"""Refresh PvPoke Pro's bundled PvPoke data at the pinned commit.

Writes web/includes/pro/data/:
  league-<cp>.json     the six published ranking categories of the CP's default cup
                       (src/data/rankings/<cup>/<category>/rankings-<cp>.json)
  overrides-<cp>.json  that cup's PvPoke editor overrides and weights (src/data/overrides/<cup>/<cp>.json)
  meta-<cp>.json       the CP's meta group, used by the `meta` search term (src/data/groups/<group>.json)
  published-cups.json  which cups have published rankings at the commit, and at which CPs

Default cups: Little Cup ("little") at 500 CP, the open "all" rankings at 1500 / 2500 / 10000. PvPoke's
"all" at 500 CP is a different population (every Pokémon that fits under 500 CP, evolved or not); GBL's
Little Cup is "little". Other cups load on demand in the app (includes/pro/cups.js).

Usage: python3 web/scripts/fetch-pro-pvpoke-data.py [--index-only]
Set GITHUB_TOKEN to raise the GitHub API rate limit for the directory listings.
"""
from pathlib import Path
import json, os, sys, urllib.request

SHA = 'f627e89e53c0c7b903fff097df7a0ad0ac95decc'
DEFAULT_CUPS = {500: 'little', 1500: 'all', 2500: 'all', 10000: 'all'}
META_GROUPS = {500: 'little', 1500: 'great', 2500: 'ultra', 10000: 'master'}
CATEGORIES = ['overall', 'leads', 'closers', 'switches', 'chargers', 'attackers']
OUT = Path(__file__).resolve().parents[1] / 'includes/pro/data'


def get(url, api=False):
    request = urllib.request.Request(url, headers={'User-Agent': 'gbl-synapse-pro-data'})
    if api and os.environ.get('GITHUB_TOKEN'):
        request.add_header('Authorization', 'Bearer ' + os.environ['GITHUB_TOKEN'])
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def raw(path):
    return get(f'https://raw.githubusercontent.com/pvpoke/pvpoke/{SHA}/{path}')


def listing(path):
    return json.loads(get(f'https://api.github.com/repos/pvpoke/pvpoke/contents/{path}?ref={SHA}', api=True))


def index():
    cups = {}
    for entry in listing('src/data/rankings'):
        if entry['type'] != 'dir':
            continue
        try:
            files = listing(f"src/data/rankings/{entry['name']}/overall")
        except Exception:
            continue
        cps = sorted(int(f['name'][len('rankings-'):-len('.json')]) for f in files
                     if f['name'].startswith('rankings-') and f['name'].endswith('.json'))
        if cps:
            cups[entry['name']] = cps
    return {'sha': SHA, 'defaults': {str(k): v for k, v in DEFAULT_CUPS.items()}, 'cups': dict(sorted(cups.items()))}


def main():
    published = index()
    (OUT / 'published-cups.json').write_text(json.dumps(published, indent=1) + '\n')
    print('published-cups.json:', len(published['cups']), 'cups')
    if '--index-only' in sys.argv:
        return
    for cp, cup in DEFAULT_CUPS.items():
        league = {c: json.loads(raw(f'src/data/rankings/{cup}/{c}/rankings-{cp}.json')) for c in CATEGORIES}
        (OUT / f'league-{cp}.json').write_text(json.dumps(league, separators=(',', ':')))
        (OUT / f'overrides-{cp}.json').write_bytes(raw(f'src/data/overrides/{cup}/{cp}.json'))
        (OUT / f'meta-{cp}.json').write_bytes(raw(f'src/data/groups/{META_GROUPS[cp]}.json'))
        print(f'{cp}: {cup}, {len(league["overall"])} ranked')


if __name__ == '__main__':
    main()
