#!/usr/bin/env python3
"""Route small, checkable tasks to free-tier LLM APIs, with failover, caching and guards.

  freellm.py ask "prompt" [--system S] [--image F]... [--json] [--agree 2] [--data public|private] [--task NAME] [--provider P]...
  freellm.py models      list the models each configured provider serves (to fix ids in providers.json)
  freellm.py stats       calls, failures and tokens per provider from the usage log

Answer on stdout; provider/model/latency on stderr. Exit codes: 0 ok, 2 every provider failed,
3 providers disagreed (--agree), 4 refused by the privacy guard.
Keys: environment variables named in providers.json, or KEY=value lines in ~/.config/freellm/env.
Cache, usage log and cooldowns live in ~/.cache/freellm (never inside the project).
Standard library only.
"""
import argparse, base64, hashlib, json, mimetypes, os, re, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get("FREELLM_CACHE", Path.home() / ".cache" / "freellm"))
ENV_FILE = Path.home() / ".config" / "freellm" / "env"
MAX_CHARS = 60_000  # small tasks only; anything bigger belongs in the main session

# Never leave the machine: credentials, e-mail addresses, private keys.
GUARDS = [
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "an e-mail address"),
    (re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AIza[\w-]{30,}|xox[abp]-[\w-]{10,})"), "an API key or token"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "a private key"),
    (re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+"), "a credential assignment"),
]


def load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


def providers():
    return json.loads(Path(os.environ.get("FREELLM_PROVIDERS", HERE / "providers.json")).read_text())["providers"]


def state(update=None):
    f = CACHE / "state.json"
    s = json.loads(f.read_text()) if f.exists() else {}
    if update:
        s.update(update)
        CACHE.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(s))
    return s


def log(entry):
    CACHE.mkdir(parents=True, exist_ok=True)
    with open(CACHE / "usage.jsonl", "a") as f:
        f.write(json.dumps({"t": round(time.time()), **entry}) + "\n")


def guard(texts):
    for t in texts:
        for rx, what in GUARDS:
            if rx.search(t):
                return what
    return None


def permitted(p, kind, data):
    """Configured for this kind of request, has its key, and may receive this data."""
    return bool(p.get(kind)) and (not p["key_env"] or bool(os.environ.get(p["key_env"]))) and (data == "public" or p["trains"] is False)


def eligible(p, kind, data):
    if not permitted(p, kind, data):
        return False
    return state().get("cooldown", {}).get(p["name"], 0) < time.time()


def call(p, model, messages, want_json, timeout=90):
    kind = "vision" if model == p.get("vision") else "text"
    body = {"model": model, "messages": messages, "temperature": 0, **(p.get("body") or {}), **(p.get("body_" + kind) or {})}
    if want_json:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(p["base"].rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "freellm/1"})
    if p["key_env"]:
        req.add_header("Authorization", "Bearer " + os.environ[p["key_env"]])
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    return out["choices"][0]["message"]["content"] or "", out.get("usage", {})


def parse_json(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)  # reasoning models may prefix their thoughts
    m = re.search(r"\{.*\}|\[.*\]", text, re.S)
    return json.loads(m.group(0) if m else text)


def run_one(p, kind, messages, want_json, task):
    model, t0 = p[kind], time.time()
    try:
        text, usage = call(p, model, messages, want_json)
        if want_json:
            try:
                parse_json(text)
            except ValueError:  # one retry with a firmer instruction
                text, usage = call(p, model, messages + [{"role": "assistant", "content": text},
                                   {"role": "user", "content": "Reply with valid JSON only."}], want_json)
                parse_json(text)
        log({"task": task, "provider": p["name"], "model": model, "ok": True, "ms": int((time.time() - t0) * 1000),
             "in": usage.get("prompt_tokens"), "out": usage.get("completion_tokens")})
        return text
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, KeyError) as e:
        code = getattr(e, "code", None)
        if code == 429 or (code and code >= 500):
            headers = getattr(e, "headers", None)
            wait = int((headers.get("Retry-After") if headers else 0) or 0)
            cd = state().get("cooldown", {})
            cd[p["name"]] = time.time() + (wait or (60 if code == 429 else 20))
            state({"cooldown": cd})
        log({"task": task, "provider": p["name"], "model": model, "ok": False, "err": f"{type(e).__name__} {code or ''}".strip()})
        print(f"[freellm] {p['name']} failed: {type(e).__name__} {code or e}", file=sys.stderr)
        return None


def normalize(text, want_json):
    if want_json:
        return json.dumps(parse_json(text), sort_keys=True)
    return re.sub(r"\s+", " ", text.strip().lower())


