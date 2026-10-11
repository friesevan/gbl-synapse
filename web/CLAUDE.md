# Working notes for Claude

## Saving Claude usage (owner's request, 2026-10-10)

The owner is on Claude Pro and wants usage spent on work that needs Claude. In order of impact:

1. **One phase per session.** Long sessions re-send their whole context every turn. Start a new
   session for each phase (benchmark run, UI change, labelling) and point it at the relevant README
   section instead of re-reading files.
2. **Scripts over eyes.** Prefer a script that checks something (score.cjs, tests, OCR) to viewing
   images or long outputs. View images only where the pipeline and the labels disagree. Keep tool
   output short (`| tail`, `| grep`).
3. **Free-tier APIs for bulk, checkable, public work**, through `scripts/freellm/freellm.py` only.
   Use them for:
   - pre-labelling HUD strips of Creative Commons videos;
   - drafting boilerplate that a test or schema validates;
   - summarising long public logs.

   Rules:
   - A task type is delegated only after it passes its quality gate
     (`scripts/freellm/eval_hud.py`, results in `scripts/freellm/evals.json`).
   - Every delegated answer is checked by a script or a second provider (`--agree 2`) before use.
   - Disagreements come back to the main session.
   - Never delegate design decisions, debugging, code that isn't covered by tests, or anything the
     owner will read as final.
   Approved task types (gate passed):
   - `hud_names`, 2026-10-10: reading nameplate names from HUD strips of Creative Commons videos.
     It got 74/74 names right, named all 37 strips that showed nameplates, and invented none for
     strips without them. This covers 4 videos from 2 channels, mostly OVH and Gemini. Use it to
     pre-label new YouTube videos. Compare its output with the pipeline and look only where they
     disagree. Re-run `eval_hud.py` when providers or models change.
   - `validate_footage`, 2026-10-11: closing "No battles found" Validate questions as "No battle
     footage" (`scripts/freellm/validate_llm.py`, private route: Groq + OpenRouter-nolog). The
     gate scored 22/22 right, covering 61% of the 36 owner answers. It needs both models to agree on
     three YouTube auto-thumbnails, and the title policy must also say "no".
     - Caveat: `policy.py` was tuned on these same 36 answers, so the precision is optimistic. The
       spot checks it leaves open keep measuring it.
     - The resolutions are reversible "Free LLM" records. They are never training labels.
4. **Small edits stay here.** A one-line fix costs less to do than to brief, send and verify.

## Data that never goes to a free-tier API

- The owner's own recordings (Desktop/Projects/PoGo Recorder/src/*.mp4) or frames from them.
- Trainer names, the owner's e-mail, API keys or tokens (freellm.py refuses these).
- Validation answers and artifact data.

Creative Commons YouTube crops limited to the HUD strip, open-source code and PvPoke data count as
public (`--data public`). Everything else is `--data private` (the default), which only goes to
providers that don't train on prompts.

Use one account per provider; don't stack several accounts to multiply quotas, which most free
tiers' terms forbid. The owner creates accounts and keys. Keys live in `~/.config/freellm/env`,
never in the project.

## Project pointers

- Meta Extractor algorithm and roadmap: `includes/meta/README.md`
- Benchmark and YouTube sources: `tests/meta-benchmark/` (`sources/README.md`, `labels/youtube/`)
- Tests: `node --test tests/meta-extractor.test.cjs`, `python3 -I scripts/freellm/test_freellm.py`
