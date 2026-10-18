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
    "meditite": {"speciesId": "meditite", "dex": 307, "types": ["fighting", "psychic"], "tags": [], "family": {"evolutions": ["medicham"]}},
    "azumarill": {"speciesId": "azumarill", "dex": 184, "types": ["water", "fairy"], "tags": [], "family": {"parent": "marill"}},
    "marill": {"speciesId": "marill", "dex": 183, "types": ["water", "fairy"], "tags": [], "family": {"parent": "azurill", "evolutions": ["azumarill"]}},
    "azurill": {"speciesId": "azurill", "dex": 298, "types": ["normal", "fairy"], "tags": [], "family": {"evolutions": ["marill"]}},
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

    def test_no_league_or_cup_questions(self):
        # A reviewer cannot verify a cup: uncaptured or low-confidence cups never become questions, compilation or not.
        refined = {"battles": [{"best": "great", "cupStatus": "uncaptured", "cps": [1498]}, {"best": "great", "cupStatus": "uncaptured"}]}
        battles = [{"start": 10}, {"start": 200}]
        for guess in ({"leagueConfidence": 0.2}, {"kindGuess": "compilation"}):
            self.assertEqual(V.harvest_questions("v1", {"battles": battles}, self.META, guess, refined), [])

    def test_withdraw_open_league_questions(self):
        with tempfile.TemporaryDirectory() as d:
            q = lambda qid, kind="league": {"qid": f"youtube-harvest:v1.mp4:{qid}", "kind": kind}  # noqa: E731
            docs = [q("league"), q("1:league"), q("0:rocket"), q("0:lead", "lead"), q("answered:league")]
            os.makedirs(os.path.join(d, "validation", "v1"))
            for doc in docs:
                with open(os.path.join(d, "validation", "v1", doc["qid"] + ".json"), "w") as f:
                    json.dump(doc, f)
            with open(os.path.join(d, "feedback.json"), "w") as f:
                json.dump({"answers": {docs[4]["qid"]: {"value": "mega@1500"}}}, f)
            inbox = os.path.join(d, "inbox.json")
            with open(inbox, "w") as f:
                json.dump({"format": "meta-validation-inbox", "questions": docs + [{"qid": "extractor:x", "kind": "shadow"}]}, f)
            fb_before = open(os.path.join(d, "feedback.json")).read()
            self.assertEqual(V.withdraw_league_questions(d, inbox, os.path.join(d, "bak"), dry_run=True)["withdrawn"], 2)
            s = V.withdraw_league_questions(d, inbox, os.path.join(d, "bak"))
            self.assertEqual((s["withdrawn"], s["keptAnswered"], s["inboxRemoved"]), (2, 1, 2))
            left = sorted(os.listdir(os.path.join(d, "validation", "v1")))
            self.assertEqual(len(left), 3)                    # Rocket, lead and the answered league question stay
            self.assertEqual(sorted(x["qid"] for x in json.load(open(inbox))["questions"]),
                             sorted([docs[2]["qid"], docs[3]["qid"], docs[4]["qid"], "extractor:x"]))
            manifest = json.load(open(os.path.join(d, "bak", "withdrawn.json")))
            self.assertEqual({r["source"] for r in manifest["questions"]}, {"policy"})
            self.assertEqual(manifest["reason"], V.WITHDRAWN_REASON)
            self.assertTrue(os.path.exists(os.path.join(d, "bak", "v1", docs[0]["qid"] + ".json")))   # moved, reversible
            self.assertEqual(open(os.path.join(d, "feedback.json")).read(), fb_before)            # never written

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

    def test_plan_with_placements(self):
        # The phone placed differently per clip (probe.cjs placements): every plan that decodes carries CROPS.
        placements = [{"box": [700, 0, 1220, 1080], "hits": 40, "stretches": [{"start": 0, "end": 650.5}, {"start": 1100.0, "end": 1400.0}]},
                      {"box": [712, 0, 1232, 1080], "hits": 30, "stretches": [{"start": 650.5, "end": 1100.0}]}]
        crops = "700,0,1220,1080@0-650.5,1100.0-1400.0;712,0,1232,1080@650.5-1100.0"
        probe = {**self.PROBE, "placements": placements}
        self.assertEqual(H.probe_plan(probe), {"CROP": "700,0,1220,1080", "RANGES": "10.0-400.0,900.0-1300.0", "CROPS": crops})
        self.assertEqual(H.probe_plan({**probe, "coverage": 0.85}), {"CROP": "700,0,1220,1080", "CROPS": crops})
        self.assertEqual(H.probe_plan({**probe, "keyInterval": 20}), {"CROP": "700,0,1220,1080", "CROPS": crops})
        self.assertIsNone(H.probe_plan({**probe, "ranges": []}))
        # One placement is no placement; the summary keeps them.
        self.assertEqual(H.probe_plan({**self.PROBE, "placements": placements[:1]}), H.probe_plan(self.PROBE))
        self.assertEqual(H.probe_summary(probe)["placements"], placements)
        self.assertNotIn("placements", H.probe_summary(self.PROBE))

    def test_perspective_crop_and_summary(self):
        two = {"screens": [{"box": [980, 0, 1480, 1080]}, {"box": [440, 0, 940, 1080]}]}
        self.assertEqual(H.perspective_crop(two, "left"), "440,0,940,1080")
        self.assertEqual(H.perspective_crop(two, "right"), "980,0,1480,1080")
        self.assertIsNone(H.perspective_crop(two, "switches"))
        self.assertIsNone(H.perspective_crop(two, "single"))
        self.assertIsNone(H.perspective_crop(two, "gbl"))
        self.assertIsNone(H.perspective_crop(self.PROBE, "left"))
        # No answer: the LEFT screen is the creator's; one screen or overlapping boxes change nothing.
        self.assertEqual(H.perspective_crop(two, None), "440,0,940,1080")
        self.assertIsNone(H.perspective_crop(self.PROBE, None))
        self.assertIsNone(H.perspective_crop({"screens": [{"box": [0, 0, 500, 1080]}, {"box": [100, 0, 600, 1080]}]}, None))
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
                # Weak championship words plus two distinguishable screens: the format is championship without a question.
                doc = H.write_league_refinement(p, {"leagueId": "great", "possibleChampionship": True}, SCHED, "20250103")
                self.assertTrue(doc["video"]["championship"])
                doc = H.write_league_refinement(p, {"leagueId": "great", "championship": True}, SCHED, "20250103")
                self.assertEqual(doc["battles"][0]["best"], "championship")
                self.assertEqual(doc["battles"][0]["battleType"], "championship")
                # The post-analysis hook writes exactly league.refine_video's document (refine-all's sidecar).
                with open(p) as f:
                    res = json.load(f)
                vl = {"leagueId": "great", "cupCandidates": []}
                doc = H.write_league_refinement(p, vl, SCHED, "20250103")
                self.assertEqual(doc, L.refine_video(res, vl, SCHED, L.load_gamemaster(), "20250103"))
                with open(p.replace(".json", ".leagues.json")) as f:
                    self.assertEqual(json.load(f), doc)
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
        self.assertEqual([o["value"] for o in rocket[0]["options"]], ["rocket", "gbl"])   # no cup options
        self.assertEqual(rocket[0]["modelTop"], "rocket")
        lead = [q for q in qs if q["kind"] == "lead"]
        self.assertEqual([q["battle"] for q in lead], [1])            # the Rocket battle is not asked
        self.assertEqual(lead[0]["modelTop"], "azumarill")             # the member key; the label is the identity
        # Every battle flagged: one video-level Rocket question.
        refined["battles"][1]["rocket"] = True
        qs = V.harvest_questions("v1", {"battles": battles}, self.META, {"leagueConfidence": 0.95}, refined)
        self.assertEqual([q["allBattles"] for q in qs if q["kind"] == "league"], [True])
        # Championship: perspective question, no GBL league question.
        two = [{"box": [100, 0, 600, 1080]}, {"box": [700, 0, 1200, 1080]}]
        one = [{"box": [100, 0, 600, 1080]}]
        refined = {"video": {"championship": True, "screens": 2, "championshipEvidence": ["title: regional championship"]},
                   "battles": [{"best": "championship", "options": opts}, {"best": "championship", "options": opts}]}
        guess = {"leagueConfidence": 0.2}
        # Two distinguishable screens: no question, the left screen is the creator's.
        qs = V.harvest_questions("v1", {"battles": battles, "probe": {"screens": two}}, self.META, guess, refined)
        self.assertEqual([q["kind"] for q in qs if q["kind"] in ("perspective", "league")], [])
        # Two screens reported but the probe could not tell them apart: ask.
        blurred = [{"box": [100, 0, 600, 1080]}, {"box": [150, 0, 650, 1080]}]
        qs = V.harvest_questions("v1", {"battles": battles, "probe": {"screens": blurred}}, self.META, guess, refined)
        kinds = [q["kind"] for q in qs]
        self.assertIn("perspective", kinds)
        self.assertNotIn("league", kinds)
        p = next(q for q in qs if q["kind"] == "perspective")
        self.assertEqual([o["value"] for o in p["options"]], ["left", "right", "single", "switches", "gbl"])
        # Strong evidence and one screen: nothing to choose. Weak evidence and one screen: ask.
        strong1 = {**refined, "video": {**refined["video"], "screens": 1}}
        qs = V.harvest_questions("v1", {"battles": battles, "probe": {"screens": one}}, self.META, guess, strong1)
        self.assertNotIn("perspective", [q["kind"] for q in qs])
        weak = {"video": {"possibleChampionship": True, "screens": 1, "championshipEvidence": ["title (weak): regional"]},
                "battles": [{"best": "master", "options": opts}, {"best": "master", "options": opts}]}
        qs = V.harvest_questions("v1", {"battles": battles, "probe": {"screens": one}}, self.META, {"leagueConfidence": 0.95}, weak)
        self.assertEqual(next(q for q in qs if q["kind"] == "perspective")["modelTop"], "single")
        # Weak evidence but two distinguishable screens: no question.
        qs = V.harvest_questions("v1", {"battles": battles, "probe": {"screens": two}}, self.META, {"leagueConfidence": 0.95}, weak)
        self.assertNotIn("perspective", [q["kind"] for q in qs])

    def test_withdraw_perspective_questions(self):
        with tempfile.TemporaryDirectory() as d:
            two = [{"box": [100, 0, 600, 1080]}, {"box": [700, 0, 1200, 1080]}]

            def put(vid, screens, crop, rv):
                os.makedirs(os.path.join(d, "validation", vid), exist_ok=True)
                os.makedirs(os.path.join(d, "results"), exist_ok=True)
                qid = f"youtube-harvest:{vid}.mp4:perspective"
                json.dump({"qid": qid, "kind": "perspective"}, open(os.path.join(d, "validation", vid, qid + ".json"), "w"))
                json.dump({"crop": crop, "probe": {"screens": screens}}, open(os.path.join(d, "results", vid + ".json"), "w"))
                json.dump({"video": rv}, open(os.path.join(d, "results", vid + ".leagues.json"), "w"))
                return qid
            put("right", two, [700, 0, 1200, 1080], {"championship": True})             # analysed on the right: requeue
            put("left", two, [100, 0, 600, 1080], {"possibleChampionship": True})        # already left
            put("strong1", two[:1], [100, 0, 600, 1080], {"championship": True})         # one screen, strong
            put("weak1", two[:1], [100, 0, 600, 1080], {"possibleChampionship": True})   # kept: genuinely ambiguous
            done = put("done", two, [700, 0, 1200, 1080], {"championship": True})
            json.dump({"answers": {done: {"value": "right"}}}, open(os.path.join(d, "feedback.json"), "w"))
            dry = V.withdraw_perspective_questions(d, dry_run=True)
            self.assertEqual((dry["withdrawn"], dry["dryRun"]), (3, True))
            self.assertTrue(os.path.exists(os.path.join(d, "validation", "right")))
            out = V.withdraw_perspective_questions(d)
            self.assertEqual(sorted(out["videoIds"]), ["left", "right", "strong1"])
            self.assertEqual(out["reanalyse"], ["right"])
            left_open = sorted(v for v in os.listdir(os.path.join(d, "validation")) if os.listdir(os.path.join(d, "validation", v)))
            self.assertEqual(left_open, ["done", "weak1"])

    def test_withdraw_form_questions_for_lookalike_sizes_and_battle_states(self):
        with tempfile.TemporaryDirectory() as d:
            def put(vid, options, n=0):
                os.makedirs(os.path.join(d, "validation", vid), exist_ok=True)
                qid = f"youtube-harvest:{vid}.mp4:{n}:opponent:x:form"
                json.dump({"qid": qid, "kind": "form", "options": [{"value": o} for o in options]},
                          open(os.path.join(d, "validation", vid, f"q{n}.json"), "w"))
                return qid
            put("pump", ["pumpkaboo_average", "pumpkaboo_large", "pumpkaboo_small", "pumpkaboo_super"])
            put("gour", ["gourgeist_small_shadow", "gourgeist_super"])
            put("cram", ["cramorant", "cramorant_gulping", "cramorant_gorging"])
            put("kyurem", ["kyurem", "kyurem_black", "kyurem_white"])              # real forms: kept
            put("mixed", ["pumpkaboo_small", "gourgeist_small"])                  # two families: kept
            done = put("pump", ["pumpkaboo_small", "pumpkaboo_large"], 1)
            json.dump({"answers": {done: {"value": "pumpkaboo_large"}}}, open(os.path.join(d, "feedback.json"), "w"))
            self.assertEqual(V.withdraw_form_questions(d, dry_run=True)["withdrawn"], 3)
            out = V.withdraw_form_questions(d)
            self.assertEqual((out["withdrawn"], out["keptAnswered"]), (3, 1))
            left = sorted(f"{v}/{f}" for v in os.listdir(os.path.join(d, "validation")) for f in os.listdir(os.path.join(d, "validation", v)))
            self.assertEqual(left, ["kyurem/q0.json", "mixed/q0.json", "pump/q1.json"])

    def test_lead_labels_show_the_full_identity_and_keep_member_keys(self):
        names = {"ninetales_alolan": "Ninetales (Alolan)", "lugia": "Lugia", "azumarill": "Azumarill"}
        self.assertEqual(V.lead_label("Ninetales", {"form": {"id": "ninetales_alolan", "p": 1}, "shadowP": .99}, names),
                         "Shadow Ninetales (Alolan)")
        self.assertEqual(V.lead_label("Ninetales", {"form": {"id": "ninetales_alolan_shadow", "p": 1}}, names), "Shadow Ninetales (Alolan)")
        self.assertEqual(V.lead_label("Ninetales", {"form": {"id": "ninetales_alolan", "p": 1}, "shadowP": .5}, names), "Ninetales (Alolan)")
        self.assertEqual(V.lead_label("Ninetales", {"form": {"id": "ninetales_alolan", "p": .7}}, names), "Ninetales")   # unsure form
        self.assertEqual(V.lead_label("Ho-Oh", {}, names), "Ho-Oh")
        battles = [{"start": 5, "opponent": ["Ninetales", "Lugia", "Ho-Oh"], "flags": [],
                    "opponentDetail": [{"name": "Ninetales", "form": {"id": "ninetales_alolan", "p": 1}, "shadowP": 1},
                                       {"name": "Lugia", "form": {"id": "lugia", "p": 1}, "shadowP": 0}, {"name": "Ho-Oh"}]}]
        full = [{"opponent": [{"label": "Ninetales", "key": "ninetales"}, {"label": "Lugia", "key": "lugia"}, {"label": "Ho-Oh", "key": "hooh"}]}]
        orig = V._species_names
        V._species_names = lambda: {**names, "ninetales_alolan": "Ninetales (Alolan)"}
        try:
            q = V.lead_questions("v1", battles, full=full)[0]
        finally:
            V._species_names = orig
        self.assertEqual([(o["value"], o["label"]) for o in q["options"][:3]],
                         [("ninetales", "Shadow Ninetales (Alolan)"), ("lugia", "Lugia"), ("hooh", "Ho-Oh")])
        self.assertIn("Shadow Ninetales (Alolan)", q["detail"])
        self.assertEqual(V.lead_questions("v1", battles)[0]["options"][2]["value"], "ho-oh")   # no full result: name-derived key



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
            origin={'sha256':'original-hash','crop':'1,2,3,4','ranges':'20-40','retained':True}
            H.atomic_json(os.path.join(d,'results','abcdefghijk.json'),{'battles':[],'full':[],'media':origin})
            with patch.object(H,'gamemaster_for',return_value=''),patch.object(H,'write_league_refinement',return_value=None):
                h.extract_one(row)
            h.export_validation.assert_called_once();self.assertTrue(os.path.isfile(source))
            doc=H.read_json(os.path.join(d,'results','abcdefghijk.json'));self.assertEqual(doc['media'],origin)
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

