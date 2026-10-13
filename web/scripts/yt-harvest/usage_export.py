"""Export the opponent teams seen in harvested YouTube battles as a Team Rankings (full-team neural network) usage file.

    python3 -I web/scripts/yt-harvest/usage_export.py [--pool web/training/runs/team-search/pool.json]

The file follows web/training/next/usage-template.json and loads with
`node training/team-search/search.cjs --meta hybrid --usage-file FILE` (see that README). It is
written outside git, to WORK/usage/, next to a quality report (.report.json and .report.md).

Eligibility, checked in this order for each battle (the first failing rule is the reason reported):
  1. Not Team Rocket (the catalog already drops those) and not a championship: the battle's league
     says championship, or the video title/channel is strong Play! Pokemon championship evidence and
     no reviewer answered "not a championship".
  2. Footage not labelled "No battle footage" or "obscured" by a reviewer.
  3. Great League: a human league answer, else the per-battle league refinement, else the CP cap must
     give 1,500 CP, and the cup must be in --cups. The default, great + mega, is open Great League
     and Great League: Mega Edition (no species restriction). Type-restricted cups such as Color,
     Retro or Willpower have their own metas and are excluded.
  4. The opponent's team is complete: three members, each with an identified form (reviewer answer,
     or form confidence >= .98). Partial teams are counted in the report, never written.
  5. The battle boundary is sound: no "more than three opponent species" flag, and the lead is
     known: no "recording starts mid-battle" flag unless a reviewer confirmed the lead.
  6. Every member maps into the trainer's pool. Shadow form only when a reviewer said Shadow, the model
     resolved it (held-out gate; observed.model_answers), or the classifier is >= .98 sure; otherwise the base form. In-battle forms (Gulping Cramorant, Hangry
     Morpeko, Blade Aegislash, Busted Mimikyu, Zen Darmanitan) map to their pool form. A confirmed
     Shadow whose Shadow form is not in the pool falls back to the base form (reported). Megas and
     anything else outside the pool are reported as unmapped and the team is dropped.
  7. Species Clause (three different Pokedex numbers) and a date: the verified recording date, else
     the upload date (registry, else the harvester's state.sqlite), so --usage-half-life-days works.
Then repeated battles are removed: in one video, a battle that overlaps or directly follows
(<= 10 s) another with the same opponent team is one battle split in two; across one creator's
videos, the same six Pokemon with the same result, faints and shields is one battle uploaded twice
(the earliest upload is kept).

Human answers (feedback.json, labels/) override detections throughout; the catalog in observed.py
applies them. Free-LLM resolutions are not human answers and are ignored.

Stratification by date: --since YYYY-MM-DD and --until YYYY-MM-DD (inclusive) keep only teams dated
inside the window (the same date rule 7 uses: recording date, else upload date). The window is applied
after the repeated-battle rule, so which copy of a duplicated battle is kept does not depend on it, and
before the creator cap, so the cap is computed on the window's own creators. Dropped teams are counted as
"date-range" in the quality report. Stratifying by rating is not possible from this catalog: no battle
or video record carries the opponent's rating or a rank bracket (the result screen is not read for it, and
the only rating information is free text in some video titles, e.g. "2864 ELO", which is the creator's own
rating at that moment, not the opponent's). The `rank` text in the file says so.

Only opponents are written: a creator's own team is one player's choice and repeats across their
battles. --include-creator-teams adds each creator team once per video.

Creator cap: each YouTube channel's rows get one weight, min(1, K / n), with K chosen so no channel
carries more than --max-creator-share of the total weight (row "weight"; "count" stays the raw
appearances). These are top-tier players' opponents, a known bias; `source` and `rank` say so.
"""
import argparse
import collections
import datetime as dt
import json
import math
import os
from pathlib import Path
import random
import sqlite3
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from observed import ObservedCatalog, human, read, date as iso_date  # noqa: E402
import league as league_rules  # noqa: E402

