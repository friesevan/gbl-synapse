"""League/cup inference for YouTube battle videos.

1. guess_league(meta, schedule): before analysis, from upload date (GBL schedule, with upload lag),
   title, tags, description and chapter titles -> leagueGuess, confidence, evidence, kindGuess.
2. refine_battle_league(observed, candidates, schedule, gamemaster): AFTER the Meta Extractor has
   analysed a battle, narrow the league per battle from observed CPs and species (cups whose
   rules the observed teams violate are eliminated). Usable from Node by shelling out:
       python3 -I league.py refine '{"cps":[1498,1500],"species":["medicham","azumarill"]}' 2025-01-10
   prints JSON with the ranked surviving formats.
3. refine_video / refine-all WORK_DIR [--dry-run] [--backup-dir D] [--web-root W]: the *.leagues.json sidecar of an
   analysed video, and a rewrite of all of them from the stored results with the current rules (no re-analysis; only
   sidecars are written, each existing one backed up first).

Owner's policy (2026-10-12): the LEAGUE of a battle comes from its CPs (the video shows them). The CUP cannot be seen
in the video, so it comes only from the video's text (text_cups / battle_cup): an exact cup name in the title (1.0),
tags (0.8), chapter titles (0.7), description (0.45), +0.1 per further source; several cups at the battle's CP share
the score (top^2 / sum); compilations count chapters only, per segment. At or above CUP_THRESHOLD (0.6) the cup is
taken; below it the cup is "uncaptured" (the battle stays under its league). The GBL schedule never assigns a cup: it
only picks between same-name variants the text names (Color Cup / Mega Color Cup; Great League / Great League: Mega
Edition) and confirms (text-confirmed) or contradicts (text-only) the text; for uncaptured cups it is a hint only.
"""
import datetime as dt
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEDULE_PATH = os.path.join(HERE, "data", "gbl-schedule.json")
GAMEMASTER_PATH = os.path.normpath(os.path.join(HERE, "..", "..", "includes", "pro", "data", "gamemaster.json"))
UPLOAD_LAG_DAYS = 14

BASE = {"great": ("Great League", 1500), "ultra": ("Ultra League", 2500),
        "master": ("Master League", 10000), "little": ("Little Cup", 500)}
LEAGUE_BY_CAP = {cp: k for k, (_, cp) in BASE.items()}
# Keyword patterns per base league (title/tags/description/chapters), several languages.
LEAGUE_WORDS = {
    "great": r"great league|\bgl\b|liga super|super ?liga|superliga|ligue super|superliga|スーパーリーグ|超級聯盟|"
             r"슈퍼리그|1500 ?cp",
    "ultra": r"ultra league|\bul\b|liga ultra|ligue hyper|hyper ?liga|ハイパーリーグ|高級聯盟|하이퍼리그|2500 ?cp",
    "master": r"master league|\bml\b|liga master|ligue master|meisterliga|liga m[aá]ster|マスターリーグ|大師聯盟|"
              r"마스터리그",
    "little": r"little (?:league|cup)|liga ball|petite ligue|liga peque|リトルカップ|500 ?cp",
}
COMPILATION = re.compile(r"compilation|highlights?|best of|montage|top \d+|funny|moments|recap|every league|"
                         r"all leagues|great.{0,20}ultra.{0,20}master", re.I)
TOURNAMENT = re.compile(r"\bvs\.?\b|draft|championship|regionals?|worlds|internationals?|tournament|"
                        r"play!? ?pok[eé]mon|\bnaic\b|\beuic\b|\blaic\b|\bocic\b|bracket|top cut", re.I)
TALK = re.compile(r"tier list|rankings?|\bguide\b|explained|\bnews\b|podcast|predictions?", re.I)
# Championship footage (Play! Pokémon events): both players' screens, invite-only, its own format.
# STRONG titles/channels settle it; WEAK words (a creator's GBL video "with my regional team") only
# make the Validate "perspective" question ask, which also offers "not a championship".
CHAMPIONSHIP_STRONG = re.compile(r"(regional championships?|international championships?|world championships?|"
                                 r"\bworlds 20\d\d\b|\b(?:laic|naic|euic|ocic)\b|\btop cut\b|grand finals?|"
                                 r"championship (?:finals?|match|day|top)|(?:finals?|semi-?finals?|quarter-?finals?) .{0,30}(?:regional|championship|worlds)|"
                                 r"(?:regional|championship|worlds).{0,30}\b(?:finals?|semi-?finals?|swiss|day [12])\b|"
                                 r"campeonato (?:regional|internacional|mundial)|play!? ?pok[eé]mon (?:regional|international|world)s?\b)", re.I)
CHAMPIONSHIP_WEAK = re.compile(r"(championships?|campeonato|regionals?\b|\bworlds\b|internationals?|tournament|torneo|tournoi|"
                               r"turnier|bracket|play!? ?pok[eé]mon)", re.I)
CHAMPIONSHIP_CHANNEL = re.compile(r"(play!? ?pok[eé]mon|pok[eé]mon go (?:championship|esports)|championship series)", re.I)
CHAMPIONSHIP_ID = "championship"


def load_schedule(path=SCHEDULE_PATH):
    try:
        with open(path, encoding="utf-8") as f:
            s = json.load(f)
    except FileNotFoundError:
        s = {"periods": [], "cups": {}, "seasons": []}
    cups = s.setdefault("cups", {})
    for k, (name, cp) in BASE.items():
        cups.setdefault(k, {"name": name, "cp": cp, "include": [], "exclude": []})
    return s


def _date(s):
    if not s:
        return None
    s = str(s).replace("-", "")
    try:
        return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None


