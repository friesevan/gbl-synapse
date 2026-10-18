"""Re-analysis queue in the harvester's state database (shared by reanalyze.py, service.py and harvest.py).

A queued video keeps its earlier result (and x_status 'done') until the new analysis replaces it, so Observed meta
and the learning loop never lose it. Only standard-library imports: the local app's Python loads this directly.

Table reprocess(id PRIMARY KEY, requested REAL, reason TEXT, scope TEXT, source TEXT):
  reason  why the video is analysed again (REASONS); it decides what the fast path may reuse
  scope   'full' (the whole video is decoded); kept for a future verified partial mode
  source  who queued it: 'owner' (the Re-analysis card), 'validate' (a Validate answer), 'cli', 'harvester'
"""
import fcntl
import json
import os
import re
import sqlite3
import time

VIDEO_ID = re.compile(r"(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])")
URL_ID = re.compile(r"(?:v=|youtu\.be/|/shorts/|/live/|/embed/)([A-Za-z0-9_-]{11})")

# Why a video is analysed again (shown in the card; Validate's own requests map to battles-missing / wrong-screen).
REASONS = {
    "code-fix": "The Meta Extractor changed (for example, better name reading)",
    "battles-missing": "Battles were missed or cut short",
    "wrong-screen": "The wrong phone screen or crop was read",
    "wrong-result": "A battle's details are wrong",
    "other": "Other",
}
SCOPES = ("full",)
SOURCES = ("owner", "validate", "cli", "harvester")
MAX_IDS = 5000


LOCK_NAME = "reanalyze.lock"