MEGA_SCHED = {
    "cups": {
        "great": {"name": "Great League", "cp": 1500}, "ultra": {"name": "Ultra League", "cp": 2500},
        "master": {"name": "Master League", "cp": 10000}, "little": {"name": "Little Cup", "cp": 500},
        "color": {"name": "Color Cup", "cp": 1500, "aliases": ["color cup", "color cup: great league edition"]},
        "colormega": {"name": "Mega Color Cup", "cp": 1500, "aliases": ["mega color cup", "mega color cup: great league edition"]},
        "retro": {"name": "Retro Cup", "cp": 1500},
        "mega": {"name": "Mega Edition", "cp": 10000, "aliases": ["great league: mega edition", "master league: mega edition",
                                                                  "ultra league: mega edition", "mega edition"]},
    },
    "periods": [
        {"start": "2025-01-07", "end": "2025-01-13", "formats": [{"id": "color", "cp": 1500}, {"id": "ultra", "cp": 2500}]},
        {"start": "2026-09-22", "end": "2026-09-28", "formats": [{"id": "retro", "cp": 1500}, {"id": "master", "cp": 10000}]},
        {"start": "2026-09-29", "end": "2026-10-05", "formats": [{"id": "colormega", "cp": 1500, "name": "Mega Color Cup: Great League Edition"}]},
        {"start": "2026-10-06", "end": "2026-10-12", "formats": [{"id": "mega", "cp": 1500, "name": "Great League: Mega Edition"},
                                                                {"id": "mega", "cp": 2500}, {"id": "mega", "cp": 10000}]},
    ],
}


