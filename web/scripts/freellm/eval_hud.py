#!/usr/bin/env python3
"""Quality gate: can the routed vision model (default: the local Ollama model) read battle nameplates
well enough to be a second reader for the extractor's HUD OCR?

Takes frames inside the hand-labelled battles of the YouTube benchmark videos
(tests/meta-benchmark/labels/youtube/*.json), crops ONLY the top HUD strip of the phone screen
(Pokémon names, CP, Poké Balls; no trainer names, no facecam), sends each strip through
freellm.py (--data public: Creative Commons uploads), and scores the names against the labels.

  python3 -I scripts/freellm/eval_hud.py [--per-battle 4] [--videos DIR] [--key llm_hud_names]
  python3 -I scripts/freellm/eval_hud.py read VIDEO x0,y0,x1,y1 T [T ...]   # second reader (needs the gate passed)

A model passes when precision >= 98% (a wrong name is worse than none) and it names >= 80% of the nameplates
on strips where the extractor's own HUD reader sees them (hud_present.cjs). Results are merged into
scripts/freellm/evals.json under --key (scores only, no images); `hud_names` holds the 2026-10-10 free-tier run.
"""
import argparse, json, time, subprocess, sys, tempfile, unicodedata, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LABELS = ROOT / "tests" / "meta-benchmark" / "labels" / "youtube"
FREELLM = Path(__file__).resolve().parent / "freellm.py"
EVALS = Path(__file__).resolve().parent / "evals.json"
PROMPT = ("This is the top strip of a Pokémon GO trainer battle screen. If it shows two white nameplates, "
          "reply with JSON {\"my\": <left nameplate's Pokémon name>, \"opponent\": <right nameplate's Pokémon name>}. "
          "Copy the names exactly as printed (e.g. \"Primal Kyogre\", \"Kommo-o\"). If no nameplates are visible, "
          "reply {\"my\": null, \"opponent\": null}.")
norm = lambda s: re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower())


def strip(video, box, t, out):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", "-vf",
                    f"crop={w}:{int(h * .13)}:{x0}:{y0},scale=886:-2", "-q:v", "3", str(out)], check=True)


def read(video, box, times, key="llm_hud_names"):
    """Second reader for low-confidence HUD OCR (question-free): the nameplates at each time, from two
    independent calls (seeds 0 and 1) that must agree; null where they don't. Refuses unless the
    nameplate gate (`key` in evals.json) passed. Prints one JSON line per time."""
    gate = (json.loads(EVALS.read_text()) if EVALS.exists() else {}).get(key) or {}
    if not gate.get("passed"):
        print(f"{key} has not passed (run eval_hud.py first)", file=sys.stderr)
        return 1
    tmp = Path(tempfile.mkdtemp())
    for t in times:
        img = tmp / f"{t:.2f}.jpg"
        strip(video, box, t, img)
        r = subprocess.run([sys.executable, "-I", str(FREELLM), "ask", PROMPT, "--image", str(img), "--json", "--agree", "2",
                            "--data", "private", "--task", "hud_read"], capture_output=True, text=True)
        img.unlink(missing_ok=True)
        if r.returncode == 6:
            print(r.stderr.strip(), file=sys.stderr)
            return 6
        ans = json.loads(r.stdout) if r.returncode == 0 else {}
        print(json.dumps({"t": t, "my": ans.get("my"), "opponent": ans.get("opponent"), "agreed": r.returncode == 0}), flush=True)
    return 0


