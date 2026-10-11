#!/usr/bin/env python3
"""Quality gate: can a free vision model read battle nameplates well enough to pre-label videos?

Takes frames inside the hand-labelled battles of the YouTube benchmark videos
(tests/meta-benchmark/labels/youtube/*.json), crops ONLY the top HUD strip of the phone screen
(Pokémon names, CP, Poké Balls; no trainer names, no facecam), sends each strip through
freellm.py (--data public: Creative Commons uploads), and scores the names against the labels.

  python3 -I scripts/freellm/eval_hud.py [--per-battle 4] [--videos DIR]

A model passes when precision >= 98% (a wrong name is worse than none) and it names >= 80% of the nameplates
on strips where the extractor's own HUD reader sees them (hud_present.cjs). Results go to scripts/freellm/evals.json (scores only, no images).
"""
import argparse, json, time, subprocess, sys, tempfile, unicodedata, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LABELS = ROOT / "tests" / "meta-benchmark" / "labels" / "youtube"
FREELLM = Path(__file__).resolve().parent / "freellm.py"
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-battle", type=int, default=4)
    ap.add_argument("--pace", type=float, default=6, help="seconds between requests")
    ap.add_argument("--videos", default=str(Path.home() / "Desktop/Projects/PoGo Recorder/src/youtube-cc"))
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp())
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
                r = subprocess.run([sys.executable, "-I", str(FREELLM), "ask", PROMPT, "--image", str(img), "--json",
                                    "--data", "public", "--task", "eval_hud"], capture_output=True, text=True)
                s["strips"] += 1
                time.sleep(a.pace)  # stay under the free tiers' per-minute limits
                if r.returncode:
                    s["failed"] += 1
                    s["failedShown"] = s.get("failedShown", 0) + shown
                    continue
                who = re.search(r"answered by (\S+)", r.stderr)
                if who:
                    s["providers"][who.group(1)] = s["providers"].get(who.group(1), 0) + 1
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
    s.update(precision=round(precision, 3), coverage=round(coverage, 3), passed=precision >= .98 and coverage >= .8)
    (Path(__file__).resolve().parent / "evals.json").write_text(json.dumps({"hud_names": s}, indent=1))
    print(json.dumps({k: v for k, v in s.items() if k != "wrong"}, indent=1))
    for w in s["wrong"][:20]:
        print("wrong:", w)
    return 0 if s["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
