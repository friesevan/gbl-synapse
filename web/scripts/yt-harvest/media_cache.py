"""Read-only inventory of retained source media; no downloads, decodes, or eviction.

Existing download_dir is the durable cache. Default retention keeps complete ID-named
videos, even when an old state row says deleted. --discard-videos is the explicit
harvester opt-out. Run this module with --jobs OUTPUT.txt to prepare run-batch.cjs
input plus OUTPUT.txt.manifest.json. Batch jobs process the original whole file:
stored crop/ranges are preserved in the manifest, and timestamps stay unmodified.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile

MEDIA_NAME = re.compile(r"^([A-Za-z0-9_-]{11})\.(mp4|webm|mkv|mov|m4v)$", re.I)
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def retained_file(name, keep=True):
    """Only complete, direct ID-named media qualifies; fragments never do."""
    return bool(keep and isinstance(name, str) and MEDIA_NAME.fullmatch(name))


def _read_json(path):
    if path.is_symlink() or not path.is_file():
        return {}
    try:
        with path.open() as stream:
            value = json.load(stream)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _rows(work):
    db = work / "state.sqlite"
    if db.is_symlink():
        return [], ["State database is a symlink; metadata was not read."]
    if not db.is_file():
        return [], ["State database missing; available files are inventoried without harvest metadata."]
    try:
        with closing(sqlite3.connect(db.absolute().as_uri() + "?mode=ro", uri=True, timeout=2)) as conn:
            conn.row_factory = sqlite3.Row
            return [dict(row) for row in conn.execute("SELECT * FROM videos ORDER BY id")], []
    except sqlite3.Error as error:
        return [], ["Could not read state database: " + str(error)]


def _hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe_file(root, path, video_id):
    # Never follow symlinks or accept state records pointing outside this cache.
    path = Path(path)
    if ".." in path.parts:
        return False
    path = Path(os.path.abspath(path))
    match = MEDIA_NAME.fullmatch(path.name)
    if path.parent.resolve() != root or not match or match.group(1) != video_id or path.is_symlink():
        return False
    return True


def inventory(download_dir, work_dir, verify_sha=False, video_ids=None):
    """Return source paths plus historical extraction context. All inputs are read-only.

    Historical harvest hashes contain the first 16 SHA-256 hex characters, not a
    full digest. Optional verification streams files and compares that prefix;
    without verification the existing hash is reported explicitly as recorded.
    """
    root = Path(download_dir).expanduser().resolve()
    work = Path(work_dir).expanduser().resolve()
    selected = set(video_ids or [])
    if any(not VIDEO_ID.fullmatch(value) for value in selected):
        raise ValueError("Each video ID must contain exactly 11 URL-safe characters.")
    rows, warnings = _rows(work)
    candidates = {}
    if root.is_dir():
        for path in sorted(root.iterdir()):
            match = MEDIA_NAME.fullmatch(path.name)
            if match:
                candidates.setdefault(match.group(1), []).append(path)
    else:
        warnings.append("Download directory missing.")
    state = {str(row.get("id")): row for row in rows if VIDEO_ID.fullmatch(str(row.get("id", ""))) and any(row.get(k) for k in ("dl_path", "sha256", "deleted_date", "x_status"))}
    ids = sorted((set(state) | set(candidates) | selected) if not selected else selected)
    items = []
    for video_id in ids:
        row = state.get(video_id, {})
        stored = row.get("dl_path")
        paths = candidates.get(video_id, [])
        preferred = Path(stored) if stored else None
        # State dl_path is authoritative when present. Do not silently substitute
        # another encode for a missing/unsafe source; record alternatives separately.
        path = preferred if preferred else (paths[0] if paths else root / (video_id + ".mp4"))
        if not path.is_absolute():
            path = root / path
        safe = _safe_file(root, path, video_id)
        available = safe and path.is_file()
        result = _read_json(work / "results" / (video_id + ".json"))
        context = result.get("learningContext") or {}
        context = context if isinstance(context, dict) else {}
        probe = result.get("probe") or {}
        probe = probe if isinstance(probe, dict) else {}
        try:
            league = json.loads(row.get("league") or "{}")
        except (TypeError, ValueError):
            league = {}
        if not isinstance(league, dict):
            league = {}
        media = result.get("media") or {}
        media = media if isinstance(media, dict) else {}
        box = probe.get("box")
        crop = ",".join(str(v) for v in box) if isinstance(box, list) and len(box) == 4 else "auto"
        if isinstance(media.get("crop"), str):
            crop = media["crop"]
        cp = context.get("league") or league.get("cp") or league.get("cpCap")
        cp = cp if cp in (500, 1500, 2500, 10000) else None
        recorded_sha = str(row["sha256"]) if row.get("sha256") else None
        size = None
        status = "available" if available else "missing" if safe else "unsafe"
        if available:
            try:
                size = path.stat().st_size
            except OSError:
                available = False
                status = "unreadable"
        item = {"videoId": video_id, "status": status,
                "path": str(path), "sourceUrl": "https://www.youtube.com/watch?v=" + video_id,
                "title": row.get("title") or "", "uploadDate": row.get("upload_date") or context.get("uploadDate"),
                "duration": row.get("duration"), "sizeBytes": size,
                "recordedSha256": recorded_sha, "recordedHashScope": "sha256-prefix-16" if recorded_sha and len(recorded_sha) == 16 else "sha256" if recorded_sha and len(recorded_sha) == 64 else "unknown",
                "sha256": None, "hashVerified": None, "league": league, "cp": cp,
                "gamemaster": context.get("gamemaster") or "", "crop": crop, "ranges": media.get("ranges") or probe.get("ranges") or [],
                "timestampBasis": "original-source-seconds", "extractionStatus": row.get("x_status"),
                "previouslyMarkedDeleted": bool(row.get("deleted_date")), "tracked": bool(row),
                "alternatives": [str(p) for p in paths if p != path]}
        if available and verify_sha:
            try:
                item["sha256"] = _hash(path)
                if recorded_sha:
                    item["hashVerified"] = item["sha256"].startswith(recorded_sha.lower())
                    if not item["hashVerified"]:
                        item["status"] = "hash-mismatch"
            except OSError as error:
                item["status"] = "unreadable"
                item["error"] = str(error)
        items.append(item)
    return {"version": 1, "downloadDir": str(root), "workDir": str(work), "warnings": warnings,
            "items": items, "counts": {key: sum(i["status"] == key for i in items) for key in ("available", "missing", "unsafe", "hash-mismatch", "unreadable")}}


def batch_jobs(report, default_cp=None, gamemaster=None):
    """Generate compatible whole-source jobs; never silently guess an unknown league."""
    lines, skipped = [], []
    for item in report["items"]:
        cp = item.get("cp") or default_cp
        if item["status"] != "available" or cp not in (500, 1500, 2500, 10000):
            skipped.append({"videoId": item["videoId"], "reason": item["status"] if item["status"] != "available" else "league-unknown; provide --default-cp"})
            continue
        fields = [item["path"], str(cp), gamemaster or item.get("gamemaster") or "", item.get("crop") or "auto"]
        if any(any(c in str(value) for c in ("|", "\n", "\r")) for value in fields):
            skipped.append({"videoId": item["videoId"], "reason": "job field contains a delimiter"})
            continue
        lines.append("|".join(str(value) for value in fields))
    return "\n".join(lines) + ("\n" if lines else ""), skipped


def _write(path, data, overwrite=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or (path.exists() and not overwrite):
        raise FileExistsError("Output exists; choose a new path or --overwrite: " + str(path))
    # Write only caller-selected output; never alter downloaded media or state.
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as stream:
        tmp = stream.name
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--download-dir", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--verify-sha", action="store_true", help="stream files to verify full SHA-256 against recorded hashes")
    parser.add_argument("--video-id", action="append", default=[])
    parser.add_argument("--jobs", help="write run-batch input plus .manifest.json at this explicit output path")
    parser.add_argument("--default-cp", type=int, choices=(500, 1500, 2500, 10000))
    parser.add_argument("--gamemaster", help="explicit game-master override for generated jobs")
    parser.add_argument("--overwrite", action="store_true", help="replace existing chosen output files")
    args = parser.parse_args(argv)
    report = inventory(args.download_dir, args.work_dir, args.verify_sha, args.video_id)
    if args.jobs:
        text, skipped = batch_jobs(report, args.default_cp, args.gamemaster)
        report["jobsSkipped"] = skipped
        report["jobsTimestampBasis"] = "whole-source-original-seconds; stored ranges are metadata only"
        manifest = args.jobs + ".manifest.json"
        # Check both destinations before writing either to avoid partial output on conflicts.
        for name in (args.jobs, manifest):
            p = Path(name)
            if p.is_symlink() or (p.exists() and not args.overwrite):
                parser.error("Output exists; choose a new path or --overwrite: " + name)
        _write(args.jobs, text, args.overwrite)
        _write(manifest, json.dumps(report, indent=2) + "\n", args.overwrite)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
