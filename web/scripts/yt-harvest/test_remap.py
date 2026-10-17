import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("remap_battles", HERE / "remap_battles.py")
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
F = R.F

VID, OTHER = "vidAAAAAAAA", "vidBBBBBBBB"


def mon(key, first, last, cp=1000):
    return {"key": key, "label": key.title(), "cp": cp, "first": first, "last": last}


def battle(start, end, my=(), opp=(), **kw):
    return {"start": start, "end": end, "my": list(my), "opponent": list(opp), **kw}


# Old: 0 same, 1+2 merge (1 is a fragment), 3 splits in two, 4 is gone. New: battle 5 is new.
OLD = [battle(0, 100, [mon("aa", 0, 100)], [mon("xx", 0, 50), mon("yy", 50, 100)]),
       battle(100.5, 120, [], [mon("zz", 100.5, 120)]),
       battle(121, 220, [], [mon("zz", 121, 180), mon("ww", 180, 220)]),
       battle(230, 500, [], [mon("pp", 230, 300), mon("qq", 400, 480)]),
       battle(600, 700, [], [mon("gg", 600, 700)])]
NEW = [battle(0, 100, [mon("aa", 0, 100)], [mon("xx", 0, 50), mon("yy", 50, 100)], focus=[]),
       battle(100, 220, [], [mon("zz", 100, 180), mon("ww", 180, 220)], focus=[]),
       battle(230, 320, [], [mon("pp", 230, 300)], focus=[]),
       battle(380, 500, [], [mon("qq", 400, 480)], focus=[]),
       battle(800, 900, [], [mon("hh", 800, 900)], focus=[])]


def qid(rest, vid=VID, src="claude-test"):
    return f"{src}:{vid}.mp4:{rest}"


def question(q, kind, battle_i, clip, side="", key="", all_battles=False):
    return {"qid": q, "kind": kind, "battle": battle_i, "side": side, "key": key, "species": key, "allBattles": all_battles,
            "title": f"Battle {(battle_i or 0) + 1} · {key or kind}", "clip": clip, "recording": VID + ".mp4",
            "video": {"id": q.split(":")[1].removesuffix(".mp4"), "uploadDate": "20261001"},
            "options": [{"value": True}, {"value": False}, {"value": "A"}, {"value": "B"}, {"value": "Win"}, {"value": "great"},
                        {"value": "z_alt"}, {"value": "battles"}]}


def answer(qd, value, at="2026-10-11T00:00:00+00:00"):
    return {**{k: qd.get(k) for k in ("kind", "species", "side", "key", "battle", "allBattles", "video", "recording")},
            "qid": qd["qid"], "value": value, "answeredAt": at, "source": "reviewer", "label": str(value)}


class RemapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.work, self.new, self.web = root / "work", root / "new", root / "web"
        (self.web / "tests/meta-benchmark/sources").mkdir(parents=True)
        F.atomic_json(self.web / "tests/meta-benchmark/sources/registry.json", [{"id": VID, "uploadDate": "20261001"}])
        self.inbox = str(root / "inbox.json")
        F.atomic_json(self.inbox, {"questions": []})
        res = {"crop": [0, 0, 400, 800], "full": OLD, "battles": [{"start": b["start"], "end": b["end"]} for b in OLD]}
        F.atomic_json(self.work / "results" / (VID + ".json"), res)
        (self.work / "feedback.lock").touch()   # the app's lease file (present in every work dir it has opened)
        F.atomic_json(self.new / (VID + ".json"), {**res, "full": NEW, "battles": [{"start": b["start"], "end": b["end"]} for b in NEW],
                                                   "hpBars": {"reextracted": "now"}})
        F.atomic_json(self.work / "results" / (OTHER + ".json"), {"full": OLD[:2], "battles": []})
        F.atomic_json(self.work / "focus" / (VID + ".json"), {"version": 2, "battles": [[{"t": 10}], [], [], [], []]})
        F.atomic_json(self.work / "results" / (VID + ".leagues.json"), {"video": {"leagueId": "great"}, "battles": []})
        qs = {
            "same": question(qid("0:opponent:xx:fast"), "fastMove", 0, [20, 32], "opponent", "xx"),
            "frag": question(qid("1:opponent:zz:fast"), "fastMove", 1, [102, 114], "opponent", "zz"),
            "main": question(qid("2:opponent:zz:fast"), "fastMove", 2, [130, 142], "opponent", "zz"),
            "fragS": question(qid("1:opponent:zz:shadow"), "shadow", 1, [102, 114], "opponent", "zz"),
            "mainS": question(qid("2:opponent:zz:shadow"), "shadow", 2, [130, 142], "opponent", "zz"),
            "fragF": question(qid("1:opponent:zz:form"), "form", 1, [102, 114], "opponent", "zz"),
            "mainF": question(qid("2:opponent:zz:form"), "form", 2, [130, 142], "opponent", "zz"),
            "splitP": question(qid("3:opponent:pp:fast"), "fastMove", 3, [240, 252], "opponent", "pp"),
            "splitQ": question(qid("3:opponent:qq:fast"), "fastMove", 3, [410, 422], "opponent", "qq"),
            "result": question(qid("3:result"), "result", 3, [490, 506]),
            "gone": question(qid("4:opponent:gg:shadow"), "shadow", 4, [610, 622], "opponent", "gg"),
            "stale": question(qid("0:opponent:ww:fast"), "fastMove", 0, [190, 202], "opponent", "ww"),
            "footage": question(qid("footage", src="youtube-harvest"), "footage", None, [0, 20], all_battles=True),
            "league": question(qid("league", src="youtube-harvest"), "league", 4, [600, 612], all_battles=True),
            "other": question(qid("1:opponent:zz:fast", vid=OTHER), "fastMove", 1, [102, 114], "opponent", "zz"),
        }
        values = {"same": "A", "frag": "B", "main": "B", "fragS": True, "mainS": False, "fragF": None, "mainF": "z_alt",
                  "splitP": "A", "splitQ": "B", "result": "Win", "gone": True, "stale": "A", "footage": "battles",
                  "league": "great", "other": "A"}
        answers = {qs[k]["qid"]: answer(qs[k], v) for k, v in values.items()}
        self.qs, self.answers = qs, answers
        open_q = question(qid("4:opponent:gg:fast"), "fastMove", 4, [610, 622], "opponent", "gg")
        open_q2 = question(qid("3:opponent:qq:shadow"), "shadow", 3, [410, 422], "opponent", "qq")
        self.open_qs = [open_q, open_q2]
        F.atomic_json(self.work / "feedback.json", {
            "answers": answers, "questions": {q["qid"]: q for q in qs.values()}, "history": [], "manualReview": {},
            "resolutions": {qid("3:opponent:pp:shadow"): {"value": False, "source": "model"},
                            qid("2:opponent:ww:shadow"): {"value": False, "source": "local-llm", "modelResolved": True},
                            qid("1:opponent:zz:fast", vid=OTHER): {"value": "A", "source": "model"}},
            "predictions": {qid("3:opponent:qq:shadow"): {"modelTop": True, "modelP": .6}, qid("0:opponent:zz:fast", vid=OTHER): {"modelP": .5}},
            "fitSignatures": {q: F.signature(a) for q, a in answers.items() if a["kind"] in F.TRAINABLE},
            "sideEffectSignatures": {qs["result"]["qid"]: "sig-result", qs["league"]["qid"]: "sig-league"},
            "learning": {"status": "idle", "version": 3}, "revision": 7})
        F.atomic_json(self.work / "labels" / (VID + ".json"), {
            "videoId": VID, "leagueId": "great",
            "verified": {qs["result"]["qid"]: answers[qs["result"]["qid"]], qs["league"]["qid"]: answers[qs["league"]["qid"]]},
            "battles": [{"n": 4, "verified": {"result": answers[qs["result"]["qid"]]}, "result": "Win", "ending": "normal"},
                        {"n": 5, "verified": {"league": answers[qs["league"]["qid"]]}, "leagueId": "great"}]})
        qdir = self.work / "validation" / VID
        docs = [q for k, q in qs.items() if k != "other"] + self.open_qs
        for q in docs:
            F.atomic_json(qdir / (q["qid"] + ".json"), q)
        F.atomic_json(qdir / "manifest.json", [{"qid": q["qid"], "bytes": 1, "kind": q["kind"]} for q in docs])

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = R.main([str(self.work), "--new", str(self.new), "--inbox", self.inbox, "--web-root", str(self.web), *extra])
        return code, out.getvalue()

    def snapshot(self):
        return {str(p.relative_to(self.work)): p.read_bytes() for p in sorted(self.work.rglob("*")) if p.is_file()
                and not str(p.relative_to(self.work)).startswith("remap-backup")}

    def test_match_classifies_same_merged_split_new_and_gone(self):
        m = R.match_battles(OLD, NEW)
        self.assertEqual([o["status"] for o in m["olds"]], ["same", "merged", "merged", "split", "gone"])
        self.assertEqual([o["to"] for o in m["olds"]], [[0], [1], [1], [2, 3], []])
        self.assertEqual([n["status"] for n in m["news"]], ["same", "merged", "split", "split", "new"])
        self.assertEqual(m["olds"][0]["found"], 3)
        self.assertEqual(m["olds"][3]["found"], 2)
        # A few seconds of the next battle's intro do not make a match.
        self.assertFalse(R.significant(11, 129, 102.5))
        self.assertTrue(R.significant(3.5, 3.5, 186))

    def test_a_pokemon_glimpsed_at_a_battle_edge_follows_itself(self):
        # The old battle saw the next battle's lead for one frame; the new boundaries give it to the next battle.
        old = [battle(0, 100.5, [], [mon("aa", 0, 90), mon("bb", 100.5, 100.5)]), battle(101, 200, [], [mon("bb", 101, 180)])]
        new = [battle(0, 95, [], [mon("aa", 0, 90)]), battle(100.5, 200, [], [mon("bb", 100.5, 180)])]
        m = R.match_battles(old, new)
        d = R.decide(qid("0:opponent:bb:shadow"), {"clip": [100.5, 108.5]}, old, new, m)
        self.assertEqual((d["qid"], d["via"]), (qid("1:opponent:bb:shadow"), "pokemon"))
        # Without that sighting it stays archived, with the reason.
        d = R.decide(qid("0:opponent:bb:shadow"), {"clip": [300, 308]}, old, new, m)
        self.assertIsNone(d["qid"])
        self.assertIn("not in the matched new battle", d["why"])

    def test_dry_run_writes_nothing(self):
        before = self.snapshot()
        code, out = self.run_tool("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.snapshot(), before)
        self.assertIn("battles 5 -> 5", out)
        self.assertIn("dry run: nothing written", out)
        self.assertFalse(list(self.work.glob("remap-backup-*")))

    def test_apply_moves_merges_archives_and_keeps_every_human_answer(self):
        old_result = (self.work / "results" / (VID + ".json")).read_bytes()
        code, out = self.run_tool()
        self.assertEqual(code, 0, out)
        fb = json.loads((self.work / "feedback.json").read_text())
        a = fb["answers"]
        # same: kept in place, untouched
        self.assertEqual(a[qid("0:opponent:xx:fast")]["value"], "A")
        self.assertNotIn("remap", a[qid("0:opponent:xx:fast")])
        # merged and agreeing: one answer on new battle 1, from old battle 2 (covers more of it); the duplicate archived
        kept = a[qid("1:opponent:zz:fast")]
        self.assertEqual((kept["value"], kept["battle"], kept["remap"]["from"]), ("B", 1, qid("2:opponent:zz:fast")))
        self.assertNotIn(qid("2:opponent:zz:fast"), a)
        # conflict: old battle 2's False kept, old battle 1's True archived with the reason
        self.assertIs(a[qid("1:opponent:zz:shadow")]["value"], False)
        # Not sure never conflicts: the confirmed form is kept
        self.assertEqual(a[qid("1:opponent:zz:form")]["value"], "z_alt")
        # split: each Pokémon follows its clip; the result follows its battle's end
        self.assertEqual(a[qid("2:opponent:pp:fast")]["value"], "A")
        self.assertEqual(a[qid("3:opponent:qq:fast")]["value"], "B")
        self.assertEqual(a[qid("3:result")]["value"], "Win")
        # stale index: realigned by the clip (old battle 2 holds ww), then moved to new battle 1
        self.assertEqual(a[qid("1:opponent:ww:fast")]["remap"]["from"], qid("0:opponent:ww:fast"))
        # gone: archived, not deleted
        self.assertNotIn(qid("4:opponent:gg:shadow"), a)
        archived = {h["answer"]["qid"]: h for h in fb["history"] if "archivedAt" in h}
        self.assertEqual(set(archived), {qid("1:opponent:zz:fast"), qid("1:opponent:zz:shadow"), qid("1:opponent:zz:form"),
                                         qid("4:opponent:gg:shadow")})
        self.assertIn("conflict", archived[qid("1:opponent:zz:shadow")]["reason"])
        self.assertIn("same answer", archived[qid("1:opponent:zz:fast")]["reason"])
        self.assertIn("gone", archived[qid("4:opponent:gg:shadow")]["reason"])
        self.assertTrue(all(h["replacedAt"] == h["archivedAt"] for h in archived.values()))
        humans = lambda d: sum(1 for x in d.values() if R.human(x))  # noqa: E731
        self.assertEqual(humans(self.answers), humans(a) + len(archived))
        # video-wide answers unchanged; the other video untouched
        for q in (qid("footage", src="youtube-harvest"), qid("league", src="youtube-harvest"), qid("1:opponent:zz:fast", vid=OTHER)):
            self.assertEqual(a[q], self.answers[q])
        # question copies follow their answers, with the new battle in the title
        self.assertEqual(fb["questions"][qid("2:opponent:pp:fast")]["title"], "Battle 3 · pp")
        self.assertNotIn(qid("3:opponent:pp:fast"), fb["questions"])
        # derived records: model resolutions reopened (history), external moved, predictions and fit signatures cleared
        self.assertNotIn(qid("3:opponent:pp:shadow"), fb["resolutions"])
        self.assertEqual(fb["resolutions"][qid("1:opponent:ww:shadow")]["source"], "local-llm")
        self.assertIn(qid("1:opponent:zz:fast", vid=OTHER), fb["resolutions"])
        self.assertTrue(any(h.get("qid") == qid("3:opponent:pp:shadow") and "reopenedAt" in h for h in fb["history"]))
        self.assertEqual(list(fb["predictions"]), [qid("0:opponent:zz:fast", vid=OTHER)])
        self.assertEqual([q for q in fb["fitSignatures"] if VID in q], [])
        self.assertIn(qid("1:opponent:zz:fast", vid=OTHER), fb["fitSignatures"])
        self.assertEqual(fb["sideEffectSignatures"], {qid("3:result"): "sig-result", qid("league", src="youtube-harvest"): "sig-league"})
        self.assertEqual(fb["revision"], 8)
        # result installed, old kept as .previous; sidecars rebuilt or retired
        res = self.work / "results"
        self.assertEqual((res / (VID + ".json.previous")).read_bytes(), old_result)
        self.assertEqual(len(json.loads((res / (VID + ".json")).read_text())["full"]), 5)
        side = json.loads((res / (VID + ".leagues.json")).read_text())
        self.assertEqual([b["start"] for b in side["battles"]], [b["start"] for b in NEW])
        self.assertFalse((self.work / "focus" / (VID + ".json")).exists())
        # labels: result moved to n=4 (new battle 3); the gone battle's video-wide copy dropped; top level unchanged
        lab = json.loads((self.work / "labels" / (VID + ".json")).read_text())
        self.assertEqual([(b["n"], b.get("result")) for b in lab["battles"]], [(4, "Win")])
        self.assertEqual(lab["verified"][qid("3:result")]["value"], "Win")
        self.assertEqual(lab["leagueId"], "great")
        # validation files renamed, gone/merged ones archived, manifest and inbox follow
        names = {p.name for p in (self.work / "validation" / VID).glob("*.json")}
        self.assertIn(qid("2:opponent:pp:fast") + ".json", names)
        self.assertNotIn(qid("4:opponent:gg:fast") + ".json", names)
        self.assertNotIn(qid("4:opponent:gg:shadow") + ".json", names)
        self.assertIn(qid("3:opponent:qq:shadow") + ".json", names)
        moved = json.loads((self.work / "validation" / VID / (qid("2:opponent:pp:fast") + ".json")).read_text())
        self.assertEqual((moved["battle"], moved["title"]), (2, "Battle 3 · pp"))
        manifest = json.loads((self.work / "validation" / VID / "manifest.json").read_text())
        self.assertEqual({e["qid"] for e in manifest}, {n[:-5] for n in names if n != "manifest.json"})
        inbox = {q["qid"] for q in json.loads(Path(self.inbox).read_text())["questions"]}
        self.assertEqual(inbox, {n[:-5] for n in names if n != "manifest.json"})
        # every changed file is in the dated backup, with the report
        backup = next(self.work.glob("remap-backup-*"))
        journal = json.loads((backup / "backup.json").read_text())
        self.assertIn("feedback.json", {e["path"] for e in journal["files"]})
        self.assertTrue((backup / "files" / "feedback.json").exists())
        report = json.loads((backup / "remap-report.json").read_text())
        self.assertEqual(report["humanAnswers"]["before"], report["humanAnswers"]["after"] + report["humanAnswers"]["archived"])

    def test_restore_puts_every_file_back(self):
        before = self.snapshot()
        before_inbox = Path(self.inbox).read_bytes()
        self.assertEqual(self.run_tool()[0], 0)
        self.assertNotEqual(self.snapshot(), before)
        backup = next(self.work.glob("remap-backup-*"))
        code, out = self.run_tool("--restore", str(backup))
        self.assertEqual(code, 0, out)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(Path(self.inbox).read_bytes(), before_inbox)

    def test_refuses_while_the_app_holds_the_lease(self):
        (self.web / "tests/meta-benchmark/results").mkdir(parents=True)
        service = F.FeedbackService(self.work, self.web)
        try:
            before = self.snapshot()
            code, out = self.run_tool()
            self.assertEqual(code, 3)
            self.assertIn("refused", out)
            self.assertEqual(self.snapshot(), before)
            code, out = self.run_tool("--dry-run")   # a read-only preview still works
            self.assertEqual(code, 0, out)
            self.assertIn("holds the lease", out)
            self.assertEqual(self.snapshot(), before)
        finally:
            service.close()
        self.assertEqual(self.run_tool()[0], 0)

    def test_saved_result_as_new_only_realigns_stale_answers(self):
        res = self.work / "results" / (VID + ".json")
        before = res.read_bytes()
        F.atomic_json(self.new / (VID + ".json"), json.loads(before))
        code, out = self.run_tool()
        self.assertEqual(code, 0, out)
        self.assertIn("unchanged: not reinstalled", out)
        self.assertEqual(res.read_bytes(), before)
        self.assertFalse((self.work / "results" / (VID + ".json.previous")).exists())
        a = json.loads((self.work / "feedback.json").read_text())["answers"]
        self.assertEqual(a[qid("2:opponent:ww:fast")]["remap"]["from"], qid("0:opponent:ww:fast"))
        self.assertEqual(a[qid("1:opponent:zz:fast")], self.answers[qid("1:opponent:zz:fast")])

    def test_skips_a_result_analysed_with_another_crop(self):
        F.atomic_json(self.new / (VID + ".json"), {"crop": [1, 1, 2, 2], "full": NEW})
        before = self.snapshot()
        code, out = self.run_tool()
        self.assertEqual(code, 0, out)
        self.assertIn("skipped", out)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
