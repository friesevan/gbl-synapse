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

## Rules

See `CLAUDE.md` at the project root. In short:
- Delegate only bulk, verifiable, public work that has passed its gate.
- Verify every answer with a script or `--agree 2`.
- Never send the owner's own recordings or any personal data.

Tests (offline, against a mock server): `python3 -I scripts/freellm/test_freellm.py`.
