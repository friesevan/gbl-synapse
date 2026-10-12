"""Per-refit model metrics for the Validate tab's "Model performance" view (WORK/metrics-history.json).

feedback.py appends one compact record after every successful refit. Records rebuilt from saved files
when the history file was first created are marked ``backfilled`` and name their sources. A value that
was never recorded is left out (the UI shows a gap); nothing is estimated.

Record fields (all optional except refit/at):
  refit, at, startedAt, durationSec, reason   refit number (learning version), finish/start time, trigger
  answers / labels                            human answer records / confirmed labels per kind in the fit snapshot
  heldOut                                     per kind: right/total held out by video; Shadow adds logLoss,
                                              auc, brier and the old posterior as ``baseline``
  gates                                       resolution thresholds and their held-out support per kind
  calibration                                 [[mean predicted, observed, n], ...] per kind (latest bins)
  resolved / shadowValues / open / questions  queue state right after the refit
  models                                      Shadow classifier and evidence-settings (movefit) versions
"""
import datetime as dt
import json
import os
from pathlib import Path
import re
import uuid

FORMAT = "gbl-validation-metrics"
FILE = "metrics-history.json"
MAX_RECORDS = 2000
OTHER_SOURCES = {"freellm", "local-llm", "haiku"}   # external (LLM) resolvers, counted apart from the model
# Mirrors SHADOW_GATE in tests/meta-benchmark/learning-loop.cjs; used only when a refit's output lacks
# its own ``passes`` flags (outputs written before the history existed).
SHADOW_GATE = {"accuracy": .95, "calls": 25, "lowerBound": .8, "videos": 5}