WEB = HERE.parents[1]
DEFAULT_WORK = Path.home() / 'Desktop/Projects/PoGo Recorder/src/yt-harvest'
DEFAULT_POOL = WEB / 'training/runs/team-search/pool.json'
DEFAULT_CUPS = ('great', 'mega')
DEFAULT_MAX_CREATOR_SHARE = .10
FORM_CONFIDENCE = .98
SPLIT_GAP_S = 10
WEIGHT_POWER = 1.25          # the trainer's default --meta-weight-power, for the PvPoke comparison
EXCLUDED_FOOTAGE = ('none', 'obscured')
BOUNDARY_FLAG = 'More than three opponent species'
MY_BOUNDARY_FLAG = 'More than three my species'
MID_START_FLAG = 'Recording starts mid-battle'
# In-battle form changes of one Pokemon -> the form PvPoke ranks (the trainer's pool IDs).
BATTLE_FORMS = {'cramorant_gulping': 'cramorant', 'cramorant_gorging': 'cramorant',
                'morpeko_hangry': 'morpeko_full_belly', 'aegislash_blade': 'aegislash_shield',
                'mimikyu_busted': 'mimikyu', 'darmanitan_zen': 'darmanitan_standard',
                'darmanitan_galarian_zen': 'darmanitan_galarian_standard'}
UNKNOWN_IDS = (None, '', 'other', 'none', 'None', 'unknown')
REASONS = {
    'rocket': 'Team Rocket battle',
    'championship': 'Championship / tournament video',
    'footage': 'Footage labelled no-footage or obscured',
    'other-league': 'Not 1,500 CP (Ultra, Master, Little or unknown league)',
    'restricted-cup': 'Restricted 1,500 CP cup (not in --cups)',
    'unknown-cup': 'Cup not named in the video text (may be a restricted cup)',
    'partial': 'Partial team (fewer than three identified members)',
    'boundary': 'Battle boundary flagged (more than three opponent species)',
    'lead-unknown': 'Recording starts mid-battle: lead unknown',
    'unmapped': 'Member outside the trainer pool (e.g. Mega)',
    'species-clause': 'Two members share a Pokedex number',
    'no-date': 'No recording or upload date',
    'duplicate': 'Repeated battle (split or re-uploaded)',
    'date-range': 'Outside the --since/--until window',
}


def day(text):
    """A strict YYYY-MM-DD date string (empty or None means no bound). Raises ValueError otherwise."""
    if text in (None, ''):
        return None
    text = str(text)
    if len(text) != 10:
        raise ValueError('%r is not a YYYY-MM-DD date' % text)
    try:
        return dt.date.fromisoformat(text).isoformat()
    except ValueError:
        raise ValueError('%r is not a YYYY-MM-DD date' % text) from None


def in_window(collected, since, until):
    """Whether a team's date is inside the inclusive [since, until] window. No bounds keep everything; a team with no date
    cannot be placed in a bounded window."""
    if not since and not until:
        return True
    return bool(collected) and (not since or collected[:10] >= since) and (not until or collected[:10] <= until)


def result_from(b):
    """read (result screen), inferred (battle timeline: faints / surrender), human (reviewer), unresolvable or unknown."""
    src, result = str(b.get('resultSource') or ''), b.get('result')
    if src == 'reviewer':
        return 'human'
    if src in ('faints', 'surrender', 'Poké Ball count', 'surrender dialog'):
        return 'inferred'
    if src == 'unresolvable':
        return 'unresolvable'
    return 'read' if result in ('Win', 'Loss', 'Tie') else 'unknown'


def load_pool(path):
    data = read(path, None)
    if not isinstance(data, dict) or not isinstance(data.get('species'), list):
        raise SystemExit('Trainer pool not found or unreadable: %s\nPrepare it first: node training/team-search/prepare.cjs '
                         '--species 300 --movesets 5 --shortlist 10000 --scout-opponents 300 --out training/runs/team-search/pool.json' % path)
    return {p['speciesId']: {'dex': p.get('dex'), 'weight': float(p.get('weight') or 0), 'name': p.get('speciesName') or p['speciesId'],
                             'rank': p.get('rank')}
            for p in data['species'] if isinstance(p, dict) and p.get('speciesId')}, data.get('hash')


def harvester_videos(work, ids):
    """Channel and upload date per video from the harvester's state.sqlite (read-only; optional)."""
    path = Path(work) / 'state.sqlite'
    ids = sorted(set(ids))
    if not path.exists() or not ids:
        return {}
    rows = []
    try:
        con = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
        try:
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                rows += con.execute('select id, channel_id, channel, upload_date from videos where id in (%s)'
                                    % ','.join('?' * len(chunk)), chunk).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return {}
    return {r[0]: {'channelId': r[1], 'channel': r[2], 'uploadDate': iso_date(r[3])} for r in rows}