def schedule_formats(schedule, upload_date, lag_days=UPLOAD_LAG_DAYS):
    """Formats active on the upload date (weight 1.0) or in the preceding lag window (0.6)."""
    d = _date(upload_date)
    out = {}
    if not d:
        return out
    lo = d - dt.timedelta(days=lag_days)
    for p in schedule.get("periods", []):
        ps, pe = _date(p["start"]), _date(p["end"])
        if not ps or not pe or pe < lo or ps > d:
            continue
        w = 1.0 if ps <= d <= pe else 0.6
        for f in p.get("formats", []):
            k = format_key(f["id"], f.get("cp"), schedule.get("cups", {}))
            out[k] = max(out.get(k, 0), w)
    return out


def format_key(fid, cp, cups):
    """'holiday' when the cup runs at its usual CP, 'holiday@500' for another CP edition."""
    c = cups.get(fid)
    base_cp = c.get("cp") if c else (BASE[fid][1] if fid in BASE else None)
    return fid if cp in (None, base_cp) else f"{fid}@{cp}"


def get_format(key, cups):
    """Resolve a format key to (cupId, cup dict with the edition's cp) or (key, None)."""
    fid, _, cp = key.partition("@")
    if fid == CHAMPIONSHIP_ID:   # Play! Pokémon events: separate from GBL cups, Great League CP unless stated
        return fid, {"name": "Championship", "cp": int(cp) if cp else 1500, "include": [], "exclude": [], "format": "championship"}
    c = cups.get(fid) or ({"name": BASE[fid][0], "cp": BASE[fid][1], "include": [], "exclude": []} if fid in BASE else None)
    if c is None:
        return fid, None
    if cp:
        c = dict(c, cp=int(cp))
    return fid, c


# Cup names as creators write them in other languages (titles of the harvested videos), next to the schedule's aliases.
LOCAL_CUP_ALIASES = {
    "color": ["copa color", "copa de color", "farb-cup", "farbcup", "farb cup", "coupe des couleurs", "coupe couleur",
              "4色カップ"],
    "colormega": ["mega copa color", "mega farb-cup", "mega farbcup", "mega farb cup", "メガ4色カップ"],
    "retro": ["copa retro", "copa retrô", "retro-cup", "coupe rétro", "レトロカップ"],
}


def _cup_patterns(schedule):
    pats = {}
    for cid, c in schedule.get("cups", {}).items():
        if cid in BASE:
            continue
        names = [c.get("name", "")] + list(c.get("aliases", [])) + LOCAL_CUP_ALIASES.get(cid, [])
        names = [n.lower() for n in names if n and len(n) >= 4]
        # "Mega Color Cup" is also written "Color Cup Mega" (titles, tags).
        names += [n[5:] + " mega" for n in names if n.startswith("mega ") and not n.endswith(" mega")]
        names = [re.escape(n) for n in names]
        if names:
            pats[cid] = re.compile(r"(?<!\w)(" + "|".join(sorted(set(names), key=len, reverse=True)) + r")(?!\w)", re.I)
    return pats


def _core_name(name):
    """'Mega Color Cup: Great League Edition' -> 'color' (edition words and the CP edition dropped)."""
    words = re.findall(r"[a-z0-9]+", (name or "").lower().split(":")[0])
    return " ".join(w for w in words if w not in ("mega", "cup", "edition"))


def cup_variants(schedule):
    """[(plain_id, mega_id)] for cups that share a name apart from "Mega" (Color Cup / Mega Color Cup) and a CP.
    The Mega Edition itself (no name left) is not a variant of anything."""
    cups = schedule.get("cups", {})
    by_core = {}
    for cid, c in cups.items():
        if cid in BASE or not isinstance(c, dict):
            continue
        core = _core_name(c.get("name"))
        if core:
            by_core.setdefault((core, c.get("cp")), []).append(cid)
    pairs = []
    for ids in by_core.values():
        mega = [i for i in ids if "mega" in cups[i]["name"].lower().split(":")[0].split()]
        pairs += [(p, m) for p in ids if p not in mega for m in mega]
    return pairs


_PAT_CACHE = {}

# "Great League: Mega Edition", "Mega Great League", "mega master league": the CP edition is named in the text.
MEGA_EDITION = re.compile(r"(?<!\w)(?:mega\s+(?:edition\s+)?(great|ultra|master)(?:\s+league)?|"
                          r"(great|ultra|master)\s+league\s*[:\-–|,]?\s*mega(?:\s+edition)?)(?!\w)", re.I)


def keyword_hits(text, schedule):
    """Return {formatId: number_of_matches} for base leagues and named cups found in text.
    A Mega Edition named with its league resolves to its CP edition ('mega@1500' for Great League); a plain cup
    whose Mega variant is the one named ("Mega Color Cup") does not also count for the plain cup."""
    text = text or ""
    hits = {}
    key = id(schedule)
    if key not in _PAT_CACHE:
        _PAT_CACHE.clear()
        _PAT_CACHE[key] = (_cup_patterns(schedule), cup_variants(schedule))
    pats, pairs = _PAT_CACHE[key]
    cup_found = False
    for cid, pat in pats.items():
        n = len(pat.findall(text))
        if n:
            hits[cid] = n
            cup_found = True
    for lid, pat in LEAGUE_WORDS.items():
        n = len(re.findall(pat, text, re.I))
        if n:
            hits[lid] = n
    for plain, mega in pairs:
        if plain in hits and mega in hits:
            hits[plain] -= hits[mega]    # each "Mega Color Cup" contains a "Color Cup" that is not a plain mention
            if hits[plain] <= 0:
                del hits[plain]
    editions = {}
    for m in MEGA_EDITION.finditer(text):
        base = (m.group(1) or m.group(2)).lower()
        ek = format_key("mega", BASE[base][1], schedule.get("cups", {}))
        editions[ek] = editions.get(ek, 0) + 1
        if hits.get(base, 0) > 0:
            hits[base] -= 1          # the league word belongs to the edition's name
            if hits[base] == 0:
                del hits[base]
    if editions:
        rest = max(0, hits.pop("mega", 0) - sum(editions.values()))
        for ek, n in editions.items():
            hits[ek] = hits.get(ek, 0) + n
        if rest:
            hits["mega"] = hits.get("mega", 0) + rest
        cup_found = True
    # "Little Cup" is a league here; a named cup with "great league" in its name ("Great League Remix")
    # counts for the cup, the base league stays as a weaker alternative.
    if cup_found and "great" in hits and re.search(r"great league remix|remix", text, re.I):
        hits["great"] = max(1, hits["great"] - 1)
    return hits


