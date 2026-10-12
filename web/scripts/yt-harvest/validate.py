"""Validation questions for harvested YouTube videos (site: Meta Extractor > Validate).

Every decision the pipeline could not settle becomes a short question with the moment to watch:
  - extractor questions (fast move, Shadow, form, result) come from tests/meta-benchmark/export-questions.cjs;
  - harvester questions (here): Team Rocket flags, championship perspective, opponent leads, and videos where no
    battle was found. Never the league or cup: the league comes from the CPs, the cup from the video's text.
Each question carries `video` (YouTube id, link, channel, licence), so the Validate tab can play the
moment on YouTube when there is no local copy. No frames, descriptions or trainer names are stored.
The inbox (all open questions, one JSON file) is what the tab loads when the site runs locally.
"""
import datetime as dt
import json
import os
import re

SOURCE = "youtube-harvest"
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


# "gbl" clears the automatic flag without naming a cup (feedback.py and observed.py treat it like "other").
NOT_ROCKET_OPTION = {"value": "gbl", "label": "Not Team Rocket (a GBL battle)", "hint": "Counts toward the observed meta"}


def _rocket_options():
    return [ROCKET_OPTION, NOT_ROCKET_OPTION]


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
                          _rocket_options(), [battles[i].get("start", 0), battles[i].get("start", 0) + 12],
                          battle=i, allBattles=True, modelTop="rocket", modelP=None))
        else:
            for i in rocket[:3]:
                out.append(_q(vid, f"{i}:rocket", "league", f"Battle {i + 1}: a Team Rocket battle?",
                              f"{'; '.join(rb[i].get('rocketReasons') or [])}. Rocket battles train the extractor but are "
                              "left out of the observed meta.",
                              _rocket_options(), [battles[i].get("start", 0), battles[i].get("start", 0) + 12],
                              battle=i, modelTop="rocket", modelP=None))
    out += lead_questions(vid, battles, skip=set(rocket), full=result.get("full"))
    # No league/cup questions: a reviewer cannot verify a cup from the footage. The league comes from the CPs and the
    # cup from the video's text (league.battle_cup); the Team Rocket question above stays, since that is verifiable.
    return out


_GM = {}


def _species_names():
    """{speciesId: "Ninetales (Alolan)"} from the PvPoke gamemaster ({} when it is unavailable)."""
    if "names" not in _GM:
        try:
            import league
            _GM["names"] = {k: v.get("speciesName") for k, v in league.load_gamemaster().items() if v.get("speciesName")}
        except (OSError, ValueError, KeyError):
            _GM["names"] = {}
    return _GM["names"]


def member_key(name):
    """The observed-meta member key of a detected name (observed._member: label lowercased, spaces removed)."""
    return str(name or "").lower().replace(" ", "")


def lead_label(name, detail, names=None):
    """The fullest identity known for a detected opponent: "Shadow Ninetales (Alolan)" when the form and the Shadow
    status are settled (form p >= .98; Shadow p >= .98), the form alone otherwise, else the detected name."""
    detail = detail if isinstance(detail, dict) else {}
    form = detail.get("form") or {}
    fid, p = str(form.get("id") or detail.get("formId") or ""), form.get("p")
    shadow = fid.endswith("_shadow")
    fid = fid.removesuffix("_shadow")
    names = _species_names() if names is None else names
    label = names.get(fid) if fid and (p is None or p >= .98) else None
    sp = detail.get("shadowP")
    if label and (shadow or (isinstance(sp, (int, float)) and sp >= .98)):
        label = "Shadow " + label
    return label or name


def lead_questions(vid, battles, skip=(), full=None):
    """Opponent lead confirmations for complete, cleanly started teams (observed meta lists a team with
    its lead only when the lead is confirmed). At most LEAD_QUESTIONS_PER_VIDEO per video. Options show the
    full identity (lead_label); their values are the member keys, which observed.py matches (as it still
    matches older answers' species names)."""
    out = []
    full = full if isinstance(full, list) else []
    for i, b in enumerate(battles):
        if len(out) >= LEAD_QUESTIONS_PER_VIDEO:
            break
        opp = [n for n in b.get("opponent") or [] if n]
        flags = " ".join(b.get("flags") or [])
        if i in skip or len(opp) != 3 or len(set(opp)) != 3 or re.search(r"mid-battle|More than three", flags):
            continue
        details = [d for d in b.get("opponentDetail") or [] if isinstance(d, dict)]
        fb = (full[i] if i < len(full) and isinstance(full[i], dict) else {}).get("opponent") or []
        keyed = {str(m.get("label") or m.get("name") or ""): m.get("key") for m in fb if isinstance(m, dict) and m.get("key")}
        opts = []
        for j, n in enumerate(opp):
            d = details[j] if j < len(details) and details[j].get("name") in (None, n) else \
                next((x for x in details if x.get("name") == n), {})
            opts.append({"value": keyed.get(n) or member_key(n), "label": lead_label(n, d), "name": n})
        out.append(_q(vid, f"{i}:lead", "lead", f"Battle {i + 1}: which Pokémon did the opponent lead with?",
                      f"Detected opponent team, in order of appearance: {', '.join(o['label'] for o in opts)}. The lead "
                      "is the first Pokémon on the opponent's side when the battle starts.",
                      opts + [{"value": "other", "label": "Another Pokémon"}],
                      [b.get("start", 0), b.get("start", 0) + 10], battle=i, modelTop=opts[0]["value"], modelP=None))
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