def ask(a):
    images = [Path(f) for f in a.image]
    prompt = a.prompt if a.prompt != "-" else sys.stdin.read()
    texts = [prompt, a.system or ""]
    if sum(map(len, texts)) > MAX_CHARS:
        print(f"[freellm] refused: over {MAX_CHARS} characters; not a small task", file=sys.stderr)
        return 4
    hit = guard(texts)
    if hit:
        print(f"[freellm] refused: the input contains {hit}", file=sys.stderr)
        return 4
    content = [{"type": "text", "text": prompt}]
    for f in images:
        mime = mimetypes.guess_type(f.name)[0] or "image/jpeg"
        content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(f.read_bytes()).decode()}})
    messages = ([{"role": "system", "content": a.system}] if a.system else []) + [{"role": "user", "content": content if images else prompt}]
    kind = "vision" if images else "text"
    only = set(a.provider or [])
    key_parts = [a.system, prompt, [hashlib.sha256(f.read_bytes()).hexdigest() for f in images], a.json, a.agree, a.data]
    if only:
        key_parts.append(sorted(only))
    key = hashlib.sha256(json.dumps(key_parts).encode()).hexdigest()
    cached = CACHE / "answers" / (key + ".txt")
    meta = cached.with_suffix(".meta.json")
    if cached.exists() and not a.no_cache:
        log({"task": a.task, "provider": "cache", "ok": True})
        print("[freellm] cache hit", file=sys.stderr)
        for name in (json.loads(meta.read_text()).get("providers", []) if meta.exists() else []):
            print(f"[freellm] answered by {name} (cached)", file=sys.stderr)
        print(cached.read_text())
        return 0
    answers, used, names = [], {p["name"] for p in providers() if only and p["name"] not in only}, []
    deadline = time.time() + a.wait
    while len(answers) < a.agree:
        ready = [p for p in providers() if p["name"] not in used and eligible(p, kind, a.data)]
        if not ready:
            # Every usable provider is cooling down after a 429: wait for the first to free up (bounded).
            now, cd = time.time(), state().get("cooldown", {})
            cooling = [cd[p["name"]] for p in providers() if p["name"] not in used and cd.get(p["name"], 0) > now
                       and permitted(p, kind, a.data)]
            if not cooling or min(cooling) > deadline:
                break
            pause = max(1, min(cooling) - now)
            print(f"[freellm] all providers rate-limited; waiting {pause:.0f} s", file=sys.stderr)
            time.sleep(pause)
            continue
        p = ready[0]
        text = run_one(p, kind, messages, a.json, a.task)
        if text is None:
            if state().get("cooldown", {}).get(p["name"], 0) <= time.time():
                used.add(p["name"])  # failed without a cooldown: don't retry it
            continue
        used.add(p["name"])
        print(f"[freellm] answered by {p['name']} ({p[kind]})", file=sys.stderr)
        answers.append(text)
        names.append(p["name"])
    if len(answers) < a.agree:
        print(f"[freellm] no answer: {len(answers)} of {a.agree} providers responded "
              f"(data={a.data}; private data only goes to providers that don't train on prompts)", file=sys.stderr)
        return 2
    if len({normalize(t, a.json) for t in answers}) > 1:
        print("[freellm] providers disagreed; do this task in the main session", file=sys.stderr)
        for t in answers:
            print("---\n" + t, file=sys.stderr)
        return 3
    out = json.dumps(parse_json(answers[0]), indent=1) if a.json else answers[0].strip()
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(out)
    meta.write_text(json.dumps({"providers": names}))
    print(out)
    return 0


def models(_):
    for p in providers():
        if p["key_env"] and not os.environ.get(p["key_env"]):
            print(f"{p['name']}: no key ({p['key_env']})")
            continue
        req = urllib.request.Request(p["base"].rstrip("/") + "/models", headers={"User-Agent": "freellm/1"})
        if p["key_env"]:
            req.add_header("Authorization", "Bearer " + os.environ[p["key_env"]])
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                ids = [str(m.get("id")).removeprefix("models/") for m in json.loads(r.read()).get("data", [])]
            mark = lambda m: m if not m or m in ids else f"{m} (NOT SERVED)"
            print(f"{p['name']}: text={mark(p['text'])} vision={mark(p['vision'])} · {len(ids)} models")
        except Exception as e:
            print(f"{p['name']}: {type(e).__name__} {getattr(e, 'code', '')}")
    return 0


def stats(_):
    f = CACHE / "usage.jsonl"
    rows = [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []
    agg = {}
    for r in rows:
        s = agg.setdefault(r["provider"], {"ok": 0, "fail": 0, "in": 0, "out": 0})
        s["ok" if r["ok"] else "fail"] += 1
        s["in"] += r.get("in") or 0
        s["out"] += r.get("out") or 0
    for name, s in sorted(agg.items()):
        print(f"{name:12} ok {s['ok']:4}  failed {s['fail']:4}  tokens in {s['in']:8}  out {s['out']:8}")
    return 0


def main():
    load_env()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    q = sub.add_parser("ask")
    q.add_argument("prompt", help='prompt text, or "-" for stdin')
    q.add_argument("--system")
    q.add_argument("--image", action="append", default=[])
    q.add_argument("--json", action="store_true", help="require a JSON answer")
    q.add_argument("--agree", type=int, default=1, help="ask N different providers; accept only if they match")
    q.add_argument("--data", choices=["public", "private"], default="private",
                   help="private (default): only providers that don't train on prompts")
    q.add_argument("--task", default="adhoc", help="label for the usage log")
    q.add_argument("--provider", action="append", help="only use these providers (repeatable; for per-provider evals)")
    q.add_argument("--no-cache", action="store_true")
    q.add_argument("--wait", type=float, default=120, help="max seconds to wait when every provider is rate-limited")
    sub.add_parser("models")
    sub.add_parser("stats")
    a = ap.parse_args()
    return {"ask": ask, "models": models, "stats": stats}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