def scheduled_variant(fid, sched, schedule, base_editions=False):
    """The schedule-window format that stands for a text-matched format the schedule did not run: the Mega variant
    of the same-name cup at the same CP (Color Cup -> Mega Color Cup), or the one scheduled CP edition of a bare
    Mega Edition; with base_editions, also a league's own Mega Edition (Great League -> Great League: Mega Edition).
    None when fid itself ran in the window, or when the choice is not unique."""
    if fid in sched:
        return None
    cups = schedule.get("cups", {})
    cp = (get_format(fid, cups)[1] or {}).get("cp")
    found = set()
    for plain, mega in cup_variants(schedule):
        if plain == fid.partition("@")[0]:
            found |= {k for k in sched if k.partition("@")[0] == mega and (get_format(k, cups)[1] or {}).get("cp") == cp}
    if fid == "mega":
        found |= {k for k in sched if k.partition("@")[0] == "mega"}
    if base_editions and fid in BASE:
        found |= {k for k in sched if k.partition("@")[0] == "mega" and (get_format(k, cups)[1] or {}).get("cp") == cp}
    if len(found) > 1:
        top = max(sched[k] for k in found)
        found = {k for k in found if sched[k] == top}
    return next(iter(found)) if len(found) == 1 else None


def guess_kind(title, chapters=(), leagues_in_chapters=0):
    t = title or ""
    if leagues_in_chapters >= 2 or COMPILATION.search(t):
        return "compilation"
    if TOURNAMENT.search(t):
        return "tournament"
    if TALK.search(t) and not re.search(r"battles?|gameplay|ranked|legend", t, re.I):
        return "guide/talk"
    return "set/gameplay"


def championship_evidence(meta):
    """(strong: bool, possible: bool, reasons [str]) from title, channel, tags and description."""
    title, channel = meta.get("title") or "", meta.get("channel") or ""
    tags, desc = " ".join(meta.get("tags") or []), (meta.get("description") or "")[:2000]
    reasons = []
    if CHAMPIONSHIP_STRONG.search(title):
        reasons.append("title: " + CHAMPIONSHIP_STRONG.search(title).group(0))
    if CHAMPIONSHIP_CHANNEL.search(channel):
        reasons.append("channel: " + channel)
    strong = bool(reasons)
    for where, text in (("title", title), ("tags", tags), ("description", desc)):
        m = CHAMPIONSHIP_STRONG.search(text) if where != "title" else None
        w = CHAMPIONSHIP_WEAK.search(text)
        if m:
            reasons.append(f"{where}: {m.group(0)}")
        elif w and where == "title":
            reasons.append(f"{where} (weak): {w.group(0)}")
    possible = strong or bool(reasons)
    return strong, possible, reasons[:4]


def guess_league(meta, schedule):
    """meta: dict with title, tags, description, chapters [{title}], uploadDate (YYYYMMDD).

    Returns dict(leagueGuess, leagueId, leagueConfidence (0..1), leagueEvidence [str],
    cupCandidates [ids from schedule], kindGuess)."""
    cups = schedule.get("cups", {})
    scores, evidence = {}, []

    def add(fid, w, why):
        scores[fid] = scores.get(fid, 0) + w
        evidence.append(f"{why}: {fid}")

    for fid, n in keyword_hits(meta.get("title"), schedule).items():
        add(fid, 3.0, "title")
    for fid, n in keyword_hits(" ".join(meta.get("tags") or []), schedule).items():
        add(fid, 1.0, "tags")
    for fid, n in keyword_hits((meta.get("description") or "")[:2000], schedule).items():
        add(fid, 0.75 if n == 1 else 1.0, "description")
    chap_leagues = set()
    for ch in meta.get("chapters") or []:
        for fid in keyword_hits(ch.get("title"), schedule):
            chap_leagues.add(fid)
    for fid in chap_leagues:
        add(fid, 2.0 / max(1, len(chap_leagues)) + 0.5, "chapters")
    sched = schedule_formats(schedule, meta.get("uploadDate"))
    for fid, w in sched.items():
        evidence.append(f"{'schedule' if w == 1.0 else 'schedule (lag window)'}: {fid}")
    sched_cps = {(get_format(f, cups)[1] or {}).get("cp") for f in sched}
    words = {}
    kind = guess_kind(meta.get("title"), meta.get("chapters"), len(chap_leagues))
    if scores:
        # A cup the text names but the schedule did not run in the window stands for the Mega variant (or the CP
        # edition) that it did run: "Color Cup" in the week of the Mega Color Cup.
        for fid in list(scores):
            alt = scheduled_variant(fid, sched, schedule)
            if alt:
                scores[alt] = scores.get(alt, 0) + scores.pop(fid)
                evidence.append(f"schedule variant: {fid} -> {alt}")
        words = {k: round(v, 2) for k, v in scores.items()}   # what the text named, before the schedule weighs in
        # Text decides; the schedule confirms (or weakens) it.
        for fid in list(scores):
            if fid in sched:
                scores[fid] += 1.0
        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
        top = ranked[0]
        conf = min(0.85, top[1] / sum(scores.values()) * min(1.0, top[1] / 3.0))
        top_cp = (get_format(top[0], cups)[1] or {}).get("cp")
        if top[0] in sched:
            conf += 0.15
        elif sched and top_cp not in sched_cps:
            conf *= 0.8           # nothing at that CP was running: maybe an older recording
    elif sched:
        today = sorted(f for f, w in sched.items() if w == 1.0) or sorted(sched)
        top = (today[0], 1.0)
        conf = 0.45 / len(today)  # schedule alone never gives high confidence
    else:
        return _with_championship({"leagueGuess": "Unknown", "leagueId": None, "leagueConfidence": 0.0, "leagueEvidence": [],
                                   "cupCandidates": [], "kindGuess": kind}, meta)
    conf = round(min(0.97, conf), 2)
    if kind == "compilation" or len([f for f in chap_leagues]) >= 2:
        kind = "compilation"
    return _with_championship({"leagueGuess": format_name(top[0], schedule), "leagueId": top[0], "leagueConfidence": conf,
                               "leagueEvidence": sorted(set(evidence))[:12], "cupCandidates": sorted(sched),
                               "leagueKeywords": words, "kindGuess": kind, "textCups": text_cups(meta, schedule)}, meta)


