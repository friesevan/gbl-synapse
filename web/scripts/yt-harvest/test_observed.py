import json
from pathlib import Path
import tempfile
import unittest
from observed import ObservedCatalog


class ObservedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.work, self.web = self.root / 'work', self.root / 'web'
        self.result = self.work / 'results/video123.json'
        self.write(self.result, {'full': [{'start': 10.5, 'end': 100, 'result': 'Loss', 'leadConfirmed': False,
            'my': [{'id': 'machamp', 'key': 'machamp', 'inference': {'shadowP': .5}}],
            'opponent': [{'id': 'umbreon', 'key': 'umbreon', 'inference': {'shadowP': 0}}],
            'hp': {'t0': 10.5, 'step': .5, 'my': {'machamp': [1, .9]}, 'opponent': {'umbreon': [1, .8]}},
            'events': [{'t': 50, 'kind': 'shield', 'side': 'my'}]}]})
        self.write(self.web / 'tests/meta-benchmark/sources/registry.json', [{'id': 'video123', 'title': 'A match', 'uploadDate': '20261010', 'leagueId': 'willpower'}])
        self.write(self.web / 'scripts/yt-harvest/data/gbl-schedule.json', {'cups': {'willpower': {'cp': 1500, 'name': 'Willpower Cup'}}, 'periods': [
            {'start': '2026-10-01', 'end': '2026-10-07', 'formats': [{'id': 'willpower', 'cp': 1500}], 'source': 'schedule'}]})
        self.catalog = ObservedCatalog(self.work, self.web)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def test_normalization_and_uncertainty(self):
        state = self.catalog.state()
        o = state['occurrences'][0]
        self.assertEqual(o['id'], 'video123:battle:0')
        self.assertIn('&t=10s', o['source']['url'])
        self.assertEqual(o['league']['name'], 'Great League')
        self.assertIsNone(o['battle']['my'][0]['shadow'])
        self.assertTrue(o['battle']['my'][0]['uncertain'])
        self.assertFalse(o['complete']['my'])
        self.assertEqual(o['timeline']['hp']['my']['machamp'], [100, 90])
        self.assertIsNone(o['battleDate'])
        self.assertFalse(o['dateVerified'])
        self.assertTrue(o['cupRange']['estimated'])
        self.assertEqual(o['cupRange']['start'], '2026-10-01')
        self.assertEqual(o['cupRange']['source'], 'upload-date')
        self.assertEqual(o['league']['cup'], 'Willpower Cup')
        self.assertEqual(o['timeline']['events'][0]['t'], 39.5)
        self.assertEqual(o['timeline']['duration'], 89.5)
        self.assertIs(state, self.catalog.state())

    def test_feedback_authority_and_cache_invalidates(self):
        before = self.catalog.state()
        self.write(self.work / 'feedback.json', {'answers': {
            's': {'kind': 'shadow', 'side': 'my', 'key': 'machamp', 'battle': 0, 'recording': 'video123.mp4', 'value': True, 'source': 'reviewer'},
            'r': {'kind': 'result', 'battle': 0, 'recording': 'video123.mp4', 'value': 'Win:opponent-forfeit', 'source': 'reviewer'},
            'model': {'kind': 'form', 'side': 'my', 'key': 'machamp', 'battle': 0, 'recording': 'video123.mp4', 'value': 'ditto', 'source': 'model'}}})
        after = self.catalog.state()
        self.assertNotEqual(before['revision'], after['revision'])
        b = after['occurrences'][0]['battle']
        self.assertTrue(b['my'][0]['shadow'])
        self.assertEqual(b['my'][0]['id'], 'machamp')
        self.assertEqual(b['result'], 'Win')
        self.assertEqual(b['ending'], 'opponent-forfeit')
        self.assertEqual(b['resultSource'], 'reviewer')

    def test_ambiguous_cup_range_and_verified_date(self):
        path = self.web / 'scripts/yt-harvest/data/gbl-schedule.json'
        s = json.loads(path.read_text())
        s['periods'].append({'start': '2026-10-08', 'end': '2026-10-14', 'formats': [{'id': 'willpower', 'cp': 1500}]})
        self.write(path, s)
        o = self.catalog.state()['occurrences'][0]
        self.assertIsNone(o['cupRange']['start'])
        self.assertEqual(len(o['cupRange']['candidates']), 2)
        raw = json.loads(self.result.read_text())
        raw.update(battleDate='2026-10-09', dateVerified=True)
        self.write(self.result, raw)
        o = self.catalog.state()['occurrences'][0]
        self.assertTrue(o['dateVerified'])
        self.assertFalse(o['cupRange']['estimated'])
        self.assertEqual(o['cupRange']['start'], '2026-10-08')

    def test_refit_result_is_used_without_old_posterior(self):
        self.write(self.work / 'feedback.json', {'learning': {'version': 3}})
        raw = json.loads(self.result.read_text())
        raw['battles'] = [{'myDetail': [{'form': {'id': 'machamp', 'p': 1}, 'shadowP': 0, 'fastMove': {'id': 'COUNTER', 'p': 1}}]}]
        raw['full'][0]['my'][0]['inference']['shadowP'] = .999
        self.write(self.work / 'learning/refit-3/video123.json', raw)
        self.assertTrue(self.catalog.state()['occurrences'][0]['battle']['my'][0]['shadow'])
        raw['full'][0]['my'][0]['inference']['shadowP'] = 0
        self.write(self.result, raw)
        self.assertFalse(self.catalog.state()['occurrences'][0]['battle']['my'][0]['shadow'])

    def test_complete_teams_stay_separate_and_result_files_only(self):
        raw = json.loads(self.result.read_text())
        raw['full'][0]['my'] = [{'id': p, 'inference': {'shadowP': 0}} for p in ('machamp', 'umbreon', 'hypno')]
        self.write(self.result, raw)
        self.write(self.work / 'results/video123.leagues.json', {'battles': [{'start': 10.5, 'best': 'willpower', 'cpCap': 1500}]})
        self.write(self.work / 'results/batch-summary.json', {'battles': [{'start': 0}]})
        s = self.catalog.state()
        self.assertEqual(len(s['occurrences']), 1)
        self.assertTrue(s['occurrences'][0]['complete']['my'])
        self.assertFalse(s['occurrences'][0]['complete']['opponent'])
        self.assertEqual(s['summary']['completeCreatorTeams'], 1)

    def test_rocket_excluded_championship_separate_and_lead_confirmed(self):
        team = [{'id': s, 'key': s, 'label': s.title(), 'inference': {'shadowP': 0, 'forms': [{'value': s, 'p': 1}]}} for s in ('azumarill', 'medicham', 'lugia')]
        self.write(self.result, {'battles': [{'start': 10.5, 'opponent': ['Azumarill', 'Medicham', 'Lugia']}, {'start': 200}],
                                 'full': [{'start': 10.5, 'end': 100, 'my': team, 'opponent': team},
                                          {'start': 200, 'end': 300, 'my': team, 'opponent': team}]})
        self.write(self.work / 'results/video123.leagues.json', {'video': {}, 'battles': [{'start': 10.5, 'best': 'great'},
                   {'start': 200, 'best': 'master', 'rocket': True, 'battleType': 'rocket'}]})
        state = self.catalog.state()
        self.assertEqual(len(state['occurrences']), 1)
        self.assertEqual(state['summary']['excluded']['rocket'], 1)
        # A reviewer's league answer overrides the automatic Rocket flag; a Rocket answer excludes the battle.
        self.write(self.work / 'feedback.json', {'answers': {
            'l': {'kind': 'league', 'battle': 1, 'recording': 'video123.mp4', 'value': 'great', 'source': 'reviewer', 'answeredAt': '1'},
            'lead': {'kind': 'lead', 'battle': 0, 'recording': 'video123.mp4', 'value': 'Lugia', 'source': 'reviewer', 'answeredAt': '1'}}})
        state = self.catalog.state()
        self.assertEqual(len(state['occurrences']), 2)
        first = next(o for o in state['occurrences'] if o['battleIndex'] == 0)
        self.assertTrue(first['battle']['leadConfirmed'])
        self.assertEqual(first['battle']['opponent'][0]['id'], 'lugia')
        self.write(self.work / 'labels/video123.json', {'videoType': 'championship', 'verified': {}})
        state = self.catalog.state()
        leagues = {o['league']['name'] for o in state['occurrences']}
        self.assertEqual(leagues, {'Championship'})
        self.assertEqual(state['occurrences'][0]['league']['format'], 'championship')
        self.assertEqual(state['summary']['championshipBattles'], 2)

    def test_corrupt_results_are_not_silent(self):
        self.result.write_text('{')
        s = self.catalog.state()
        self.assertEqual(s['occurrences'], [])
        self.assertEqual(len(s['summary']['errors']), 1)


if __name__ == '__main__':
    unittest.main()
