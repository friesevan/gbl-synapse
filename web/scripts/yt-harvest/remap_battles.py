"""Move battle-addressed labels onto a re-extracted result whose battle structure changed, then install that result.

Labels address battles by index: qids `<source>:<id>.mp4:<battle>:...` (answers, resolutions, predictions, fit and
side-effect signatures, question copies and manual-review flags in feedback.json; validation/<id>/*.json question
files and their manifest), the `battle` field of answers and questions, and labels/<id>.json (`verified` keyed by qid,
`battles[n]` with n = index + 1). reextract-labelled.cjs therefore installs a new result only when its battles are
unchanged; with `--keep DIR` it saves every re-extracted result instead, and this tool installs those.

Matching. Old and new battles are matched by time overlap (an overlap counts when it covers >= 25% of the shorter
battle, and >= 1 s). Each old battle is `same` (one old, one new), `merged` (several old -> one new), `split` (one old ->
several new) or `gone` (no new battle overlaps it); a new battle no old one overlaps is `new`. Teams and CPs are the
check: the report counts the old Pokémon found (same side, same key) in the matched new battles, and with the same CP.

Rules.
  - A battle-scoped record moves to the matched new battle. For a Pokémon (my/opponent:<key>) the new battle must have
    that key on that side; among several (a split) the one whose span holds the question's clip wins, else the most
    overlap of the Pokémon's own first..last time. Results anchor on the old battle's end, leads on its start.
  - A record whose own battle no longer holds its Pokémon (answered against an older analysis) is first realigned to
    the old battle that holds both that Pokémon and the question's clip. A Pokémon the old battle only glimpsed at its
    edge (often the next battle's lead) follows itself: when no matched new battle has it but exactly one new battle
    shows that key on that side at the question's moment, the record goes there.
  - Merged battles: answers that agree are kept once (the duplicate is archived as merged); on a conflict the human
    answer from the old battle covering more of the new battle is kept and the other archived with the reason. A
    "Not sure" never conflicts with a confirmed answer.
  - Gone battles, or a Pokémon the matched battle no longer has: the answer is archived, never deleted.
  - Video-wide records (no battle index in the qid: footage, league, perspective, all-battles Rocket) are unchanged;
    their per-battle copy in labels/<id>.json follows its battle.
  - Archived human answers go to feedback.json `history` ({"answer", "replacedAt", "reason", "remap"}), to
    labels/<id>.json `archived` when it held them, and to the backup's remap-report.json. The tool aborts if the count
    of human answers before != after + archived.
  - Derived records are invalidated: the video's model/timeline/policy resolutions are reopened (history records) and
    its predictions dropped, both re-derived by the next refit; fit signatures of its answers are cleared, so they count
    as pending and the next answer (or Retrain) refits; external (LLM) resolutions move like answers. results/<id>.
    leagues.json is rebuilt from the new result (league.refine_video), focus/<id>.json is retired when the new result
    has its own focus moments (else rebucketed by time), and the Validate inbox is rebuilt from validation/.
  - The new result replaces results/<id>.json; the old one becomes results/<id>.json.previous. A "new" result whose
    battles equal the saved ones is not reinstalled: passing copies of saved results only realigns answers whose
    battle index went stale in an earlier re-analysis.

Safety. Writes need feedback.py's lease (feedback.lock), so the tool refuses while the local app runs. Every file it
writes or deletes is first copied to a dated backup folder (WORK/remap-backup-YYYYMMDD-HHMMSS/, with backup.json);
`--restore DIR` puts them all back. Each write is atomic, feedback.json last. `--dry-run` writes nothing.

  python3 -I remap_battles.py WORK_DIR --new DIR [--only id,id] [--dry-run] [--inbox PATH] [--report FILE]
  python3 -I remap_battles.py WORK_DIR --restore WORK_DIR/remap-backup-YYYYMMDD-HHMMSS
"""
import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import feedback as F  # noqa: E402
import league as L  # noqa: E402
import validate as V  # noqa: E402

WEB = os.path.normpath(os.path.join(HERE, "..", ".."))
INBOX = os.path.join(WEB, "tests", "meta-benchmark", "results", "validation-inbox.json")
REGISTRY = os.path.join(WEB, "tests", "meta-benchmark", "sources", "registry.json")

QID = re.compile(r"^(?P<src>[^:]+):(?P<vid>.+?)\.mp4:(?P<battle>\d+):(?P<rest>.+)$")
MEMBER = re.compile(r"^(?P<side>my|opponent):(?P<key>[^:]+):(?P<what>\w+)$")
# An overlap counts when it covers >= 25% of the shorter battle (and >= 1 s): boundary jitter between consecutive
# battles (a few seconds of the next battle's intro) does not, a fragment inside a rejoined battle does.
SIGNIFICANT_FRAC, SIGNIFICANT_MIN_S = 0.25, 1.0
REMAP_REASON = "Battle structure changed (re-extracted result installed by remap_battles.py)"
LEASE_HELD = ("The local app (run_app.py) holds feedback.lock for this work directory and keeps feedback.json in memory. "
              "Stop the app, then run this again.")


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def human(a):
    """A reviewer's answer (Not sure included): never a model, timeline, policy or LLM resolution."""
    return isinstance(a, dict) and a.get("source") != "model" and not a.get("modelResolved")


# ------------------------------------------------------------------------------------------------- matching

