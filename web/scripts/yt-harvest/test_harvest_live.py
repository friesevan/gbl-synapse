"""Live harvester status and YouTube sign-in (service.py status/health/parse_log, youtube_auth.py, Harvester.auth).
Offline: no process is started and YouTube is never contacted."""
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import service as S
import youtube_auth as A

BOT = 'ERROR: [youtube] aMwT2nTcVOg: Sign in to confirm you’re not a bot. Use --cookies'


class Detection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name) / 'work'
        self.work.mkdir()
        self.rows = []
        self.service = S.HarvestService(self.work, Path(self.tmp.name) / 'web', processes=lambda: self.rows,
                                        dependency_probe=lambda: {'ready': True, 'missing': [], 'python': '/bin/false'})

    def tearDown(self):
        self.tmp.cleanup()

    def test_run_started_from_a_terminal_with_a_relative_script_path_is_live(self):
        command = 'python3 -I scripts/yt-harvest/harvest.py overnight --work-dir %s --hours 48 --extract-jobs 12 --downloads-per-min 1 --focus-cup little --focus-since 2026-10-13' % self.work
        self.rows.append({'pid': 78217, 'identity': 'Sat Oct 17 13:20:47 2026', 'command': command})
        self.assertFalse(S.is_harvester(self.rows[0], self.work, self.service.script), 'the command line alone does not match')
        started = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat()
        S.atomic_json(self.work / 'run.json', {'pid': 78217, 'identity': 'Sat Oct 17 13:20:47 2026', 'phase': 'running', 'startedAt': started})
        h = self.service.status()['harvest']
        self.assertTrue(h['running'])
        self.assertEqual(h['phase'], 'running')
        run = h['run']
        self.assertEqual((run['origin'], run['hours'], run['extractJobs'], run['focusCup'], run['focusSince']), ('command line', 48.0, 12, 'little', '2026-10-13'))
        self.assertGreater(dt.datetime.fromisoformat(run['deadline']), dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=46))
        self.service.stop()
        self.assertTrue((self.work / 'STOP').exists(), 'Stop safely reaches a terminal-started run')

    def test_a_recycled_pid_with_another_identity_is_not_live(self):
        self.rows.append({'pid': 9, 'identity': 'new', 'command': 'python3 scripts/yt-harvest/harvest.py overnight'})
        S.atomic_json(self.work / 'run.json', {'pid': 9, 'identity': 'old', 'phase': 'running'})
        self.assertFalse(self.service.status()['harvest']['running'])

    def test_harvester_report_wins_over_the_log(self):
        self.rows.append({'pid': 5, 'identity': 'x', 'command': 'python3 scripts/yt-harvest/harvest.py overnight'})
        S.atomic_json(self.work / 'run.json', {'pid': 5, 'identity': 'x', 'phase': 'running', 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat()})
        S.atomic_json(self.work / 'summary.json', {'updated': dt.datetime.now().isoformat(timespec='seconds'), 'run': {'pid': 5, 'hours': 2, 'deadline': '2030-01-01T00:00:00'},
                                                   'youtube': {'blocks': 0, 'pausedUntil': None, 'lastDownload': {'at': dt.datetime.now().isoformat(), 'id': 'abcdefghijk'}}})
        h = self.service.status()['harvest']
        self.assertTrue(h['run']['reportsLive'])
        self.assertTrue(h['youtube']['signInApplies'])
        self.assertEqual(h['health']['level'], 'ok')


