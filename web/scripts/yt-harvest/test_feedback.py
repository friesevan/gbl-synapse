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


if __name__ == "__main__":
    unittest.main()