def span(b):
    s = float(b.get("start") or 0)
    e = b.get("end")
    return s, max(s, float(e if e is not None else s))


def overlap(a, b):
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def significant(ov, d1, d2):
    return ov > 0 and ov >= max(SIGNIFICANT_MIN_S, SIGNIFICANT_FRAC * min(d1, d2))


def member(b, side, key):
    return next((p for p in (b or {}).get(side) or [] if isinstance(p, dict) and p.get("key") == key), None)


def member_span(p, b):
    lo, hi = span(b)
    try:
        return float(p.get("first", lo)), float(p.get("last", hi))
    except (TypeError, ValueError):
        return lo, hi


def match_battles(old_full, new_full):
    """Old -> new battles by time overlap. Returns {ov, olds: [{status, to}], news: [{status, from}], checks}."""
    so, sn = [span(b) for b in old_full], [span(b) for b in new_full]
    ov = [[overlap(a, b) for b in sn] for a in so]
    to = [[j for j in range(len(sn)) if significant(ov[i][j], so[i][1] - so[i][0], sn[j][1] - sn[j][0])] for i in range(len(so))]
    for i, a in enumerate(so):   # a battle seen for under a second (a single HUD read) belongs to the one around it
        if not to[i] and a[1] - a[0] < SIGNIFICANT_MIN_S:
            to[i] = [j for j, b in enumerate(sn) if b[0] <= (a[0] + a[1]) / 2 <= b[1]][:1]
    frm = [[i for i in range(len(so)) if j in to[i]] for j in range(len(sn))]
    olds, news = [], []
    for i, js in enumerate(to):
        status = "gone" if not js else "split" if len(js) > 1 else "merged" if len(frm[js[0]]) > 1 else "same"
        found = cp_same = total = 0
        for side in ("my", "opponent"):
            for p in old_full[i].get(side) or []:
                if not isinstance(p, dict) or not p.get("key"):
                    continue
                total += 1
                hits = [member(new_full[j], side, p["key"]) for j in js]
                hits = [h for h in hits if h]
                found += bool(hits)
                cp_same += any(h.get("cp") == p.get("cp") for h in hits)
        olds.append({"status": status, "to": js, "members": total, "found": found, "sameCp": cp_same})
    for j, is_ in enumerate(frm):
        news.append({"status": "new" if not is_ else "merged" if len(is_) > 1 else "split" if len(to[is_[0]]) > 1 else "same",
                     "from": is_})
    return {"ov": ov, "olds": olds, "news": news, "oldSpans": so, "newSpans": sn}


def anchor_battle(m, i):
    """The new battle that carries old battle i's per-battle copies (most overlap), or None."""
    js = m["olds"][i]["to"] if 0 <= i < len(m["olds"]) else []
    return max(js, key=lambda j: (m["ov"][i][j], -j)) if js else None


def clip_mid(q):
    clip = (q or {}).get("clip")
    if isinstance(clip, (list, tuple)) and len(clip) == 2 and all(isinstance(x, (int, float)) for x in clip):
        return (clip[0] + clip[1]) / 2
    return None


def within(t, s, pad_before=2.0, pad_after=10.0):
    return t is not None and s[0] - pad_before <= t <= s[1] + pad_after


def decide(qid, q, old_full, new_full, m):
    """Where one battle-scoped record goes. Returns {old, new, qid, status, why} with status kept | moved | archived
    (new/qid None); old is the effective old battle (realigned when the qid's own battle lacks its Pokémon)."""
    p = QID.match(qid)
    i, rest = int(p["battle"]), p["rest"]
    mm = MEMBER.match(rest)
    t = clip_mid(q)
    out = {"from": qid, "old": i, "new": None, "qid": None, "status": "archived", "why": None, "realigned": None, "via": None}
    if mm:
        side, key = mm["side"], mm["key"]
        own = 0 <= i < len(old_full) and member(old_full[i], side, key)
        if not own or (t is not None and not within(t, m["oldSpans"][i])):
            hold = [k for k, b in enumerate(old_full) if k != i and member(b, side, key) and within(t, m["oldSpans"][k])]
            if len(hold) == 1:
                out["realigned"], i = i, hold[0]
                out["old"] = i
            elif not own:
                out["why"] = f"battle {i + 1} of the saved result has no {side} {key}" + (" and no other battle holds it at the question's clip" if t is not None else "")
                return out
    elif not (0 <= i < len(old_full)):
        out["why"] = f"battle {i + 1} is not in the saved result ({len(old_full)} battles)"
        return out
    cands = list(m["olds"][i]["to"])
    if mm:
        # A Pokémon the old battle only glimpsed at its edge (the next battle's lead) may now open a neighbouring battle:
        # it follows the Pokémon when exactly one new battle shows that key on that side at the question's moment.
        at = t if t is not None else sum(member_span(member(old_full[i], side, key), old_full[i])) / 2
        seen = [j for j, b in enumerate(new_full) if member(b, side, key) and within(at, member_span(member(b, side, key), b), 2.0, 2.0)]
        if not any(member(new_full[j], side, key) for j in cands) and len(seen) == 1:
            out["via"] = "pokemon"
            cands = seen
    if not cands:
        out["why"] = f"battle {i + 1} is gone: no new battle overlaps {m['oldSpans'][i][0]:.1f}-{m['oldSpans'][i][1]:.1f} s"
        return out
    if mm:
        with_key = [j for j in cands if member(new_full[j], side, key)]
        if not with_key:
            here = sorted({x.get("key") for j in cands for x in new_full[j].get(side) or [] if isinstance(x, dict)} - {None})
            out["why"] = (f"{side} {key} is not in the matched new battle {', '.join(str(j + 1) for j in cands)}"
                          f" (it has {', '.join(here) or 'nobody'} on that side)")
            return out
        cands = with_key
    if len(cands) > 1:
        old_b = old_full[i]
        if t is None:
            if mm:
                t = sum(member_span(member(old_b, side, key), old_b)) / 2
            elif rest == "result":
                t = m["oldSpans"][i][1] - 1
            else:   # lead, rocket and other battle-start questions
                t = m["oldSpans"][i][0] + 1
        holding = [j for j in cands if within(t, m["newSpans"][j], 0.5, 0.5 if mm else 10.0)]
        if len(holding) == 1:
            cands = holding
        elif mm:
            mine = member_span(member(old_b, side, key), old_b)
            cands = [max(cands, key=lambda j: (overlap(mine, member_span(member(new_full[j], side, key), new_full[j])), m["ov"][i][j], -j))]
        else:
            cands = [max(cands, key=lambda j: (m["ov"][i][j], -j))]
    j = cands[0]
    target = f"{p['src']}:{p['vid']}.mp4:{j}:{rest}"
    out.update(new=j, qid=target, status="kept" if target == qid else "moved")
    return out