def format_name(fid, schedule):
    """Display name of a format key: the schedule's own name for an edition ("Great League: Mega Edition")."""
    cups = schedule.get("cups", {})
    _, cup = get_format(fid, cups)
    name = (cup or {}).get("name") or fid
    sched_name = next((f.get("name") for p in schedule.get("periods", []) for f in p.get("formats", [])
                       if f.get("name") and format_key(f["id"], f.get("cp"), cups) == fid), None)
    if fid not in BASE and sched_name:
        return sched_name
    if cup and "@" in fid:
        return f"{name} ({cup['cp']} CP)"
    return name


# ---------------------------------------------------------------- the cup, from the video's own text
# The video shows the CPs (so the league), never the cup. The cup comes from what the creator wrote: an exact cup name
# in the title counts most, then tags, chapter titles, description. The GBL schedule only picks between same-name
# variants the text names (Color Cup / Mega Color Cup; Great League / Great League: Mega Edition) and confirms or
# contradicts; on its own it never assigns a cup. Below CUP_THRESHOLD the cup is "uncaptured".
CUP_SOURCES = ("title", "tags", "chapters", "description")
CUP_WEIGHTS = {"title": 1.0, "tags": 0.8, "chapters": 0.7, "description": 0.45}
CUP_CORROBORATION = 0.1     # each further source naming the same cup
CUP_THRESHOLD = 0.6


def text_cups(meta, schedule):
    """What the video's text names. Returns {"formats": {fid: {"score", "sources", "cp"}}, "segments": [{"start",
    "end", "formats"}] (chapters naming a format), "compilation": bool}. score = the strongest source's weight plus
    CUP_CORROBORATION per further source (at most 1)."""
    cups = schedule.get("cups", {})
    found = {}
    for src, text in (("title", meta.get("title")), ("tags", " ".join(meta.get("tags") or [])),
                      ("description", (meta.get("description") or "")[:2000])):
        for fid in keyword_hits(text, schedule):
            found.setdefault(fid, set()).add(src)
    chs = [c for c in meta.get("chapters") or [] if isinstance(c, dict)]
    segments = []
    for i, ch in enumerate(chs):
        fids = sorted(keyword_hits(ch.get("title"), schedule))
        if not fids:
            continue
        end = chs[i + 1].get("start") if i + 1 < len(chs) else ch.get("end")
        segments.append({"start": ch.get("start") or 0, "end": end, "formats": fids})
        for fid in fids:
            found.setdefault(fid, set()).add("chapters")
    formats = {}
    for fid, srcs in found.items():
        w = sorted((CUP_WEIGHTS[s] for s in srcs), reverse=True)
        formats[fid] = {"score": round(min(1.0, w[0] + CUP_CORROBORATION * (len(w) - 1)), 2),
                        "sources": [s for s in CUP_SOURCES if s in srcs], "cp": (get_format(fid, cups)[1] or {}).get("cp")}
    kind = guess_kind(meta.get("title"), chs, len({f for s in segments for f in s["formats"]}))
    return {"formats": formats, "segments": segments, "compilation": kind == "compilation"}


def _competitors(scores, cap, cps):
    """The formats named at this CP (all of them when the CP is unknown). A bare league word ("Great League") yields to
    a cup at its CP named at least as strongly: it is the generic word, not a second cup."""
    at = {f: s for f, s in scores.items() if cap is None or cps.get(f) == cap}
    out = {}
    for f, s in at.items():
        rivals = [v for g, v in at.items() if g not in BASE and cps.get(g) == cps.get(f)]
        if f in BASE and rivals and max(rivals) >= s:
            continue
        out[f] = s
    return out


def _merge_variants(comp, schedule, sched):
    """Same-name variants the text names together (Color Cup and Mega Color Cup; Great League and Great League: Mega
    Edition) are one candidate: the schedule picks the one it ran in the window, else the more strongly named one."""
    cups = schedule.get("cups", {})
    pairs = list(cup_variants(schedule))
    for f in comp:
        if f.partition("@")[0] == "mega":
            base = LEAGUE_BY_CAP.get((get_format(f, cups)[1] or {}).get("cp"))
            if base:
                pairs.append((base, f))
    out = dict(comp)
    for plain, mega in pairs:
        if plain not in out or mega not in out:
            continue
        ran = [f for f in (plain, mega) if f in sched]
        if len(ran) == 1:
            keep = ran[0]
        elif out[plain] != out[mega]:
            keep = max((plain, mega), key=out.get)
        else:
            continue
        out[keep] = max(out.pop(plain), out.pop(mega))
    return out


