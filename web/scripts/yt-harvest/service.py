"""Local, dependency-free lifecycle and progress API for the resumable harvester."""
import contextlib
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import threading
import time

import reanalysis_queue
import youtube_auth

HERE = Path(__file__).resolve().parent
DEFAULT_WORK = Path.home() / 'Desktop/Projects/PoGo Recorder/src/yt-harvest'


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.%s.tmp' % os.getpid())
    tmp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with Path(path).open(encoding='utf-8') as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return default


@contextlib.contextmanager
def file_lock(path, blocking=True):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        try:
            yield stream
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def process_table():
    """PID + OS start identity prevent a recycled PID from being mistaken for our worker."""
    result = subprocess.run(['ps', '-axo', 'pid=,lstart=,command='], capture_output=True, text=True,
                            timeout=3, check=True)
    rows = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 6)
        if len(parts) == 7 and parts[0].isdigit():
            rows.append({'pid': int(parts[0]), 'identity': ' '.join(parts[1:6]), 'command': parts[6]})
    return rows


def is_harvester(row, work_dir, script=HERE / 'harvest.py'):
    command = row.get('command', '')
    if 'harvest.py' not in command:  # cheap reject before resolving paths (ps lists hundreds of processes)
        return False
    if re.match(r'^\S*caffeinate(?:\s|$)', command):
        return False
    script = str(Path(script).resolve())
    # ps prints arguments without shell quoting, including spaces in both project and work paths.
    match = re.search(r'(?:^|\s|[\"\'])' + re.escape(script) + r'(?:[\"\']?)(?=\s|$)', command)
    if not match:
        return False
    prefix = command[:match.start()].strip()
    # Only Python interpreters run our lifecycle, never a shell echo or editor command mentioning it.
    if not re.search(r'(?:^|/|\s)python(?:\d+(?:\.\d+)*)?(?:\s|$)', prefix):
        return False
    rest = command[match.end():].strip()
    if rest and not (rest == 'overnight' or rest.startswith('overnight ') or rest.startswith('--')):
        return False
    configured = DEFAULT_WORK
    work_match = re.search(r'(?:^|\s)--work-dir(?:=|\s+)(.+?)(?=\s+--[\w-]+(?:=|\s|$)|$)', rest)
    if work_match:
        configured = Path(work_match.group(1).strip().strip('\"\''))
    return configured.expanduser().resolve() == Path(work_dir).resolve()


LOG_TIME = re.compile(r'^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) ')
BLOCK_LINE = re.compile(r'rate limited \((?P<what>[^:]+?(?: [A-Za-z0-9_-]{11})?): (?P<message>.*)\); all workers pause (?P<pause>\d+) s')
DOWNLOAD_LINE = re.compile(r' downloaded (?P<id>[A-Za-z0-9_-]{11}) \((?P<mb>\d+) MB')


def _log_time(line, now):
    m = LOG_TIME.match(line)
    if not m:
        return None
    month, day, hour, minute, second = map(int, m.groups())
    try:
        t = dt.datetime(now.year, month, day, hour, minute, second)
    except ValueError:
        return None
    return t.replace(year=now.year - 1) if t > now + dt.timedelta(days=1) else t


