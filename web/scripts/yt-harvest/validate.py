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
CLOSE = 1.0
# Footage answers. "rocket" and "championship" battles look like GBL and train the extractor (fast
# moves, Shadow, outcomes) but never count toward the GBL meta; championships get their own format.
# "obscured": real battles, but an overlay hides part of the screen, so the video can't be analysed.
FOOTAGE_OPTIONS = [
    {"value": "battles", "label": "Yes, GBL battles are shown", "hint": "The detector missed them"},
    {"value": "rocket", "label": "Team Rocket battles", "hint": "Training only, not meta. Opponent CPs often exceed the league cap"},
    {"value": "championship", "label": "Championship / tournament", "hint": "Invite-only event; often both players' screens"},
    {"value": "obscured", "label": "Battles, but the screen is obscured", "hint": "Overlay or facecam covers the HUD"},
    {"value": "partial", "label": "Only short clips or replays"},
    {"value": "none", "label": "No battle footage"},
]
REPROCESS = ("battles", "partial", "rocket", "championship")
# League answer for one battle (or the whole video): Team Rocket. Training only, never observed meta.
ROCKET_OPTION = {"value": "rocket", "label": "Team Rocket battle", "hint": "Grunt/leader: training only, not meta"}
# Championship broadcasts show both phones; the answer picks the side treated as the creator's team.
PERSPECTIVE_OPTIONS = [
    {"value": "left", "label": "Left screen's player", "hint": "Their team counts as the creator side"},
    {"value": "right", "label": "Right screen's player", "hint": "Their team counts as the creator side"},
    {"value": "single", "label": "Only one phone screen is shown"},
    {"value": "switches", "label": "The broadcast switches between players"},
    {"value": "gbl", "label": "Not a championship (ordinary GBL battles)"},
]
LEAD_QUESTIONS_PER_VIDEO = 2


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
    return out + [ROCKET_OPTION, {"value": "other", "label": "Another league or cup"}]


def _rocket_options(opts):
    return [ROCKET_OPTION] + [o for o in _league_options(opts) if o["value"] != "rocket"]


