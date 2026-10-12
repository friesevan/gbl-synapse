# Working notes for Claude

## Saving Claude usage (owner's request, 2026-10-10)

The owner is on Claude Pro and wants usage spent on work that needs Claude. In order of impact:

1. **One phase per session.** Long sessions re-send their whole context every turn. Start a new
   session for each phase (benchmark run, UI change, labelling) and point it at the relevant README
   section instead of re-reading files.
2. **Scripts over eyes.** Prefer a script that checks something (score.cjs, tests, OCR) to viewing
   images or long outputs. View images only where the pipeline and the labels disagree. Keep tool
   output short (`| tail`, `| grep`).
3. **A local model for bulk, checkable work**, through `scripts/freellm/freellm.py` only. Since
   2026-10-12 the router's only enabled provider is a local Ollama vision model (`qwen2.5vl:7b` on
   this Mac): nothing leaves the machine and nothing costs money, but it is slow (seconds per image).
   The free-tier APIs (Groq, Gemini, OVH, OpenRouter) are **phased out** (disabled in
   `providers.json`: daily quotas, two-provider agreement and model churn); Claude Haiku through the
   API is wired in but disabled, for if API billing is ever set up. Use the local model for:
   - answering Validate questions of a kind that passed its gate (`scripts/freellm/validate_llm.py`);
   - pre-labelling HUD strips;
   - drafting boilerplate that a test or schema validates; summarising long logs.

   Rules:
   - A task type is delegated only after it passes its quality gate (results in
     `scripts/freellm/evals.json`): ≥ 95% exactly right on the owner's answers, held out by video.
   - Every delegated answer is checked by a script or by two independent calls that agree with
     confidence ≥ the gate's threshold (`--agree 2`).
   - Disagreements come back to the main session or stay open for the owner.
   - Re-run the gate whenever the model changes (`run` refuses otherwise).
   - Never delegate design decisions, debugging, code that isn't covered by tests, or anything the
     owner will read as final.
   Approved task types (gate passed with the local model `qwen2.5vl:7b`, 2026-10-12):
   - `llm_hud_names`: reading nameplate names from HUD strips. 108/108 names right on 92 strips of
     the Creative Commons benchmark, none invented. Use `eval_hud.py read` as a second reader where
     the OCR is unsure; compare with the pipeline and look only where they disagree.
   No Validate kind passed (footage, result, lead, title_footage, title_league, footage_title; see
   `scripts/freellm/README.md`), so `validate_llm.py run` resolves nothing until a gate passes.
   Historical (free tiers, superseded): `hud_names` 2026-10-10 (74/74 names, mostly OVH and Gemini;
   never wired in) and `validate_footage` 2026-10-11 (22/22 "No battle footage", Groq + OpenRouter;
   its 6 "Free LLM" resolutions stay readable and reversible).
4. **Small edits stay here.** A one-line fix costs less to do than to brief, send and verify.

## Data that never goes to a remote LLM API

- The owner's own recordings (Desktop/Projects/PoGo Recorder/src/*.mp4) or frames from them
  (`validate_llm.py` never uses them, even locally).
- Trainer names, the owner's e-mail, API keys or tokens (freellm.py refuses these).
- Validation answers and artifact data.

The local model may see private frames (cropped to the phone screen, stopping before VS screens).
For a remote provider, Creative Commons YouTube crops limited to the HUD strip, open-source code and
PvPoke data count as public (`--data public`); everything else is `--data private` (the default),
which only goes to providers that don't train on prompts.

Keys (only for remote providers) live in `~/.config/gbl-synapse/env` or `~/.config/freellm/env`,
never in the project. The owner creates accounts and keys; one account per provider.

## Project pointers

- Meta Extractor algorithm and roadmap: `includes/meta/README.md`
- Benchmark and YouTube sources: `tests/meta-benchmark/` (`sources/README.md`, `labels/youtube/`)
- Tests: `node --test tests/meta-extractor.test.cjs`, `python3 -I scripts/freellm/test_freellm.py`