def battle_cup(text, cap, start, schedule, sched):
    """The cup of one battle from the video's text (text_cups), for a battle whose CPs show `cap` (None: unreadable).
    sched: schedule_formats() of the battle's window. Returns {"cup", "status" ("text-confirmed" | "text-only" |
    "uncaptured"), "source", "confidence", "reason", "variant", "scheduled" (names the schedule ran at the CP)}."""
    cups = schedule.get("cups", {})
    text = text or {}
    formats = text.get("formats") or {}
    cps = {f: v.get("cp") for f, v in formats.items()}
    out = {"cup": None, "status": "uncaptured", "source": None, "confidence": 0.0, "reason": None, "variant": None}
    pick = None
    seg = next((s for s in text.get("segments") or [] if isinstance(start, (int, float)) and (s.get("start") or 0) <= start
                and (s.get("end") is None or start < s["end"])), None)
    if seg:
        comp = _merge_variants(_competitors({f: CUP_WEIGHTS["chapters"] for f in seg["formats"] if f in cps}, cap, cps),
                               schedule, sched)
        if len(comp) == 1:
            pick = (next(iter(comp)), "chapters", CUP_WEIGHTS["chapters"])
        elif len(comp) > 1:
            out["reason"] = "several-cups"
    if pick is None and out["reason"] is None:
        comp = _merge_variants(_competitors({f: v["score"] for f, v in formats.items()}, cap, cps), schedule, sched)
        if text.get("compilation"):
            out["reason"] = "compilation"           # a compilation's cups come from its chapters only
        elif not comp:
            out["reason"] = "other-cp" if formats else "no-cup-named"
        else:
            fid = max(comp, key=lambda f: (comp[f], f))
            conf = round(comp[fid] * comp[fid] / sum(comp.values()), 2)
            src = next((s for s in CUP_SOURCES if s in formats[fid]["sources"]), None)
            if conf >= CUP_THRESHOLD:
                pick = (fid, src, conf)
            else:
                out.update(reason="several-cups" if len(comp) > 1 else "weak-text", confidence=conf, source=src)
    fcap = cap if cap is not None else (cps.get(pick[0]) if pick else None)
    ran = [k for k in sorted(sched) if (get_format(k, cups)[1] or {}).get("cp") == fcap] if fcap is not None else []
    out["scheduled"] = [format_name(k, schedule) for k in ran]
    if pick is None:
        return out
    fid, src, conf = pick
    alt = scheduled_variant(fid, sched, schedule, base_editions=True)
    if alt:
        out["variant"] = f"{fid} -> {alt}"
        fid = alt
    out.update(cup=fid, source=src, confidence=conf,
               status="text-confirmed" if fid in sched else "text-only",
               reason=None if fid in sched else "disagrees" if ran else "no-record")
    return out


def _with_championship(guess, meta):
    strong, possible, reasons = championship_evidence(meta)
    if strong:
        guess.update(championship=True, kindGuess="tournament")
    if possible:
        guess["possibleChampionship"] = True
        guess["championshipEvidence"] = reasons
    return guess


# ---------------------------------------------------------------- post-analysis refinement

def cp_cap_for(cps):
    """Smallest standard cap that fits all observed CPs: 500, 1500, 2500 or 10000 (uncapped)."""
    m = max([c for c in cps if c] or [0])
    for cap in (500, 1500, 2500):
        if m <= cap:
            return cap
    return 10000


CPM_MAX = 0.84529999   # level 51 (best buddy at level 50): the highest CP multiplier a player's Pokémon reaches


def max_player_cp(mon, cpm=CPM_MAX):
    """Highest CP a player's Pokémon of this species/form can show (15/15/15, level 51)."""
    b = mon.get("baseStats") or {}
    if not b:
        return None
    return max(10, int((b["atk"] + 15) * (b["def"] + 15) ** 0.5 * (b["hp"] + 15) ** 0.5 * cpm * cpm / 10))


def rocket_evidence(my, opponent, gamemaster):
    """Team Rocket battles: grunts' and leaders' Pokémon often show CPs no player's Pokémon can reach,
    or far above the league cap that the creator's team fits. my/opponent: [{"species", "cp"}].
    Conservative against single OCR or species misreads: two impossible CPs, one far above the
    species maximum (x1.5), or two opponent CPs above the creator's cap. Returns {flag, reasons}."""
    reasons, over_species, far = [], 0, False
    for m in opponent or []:
        sid, cp = m.get("species"), m.get("cp")
        if not isinstance(cp, (int, float)) or not sid:
            continue
        mon = gamemaster.get(sid) or gamemaster.get(re.sub(r"_shadow$", "", sid))
        top = max_player_cp(mon) if mon else None
        # >6x the maximum is a misread (an extra digit), not a Rocket Pokémon (seen up to ~4x).
        if top and top * 1.02 + 10 < cp <= top * 6:
            over_species += 1
            far = far or cp >= top * 1.5
            reasons.append(f"{sid} CP {int(cp)} > player max {top}")
    my_cps = [m.get("cp") for m in my or [] if isinstance(m.get("cp"), (int, float))]
    over_cap = 0
    cap = plausible_cap(my_cps)
    if cap:
        if cap < 10000:
            over = [m.get("cp") for m in opponent or [] if isinstance(m.get("cp"), (int, float)) and m["cp"] > cap * 1.03]
            over_cap = len(over)
            if over_cap:
                reasons.append(f"creator's team fits {cap} CP; opponent CP {', '.join(str(int(c)) for c in over[:3])}")
    flag = over_species >= 2 or far or over_cap >= 2
    return {"flag": flag, "reasons": reasons[:4]}


def plausible_cap(cps):
    """The league cap a team sits at, or None when its CPs look truncated (a GBL team is built close
    to the cap: '148' read from 'CP 1480' would otherwise suggest Little Cup)."""
    cps = [c for c in cps or [] if isinstance(c, (int, float)) and c > 0]
    if not cps:
        return None
    cap = cp_cap_for(cps)
    return cap if cap == 10000 or max(cps) >= cap * 0.8 else None


def load_gamemaster(path=GAMEMASTER_PATH):
    with open(path, encoding="utf-8") as f:
        g = json.load(f)
    return {p["speciesId"]: p for p in g["pokemon"]}


def _stage(mon, gm):
    n, seen = 1, set()
    while mon and (mon.get("family") or {}).get("parent") and n < 4:
        par = mon["family"]["parent"]
        if par in seen:
            break
        seen.add(par)
        mon = gm.get(par) if gm else None
        n += 1
    return n