# Offline evaluations documented before per-refit tracking began. They describe model changes measured
# with the same video-grouped held-out method, but they are not refits, so they are listed separately.
MILESTONES = [
    {"at": "2026-10-11T08:05:13+00:00", "commit": "6a11f05", "change": "Learned Shadow classifier",
     "source": "includes/meta/README.md, Shadow classifier (208 labels, 35 videos)",
     "shadow": {"before": {"right": 130, "total": 208, "logLoss": 0.653, "auc": 0.685},
                "after": {"right": 155, "total": 208, "logLoss": 0.513, "auc": 0.814}}},
    {"at": "2026-10-11T08:43:11+00:00", "commit": "13279f9", "change": "Fast-move and form model v4",
     "source": "includes/meta/README.md, Fast moves and forms (v4); yt-harvest/HANDOFF.md status ~09:00",
     "fastMove": {"before": {"right": 153, "total": 197}, "after": {"right": 161, "total": 197}},
     "form": {"before": {"right": 15, "total": 31}, "after": {"right": 23, "total": 31}}},
    {"at": "2026-10-11T19:25:23+00:00", "commit": "3a6c2e0", "change": "HP bars re-read on YouTube footage",
     "source": "yt-harvest/HANDOFF.md, status ~16:00 (HP-bar detection)",
     "fastMove": {"before": {"right": 161, "total": 197, "logLoss": 0.428}, "after": {"right": 165, "total": 197, "logLoss": 0.393}},
     "form": {"before": {"right": 23, "total": 31}, "after": {"right": 26, "total": 31}},
     "shadow": {"before": {"right": 157, "total": 208, "logLoss": 0.495, "auc": 0.823},
                "after": {"right": 171, "total": 208, "logLoss": 0.356, "auc": 0.917}}},
    {"at": "2026-10-11T21:18:25+00:00", "commit": "256fb9a", "change": "Shadow focus-shot features",
     "source": "includes/meta/README.md, Focus shots (410 labels, 125 videos)",
     "shadow": {"before": {"right": 299, "total": 410, "logLoss": 0.504, "auc": 0.829},
                "after": {"right": 323, "total": 410, "logLoss": 0.461, "auc": 0.870}}},
]


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _time(value):
    try:
        t = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def _iso(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat(timespec="seconds")


def _confirmed(a):
    return isinstance(a, dict) and a.get("value") is not None and a.get("source") != "model" and not a.get("modelResolved")


def _human(a):
    return isinstance(a, dict) and a.get("source") != "model" and not a.get("modelResolved")


def _count(items):
    out = {}
    for kind in items:
        out[kind or "other"] = out.get(kind or "other", 0) + 1
    return dict(sorted(out.items()))


def _round(x, n=4):
    return round(x, n) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _clean(d):
    return {k: v for k, v in d.items() if v is not None and v != {} and v != []}


def answer_counts(answers):
    """Human answer records and confirmed labels per kind."""
    answers = [a for a in answers if _human(a)]
    return _count(a.get("kind") for a in answers), _count(a.get("kind") for a in answers if _confirmed(a))


def queue_counts(questions, answers, resolutions):
    """Open questions per kind, and resolutions per source and kind, as the Validate tab counts them."""
    resolved, open_, values = {}, {}, {}
    for qid, q in questions.items():
        kind = q.get("kind") or "other"
        if _confirmed(answers.get(qid)):
            continue
        r = resolutions.get(qid)
        if r:
            source = r.get("source") if r.get("source") in OTHER_SOURCES else "model"
            resolved.setdefault(source, {})[kind] = resolved.get(source, {}).get(kind, 0) + 1
            if kind == "shadow" and source == "model":
                key = "shadow" if r.get("value") is True else "notShadow"
                values[key] = values.get(key, 0) + 1
            continue
        open_[kind] = open_.get(kind, 0) + 1
    return ({k: dict(sorted(v.items())) for k, v in sorted(resolved.items())}, dict(sorted(open_.items())), values)


def _bins(rows, keys):
    out = []
    for b in rows or []:
        if isinstance(b, dict) and b.get("n"):
            p, y = b.get(keys[0]), b.get(keys[1])
            if isinstance(p, (int, float)) and isinstance(y, (int, float)):
                out.append([_round(p, 3), _round(y, 3), int(b["n"])])
    return out


def _shadow_passes(t):
    return bool(t and t.get("accuracy", 0) >= SHADOW_GATE["accuracy"] and t.get("n", 0) >= SHADOW_GATE["calls"]
                and t.get("lowerBound", 0) >= SHADOW_GATE["lowerBound"] and (t.get("videos") or 0) >= SHADOW_GATE["videos"])


def model_metrics(learning):
    """Held-out accuracy, resolution gates, calibration bins and model versions stored by a refit."""
    cal, sm = learning.get("calibration") or {}, learning.get("shadowModel") or {}
    held, gates, bins = {}, {}, {}
    for kind in ("fastMove", "form"):
        c = cal.get(kind) or {}
        if c.get("heldOut"):
            held[kind] = _clean({"right": c.get("heldOutRight"), "total": c.get("heldOut"), "logLoss": _round(c.get("logLoss"))})
        if c:
            gates[kind] = _clean({"threshold": c.get("threshold"), "resolveAt": c.get("resolveAt"), "right": c.get("right"),
                                  "total": c.get("total"), "videos": c.get("videoCount"), "lowerBound": _round(c.get("lowerBound")),
                                  "resolving": c.get("threshold") is not None,
                                  "sweep": [list(x) for x in c.get("sweep") or [] if isinstance(x, (list, tuple)) and len(x) == 3]})
        if c.get("bins"):
            bins[kind] = _bins(c["bins"], ("meanP", "acc"))
    cv = sm.get("cv") or {}
    new, old = cv.get("new") or {}, cv.get("old") or {}
    if new.get("n"):
        base = _clean({"right": old.get("right"), "total": old.get("n"), "logLoss": _round(old.get("logLoss")),
                       "auc": _round(old.get("auc")), "brier": _round(old.get("brier"))}) if old.get("n") else None
        held["shadow"] = _clean({"right": new.get("right"), "total": new.get("n"), "logLoss": _round(new.get("logLoss")),
                                 "auc": _round(new.get("auc")), "brier": _round(new.get("brier")), "baseline": base})
    thresholds, passes = sm.get("thresholds") or {}, sm.get("passes") or {}
    shadow_gates = {}
    for direction in ("regular", "shadow"):
        t = thresholds.get(direction)
        if isinstance(t, dict) and t.get("n"):
            shadow_gates[direction] = _clean({"confidence": _round(t.get("confidence")), "right": t.get("right"), "total": t.get("n"),
                                              "videos": t.get("videos"), "lowerBound": _round(t.get("lowerBound")),
                                              "resolving": bool(passes[direction]) if direction in passes else _shadow_passes(t)})
    if shadow_gates:
        gates["shadow"] = shadow_gates
    if cv.get("calibration"):
        bins["shadow"] = _bins(cv["calibration"], ("meanP", "rate"))
    models = _clean({
        "shadowClassifier": _clean({"labels": sm.get("n"), "videos": sm.get("videos")}) if sm else None,
        "movefit": _clean({"fittedAt": learning.get("paramsFit"), "labels": learning.get("paramsLabels")}) if learning.get("paramsFit") else None})
    return _clean({"heldOut": held, "gates": gates, "calibration": bins, "models": models})


def build_record(version, learning, questions, answers, resolutions, snapshot=None, reason=None):
    """The record for refit ``version`` from feedback.json state right after it was saved."""
    given, labels = answer_counts(snapshot if snapshot is not None else answers.values())
    resolved, open_, values = queue_counts(questions, answers, resolutions)
    start, end = _time(learning.get("startedAt")), _time(learning.get("lastFit"))
    rec = {"refit": int(version), "at": learning.get("lastFit") or now(), "startedAt": learning.get("startedAt"),
           "durationSec": int((end - start).total_seconds()) if start and end and end >= start else None,
           "reason": reason or learning.get("reason"), "answers": given, "labels": labels,
           **model_metrics(learning),
           "resolved": resolved, "shadowValues": values, "open": open_, "questions": len(questions),
           "runsRefit": learning.get("runsRefit"), "errors": len(learning.get("errors") or [])}
    return _clean(rec)


# ---- backfill ----
_MOVE_REASON = re.compile(r"held-out (fastMove|form) answers at p ≥ ([\d.]+): (\d+)/(\d+) right over (\d+) videos \(95% lower bound ([\d.]+)%\)")
_SHADOW_REASON = re.compile(r"held-out (Shadow|not-Shadow) calls at ≥(\d+)% confidence were right (\d+)/(\d+) on (\d+) videos \(95% lower bound ([\d.]+)%\)")
_OLD_REASON = re.compile(r"held-out (shadow|form|fastMove) accuracy (\d+)/(\d+) \(95% lower bound ([\d.]+)%\)")


def gates_from_reasons(resolutions):
    """Resolution gates quoted in model-resolution reasons, per model version (feedback.json keeps the
    reason of every resolution it drops in ``history``)."""
    out = {}
    for r in resolutions:
        if not isinstance(r, dict) or r.get("source") != "model" or not isinstance(r.get("modelVersion"), int):
            continue
        reason, g = str(r.get("reason") or ""), out.setdefault(r["modelVersion"], {})
        m = _MOVE_REASON.search(reason)
        if m:
            g[m[1]] = {"resolveAt": float(m[2]), "right": int(m[3]), "total": int(m[4]), "videos": int(m[5]),
                       "lowerBound": round(float(m[6]) / 100, 4), "resolving": True}
        m = _SHADOW_REASON.search(reason)
        if m:
            g.setdefault("shadow", {})["shadow" if m[1] == "Shadow" else "regular"] = {
                "confidence": int(m[2]) / 100, "right": int(m[3]), "total": int(m[4]), "videos": int(m[5]),
                "lowerBound": round(float(m[6]) / 100, 4), "resolving": True}
        m = _OLD_REASON.search(reason)
        if m and m[1] != "shadow":
            g[m[1]] = {"resolveAt": 0.98, "right": int(m[2]), "total": int(m[3]), "lowerBound": round(float(m[4]) / 100, 4), "resolving": True}
    return {k: v for k, v in out.items() if v}


def answers_at(data, at):
    """Human answers that were saved at time ``at`` (replaced answers count until they were replaced)."""
    t, out = _time(at), []
    if t is None:
        return out
    for a in (data.get("answers") or {}).values():
        s = _time(a.get("answeredAt"))
        if s and s <= t:
            out.append(a)
    for h in data.get("history") or []:
        a = h.get("answer") if isinstance(h, dict) else None
        s, e = _time((a or {}).get("answeredAt")), _time(h.get("replacedAt")) if isinstance(h, dict) else None
        if a and s and e and s <= t < e:
            out.append(a)
    return out


def _refit_dirs(learning_dir):
    out = {}
    try:
        entries = list(os.scandir(learning_dir))
    except OSError:
        return out
    for e in entries:
        m = re.fullmatch(r"refit-(\d+)", e.name)
        if m and e.is_dir():
            out[int(m[1])] = Path(e.path)
    return out


def _dir_summary(path):
    """(files written, latest write time) for one refit output folder."""
    n, latest = 0, None
    try:
        for f in os.scandir(path):
            if f.name.endswith(".json") and f.is_file():
                n += 1
                latest = max(latest or 0, f.stat().st_mtime)
        latest = latest or path.stat().st_mtime
    except OSError:
        return 0, None
    return n, latest


def backfill(work, data, questions):
    """Records for refits that ran before the history existed, from saved files only."""
    learning, records = data.get("learning") or {}, []
    version = int(learning.get("version") or 0)
    dirs = _refit_dirs(Path(work) / "learning")
    drops = [h.get("resolution") for h in data.get("history") or [] if isinstance(h, dict)]
    reason_gates = gates_from_reasons(drops + list((data.get("resolutions") or {}).values()))
    full = version if version and (learning.get("calibration") or learning.get("shadowModel")) else None
    for n in sorted(set(dirs) | set(reason_gates)):
        if n < 1 or n > version or n == full:
            continue
        files, latest = _dir_summary(dirs[n]) if n in dirs else (None, None)
        rec = {"refit": n, "backfilled": True}
        sources = []
        if latest:
            rec["at"] = _iso(latest)
            rec["runsRefit"] = files
            given, labels = answer_counts(answers_at(data, rec["at"]))
            rec.update(answers=given, labels=labels)
            sources.append("time and runs refit: learning/refit-%d output files; answers and labels: feedback.json answers "
                           "saved by then (may include answers saved while the refit ran)" % n)
        if n in reason_gates:
            rec["gates"] = reason_gates[n]
            sources.append("gates: thresholds quoted in this refit's model-resolution reasons")
        if "at" not in rec:
            continue
        rec["source"] = "; ".join(sources)
        records.append(_clean(rec))
    if full:
        rec = build_record(full, learning, questions, data.get("answers") or {}, data.get("resolutions") or {})
        rec.update(backfilled=True, source="held-out metrics, gates and models: stored by refit %d in feedback.json learning; "
                   "answers, open and resolved counts: feedback.json when the history began (%s)" % (full, now()))
        for kind, g in reason_gates.get(full, {}).items():  # e.g. the effective fast-move threshold
            target = rec.setdefault("gates", {}).setdefault(kind, {})
            for key, value in g.items():
                target.setdefault(key, value)
        records.append(rec)
    return records


# ---- storage ----
def path_for(work):
    return Path(work) / FILE


def load(work):
    try:
        d = json.loads(path_for(work).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and d.get("format") == FORMAT and isinstance(d.get("records"), list) else None


def save(work, history):
    path = path_for(work)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def new_history(records=()):
    return {"format": FORMAT, "version": 1, "createdAt": now(), "updatedAt": now(), "revision": 1,
            "records": sorted(records, key=lambda r: r["refit"]), "milestones": MILESTONES}


def append(history, record):
    """Adds (or replaces, for the same refit number) one record; keeps the newest MAX_RECORDS."""
    records = [r for r in history.get("records", []) if r.get("refit") != record["refit"]]
    records.append(record)
    records.sort(key=lambda r: r["refit"])
    history.update(records=records[-MAX_RECORDS:], updatedAt=now(), revision=int(history.get("revision") or 0) + 1,
                   milestones=MILESTONES)
    return history


def summary(history):
    """What /api/validation carries on every poll: the revision and the latest record."""
    if not history:
        return {"revision": 0, "records": 0}
    records = history.get("records") or []
    return {"revision": history.get("revision", 0), "records": len(records), "latest": records[-1] if records else None}
