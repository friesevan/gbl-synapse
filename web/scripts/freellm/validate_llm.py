#!/usr/bin/env python3
"""Answer simple Validate questions with free-tier vision models, behind a quality gate.

  validate_llm.py gate --kind footage|result [--limit N]    score against the owner's answers -> evals.json
  validate_llm.py run  --kind footage|result [--limit N] [--dry-run]   resolve open questions

Frames are private (non-Creative-Commons YouTube footage): they only go to providers with
trains=false in providers.json (Groq, and OpenRouter with data_collection=deny), cropped and
downscaled, with trainer-name areas blacked out. No answers, titles or names are sent.

Agreement: the first provider (Groq) answers every question; only when its answer is one this kind
may resolve is the second provider asked. A question resolves only when both give the same answer
(two providers, like freellm.py --agree 2), the kind passed its gate (evals.json, >= 95% precision),
and the question is not a spot check. Resolutions go to the local app as source "freellm"
(POST /api/validation/resolve): reversible, shown as "Free LLM", never training labels; human answers win.
Frames and answers are cached in ~/.cache/freellm (never in the project).
"""
import argparse, hashlib, json, math, os, re, sqlite3, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
FREELLM = HERE / "freellm.py"
EVALS = HERE / "evals.json"
WORK = Path(os.environ.get("YT_HARVEST_WORK", Path.home() / "Desktop/Projects/PoGo Recorder/src/yt-harvest"))
RELABEL = WORK.parent / "relabel-cache"
FRAMES = Path(os.environ.get("FREELLM_CACHE", Path.home() / ".cache" / "freellm")) / "validate-frames"
APP = os.environ.get("GBL_APP", "http://localhost:65246")
PROVIDERS = ["groq", "openrouter-nolog"]   # first answers everything; second confirms resolvable answers
GATE = {"precision": 0.95, "minResolved": 10}

KINDS = {
    "footage": {
        # Only answers that need no pipeline action may resolve; "battles"/"rocket"/... need a reprocess.
        "resolvable": {"none"},
        "prompt": (
            "These are three frames from a YouTube video, taken at 25%, 50% and 75% of its length "
            "(left to right). The video was found by a search for Pokémon GO PvP. Does it show Pokémon GO "
            "trainer battles? Signs of a trainer battle, even in a small phone screen next to overlays or a face "
            "camera: two Pokémon facing each other with HP bars at the top and move buttons at the bottom; the "
            "charged-attack tapping screen (\"Excellent!\", \"Great!\", \"Nice!\"); the shield prompt; the "
            "\"GO\" countdown or the VS screen; the \"YOU WIN\"/\"GOOD EFFORT\" end screen. Raids, Max battles, "
            "gyms, the map, catching, menus, Pokémon lists, a person talking or another game are NOT trainer battles.\n"
            "Reply with JSON {\"answer\": X} where X is one of:\n"
            "\"battles\" - a trainer battle against another player is visible in at least one frame;\n"
            "\"rocket\" - a battle against Team Rocket (grunt, leader or Giovanni) is visible;\n"
            "\"championship\" - a tournament broadcast (two phone screens side by side, casters, a stage);\n"
            "\"obscured\" - a trainer battle is there but overlays or a face camera cover the battle screen;\n"
            "\"none\" - none of the three frames shows anything from a Pokémon GO trainer battle;\n"
            "\"unsure\" - you can't tell."),
    },
    "result": {
        "resolvable": {"Win", "Win:opponent-forfeit", "Loss", "Loss:you-forfeit", "Tie"},
        "prompt": (
            "These frames come from a Pokémon GO trainer battle recorded by the player (\"you\"), whose Pokémon "
            "is at the bottom/left side, the opponent's at the top/right. They are taken around the end of one "
            "battle, in time order left to right. Who won? Look for the end screen text (\"YOU WIN\", "
            "\"GOOD EFFORT\" = you lost, \"TIE\") or whose last Pokémon fainted.\n"
            "Reply with JSON {\"answer\": X} where X is one of:\n"
            "\"Win\" - the opponent's last Pokémon fainted, or YOU WIN is shown;\n"
            "\"Win:opponent-forfeit\" - you won while the opponent still had Pokémon left (they forfeited or left);\n"
            "\"Loss\" - your last Pokémon fainted, or GOOD EFFORT is shown;\n"
            "\"Loss:you-forfeit\" - you forfeited or left while you still had Pokémon;\n"
            "\"Tie\" - both last Pokémon fainted together, or TIE is shown;\n"
            "\"unsure\" - the frames don't show it clearly."),
    },
}


