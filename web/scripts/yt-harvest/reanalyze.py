#!/usr/bin/env python3
"""Re-analysis of videos the harvester already analysed (Meta Extractor › Analyze & review › Re-analysis).

The harvester (harvest.py) finds, downloads and analyses each video once. This tool analyses queued videos again with
the current Meta Extractor, in its own process, so a re-analysis never waits behind YouTube rate limits and the
harvester's downloads never wait behind a long re-analysis. Both share the harvester's state database; each resets only
its own work in progress (harvest.State reset="all" / "reprocess"), and the harvester no longer claims queued videos.

    python3 -I reanalyze.py queue --ids ID,ID… [--reason code-fix]
    python3 -I reanalyze.py run [--jobs N] [--fetch-missing tornado] [--keep-running]
    python3 -I reanalyze.py status
    python3 -I reanalyze.py stop [--now]

Every re-analysis decodes the whole video, as the first analysis did. Reusing what the earlier analysis found (its
battle times, screen box or nameplate language) was measured on three queued videos on 2026-10-18 and changed the
answers on two of them (a battle in the first seconds was lost; presetting the nameplate language dropped species
reads), so it is not done; see includes/meta/README.md § 8 "Re-analysis".

A queued video that is not on disk waits for the harvester to download it again (first in its download queue), or,
with --fetch-missing tornado (the card's checkbox), is fetched through tornado_fetch.py within its 100 GB allowance.

Progress lives in WORK/reanalyze-summary.json (rewritten every few seconds) and WORK/reanalyze-run.json (this run's
identity). "Stop safely" (WORK/reanalyze.STOP) finishes the videos being analysed; "Stop now" (WORK/reanalyze.ABORT)
ends them at once, and their earlier results stay. Either way the queue is kept for the next run.
"""
import argparse
import collections
import datetime as dt
import fcntl
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harvest as H  # noqa: E402
import reanalysis_queue as RQ  # noqa: E402
from service import atomic_json, read_json, process_table  # noqa: E402

log = logging.getLogger("harvest")
SUMMARY = "reanalyze-summary.json"
RUN = "reanalyze-run.json"
STOP = "reanalyze.STOP"
ABORT = "reanalyze.ABORT"
DEFAULT_REALTIME = 3.0    # seconds of video per second per worker until this run has measured its own
TORNADO_HEIGHT = "720"


# ---------------------------------------------------------------------------------------------- before / after
def _teams(result):
    out = []
    for b in (result or {}).get("battles") or []:
        out.append({"start": b.get("start"), "my": list(b.get("my") or []), "opponent": list(b.get("opponent") or []),
                    "result": b.get("result")})
    return out


def compare(before, after):
    """What the new analysis changed, in a few counts and words (shown in the card's Finished list)."""
    b, a = _teams(before), _teams(after)
    species = lambda teams, side: collections.Counter(s for t in teams for s in t[side])
    gained, lost = [], []
    for side in ("opponent", "my"):
        old, new = species(b, side), species(a, side)
        gained += sorted((new - old).elements())
        lost += sorted((old - new).elements())
    results = sum(1 for x, y in zip(sorted(b, key=lambda t: t["start"] or 0), sorted(a, key=lambda t: t["start"] or 0))
                  if x["result"] != y["result"])
    words = []
    if len(a) != len(b):
        words.append(f"battles {len(b)} → {len(a)}")
    if gained or lost:
        words.append("species " + ", ".join([f"+{s}" for s in dict.fromkeys(gained)][:6] + [f"−{s}" for s in dict.fromkeys(lost)][:6]))
    if results:
        words.append(f"{results} result{'s' if results != 1 else ''} changed")
    return {"battlesBefore": len(b), "battlesAfter": len(a), "gained": gained[:20], "lost": lost[:20],
            "resultsChanged": results, "summary": "; ".join(words) or "no change"}


