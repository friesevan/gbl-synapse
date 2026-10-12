"""Offline tests for freellm.py against a local mock OpenAI-compatible server (no real API calls).
Run: python3 -I scripts/freellm/test_freellm.py"""
import json, os, subprocess, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "freellm.py"
SEEN = []
BODIES = []
RESPONSES = []   # queued fake-SDK responses (AnthropicProvider)


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def reply(self, obj, code=200):
        out = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(out)

    def do_GET(self):
        # A local Ollama server: /local has the fallback model only, /empty has none.
        if self.path == "/local/api/tags":
            return self.reply({"models": [{"name": "fallback-vl:7b"}]})
        if self.path == "/empty/api/tags":
            return self.reply({"models": []})
        self.send_response(404); self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append((self.path, body["model"]))
        BODIES.append(body)
        if self.path.startswith("/local"):
            ans = {"answer": "none", "confidence": 0.9}
            return self.reply({"choices": [{"message": {"content": json.dumps(ans)}}], "usage": {"prompt_tokens": 50, "completion_tokens": 9}})
        if self.path.startswith("/once") and not any(x == ("/once/chat/completions", "ok") for x in SEEN[:-1]):
            SEEN.append(("/once/chat/completions", "ok"))
            self.send_response(429); self.send_header("Retry-After", "1"); self.end_headers(); return
        if self.path.startswith("/once"):
            self.path = "/a"
        if self.path.startswith("/busy"):
            self.send_response(429); self.send_header("Retry-After", "1"); self.end_headers(); return
        answer = {"/a": '{"name": "Sandslash"}', "/b": '{"name": "Sandslash"}', "/c": '{"name": "Drifblim"}'}[self.path[:2]]
        out = json.dumps({"choices": [{"message": {"content": answer}}], "usage": {"prompt_tokens": 5, "completion_tokens": 3}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(out)


class FreeLLM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    def run_cli(self, provs, *args):
        d = tempfile.mkdtemp()
        f = Path(d) / "p.json"
        f.write_text(json.dumps({"providers": [{"key_env": None, "vision": None, **p, "base": self.base + p["base"]} for p in provs]}))
        env = {**os.environ, "FREELLM_PROVIDERS": str(f), "FREELLM_CACHE": str(Path(d) / "cache"), "HOME": d}
        r = subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True, env=env)
        return r, Path(d)

    def test_failover_and_cooldown(self):
        r, d = self.run_cli([{"name": "busy", "base": "/busy", "trains": False, "text": "m1"},
                             {"name": "a", "base": "/a", "trains": False, "text": "m2"}], "ask", "hi", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {"name": "Sandslash"})
        self.assertIn("busy", json.loads((d / "cache" / "state.json").read_text())["cooldown"])

    def test_private_data_skips_training_providers(self):
        r, _ = self.run_cli([{"name": "c", "base": "/c", "trains": True, "text": "m"}], "ask", "hi")
        self.assertEqual(r.returncode, 2)
        r, _ = self.run_cli([{"name": "c", "base": "/c", "trains": True, "text": "m"}], "ask", "hi", "--data", "public")
        self.assertEqual(r.returncode, 0)

    def test_guard_blocks_secrets_and_email(self):
        for text in ["mail me at someone@example.com", "token ghp_" + "a" * 30, "api_key = abc123"]:
            r, _ = self.run_cli([{"name": "a", "base": "/a", "trains": False, "text": "m"}], "ask", text)
            self.assertEqual(r.returncode, 4, text)

    def test_agreement(self):
        same = [{"name": "a", "base": "/a", "trains": False, "text": "m"}, {"name": "b", "base": "/b", "trains": False, "text": "m"}]
        r, _ = self.run_cli(same, "ask", "q", "--json", "--agree", "2")
        self.assertEqual(r.returncode, 0, r.stderr)
        r, _ = self.run_cli([same[0], {"name": "c", "base": "/c", "trains": False, "text": "m"}], "ask", "q", "--json", "--agree", "2")
        self.assertEqual(r.returncode, 3)

    def test_waits_out_a_short_rate_limit(self):
        r, _ = self.run_cli([{"name": "once", "base": "/once", "trains": False, "text": "m"}], "ask", "wait for me", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("waiting", r.stderr)

    def test_provider_filter_body_extras_and_cached_provenance(self):
        provs = [{"name": "a", "base": "/a", "trains": False, "text": "m"},
                 {"name": "b", "base": "/b", "trains": False, "text": "m", "body": {"provider": {"data_collection": "deny"}}}]
        r, d = self.run_cli(provs, "ask", "only b", "--json", "--provider", "b")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("answered by b", r.stderr)
        self.assertEqual(BODIES[-1]["provider"], {"data_collection": "deny"})
        env = {**os.environ, "FREELLM_PROVIDERS": str(d / "p.json"), "FREELLM_CACHE": str(d / "cache"), "HOME": str(d)}
        r = subprocess.run([sys.executable, "-I", str(SCRIPT), "ask", "only b", "--json", "--provider", "b"], capture_output=True, text=True, env=env)
        self.assertIn("answered by b (cached)", r.stderr)
        r = subprocess.run([sys.executable, "-I", str(SCRIPT), "ask", "only b", "--json", "--provider", "zzz"], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 2)

    def test_reasoning_prefix_is_ignored(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("freellm", SCRIPT)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        self.assertEqual(m.parse_json('<think>maybe {"answer": "x"}</think>{"answer": "none"}'), {"answer": "none"})

    def test_local_provider_fallback_schema_seeds_and_agreement(self):
        schema = {"type": "object", "properties": {"answer": {"type": "string"}, "confidence": {"type": "number"}},
                  "required": ["answer", "confidence"], "additionalProperties": False}
        prov = {"name": "ollama", "base": "/local/v1", "local": True, "trains": False, "text": "missing-vl:7b",
                "vision": "missing-vl:7b", "fallback": ["fallback-vl:7b"], "repeatable": True, "seeded": True,
                "structured": True, "temperature": 0.2, "source": "local-llm"}
        img = Path(tempfile.mkdtemp()) / "f.jpg"
        img.write_bytes(b"\xff\xd8fakejpeg")
        n = len(BODIES)
        r, d = self.run_cli([prov], "ask", "q", "--schema", json.dumps(schema), "--image", str(img), "--agree", "2")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("using fallback fallback-vl:7b", r.stderr)
        self.assertIn("answered by ollama (fallback-vl:7b) source=local-llm", r.stderr)
        self.assertIn("answered by ollama#2", r.stderr)
        sent = BODIES[n:]
        self.assertEqual([b["seed"] for b in sent], [0, 1])          # two independent calls
        self.assertEqual(sent[0]["model"], "fallback-vl:7b")
        self.assertEqual(sent[0]["response_format"]["type"], "json_schema")
        self.assertEqual(sent[0]["temperature"], 0.2)
        self.assertTrue(sent[0]["messages"][-1]["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertNotIn("Independent check", json.dumps(sent[0]["messages"]))
        self.assertIn("Independent check 2", json.dumps(sent[1]["messages"]))
        log = [json.loads(l) for l in (d / "cache" / "usage.jsonl").read_text().splitlines()]
        self.assertEqual({e["model"] for e in log}, {"fallback-vl:7b"})
        r2 = subprocess.run([sys.executable, "-I", str(SCRIPT), "ask", "q", "--schema", json.dumps(schema), "--image", str(img), "--agree", "2"],
                            capture_output=True, text=True, env={**os.environ, "FREELLM_PROVIDERS": str(d / "p.json"),
                                                                 "FREELLM_CACHE": str(d / "cache"), "HOME": str(d)})
        self.assertIn("answered by ollama (cached) (fallback-vl:7b) source=local-llm", r2.stderr)

    def test_local_server_missing_prints_setup_commands(self):
        prov = {"name": "ollama", "local": True, "trains": False, "text": "qwen2.5vl:7b", "source": "local-llm"}
        r, _ = self.run_cli([{**prov, "base": "/empty/v1"}], "ask", "hi")
        self.assertEqual(r.returncode, 6, r.stderr)
        self.assertIn("ollama pull qwen2.5vl:7b", r.stderr)
        d = tempfile.mkdtemp()
        f = Path(d) / "p.json"
        f.write_text(json.dumps({"providers": [{**prov, "key_env": None, "base": "http://127.0.0.1:9/v1"}]}))   # nothing listens
        r = subprocess.run([sys.executable, "-I", str(SCRIPT), "ask", "hi"], capture_output=True, text=True,
                           env={**os.environ, "FREELLM_PROVIDERS": str(f), "FREELLM_CACHE": str(Path(d) / "c"), "HOME": d})
        self.assertEqual(r.returncode, 6)
        self.assertIn("brew install ollama", r.stderr)
        self.assertIn("ollama serve", r.stderr)

    def test_disabled_providers_are_skipped(self):
        r, _ = self.run_cli([{"name": "a", "base": "/a", "trains": False, "text": "m", "enabled": False}], "ask", "hi")
        self.assertEqual(r.returncode, 2)

    def test_cache(self):
        provs = [{"name": "a", "base": "/a", "trains": False, "text": "m"}]
        d = tempfile.mkdtemp()
        f = Path(d) / "p.json"
        f.write_text(json.dumps({"providers": [{"key_env": None, "vision": None, **provs[0], "base": self.base + "/a"}]}))
        env = {**os.environ, "FREELLM_PROVIDERS": str(f), "FREELLM_CACHE": str(Path(d) / "c"), "HOME": d}
        cmd = [sys.executable, "-I", str(SCRIPT), "ask", "cache me"]
        n = len(SEEN)
        subprocess.run(cmd, capture_output=True, env=env)
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
        self.assertIn("cache hit", r.stderr)
        self.assertEqual(len(SEEN), n + 1)


def load(name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, SCRIPT.parent / (name + ".py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def fake_anthropic(responses, calls):
    """A stand-in for the official SDK (not installed in tests): same class and error names."""
    import types
    mod = types.ModuleType("anthropic")

    class APIError(Exception): pass

    class APIStatusError(APIError):
        def __init__(self, status_code, headers=None):
            super().__init__(f"status {status_code}")
            self.status_code = status_code
            self.response = types.SimpleNamespace(headers=headers or {})

    class RateLimitError(APIStatusError): pass

    class APIConnectionError(APIError): pass

    class Messages:
        def create(self, **kw):
            calls.append(kw)
            r = (responses or RESPONSES).pop(0)
            if isinstance(r, Exception):
                raise r
            return r

    class Anthropic:
        def __init__(self, **kw):
            self.messages = Messages()

    mod.Anthropic, mod.APIError, mod.APIStatusError, mod.RateLimitError, mod.APIConnectionError = Anthropic, APIError, APIStatusError, RateLimitError, APIConnectionError
    return mod


def message(text, stop="end_turn", tin=1000, tout=100):
    import types
    return types.SimpleNamespace(stop_reason=stop, content=[types.SimpleNamespace(type="thinking", thinking=""), types.SimpleNamespace(type="text", text=text)],
                                 usage=types.SimpleNamespace(input_tokens=tin, output_tokens=tout, cache_creation_input_tokens=0, cache_read_input_tokens=0))


class AnthropicProvider(unittest.TestCase):
    """The disabled-by-default Claude provider, against a fake SDK module (no network)."""

    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.m = load("freellm")
        self.m.CACHE = self.d / "cache"
        self.calls = []
        self.prov = {"name": "anthropic", "api": "anthropic", "key_env": "FAKE_KEY", "trains": False, "vision": "claude-haiku-5-5",
                     "text": "claude-haiku-5-5", "effort": "low", "repeatable": True, "source": "haiku",
                     "price_per_mtok": {"in": 0.10, "out": 0.50, "cache_write": 0.125, "cache_read": 0.01}}
        os.environ["FAKE_KEY"] = "test-not-a-key"

    def tearDown(self):
        sys.modules.pop("anthropic", None)
        os.environ.pop("FAKE_KEY", None)

    def run_ask(self, responses, *args):
        mod = sys.modules["anthropic"] = fake_anthropic([], self.calls)
        RESPONSES[:] = [r(mod) if callable(r) else r for r in responses]
        self.m.providers = lambda: [self.prov]
        img = self.d / "f.jpg"
        img.write_bytes(b"\xff\xd8x")
        a = self.m.argparse.Namespace(prompt="q", system=None, image=[str(img)], json=False, schema=json.dumps({"type": "object"}),
                                      agree=1, data="private", task="t", provider=None, no_cache=True, wait=1, seed=0)
        for k, v in zip(args[::2], args[1::2]):
            setattr(a, k, v)
        return self.m.ask(a)

    def test_request_shape_and_cost_log(self):
        self.assertEqual(self.run_ask([message('{"answer": "none", "confidence": 0.9}')]), 0)
        kw = self.calls[0]
        self.assertEqual(kw["model"], "claude-haiku-5-5")
        self.assertEqual(kw["messages"][0]["content"][0]["type"], "image")          # image block before the text
        self.assertEqual(kw["messages"][0]["content"][0]["source"]["media_type"], "image/jpeg")
        self.assertEqual(kw["output_config"]["format"]["type"], "json_schema")
        self.assertEqual(kw["output_config"]["effort"], "low")
        self.assertNotIn("temperature", kw)                                           # Haiku 5.5: 400 on non-default sampling
        row = json.loads((self.d / "cache" / "usage.jsonl").read_text().splitlines()[-1])
        self.assertAlmostEqual(row["usd"], (1000 * 0.10 + 100 * 0.50) / 1e6)
        self.assertNotIn("test-not-a-key", (self.d / "cache" / "usage.jsonl").read_text())

    def test_refusal_rate_limit_and_budget(self):
        self.assertEqual(self.run_ask([message("", stop="refusal")]), 2)
        self.assertEqual(self.run_ask([lambda api: api.RateLimitError(429, {"retry-after": "30"})]), 2)
        self.assertIn("anthropic", json.loads((self.d / "cache" / "state.json").read_text())["cooldown"])
        (self.d / "cache" / "state.json").unlink()
        os.environ["FREELLM_BUDGET_USD"] = "0.0001"
        try:
            self.m.log({"provider": "anthropic", "ok": True, "usd": 0.001})
            self.assertEqual(self.run_ask([message("{}")]), 5)
        finally:
            os.environ.pop("FREELLM_BUDGET_USD")


class ValidateLLM(unittest.TestCase):
    """Pure parts of validate_llm.py: agreement, thresholds, privacy filters."""

    @classmethod
    def setUpClass(cls):
        cls.v = load("validate_llm")

    def call(self, ans, conf):
        return {"answer": ans, "confidence": conf, "model": "m", "source": "local-llm"}

    def test_agreement_needs_two_matching_confident_calls(self):
        v, q = self.v, {"qid": "x", "options": []}
        self.assertEqual(v.agreed("footage", q, {"a": self.call("none", .9), "b": self.call("none", .8)}, .8), "none")
        self.assertIsNone(v.agreed("footage", q, {"a": self.call("none", .9), "b": self.call("none", .7)}, .8))
        self.assertIsNone(v.agreed("footage", q, {"a": self.call("none", .9), "b": self.call("battles", .9)}, 0))
        self.assertIsNone(v.agreed("footage", q, {"a": self.call("unsure", .9), "b": self.call("unsure", .9)}, 0))
        self.assertIsNone(v.agreed("footage", q, {"a": self.call("none", .9), "b": None}, 0))
        both = {"footage.a": self.call("none", .95), "footage.b": self.call("none", .95),
                "title_footage.a": self.call("none", .9), "title_footage.b": self.call("none", .95)}
        self.assertEqual(v.agreed("footage_title", q, both, .9), "none")         # thumbnails and title agree
        self.assertIsNone(v.agreed("footage_title", q, {**both, "title_footage.b": self.call("battles", .9)}, 0))
        self.assertIsNone(v.agreed("footage_title", q, {k: c for k, c in both.items() if k.startswith("footage")}, 0))
        self.assertIsNone(v.agreed("footage_title", q, {**both, "footage.a": self.call("obscured", .9), "footage.b": self.call("obscured", .9)}, 0))
        lead = {"qid": "l", "options": [{"value": "Azumarill"}, {"value": "Medicham"}, {"value": "other"}]}
        self.assertIsNone(v.agreed("lead", lead, {"a": self.call("other", .9), "b": self.call("other", .9)}, 0))

    def test_threshold_choice_and_held_out_ordering(self):
        v = self.v
        rows = [{"q": {"qid": str(i)}, "truth": "none", "calls": {"a": self.call("none", .95), "b": self.call("none", .95)}} for i in range(19)]
        rows.append({"q": {"qid": "w"}, "truth": "battles", "calls": {"a": self.call("none", .6), "b": self.call("none", .6)}})
        self.assertEqual(v.choose_threshold(rows, "footage"), 0.0)        # 19/20 = 95%
        rows.append({"q": {"qid": "w2"}, "truth": "battles", "calls": {"a": self.call("none", .6), "b": self.call("none", .6)}})
        self.assertEqual(v.choose_threshold(rows, "footage"), 0.7)        # drop the two unconfident wrong ones
        self.assertNotEqual(v.ordered(list(v.FOOTAGE_CHOICES), 1, "q1"), list(v.FOOTAGE_CHOICES))
        self.assertEqual(v.ordered(list(v.FOOTAGE_CHOICES), 0, "q1"), list(v.FOOTAGE_CHOICES))

    def test_privacy_filters(self):
        v = self.v
        text = "Great league!\nTrainer code: 1234 5678 9012\nMy IGN: SomeName\nmail me@example.com https://x.y @handle\nUltra cup"
        clean = v.clean_description(text)
        self.assertNotIn("1234", clean)
        self.assertNotIn("SomeName", clean)
        self.assertNotIn("example.com", clean)
        self.assertNotIn("@handle", clean)
        self.assertIn("Ultra cup", clean)
        own = Path(tempfile.mkdtemp())
        (own / "mine.mp4").write_bytes(b"x")
        v.OWN_RECORDINGS = own
        self.assertFalse(v.safe_video(own / "mine.mp4"))
        (own / "cache").mkdir()
        (own / "cache" / "yt.mp4").write_bytes(b"x")
        self.assertTrue(v.safe_video(own / "cache" / "yt.mp4"))

    def test_human_answers_exclude_llm_resolutions(self):
        v = self.v
        self.assertTrue(v.human({"value": "none", "source": "reviewer"}))
        for s in ("model", "freellm", "local-llm", "haiku"):
            self.assertFalse(v.human({"value": "none", "source": s}))
        self.assertFalse(v.human({"value": "none", "modelResolved": True}))


if __name__ == "__main__":
    unittest.main(verbosity=1)
