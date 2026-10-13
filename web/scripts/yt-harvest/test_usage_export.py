"""Eligibility rules of usage_export.py on a synthetic harvest (no real data)."""
import contextlib
import datetime as dt
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import usage_export as ue

WEB = Path(__file__).resolve().parents[2]
POOL = [('melmetal', 809, 40), ('cramorant', 845, 34), ('quagsire', 195, 3), ('quagsire_shadow', 195, 12),
        ('marowak_alolan', 105, 12), ('altaria', 334, 40), ('mimikyu', 778, 36), ('tinkaton', 959, 32),
        ('ursaluna', 901, 2), ('azumarill', 184, 20), ('medicham', 308, 20), ('registeel', 379, 20),
        ('lanturn', 171, 15), ('skarmory', 227, 15)]


def mon(i, shadow_p=0, form_p=None, key=None):
    m = {'id': i, 'key': key or i.replace('_', ''), 'inference': {'shadowP': shadow_p}}
    if form_p is not None:
        m['inference']['forms'] = [{'id': i, 'p': form_p}]
    return m


MY = [mon('azumarill'), mon('medicham'), mon('registeel')]
OPP = [mon('melmetal'), mon('cramorant', .5), mon('quagsire', .99)]


def battle(start, opponent, my=MY, flags=(), result='Win'):
    return {'start': start, 'end': start + 60, 'result': result, 'my': my, 'opponent': opponent, 'flags': list(flags),
            'fainted': {'my': 1, 'opponent': 3}, 'shieldsUsed': {'my': 2, 'opponent': 2}}


class UsageExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.work, self.web, self.pool = root / 'work', root / 'web', root / 'pool.json'
        self.write(self.pool, {'hash': 'test', 'species': [{'speciesId': i, 'speciesName': i, 'dex': d, 'weight': w} for i, d, w in POOL]})
        self.write(self.web / 'scripts/yt-harvest/data/gbl-schedule.json', {'cups': {
            'great': {'cp': 1500, 'name': 'Great League'}, 'color': {'cp': 1500, 'name': 'Color Cup'}}, 'periods': []})
        videos = {
            'vgreat': ('great', '20261005', 'Channel A', 'GBL climb'),
            'vreup': ('great', '20261007', 'Channel A', 'GBL climb, best battles'),
            'vmega': ('mega@1500', '20261008', 'Channel B', 'Mega Edition'),
            'vcolor': ('color', '20261008', 'Channel B', 'Color Cup'),
            'vultra': ('ultra', '20261008', 'Channel B', 'Ultra League'),
            'vchamp': ('great', '20261008', 'Channel C', 'Louisville Regional Championship finals'),
            'vobscured': ('great', '20261008', 'Channel C', 'Facecam GBL'),
            'vnone': ('great', '20261008', 'Channel C', 'Not a battle'),
            'vrocket': ('great', '20261008', 'Channel C', 'Grunts'),
            'vnodate': ('great', None, 'Channel C', 'Old video'),
        }
        self.write(self.web / 'tests/meta-benchmark/sources/registry.json',
                   [{'id': v, 'leagueId': lg, 'uploadDate': d, 'channel': c, 'title': t} for v, (lg, d, c, t) in videos.items()])
        alt = [mon('altaria'), mon('mimikyu'), mon('tinkaton')]
        self.result('vgreat', [
            battle(10, OPP),                                                     # 0 eligible
            battle(100, OPP[:2]),                                                # 1 partial
            battle(200, [mon('altaria'), mon('sableye_mega'), mon('tinkaton')]),  # 2 unmapped Mega
            battle(300, alt, flags=['More than three opponent species: check boundary']),  # 3 boundary
            battle(400, alt, flags=['Recording starts mid-battle: lead may be missing']),  # 4 lead unknown
            battle(75, OPP, my=MY[:2]),                                          # 5 split from battle 0 (starts 5 s after it ends)
            battle(500, [mon('marowak', form_p=.6, key='marowak'), mon('altaria'), mon('mimikyu')]),  # 6 human form answer
            battle(600, [mon('cramorant_gulping'), mon('ursaluna', key='ursaluna'), mon('lanturn')]),  # 7 alias + Shadow fallback
            battle(700, [mon('marowak', form_p=.6, key='marowak'), mon('altaria'), mon('lanturn')]),  # 8 low form confidence
        ])
        self.result('vreup', [battle(30, OPP)])                                 # re-upload of vgreat battle 0
        self.result('vmega', [battle(10, alt, my=[mon('lanturn'), mon('skarmory'), mon('azumarill')])])
        self.result('vcolor', [battle(10, [mon('lanturn'), mon('azumarill'), mon('skarmory')]), battle(100, alt)])
        self.result('vultra', [battle(10, alt)])
        self.result('vchamp', [battle(10, alt)])
        self.result('vobscured', [battle(10, alt)])
        self.result('vnone', [battle(10, alt)])
        self.result('vrocket', [battle(10, alt)])
        self.result('vnodate', [battle(10, alt)])
        self.write(self.work / 'labels/vrocket.json', {'videoType': 'rocket'})
        self.write(self.work / 'labels/vobscured.json', {'videoType': 'obscured'})
        answer = lambda vid, kind, value, **kw: {'kind': kind, 'recording': vid + '.mp4', 'value': value, 'source': 'reviewer',
                                                 'answeredAt': '2026-10-10T00:00:00+00:00', **kw}
        self.write(self.work / 'feedback.json', {'answers': {
            'a': answer('vnone', 'footage', 'none', allBattles=True),
            'b': answer('vgreat', 'form', 'marowak_alolan', battle=6, side='opponent', key='marowak'),
            'c': answer('vgreat', 'shadow', True, battle=7, side='opponent', key='ursaluna'),
            'd': answer('vcolor', 'league', 'great', battle=1),
            'm': {**answer('vgreat', 'form', 'marowak_alolan', battle=8, side='opponent', key='marowak'), 'source': 'model'},
        }})

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    CUPS = {'vmega': 'mega@1500', 'vcolor': 'color', 'vultra': 'ultra'}

    def result(self, vid, battles):
        self.write(self.work / 'results' / (vid + '.json'), {'full': battles})
        # league.refine_video's sidecar: the cup the video text names (Great League unless listed above).
        cup = self.CUPS.get(vid, 'great')
        cp = 2500 if cup == 'ultra' else 1500
        self.write(self.work / 'results' / (vid + '.leagues.json'), {'video': {}, 'battles': [
            {'start': b['start'], 'league': 'ultra' if cp == 2500 else 'great', 'cpCap': cp, 'cup': cup,
             'cupStatus': 'text-only', 'cupSource': 'title'} for b in battles]})

    def build(self, **kw):
        return ue.build(self.work, self.web, self.pool, today=dt.date(2026, 10, 11), prior_samples=200, **kw)

    def test_uncaptured_cup_is_not_counted_as_open_great_league(self):
        self.write(self.work / 'results/vcolor.leagues.json', {'video': {}, 'battles': [
            {'start': s, 'league': 'great', 'cpCap': 1500, 'cup': None, 'cupStatus': 'uncaptured', 'cupReason': 'no-cup-named'}
            for s in (10, 100)]})
        _, report = self.build()
        self.assertEqual(report['exclusions']['unknown-cup']['count'], 1)   # where the Color Cup battle was 'restricted-cup'
        self.assertNotIn('restricted-cup', report['exclusions'])

    def test_report_says_where_kept_results_came_from(self):
        _, report = self.build()
        self.assertEqual(sum(report['resultSources'].values()), report['eligibleTeams'])
        self.assertEqual([ue.result_from(b) for b in ({'result': 'Win', 'resultSource': 'faints'}, {'result': 'Loss', 'resultSource': 'reviewer'},
                          {'result': 'Win', 'resultSource': 'result screen'}, {'result': 'Unknown', 'resultSource': 'unresolvable'}, {'result': 'Unknown'})],
                         ['inferred', 'human', 'read', 'unresolvable', 'unknown'])

    def test_eligibility_rules_and_reasons(self):
        usage, report = self.build()
        ex = {k: v['count'] for k, v in report['exclusions'].items()}
        self.assertEqual(ex, {'rocket': 1, 'championship': 1, 'footage': 2, 'other-league': 1, 'restricted-cup': 1, 'partial': 2,
                              'boundary': 1, 'lead-unknown': 1, 'unmapped': 1, 'no-date': 1, 'duplicate': 2})
        self.assertEqual(report['eligibleTeams'], 5)
        self.assertEqual(report['unmappedSpecies'], {'sableye_mega': 1})
        self.assertEqual(report['partialTeamsByIdentifiedMembers'], {2: 2})
        teams = sorted((t['members'], t['count'], t['collectedAt']) for t in usage['teams'])
        self.assertEqual(teams, sorted([
            # Confirmed Shadow (.99) keeps the Shadow form; an unknown Shadow (.5) is the base form.
            (['melmetal', 'cramorant', 'quagsire_shadow'], 1, '2026-10-05'),
            # Human form answer beats the low-confidence detection.
            (['marowak_alolan', 'altaria', 'mimikyu'], 1, '2026-10-05'),
            # Gulping Cramorant is Cramorant; a confirmed Shadow Ursaluna falls back to the pool's base form.
            (['cramorant', 'lanturn', 'ursaluna'], 1, '2026-10-05'),
            # Mega Edition, plus a Color Cup battle a human answer moved to Great League: one creator and day, one row.
            (['altaria', 'mimikyu', 'tinkaton'], 2, '2026-10-08'),
        ]))
        self.assertEqual(usage['cp'], 1500)
        self.assertEqual(usage['cup'], 'all')
        self.assertEqual(usage['dateRange'], {'from': '2026-10-05', 'to': '2026-10-08'})
        self.assertEqual(report['creators'], 2)
        self.assertIn('top-tier', usage['source'])
        self.assertIn('biased', usage['rank'])
        self.assertEqual(report['memberMapping']['shadow'], 1)
        self.assertEqual(report['memberMapping']['shadow-fallback'], 1)
        self.assertEqual(report['memberMapping']['base, Shadow unknown'], 1)
        self.assertTrue(all(t['side'] == 'opponent' for t in usage['teams']))

    def test_cups_flag_and_creator_teams_once_per_video(self):
        usage, report = self.build(cups=('great',))
        self.assertEqual(report['exclusions']['restricted-cup']['count'], 2)
        self.assertEqual(report['eligibleTeams'], 4)
        usage, report = self.build(include_creator_teams=True)
        creator = [t for t in usage['teams'] if t['side'] == 'creator']
        # vgreat's creator team appears in four kept battles but is written once; vmega's once; vcolor's once.
        self.assertEqual(sorted(t['members'] for t in creator),
                         sorted([['azumarill', 'medicham', 'registeel'], ['azumarill', 'medicham', 'registeel'],
                                 ['lanturn', 'azumarill', 'skarmory']]))
        self.assertEqual(report['creatorTeams'], 3)

    def test_date_window_keeps_inclusive_bounds_and_counts_the_rest(self):
        full_usage, full = self.build()
        self.assertNotIn('window', full_usage)
        self.assertEqual(full['window'], {'since': None, 'until': None})
        self.assertNotIn('date-range', full['exclusions'])
        # Five teams: three dated 2026-10-05 (Channel A) and two dated 2026-10-08 (Channel B).
        usage, report = self.build(since='2026-10-06')
        self.assertEqual(report['eligibleTeams'], 2)
        self.assertEqual(report['exclusions']['date-range']['count'], 3)
        self.assertEqual(report['dateRange'], {'from': '2026-10-08', 'to': '2026-10-08'})
        self.assertEqual(usage['dateRange'], {'from': '2026-10-08', 'to': '2026-10-08'})
        self.assertEqual(usage['window'], {'since': '2026-10-06', 'until': None})
        self.assertEqual(report['window'], {'since': '2026-10-06', 'until': None})
        self.assertEqual(report['creators'], 1)
        self.assertEqual({t['collectedAt'] for t in usage['teams']}, {'2026-10-08'})
        # Both bounds are inclusive.
        usage, report = self.build(since='2026-10-05', until='2026-10-05')
        self.assertEqual(report['eligibleTeams'], 3)
        self.assertEqual({t['collectedAt'] for t in usage['teams']}, {'2026-10-05'})
        self.assertEqual(report['exclusions']['date-range']['count'], 2)
        usage, report = self.build(until='2026-10-07')
        self.assertEqual(report['eligibleTeams'], 3)
        usage, report = self.build(since='2026-10-05', until='2026-10-08')
        self.assertEqual(report['eligibleTeams'], 5)
        self.assertNotIn('date-range', report['exclusions'])
        # Everything outside the window: nothing to write, and the report says why.
        usage, report = self.build(since='2026-11-01')
        self.assertEqual(usage['teams'], [])
        self.assertEqual(report['exclusions']['date-range']['count'], 5)

    def test_date_window_does_not_change_which_duplicate_is_kept(self):
        # vreup (uploaded 2026-10-07) re-uploads vgreat's first battle (2026-10-05). The window starts after the original:
        # the re-upload is still a duplicate and must not come back as a fresh observation.
        _, full = self.build()
        self.assertEqual(full['exclusions']['duplicate']['count'], 2)
        _, report = self.build(since='2026-10-06')
        self.assertEqual(report['exclusions']['duplicate']['count'], 2)
        self.assertEqual(report['eligibleTeams'], 2)

    def test_date_window_validation(self):
        self.assertEqual(ue.day('2026-10-05'), '2026-10-05')
        self.assertIsNone(ue.day(None))
        self.assertIsNone(ue.day(''))
        for bad in ('20261005', '2026-13-01', '2026-02-30', 'yesterday', '2026-10-5', '2026-10-05T00:00'):
            with self.assertRaises(ValueError, msg=bad):
                ue.day(bad)
        with self.assertRaises(ValueError):
            self.build(since='2026-10-08', until='2026-10-05')
        self.assertTrue(ue.in_window('2026-10-05', None, None))
        self.assertTrue(ue.in_window('2026-10-05', '2026-10-05', '2026-10-05'))
        self.assertFalse(ue.in_window('2026-10-04', '2026-10-05', None))
        self.assertFalse(ue.in_window('2026-10-06', None, '2026-10-05'))
        self.assertFalse(ue.in_window(None, '2026-10-05', None))

    def test_date_window_on_the_command_line(self):
        out = Path(self.tmp.name) / 'usage-window.json'
        base = ['--work', str(self.work), '--web-root', str(self.web), '--pool', str(self.pool), '--out', str(out)]
        for bad in (['--since', '2026-10-08', '--until', '2026-10-05'], ['--since', '10/08/2026']):
            with contextlib.redirect_stderr(io.StringIO()) as complaint, self.assertRaises(SystemExit) as stopped:
                ue.main(base + bad)
            self.assertEqual(stopped.exception.code, 2)
            self.assertIn('error', complaint.getvalue())
        self.assertFalse(out.exists())
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            ue.main(base + ['--since', '2026-10-06', '--until', '2026-10-31'])
        written = json.loads(out.read_text())
        self.assertEqual(written['window'], {'since': '2026-10-06', 'until': '2026-10-31'})
        self.assertEqual({t['collectedAt'] for t in written['teams']}, {'2026-10-08'})
        self.assertIn('window 2026-10-06 to 2026-10-31', printed.getvalue())
        self.assertIn('Outside the --since/--until window', printed.getvalue())

    def test_creator_cap(self):
        k, w = ue.creator_cap({'A': 30, 'B': 5, 'C': 5, 'D': 5, 'E': 5, 'F': 5, 'G': 5, 'H': 5, 'I': 5, 'J': 5, 'K': 5}, .10)
        total = sum(min(n, k) for n in [30] + [5] * 10)
        self.assertAlmostEqual(min(30, k) / total, .10, places=6)
        self.assertAlmostEqual(w['A'] * 30, k)
        self.assertEqual(w['B'], 1.0)
        self.assertEqual(ue.creator_cap({'A': 3, 'B': 3}, .10)[1], {'A': 1.0, 'B': 1.0})   # too few creators: equal totals
        self.assertEqual(ue.creator_cap({'A': 1, 'B': 1, 'C': 1}, .5)[1], {'A': 1.0, 'B': 1.0, 'C': 1.0})
        usage, report = self.build(max_creator_share=.5)
        self.assertLessEqual(report['maxCreatorShare']['after'], .5 + 1e-9)
        self.assertTrue(any(t.get('weight', 1) < 1 for t in usage['teams']))

    def test_dedupe_keeps_earliest_upload(self):
        e = lambda vid, start, date, result='Win': {'videoId': vid, 'start': start, 'end': start + 60, 'collectedAt': date,
                                                    'creator': 'A', 'opponentSet': ('a', 'b', 'c'), 'mySet': ('x', 'y', 'z'),
                                                    'result': result, 'fainted': '1', 'shields': '2'}
        kept, dropped = ue.dedupe([e('late', 0, '2026-10-07'), e('early', 0, '2026-10-05'), e('early', 500, '2026-10-05', 'Loss')])
        self.assertEqual([(k['videoId'], k['start']) for k in kept], [('early', 0), ('early', 500)])
        self.assertEqual([d['videoId'] for d in dropped], ['late'])

    @unittest.skipUnless(shutil.which('node'), 'node not installed')
    def test_file_loads_in_the_trainer(self):
        usage, _ = self.build(max_creator_share=.5)
        out = Path(self.tmp.name) / 'usage.json'
        out.write_text(json.dumps(usage))
        script = ("const {createMeta}=require(process.argv[1]);const pool=require(process.argv[2]).species.map(p=>({...p,scoutByType:Array(18).fill(.5)}));"
                  "const m=createMeta(pool,{usageFile:process.argv[3],halfLifeDays:30,asOf:'2026-10-11',priorStrength:5});"
                  "console.log(JSON.stringify({d:m.description,observed:m.fixtures(400,7).filter(f=>f.component==='observed').length}));")
        run = subprocess.run(['node', '-e', script, str(WEB / 'training/team-search/meta.cjs'), str(self.pool), str(out)],
                             capture_output=True, text=True, check=True)
        got = json.loads(run.stdout)
        self.assertEqual(got['d']['observedCount'], 5)
        self.assertEqual(got['d']['creators'], 2)
        self.assertEqual(got['d']['dateRange'], {'from': '2026-10-05', 'to': '2026-10-08'})
        self.assertTrue(got['d']['creatorWeighted'])
        self.assertGreater(got['observed'], 100)


if __name__ == '__main__':
    unittest.main()
