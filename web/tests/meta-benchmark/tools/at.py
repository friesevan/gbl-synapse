"""Thumb index nearest to a time: python at.py OUTDIR SECONDS"""
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1] + '/frames.jsonl')]
t = float(sys.argv[2]); print(min(rows, key=lambda r: abs(r['t'] - t))['thumb'])