def _matches(filt, sid, mon, moves, gm=None):
    ft, vals = filt.get("filterType"), filt.get("values") or []
    if not vals:
        return None
    if ft == "evolution":
        return _stage(mon, gm) in vals
    if ft == "id":
        return sid in vals
    if ft == "type":
        return any(t in vals for t in mon.get("types", []) if t != "none")
    if ft == "tag":
        return any(t in vals for t in mon.get("tags", []))
    if ft == "dex":
        lo, hi = (vals + vals)[:2]
        return lo <= mon.get("dex", -1) <= hi
    if ft == "move":
        return None if not moves else any(m in vals for m in moves)
    return None    # unknown filter type: cannot judge


def species_allowed(cup, sid, mon, moves=(), gm=None):
    """PvPoke semantics: non-id include filters must all match, or the id is explicitly included;
    any matching exclude filter rejects (exclude-type does not override an explicit include-id).
    Returns True/False, or None when the rules can't be judged."""
    if cup.get("rulesUnknown"):
        return None
    cp = cup.get("cp")
    live = lambda fs: [f for f in fs or [] if not f.get("leagues") or cp in f["leagues"]]  # noqa: E731
    inc, exc = live(cup.get("include")), live(cup.get("exclude"))
    inc_ids = {v for f in inc if f.get("filterType") == "id" for v in f.get("values") or []}
    explicit = sid in inc_ids
    non_id = [f for f in inc if f.get("filterType") != "id" and f.get("values")]
    if explicit:
        ok = True
    elif non_id:
        res = [_matches(f, sid, mon, moves, gm) for f in non_id]
        if any(r is False for r in res):
            ok = False
        elif all(r is True for r in res):
            ok = True
        else:
            ok = None
    else:
        ok = not inc_ids    # only an id whitelist and we're not on it
    if ok is False:
        return False
    for f in exc:
        if explicit and f.get("filterType") != "id":
            continue
        r = _matches(f, sid, mon, moves, gm)
        if r is True:
            return False
    return ok


CP_CEILING = 6500       # no player's Pokémon shows more: a larger read has an extra digit
CAP_ORDER = {1500: 0, 2500: 1, 10000: 2, 500: 3}   # when nothing else separates formats, the usual leagues first


def refine_battle_league(observed, candidates=None, schedule=None, gamemaster=None, battle_date=None,
                         keywords=None, lag_days=0):
    """Narrow the format of ONE analysed battle.

    observed: {"cps": [ints, both teams], "species": [PvPoke speciesIds seen, both teams],
               "moves": {speciesId: [MOVE_IDS]} optional,
               "teams": {"my": [{species, cp}], "opponent": [...]} optional -> adds "rocket" {flag, reasons}}
    candidates: format ids to consider (default: schedule formats around battle_date, else all
                four base leagues).
    battle_date / lag_days: the date to check the schedule at (upload date + lag window for uploads).
    keywords: format ids the video's title/tags/description named ({id: strength} or a list).
    Ranking: formats the schedule ran in the window first, then the video's keywords, then CP cap fit and
    eligibility, then how recently in the window. A Mega Edition counts at the CP of its edition (mega@1500 is Great
    League CP), so a Great League team never favours a 10000 CP Mega Edition.
    Returns {"ranked": [{id,name,cp,score,scheduled,keyword,reasons}], "eliminated": [{id,reason}], "cpCap": cap}."""
    schedule = schedule or load_schedule()
    gamemaster = gamemaster if gamemaster is not None else load_gamemaster()
    cups = schedule.get("cups", {})
    sched = schedule_formats(schedule, battle_date, lag_days=lag_days) if battle_date else {}
    kw = dict(keywords) if isinstance(keywords, dict) else {k: 1 for k in keywords or []}
    off_schedule = set()
    if not candidates:
        candidates = sorted(sched)
        if candidates:
            # Base leagues stay possible (friend battles, tournaments, schedule gaps) but rank lower.
            off_schedule = {b for b in BASE if b not in candidates}
            candidates += sorted(off_schedule)
        candidates = candidates or list(BASE)
    elif sched:
        off_schedule = {c for c in candidates if c not in sched}
    cps = [c for c in observed.get("cps") or [] if c and c <= CP_CEILING]
    cap = plausible_cap(cps)     # None when the reads look truncated ('149' from 'CP 1490'): no CP evidence then
    moves = observed.get("moves") or {}
    ranked, eliminated = [], []
    for fid in candidates:
        _, cup = get_format(fid, cups)
        if cup is None:
            eliminated.append({"id": fid, "reason": "unknown format"})
            continue
        ccap = cup.get("cp", 10000)
        if cps and max(cps) > ccap:
            eliminated.append({"id": fid, "reason": f"CP {max(cps)} above cap {ccap}"})
            continue
        score, reasons = (0.0, ["not on the GBL schedule that day"]) if fid in off_schedule else (1.0, [])
        if cap is not None:
            if ccap == cap:
                score += 2.0
                reasons.append(f"CP cap {cap} fits")
            else:
                score -= 0.5 * (1 + [500, 1500, 2500, 10000].index(min(ccap, 10000)) - [500, 1500, 2500, 10000].index(cap))
                reasons.append(f"CP fits but cap {ccap} > {cap}")
        bad, unknown = [], 0
        for sid in observed.get("species") or []:
            mon = gamemaster.get(sid) or gamemaster.get(re.sub(r"_shadow$", "", sid))
            if not mon:
                unknown += 1
                continue
            ok = species_allowed(cup, sid, mon, moves.get(sid, ()), gamemaster)
            if ok is False:
                bad.append(sid)
            elif ok is None:
                unknown += 1
        if bad:
            eliminated.append({"id": fid, "reason": "not eligible: " + ", ".join(sorted(set(bad)))})
            continue
        restricted = bool(cup.get("include") or any(f.get("values") for f in cup.get("exclude") or []))
        if restricted and observed.get("species") and not unknown:
            score += 1.0   # a restricted cup that the whole team satisfies is informative
            reasons.append("all species eligible")
        # A keyword only counts where the CPs do not contradict it (a Great League word over an Ultra League team). A
        # bare league word ("Great League") names a CP, not a cup: it cannot outrank the cups the schedule ran at it.
        word = kw.get(fid, 0) if cap is None or ccap == cap else 0
        if fid in BASE and sched and fid not in sched:
            word = 0
        if word:
            reasons.append("named in the title, tags or description")
        ranked.append({"id": fid, "name": cup.get("name", fid), "cp": ccap, "score": round(score, 2),
                       "scheduled": sched.get(fid, 0), "keyword": word, "reasons": reasons})
    # A cup the schedule did not run in the window but the text names still ranks first: the schedule and the text
    # disagree, and the result says so (observed.py: contradicted) instead of quietly picking another cup that ran.
    # Where no keyword settles it, the formats the schedule ran in the window come first, then the keyword's CP
    # (when the CPs are unreadable), CP cap fit and eligibility, then the most recently started.
    in_window = lambda r: r["scheduled"] > 0 or not sched  # noqa: E731
    word_cps = {(get_format(k, cups)[1] or {}).get("cp") for k in kw} if cap is None else set()
    ranked.sort(key=lambda r: (-r["keyword"], not in_window(r), bool(word_cps) and r["cp"] not in word_cps, -r["score"],
                               -r["scheduled"], CAP_ORDER.get(r["cp"], 9), r["id"]))
    out = {"ranked": ranked, "eliminated": eliminated, "cpCap": cap}
    teams = observed.get("teams")
    if teams:
        out["rocket"] = rocket_evidence(teams.get("my"), teams.get("opponent"), gamemaster)
    return out


