"""Observed movesets in usage_export.py (the `movesets` of each row and the quality report), on a synthetic harvest."""
import datetime as dt
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import usage_export as ue

WEB = Path(__file__).resolve().parents[2]
POOL = [('melmetal', 809, 40, ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'DYNAMIC_PUNCH']),
        ('cramorant', 845, 34, ['PECK', 'DIVE', 'FLY']),
        ('quagsire', 195, 3, ['MUD_SHOT', 'AQUA_TAIL', 'STONE_EDGE']),
        ('quagsire_shadow', 195, 12, ['MUD_SHOT', 'AQUA_TAIL', 'STONE_EDGE']),
        ('altaria', 334, 40, ['DRAGON_BREATH', 'MOONBLAST', 'FLAMETHROWER']),
        ('mimikyu', 778, 36, ['SHADOW_CLAW', 'SHADOW_SNEAK', 'PLAY_ROUGH']),
        ('tinkaton', 959, 32, ['FAIRY_WIND', 'GIGATON_HAMMER', 'BULLDOZE']),
        ('azumarill', 184, 20, ['BUBBLE', 'ICE_BEAM', 'PLAY_ROUGH']),
        ('medicham', 308, 20, ['PSYCHO_CUT', 'ICE_PUNCH', 'DYNAMIC_PUNCH']),
        ('registeel', 379, 20, ['LOCK_ON', 'FLASH_CANNON', 'FOCUS_BLAST'])]
MY = [{'id': i, 'key': i, 'inference': {'shadowP': 0}} for i in ('azumarill', 'medicham', 'registeel')]
GAMEMASTER = WEB / 'includes/pro/data/gamemaster.json'


def mon(i, fast=None, p=None, key=None, shadow_p=0):
    m = {'id': i, 'key': key or i.replace('_', ''), 'inference': {'shadowP': shadow_p}}
    if fast:
        m['inference']['moves'] = [{'value': fast, 'p': p}]
    return m


def move(actor, name, side='opponent'):
    return {'t': 1, 'kind': 'move', 'side': side, 'actor': actor, 'move': name}


def battle(start, opponent, events=()):
    # Two creator members only: the creator's team is incomplete, so no repeated-battle fingerprint merges these battles.
    return {'start': start, 'end': start + 60, 'result': 'Win', 'my': MY[:2], 'opponent': opponent, 'flags': [], 'events': list(events),
            'fainted': {'my': 1, 'opponent': 3}, 'shieldsUsed': {'my': 2, 'opponent': 2}}


class MovesetExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.work, self.web, self.pool = root / 'work', root / 'web', root / 'pool.json'
        self.write(self.pool, {'hash': 'test', 'species': [{'speciesId': i, 'speciesName': i, 'dex': d, 'weight': w, 'moveset': ms}
                                                           for i, d, w, ms in POOL]})
        self.write(self.web / 'scripts/yt-harvest/data/gbl-schedule.json', {'cups': {'great': {'cp': 1500, 'name': 'Great League'}}, 'periods': []})
        self.write(self.web / 'tests/meta-benchmark/sources/registry.json', [
            {'id': 'vone', 'leagueId': 'great', 'uploadDate': '20261005', 'channel': 'Channel A', 'title': 'GBL climb'},
            {'id': 'vtwo', 'leagueId': 'great', 'uploadDate': '20261006', 'channel': 'Channel B', 'title': 'GBL climb two'}])
        # Channel A, 2026-10-05: four battles with the same opponent team and different evidence.
        # Melmetal: a confident fast move, two charged moves (Rock Slide is outside the recommended pair). Cramorant: p = .6 under
        # the threshold, except where a model-resolved answer exists (battles 0 and 3). Quagsire: no inference; Return is legal for a
        # Shadow-eligible base form.
        events = [move('melmetal', 'ROCK_SLIDE'), move('melmetal', 'DOUBLE_IRON_BASH'), move('melmetal', 'ROCK_SLIDE'),
                  move('cramorant', 'DIVE'), move('quagsire', 'RETURN'), move('azumarill', 'ICE_BEAM', side='my')]
        weak = lambda: [mon('melmetal', 'THUNDER_SHOCK', .97), mon('cramorant', 'WATER_GUN', .6), mon('quagsire')]
        self.result('vone', [battle(10, weak(), events), battle(200, weak(), events),
                             battle(400, [mon('melmetal'), mon('cramorant'), mon('quagsire')], []), battle(600, weak(), events)])
        # Channel B, 2026-10-06: a contradictory member (three distinct charged moves), an illegal charged move, a human answer
        # over a low-confidence inference, a Shadow with Frustration, an invalid fast move and an invented charged move.
        self.result('vtwo', [
            battle(10, [mon('altaria', 'DRAGON_BREATH', .95), mon('mimikyu', 'SHADOW_CLAW', .99), mon('tinkaton', 'ROCK_SMASH', .5)],
                   [move('altaria', 'MOONBLAST'), move('altaria', 'SKY_ATTACK'), move('altaria', 'DRAGON_PULSE'),
                    move('mimikyu', 'HYPER_BEAM'), move('mimikyu', 'PLAY_ROUGH'), move('tinkaton', 'GIGATON_HAMMER')]),
            battle(200, [mon('quagsire_shadow', 'MUD_SHOT', .95, shadow_p=1), mon('altaria', 'PECK', .99), mon('tinkaton', 'FAIRY_WIND', .93)],
                   [move('quagsireshadow', 'FRUSTRATION'), move('tinkaton', 'BULLDOZE')]),
            battle(400, [mon('melmetal', 'NOT_A_MOVE', .99), mon('altaria'), mon('tinkaton')], [move('melmetal', 'MADE_UP')]),
        ])
        answer = lambda vid, kind, value, **kw: {'kind': kind, 'recording': vid + '.mp4', 'value': value, 'source': 'reviewer',
                                                 'answeredAt': '2026-10-10T00:00:00+00:00', 'side': 'opponent', **kw}
        self.write(self.work / 'feedback.json', {'answers': {
            'h': answer('vtwo', 'fastMove', 'ROCK_SMASH', battle=0, key='tinkaton'),
        }, 'resolutions': {
            # observed.model_answers: held-out-gated resolutions (the question id encodes where they apply).
            'x:vone.mp4:0:opponent:cramorant:fast': {'source': 'model', 'value': 'PECK'},
            'x:vone.mp4:3:opponent:cramorant:fast': {'source': 'model', 'value': 'PECK'},
            'x:vone.mp4:2:opponent:melmetal:fast': {'source': 'freellm', 'value': 'THUNDER_SHOCK'},   # external: ignored
        }})

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def result(self, vid, battles):
        self.write(self.work / 'results' / (vid + '.json'), {'full': battles})
        self.write(self.work / 'results' / (vid + '.leagues.json'), {'video': {}, 'battles': [
            {'start': b['start'], 'league': 'great', 'cpCap': 1500, 'cup': 'great', 'cupStatus': 'text-only', 'cupSource': 'title'} for b in battles]})

    def build(self, **kw):
        return ue.build(self.work, self.web, self.pool, today=dt.date(2026, 10, 11), prior_samples=200, **kw)

    def test_rows_split_by_observed_movesets_and_identical_ones_merge(self):
        usage, report = self.build()
        self.assertEqual(report['eligibleTeams'], 7)
        rows = [t for t in usage['teams'] if t['members'] == ['melmetal', 'cramorant', 'quagsire']]
        self.assertEqual(sorted(t['count'] for t in rows), [1, 1, 2])
        free = [t for t in rows if 'movesets' not in t]
        self.assertEqual([t['count'] for t in free], [1])               # battle 2: no usable move; the freellm resolution is not an answer
        merged = next(t for t in rows if t['count'] == 2)               # battles 0 and 3 observed the same movesets
        self.assertEqual(sorted(merged['battles']), ['vone:0', 'vone:3'])
        melmetal, cramorant, quagsire = merged['movesets']
        self.assertEqual(melmetal, {'fast': 'THUNDER_SHOCK', 'charged': ['ROCK_SLIDE', 'DOUBLE_IRON_BASH']})   # order of first use, each once
        self.assertEqual(cramorant, {'fast': 'PECK', 'charged': ['DIVE']})                                      # model-resolved answer beats p = .6
        self.assertEqual(quagsire, {'fast': None, 'charged': ['RETURN']})
        lone = next(t for t in rows if t['count'] == 1 and 'movesets' in t)   # battle 1: no model answer, so Cramorant's p = .6 is dropped
        self.assertEqual(lone['movesets'][1], {'fast': None, 'charged': ['DIVE']})
        self.assertEqual(lone['battles'], ['vone:1'])

    def test_human_beats_model_beats_inference_and_bad_moves_are_dropped_and_counted(self):
        usage, report = self.build()
        row = next(t for t in usage['teams'] if t['members'] == ['altaria', 'mimikyu', 'tinkaton'])
        altaria, mimikyu, tinkaton = row['movesets']
        self.assertEqual(tinkaton, {'fast': 'ROCK_SMASH', 'charged': ['GIGATON_HAMMER']})   # a reviewer's answer over a .5 inference
        self.assertEqual(altaria, {'fast': 'DRAGON_BREATH', 'charged': []})                 # three distinct charged moves: contradictory
        self.assertEqual(mimikyu, {'fast': 'SHADOW_CLAW', 'charged': ['PLAY_ROUGH']})       # Hyper Beam is not in Mimikyu's pool
        shadow = next(t for t in usage['teams'] if t['members'][0] == 'quagsire_shadow')
        self.assertEqual(shadow['movesets'][0], {'fast': 'MUD_SHOT', 'charged': ['FRUSTRATION']})
        self.assertEqual(shadow['movesets'][1], {'fast': 'PECK', 'charged': []})
        self.assertEqual(shadow['movesets'][2], {'fast': 'FAIRY_WIND', 'charged': ['BULLDOZE']})
        invalid = next(t for t in usage['teams'] if t['members'][0] == 'melmetal' and t['collectedAt'] == '2026-10-06')
        self.assertNotIn('movesets', invalid)                                                # nothing valid left: no key at all
        m = report['movesets']
        self.assertEqual(m['dropped'], {'lowConfidenceFast': 1, 'illegalFast': 1, 'illegalCharged': 2, 'conflictingCharged': 1})
        self.assertEqual(m['fastBySource'], {'inference': 8, 'model': 2, 'reviewer': 1})

    def test_threshold_is_inclusive_at_point_nine(self):
        book = ue.load_move_book(GAMEMASTER)
        member = lambda p, **kw: {'key': 'melmetal', 'fastMove': 'THUNDER_SHOCK', 'fastMoveConfidence': p, 'fastMoveSource': 'inference', **kw}
        self.assertEqual(ue.member_moves(member(.90), [], 'opponent', 'melmetal', book)[0], {'fast': 'THUNDER_SHOCK', 'charged': [], 'fastSource': 'inference'})
        self.assertIsNone(ue.member_moves(member(.8999), [], 'opponent', 'melmetal', book)[0])
        self.assertIsNone(ue.member_moves(member(None), [], 'opponent', 'melmetal', book)[0])
        self.assertEqual(ue.member_moves(member(.2, fastMoveSource='reviewer'), [], 'opponent', 'melmetal', book)[0]['fastSource'], 'reviewer')
        # An event credited to another side or another Pokemon is not this member's.
        events = [move('melmetal', 'ROCK_SLIDE', side='my'), move('registeel', 'ROCK_SLIDE'), {'kind': 'shield', 'side': 'opponent'}]
        self.assertIsNone(ue.member_moves({'key': 'melmetal'}, events, 'opponent', 'melmetal', book)[0])
        self.assertIsNone(ue.member_moves({'key': 'melmetal', 'fastMove': 'THUNDER_SHOCK', 'fastMoveConfidence': 1}, [], 'opponent', 'not_a_species', book)[0])

    def test_pools_include_return_and_frustration_like_the_vendor_pokemon(self):
        book = ue.load_move_book(GAMEMASTER)
        self.assertIn('RETURN', book.legal('quagsire')['charged'])            # Shadow-eligible, level 25 CP 1191 <= 1500
        self.assertNotIn('RETURN', book.legal('quagsire_shadow')['charged'])
        self.assertIn('FRUSTRATION', book.legal('quagsire_shadow')['charged'])
        self.assertNotIn('FRUSTRATION', book.legal('quagsire')['charged'])
        self.assertIn('RETURN', book.legal('registeel')['charged'])           # level 25 CP 1484
        self.assertNotIn('RETURN', book.legal('melmetal')['charged'])         # not Shadow-eligible
        self.assertIn('THUNDER_SHOCK', book.legal('melmetal')['fast'])
        self.assertNotIn('THUNDER_SHOCK', book.legal('melmetal')['charged'])
        self.assertNotIn('ROCK_SLIDE', book.legal('melmetal')['fast'])
        self.assertIsNone(book.legal('not_a_species'))

    def test_report_counts_members_and_differences_from_the_recommendation(self):
        usage, report = self.build()
        m = report['movesets']
        self.assertEqual((m['members'], m['battles'], m['battlesWithMoves']), (21, 7, 5))
        self.assertEqual((m['withFast'], m['withCharged'], m['withFastAndCharged']), (11, 13, 9))
        self.assertAlmostEqual(m['withFastShare'], 11 / 21)
        self.assertAlmostEqual(m['withChargedShare'], 13 / 21)
        # Fast moves that are not the recommended one: Tinkaton's Rock Smash (reviewer) and Altaria's Peck.
        self.assertEqual(m['fastDiffersFromRecommended'], {'count': 2, 'of': 11, 'share': 2 / 11})
        # Charged moves outside the recommended pair: Rock Slide (3), Return (3) and Frustration (1).
        self.assertEqual(m['chargedOutsideRecommended'], {'count': 7, 'of': 13, 'share': 7 / 13})
        self.assertEqual(m['membersDifferingFromRecommended'], {'count': 9, 'share': 9 / 21})
        self.assertEqual(m['teamsWithADifferingMember'], 5)
        text = ue.markdown(report)
        self.assertIn('## Observed movesets', text)
        self.assertIn('Observed fast move differs from the recommended one | 2 of 11', text)
        self.assertIn('conflictingCharged 1', text)

    def test_no_movesets_flag_and_no_book_leave_the_file_as_before(self):
        usage, report = self.build(movesets=False)
        self.assertTrue(all('movesets' not in t for t in usage['teams']))
        self.assertNotIn('movesets', usage)
        self.assertIsNone(report['movesets'])
        self.assertNotIn('Observed movesets', ue.markdown(report))
        # Rows that differ only in movesets merge again: the same appearances, fewer rows.
        with_moves, _ = self.build()
        self.assertEqual(sum(t['count'] for t in usage['teams']), sum(t['count'] for t in with_moves['teams']))
        self.assertLess(len(usage['teams']), len(with_moves['teams']))

    def test_every_written_move_is_a_known_move_of_the_right_kind(self):
        usage, _ = self.build()
        book = ue.load_move_book(GAMEMASTER)
        for t in usage['teams']:
            for species_id, x in zip(t['members'], t.get('movesets') or [None] * 3):
                if x is None:
                    continue
                legal = book.legal(species_id)
                if x['fast'] is not None:
                    self.assertIn(x['fast'], legal['fast'])
                self.assertLessEqual(len(x['charged']), ue.MAX_CHARGED)
                self.assertEqual(len(set(x['charged'])), len(x['charged']))
                for c in x['charged']:
                    self.assertIn(c, legal['charged'])
                self.assertNotIn('fastSource', x)

    @unittest.skipUnless(shutil.which('node'), 'node not installed')
    def test_the_trainer_reads_the_file_with_and_without_observed_moves(self):
        usage, _ = self.build(max_creator_share=.9)
        out = Path(self.tmp.name) / 'usage.json'
        out.write_text(json.dumps(usage))
        script = ("const {loadUsage}=require(process.argv[1]);const pool=require(process.argv[2]).species.map(p=>({...p,scoutByType:Array(18).fill(.5)}));"
                  "const off=loadUsage(process.argv[3],pool),on=loadUsage(process.argv[3],pool,{observedMoves:true});"
                  "console.log(JSON.stringify({off:off.rows.length,on:on.rows.length,total:[off.total,on.total],moved:on.rows.filter(r=>r.movesets.some(Boolean)).length}));")
        run = subprocess.run(['node', '-e', script, str(WEB / 'training/team-search/meta.cjs'), str(self.pool), str(out)], capture_output=True, text=True, check=True)
        got = json.loads(run.stdout)
        self.assertEqual(got['total'][0], got['total'][1])
        self.assertGreaterEqual(got['on'], got['off'])
        self.assertGreaterEqual(got['moved'], 1)


if __name__ == '__main__':
    unittest.main()