def main():
    if sys.argv[1:2] == ["read"]:
        rp = argparse.ArgumentParser(prog="eval_hud.py read")
        rp.add_argument("video")
        rp.add_argument("box", help="phone screen x0,y0,x1,y1")
        rp.add_argument("times", nargs="+", type=float)
        r = rp.parse_args(sys.argv[2:])
        if Path(r.video).resolve().parent == (Path.home() / "Desktop/Projects/PoGo Recorder/src").resolve():
            print("refused: the owner's own recordings are never sent to a model", file=sys.stderr)
            return 4
        return read(Path(r.video), [int(x) for x in r.box.split(",")], r.times)
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-battle", type=int, default=4)
    ap.add_argument("--pace", type=float, default=0, help="seconds between requests (the free tiers needed ~6)")
    ap.add_argument("--videos", default=str(Path.home() / "Desktop/Projects/PoGo Recorder/src/youtube-cc"))
    ap.add_argument("--key", default="llm_hud_names", help="evals.json entry to write")
    a = ap.parse_args()
    tmp, t0, models, lat = Path(tempfile.mkdtemp()), time.time(), set(), []
    s = {"strips": 0, "shown": 0, "namedShown": 0, "named": 0, "right": 0, "wrong": [], "failed": 0, "providers": {}}
    for lf in sorted(LABELS.glob("*.json")):
        lab = json.loads(lf.read_text())
        if "battles" not in lab:
            continue  # edited videos have species lists only
        video = Path(a.videos) / lab["recording"]
        for b in lab["battles"]:
            for k in range(a.per_battle):
                t = b["start"] + 8 + (b["end"] - b["start"] - 16) * k / max(1, a.per_battle - 1)
                img = tmp / f"{lf.stem}_{b['n']}_{k}.jpg"
                strip(video, lab["screenBox"], t, img)
                shown = subprocess.run(["node", str(Path(__file__).resolve().parent / "hud_present.cjs"), str(video),
                                        ",".join(map(str, lab["screenBox"])), f"{t:.2f}"], capture_output=True, text=True).stdout.strip() == "1"
                s["shown"] += shown
                c0 = time.time()
                r = subprocess.run([sys.executable, "-I", str(FREELLM), "ask", PROMPT, "--image", str(img), "--json",
                                    "--data", "public", "--task", "eval_hud"], capture_output=True, text=True)
                s["strips"] += 1
                if r.returncode == 6:
                    print(r.stderr.strip(), file=sys.stderr)
                    return 6
                if "cache hit" not in r.stderr:
                    lat.append(time.time() - c0)
                time.sleep(a.pace)
                if r.returncode:
                    s["failed"] += 1
                    s["failedShown"] = s.get("failedShown", 0) + shown
                    continue
                who = re.search(r"answered by (\S+)(?: \(cached\))?(?: \(([^)]*)\))?", r.stderr)
                if who:
                    s["providers"][who.group(1)] = s["providers"].get(who.group(1), 0) + 1
                    if who.group(2):
                        models.add(who.group(2))
                ans = json.loads(r.stdout)
                for side, truth in (("my", b["my"]), ("opponent", b["opp"])):
                    if ans.get(side):
                        s["named"] += 1
                        s["namedShown"] += shown
                        if norm(ans[side]) in {norm(x) for x in truth}:
                            s["right"] += 1
                        else:
                            s["wrong"].append(f"{lf.stem} #{b['n']} t={t:.0f} {side}: {ans[side]}")
    precision = s["right"] / s["named"] if s["named"] else 0
    # Coverage counts only strips where the local HUD reader sees both nameplates (and an answer came back).
    answered_shown = s["shown"] - s.get("failedShown", 0)
    coverage = s["namedShown"] / (2 * answered_shown) if answered_shown > 0 else 0
    s.update(precision=round(precision, 3), coverage=round(coverage, 3), passed=precision >= .98 and coverage >= .8,
             date=time.strftime("%Y-%m-%d"), models=sorted(models), wallS=round(time.time() - t0),
             meanCallS=round(sum(lat) / len(lat), 2) if lat else None,
             costUSD=0.0 if set(s["providers"]) <= {"ollama"} else None)
    evals = json.loads(EVALS.read_text()) if EVALS.exists() else {}
    evals[a.key] = s   # merged: the other gates live in the same file
    EVALS.write_text(json.dumps(evals, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({k: v for k, v in s.items() if k != "wrong"}, indent=1))
    for w in s["wrong"][:20]:
        print("wrong:", w)
    return 0 if s["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