class LogAndHealth(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 17, 14, 30, 0)
    LINES = ['10-17 13:20:50 MainThread start: deadline 13:20',
             '10-17 13:40:00 dl0 downloaded abcdefghijk (120 MB in 30 s, 4.0 MB/s)',
             '10-17 14:22:37 dl1 rate limited (download aMwT2nTcVOg: %s); all workers pause 3468 s; metadata now 3/min, downloads 0.5/min' % BOT]

    def test_parse_log(self):
        y = S.parse_log(self.LINES, now=self.NOW)
        self.assertEqual((y['blocks'], y['botChecks'], y['lastBlock']['kind'], y['lastBlock']['what']), (1, 1, 'bot-check', 'download aMwT2nTcVOg'))
        self.assertEqual(y['pausedUntil'], '2026-10-17T15:20:25')
        self.assertEqual(y['lastDownload']['id'], 'abcdefghijk')
        self.assertEqual(y['downloadsLastHour'], {'success': 1, 'block': 1})
        later = S.parse_log(self.LINES, since='2026-10-17T18:00:00+00:00', now=self.NOW)  # 14:00 EDT
        self.assertIsNone(later['lastDownload'], 'lines before the run started are ignored')

    def health(self, youtube, running=True, signed=False):
        now = dt.datetime(2026, 10, 17, 14, 30).astimezone()
        youtube = {**youtube, 'config': {'mode': 'browser', 'browser': 'chrome', 'label': 'Signed in through Google Chrome'} if signed else {'mode': 'none'}}
        return S.health('running' if running else 'stopped', running, youtube, {'updated': now.isoformat()}, {}, now=now)

    def test_bot_check_pause_asks_for_sign_in(self):
        block = {'at': '2026-10-17T14:22:37', 'kind': 'bot-check', 'what': 'download x'}
        h = self.health({'lastBlock': block, 'pausedUntil': '2026-10-17T15:20:25', 'pauseLeftSeconds': 3000, 'botChecks': 6, 'blocks': 6})
        self.assertEqual((h['level'], h['action']), ('blocked', 'signin'))
        self.assertIn('not a bot', h['message'])
        self.assertIn('6 times', h['message'])
        old = self.health({'lastBlock': block, 'pausedUntil': '2026-10-17T15:20:25', 'pauseLeftSeconds': 3000, 'botChecks': 1, 'signInApplies': False}, signed=True)
        self.assertIn('stop it and start it again', old['message'], 'a sign-in saved for an older running harvester needs a restart')
        rate = self.health({'lastBlock': {**block, 'kind': 'rate-limit'}, 'pausedUntil': '2026-10-17T15:00:00', 'pauseLeftSeconds': 1800, 'blocks': 1})
        self.assertEqual((rate['level'], rate['action']), ('warn', None))
        idle = self.health({'lastBlock': block}, running=False)
        self.assertEqual((idle['level'], idle['action']), ('warn', 'signin'))
        self.assertEqual(self.health({'lastDownload': {'at': '2026-10-17T14:29:00'}})['level'], 'ok')

    def test_stalled_report(self):
        now = dt.datetime(2026, 10, 17, 14, 30).astimezone()
        h = S.health('running', True, {'config': {}}, {'updated': (now - dt.timedelta(minutes=12)).isoformat()}, {}, now=now)
        self.assertEqual(h['level'], 'warn')
        self.assertIn('12 minutes', h['message'])


class SignIn(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_config_round_trip_and_validation(self):
        self.assertEqual(A.load(self.work), {'mode': 'none'})
        profile = self.work / 'Profile 1'
        profile.mkdir()
        saved = A.save(self.work, {'mode': 'browser', 'browser': 'chrome', 'profile': str(profile), 'cookies': 'never stored'})
        self.assertNotIn('cookies', saved)
        self.assertEqual(A.ydl_options(A.load(self.work)), {'cookiesfrombrowser': ('chrome', str(profile), None, None)})
        cookies = self.work / 'c.txt'
        cookies.write_text('# Netscape HTTP Cookie File\n')
        self.assertEqual(A.ydl_options(A.save(self.work, {'mode': 'file', 'cookieFile': str(cookies)})), {'cookiefile': str(cookies)})
        for bad in [{'mode': 'browser', 'browser': 'netscape'}, {'mode': 'browser', 'browser': 'chrome', 'profile': '/no/such'},
                    {'mode': 'file', 'cookieFile': '/no/such.txt'}, {'mode': 'other'}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                A.save(self.work, bad)
        self.assertEqual(A.ydl_options(A.save(self.work, {'mode': 'none'})), {})

    def test_block_kinds(self):
        self.assertEqual(A.block_kind(BOT), 'bot-check')
        self.assertEqual(A.block_kind('HTTP Error 429: Too Many Requests'), 'rate-limit')
        self.assertTrue(A.is_cookie_error('could not find chrome cookies database in "/x"'))
        self.assertFalse(A.is_cookie_error(BOT))

    def test_running_harvester_picks_up_a_new_sign_in_and_ends_its_pause(self):
        import harvest as H
        h = H.Harvester.__new__(H.Harvester)
        h.a = SimpleNamespace(work_dir=str(self.work))
        h.backoff, h.meta_rate, h.dl_rate = H.Backoff(), H.Limiter(20), H.Limiter(3, floor=.5)
        h.yt_lock, h.yt = __import__('threading').Lock(), {'authError': {'at': 0, 'message': 'x'}}
        h._auth_stamp, h._auth = A.stamp(self.work), A.load(self.work)
        h.backoff.hit()
        h.meta_rate.slow_down()
        self.assertGreater(h.backoff.until, time.time())
        self.assertEqual(h.auth(), {'mode': 'none'}, 'unchanged file: the pause stays')
        self.assertGreater(h.backoff.until, time.time())
        cookies = self.work / 'c.txt'
        cookies.write_text('# Netscape HTTP Cookie File\n')
        A.save(self.work, {'mode': 'file', 'cookieFile': str(cookies)})
        self.assertEqual(h.auth()['mode'], 'file')
        self.assertLessEqual(h.backoff.until, time.time())
        self.assertEqual(h.meta_rate.rate, 20)
        self.assertIsNone(h.yt['authError'])


if __name__ == '__main__':
    unittest.main()
