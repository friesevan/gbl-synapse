# freellm: free-tier LLM helper with guards

This is a small router for checkable jobs that don't need Claude. It sends each request to the
first free-tier provider in `providers.json` that:

- has a key,
- isn't rate-limited, and
- may receive this data (`--data private` only goes to providers that don't train on prompts).

On a 429, 5xx or timeout it moves to the next provider and puts the failed one on a cooldown.
Answers are cached, and every call is logged to `~/.cache/freellm/usage.jsonl`.

The provider list comes from [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis),
a curated list of 16 providers. That repo doesn't route requests itself; this script does.

## Setup (owner)

1. Create free accounts and keys. Recommended:
   - Groq, for text. It doesn't train on API prompts.
   - Google AI Studio (Gemini), for vision. Its free-tier prompts may be used by Google, so send it
     public data only.
   - Optionally Mistral: opt out of training in its console, then set `"trains": false` in
     `providers.json`.
2. Put the keys in `~/.config/freellm/env`, outside the project:
   ```
   GROQ_API_KEY=...
   GEMINI_API_KEY=...
   ```
3. Run `python3 -I scripts/freellm/freellm.py models` and fix any model id marked NOT SERVED.
4. Run the quality gate: `python3 -I scripts/freellm/eval_hud.py`.

## Usage

```
freellm.py ask "Return JSON {...} for ..." --json --data public --task label_hud --image strip.jpg
freellm.py ask - --agree 2 < prompt.txt     # two providers must give the same answer
freellm.py stats
```

Exit codes:
- 0: ok
- 2: no provider answered
- 3: providers disagreed (do it in the main session)
- 4: refused, because the input contains an e-mail, key or token, or is too large

Per-provider evals: `--provider NAME` (repeatable) restricts the router; cached answers keep which
providers gave them. Providers may add request fields with `body` / `body_text` / `body_vision`.

## Private vision route (2026-10-11)

Frames from non-Creative-Commons videos are `--data private`, so they only go to `trains: false`
providers. Two exist:

- `groq`: vision model `qwen/qwen3.8-27b`, with reasoning off. Its limits are 8,000 tokens/min
  (about 4 image requests a minute) and **200,000 tokens/day**. A footage strip costs about 1,600
  tokens and a result strip about 1,000.
- `openrouter-nolog`: the same OpenRouter key, with `provider.data_collection = "deny"`. OpenRouter
  then routes only to endpoints that neither retain nor train on prompts. The model is `dots-3-note-preview:free`.
  - Gemma `:free` runs only on Google AI Studio, so it is excluded.
  - The free key allows **50 requests a day** across all free models. This is the bottleneck. Buying $10 of
    credits would raise it to 1,000.

## Validate questions (`validate_llm.py`)

```
validate_llm.py gate --kind footage|result [--first-only]   # score against the owner's answers -> evals.json
validate_llm.py run  --kind footage|result [--dry-run]      # resolve open questions (needs a passed gate)
```

How a question is resolved:
- Groq answers first. OpenRouter-nolog is asked only when Groq's answer could resolve the question,
  which saves its quota.
- Both providers must give the same answer.
- The app stores it through `POST /api/validation/resolve` as a `freellm` resolution. It is
  reversible, shown as "Free LLM · groq + openrouter-nolog" under Model resolved, and is never a
  training label.
- Human answers and Reopen win. Audit spot checks stay open, and about 1 in 10 agreed answers is
  also left open as a spot check.

Kinds:
- **footage**: YouTube's public auto-thumbnails `hq1-3` (frames at 25/50/75%) are downscaled into
  one 1080×270 strip.
  - It resolves only "No battle footage". Other answers need a reprocess, so a person gives them.
  - It is only asked when the harvester's title policy (`policy.py`) also rates the video "no".
- **result**: up to six frames of the phone screen, 216 px wide, from 8 s before to 10 s after the
  battle end, taken from the local copy.
  - Frames within 6 s of the next battle's start are dropped, because its VS screen shows trainer names.

Gate: at least 10 resolved answers, with ≥ 95% exactly right (`evals.json`, `validate_<kind>`).

Results, 2026-10-11:
- **footage passed.**
  - 22/22 right, covering 22 of 36 owner answers (all 36 from different videos).
  - Without the title condition it would fail at 25/28: three videos with battles showed none in
    their three thumbnails.
  - On the open queue (244), 49 passed the title check. Both models agreed on "none" for 9; 3 of those
    stay open as spot checks, so **6 resolve**.
  - The run took 6 minutes. The app must be restarted to load the resolve route. Then re-run
    `run --kind footage`: answers are cached, so this makes no new calls.
- **result not measured yet.** Both providers' daily quotas ran out. Most of these battles cut straight
  into the next one with no result screen, so expect low coverage.

## Rules

See `CLAUDE.md` at the project root. In short:
- Delegate only bulk, verifiable, public work that has passed its gate.
- Verify every answer with a script or `--agree 2`.
- Never send the owner's own recordings or any personal data.

Tests (offline, against a mock server): `python3 -I scripts/freellm/test_freellm.py`.
