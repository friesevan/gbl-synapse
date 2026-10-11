"""Optional YouTube Data API v3 metadata (videos.list, 50 ids per request, 1 quota unit each).

With a key, metadata no longer goes through YouTube's web player, which is what triggers
"Sign in to confirm you're not a bot"; the default 10,000 units/day covers ~500,000 videos.
The key is read from YOUTUBE_API_KEY in the environment, ~/.config/gbl-synapse/env or
~/.config/freellm/env (KEY=value lines). It is never logged or written anywhere.
"""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

ENV_FILES = [os.path.expanduser("~/.config/gbl-synapse/env"), os.path.expanduser("~/.config/freellm/env")]
API = "https://www.googleapis.com/youtube/v3/videos"
CHAPTER_RE = re.compile(r"^\s*[\(\[]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\)\]]?\s*[-–—:|]?\s*(.{2,80}?)\s*$", re.M)


class QuotaExceeded(Exception):
    pass


def api_key():
    k = os.environ.get("YOUTUBE_API_KEY")
    if k:
        return k.strip()
    for path in ENV_FILES:
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"\s*(?:export\s+)?YOUTUBE_API_KEY\s*=\s*['\"]?([^'\"\s]+)", line)
                    if m:
                        return m.group(1)
        except OSError:
            continue
    return None


def iso_duration(s):
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return None
    d, h, mi, se = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + se


def chapters_from_description(desc):
    out = []
    for t, title in CHAPTER_RE.findall(desc or ""):
        parts = [int(x) for x in t.split(":")]
        sec = parts[-1] + 60 * parts[-2] + (3600 * parts[-3] if len(parts) == 3 else 0)
        out.append({"start": sec, "title": title})
    # Real chapter lists start at 0:00 and increase.
    if len(out) < 2 or out[0]["start"] != 0 or any(b["start"] <= a["start"] for a, b in zip(out, out[1:])):
        return []
    return out[:80]


def to_meta(item, is_cc):
    """videos.list item -> the dict harvest.extract_meta() produces (format fields unknown)."""
    sn, cd, st, stats = item.get("snippet", {}), item.get("contentDetails", {}), item.get("status", {}), item.get("statistics", {})
    lic = "Creative Commons Attribution license (reuse allowed)" if st.get("license") == "creativeCommon" else "Standard YouTube License"
    desc = sn.get("description") or ""
    live = sn.get("liveBroadcastContent")
    return {
        "id": item["id"], "title": sn.get("title"), "channel": sn.get("channelTitle"), "channelId": sn.get("channelId"),
        "channelUrl": f"https://www.youtube.com/channel/{sn['channelId']}" if sn.get("channelId") else None,
        "uploadDate": (sn.get("publishedAt") or "")[:10].replace("-", "") or None,
        "durationS": iso_duration(cd.get("duration")), "license": lic, "creativeCommons": is_cc(lic),
        "maxWidth": None, "maxHeight": 720 if cd.get("definition") == "hd" else None, "fps": None, "orientation": None,
        "language": sn.get("defaultAudioLanguage") or sn.get("defaultLanguage"),
        "views": int(stats["viewCount"]) if stats.get("viewCount") else None, "tags": (sn.get("tags") or [])[:40],
        "categories": [], "description": desc[:3000], "chapters": chapters_from_description(desc),
        "liveStatus": {"live": "is_live", "upcoming": "is_upcoming"}.get(live, "not_live"),
        "availability": st.get("privacyStatus"), "estBytes": None, "metaSource": "data-api",
    }


def fetch(ids, key, timeout=30):
    """Returns {id: item} for available videos. Raises QuotaExceeded when today's quota is used up."""
    q = urllib.parse.urlencode({"part": "snippet,contentDetails,status,statistics", "id": ",".join(ids),
                                "maxResults": 50, "key": key})
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "gbl-synapse-harvester"}),
                                    timeout=timeout) as r:
            data = json.load(r)
    except urllib.error.HTTPError as ex:
        body = ex.read().decode("utf-8", "replace")
        if ex.code == 403 and re.search(r"quota|dailyLimit|rateLimit", body):
            raise QuotaExceeded() from None
        raise RuntimeError(f"YouTube Data API HTTP {ex.code}: {body[:200]}") from None
    return {it["id"]: it for it in data.get("items", [])}
