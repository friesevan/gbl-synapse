#!/usr/bin/env python3
"""YouTube harvester for Pokémon GO battle videos (Meta Extractor benchmark / training data).

Pipeline (all stages run concurrently until the deadline):
  discover  date-sorted YouTube searches (templates x leagues/cups x seasons x languages), then the
            uploads of every channel that produced a battle video, then relevance-sorted searches.
            Flat extraction only (fast). Shorts/unrelated titles filtered by policy.relevance().
  enrich    full metadata per video (license, upload date, formats, chapters, tags...) with a
            bounded worker pool; league/cup guess from schedule + text (league.py).
  download  videos allowed by policy.download_allowed() (newest first, <=1080p H.264 video only),
            SHA-256 fingerprint, duplicates dropped, disk budget respected.
  extract   Meta Extractor batch runner (tests/meta-benchmark/run-batch.cjs) on downloaded videos,
            GAMEMASTER chosen by upload date; the video is deleted afterwards unless --keep.
State lives in SQLite in the work dir (outside git), so re-running resumes. registry.json (metadata
only) is rewritten periodically, sorted by id.

Usage: bash web/scripts/yt-harvest/overnight.sh [--hours 9] [options]    (see --help)
"""
import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import random
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import league as L  # noqa: E402
import policy as P  # noqa: E402
import validate as V  # noqa: E402
import ytapi  # noqa: E402

WEB = os.path.normpath(os.path.join(HERE, "..", ".."))
REGISTRY = os.path.join(WEB, "tests", "meta-benchmark", "sources", "registry.json")
RUN_NODE = os.path.join(WEB, "tests", "meta-benchmark", "run-node.cjs")
EXPORT_Q = os.path.join(WEB, "tests", "meta-benchmark", "export-questions.cjs")
LEARNED = os.path.join(WEB, "tests", "meta-benchmark", "learned.json")
# The Validate tab (familyRanks.html, served by run_app.py) loads this file when it exists. Git ignores
# **/results/, so harvested questions never reach the repo.
INBOX = os.path.join(WEB, "tests", "meta-benchmark", "results", "validation-inbox.json")
HOME = os.path.expanduser("~")
DEFAULT_DL = os.path.join(HOME, "Desktop", "Projects", "PoGo Recorder", "src", "youtube")
DEFAULT_WORK = os.path.join(HOME, "Desktop", "Projects", "PoGo Recorder", "src", "yt-harvest")
GM_CACHE = os.path.join(HOME, ".cache", "gbl-synapse", "gamemaster")
FORMAT = "bv*[vcodec^=avc1][height<=1080][ext=mp4]/bv*[vcodec^=avc1][height<=1080]/bv*[height<=1080][ext=mp4]"
log = logging.getLogger("harvest")
SKIPPED = object()   # download_one: full metadata said "don't download"
# Download queue: approved videos, plus videos whose title already looks like a battle video (their
# metadata arrives with the download request). Newest first, by upload date or approximate date.
DL_CLAIM = ("SELECT id, meta, meta_status, title, channel_id, duration FROM videos WHERE dl_status IS NULL AND attempts<3 "
            "AND (allowed=1 OR (meta_status='todo' AND rel_label='relevant')) "
            "ORDER BY COALESCE(upload_date, strftime('%Y%m%d', approx_ts, 'unixepoch'), '0') DESC, rel_score DESC LIMIT 32")

# ------------------------------------------------------------------------------------- queries

LEAGUES_EN = ["great league", "ultra league", "master league", "little cup", "great league remix",
              "ultra league premier", "master league premier", "premier cup", "mega master league"]
TEMPLATES = ["pokemon go {}", "{} pokemon go", "go battle league {}", "gbl {}", "{} pvp pokemon go",
             "{} team pokemon go", "{} legend pokemon go", "{} gbl battles"]
GENERIC = ["pokemon go pvp", "go battle league", "gbl pokemon go", "pokemon go battle league legend",
           "pokemon go pvp battles", "pokemon go ranked battles", "gbl road to legend", "pvpoke team gbl",
           "pokemon go pvp set", "gbl highlights", "pokemon go pvp tournament", "play pokemon go championship",
           "pokemon go pvp compilation", "gbl best team", "pokemon go elo 3000", "gbl veteran rank",
           "pokemon go regional championship pvp", "pokemon go world championship go"]
FOREIGN = ["liga super ball pokemon go", "liga ultra ball pokemon go", "liga master ball pokemon go",
           "liga super pokemon go", "liga ultra pokemon go", "liga master pokemon go", "batallas pvp pokemon go",
           "liga de combates go", "combates gbl", "pokemon go pvp batalhas", "liga grande pokemon go",
           "liga de batalha go", "ligue super pokemon go", "ligue hyper pokemon go", "ligue master pokemon go",
           "combats pvp pokemon go", "ligue de combat go", "superliga pokemon go", "hyperliga pokemon go",
           "meisterliga pokemon go", "kampfliga pokemon go", "lega mega pokemon go", "lega ultra pokemon go",
           "lega master pokemon go", "ポケモンGO スーパーリーグ", "ポケモンGO ハイパーリーグ",
           "ポケモンGO マスターリーグ", "GOバトルリーグ", "GBL シーズン", "ポケモンGO リトルカップ",
           "ポケモンGO 対戦", "포켓몬고 슈퍼리그", "포켓몬고 하이퍼리그", "포켓몬고 마스터리그", "포켓몬고 배틀리그",
           "寶可夢GO 超級聯盟", "宝可梦GO 对战", "pokemon go liga super indonesia", "pokemon go pvp thai"]


def build_queries(schedule, now_year=None):
    """Ordered, de-duplicated query list: most productive first."""
    now_year = now_year or dt.date.today().year
    q = list(GENERIC)
    for lg in LEAGUES_EN:
        q += [t.format(lg) for t in TEMPLATES]
    q += FOREIGN
    cups = schedule.get("cups", {})
    names = sorted({c.get("name", "") for k, c in cups.items() if k not in L.BASE and c.get("name")})
    for n in names:
        n = re.sub(r"\s*\(.*?\)", "", n).strip()
        q += [f"{n} pokemon go", f"{n} gbl"]
    seasons = [s.get("season") for s in schedule.get("seasons", []) if isinstance(s.get("season"), int)]
    for n in sorted(set(seasons or range(1, 26)), reverse=True):
        q += [f"gbl season {n}", f"go battle league season {n}"]
    for y in range(now_year, 2019, -1):
        q += [f"great league {y} pokemon go", f"ultra league {y} pokemon go", f"master league {y} pokemon go",
              f"gbl {y}"]
    seen, out = set(), []
    for s in q:
        k = s.lower().strip()
        if k and k not in seen:
            seen.add(k)
            out.append(s)
    return out


def search_url(query, by_date):
    u = "https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(query)
    return u + "&sp=CAI%253D" if by_date else u     # CAI= : sort by upload date