def reanalyzer_running(work_dir):
    """True while a reanalyze.py run holds its lock on this work directory."""
    path = os.path.join(work_dir, LOCK_NAME)
    if not os.path.exists(path):
        return False
    with open(path, "a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(stream, fcntl.LOCK_UN)
    return False


def connect(work_dir, timeout=30):
    db = sqlite3.connect(os.path.join(work_dir, "state.sqlite"), timeout=timeout)
    db.row_factory = sqlite3.Row
    ensure_schema(db)
    return db


def ensure_schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS reprocess(id TEXT PRIMARY KEY, requested REAL)")
    have = {row[1] for row in db.execute("PRAGMA table_info(reprocess)")}
    for column in ("reason", "scope", "source"):
        if column not in have:
            db.execute(f"ALTER TABLE reprocess ADD COLUMN {column} TEXT")
    db.commit()


def parse_ids(value):
    """Video ids from pasted text: ids, watch/short/live/youtu.be URLs, separated by anything. Order kept, no repeats."""
    if isinstance(value, (list, tuple)):
        value = "\n".join(str(v) for v in value)
    text = str(value or "")
    found = URL_ID.findall(text)
    rest = URL_ID.sub(" ", text)
    found += [m for m in VIDEO_ID.findall(rest) if not m.startswith("http")]
    return list(dict.fromkeys(found))


def _obscured(work_dir, vid):
    try:
        with open(os.path.join(work_dir, "labels", vid + ".json"), encoding="utf-8") as f:
            return (json.load(f) or {}).get("videoType") == "obscured"
    except (OSError, ValueError):
        return False


def queue(work_dir, ids, reason="code-fix", scope="full", source="owner", db=None, busy=()):
    """Queue videos for re-analysis. A video on disk goes straight to the analysis queue; one that is not is marked
    for download (by the harvester, or Tornado when the re-analysis run is told to fetch). Returns counts and lists."""
    if reason not in REASONS:
        raise ValueError("reason must be one of: " + ", ".join(REASONS))
    if scope not in SCOPES:
        raise ValueError("scope must be full")
    if source not in SOURCES:
        raise ValueError("source must be one of: " + ", ".join(SOURCES))
    ids = parse_ids(ids)
    if len(ids) > MAX_IDS:
        raise ValueError(f"at most {MAX_IDS} videos at a time")
    own = db is None
    db = db or connect(work_dir)
    out = {"queued": [], "onDisk": [], "needDownload": [], "unknown": [], "obscured": [], "busy": []}
    try:
        now = time.time()
        for vid in ids:
            row = db.execute("SELECT dl_path, dl_status, x_status FROM videos WHERE id=?", (vid,)).fetchone()
            if not row:
                out["unknown"].append(vid)
                continue
            if _obscured(work_dir, vid):
                # The reviewer said an overlay hides the HUD: analysing it again cannot help.
                out["obscured"].append(vid)
                continue
            if vid in busy or row["dl_status"] in ("working", "tornado") or row["x_status"] in ("working", "reworking"):
                # Being downloaded or analysed right now: the request is still recorded; nothing is reset under it.
                out["busy"].append(vid)
            elif row["dl_path"] and os.path.isfile(row["dl_path"]):
                db.execute("UPDATE videos SET dl_status='done', deleted_date=NULL, updated=? WHERE id=?", (now, vid))
                out["onDisk"].append(vid)
            else:
                db.execute("UPDATE videos SET dl_status=NULL, deleted_date=NULL, attempts=0, err=NULL, rel_label='relevant', "
                           "allowed=1, updated=? WHERE id=?", (now, vid))
                out["needDownload"].append(vid)
            db.execute("INSERT OR REPLACE INTO reprocess(id, requested, reason, scope, source) VALUES(?,?,?,?,?)",
                       (vid, now, reason, scope, source))
            out["queued"].append(vid)
        db.commit()
    finally:
        if own:
            db.close()
    return {**{k: len(v) for k, v in out.items()}, "ids": out}


def remove(work_dir, ids, db=None):
    """Take videos off the queue. Their earlier results stay; nothing is downloaded or deleted."""
    ids = parse_ids(ids)
    own = db is None
    db = db or connect(work_dir)
    try:
        n = 0
        for vid in ids:
            n += db.execute("DELETE FROM reprocess WHERE id=? AND id NOT IN (SELECT id FROM videos WHERE x_status IN "
                            "('working','reworking'))", (vid,)).rowcount
        db.commit()
        return {"removed": n}
    finally:
        if own:
            db.close()


def snapshot(work_dir, limit=200):
    """Queue state for the Re-analysis card: counts and the first `limit` queued videos (oldest request first)."""
    path = os.path.join(work_dir, "state.sqlite")
    if not os.path.exists(path):
        return {"total": 0, "ready": 0, "running": 0, "waitingDownload": 0, "downloading": 0, "reasons": {}, "items": []}
    db = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    try:
        have = {row[1] for row in db.execute("PRAGMA table_info(reprocess)")}
        if not have:
            return {"total": 0, "ready": 0, "running": 0, "waitingDownload": 0, "downloading": 0, "reasons": {}, "items": []}
        cols = ", ".join(f"r.{c}" if c in have else f"NULL AS {c}" for c in ("reason", "scope", "source"))
        rows = db.execute("SELECT v.id, v.title, v.channel, v.duration, v.dl_status, v.dl_path, v.deleted_date, v.x_status, "
                          "v.err, r.requested, " + cols + " FROM reprocess r JOIN videos v ON v.id=r.id "
                          "ORDER BY r.requested, v.upload_date DESC").fetchall()
    finally:
        db.close()
    items, counts, reasons = [], {"ready": 0, "running": 0, "waitingDownload": 0, "downloading": 0}, {}
    for r in rows:
        on_disk = r["dl_status"] == "done" and not r["deleted_date"] and bool(r["dl_path"]) and os.path.isfile(r["dl_path"])
        state = ("running" if r["x_status"] in ("working", "reworking") else
                 "downloading" if r["dl_status"] in ("working", "tornado") else
                 "ready" if on_disk else "waitingDownload")
        counts[state] += 1
        reasons[r["reason"] or "other"] = reasons.get(r["reason"] or "other", 0) + 1
        if len(items) < limit:
            items.append({"id": r["id"], "title": r["title"], "channel": r["channel"], "duration": r["duration"],
                          "state": state, "reason": r["reason"] or "other", "scope": r["scope"] or "full",
                          "source": r["source"], "requested": r["requested"], "error": r["err"]})
    return {"total": len(rows), **counts, "reasons": reasons, "items": items}


def requeue_reason(text):
    """A request file's free-text reason -> a queue reason."""
    text = (text or "").lower()
    if "perspective" in text or "screen" in text or "crop" in text:
        return "wrong-screen"
    if "battle" in text and ("miss" in text or "footage" in text or "shown" in text):
        return "battles-missing"
    return "code-fix" if ("fix" in text or "nameplate" in text or "banner" in text or "placement" in text) else "other"


def pending_requests(work_dir):
    directory = os.path.join(work_dir, "requeue")
    try:
        return sum(1 for name in os.listdir(directory) if name.endswith(".json"))
    except OSError:
        return 0


def consume_requests(work_dir, db=None, inflight=(), log=None):
    """Request files in WORK/requeue (Validate answers, other tools and sessions) join the queue; each file is removed
    once queued, or renamed .unknown / .obscured / .invalid. Immutable files avoid racing live feedback writes."""
    directory = os.path.join(work_dir, "requeue")
    if not os.path.isdir(directory):
        return 0
    own = db is None
    db = db or connect(work_dir)
    n = 0
    try:
        for name in sorted(os.listdir(directory))[:500]:
            if not name.endswith(".json"):
                continue
            path = os.path.join(directory, name)
            try:
                with open(path, encoding="utf-8") as f:
                    request = json.load(f) or {}
            except (OSError, ValueError):
                request = {}
            vid = request.get("videoId", "") if isinstance(request, dict) else ""
            if not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid or ""):
                os.replace(path, path + ".invalid")
                continue
            if vid in inflight:
                continue      # an active worker owns it; try again at the next tick
            out = queue(work_dir, [vid], reason=requeue_reason(request.get("reason")), source="validate", db=db)
            if out["unknown"]:
                os.replace(path, path + ".unknown")
            elif out["obscured"]:
                os.replace(path, path + ".obscured")
            else:
                os.remove(path)
                n += 1
                if log:
                    log.info("requeued %s (%s)", vid, "local video" if out["onDisk"] else "being processed" if out["busy"] else "redownload required")
    finally:
        if own:
            db.close()
    return n