WITHDRAWN_REASON = "withdrawn: cup is taken from the video text"


def is_cup_question(q):
    """A league/cup question (asked before the cup came from the video text); the Team Rocket flag is not one."""
    return q.get("kind") == "league" and not str(q.get("qid") or "").endswith(":rocket")


def withdraw_league_questions(work_dir, inbox_path=None, backup_dir=None, dry_run=False):
    """Takes the open league/cup questions out of the Validate queue (policy: a reviewer cannot verify a cup; the cup
    comes from the video's text). Each question file is MOVED from validation/<id>/ into backup_dir, which keeps a
    manifest of {"qid", "reason", "source": "policy"} records: reversible (move the files back, rebuild the inbox), and
    never a resolution, so no metric counts it as model-resolved. Answered or resolved questions stay, with their
    labels. feedback.json is only read. The inbox loses exactly the withdrawn questions. Returns a summary."""
    import shutil
    qroot = os.path.join(work_dir, "validation")
    try:
        with open(os.path.join(work_dir, "feedback.json"), encoding="utf-8") as f:
            fb = json.load(f)
    except (OSError, ValueError):
        fb = {}
    settled = set(fb.get("answers") or {}) | set(fb.get("resolutions") or {})
    backup_dir = backup_dir or os.path.join(work_dir, "validation-withdrawn-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    records, kept = [], 0
    for vid in sorted(os.listdir(qroot)) if os.path.isdir(qroot) else []:
        d = os.path.join(qroot, vid)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".json") or name == "manifest.json":
                continue
            try:
                with open(os.path.join(d, name), encoding="utf-8") as f:
                    q = json.load(f)
            except (OSError, ValueError):
                continue
            if not isinstance(q, dict) or not is_cup_question(q):
                continue
            if q.get("qid") in settled:
                kept += 1
                continue
            records.append({"qid": q.get("qid"), "videoId": vid, "file": os.path.join(vid, name), "reason": WITHDRAWN_REASON,
                            "source": "policy", "withdrawnAt": dt.datetime.now().isoformat(timespec="seconds")})
            if not dry_run:
                os.makedirs(os.path.join(backup_dir, vid), exist_ok=True)
                shutil.move(os.path.join(d, name), os.path.join(backup_dir, vid, name))
    removed = 0
    if records and not dry_run:
        with open(os.path.join(backup_dir, "withdrawn.json"), "w", encoding="utf-8") as f:
            json.dump({"reason": WITHDRAWN_REASON, "source": "policy", "questions": records}, f, ensure_ascii=False, indent=1)
        if inbox_path and os.path.exists(inbox_path):
            with open(inbox_path, encoding="utf-8") as f:
                inbox = json.load(f)
            gone = {r["qid"] for r in records}
            before = len(inbox.get("questions") or [])
            inbox["questions"] = [q for q in inbox.get("questions") or [] if q.get("qid") not in gone]
            removed = before - len(inbox["questions"])
            tmp = inbox_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(inbox, f, ensure_ascii=False)
            os.replace(tmp, inbox_path)
    return {"withdrawn": len(records), "keptAnswered": kept, "inboxRemoved": removed,
            "backup": backup_dir if records and not dry_run else None, "dryRun": dry_run}


if __name__ == "__main__":
    import argparse
    import sys
    ap = argparse.ArgumentParser(prog="validate.py withdraw-league", description=withdraw_league_questions.__doc__)
    ap.add_argument("command", choices=["withdraw-league"])
    ap.add_argument("work_dir")
    ap.add_argument("--inbox", default=os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                                                     "tests", "meta-benchmark", "results", "validation-inbox.json")))
    ap.add_argument("--backup-dir", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(sys.argv[1:])
    print(json.dumps(withdraw_league_questions(a.work_dir, a.inbox, a.backup_dir, a.dry_run), indent=1))
