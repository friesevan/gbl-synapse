"""Durable local reviewer labels and serialized, offline Bayesian-prior refits.

Model resolutions are separate audit records; they are NEVER labels for learning.
Refits use stored physical extraction evidence, leave-video-out calibration and no video downloads.
"""
import datetime as dt
import hashlib
import fcntl
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid

try:
    import metrics_history as MH
except ImportError:  # loaded by file path (tests, tools)
    import importlib.util as _importlib_util
    _spec = _importlib_util.spec_from_file_location("metrics_history", Path(__file__).resolve().parent / "metrics_history.py")
    MH = _importlib_util.module_from_spec(_spec)
    _spec.loader.exec_module(MH)

# Footage answers that mean the video has battle footage worth analysing (validate.REPROCESS).
REPROCESS_VALUES = ("battles", "partial", "rocket", "championship")

TRAINABLE = {"shadow", "form", "fastMove"}
MINIMUM, TARGET = 8, 24
# External resolvers (scripts/freellm/validate_llm.py): closed like model resolutions, never labels.
EXTERNAL_SOURCES = {"freellm", "local-llm", "haiku"}
# "freellm" (free-tier APIs, phased out 2026-10-12) needs two different providers to agree; the others
# are one model whose two independent calls agreed above the gate's confidence threshold.
MULTI_PROVIDER_SOURCES = {"freellm"}
# Result questions settled by the battle timeline (learning-loop.cjs resultResolution, re-derived on every refit):
# "timeline" carries the inferred result (Poké Ball counter / HP bar / surrender dialog); "policy" closes a result
# question the footage can't answer (no result screen: the video cuts to the next battle or ends; value None).
# Both are reversible (Reopen, or a human answer replaces them), never labels, and policy records are not counted
# as model resolutions (learning.resolved, metrics_history "policy" bucket).
TIMELINE_SOURCE, POLICY_SOURCE = "timeline", "policy"
# Fast-move/form evidence settings are refitted (movefit-fit.cjs) once this many new labels have arrived.
PARAM_REFIT_EVERY = 24


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def signature(a):
    return hashlib.sha256(json.dumps([a.get("kind"), a.get("species"), a.get("value")], sort_keys=True).encode()).hexdigest()


def confirmed(a):
    return a.get("value") is not None and a.get("source") != "model" and not a.get("modelResolved")


