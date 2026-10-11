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

    def _runs(self):
        return [row for row in self.processes() if is_harvester(row, self.work_dir, self.script)]

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
                runs = self._runs()
                process_error = None
            except (OSError, subprocess.SubprocessError) as ex:
                runs, process_error = [], 'Unable to inspect running processes: ' + str(ex)[:200]
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
                'duplicateProcesses': len(runs) > 1}}

    def _database_status(self):
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
        return self._tail_file(self.work_dir / 'harvest.log')

    @staticmethod
    def _tail_file(path):
        try:
            with Path(path).open('rb') as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - 12000))
                return stream.read().decode('utf-8', 'replace').splitlines()[-35:]
        except OSError:
            return []

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

    def feedback(self):
        with self.lock:
            if self._feedback is None:
                from feedback import FeedbackService
                self._feedback = FeedbackService(work_dir=self.work_dir, web_root=self.web_root)
            return self._feedback