def moved_doc(doc, d, stamp=None):
    """A question or answer re-addressed to its new battle (qid, battle, "Battle N" in the title)."""
    out = copy.deepcopy(doc)
    if d["qid"] == d["from"]:
        return out
    out["qid"] = d["qid"]
    out["battle"] = d["new"]
    if isinstance(out.get("title"), str):
        out["title"] = re.sub(r"^Battle \d+", f"Battle {d['new'] + 1}", out["title"])
    if stamp:
        out["remap"] = {"from": d["from"], "at": stamp}
    return out


def winners(entries, m):
    """Collision groups -> {new qid: winning old qid}, plus {old qid: reason} for the losers.
    entries: {old qid: (record, decision)}; a confirmed answer beats Not sure; then the old battle covering more of the
    new battle; then the later answer."""
    groups = {}
    for old, (rec, d) in entries.items():
        if d["qid"]:
            groups.setdefault(d["qid"], []).append(old)
    win, lost = {}, {}
    for new_qid, olds in groups.items():
        def rank(o):
            rec, d = entries[o]
            return (F.confirmed(rec) if isinstance(rec, dict) else False, m["ov"][d["old"]][d["new"]],
                    str((rec or {}).get("answeredAt") or (rec or {}).get("resolvedAt") or ""), o == new_qid)
        best = max(olds, key=rank)
        win[new_qid] = best
        kept = entries[best][0]
        for o in olds:
            if o == best:
                continue
            rec = entries[o][0]
            if not F.confirmed(rec):
                lost[o] = f"merged into {new_qid}: Not sure, superseded by the answer kept there"
            elif rec.get("value") == (kept or {}).get("value"):
                lost[o] = f"merged into {new_qid}: same answer ({json.dumps(rec.get('value'))}) as the one kept"
            else:
                lost[o] = (f"conflict in {new_qid}: {json.dumps(rec.get('value'))} vs kept {json.dumps(kept.get('value'))}; kept the "
                           f"answer from old battle {entries[best][1]['old'] + 1}, which covers more of new battle {entries[best][1]['new'] + 1}")
    return win, lost


# ------------------------------------------------------------------------------------------------- planning

def read(path, default=None):
    return F.read_json(path, default)


