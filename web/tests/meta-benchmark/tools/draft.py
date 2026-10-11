"""Draft battle labels from frames.jsonl using HUD structure (balls/shields) + dictionary names.

python draft.py OUTDIR GAMEMASTER  -> writes OUTDIR/draft.json and prints a summary
"""
import json, re, sys, unicodedata

out, gm_path = sys.argv[1], sys.argv[2]
gm = json.load(open(gm_path))

def norm(s):
    s = unicodedata.normalize('NFD', s)
    return re.sub(r'[^a-z0-9]', '', ''.join(c for c in s if not unicodedata.combining(c)).lower())

names = {}
for p in gm['pokemon']:
    visible = re.sub(r'\s*\([^)]*\)', '', p['speciesName'])
    names.setdefault(norm(visible), visible)

def dist(a, b):
    row = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, row[0] = row[0], i
        for j in range(1, len(b) + 1):
            old = row[j]; row[j] = min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] != b[j - 1])); prev = old
    return row[-1]

cache = {}
def species(text):
    k = norm(text)
    if k in cache: return cache[k]
    if len(k) < 3: cache[k] = None; return None
    if k in names: cache[k] = (names[k], 0); return cache[k]
    best = min(names, key=lambda n: dist(k, n))
    d = dist(k, best)
    cache[k] = (names[best], d) if d <= max(1, len(k) // 4) else None
    return cache[k]

frames = [json.loads(l) for l in open(out + '/frames.jsonl')]
battles, cur, last_hud = [], None, -99
def fresh(s): return s.get('panel') and s['balls'] == ['alive'] * 3 and s['shields'] == 2

for f in frames:
    my, opp, t = f['my'], f['opp'], f['t']
    if not (my.get('panel') and opp.get('panel')): continue
    if my['balls'] == ['?'] * 3 and opp['balls'] == ['?'] * 3: continue  # transition frame, not a real HUD
    # Faints and used shields only accumulate within a battle; a reset to a fresh HUD means a new battle.
    used = lambda s: s['balls'].count('fainted') + (2 - s['shields'])
    regressed = cur and fresh(my) and fresh(opp) and (cur['used'] > 0)
    if cur and (t - last_hud > 25 or regressed or (fresh(my) and fresh(opp) and cur['ended'])):
        battles.append(cur); cur = None
    if cur is None:
        if not (fresh(my) and fresh(opp)) and t - last_hud < 25: last_hud = t; continue
        cur = {'start': t, 'end': t, 'my': [], 'opp': [], 'fuzzy': [], 'ended': False, 'balls': None,
               'flags': [] if fresh(my) and fresh(opp) else ['started mid-battle'], 'events': [], 'used': 0}
    cur['end'] = t; last_hud = t
    if '?' not in my['balls'] + opp['balls']: cur['used'] = max(cur['used'], used(my) + used(opp))
    for side, s in (('my', my), ('opp', opp)):
        hit = species(s['name'])
        if hit and hit[0] not in cur[side]:
            cur[side].append(hit[0]); cur['events'].append([t, side, hit[0], ''.join(b[0] for b in s['balls'])])
            if hit[1]: cur['fuzzy'].append(f"{s['name']}→{hit[0]}")
    cur['balls'] = {side: s['balls'] for side, s in (('my', my), ('opp', opp))}
    if 'fainted,fainted,fainted' in (','.join(my['balls']), ','.join(opp['balls'])): cur['ended'] = True
if cur: battles.append(cur)

for b in battles:
    lost = [side for side in ('my', 'opp') if b['balls'][side] == ['fainted'] * 3]
    b['result'] = 'Win' if lost == ['opp'] else 'Loss' if lost == ['my'] else 'Unknown'
    for side in ('my', 'opp'):
        if len(b[side]) > 3: b['flags'].append(f'{side}: more than 3 species')
json.dump(battles, open(out + '/draft.json', 'w'), indent=1)

fmt = lambda t: f'{int(t // 60)}:{int(t % 60):02d}'
for i, b in enumerate(battles, 1):
    print(f"{i:>2} {fmt(b['start'])}-{fmt(b['end'])} {b['result']:<7} me: {', '.join(b['my']):<38} opp: {', '.join(b['opp'])}"
          + (f"  [{'; '.join(b['flags'] + b['fuzzy'])}]" if b['flags'] or b['fuzzy'] else ''))
