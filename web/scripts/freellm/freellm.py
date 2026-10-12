#!/usr/bin/env python3
"""Route small, checkable tasks to an LLM, with guards, caching, retries and a usage/cost log.

  freellm.py ask "prompt" [--system S] [--image F]... [--json] [--schema JSON] [--agree 2] [--data public|private] [--task NAME] [--provider P]...
  freellm.py models      check that each enabled provider is reachable and serves its configured models
  freellm.py stats       calls, failures, tokens and estimated USD per provider (and per run with --run)

Provider-agnostic. Since 2026-10-12 the default and only enabled provider is `ollama`: a local vision
model (qwen2.5vl:7b) behind Ollama's OpenAI-compatible endpoint, so nothing leaves the machine.
`anthropic` (Claude Haiku 5.5 through the official SDK) is kept, disabled, for if API access is ever
available. The free-tier providers (Groq, Gemini, OVH, OpenRouter, ...) are disabled and being phased out.

Answer on stdout; provider/model/latency on stderr. Exit codes: 0 ok, 2 every provider failed,
3 answers disagreed (--agree), 4 refused by the privacy guard, 5 the spending budget is used up,
6 the local model server isn't running or lacks the model (the setup commands are printed).
Keys: environment variables named in providers.json, or KEY=value lines in ~/.config/gbl-synapse/env
or ~/.config/freellm/env (never in the project; never printed or logged).
Cache, usage log (tokens, estimated USD) and cooldowns live in ~/.cache/freellm (never inside the project).
"""
import argparse, base64, hashlib, json, mimetypes, os, re, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get("FREELLM_CACHE", Path.home() / ".cache" / "freellm"))
ENV_FILES = [Path.home() / ".config" / "gbl-synapse" / "env", Path.home() / ".config" / "freellm" / "env"]
MAX_CHARS = 60_000  # small tasks only; anything bigger belongs in the main session
DEFAULT_BUDGET_USD = 5.0   # total estimated spend on priced providers (usage log) before calls are refused

# Never leave the machine: credentials, e-mail addresses, private keys.
GUARDS = [
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "an e-mail address"),
    (re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AIza[\w-]{30,}|xox[abp]-[\w-]{10,})"), "an API key or token"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "a private key"),
    (re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+"), "a credential assignment"),
]


class ProviderError(Exception):
    """A failed API call: `code` is the HTTP status (None for network errors), `wait` a Retry-After."""
    def __init__(self, msg, code=None, wait=0):
        super().__init__(msg)
        self.code, self.wait = code, wait


def load_env():
    for f in ENV_FILES:
        if f.exists():
            for line in f.read_text().splitlines():
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
    run = os.environ.get("FREELLM_RUN")
    with open(CACHE / "usage.jsonl", "a") as f:
        f.write(json.dumps({"t": round(time.time()), **({"run": run} if run else {}), **entry}) + "\n")


def usage_rows():
    f = CACHE / "usage.jsonl"
    rows = []
    if f.exists():
        for line in f.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def spent_usd(run=None):
    """Estimated USD in the usage log (all runs, or one FREELLM_RUN id)."""
    return round(sum(r.get("usd") or 0 for r in usage_rows() if run is None or r.get("run") == run), 6)


def budget_usd():
    return float(os.environ.get("FREELLM_BUDGET_USD") or DEFAULT_BUDGET_USD)


def cost(p, usage):
    """Estimated USD from the provider's per-million-token prices (providers.json `price_per_mtok`)."""
    price = p.get("price_per_mtok")
    if not price:
        return None
    return round((usage.get("in", 0) * price.get("in", 0) + usage.get("out", 0) * price.get("out", 0)
                  + usage.get("cacheWrite", 0) * price.get("cache_write", 0) + usage.get("cacheRead", 0) * price.get("cache_read", 0)) / 1e6, 8)


def guard(texts):
    for t in texts:
        for rx, what in GUARDS:
            if rx.search(t):
                return what
    return None