@contextmanager
def file_lock(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


class FeedbackUnavailable(Exception):
    """503: a different local server owns validation, or this instance was closed."""


class FeedbackService:
    def __init__(self, work_dir, web_root):
        self.work = Path(work_dir)
        self.web = Path(web_root)
        self.path = self.work / "feedback.json"
        self.lock = threading.RLock()
        self._closing = False
        self.thread = None
        self.requested = False
        self.work.mkdir(parents=True, exist_ok=True)
        self._lease = (self.work / "feedback.lock").open("a+")
        try:
            fcntl.flock(self._lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._lease.close()
            self._lease = None
            raise FeedbackUnavailable("Another local web server already manages validation for this work directory. Use its Validate tab, or stop that server before opening validation in a second server. Harvest status and stop controls remain available.") from None
        self.data = read_json(self.path, {})
        for key in ("answers", "resolutions", "manualReview", "fitSignatures", "questions", "sideEffectSignatures"):
            self.data.setdefault(key, {})
        self.data.setdefault("history", [])
        self.data.setdefault("learning", {"status": "idle", "version": 0, "modelType": "Bayesian species / move priors"})
        if self.data["learning"].get("status") in ("queued", "running"):
            self.data["learning"].update(status="interrupted", error="Prior refit was interrupted; saved answers are intact. Retry refit.")
        baseline_path = self.work / "baseline-learned.json"
        if not baseline_path.exists():
            atomic_json(baseline_path, read_json(self.web / "tests/meta-benchmark/learned.json", {"moves": {}, "shadow": {}}))
        self.thread = None
        self.requested = False
        self.history_metrics = self._load_metrics()

    def _load_metrics(self):
        """Per-refit metrics history (metrics_history.py). Created once, backfilled from saved files; a refit
        that saved results without a record (older code) is added as a backfilled record. Never blocks review."""
        history = MH.load(self.work)
        try:
            version = int(self.data["learning"].get("version") or 0)
            if history is None:
                history = MH.new_history(MH.backfill(self.work, self.data, self._questions()))
                history["backfilledAt"] = now()
                MH.save(self.work, history)
            elif version > max([r.get("refit", 0) for r in history["records"]] or [0]) and self.data["learning"].get("calibration"):
                record = MH.build_record(version, self.data["learning"], self._questions(), self.data["answers"], self.data["resolutions"])
                record.update(backfilled=True, source="stored by refit %d in feedback.json; counts when this server started" % version)
                MH.save(self.work, MH.append(history, record))
        except Exception as ex:  # metrics are a view; labels and refits must keep working
            self.data["learning"]["metricsError"] = str(ex)[:300]
            history = history or MH.new_history()
        return history

    def _ensure_open(self):
        if self._closing or self._lease is None:
            raise FeedbackUnavailable("This validation service is closed; reopen the local app to continue.")

    def _release_lease(self):
        if self._lease is not None:
            fcntl.flock(self._lease, fcntl.LOCK_UN)
            self._lease.close()
            self._lease = None

    def close(self, wait=True):
        """Drain an active refit before releasing exclusive feedback ownership.

        wait=False retains the lease until the current worker finishes. It never lets a second
        server overwrite labels while the first server is publishing a model/checkpoint.
        """
        with self.lock:
            self._closing = True
            self.requested = False
            worker = self.thread
            if not worker or not worker.is_alive():
                self._release_lease()
                return True
        if wait and worker is not threading.current_thread():
            worker.join()
        with self.lock:
            if not worker.is_alive():
                self._release_lease()
                return True
            return False

    def __del__(self):
        try:
            self.close(wait=False)
        except Exception:
            pass

    def _save(self):
        self.data["revision"] = int(self.data.get("revision") or 0) + 1
        atomic_json(self.path, self.data)

    def _questions(self):
        inbox = read_json(self.web / "tests/meta-benchmark/results/validation-inbox.json", {})
        out = {q["qid"]: q for q in inbox.get("questions", []) if isinstance(q, dict) and q.get("qid")}
        for file in sorted((self.work / "validation").glob("*/*.json")):
            if file.name == "manifest.json":
                continue
            q = read_json(file, {})
            if isinstance(q, dict) and q.get("qid"):
                out[q["qid"]] = q
        out.update(self.data["questions"])
        for qid, prediction in self.data.get("predictions", {}).items():
            if qid in out and not confirmed(self.data["answers"].get(qid, {})):
                out[qid] = {**out[qid], **prediction}
        return out

    def _pending(self):
        return [a for qid, a in self.data["answers"].items() if confirmed(a) and a.get("kind") in TRAINABLE
                and self.data["fitSignatures"].get(qid) != signature(a)]

    def state(self):
        with self.lock:
            self._ensure_open()
            questions = self._questions()
            pending = self._pending()
            learning = {**self.data["learning"], "pending": len(pending), "minimum": MINIMUM, "target": TARGET,
                        "confidenceNote": "Posterior confidence is a heuristic; held-out checks guard automatic resolution.",
                        "totalConfirmed": sum(confirmed(a) for a in self.data["answers"].values()),
                        "remaining": max(0, MINIMUM - len(pending)), "autoRefit": True, "metrics": MH.summary(self.history_metrics)}
            return {"revision": self.data.get("revision", 0), "questions": list(questions.values()), "answers": dict(self.data["answers"]),
                    "resolutions": dict(self.data["resolutions"]), "learning": learning}

    snapshot = state

    def metrics(self):
        """The full per-refit metrics history (GET /api/validation/metrics)."""
        with self.lock:
            self._ensure_open()
            return json.loads(json.dumps(self.history_metrics))

    def answer_many(self, answers):
        if not isinstance(answers, list) or len(answers) > 5000:
            raise ValueError("answers must be a list of at most 5000 reviewer answers")
        with self.lock:
            self._ensure_open()
            questions = self._questions()
            prepared = []
            for a in answers:
                if not isinstance(a, dict) or not isinstance(a.get("qid"), str):
                    raise ValueError("Each answer requires a qid")
                if a.get("source") == "model" or a.get("modelResolved"):
                    raise ValueError("Model resolutions are audit records, not reviewer labels")
                q = questions.get(a["qid"]) or a.get("question")
                if not isinstance(q, dict) or not q.get("kind") or q.get("qid", a["qid"]) != a["qid"]:
                    raise ValueError("Unknown question; import the original question with the answer")
                value = a.get("value")
                options = q.get("options") or []
                if value is not None and (not options or not any(type(o.get("value")) is type(value) and o.get("value") == value for o in options)):
                    raise ValueError("Answer is not one of the question's options")
                doc = {k: q.get(k) for k in ("kind", "species", "side", "key", "battle", "allBattles", "video", "recording", "modelTop", "modelP", "purple")}
                doc.update(qid=a["qid"], value=value, answeredAt=now(), source="reviewer",
                           label=next((o.get("label") for o in options if type(o.get("value")) is type(value) and o.get("value") == value), "Not sure"))
                prepared.append((q, doc))
            changed = 0
            correction = False
            for q, a in prepared:
                old = self.data["answers"].get(a["qid"])
                if old and signature(old) == signature(a):
                    continue
                correction |= bool(old and confirmed(old))
                if old:
                    self.data["history"].append({"answer": old, "replacedAt": now()})
                self.data["questions"][a["qid"]] = q
                self.data["answers"][a["qid"]] = a
                resolved = self.data["resolutions"].pop(a["qid"], None)
                if resolved:
                    self.data["history"].append({"qid": a["qid"], "resolution": resolved, "replacedByHumanAt": now()})
                self.data["manualReview"].pop(a["qid"], None)
                changed += 1
            # Save labels first. Registry/pipeline side effects are recoverable on retry.
            self._save()
            for q, a in prepared:
                if a["kind"] not in TRAINABLE and self.data["sideEffectSignatures"].get(a["qid"]) != signature(a):
                    self._apply_pipeline_answer(q, a)
                    self.data["sideEffectSignatures"][a["qid"]] = signature(a)
            self._save()
            league_changed = changed and any(a["kind"] == "league" for _, a in prepared)
            if changed and (correction or league_changed or len(self._pending()) >= MINIMUM):
                self._queue_locked("League context changed" if league_changed else "Corrected reviewer label" if correction else "8 new useful reviewer answers")
            result = self.state()
            result["saved"] = changed
            return result

    submit_answers = answer_many

    def resolve_external(self, items):
        """Close open questions with answers from a gated external resolver (scripts/freellm/validate_llm.py).

        Stored in resolutions (reversible audit records with the resolver's source: "local-llm",
        "haiku", or the older "freellm"), never in answers: they don't train, don't trigger pipeline
        side effects, and a human answer or Reopen replaces them.
        Audit spot checks, answered and reopened questions are refused (skipped).
        """
        if not isinstance(items, list) or len(items) > 5000:
            raise ValueError("resolutions must be a list of at most 5000 entries")
        with self.lock:
            self._ensure_open()
            questions = self._questions()
            saved, skipped = 0, []
            for it in items:
                if not isinstance(it, dict) or not isinstance(it.get("qid"), str):
                    raise ValueError("Each resolution requires a qid")
                qid, value = it["qid"], it.get("value")
                if it.get("source") not in EXTERNAL_SOURCES:
                    raise ValueError("Unknown resolution source")
                providers = it.get("providers")
                if it["source"] in MULTI_PROVIDER_SOURCES:
                    if (not isinstance(providers, list) or len({str(p) for p in providers}) < 2 or len(providers) > 4
                            or int(it.get("agreement") or 0) < 2):
                        raise ValueError("External resolutions need agreement between at least two providers")
                else:
                    conf, threshold = it.get("confidence"), it.get("threshold")
                    if (not isinstance(it.get("model"), str) or not it["model"] or int(it.get("agreement") or 0) < 2
                            or not isinstance(conf, (int, float)) or not isinstance(threshold, (int, float)) or conf < threshold):
                        raise ValueError("Model resolutions need two agreeing calls with confidence at or above the gate's threshold")
                    providers = [it["model"]]
                q = questions.get(qid)
                options = (q or {}).get("options") or []
                option = next((o for o in options if type(o.get("value")) is type(value) and o.get("value") == value), None)
                reason = ("unknown question" if not q else "spot check" if q.get("audit") else
                          "answered by a person" if confirmed(self.data["answers"].get(qid, {})) else
                          "reopened by a person" if self.data["manualReview"].get(qid) else
                          "not an option" if value is None or option is None else None)
                if reason:
                    skipped.append({"qid": qid, "reason": reason})
                    continue
                rec = {"value": value, "label": option.get("label"), "source": it["source"], "modelResolved": True,
                       "providers": [str(p)[:40] for p in providers], "agreement": int(it["agreement"]),
                       "task": str(it.get("task") or "")[:60], "reason": str(it.get("reason") or "")[:300],
                       "gate": it.get("gate") if isinstance(it.get("gate"), dict) and len(json.dumps(it["gate"])) < 500 else None}
                if it["source"] not in MULTI_PROVIDER_SOURCES:
                    rec.update(model=it["model"][:80], confidence=round(float(it["confidence"]), 3), threshold=float(it["threshold"]))
                old = self.data["resolutions"].get(qid)
                if old and all(old.get(k) == rec[k] for k in ("value", "source", "providers", "task")):
                    continue
                if old:
                    self.data["history"].append({"qid": qid, "resolution": old, "replacedAt": now()})
                rec["resolvedAt"] = now()
                self.data["resolutions"][qid] = rec
                saved += 1
            if saved:
                self._save()
            result = self.state()
            result.update(saved=saved, skipped=skipped)
            return result

    def reopen(self, qid):
        with self.lock:
            self._ensure_open()
            resolution = self.data["resolutions"].pop(qid, None)
            if resolution:
                self.data["history"].append({"resolution": resolution, "qid": qid, "reopenedAt": now()})
            self.data["manualReview"][qid] = True
            self._save()
            return self.state()

    def retrain(self):
        with self.lock:
            self._ensure_open()
            self._queue_locked("Manual refit")
            return self.state()

    request_retrain = retrain

    def _queue_locked(self, reason):
        self.requested = True
        if self.thread and self.thread.is_alive():
            self.data["learning"]["reason"] = reason   # the follow-up refit's reason; the running one kept its own
            return
        self.data["learning"].update(status="queued", reason=reason, error=None, progress="Waiting briefly to combine incoming answers")
        self._save()
        self.thread = threading.Thread(target=self._worker, name="validation-refit", daemon=True)
        self.thread.start()

    def _worker(self):
        # Short debounce; no decode/download work, one model refit at a time.
        time.sleep(2)
        while True:
            with self.lock:
                if not self.requested or self._closing:
                    self.thread = None
                    if self._closing:
                        self._release_lease()
                    return
                self.requested = False
                questions = list(self._questions().values())
                answers = list(self.data["answers"].values())
                reason = self.data["learning"].get("reason")
                version = int(self.data["learning"].get("version") or 0) + 1
                self.data["learning"].update(status="running", progress="Refitting saved evidence and checking held-out videos", startedAt=now())
                self._save()
            try:
                result = self._fit(questions, answers, version)
                with self.lock:
                    # Preserve labels submitted during this pass. Only these snapshot labels count as fit.
                    self.data["fitSignatures"] = {a["qid"]: signature(a) for a in answers if confirmed(a) and a.get("kind") in TRAINABLE}
                    previous = self.data["resolutions"]
                    next_resolutions = {qid: r for qid, r in result["resolutions"].items()
                                        if not confirmed(self.data["answers"].get(qid, {})) and not self.data["manualReview"].get(qid)}
                    # External (free-LLM) resolutions don't depend on the prior model: keep them across refits.
                    for qid, r in previous.items():
                        if (r.get("source") in EXTERNAL_SOURCES and qid not in next_resolutions
                                and not confirmed(self.data["answers"].get(qid, {})) and not self.data["manualReview"].get(qid)):
                            next_resolutions[qid] = r
                    for qid, r in previous.items():
                        if qid not in next_resolutions:
                            self.data["history"].append({"qid": qid, "resolution": r, "reopenedAt": now(), "reason": "Model no longer passes confidence gates"})
                    self.data["resolutions"] = next_resolutions
                    self.data["predictions"] = result["predictions"]
                    self.data["learning"].update(status="idle", version=version, lastFit=now(), progress="Saved prior model; uncertain questions remain open",
                        calibration=result["calibration"], runsRefit=result["runsRefit"], errors=result["errors"], error=None,
                        resolved=sum(1 for r in next_resolutions.values() if r.get("source") != POLICY_SOURCE),
                        policyClosed=sum(1 for r in next_resolutions.values() if r.get("source") == POLICY_SOURCE),
                        resultSources=result.get("resultSources"),
                        shadowModel=result.get("shadowModel"))
                    result["learned"].update(modelVersion=version, updatedAt=now(), modelType="Bayesian species / move priors + Shadow classifier")
                    atomic_json(self.web / "tests/meta-benchmark/learned.json", result["learned"])
                    atomic_json(self.work / "learned.json", result["learned"])
                    self._save()
                    self._record_metrics(version, answers, reason)
                    if not self._closing and len(self._pending()) >= MINIMUM:
                        if not self.requested:
                            self.data["learning"]["reason"] = "8 new useful reviewer answers"
                        self.requested = True
                    refit_params = not self._closing and self._params_due()
                if refit_params:
                    self._fit_params()
            except Exception as ex:
                with self.lock:
                    self.data["learning"].update(status="error", error=str(ex)[:500], progress="Answers are saved; retry model refit")
                    self._save()

    def _record_metrics(self, version, snapshot, reason):
        """Append this refit's record to the metrics history (caller holds the lock)."""
        try:
            record = MH.build_record(version, self.data["learning"], self._questions(), self.data["answers"],
                                     self.data["resolutions"], snapshot=snapshot, reason=reason)
            MH.save(self.work, MH.append(self.history_metrics, record))
            self.data["learning"].pop("metricsError", None)
        except Exception as ex:  # never fail a saved refit over its metrics record
            self.data["learning"]["metricsError"] = str(ex)[:300]

    def _params_due(self):
        """True when enough fast-move/form labels arrived since the evidence settings were last fitted."""
        return self._move_labels() >= int(self.data["learning"].get("paramsLabels") or 0) + PARAM_REFIT_EVERY

    def _move_labels(self):
        return sum(1 for a in self.data["answers"].values() if confirmed(a) and a.get("kind") in ("fastMove", "form"))

    def _fit_params(self):
        """Refit the fast-move and form evidence settings from saved evidence (no video); the next model
        refit applies them as learned.fit. Failures leave the previous settings in place."""
        with self.lock:
            labels = self._move_labels()
        out = self.work / "learning" / "movefit-params.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "WORK_DIR": str(self.work)}
        try:
            for kind in ("fastMove", "form"):
                subprocess.run(["node", str(self.web / "tests/meta-benchmark/movefit-fit.cjs"), "--kind", kind, "--rounds", "1", "--out", str(out)],
                               capture_output=True, text=True, timeout=3600, cwd=self.web, env=env, check=True)
        except (subprocess.SubprocessError, OSError) as ex:
            with self.lock:
                self.data["learning"].update(paramsError=str(ex)[:300], paramsLabels=labels)
                self._save()
            return
        with self.lock:
            self.data["learning"].update(paramsFit=now(), paramsError=None, paramsLabels=labels,
                                         reason="Fast-move and form evidence settings refitted")
            self.requested = True
            self._save()

    def _fit(self, questions, answers, version):
        context = self.work / "learning"
        context.mkdir(parents=True, exist_ok=True)
        src, dst = context / "input.json", context / "output.json"
        registry = read_json(self.web / "tests/meta-benchmark/sources/registry.json", [])
        by_id = {v["id"]: v for v in (registry if isinstance(registry, list) else registry.get("videos", []))}
        cups = read_json(self.web / "scripts/yt-harvest/data/gbl-schedule.json", {}).get("cups", {})
        cup_cp = {"great": 1500, "ultra": 2500, "master": 10000, "little": 500}
        cup_cp.update({k: v.get("cp") for k, v in cups.items() if isinstance(v, dict) and v.get("cp")})
        required_videos = {(q.get("video") or {}).get("id") or str(q.get("recording") or "").removesuffix(".mp4") for q in questions}
        runs = []
        for file in sorted((self.work / "results").glob("*.json")):
            if file.name.endswith(".learned.json") or file.stem not in required_videos:
                continue
            raw = read_json(file, {})
            if not isinstance(raw, dict) or not isinstance(raw.get("full"), list):
                continue
            c = raw.get("learningContext") or {}
            r = by_id.get(file.stem, {})
            cp = {"great": 1500, "ultra": 2500, "master": 10000, "little": 500}.get(r.get("leagueId"), 1500)
            gm = c.get("gamemaster")
            if not gm:
                date = str(r.get("uploadDate") or "").replace("-", "")
                try:
                    d = dt.datetime.strptime(date, "%Y%m%d").date().replace(day=16 if int(date[-2:]) >= 16 else 1)
                    cached = Path.home() / ".cache/gbl-synapse/gamemaster" / (d.isoformat() + ".json")
                    if cached.exists():
                        gm = str(cached)
                except ValueError:
                    pass
            runs.append({"videoId": file.stem, "path": str(file), "league": c.get("league") or cp, "gamemaster": gm, "channel": r.get("channel")})
        with self.lock:
            manual_review = dict(self.data["manualReview"])
        atomic_json(src, {"questions": questions, "answers": answers, "manualReview": manual_review, "version": version,
                          "cupCP": cup_cp, "baseline": read_json(self.work / "baseline-learned.json", {}), "runs": runs, "outputDir": str(context / ("refit-" + str(version))),
                          # Archived human labels train the Shadow classifier only (their priors are in the baseline).
                          "labelsDir": str(self.work / "labels"),
                          "workDir": str(self.work), "fitParams": str(context / "movefit-params.json")})
        proc = subprocess.run(["node", str(self.web / "tests/meta-benchmark/learning-loop.cjs"), str(src), str(dst)],
                              capture_output=True, text=True, timeout=1800, cwd=self.web)
        if proc.returncode:
            raise RuntimeError(proc.stderr[-500:] or "Offline model refit failed")
        return json.loads(dst.read_text(encoding="utf-8"))

    def _apply_pipeline_answer(self, q, a):
        vid = (q.get("video") or {}).get("id") or str(q.get("recording") or "").removesuffix(".mp4")
        if not vid or not all(c.isalnum() or c in "_-" for c in vid):
            return
        labels_path = self.work / "labels" / (vid + ".json")
        labels = read_json(labels_path, {"videoId": vid, "verified": {}})
        labels["verified"][a["qid"]] = a
        if q.get("battle") is not None:
            battles = labels.setdefault("battles", [])
            b = next((b for b in battles if b.get("n") == int(q["battle"]) + 1), None)
            if b is None:
                b = {"n": int(q["battle"]) + 1, "verified": {}}
                battles.append(b)
            b.setdefault("verified", {})[q["kind"]] = a
            if q["kind"] == "league":
                # "rocket" is a battle type, not a league: training only, excluded from observed meta.
                if a["value"] == "rocket" and confirmed(a):
                    b["battleType"] = "rocket"
                    b.pop("leagueId", None)
                elif a["value"] not in (None, "other", "rocket", "gbl"):
                    b["leagueId"] = a["value"]
                    b.pop("battleType", None)
                else:
                    b.pop("leagueId", None)
                    b.pop("battleType", None)
            if q["kind"] == "result":
                if confirmed(a):
                    result, _, ending = str(a["value"]).partition(":")
                    b.update(result=result, ending=ending or "normal")
                else:
                    b.pop("result", None)
                    b.pop("ending", None)
        if q["kind"] == "league" and q.get("allBattles"):
            if a["value"] == "rocket" and confirmed(a):
                labels["videoType"] = "rocket"
                labels.pop("leagueId", None)
            elif a["value"] not in (None, "other", "rocket", "gbl"):
                labels["leagueId"] = a["value"]
                if labels.get("videoType") == "rocket":
                    labels.pop("videoType")
            else:
                labels.pop("leagueId", None)
                if a["value"] == "gbl" and confirmed(a) and labels.get("videoType") == "rocket":
                    labels.pop("videoType")   # "Not Team Rocket": clears the flag, names no cup
        perspective_requeue = False
        if q["kind"] == "perspective":
            # Championship broadcasts: which phone is the creator side (left/right re-analyses that screen).
            if confirmed(a) and a["value"] == "gbl":
                labels.pop("perspective", None)
                labels["championship"] = False
                if labels.get("videoType") == "championship":
                    labels.pop("videoType")
            elif confirmed(a):
                perspective_requeue = a["value"] in ("left", "right") and labels.get("perspective") != a["value"]
                labels["perspective"] = a["value"]
                labels["championship"] = True
                labels["videoType"] = "championship"
            else:
                labels.pop("perspective", None)
                labels.pop("championship", None)
        atomic_json(labels_path, labels)
        if perspective_requeue:
            token = hashlib.sha256((a["qid"] + signature(a)).encode()).hexdigest()[:24]
            atomic_json(self.work / "requeue" / (token + ".json"), {"videoId": vid, "reason": "Championship perspective: analyse the " + a["value"] + " screen", "requestedAt": now()})
        if q["kind"] == "footage":
            fpath = self.work / "relevance-feedback.json"
            feedback = read_json(fpath, {"videos": {}})
            if confirmed(a):
                feedback["videos"][vid] = {"value": a["value"] != "none", "footageValue": a["value"], "title": (q.get("video") or {}).get("title"), "channel": (q.get("video") or {}).get("channel"), "answeredAt": a["answeredAt"]}
            else:
                feedback["videos"].pop(vid, None)
            atomic_json(fpath, feedback)
            if confirmed(a) and a["value"] in ("rocket", "championship", "obscured"):
                labels["videoType"] = a["value"]   # observed meta excludes rocket; championship is its own format
                atomic_json(labels_path, labels)
            elif confirmed(a):
                labels.pop("videoType", None)
                atomic_json(labels_path, labels)
            if a["value"] not in REPROCESS_VALUES:
                for request in (self.work / "requeue").glob("*.json"):
                    if read_json(request, {}).get("videoId") == vid:
                        request.unlink(missing_ok=True)
            if a["value"] in REPROCESS_VALUES:
                # Immutable request per revision; consumer claims each file atomically.
                token = hashlib.sha256((a["qid"] + signature(a)).encode()).hexdigest()[:24]
                atomic_json(self.work / "requeue" / (token + ".json"), {"videoId": vid, "reason": "Reviewer confirmed missed battle footage", "requestedAt": now()})
        if q["kind"] == "league" and q.get("allBattles"):
            registry_path = self.web / "tests/meta-benchmark/sources/registry.json"
            with file_lock(self.work / "registry.lock"):
                registry = read_json(registry_path, [])
                items = registry if isinstance(registry, list) else registry.get("videos", [])
                entry = next((r for r in items if r.get("id") == vid), None)
                if entry:
                    review = entry.get("leagueReview") or {}
                    previous = review.get("previous") or {k: entry.get(k) for k in ("leagueId", "leagueGuess", "leagueConfidence")}
                    if a["value"] in (None, "other", "rocket", "gbl"):
                        entry.update(previous)
                        entry.pop("reviewerLeague", None)
                        entry.pop("leagueReview", None)
                    else:
                        option = next((o for o in q.get("options", []) if o["value"] == a["value"]), {})
                        entry.update(leagueId=a["value"], leagueGuess=option.get("label", a["value"]), leagueConfidence=1, reviewerLeague=True,
                                     leagueReview={"qid": a["qid"], "answeredAt": a["answeredAt"], "previous": previous})
                    atomic_json(registry_path, registry)
