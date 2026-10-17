#!/usr/bin/env python3
"""Download specifically requested YouTube videos through Tornado API (https://docs.tornadoapi.io).

Owner's rules (2026-10-15): use Tornado only for downloads the owner asked for (first: this week's
Little Cup videos), and never let the total downloaded through it pass 100 GB (raised from 20 GB on 2026-10-16: the free trial includes 100 GB). The running total is kept
in WORK/tornado-usage.json; a video is only requested while the total stays under the cap, and the run
stops as soon as a file would take it over.

Each finished file lands in the harvester's download directory as <id>.mp4 and its row in state.sqlite is
marked downloaded (dl_status 'done'), so the harvester's analysis workers pick it up like any download.
Rows being fetched are marked dl_status 'tornado' first, so the harvester never claims them meanwhile.

    python3 -I web/scripts/yt-harvest/tornado_fetch.py --focus-cup little --since 2026-10-13 [--dry-run]
    python3 -I web/scripts/yt-harvest/tornado_fetch.py --ids ID1,ID2

The key is read from ~/.config/gbl-synapse/env (TORNADO_API_KEY=...), never from the command line.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harvest as H  # noqa: E402

API = "https://api.tornadoapi.io"
CAP_BYTES = 100 * 10**9
ENV = os.path.expanduser("~/.config/gbl-synapse/env")
UA = "gbl-synapse-harvester/1.0 (+curl-compatible)"  # Python-urllib's default agent is refused (403)


def api_key():
    with open(ENV, encoding="utf-8") as f:
        for line in f:
            if line.startswith("TORNADO_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("TORNADO_API_KEY missing from " + ENV)


def call(method, path, key, body=None):
    req = urllib.request.Request(API + path, method=method, headers={"x-api-key": key, "Content-Type": "application/json", "User-Agent": UA},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def load_usage(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"capBytes": CAP_BYTES, "bytes": 0, "videos": {}}


def save_usage(path, usage):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(usage, f, indent=1)
    os.replace(tmp, path)


def fetch(url, dest):
    sha, size = hashlib.sha256(), 0
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=600) as r, open(dest + ".part", "wb") as out:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            sha.update(chunk)
            size += len(chunk)
    os.replace(dest + ".part", dest)
    return sha.hexdigest(), size


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", default=H.DEFAULT_WORK)
    ap.add_argument("--download-dir", default=H.DEFAULT_DL)
    ap.add_argument("--focus-cup")
    ap.add_argument("--since")
    ap.add_argument("--ids", default="")
    ap.add_argument("--max-resolution", default="1080")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not a.ids and not a.focus_cup:
        raise SystemExit("Name the requested videos: --focus-cup CUP (with --since) or --ids")
    db = sqlite3.connect(os.path.join(a.work_dir, "state.sqlite"), timeout=60)
    db.row_factory = sqlite3.Row
    if a.ids:
        ids = [i.strip() for i in a.ids.split(",") if i.strip()]
        rows = [r for i in ids for r in db.execute("SELECT id, title, dl_status FROM videos WHERE id=?", (i,))]
    else:
        with open(os.path.join(HERE, "data", "gbl-schedule.json"), encoding="utf-8") as f:
            schedule = json.load(f)
        expr, args = H.focus_sql(a.focus_cup, schedule, a.since)
        rows = list(db.execute("SELECT id, title, dl_status, rel_label FROM videos WHERE (dl_status IS NULL OR dl_status='tornado') "
                               "AND COALESCE(rel_label,'') != 'no' AND " + expr +
                               " ORDER BY COALESCE(upload_date, strftime('%Y%m%d', approx_ts, 'unixepoch'), '0') DESC", args))
    usage_path = os.path.join(a.work_dir, "tornado-usage.json")
    usage = load_usage(usage_path)
    print(f"{len(rows)} requested videos; {usage['bytes'] / 1e9:.2f} GB of {CAP_BYTES / 1e9:.0f} GB used so far")
    if a.dry_run:
        for r in rows:
            print("  ", r["id"], (r["title"] or "")[:80])
        return
    key = api_key()
    for r in rows:
        vid = r["id"]
        if usage["bytes"] >= CAP_BYTES:
            print("cap reached; stopping")
            break
        dest = os.path.join(a.download_dir, vid + ".mp4")
        db.execute("UPDATE videos SET dl_status='tornado' WHERE id=?", (vid,))
        db.commit()
        try:
            job = call("POST", "/jobs", key, {"url": f"https://www.youtube.com/watch?v={vid}", "format": "mp4",
                                              "max_resolution": a.max_resolution, "filename": vid})["job_id"]
            for _ in range(180):
                s = call("GET", f"/jobs/{job}", key)
                if str(s.get("status", "")).lower() in ("completed", "failed", "error") or s.get("error"):
                    break
                time.sleep(10)
            if str(s.get("status", "")).lower() != "completed" or not s.get("s3_url"):
                raise RuntimeError(s.get("error") or s.get("status") or "no file")
            sha, size = fetch(s["s3_url"], dest)
            if usage["bytes"] + size > CAP_BYTES:
                os.remove(dest)
                db.execute("UPDATE videos SET dl_status=NULL WHERE id=?", (vid,))
                db.commit()
                usage["bytes"] += size
                usage["videos"][vid] = {"bytes": size, "discarded": "over the 20 GB cap", "at": dt.datetime.now().isoformat()}
                save_usage(usage_path, usage)
                print(f"{vid}: {size / 1e9:.2f} GB would pass the cap; discarded and stopped")
                break
            usage["bytes"] += size
            usage["videos"][vid] = {"bytes": size, "sha256": sha, "at": dt.datetime.now().isoformat()}
            save_usage(usage_path, usage)
            db.execute("UPDATE videos SET dl_status='done', dl_path=?, sha256=?, size_bytes=?, dl_date=?, err=NULL WHERE id=?",
                       (dest, sha[:16], size, dt.date.today().isoformat(), vid))
            db.commit()
            print(f"{vid}: {size / 1e6:.0f} MB · total {usage['bytes'] / 1e9:.2f} GB · {(r['title'] or '')[:60]}", flush=True)
        except Exception as e:  # leave the row for the harvester and report
            db.execute("UPDATE videos SET dl_status=NULL WHERE id=? AND dl_status='tornado'", (vid,))
            db.commit()
            print(f"{vid}: failed ({str(e)[:160]})", flush=True)
    print(f"done; {usage['bytes'] / 1e9:.2f} GB used of {CAP_BYTES / 1e9:.0f} GB")


if __name__ == "__main__":
    main()
