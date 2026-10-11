"""Collapse frames.jsonl into a compact change log: one line per HUD state change."""
import json, sys

def fmt(t): return f'{int(t // 60)}:{t % 60:04.1f}'
def side(s):
    if not s.get('panel'): return None
    balls = ''.join({'alive': 'o', 'fainted': 'x'}.get(b, '?') for b in s['balls'])
    return f"{s['name'][:14]:<14} {balls} sh{s['shields']}"

prev, start = None, None
for line in open(sys.argv[1]):
    r = json.loads(line)
    a, b = side(r['my']), side(r['opp'])
    state = (a, b)
    if state != prev:
        label = 'no HUD' if a is None and b is None else f'{a or "-":<24} | {b or "-"}'
        print(f"{fmt(r['t']):>7} #{r['thumb']:<5} {label}")
        prev = state