# ---------------------------------------------------------------- video-level document and bulk rewrite

def refine_video(res, video_league, schedule, gamemaster, upload_date=None, lag_days=UPLOAD_LAG_DAYS, meta=None):
    """The *.leagues.json document of one analysed video (what harvest.write_league_refinement stores). Per battle:
    the league from the CPs it shows, the cup from the video's text (battle_cup: title, tags, chapters, description;
    the schedule at the upload date + lag window only picks a same-name variant and confirms or contradicts), Team
    Rocket flags and the championship format. A reviewer's video-wide label (reviewerLeague) is the cup instead.

    res: the stored result ({"battles": [...], "probe": {...}}); video_league: guess_league() output (its textCups, or
    meta to compute them)."""
    text = text_cups(meta, schedule) if meta else video_league.get("textCups") or {}
    cups = schedule.get("cups", {})
    sched = schedule_formats(schedule, upload_date, lag_days=lag_days) if upload_date else {}
    reviewer = video_league.get("leagueId") if video_league.get("reviewerLeague") else None
    reviewer_cp = (get_format(reviewer, cups)[1] or {}).get("cp") if reviewer else None
    screens = len(((res.get("probe") or {}).get("screens")) or [])
    championship = bool(video_league.get("championship"))
    possible = championship or bool(video_league.get("possibleChampionship")) or screens >= 2
    out = []
    for b in res.get("battles", []):
        def team(side):
            return [{"species": (m.get("form") or {}).get("id") or m.get("formId"), "cp": m.get("cp")}
                    for m in b.get(side + "Detail") or []]
        my, opp = team("my"), team("opponent")
        cps = [m["cp"] for m in my + opp if isinstance(m.get("cp"), (int, float))]
        cap = plausible_cap([c for c in cps if c and c <= CP_CEILING])
        rocket = rocket_evidence(my, opp, gamemaster)
        if reviewer and (cap is None or reviewer_cp == cap):
            ran = [k for k in sorted(sched) if (get_format(k, cups)[1] or {}).get("cp") == reviewer_cp]
            c = {"cup": reviewer, "status": "text-confirmed" if reviewer in sched else "text-only", "source": "reviewer",
                 "confidence": 1.0, "reason": None if reviewer in sched else "disagrees" if ran else "no-record",
                 "variant": None, "scheduled": [format_name(k, schedule) for k in ran]}
        else:
            c = battle_cup(text, cap, b.get("start"), schedule, sched)
        league_cp = cap if cap is not None else (get_format(c["cup"], cups)[1] or {}).get("cp") if c["cup"] else None
        league = LEAGUE_BY_CAP.get(league_cp) or ("master" if league_cp and league_cp > 2500 else None)
        entry = {"start": b.get("start"), "league": league, "cpCap": cap, "cup": c["cup"],
                 "cupName": format_name(c["cup"], schedule) if c["cup"] else None, "cupStatus": c["status"],
                 "cupSource": c["source"], "cupConfidence": c["confidence"], "cupReason": c["reason"],
                 "cupVariant": c["variant"], "scheduled": c["scheduled"],
                 "best": c["cup"] or league, "cps": cps, "rocket": rocket["flag"], "rocketReasons": rocket["reasons"]}
        if rocket["flag"]:
            entry["battleType"] = "rocket"
        elif championship:
            entry["battleType"] = "championship"
            ccap = plausible_cap([m.get("cp") for m in my])
            entry["best"] = CHAMPIONSHIP_ID if ccap in (None, 1500) else f"{CHAMPIONSHIP_ID}@{ccap}"
            # Play! Pokémon events are not on the GBL schedule; the title or a reviewer named the format.
            entry.update(cup=entry["best"], cupName="Championship", cupStatus="text-only", cupReason="championship",
                         cupSource="reviewer" if reviewer else "title", cupConfidence=1.0, cupVariant=None, scheduled=[])
        out.append(entry)
    return {"video": {**video_league, "textCups": text, "championship": championship, "possibleChampionship": possible,
                      "screens": screens},
            "battles": out}


