#!/usr/bin/env python3
"""Answer simple Validate questions with a (local) LLM, behind a quality gate.

  validate_llm.py gate  --kind KIND [--limit N]               score against the owner's answers -> evals.json
  validate_llm.py run   --kind KIND [--limit N] [--dry-run]   resolve open questions (needs a passed gate)
  validate_llm.py bench [--n 6]                               latency per call for each image kind

Kinds, in priority order:
  footage        "No battles found": battle type from YouTube's auto-thumbnails (hq1-3) + the title
  result         who won: phone-screen frames around the battle end, from the local copy
  lead           opponent's lead: the nameplate strip read twice (second reader for the HUD OCR)
  title_footage  relevance / Rocket / championship from the title and description alone (text only)
  title_league   league or cup of a battle from the title, description and CPs (text only)
  footage_title  footage and title_footage together: all four calls must agree

The model is whatever freellm.py routes to: by default the local Ollama server (nothing leaves the
machine). Frames are still cropped and downscaled, and stop 6 s before the next battle's VS screen
(trainer names); the owner's own recordings (PoGo Recorder/src/*.mp4) are never used.

Agreement rule: two independent calls (different option order and seed; for `lead`, a different
frame) must give the same answer, each with confidence >= the threshold the gate chose. Otherwise
the question stays open. About 1 in 10 agreed answers also stays open as a spot check.

Gate: the owner's human answers, split into two halves by video. Each half's threshold is chosen on
the other half; the pooled held-out answers must be >= 95% exactly right with >= 10 resolved. The
threshold used by `run` is the strictest of the per-half and whole-set choices. Results (date, n,
precision, coverage, latency, model) go to evals.json as llm_<kind>. `run` refuses to resolve when
the gate didn't pass or was measured on another model.

Resolutions go to the local app (POST /api/validation/resolve) with the provider's source
("local-llm"): reversible, never training labels; human answers and Reopen win; audit questions stay open.
"""
import argparse, hashlib, json, math, os, re, sqlite3, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
FREELLM = HERE / "freellm.py"
EVALS = HERE / "evals.json"
WEB = HERE.parents[1]
WORK = Path(os.environ.get("YT_HARVEST_WORK", Path.home() / "Desktop/Projects/PoGo Recorder/src/yt-harvest"))
OWN_RECORDINGS = WORK.parent   # PoGo Recorder/src: the owner's own *.mp4 live directly here; never used
RELABEL = WORK.parent / "youtube"   # the download dir (relabel-cache is merged into it)
CC_VIDEOS = Path(os.environ.get("YT_CC_VIDEOS", Path.home() / "Desktop/Projects/PoGo Recorder/src/youtube-cc"))
BENCH_LABELS = WEB / "tests" / "meta-benchmark" / "labels" / "youtube"
FRAMES = Path(os.environ.get("FREELLM_CACHE", Path.home() / ".cache" / "freellm")) / "validate-frames"
APP = os.environ.get("GBL_APP", "http://localhost:65246")
GATE = {"precision": 0.95, "minResolved": 10, "thresholds": [0.0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99]}
EXTERNAL = {"freellm", "local-llm", "haiku"}   # resolution sources that are not human answers
RESULT_WIDTH = 288

FOOTAGE_CHOICES = {
    "battles": "an ordinary trainer battle against another player (GO Battle League) is visible",
    "rocket": "a battle against Team Rocket (grunt, leader or Giovanni; shadowy enemy, Rocket balloon or hideout) is visible",
    "championship": "a tournament broadcast (two phone screens side by side, casters, a stage, event branding)",
    "obscured": "a trainer battle is there, but overlays or a face camera cover most of the battle screen",
    "partial": "only very short battle clips or replays between other content (talking, team building, menus)",
    "none": "nothing from a Pokémon GO trainer battle: raids, Max battles, gyms, the map, catching, menus, "
            "Pokémon lists, a person talking, or another game",
}
FOOTAGE_SIGNS = ("Signs of a trainer battle, even in a small phone screen next to overlays or a face camera: two "
                 "Pokémon facing each other with HP bars and white nameplates at the top and move buttons at the "
                 "bottom; the charged-attack tapping screen (\"Excellent!\", \"Great!\", \"Nice!\"); the shield prompt; "
                 "the \"GO\" countdown or the VS screen; the \"YOU WIN\"/\"GOOD EFFORT\" end screen.")