class Plan:
    """Every file change for a set of videos, computed in memory first (nothing is written by planning)."""

    def __init__(self, work, web=WEB, inbox=INBOX, stamp=None):
        self.work, self.web, self.inbox = Path(work), Path(web), inbox
        self.stamp = stamp or now()
        self.data = read(self.work / "feedback.json", {})
        for key in ("answers", "resolutions", "manualReview", "fitSignatures", "questions", "sideEffectSignatures", "predictions"):
            self.data.setdefault(key, {})
        self.data.setdefault("history", [])
        self.files = {}      # Path -> new content (dict, or bytes for a copy) | None (delete)
        self.reports = []
        self.registry = None
        self.humans_before = self.count_humans()

    # Human answers: feedback answers plus labels-only (legacy) entries, plus archive records written by this tool.
    def count_humans(self, data=None, labels_override=None):
        data = data or self.data
        seen = {q for q, a in data["answers"].items() if human(a)}
        n = len(seen)
        ldir = self.work / "labels"
        for f in sorted(ldir.glob("*.json")) if ldir.is_dir() else []:
            lab = (labels_override or {}).get(f, read(f, {}))
            for q, a in ((lab or {}).get("verified") or {}).items():
                if human(a) and q not in seen and (a or {}).get("qid", q) not in seen:
                    n += 1
        return n

    def add_video(self, vid, new_path):
        work, d = self.work, self.data
        res_path = work / "results" / (vid + ".json")
        old, new = read(res_path, None), read(new_path, None)
        rep = {"videoId": vid, "skipped": None}
        self.reports.append(rep)
        if not isinstance(old, dict) or not isinstance(old.get("full"), list):
            rep["skipped"] = "no saved result"
            return rep
        if not isinstance(new, dict) or not isinstance(new.get("full"), list):
            rep["skipped"] = "the new result is unreadable"
            return rep
        if (res_path.parent / (vid + ".json.tmp")).exists():
            rep["skipped"] = "a re-analysis is writing results/" + vid + ".json.tmp"
            return rep
        if old.get("crop") != new.get("crop") or (old.get("ranges") or None) != (new.get("ranges") or None):
            rep["skipped"] = "the saved result's crop or ranges differ from the re-extraction's (re-analysed since?)"
            return rep
        requeued = [p.name for p in (work / "requeue").glob("*.json") if read(p, {}).get("videoId") == vid] if (work / "requeue").is_dir() else []
        if requeued:
            rep["warning"] = f"pending re-analysis request(s) {', '.join(requeued)}: the harvester will replace this result again"
        old_full, new_full = old["full"], new["full"]
        m = match_battles(old_full, new_full)
        rep.update(before=len(old_full), after=len(new_full), olds=m["olds"], news=[{k: v for k, v in x.items()} for x in m["news"]])

        def scoped(q):
            mq = QID.match(str(q))
            return bool(mq) and mq["vid"] == vid

        labels_path = work / "labels" / (vid + ".json")
        labels = read(labels_path, None)
        lverified = (labels or {}).get("verified") or {}
        qdir = work / "validation" / vid
        qfiles = {}
        for f in sorted(qdir.glob("*.json")) if qdir.is_dir() else []:
            if f.name == "manifest.json":
                continue
            doc = read(f, None)
            if isinstance(doc, dict):
                qfiles[f] = doc
        file_by_qid = {doc.get("qid") or f.stem: doc for f, doc in qfiles.items()}

        def question(qid):
            return d["questions"].get(qid) or file_by_qid.get(qid) or {}

        cache = {}

        def dec(qid):
            if qid not in cache:
                cache[qid] = decide(qid, question(qid), old_full, new_full, m)
            return cache[qid]

        # Human answers: feedback answers, plus labels-only (legacy) entries.
        answers = {q: (a, dec(q)) for q, a in d["answers"].items() if scoped(q)}
        legacy = {q: (a, dec(q)) for q, a in lverified.items() if scoped(q) and q not in d["answers"] and human(a)}
        win, lost = winners({**answers, **legacy}, m)
        archive, moves, counts = [], [], {"kept": 0, "moved": 0, "merged": 0, "conflicts": 0, "archived": 0, "realigned": 0}

        def fate(q, dd):
            if dd["qid"] is None:
                return "archived", dd["why"]
            if win.get(dd["qid"]) != q:
                return "lost", lost.get(q)
            return dd["status"], None

        new_answers = {q: a for q, a in d["answers"].items() if not scoped(q)}
        for q, (a, dd) in sorted(answers.items()):
            what, why = fate(q, dd)
            counts["realigned"] += dd["realigned"] is not None
            if what in ("kept", "moved"):
                counts[what] += 1
                new_answers[dd["qid"]] = moved_doc(a, dd, self.stamp)
                if what == "moved":
                    moves.append({"from": q, "to": dd["qid"], "kind": a.get("kind"), "value": a.get("value"),
                                  "oldBattle": dd["old"] + 1, "newBattle": dd["new"] + 1,
                                  **({"realignedFrom": dd["realigned"] + 1} if dd["realigned"] is not None else {}),
                                  **({"via": dd["via"]} if dd["via"] else {})})
            else:
                kind = "conflicts" if why and why.startswith("conflict") else "merged" if what == "lost" else "archived"
                counts[kind] += 1
                archive.append({"qid": q, "answer": a, "question": d["questions"].get(q), "reason": why, "kind": kind,
                                "target": dd["qid"], "oldBattle": dd["old"] + 1})
        for q, (a, dd) in sorted(legacy.items()):
            what, why = fate(q, dd)
            if what not in ("kept", "moved"):
                kind = "conflicts" if why and why.startswith("conflict") else "merged" if what == "lost" else "archived"
                counts[kind] += 1
                archive.append({"qid": q, "answer": a, "reason": why, "kind": kind, "target": dd["qid"], "legacy": True,
                                "oldBattle": dd["old"] + 1})
            else:
                counts[what] += 1
        rep.update(answers=counts, moves=moves, archive=[{k: v for k, v in x.items() if k not in ("answer", "question")} | {"value": x["answer"].get("value")} for x in archive])

        # feedback.json, keyed by qid.
        stamp = self.stamp
        history = d["history"]
        for x in archive:
            history.append({"answer": x["answer"], "replacedAt": stamp, "archivedAt": stamp, "reason": REMAP_REASON + ": " + str(x["reason"]),
                            "remap": {"videoId": vid, "kind": x["kind"], "target": x["target"], "question": x.get("question")}})
        for mv in moves:
            history.append({"qid": mv["from"], "movedTo": mv["to"], "remappedAt": stamp, "reason": REMAP_REASON,
                            "remap": {"videoId": vid, "oldBattle": mv["oldBattle"], "newBattle": mv["newBattle"]}})
        d["answers"] = new_answers

        def rekey(table):
            out = {q: v for q, v in table.items() if not scoped(q)}
            for q, v in table.items():
                if not scoped(q):
                    continue
                dd = dec(q)
                if q in answers or q in legacy:
                    what, _ = fate(q, dd)
                    if what in ("kept", "moved"):
                        out[dd["qid"]] = v
                elif dd["qid"] and dd["qid"] not in out:
                    out[dd["qid"]] = v
            return out

        # Question copies of answered questions move with their answers.
        qcopies = {q: v for q, v in d["questions"].items() if not scoped(q)}
        for q, v in d["questions"].items():
            if scoped(q):
                dd = dec(q)
                if q in answers:
                    what, _ = fate(q, dd)
                    if what in ("kept", "moved"):
                        qcopies[dd["qid"]] = moved_doc(v, dd)
                elif dd["qid"] and dd["qid"] not in new_answers and dd["qid"] not in qcopies:
                    qcopies[dd["qid"]] = moved_doc(v, dd)
        d["questions"] = qcopies
        d["sideEffectSignatures"] = rekey(d["sideEffectSignatures"])
        d["manualReview"] = rekey(d["manualReview"])
        # Derived: re-derived by the next refit.
        dropped_fit = [q for q in d["fitSignatures"] if scoped(q)]
        for q in dropped_fit:
            d["fitSignatures"].pop(q)
        dropped_pred = [q for q in d["predictions"] if scoped(q)]
        for q in dropped_pred:
            d["predictions"].pop(q)
        res_counts = {"reopened": 0, "externalMoved": 0, "externalDropped": 0}
        external = {}
        resolutions = {}
        for q, r in d["resolutions"].items():
            if not scoped(q):
                resolutions[q] = r
            elif (r or {}).get("source") in F.EXTERNAL_SOURCES:
                external[q] = (r, dec(q))
            else:
                res_counts["reopened"] += 1
                history.append({"qid": q, "resolution": r, "reopenedAt": stamp, "reason": REMAP_REASON + "; re-derived at the next refit"})
        ext_win, _ = winners(external, m)
        for q, (r, dd) in external.items():
            target = dd["qid"]
            if target and ext_win.get(target) == q and not F.confirmed(new_answers.get(target, {})):
                resolutions[target] = r
                res_counts["externalMoved"] += target != q
            else:
                res_counts["externalDropped"] += 1
                history.append({"qid": q, "resolution": r, "reopenedAt": stamp,
                                "reason": REMAP_REASON + ": " + (dd["why"] or "a person's answer or another resolution holds " + str(target))})
        d["resolutions"] = resolutions
        rep.update(derived={"fitSignaturesCleared": len(dropped_fit), "predictionsDropped": len(dropped_pred), **res_counts})

        # labels/<id>.json
        if isinstance(labels, dict):
            lab = copy.deepcopy(labels)
            nv = {q: a for q, a in lverified.items() if not scoped(q)}
            for q, a in lverified.items():
                if not scoped(q):
                    continue
                dd = dec(q)
                what, why = fate(q, dd)
                if what in ("kept", "moved"):
                    nv[dd["qid"]] = moved_doc(a, dd, stamp)
                else:
                    lab.setdefault("archived", []).append({"qid": q, "answer": a, "archivedAt": stamp, "reason": REMAP_REASON + ": " + str(why or dd["why"])})
            lab["verified"] = nv
            entries = {}
            for e in sorted(labels.get("battles") or [], key=lambda e: int(e.get("n") or 0)):
                i = int(e.get("n") or 0) - 1
                placed = False
                for kind, a in sorted((e.get("verified") or {}).items(), key=lambda kv: str((kv[1] or {}).get("answeredAt") or "")):
                    q = (a or {}).get("qid")
                    if q and scoped(q):
                        dd = dec(q)
                        what, _ = fate(q, dd)
                        if what not in ("kept", "moved"):
                            continue
                        j, a2 = dd["new"], moved_doc(a, dd, stamp)
                    else:   # a video-wide answer's per-battle copy follows its battle
                        j, a2 = anchor_battle(m, i), a
                        if j is None:
                            continue
                    entry = entries.setdefault(j, {"n": j + 1, "verified": {}})
                    F.apply_battle_label(entry, kind, a2)
                    placed = True
                    for k, v in e.items():
                        if k not in ("n", "verified", "result", "ending", "leagueId", "battleType"):
                            entry.setdefault(k, v)
                if not placed and not (e.get("verified") or {}):
                    j = anchor_battle(m, i)
                    if j is not None:
                        entry = entries.setdefault(j, {"n": j + 1, "verified": {}})
                        for k, v in e.items():
                            if k not in ("n", "verified"):
                                entry.setdefault(k, v)
            if "battles" in labels:
                lab["battles"] = [entries[j] for j in sorted(entries)]
            if lab != labels:
                self.files[labels_path] = lab

        # validation/<id>/: question files re-addressed; collisions and gone ones archived (kept in the backup).
        # An answered question goes where its answer went; an open one to its own target unless that is taken.
        final, placed, archived_files = {}, {}, []   # final: file name -> doc; placed: source file -> new name
        open_q = {}
        for f, doc in qfiles.items():
            q = doc.get("qid") or f.stem
            if not scoped(q):
                final[f.name], placed[f] = doc, f.name
            elif q in answers:
                dd = dec(q)
                what, why = fate(q, dd)
                if what in ("kept", "moved"):
                    final[dd["qid"] + ".json"], placed[f] = moved_doc(doc, dd), dd["qid"] + ".json"
                else:
                    archived_files.append({"qid": q, "file": f.name, "reason": why or dd["why"]})
            else:
                open_q[q] = ({}, dec(q), f, doc)
        o_win, _ = winners({q: (a, dd) for q, (a, dd, _, _) in open_q.items()}, m)
        for q, (_, dd, f, doc) in sorted(open_q.items()):
            name = (dd["qid"] or "") + ".json"
            if dd["qid"] and o_win.get(dd["qid"]) == q and name not in final and dd["qid"] not in win:
                final[name], placed[f] = moved_doc(doc, dd), name
            else:
                archived_files.append({"qid": q, "file": f.name, "reason": dd["why"] or "another question now holds " + str(dd["qid"])})
        moved_files = sum(1 for f, name in placed.items() if name != f.name)
        rep["questions"] = {"moved": moved_files, "archived": len(archived_files), "archivedFiles": archived_files}
        for f in qfiles:
            if f.name not in final:
                self.files[f] = None
        for name, doc in final.items():
            if qfiles.get(qdir / name) != doc:
                self.files[qdir / name] = doc
        manifest_path = qdir / "manifest.json"
        manifest = read(manifest_path, None)
        if qfiles and isinstance(manifest, list):
            by_name = {f.name: name for f, name in placed.items()}
            out, seen = [], set()
            for e in manifest:
                if not isinstance(e, dict) or not e.get("qid"):
                    out.append(e)
                    continue
                name = by_name.get(e["qid"] + ".json")
                if name is None and scoped(e["qid"]):
                    continue   # archived (or a stale entry)
                if name is not None and name != e["qid"] + ".json":
                    e = {**e, "qid": name[:-5], "bytes": len(json.dumps(final[name], ensure_ascii=False, separators=(",", ":")))}
                if e["qid"] not in seen:
                    seen.add(e["qid"])
                    out.append(e)
            if out != manifest:
                self.files[manifest_path] = out

        # results/<id>.json (old -> .previous), its leagues sidecar and focus sidecar. Passing the saved result itself
        # as the "new" one only realigns stale answers (see decide): nothing is reinstalled then.
        if json.dumps(old_full, sort_keys=True) == json.dumps(new_full, sort_keys=True):
            rep["result"] = "unchanged: not reinstalled"
            return rep
        self.files[res_path.with_name(vid + ".json.previous")] = res_path.read_bytes()
        self.files[res_path] = new
        side_path = res_path.with_name(vid + ".leagues.json")
        side = read(side_path, None)
        if isinstance(side, dict) and isinstance(side.get("video"), dict):
            try:
                doc = self.refine(vid, new, side["video"], labels or {}, d)
                self.files[side_path] = doc
                rep["leagues"] = "rebuilt"
            except Exception as ex:  # a failed refine leaves the sidecar (matched by battle start) for refine-all
                rep["leagues"] = "not rebuilt: " + str(ex)[:200]
        focus_path = work / "focus" / (vid + ".json")
        focus = read(focus_path, None)
        if isinstance(focus, dict):
            if new_full and all("focus" in b for b in new_full):
                self.files[focus_path] = None
                rep["focus"] = "retired (the new result has its own focus moments)"
            else:
                moments = [x for b in focus.get("battles") or [] for x in b or [] if isinstance(x, dict)]
                spans = m["newSpans"]
                self.files[focus_path] = {**focus, "remapped": stamp,
                                          "battles": [[x for x in moments if s[0] - 1 <= float(x.get("t") or -1) <= s[1] + 8] for s in spans]}
                rep["focus"] = "rebucketed by time"
        return rep

    def refine(self, vid, new, video_league, labels, data):
        """league.refine_video for the new result, as harvest.write_league_refinement does after an analysis."""
        if self.registry is None:
            reg = read(self.web / "tests" / "meta-benchmark" / "sources" / "registry.json", [])
            self.registry = {v.get("id"): v for v in (reg if isinstance(reg, list) else reg.get("videos", [])) if isinstance(v, dict)}
        schedule = L.load_schedule()
        entry = self.registry.get(vid) or {}
        upload = entry.get("uploadDate") or next((str((a.get("video") or {}).get("uploadDate")) for a in data["questions"].values()
                                                  if (a.get("video") or {}).get("id") == vid and (a.get("video") or {}).get("uploadDate")), None)
        video_league = L.reviewed_league(video_league, schedule, labels, entry)
        return L.refine_video(new, video_league, schedule, L.load_gamemaster(), upload)

    def finish(self):
        """feedback.json, the inbox, and the invariant: no human answer lost."""
        self.files[self.work / "feedback.json"] = self.data
        labels_now = {p: c for p, c in self.files.items() if p.parent == self.work / "labels" and isinstance(c, dict)}
        archived = sum(1 for h in self.data["history"] if isinstance(h, dict) and h.get("archivedAt") == self.stamp and "answer" in h)
        after = self.count_humans(self.data, labels_now)
        self.humans_after, self.archived = after, archived
        if self.humans_before != after + self.archived:
            raise RuntimeError(f"human answers before {self.humans_before} != after {after} + archived {self.archived}: nothing written")


