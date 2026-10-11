# YouTube harvester: progress and to-dos (handoff)

Last updated: 2026-10-11, ~01:30. Pass this file to the next agent.

## Goal
Overnight, unattended: find as many Pokémon GO battle videos on YouTube as possible (newest first),
download them, run the Meta Extractor on them, and put every decision that needs a person into the
site's **Validate** tab. Videos stay local and are deleted after processing; only derived data is committed.
The owner lifted the Creative Commons-only download rule on 2026-10-11 (private analysis only).

## Run it
```bash
cd ~/Desktop/Projects/GBL\ Synapse && git pull && bash web/scripts/yt-harvest/overnight.sh --hours 9
```
- Progress: `tail -f ~/Desktop/Projects/PoGo\ Recorder/src/yt-harvest/harvest.log`
- Stop: Ctrl-C or `touch ~/Desktop/Projects/PoGo\ Recorder/src/yt-harvest/STOP`. Re-run to resume.
- Review: `python3 web/run_app.py`, then Meta Extractor › Validate. Harvested questions load automatically.
- Afterwards: commit `web/tests/meta-benchmark/sources/registry.json` (metadata only).
- Don't run a neural-network training run at the same time: it slows extraction about tenfold.

## Done this session
- **One YouTube request per downloaded video.** Videos with battle-like titles go straight to the
  download queue; the download's extraction supplies the metadata, applies the policy, then downloads
  (`download_one`, `DL_CLAIM`, `SKIPPED`). Queue is newest first, by upload date or the approximate date
  from channel listings. Tested live: metadata and download in one 8 s request.
- **Continuous extractor pool** (`extract_worker` / `extract_one`): one `run-node.cjs` per video, default
  cores/2 workers, so a long video no longer holds up a whole batch. Measured alone: 5.7–7.7× real time
  per worker. The 0.7× seen in the first smoke run was CPU contention with the 10-hour trainer run.
- **Optional YouTube Data API** (`ytapi.py`): with `YOUTUBE_API_KEY` in `~/.config/gbl-synapse/env`,
  metadata comes 50 videos per request (≈500k/day free) and doesn't touch the web player that triggers
  bot checks. No key is configured yet; the owner must create one (Google Cloud › YouTube Data API v3).
- **Validate questions for every processed video** (`validate.py`, `export_validation`):
  - extractor questions (fast move, Shadow, form, result) via `export-questions.cjs` with `NO_FRAMES=1`;
  - league/cup questions (once per video if ambiguous; per battle for compilations or disagreeing battles);
  - "No battles found" questions when the extractor finds nothing.
  Written to `PoGo Recorder/src/yt-harvest/validation/<id>/` and collected into
  `web/tests/meta-benchmark/results/validation-inbox.json` (git-ignored).
- **Validate tab** (`web/includes/meta/validation.js`, `meta.css`): auto-loads the inbox when served
  locally (re-checks every 5 min; not copied into localStorage), **Import questions…** (for claude.ai's
  shared store), an embedded **YouTube player** at the question's moment when there's no local file
  (Restart, plus an "Open on YouTube at m:ss" link), **Download answers** (JSON), a "From the overnight
  harvester" source filter, and "Creator won/lost" wording for creator videos. Checked in the browser.
- Tests: `python3 -I web/scripts/yt-harvest/test_yt_harvest.py` (28 pass), `node --test
  web/tests/meta-extractor.test.cjs` (37 pass). Docs: `web/tests/meta-benchmark/sources/README.md`.

## In progress (separate agent)
- **Screen locator misses overlay layouts.** `oqxO3iZePPU` (Reis2TheOccasion: centre phone column
  inside a branded frame with a team card) gives `box:null` and 0 battles. An agent was fixing
  `web/tests/meta-benchmark/locate-screen.cjs` / `web/includes/meta/screen.js`. Check `git log` for
  its commit. If it isn't there, redo it: this layout is common, so it costs a lot of footage.
  The video is kept locally in `PoGo Recorder/src/youtube/` for testing.

## To-dos
1. **Fold answers back.** Use the Download answers JSON to:
   - write league/cup answers into `registry.json` (`leagueGuess`) and per-battle labels;
   - feed `footage: none` answers back into `policy.relevance()` as negative examples;
   - make extractor answers work with `fold-answers.cjs` (it expects a folder of answer docs).
   None of this is written yet.
2. **Re-queue missed videos.** After the screen-locator fix, re-process videos answered "Yes, battles
   are shown". They were deleted, so this needs a re-download; add a `requeue` command.
3. **Shared-store limits on claude.ai.** The Validate tab subscribes with `limit(1000)` questions. A
   full night can produce more. Paginate, or import only the newest N videos.
4. **Data API key.** Once the owner adds it, confirm the log says "YouTube Data API (key found)".
   Consider raising `--meta-per-min` defaults, since only downloads then use the web player.
5. **Speed ideas, not measured yet:**
   - decode 720p for portrait uploads;
   - skip analysis outside battle chapters for long streams;
   - run `run-node` HUD OCR less often on 60 fps sources.
6. **Use the team card in overlay layouts.** Overlay frames often show the creator's team and
   movesets. That could settle "my side" fast-move questions without asking anyone.
7. **League labels.** "Mega Master League" titles map to Master League. Schedule gaps: 2026-08-25 is
   missing, and Season 2's dates differ between sources (see `data/gbl-schedule.json`).
8. **Wire league data into extraction.** `export_validation` runs after `write_league_refinement`, but
   the per-battle league isn't yet passed into the Meta Extractor's species-candidate priors.

## Files
- `harvest.py`: pipeline (discover, metadata, download, extract, validate, registry).
- `validate.py`: harvester questions and the inbox.
- `ytapi.py`: Data API.
- `league.py` / `data/gbl-schedule.json`: schedule and cup rules.
- `policy.py`: relevance and download policy.