def permitted(p, kind, data):
    """Enabled, configured for this kind of request, has its key, and may receive this data."""
    return (p.get("enabled", True) is not False and bool(p.get(kind))
            and (not p["key_env"] or bool(os.environ.get(p["key_env"]))) and (data == "public" or p["trains"] is False))


def eligible(p, kind, data):
    if not permitted(p, kind, data):
        return False
    return state().get("cooldown", {}).get(p["name"], 0) < time.time()


# ---------- API adapters ----------

class SetupError(Exception):
    """A local provider's server isn't running or lacks the model; the message holds the setup commands."""


def base_url(p):
    return (os.environ.get(p["base_env"]) if p.get("base_env") else None) or p["base"]


def model_for(p, kind):
    """The configured model, overridable by the provider's `model_env` variable (e.g. FREELLM_OLLAMA_MODEL)."""
    return (os.environ.get(p["model_env"]) if p.get("model_env") else None) or p.get(kind)


_LOCAL_MODELS = {}


def local_model(p, model):
    """For a local server (Ollama): check it answers and has `model` (else the first installed fallback).
    Raises SetupError with the exact commands to run; never installs or pulls anything itself."""
    root = re.sub(r"/v1/?$", "", base_url(p).rstrip("/"))
    if root not in _LOCAL_MODELS:
        try:
            with urllib.request.urlopen(urllib.request.Request(root + "/api/tags", headers={"User-Agent": "freellm/1"}), timeout=5) as r:
                _LOCAL_MODELS[root] = {m.get("name") or m.get("model") for m in json.loads(r.read()).get("models", [])}
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError, OSError):
            raise SetupError(f"{p['name']}: no model server at {root}. Set it up (once, ~5 GB):\n"
                             f"  brew install ollama\n  ollama serve            # or: brew services start ollama\n"
                             f"  ollama pull {model}") from None
    have = _LOCAL_MODELS[root]
    for m in [model] + list(p.get("fallback") or []):
        if m in have or (":" not in m and m + ":latest" in have):
            if m != model:
                print(f"[freellm] {p['name']}: {model} not installed; using fallback {m}", file=sys.stderr)
            return m
    raise SetupError(f"{p['name']}: the server at {root} doesn't have {model}"
                     f"{' (or ' + ', '.join(p['fallback']) + ')' if p.get('fallback') else ''}"
                     f"{'; installed: ' + ', '.join(sorted(have)) + ' (pick one with ' + p['model_env'] + '=NAME)' if have and p.get('model_env') else ''}."
                     f" Run:\n  ollama pull {model}")