def parse_log(lines, since=None, now=None):
    """YouTube access read from harvest.log lines (for harvesters that do not report it themselves)."""
    now = now or dt.datetime.now()
    start = dt.datetime.fromisoformat(since).astimezone().replace(tzinfo=None) if since else None
    out = {'lastBlock': None, 'blocks': 0, 'botChecks': 0, 'lastDownload': None, 'lastSuccess': None, 'pausedUntil': None,
           'pauseLeftSeconds': 0, 'downloadsLastHour': {}}
    for line in lines:
        at = _log_time(line, now)
        if not at or (start and at < start):
            continue
        block = BLOCK_LINE.search(line)
        if block:
            kind = youtube_auth.block_kind(block['message'])
            out['blocks'] += 1
            out['botChecks'] += kind == 'bot-check'
            until = at + dt.timedelta(seconds=int(block['pause']))
            out['lastBlock'] = {'at': at.isoformat(), 'kind': kind, 'what': block['what'], 'message': block['message'][:300],
                                'pauseSeconds': int(block['pause'])}
            out['pausedUntil'] = until.isoformat() if until > now else None
            out['pauseLeftSeconds'] = max(0, round((until - now).total_seconds()))
            if now - at < dt.timedelta(hours=1):
                out['downloadsLastHour']['block'] = out['downloadsLastHour'].get('block', 0) + block['what'].startswith('download')
            continue
        done = DOWNLOAD_LINE.search(line)
        if done:
            out['lastDownload'] = {'at': at.isoformat(), 'id': done['id'], 'mb': int(done['mb'])}
            out['lastSuccess'] = {'at': at.isoformat(), 'what': 'download ' + done['id']}
            if now - at < dt.timedelta(hours=1):
                out['downloadsLastHour']['success'] = out['downloadsLastHour'].get('success', 0) + 1
    return out


