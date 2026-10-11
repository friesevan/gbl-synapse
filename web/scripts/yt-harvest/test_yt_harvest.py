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


if __name__ == "__main__":
    unittest.main(verbosity=1)
