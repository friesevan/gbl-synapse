"""Validation questions for harvested YouTube videos (site: Meta Extractor > Validate).

Every decision the pipeline could not settle becomes a short question with the moment to watch:
  - extractor questions (fast move, Shadow, form, result) come from tests/meta-benchmark/export-questions.cjs;
  - harvester questions (here): which league/cup a battle is in, and videos where no battle was found.
Each question carries `video` (YouTube id, link, channel, licence), so the Validate tab can play the
moment on YouTube when there is no local copy. No frames, descriptions or trainer names are stored.
The inbox (all open questions, one JSON file) is what the tab loads when the site runs locally.
"""
import datetime as dt
import json
import os
import re

SOURCE = "youtube-harvest"
CLOSE = 1.0   # league candidates within this score of the best are still in question


def safe_id(s):
    return re.sub(r"[^A-Za-z0-9_\-.~:@+]", "-", str(s))[:200]


def video_ref(vid, meta):
    return {"provider": "youtube", "id": vid, "url": f"https://www.youtube.com/watch?v={vid}",
            "title": meta.get("title"), "channel": meta.get("channel"), "license": meta.get("license"),
            "uploadDate": meta.get("uploadDate"), "durationS": meta.get("durationS")}


def decorate(doc, video):
    """Marks a question as harvested and links it to its YouTube video (times are video times)."""
    doc["source"] = SOURCE
    doc["video"] = video
    doc["recording"] = f"{video['id']}.mp4"
    doc.setdefault("attribution", {"channel": video.get("channel"), "url": video["url"],
                                   "license": video.get("license"), "uploadDate": video.get("uploadDate")})
    doc.pop("frames", None)
    doc["frames"] = []
    return doc


def _q(vid, qid, kind, title, detail, options, clip, battle=None, **kw):
    return {"qid": safe_id(f"{SOURCE}:{vid}.mp4:{qid}"), "createdAt": dt.datetime.now().isoformat(timespec="seconds"),
            "kind": kind, "side": "", "key": "", "battle": battle, "species": "", "title": title, "detail": detail,
            "options": options, "clip": [round(clip[0], 1), round(clip[1], 1)], "focus": "center", **kw}


def _league_options(opts):
    out = [{"value": o["id"], "label": o["name"] + (f" ({o['cp']} CP)" if o.get("cp") and o["cp"] < 10000 else ""),
            "hint": f"score {o['score']}"} for o in opts]
    return out + [{"value": "other", "label": "Another league or cup"}]


def harvest_questions(vid, result, meta, video_league, refined, schedule=None):
    """Harvester-level questions for one analysed video. Returns question documents (undecorated)."""
    out = []
    battles = result.get("battles") or []
    dur = float(meta.get("durationS") or result.get("videoSeconds") or 0)
    if not battles:
        t = max(0.0, dur * 0.25)
        out.append(_q(vid, "footage", "footage", "No battles found: does this video show Pokémon GO battles?",
                      "The Meta Extractor found no battle in this video. Either the phone screen wasn’t located "
                      "(unusual layout, overlays) or the video has no battle footage. Scrub through the video.",
                      [{"value": "battles", "label": "Yes, battles are shown", "hint": "The detector missed them"},
                       {"value": "partial", "label": "Only short clips or replays"},
                       {"value": "none", "label": "No battle footage"}], [t, t + 20], allBattles=True))
        return out
    rb = (refined or {}).get("battles") or []
    vguess, vconf = video_league.get("leagueGuess", "Unknown"), float(video_league.get("leagueConfidence") or 0)
    compilation = video_league.get("kindGuess") == "compilation"
    open_ = []
    for i, r in enumerate(rb[:len(battles)]):
        opts = r.get("options") or []
        close = [o for o in opts if opts and opts[0]["score"] - o["score"] < CLOSE]
        if len(close) > 1:
            open_.append((i, r, opts))
    bests = {r.get("best") for r in rb if r.get("best")}
    per_battle = compilation or len(bests) > 1
    if not per_battle and open_ and vconf < 0.9:
        # One question for the whole video, asked at its first ambiguous battle.
        i, r, opts = open_[0]
        b = battles[i]
        out.append(_q(vid, "league", "league", "Which league or cup are these battles in?",
                      f"The video looks like {vguess} ({round(vconf * 100)}% from the title and the GBL schedule). "
                      f"CPs seen: {', '.join(str(c) for c in r.get('cps', [])[:6]) or 'none read'}. "
                      "Pause at the start of a battle: the CPs and the teams usually settle it.",
                      _league_options(opts), [b.get("start", 0), b.get("start", 0) + 12], battle=i, allBattles=True,
                      modelTop=opts[0]["id"], modelP=None))
    elif per_battle:
        for i, r, opts in open_:
            b = battles[i]
            out.append(_q(vid, f"{i}:league", "league", f"Battle {i + 1}: which league or cup?",
                          f"{'This looks like a compilation, so each battle is checked. ' if compilation else ''}"
                          f"CPs seen: {', '.join(str(c) for c in r.get('cps', [])[:6]) or 'none read'}. "
                          "The CPs and the teams at the start of the battle usually settle it.",
                          _league_options(opts), [b.get("start", 0), b.get("start", 0) + 12], battle=i,
                          modelTop=opts[0]["id"], modelP=None))
    return out


def write_inbox(qroot, inbox_path):
    """Collects every harvested question into one file for the Validate tab (atomic write)."""
    if not inbox_path:
        return 0
    docs = []
    for vid in sorted(os.listdir(qroot)) if os.path.isdir(qroot) else []:
        d = os.path.join(qroot, vid)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.endswith(".json") and name != "manifest.json":
                try:
                    with open(os.path.join(d, name), encoding="utf-8") as f:
                        docs.append(json.load(f))
                except (OSError, ValueError):
                    continue
    docs.sort(key=lambda q: (str((q.get("video") or {}).get("uploadDate") or ""), q.get("qid")), reverse=True)
    os.makedirs(os.path.dirname(inbox_path), exist_ok=True)
    tmp = inbox_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"format": "meta-validation-inbox", "version": 1,
                   "generated": dt.datetime.now().isoformat(timespec="seconds"), "questions": docs}, f, ensure_ascii=False)
    os.replace(tmp, inbox_path)
    return len(docs)
