"""Download policy and battle-video relevance filter for the YouTube harvester.

Policy (owner decision, 2026-10-11): every plausible Pokémon GO battle video may be downloaded for
PRIVATE analysis and training. Licence/permission fields are still recorded on every registry entry
so that anything published later can be filtered to Creative Commons or consenting creators and
credited. `--cc-only` restores the stricter rule (CC licence or written permission only).

Never relaxed: videos stay local and outside the repo, are deleted after processing unless --keep,
only derived data (teams, moves, results) is committed, opponent trainer names are never stored,
videos/frames never go to free-tier APIs, no cookies / CAPTCHA bypassing / proxy rotation.
"""
import re

PVP = re.compile(r"(pok[eé]mon\s*go|\bpogo\b|\bgbl\b|go battle league|battle league|\bpvp\b|great league|ultra league|"
                 r"master league|little (?:cup|league)|liga (?:super|ultra|master|ball)|super ?liga|hyper ?liga|"
                 r"ligue (?:super|hyper|master)|meisterliga|スーパーリーグ|ハイパーリーグ|マスターリーグ|リトルカップ|"
                 r"バトルリーグ|gbl|ポケモンgo|ポケgo|\bcup\b|copa|coupe|\bremix\b|\bpremier\b|\blegend\b|\bveteran\b|"
                 r"\belo\b|\brating\b|\branked\b|\bvs\.?\b|\bteam\b|\bset\b|\bbattles?\b|\bbatallas?\b|\bkämpfe\b|"
                 r"\bplay!? ?pok[eé]mon\b|regionals?|worlds|internationals?|\bnaic\b|\beuic\b|\blaic\b|\bocic\b)", re.I)
GAME = re.compile(r"(pok[eé]mon\s*go|\bpogo\b|\bgbl\b|go battle league|ポケモンgo|ポケgo|pvpoke|"
                  r"great league|ultra league|master league|liga super|liga ultra|liga master|"
                  r"スーパーリーグ|ハイパーリーグ|マスターリーグ)", re.I)
NEGATIVE = re.compile(r"(#shorts?\b|\braids?\b|shiny (?:hunt|check)|community day|spotlight hour|unboxing|pack opening|"
                      r"\btcg\b|pocket|scarlet|violet|showdown|\bvgc\b|\bunite\b|legends? (?:arceus|z-a|za)|anime|"
                      r"pok[eé]mon sleep|egg hatch|hatching|max battle|dynamax raid|"
                      r"gigantamax|research|spoofing|spoofer|\bnews\b|\bleaks?\b|datamine|catch(?:ing)? (?:every|all)|"
                      r"mewtwo raid|minecraft|palworld|fortnite|roblox)", re.I)
# Learned from reviewer footage answers (relevance-feedback.json, 2026-10-11): 28 of 36 "no battles
# found" videos had no battle footage. Greek basketball ("STOIXIMAN GBL") highlights, another game
# (Pokémon Champions) and these PvE/news topics never showed GBL battles. OTHER_SPORT/OTHER_GAME
# always veto; NON_PVP vetoes only titles without a PvP marker (a "Color Cup" or "Great League"
# title with "shiny" or "raid" in it keeps a soft penalty instead).
OTHER_SPORT = re.compile(r"(stoiximan|basket(?:ball)?|euroleague|\bnba\b|\bfiba\b|\bgbl (?:round|rnd)\b|full highlights|"
                         r"highlights?\b.{0,40}\b\d{2,3}\s*[-–]\s*\d{2,3}\b|\b\d{2,3}\s*[-–]\s*\d{2,3}\b.{0,40}\bhighlights?)", re.I)
OTHER_GAME = re.compile(r"(?<!play )(?<!play! )pok[eé]mon champions\b", re.I)   # the separate game; vetoed without "Pokémon GO"
NON_PVP = re.compile(r"(\braids?\b|raid (?:day|hour|invites?)|max (?:battles?|monday|out)|gigantamax|\bg-?max\b|dynamax|"
                     r"community day|spotlight hour|costume|lucky trades?|\bhundo\b|\bshundo\b|new shiny|shiny (?:hunt|check|odds)|"
                     r"guaranteed shiny|\bevent\b|forecast|coming to pok[eé]mon go|this week in|\btips\b|wild area|"
                     r"rocket radars?|\bradar\b|bottle caps?|stardust|\bsolo(?:ed|ing)?\b|\bduo(?:ed|ing)?\b|go fest|"
                     r"unboxing|giveaway|\btcg)", re.I)
