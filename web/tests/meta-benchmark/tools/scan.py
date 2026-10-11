"""Pass 1: decode only keyframes (~1/s), measure HUD state, cache nameplate OCR by image hash.

Usage: python scan.py VIDEO OUTDIR
Writes OUTDIR/frames.jsonl (one row per keyframe), OUTDIR/names/*.png (one per distinct
nameplate image) and OUTDIR/thumbs/*.jpg (small frame thumbnails for visual review).
"""
import json, os, subprocess, sys, time, hashlib
import numpy as np
from PIL import Image

video, out = sys.argv[1], sys.argv[2]
os.makedirs(out + '/names', exist_ok=True); os.makedirs(out + '/thumbs', exist_ok=True)
W, H = 886, 1920  # source geometry; all boxes below are in source pixels

# Nameplate panels and their contents (x0, y0, x1, y1)
PANEL = {'my': (17, 117, 357, 207), 'opp': (529, 117, 869, 207)}
NAME = {'my': (30, 125, 200, 155), 'opp': (700, 125, 860, 155)}
CP = {'my': (240, 125, 350, 155), 'opp': (535, 125, 640, 155)}
BALLS = {'my': [(31, 165, 61, 195), (78, 165, 108, 195), (127, 165, 157, 195)],
         'opp': [(728, 165, 758, 195), (776, 165, 806, 195), (825, 165, 855, 195)]}
SHIELDS = {'my': [(194, 165, 222, 195), (235, 165, 263, 195)],
           'opp': [(622, 165, 651, 195), (664, 165, 692, 195)]}


def keyframe_times():
    cmd = ['ffprobe', '-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey',
           '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', video]
    return [float(x.strip().strip(',')) for x in subprocess.check_output(cmd, text=True).split() if x.strip().strip(',')]


def mean(img, box):
    x0, y0, x1, y1 = box
    return img[y0:y1, x0:x1].reshape(-1, 3).mean(0)


def ball_state(rgb):
    r, g, b = rgb
    if r > 150 and r - b > 60: return 'alive'      # red top half dominates
    if max(r, g, b) < 120: return 'fainted'         # dark grey ball
    return '?'


def shield_state(rgb):
    r, g, b = rgb
    if b > 180 and r > 170 and g < 200: return 1    # bright pink/lilac
    return 0


def name_hash(gray):
    small = Image.fromarray(gray).resize((64, 12), Image.BILINEAR)
    bits = (np.asarray(small) < 128)  # dark text on pale panel
    return hashlib.sha1(np.packbits(bits).tobytes()).hexdigest()[:16], bits


ocr_cache = {}
def ocr(path):
    r = subprocess.run(['tesseract', path, '-', '--psm', '7', '-l', 'eng'], capture_output=True, text=True)
    return r.stdout.strip()


times = keyframe_times()
t0 = time.time()
proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-skip_frame', 'nokey', '-i', video, '-vsync', '0',
                         '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
size = W * H * 3
rows, i, ocr_calls = [], 0, 0
with open(out + '/frames.jsonl', 'w') as f:
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size: break
        t = times[i] if i < len(times) else None; i += 1
        img = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        row = {'t': round(t, 3)}
        for side in ('my', 'opp'):
            p = mean(img, PANEL[side])
            panel = bool(p.min() > 170 and p.max() - p.min() < 60)
            row[side] = {'panel': panel}
            if not panel: continue
            row[side]['balls'] = [ball_state(mean(img, b)) for b in BALLS[side]]
            row[side]['shields'] = sum(shield_state(mean(img, s)) for s in SHIELDS[side])
            x0, y0, x1, y1 = NAME[side]
            gray = np.asarray(Image.fromarray(img[y0:y1, x0:x1]).convert('L'))
            h, _ = name_hash(gray)
            if h not in ocr_cache:
                path = f'{out}/names/{side}-{h}.png'
                Image.fromarray(gray).resize(((x1 - x0) * 2, (y1 - y0) * 2)).save(path)
                ocr_cache[h] = ocr(path); ocr_calls += 1
            row[side]['nameHash'] = h; row[side]['name'] = ocr_cache[h]
        Image.fromarray(img).resize((111, 240)).save(f'{out}/thumbs/{i:05d}.jpg', quality=70)
        row['thumb'] = i
        f.write(json.dumps(row) + '\n')
proc.wait()
print(json.dumps({'video': video, 'keyframes': i, 'ocrCalls': ocr_calls, 'seconds': round(time.time() - t0, 1)}))
