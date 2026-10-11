"""Versioned raw screen/range cache, independent of classifier predictions."""
import hashlib
import json
import os
from pathlib import Path

DEPENDENCIES = ('tests/meta-benchmark/probe.cjs', 'tests/meta-benchmark/locate-screen.cjs',
                'tests/meta-benchmark/hud-scan-plan.cjs', 'includes/meta/screen.js', 'includes/meta/core.js')


def identity(video, web, env=None, source_sha=None):
    source = Path(video)
    if source.is_symlink() or not source.is_file():
        return None
    stat = source.stat()
    # Existing source identity is combined with extraction implementation/config identity.
    code = hashlib.sha256()
    for name in DEPENDENCIES:
        code.update(name.encode())
        code.update((Path(web) / name).read_bytes())
    options = {k: (os.environ if env is None else env).get(k, '') for k in ('PROBE_PRE', 'PROBE_POST', 'PROBE_GAP')}
    return {'schema': 1, 'source': str(source.resolve()), 'bytes': stat.st_size,
            'mtimeNs': stat.st_mtime_ns, 'ctimeNs': stat.st_ctime_ns, 'recordedSha256': source_sha, 'code': code.hexdigest(), 'options': options}


def load(file, key):
    if key is None:
        return None
    try:
        doc = json.loads(Path(file).read_text())
        probe = doc['probe']
        payload = json.dumps(probe, sort_keys=True, separators=(',', ':')).encode()
        if doc.get('key') == key and doc.get('checksum') == hashlib.sha256(payload).hexdigest() and isinstance(probe, dict):
            return probe
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def document(key, probe):
    payload = json.dumps(probe, sort_keys=True, separators=(',', ':')).encode()
    return {'key': key, 'probe': probe, 'checksum': hashlib.sha256(payload).hexdigest()}