class MegaVariantRules(unittest.TestCase):
    S = MEGA_SCHED

    def test_keywords_name_the_mega_variant_and_edition(self):
        h = lambda t: L.keyword_hits(t, self.S)  # noqa: E731
        self.assertEqual(h("Shadow Palkia - Color Cup"), {"color": 1})
        self.assertEqual(h("Mega Color Cup team"), {"colormega": 1})          # not also the plain Color Cup
        self.assertEqual(h("TOP 100 LEADERBOARDS TEAM (Color Cup Mega)"), {"colormega": 1})
        self.assertEqual(h("Color Cup and Mega Color Cup"), {"color": 1, "colormega": 1})
        self.assertEqual(h("Great League: Mega Edition team"), {"mega@1500": 1})   # edition CP, not the Master default
        self.assertEqual(h("EXPERT PUSH in MEGA GREAT LEAGUE"), {"mega@1500": 1})
        self.assertEqual(h("The King of Mega Master league"), {"mega": 1})
        self.assertEqual(h("Ultra League mega edition"), {"mega@2500": 1})
        self.assertEqual(h("Great League team"), {"great": 1})

    def test_schedule_variant_wins_for_a_keyword_cup_it_did_not_run(self):
        g = L.guess_league({"title": "Shadow Palkia - Color Cup", "uploadDate": "20261005"}, self.S)
        self.assertEqual(g["leagueId"], "colormega")
        self.assertEqual(g["leagueGuess"], "Mega Color Cup: Great League Edition")
        self.assertIn("schedule variant: color -> colormega", g["leagueEvidence"])
        self.assertIn("colormega", g["leagueKeywords"])
        # Upload week after the Mega week: still inside the 14-day lag window of the Mega Color Cup.
        self.assertEqual(L.guess_league({"title": "Color cup", "uploadDate": "20261012"}, self.S)["leagueId"], "colormega")
        # The plain cup stays when the schedule ran it, and when the schedule says nothing about either.
        self.assertEqual(L.guess_league({"title": "Color Cup", "uploadDate": "20250110"}, self.S)["leagueId"], "color")
        self.assertEqual(L.guess_league({"title": "Color Cup", "uploadDate": "20240101"}, self.S)["leagueId"], "color")
        # A cup with no Mega variant is never replaced: the schedule and the text disagree and it stays "retro".
        g = L.guess_league({"title": "Retro Cup", "uploadDate": "20261008"}, self.S)
        self.assertEqual(g["leagueId"], "retro")
        self.assertNotIn("schedule variant", " ".join(g["leagueEvidence"]))

    def test_named_edition_resolves_to_its_scheduled_cp(self):
        g = L.guess_league({"title": "Great League: Mega Edition", "uploadDate": "20261008"}, self.S)
        self.assertEqual(g["leagueId"], "mega@1500")
        # A bare "Mega Edition" with several scheduled CP editions is not guessed.
        self.assertEqual(L.scheduled_variant("mega", {"mega@1500": 1.0, "mega@2500": 1.0}, self.S), None)
        self.assertEqual(L.scheduled_variant("mega", {"mega@1500": 1.0}, self.S), "mega@1500")
        self.assertIsNone(L.scheduled_variant("color", {"color": 1.0, "colormega": 1.0}, self.S))   # it ran itself

    def test_refine_ranks_schedule_then_keywords_then_cp(self):
        obs = {"cps": [1498, 1500, 1491], "species": []}
        cands = ["color", "colormega", "great", "mega@1500", "retro", "ultra"]
        r = L.refine_battle_league(obs, cands, self.S, {}, battle_date="20261006", keywords={"colormega": 3}, lag_days=14)
        self.assertEqual(r["ranked"][0]["id"], "colormega")
        self.assertEqual(r["ranked"][0]["scheduled"], 0.6)       # the keyword cup ran in the lag window
        order = [x["id"] for x in r["ranked"]]
        self.assertLess(order.index("mega@1500"), order.index("great"))   # scheduled beats unscheduled
        self.assertLess(order.index("great"), order.index("ultra"))       # then the CP cap that fits
        # No keyword: the formats the schedule ran come first, the lag window after the upload week.
        r = L.refine_battle_league(obs, cands, self.S, {}, battle_date="20261006", lag_days=14)
        self.assertEqual({x["id"] for x in r["ranked"][:3]}, {"colormega", "retro", "mega@1500"})
        self.assertEqual(r["ranked"][0]["id"], "mega@1500")
        # Genuine disagreement is kept: Retro Cup named, only the Mega Edition ran that week.
        r = L.refine_battle_league(obs, cands, self.S, {}, battle_date="20261008", keywords={"retro": 3}, lag_days=0)
        self.assertEqual((r["ranked"][0]["id"], r["ranked"][0]["scheduled"]), ("retro", 0))
        # A bare league word fixes the CP but does not outrank the cups that ran at it.
        r = L.refine_battle_league(obs, cands, self.S, {}, battle_date="20261008", keywords={"great": 3}, lag_days=0)
        self.assertEqual(r["ranked"][0]["id"], "mega@1500")

    def test_mega_edition_counts_at_great_league_cp(self):
        # An extra OCR digit (14928) is dropped, so the Great League Mega Edition survives; the bare 10000 one ranks lower.
        obs = {"cps": [150, 149, 1500, 14928], "species": []}
        r = L.refine_battle_league(obs, ["mega", "mega@1500", "mega@2500"], self.S, {}, battle_date="20261008", keywords={"mega@1500": 3})
        self.assertEqual((r["ranked"][0]["id"], r["cpCap"]), ("mega@1500", 1500))
        self.assertEqual(r["ranked"][-1]["id"], "mega")
        # Truncated reads ('149' from 'CP 1490') give no CP cap, so they cannot pull the battle to Little Cup.
        r = L.refine_battle_league({"cps": [14, 149, 148], "species": []}, ["great", "little", "mega@1500"], self.S, {},
                                   battle_date="20261008", keywords={"mega@1500": 3})
        self.assertIsNone(r["cpCap"])
        self.assertEqual(r["ranked"][0]["id"], "mega@1500")

    def cup(self, meta, cap=1500, start=10, day="20261005"):
        return L.battle_cup(L.text_cups(meta, self.S), cap, start, self.S, L.schedule_formats(self.S, day))

    def test_cup_comes_from_the_text_never_the_schedule_alone(self):
        # Title > tags > chapters > description; the schedule only picks the Mega variant the text's name stands for.
        c = self.cup({"title": "Shadow Palkia - Color Cup"})
        self.assertEqual((c["cup"], c["status"], c["source"], c["confidence"], c["variant"]),
                         ("colormega", "text-confirmed", "title", 1.0, "color -> colormega"))
        self.assertEqual(self.cup({"title": "Lugia", "tags": ["color cup"]})[("source")], "tags")
        # Nothing named: uncaptured, with what the schedule ran at the CP as a hint only.
        c = self.cup({"title": "Shadow Palkia climbs"})
        self.assertEqual((c["cup"], c["status"], c["reason"]), (None, "uncaptured", "no-cup-named"))
        self.assertEqual(c["scheduled"], ["Mega Color Cup: Great League Edition", "Retro Cup"])   # upload week + lag window
        # The description alone is too weak (channel blurbs name every league).
        c = self.cup({"title": "Shadow Palkia", "description": "Great League, Ultra League and Master League videos"})
        self.assertEqual((c["status"], c["reason"]), ("uncaptured", "weak-text"))
        # Several cups at the battle's CP: penalised below the threshold; a bare league word yields to a named cup.
        self.assertEqual(self.cup({"title": "Retro Cup and Color Cup"})["reason"], "several-cups")
        self.assertEqual(self.cup({"title": "Color Cup Great League"})["cup"], "colormega")
        # Same-name variants named together are one candidate, settled by the schedule.
        self.assertEqual(self.cup({"title": "Color Cup", "tags": ["mega color cup"]})["cup"], "colormega")
        # A league named in the text resolves to its scheduled Mega Edition; other CPs do not compete.
        self.assertEqual(self.cup({"title": "Great League climb"}, day="20261008")["cup"], "mega@1500")
        self.assertEqual(self.cup({"title": "Great League and Ultra League"}, cap=2500, day="20261008")["cup"], "mega@2500")
        self.assertEqual(self.cup({"title": "Ultra League team"})["reason"], "other-cp")
        # Text the schedule contradicts stays the cup (text-only, saying what ran); no schedule record says so too.
        c = self.cup({"title": "Retro Cup"}, day="20261015")
        self.assertEqual((c["cup"], c["status"], c["reason"]), ("retro", "text-only", "disagrees"))
        self.assertEqual(self.cup({"title": "Retro Cup"}, day="20240101")["reason"], "no-record")
        # Compilations: chapters only, per segment.
        meta = {"title": "Best moments compilation", "chapters": [{"start": 0, "title": "Retro Cup"}, {"start": 100, "title": "Color Cup"},
                                                                  {"start": 200, "title": "Outro"}]}
        self.assertEqual(self.cup(meta, start=50)["cup"], "retro")
        self.assertEqual((self.cup(meta, start=150)["cup"], self.cup(meta, start=150)["source"]), ("colormega", "chapters"))
        self.assertEqual(self.cup(meta, start=250)["reason"], "compilation")
        self.assertEqual(self.cup({"title": "Funny moments in Color Cup"})["reason"], "compilation")
        # Localised names count as the cup's name.
        self.assertEqual(L.keyword_hits("Marowak en Copa Color", self.S), {"color": 1})

    def test_refine_video_league_from_cps_cup_from_text(self):
        mon = lambda c: {"form": {"id": "x"}, "cp": c}  # noqa: E731
        res = {"battles": [{"start": 5, "myDetail": [mon(1490)], "opponentDetail": [mon(1495)]},
                           {"start": 50, "myDetail": [mon(2490)], "opponentDetail": [mon(2481)]}]}
        doc = L.refine_video(res, {}, self.S, {}, "20261005", meta={"title": "Color Cup"})
        a, b = doc["battles"]
        self.assertEqual((a["league"], a["cup"], a["cupStatus"], a["best"]), ("great", "colormega", "text-confirmed", "colormega"))
        self.assertEqual((b["league"], b["cup"], b["cupStatus"], b["cupReason"], b["best"]), ("ultra", None, "uncaptured", "other-cp", "ultra"))
        self.assertIn("formats", doc["video"]["textCups"])
        # A reviewer's video-wide label is the cup (at its CP).
        doc = L.refine_video(res, {"leagueId": "retro", "reviewerLeague": True}, self.S, {}, "20261005", meta={"title": "Color Cup"})
        self.assertEqual((doc["battles"][0]["cup"], doc["battles"][0]["cupSource"], doc["battles"][1]["cup"]), ("retro", "reviewer", None))

    def test_refine_all_rewrites_only_sidecars_with_backup(self):
        import hashlib
        with tempfile.TemporaryDirectory() as d:
            work, web = os.path.join(d, "work"), os.path.join(d, "web")
            for sub in (os.path.join(work, "results"), os.path.join(work, "labels"),
                        os.path.join(web, "tests", "meta-benchmark", "sources")):
                os.makedirs(sub)
            mon = lambda c: {"form": {"id": "x"}, "cp": c}  # noqa: E731
            res = {"battles": [{"start": 5, "myDetail": [mon(1490)], "opponentDetail": [mon(1495)]}]}
            for vid in ("aaaaaaaaaaa", "bbbbbbbbbbb"):
                with open(os.path.join(work, "results", vid + ".json"), "w") as f:
                    json.dump(res, f)
            with open(os.path.join(work, "results", "aaaaaaaaaaa.leagues.json"), "w") as f:      # stale sidecar
                json.dump({"video": {"leagueId": "color"}, "battles": [{"start": 5, "best": "color"}]}, f)
            with open(os.path.join(web, "tests", "meta-benchmark", "sources", "registry.json"), "w") as f:
                json.dump([{"id": "aaaaaaaaaaa", "title": "Pokemon Go Monday Color cup", "uploadDate": "20261006"},
                           {"id": "bbbbbbbbbbb", "title": "Color Cup", "uploadDate": "20261006"}], f)
            with open(os.path.join(work, "labels", "bbbbbbbbbbb.json"), "w") as f:   # a reviewer's video-wide label wins
                json.dump({"leagueId": "retro"}, f)

            def digest():
                return {n: hashlib.sha256(open(os.path.join(work, "results", n), "rb").read()).hexdigest()
                        for n in os.listdir(os.path.join(work, "results")) if not n.endswith(".leagues.json")}
            before = digest()
            s = L.refine_all(work, web, os.path.join(d, "bak"), schedule=self.S, gamemaster={})
            self.assertEqual((s["videos"], s["written"], s["created"]), (2, 1, 1))
            read = lambda v: json.load(open(os.path.join(work, "results", v + ".leagues.json")))  # noqa: E731
            self.assertEqual(read("aaaaaaaaaaa")["battles"][0]["best"], "colormega")
            self.assertEqual(read("bbbbbbbbbbb")["battles"][0]["best"], "retro")
            self.assertTrue(os.path.exists(os.path.join(d, "bak", "aaaaaaaaaaa.leagues.json")))
            self.assertEqual(json.load(open(os.path.join(d, "bak", "aaaaaaaaaaa.leagues.json")))["battles"][0]["best"], "color")
            self.assertEqual(digest(), before)                      # results/*.json untouched
            again = L.refine_all(work, web, os.path.join(d, "bak"), schedule=self.S, gamemaster={})
            self.assertEqual((again["written"], again["created"]), (0, 0))   # idempotent