def call_openai(p, model, req, want_json, schema=None, seed=0):
    """OpenAI-compatible /chat/completions over urllib: the local Ollama server and the legacy free tiers.
    Images go as base64 data URLs. With a schema and "structured": true, JSON is constrained by
    response_format json_schema (Ollama >= 0.5); otherwise json_object."""
    kind = "vision" if req["images"] else "text"
    content = [{"type": "text", "text": req["prompt"]}] + [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(data).decode()}} for mime, data in req["images"]]
    messages = ([{"role": "system", "content": req["system"]}] if req["system"] else []) + [
        {"role": "user", "content": content if req["images"] else req["prompt"]}]
    body = {"model": model, "messages": messages, "temperature": p.get("temperature", 0), **(p.get("body") or {}), **(p.get("body_" + kind) or {})}
    if p.get("seeded"):
        body["seed"] = seed
    if schema and p.get("structured"):
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema, "strict": True}}
    elif want_json:
        body["response_format"] = {"type": "json_object"}
    r = urllib.request.Request(base_url(p).rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json", "User-Agent": "freellm/1"})
    if p["key_env"]:
        r.add_header("Authorization", "Bearer " + os.environ[p["key_env"]])
    try:
        with urllib.request.urlopen(r, timeout=float(p.get("timeout", 90))) as resp:
            out = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404 and p.get("local"):
            raise SetupError(f"{p['name']}: model {model} not found. Run:\n  ollama pull {model}") from None
        raise ProviderError(f"HTTPError {e.code}", e.code, int((e.headers.get("Retry-After") if e.headers else 0) or 0)) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        if p.get("local"):
            _LOCAL_MODELS.clear()
            local_model(p, model)   # raises SetupError if the server went away
        raise ProviderError(type(e).__name__) from None
    u = out.get("usage", {})
    return out["choices"][0]["message"]["content"] or "", {"in": u.get("prompt_tokens") or 0, "out": u.get("completion_tokens") or 0}


def anthropic_client(p):
    """The official SDK client. It retries 429, 5xx and connection errors itself with exponential
    backoff (honouring retry-after), `max_retries` times, before the router puts the provider on a cooldown."""
    import anthropic
    return anthropic.Anthropic(api_key=os.environ[p["key_env"]], max_retries=int(p.get("max_retries", 4)),
                               timeout=float(p.get("timeout", 90)))


def call_anthropic(p, model, req, want_json, schema=None):
    """Claude through the Messages API: images as base64 content blocks before the text, JSON answers
    via structured outputs when a schema is given. Claude Haiku 5.5 rejects non-default temperature /
    top_p / top_k (400), so none are sent; answers are made repeatable by the cache instead."""
    try:
        import anthropic
    except ImportError:
        raise ProviderError("anthropic SDK not installed (see scripts/freellm/README.md, Setup)") from None
    content = [{"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.standard_b64encode(data).decode()}}
               for mime, data in req["images"]] + [{"type": "text", "text": req["prompt"]}]
    kw = {"model": model, "max_tokens": int(p.get("max_tokens", 4096)), "messages": [{"role": "user", "content": content}]}
    system = req["system"] or ""
    if want_json and not schema:
        system = (system + "\n\n" if system else "") + "Reply with one JSON value only, no other text."
    if system:
        kw["system"] = system
    output_config = {}
    if p.get("effort"):
        output_config["effort"] = p["effort"]
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    if output_config:
        kw["output_config"] = output_config
    client = anthropic_client(p)
    try:
        msg = client.messages.create(**kw)
    except anthropic.RateLimitError as e:          # 429 after the SDK's own retries
        raise ProviderError("RateLimitError", 429, retry_after(e)) from None
    except anthropic.APIStatusError as e:          # 4xx (no cooldown) or 5xx (cooldown)
        raise ProviderError(f"{type(e).__name__} {e.status_code}", e.status_code, retry_after(e)) from None
    except anthropic.APIConnectionError as e:      # network failure / timeout after retries
        raise ProviderError(type(e).__name__) from None
    u = msg.usage
    usage = {"in": u.input_tokens or 0, "out": u.output_tokens or 0,
             "cacheWrite": getattr(u, "cache_creation_input_tokens", 0) or 0, "cacheRead": getattr(u, "cache_read_input_tokens", 0) or 0}
    if msg.stop_reason == "refusal":
        raise RefusalError(usage)
    if msg.stop_reason == "max_tokens":
        raise TruncatedError(usage)
    return "".join(b.text for b in msg.content if b.type == "text"), usage


class RefusalError(Exception):
    """The model declined (stop_reason "refusal"); no cooldown, the question stays open."""
    def __init__(self, usage):
        super().__init__("refusal")
        self.usage = usage


class TruncatedError(RefusalError):
    """stop_reason "max_tokens": the answer was cut off."""
    def __str__(self):
        return "max_tokens"


def retry_after(e):
    try:
        return int(float(e.response.headers.get("retry-after") or 0))
    except (AttributeError, TypeError, ValueError):
        return 0


def call(p, model, req, want_json, schema=None, seed=0):
    """(text, usage); usage["model"] is the model that actually answered (a local fallback may differ)."""
    if p.get("api") == "anthropic":
        text, usage = call_anthropic(p, model, req, want_json, schema)
        return text, {**usage, "model": model}
    if p.get("local"):
        model = local_model(p, model)
    text, usage = call_openai(p, model, req, want_json, schema, seed)
    return text, {**usage, "model": model}


def parse_json(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)  # reasoning models may prefix their thoughts
    m = re.search(r"\{.*\}|\[.*\]", text, re.S)
    return json.loads(m.group(0) if m else text)


def run_one(p, kind, req, want_json, task, schema=None, seed=0):
    """(text, model) or (None, None). SetupError (local server missing) propagates to the caller."""
    model, t0 = model_for(p, kind), time.time()
    total = {"in": 0, "out": 0, "cacheWrite": 0, "cacheRead": 0}
    used = [model]

    def add(u):
        for k in total:
            total[k] += u.get(k, 0) or 0
        used[0] = u.get("model") or used[0]

    def entry(ok, **extra):
        usd = cost(p, total)
        return {"task": task, "provider": p["name"], "model": used[0], "ok": ok, "ms": int((time.time() - t0) * 1000),
                "in": total["in"], "out": total["out"], **({"cacheRead": total["cacheRead"], "cacheWrite": total["cacheWrite"]} if total["cacheRead"] or total["cacheWrite"] else {}),
                **({"usd": usd} if usd is not None else {}), **extra}
    try:
        text, usage = call(p, model, req, want_json, schema, seed)
        add(usage)
        if want_json:
            try:
                parse_json(text)
            except ValueError:  # one retry with a firmer instruction
                text, usage = call(p, model, {**req, "prompt": req["prompt"] + "\n\nReply with valid JSON only."}, want_json, schema, seed + 1000)
                add(usage)
                parse_json(text)
        log(entry(True))
        return text, used[0]
    except RefusalError as e:
        add(e.usage)
        log(entry(False, err=str(e)))
        print(f"[freellm] {p['name']} gave no answer: {e}", file=sys.stderr)
        return None, None
    except (ProviderError, ValueError, KeyError) as e:
        code = getattr(e, "code", None)
        if code == 429 or (code and code >= 500):
            cd = state().get("cooldown", {})
            cd[p["name"]] = time.time() + (getattr(e, "wait", 0) or (60 if code == 429 else 20))
            state({"cooldown": cd})
        log(entry(False, err=f"{type(e).__name__} {code or ''}".strip()))
        print(f"[freellm] {p['name']} failed: {e}", file=sys.stderr)
        return None, None


def normalize(text, want_json):
    if want_json:
        return json.dumps(parse_json(text), sort_keys=True)
    return re.sub(r"\s+", " ", text.strip().lower())


def load_schema(s):
    if not s:
        return None
    return json.loads(Path(s[1:]).read_text() if s.startswith("@") else s)


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
    schema = load_schema(a.schema)
    want_json = a.json or bool(schema)
    req = {"system": a.system, "prompt": prompt,
           "images": [(mimetypes.guess_type(f.name)[0] or "image/jpeg", f.read_bytes()) for f in images]}
    kind = "vision" if images else "text"
    only = set(a.provider or [])
    key_parts = [a.system, prompt, [hashlib.sha256(data).hexdigest() for _, data in req["images"]], want_json, a.agree, a.data]
    if only:
        key_parts.append(sorted(only))
    if schema:
        key_parts.append(schema)
    if a.seed:
        key_parts.append(["seed", a.seed])
    # Which models may answer is part of the request: a model change never reuses old answers.
    key_parts.append([[p["name"], model_for(p, kind)] for p in providers()
                      if p.get("enabled", True) is not False and (not only or p["name"] in only)])
    key = hashlib.sha256(json.dumps(key_parts, sort_keys=True).encode()).hexdigest()
    cached = CACHE / "answers" / (key + ".txt")
    meta = cached.with_suffix(".meta.json")
    if cached.exists() and not a.no_cache:
        log({"task": a.task, "provider": "cache", "ok": True})
        print("[freellm] cache hit", file=sys.stderr)
        m = json.loads(meta.read_text()) if meta.exists() else {}
        for i, name in enumerate(m.get("providers", [])):
            extra = f" ({m['models'][i]}) source={m['sources'][i]}" if i < len(m.get("models") or []) and i < len(m.get("sources") or []) else ""
            print(f"[freellm] answered by {name} (cached){extra}", file=sys.stderr)
        print(cached.read_text())
        return 0
    over_budget = spent_usd() >= budget_usd()
    # A provider answers once, except a "repeatable" one (anthropic), which may give all --agree answers:
    # repeated calls are independent requests (the k-th carries an "independent check k" line).
    uses, dead, names, answers = {}, {p["name"] for p in providers() if only and p["name"] not in only}, [], []
    models_used, sources = [], []
    blocked = setup_missing = False
    deadline = time.time() + a.wait

    def available(p):
        if p["name"] in dead or uses.get(p["name"], 0) >= (a.agree if p.get("repeatable") else 1):
            return False
        return eligible(p, kind, a.data)

    while len(answers) < a.agree:
        ready = [p for p in providers() if available(p)]
        if over_budget and any(p.get("price_per_mtok") for p in ready):
            blocked = True
            dead |= {p["name"] for p in ready if p.get("price_per_mtok")}
            continue
        if not ready:
            # Every usable provider is cooling down after a 429: wait for the first to free up (bounded).
            now, cd = time.time(), state().get("cooldown", {})
            cooling = [cd[p["name"]] for p in providers() if p["name"] not in dead and cd.get(p["name"], 0) > now
                       and permitted(p, kind, a.data)]
            if not cooling or min(cooling) > deadline:
                break
            pause = max(1, min(cooling) - now)
            print(f"[freellm] all providers rate-limited; waiting {pause:.0f} s", file=sys.stderr)
            time.sleep(pause)
            continue
        p = ready[0]
        k = uses.get(p["name"], 0)
        r = req if k == 0 else {**req, "system": ((req["system"] or "") + f"\n\n(Independent check {k + 1}.)").strip()}
        try:
            text, model = run_one(p, kind, r, want_json, a.task, schema, seed=a.seed + k)
        except SetupError as e:
            log({"task": a.task, "provider": p["name"], "ok": False, "err": "SetupError"})
            print(f"[freellm] {e}", file=sys.stderr)
            setup_missing = True
            dead.add(p["name"])
            continue
        if text is None:
            if state().get("cooldown", {}).get(p["name"], 0) <= time.time():
                dead.add(p["name"])  # failed without a cooldown: don't retry it
            continue
        uses[p["name"]] = k + 1
        label = p["name"] if k == 0 else f"{p['name']}#{k + 1}"
        print(f"[freellm] answered by {label} ({model}) source={p.get('source') or p['name']}", file=sys.stderr)
        answers.append(text)
        names.append(label)
        models_used.append(model)
        sources.append(p.get("source") or p["name"])
    if len(answers) < a.agree:
        if blocked:
            print(f"[freellm] refused: estimated spend ${spent_usd():.2f} reached the budget ${budget_usd():.2f} "
                  "(FREELLM_BUDGET_USD; see `freellm.py stats`)", file=sys.stderr)
            return 5
        if setup_missing and not answers:
            return 6
        print(f"[freellm] no answer: {len(answers)} of {a.agree} answers "
              f"(data={a.data}; private data only goes to providers that don't train on prompts)", file=sys.stderr)
        return 2
    if len({normalize(t, want_json) for t in answers}) > 1:
        print("[freellm] answers disagreed; do this task in the main session", file=sys.stderr)
        for t in answers:
            print("---\n" + t, file=sys.stderr)
        return 3
    out = json.dumps(parse_json(answers[0]), indent=1) if want_json else answers[0].strip()
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(out)
    meta.write_text(json.dumps({"providers": names, "models": models_used, "sources": sources}))
    print(out)
    return 0


def models(a):
    for p in providers():
        if p.get("enabled", True) is False and not a.all:
            continue
        if p["key_env"] and not os.environ.get(p["key_env"]):
            print(f"{p['name']}: no key ({p['key_env']})")
            continue
        if p.get("local"):
            try:
                found = {k: local_model(p, model_for(p, k)) for k in ("text", "vision") if model_for(p, k)}
                print(f"{p['name']}: ready at {base_url(p)} · " + " ".join(f"{k}={m}" for k, m in found.items()))
            except SetupError as e:
                print(e)
            continue
        try:
            if p.get("api") == "anthropic":
                client = anthropic_client(p)
                ids = set()
                for m in {p.get("text"), p.get("vision")} - {None}:
                    try:
                        ids.add(client.models.retrieve(m).id)
                    except Exception as e:   # NotFoundError: the id is retired or wrong
                        print(f"{p['name']}: {m} ({type(e).__name__})")
            else:
                req = urllib.request.Request(p["base"].rstrip("/") + "/models", headers={"User-Agent": "freellm/1"})
                if p["key_env"]:
                    req.add_header("Authorization", "Bearer " + os.environ[p["key_env"]])
                with urllib.request.urlopen(req, timeout=30) as r:
                    ids = {str(m.get("id")).removeprefix("models/") for m in json.loads(r.read()).get("data", [])}
            mark = lambda m: m if not m or m in ids else f"{m} (NOT SERVED)"
            print(f"{p['name']}: text={mark(p['text'])} vision={mark(p['vision'])} · {len(ids)} models checked")
        except Exception as e:
            print(f"{p['name']}: {type(e).__name__} {getattr(e, 'code', '')}")
    return 0


def stats(a):
    rows = [r for r in usage_rows() if not a.run or r.get("run") == a.run]
    agg = {}
    for r in rows:
        s = agg.setdefault(r["provider"], {"ok": 0, "fail": 0, "in": 0, "out": 0, "usd": 0.0})
        s["ok" if r["ok"] else "fail"] += 1
        s["in"] += r.get("in") or 0
        s["out"] += r.get("out") or 0
        s["usd"] += r.get("usd") or 0
    for name, s in sorted(agg.items()):
        print(f"{name:16} ok {s['ok']:5}  failed {s['fail']:4}  tokens in {s['in']:9}  out {s['out']:8}  ${s['usd']:.4f}")
    print(f"estimated spend {'in run ' + a.run if a.run else 'total'}: ${sum(s['usd'] for s in agg.values()):.4f}"
          f" (budget ${budget_usd():.2f}, FREELLM_BUDGET_USD)")
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
    q.add_argument("--schema", help="JSON Schema for the answer (inline JSON or @file); implies --json (structured outputs)")
    q.add_argument("--agree", type=int, default=1,
                   help="N answers must match: different providers, or N independent calls to a repeatable provider (anthropic)")
    q.add_argument("--data", choices=["public", "private"], default="private",
                   help="private (default): only providers that don't train on prompts")
    q.add_argument("--task", default="adhoc", help="label for the usage log")
    q.add_argument("--provider", action="append", help="only use these providers (repeatable; for per-provider evals)")
    q.add_argument("--no-cache", action="store_true")
    q.add_argument("--wait", type=float, default=120, help="max seconds to wait when every provider is rate-limited")
    q.add_argument("--seed", type=int, default=0, help="sampling seed for seeded providers (independent repeat calls use seed+k)")
    m = sub.add_parser("models")
    m.add_argument("--all", action="store_true", help="also check disabled (phased-out) providers")
    s = sub.add_parser("stats")
    s.add_argument("--run", help="only this FREELLM_RUN id")
    a = ap.parse_args()
    return {"ask": ask, "models": models, "stats": stats}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
