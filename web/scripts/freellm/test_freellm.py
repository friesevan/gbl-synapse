"""Offline tests for freellm.py against a local mock OpenAI-compatible server (no real API calls).
Run: python3 -I scripts/freellm/test_freellm.py"""
import json, os, subprocess, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "freellm.py"
SEEN = []


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append((self.path, body["model"]))
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


if __name__ == "__main__":
    unittest.main(verbosity=1)