def harvest_questions(vid, result, meta, video_league, refined, schedule=None):
    """Harvester-level questions for one analysed video. Returns question documents (undecorated)."""
    out = []
    battles = result.get("battles") or []
    dur = float(meta.get("durationS") or result.get("videoSeconds") or 0)
    probe = result.get("probe") or {}
    if not battles:
        t = max(0.0, dur * 0.25)
        if probe and not probe.get("hits"):
            detail = (f"A quick scan of {probe.get('samples') or 0} keyframes found no battle HUD (nameplates and Poké Balls)"
                      f"{'; the phone screen was not located' if not probe.get('box') else ''}, so the full analysis was skipped. "
                      "Either the layout is unusual (overlays, two screens) or the video has no battle footage. Scrub through the video.")
        elif probe and probe.get("hits"):
            first = (probe.get("ranges") or [{}])[0].get("start", t)
            t = float(first or t)
            detail = (f"The quick scan saw a battle HUD in {probe['hits']} keyframes, but the full analysis found no complete "
                      "battle. Check the moment shown: an overlay may hide part of the screen.")
        else:
            detail = ("The Meta Extractor found no battle in this video. Either the phone screen wasn’t located "
                      "(unusual layout, overlays) or the video has no battle footage. Scrub through the video.")
        out.append(_q(vid, "footage", "footage", "No battles found: does this video show Pokémon GO battles?",
                      detail, FOOTAGE_OPTIONS, [t, t + 20], allBattles=True))
        return out
    rb = (refined or {}).get("battles") or []
    rv = (refined or {}).get("video") or {}
    championship = bool(rv.get("championship") or video_league.get("championship"))
    if championship or rv.get("possibleChampionship") or video_league.get("possibleChampionship"):
        b = battles[0]
        why = "; ".join((rv.get("championshipEvidence") or video_league.get("championshipEvidence") or [])[:2])
        screens = rv.get("screens") or len(probe.get("screens") or [])
        out.append(_q(vid, "perspective", "perspective", "Championship footage: whose team is the creator side?",
                      ("This looks like a championship or tournament broadcast"
                       + (f" ({why})" if why else "") + (f"; {screens} phone screens were found" if screens >= 2 else "") + ". "
                       "Championship battles get their own format, separate from GBL. Pick the player whose screen should count as "
                       "‘my’ team; a left/right answer re-analyses that screen."),
                      PERSPECTIVE_OPTIONS, [b.get("start", 0), b.get("start", 0) + 15], battle=0, allBattles=True,
                      modelTop="left" if screens >= 2 else "single", modelP=None))
    rocket = [i for i, r in enumerate(rb[:len(battles)]) if r.get("rocket")]
    if rocket:
        # Auto-flagged Team Rocket battles: one question when every battle is flagged, else per battle.
        if len(rocket) == len(battles) and len(battles) > 1:
            i = rocket[0]
            out.append(_q(vid, "rocket", "league", "These look like Team Rocket battles. Confirm?",
                          f"Opponent CPs no player's Pokémon can reach: {'; '.join(rb[i].get('rocketReasons') or [])}. "
                          "Rocket battles still train fast moves, Shadow and outcomes, but never count toward the GBL meta.",
                          _rocket_options(rb[i].get("options") or []), [battles[i].get("start", 0), battles[i].get("start", 0) + 12],
                          battle=i, allBattles=True, modelTop="rocket", modelP=None))
        else:
            for i in rocket[:3]:
                out.append(_q(vid, f"{i}:rocket", "league", f"Battle {i + 1}: a Team Rocket battle?",
                              f"{'; '.join(rb[i].get('rocketReasons') or [])}. Rocket battles train the extractor but are "
                              "left out of the observed meta.",
                              _rocket_options(rb[i].get("options") or []), [battles[i].get("start", 0), battles[i].get("start", 0) + 12],
                              battle=i, modelTop="rocket", modelP=None))
    out += lead_questions(vid, battles, skip=set(rocket))
    if championship:
        return out   # the format is Championship; the GBL league/cup question does not apply
    vguess, vconf = video_league.get("leagueGuess", "Unknown"), float(video_league.get("leagueConfidence") or 0)
    compilation = video_league.get("kindGuess") == "compilation"
    open_ = []
    for i, r in enumerate(rb[:len(battles)]):
        if r.get("rocket"):
            continue
        opts = r.get("options") or []
        close = [o for o in opts if opts and opts[0]["score"] - o["score"] < CLOSE]
        if len(close) > 1:
            open_.append((i, r, opts))
    bests = {r.get("best") for r in rb if r.get("best") and not r.get("rocket")}
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


def lead_questions(vid, battles, skip=()):
    """Opponent lead confirmations for complete, cleanly started teams (observed meta lists a team with
    its lead only when the lead is confirmed). At most LEAD_QUESTIONS_PER_VIDEO per video."""
    out = []
    for i, b in enumerate(battles):
        if len(out) >= LEAD_QUESTIONS_PER_VIDEO:
            break
        opp = [n for n in b.get("opponent") or [] if n]
        flags = " ".join(b.get("flags") or [])
        if i in skip or len(opp) != 3 or len(set(opp)) != 3 or re.search(r"mid-battle|More than three", flags):
            continue
        out.append(_q(vid, f"{i}:lead", "lead", f"Battle {i + 1}: which Pokémon did the opponent lead with?",
                      f"Detected opponent team, in order of appearance: {', '.join(opp)}. The lead is the first Pokémon "
                      "on the opponent's side when the battle starts.",
                      [{"value": n, "label": n} for n in opp] + [{"value": "other", "label": "Another Pokémon"}],
                      [b.get("start", 0), b.get("start", 0) + 10], battle=i, modelTop=opp[0], modelP=None))
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