def reviewer_footage(work, feedback):
    """Latest human footage answer per video, plus labels/<video>.json videoType."""
    answers = list((feedback.get('answers') or {}).values())
    labels_dir = Path(work) / 'labels'
    video_type = {}
    for p in sorted(labels_dir.glob('*.json')) if labels_dir.is_dir() else []:
        labels = read(p, {})
        if not isinstance(labels, dict):
            continue
        answers.extend(a for a in (labels.get('verified') or {}).values() if isinstance(a, dict))
        if labels.get('videoType'):
            video_type[p.stem] = labels['videoType']
        if labels.get('championship') is False:
            video_type.setdefault(p.stem, 'not-championship')
    latest = {}
    for a in answers:
        if a.get('kind') != 'footage' or not human(a):
            continue
        vid = ObservedCatalog._video(a)
        if vid not in latest or str(a.get('answeredAt') or '') >= str(latest[vid].get('answeredAt') or ''):
            latest[vid] = a
    return {vid: a['value'] for vid, a in latest.items()}, video_type


def strong_championship(registry_by_id, video_type):
    out = set()
    for vid, v in registry_by_id.items():
        if video_type.get(vid) == 'not-championship':
            continue
        strong, _, _ = league_rules.championship_evidence({'title': v.get('title') or '', 'channel': v.get('channel') or '',
                                                           'description': v.get('description') or ''})
        if strong or v.get('championship'):
            out.add(vid)
    return out


def map_member(m, pool):
    """(pool speciesId or None, note). Shadow only when confirmed; base form otherwise."""
    identity = m.get('id')
    if identity in UNKNOWN_IDS:
        return None, 'unknown'
    base = BATTLE_FORMS.get(identity, identity)
    if m.get('shadow') is True:
        if base + '_shadow' in pool:
            return base + '_shadow', 'shadow'
        if base in pool:
            return base, 'shadow-fallback'
        return None, base + '_shadow'
    return (base, 'base' if m.get('shadow') is False else 'base, Shadow unknown') if base in pool else (None, base)


def identified(m):
    if m.get('id') in UNKNOWN_IDS:
        return False
    if 'form' in (m.get('reviewed') or []):
        return True
    p = m.get('formConfidence')
    return p is None or p >= FORM_CONFIDENCE


def flagged(battle, prefix):
    return any(str(f).startswith(prefix) for f in battle.get('flags') or [])


def side_team(o, side, pool, flag_prefix):
    """(reason, members, notes) for one side of a GBL occurrence that passed the league rules."""
    b = o['battle']
    members = b[side]
    if len(members) != 3 or not all(identified(m) for m in members):
        return 'partial', None, None
    if flagged(b, flag_prefix):
        return 'boundary', None, None
    if side == 'opponent' and flagged(b, MID_START_FLAG) and not b.get('leadConfirmed'):
        return 'lead-unknown', None, None
    if side == 'my' and flagged(b, MID_START_FLAG):
        return 'lead-unknown', None, None
    mapped = [map_member(m, pool) for m in members]
    if any(sid is None for sid, _ in mapped):
        return 'unmapped', [note for sid, note in mapped if sid is None], None
    ids = [sid for sid, _ in mapped]
    if len({pool[i]['dex'] for i in ids}) != 3:
        return 'species-clause', None, None
    notes = [note for _, note in mapped]
    reviewed = sum(bool(m.get('reviewed')) for m in members)
    return None, ids, {'notes': notes, 'reviewedMembers': reviewed}


def canonical(ids):
    return [ids[0]] + sorted(ids[1:])


def creator_cap(counts, max_share):
    """K such that min(n, K) / sum(min(n_c, K)) <= max_share for every creator (bisection).
    Returns (K, weights by creator). With too few creators to meet the share, all creators get
    equal totals (K = the smallest creator's count)."""
    if not counts:
        return None, {}
    n = sorted(counts.values())
    if max(n) <= max_share * sum(n):
        return float(max(n)), {c: 1.0 for c in counts}
    if len(n) * max_share < 1:
        k = float(n[0])
    else:
        lo, hi = 0.0, float(max(n))
        for _ in range(100):
            mid = (lo + hi) / 2
            if mid - max_share * sum(min(x, mid) for x in n) > 0:
                hi = mid
            else:
                lo = mid
        k = lo
    return k, {c: min(1.0, k / v) for c, v in counts.items()}


def prior_presence(pool, samples=20000, seed=2026101100):
    """Share of teams containing each species when drawn independently by PvPoke weight ** 1.25,
    without repeating a Pokedex number (the independent half of the trainer's synthetic prior)."""
    rng = random.Random(seed)
    ids = sorted(i for i, p in pool.items() if p['weight'] > 0)
    cumulative, total = [], 0.0
    for i in ids:
        total += pool[i]['weight'] ** WEIGHT_POWER
        cumulative.append(total)
    present = collections.Counter()
    for _ in range(samples):
        team, dexes = [], set()
        while len(team) < 3:
            choice = rng.choices(ids, cum_weights=cumulative)[0]
            if pool[choice]['dex'] in dexes:
                continue
            team.append(choice)
            dexes.add(pool[choice]['dex'])
        present.update(team)
    return {i: present[i] / samples for i in ids}


