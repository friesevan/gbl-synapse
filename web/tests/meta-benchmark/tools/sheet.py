"""Contact sheet of thumbnails: python sheet.py OUTDIR FIRST LAST DEST [cols]"""
import sys
from PIL import Image, ImageDraw
out, a, b, dest = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
cols = int(sys.argv[5]) if len(sys.argv) > 5 else 12
ids = list(range(a, b + 1)); rows = (len(ids) + cols - 1) // cols
sheet = Image.new('RGB', (cols * 111, rows * 252), 'white'); d = ImageDraw.Draw(sheet)
for k, i in enumerate(ids):
    x, y = (k % cols) * 111, (k // cols) * 252
    sheet.paste(Image.open(f'{out}/thumbs/{i:05d}.jpg'), (x, y + 12)); d.text((x + 2, y), f'#{i}', fill='black')
sheet.save(dest)