def health(phase, running, youtube, summary, run, now=None):
    """One headline for the panel: level ok | warn | blocked | idle, a message, and an action ('signin' or None)."""
    now = now or dt.datetime.now().astimezone()
    parse = lambda t: dt.datetime.fromisoformat(t).astimezone() if t else None  # noqa: E731
    block, config = youtube.get('lastBlock') or {}, youtube.get('config') or {}
    signed = config.get('mode', 'none') != 'none'
    clock = lambda t: parse(t).strftime('%-I:%M %p') if t else ''  # noqa: E731
    if not running:
        recent = block and block.get('kind') == 'bot-check' and parse(block['at']) and now - parse(block['at']) < dt.timedelta(hours=12)
        if recent and not signed:
            return {'level': 'warn', 'action': 'signin', 'message': 'The last run was blocked by YouTube’s bot check at ' + clock(block['at']) +
                    '. Sign in to YouTube before the next run so downloads succeed.'}
        return {'level': 'idle', 'action': None, 'message': 'Not running.' if phase != 'interrupted' else 'The last run ended without a clean stop.'}
    updated = parse(summary.get('updated')) if summary.get('updated') else None
    if updated and now - updated > dt.timedelta(minutes=5):
        return {'level': 'warn', 'action': None, 'message': 'No progress report for %d minutes; the harvester may be stuck or busy.' % ((now - updated).total_seconds() // 60)}
    if youtube.get('authError'):
        return {'level': 'warn', 'action': 'signin', 'message': 'The YouTube sign-in could not be read (' + youtube['authError']['message'][:140] +
                '). The harvester continues without it.'}
    if youtube.get('pausedUntil'):
        minutes = max(1, round(youtube.get('pauseLeftSeconds', 0) / 60))
        times = ' (%d time%s this run)' % (youtube.get('botChecks') or youtube.get('blocks'), '' if (youtube.get('botChecks') or youtube.get('blocks')) == 1 else 's')
        if block.get('kind') == 'bot-check':
            if signed and not youtube.get('signInApplies'):
                fix = ' Your sign-in is saved, but this harvester started before sign-in support: stop it and start it again to use it.'
            elif signed:
                fix = ' YouTube still asks with your sign-in: test it below, or try another browser profile or account.'
            else:
                fix = ' Sign in to YouTube to let downloads through.'
            return {'level': 'blocked', 'action': 'signin', 'message': 'YouTube is blocking downloads: “Sign in to confirm you’re not a bot”' + times +
                    '. All YouTube requests are paused until ' + clock(youtube['pausedUntil']) + ' (%d min).' % minutes + fix}
        return {'level': 'warn', 'action': None, 'message': 'YouTube rate limit' + times + ': requests are paused until ' + clock(youtube['pausedUntil']) +
                ' (%d min) and slowed down afterwards.' % minutes}
    hour = youtube.get('downloadsLastHour') or {}
    last = youtube.get('lastDownload')
    if hour.get('block') and not hour.get('success'):
        return {'level': 'warn', 'action': 'signin' if not signed else None, 'message': 'Downloads were blocked %d time%s in the last hour and none succeeded.' % (hour['block'], '' if hour['block'] == 1 else 's')}
    return {'level': 'ok', 'action': None, 'message': 'Running.' + (' Last download ' + clock(last['at']) + '.' if last else '') +
            (' ' + config.get('label', '') + '.' if signed else '')}



class Lifecycle:
    """Held by all new CLI/UI runs for their entire lifetime, including graceful draining."""
    def __init__(self, work_dir):
        self.work_dir = Path(work_dir)
        self.lock = None
        self.record = None

    def __enter__(self):
        self.lock = file_lock(self.work_dir / 'harvest.lock', blocking=False)
        try:
            self.lock.__enter__()
        except BlockingIOError:
            raise RuntimeError('A harvester is already using this work directory.')
        rows = process_table()
        current = next((r for r in rows if r['pid'] == os.getpid()), None)
        if not current:
            self.lock.__exit__(None, None, None)
            raise RuntimeError('Unable to verify harvester process identity.')
        if any(r['pid'] != os.getpid() and is_harvester(r, self.work_dir) for r in rows):
            self.lock.__exit__(None, None, None)
            raise RuntimeError('An existing CLI harvester is already using this work directory.')
        self.record = {**current, 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                       'phase': 'running', 'managed': True, 'workDir': str(self.work_dir)}
        atomic_json(self.work_dir / 'run.json', self.record)
        return self

    def __exit__(self, error_type, error, traceback):
        self.record.update(phase='failed' if error else 'stopped', endedAt=dt.datetime.now(dt.timezone.utc).isoformat())
        if error:
            self.record['error'] = str(error)[:500]
        atomic_json(self.work_dir / 'run.json', self.record)
        self.lock.__exit__(error_type, error, traceback)


class HarvestService:
    def __init__(self, work_dir=None, web_root=None, popen=None, processes=None, dependency_probe=None):
        self.work_dir = Path(work_dir or os.environ.get('YT_HARVEST_WORK', DEFAULT_WORK)).expanduser().resolve()
        self.web_root = Path(web_root or HERE.parent.parent).resolve()
        self.script = self.web_root / 'scripts/yt-harvest/harvest.py'
        self.popen = popen or subprocess.Popen
        self.processes = processes or process_table
        self.dependency_probe = dependency_probe or self.dependencies
        self.lock = threading.RLock()
        self.children = []
        self._feedback = None
        self._deps_cache = None
        self._question_cache = None

    def _runs(self, rows=None):
        """Live harvesters on this work directory: matched by command line, or by the identity a harvester records in
        run.json (Lifecycle), which also covers runs started with a relative script path from a terminal or script."""
        rows = self.processes() if rows is None else rows
        record = read_json(self.work_dir / 'run.json', {})
        return [row for row in rows if is_harvester(row, self.work_dir, self.script) or (
            record.get('phase') in ('running', 'stopping') and row['pid'] == record.get('pid') and row['identity'] == record.get('identity')
            and 'harvest.py' in row['command'] and not re.match(r'^\S*caffeinate(?:\s|$)', row['command']))]

    def _pending(self):
        launch = read_json(self.work_dir / 'launch.json', {})
        # A launcher identity, not merely its PID, must match before it blocks another start.
        return next((row for row in self.processes() if row['pid'] == launch.get('pid')
                     and row['identity'] == launch.get('identity')
                     and str(self.script) in row['command']), None)

    def dependencies(self):
        if self._deps_cache and time.monotonic() - self._deps_cache[0] < 30:
            return self._deps_cache[1]
        python = Path(os.environ.get('YT_HARVEST_VENV', str(Path.home() / '.cache/gbl-synapse/venv'))) / 'bin/python'
        missing = []
        if not python.is_file():
            missing.append('Existing harvester virtual environment (YT_HARVEST_VENV)')
        else:
            try:
                probe = subprocess.run([str(python), '-I', '-c', 'import yt_dlp'], capture_output=True, timeout=10)
                if probe.returncode:
                    missing.append('yt-dlp in the existing harvester environment')
            except (OSError, subprocess.TimeoutExpired):
                missing.append('Readable harvester Python environment')
        tool_path = '/opt/homebrew/bin:' + os.environ.get('PATH', '')
        for name in ('node', 'ffmpeg', 'ffprobe', 'tesseract'):
            if not shutil.which(name, path=tool_path):
                missing.append(name)
        result = {'ready': not missing, 'missing': missing, 'python': str(python),
                  'message': 'Use the documented overnight.sh setup in a terminal to install missing dependencies.' if missing else ''}
        self._deps_cache = (time.monotonic(), result)
        return result

    def status(self):
        with self.lock:
            self.children[:] = [child for child in self.children if child.poll() is None]
            record = read_json(self.work_dir / 'run.json', {})
            try:
                rows = self.processes()
                runs = self._runs(rows)
                process_error = None
            except (OSError, subprocess.SubprocessError) as ex:
                rows, runs, process_error = [], [], 'Unable to inspect running processes: ' + str(ex)[:200]
            live = runs[0] if runs else None
            pending = self._pending() if not process_error and not live else None
            managed = bool(live and live['pid'] == record.get('pid') and live['identity'] == record.get('identity'))
            stopped = (self.work_dir / 'STOP').exists()
            phase = 'stopping' if live and stopped else 'running' if live else record.get('phase', 'idle')
            if not live and phase in ('running', 'starting', 'stopping'):
                phase = 'interrupted'
            if pending:
                phase = 'stopping' if stopped else 'starting'
            summary = read_json(self.work_dir / 'summary.json', {})
            stages, active, errors = self._database_status()
            launch = read_json(self.work_dir / 'launch.json', {})
            counts = {'discovered': stages.get('discovered', 0),
                      'downloaded': stages.get('download', {}).get('done', 0),
                      'extracted': stages.get('extraction', {}).get('done', 0)}
            inbox = self.web_root / 'tests/meta-benchmark/results/validation-inbox.json'
            try:
                stamp = inbox.stat().st_mtime_ns
            except OSError:
                stamp = None
            if self._question_cache is None or self._question_cache[0] != stamp:
                questions = (read_json(inbox, {}) or {}).get('questions', []) if stamp else []
                self._question_cache = (stamp, len(questions))
            counts['questions'] = max((summary.get('total') or {}).get('questions', 0), self._question_cache[1])
            log_lines = self._tail_file(self.work_dir / 'harvest.log', 400000, 4000)
            run = self._run_info(live, record, summary, launch, rows)
            youtube = self._youtube(summary, live, run, log_lines)
            for e in errors:
                if e.get('error'):
                    e['kind'] = ('unavailable' if re.match(r'unavailable', e['error']) else 'bot-check' if youtube_auth.BOT_CHECK_RE.search(e['error'])
                                 else 'rate-limit' if re.search(r'ratelimit|429', e['error']) else 'other')
            return {'available': True, 'harvest': {
                'running': bool(live or pending), 'phase': phase, 'status': phase,
                'pid': (live or pending or {}).get('pid'), 'counts': counts, 'jobs': active,
                'hours': launch.get('hours'), 'workers': launch.get('workers'),
                'managed': managed, 'stopRequested': bool((live or pending) and stopped), 'workDir': str(self.work_dir),
                'startedAt': record.get('startedAt') if managed else (live or {}).get('identity'),
                'endedAt': record.get('endedAt') if not live else None,
                'summary': summary, 'stages': stages, 'activeJobs': active, 'errors': errors,
                'log': self._tail(), 'dependencies': self.dependency_probe(),
                'error': process_error or record.get('error') if not live else process_error,
                'duplicateProcesses': len(runs) > 1,
                'run': run, 'youtube': youtube, 'health': health(phase, bool(live or pending), youtube, summary, run),
                'tornado': self._tornado(rows), 'thisRun': summary.get('thisRun') if live else None}}

    def _database_status(self):
        # Full-table counts take over a second on a large harvest; the panel polls every 4 s, so reuse them for 10 s.
        cached = getattr(self, '_db_cache', None)
        if cached and time.monotonic() - cached[0] < 10:
            return cached[1]
        result = self._database_query()
        self._db_cache = (time.monotonic(), result)
        return result

    def _database_query(self):
        path = self.work_dir / 'state.sqlite'
        if not path.exists():
            return {}, [], []
        try:
            with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=.3) as db:
                db.row_factory = sqlite3.Row
                stages = {'discovered': db.execute('SELECT count(*) FROM videos').fetchone()[0]}
                for key, column in (('metadata', 'meta_status'), ('download', 'dl_status'), ('extraction', 'x_status')):
                    stages[key] = {str(row[0] or 'queued'): row[1] for row in db.execute(
                        'SELECT %s, count(*) FROM videos GROUP BY %s' % (column, column))}
                active = [dict(row) for row in db.execute("SELECT id,title,meta_status,dl_status,x_status FROM videos WHERE meta_status='working' OR dl_status='working' OR x_status='working' LIMIT 32")]
                errors = [dict(row) for row in db.execute("SELECT id,title,substr(err,1,500) error FROM videos WHERE err IS NOT NULL ORDER BY updated DESC LIMIT 10")]
                return stages, active, errors
        except sqlite3.Error as ex:
            return {}, [], [{'error': 'Progress database busy/unavailable: ' + str(ex)[:100]}]

    def _tail(self):
        return self._tail_file(self.work_dir / 'harvest.log', 40000, 120)

    @staticmethod
    def _tail_file(path, size=12000, lines=35):
        try:
            with Path(path).open('rb') as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - size))
                return stream.read().decode('utf-8', 'replace').splitlines()[-lines:]
        except OSError:
            return []

    def _run_info(self, live, record, summary, launch, rows):
        """How the live run was started and with what settings: the harvester's own report (summary.json 'run'),
        else its command line, so runs started from a terminal or a script show the same details."""
        if not live:
            return None
        own = summary.get('run') if summary.get('run', {}).get('pid') == live['pid'] else None
        command = live['command']
        arg = lambda name: (re.search(r'(?:^|\s)--' + name + r'(?:=|\s+)(\S+)', command) or [None, None])[1]  # noqa: E731
        hours = float(arg('hours') or 9)
        started = record.get('startedAt') if record.get('pid') == live['pid'] else None
        launched = launch.get('pid') and any(r['pid'] == launch.get('pid') and r['identity'] == launch.get('identity') for r in rows)
        info = own or {'pid': live['pid'], 'startedAt': started, 'hours': hours, 'extractJobs': int(arg('extract-jobs') or 0) or None,
                       'downloadsPerMinCap': float(arg('downloads-per-min') or 3), 'maxBacklogHours': float(arg('max-backlog-hours') or 2),
                       'focusCup': arg('focus-cup'), 'focusSince': arg('focus-since'), 'focusOnly': '--focus-only' in command,
                       'extract': '--no-extract' not in command}
        if not info.get('deadline') and started:
            info['deadline'] = (dt.datetime.fromisoformat(started) + dt.timedelta(hours=hours)).astimezone().isoformat(timespec='seconds')
        return {**info, 'origin': 'app' if launched else 'command line', 'command': command[:600], 'reportsLive': bool(own)}

    def _youtube(self, summary, live, run, log_lines):
        """YouTube access: the harvester's live report when it has one (this version), else read from its log, so an
        older harvester that is still running is covered too."""
        auth = youtube_auth.load(self.work_dir)
        own = summary.get('youtube') if live and run and run.get('reportsLive') else None
        if own:
            out = dict(own)
        else:
            out = parse_log(log_lines, run.get('startedAt') if run else None)
            out['source'] = 'log'
        out['config'] = {**auth, 'label': youtube_auth.label(auth)}
        # The sign-in applies to a running harvester only when it reads the setting (this version, live report).
        out['signInApplies'] = bool(own) or not live
        return out

    def _tornado(self, rows):
        usage = read_json(self.work_dir / 'tornado-usage.json')
        if not usage:
            return None
        log_lines = [line for line in self._tail_file(self.work_dir / 'tornado.log', 4000, 20) if line.strip()]
        return {'usedGB': round((usage.get('bytes') or 0) / 1e9, 2), 'capGB': round((usage.get('capBytes') or 0) / 1e9),
                'videos': len([k for k in (usage.get('videos') or {}) if '(' not in k]),
                'running': any(re.search(r'tornado_fetch\.py|tornado-loop\.sh', r['command']) for r in rows),
                'last': log_lines[-1][:200] if log_lines else ''}

    def auth_state(self):
        config = youtube_auth.load(self.work_dir)
        browsers = youtube_auth.browsers()
        return {'config': {**config, 'label': youtube_auth.label(config, browsers)}, 'browsers': browsers}

    def save_auth(self, body):
        config = youtube_auth.save(self.work_dir, body)
        return {**self.auth_state(), 'saved': config}

    def test_auth(self, body):
        """Resolve a video's formats with the given sign-in in the harvester's own Python (nothing is downloaded).
        Waits up to 2 minutes: macOS may first ask for keychain access to the browser's cookies."""
        config = youtube_auth.normalize(body.get('config') or body)
        video = body.get('video') if isinstance(body.get('video'), str) and re.fullmatch(r'[A-Za-z0-9_-]{11}', body.get('video')) else None
        if not video:
            blocked = (self.status()['harvest'].get('youtube') or {}).get('lastBlock') or {}
            match = re.search(r'([A-Za-z0-9_-]{11})', blocked.get('what') or '')
            video = match.group(1) if match else 'jNQXAC9IVRw'
        python = self.dependency_probe().get('python')
        try:
            result = subprocess.run([python, '-I', str(HERE / 'youtube_auth.py'), 'test', '--config', json.dumps(config), '--video', video],
                                    capture_output=True, text=True, timeout=120)
            out = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {
                'ok': False, 'kind': 'error', 'message': (result.stderr.strip().splitlines() or ['The test did not run.'])[-1][:300]}
        except subprocess.TimeoutExpired:
            out = {'ok': False, 'kind': 'timeout', 'message': 'No answer within 2 minutes. If macOS asked for keychain access, allow it and test again.'}
        except (OSError, ValueError) as ex:
            out = {'ok': False, 'kind': 'error', 'message': str(ex)[:300]}
        return {**out, 'video': video, 'config': {**config, 'label': youtube_auth.label(config)}}

    def start(self, body):
        hours = body.get('hours', 9)
        workers = body.get('workers', max(1, min(8, (os.cpu_count() or 4) * 2 // 3)))
        if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not math.isfinite(hours) or not .05 <= hours <= 48:
            raise ValueError('hours must be between 0.05 and 48.')
        if isinstance(workers, bool) or not isinstance(workers, int) or not 1 <= workers <= min(16, os.cpu_count() or 4):
            raise ValueError('workers must be an integer between 1 and %s.' % min(16, os.cpu_count() or 4))
        with self.lock, file_lock(self.work_dir / 'start.lock'):
            if self._runs() or self._pending() or any(child.poll() is None for child in self.children):
                return self.status()
            deps = self.dependency_probe()
            if not deps['ready']:
                raise RuntimeError('Cannot start: ' + ', '.join(deps['missing']) + '. ' + deps.get('message', ''))
            # Lock check covers a CLI still initializing or draining before ps registration.
            try:
                with file_lock(self.work_dir / 'harvest.lock', blocking=False):
                    pass
            except BlockingIOError:
                raise RuntimeError('A harvester is already starting or draining this work directory.')
            (self.work_dir / 'STOP').unlink(missing_ok=True)
            env = dict(os.environ, PATH='/opt/homebrew/bin:' + os.environ.get('PATH', ''), YT_HARVEST_WORK=str(self.work_dir), YT_HARVEST_QUIET='1')
            command = [deps['python'], '-I', str(self.script), 'overnight', '--work-dir', str(self.work_dir),
                       '--hours', str(hours), '--extract-jobs', str(workers), '--respect-stop']
            caffeinate = shutil.which('caffeinate')
            if caffeinate:
                command = [caffeinate, '-i'] + command
            with (self.work_dir / 'launcher.log').open('ab') as stream:
                child = self.popen(command, cwd=str(self.web_root), env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            self.children.append(child)
            # Harvester writes its own verified record; launcher record is distinct to avoid overwrites.
            current = next((row for row in self.processes() if row['pid'] == child.pid), {})
            atomic_json(self.work_dir / 'launch.json', {'pid': child.pid, 'identity': current.get('identity'),
                        'hours': hours, 'workers': workers, 'startedAt': time.time()})
            result = self.status()
            exit_code = child.poll()
            if exit_code is not None and exit_code != 0:
                launcher_log = self._tail_file(self.work_dir / 'launcher.log')
                raise RuntimeError('Harvester failed to start: ' + (launcher_log[-1] if launcher_log else 'exit %s' % exit_code))
            if not result['harvest']['running'] and exit_code is None:
                result['harvest'].update(running=True, phase='starting', pid=child.pid)
            return result

    def stop(self):
        with self.lock, file_lock(self.work_dir / 'start.lock'):
            if self._runs() or self._pending():
                (self.work_dir / 'STOP').touch()
            return self.status()

    # ---- Re-analysis (reanalyze.py, its own process; Meta Extractor › Analyze & review › Re-analysis)
    def _reanalyzer(self, rows):
        record = read_json(self.work_dir / 'reanalyze-run.json', {})
        live = next((r for r in rows if r['pid'] == record.get('pid') and r['identity'] == record.get('identity')
                     and 'reanalyze.py' in r['command'] and not re.match(r'^\S*caffeinate(?:\s|$)', r['command'])), None) \
            if record.get('phase') == 'running' else None
        launch = read_json(self.work_dir / 'reanalyze-launch.json', {})
        pending = None if live else next((r for r in rows if r['pid'] == launch.get('pid') and r['identity'] == launch.get('identity')
                                          and 'reanalyze.py' in r['command']), None)
        return live, pending, record

    def reanalyze_status(self):
        try:
            rows = self.processes()
        except (OSError, subprocess.SubprocessError):
            rows = []
        live, pending, record = self._reanalyzer(rows)
        stop, abort = (self.work_dir / 'reanalyze.STOP').exists(), (self.work_dir / 'reanalyze.ABORT').exists()
        phase = ('stopping' if stop else 'running') if live else 'starting' if pending else record.get('phase') or 'idle'
        if not live and not pending and phase == 'running':
            phase = 'interrupted'
        summary = read_json(self.work_dir / 'reanalyze-summary.json', {})
        if reanalysis_queue.pending_requests(self.work_dir):
            # Requests written by Validate or other tools join the queue now, so the card shows them before a run.
            try:
                reanalysis_queue.consume_requests(self.work_dir)
            except sqlite3.Error:
                pass
        return {'available': True, 'reanalyze': {
            'running': bool(live or pending), 'phase': phase, 'pid': (live or pending or {}).get('pid'), 'run': record,
            'stopRequested': bool((live or pending) and stop), 'abortRequested': bool((live or pending) and abort),
            'summary': summary, 'queue': reanalysis_queue.snapshot(self.work_dir, limit=300),
            'reasons': reanalysis_queue.REASONS,
            'harvesterRunning': bool(self._runs(rows)), 'tornado': self._tornado(rows),
            'defaultJobs': max(1, min(16, (os.cpu_count() or 4) * 2 // 3)),
            'log': self._tail_file(self.work_dir / 'reanalyze.log', 30000, 60)}}

    def reanalyze_queue(self, body):
        ids = body.get('ids')
        if not isinstance(ids, (str, list)):
            raise ValueError('ids must be text or a list of video ids or URLs.')
        result = reanalysis_queue.queue(self.work_dir, ids, body.get('reason') or 'code-fix', 'full', 'owner')
        return {**self.reanalyze_status(), 'queued': {k: v for k, v in result.items() if k != 'ids'}, 'queuedIds': result['ids']}

    def reanalyze_remove(self, body):
        ids = body.get('ids')
        if not isinstance(ids, (str, list)):
            raise ValueError('ids must be text or a list of video ids.')
        return {**self.reanalyze_status(), 'removed': reanalysis_queue.remove(self.work_dir, ids)['removed']}

    def reanalyze_start(self, body):
        jobs = body.get('jobs', max(1, min(16, (os.cpu_count() or 4) * 2 // 3)))
        if isinstance(jobs, bool) or not isinstance(jobs, int) or not 1 <= jobs <= min(16, os.cpu_count() or 4):
            raise ValueError('jobs must be an integer between 1 and %s.' % min(16, os.cpu_count() or 4))
        fetch = body.get('fetchMissing') is True
        with self.lock, file_lock(self.work_dir / 'start.lock'):
            live, pending, _ = self._reanalyzer(self.processes())
            if live or pending or reanalysis_queue.reanalyzer_running(str(self.work_dir)):
                return self.reanalyze_status()
            deps = self.dependency_probe()
            if not deps['ready']:
                raise RuntimeError('Cannot start: ' + ', '.join(deps['missing']) + '. ' + deps.get('message', ''))
            for name in ('reanalyze.STOP', 'reanalyze.ABORT'):
                (self.work_dir / name).unlink(missing_ok=True)
            env = dict(os.environ, PATH='/opt/homebrew/bin:' + os.environ.get('PATH', ''), YT_HARVEST_WORK=str(self.work_dir), YT_HARVEST_QUIET='1')
            command = [deps['python'], '-I', str(self.web_root / 'scripts/yt-harvest/reanalyze.py'), 'run', '--work-dir',
                       str(self.work_dir), '--jobs', str(jobs)] + (['--fetch-missing', 'tornado'] if fetch else [])
            caffeinate = shutil.which('caffeinate')
            if caffeinate:
                command = [caffeinate, '-i'] + command
            with (self.work_dir / 'reanalyze-launcher.log').open('ab') as stream:
                child = self.popen(command, cwd=str(self.web_root), env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            self.children.append(child)
            current = next((row for row in self.processes() if row['pid'] == child.pid), {})
            atomic_json(self.work_dir / 'reanalyze-launch.json', {'pid': child.pid, 'identity': current.get('identity'),
                        'jobs': jobs, 'fetchMissing': fetch, 'startedAt': time.time()})
            result = self.reanalyze_status()
            exit_code = child.poll()
            if exit_code is not None and exit_code != 0:
                tail = self._tail_file(self.work_dir / 'reanalyze-launcher.log')
                raise RuntimeError('Re-analysis failed to start: ' + (tail[-1] if tail else 'exit %s' % exit_code))
            if not result['reanalyze']['running'] and exit_code is None:
                result['reanalyze'].update(running=True, phase='starting', pid=child.pid)
            return result

    def reanalyze_stop(self, body):
        (self.work_dir / 'reanalyze.STOP').touch()
        if body.get('now') is True:
            (self.work_dir / 'reanalyze.ABORT').touch()
        return self.reanalyze_status()

    def feedback(self):
        with self.lock:
            if self._feedback is None:
                from feedback import FeedbackService
                self._feedback = FeedbackService(work_dir=self.work_dir, web_root=self.web_root)
            return self._feedback

    def validation_metrics(self):
        """Per-refit model metrics. A second server (another one owns validation) reads the history file
        read-only, so the charts still show; the owning server serves its in-memory copy."""
        from feedback import FeedbackUnavailable
        try:
            return self.feedback().metrics()
        except FeedbackUnavailable:
            import metrics_history
            history = metrics_history.load(self.work_dir) or metrics_history.new_history()
            return {**history, 'readOnly': True}