def _read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _stored_meta(work_dir, ids):
    """{videoId: meta} from a COPY of the harvester's state.sqlite (the live database is never opened)."""
    import shutil
    import sqlite3
    import tempfile
    out = {}
    src = os.path.join(work_dir, "state.sqlite")
    if not os.path.exists(src):
        return out
    with tempfile.TemporaryDirectory() as tmp:
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(src + suffix):
                shutil.copy2(src + suffix, os.path.join(tmp, "state.sqlite" + suffix))
        db = sqlite3.connect(os.path.join(tmp, "state.sqlite"))
        try:
            for vid, meta in db.execute("SELECT id, meta FROM videos WHERE meta IS NOT NULL"):
                if vid in ids:
                    try:
                        out[vid] = json.loads(meta)
                    except ValueError:
                        pass
        finally:
            db.close()
    return out


def reviewed_league(video_league, schedule, label, registered):
    """A confirmed video-wide label takes precedence over title/schedule guesses (harvest._reviewed_league)."""
    pending = (label or {}).get("leagueId")
    reviewed = registered if (registered or {}).get("reviewerLeague") else {}
    key = pending if pending and pending != "other" else reviewed.get("leagueId")
    if not key:
        return video_league
    _, cup = get_format(key, schedule.get("cups", {}))
    if not cup:
        return video_league
    evidence = reviewed.get("leagueEvidence") or [{"source": "human-validation", "leagueId": key}]
    name = reviewed.get("leagueGuess") if reviewed.get("leagueId") == key else cup.get("name", key)
    return {**video_league, "leagueId": key, "leagueGuess": name, "leagueConfidence": 1, "leagueEvidence": evidence,
            "reviewerLeague": True, "cupCandidates": [], "leagueKeywords": {key: 3}}


def refine_all(work_dir, web_root=None, backup_dir=None, dry_run=False, schedule=None, gamemaster=None):
    """Rewrite results/*.leagues.json from the stored results with the current inference rules, without re-analysis.
    Reads results/*.json, labels/, state.sqlite (a copy) and the registry; WRITES ONLY the sidecars, after copying
    each existing one into backup_dir. Returns a summary dict."""
    import shutil
    web_root = web_root or os.path.normpath(os.path.join(HERE, "..", ".."))
    schedule = schedule or load_schedule()
    gamemaster = gamemaster if gamemaster is not None else load_gamemaster()
    results = os.path.join(work_dir, "results")
    names = sorted(n for n in os.listdir(results) if n.endswith(".json")
                   and not n.endswith((".leagues.json", ".learned.json")) and n != "batch-summary.json")
    ids = {n[:-5] for n in names}
    registry = _read_json(os.path.join(web_root, "tests", "meta-benchmark", "sources", "registry.json"), [])
    registry = {v.get("id"): v for v in (registry if isinstance(registry, list) else registry.get("videos", [])) if isinstance(v, dict)}
    metas = _stored_meta(work_dir, ids)
    backup_dir = backup_dir or os.path.join(work_dir, "results-backup-leagues-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    summary = {"videos": 0, "written": 0, "created": 0, "battlesChanged": 0, "battles": 0, "noMetadata": 0, "backup": None, "changes": {}}
    for name in names:
        vid = name[:-5]
        res = _read_json(os.path.join(results, name), None)
        if not isinstance(res, dict) or not isinstance(res.get("battles"), list):
            continue
        sidecar = os.path.join(results, vid + ".leagues.json")
        old = _read_json(sidecar, None)
        meta = {**registry.get(vid, {}), **metas.get(vid, {})}
        if meta.get("title") or meta.get("uploadDate"):
            video_league = guess_league(meta, schedule)
        elif isinstance(old, dict) and isinstance(old.get("video"), dict):
            video_league = old["video"]
            summary["noMetadata"] += 1
        else:
            video_league = guess_league(meta, schedule)
            summary["noMetadata"] += 1
        video_league = reviewed_league(video_league, schedule, _read_json(os.path.join(work_dir, "labels", name), {}), registry.get(vid))
        doc = refine_video(res, video_league, schedule, gamemaster, meta.get("uploadDate"), meta=meta if meta.get("title") else None)
        summary["videos"] += 1
        before = {b.get("start"): b.get("best") for b in (old or {}).get("battles", [])} if isinstance(old, dict) else {}
        for b in doc["battles"]:
            summary["battles"] += 1
            if before.get(b["start"]) != b["best"]:
                summary["battlesChanged"] += 1
                k = f"{before.get(b['start'])} -> {b['best']}"
                summary["changes"][k] = summary["changes"].get(k, 0) + 1
        if isinstance(old, dict) and json.dumps(old, sort_keys=True) == json.dumps(doc, sort_keys=True):
            continue
        if dry_run:
            summary["written" if old else "created"] += 1
            continue
        if old is not None:
            os.makedirs(backup_dir, exist_ok=True)
            shutil.copy2(sidecar, os.path.join(backup_dir, vid + ".leagues.json"))
            summary["backup"] = backup_dir
        with open(sidecar + ".tmp", "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1)
        os.replace(sidecar + ".tmp", sidecar)
        summary["written" if old is not None else "created"] += 1
    summary["changes"] = dict(sorted(summary["changes"].items(), key=lambda kv: -kv[1])[:15])
    return summary


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "refine-all":
        import argparse
        ap = argparse.ArgumentParser(prog="league.py refine-all", description=refine_all.__doc__)
        ap.add_argument("work_dir")
        ap.add_argument("--web-root", default=None, help="checkout whose registry.json supplies titles/upload dates (default: this one)")
        ap.add_argument("--backup-dir", default=None)
        ap.add_argument("--dry-run", action="store_true")
        a = ap.parse_args(sys.argv[2:])
        print(json.dumps(refine_all(a.work_dir, a.web_root, a.backup_dir, a.dry_run), indent=1))
    elif len(sys.argv) >= 3 and sys.argv[1] == "refine":
        obs = json.loads(sys.argv[2])
        date = sys.argv[3] if len(sys.argv) > 3 else None
        cands = sys.argv[4].split(",") if len(sys.argv) > 4 else None
        print(json.dumps(refine_battle_league(obs, cands, battle_date=date), indent=1))
    else:
        print(__doc__)
