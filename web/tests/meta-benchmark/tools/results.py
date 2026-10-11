"""Read the result banner after each drafted battle: python results.py VIDEO OUTDIR
Scans keyframes in the 45 s after each battle's last HUD frame, OCRs the centre band,
and stops at the first YOU WIN / GOOD EFFORT / TIE. Updates OUTDIR/draft.json in place."""
import json, re, subprocess, sys, os
import numpy as np
from PIL import Image

video, out = sys.argv[1], sys.argv[2]
W, H, Y0, Y1 = 886, 1920, 700, 1180
battles = json.load(open(out + '/draft.json'))
tmp = out + '/result-crop.png'

def classify(text):
    k = re.sub(r'[^a-z]', '', text.lower())
    if 'youwin' in k or 'ouwin' in k: return 'Win'
    if 'goodeffort' in k or 'goodeff' in k or 'oodeffort' in k: return 'Loss'
    if 'youlose' in k: return 'Loss'
    if re.search(r'\btie\b', text.lower()): return 'Tie'
    return None

for i, b in enumerate(battles):
    nxt = battles[i + 1]['start'] if i + 1 < len(battles) else b['end'] + 45
    span = max(3, min(45, nxt - b['end']))
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-skip_frame', 'nokey', '-ss', str(b['end']), '-t', str(span),
                             '-i', video, '-vsync', '0', '-vf', f'crop={W}:{Y1 - Y0}:0:{Y0}',
                             '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    size, k, found = W * (Y1 - Y0) * 3, 0, None
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size: break
        img = np.frombuffer(buf, np.uint8).reshape(Y1 - Y0, W, 3)
        white = (img.min(2) > 215)
        if white.mean() < 0.01: k += 1; continue            # no large white text in the band
        Image.fromarray(np.where(white, 0, 255).astype(np.uint8)).save(tmp)
        text = subprocess.run(['tesseract', tmp, '-', '--psm', '6'], capture_output=True, text=True).stdout
        found = classify(text)
        if found: b['resultScreen'] = {'value': found, 't': round(b['end'] + k, 1)}; break
        k += 1
    proc.kill(); proc.wait()
    hud = b['result']
    if found and hud != 'Unknown' and hud != found: b['flags'].append(f'HUD says {hud}, screen says {found}')
    b['result'] = found or hud
json.dump(battles, open(out + '/draft.json', 'w'), indent=1)
fmt = lambda t: f'{int(t // 60)}:{int(t % 60):02d}'
for i, b in enumerate(battles, 1):
    print(f"{i:>2} {fmt(b['start'])}-{fmt(b['end'])} {b['result']:<7} {'screen' if 'resultScreen' in b else 'HUD   '} "
          f"me: {', '.join(b['my']):<36} opp: {', '.join(b['opp'])}" + (f"  [{'; '.join(b['flags'])}]" if b['flags'] else ''))
if os.path.exists(tmp): os.remove(tmp)