def team_prior(team, pool):
    """Probability of this lead + unordered bench under independent PvPoke-weight draws."""
    w = {i: p['weight'] ** WEIGHT_POWER for i, p in pool.items() if p['weight'] > 0}
    total = sum(w.values())

    def p(i, taken):
        dex = {pool[t]['dex'] for t in taken}
        rest = total - sum(v for k, v in w.items() if pool[k]['dex'] in dex)
        return w.get(i, 0) / rest if rest > 0 else 0
    lead, b, c = team
    return p(lead, []) * (p(b, [lead]) * p(c, [lead, b]) + p(c, [lead]) * p(b, [lead, c]))


def dedupe(entries):
    """Drops split and re-uploaded battles. Entries are sorted so the earliest upload is kept."""
    kept, dropped = [], []
    entries = sorted(entries, key=lambda e: (e['collectedAt'], e['videoId'], e['start']))
    by_video = collections.defaultdict(list)
    fingerprints = set()
    for e in entries:
        split = next((k for k in by_video[e['videoId']] if k['opponentSet'] == e['opponentSet']
                      and e['start'] <= (k['end'] if k['end'] is not None else k['start']) + SPLIT_GAP_S
                      and k['start'] <= (e['end'] if e['end'] is not None else e['start']) + SPLIT_GAP_S), None)
        fp = (e['creator'], e['opponentSet'], e['mySet'], e['result'], e['fainted'], e['shields']) if e['mySet'] else None
        if split is not None or (fp is not None and fp in fingerprints and e['result'] not in ('Unknown', None)):
            dropped.append(e)
            continue
        by_video[e['videoId']].append(e)
        if fp is not None:
            fingerprints.add(fp)
        kept.append(e)
    return kept, dropped