# ------------------------------------------------------------------------------------------------- applying

def _write(path, content):
    """Atomic write in each file's usual format (results compact like run-node, sidecars indented like harvest.py)."""
    if path.name == "feedback.json":
        F.save_feedback(path, content)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".remap.tmp")
    try:
        if isinstance(content, bytes):
            tmp.write_bytes(content)
        else:
            if path.name.endswith(".leagues.json") or path.name == "manifest.json":
                opts = {"indent": 1}
            elif path.parent.name == "results" or path.parent.name == "focus":
                opts = {"separators": (",", ":")}
            else:
                opts = {}
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(content, f, ensure_ascii=False, **opts)
                f.flush()
                os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def apply(plan, backup_dir):
    """Backs up every path first (backup.json lists them), then writes; feedback.json last."""
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=False)
    order = sorted(plan.files, key=lambda p: (p.name == "feedback.json", str(p)))
    journal = []
    for p in order:
        rel = os.path.relpath(p, plan.work)
        existed = p.exists()
        if existed:
            dst = backup_dir / "files" / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)
        journal.append({"path": rel, "existed": existed})
    if plan.inbox and os.path.exists(plan.inbox):
        shutil.copy2(plan.inbox, backup_dir / "validation-inbox.json")
    F.atomic_json(backup_dir / "backup.json", {"createdAt": plan.stamp, "work": str(plan.work), "inbox": plan.inbox or None,
                                               "files": journal})
    F.atomic_json(backup_dir / "remap-report.json", {"createdAt": plan.stamp, "videos": plan.reports,
                                                     "humanAnswers": {"before": plan.humans_before, "after": plan.humans_after,
                                                                      "archived": plan.archived},
                                                     "archived": [h for h in plan.data["history"] if isinstance(h, dict)
                                                                  and h.get("archivedAt") == plan.stamp]})
    for p in order:
        content = plan.files[p]
        if content is None:
            p.unlink(missing_ok=True)
        else:
            _write(p, content)
    inbox_n = None
    if plan.inbox and os.path.exists(plan.inbox):
        inbox_n = V.write_inbox(str(plan.work / "validation"), plan.inbox)
    return inbox_n