# ------------------------------------------------------------------------------------- state


class State:
    SCHEMA = """
    CREATE TABLE IF NOT EXISTS videos(
      id TEXT PRIMARY KEY, title TEXT, channel_id TEXT, channel TEXT, channel_url TEXT,
      duration REAL, approx_ts INTEGER, views INTEGER, source TEXT, discovered REAL,
      rel_score REAL, rel_label TEXT,
      meta_status TEXT DEFAULT 'todo', meta TEXT, upload_date TEXT, license TEXT, cc INTEGER,
      league TEXT, allowed INTEGER, allow_reason TEXT,
      dl_status TEXT, dl_path TEXT, sha256 TEXT, size_bytes INTEGER, dl_date TEXT,
      x_status TEXT, x_date TEXT, deleted_date TEXT, attempts INTEGER DEFAULT 0, err TEXT, updated REAL);
    CREATE INDEX IF NOT EXISTS v_meta ON videos(meta_status, approx_ts);
    CREATE INDEX IF NOT EXISTS v_dl ON videos(allowed, dl_status, upload_date);
    CREATE INDEX IF NOT EXISTS v_sha ON videos(sha256);
    CREATE TABLE IF NOT EXISTS queries(q TEXT, mode TEXT, done REAL, n INTEGER, PRIMARY KEY(q, mode));
    CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, url TEXT, name TEXT, hits INTEGER DEFAULT 0,
      crawled REAL, n INTEGER);
    """

    def __init__(self, path):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=60)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(self.SCHEMA)
        # Interrupted work goes back to the queue.
        self.x("UPDATE videos SET meta_status='todo' WHERE meta_status='working'")
        self.x("UPDATE videos SET dl_status=NULL WHERE dl_status='working'")
        self.x("UPDATE videos SET x_status=NULL WHERE x_status='working'")

    def q(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def x(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur.rowcount

    def add_flat(self, e, source, rel_score, rel_label):
        """Insert a flat search/channel entry; returns True if new."""
        with self.lock:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO videos(id,title,channel_id,channel,channel_url,duration,approx_ts,views,source,"
                "discovered,rel_score,rel_label,meta_status,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (e["id"], e.get("title"), e.get("channel_id"), e.get("channel") or e.get("uploader"),
                 e.get("channel_url"), e.get("duration"), e.get("timestamp"), e.get("view_count"), source,
                 time.time(), rel_score, rel_label, "todo" if rel_label != "no" else "skip", time.time()))
            self.db.commit()
            return cur.rowcount == 1

    def channel_hit(self, cid, url, name):
        if not cid:
            return
        self.x("INSERT INTO channels(id,url,name,hits) VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET hits=hits+1",
               (cid, url or f"https://www.youtube.com/channel/{cid}", name))

    def channel_hits(self, cid):
        r = self.q("SELECT hits FROM channels WHERE id=?", (cid,))
        return r[0]["hits"] if r else 0

# ------------------------------------------------------------------------------------- politeness


RATE_RE = re.compile(r"429|too many requests|not a bot|sign in to confirm(?! your age)|rate.?limit|unusual traffic|"
                     r"captcha", re.I)
GONE_RE = re.compile(r"private video|video unavailable|has been removed|terminated|members.only|join this channel|"
                     r"confirm your age|age.restricted|inappropriate|copyright|not available in your country|"
                     r"live event will begin|premieres in|this live event|is not available|does not exist", re.I)


def classify_error(msg):
    msg = str(msg or "")
    if RATE_RE.search(msg):
        return "ratelimit"
    if GONE_RE.search(msg):
        return "unavailable"
    return "transient"


class Backoff:
    """Shared pause for all workers after a 429 / bot check: 2 min doubling to 1 h. Several workers
    failing at the same moment count as ONE event (no escalation while already paused)."""

    def __init__(self, base=120, cap=3600):
        self.base, self.cap, self.k, self.until = base, cap, 0, 0.0
        self.lock = threading.Lock()
        self.events = 0
        self.last_ok = time.time()

    def hit(self):
        with self.lock:
            now = time.time()
            if now < self.until:
                return self.until - now
            delay = min(self.cap, self.base * 2 ** self.k) * random.uniform(0.9, 1.1)
            self.until = now + delay
            self.k = min(self.k + 1, 10)
            self.events += 1
            return delay

    def ok(self):
        with self.lock:
            now = time.time()
            if self.k and now > self.until + 1200 and now - self.last_ok > 1200:
                self.k -= 1          # 20 clean minutes undo one doubling
                self.last_ok = now

    def wait(self, stop):
        while not stop.is_set():
            left = self.until - time.time()
            if left <= 0:
                return
            stop.wait(min(left, 30))

class Limiter:
    """Global request-rate cap shared by threads (requests/min). Halves after each rate-limit event
    and creeps back up by 10% every 10 clean minutes (AIMD), so a long run settles at a rate
    YouTube tolerates instead of hammering it."""

    def __init__(self, per_min, floor=3):
        self.max, self.rate, self.floor = per_min, per_min, floor
        self.next = 0.0
        self.lock = threading.Lock()
        self.last_change = time.time()

    def acquire(self, stop):
        with self.lock:
            now = time.time()
            if now - self.last_change > 600 and self.rate < self.max:
                self.rate = min(self.max, self.rate * 1.1 + 0.5)
                self.last_change = now
            slot = max(now, self.next)
            self.next = slot + 60.0 / self.rate
        if slot > now:
            stop.wait(slot - now)

    def slow_down(self):
        with self.lock:
            self.rate = max(self.floor, self.rate / 2)
            self.last_change = time.time()
            return self.rate

# ------------------------------------------------------------------------------------- harvester


class Harvester:
    def __init__(self, a):
        self.a = a
        os.makedirs(a.work_dir, exist_ok=True)
        os.makedirs(a.download_dir, exist_ok=True)
        os.makedirs(os.path.join(a.work_dir, "results"), exist_ok=True)
        self.state = State(os.path.join(a.work_dir, "state.sqlite"))
        self.schedule = L.load_schedule()
        self.stop = threading.Event()
        self.disc_stop = threading.Event()
        self.backoff = Backoff()
        self.meta_rate = Limiter(a.meta_per_min)
        self.dl_rate = Limiter(a.downloads_per_min, floor=0.5)
        self.deadline = time.time() + a.hours * 3600
        self.t0 = time.time()
        self.c = {"flat": 0, "flatNew": 0, "enriched": 0, "enrichErr": 0, "downloaded": 0, "dlBytes": 0,
                  "dlSeconds": 0.0, "dups": 0, "extracted": 0, "extractFailed": 0, "deleted": 0, "queries": 0,
                  "channels": 0, "rateLimits": 0, "apiMeta": 0}
        self.clock = threading.Lock()
        self.inflight = set()
        self.dl_active = 0
        self.registry = self._load_registry()
        self.reg_sha = {e.get("sha256"): e["id"] for e in self.registry.values() if e.get("sha256")}
        gm = L.load_gamemaster()
        names = sorted({p["speciesName"].lower() for p in gm.values() if len(p["speciesName"]) >= 5}, key=len, reverse=True)
        self.species_re = re.compile(r"(?<!\w)(" + "|".join(re.escape(n) for n in names) + r")(?!\w)", re.I)
        self.queries = build_queries(self.schedule)[: a.max_queries or None]
        self.ytdlp = None
        self.api_key = None if a.no_api else ytapi.api_key()
        self.api_off_until = 0.0

    # ---- helpers
    def inc(self, k, n=1):
        with self.clock:
            self.c[k] += n

    def alive(self):
        return not self.stop.is_set() and time.time() < self.deadline and not os.path.exists(self.stop_file)

    @property
    def stop_file(self):
        return os.path.join(self.a.work_dir, "STOP")

    def _load_registry(self):
        if not self.a.registry or not os.path.exists(self.a.registry):
            return {}
        with open(self.a.registry, encoding="utf-8") as f:
            return {e["id"]: e for e in json.load(f)}

    def ydl(self, extra=None):
        import yt_dlp
        o = {"quiet": True, "no_warnings": True, "skip_download": True, "noprogress": True,
             "socket_timeout": 30, "retries": 3, "extractor_retries": 2, "noplaylist": True}
        # YouTube's JS challenge needs a runtime; without one downloads are throttled (~0.4 MB/s)
        # or refused. overnight.sh installs deno into the venv (pip package "deno").
        deno = os.path.join(sys.prefix, "bin", "deno")
        deno = deno if os.path.exists(deno) else shutil.which("deno")
        if deno:
            o["js_runtimes"] = {"deno": {"path": deno}}
        elif shutil.which("node"):
            o["js_runtimes"] = {"node": {"path": shutil.which("node")}}
        o["logger"] = _YtLogger()
        ff = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
        if os.path.exists(ff):
            o["ffmpeg_location"] = ff
        o.update(extra or {})
        return yt_dlp.YoutubeDL(o)

    def _yt_call(self, fn, what, limiter=None):
        """Run fn() with polite backoff. Returns (result, error_kind)."""
        for attempt in range(6):
            self.backoff.wait(self.stop)
            if limiter:
                limiter.acquire(self.stop)
            if not self.alive():
                return None, "stopped"
            try:
                r = fn()
                self.backoff.ok()
                return r, None
            except Exception as ex:  # yt_dlp.utils.DownloadError and network errors
                kind = classify_error(ex)
                if kind == "ratelimit":
                    fresh = time.time() >= self.backoff.until
                    d = self.backoff.hit()
                    self.inc("rateLimits")
                    if fresh:
                        r1, r2 = self.meta_rate.slow_down(), self.dl_rate.slow_down()
                        log.warning("rate limited (%s: %s); all workers pause %.0f s; metadata now %.0f/min, "
                                    "downloads %.1f/min", what, str(ex)[:80], d, r1, r2)
                    continue
                return None, f"{kind}: {str(ex)[:300]}"
        return None, "ratelimit: gave up for now"

    def relevance_of(self, title, duration, tags=(), desc="", cats=(), cid=None):
        hits = self.state.channel_hits(cid) if cid else 0
        sp = bool(self.species_re.search(title or ""))
        return P.relevance(title, duration, tags, desc, cats, channel_battle_hits=hits, species_hit=sp)

    # ---- discovery
    def _iter_flat(self, url, limit):
        def run():
            with self.ydl({"extract_flat": "in_playlist", "playlistend": limit,
                           "sleep_interval_requests": self.a.pace * self.meta_rate.max / self.meta_rate.rate,
                           "extractor_args": {"youtubetab": {"approximate_date": [""]}}}) as y:
                info = y.extract_info(url, download=False)
                return list(info.get("entries") or [])
        r, err = self._yt_call(run, url)
        if err:
            log.info("flat %s: %s", url[:90], err[:160])
        return r or []

    def _ingest(self, entries, source, channel=None):
        new = 0
        for e in entries:
            if not e or not e.get("id") or e.get("ie_key") not in (None, "Youtube"):
                continue
            if e.get("live_status") in ("is_upcoming",):
                continue
            if channel:
                e.setdefault("channel_id", channel["id"])
                e.setdefault("channel_url", channel["url"])
                e.setdefault("channel", channel["name"])
            score, label = self.relevance_of(e.get("title"), e.get("duration"), cid=e.get("channel_id"))
            self.inc("flat")
            if self.state.add_flat(e, source, score, label):
                new += 1
                self.inc("flatNew")
                if label == "relevant" and source.startswith("search"):
                    self.state.channel_hit(e.get("channel_id"), e.get("channel_url"), e.get("channel"))
        return new

    def discover_search(self):
        modes = [("date", True, self.a.search_limit, 12 * 3600), ("relevance", False, self.a.search_limit * 2, 7 * 86400)]
        for mode, by_date, limit, stale in modes:
            for q in self.queries:
                if not self.alive() or self.disc_stop.is_set():
                    return
                r = self.state.q("SELECT done FROM queries WHERE q=? AND mode=?", (q, mode))
                if r and r[0]["done"] and time.time() - r[0]["done"] < stale:
                    continue
                es = self._iter_flat(search_url(q, by_date), limit)
                n = self._ingest(es, f"search-{mode}")
                self.state.x("INSERT OR REPLACE INTO queries(q,mode,done,n) VALUES(?,?,?,?)", (q, mode, time.time(), len(es)))
                self.inc("queries")
                log.info("search[%s] %r: %d results, %d new", mode, q, len(es), n)
                self.stop.wait(self.a.pace)
        log.info("search discovery: all queries done")

    def discover_channels(self):
        idle = 0
        while self.alive() and not self.disc_stop.is_set():
            r = self.state.q("SELECT * FROM channels WHERE crawled IS NULL OR crawled < ? ORDER BY hits DESC LIMIT 1",
                             (time.time() - 24 * 3600,))
            if not r:
                idle += 1
                self.stop.wait(min(60, 5 * idle))
                continue
            idle = 0
            ch = dict(r[0])
            url = (ch["url"] or f"https://www.youtube.com/channel/{ch['id']}").rstrip("/") + "/videos"
            es = self._iter_flat(url, self.a.channel_limit)
            n = self._ingest(es, "channel", channel=ch)
            self.state.x("UPDATE channels SET crawled=?, n=? WHERE id=?", (time.time(), len(es), ch["id"]))
            self.inc("channels")
            log.info("channel %s (%d hits): %d videos, %d new", ch["name"], ch["hits"], len(es), n)
            self.stop.wait(self.a.pace)

    # ---- enrichment
    def _claim(self, sql, args, status_col, working):
        with self.state.lock:
            r = self.state.q(sql, args)
            for row in r:
                if row["id"] not in self.inflight:
                    self.inflight.add(row["id"])
                    self.state.x(f"UPDATE videos SET {status_col}=? WHERE id=?", (working, row["id"]))
                    return dict(row)
        return None

    def _release(self, vid):
        with self.state.lock:
            self.inflight.discard(vid)

    def enrich_worker(self):
        while self.alive():
            if self.api_key and time.time() >= self.api_off_until:
                if self.enrich_api_batch():
                    continue
                self.stop.wait(5)
                continue
            if self.api_key and not self.a.web_meta_when_quota_out:
                self.stop.wait(60)   # API quota used up: keep web requests for downloads
                continue
            row = self._claim("SELECT id FROM videos WHERE meta_status='todo' AND attempts<3 "
                              "ORDER BY COALESCE(approx_ts,0) DESC, rel_score DESC LIMIT 32", (), "meta_status", "working")
            if not row:
                self.stop.wait(5)
                continue
            try:
                self.enrich_one(row["id"])
            finally:
                self._release(row["id"])

    def enrich_api_batch(self):
        """Data API: metadata for up to 50 videos in one request. Returns True if work was done."""
        with self.state.lock:
            rows = self.state.q("SELECT id FROM videos WHERE meta_status='todo' AND attempts<3 "
                                "ORDER BY COALESCE(approx_ts,0) DESC, rel_score DESC LIMIT 200")
            ids = [r["id"] for r in rows if r["id"] not in self.inflight][:50]
            for vid in ids:
                self.inflight.add(vid)
                self.state.x("UPDATE videos SET meta_status='working' WHERE id=?", (vid,))
        if not ids:
            return False
        try:
            items = ytapi.fetch(ids, self.api_key)
        except ytapi.QuotaExceeded:
            # Quota resets at midnight Pacific; check again in an hour.
            self.api_off_until = time.time() + 3600
            log.warning("YouTube Data API quota used up; metadata pauses for an hour (downloads continue)")
            items = None
        except Exception as ex:
            log.warning("YouTube Data API: %s", str(ex)[:200])
            self.api_off_until = time.time() + 300
            items = None
        try:
            for vid in ids:
                if items is None:
                    self.state.x("UPDATE videos SET meta_status='todo' WHERE id=?", (vid,))
                elif vid in items:
                    self.apply_meta(vid, ytapi.to_meta(items[vid], P.is_cc))
                    self.inc("apiMeta")
                else:
                    self.state.x("UPDATE videos SET meta_status='unavailable', err='not returned by Data API', "
                                 "updated=? WHERE id=?", (time.time(), vid))
        finally:
            for vid in ids:
                self._release(vid)
        return items is not None

    def enrich_one(self, vid):
        def run():
            with self.ydl() as y:
                return y.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
        info, err = self._yt_call(run, vid, self.meta_rate)
        if err:
            self._meta_error(vid, err)
            return
        self.apply_meta(vid, extract_meta(info))

    def _meta_error(self, vid, err):
        if err == "stopped" or err.startswith("ratelimit"):
            self.state.x("UPDATE videos SET meta_status='todo' WHERE id=?", (vid,))
            return
        gone = err.startswith("unavailable")
        self.state.x("UPDATE videos SET meta_status=?, attempts=attempts+1, err=?, updated=? WHERE id=?",
                     ("unavailable" if gone else "todo", err, time.time(), vid))
        self.inc("enrichErr")

    def apply_meta(self, vid, meta):
        """Store full metadata, relevance, league guess and the download decision. Returns allowed."""
        rel_score, rel_label = self.relevance_of(meta["title"], meta["durationS"], meta["tags"], meta["description"],
                                                 meta["categories"], meta["channelId"])
        meta["relevanceLabel"], meta["relevance"] = rel_label, rel_score
        lg = L.guess_league(meta, self.schedule)
        prior = self.registry.get(vid, {})
        meta["permission"] = prior.get("permission") or ("CC license (reuse allowed with attribution)" if meta["creativeCommons"] else "not requested")
        ok, why = P.download_allowed(meta, cc_only=self.a.cc_only, max_duration_s=self.a.max_duration_min * 60)
        if rel_label == "relevant":
            self.state.channel_hit(meta["channelId"], meta["channelUrl"], meta["channel"])
        self.state.x("UPDATE videos SET meta_status='done', meta=?, upload_date=?, license=?, cc=?, league=?, allowed=?, "
                     "allow_reason=?, rel_score=?, rel_label=?, title=?, channel_id=?, channel=?, channel_url=?, duration=?, "
                     "views=?, err=NULL, updated=? WHERE id=?",
                     (json.dumps(meta, ensure_ascii=False), meta["uploadDate"], meta["license"], int(meta["creativeCommons"]),
                      json.dumps(lg, ensure_ascii=False), int(ok), why, rel_score, rel_label, meta["title"], meta["channelId"],
                      meta["channel"], meta["channelUrl"], meta["durationS"], meta["views"], time.time(), vid))
        self.inc("enriched")
        return ok

    # ---- download
    def used_bytes(self):
        r = self.state.q("SELECT COALESCE(SUM(size_bytes),0) s FROM videos WHERE dl_status='done' AND deleted_date IS NULL")
        return r[0]["s"]

    def disk_ok(self, est):
        free = shutil.disk_usage(self.a.download_dir).free
        return (self.used_bytes() + est <= self.a.disk_budget_gb * 1e9) and (free - est >= self.a.min_free_gb * 1e9)

    def download_worker(self):
        while self.alive():
            with self.clock:   # reserve a slot so parallel workers can't overshoot --max-downloads
                if self.a.max_downloads is not None and self.c["downloaded"] + self.dl_active >= self.a.max_downloads:
                    if self.c["downloaded"] >= self.a.max_downloads:
                        return
                    wait = True
                else:
                    self.dl_active += 1
                    wait = False
            if wait:
                self.stop.wait(5)
                continue
            try:
                row = self._claim(DL_CLAIM, (), "dl_status", "working")
                if not row:
                    self.stop.wait(10)
                    continue
                try:
                    self.download_one(row)
                finally:
                    self._release(row["id"])
            finally:
                with self.clock:
                    self.dl_active -= 1

    def download_one(self, row):
        vid, meta = row["id"], json.loads(row.get("meta") or "{}")
        prior = self.registry.get(vid, {})
        if prior.get("status") in ("downloaded", "processed", "deleted") or prior.get("sha256"):
            self.state.x("UPDATE videos SET dl_status='prior', sha256=? WHERE id=?", (prior.get("sha256"), vid))
            return
        # Near-duplicate re-upload: same channel, same normalised title, duration within 2 s.
        norm = re.sub(r"\W+", " ", (row["title"] or "").lower()).strip()
        for o in self.state.q("SELECT id, title FROM videos WHERE channel_id=? AND id<>? AND dl_status IN ('done','prior') "
                              "AND ABS(duration-?)<=2", (row["channel_id"], vid, row["duration"] or -99)):
            if re.sub(r"\W+", " ", (o["title"] or "").lower()).strip() == norm:
                self.state.x("UPDATE videos SET dl_status='dup', err=? WHERE id=?", (f"re-upload of {o['id']}", vid))
                self.inc("dups")
                return
        est = meta.get("estBytes") or int((row["duration"] or 900) * 300_000)
        while not self.disk_ok(est):
            if not self.alive():
                self.state.x("UPDATE videos SET dl_status=NULL WHERE id=?", (vid,))
                return
            log.info("disk budget reached (%.1f GB in use); waiting for processing to free space", self.used_bytes() / 1e9)
            self.stop.wait(60)
        t = time.time()
        need_meta = row.get("meta_status") != "done"

        def run():
            # One player request per video: when metadata is still missing, the same extraction
            # supplies it, the download decision is made, and the resolved formats are downloaded.
            with self.ydl({"skip_download": False, "format": FORMAT,
                           "outtmpl": os.path.join(self.a.download_dir, "%(id)s.%(ext)s"),
                           "continuedl": True, "fragment_retries": 10, "concurrent_fragment_downloads": 4}) as y:
                info = y.extract_info(f"https://www.youtube.com/watch?v={vid}", download=not need_meta)
                if need_meta:
                    if not self.apply_meta(vid, extract_meta(info)):
                        return SKIPPED
                    info = y.process_ie_result(info, download=True)
                return info.get("requested_downloads", [{}])[0].get("filepath") or y.prepare_filename(info)
        path, err = self._yt_call(run, f"download {vid}", self.dl_rate)
        if path is SKIPPED:
            self.state.x("UPDATE videos SET dl_status='skip' WHERE id=?", (vid,))
            return
        if err and need_meta and not (err == "stopped" or err.startswith("ratelimit")):
            self._meta_error(vid, err)
        if err or not path or not os.path.exists(path):
            if err == "stopped" or (err or "").startswith("ratelimit"):
                self.state.x("UPDATE videos SET dl_status=NULL WHERE id=?", (vid,))
                return
            self.state.x("UPDATE videos SET dl_status=?, attempts=attempts+1, err=? WHERE id=?",
                         ("error" if (err or "").startswith("unavailable") else None, err or "no file", vid))
            log.warning("download %s failed: %s", vid, (err or "no file")[:200])
            return
        size, secs = os.path.getsize(path), time.time() - t
        sha = sha256_prefix(path)
        dup = self.reg_sha.get(sha) or next((r["id"] for r in self.state.q(
            "SELECT id FROM videos WHERE sha256=? AND id<>?", (sha, vid))), None)
        if dup:
            os.remove(path)
            self.state.x("UPDATE videos SET dl_status='dup', sha256=?, err=? WHERE id=?", (sha, f"same file as {dup}", vid))
            self.inc("dups")
            return
        self.state.x("UPDATE videos SET dl_status='done', dl_path=?, sha256=?, size_bytes=?, dl_date=? WHERE id=?",
                     (path, sha, size, dt.date.today().isoformat(), vid))
        self.inc("downloaded")
        self.inc("dlBytes", size)
        self.inc("dlSeconds", secs)
        log.info("downloaded %s (%.0f MB in %.0f s, %.1f MB/s)", vid, size / 1e6, secs, size / 1e6 / max(secs, 0.1))

    # ---- extraction (Meta Extractor, one process per video)
    # A pool of workers, each running run-node.cjs on one video at a time: a finished worker takes the
    # next video at once, so a long video never holds up the others (run-batch.cjs waits for a whole
    # batch). Measured alone, one worker analyses 5-8x real time using about two cores.
    def extract_worker(self):
        while self.alive():
            row = self._claim("SELECT id, dl_path, upload_date, league, duration, meta FROM videos WHERE dl_status='done' "
                              "AND x_status IS NULL AND deleted_date IS NULL ORDER BY upload_date DESC LIMIT 16",
                              (), "x_status", "working")
            if not row:
                self.stop.wait(10)
                continue
            try:
                self.extract_one(row)
            finally:
                self._release(row["id"])

    def extract_one(self, r):
        vid, path = r["id"], r["dl_path"]
        if not path or not os.path.exists(path):
            self.state.x("UPDATE videos SET x_status='failed', err='file missing' WHERE id=?", (vid,))
            return
        out_dir = os.path.join(self.a.work_dir, "results")
        res = os.path.join(out_dir, f"{vid}.json")
        lg = json.loads(r["league"] or "{}")
        cp = (L.get_format(lg.get("leagueId") or "", self.schedule["cups"])[1] or {}).get("cp", 1500)
        gm = gamemaster_for(r["upload_date"]) or ""
        env = {**os.environ, "LEAGUE": str(cp if cp in (500, 1500, 2500, 10000) else 1500), "GAMEMASTER": gm, "CROP": "auto"}
        ok = os.path.exists(res)
        if not ok:
            timeout = max(900, (r["duration"] or 900) * 2 + 600)
            t = time.time()
            with open(os.path.join(self.a.work_dir, "extract.log"), "a") as lf:
                lf.write(f"--- {vid} ({(r['duration'] or 0) / 60:.0f} min)\n")
                lf.flush()
                p = subprocess.Popen(["node", RUN_NODE, path, res + ".tmp"], stdout=lf, stderr=subprocess.STDOUT, env=env)
                while p.poll() is None:
                    if not self.alive() or time.time() - t > timeout:
                        p.terminate()
                        try:
                            p.wait(30)
                        except subprocess.TimeoutExpired:
                            p.kill()
                        break
                    time.sleep(2)
            if p.returncode is None or (p.returncode != 0 and not self.alive()):
                self.state.x("UPDATE videos SET x_status=NULL WHERE id=?", (vid,))   # interrupted: retry next run
                return
            ok = p.returncode == 0 and os.path.exists(res + ".tmp")
            if ok:
                os.replace(res + ".tmp", res)
                log.info("extract %s: %.0f min of video in %.0f s", vid, (r["duration"] or 0) / 60, time.time() - t)
        if ok:
            try:
                refined = write_league_refinement(res, lg, self.schedule, r["upload_date"])
            except Exception as ex:  # refinement is best-effort
                log.info("league refinement %s: %s", vid, ex)
                refined = None
            try:
                n = self.export_validation(vid, res, path, gm, json.loads(r["meta"] or "{}"), lg, refined)
                log.info("validate %s: %d questions", vid, n)
            except Exception as ex:
                log.warning("validation export %s failed: %s", vid, str(ex)[:300])
        self.state.x("UPDATE videos SET x_status=?, x_date=? WHERE id=?",
                     ("done" if ok else "failed", dt.date.today().isoformat(), vid))
        self.inc("extracted" if ok else "extractFailed")
        if not self.a.keep:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            self.state.x("UPDATE videos SET deleted_date=? WHERE id=?", (dt.date.today().isoformat(), vid))
            self.inc("deleted")

    # ---- validation questions (site: Meta Extractor > Validate)
    def export_validation(self, vid, res, path, gm, meta, video_league, refined):
        """Writes this video's open questions to work/validation/<id>/ and rebuilds the inbox the Validate
        tab loads. Extractor questions come from export-questions.cjs (no frames: the reviewer watches the
        moment on YouTube or in a local copy); harvester questions cover league/cup and missed footage."""
        qdir = os.path.join(self.a.work_dir, "validation", vid)
        os.makedirs(qdir, exist_ok=True)
        env = {**os.environ, "NO_FRAMES": "1", "GAMEMASTER": gm}
        subprocess.run(["node", EXPORT_Q, res, path, qdir] + ([LEARNED] if os.path.exists(LEARNED) else []),
                       env=env, check=True, capture_output=True, timeout=600)
        with open(res, encoding="utf-8") as f:
            result = json.load(f)
        extra = V.harvest_questions(vid, result, meta, video_league, refined, self.schedule)
        video = V.video_ref(vid, meta)
        n = 0
        for name in os.listdir(qdir):
            if not name.endswith(".json") or name == "manifest.json":
                continue
            fp = os.path.join(qdir, name)
            with open(fp, encoding="utf-8") as f:
                doc = json.load(f)
            V.decorate(doc, video)
            with open(fp, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False)
            n += 1
        for doc in extra:
            V.decorate(doc, video)
            with open(os.path.join(qdir, doc["qid"] + ".json"), "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False)
            n += 1
        V.write_inbox(os.path.join(self.a.work_dir, "validation"), self.a.inbox)
        return n

    # ---- reporting
    def summary(self):
        s = self.state
        el = max(1.0, time.time() - self.t0)
        by_league, by_year, cc = {}, {}, {"cc": 0, "notCC": 0}
        for r in s.q("SELECT league, upload_date, cc FROM videos WHERE meta_status='done' AND rel_label='relevant'"):
            lg = json.loads(r["league"] or "{}").get("leagueGuess", "Unknown")
            by_league[lg] = by_league.get(lg, 0) + 1
            y = (r["upload_date"] or "????")[:4]
            by_year[y] = by_year.get(y, 0) + 1
            cc["cc" if r["cc"] else "notCC"] += 1
        tot = lambda sql: s.q(sql)[0][0]  # noqa: E731
        with self.clock:
            c = dict(self.c)
        return {
            "updated": dt.datetime.now().isoformat(timespec="seconds"),
            "elapsedMin": round(el / 60, 1),
            "thisRun": c,
            "ratesPerMin": {"flatSeen": round(c["flat"] / el * 60, 1), "newVideos": round(c["flatNew"] / el * 60, 1),
                            "metadata": round(c["enriched"] / el * 60, 1)},
            "downloadMBps": round(c["dlBytes"] / 1e6 / max(c["dlSeconds"], 0.1), 1),
            "downloadedGB": round(c["dlBytes"] / 1e9, 2),
            "total": {"videos": tot("SELECT COUNT(*) FROM videos"),
                      "plausible": tot("SELECT COUNT(*) FROM videos WHERE rel_label<>'no'"),
                      "enriched": tot("SELECT COUNT(*) FROM videos WHERE meta_status='done'"),
                      "relevant": sum(by_league.values()),
                      "allowed": tot("SELECT COUNT(*) FROM videos WHERE allowed=1"),
                      "downloaded": tot("SELECT COUNT(*) FROM videos WHERE dl_status='done'"),
                      "processed": tot("SELECT COUNT(*) FROM videos WHERE x_status='done'"),
                      "onDiskGB": round(self.used_bytes() / 1e9, 2),
                      "channels": tot("SELECT COUNT(*) FROM channels"),
                      "channelsCrawled": tot("SELECT COUNT(*) FROM channels WHERE crawled IS NOT NULL"),
                      "queriesDone": tot("SELECT COUNT(*) FROM queries"), "queriesPlanned": 2 * len(self.queries),
                      "metaErrors": tot("SELECT COUNT(*) FROM videos WHERE err IS NOT NULL AND meta_status<>'done'"),
                      "downloadErrors": tot("SELECT COUNT(*) FROM videos WHERE dl_status='error'")},
            "relevantByLeagueGuess": dict(sorted(by_league.items(), key=lambda kv: -kv[1])),
            "relevantByYear": dict(sorted(by_year.items())),
            "relevantLicense": cc,
            "rateLimitPauses": self.backoff.events,
        }

    def write_summary(self):
        sm = self.summary()
        tmp = os.path.join(self.a.work_dir, "summary.json.tmp")
        with open(tmp, "w") as f:
            json.dump(sm, f, indent=1)
        os.replace(tmp, os.path.join(self.a.work_dir, "summary.json"))
        t = sm["total"]
        log.info("progress: %d videos known, %d enriched (%d relevant), %d downloaded, %d processed, %.1f GB on disk · "
                 "%.0f new/min, %.0f meta/min, %.1f MB/s", t["videos"], t["enriched"], t["relevant"], t["downloaded"],
                 t["processed"], t["onDiskGB"], sm["ratesPerMin"]["newVideos"], sm["ratesPerMin"]["metadata"], sm["downloadMBps"])
        return sm

    def export_registry(self):
        if not self.a.registry:
            return 0
        rows = self.state.q("SELECT * FROM videos WHERE meta_status='done' AND rel_label='relevant'")
        reg = merge_registry(self.registry, [dict(r) for r in rows])
        write_registry(self.a.registry, reg)
        self.registry = reg
        return len(reg)

    def reporter(self):
        last_reg = time.time()
        while not self.stop.is_set():
            self.stop.wait(300)
            try:
                self.write_summary()
                if time.time() - last_reg > self.a.registry_every_min * 60:
                    n = self.export_registry()
                    log.info("registry: %d entries written", n)
                    last_reg = time.time()
            except Exception as ex:
                log.exception("reporter: %s", ex)

    # ---- main
    def run(self):
        log.info("metadata: %s", "YouTube Data API (key found)" if self.api_key else "web player (no YOUTUBE_API_KEY; see HANDOFF.md)")
        log.info("start: deadline %s, %d queries, download dir %s, work dir %s, policy=%s, keep=%s",
                 dt.datetime.fromtimestamp(self.deadline).strftime("%H:%M"), len(self.queries), self.a.download_dir,
                 self.a.work_dir, "cc-only" if self.a.cc_only else "all plausible battle videos", self.a.keep)
        ts = [threading.Thread(target=self.discover_search, name="search", daemon=True),
              threading.Thread(target=self.discover_channels, name="channels", daemon=True),
              threading.Thread(target=self.reporter, name="reporter", daemon=True)]
        ts += [threading.Thread(target=self.enrich_worker, name=f"enrich{i}", daemon=True) for i in range(self.a.enrich_workers)]
        if self.a.max_downloads != 0:
            ts += [threading.Thread(target=self.download_worker, name=f"dl{i}", daemon=True) for i in range(self.a.download_workers)]
        if not self.a.no_extract:
            jobs = self.a.extract_jobs or max(1, (os.cpu_count() or 4) // 2)
            ts += [threading.Thread(target=self.extract_worker, name=f"x{i}", daemon=True) for i in range(jobs)]
        for t in ts:
            t.start()
        try:
            while self.alive():
                time.sleep(2)
                if self.a.max_downloads and self.c["downloaded"] >= self.a.max_downloads and self.a.stop_after_downloads:
                    self.wait_extract_then_stop()
                    break
        except KeyboardInterrupt:
            log.info("interrupted: finishing current requests and saving state")
        self.stop.set()
        for t in ts:
            t.join(timeout=60)
        sm = self.write_summary()
        n = self.export_registry()
        log.info("done: registry %d entries; summary %s", n, os.path.join(self.a.work_dir, "summary.json"))
        return sm

    def wait_extract_then_stop(self):
        """Smoke runs: after the last download, give extraction time to finish before stopping."""
        while self.alive():
            busy = self.state.q("SELECT COUNT(*) FROM videos WHERE dl_status='done' AND x_status IS NULL AND deleted_date IS NULL")[0][0]
            if self.a.no_extract or not busy:
                return
            time.sleep(5)

# ------------------------------------------------------------------------------------- helpers


class _YtLogger:
    """Route yt-dlp messages to the log file only (errors are also returned to the caller)."""
    _yt = logging.getLogger("yt-dlp")

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        if "JavaScript runtime" in msg or "initial data" in msg:
            self._yt.debug(msg)
        else:
            self._yt.debug(msg[:300])

    def error(self, msg):
        self._yt.debug(msg[:300])


def extract_meta(info):
    """Keep what the registry and league inference need (stored in the local state DB only)."""
    fmts = info.get("formats") or []
    vids = [f for f in fmts if f.get("vcodec") not in (None, "none") and f.get("height")]
    best = max(vids, key=lambda f: (f.get("height") or 0, f.get("fps") or 0), default={})
    avc = [f for f in vids if str(f.get("vcodec", "")).startswith("avc1") and (f.get("height") or 0) <= 1080]
    pick = max(avc, key=lambda f: (f.get("height") or 0, f.get("fps") or 0), default={})
    est = pick.get("filesize") or pick.get("filesize_approx")
    w, h = best.get("width") or info.get("width"), best.get("height") or info.get("height")
    lic = info.get("license") or "Standard YouTube License"
    return {
        "id": info.get("id"), "title": info.get("title"), "channel": info.get("channel") or info.get("uploader"),
        "channelId": info.get("channel_id"), "channelUrl": info.get("channel_url"),
        "uploadDate": info.get("upload_date"), "durationS": info.get("duration"), "license": lic,
        "creativeCommons": P.is_cc(lic), "maxWidth": w, "maxHeight": h, "fps": best.get("fps") or info.get("fps"),
        "orientation": None if not (w and h) else ("portrait" if h > w else "landscape"),
        "language": info.get("language"), "views": info.get("view_count"), "tags": (info.get("tags") or [])[:40],
        "categories": info.get("categories") or [], "description": (info.get("description") or "")[:3000],
        "chapters": [{"start": c.get("start_time"), "title": c.get("title")} for c in (info.get("chapters") or [])][:80],
        "liveStatus": info.get("live_status"), "availability": info.get("availability"),
        "estBytes": int(est) if est else None,
    }


def sha256_prefix(path, n=16):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()[:n]


STATUS_ORDER = ["candidate", "approved", "downloaded", "processed", "deleted"]


def registry_entry(row, prior=None):
    """Registry entry (existing schema + league fields) from a state row. No descriptions, no
    trainer names beyond the public title/channel already in the schema."""
    m = json.loads(row.get("meta") or "{}")
    lg = json.loads(row.get("league") or "{}")
    e = dict(prior or {})
    status = "approved" if row.get("allowed") else "candidate"
    if row.get("dl_status") == "done":
        status = "downloaded"
    if row.get("x_status") == "done":
        status = "processed"
    if row.get("deleted_date"):
        status = "deleted"
    if prior and STATUS_ORDER.index(prior.get("status", "candidate")) > STATUS_ORDER.index(status) \
            and row.get("dl_status") in (None, "prior"):
        status = prior["status"]
    vid = row["id"]
    base = {
        "id": vid, "url": f"https://www.youtube.com/watch?v={vid}", "title": m.get("title") or row.get("title"),
        "channel": m.get("channel") or row.get("channel"), "channelUrl": m.get("channelUrl") or row.get("channel_url"),
        "uploadDate": m.get("uploadDate"), "durationMin": round((m.get("durationS") or 0) / 60, 1),
        "license": m.get("license"), "creativeCommons": bool(m.get("creativeCommons")),
        "maxWidth": m.get("maxWidth"), "maxHeight": m.get("maxHeight"), "fps": m.get("fps"),
        "orientation": m.get("orientation"), "language": m.get("language"), "views": m.get("views"),
    }
    for k, v in base.items():
        if k not in e or e[k] in (None, "") or k in ("views", "license", "creativeCommons"):
            e[k] = v
    keep_manual = prior and (prior.get("shortlist") or prior.get("pilot"))
    if not keep_manual:
        e["leagueGuess"] = lg.get("leagueGuess", "Unknown")
        e["kindGuess"] = lg.get("kindGuess", "set/gameplay")
    e["leagueId"] = lg.get("leagueId")
    e["leagueConfidence"] = lg.get("leagueConfidence", 0)
    e["leagueEvidence"] = lg.get("leagueEvidence", [])
    e["cupCandidates"] = lg.get("cupCandidates", [])
    e.setdefault("permission", "CC license (reuse allowed with attribution)" if e["creativeCommons"] else "not requested")
    e["status"] = status
    e.setdefault("shortlist", False)
    e["relevance"] = row.get("rel_score")
    if row.get("dl_status") == "done":
        e["downloaded"] = row.get("dl_date")
        e["sha256"] = row.get("sha256")
        if row.get("size_bytes"):
            e["size1080MB"] = round(row["size_bytes"] / 1e6)
    if row.get("x_status") == "done":
        e["processed"] = row.get("x_date")
    elif row.get("x_status") == "failed":
        e["note"] = e.get("note") or "analysis failed"
    if row.get("deleted_date"):
        e["deletedDate"] = row["deleted_date"]
    e.setdefault("harvested", dt.date.today().isoformat())
    return e


def merge_registry(registry, rows):
    reg = dict(registry)
    for r in rows:
        reg[r["id"]] = registry_entry(r, reg.get(r["id"]))
    return reg


def write_registry(path, reg):
    items = [reg[k] for k in sorted(reg)]
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=1, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


_gm_lock = threading.Lock()


def gamemaster_for(upload_date):
    """Path to PvPoke gamemaster.min.json as of the 1st/16th on or before the upload date (cached).
    Battles precede uploads, so rounding down is the right direction. Returns None on failure."""
    d = L._date(upload_date)
    if not d:
        return None
    key = d.replace(day=16 if d.day >= 16 else 1)
    path = os.path.join(GM_CACHE, f"{key.isoformat()}.json")
    if os.path.exists(path):
        return path
    with _gm_lock:
        if os.path.exists(path):
            return path
        miss = path + ".miss"
        if os.path.exists(miss) and time.time() - os.path.getmtime(miss) < 3600:
            return None
        os.makedirs(GM_CACHE, exist_ok=True)
        try:
            api = ("https://api.github.com/repos/pvpoke/pvpoke/commits?path=src/data/gamemaster.min.json&per_page=1&until="
                   + key.isoformat() + "T23:59:59Z")
            req = urllib.request.Request(api, headers={"User-Agent": "gbl-synapse-harvester", "Accept": "application/vnd.github+json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                sha = json.load(r)[0]["sha"]
            raw = f"https://raw.githubusercontent.com/pvpoke/pvpoke/{sha}/src/data/gamemaster.min.json"
            with urllib.request.urlopen(urllib.request.Request(raw, headers={"User-Agent": "gbl-synapse-harvester"}), timeout=120) as r:
                data = r.read()
            json.loads(data)
            with open(path + ".tmp", "wb") as f:
                f.write(data)
            os.replace(path + ".tmp", path)
            return path
        except Exception as ex:
            log.info("gamemaster for %s unavailable (%s); using current data", key, str(ex)[:120])
            open(miss, "w").close()
            return None


def write_league_refinement(result_path, video_league, schedule, upload_date):
    """Post-analysis hook: per-battle league from observed CPs/species (league.refine_battle_league)."""
    with open(result_path, encoding="utf-8") as f:
        res = json.load(f)
    cands = sorted(set((video_league.get("cupCandidates") or []) + ([video_league["leagueId"]] if video_league.get("leagueId") else [])
                       + list(L.BASE)))
    gm = L.load_gamemaster()
    out = []
    for b in res.get("battles", []):
        mons = (b.get("myDetail") or []) + (b.get("opponentDetail") or [])
        species = [((m.get("form") or {}).get("id") or m.get("formId")) for m in mons]
        obs = {"cps": [m.get("cp") for m in mons if isinstance(m.get("cp"), (int, float))],
               "species": [s for s in species if isinstance(s, str)]}
        r = L.refine_battle_league(obs, cands, schedule, gm)
        out.append({"start": b.get("start"), "best": r["ranked"][0]["id"] if r["ranked"] else None,
                    "ranked": [x["id"] for x in r["ranked"][:4]], "cpCap": r["cpCap"], "eliminated": len(r["eliminated"]),
                    "options": [{"id": x["id"], "name": x["name"], "cp": x["cp"], "score": x["score"]} for x in r["ranked"][:4]],
                    "cps": obs["cps"]})
    doc = {"video": video_league, "battles": out}
    with open(result_path.replace(".json", ".leagues.json"), "w") as f:
        json.dump(doc, f, indent=1)
    return doc

# ------------------------------------------------------------------------------------- CLI


def parse(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", nargs="?", default="overnight", choices=["overnight", "status", "export-registry", "queries"])
    ap.add_argument("--hours", type=float, default=9.0)
    ap.add_argument("--download-dir", default=os.environ.get("YT_HARVEST_DL", DEFAULT_DL))
    ap.add_argument("--work-dir", default=os.environ.get("YT_HARVEST_WORK", DEFAULT_WORK))
    ap.add_argument("--registry", default=REGISTRY, help="registry.json to update ('' = don't)")
    ap.add_argument("--disk-budget-gb", type=float, default=150)
    ap.add_argument("--min-free-gb", type=float, default=30)
    ap.add_argument("--max-downloads", type=int, default=None, help="stop downloading after N (0 = metadata only)")
    ap.add_argument("--stop-after-downloads", action="store_true", help="end the run once --max-downloads are done (smoke tests)")
    ap.add_argument("--max-duration-min", type=float, default=180)
    ap.add_argument("--max-queries", type=int, default=None)
    ap.add_argument("--search-limit", type=int, default=150, help="results per date-sorted query (relevance: 2x)")
    ap.add_argument("--channel-limit", type=int, default=3000)
    ap.add_argument("--enrich-workers", type=int, default=4)
    ap.add_argument("--meta-per-min", type=float, default=20, help="metadata requests/min cap (halves on 429)")
    ap.add_argument("--downloads-per-min", type=float, default=3, help="download starts/min cap (halves on 429)")
    ap.add_argument("--download-workers", type=int, default=2)
    ap.add_argument("--extract-jobs", type=int, default=0, help="parallel Meta Extractor processes (default cores/2)")
    ap.add_argument("--inbox", default=INBOX, help="validation inbox the site's Validate tab loads ('' = don't write)")
    ap.add_argument("--no-extract", action="store_true", help="don't run the Meta Extractor")
    ap.add_argument("--no-api", action="store_true", help="ignore a YouTube Data API key even if one is configured")
    ap.add_argument("--web-meta-when-quota-out", action="store_true",
                    help="after the Data API quota runs out, fetch metadata through the web player again")
    ap.add_argument("--keep", action="store_true", help="keep videos after processing (default: delete)")
    ap.add_argument("--cc-only", action="store_true", help="download only Creative Commons / written-permission videos")
    ap.add_argument("--pace", type=float, default=2.0, help="seconds between discovery page requests")
    ap.add_argument("--registry-every-min", type=float, default=30)
    return ap.parse_args(argv)


def setup_logging(work_dir):
    os.makedirs(work_dir, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(threadName)s %(message)s", "%m-%d %H:%M:%S")
    fh = logging.FileHandler(os.path.join(work_dir, "harvest.log"))
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    sh.setLevel(logging.WARNING if os.environ.get("YT_HARVEST_QUIET") else logging.INFO)
    root = logging.getLogger()
    root.handlers[:] = [fh, sh]
    root.setLevel(logging.INFO)


def main(argv=None):
    a = parse(argv)
    a.registry = a.registry or None
    if a.command == "queries":
        for q in build_queries(L.load_schedule()):
            print(q)
        return 0
    if a.command == "status":
        p = os.path.join(a.work_dir, "summary.json")
        print(open(p).read() if os.path.exists(p) else "no summary yet: " + p)
        return 0
    setup_logging(a.work_dir)
    h = Harvester(a)
    if a.command == "export-registry":
        print(h.export_registry(), "entries")
        return 0
    signal.signal(signal.SIGTERM, lambda *_: h.stop.set())
    sm = h.run()
    print(json.dumps({k: sm[k] for k in ("elapsedMin", "ratesPerMin", "downloadMBps", "total", "relevantLicense")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
