"""League/cup inference for YouTube battle videos.

1. guess_league(meta, schedule): before analysis, from upload date (GBL schedule, with upload lag),
   title, tags, description and chapter titles -> leagueGuess, confidence, evidence, kindGuess.
2. refine_battle_league(observed, candidates, schedule, gamemaster): AFTER the Meta Extractor has
   analysed a battle, narrow the league per battle from observed CPs and species (cups whose
   rules the observed teams violate are eliminated). Usable from Node by shelling out:
       python3 -I league.py refine '{"cps":[1498,1500],"species":["medicham","azumarill"]}' 2025-01-10
   prints JSON with the ranked surviving formats.
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


def _cup_patterns(schedule):
    pats = {}
    for cid, c in schedule.get("cups", {}).items():
        if cid in BASE:
            continue
        names = [c.get("name", "")] + list(c.get("aliases", []))
        names = [re.escape(n.lower()) for n in names if n and len(n) >= 4]
        if names:
            pats[cid] = re.compile(r"(?<!\w)(" + "|".join(sorted(set(names), key=len, reverse=True)) + r")(?!\w)", re.I)
    return pats


_PAT_CACHE = {}


def keyword_hits(text, schedule):
    """Return {formatId: number_of_matches} for base leagues and named cups found in text."""
    text = text or ""
    hits = {}
    key = id(schedule)
    if key not in _PAT_CACHE:
        _PAT_CACHE.clear()
        _PAT_CACHE[key] = _cup_patterns(schedule)
    cup_found = False
    for cid, pat in _PAT_CACHE[key].items():
        n = len(pat.findall(text))
        if n:
            hits[cid] = n
            cup_found = True
    for lid, pat in LEAGUE_WORDS.items():
        n = len(re.findall(pat, text, re.I))
        if n:
            hits[lid] = n
    # "Little Cup" is a league here; a named cup with "great league" in its name ("Great League Remix")
    # counts for the cup, the base league stays as a weaker alternative.
    if cup_found and "great" in hits and re.search(r"great league remix|remix", text, re.I):
        hits["great"] = max(1, hits["great"] - 1)
    return hits


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
    kind = guess_kind(meta.get("title"), meta.get("chapters"), len(chap_leagues))
    if scores:
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
    _, cup = get_format(top[0], cups)
    name = (cup or {}).get("name") or top[0]
    sched_name = next((f.get("name") for p in schedule.get("periods", []) for f in p.get("formats", [])
                       if f.get("name") and format_key(f["id"], f.get("cp"), cups) == top[0]), None)
    if top[0] not in BASE and sched_name:
        name = sched_name          # e.g. "Great League: Mega Edition"
    elif cup and "@" in top[0]:
        name = f"{name} ({cup['cp']} CP)"
    return _with_championship({"leagueGuess": name, "leagueId": top[0], "leagueConfidence": conf,
                               "leagueEvidence": sorted(set(evidence))[:12], "cupCandidates": sorted(sched),
                               "kindGuess": kind}, meta)


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


def refine_battle_league(observed, candidates=None, schedule=None, gamemaster=None, battle_date=None):
    """Narrow the format of ONE analysed battle.

    observed: {"cps": [ints, both teams], "species": [PvPoke speciesIds seen, both teams],
               "moves": {speciesId: [MOVE_IDS]} optional,
               "teams": {"my": [{species, cp}], "opponent": [...]} optional -> adds "rocket" {flag, reasons}}
    candidates: format ids to consider (default: schedule formats around battle_date, else all
                four base leagues). Returns {"ranked": [{id,name,cp,score,reasons}], "eliminated":
                [{id,reason}], "cpCap": cap}."""
    schedule = schedule or load_schedule()
    gamemaster = gamemaster if gamemaster is not None else load_gamemaster()
    cups = schedule.get("cups", {})
    off_schedule = set()
    if not candidates:
        candidates = sorted(schedule_formats(schedule, battle_date, lag_days=0)) if battle_date else []
        if candidates:
            # Base leagues stay possible (friend battles, tournaments, schedule gaps) but rank lower.
            off_schedule = {b for b in BASE if b not in candidates}
            candidates += sorted(off_schedule)
        candidates = candidates or list(BASE)
    cps = [c for c in observed.get("cps") or [] if c]
    cap = cp_cap_for(cps) if cps else None
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
        ranked.append({"id": fid, "name": cup.get("name", fid), "cp": ccap, "score": round(score, 2), "reasons": reasons})
    ranked.sort(key=lambda r: (-r["score"], r["cp"], r["id"]))
    out = {"ranked": ranked, "eliminated": eliminated, "cpCap": cap}
    teams = observed.get("teams")
    if teams:
        out["rocket"] = rocket_evidence(teams.get("my"), teams.get("opponent"), gamemaster)
    return out


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "refine":
        obs = json.loads(sys.argv[2])
        date = sys.argv[3] if len(sys.argv) > 3 else None
        cands = sys.argv[4].split(",") if len(sys.argv) > 4 else None
        print(json.dumps(refine_battle_league(obs, cands, battle_date=date), indent=1))
    else:
        print(__doc__)