def build(work=DEFAULT_WORK, web_root=WEB, pool_path=DEFAULT_POOL, registry=None, cups=DEFAULT_CUPS,
          include_creator_teams=False, max_creator_share=DEFAULT_MAX_CREATOR_SHARE, today=None, prior_samples=20000,
          since=None, until=None):
    work, web_root = Path(work), Path(web_root)
    since, until = day(since), day(until)
    if since and until and since > until:
        raise ValueError('--since %s is after --until %s' % (since, until))
    pool, pool_hash = load_pool(pool_path)
    catalog = ObservedCatalog(work, web_root)
    if registry:
        catalog.registry = Path(registry)
    state = catalog.state()
    occurrences = state['occurrences']
    feedback = read(work / 'feedback.json', {})
    footage, video_type = reviewer_footage(work, feedback)
    reg = read(catalog.registry, [])
    reg = reg if isinstance(reg, list) else reg.get('videos', [])
    registry_by_id = {v.get('id'): v for v in reg if isinstance(v, dict) and v.get('id')}
    championship_titles = strong_championship(registry_by_id, video_type)
    harvested = harvester_videos(work, (o['source']['videoId'] for o in occurrences))

    reasons = collections.Counter({'rocket': state['summary']['excluded'].get('rocket', 0)})
    gl_reasons = collections.Counter()
    by_cup = collections.Counter()
    unmapped = collections.Counter()
    notes = collections.Counter()
    leads = collections.Counter()
    partial_gl = collections.Counter()
    entries = []

    for o in occurrences:
        vid = o['source']['videoId']
        b = o['battle']
        lg = o['league']
        reason = None
        if o.get('battleType') == 'championship' or lg.get('format') == 'championship' or vid in championship_titles:
            reason = 'championship'
        elif footage.get(vid) in EXCLUDED_FOOTAGE or video_type.get(vid) == 'obscured':
            reason = 'footage'
        elif lg.get('cp') != 1500:
            reason = 'other-league'
        elif (o.get('cupRange') or {}).get('status') == 'uncaptured':
            reason = 'unknown-cup'
        elif (lg.get('cupId') or 'great') not in cups:
            reason = 'restricted-cup'
        in_gl = reason in (None, 'restricted-cup', 'unknown-cup')
        if in_gl:
            cup_id = 'unknown' if reason == 'unknown-cup' else lg.get('cupId') or 'great'
            by_cup[(cup_id, 'Great League' if cup_id == 'great' else 'Unknown cup' if cup_id == 'unknown' else lg.get('cup') or cup_id)] += 1
        h = harvested.get(vid, {})
        collected = o['battleDate'] if o.get('dateVerified') and o.get('battleDate') else (o['source'].get('uploadDate') or h.get('uploadDate'))
        channel = o['source'].get('channel') or h.get('channel')
        creator = h.get('channelId') or channel or ('video:' + vid)
        base = {'videoId': vid, 'battle': o['battleIndex'], 'start': b.get('start') or 0, 'end': b.get('end'),
                'collectedAt': collected, 'dateBasis': 'recording' if o.get('dateVerified') and o.get('battleDate') else 'upload',
                'creator': creator, 'channel': channel or ('unknown channel (' + vid + ')'), 'cup': lg.get('cupId') or ('unknown' if reason == 'unknown-cup' else 'great'),
                'result': b.get('result'), 'resultSource': result_from(b), 'fainted': json.dumps(b.get('fainted'), sort_keys=True),
                'shields': json.dumps(b.get('shieldsUsed'), sort_keys=True)}
        if reason is None:
            reason, ids, info = side_team(o, 'opponent', pool, BOUNDARY_FLAG)
            if reason == 'unmapped':
                unmapped.update(ids)
            if reason == 'partial':
                partial_gl[len([m for m in b['opponent'] if identified(m)])] += 1
            if reason is None and not collected:
                reason = 'no-date'
            if reason is None:
                my_reason, my_ids, _ = side_team(o, 'my', pool, MY_BOUNDARY_FLAG)
                entries.append({**base, 'members': canonical(ids), 'opponentSet': tuple(sorted(ids)),
                                'mySet': tuple(sorted(my_ids)) if my_reason is None else None,
                                'myMembers': canonical(my_ids) if my_reason is None else None, 'notes': info['notes'],
                                'reviewedMembers': info['reviewedMembers'], 'leadConfirmed': bool(b.get('leadConfirmed'))})
        if reason:
            reasons[reason] += 1
            if in_gl:
                gl_reasons[reason] += 1

    kept, dropped = dedupe(entries)
    reasons['duplicate'] += len(dropped)
    gl_reasons['duplicate'] += len(dropped)
    # The window comes after the repeated-battle rule (a battle's duplicates are judged on all dates) and before the creator cap.
    outside = [e for e in kept if not in_window(e['collectedAt'], since, until)]
    if outside:
        kept = [e for e in kept if in_window(e['collectedAt'], since, until)]
        reasons['date-range'] += len(outside)
        gl_reasons['date-range'] += len(outside)
    for e in kept:
        notes.update(e['notes'])
        leads['reviewer-confirmed' if e['leadConfirmed'] else 'first seen at battle start'] += 1

    # Creator teams (opt-in): from kept battles, once per video and distinct team.
    creator_rows, seen = [], set()
    for e in kept if include_creator_teams else []:
        key = (e['videoId'], e['mySet'])
        if e['myMembers'] and key not in seen:
            seen.add(key)
            creator_rows.append({**e, 'members': e['myMembers']})

    rows_in = [dict(e, side='opponent') for e in kept] + [dict(e, side='creator') for e in creator_rows]
    per_creator = collections.Counter(e['creator'] for e in rows_in)
    k, weights = creator_cap(per_creator, max_creator_share)
    channel_name = {e['creator']: e['channel'] for e in rows_in}

    grouped = collections.OrderedDict()
    for e in sorted(rows_in, key=lambda e: (e['collectedAt'], e['creator'], e['members'])):
        key = (tuple(e['members']), e['collectedAt'], e['creator'], e['side'])
        g = grouped.setdefault(key, {'members': list(e['members']), 'count': 0, 'collectedAt': e['collectedAt'],
                                     'creator': channel_name[e['creator']], 'side': e['side'], 'battles': []})
        g['count'] += 1
        g['battles'].append('%s:%d' % (e['videoId'], e['battle']))
        w = round(weights[e['creator']], 6)
        if w < 1:
            g['weight'] = w
    teams = list(grouped.values())

    dates = sorted(e['collectedAt'] for e in rows_in)
    total_weight = sum(weights[e['creator']] for e in rows_in)
    distinct = collections.Counter()
    weighted = collections.Counter()
    creators_of = collections.defaultdict(set)
    for e in kept:
        key = tuple(e['members'])
        distinct[key] += 1
        weighted[key] += weights[e['creator']]
        creators_of[key].add(e['creator'])
    opp_weight = sum(weighted.values()) or 1
    prior = prior_presence(pool, prior_samples) if prior_samples else {}
    prior_rank = {i: r for r, (i, _) in enumerate(sorted(pool.items(), key=lambda kv: -kv[1]['weight']), 1)}
    top_teams = [{'members': list(t), 'count': distinct[t], 'weightedShare': weighted[t] / opp_weight,
                  'creators': len(creators_of[t]), 'pvpokePrior': team_prior(t, pool)}
                 for t in sorted(distinct, key=lambda t: (-weighted[t], -distinct[t], t))[:20]]
    for t in top_teams:
        t['ratio'] = t['weightedShare'] / t['pvpokePrior'] if t['pvpokePrior'] else None
    presence = collections.Counter()
    for e in kept:
        for i in set(e['members']):
            presence[i] += weights[e['creator']]
    top_species = [{'speciesId': i, 'observedPresence': presence[i] / opp_weight, 'observedRank': r,
                    'pvpokeWeight': pool[i]['weight'], 'pvpokeRank': prior_rank.get(i), 'pvpokePresence': prior.get(i)}
                   for r, i in enumerate(sorted(presence, key=lambda i: (-presence[i], i))[:30], 1)]
    prior_top = [{'speciesId': i, 'pvpokePresence': prior[i], 'observedPresence': presence.get(i, 0) / opp_weight}
                 for i in sorted(prior, key=lambda i: -prior[i])[:15]]

    all_battles = len(occurrences) + reasons['rocket']
    gl_battles = sum(by_cup.values())
    max_share_before = max(per_creator.values()) / sum(per_creator.values()) if per_creator else 0
    max_share_after = max(min(v, k) for v in per_creator.values()) / total_weight if per_creator else 0
    generated = (today or dt.date.today()).isoformat()
    first, last = (dates[0], dates[-1]) if dates else (None, None)
    cup_text = ' and '.join({'great': 'open Great League', 'mega': 'Great League: Mega Edition'}.get(c, c) for c in cups)
    usage = {
        'source': ('Observed opponents in %d harvested YouTube GBL videos by %d creators (%s, 1,500 CP), %s to %s. '
                   'Detections with human answers applied; top-tier players\' opponents, not average-player usage.'
                   % (len({e['videoId'] for e in rows_in}), len(per_creator), cup_text, first, last)),
        'cp': 1500, 'cup': 'all', 'collectedAt': last, **({'window': {'since': since, 'until': until}} if since or until else {}),
        'rank': 'Opponents of top-tier YouTube creators (high-rated players; rating not measured); biased above the average ladder',
        'generatedAt': generated, 'generator': 'web/scripts/yt-harvest/usage_export.py',
        'creators': len(per_creator), 'dateRange': {'from': first, 'to': last},
        'cups': list(cups), 'sides': ['opponent'] + (['creator'] if include_creator_teams else []),
        'weighting': ('Per-creator weight min(1, %.3g / n) so no channel exceeds %.0f%% of the total; count is raw appearances.'
                      % (k or 0, max_creator_share * 100)),
        'poolHash': pool_hash,
        'teams': teams,
    }
    report = {
        'generatedAt': generated, 'work': str(work), 'pool': str(pool_path), 'poolHash': pool_hash,
        'catalog': {k2: state['summary'][k2] for k2 in ('videos', 'battles', 'files', 'truncated')},
        'battles': all_battles, 'greatLeagueBattles': gl_battles,
        'eligibleTeams': len(kept), 'creatorTeams': len(creator_rows), 'rows': len(teams),
        'distinctTeams': len(distinct), 'creators': len(per_creator), 'dateRange': {'from': first, 'to': last},
        'videos': len({e['videoId'] for e in rows_in}), 'window': {'since': since, 'until': until},
        'weightedTotal': total_weight, 'creatorCapK': k, 'maxCreatorShare': {'before': max_share_before, 'after': max_share_after},
        'exclusions': {r: {'count': reasons[r], 'share': reasons[r] / all_battles if all_battles else 0, 'label': REASONS[r]}
                       for r in REASONS if reasons[r]},
        'greatLeagueExclusions': {r: {'count': gl_reasons[r], 'share': gl_reasons[r] / gl_battles if gl_battles else 0, 'label': REASONS[r]}
                                  for r in REASONS if gl_reasons[r]},
        'cups': [{'cup': c, 'name': n, 'battles': v, 'included': c in cups} for (c, n), v in by_cup.most_common()],
        'partialTeamsByIdentifiedMembers': dict(sorted(partial_gl.items())),
        'unmappedSpecies': dict(unmapped.most_common()),
        'memberMapping': dict(notes.most_common()), 'leads': dict(leads),
        'reviewedMembers': sum(e['reviewedMembers'] for e in kept),
        'dateBasis': dict(collections.Counter(e['dateBasis'] for e in kept)),
        # Where the kept battles' results came from (observed.py applies timeline inferences and human answers).
        'resultSources': dict(collections.Counter(e.get('resultSource', 'unknown') for e in kept)),
        'perCreator': [{'channel': channel_name[c], 'teams': v, 'weight': round(weights[c], 4)} for c, v in per_creator.most_common()],
        'topTeams': top_teams, 'topSpecies': top_species, 'pvpokeTopSpecies': prior_top,
        'trainer': recommend(total_weight, rows_in, weights, last),
    }
    return usage, report


