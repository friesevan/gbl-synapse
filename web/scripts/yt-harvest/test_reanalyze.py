"""Re-analysis tool (reanalyze.py) and its queue (reanalysis_queue.py): python3 -I test_reanalyze.py"""
import collections
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harvest as H  # noqa: E402
import reanalysis_queue as RQ  # noqa: E402
import reanalyze as R  # noqa: E402

A, B, C = "abcdefghijk", "bcdefghijkl", "cdefghijklm"


class QueueTest(unittest.TestCase):
    def test_parse_ids_from_urls_and_lists(self):
        text = (f"https://www.youtube.com/watch?v={A}&t=10s\nhttps://youtu.be/{B}?si=x, {C}\n{A}\n"
                "https://www.youtube.com/shorts/defghijklmn")
        self.assertEqual(RQ.parse_ids(text), [A, B, "defghijklmn", C])
        self.assertEqual(RQ.parse_ids([A, A, B]), [A, B])

    def test_queue_marks_on_disk_download_unknown_and_obscured(self):
        with tempfile.TemporaryDirectory() as d:
            st = H.State(os.path.join(d, "state.sqlite"))
            video = Path(d) / (A + ".mp4")
            video.write_bytes(b"x")
            st.x("INSERT INTO videos(id,dl_status,dl_path,x_status,deleted_date) VALUES(?,'done',?,'done',NULL)", (A, str(video)))
            st.x("INSERT INTO videos(id,dl_status,dl_path,x_status,deleted_date,allowed,attempts) VALUES(?,'done',?,'done','2026-10-01',0,3)",
                 (B, str(Path(d) / "gone.mp4")))
            st.x("INSERT INTO videos(id,x_status) VALUES('defghijklmn','done')")
            (Path(d) / "labels").mkdir()
            (Path(d) / "labels" / "defghijklmn.json").write_text('{"videoType": "obscured"}')
            out = RQ.queue(d, [A, B, C, "defghijklmn"], reason="code-fix")
            self.assertEqual((out["onDisk"], out["needDownload"], out["unknown"], out["obscured"], out["queued"]), (1, 1, 1, 1, 2))
            row = st.q("SELECT dl_status, deleted_date, allowed, attempts, x_status FROM videos WHERE id=?", (B,))[0]
            self.assertEqual((row["dl_status"], row["deleted_date"], row["allowed"], row["attempts"], row["x_status"]), (None, None, 1, 0, "done"),
                             "a missing video is downloaded again; its earlier result stays")
            reasons = {r["id"]: (r["reason"], r["scope"], r["source"]) for r in st.q("SELECT * FROM reprocess")}
            self.assertEqual(reasons[A], ("code-fix", "full", "owner"))
            snap = RQ.snapshot(d)
            self.assertEqual((snap["total"], snap["ready"], snap["waitingDownload"]), (2, 1, 1))
            self.assertEqual(RQ.remove(d, [A])["removed"], 1)
            self.assertEqual(st.q("SELECT x_status FROM videos WHERE id=?", (A,))[0][0], "done")
            with self.assertRaises(ValueError):
                RQ.queue(d, [A], reason="because")
            st.db.close()

    def test_busy_rows_are_recorded_but_not_reset(self):
        with tempfile.TemporaryDirectory() as d:
            st = H.State(os.path.join(d, "state.sqlite"))
            st.x("INSERT INTO videos(id,dl_status,x_status) VALUES(?,'working',NULL)", (A,))
            out = RQ.queue(d, [A])
            self.assertEqual(out["busy"], 1)
            self.assertEqual(st.q("SELECT dl_status FROM videos")[0][0], "working")
            st.db.close()

    def test_harvester_leaves_queued_videos_to_the_reanalyzer(self):
        with tempfile.TemporaryDirectory() as d:
            st = H.State(os.path.join(d, "state.sqlite"))
            st.x("INSERT INTO videos(id,dl_status,x_status,upload_date) VALUES(?,'done',NULL,'20261001')", (A,))
            st.x("INSERT INTO videos(id,dl_status,x_status,upload_date) VALUES(?,'done',NULL,'20261002')", (B,))
            st.x("INSERT INTO reprocess(id,requested) VALUES(?,1)", (B,))
            self.assertEqual([r["id"] for r in st.q(H.X_CLAIM)], [A])
            self.assertEqual([r["id"] for r in st.q(H.X_REPROCESS_CLAIM)], [B])
            # Downloads: a queued video that must be downloaded again comes first.
            st.x("INSERT INTO videos(id,dl_status,allowed,attempts,upload_date) VALUES(?,NULL,1,0,'20200101')", (C,))
            st.x("INSERT INTO videos(id,dl_status,allowed,attempts,upload_date) VALUES('defghijklmn',NULL,1,0,'20261010')")
            st.x("INSERT INTO reprocess(id,requested) VALUES(?,2)", (C,))
            self.assertEqual(st.q(H.DL_CLAIM)[0]["id"], C)
            st.db.close()

    def test_state_resets_only_its_own_work(self):
        with tempfile.TemporaryDirectory() as d:
            st = H.State(os.path.join(d, "state.sqlite"))
            st.x("INSERT INTO videos(id,dl_status,x_status) VALUES(?,'working','working')", (A,))
            st.x("INSERT INTO videos(id,x_status) VALUES(?,'reworking')", (B,))
            st.x("INSERT INTO reprocess(id,requested) VALUES(?,1)", (B,))
            st.db.close()
            with open(os.path.join(d, RQ.LOCK_NAME), "a") as lock:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX)
                self.assertTrue(RQ.reanalyzer_running(d))
                st = H.State(os.path.join(d, "state.sqlite"))      # harvester start while a re-analysis runs
                rows = {r["id"]: (r["dl_status"], r["x_status"]) for r in st.q("SELECT * FROM videos")}
                self.assertEqual(rows[A], (None, None))
                self.assertEqual(rows[B], (None, "reworking"), "the running re-analysis keeps its claim")
                st.db.close()
            self.assertFalse(RQ.reanalyzer_running(d))
            st = H.State(os.path.join(d, "state.sqlite"), reset="reprocess")
            self.assertEqual(st.q("SELECT x_status FROM videos WHERE id=?", (B,))[0][0], "done")
            st.db.close()


