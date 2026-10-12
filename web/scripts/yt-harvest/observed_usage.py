"""Observed per-Pokemon usage for PvPoke Pro's opponent weights (GET /api/observed-usage).

Counts only; the weight formula (smoothing toward PvPoke, Shadow split, lead bonus) runs in the browser
(includes/pro/observed-weights.js) so it can follow the user's roster. The counting matches the Observed meta's
"Pokemon usage" tab (includes/meta/observed-core.js analyze(), opponent side): a lineup counts when its three
species/forms are settled (identified or Shadow-unknown) and distinct; per species we count lineups containing it,
confirmed leads, and Shadow yes/no/unknown. Creators' own teams are not counted (one player's choice, repeated).

Grouping: the battle's league CP and its cup from the video text (league.cupId), only when the schedule ran that cup
(cupRange.status "text-confirmed"; repeat-cup battles carry all their periods). One group per (CP, cup, season) pools
every period of that cup in the season; season "all" pools across seasons. Uncaptured cups, text-only cups
(no schedule record or a disagreement) and championships are left out.
"""
import threading

FORMAT = 'gbl-synapse-observed-usage'
VERSION = 1


def _status(m):
    """observed-core.js status(): (id, formKnown, shadow True/False/None) of a catalog member."""
    m = m if isinstance(m, dict) else {'id': m}
    ident = str(m.get('id') or '')
    shadow_suffix = ident.endswith('_shadow')
    ident = ident.removesuffix('_shadow')
    why = m.get('why') if isinstance(m.get('why'), list) else []
    form_known = bool(ident) and not any(isinstance(w, dict) and w.get('kind') in ('species', 'form') for w in why)
    shadow = True if (shadow_suffix or m.get('shadow') is True) else None if m.get('shadow') is None else False
    return ident, form_known, shadow


def _season_name(schedule, season):
    for s in schedule.get('seasons') or []:
        if isinstance(s, dict) and s.get('season') == season:
            return s.get('name')
    return None


def _cup_name(schedule, cup, cp, fallback):
    for p in schedule.get('periods') or []:
        for f in p.get('formats') or []:
            if f.get('id') == cup and f.get('cp') == cp and f.get('name'):
                return f['name']
    return fallback or ((schedule.get('cups') or {}).get(cup) or {}).get('name') or cup


def groups(occurrences, schedule):
    """Usage counts per (cp, cup, season) and per (cp, cup, 'all')."""
    out = {}
    for o in occurrences or []:
        league, rng = o.get('league') or {}, o.get('cupRange') or {}
        cp, cup = league.get('cp'), league.get('cupId')
        if league.get('format') == 'championship' or o.get('battleType') == 'rocket' or not cp or not cup:
            continue
        if rng.get('status') != 'text-confirmed':
            continue
        season = rng.get('season')
        periods = [(p.get('start'), p.get('end')) for p in rng.get('periods') or [] if isinstance(p, dict)] \
            or [(rng.get('start'), rng.get('end'))]
        team = (o.get('battle') or {}).get('opponent') or []
        st = [_status(m) for m in team]
        complete = len(st) == 3 and all(s[1] for s in st) and len({s[0] for s in st}) == 3
        lead = bool((o.get('battle') or {}).get('leadConfirmed'))
        day = o.get('battleDate') or (o.get('source') or {}).get('uploadDate')
        channel = (o.get('source') or {}).get('channel')
        for key in ((cp, cup, season), (cp, cup, 'all')):
            if key[2] is None:
                continue
            g = out.setdefault(key, {'cp': cp, 'cup': cup, 'season': key[2], 'battles': 0, 'lineups': 0, 'leadLineups': 0,
                                     'creators': set(), 'first': None, 'last': None, 'periods': {}, 'seasons': set(),
                                     'cupName': league.get('cup'), 'species': {}})
            g['battles'] += 1
            if season is not None:
                g['seasons'].add(season)
            if channel:
                g['creators'].add(channel)
            if day:
                g['first'] = day if not g['first'] or day < g['first'] else g['first']
                g['last'] = day if not g['last'] or day > g['last'] else g['last']
            for p in periods:
                if p[0] or p[1]:
                    g['periods'][p] = g['periods'].get(p, 0) + 1
            if not complete:
                continue
            g['lineups'] += 1
            if lead:
                g['leadLineups'] += 1
            for i, (ident, _, shadow) in enumerate(st):
                u = g['species'].setdefault(ident, {'teams': 0, 'leads': 0, 'shadow': {'yes': 0, 'no': 0, 'unknown': 0}})
                u['teams'] += 1
                if lead and i == 0:
                    u['leads'] += 1
                u['shadow']['yes' if shadow is True else 'no' if shadow is False else 'unknown'] += 1
    rows = []
    for (cp, cup, season), g in out.items():
        seasons = sorted(g.pop('seasons'))
        rows.append({**g, 'cupName': _cup_name(schedule, cup, cp, g['cupName']),
                     'seasonName': 'All seasons' if season == 'all' else _season_name(schedule, season),
                     'seasons': seasons, 'creators': len(g['creators']),
                     'periods': [{'start': s, 'end': e, 'battles': n} for (s, e), n in sorted(g['periods'].items(), key=lambda x: (str(x[0][0]), str(x[0][1])))],
                     'species': dict(sorted(g['species'].items(), key=lambda kv: (-kv[1]['teams'], kv[0])))})
    rows.sort(key=lambda r: (r['cp'], r['cup'], r['season'] == 'all', -1 if r['season'] == 'all' else -float(r['season'])))
    return rows


def payload(state, schedule, generated=None):
    return {'format': FORMAT, 'version': VERSION, 'revision': state.get('revision'), 'generated': generated,
            'side': 'opponent', 'basis': 'text-confirmed cups; settled lineups (three distinct species/forms)',
            'groups': groups(state.get('occurrences'), schedule)}


def select(value, cp=None, cup=None, season=None):
    """The ?cp=&cup=&season= filter of the endpoint (any omitted part matches everything)."""
    rows = value['groups']
    if cp not in (None, ''):
        rows = [g for g in rows if str(g['cp']) == str(cp)]
    if cup not in (None, ''):
        rows = [g for g in rows if g['cup'] == cup]
    if season not in (None, ''):
        rows = [g for g in rows if str(g['season']) == str(season)]
    return {**value, 'groups': rows}


class ObservedUsage:
    """Cached by the observed catalog's revision (which covers results, labels, feedback and the schedule)."""

    def __init__(self, catalog, schedule_reader):
        self.catalog, self.schedule_reader = catalog, schedule_reader
        self.lock = threading.Lock()
        self._cache = (None, None)

    def state(self):
        state = self.catalog.state()
        with self.lock:
            if self._cache[0] != state['revision']:
                import datetime as dt
                self._cache = (state['revision'], payload(state, self.schedule_reader(), dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')))
            return self._cache[1]