def recommend(total_weight, rows, weights, as_of, half_life=30, target_share=.75):
    """Prior strength that gives the target observed share after the half-life decay."""
    if not rows or not as_of:
        return None
    at = dt.date.fromisoformat(as_of)
    decayed = sum(weights[e['creator']] * 0.5 ** ((at - dt.date.fromisoformat(e['collectedAt'])).days / half_life) for e in rows)
    strength = max(1, round(decayed * (1 - target_share) / target_share))
    return {'halfLifeDays': half_life, 'asOf': as_of, 'decayedWeight': decayed, 'targetObservedShare': target_share,
            'priorStrength': strength, 'observedShare': min(.8, decayed / (decayed + strength)),
            'defaultPriorStrengthShare': min(.8, decayed / (decayed + 500))}


def pct(x):
    return '—' if x is None else '%.1f%%' % (100 * x)


def markdown(report):
    r = report
    lines = ['# Observed Great League opponents — quality report', '',
             'Generated %s from `%s`.' % (r['generatedAt'], r['work']), '',
             '| | |', '| --- | --- |',
             '| Battles in the catalog (incl. Team Rocket) | %d |' % r['battles'],
             '| Great League battles (1,500 CP, any cup) | %d |' % r['greatLeagueBattles'],
             '| Eligible opponent teams (after dedupe) | %d (%s of all battles, %s of Great League battles) |'
             % (r['eligibleTeams'], pct(r['eligibleTeams'] / r['battles'] if r['battles'] else None),
                pct(r['eligibleTeams'] / r['greatLeagueBattles'] if r['greatLeagueBattles'] else None)),
             '| Creator teams (opt-in) | %d |' % r['creatorTeams'],
             '| Distinct opponent teams (lead + bench) | %d |' % r['distinctTeams'],
             '| Videos / creators | %d / %d |' % (r['videos'], r['creators']),
             '| Date range | %s to %s%s |' % (r['dateRange']['from'], r['dateRange']['to'],
                                               ' (window %s to %s)' % (r['window']['since'] or 'start', r['window']['until'] or 'end')
                                               if r.get('window') and (r['window']['since'] or r['window']['until']) else ''),
             '| Largest creator share, before / after the cap | %s / %s |' % (pct(r['maxCreatorShare']['before']), pct(r['maxCreatorShare']['after'])),
             '', '## Exclusions (share of all battles)', '', '| Reason | Battles | Share |', '| --- | ---: | ---: |']
    lines += ['| %s | %d | %s |' % (v['label'], v['count'], pct(v['share'])) for v in r['exclusions'].values()]
    lines += ['', '## Exclusions among Great League battles', '', '| Reason | Battles | Share |', '| --- | ---: | ---: |']
    lines += ['| %s | %d | %s |' % (v['label'], v['count'], pct(v['share'])) for v in r['greatLeagueExclusions'].values()]
    lines += ['', 'Cups at 1,500 CP: ' + ', '.join('%s %d%s' % (c['name'], c['battles'], '' if c['included'] else ' (excluded)') for c in r['cups']),
              '', 'Partial opponent teams by identified members: %s' % r['partialTeamsByIdentifiedMembers'],
              '', 'Unmapped species (team dropped): ' + (', '.join('%s %d' % kv for kv in r['unmappedSpecies'].items()) or 'none'),
              '', 'Member mapping: %s. Leads: %s. Members with a reviewer answer: %d. Date basis: %s.'
              % (r['memberMapping'], r['leads'], r['reviewedMembers'], r['dateBasis']),
              '', '## Top 20 teams vs the PvPoke prior', '',
              'PvPoke prior = probability of this lead and bench when members are drawn independently by PvPoke weight ^ 1.25 (the independent half of the trainer\'s synthetic prior).',
              '', '| # | Lead | Bench | Teams | Creators | Observed share | PvPoke prior | Ratio |', '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |']
    lines += ['| %d | %s | %s | %d | %d | %s | %s | %s |' % (i, t['members'][0], ' / '.join(t['members'][1:]), t['count'], t['creators'],
                                                         pct(t['weightedShare']), '%.3f%%' % (100 * t['pvpokePrior']),
                                                         '%.0f×' % t['ratio'] if t['ratio'] else '—')
              for i, t in enumerate(r['topTeams'], 1)]
    lines += ['', '## Top species: observed presence vs PvPoke', '',
              '| # | Species | Observed presence | PvPoke presence | PvPoke weight (rank) |', '| ---: | --- | ---: | ---: | --- |']
    lines += ['| %d | %s | %s | %s | %g (#%s) |' % (s['observedRank'], s['speciesId'], pct(s['observedPresence']), pct(s['pvpokePresence']),
                                                 s['pvpokeWeight'], s['pvpokeRank']) for s in r['topSpecies'][:20]]
    lines += ['', 'PvPoke\'s most likely species and their observed presence: ' + ', '.join(
        '%s %s vs %s' % (s['speciesId'], pct(s['pvpokePresence']), pct(s['observedPresence'])) for s in r['pvpokeTopSpecies'][:10])]
    lines += ['', '## Creators', '', '| Channel | Teams | Weight per team |', '| --- | ---: | ---: |']
    lines += ['| %s | %d | %.3f |' % (c['channel'], c['teams'], c['weight']) for c in r['perCreator']]
    t = r['trainer']
    if t:
        lines += ['', '## Trainer settings', '',
                  'With `--usage-half-life-days %d --usage-as-of %s` the decayed weight is %.1f. `--usage-prior-strength %d` gives an '
                  'observed share of %s (the default 500 would give %s).' % (t['halfLifeDays'], t['asOf'], t['decayedWeight'], t['priorStrength'],
                                                                             pct(t['observedShare']), pct(t['defaultPriorStrengthShare']))]
    return '\n'.join(lines) + '\n'


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name + '.')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--work', default=str(DEFAULT_WORK), help='Harvester work directory (results/, labels/, feedback.json)')
    ap.add_argument('--web-root', default=str(WEB), help='web/ checkout holding the registry and the GBL schedule')
    ap.add_argument('--registry', help='registry.json to read instead of WEB_ROOT/tests/meta-benchmark/sources/registry.json')
    ap.add_argument('--pool', default=str(DEFAULT_POOL), help='Trainer pool (prepare.cjs output); its speciesIds are the targets')
    ap.add_argument('--out', help='Usage file (default WORK/usage/observed-gl-opponents.json)')
    ap.add_argument('--cups', default=','.join(DEFAULT_CUPS), help='1,500 CP cup IDs to include (default great,mega)')
    ap.add_argument('--include-creator-teams', action='store_true', help='Also write each creator team once per video')
    ap.add_argument('--max-creator-share', type=float, default=DEFAULT_MAX_CREATOR_SHARE, help='Largest weight share of one channel')
    ap.add_argument('--since', help='Keep only teams dated on or after this day (YYYY-MM-DD; recording date, else upload date)')
    ap.add_argument('--until', help='Keep only teams dated on or before this day (YYYY-MM-DD)')
    args = ap.parse_args(argv)
    try:
        since, until = day(args.since), day(args.until)
    except ValueError as e:
        ap.error(str(e))
    if since and until and since > until:
        ap.error('--since %s is after --until %s' % (since, until))
    if not 0 < args.max_creator_share <= 1:
        ap.error('--max-creator-share must be in (0, 1]')
    usage, report = build(args.work, args.web_root, args.pool, args.registry, tuple(c for c in args.cups.split(',') if c),
                          args.include_creator_teams, args.max_creator_share, since=since, until=until)
    out = Path(args.out) if args.out else Path(args.work) / 'usage' / 'observed-gl-opponents.json'
    if not usage['teams']:
        print(markdown(report))
        raise SystemExit('No eligible teams; nothing written.')
    atomic_write(out, json.dumps(usage, indent=1) + '\n')
    atomic_write(out.with_suffix('.report.json'), json.dumps(report, indent=1) + '\n')
    text = markdown(report)
    atomic_write(out.with_suffix('.report.md'), text)
    print(text)
    print('Wrote %s (%d rows, %d teams)' % (out, len(usage['teams']), report['eligibleTeams'] + report['creatorTeams']))


if __name__ == '__main__':
    main()