def restore(work, backup_dir, inbox=INBOX):
    """Undo one run: every journalled path back to its backed-up copy (or removed if the run created it)."""
    work, backup_dir = Path(work), Path(backup_dir)
    j = read(backup_dir / "backup.json", None)
    if not isinstance(j, dict):
        raise SystemExit(f"{backup_dir}: no backup.json")
    for e in j["files"]:
        p = work / e["path"]
        if e["existed"]:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".remap.tmp")
            shutil.copy2(backup_dir / "files" / e["path"], tmp)
            os.replace(tmp, p)
        else:
            p.unlink(missing_ok=True)
    saved = backup_dir / "validation-inbox.json"
    target = j.get("inbox") or inbox
    if target and saved.exists():
        shutil.copy2(saved, target)
    return len(j["files"])


# ------------------------------------------------------------------------------------------------- report

def describe(rep):
    if rep.get("skipped"):
        return [f"{rep['videoId']}: skipped ({rep['skipped']})"]
    olds, news = rep["olds"], rep["news"]
    tally = {}
    for o in olds:
        tally[o["status"]] = tally.get(o["status"], 0) + 1
    new_only = sum(1 for n in news if n["status"] == "new")
    members = sum(o["members"] for o in olds if o["status"] != "gone")
    found = sum(o["found"] for o in olds if o["status"] != "gone")
    same_cp = sum(o["sameCp"] for o in olds if o["status"] != "gone")
    a, qs, dv = rep["answers"], rep["questions"], rep["derived"]
    lines = [f"{rep['videoId']}: battles {rep['before']} -> {rep['after']} ("
             + ", ".join(f"{k} {v}" for k, v in sorted(tally.items())) + (f", new {new_only}" if new_only else "")
             + f"); teams: {found}/{members} old Pokémon found, {same_cp} with the same CP"]
    changes = []
    for j, n in enumerate(news):
        if n["status"] == "merged":
            changes.append("old " + "+".join(str(i + 1) for i in n["from"]) + f" -> new {j + 1}")
        elif n["status"] == "new":
            changes.append(f"new {j + 1} (no old battle)")
    for i, o in enumerate(olds):
        if o["status"] == "split":
            changes.append(f"old {i + 1} -> new " + "+".join(str(j + 1) for j in o["to"]))
        elif o["status"] == "gone":
            changes.append(f"old {i + 1} gone")
        elif o["status"] == "same" and o["to"][0] != i:
            pass
    shifted = sum(1 for i, o in enumerate(olds) if o["status"] == "same" and o["to"][0] != i)
    if shifted:
        changes.append(f"{shifted} unchanged battle(s) renumbered")
    if changes:
        lines.append("  " + "; ".join(changes))
    lines.append(f"  answers: kept {a['kept']}, moved {a['moved']}, merged {a['merged']}, conflicts {a['conflicts']}, archived {a['archived']}"
                 + (f" (realigned {a['realigned']})" if a["realigned"] else "")
                 + f"; questions: moved {qs['moved']}, archived {qs['archived']}; reopened model resolutions {dv['reopened']}, "
                   f"predictions dropped {dv['predictionsDropped']}, fit signatures cleared {dv['fitSignaturesCleared']}"
                 + (f", external moved {dv['externalMoved']} dropped {dv['externalDropped']}" if dv["externalMoved"] or dv["externalDropped"] else ""))
    def what(qid):
        rest = qid.split(".mp4:", 1)[1].split(":", 1)[1]
        return rest.replace(":", " ")
    for mv in rep["moves"]:
        lines.append(f"    moved battle {mv.get('realignedFrom') or mv['oldBattle']} -> {mv['newBattle']}: {what(mv['from'])} = {json.dumps(mv['value'])}"
                     + (f" (a stale index: its Pokémon and clip are in old battle {mv['oldBattle']})" if mv.get("realignedFrom") else "")
                     + (" (followed its Pokémon: that new battle shows it at the question's moment)" if mv.get("via") else ""))
    for x in rep["archive"]:
        lines.append(f"    {x['kind']}: battle {x['oldBattle']} {what(x['qid'])} = {json.dumps(x['value'])}: {x['reason']}")
    for x in qs["archivedFiles"]:
        lines.append(f"    question archived: {x['qid'].split('.mp4:', 1)[1]}: {x['reason']}")
    for k in ("result", "leagues", "focus", "warning"):
        if rep.get(k):
            lines.append(f"  {k}: {rep[k]}")
    return lines