if __name__ == "__main__":
    unittest.main(verbosity=1)


class FocusCupTest(unittest.TestCase):
    """--focus-cup: queries first, claim queries take matching rows first (or only)."""
    SCHEDULE = {"cups": {"little": {"name": "Little Cup"}}}

    def test_queries_and_terms(self):
        q = H.focus_queries("little", self.SCHEDULE, now_year=2026)
        self.assertEqual(q[0], "pokemon go little cup")
        self.assertIn("little cup 2026 pokemon go", q)
        self.assertIn("リトルカップ", H.focus_terms("little", self.SCHEDULE))

    def test_claims_order_and_restrict(self):
        import sqlite3
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE videos(id TEXT, title TEXT, channel_id TEXT, duration REAL, meta TEXT, meta_status TEXT, "
                   "dl_status TEXT, attempts INTEGER DEFAULT 0, allowed INTEGER, rel_label TEXT, upload_date TEXT, "
                   "approx_ts INTEGER, rel_score REAL, league TEXT)")
        rows = [("new-gl", "Great League set", '{"leagueId": "great"}', "20261014"),
                ("old-lc", "LITTLE CUP team", '{"leagueId": "little"}', "20250101"),
                ("new-lc", "Pokemon go set", '{"leagueId": "little"}', "20261013"),
                ("new-lc-title", "Little Cup Great League Edition", '{"leagueId": "great"}', "20261014")]
        for vid, title, league, up in rows:
            db.execute("INSERT INTO videos(id,title,league,upload_date,allowed,rel_score) VALUES(?,?,?,?,1,1)", (vid, title, league, up))
        expr, args = H.focus_sql("little", self.SCHEDULE, "2026-10-13")
        order = [r["id"] for r in db.execute(*H.focused(H.DL_CLAIM, expr, args, False))]
        self.assertEqual(order[:2], ["new-lc-title", "new-lc"])
        only = [r["id"] for r in db.execute(*H.focused(H.DL_CLAIM, expr, args, True))]
        self.assertEqual(sorted(only), ["new-lc", "new-lc-title"])