PVP_MARKER = re.compile(r"(great league|ultra league|master league|little (?:cup|league)|\bcup\b|copa|coupe|"
                        r"go battle league|battle league|\bpvp\b|\bgbl\b|liga (?:super|ultra|master|ball)|super ?liga|hyper ?liga|"
                        r"ligue (?:super|hyper|master)|meisterliga|スーパーリーグ|ハイパーリーグ|マスターリーグ|リトルカップ|バトルリーグ|"
                        r"\blegend\b|\bveteran\b|\bexpert\b|\belo\b|\branked\b|leaderboard|\bremix\b|\bpremier\b|"
                        r"regionals?|worlds|internationals?|\bnaic\b|\beuic\b|\blaic\b|\bocic\b|play!? ?pok[eé]mon|"
                        # Team GO Rocket battles look like GBL and train the extractor (never the meta).
                        r"rocket grunts?|\bgrunts?\b|team (?:go )?rocket|rocket (?:leaders?|boss|battles?)|giovanni|"
                        r"\b(?:sierra|cliff|arlo)\b)", re.I)
TALK = re.compile(r"(tier list|rankings? update|\bguide\b|explained|\bnews\b|\bpodcast\b|\breaction\b|"
                  r"\bupdate\b|\bpredictions?\b)", re.I)
NO_BATTLE_FOOTAGE_DURATION_S = 120   # Shorts and teasers
MAX_DOWNLOAD_DURATION_S = 3 * 3600   # longer = stream VOD; overridable


def relevance(title, duration=None, tags=(), description="", categories=(), channel_battle_hits=0, species_hit=False):
    """Score how plausible it is that a video shows Pokémon GO PvP battles.

    Returns (score, label) with label in {"relevant", "maybe", "no"}. Uses title first, then tags,
    description and the channel's history (channels that already produced battle videos get credit,
    because many creators title videos only with Pokémon names)."""
    title = title or ""
    text_tags = " ".join(tags or ())
    desc = (description or "")[:1500]
    score = 0.0
    if duration is not None and duration < NO_BATTLE_FOOTAGE_DURATION_S:
        return -5.0, "no"
    if re.search(r"#shorts?\b", title + " " + text_tags, re.I):
        return -5.0, "no"
    if GAME.search(title):
        score += 2
    elif GAME.search(text_tags) or GAME.search(desc):
        score += 1
    pvp_hits = len(set(m.group(0).lower() for m in PVP.finditer(title)))
    score += min(pvp_hits, 3) * 0.75
    if PVP.search(text_tags):
        score += 0.5
    if species_hit:
        score += 0.75
    if channel_battle_hits >= 3:
        score += 1.5
    elif channel_battle_hits >= 1:
        score += 0.75
    if OTHER_SPORT.search(title) or (OTHER_GAME.search(title) and not GAME.search(title)):
        return -5.0, "no"
    non_pvp = NON_PVP.search(title)
    if non_pvp and not PVP_MARKER.search(title):
        return min(score, 0.0) - 3.0, "no"
    if NEGATIVE.search(title):
        score -= 2.5
    elif non_pvp:
        score -= 1.0
    if TALK.search(title) and not re.search(r"\b(battles?|gameplay|vs|ranked|legend|set)\b", title, re.I):
        score -= 1
    if categories and "Gaming" not in categories:
        score -= 1
    label = "relevant" if score >= 2.5 else "maybe" if score >= 1.25 else "no"
    return round(score, 2), label


def is_cc(license_text):
    return bool(license_text) and "creative commons" in license_text.lower()


def has_written_permission(permission):
    return bool(permission) and bool(re.search(r"agreed|written|consent|granted", permission, re.I)) \
        and not re.search(r"not requested|declined|refused", permission, re.I)


def download_allowed(entry, cc_only=False, max_duration_s=MAX_DOWNLOAD_DURATION_S):
    """THE download policy check. Returns (allowed: bool, reason: str).

    entry: dict with relevanceLabel, durationS, liveStatus, availability, license, permission.
    Default (owner policy 2026-10-11): any video that passes the battle-video relevance filter.
    cc_only=True: additionally require a Creative Commons licence or written creator permission."""
    if entry.get("relevanceLabel") != "relevant":
        return False, "not a plausible battle video"
    if entry.get("liveStatus") in ("is_live", "is_upcoming", "post_live"):
        return False, "live/upcoming stream"
    if entry.get("availability") not in (None, "public", "unlisted"):
        return False, "not publicly available"
    d = entry.get("durationS")
    if d is None:
        return False, "unknown duration"
    if d < NO_BATTLE_FOOTAGE_DURATION_S:
        return False, "too short"
    if max_duration_s and d > max_duration_s:
        return False, "longer than max duration"
    if cc_only and not (is_cc(entry.get("license")) or has_written_permission(entry.get("permission"))):
        return False, "cc-only mode: not CC and no written permission"
    return True, "battle video (private analysis)" if not cc_only else "CC or written permission"
