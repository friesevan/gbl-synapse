import importlib.util
import json
from pathlib import Path
import tempfile
import time
import subprocess
import sys
import threading
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("feedback", HERE / "feedback.py")
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)


class FeedbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.work, self.web = self.root / "work", self.root / "web"
        self.work.mkdir()
        self.bench = self.web / "tests/meta-benchmark"
        (self.bench / "sources").mkdir(parents=True)
        F.atomic_json(self.bench / "learned.json", {"moves": {"claydol": {"MUD_SLAP": 2}}, "shadow": {}})
        F.atomic_json(self.bench / "sources/registry.json", [{"id": "video", "leagueId": "great"}])
        self.questions = [{"qid": "q" + str(i), "kind": "shadow", "species": "claydol", "battle": 0,
                           "side": "opponent", "key": "enemy", "video": {"id": "video"}, "options": [{"value": True}, {"value": False}]} for i in range(8)]
        F.atomic_json(self.bench / "results/validation-inbox.json", {"questions": self.questions})
        self.service = F.FeedbackService(self.work, self.web)

    def tearDown(self):
        self.service.close()
        self.tmp.cleanup()

    def test_idempotent_atomic_labels_recover_after_restart_and_validate_options(self):
        self.service.answer_many([{"qid": "q0", "value": True}])
        self.assertEqual(self.service.answer_many([{"qid": "q0", "value": True}])["saved"], 0)
        self.service.close()
        again = F.FeedbackService(self.work, self.web)
        self.service = again
        self.assertEqual(again.state()["answers"]["q0"]["value"], True)
        self.assertEqual(again.state()["learning"]["pending"], 1)
        with self.assertRaises(ValueError):
            self.service.answer_many([{"qid": "q1", "value": 1}])
        with self.assertRaises(ValueError):
            self.service.answer_many([{"qid": "unknown", "value": True}])
        self.assertNotIn("q1", self.service.state()["answers"])
        self.service.data["questions"]["q0"]["modelTop"] = False
        self.service.data["predictions"] = {"q0": {"modelTop": True, "modelP": .999}}
        q0 = next(q for q in self.service.state()["questions"] if q["qid"] == "q0")
        self.assertEqual(q0["modelTop"], False, "Original human-check prediction must not become fitted accuracy")

    def test_exclusive_owner_refuses_second_server_and_recovers_after_close(self):
        self.service.answer_many([{"qid": "q0", "value": True}])
        with self.assertRaisesRegex(F.FeedbackUnavailable, "Another local web server"):
            F.FeedbackService(self.work, self.web)
        command = "import importlib.util,sys; s=importlib.util.spec_from_file_location('feedback',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.FeedbackService(sys.argv[2],sys.argv[3])"
        p = subprocess.run([sys.executable, "-I", "-c", command, str(HERE / "feedback.py"), str(self.work), str(self.web)], capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("Another local web server", p.stderr)
        self.assertEqual(F.read_json(self.work / "feedback.json", {})["answers"]["q0"]["value"], True)
        self.service.close()
        self.service = F.FeedbackService(self.work, self.web)
        self.assertEqual(self.service.state()["answers"]["q0"]["value"], True)

    def test_close_retains_lease_until_in_progress_refit_finishes(self):
        entered, release = threading.Event(), threading.Event()
        def fit(*args):
            entered.set()
            release.wait(5)
            return {"learned": {"moves": {}, "shadow": {}}, "predictions": {}, "resolutions": {}, "calibration": {}, "runsRefit": 0, "errors": []}
        self.service._fit = fit
        self.service.retrain()
        self.assertTrue(entered.wait(4))
        self.assertFalse(self.service.close(wait=False))
        with self.assertRaises(F.FeedbackUnavailable):
            F.FeedbackService(self.work, self.web)
        worker = self.service.thread
        release.set()
        worker.join(5)
        self.service = F.FeedbackService(self.work, self.web)
        self.assertEqual(self.service.state()["learning"]["version"], 1)

    def test_not_sure_remains_untrained_and_unknown_browser_question_can_be_imported(self):
        self.service.answer_many([{"qid": "q0", "value": None}])
        self.assertEqual(self.service.state()["learning"]["pending"], 0)
        q = {**self.questions[0], "qid": "browser:local:shadow"}
        self.service.answer_many([{"qid": q["qid"], "value": True, "question": q, "source": "browser"}])
        self.assertEqual(self.service.state()["learning"]["pending"], 1)
        self.assertEqual(self.service.state()["answers"][q["qid"]]["source"], "reviewer")
        with self.assertRaises(ValueError):
            self.service.answer_many([{"qid": "q1", "value": True, "source": "model"}])
        self.assertNotIn("q1", self.service.state()["answers"])

    def test_requeue_and_league_feedback_immediately_persist_and_refit(self):
        qs = [{"qid": "footage", "kind": "footage", "video": {"id": "video", "title": "Battle stream"}, "options": [{"value": "battles"}, {"value": "none"}]},
              {"qid": "league", "kind": "league", "video": {"id": "video"}, "battle": 2, "allBattles": True, "options": [{"value": "ultra", "label": "Ultra League"}]}]
        self.service._fit = lambda *args: {"learned": {"moves": {}, "shadow": {}}, "predictions": {}, "resolutions": {}, "calibration": {}, "runsRefit": 0, "errors": []}
        payload = [{"qid": q["qid"], "question": q, "value": q["options"][0]["value"]} for q in qs]
        self.service.answer_many(payload)
        self.assertEqual(len(list((self.work / "requeue").glob("*.json"))), 1)
        self.assertEqual(F.read_json(self.work / "relevance-feedback.json", {})["videos"]["video"]["value"], True)
        r = F.read_json(self.bench / "sources/registry.json", [])[0]
        self.assertEqual(r["leagueId"], "ultra")
        self.assertTrue(r["reviewerLeague"])
        self.assertEqual(F.read_json(self.work / "labels/video.json", {})["battles"][0]["leagueId"], "ultra")
        self.assertIsNotNone(self.service.thread)
        self.service.thread.join(5)
        for request in (self.work / "requeue").glob("*.json"):
            request.unlink()
        self.service.answer_many(payload)
        self.assertEqual(len(list((self.work / "requeue").glob("*.json"))), 0, "Acknowledged retries must not redownload a claimed video")
        self.service.answer_many([{"qid": "league", "value": None}])
        r = F.read_json(self.bench / "sources/registry.json", [])[0]
        self.assertNotIn("reviewerLeague", r)
        self.assertEqual(r["leagueId"], "great")
        self.assertNotIn("leagueId", F.read_json(self.work / "labels/video.json", {}))

    def test_evidence_settings_refit_is_due_every_24_human_move_labels(self):
        answers = self.service.data["answers"]
        for i in range(23):
            answers["m" + str(i)] = {"qid": "m" + str(i), "kind": "fastMove", "value": "MUD_SLAP"}
        answers["model"] = {"qid": "model", "kind": "fastMove", "value": "MUD_SLAP", "source": "model"}
        answers["unsure"] = {"qid": "unsure", "kind": "form", "value": None}
        self.assertFalse(self.service._params_due())
        answers["m23"] = {"qid": "m23", "kind": "form", "value": "weezing_galarian"}
        self.assertTrue(self.service._params_due())
        self.service.data["learning"]["paramsLabels"] = 24
        self.assertFalse(self.service._params_due())

    def test_rocket_and_perspective_answers_label_the_video(self):
        self.service._fit = lambda *args: {"learned": {"moves": {}, "shadow": {}}, "predictions": {}, "resolutions": {}, "calibration": {}, "runsRefit": 0, "errors": []}
        rocket = {"qid": "r1", "kind": "league", "video": {"id": "video"}, "battle": 1,
                  "options": [{"value": "rocket", "label": "Team Rocket battle"}, {"value": "great", "label": "Great League"}]}
        self.service.answer_many([{"qid": "r1", "question": rocket, "value": "rocket"}])
        labels = F.read_json(self.work / "labels/video.json", {})
        b = next(x for x in labels["battles"] if x["n"] == 2)
        self.assertEqual(b["battleType"], "rocket")
        self.assertNotIn("leagueId", b)
        self.service.answer_many([{"qid": "r1", "value": "great"}])   # a correction makes it a league battle again
        b = next(x for x in F.read_json(self.work / "labels/video.json", {})["battles"] if x["n"] == 2)
        self.assertEqual((b.get("leagueId"), b.get("battleType")), ("great", None))
        allq = dict(rocket, qid="r2", allBattles=True)
        self.service.answer_many([{"qid": "r2", "question": allq, "value": "rocket"}])
        labels = F.read_json(self.work / "labels/video.json", {})
        self.assertEqual(labels["videoType"], "rocket")
        self.assertNotIn("leagueId", labels)
        self.assertEqual(F.read_json(self.bench / "sources/registry.json", [])[0]["leagueId"], "great")   # registry league untouched
        persp = {"qid": "p1", "kind": "perspective", "video": {"id": "video"}, "battle": 0, "allBattles": True,
                 "options": [{"value": v} for v in ("left", "right", "single", "switches", "gbl")]}
        self.service.answer_many([{"qid": "p1", "question": persp, "value": "right"}])
        labels = F.read_json(self.work / "labels/video.json", {})
        self.assertEqual((labels["perspective"], labels["videoType"], labels["championship"]), ("right", "championship", True))
        requests = [F.read_json(r, {}) for r in (self.work / "requeue").glob("*.json")]
        self.assertTrue(any("right screen" in r.get("reason", "") for r in requests))
        self.service.answer_many([{"qid": "p1", "value": "gbl"}])
        labels = F.read_json(self.work / "labels/video.json", {})
        self.assertIs(labels["championship"], False)
        self.assertNotIn("perspective", labels)
        self.assertNotEqual(labels.get("videoType"), "championship")

    def test_free_llm_resolutions_are_gated_reversible_and_survive_refits(self):
        r = lambda qid, value=True, **k: {"qid": qid, "value": value, "source": "freellm", "providers": ["groq", "openrouter-nolog"], "agreement": 2, "task": "t", **k}
        with self.assertRaises(ValueError):
            self.service.resolve_external([r("q1", providers=["groq"])])
        with self.assertRaises(ValueError):
            self.service.resolve_external([{**r("q1"), "source": "model"}])
        self.questions[3]["audit"] = True
        F.atomic_json(self.bench / "results/validation-inbox.json", {"questions": self.questions})
        self.service.answer_many([{"qid": "q0", "value": False}])
        out = self.service.resolve_external([r("q0"), r("q1"), r("q2", "maybe"), r("q3"), r("q4")])
        self.assertEqual(out["saved"], 2)
        self.assertEqual({s["qid"]: s["reason"] for s in out["skipped"]}, {"q0": "answered by a person", "q2": "not an option", "q3": "spot check"})
        self.assertEqual(out["resolutions"]["q1"]["source"], "freellm")
        self.assertEqual(out["answers"].keys(), {"q0"})   # never a label
        self.assertEqual(self.service.resolve_external([r("q1")])["saved"], 0)   # idempotent
        self.service._fit = lambda q, a, v: {"learned": {"moves": {}, "shadow": {}}, "predictions": {}, "resolutions": {}, "calibration": {}, "runsRefit": 0, "errors": []}
        self.service.retrain()
        self.service.thread.join(5)
        self.assertEqual(set(self.service.state()["resolutions"]), {"q1", "q4"})
        self.service.reopen("q4")
        self.assertEqual(self.service.resolve_external([r("q4")])["skipped"][0]["reason"], "reopened by a person")
        self.service.answer_many([{"qid": "q1", "value": False}])   # a human answer replaces it
        self.assertEqual(set(self.service.state()["resolutions"]), set())

    def test_local_llm_resolutions_need_two_confident_calls(self):
        r = lambda qid, value=True, **k: {"qid": qid, "value": value, "source": "local-llm", "model": "qwen2.5vl:7b",
                                          "agreement": 2, "confidence": 0.9, "threshold": 0.8, "task": "llm_footage", **k}
        for bad in (r("q1", agreement=1), r("q1", confidence=0.7), r("q1", model=""), r("q1", threshold=None), {**r("q1"), "source": "gpt"}):
            with self.assertRaises(ValueError):
                self.service.resolve_external([bad])
        out = self.service.resolve_external([r("q1"), r("q2", "maybe")])
        self.assertEqual(out["saved"], 1)
        rec = out["resolutions"]["q1"]
        self.assertEqual((rec["source"], rec["providers"], rec["model"], rec["confidence"], rec["threshold"], rec["modelResolved"]),
                         ("local-llm", ["qwen2.5vl:7b"], "qwen2.5vl:7b", 0.9, 0.8, True))
        self.assertNotIn("q1", out["answers"])   # never a label
        self.assertEqual(self.service.resolve_external([r("q1")])["saved"], 0)
        self.service.answer_many([{"qid": "q1", "value": False}])   # a human answer replaces it
        self.assertNotIn("q1", self.service.state()["resolutions"])

    def test_eight_useful_answers_refit_and_reopen_lock_preserves_human_labels(self):
        def fit(questions, answers, version):
            return {"learned": {"moves": {}, "shadow": {"claydol": {"yes": 8, "no": 0}}}, "predictions": {}, "resolutions": {"q0": {"value": False}, "new": {"value": True}}, "calibration": {}, "runsRefit": 1, "errors": []}
        self.service._fit = fit
        self.service.answer_many([{"qid": "q" + str(i), "value": True} for i in range(8)])
        self.service.thread.join(5)
        state = self.service.state()
        self.assertEqual(state["learning"]["pending"], 0)
        self.assertEqual(state["learning"]["version"], 1)
        self.assertEqual(state["answers"]["q0"]["value"], True)
        self.assertNotIn("q0", state["resolutions"])
        self.service.reopen("new")
        self.assertNotIn("new", self.service.state()["resolutions"])
        self.assertTrue(F.read_json(self.work / "feedback.json", {})["manualReview"]["new"])
        self.assertEqual(F.read_json(self.work / "baseline-learned.json", {})["moves"]["claydol"]["MUD_SLAP"], 2)

    def test_real_offline_runner_publishes_prior_only_human_counts_preserving_baseline(self):
        # Runner symlink resolves its own source/dependencies; every writable result stays in temp.
        script = HERE.parent.parent / "tests/meta-benchmark/learning-loop.cjs"
        (self.bench / "learning-loop.cjs").symlink_to(script)
        self.service.answer_many([{"qid": "q0", "value": True}])
        self.service.retrain()
        self.service.thread.join(10)
        state = self.service.state()
        self.assertEqual(state["learning"]["status"], "idle", state["learning"])
        self.assertEqual(state["learning"]["pending"], 0)
        learned = F.read_json(self.bench / "learned.json", {})
        self.assertEqual(learned["moves"]["claydol"]["MUD_SLAP"], 2)
        self.assertEqual(learned["shadow"]["claydol"]["yes"], 1)
        self.assertEqual(learned["modelVersion"], 1)
        self.assertEqual(state["resolutions"], {})
        record = self.service.metrics()["records"][-1]   # the real runner's output also produces a history record
        self.assertEqual((record["refit"], record["labels"], record.get("backfilled")), (1, {"shadow": 1}, None))
        self.assertNotIn("heldOut", record, "No held-out labels: the record leaves the metric out instead of reporting 0")

    def fit_result(self, resolutions=None):
        return {"learned": {"moves": {}, "shadow": {}}, "predictions": {}, "resolutions": resolutions or {}, "runsRefit": 3, "errors": [],
                "calibration": {"fastMove": {"heldOut": 197, "heldOutRight": 165, "logLoss": 0.39, "threshold": 0.8, "resolveAt": 0.9,
                                             "sweep": [[0.8, 127, 131], [0.9, 98, 100]], "right": 127, "total": 131, "videoCount": 21, "lowerBound": 0.924,
                                             "bins": [{"bin": "0.5-0.7", "n": 10, "meanP": 0.6, "acc": 0.5}]},
                                "form": {"heldOut": 31, "heldOutRight": 27, "threshold": None, "sweep": [], "right": 21, "total": 22, "videoCount": 16, "lowerBound": 0}},
                "shadowModel": {"n": 410, "videos": 125, "passes": {"regular": True, "shadow": False},
                                "cv": {"old": {"n": 410, "right": 282, "logLoss": 0.646, "auc": 0.73, "brier": 0.217},
                                       "new": {"n": 410, "right": 325, "logLoss": 0.458, "auc": 0.8705, "brier": 0.148},
                                       "calibration": [{"bin": "0.0-0.1", "n": 67, "meanP": 0.043, "rate": 0.03}]},
                                "thresholds": {"regular": {"confidence": 0.7275, "n": 132, "right": 126, "accuracy": 0.95, "lowerBound": 0.904, "videos": 56},
                                               "shadow": {"confidence": 0.943, "n": 27, "right": 26, "accuracy": 0.96, "lowerBound": 0.817, "videos": 15}}}}

    def test_every_refit_appends_a_durable_metrics_record(self):
        self.service._fit = lambda q, a, v: self.fit_result({"q5": {"value": False, "source": "model"}, "q6": {"value": True, "source": "model"}})
        self.service.answer_many([{"qid": "q0", "value": True}, {"qid": "q1", "value": None}])
        self.service.retrain()
        self.service.thread.join(5)
        self.service.resolve_external([{"qid": "q7", "value": True, "source": "freellm", "providers": ["groq", "openrouter-nolog"], "agreement": 2}])
        history = F.read_json(self.work / "metrics-history.json", {})
        self.assertEqual(history["format"], "gbl-validation-metrics")
        rec = history["records"][-1]
        self.assertEqual((rec["refit"], rec["reason"], rec["runsRefit"]), (1, "Manual refit", 3))
        self.assertEqual(rec["answers"], {"shadow": 2})
        self.assertEqual(rec["labels"], {"shadow": 1}, "Not sure is an answer but not a label")
        self.assertEqual(rec["heldOut"]["fastMove"], {"right": 165, "total": 197, "logLoss": 0.39})
        self.assertEqual(rec["heldOut"]["shadow"]["auc"], 0.8705)
        self.assertEqual(rec["heldOut"]["shadow"]["baseline"]["right"], 282)
        self.assertEqual(rec["gates"]["fastMove"]["resolveAt"], 0.9)
        self.assertIs(rec["gates"]["form"]["resolving"], False)
        self.assertEqual({d: g["resolving"] for d, g in rec["gates"]["shadow"].items()}, {"regular": True, "shadow": False})
        self.assertEqual(rec["calibration"]["shadow"], [[0.043, 0.03, 67]])
        self.assertEqual(rec["calibration"]["fastMove"], [[0.6, 0.5, 10]])
        self.assertEqual(rec["resolved"], {"model": {"shadow": 2}})   # the later free-LLM resolution is not part of refit 1
        self.assertEqual(rec["shadowValues"], {"notShadow": 1, "shadow": 1})
        self.assertEqual((rec["open"], rec["questions"]), ({"shadow": 5}, 8))
        self.assertEqual(rec["models"]["shadowClassifier"], {"labels": 410, "videos": 125})
        self.assertNotIn("backfilled", rec)
        self.assertEqual(list(self.work.glob("metrics-history.json.*.tmp")), [])
        summary = self.service.state()["learning"]["metrics"]
        self.assertEqual((summary["records"], summary["latest"]["refit"]), (1, 1))
        revision = summary["revision"]
        self.service.retrain()
        self.service.thread.join(5)
        self.assertEqual([r["refit"] for r in self.service.metrics()["records"]], [1, 2])
        self.assertEqual(self.service.state()["learning"]["metrics"]["revision"], revision + 1)
        self.assertEqual(self.service.metrics()["records"][-1]["resolved"], {"freellm": {"shadow": 1}, "model": {"shadow": 2}})
        self.service.close()   # the history survives a restart unchanged
        self.service = F.FeedbackService(self.work, self.web)
        self.assertEqual([r["refit"] for r in self.service.metrics()["records"]], [1, 2])

    def test_metrics_failure_never_fails_a_saved_refit(self):
        self.service._fit = lambda q, a, v: self.fit_result()
        original = F.MH.build_record
        def broken(*a, **k):
            raise RuntimeError("disk full")
        F.MH.build_record = broken
        try:
            self.service.retrain()
            self.service.thread.join(5)
        finally:
            F.MH.build_record = original
        learning = self.service.state()["learning"]
        self.assertEqual((learning["status"], learning["version"]), ("idle", 1))
        self.assertIn("disk full", learning["metricsError"])

    def test_history_is_backfilled_once_from_saved_files_without_inventing_metrics(self):
        self.service.close()
        (self.work / "metrics-history.json").unlink()
        data = F.read_json(self.work / "feedback.json", {})
        base = lambda h, m=0: "2026-10-11T%02d:%02d:00+00:00" % (h, m)
        data["answers"] = {"a1": {"qid": "a1", "kind": "shadow", "value": True, "answeredAt": base(5)},
                           "a2": {"qid": "a2", "kind": "fastMove", "value": "MUD_SLAP", "answeredAt": base(6, 30)},
                           "a3": {"qid": "a3", "kind": "form", "value": None, "answeredAt": base(6, 40)}}
        reason = "Re-scored saved damage/timing/energy/icon evidence; held-out fastMove answers at p \u2265 0.9: 111/116 right over 21 videos (95% lower bound 90.3%)."
        data["history"] = [{"qid": "q1", "resolution": {"value": "X", "source": "model", "modelVersion": 2, "reason": reason}, "reopenedAt": base(8)},
                           {"answer": {"qid": "a2", "kind": "fastMove", "value": "OTHER", "answeredAt": base(5, 10)}, "replacedAt": base(6, 30)}]
        fit = self.fit_result()
        data["learning"] = {"status": "idle", "version": 3, "lastFit": base(9), "startedAt": base(8, 58), "reason": "Manual refit",
                            "calibration": fit["calibration"], "shadowModel": fit["shadowModel"], "runsRefit": 3, "errors": []}
        data["resolutions"] = {"q2": {"value": False, "source": "model", "modelVersion": 3}}
        F.atomic_json(self.work / "feedback.json", data)
        for n, t in ((1, base(6)), (2, base(7))):
            folder = self.work / "learning" / ("refit-%d" % n)
            folder.mkdir(parents=True)
            for vid in ("v1", "v2")[:n]:
                f = folder / (vid + ".json")
                f.write_text("{}")
                ts = F.dt.datetime.fromisoformat(t).timestamp()
                F.os.utime(f, (ts, ts))
        self.service = F.FeedbackService(self.work, self.web)
        history = self.service.metrics()
        r1, r2, r3 = history["records"]
        self.assertEqual([r["refit"] for r in (r1, r2, r3)], [1, 2, 3])
        self.assertTrue(all(r["backfilled"] and r["source"] for r in (r1, r2, r3)))
        self.assertEqual((r1["at"], r1["runsRefit"]), (base(6), 1))
        self.assertEqual(r1["labels"], {"fastMove": 1, "shadow": 1}, "The replaced fast-move answer counts while it was current")
        self.assertEqual(r2["labels"], {"fastMove": 1, "shadow": 1})
        self.assertEqual(r2["answers"], {"fastMove": 1, "form": 1, "shadow": 1})
        self.assertEqual(r2["gates"]["fastMove"], {"resolveAt": 0.9, "right": 111, "total": 116, "videos": 21, "lowerBound": 0.903, "resolving": True})
        for r in (r1, r2):
            self.assertFalse({"heldOut", "open", "resolved", "calibration", "reason"} & set(r), "Unrecorded metrics stay blank")
        self.assertEqual((r3["at"], r3["reason"], r3["heldOut"]["form"]), (base(9), "Manual refit", {"right": 27, "total": 31}))
        self.assertEqual(r3["resolved"], {"model": {"shadow": 1}})
        self.assertTrue(history["milestones"] and all(m["source"] for m in history["milestones"]))
        self.service.close()   # created once: a restart keeps it as it is
        self.service = F.FeedbackService(self.work, self.web)
        self.assertEqual(self.service.metrics()["createdAt"], history["createdAt"])

    def test_second_server_reads_metrics_read_only(self):
        sys.path.insert(0, str(HERE))
        try:
            import service as S
        finally:
            sys.path.remove(str(HERE))
        self.service._fit = lambda q, a, v: self.fit_result()
        self.service.retrain()
        self.service.thread.join(5)
        other = S.HarvestService(work_dir=self.work, web_root=self.web)
        out = other.validation_metrics()   # this server holds the lease; the other reads the file
        self.assertTrue(out["readOnly"])
        self.assertEqual(out["records"][-1]["refit"], 1)


    def test_timeline_and_policy_result_closures_are_separate_from_model_resolutions(self):
        q = {"qid": "r1", "kind": "result", "battle": 0, "recording": "v.mp4", "options": [{"value": "Win", "label": "You won"}]}
        q2 = {**q, "qid": "r2", "battle": 1}
        res = self.fit_result({"r1": {"source": "timeline", "value": "Win", "rule": "faints", "label": "You won"},
                               "r2": {"source": "policy", "value": None, "policy": "no-result-screen", "reason": "No result screen; timeline inconclusive."}})
        res["calibration"]["result"] = {"heldOut": 3, "heldOutRight": 3, "byRule": {
            "fade": {"right": 10, "total": 14, "videos": 4, "uncertain": True, "promoted": False},
            "faints": {"right": 3, "total": 3, "videos": 2, "uncertain": False, "promoted": False}}}
        res["resultSources"] = {"read": 10, "inferred": 1, "human": 3, "unresolvable": 1, "open": 2}
        self.service._fit = lambda qs, a, v: res
        self.service.data["questions"].update(r1=q, r2=q2)
        self.service.retrain()
        self.service.thread.join(10)
        st = self.service.state()
        self.assertEqual(st["learning"]["resolved"], 1)
        self.assertEqual(st["learning"]["policyClosed"], 1)
        self.assertEqual(st["resolutions"]["r2"]["source"], "policy")
        rec = self.service.metrics()["records"][-1]
        self.assertEqual(rec["resolved"]["timeline"], {"result": 1})
        self.assertEqual(rec["resolved"]["policy"], {"result": 1})
        self.assertNotIn("result", rec["resolved"].get("model", {}))
        self.assertEqual(rec["heldOut"]["result"]["rules"]["fade"], {"right": 10, "total": 14, "videos": 4, "uncertain": True, "promoted": False})
        self.assertEqual(rec["heldOut"]["result"]["rules"]["faints"]["total"], 3)
        self.assertEqual(rec["results"]["unresolvable"], 1)
        # Reopen (or a human answer) replaces a policy record, and the next refit leaves it open.
        self.service.reopen("r2")
        self.assertNotIn("r2", self.service.state()["resolutions"])

    def test_refit_reopens_a_policy_closure_the_new_rules_ask_and_carries_the_guess(self):
        q = {"qid": "r3", "kind": "result", "battle": 0, "recording": "v.mp4", "options": [{"value": "Win:opponent-forfeit", "label": "Opponent forfeited"}]}
        self.service.data["questions"].update(r3=q)
        self.service.data["resolutions"]["r3"] = {"source": "policy", "value": None, "policy": "no-result-screen", "reason": "old"}
        res = self.fit_result({})
        res["predictions"] = {"r3": {"modelTop": "Win:opponent-forfeit", "modelP": 0.71, "resultRule": "fade", "detail": "The timeline suggests..."}}
        self.service._fit = lambda qs, a, v: res
        self.service.retrain()
        self.service.thread.join(10)
        st = self.service.state()
        self.assertNotIn("r3", st["resolutions"])
        self.assertTrue(any(h.get("qid") == "r3" for h in self.service.data["history"]))

if __name__ == "__main__":
    unittest.main()