# ---------- questions and labels ----------

def fetch_state():
    """Open questions, answers and resolutions from the running app (read-only GET)."""
    req = urllib.request.Request(APP + "/api/validation", headers={"Origin": APP, "Sec-Fetch-Site": "same-origin"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def human(a):
    return a and a.get("value") is not None and a.get("source") not in ("model", "freellm") and not a.get("modelResolved")


def video_id(q):
    return (q.get("video") or {}).get("id") or str(q.get("recording") or "").removesuffix(".mp4")


def local_video(vid):
    try:
        db = sqlite3.connect(f"file:{WORK / 'state.sqlite'}?mode=ro", uri=True)
        row = db.execute("select dl_path from videos where id=?", (vid,)).fetchone()
        db.close()
    except sqlite3.Error:
        row = None
    for p in ([row[0]] if row and row[0] else []) + [str(RELABEL / (vid + ".mp4"))]:
        if p and Path(p).exists():
            return Path(p)
    return None


# ---------- frames ----------

def ffmpeg(args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True, timeout=120)


def footage_frames(q):
    """YouTube's public auto-thumbnails hq1-3 (frames at 25/50/75%), downscaled side by side."""
    vid = video_id(q)
    out = FRAMES / "footage" / (vid + ".jpg")
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    parts = []
    for n in (1, 2, 3):
        f = out.with_name(f"{vid}.hq{n}.jpg")
        if not f.exists():
            try:
                with urllib.request.urlopen(f"https://i.ytimg.com/vi/{vid}/hq{n}.jpg", timeout=30) as r:
                    f.write_bytes(r.read())
            except urllib.error.HTTPError:
                return None
            time.sleep(0.3)
        parts.append(f)
    ffmpeg([x for f in parts for x in ("-i", str(f))] + ["-filter_complex",
           "".join(f"[{i}]scale=360:270,setsar=1[v{i}];" for i in range(3)) + "[v0][v1][v2]hstack=inputs=3", "-q:v", "4", str(out)])
    for f in parts:
        f.unlink(missing_ok=True)
    return out


def result_frames(q):
    """Up to six frames from 6 s before to 10 s after the battle end, from the local copy: phone
    screen only, 216 px wide. In-battle HUDs show Pokémon names, not trainer names; frames close to
    the next battle (its VS screen names both trainers) are left out. None without a local video."""
    vid = video_id(q)
    key = hashlib.sha256(q["qid"].encode()).hexdigest()[:16]
    out = FRAMES / "result" / (key + ".jpg")
    if out.exists():
        return out
    video = local_video(vid)
    res = WORK / "results" / (vid + ".json")
    if not video or not res.exists():
        return None
    r = json.loads(res.read_text())
    x, y, x1, y1 = r.get("crop") or [0, 0, 0, 0]   # phone screen box [x0, y0, x1, y1]
    w, h = x1 - x, y1 - y
    if w <= 0 or h <= 0:
        return None
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", str(video)], capture_output=True, text=True, timeout=60).stdout.strip().split(",")
    if len(probe) < 2 or x1 > int(probe[0]) or y1 > int(probe[1]):
        return None   # a re-encoded copy at another size: the saved screen box doesn't apply
    end = q["clip"][0] + 2   # questions.js: clip = [end - 2, end + 14]
    battles = r.get("battles") or []
    nxt = next((b["start"] for b in battles if b.get("start", 0) > end), None)
    # The last seconds of the battle (whose Pokémon are left, HP) and just after the end. Nothing
    # later: the next battle's VS screen shows both trainer names.
    times = [t for t in (end - 8, end - 5, end - 2.5, end - 0.5, end + 1.5, end + 4, end + 7, end + 10)
             if nxt is None or t < nxt - 6][-6:]
    if len(times) < 3:
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = []
    for i, t in enumerate(times):
        f = out.with_name(f"{key}.{i}.jpg")
        # Phone screen only (no facecam/overlays), scaled small.
        try:
            ffmpeg(["-ss", f"{max(0, t):.2f}", "-i", str(video), "-frames:v", "1", "-vf",
                    f"crop={w}:{h}:{x}:{y},scale=216:-2", str(f)])
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
    return out


FRAME_BUILDERS = {"footage": footage_frames, "result": result_frames}


def title_says_no(q):
    """Footage: the harvester's title policy (policy.py) also calls the video irrelevant. Three
    thumbnails can miss battles shown elsewhere in a video; the title is an independent second signal."""
    sys.path.insert(0, str(HERE.parent / "yt-harvest"))
    import policy
    v = q.get("video") or {}
    return policy.relevance(v.get("title") or "", v.get("durationS"))[1] == "no"


PREFILTER = {"footage": title_says_no, "result": lambda q: True}


def spot_check(qid, share=10):
    """Keep about 1 in `share` resolvable questions open so the owner keeps measuring precision."""
    return int(hashlib.sha256(("spot:" + qid).encode()).hexdigest(), 16) % share == 0


# ---------- asking ----------

def ask(kind, image, provider):
    """One provider's answer (cached by freellm.py), or None."""
    r = subprocess.run([sys.executable, "-I", str(FREELLM), "ask", KINDS[kind]["prompt"], "--image", str(image), "--json",
                        "--data", "private", "--provider", provider, "--task", "validate_" + kind, "--wait", "300"],
                       capture_output=True, text=True, timeout=900)
    if r.returncode:
        return None
    try:
        ans = json.loads(r.stdout).get("answer")
    except (ValueError, AttributeError):
        return None
    return ans if isinstance(ans, str) else None


def coarse(kind, value):
    """Human values map onto what the model can answer (forfeits count as the parent Win/Loss)."""
    if kind == "result":
        return str(value).split(":")[0]
    return value


def decide(kind, q, image, second=True):
    first = ask(kind, image, PROVIDERS[0])
    out = {PROVIDERS[0]: first}
    if second and first in KINDS[kind]["resolvable"]:
        out[PROVIDERS[1]] = ask(kind, image, PROVIDERS[1])
    agreed = first if first in KINDS[kind]["resolvable"] and out.get(PROVIDERS[1]) == first else None
    return agreed, out


def wilson_lower(k, n, z=1.96):
    if not n:
        return 0.0
    p = k / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


# ---------- commands ----------

def cmd_gate(a):
    st = fetch_state()
    qs = {q["qid"]: q for q in st["questions"] if q.get("kind") == a.kind}
    items = [(qs[qid], ans) for qid, ans in st["answers"].items() if qid in qs and human(ans)]
    items.sort(key=lambda x: hashlib.sha256(video_id(x[0]).encode()).hexdigest())
    if a.limit:
        items = items[:a.limit]
    rows, skipped = [], 0
    for q, ans in items:
        if not PREFILTER[a.kind](q):
            rows.append({"video": video_id(q), "truth": coarse(a.kind, ans["value"]), "exact": ans["value"], "agreed": None, "per": {}})
            continue
        img = FRAME_BUILDERS[a.kind](q)
        if not img:
            skipped += 1
            continue
        agreed, per = decide(a.kind, q, img, second=not a.first_only)
        if a.first_only:   # screening one provider: its resolvable answers, not an agreement
            agreed = per[PROVIDERS[0]] if per[PROVIDERS[0]] in KINDS[a.kind]["resolvable"] else None
        rows.append({"video": video_id(q), "truth": coarse(a.kind, ans["value"]), "exact": ans["value"], "agreed": agreed, "per": per})
        print(f"{len(rows):3} truth={ans['value']:<22} agreed={agreed!s:<8} " + " ".join(f"{k}={v}" for k, v in per.items()), flush=True)
    s = {"date": time.strftime("%Y-%m-%d"), "labelled": len(items), "noFrames": skipped, "evaluated": len(rows),
         "videos": len({r["video"] for r in rows}), "providers": {}, "resolvable": sorted(KINDS[a.kind]["resolvable"])}
    for p in PROVIDERS:
        got = [r for r in rows if r["per"].get(p) not in (None, "unsure") and p in r["per"]]
        s["providers"][p] = {"asked": sum(p in r["per"] for r in rows), "answered": len(got),
                             "right": sum(r["per"][p] == r["truth"] for r in got)}
    res = [r for r in rows if r["agreed"]]
    right = sum(r["agreed"] == r["truth"] for r in res)
    exact = sum(r["agreed"] == r["exact"] for r in res)
    s.update(resolved=len(res), right=right, exactRight=exact,
             precision=round(right / len(res), 3) if res else 0, exactPrecision=round(exact / len(res), 3) if res else 0,
             wilsonLower=round(wilson_lower(right, len(res)), 3), coverage=round(len(res) / len(rows), 3) if rows else 0,
             wrong=[f"{r['video']}: said {r['agreed']}, owner {r['exact']}" for r in res if r["agreed"] != r["exact"]])
    # The gate counts exact matches: a forfeit resolved as a plain Win would lose the forfeit label.
    s["passed"] = not a.first_only and bool(len(res) >= GATE["minResolved"] and s["exactPrecision"] >= GATE["precision"])
    evals = json.loads(EVALS.read_text()) if EVALS.exists() else {}
    evals["validate_" + a.kind + ("_screen_" + PROVIDERS[0] if a.first_only else "")] = s
    EVALS.write_text(json.dumps(evals, indent=1))
    print(json.dumps({k: v for k, v in s.items() if k != "wrong"}))
    for w in s["wrong"][:10]:
        print("wrong:", w)
    return 0 if s["passed"] else 1


def cmd_run(a):
    gate = (json.loads(EVALS.read_text()) if EVALS.exists() else {}).get("validate_" + a.kind) or {}
    if not gate.get("passed"):
        print(f"validate_{a.kind} has not passed its gate (run gate first); nothing resolved.")
        return 1
    st = fetch_state()
    done = set(st["answers"]) | set(st["resolutions"])
    open_qs = [q for q in st["questions"] if q.get("kind") == a.kind and q["qid"] not in done and not q.get("audit")]
    if a.limit:
        open_qs = open_qs[:a.limit]
    t0, out = time.time(), []
    stats = {"open": len(open_qs), "prefiltered": 0, "noFrames": 0, "unresolved": 0, "agreed": 0, "keptAsSpotCheck": 0}
    for q in open_qs:
        if not PREFILTER[a.kind](q):
            stats["prefiltered"] += 1
            continue
        img = FRAME_BUILDERS[a.kind](q)
        if not img:
            stats["noFrames"] += 1
            continue
        agreed, per = decide(a.kind, q, img)
        if not agreed:
            stats["unresolved"] += 1
            continue
        stats["agreed"] += 1
        if spot_check(q["qid"]):
            stats["keptAsSpotCheck"] += 1
            continue
        out.append({"qid": q["qid"], "value": agreed, "source": "freellm", "providers": list(per), "agreement": 2,
                    "task": "validate_" + a.kind,
                    "gate": {k: gate.get(k) for k in ("date", "precision", "resolved", "coverage")},
                    "reason": f"Free LLMs {' and '.join(per)} agreed; gate {gate.get('date')}: "
                              f"{gate.get('exactRight')}/{gate.get('resolved')} right on the owner's answers."})
    stats["seconds"] = round(time.time() - t0)
    if out and not a.dry_run:
        body = json.dumps({"resolutions": out}).encode()
        req = urllib.request.Request(APP + "/api/validation/resolve", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Origin": APP, "Sec-Fetch-Site": "same-origin"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = json.load(r)
            stats.update(saved=resp.get("saved"), skipped=len(resp.get("skipped") or []))
        except urllib.error.HTTPError as e:
            stats["submitError"] = f"{e.code}: restart the app to load /api/validation/resolve, then re-run (answers are cached)" if e.code == 404 else str(e.code)
    print(json.dumps(stats))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["gate", "run"])
    ap.add_argument("--kind", choices=sorted(KINDS), required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--first-only", action="store_true", help="gate: screen the first provider alone (saves the second's quota)")
    a = ap.parse_args()
    return {"gate": cmd_gate, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
