"""Unit tests for the YouTube harvester. Run: python3 -I web/scripts/yt-harvest/test_yt_harvest.py"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harvest as H  # noqa: E402
import league as L  # noqa: E402
import policy as P  # noqa: E402
import validate as V  # noqa: E402
import ytapi  # noqa: E402

GM = {
    "medicham": {"speciesId": "medicham", "dex": 308, "types": ["fighting", "psychic"], "tags": [], "family": {"parent": "meditite"}},
    "meditite": {"speciesId": "meditite", "dex": 307, "types": ["fighting", "psychic"], "tags": [], "family": {}},
    "azumarill": {"speciesId": "azumarill", "dex": 184, "types": ["water", "fairy"], "tags": [], "family": {"parent": "marill"}},
    "marill": {"speciesId": "marill", "dex": 183, "types": ["water", "fairy"], "tags": [], "family": {"parent": "azurill"}},
    "azurill": {"speciesId": "azurill", "dex": 298, "types": ["normal", "fairy"], "tags": [], "family": {}},
    "lugia": {"speciesId": "lugia", "dex": 249, "types": ["psychic", "flying"], "tags": ["legendary"], "family": {}},
    "charizard": {"speciesId": "charizard", "dex": 6, "types": ["fire", "flying"], "tags": [], "family": {}},
    "sableye": {"speciesId": "sableye", "dex": 302, "types": ["dark", "ghost"], "tags": [], "family": {}},
    "crustle": {"speciesId": "crustle", "dex": 558, "types": ["bug", "rock"], "tags": [], "family": {}},
}
SCHED = {
    "periods": [
        {"start": "2025-01-01", "end": "2025-01-07", "formats": [{"id": "great", "cp": 1500}, {"id": "spooky", "cp": 1500}]},
        {"start": "2025-01-08", "end": "2025-01-14", "formats": [{"id": "ultra", "cp": 2500}, {"id": "spooky", "cp": 500}]},
    ],
    "cups": {
        "great": {"name": "Great League", "cp": 1500}, "ultra": {"name": "Ultra League", "cp": 2500},
        "master": {"name": "Master League", "cp": 10000}, "little": {"name": "Little Cup", "cp": 500,
                                                                     "include": [{"filterType": "evolution", "values": [1]}]},
        "spooky": {"name": "Spooky Cup", "cp": 1500, "aliases": ["copa espeluznante"],
                   "include": [{"filterType": "type", "values": ["ghost", "dark", "bug"]},
                               {"filterType": "id", "values": ["charizard"]}],
                   "exclude": [{"filterType": "id", "values": ["crustle"]},
                               {"filterType": "id", "values": ["sableye"], "leagues": [500]}]},
        "nolegend": {"name": "Premier Cup", "cp": 10000, "exclude": [{"filterType": "tag", "values": ["legendary"]}]},
    },
}


class Policy(unittest.TestCase):
    def entry(self, **kw):
        e = {"relevanceLabel": "relevant", "durationS": 900, "liveStatus": "not_live", "availability": "public",
             "license": "Standard YouTube License", "permission": "not requested"}
        e.update(kw)
        return e

    def test_default_allows_any_plausible_battle_video(self):
        self.assertTrue(P.download_allowed(self.entry())[0])

    def test_not_relevant_or_short_or_live_or_long_refused(self):
        self.assertFalse(P.download_allowed(self.entry(relevanceLabel="maybe"))[0])
        self.assertFalse(P.download_allowed(self.entry(durationS=45))[0])
        self.assertFalse(P.download_allowed(self.entry(liveStatus="is_live"))[0])
        self.assertFalse(P.download_allowed(self.entry(durationS=5 * 3600))[0])
        self.assertFalse(P.download_allowed(self.entry(availability="private"))[0])
        self.assertFalse(P.download_allowed(self.entry(durationS=None))[0])

    def test_cc_only_mode(self):
        self.assertFalse(P.download_allowed(self.entry(), cc_only=True)[0])
        self.assertTrue(P.download_allowed(self.entry(license="Creative Commons Attribution license (reuse allowed)"), cc_only=True)[0])
        self.assertTrue(P.download_allowed(self.entry(permission="creator agreed in writing 2026-10-01"), cc_only=True)[0])
        self.assertFalse(P.download_allowed(self.entry(permission="not requested"), cc_only=True)[0])

    def test_relevance(self):
        self.assertEqual(P.relevance("Best GREAT LEAGUE team | Pokémon GO Battle League", 1100)[1], "relevant")
        self.assertEqual(P.relevance("GBL great league #shorts", 50)[1], "no")
        self.assertEqual(P.relevance("Mewtwo raid day shiny hunt Pokemon GO", 900)[1], "no")
        self.assertEqual(P.relevance("Minecraft let's play", 900)[1], "no")
        # Channel history and species names rescue terse titles from battle channels.
        self.assertNotEqual(P.relevance("Medicham is BROKEN", 900, channel_battle_hits=5, species_hit=True)[1], "no")


class League(unittest.TestCase):
    def test_schedule_with_lag_and_cp_editions(self):
        f = L.schedule_formats(SCHED, "20250109")
        self.assertEqual(f["ultra"], 1.0)
        self.assertEqual(f["spooky@500"], 1.0)
        self.assertEqual(f["great"], 0.6)        # previous week, inside the upload-lag window
        self.assertEqual(L.schedule_formats(SCHED, "20240101"), {})

    def test_title_beats_schedule(self):
        g = L.guess_league({"title": "Spooky Cup team that hit Legend", "uploadDate": "20250103"}, SCHED)
        self.assertEqual(g["leagueId"], "spooky")
        self.assertGreater(g["leagueConfidence"], 0.6)
        g = L.guess_league({"title": "Copa Espeluznante equipo", "uploadDate": "20250103"}, SCHED)
        self.assertEqual(g["leagueId"], "spooky")

    def test_schedule_only_is_low_confidence(self):
        g = L.guess_league({"title": "Medicham sweeps!", "uploadDate": "20250103"}, SCHED)
        self.assertIn(g["leagueId"], ("great", "spooky"))
        self.assertLess(g["leagueConfidence"], 0.5)

    def test_compilation_flags(self):
        self.assertEqual(L.guess_league({"title": "GBL highlights compilation"}, SCHED)["kindGuess"], "compilation")
        g = L.guess_league({"title": "My week", "chapters": [{"title": "Great League"}, {"title": "Ultra League set"}]}, SCHED)
        self.assertEqual(g["kindGuess"], "compilation")
        self.assertEqual(L.guess_league({"title": "Great League set"}, SCHED)["kindGuess"], "set/gameplay")

    def test_cp_cap(self):
        self.assertEqual(L.cp_cap_for([480, 500]), 500)
        self.assertEqual(L.cp_cap_for([1499, 1200]), 1500)
        self.assertEqual(L.cp_cap_for([2498]), 2500)
        self.assertEqual(L.cp_cap_for([3500]), 10000)

    def test_refine_by_cp(self):
        r = L.refine_battle_league({"cps": [2400, 2500], "species": []}, ["great", "ultra", "master"], SCHED, GM)
        self.assertEqual(r["ranked"][0]["id"], "ultra")
        self.assertIn("great", [e["id"] for e in r["eliminated"]])

    def test_refine_by_species_rules(self):
        obs = {"cps": [1500, 1497], "species": ["sableye", "charizard"]}
        r = L.refine_battle_league(obs, ["great", "spooky"], SCHED, GM)
        self.assertEqual(r["ranked"][0]["id"], "spooky")         # restricted cup the team satisfies wins
        obs = {"cps": [1500], "species": ["medicham"]}            # fighting/psychic: not a Spooky Cup mon
        r = L.refine_battle_league(obs, ["great", "spooky"], SCHED, GM)
        self.assertEqual([x["id"] for x in r["ranked"]], ["great"])
        r = L.refine_battle_league({"cps": [1500], "species": ["crustle"]}, ["spooky"], SCHED, GM)
        self.assertEqual(r["ranked"], [])                        # excluded by id

    def test_league_scoped_filters_and_evolution(self):
        r = L.refine_battle_league({"cps": [500], "species": ["sableye"]}, ["spooky@500", "spooky"], SCHED, GM)
        self.assertEqual([x["id"] for x in r["ranked"]], ["spooky"])   # sableye banned only at 500 CP
        r = L.refine_battle_league({"cps": [500, 499], "species": ["azurill", "meditite"]}, ["little", "great"], SCHED, GM)
        self.assertEqual(r["ranked"][0]["id"], "little")
        r = L.refine_battle_league({"cps": [500], "species": ["marill"]}, ["little"], SCHED, GM)
        self.assertEqual(r["ranked"], [])                        # evolved once: not Little Cup

    def test_tag_exclusion(self):
        r = L.refine_battle_league({"cps": [4000], "species": ["lugia"]}, ["master", "nolegend"], SCHED, GM)
        self.assertEqual([x["id"] for x in r["ranked"]], ["master"])

    def test_real_schedule_loads(self):
        s = L.load_schedule()
        self.assertGreater(len(s["periods"]), 50)
        for p in s["periods"]:
            for f in p["formats"]:
                self.assertIsNotNone(L.get_format(L.format_key(f["id"], f.get("cp"), s["cups"]), s["cups"])[1], f)


class Harvest(unittest.TestCase):
    def test_classify_error(self):
        self.assertEqual(H.classify_error("HTTP Error 429: Too Many Requests"), "ratelimit")
        self.assertEqual(H.classify_error("Sign in to confirm you’re not a bot"), "ratelimit")
        self.assertEqual(H.classify_error("Sign in to confirm your age"), "unavailable")
        self.assertEqual(H.classify_error("Private video"), "unavailable")
        self.assertEqual(H.classify_error("Connection reset"), "transient")

    def test_backoff_grows(self):
        b = H.Backoff(base=10, cap=100)
        d1 = b.hit()
        self.assertLessEqual(b.hit(), d1)          # simultaneous failures: one event, no escalation
        self.assertEqual(b.events, 1)
        b.until = 0
        d2 = b.hit()
        self.assertGreater(d2, d1 * 1.5)
        for _ in range(10):
            b.until = 0
            b.hit()
        b.until = 0
        self.assertLessEqual(b.hit(), 110)

    def test_limiter_halves_and_spaces_requests(self):
        import threading
        lim = H.Limiter(600, floor=3)               # 10/s
        stop = threading.Event()
        t = __import__("time").time()
        for _ in range(4):
            lim.acquire(stop)
        self.assertGreaterEqual(__import__("time").time() - t, 0.28)
        self.assertEqual(lim.slow_down(), 300)
        for _ in range(10):
            lim.slow_down()
        self.assertEqual(lim.rate, 3)

    def test_queries_unique_and_multilingual(self):
        q = H.build_queries(L.load_schedule())
        self.assertEqual(len(q), len({x.lower() for x in q}))
        self.assertTrue(any("スーパーリーグ" in x for x in q))
        self.assertTrue(any("season" in x for x in q))
        self.assertGreater(len(q), 150)

    def test_state_dedupe_and_resume(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "s.sqlite")
            s = H.State(p)
            e = {"id": "abc", "title": "t", "duration": 600}
            self.assertTrue(s.add_flat(e, "search", 3, "relevant"))
            self.assertFalse(s.add_flat(e, "channel", 3, "relevant"))   # dedupe by id
            s.x("UPDATE videos SET meta_status='working', dl_status='working' WHERE id='abc'")
            s.db.close()
            s2 = H.State(p)                                              # resume: interrupted work is re-queued
            r = s2.q("SELECT meta_status, dl_status FROM videos WHERE id='abc'")[0]
            self.assertEqual((r["meta_status"], r["dl_status"]), ("todo", None))
            self.assertEqual(s2.q("SELECT COUNT(*) FROM videos")[0][0], 1)

    def test_registry_merge_keeps_manual_fields_and_sorts(self):
        prior = {"zz1": {"id": "zz1", "status": "processed", "pilot": True, "leagueGuess": "Great League",
                         "sha256": "aa", "permission": "CC license (reuse allowed with attribution)", "shortlist": True}}
        meta = {"title": "Ultra League set", "uploadDate": "20250101", "durationS": 600, "license": "Standard YouTube License",
                "creativeCommons": False, "channel": "C"}
        rows = [{"id": "zz1", "meta": json.dumps(meta), "league": json.dumps({"leagueGuess": "Ultra League", "leagueId": "ultra"}),
                 "allowed": 1, "dl_status": "prior"},
                {"id": "aa0", "meta": json.dumps(meta), "league": json.dumps({"leagueGuess": "Ultra League", "leagueId": "ultra"}),
                 "allowed": 1, "dl_status": "done", "x_status": "done", "deleted_date": "2026-10-12", "sha256": "bb",
                 "size_bytes": 2e8, "dl_date": "2026-10-12", "x_date": "2026-10-12"}]
        reg = H.merge_registry(prior, rows)
        self.assertEqual(reg["zz1"]["status"], "processed")
        self.assertEqual(reg["zz1"]["leagueGuess"], "Great League")      # manual label kept
        self.assertEqual(reg["zz1"]["leagueId"], "ultra")
        self.assertEqual(reg["aa0"]["status"], "deleted")
        self.assertEqual(reg["aa0"]["permission"], "not requested")
        self.assertNotIn("description", reg["aa0"])
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "r.json")
            H.write_registry(p, reg)
            self.assertEqual([e["id"] for e in json.loads(open(p).read())], ["aa0", "zz1"])

    def test_sha_prefix(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"hello")
        try:
            self.assertEqual(H.sha256_prefix(f.name), "2cf24dba5fb0a30e")
        finally:
            os.remove(f.name)


class TestDataApi(unittest.TestCase):
    def test_duration_and_chapters(self):
        self.assertEqual(ytapi.iso_duration("PT1H2M3S"), 3723)
        self.assertEqual(ytapi.iso_duration("PT45S"), 45)
        self.assertIsNone(ytapi.iso_duration("bogus"))
        ch = ytapi.chapters_from_description("Intro\n0:00 Great League\n12:30 Ultra League\n1:02:00 Master")
        self.assertEqual([c["start"] for c in ch], [0, 750, 3720])
        self.assertEqual(ytapi.chapters_from_description("check 5:00 for the sweep"), [])

    def test_to_meta(self):
        item = {"id": "abc", "snippet": {"title": "GBL", "channelId": "UC1", "channelTitle": "Ch", "publishedAt": "2026-10-01T12:00:00Z",
                                         "description": "", "tags": ["gbl"]},
                "contentDetails": {"duration": "PT20M", "definition": "hd"}, "status": {"license": "creativeCommon"},
                "statistics": {"viewCount": "12"}}
        m = ytapi.to_meta(item, P.is_cc)
        self.assertEqual((m["uploadDate"], m["durationS"], m["creativeCommons"], m["views"]), ("20261001", 1200, True, 12))
        self.assertTrue(set(H.extract_meta({"id": "x"})) <= set(m))   # same fields as the web path

    def test_key_never_from_repo(self):
        old = os.environ.pop("YOUTUBE_API_KEY", None)
        try:
            os.environ["YOUTUBE_API_KEY"] = "k123"
            self.assertEqual(ytapi.api_key(), "k123")
        finally:
            os.environ.pop("YOUTUBE_API_KEY", None)
            if old:
                os.environ["YOUTUBE_API_KEY"] = old


class TestDownloadQueue(unittest.TestCase):
    def test_relevant_titles_queue_newest_first(self):
        with tempfile.TemporaryDirectory() as d:
            st = H.State(os.path.join(d, "s.sqlite"))
            for vid, label, ts in [("old", "relevant", 1600000000), ("new", "relevant", 1790000000), ("maybe", "maybe", 1795000000)]:
                st.add_flat({"id": vid, "title": vid, "timestamp": ts}, "search", 1, label)
            st.x("UPDATE videos SET meta_status='done', allowed=1, upload_date='20260101' WHERE id='old'")
            ids = [r["id"] for r in st.q(H.DL_CLAIM)]
            self.assertEqual(ids, ["new", "old"])   # 'maybe' waits for full metadata


class TestValidation(unittest.TestCase):
    META = {"title": "GBL set", "channel": "Ch", "license": "Standard YouTube License", "uploadDate": "20261001", "durationS": 600}

    def test_no_battles_asks_about_footage(self):
        qs = V.harvest_questions("v1", {"battles": []}, self.META, {}, None)
        self.assertEqual([q["kind"] for q in qs], ["footage"])
        self.assertEqual(qs[0]["clip"], [150.0, 170.0])

    def test_league_question_once_per_video(self):
        opts = [{"id": "great", "name": "Great League", "cp": 1500, "score": 3.0},
                {"id": "spooky", "name": "Spooky Cup", "cp": 1500, "score": 2.5}]
        refined = {"battles": [{"best": "great", "options": opts, "cps": [1498]}, {"best": "great", "options": opts, "cps": [1500]}]}
        battles = [{"start": 10}, {"start": 200}]
        qs = V.harvest_questions("v1", {"battles": battles}, self.META, {"leagueConfidence": 0.5}, refined)
        self.assertEqual(len(qs), 1)
        self.assertEqual(qs[0]["options"][-1]["value"], "other")
        self.assertTrue(qs[0]["allBattles"])
        # Confident video-level guess: nothing to ask.
        self.assertEqual(V.harvest_questions("v1", {"battles": battles}, self.META, {"leagueConfidence": 0.95}, refined), [])
        # Compilation: each ambiguous battle is asked.
        qs = V.harvest_questions("v1", {"battles": battles}, self.META, {"kindGuess": "compilation"}, refined)
        self.assertEqual([q["battle"] for q in qs], [0, 1])

    def test_decorate_and_inbox(self):
        with tempfile.TemporaryDirectory() as d:
            vdir = os.path.join(d, "q", "v1")
            os.makedirs(vdir)
            doc = V.decorate({"qid": "a", "kind": "result", "frames": ["data:x"]}, V.video_ref("v1", self.META))
            self.assertEqual((doc["source"], doc["frames"], doc["video"]["id"], doc["recording"]), ("youtube-harvest", [], "v1", "v1.mp4"))
            with open(os.path.join(vdir, "a.json"), "w") as f:
                json.dump(doc, f)
            n = V.write_inbox(os.path.join(d, "q"), os.path.join(d, "out", "inbox.json"))
            self.assertEqual(n, 1)
            with open(os.path.join(d, "out", "inbox.json")) as f:
                self.assertEqual(json.load(f)["questions"][0]["qid"], "a")


class TestProbePlan(unittest.TestCase):
    PROBE = {"box": [700, 0, 1220, 1080], "ranges": [{"start": 10.0, "end": 400.0, "hits": 40}, {"start": 900.0, "end": 1300.0, "hits": 30}],
             "coverage": 0.3, "keyInterval": 6, "screens": [{"box": [700, 0, 1220, 1080], "score": 9}], "samples": 300, "hits": 70}

    def test_plan(self):
        self.assertEqual(H.probe_plan(None), {})                       # probe failed: whole video
        self.assertIsNone(H.probe_plan({**self.PROBE, "ranges": []}))  # no HUD: skip the full pass
        self.assertIsNone(H.probe_plan({"box": None, "ranges": []}))
        self.assertEqual(H.probe_plan(self.PROBE), {"CROP": "700,0,1220,1080", "RANGES": "10.0-400.0,900.0-1300.0"})
        self.assertEqual(H.probe_plan({**self.PROBE, "coverage": 0.85}), {"CROP": "700,0,1220,1080"})
        # Keyframes too sparse to trust the scan: analyse everything.
        self.assertEqual(H.probe_plan({**self.PROBE, "keyInterval": 20, "ranges": []}), {"CROP": "700,0,1220,1080"})

    def test_perspective_crop_and_summary(self):
        two = {"screens": [{"box": [980, 0, 1480, 1080]}, {"box": [440, 0, 940, 1080]}]}
        self.assertEqual(H.perspective_crop(two, "left"), "440,0,940,1080")
        self.assertEqual(H.perspective_crop(two, "right"), "980,0,1480,1080")
        self.assertIsNone(H.perspective_crop(two, "switches"))
        self.assertIsNone(H.perspective_crop(self.PROBE, "left"))
        self.assertNotIn("hitTimes", H.probe_summary({**self.PROBE, "hitTimes": [1, 2]}))

    def test_default_workers(self):
        self.assertEqual(H.default_extract_jobs(12), 8)
        self.assertEqual(H.default_extract_jobs(1), 1)


class TestRelevanceFeedbackRules(unittest.TestCase):
    """Real titles from reviewer footage answers (2026-10-11) and battle videos the extractor analysed."""
    NO = ["Aris vs AEK Athens 88-58 HIGHLIGHTS | GBL Round 2 26/27",
          "Mykonos - PAOK | Full Highlights | GBL Round 1 | 03.10.2026",
          "ΑΕΚ  -  ΜΑΡΟΥΣΙ  91-70 | HIGHLIGHTS | STOIXIMAN GBL",
          "GIGANTAMAX KANTO STARTERS ARE HERE! GMAX CHARIZARD, BLASTOISE & VENUSAUR | Pokémon GO",
          "NEW GIGANTAMAX BATTLES IN POKEMON GO! NEED Shiny GMAX Venusaur",
          "Mega Mewtwo Community Day, Because Everything is Zorua! - Pokemon GO",
          "50 PRO POKÉMON GO TIPS From a Day One Player!!",
          "NEVER TRANSFER A HUNDO BY MISTAKE AGAIN! Pokemon GO",
          "This TALONFLAME PSYSPAM Team Did Great At A Regional...| Pokemon Champions",
          "THIS IS CRAZY! My Luckiest Max Monday Ever! - Pokemon GO",
          "Pokémon GO Has A LOT Going On This Week | GO Forecast",
          "DON'T USE YOUR RADAR ON ZEKROM | Pokemon GO"]
    KEEP = ["I battled over 100 Rocket Grunts in a day and had some amazing luck (Pokemon GO)",
            "GBL day 50 battles & TCGP / Long stream",
            "SHINY SHADOW ZEKROM DESTROYS THE COLOR CUP!! - Pokémon GO Battle League",
            "PLAY POKEMON CHAMPIONSHIP TEAM | Great League Teams | Pokemon GO Battle League",
            "I battled 13 PLAY POKEMON CHAMPIONS in the GO BATTLE LEAGUE",
            "BLAST FROM THE PAST! Lanturn just WON the Recife Regional Championship | Pokémon GO",
            "UNDEFEATED TEAM IN GREAT LEAGUE POKEMON GO BATTLE LEAGUE 2026"]

    def test_vetoes(self):
        for t in self.NO:
            self.assertEqual(P.relevance(t, 600)[1], "no", t)

    def test_battle_titles_survive(self):
        for t in self.KEEP:
            self.assertNotEqual(P.relevance(t, 900, channel_battle_hits=1)[1], "no", t)


class TestDiskPolicy(unittest.TestCase):
    def harvester(self, d, keep=False):
        from types import SimpleNamespace
        import threading
        h = H.Harvester.__new__(H.Harvester)
        dl = os.path.join(d, "dl")
        os.makedirs(dl)
        h.a = SimpleNamespace(work_dir=d, download_dir=dl, keep=keep, extract_jobs=2, max_backlog_hours=2.0, no_extract=False)
        h.state = H.State(os.path.join(d, "s.sqlite"))
        h.clock = threading.Lock()
        h.c = {"cleaned": 0, "xVideoS": 0.0, "xBusyS": 0.0}
        return h, dl

    def touch(self, *parts):
        with open(os.path.join(*parts), "w") as f:
            f.write("x")

    def test_startup_cleanup_only_removes_stale_harvest_files(self):
        with tempfile.TemporaryDirectory() as d:
            h, dl = self.harvester(d)
            st = h.state
            st.x("INSERT INTO videos(id,dl_status,dl_path) VALUES('pendingAAAA','done',?)", (os.path.join(dl, "pendingAAAA.mp4"),))
            st.x("INSERT INTO videos(id,dl_status,dl_path,x_status) VALUES('doneBBBBBBB','done',?,'done')", (os.path.join(dl, "doneBBBBBBB.mp4"),))
            st.x("INSERT INTO videos(id,dl_status) VALUES('dupCCCCCCCC','dup')")
            for name in ("pendingAAAA.mp4", "pendingAAAA.mp4.part", "doneBBBBBBB.mp4", "dupCCCCCCCC.mp4", "unknownDDDD.mp4",
                         "notes.txt", "my holiday.mp4"):
                self.touch(dl, name)
            os.makedirs(os.path.join(dl, "sub"))
            self.touch(dl, "sub", "eeeeeeeeeee.mp4")
            outside = os.path.join(d, "fffffffffff.mp4")
            self.touch(outside)
            os.symlink(outside, os.path.join(dl, "fffffffffff.mp4"))
            self.assertEqual(h.cleanup_download_dir(), 4)
            self.assertEqual(sorted(os.listdir(dl)), ["fffffffffff.mp4", "my holiday.mp4", "notes.txt", "pendingAAAA.mp4", "sub"])
            self.assertTrue(os.path.exists(outside) and os.path.exists(os.path.join(dl, "sub", "eeeeeeeeeee.mp4")))
            self.assertIsNotNone(st.q("SELECT deleted_date FROM videos WHERE id='doneBBBBBBB'")[0][0])
            st.db.close()

    def test_keep_flag_keeps_processed_files(self):
        with tempfile.TemporaryDirectory() as d:
            h, dl = self.harvester(d, keep=True)
            h.state.x("INSERT INTO videos(id,dl_status,dl_path,x_status) VALUES('doneBBBBBBB','done',?,'done')", (os.path.join(dl, "doneBBBBBBB.mp4"),))
            self.touch(dl, "doneBBBBBBB.mp4")
            self.assertEqual(h.cleanup_download_dir(), 0)
            h.state.db.close()

    def test_remove_video_files_takes_partials_too(self):
        with tempfile.TemporaryDirectory() as d:
            h, dl = self.harvester(d)
            for name in ("abcdefghijk.mp4", "abcdefghijk.mp4.part", "abcdefghijk.f137.mp4", "abcdefghijX.mp4"):
                self.touch(dl, name)
            self.assertEqual(h.remove_video_files("abcdefghijk", "test"), 3)
            self.assertEqual(os.listdir(dl), ["abcdefghijX.mp4"])
            h.state.db.close()

    def test_backlog_cap_pauses_downloads(self):
        with tempfile.TemporaryDirectory() as d:
            h, dl = self.harvester(d)
            self.assertTrue(h.backlog_ok(3600))                       # empty queue: always allowed
            # 2 workers at 2.5x: 30 h of queued video = 6 h of work > 2 h cap.
            h.state.x("INSERT INTO videos(id,dl_status,duration) VALUES('a','done',108000)")
            self.assertFalse(h.backlog_ok(600))
            h.state.x("UPDATE videos SET duration=1800")              # 0.1 h of work
            self.assertTrue(h.backlog_ok(600))
            h.a.max_backlog_hours = 0
            h.state.x("UPDATE videos SET duration=1e9")
            self.assertTrue(h.backlog_ok(600))                        # 0 = disk budget only
            h.state.db.close()

    def test_registry_keeps_duplicate_fingerprints(self):
        row = {"id": "dupdupdupdu", "meta": "{}", "league": "{}", "dl_status": "dup", "sha256": "abc123",
               "err": "same file as origorigori", "title": "T", "channel": "C", "duration": 600}
        e = H.registry_entry(row)
        self.assertEqual((e["sha256"], e["duplicateOf"], e["title"], e["channel"]), ("abc123", "origorigori", "T", "C"))

    def test_known_fingerprint_is_never_downloaded_again(self):
        with tempfile.TemporaryDirectory() as d:
            h, dl = self.harvester(d)
            h.registry = {"seenseenAAA": {"id": "seenseenAAA", "status": "deleted", "sha256": "f00"}}
            h.state.x("INSERT INTO videos(id,title,channel_id,duration) VALUES('seenseenAAA','t','c',600)")
            h.download_one({"id": "seenseenAAA", "meta": "{}", "meta_status": "done", "title": "t", "channel_id": "c", "duration": 600})
            self.assertEqual(h.state.q("SELECT dl_status, sha256 FROM videos")[0][:], ("prior", "f00"))
            h.state.db.close()


class TestBattleTypes(unittest.TestCase):
    GM = {"deino": {"speciesId": "deino", "baseStats": {"atk": 116, "def": 93, "hp": 141}},
          "sharpedo": {"speciesId": "sharpedo", "baseStats": {"atk": 243, "def": 83, "hp": 172}},
          "greninja": {"speciesId": "greninja", "baseStats": {"atk": 223, "def": 152, "hp": 176}},
          "azumarill": {"speciesId": "azumarill", "baseStats": {"atk": 112, "def": 152, "hp": 225}},
          "medicham": {"speciesId": "medicham", "baseStats": {"atk": 121, "def": 152, "hp": 155}}}

    def test_max_cp(self):
        self.assertEqual(L.max_player_cp(self.GM["deino"]), 1214)   # 15/15/15 at level 51

    def test_rocket_flags(self):
        mon = lambda s, cp: {"species": s, "cp": cp}  # noqa: E731
        grunt = L.rocket_evidence([mon("medicham", 1497)], [mon("deino", 3663), mon("sharpedo", 7554), mon("greninja", 9163)], self.GM)
        self.assertTrue(grunt["flag"])
        self.assertTrue(L.rocket_evidence([], [mon("deino", 3663)], self.GM)["flag"])            # one, far above
        gbl = L.rocket_evidence([mon("medicham", 1497)], [mon("azumarill", 1500), mon("deino", 1090)], self.GM)
        self.assertFalse(gbl["flag"])
        # 'CP 1480' read as '148' on the creator side must not look like Little Cup vs 1500 CP.
        self.assertFalse(L.rocket_evidence([mon("medicham", 148)], [mon("azumarill", 1497), mon("medicham", 1499)], self.GM)["flag"])
        # An extra OCR digit (x10) is a misread, not a Rocket Pokémon.
        self.assertFalse(L.rocket_evidence([], [mon("deino", 10960)], self.GM)["flag"])
        # Two opponents above the cap the creator's team sits at.
        self.assertTrue(L.rocket_evidence([mon("medicham", 1490), mon("azumarill", 1460)], [mon("x", 2900), mon("y", 2100)], self.GM)["flag"])

    def test_refine_reports_rocket(self):
        obs = {"cps": [1497, 3663], "species": ["medicham", "deino"],
               "teams": {"my": [{"species": "medicham", "cp": 1497}], "opponent": [{"species": "deino", "cp": 3663}]}}
        r = L.refine_battle_league(obs, ["great", "master"], SCHED, self.GM)
        self.assertTrue(r["rocket"]["flag"])

    def test_championship_evidence(self):
        strong = L.guess_league({"title": "BLAST FROM THE PAST! Lanturn just WON the Recife Regional Championship"}, SCHED)
        self.assertTrue(strong["championship"])
        self.assertEqual(strong["kindGuess"], "tournament")
        weak = L.guess_league({"title": "PLAY POKEMON CHAMPIONSHIP TEAM | Great League"}, SCHED)
        self.assertNotIn("championship", weak)
        self.assertTrue(weak["possibleChampionship"])
        self.assertTrue(L.guess_league({"title": "Day 2 top cut", "channel": "Play Pokémon"}, SCHED)["championship"])
        self.assertNotIn("possibleChampionship", L.guess_league({"title": "Great League set"}, SCHED))
        self.assertEqual(L.get_format("championship", {})[1]["name"], "Championship")
        self.assertEqual(L.get_format("championship@2500", {})[1]["cp"], 2500)

    def test_write_league_refinement_types(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "v.json")
            b = lambda my, opp: {"start": 1, "myDetail": [{"form": {"id": s}, "cp": c} for s, c in my],  # noqa: E731
                                 "opponentDetail": [{"form": {"id": s}, "cp": c} for s, c in opp]}
            with open(p, "w") as f:
                json.dump({"battles": [b([("medicham", 1497)], [("azumarill", 1499)]),
                                       b([("medicham", 1497)], [("deino", 3663), ("sharpedo", 7554)])],
                           "probe": {"screens": [{"box": [0, 0, 1, 1]}, {"box": [2, 0, 3, 1]}]}}, f)
            orig = L.load_gamemaster
            L.load_gamemaster = lambda *a: {**GM, **self.GM}
            try:
                doc = H.write_league_refinement(p, {"leagueId": "great", "cupCandidates": []}, SCHED, "20250103")
                self.assertEqual([x.get("battleType") for x in doc["battles"]], [None, "rocket"])
                self.assertTrue(doc["video"]["possibleChampionship"])   # two phone screens
                self.assertFalse(doc["video"]["championship"])
                doc = H.write_league_refinement(p, {"leagueId": "great", "championship": True}, SCHED, "20250103")
                self.assertEqual(doc["battles"][0]["best"], "championship")
                self.assertEqual(doc["battles"][0]["battleType"], "championship")
            finally:
                L.load_gamemaster = orig


class TestNewQuestions(unittest.TestCase):
    META = TestValidation.META

    def test_probe_detail_in_footage_question(self):
        q = V.harvest_questions("v1", {"battles": [], "probe": {"samples": 120, "hits": 0, "box": None}}, self.META, {}, None)[0]
        self.assertIn("120 keyframes found no battle HUD", q["detail"])
        self.assertIn("not located", q["detail"])
        q = V.harvest_questions("v1", {"battles": [], "probe": {"samples": 120, "hits": 9, "box": [0, 0, 1, 1],
                                                              "ranges": [{"start": 300, "end": 500}]}}, self.META, {}, None)[0]
        self.assertEqual(q["clip"][0], 300.0)
        self.assertIn("full analysis found no complete battle", q["detail"])

    def test_rocket_perspective_and_lead(self):
        opts = [{"id": "master", "name": "Master League", "cp": 10000, "score": 1.0}]
        battles = [{"start": 10, "opponent": ["Deino", "Sharpedo", "Greninja"], "flags": []},
                   {"start": 90, "opponent": ["Azumarill", "Medicham", "Lugia"], "flags": []}]
        refined = {"video": {}, "battles": [{"best": "master", "options": opts, "rocket": True, "rocketReasons": ["deino CP 3663 > player max 1096"]},
                                            {"best": "master", "options": opts, "rocket": False}]}
        qs = V.harvest_questions("v1", {"battles": battles}, self.META, {"leagueConfidence": 0.95}, refined)
        rocket = [q for q in qs if q["qid"].endswith("0:rocket")]
        self.assertEqual(rocket[0]["options"][0]["value"], "rocket")
        self.assertEqual(rocket[0]["modelTop"], "rocket")
        lead = [q for q in qs if q["kind"] == "lead"]
        self.assertEqual([q["battle"] for q in lead], [1])            # the Rocket battle is not asked
        self.assertEqual(lead[0]["modelTop"], "Azumarill")
        # Every battle flagged: one video-level Rocket question.
        refined["battles"][1]["rocket"] = True
        qs = V.harvest_questions("v1", {"battles": battles}, self.META, {"leagueConfidence": 0.95}, refined)
        self.assertEqual([q["allBattles"] for q in qs if q["kind"] == "league"], [True])
        # Championship: perspective question, no GBL league question.
        refined = {"video": {"championship": True, "screens": 2, "championshipEvidence": ["title: regional championship"]},
                   "battles": [{"best": "championship", "options": opts}, {"best": "championship", "options": opts}]}
        qs = V.harvest_questions("v1", {"battles": battles}, self.META, {"leagueConfidence": 0.2}, refined)
        kinds = [q["kind"] for q in qs]
        self.assertIn("perspective", kinds)
        self.assertNotIn("league", kinds)
        p = next(q for q in qs if q["kind"] == "perspective")
        self.assertEqual([o["value"] for o in p["options"]], ["left", "right", "single", "switches", "gbl"])
        # League options always offer Team Rocket.
        self.assertIn("rocket", [o["value"] for o in V._league_options(opts)])



class RetentionAndProbeCache(unittest.TestCase):
    def test_retention_defaults_and_explicit_discard(self):
        self.assertTrue(H.parse([]).keep)
        self.assertTrue(H.parse(['--keep']).keep)
        self.assertFalse(H.parse(['--discard-videos']).keep)
        self.assertEqual(H.download_format(1080), H.FORMAT)
        self.assertIn('height<=720', H.download_format(720))
        with self.assertRaises(ValueError):
            H.download_format(480)

    def test_keep_retains_completed_sources_even_after_legacy_deleted_marker(self):
        # Construct only the fields startup cleanup needs; this does not start workers.
        from types import SimpleNamespace
        import threading
        with tempfile.TemporaryDirectory() as d:
            h = H.Harvester.__new__(H.Harvester)
            h.a = SimpleNamespace(download_dir=d, keep=True)
            h.state = H.State(os.path.join(d, 'state.sqlite'))
            h.clock = threading.Lock(); h.c = {'cleaned': 0}
            for name in ('abcdefghijk.mp4', 'lmnopqrstuv.mp4', 'abcdefghijk.mp4.part'):
                with open(os.path.join(d, name), 'w') as stream: stream.write('source')
            h.state.x("INSERT INTO videos(id,dl_status,dl_path,x_status,deleted_date) VALUES('abcdefghijk','done',?,'done','2026-10-10')", (os.path.join(d,'abcdefghijk.mp4'),))
            self.assertEqual(h.cleanup_download_dir(), 1)
            self.assertTrue(os.path.exists(os.path.join(d,'abcdefghijk.mp4')))
            self.assertTrue(os.path.exists(os.path.join(d,'lmnopqrstuv.mp4')))
            h.state.db.close()

    def test_completed_extraction_retains_media_and_exports_validation(self):
        from types import SimpleNamespace
        from unittest.mock import patch, Mock
        import threading
        with tempfile.TemporaryDirectory() as d:
            h = H.Harvester.__new__(H.Harvester)
            h.a = SimpleNamespace(work_dir=d, download_dir=d, keep=True, ffmpeg_threads=1)
            h.state = H.State(os.path.join(d,'state.sqlite'));h.schedule = SCHED
            h.clock = threading.Lock();h.validation_lock=threading.Lock();h.c={'extracted':0,'extractFailed':0,'xVideoS':0,'xBusyS':0}
            h._reviewed_league=lambda vid,lg:lg;h.export_validation=Mock(return_value=2)
            source=os.path.join(d,'abcdefghijk.mp4')
            with open(source,'w') as stream:stream.write('source')
            h.state.x("INSERT INTO videos(id,dl_status,dl_path,sha256,league,meta) VALUES('abcdefghijk','done',?,'abc123',?,?)",(source,json.dumps({'leagueId':'great'}),'{}'))
            # Match the fields claimed by the actual worker, including its source fingerprint.
            row=h.state.q("SELECT id,dl_path,sha256,upload_date,league,duration,meta FROM videos WHERE id='abcdefghijk'")[0]
            H.atomic_json(os.path.join(d,'results','abcdefghijk.json'),{'battles':[],'full':[]})
            with patch.object(H,'gamemaster_for',return_value=''),patch.object(H,'write_league_refinement',return_value=None):
                h.extract_one(row)
            h.export_validation.assert_called_once();self.assertTrue(os.path.isfile(source))
            doc=H.read_json(os.path.join(d,'results','abcdefghijk.json'));self.assertEqual(doc['media']['sha256'],'abc123');self.assertTrue(doc['media']['retained'])
            self.assertEqual(h.state.q("SELECT x_status FROM videos WHERE id='abcdefghijk'")[0][0],'done');h.state.db.close()

    def test_matching_probe_cache_avoids_subprocess(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import threading
        with tempfile.TemporaryDirectory() as d:
            h = H.Harvester.__new__(H.Harvester);h.a = SimpleNamespace(work_dir=d)
            h.clock = threading.Lock();h.c = {'probed': 0}
            source = os.path.join(d,'abcdefghijk.mp4')
            with open(source,'w') as stream: stream.write('source')
            probe = {'box':[0,0,560,1080], 'ranges':[], 'duration':30}
            key = H.PC.identity(source,H.WEB)
            H.atomic_json(os.path.join(d,'probe','abcdefghijk.json.cache.json'), H.PC.document(key,probe))
            with patch.object(H.subprocess,'run') as run:
                self.assertEqual(h.run_probe('abcdefghijk',source,30),probe)
                run.assert_not_called()

if __name__ == "__main__":
    unittest.main(verbosity=1)