class CompareTest(unittest.TestCase):
    RESULT = {"videoSeconds": 900, "crop": [10, 0, 288, 640], "media": {"crop": "auto"}, "nameLanguage": "ko",
              "battles": [{"start": 100, "end": 200}, {"start": 240, "end": 330}, {"start": 700, "end": 880}]}

    def test_compare_reports_species_battles_and_results(self):
        before = {"battles": [{"start": 1, "my": ["Mewtwo (Mega Y)", "Corvisquire"], "opponent": ["Dialga"], "result": "win"}]}
        after = {"battles": [{"start": 1, "my": ["Mewtwo (Mega Y)", "Zekrom"], "opponent": ["Dialga"], "result": "loss"},
                             {"start": 300, "my": [], "opponent": ["Kyogre"], "result": "win"}]}
        c = R.compare(before, after)
        self.assertEqual((c["battlesBefore"], c["battlesAfter"], c["resultsChanged"]), (1, 2, 1))
        self.assertEqual(sorted(c["gained"]), ["Kyogre", "Zekrom"])
        self.assertEqual(c["lost"], ["Corvisquire"])
        self.assertIn("battles 1 → 2", c["summary"])
        self.assertEqual(R.compare(before, before)["summary"], "no change")


class RunnerTest(unittest.TestCase):
    def fake(self, d):
        r = R.Reanalyzer.__new__(R.Reanalyzer)
        r.a = SimpleNamespace(work_dir=d, download_dir=d, keep=True, inbox="", registry=None, no_probe=True,
                              fetch_missing="none", keep_running=False, extract_jobs=2, ffmpeg_threads=1)
        r.state = H.State(os.path.join(d, "state.sqlite"), reset="reprocess")
        r.inflight, r.registry, r.validation_lock = set(), {}, threading.RLock()
        r.stop, r.deadline, r.schedule = threading.Event(), float("inf"), {"cups": {}}
        r.inc = lambda *_: None
        r.clock, r.c = threading.Lock(), {"xVideoS": 0.0, "xBusyS": 0.0}
        r.x_claim = (H.X_REPROCESS_CLAIM, ())
        r.jobs, r.recent, r.plans, r.jobs_lock = {}, collections.deque(maxlen=60), {}, threading.Lock()
        r.done = {"ok": 0, "failed": 0, "interrupted": 0, "needsDownload": 0, "videoSeconds": 0.0, "busySeconds": 0.0}
        r.started_at, r.fetch_proc, r.fetch_tried = "now", None, set()
        r.export_validation = lambda *a, **kw: 0
        r.apply_retention = lambda *a, **kw: None
        return r

    def test_reanalysis_replaces_result_and_reports_the_change(self):
        with tempfile.TemporaryDirectory() as d:
            r = self.fake(d)
            video = Path(d) / (A + ".mp4")
            video.write_bytes(b"x")
            (Path(d) / "results").mkdir()
            res = Path(d) / "results" / (A + ".json")
            res.write_text(json.dumps({**CompareTest.RESULT, "battles": [{"start": 100, "end": 200, "my": ["Corvisquire"], "opponent": []}]}))
            r.state.x("INSERT INTO videos(id,dl_status,dl_path,x_status,duration,title,league,upload_date,meta) "
                      "VALUES(?,'done',?,'done',900,'Korean GBL','{}','20261001','{}')", (A, str(video)))
            RQ.queue(d, [A], reason="code-fix", db=r.state.db)
            seen = {}

            class Process:
                def __init__(self, command, env=None, **kw):
                    seen.update(env)
                    Path(command[-1]).write_text(json.dumps({"battles": [{"start": 100, "end": 200, "my": ["Zekrom"], "opponent": []}], "full": []}))
                    self.returncode, self.pid = 0, 0

                def poll(self):
                    return self.returncode

            claimed = r._claim(*r.x_claim, "x_status", lambda row: "reworking" if row["x_status"] == "done" else "working")
            self.assertEqual(r.state.q("SELECT x_status FROM videos")[0][0], "reworking")
            with patch("harvest.subprocess.Popen", Process), patch("harvest.gamemaster_for", return_value=""), \
                    patch("harvest.write_league_refinement", return_value=None):
                r.extract_one(claimed)
            self.assertEqual(seen.get("FORCE_FULL"), "1", "every re-analysis decodes the whole video")
            self.assertNotIn("RANGES", seen)
            self.assertNotIn("NAME_LANGUAGE", seen)
            self.assertTrue(seen["PROGRESS_FILE"].endswith(A + ".json"))
            self.assertFalse(r.state.q("SELECT * FROM reprocess"))
            self.assertEqual(json.loads(res.read_text())["battles"][0]["my"], ["Zekrom"])
            entry = r.recent[0]
            self.assertEqual((entry["outcome"], entry["mode"], entry["change"]["gained"], entry["change"]["lost"]),
                             ("ok", "whole video", ["Zekrom"], ["Corvisquire"]))
            summary = r.report()
            self.assertEqual(summary["finished"]["ok"], 1)
            self.assertEqual(summary["queue"]["total"], 0)
            r.state.db.close()

    def test_failed_first_analysis_leaves_the_queue_and_abort_keeps_the_request(self):
        with tempfile.TemporaryDirectory() as d:
            r = self.fake(d)
            video = Path(d) / (A + ".mp4")
            video.write_bytes(b"x")
            (Path(d) / "results").mkdir()
            r.state.x("INSERT INTO videos(id,dl_status,dl_path,x_status,duration,league,upload_date,meta) "
                      "VALUES(?,'done',?,NULL,600,'{}','20261001','{}')", (A, str(video)))
            RQ.queue(d, [A], db=r.state.db)

            def process(code):
                class Process:
                    def __init__(self, command, **kw):
                        self.returncode, self.pid = code, 0

                    def poll(self):
                        return self.returncode
                return Process
            with patch("harvest.subprocess.Popen", process(1)), patch("harvest.gamemaster_for", return_value=""):
                r.extract_one(r._claim(*r.x_claim, "x_status", "working"))
            self.assertEqual(r.recent[0]["outcome"], "failed")
            self.assertFalse(r.state.q("SELECT * FROM reprocess"), "not retried forever")
            r._release(A)
            # "Stop now": the running analysis ends, the request and the earlier result stay.
            (Path(d) / "results" / (A + ".json")).write_text('{"battles": []}')
            r.state.x("UPDATE videos SET x_status='done'")
            RQ.queue(d, [A], db=r.state.db)
            Path(d, R.ABORT).touch()
            r.stop.set()

            class Running:
                def __init__(self, command, **kw):
                    self.returncode, self.pid = None, 0

                def poll(self):
                    return self.returncode

                def wait(self, timeout=None):
                    self.returncode = -15
            with patch("harvest.subprocess.Popen", Running), patch("harvest.gamemaster_for", return_value=""), \
                    patch("harvest.os.killpg", lambda *a: None):
                r.extract_one(r._claim(*r.x_claim, "x_status", lambda row: "reworking"))
            self.assertEqual(r.recent[0]["outcome"], "interrupted")
            self.assertEqual(r.state.q("SELECT x_status FROM videos")[0][0], "done")
            self.assertTrue(r.state.q("SELECT * FROM reprocess"))
            r.state.db.close()

    def test_progress_follows_the_video_time(self):
        with tempfile.TemporaryDirectory() as d:
            r = self.fake(d)
            os.makedirs(os.path.join(d, "reanalyze", "progress"))
            Path(d, "reanalyze", "progress", A + ".json").write_text('{"t": 300}')
            p = r._job_progress({"id": A, "plannedSeconds": 900, "videoSeconds": 900})
            self.assertEqual((p["doneSeconds"], p["fraction"]), (300.0, 0.333))
            self.assertEqual(p["etaSeconds"], round(600 / R.DEFAULT_REALTIME))
            r.state.db.close()