def lease_state(work):
    try:
        lease = F.acquire_lease(work)
    except F.FeedbackUnavailable:
        return True
    F.release_lease(lease)
    return False


def main(argv=None):
    ap = argparse.ArgumentParser(prog="remap_battles.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("work_dir")
    ap.add_argument("--new", help="folder of re-extracted <id>.json (reextract-labelled.cjs --keep DIR)")
    ap.add_argument("--only", default=None, help="comma-separated video ids (default: every <id>.json in --new)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan; write nothing (also works while the app runs)")
    ap.add_argument("--inbox", default=INBOX, help="Validate inbox to rebuild after the change ('' = don't)")
    ap.add_argument("--web-root", default=WEB, help="checkout whose registry.json supplies upload dates (default: this one)")
    ap.add_argument("--backup-dir", default=None, help="default WORK/remap-backup-YYYYMMDD-HHMMSS")
    ap.add_argument("--report", default=None, help="also write the full plan as JSON here")
    ap.add_argument("--restore", default=None, metavar="BACKUP_DIR", help="undo a run from its backup folder (needs the lease)")
    a = ap.parse_args(argv)
    work = Path(a.work_dir)
    if not (work / "feedback.json").exists():
        print(f"{work}: no feedback.json", file=sys.stderr)
        return 2
    if a.restore:
        try:
            lease = F.acquire_lease(work, LEASE_HELD)
        except F.FeedbackUnavailable as ex:
            print("refused: " + str(ex), file=sys.stderr)
            return 3
        try:
            print(f"restored {restore(work, a.restore, a.inbox)} files from {a.restore}")
        finally:
            F.release_lease(lease)
        return 0
    if not a.new:
        ap.error("--new DIR is required")
    lease = None
    if a.dry_run:
        if lease_state(work):
            print("note: the local app holds the lease (it is running); this is a read-only preview of feedback.json as saved. "
                  "Applying refuses until the app stops.")
    else:
        try:
            lease = F.acquire_lease(work, LEASE_HELD)
        except F.FeedbackUnavailable as ex:
            print("refused: " + str(ex), file=sys.stderr)
            return 3
    try:
        ids = sorted(p.stem for p in Path(a.new).glob("*.json") if not p.name.endswith((".leagues.json", ".tmp")))
        if a.only:
            wanted = [x for x in a.only.split(",") if x]
            missing = [x for x in wanted if x not in ids]
            if missing:
                print("not in --new: " + " ".join(missing), file=sys.stderr)
                return 2
            ids = wanted
        plan = Plan(work, a.web_root, a.inbox or None)
        for vid in ids:
            plan.add_video(vid, Path(a.new) / (vid + ".json"))
        plan.finish()
        for rep in plan.reports:
            for line in describe(rep):
                print(line)
        done = [r for r in plan.reports if not r.get("skipped")]
        tot = {k: sum(r["answers"][k] for r in done) for k in ("kept", "moved", "merged", "conflicts", "archived", "realigned")}
        print(f"total: {len(done)} videos, battles {sum(r['before'] for r in done)} -> {sum(r['after'] for r in done)}; answers kept "
              f"{tot['kept']}, moved {tot['moved']}, merged {tot['merged']}, conflicts {tot['conflicts']}, archived {tot['archived']}"
              f" (realigned {tot['realigned']}); human answers {plan.humans_before} before = {plan.humans_after} after + "
              f"{plan.archived} archived; {len(plan.files)} files to write")
        if a.report:
            F.atomic_json(a.report, {"videos": plan.reports, "humanAnswers": {"before": plan.humans_before, "after": plan.humans_after,
                                                                              "archived": plan.archived}})
        if a.dry_run:
            print("dry run: nothing written")
            return 0
        if not done:
            print("nothing to apply")
            return 0
        backup = Path(a.backup_dir) if a.backup_dir else work / ("remap-backup-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
        inbox_n = apply(plan, backup)
        print(f"applied: {len(plan.files)} files written (backup and restore journal in {backup})"
              + (f"; inbox rebuilt with {inbox_n} questions" if inbox_n is not None else "")
              + ". After the app restarts, Retrain in Validate (or the next answer) refits these videos.")
        return 0
    finally:
        F.release_lease(lease)


if __name__ == "__main__":
    sys.exit(main())