# ---------------------------------------------------------------------------------------------- runner
class Reanalyzer(H.Harvester):
    STATE_RESET = "reprocess"
    EXTRACT_LOG = "reanalyze-extract.log"

    def __init__(self, a):
        super().__init__(a)
        self.x_claim = (H.X_REPROCESS_CLAIM, ())
        self.jobs = {}                      # vid -> live job record for the card
        self.recent = collections.deque(maxlen=60)
        self.done = {"ok": 0, "failed": 0, "interrupted": 0, "needsDownload": 0, "videoSeconds": 0.0, "busySeconds": 0.0}
        self.started_at = dt.datetime.now(dt.timezone.utc).isoformat()
        self.fetch_proc = None
        self.fetch_tried = set()
        self.fetch_log = []
        self.jobs_lock = threading.Lock()

    def _load_registry(self):
        return {}   # only the harvester's downloads need the registry (duplicates); it is 100+ MB

    @property
    def stop_file(self):
        return os.path.join(self.a.work_dir, STOP)

    def abort_job(self, vid):
        return os.path.exists(os.path.join(self.a.work_dir, ABORT))

    def _claim(self, sql, args, status_col, working):
        """Atomic across processes: the row is only taken if no one marked it working in the meantime."""
        with self.state.lock:
            for row in self.state.q(sql, args):
                if row["id"] in self.inflight:
                    continue
                n = self.state.x(f"UPDATE videos SET {status_col}=? WHERE id=? AND COALESCE({status_col},'') NOT IN "
                                 "('working','reworking')", (working(row) if callable(working) else working, row["id"]))
                if n:
                    self.inflight.add(row["id"])
                    return dict(row)
        return None

    def _prior(self, vid):
        return read_json(os.path.join(self.a.work_dir, "results", vid + ".json"), {})

    def job_env(self, vid, plan):
        path = os.path.join(self.a.work_dir, "reanalyze", "progress", vid + ".json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return {"PROGRESS_FILE": path}

    def job_started(self, vid, row, plan):
        with self.jobs_lock:
            if vid in self.jobs:
                self.jobs[vid]["analysisStarted"] = time.time()

    def extract_one(self, r):
        vid = r["id"]
        before = self._prior(vid)
        with self.jobs_lock:
            self.jobs[vid] = {"id": vid, "title": r.get("title") or "", "videoSeconds": r.get("duration") or 0,
                              "reason": r.get("reason") or "other",
                              "startedAt": time.time(), "mode": "whole video",
                              "plannedSeconds": r.get("duration") or 0}
        t = time.time()
        try:
            super().extract_one(r)
        finally:
            with self.jobs_lock:
                job = self.jobs.pop(vid, {})
        row = (self.state.q("SELECT x_status, dl_status, err FROM videos WHERE id=?", (vid,)) or [{}])[0]
        still_queued = bool(self.state.q("SELECT 1 FROM reprocess WHERE id=?", (vid,)))
        seconds = time.time() - t
        if not still_queued and row["x_status"] == "done" and (row["err"] or "") != "re-analysis failed":
            outcome = "ok"
        elif still_queued and row["x_status"] == "failed":
            # A video with no earlier result whose analysis failed: off the queue, so it isn't retried forever.
            self.state.x("DELETE FROM reprocess WHERE id=?", (vid,))
            outcome = "failed"
        elif still_queued and row["dl_status"] is None:
            outcome = "needsDownload"      # the file was gone; the harvester (or Tornado) downloads it again
        elif still_queued:
            outcome = "interrupted"
        else:
            outcome = "failed"
        entry = {"id": vid, "title": job.get("title") or r.get("title") or "", "at": time.time(), "outcome": outcome,
                 "seconds": round(seconds), "mode": job.get("mode"), "plannedSeconds": job.get("plannedSeconds"),
                 "error": row["err"] if outcome == "failed" else None}
        if outcome == "ok":
            entry["change"] = compare(before, self._prior(vid))
            self.done["videoSeconds"] += job.get("plannedSeconds") or 0
            self.done["busySeconds"] += seconds
        self.done[outcome] += 1
        self.recent.appendleft(entry)
        log.info("re-analysis %s: %s in %.0f s (%s)%s", vid, outcome, seconds, job.get("mode"),
                 " · " + entry["change"]["summary"] if outcome == "ok" else "")

    # ---- Tornado: requested downloads only (the owner ticks "Download missing videos through Tornado")
    def fetch_missing(self):
        if self.a.fetch_missing != "tornado" or (self.fetch_proc and self.fetch_proc.poll() is None):
            return
        if self.fetch_proc is not None:
            self.fetch_proc = None
        rows = self.state.q("SELECT v.id FROM reprocess r JOIN videos v ON v.id=r.id WHERE v.dl_status IS NULL "
                            "ORDER BY r.requested")
        ids = [r["id"] for r in rows if r["id"] not in self.fetch_tried][:20]
        if not ids:
            return
        self.fetch_tried.update(ids)
        cmd = [sys.executable, "-I", os.path.join(HERE, "tornado_fetch.py"), "--ids", ",".join(ids), "--max-resolution",
               TORNADO_HEIGHT, "--work-dir", self.a.work_dir, "--download-dir", self.a.download_dir]
        stream = open(os.path.join(self.a.work_dir, "tornado.log"), "a")
        stream.write(f"--- {dt.datetime.now():%m-%d %H:%M} re-analysis queue: {len(ids)} videos\n")
        stream.flush()
        self.fetch_proc = subprocess.Popen(cmd, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        stream.close()
        log.info("re-analysis: fetching %d missing videos through Tornado", len(ids))

    # ---- live report
    def _job_progress(self, job):
        p = read_json(os.path.join(self.a.work_dir, "reanalyze", "progress", job["id"] + ".json"), {})
        t = p.get("t")
        planned = job.get("plannedSeconds") or job.get("videoSeconds") or 0
        if t is None:
            done = 0.0
        else:
            done = float(t)
        rt = self.realtime()
        left = max(0.0, planned - done) / rt if planned else None
        return {**job, "doneSeconds": round(min(done, planned or done), 1),
                "fraction": round(min(1.0, done / planned), 3) if planned else None,
                "etaSeconds": round(left) if left is not None else None}

    def realtime(self):
        """Measured seconds of planned video per second per worker this run (default until two videos are done)."""
        if self.done["ok"] >= 2 and self.done["busySeconds"] > 0:
            return max(0.3, self.done["videoSeconds"] / self.done["busySeconds"])
        return DEFAULT_REALTIME

    def report(self):
        snap = RQ.snapshot(self.a.work_dir, limit=0)
        with self.jobs_lock:
            active = [self._job_progress(j) for j in self.jobs.values()]
        ready = self.state.q("SELECT v.id, v.duration, r.reason, r.scope FROM reprocess r JOIN videos v ON v.id=r.id "
                             "WHERE v.dl_status='done' AND v.deleted_date IS NULL AND COALESCE(v.x_status,'') NOT IN "
                             "('working','reworking')")
        waiting_s = sum(float(r["duration"] or 0) for r in ready)
        active_s = sum(max(0.0, (j.get("plannedSeconds") or 0) - (j.get("doneSeconds") or 0)) for j in active)
        workers = max(1, min(self.extract_jobs, len(ready) + len(active)))
        eta = (waiting_s + active_s) / (self.realtime() * workers) if (ready or active) else 0
        fetching = self.fetch_proc is not None and self.fetch_proc.poll() is None
        tornado = read_json(os.path.join(self.a.work_dir, "tornado-usage.json"), {})
        summary = {"phase": "stopping" if not self.alive() else "running", "pid": os.getpid(), "startedAt": self.started_at,
                   "updated": dt.datetime.now(dt.timezone.utc).isoformat(), "jobs": self.extract_jobs,
                   "fetchMissing": self.a.fetch_missing, "fetching": fetching, "keepRunning": self.a.keep_running,
                   "queue": {k: snap.get(k) for k in ("total", "ready", "running", "waitingDownload", "downloading")},
                   "finished": dict(self.done), "realtimePerWorker": round(self.realtime(), 2),
                   "workersBusy": len(active), "etaSeconds": round(eta), "waitingVideoSeconds": round(waiting_s),
                   "active": sorted(active, key=lambda j: j.get("startedAt") or 0), "recent": list(self.recent)[:30],
                   "tornado": {"usedGB": round((tornado.get("bytes") or 0) / 1e9, 2),
                               "capGB": round((tornado.get("capBytes") or 100e9) / 1e9)} if tornado else None}
        atomic_json(os.path.join(self.a.work_dir, SUMMARY), summary)
        return summary

    def reporter(self):
        while not self.stop.is_set():
            try:
                self.report()
            except Exception as ex:   # the report never stops the analyses
                log.warning("re-analysis report: %s", str(ex)[:200])
            self.stop.wait(3)

    def has_work(self):
        if self.jobs or self.state.q(H.X_REPROCESS_CLAIM.replace("LIMIT 16", "LIMIT 1")):
            return True
        if self.a.fetch_missing == "tornado":
            if self.fetch_proc is not None and self.fetch_proc.poll() is None:
                return True
            pending = self.state.q("SELECT v.id FROM reprocess r JOIN videos v ON v.id=r.id WHERE v.dl_status IS NULL")
            if any(r["id"] not in self.fetch_tried for r in pending):
                return True
            if self.state.q("SELECT 1 FROM reprocess r JOIN videos v ON v.id=r.id WHERE v.dl_status='tornado' LIMIT 1"):
                return True
        return False

    def run(self):
        log.info("re-analysis: start · %d workers · missing videos: %s", self.extract_jobs,
                 "Tornado" if self.a.fetch_missing == "tornado" else "wait for the harvester")
        # A fetch interrupted with this tool (no tornado_fetch.py alive) goes back to waiting for a download.
        if not any("tornado_fetch.py" in row["command"] for row in process_table()):
            self.state.x("UPDATE videos SET dl_status=NULL WHERE dl_status='tornado' AND " + H.REPROCESS)
        threads = [threading.Thread(target=self.extract_worker, name=f"x{i}", daemon=True) for i in range(self.extract_jobs)]
        threads.append(threading.Thread(target=self.reporter, name="reporter", daemon=True))
        for t in threads:
            t.start()
        idle_since = None
        try:
            while self.alive():
                time.sleep(2)
                H.consume_requeue_files(self.a.work_dir, self.state, self.inflight)
                self.fetch_missing()
                if self.has_work() or self.a.keep_running:
                    idle_since = None
                elif idle_since is None:
                    idle_since = time.time()
                elif time.time() - idle_since > 8:      # workers poll every 10 s; give them a moment to claim
                    log.info("re-analysis: queue done (nothing left on disk%s)",
                             "" if self.a.fetch_missing == "tornado" else "; videos that need a download wait for the harvester")
                    break
        except KeyboardInterrupt:
            pass
        self.stop.set()
        for t in threads:
            t.join()
        if self.fetch_proc is not None and self.fetch_proc.poll() is None and os.path.exists(os.path.join(self.a.work_dir, ABORT)):
            self.fetch_proc.terminate()
        self.state.x("UPDATE videos SET x_status='done' WHERE x_status='reworking'")
        self.state.x("UPDATE videos SET x_status=NULL WHERE x_status='working' AND " + H.REPROCESS)
        summary = self.report()
        summary["phase"] = "finished"
        atomic_json(os.path.join(self.a.work_dir, SUMMARY), summary)
        log.info("re-analysis: done · %d replaced, %d failed, %d interrupted", self.done["ok"], self.done["failed"],
                 self.done["interrupted"])
        return summary


# ---------------------------------------------------------------------------------------------- CLI
def parse(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["queue", "remove", "run", "status", "stop"])
    ap.add_argument("--work-dir", default=os.environ.get("YT_HARVEST_WORK", H.DEFAULT_WORK))
    ap.add_argument("--download-dir", default=os.environ.get("YT_HARVEST_DL", H.DEFAULT_DL))
    ap.add_argument("--ids", default="", help="queue/remove: ids or YouTube URLs, comma or newline separated ('-' = stdin)")
    ap.add_argument("--reason", default="code-fix", choices=sorted(RQ.REASONS))
    ap.add_argument("--scope", default="full", choices=RQ.SCOPES, help=argparse.SUPPRESS)
    ap.add_argument("--jobs", type=int, default=0, help="run: parallel analyses (default 2/3 of the cores)")
    ap.add_argument("--fetch-missing", default="none", choices=["none", "tornado"],
                    help="run: download queued videos that are not on disk through Tornado (requested downloads only)")
    ap.add_argument("--keep-running", action="store_true", help="run: wait for new requests instead of ending when done")
    ap.add_argument("--hours", type=float, default=48.0, help="run: stop after this long")
    ap.add_argument("--now", action="store_true", help="stop: end the current analyses at once (earlier results stay)")
    a = ap.parse_args(argv)
    if a.command == "run":
        h = H.parse(["overnight", "--work-dir", a.work_dir, "--download-dir", a.download_dir, "--hours", str(a.hours),
                     "--extract-jobs", str(a.jobs), "--registry", "", "--respect-stop"])
        h.fetch_missing, h.keep_running, h.command = a.fetch_missing, a.keep_running, "reanalyze"
        return a, h
    return a, None


class RunLock:
    """reanalyze.lock for the whole run (reanalysis_queue.reanalyzer_running), and reanalyze-run.json for the card."""
    def __init__(self, work_dir, info):
        self.work_dir, self.info, self.stream = work_dir, info, None

    def __enter__(self):
        os.makedirs(self.work_dir, exist_ok=True)
        self.stream = open(os.path.join(self.work_dir, RQ.LOCK_NAME), "a")
        try:
            fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.stream.close()
            raise SystemExit("A re-analysis is already running on this work directory.")
        me = next((r for r in process_table() if r["pid"] == os.getpid()), {})
        self.record = {"pid": os.getpid(), "identity": me.get("identity"), "phase": "running",
                       "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(), **self.info}
        atomic_json(os.path.join(self.work_dir, RUN), self.record)
        return self

    def __exit__(self, error_type, error, traceback):
        self.record.update(phase="failed" if error and error_type is not SystemExit else "finished",
                           endedAt=dt.datetime.now(dt.timezone.utc).isoformat())
        if error and error_type is not SystemExit:
            self.record["error"] = str(error)[:500]
        atomic_json(os.path.join(self.work_dir, RUN), self.record)
        fcntl.flock(self.stream, fcntl.LOCK_UN)
        self.stream.close()


def setup_logging(work_dir):
    """reanalyze.log, apart from the harvester's harvest.log (both share the 'harvest' logger's code paths)."""
    fmt = logging.Formatter("%(asctime)s %(threadName)s %(message)s", "%m-%d %H:%M:%S")
    fh = logging.FileHandler(os.path.join(work_dir, "reanalyze.log"))
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    sh.setLevel(logging.WARNING if os.environ.get("YT_HARVEST_QUIET") else logging.INFO)
    root = logging.getLogger()
    root.handlers[:] = [fh, sh]
    root.setLevel(logging.INFO)


def main(argv=None):
    a, h = parse(argv)
    if a.command in ("queue", "remove"):
        ids = sys.stdin.read() if a.ids == "-" else a.ids
        out = (RQ.queue(a.work_dir, ids, a.reason, a.scope, "cli") if a.command == "queue" else RQ.remove(a.work_dir, ids))
        print(json.dumps({k: v for k, v in out.items() if k != "ids"}))
        if out.get("unknown"):
            print("not in the harvest database:", ", ".join(out["ids"]["unknown"]), file=sys.stderr)
        return 0
    if a.command == "status":
        print(json.dumps({"queue": {k: v for k, v in RQ.snapshot(a.work_dir, 0).items() if k != "items"},
                          "run": read_json(os.path.join(a.work_dir, RUN), {}),
                          "summary": {k: v for k, v in read_json(os.path.join(a.work_dir, SUMMARY), {}).items()
                                      if k not in ("recent", "active")}}, indent=1))
        return 0
    if a.command == "stop":
        open(os.path.join(a.work_dir, ABORT if a.now else STOP), "a").close()
        if a.now:
            open(os.path.join(a.work_dir, STOP), "a").close()
        print("stop requested" + (" (now)" if a.now else " (after the current videos)"))
        return 0
    with RunLock(a.work_dir, {"jobs": a.jobs or H.default_extract_jobs(), "fetchMissing": a.fetch_missing}):
        for name in (STOP, ABORT):
            try:
                os.remove(os.path.join(a.work_dir, name))
            except FileNotFoundError:
                pass
        setup_logging(a.work_dir)
        r = Reanalyzer(h)
        signal.signal(signal.SIGTERM, lambda *_: r.stop.set())
        summary = r.run()
    print(json.dumps({"finished": summary["finished"], "queue": summary["queue"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