class ServiceTest(unittest.TestCase):
    def test_queue_start_and_stop_from_the_card(self):
        import service as S
        with tempfile.TemporaryDirectory() as d:
            st = H.State(os.path.join(d, "state.sqlite"))
            st.x("INSERT INTO videos(id,x_status,title) VALUES(?,'done','Old video')", (A,))
            st.db.close()
            launched = []

            class Child:
                pid = 4242

                def poll(self):
                    return None
            rows = [{"pid": 4242, "identity": "Sat Oct 18 10:00:00 2026", "command": "python -I reanalyze.py run"}]
            svc = S.HarvestService(work_dir=d, web_root=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                   popen=lambda cmd, **kw: launched.append(cmd) or Child(), processes=lambda: rows,
                                   dependency_probe=lambda: {"ready": True, "missing": [], "python": "/venv/python"})
            out = svc.reanalyze_queue({"ids": f"https://youtu.be/{A} {B}", "reason": "code-fix"})
            self.assertEqual((out["queued"]["queued"], out["queued"]["unknown"]), (1, 1))
            self.assertEqual(out["reanalyze"]["queue"]["total"], 1)
            with self.assertRaises(ValueError):
                svc.reanalyze_start({"jobs": 0})
            out = svc.reanalyze_start({"jobs": 2, "fetchMissing": True})
            cmd = launched[0]
            self.assertIn("reanalyze.py", " ".join(cmd))
            self.assertEqual(cmd[cmd.index("--jobs") + 1], "2")
            self.assertEqual(cmd[cmd.index("--fetch-missing") + 1], "tornado")
            self.assertEqual(out["reanalyze"]["phase"], "starting")
            svc.reanalyze_stop({"now": True})
            self.assertTrue(Path(d, "reanalyze.STOP").exists() and Path(d, "reanalyze.ABORT").exists())
            self.assertEqual(svc.reanalyze_remove({"ids": [A]})["removed"], 1)


