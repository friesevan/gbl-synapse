import json
from pathlib import Path
import tempfile
import sys
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
        self.write(self.web / 'tests/meta-benchmark/sources/registry.json', [{'id': 'video123', 'title': 'A Willpower Cup match', 'uploadDate': '20261010', 'leagueId': 'willpower'}])
        # league.refine_video's sidecar: the league from the CPs, the cup from the title, checked against the schedule.
        self.write(self.work / 'results/video123.leagues.json', {'video': {}, 'battles': [{'start': 10.5, 'league': 'great', 'cpCap': 1500,
                   'cup': 'willpower', 'cupName': 'Willpower Cup', 'cupStatus': 'text-confirmed', 'cupSource': 'title', 'cupConfidence': 1.0}]})
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
        self.assertEqual((o['cupRange']['status'], o['league']['cupSource']), ('text-confirmed', 'title'))
        self.assertEqual(state['summary']['cupStatusByLeague'], {'Great League': {'text-confirmed': 1}})
        self.assertEqual(o['timeline']['events'][0]['t'], 39.5)
        self.assertEqual(o['timeline']['duration'], 89.5)
        self.assertIs(state, self.catalog.state())

    def test_uncaptured_cup_stays_under_its_league_with_a_schedule_hint(self):
        side = self.work / 'results/video123.leagues.json'
        self.write(side, {'video': {}, 'battles': [{'start': 10.5, 'league': 'great', 'cpCap': 1500, 'cup': None,
                                                    'cupStatus': 'uncaptured', 'cupReason': 'no-cup-named'}]})
        o = self.catalog.state()['occurrences'][0]
        self.assertEqual((o['league']['name'], o['league']['cp'], o['league']['cup'], o['league']['cupId']), ('Great League', 1500, 'unknown', None))
        r = o['cupRange']   # the registry's pre-analysis guess ("willpower") never becomes the cup
        self.assertEqual((r['status'], r['reason'], r['start']), ('uncaptured', 'no-cup-named', None))
        self.assertEqual([x['id'] for x in r['scheduled']], ['willpower'])   # a hint only
        # A sidecar written before the text rule (no cupStatus): uncaptured, its schedule-ranked "best" ignored.
        self.write(side, {'battles': [{'start': 10.5, 'best': 'willpower', 'cpCap': 1500}]})
        r = self.catalog.state()['occurrences'][0]['cupRange']
        self.assertEqual((r['status'], r['reason']), ('uncaptured', 'not-refined'))
        # A text cup the schedule never ran at that CP on those dates: text-only, saying what ran instead.
        self.write(side, {'battles': [{'start': 10.5, 'league': 'great', 'cpCap': 1500, 'cup': 'great', 'cupStatus': 'text-only', 'cupSource': 'tags'}]})
        o = self.catalog.state()['occurrences'][0]
        self.assertEqual((o['league']['cup'], o['cupRange']['status'], o['cupRange']['reason']), ('all', 'text-only', 'disagrees'))
        self.assertEqual([x['id'] for x in o['cupRange']['scheduled']], ['willpower'])
        # A reviewer's league answer is the cup.
        self.write(self.work / 'feedback.json', {'answers': {'l': {'kind': 'league', 'battle': 0, 'recording': 'video123.mp4',
                                                                   'value': 'willpower', 'source': 'reviewer', 'answeredAt': '1'}}})
        o = self.catalog.state()['occurrences'][0]
        self.assertEqual((o['league']['cupSource'], o['cupRange']['status']), ('reviewer', 'text-confirmed'))

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

    def test_timeline_results_count_like_detected_ones_and_human_answers_still_win(self):
        raw = json.loads(self.result.read_text())
        raw['full'][0].update(result='Unknown', resultSource='')
        self.write(self.result, raw)
        qid = 'claude-test:video123.mp4:0:result'
        self.write(self.work / 'feedback.json', {'answers': {}, 'resolutions': {qid: {'source': 'timeline', 'value': 'Loss:you-forfeit', 'rule': 'surrender'}}})
        b = self.catalog.state()['occurrences'][0]['battle']
        self.assertEqual((b['result'], b['ending'], b['resultSource']), ('Loss', 'you-forfeit', 'surrender'))
        self.write(self.work / 'feedback.json', {'answers': {}, 'resolutions': {qid: {'source': 'policy', 'value': None, 'policy': 'no-result-screen'}}})
        b = self.catalog.state()['occurrences'][0]['battle']
        self.assertEqual((b['result'], b['resultSource']), ('Unknown', 'unresolvable'))
        self.write(self.work / 'feedback.json', {'answers': {qid: {'kind': 'result', 'battle': 0, 'recording': 'video123.mp4', 'value': 'Win', 'source': 'reviewer'}},
                                                 'resolutions': {qid: {'source': 'timeline', 'value': 'Loss', 'rule': 'faints'}}})
        b = self.catalog.state()['occurrences'][0]['battle']
        self.assertEqual((b['result'], b['resultSource']), ('Win', 'reviewer'))

    def test_read_result_screens_keep_priority_and_legacy_sources_are_renamed(self):
        raw = json.loads(self.result.read_text())
        raw['full'][0].update(result='Win', resultSource='Poké Ball count')
        self.write(self.result, raw)
        self.assertEqual(self.catalog.state()['occurrences'][0]['battle']['resultSource'], 'faints')
        raw['full'][0].update(result='Loss', resultSource='result screen')
        self.write(self.result, raw)
        self.write(self.work / 'feedback.json', {'answers': {}, 'resolutions': {'claude-test:video123.mp4:0:result': {'source': 'timeline', 'value': 'Win', 'rule': 'faints'}}})
        b = self.catalog.state()['occurrences'][0]['battle']
        self.assertEqual((b['result'], b['resultSource']), ('Loss', 'result screen'))

    def test_repeat_cup_is_assigned_to_the_cup_and_verified_date_narrows_it(self):
        path = self.web / 'scripts/yt-harvest/data/gbl-schedule.json'
        s = json.loads(path.read_text())
        s['periods'].append({'start': '2026-10-08', 'end': '2026-10-14', 'formats': [{'id': 'willpower', 'cp': 1500}]})
        self.write(path, s)
        o = self.catalog.state()['occurrences'][0]
        r = o['cupRange']      # the same cup ran twice in the window: assigned to the cup, both periods listed
        self.assertEqual((r['status'], r['repeat'], r['start'], r['end']), ('text-confirmed', True, '2026-10-01', '2026-10-14'))
        self.assertEqual([(p['start'], p['end']) for p in r['periods']], [('2026-10-01', '2026-10-07'), ('2026-10-08', '2026-10-14')])
        self.assertEqual(self.catalog.state()['summary']['periodStatus']['repeat-cup'], 1)
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
        # Lead answers now store the member key (labels show "Shadow Ninetales (Alolan)"); "Not Team Rocket" ("gbl")
        # clears the automatic flag without naming a cup.
        self.write(self.work / 'feedback.json', {'answers': {
            'l': {'kind': 'league', 'battle': 1, 'recording': 'video123.mp4', 'value': 'gbl', 'source': 'reviewer', 'answeredAt': '1'},
            'lead': {'kind': 'lead', 'battle': 0, 'recording': 'video123.mp4', 'value': 'medicham', 'label': 'Medicham',
                     'source': 'reviewer', 'answeredAt': '1'}}})
        state = self.catalog.state()
        self.assertEqual(len(state['occurrences']), 2)
        second = next(o for o in state['occurrences'] if o['battleIndex'] == 1)
        self.assertEqual((second['league']['cupId'], second['cupRange']['status']), (None, 'uncaptured'))
        first = next(o for o in state['occurrences'] if o['battleIndex'] == 0)
        self.assertEqual((first['battle']['opponent'][0]['id'], first['battle']['leadConfirmed']), ('medicham', True))
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


