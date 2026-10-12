# freellm: LLM router with guards (local model by default)

A small, provider-agnostic router for checkable jobs that don't need Claude. It sends each request
to the first provider in `providers.json` that:

- is enabled,
- has a key (if it needs one) and isn't rate-limited, and
- may receive this data (`--data private` only goes to providers that don't train on prompts).

On a 429, 5xx or timeout it moves to the next provider and puts the failed one on a cooldown.
Answers are cached, and every call is logged to `~/.cache/freellm/usage.jsonl` (tokens, latency,
model and, for paid providers, estimated USD).

## Providers (2026-10-12)

| Provider | Status | What |
|---|---|---|
| `ollama` | **default, only enabled** | A local vision model behind Ollama's OpenAI-compatible endpoint (`http://localhost:11434/v1`). `qwen2.5vl:7b` (fallbacks `qwen3-vl:8b`, `llama3.2-vision:11b`). Nothing leaves the machine, so private data is fine. No quota, no cost. |
| `anthropic` | disabled | Claude Haiku 5.5 (`claude-haiku-5-5`) through the official `anthropic` SDK, for if API access is ever available (the owner has a Claude subscription, not API billing). Anthropic doesn't train on API inputs by default, so it is `trains: false`. |
| `groq`, `gemini`, `mistral`, `openrouter-nolog`, `openrouter`, `ovh` | disabled, being phased out | The free tiers: daily quotas, two-provider agreement and model churn made them impractical. Kept so the old `freellm` resolutions stay explainable; remove later. |

Endpoint and model are configurable: `FREELLM_OLLAMA_BASE`, `FREELLM_OLLAMA_MODEL` (or edit
`providers.json`). If the configured model isn't installed, the first installed fallback is used.

## Setup (owner)

Local model (done 2026-10-12 on the M2 Max):

```
brew install ollama
ollama serve                     # or: brew services start ollama
ollama pull qwen2.5vl:7b         # ~6 GB
python3 -I scripts/freellm/freellm.py models     # "ollama: ready at ... vision=qwen2.5vl:7b"
```

If the server isn't running or lacks the model, `freellm.py` exits with code 6 and prints these
commands; it never installs or pulls anything itself.

Claude API (only if API billing is ever set up): `python3 -m venv ~/.venvs/gbl-synapse &&
~/.venvs/gbl-synapse/bin/pip install anthropic`, put `ANTHROPIC_API_KEY=...` in
`~/.config/gbl-synapse/env` (never in the project), set `"enabled": true` on `anthropic`, and run the
scripts with `~/.venvs/gbl-synapse/bin/python -I`. Haiku 5.5 costs $0.10 / $0.50 per million input /
output tokens (prompts up to 100K tokens); `freellm.py` logs the estimated cost of each call and
refuses paid calls once the log's total reaches `FREELLM_BUDGET_USD` (default $5). Haiku 5.5 rejects
non-default `temperature`, so none is sent; JSON comes from structured outputs.

## Usage

```
freellm.py ask "Return JSON {...} for ..." --json --task label_hud --image strip.jpg
freellm.py ask "..." --schema '{"type":"object",...}' --image a.jpg   # JSON constrained by a schema
freellm.py ask - --agree 2 < prompt.txt     # two answers must match (two independent calls to a repeatable provider)
freellm.py models                           # is each enabled provider reachable and serving its model?
freellm.py stats [--run ID]                 # calls, tokens, estimated USD
```

Exit codes: 0 ok · 2 no provider answered · 3 answers disagreed · 4 refused (e-mail, key or token in
the input, or too large) · 5 spending budget used up · 6 local model server not ready.

`--agree N` on a `repeatable` provider makes N independent calls (seeds `seed+k`, and an "independent
check k" line from the second on). `--provider NAME` (repeatable) restricts the router; the cache
key includes which provider/model may answer, so a model change never reuses old answers.

## Validate questions (`validate_llm.py`)

```
validate_llm.py gate --kind KIND [--limit N]               # score against the owner's answers -> evals.json (llm_KIND)
validate_llm.py run  --kind KIND [--limit N] [--dry-run]   # resolve open questions (needs a passed gate on the same model)
validate_llm.py bench [--n 6]                              # latency per call for each kind
```

Kinds, in priority order:

| Kind | Questions | Input |
|---|---|---|
| `footage` | "No battles found" (battle type: all six footage options) | YouTube's public auto-thumbnails hq1-3 (25/50/75%), one 1080×270 strip, plus the title |
| `result` | "Battle N: who won?" (creator = "you") | Up to six phone-screen frames, 288 px wide, from 8 s before to 10 s after the battle end; frames within 6 s of the next battle's start (its VS screen shows trainer names) are dropped |
| `lead` | "Which Pokémon did the opponent lead with?" — the nameplate second reader | The top HUD strip (Pokémon nameplates only) at battle start + 3 s and + 6 s |
| `title_footage` | "No battles found" from text only (battles / Rocket / championship / none) | Title, channel, length and the description without links, e-mails, handles, trainer codes or in-game names |
| `title_league` | League or cup of a battle, from text only | The same text plus the CPs the extractor saw and the question's options |
| `footage_title` | "No battles found" (battles / Rocket / championship / none) | `footage` and `title_footage` together: all four calls must agree (two independent modalities) |

**Agreement rule.** Two independent calls must give the same answer: the second lists the options in
a different (question-seeded) order with a different seed, and for `lead` reads a different frame.
Each must report confidence ≥ the threshold the gate chose. Otherwise the question stays open. About
1 in 10 agreed answers also stays open as a spot check, so precision keeps being measured.

**Gate.** The owner's human answers (from the app, `GET /api/validation`), split into two halves by
video. Each half's confidence threshold is chosen on the other half (lowest threshold with ≥ 95%
exactly right); the pooled held-out answers must be ≥ 95% exactly right with ≥ 10 resolved. `run`
uses the strictest of the per-half and whole-set thresholds. The `lead` gate adds the hand-labelled
Creative Commons benchmark battles (`tests/meta-benchmark/labels/youtube`, `oppLead`), because the
owner hasn't answered lead questions yet. Each gate is recorded in `evals.json` as `llm_<kind>` with
date, n, precision, coverage, threshold, model, latency and wall time. `run` refuses to resolve when
the gate failed or was measured on a different model: re-run the gate after any model change.

**Resolutions** go to the app through `POST /api/validation/resolve` with the provider's `source`
(`local-llm` for Ollama, `haiku` for Claude, `freellm` for the old free-tier records). They are
reversible, shown under Model resolved as "Local LLM · <model> <confidence>", and never training
labels. Human answers and Reopen win; audit questions stay open. Footage resolutions don't requeue a
reprocess (resolutions have no pipeline side effects); a person's answer still does.

Commands, from `web/` (the app must be running on port 65246; restart it after pulling this change
so the resolve route accepts `local-llm`):

```
python3 -I scripts/freellm/freellm.py models
python3 -I scripts/freellm/validate_llm.py gate --kind footage
python3 -I scripts/freellm/validate_llm.py gate --kind result
python3 -I scripts/freellm/validate_llm.py gate --kind lead
python3 -I scripts/freellm/eval_hud.py                       # nameplate reading on the CC benchmark -> llm_hud_names
python3 -I scripts/freellm/validate_llm.py gate --kind title_footage
python3 -I scripts/freellm/validate_llm.py gate --kind title_league
python3 -I scripts/freellm/validate_llm.py gate --kind footage_title     # reuses the cached footage and title answers
python3 -I scripts/freellm/validate_llm.py run --kind <each kind that passed>   # add --dry-run to see the counts first
```

Answers and frames are cached in `~/.cache/freellm`, so re-running a gate or a run after an app
restart makes no new model calls.

## Results, 2026-10-12 (qwen2.5vl:7b on the M2 Max, harvester running alongside)

**No kind passed, so nothing was resolved.** Every gate is in `evals.json` (`llm_*`).

| Kind | n (videos) | Held-out resolved | Right | Coverage | First call right | s per call |
|---|---|---|---|---|---|---|
| `footage` | 36 (36) | 0 | – | 0% | 28/36 | 8.2 |
| `footage_title` | 36 (36) | 12 | 11 (91.7%) | 33% | – | 8.2 + 1.4 |
| `result` | 46 of 51 had frames (13) | 0 | – | 0% | 21/46 | 7.0 |
| `lead` | 22 benchmark battles (4) | 7 | 5 (71%) | 32% | 18/22 | 6.4 |
| `title_footage` | 36 (36) | 5 | 4 (80%) | 14% | 21/36 | 1.4 |
| `title_league` | 2 (2) | 0 | – | – | 0/2 | 1.3 |

**Nameplate reading passed** (`eval_hud.py` → `llm_hud_names`): 108 of 108 names right on 92 HUD strips
from the Creative Commons benchmark, all 53 strips with nameplates read, none invented; 5.9 s per strip.
It is available as a question-free second reader for low-confidence OCR:

```
python3 -I scripts/freellm/eval_hud.py read VIDEO x0,y0,x1,y1 T [T ...]   # one JSON line per time; two calls must agree
```

Wiring it into the extractor itself (`core.js`, `run-node-v2.cjs`) is left for a session that may change
those files.

What went wrong:
- **Confidence carries no information.** The model says 0.95 for nearly everything, right or wrong, so the
  threshold can't separate good answers from bad ones. Only agreement filters.
- **footage**: two independent calls agree on wrong answers, mostly "none" for videos with only short clips
  ("partial") or battles the three thumbnails missed. The thumbnails and title together (`footage_title`)
  got 11 of 12 right; the miss was a Max battle (a Gigantamax raid boss) that both read as a trainer battle.
  All 10 combined "none" answers were right, but resolving only "none" would be a scope picked after seeing
  these answers, so it wasn't done.
- **result**: the first call says "Win" for almost every battle (21/46 right, the share of wins), and the
  second call, with the options reordered, often switches to "Loss". The 7B model doesn't read the end
  screen from these frames.
- **lead**: the nameplates are read correctly, but the two reads are 3 s apart and the opponent sometimes
  switches in between, so they disagree. The two "wrong" agreed answers look like label errors: in
  cyu1yFuGtZA battle 2 the HUD shows no nameplates at 298 s and 301 s and Weezing at 305 s, while the
  label says Virizion led. The benchmark labels' battle starts are only ±4 s accurate. Owner answers to
  lead questions would make a fairer gate.
- **title_league**: only 2 owner answers so far; at least 10 resolved are needed.

Next steps, if wanted: try a stronger local model (`qwen3-vl:8b`, or a 32B model if memory allows) by
setting `FREELLM_OLLAMA_MODEL` and re-running the gates; answer ~10 lead and league questions in the
app so those gates have owner answers.

## Throughput (M2 Max, 64 GB)

Measured per call, one image (1,500–1,800 prompt tokens): 6.4–8.2 s, with the harvester's ffmpeg jobs
running at the same time; text-only calls take 1.3–1.4 s. The model loads in ~10 s on first use. One
question costs one call, or two when the first answer could resolve it (four for `footage_title`).

| Kind | Open | ≈ s per question | ≈ total |
|---|---|---|---|
| footage (+ title) | 261 | 17 | 1.2 h |
| result | 1,246 | 14 | 4.8 h |
| lead | 227 | 11 | 0.7 h |
| title_league | 284 | 3 | 0.2 h |

That is about 7 hours for the ~2,000 questions these kinds cover. The whole open queue (~4,900
questions, 1–4 images each) would take roughly 16–55 hours of continuous GPU time at 12–40 s per
question. Run order once gates pass: footage (+ title) and lead first (short, cheap, and they close
whole videos or confirm teams), then result (the bulk), then the text-only kinds.

## History

- 2026-10-10/11: free-tier providers. `hud_names` passed (74/74, mostly OVH and Gemini) but was
  never wired in. `validate_footage` passed (22/22, 61% of 36 owner answers, Groq + OpenRouter-nolog
  agreeing and the title policy saying "no") and closed 6 questions (source `freellm`, still
  readable). `validate_result` failed on 2026-10-12: Groq alone got 4 of its 14 resolvable answers
  right (it calls most wins "Loss"), and a 429 cooldown stopped the run (`evals.json`, `validate_result`).
- 2026-10-12: free tiers phased out; local Ollama model by default; Claude Haiku kept disabled.

## Rules

See `CLAUDE.md` at the project root. In short:
- Delegate only bulk, verifiable work that has passed its gate.
- Verify every answer with a script or two agreeing calls.
- Never send the owner's own recordings or any personal data to a remote provider.

Tests (offline, against a mock server and a fake SDK): `python3 -I scripts/freellm/test_freellm.py`.