class MembersOnlyTest(unittest.TestCase):
    def test_listing_badge_and_titles(self):
        self.assertEqual(H.restricted_reason({"availability": "subscriber_only", "title": "GBL"}), "members-only (listing badge)")
        for title in ("（メンバー限定）レトロカップで爆勝ち", "【メン限定動画】レジェンド常連は", "【メンバー限定】緊急配信！",
                      "Members only: my Great League team", "멤버십 전용 영상", "Solo miembros - Liga Super Ball"):
            self.assertEqual(H.restricted_reason({"title": title}), "members-only (title)", title)
        for title in ("Pokemon GO Great League", "メンバー紹介！", "Mega Ohrdoch so bulky"):
            self.assertEqual(H.restricted_reason({"title": title}), "", title)

    def test_mark_restricted_takes_videos_off_the_queues(self):
        with tempfile.TemporaryDirectory() as d:
            h = H.Harvester.__new__(H.Harvester)
            h.state = H.State(os.path.join(d, "state.sqlite"))
            h.inc = lambda *_: None
            h.state.x("INSERT INTO videos(id,meta_status,allowed,dl_status) VALUES(?,'done',1,NULL)", (A,))
            h.state.x("INSERT INTO videos(id,meta_status,allowed,dl_status) VALUES(?,'done',1,'done')", (B,))
            self.assertEqual(h.mark_restricted(A, "members-only (listing badge)"), 1)
            self.assertEqual(h.mark_restricted(B, "members-only (listing badge)"), 0, "a downloaded video keeps what it has")
            row = h.state.q("SELECT meta_status, allowed, err FROM videos WHERE id=?", (A,))[0]
            self.assertEqual((row["meta_status"], row["allowed"]), ("unavailable", 0))
            self.assertFalse([r for r in h.state.q(H.DL_CLAIM) if r["id"] == A])
            h.state.db.close()


if __name__ == "__main__":
    unittest.main()