RESULT_CHOICES = {
    "Win": "the opponent's last Pokémon fainted, or YOU WIN is shown",
    "Win:opponent-forfeit": "you won while the opponent still had Pokémon left (they forfeited or left)",
    "Loss": "your last Pokémon fainted, or GOOD EFFORT is shown",
    "Loss:you-forfeit": "you forfeited or left while you still had Pokémon",
    "Tie": "both last Pokémon fainted together, or TIE is shown",
}
TITLE_FOOTAGE_CHOICES = {k: FOOTAGE_CHOICES[k] for k in ("battles", "rocket", "championship", "none")}


# ---------- questions and labels ----------

def fetch_state():
    """Questions, answers and resolutions from the running app (read-only GET)."""
    req = urllib.request.Request(APP + "/api/validation", headers={"Origin": APP, "Sec-Fetch-Site": "same-origin"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def human(a):
    return bool(a) and a.get("value") is not None and a.get("source") not in ({"model"} | EXTERNAL) and not a.get("modelResolved")


def video_id(q):
    return (q.get("video") or {}).get("id") or str(q.get("recording") or "").removesuffix(".mp4")


def safe_video(p):
    """Never the owner's own recordings (files directly in PoGo Recorder/src)."""
    p = Path(p).resolve()
    return p.exists() and p.parent != OWN_RECORDINGS.resolve()


def local_video(vid):
    try:
        db = sqlite3.connect(f"file:{WORK / 'state.sqlite'}?mode=ro", uri=True)
        row = db.execute("select dl_path from videos where id=?", (vid,)).fetchone()
        db.close()
    except sqlite3.Error:
        row = None
    for p in ([row[0]] if row and row[0] else []) + [str(RELABEL / (vid + ".mp4")), str(CC_VIDEOS / (vid + ".mp4"))]:
        if p and safe_video(p):
            return Path(p)
    return None


def video_meta(vid):
    try:
        db = sqlite3.connect(f"file:{WORK / 'state.sqlite'}?mode=ro", uri=True)
        row = db.execute("select meta from videos where id=?", (vid,)).fetchone()
        db.close()
        return json.loads(row[0]) if row and row[0] else {}
    except (sqlite3.Error, ValueError):
        return {}


def clean_description(text, limit=1200):
    """Public video description without links, e-mails, handles, trainer codes or in-game names."""
    out = []
    for line in str(text or "").splitlines():
        if re.search(r"(?i)trainer\s*(code|name|id)|friend\s*code|\bIGN\b|in-?game\s*name|\b\d{4}\s?\d{4}\s?\d{4}\b", line):
            continue
        line = re.sub(r"https?://\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+|@\w+", "", line).strip()
        if line:
            out.append(line)
    return "\n".join(out)[:limit]


def video_text(q):
    v = q.get("video") or {}
    meta = video_meta(video_id(q))
    dur = v.get("durationS") or meta.get("durationS")
    lines = [f"Title: {v.get('title') or meta.get('title') or ''}", f"Channel: {v.get('channel') or meta.get('channel') or ''}"]
    if dur:
        lines.append(f"Length: {int(dur) // 60} min {int(dur) % 60} s")
    desc = clean_description(meta.get("description"))
    if desc:
        lines.append("Description:\n" + desc)
    return "\n".join(lines)


# ---------- frames ----------

def ffmpeg(args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True, timeout=120, capture_output=True)


def footage_frames(q, variant=0):
    """YouTube's public auto-thumbnails hq1-3 (frames at 25/50/75%), downscaled side by side."""
    vid = video_id(q)
    out = FRAMES / "footage" / (vid + ".jpg")
    if out.exists():
        return [out]
    out.parent.mkdir(parents=True, exist_ok=True)
    parts = []
    for n in (1, 2, 3):
        f = out.with_name(f"{vid}.hq{n}.jpg")
        if not f.exists():
            try:
                with urllib.request.urlopen(f"https://i.ytimg.com/vi/{vid}/hq{n}.jpg", timeout=30) as r:
                    f.write_bytes(r.read())
            except (urllib.error.URLError, TimeoutError):
                return None
            time.sleep(0.3)
        parts.append(f)
    ffmpeg([x for f in parts for x in ("-i", str(f))] + ["-filter_complex",
           "".join(f"[{i}]scale=360:270,setsar=1[v{i}];" for i in range(3)) + "[v0][v1][v2]hstack=inputs=3", "-q:v", "4", str(out)])
    for f in parts:
        f.unlink(missing_ok=True)
    return [out]


def screen_box(vid, video):
    """Phone screen box [x0, y0, x1, y1] from the extractor's result, if it fits this copy."""
    res = WORK / "results" / (vid + ".json")
    if not res.exists():
        return None, {}
    r = json.loads(res.read_text())
    x, y, x1, y1 = r.get("crop") or [0, 0, 0, 0]
    if x1 - x <= 0 or y1 - y <= 0:
        return None, r
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", str(video)], capture_output=True, text=True, timeout=60).stdout.strip().split(",")
    if len(probe) < 2 or x1 > int(probe[0]) or y1 > int(probe[1]):
        return None, r   # a re-encoded copy at another size: the saved screen box doesn't apply
    return [x, y, x1, y1], r


def result_frames(q, variant=0):
    """Up to six frames from 8 s before to 10 s after the battle end, from the local copy: phone
    screen only, RESULT_WIDTH px wide. In-battle HUDs show Pokémon names, not trainer names; frames
    within 6 s of the next battle's start (its VS screen names both trainers) are left out."""
    vid = video_id(q)
    key = hashlib.sha256(q["qid"].encode()).hexdigest()[:16]
    out = FRAMES / f"result{RESULT_WIDTH}" / (key + ".jpg")
    if out.exists():
        return [out]
    video = local_video(vid)
    if not video:
        return None
    box, r = screen_box(vid, video)
    if not box:
        return None
    x, y, x1, y1 = box
    end = q["clip"][0] + 2   # questions.js: clip = [end - 2, end + 14]
    nxt = next((b["start"] for b in r.get("battles") or [] if b.get("start", 0) > end), None)
    times = [t for t in (end - 8, end - 5, end - 2.5, end - 0.5, end + 1.5, end + 4, end + 7, end + 10)
             if nxt is None or t < nxt - 6][-6:]
    if len(times) < 3:
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = []
    for i, t in enumerate(times):
        f = out.with_name(f"{key}.{i}.jpg")
        try:
            ffmpeg(["-ss", f"{max(0, t):.2f}", "-i", str(video), "-frames:v", "1", "-vf",
                    f"crop={x1 - x}:{y1 - y}:{x}:{y},scale={RESULT_WIDTH}:-2", str(f)])
        except subprocess.CalledProcessError:
            continue   # past the end of the file
        if f.exists():
            tmp.append(f)
    if len(tmp) < 3:
        for f in tmp:
            f.unlink(missing_ok=True)
        return None
    ffmpeg([x for f in tmp for x in ("-i", str(f))] + ["-filter_complex", f"hstack=inputs={len(tmp)}", "-q:v", "4", str(out)])
    for f in tmp:
        f.unlink(missing_ok=True)
    return [out]


def hud_strip(video, box, t, out):
    """The top HUD strip of the phone screen (Pokémon nameplates, CP, Poké Balls; no trainer names)."""
    x0, y0, x1, y1 = box
    ffmpeg(["-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", "-vf",
            f"crop={x1 - x0}:{int((y1 - y0) * .13)}:{x0}:{y0},scale=886:-2", "-q:v", "3", str(out)])
    return out if out.exists() else None


LEAD_OFFSETS = (3.0, 6.0)   # seconds after the battle start: the two independent reads


def lead_frames(q, variant=0):
    if q.get("bench"):
        video, box, start = Path(q["bench"]["video"]), q["bench"]["box"], q["bench"]["start"] + 2   # labels: start ±4 s
    else:
        vid = video_id(q)
        video = local_video(vid)
        if not video:
            return None
        box, _ = screen_box(vid, video)
        start = q["clip"][0]
    if not box or not video.exists():
        return None
    key = hashlib.sha256(q["qid"].encode()).hexdigest()[:16]
    out = FRAMES / "lead" / f"{key}.{variant % 2}.jpg"
    if out.exists():
        return [out]
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        return [hud_strip(video, box, start + LEAD_OFFSETS[variant % 2], out)]
    except subprocess.CalledProcessError:
        return None


# ---------- prompts ----------

def choices_text(choices, order):
    return "\n".join(f"\"{k}\" - {choices[k]};" for k in order) + "\n\"unsure\" - you can't tell."


def ordered(keys, variant, qid):
    """Variant 0: canonical order; variant 1: a different, question-seeded order (independence)."""
    keys = list(keys)
    if variant:
        keys.sort(key=lambda k: hashlib.sha256(f"{qid}:{k}".encode()).hexdigest())
        if len(keys) > 1 and keys == list(sorted(keys)):
            keys.reverse()
    return keys


def schema_for(values):
    return {"type": "object", "properties": {"answer": {"type": "string", "enum": list(values) + ["unsure"]},
                                              "confidence": {"type": "number"}},
            "required": ["answer", "confidence"], "additionalProperties": False}


REPLY = ("Reply with JSON {\"answer\": X, \"confidence\": C} where C is your probability (0 to 1) that X is right, "
         "and X is one of:\n")


def prompt_footage(q, variant):
    order = ordered(FOOTAGE_CHOICES, variant, q["qid"])
    return ("These are three frames from a YouTube video, taken at 25%, 50% and 75% of its length (left to right). "
            f"The video was found by a search for Pokémon GO PvP.\n{video_text(q)}\n\n"
            f"Which kind of footage does it show? {FOOTAGE_SIGNS}\n" + REPLY + choices_text(FOOTAGE_CHOICES, order)), order


def prompt_result(q, variant):
    order = ordered(RESULT_CHOICES, variant, q["qid"])
    return ("These frames come from a Pokémon GO trainer battle recorded by the player (\"you\"), whose Pokémon "
            "is at the bottom/left side, the opponent's at the top/right. They are taken around the end of one battle, "
            "in time order left to right. Who won? Look for the end screen text (\"YOU WIN\", \"GOOD EFFORT\" = you "
            "lost, \"TIE\"; the game may be in another language) and whose last Pokémon fainted; a forfeit ends the "
            "battle while that side still has Pokémon. If the frames end before the battle does, answer \"unsure\".\n"
            + REPLY + choices_text(RESULT_CHOICES, order)), order


def option_values(q):
    return [o["value"] for o in q.get("options") or [] if isinstance(o.get("value"), str)]


def prompt_lead(q, variant):
    names = [v for v in option_values(q) if v != "other"]
    order = ordered(names, variant, q["qid"]) + ["other"]
    # Values are member keys since lead options show the full identity; the nameplate prints the detected name.
    shown = {o["value"]: o.get("name") or o["value"] for o in q.get("options") or [] if isinstance(o.get("value"), str)}
    choices = {**{n: f"the right nameplate shows {shown.get(n, n)}" for n in names}, "other": "it shows another Pokémon"}
    return ("This is the top strip of a Pokémon GO trainer battle screen, just after the battle started. The RIGHT "
            "white nameplate names the opponent's Pokémon (the left one is the player's). Which Pokémon is on the "
            "opponent's (right) nameplate? Regional forms may be printed without the form name.\n"
            + REPLY + choices_text(choices, order)), order


def prompt_title_footage(q, variant):
    order = ordered(TITLE_FOOTAGE_CHOICES, variant, q["qid"])
    return ("A YouTube video was found by a search for Pokémon GO PvP. From its title and description only, "
            "what does it show?\n" + video_text(q) + "\n\n" + REPLY + choices_text(TITLE_FOOTAGE_CHOICES, order)), order


def prompt_title_league(q, variant):
    opts = {o["value"]: o.get("label") or o["value"] for o in q.get("options") or [] if isinstance(o.get("value"), str)}
    order = ordered([k for k in opts if k != "other"], variant, q["qid"]) + (["other"] if "other" in opts else [])
    return ("A Pokémon GO PvP battle comes from this YouTube video. Which league or cup is it in?\n" + video_text(q)
            + f"\n\nWhat the analysis saw: {q.get('detail') or ''}\n"
            "Great League and its cups cap CP at 1500, Ultra League at 2500, Master League has no cap.\n"
            + REPLY + choices_text({k: opts[k] for k in order}, order)), order


def none_frames(q, variant=0):
    return []


KINDS = {
    "footage": {"question": "footage", "frames": footage_frames, "prompt": prompt_footage, "data": "private",
                "values": lambda q: list(FOOTAGE_CHOICES), "resolvable": lambda q: set(FOOTAGE_CHOICES)},
    "result": {"question": "result", "frames": result_frames, "prompt": prompt_result, "data": "private",
               "values": lambda q: list(RESULT_CHOICES), "resolvable": lambda q: set(RESULT_CHOICES)},
    "lead": {"question": "lead", "frames": lead_frames, "prompt": prompt_lead, "data": "private",
             "values": option_values, "resolvable": lambda q: set(option_values(q)) - {"other"}, "bench": True},
    "title_footage": {"question": "footage", "frames": none_frames, "prompt": prompt_title_footage, "data": "public",
                      "values": lambda q: list(TITLE_FOOTAGE_CHOICES), "resolvable": lambda q: set(TITLE_FOOTAGE_CHOICES)},
    # Thumbnails AND text must both agree (four calls): two independent modalities, like the earlier
    # free-tier rule (thumbnails + title policy). Answers are those both can give.
    "footage_title": {"question": "footage", "parts": ["footage", "title_footage"], "data": "private",
                      "values": lambda q: list(TITLE_FOOTAGE_CHOICES), "resolvable": lambda q: set(TITLE_FOOTAGE_CHOICES)},
    "title_league": {"question": "league", "frames": none_frames, "prompt": prompt_title_league, "data": "public",
                     "values": option_values, "resolvable": lambda q: set(option_values(q)) - {"other"}},
}


def spot_check(qid, share=10):
    """Keep about 1 in `share` resolvable questions open so the owner keeps measuring precision."""
    return int(hashlib.sha256(("spot:" + qid).encode()).hexdigest(), 16) % share == 0


# ---------- asking ----------

class SetupNeeded(SystemExit):
    pass


LATENCY = []   # (seconds, images) per uncached call


def ask(kind, q, variant, run_id):
    """One call's {"answer", "confidence", "model", "source"} (cached by freellm.py), or None."""
    spec = KINDS[kind]
    images = spec["frames"](q, variant)
    if images is None:
        return "noFrames"
    prompt, _ = spec["prompt"](q, variant)
    cmd = [sys.executable, "-I", str(FREELLM), "ask", prompt, "--schema", json.dumps(schema_for(spec["values"](q))),
           "--data", spec["data"], "--task", "llm_" + kind, "--seed", str(variant), "--wait", "300"]
    for f in images:
        cmd += ["--image", str(f)]
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800, env={**os.environ, "FREELLM_RUN": run_id})
    if r.returncode == 6:
        print(r.stderr.strip(), file=sys.stderr)
        raise SetupNeeded(6)
    if r.returncode:
        return None
    if "cache hit" not in r.stderr:
        LATENCY.append((time.time() - t0, len(images)))
    try:
        out = json.loads(r.stdout)
        ans, conf = out.get("answer"), float(out.get("confidence"))
    except (ValueError, AttributeError, TypeError):
        return None
    m = re.search(r"answered by \S+(?: \(cached\))? \(([^)]*)\) source=(\S+)", r.stderr)
    if not isinstance(ans, str) or ans not in set(spec["values"](q)) | {"unsure"}:
        return None
    return {"answer": ans, "confidence": max(0.0, min(1.0, conf)), "model": m.group(1) if m else None,
            "source": m.group(2) if m else None}


def decide(kind, q, run_id, threshold=0.0):
    """Both calls' answers. The second call is made only when the first could resolve the question.
    A combined kind ("parts") asks each part in turn and stops at the first part that can't agree."""
    spec = KINDS[kind]
    if spec.get("parts"):
        out = {}
        for part in spec["parts"]:
            sub = decide(part, q, run_id, threshold)
            if sub == "noFrames":
                return "noFrames"
            out[part + ".a"], out[part + ".b"] = sub["a"], sub["b"]
            if not agreed(kind, q, {"a": sub["a"], "b": sub["b"]}, threshold):
                break
        return out
    a = ask(kind, q, 0, run_id)
    if a == "noFrames":
        return "noFrames"
    out = {"a": a, "b": None}
    if a and a["answer"] in spec["resolvable"](q) and a["confidence"] >= threshold:
        b = ask(kind, q, 1, run_id)
        out["b"] = b if isinstance(b, dict) else None
    return out


def expected_calls(kind):
    return 2 * len(KINDS[kind].get("parts") or [kind])


def agreed(kind, q, calls, threshold):
    """The answer when every expected call agrees on a resolvable value with confidence >= threshold."""
    got = [c for c in calls.values() if c]
    n = 2 if set(calls) == {"a", "b"} else expected_calls(kind)
    if len(got) < n or len({c["answer"] for c in got}) != 1 or got[0]["answer"] not in KINDS[kind]["resolvable"](q):
        return None
    return got[0]["answer"] if min(c["confidence"] for c in got) >= threshold else None


def first_call(calls):
    return next((c for c in calls.values() if c), None) or {}


def wilson_lower(k, n, z=1.96):
    if not n:
        return 0.0
    p = k / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def choose_threshold(rows, kind):
    """Lowest threshold whose answers are >= GATE precision exactly right (max coverage); None if none."""
    for t in GATE["thresholds"]:
        res = [r for r in rows if agreed(kind, r["q"], r["calls"], t)]
        if res and sum(agreed(kind, r["q"], r["calls"], t) == r["truth"] for r in res) / len(res) >= GATE["precision"]:
            return t
    return None


def latency_summary():
    if not LATENCY:
        return None
    s = sorted(x for x, _ in LATENCY)
    return {"calls": len(s), "meanS": round(sum(s) / len(s), 2), "p90S": round(s[int(.9 * (len(s) - 1))], 2),
            "imagesPerCall": round(sum(n for _, n in LATENCY) / len(LATENCY), 2)}


# ---------- commands ----------

def bench_items():
    """Lead gate extras: hand-labelled battles of the Creative Commons benchmark videos (opponent lead)."""
    out = []
    for lf in sorted(BENCH_LABELS.glob("*.json")):
        lab = json.loads(lf.read_text())
        video = CC_VIDEOS / lab.get("recording", "")
        if "battles" not in lab or not video.exists() or not lab.get("screenBox"):
            continue
        for b in lab["battles"]:
            opp = [n for n in b.get("opp") or [] if n]
            if not b.get("oppLead") or len(opp) != 3:
                continue
            q = {"qid": f"bench:{lf.stem}:{b['n']}:lead", "kind": "lead", "video": {"id": lf.stem},
                 "options": [{"value": n} for n in opp] + [{"value": "other"}],
                 "bench": {"video": str(video), "box": lab["screenBox"], "start": b["start"]}}
            out.append((q, {"value": b["oppLead"]}))
    return out


def cmd_gate(a):
    spec, run_id = KINDS[a.kind], f"gate-{a.kind}-{int(time.time())}"
    st = fetch_state()
    qs = {q["qid"]: q for q in st["questions"] if q.get("kind") == spec["question"]}
    items = [(qs[qid], ans) for qid, ans in st["answers"].items() if qid in qs and human(ans)]
    humans = len(items)
    if spec.get("bench"):
        items += bench_items()
    items.sort(key=lambda x: hashlib.sha256(video_id(x[0]).encode()).hexdigest())
    if a.limit:
        items = items[:a.limit]
    t0, rows, skipped = time.time(), [], 0
    for q, ans in items:
        calls = decide(a.kind, q, run_id)
        if calls == "noFrames":
            skipped += 1
            continue
        fold = int(hashlib.sha256(("fold:" + video_id(q)).encode()).hexdigest(), 16) % 2
        rows.append({"q": q, "video": video_id(q), "fold": fold, "truth": ans["value"], "calls": calls})
        fmt = lambda c: f"{c['answer']}@{c['confidence']:.2f}" if c else "-"
        print(f"{len(rows):3} truth={str(ans['value']):<22} " + "  ".join(f"{k}={fmt(c)}" for k, c in calls.items()), flush=True)
    # Two-fold by video: each half's threshold comes from the other half; the pooled held-out answers count.
    held = []
    per_fold = {}
    for f in (0, 1):
        t = choose_threshold([r for r in rows if r["fold"] != f], a.kind)
        per_fold[f] = t
        if t is not None:
            held += [(r, agreed(a.kind, r["q"], r["calls"], t)) for r in rows if r["fold"] == f]
    res = [(r, v) for r, v in held if v]
    right = sum(v == r["truth"] for r, v in res)
    t_all = choose_threshold(rows, a.kind)
    chosen = None if t_all is None or None in per_fold.values() else max([t_all, *per_fold.values()])
    models = sorted({c["model"] for r in rows for c in r["calls"].values() if c and c.get("model")})
    sources = sorted({c["source"] for r in rows for c in r["calls"].values() if c and c.get("source")})
    by_value = {}
    for r, v in res:
        s = by_value.setdefault(v, {"resolved": 0, "right": 0})
        s["resolved"] += 1
        s["right"] += v == r["truth"]
    s = {"date": time.strftime("%Y-%m-%d"), "kind": a.kind, "model": models[0] if len(models) == 1 else models,
         "source": sources[0] if len(sources) == 1 else sources, "labelled": len(items), "humanAnswers": humans,
         "benchmarkItems": len(items) - humans if spec.get("bench") else 0, "noFrames": skipped, "evaluated": len(rows),
         "videos": len({r["video"] for r in rows}), "foldThresholds": per_fold, "threshold": chosen,
         "resolved": len(res), "right": right, "precision": round(right / len(res), 3) if res else 0,
         "wilsonLower": round(wilson_lower(right, len(res)), 3), "coverage": round(len(res) / len(rows), 3) if rows else 0,
         "byValue": by_value, "firstCallRight": sum(first_call(r["calls"]).get("answer") == r["truth"] for r in rows),
         "wrong": [f"{r['video']}: said {v}, owner {r['truth']}" for r, v in res if v != r["truth"]],
         "latency": latency_summary(), "wallS": round(time.time() - t0), "costUSD": 0.0 if sources == ["local-llm"] else None,
         "method": "two-fold by video; held-out exact precision; threshold = strictest of fold and whole-set choices"}
    s["passed"] = bool(chosen is not None and len(res) >= GATE["minResolved"] and s["precision"] >= GATE["precision"])
    if not s["passed"]:
        s["status"] = ("not enough labelled answers" if len(rows) < 2 * GATE["minResolved"] else
                       f"held-out precision {s['precision']} on {len(res)} resolved (needs >= {GATE['precision']} on >= {GATE['minResolved']})")
    evals = json.loads(EVALS.read_text()) if EVALS.exists() else {}
    evals["llm_" + a.kind] = s
    EVALS.write_text(json.dumps(evals, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({k: v for k, v in s.items() if k != "wrong"}, ensure_ascii=False))
    for w in s["wrong"][:10]:
        print("wrong:", w)
    return 0 if s["passed"] else 1


def submit(out):
    saved, skipped = 0, 0
    for i in range(0, len(out), 500):
        body = json.dumps({"resolutions": out[i:i + 500]}).encode()
        req = urllib.request.Request(APP + "/api/validation/resolve", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Origin": APP, "Sec-Fetch-Site": "same-origin"})
        with urllib.request.urlopen(req, timeout=120) as r:
            resp = json.load(r)
        saved += resp.get("saved") or 0
        skipped += len(resp.get("skipped") or [])
    return saved, skipped


def cmd_run(a):
    spec, run_id = KINDS[a.kind], f"run-{a.kind}-{int(time.time())}"
    gate = (json.loads(EVALS.read_text()) if EVALS.exists() else {}).get("llm_" + a.kind) or {}
    if not gate.get("passed"):
        print(f"llm_{a.kind} has not passed its gate (run `validate_llm.py gate --kind {a.kind}` first); nothing resolved.")
        return 1
    t = gate["threshold"]
    st = fetch_state()
    done = set(st["answers"]) | set(st["resolutions"])
    open_qs = [q for q in st["questions"] if q.get("kind") == spec["question"] and q["qid"] not in done and not q.get("audit")]
    if a.limit:
        open_qs = open_qs[:a.limit]
    t0, out = time.time(), []
    stats = {"open": len(open_qs), "noFrames": 0, "unresolved": 0, "agreed": 0, "keptAsSpotCheck": 0, "threshold": t}
    for n, q in enumerate(open_qs, 1):
        calls = decide(a.kind, q, run_id, t)
        if calls == "noFrames":
            stats["noFrames"] += 1
            continue
        first = first_call(calls)
        if first.get("model") and first["model"] != gate.get("model"):
            print(f"model {first['model']} differs from the gated {gate.get('model')}: re-run the gate; nothing resolved.")
            return 1
        value = agreed(a.kind, q, calls, t)
        if not value:
            stats["unresolved"] += 1
            continue
        stats["agreed"] += 1
        if spot_check(q["qid"]):
            stats["keptAsSpotCheck"] += 1
            continue
        got = [c for c in calls.values() if c]
        conf = min(c["confidence"] for c in got)
        source = first.get("source") or "local-llm"
        out.append({"qid": q["qid"], "value": value, "source": source, "model": first.get("model"), "providers": [first.get("model")],
                    "agreement": len(got), "calls": len(got), "confidence": round(conf, 3), "threshold": t, "task": "llm_" + a.kind,
                    "gate": {k: gate.get(k) for k in ("date", "precision", "resolved", "coverage", "threshold")},
                    "reason": f"{first.get('model')}: {len(got)} independent calls agreed (confidence {conf:.2f} >= {t}); "
                              f"gate {gate.get('date')}: {gate.get('right')}/{gate.get('resolved')} right on held-out owner answers."})
        if n % 25 == 0:
            print(f"{n}/{len(open_qs)} · agreed {stats['agreed']} · {round(time.time() - t0)} s", flush=True)
    stats.update(seconds=round(time.time() - t0), latency=latency_summary(), resolutions=len(out))
    if out and not a.dry_run:
        try:
            stats["saved"], stats["skipped"] = submit(out)
        except urllib.error.HTTPError as e:
            stats["submitError"] = (f"{e.code}: restart the app to load the updated /api/validation/resolve, then re-run "
                                    "(answers are cached)") if e.code in (400, 404) else str(e.code)
    print(json.dumps(stats))
    return 0


def cmd_bench(a):
    """Latency per call on a few labelled questions of each image kind (cached answers don't count)."""
    st = fetch_state()
    run_id = f"bench-{int(time.time())}"
    out = {}
    for kind in ("footage", "result", "lead", "title_footage"):
        spec = KINDS[kind]
        LATENCY.clear()
        qs = [q for q in st["questions"] if q.get("kind") == spec["question"]][:a.n * 4]
        n = 0
        for q in qs:
            if n >= a.n:
                break
            r = ask(kind, q, 7, run_id)   # variant 7: an uncached request
            n += r not in (None, "noFrames")
        out[kind] = latency_summary()
        print(kind, out[kind], flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["gate", "run", "bench"])
    ap.add_argument("--kind", choices=list(KINDS))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--n", type=int, default=6, help="bench: calls per kind")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.cmd != "bench" and not a.kind:
        ap.error("--kind is required")
    try:
        return {"gate": cmd_gate, "run": cmd_run, "bench": cmd_bench}[a.cmd](a)
    except SetupNeeded:
        print("The local model server isn't ready: run the commands above, then re-run (answers are cached).", file=sys.stderr)
        return 6


if __name__ == "__main__":
    sys.exit(main())