class ModelAnswerTests(unittest.TestCase):
    def test_model_resolutions_parse_and_skip_free_llm(self):
        import observed
        fb = {"resolutions": {
            "claude-test:v1.mp4:3:opponent:corviknight:fast": {"value": "SAND_ATTACK", "source": "model"},
            "claude-test:v1.mp4:0:my:azumarill:shadow": {"value": False, "source": "model"},
            "youtube-harvest:v1.mp4:footage": {"value": "none", "source": "freellm"}}}
        got = sorted(observed.model_answers(fb), key=lambda a: a["kind"])
        self.assertEqual([(a["kind"], a["side"], a["key"], a["battle"], a["allBattles"]) for a in got],
                         [("fastMove", "opponent", "corviknight", 3, False), ("shadow", "my", "azumarill", 0, True)])
        self.assertTrue(all(not observed.human(a) for a in got))


class UnidentifiedLineupTests(unittest.TestCase):
    """Why a lineup is unidentified, its Validate links, and automatic reclassification on the next poll."""
    QID = 'claude-test:video123.mp4:0:opponent:umbreon:shadow'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.work, self.web = root / 'work', root / 'web'
        team = [{'id': 'azumarill', 'key': 'azumarill', 'inference': {'shadowP': 0, 'forms': [{'value': 'azumarill', 'p': 1}]}},
                {'id': 'umbreon', 'key': 'umbreon', 'inference': {'shadowP': .62, 'forms': [{'value': 'umbreon', 'p': 1}]}},
                {'key': 'ninetales', 'inference': {'shadowP': 0, 'forms': [{'value': 'ninetales_alolan', 'p': .91}, {'value': 'ninetales', 'p': .09}]}}]
        self.write(self.work / 'results/video123.json', {'full': [{'start': 5, 'end': 90, 'result': 'Win', 'my': [], 'opponent': team}]})
        self.write(self.web / 'tests/meta-benchmark/sources/registry.json',
                   [{'id': 'video123', 'title': 'A match', 'uploadDate': '20261010', 'leagueId': 'great', 'channel': 'Creator A'}])
        self.write(self.web / 'scripts/yt-harvest/data/gbl-schedule.json', {'cups': {'great': {'cp': 1500, 'name': 'Great League'}}, 'periods': [
            {'start': '2026-10-06', 'end': '2026-10-12', 'season': 28, 'formats': [{'id': 'great', 'cp': 1500}], 'source': 'schedule'}],
            'seasons': [{'season': 28, 'name': 'Twilight Trails', 'start': '2026-09-08', 'end': '2026-11-30'}]})
        for qid in (self.QID, 'claude-test:video123.mp4:0:opponent:ninetales:form', 'claude-test:video123.mp4:0:opponent:umbreon:fast',
                    'claude-test:video123.mp4:0:result'):
            self.write(self.work / 'validation/video123' / (qid + '.json'), {'qid': qid})
        self.catalog = ObservedCatalog(self.work, self.web)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def members(self, state):
        return {m['key']: m for m in state['occurrences'][0]['battle']['opponent']}

    def test_reasons_and_questions_per_member(self):
        s = self.catalog.state()
        m = self.members(s)
        self.assertEqual(m['azumarill']['why'], [])
        self.assertEqual(m['umbreon']['why'], [{'kind': 'shadow', 'p': .62, 'question': {'qid': self.QID, 'status': 'open'}}])
        self.assertEqual(m['umbreon']['fastQuestion']['status'], 'open')
        form = m['ninetales']['why'][0]
        self.assertEqual((form['kind'], form['p'], [a['id'] for a in form['alternatives']]), ('form', .91, ['ninetales_alolan', 'ninetales']))
        self.assertEqual(form['question']['qid'], 'claude-test:video123.mp4:0:opponent:ninetales:form')
        self.assertFalse(s['occurrences'][0]['complete']['opponent'])
        self.assertEqual(s['schedule']['seasons'][0]['name'], 'Twilight Trails')

    def test_model_resolution_and_human_answer_reclassify_on_next_poll(self):
        before = self.catalog.state()
        # A refit resolution (feedback.json resolutions, applied through model_answers) settles the Shadow status...
        self.write(self.work / 'feedback.json', {'resolutions': {
            self.QID: {'value': True, 'source': 'model'},
            'claude-test:video123.mp4:0:opponent:ninetales:form': {'value': 'ninetales_alolan', 'source': 'model'}}})
        after = self.catalog.state()
        self.assertNotEqual(before['revision'], after['revision'])
        m = self.members(after)
        self.assertTrue(m['umbreon']['shadow'])
        self.assertEqual((m['umbreon']['why'], m['ninetales']['why']), ([], []))
        self.assertFalse(any(x['uncertain'] for x in m.values()))
        self.assertTrue(after['occurrences'][0]['complete']['opponent'])
        # ...and a human answer overrides it (human feedback wins over inferred values).
        self.write(self.work / 'feedback.json', {'resolutions': {self.QID: {'value': True, 'source': 'model'}}, 'answers': {
            self.QID: {'kind': 'shadow', 'side': 'opponent', 'key': 'umbreon', 'battle': 0, 'recording': 'video123.mp4', 'value': False, 'source': 'reviewer'},
            'f': {'kind': 'form', 'side': 'opponent', 'key': 'ninetales', 'battle': 0, 'recording': 'video123.mp4', 'value': 'ninetales_alolan', 'source': 'reviewer'}}})
        m = self.members(self.catalog.state())
        self.assertIs(m['umbreon']['shadow'], False)
        self.assertEqual(m['ninetales']['id'], 'ninetales_alolan')
        self.assertTrue(self.catalog.state()['occurrences'][0]['complete']['opponent'])

    def test_api_since_short_circuit_then_reclassified_state(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
        import io
        from email.message import Message
        from types import SimpleNamespace
        import run_app

        class Handler(run_app.LocalHandler):
            def _json(self, status, value):
                self.response = (status, value)

        def get(path):
            h = Handler.__new__(Handler)
            h.path, h.server, h.headers = path, SimpleNamespace(server_port=8000), Message()
            h.headers['Host'] = 'localhost:8000'
            h.rfile, h.service, h.observed = io.BytesIO(b''), None, self.catalog
            h.do_GET()
            return h.response
        status, first = get('/api/observed-meta')
        self.assertEqual(status, 200)
        self.assertEqual(get('/api/observed-meta?since=' + first['revision']), (200, {'revision': first['revision'], 'unchanged': True}))
        self.write(self.work / 'feedback.json', {'resolutions': {self.QID: {'value': False, 'source': 'model'},
                                                                 'claude-test:video123.mp4:0:opponent:ninetales:form': {'value': 'ninetales_alolan', 'source': 'model'}}})
        status, second = get('/api/observed-meta?since=' + first['revision'])
        self.assertNotIn('unchanged', second)
        self.assertTrue(second['occurrences'][0]['complete']['opponent'])
        self.assertEqual(second['summary']['completeOpponentTeams'], 1)


class ScheduleCheckTests(unittest.TestCase):
    SCHEDULE = {'cups': {'retro': {'name': 'Retro Cup'}}, 'periods': [
        {'start': '2026-09-22', 'end': '2026-09-28', 'season': 28, 'formats': [{'id': 'retro', 'cp': 1500, 'name': 'Retro Cup'}, {'id': 'ultra', 'cp': 2500}]},
        {'start': '2026-09-29', 'end': '2026-10-05', 'season': 28, 'formats': [{'id': 'colormega', 'cp': 1500, 'name': 'Mega Color Cup'}]},
        {'start': '2026-10-13', 'end': '2026-10-19', 'season': 28, 'formats': [{'id': 'retro', 'cp': 1500}]}]}

    def period(self, cup, anchor, verified=False, cp=1500):
        return ObservedCatalog._period(cup, cp, anchor, self.SCHEDULE, verified)

    def test_statuses(self):
        conf = self.period('retro', '2026-09-24', True)
        self.assertEqual((conf['status'], conf['source'], conf['estimated']), ('text-confirmed', 'recording-date', False))
        est = self.period('retro', '2026-10-01')
        self.assertEqual((est['status'], est['start'], est['season'], est['uploadInPeriod'], est['estimated']),
                         ('text-confirmed', '2026-09-22', 28, False, True))
        self.assertEqual((self.period('retro', None)['status'], self.period('retro', None)['reason']), ('text-only', 'no-record'))
        champ = ObservedCatalog._period('retro', 1500, '2026-10-01', self.SCHEDULE, False, 'championship')
        self.assertEqual((champ['status'], champ['reason']), ('text-only', 'championship'))
        bad = self.period('color', '2026-10-02')
        self.assertTrue(bad['contradiction'])
        self.assertEqual((bad['status'], bad['reason']), ('text-only', 'disagrees'))
        self.assertEqual([x['id'] for x in bad['scheduled']], ['retro', 'colormega'])
        self.assertEqual((self.period('retro', '2027-05-01')['status'], self.period('retro', '2027-05-01')['reason']), ('text-only', 'no-record'))
        # No cup in the text: uncaptured, with what the schedule ran at the CP as a hint only.
        unc = self.period(None, '2026-10-02')
        self.assertEqual((unc['status'], unc['reason'], unc['start']), ('uncaptured', 'no-cup-named', None))
        self.assertEqual([x['id'] for x in unc['scheduled']], ['retro', 'colormega'])
        self.assertEqual(ObservedCatalog._period(None, None, '2026-10-02', self.SCHEDULE, False, 'no-league')['scheduled'], [])
        # The upload-lag window holds two Retro periods: the same cup, so estimated (repeat cup) with both listed.
        self.SCHEDULE['periods'].append({'start': '2026-10-06', 'end': '2026-10-12', 'formats': [{'id': 'retro', 'cp': 1500}]})
        try:
            rep = self.period('retro', '2026-10-08')
            self.assertEqual((rep['status'], rep['repeat'], len(rep['periods']), rep['start'], rep['end'], rep['uploadInPeriod']),
                             ('text-confirmed', True, 2, '2026-09-22', '2026-10-12', True))
            self.assertNotIn('reason', rep)
            # A repeat of a DIFFERENT cup in the same window does not join it: colormega ran once, retro twice.
            one = self.period('colormega', '2026-10-04')
            self.assertEqual((one['status'], one.get('repeat')), ('text-confirmed', None))
            # A verified date inside one of the two periods is confirmed to that period alone.
            conf = self.period('retro', '2026-10-08', True)
            self.assertEqual((conf['status'], conf['start'], conf.get('repeat'), conf['source']), ('text-confirmed', '2026-10-06', None, 'recording-date'))
        finally:
            self.SCHEDULE['periods'].pop()


class PvPokeTests(unittest.TestCase):
    def test_expected_presence_from_open_league_weights(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp)
            data = web / 'includes/pro/data'
            data.mkdir(parents=True)
            (data / 'gamemaster.json').write_text(json.dumps({'pokemon': [{'speciesId': s, 'dex': d} for s, d in
                                                                         (('a', 1), ('a_shadow', 1), ('b', 2), ('c', 3), ('d', 4), ('z', 5))]}))
            (data / 'league-1500.json').write_text(json.dumps({'overall': [{'speciesId': s} for s in ('a', 'a_shadow', 'b', 'c', 'd', 'z')]}))
            (data / 'overrides-1500.json').write_text(json.dumps([{'speciesId': 'a', 'weight': 10}, {'speciesId': 'z', 'weight': 0}]))
            out = ObservedCatalog(web / 'work', web).pvpoke()
            self.assertEqual(list(out), ['1500'])
            sp = out['1500']['species']
            self.assertNotIn('z', sp)        # weight 0 is not in the pool
            self.assertEqual(sp['a']['weight'], 10)
            self.assertGreater(sp['a']['presence'], sp['b']['presence'])
            # a and a_shadow share a Pokedex number, so at most one is in a team; the four dex numbers fill 3 slots.
            self.assertAlmostEqual(sum(v['presence'] for v in sp.values()), 3, places=6)
