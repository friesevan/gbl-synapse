**2026-10-11 retention update:** New harvester runs retain complete source videos by default. `--discard-videos` explicitly restores the former deletion behavior. Existing processes keep their loaded settings. Persistent exact OCR and versioned screen/range caches now support repeated extraction tests; see `VIDEO-ANALYSIS-PERFORMANCE.md` at the repository root for measurements, inventory commands and experimental quality controls. Earlier deletion descriptions below describe the prior behavior.

# YouTube harvester handoff — 2026-10-11

The local UI now controls the resumable harvester and the review/learning loop.

## Start and review

From the GBL Synapse project root, run `python3 web/run_app.py`. Open **Meta Extractor → Analyze & review** for harvesting and **Validate** for review.
The **YouTube harvester** panel starts/resumes a run, sets hours and extraction workers, stops safely,
and shows current jobs, counts, recent activity and errors. The UI uses the existing yt-dlp environment;
it does not install packages. If setup is missing, use `bash web/scripts/yt-harvest/overnight.sh` in a terminal.

Stopping prevents new work, finishes active video extraction/requests, saves results, then releases the
work-directory lock. A long video can take time to finish. The detached harvester survives closing the
web server; use **Stop safely** before closing it if you want harvesting to stop. Restarting resumes SQLite
state. Existing CLI runs are recognized. Videos remain local outside Git and are deleted after processing.
The prior owner authorization permits non-CC footage for private analysis; permission metadata stays recorded.

## Live queue and learning

- Polling updates every four seconds while harvesting/refitting and every 15 seconds when idle. New questions
  appear without refreshing the page or interrupting the current video.
- **Priority** uses an impact heuristic based on uncertainty, affected species, repeat coverage and audit need.
  **Type** groups Shadow, Form, Fast move, Battle outcome, League/cup and Battle footage questions.
  **Video** groups questions by video priority, then timestamp; playback seeks within the same player.
- Answers persist atomically in the work directory, with a browser retry journal. Human corrections and
  original predictions are retained. “Not sure” remains unresolved and never trains the model.
- The current extractor learns **Bayesian species/move priors**, not a new neural network. A starting default
  refits after **eight new useful answers**; the separate initial review goal is **24 diverse confirmations**.
  Corrections and league changes refit sooner. These are practical defaults, not a measured optimum.
- Refit uses saved HP/cadence/aura/charged-move evidence and historical game data, without video decoding.
  Only runs with queued or answered questions need reassessment. Legacy human aggregate priors are frozen
  once in `baseline-learned.json`, then combined idempotently with new human labels.
- Model-resolved questions leave the open queue but remain in a reversible **Model resolved** audit.
  Human answers always win.
- **Fast moves and forms (v4):** a fast move or form resolves at the confidence threshold picked by
  video-grouped held-out checks, over every traceable human label. The threshold must give ≥ 95%
  right answers on ≥ 30 answers from ≥ 5 videos, with a Wilson lower bound ≥ 0.90. It is never below
  0.90, and the margin to the runner-up must be ≥ 0.8.
  - Currently: fast moves resolve at p ≥ 0.90 (80/81 held out). Forms do not qualify yet (21 answers).
  - The label-free model must agree, and audits stay open.
  - Evidence settings are refitted every 24 new fast-move/form answers (`movefit-fit.cjs`,
    `learning/movefit-params.json`).
  - Details: `includes/meta/README.md`, section *Fast moves and forms from 228 human labels*.
- **Shadow:** automatic resolution requires at least 98% posterior confidence, a 0.90
  winner margin, four measured hits, eight same-species/type human labels from at least three other videos,
  and 50 high-confidence held-out video checks for that question type with a Wilson lower bound of 90%.
  All labels from the held-out video and untraceable legacy aggregates are excluded from calibration.
  The new-label-only model must agree with the live model. Audit questions stay open until a person answers.
  These gates express conservative confidence, not certainty.
- **Shadow** (2026-10-11) uses the learned Shadow classifier instead (`includes/meta/shadow-model.js`,
  README "Shadow classifier"). Out of fold by video it was right 74.5% of the time (old posterior 62.5%), with
  log-loss 0.513 (old 0.653). "Not Shadow" auto-resolves when held-out calls at that confidence were ≥ 95% right
  over ≥ 25 calls from ≥ 5 videos (now p ≤ ~0.12: 27/28). "Shadow" never auto-resolves yet. A dry run on the live
  queue resolves 15 of 135 open Shadow questions. These take effect on the first refit after `git pull`;
  restart the app so `feedback.py` also passes the archived labels.
- Two deterministic confident-call spot checks per video feed calibration; `AUDIT=0` explicitly disables them.
- League/cup and outcome feedback creates per-battle labels. Video-wide league labels update the registry
  and extraction CP cap. “No footage” informs relevance; “battles are shown” requests reprocessing with a
  local file or a fresh download. Identical feedback retries do not create duplicate requeue requests.

## Throughput, disk and battle types (2026-10-11, second pass)

Takes effect when the harvester is restarted.

- **Keyframe pre-screen** (`tests/meta-benchmark/probe.cjs`). Before the full pass, each video's keyframes
  (one every ~2–6 s on YouTube) are decoded single-threaded. The phone screen is located on 32 of them
  (falling back to the extractor's own 16-seek search), and every keyframe is tested for the battle HUD
  (`core.js` readHud/calibrate). Hits become padded ranges (30 s before, 45 s after, gaps ≤60 s merged).
  - No HUD: the full pass is skipped and the "No battles found" question says so.
  - HUD in under 80 % of the video: `run-node.cjs` decodes only those ranges (`RANGES=s-e,…`, one tracker,
    one output, so no merge step), with `CROP` set to the located box.
  - Otherwise the whole video is analysed.
  - A reviewer's "battles are shown" reprocess always analyses the whole video. `--no-probe` disables the
    pre-screen.
  Measured numbers are in sources/README.md.
- **Defaults.** 2/3 of the cores as extraction workers (8 on 12) and `--ffmpeg-threads 1`. A
  single-threaded decoder uses about 7 % less CPU per video-second than ffmpeg's auto threading, and the
  CPU is the limit. FPS and HUD_EVERY are unchanged. `bench-workers.cjs` re-measures worker counts on an
  idle machine.
- **Disk.**
  - Downloads pause while more than `--max-backlog-hours` (2) of extraction work is queued. The estimate
    uses the measured worker rate. The 150 GB budget still applies.
  - A video is deleted when it is processed, fails, is skipped after metadata or is a duplicate; failed
    and partial downloads (`<id>.*`) are deleted too.
  - At startup, the download dir is cleaned of files that the state DB marks processed, deleted,
    duplicate or partial, and of `<11-char id>.<ext>` files it doesn't know. Each one is logged. Other
    names, subfolders and symlinks are never touched.
  - Kept: results, questions, labels, and the state DB plus registry (id, sha256, title, channel,
    duration). Duplicates now keep their sha256 and `duplicateOf` in the registry. A requeue downloads
    again on demand.
- **Relevance** (`policy.py`, learned from 36 footage answers):
  - Always vetoed: Greek basketball ("STOIXIMAN GBL", score highlights) and Pokémon Champions, the
    separate game.
  - Vetoed unless the title also has a PvP marker (league, cup, GBL, PvP, rank words, championship
    words): Max/Gigantamax battles, raids, Community Day, events, tips, news-like topics, radars,
    hundos and similar. With a marker they only get a penalty.
  - Checked against real labels: 19 of 26 "no footage" videos are now refused before download. All 46
    videos with battles still pass except one Rocket-grunt "EVENT" video.
- **Team Rocket.**
  - `league.rocket_evidence` (in `refine_battle_league` output and `<id>.leagues.json`) flags a battle when
    the opponent's CPs exceed what a player's Pokémon can reach (15/15/15, level 51). It needs two such
    Pokémon, or one at ≥1.5× (readings above 6× are misreads). It also flags two opponent CPs above the
    cap the creator's team sits at; truncated CP reads are ignored.
  - Flagged battles get a "Team Rocket battle?" question. Every league question offers "Team Rocket
    battle".
  - Rocket battles still train fast moves, Shadow and outcomes. They are excluded from observed meta
    (`observed.py`, `observed-core.js`) and from team-training exports (`core.js` eligible).
- **Championships.**
  - Strong title or channel evidence (regional/international/world championship, NAIC/EUIC/LAIC/OCIC, top
    cut, grand final, Play! Pokémon) sets the `championship` format. Battles are `championship[@cp]`,
    shown as their own "Championship" league in observed meta.
  - Weaker words, or two phone screens found by the probe, only ask the "perspective" question.
  - The perspective question offers left / right / single / switches / not a championship. Left or right
    re-analyses that phone. "Not a championship" returns the video to GBL.
- **Obscured.** The footage answer "obscured" sets `labels.videoType`. No requeue is created, and later
  requeue requests are refused (`.obscured`).
- **New Validate questions:**
  - Team Rocket confirmation.
  - Championship perspective.
  - Opponent lead: at most two per video, for complete, cleanly started teams. A confirmed lead puts that
    Pokémon first and marks `leadConfirmed` in observed meta.
  - The "no battles" detail now says whether the probe saw a HUD.
- **Further question ideas (not built):**
  - Species check when nameplate OCR confidence is below ~60 (`full[].*.confidence` is saved).
  - "Is this the same creator team?" for team pooling.
  - Language of the game UI: no longer needed; the extractor recognises it (status 2026-10-11 ~19:00 below).

## Files and checks

`web/run_app.py`: local-only, same-origin API/server. `service.py`: lifecycle/progress/process locks.
`feedback.py`: durable labels, background refits and audit state. `learning-loop.cjs` / `refit.cjs`:
offline fitting/calibration. `validation.js` / `validation-policy.js`: UI and queue order.

```bash
python3 -I -m unittest discover -s web/scripts/yt-harvest -p 'test_*.py'
node --test web/tests/meta-*.test.cjs
node artifact/build.cjs /private/tmp/gbl-artifact-preview
```

The overlay screen fix now locates `oqxO3iZePPU` at source crop `[710,0,1210,1080]` (seven of eight
sampled frames read a HUD). A 60-second excerpt recovered one battle in 15.7 seconds on this machine;
this is a layout smoke check, not a sustained throughput benchmark.

## Remaining independent improvements

No YouTube Data API key is configured; adding one remains the owner's Google Cloud setup task.
Hosted artifact/shared-store review has no access to local start/stop APIs. Its store still has a 1,000
question subscription cap, now clearly indicated; import files to review the remainder.
Team-card OCR, lower-resolution decode trials, and uncertain schedule gaps remain separate experiments
(battle-range skipping is now the probe). Do not run neural team training concurrently when measuring extraction speed.

## Observed meta browser

The new **Observed meta** dashboard reads `/api/observed-meta` automatically, alongside reviewed browser/shared observations. League/cup/time-range grouping, selected team occurrences, team-perspective outcomes, source timestamps and saved battle graphs are documented in the root `HANDOFF-2026-10-11-OBSERVED-META.md`. Detected lineups are provisional; incomplete teams stay separate.

**League › Cup › Period (2026-10-12).** Controls are a tree: league select → cup select ("Open league" is the
`all` cup; "All cups" also exists) → period chips grouped by GBL season from `gbl-schedule.json`
("Season 28 · Twilight Trails"). Chips multi-select and aggregate; "All N repeats in Season N" picks every
period of the cup in that season; "Unassigned" holds battles without a period. The choice is saved in
`localStorage` (`pvp-observed-view-v2`) and survives polls.

**Schedule check** (`observed.py _period`, per battle `cupRange.status` / `reason` / `contradiction`):
- `confirmed`: a verified recording date inside a period of the observed cup;
- `estimated`: the upload date with the 14-day recording lag overlaps exactly one period of the cup;
- `estimated` + `repeat: true` ("repeat cup"): the same cup ran in several periods of the window. It is assigned to
  the cup; `periods`/`candidates` list every period and start/end span them (counted in `periodStatus['repeat-cup']`);
- `unassigned`: `ambiguous` (different cups; not reachable today), `no-date`, `no-league`, `championship`,
  `outside-schedule`, or `contradicted` (the schedule ran other formats at that CP on those dates and never
  this cup; `scheduled` lists what ran). Totals are in `summary.periodStatus`.

**League inference rules** (`league.py`): (1) a keyword cup the schedule did not run in the upload-lag window stands
for its same-name Mega variant (`cup_variants`: Color Cup / Mega Color Cup, Halloween, Catch) or the one scheduled CP
edition of a bare Mega Edition, when that ran; "Mega Color Cup" / "Color Cup Mega" do not also count as the plain
cup; "Great League: Mega Edition" / "Mega Great League" resolve to `mega@1500` (Great League CP), not the 10000 CP
default. (2) `refine_battle_league` ranks: cups the text names (not a bare league word when the schedule did not run
it), then formats the schedule ran in the window, then CP cap fit and species eligibility. Truncated CP reads
('149' from 'CP 1490') give no cap (`plausible_cap`), reads above 6500 are dropped. A named cup the schedule never ran
and has no Mega variant stays, so observed.py reports `contradicted` with both named. Human league answers override
everything (observed.py). (3) `python3 -I league.py refine-all WORK_DIR [--dry-run]` rewrites only the
`results/*.leagues.json` sidecars from stored results (metadata from a copy of state.sqlite and the registry), backing
each up to `results-backup-leagues-<time>/`; `python3 -I observed_audit.py [WORK_DIR] [--web-root W]` prints the
schedule-check counts and contradiction categories offline. `harvest.write_league_refinement` still uses the old
call (no date/keywords); new analyses should call `league.refine_video(...)` instead.
- On 2026-10-12 (1,496 battles): 0 confirmed (no verified recording dates), 1,070 estimated, 426 unassigned
  (192 ambiguous, 142 contradicted, 43 no date, 30 no league, 19 outside the schedule). 134 of the
  contradictions are Great League "Color Cup" battles uploaded while the schedule ran Mega Color Cup.

**Why a lineup is unidentified.** Each member carries `why` (the `_member` tests: `species` unread,
`form` p < .98 with the top alternatives, `shadow` unknown with its p) and the Validate question that settles
it (`question: {qid, status: open|answered|resolved}`, from `WORK/validation/<video>/<qid>.json` file names;
creator-side questions apply to every battle). "Answer in Validate" calls `MetaValidation.focus(qid)`.
A human answer or a refit resolution (`feedback.json` resolutions via `model_answers`) changes the catalog
revision, so the lineup moves into the identified teams on the next poll (`test_observed.py`
`UnidentifiedLineupTests`, `meta-observed-ui.test.cjs` end-to-end test). Fast moves never block identification.

**Analysis per selection** (`observed-core.js analyze/trend`): identified teams (order ignored, or by
confirmed lead), provisional teams (species + form settled, Shadow unknown; never merged with identified),
creator-perspective win rates, distinct creators and dates; Pokémon usage over lineups whose three species
and forms are settled (team share, confirmed-lead share, Shadow yes/no/unknown, fast moves read at ≥ 90%,
creator win %, sparklines per period with ≥ 10 lineups); pairings with lift; PvPoke expected share for open
leagues and (approximately) Mega Edition: `ObservedCatalog.pvpoke()` draws teams by PvPoke weight ^ 1.25
with `usage_export.prior_presence` over the trainer's 300-species population, Shadow and base combined.

**Trainer meta export:** `python3 -I web/scripts/yt-harvest/usage_export.py` turns the same catalog into the Team Rankings neural network's opponent usage file, written to `WORK/usage/`. It is read-only on the harvest data. Its rules and the overnight command are in `web/training/team-search/README.md` ("Observed opponent meta"); its tests are in `test_usage_export.py`.

## Status 2026-10-11 03:40 (model-improvement round)
- Human answers so far (feedback.json): 136 Shadow, 95 fast move, 25 form, 52 result, 36 footage, 1 league.
  The model's pick was right on 54/101 Shadow (coin flip), 61/89 fast move and 13/22 form. 28 of 36
  "no battles found" videos truly had no battle footage.
- Harvester bottleneck: extraction. 12 workers on 12 cores ran at 2.25× real time each (about 6× alone);
  41/79 analysed videos had 0 battles and were fully decoded. Restarted at 03:34 with `--extract-jobs 6`
  for 10 h (detached via overnight.sh; launcher.log in the work dir).
- New footage answers: Team Rocket, Championship, Screen obscured (commit 41b11f2).
- Three agents are working in parallel and will push to main:
  1. Shadow model (dataset, video-grouped CV, learned classifier, model-resolved questions);
  2. fast-move and form models (damage/energy/cadence likelihoods, type icons, model-resolved questions);
  3. harvester speed (keyframe pre-screen plus HUD-segment extraction, worker/thread benchmark,
     relevance from footage answers, download backlog cap, cleanup), Team Rocket auto-flag, Championship
     format plus "perspective" question, observed-meta exclusion.
- **When they finish:** `git pull`, run the tests in "Files and checks", then restart the harvester
  (Stop safely in the UI, or SIGTERM the PID in run.json) so it picks up the new extractor code.

## Status 2026-10-11 ~09:00 (after the model-improvement round)
- Pushed: Shadow classifier (6a11f05), fast-move/form model v4 (13279f9), pre-screen, backlog cap,
  cleanup and Rocket/championship/perspective/lead questions (a811a09); Rocket battle videos allowed
  through relevance for training (this commit). Harvester and web app (port 65246) restarted on it.
- Held-out results (each video scored by a model that never saw it):
  - fast moves: 153 → 161/197;
  - forms: 15 → 23/31;
  - Shadow after the merge: 147 → 158/209, AUC 0.75 → 0.82.
- Model resolved after the first refit: **55 fast-move questions**, 0 forms, 0 Shadow.
  - Shadow "not Shadow" calls are 15/15 right at ≥0.93 and 24/26 at ≥0.90 (held out), but the gate
    needs ≥25 calls at ≥95% with a Wilson lower bound ≥0.80, so none resolve yet. That's a data
    limit, not a bug: they'll resolve automatically as more Shadow answers arrive.
  - Forms need ≥30 held-out answers at the threshold; there are 16–17 so far.
- Throughput: the pre-screen skips about 30 of 109 queued videos with no battle screen and analyses only
  the battle stretches of 14 more. That's about 1.5× fewer worker-hours. The default is now 8 workers.
- Open items:
  - worker-count benchmark on an idle machine (`tests/meta-benchmark/bench-workers.cjs`);
  - Japanese-UI videos give 0 battles (extractor): done, see the status of ~19:00 below;
  - a nameplate species-check question;
  - HP bars on low-resolution YouTube crops: done (next section);
  - ~~the Shadow classifier flips two forms~~ fixed (likelihood ratio within each form).

## Status 2026-10-11 ~16:00 (HP-bar detection)
- `hp.js` findBars now uses hue-based fill/trail classes, tolerant row linking and an outline check on
  every bar. The search band is 300–1450 (was 450–1350). Fills are sub-pixel and hit steps allow for
  jitter. Details and numbers: `includes/meta/README.md`, *HP bars on YouTube footage*. Aura boxes follow
  the chosen bars, so aura readings change too.
- On 223 nameplate-visible YouTube and phone frames, valid bars found: 85 → 139 (yours), 62 → 131
  (opponent). The old detector's 86 false bars (no outline) are gone.
- All 37 labelled videos were re-extracted (same crops, ranges and battle structure) and installed in the
  work dir's `results/`. The originals are in `results-backup-hpbars-2026-10-11/`. Held out by video:
  - fast moves: 161 → 165/197 (log-loss 0.428 → 0.393);
  - forms: 23 → 26/31;
  - Shadow classifier: 157 → 171/208 (log-loss 0.495 → 0.356, AUC 0.823 → 0.917).
- The videos are in `~/Desktop/Projects/PoGo Recorder/src/relabel-cache/`, shared with the Shadow agent.
  The coordinator deletes the folder.
- `node web/tests/meta-benchmark/reextract-labelled.cjs <video dir>` repeats the re-extraction for newly
  labelled videos. It installs a result only if the battle structure is unchanged.
- **Next.**
  - Refit `movefit-fit.cjs` (its damage noise was fitted on the old hits) and the Shadow classifier
    default (`shadow-cv.cjs --write-default`) on the new evidence. The learning loop also refits on its
    own schedule.
  - Restart the harvester so new videos use the new detector.
  - Wide, tablet-shaped screens (`S67R41DZFuY`, `ORyJbp1_81k`) can put your bar mid-screen, where it is
    read as the opponent's: done (status of ~19:00 below).
  - YouTube asked "confirm you're not a bot" until 14:30 today; downloads then worked.
- No "Is the HP bar here?" Validate question was added. The outline score separates bars from look-alikes
  cleanly (real ≥ 0.9, others < 0.1), and a visual check found no false bars, so labelled ground truth
  wasn't needed.

## Status 2026-10-11 ~17:30 (Shadow focus shots)
- 412 human Shadow labels (338 in feedback.json, 74 archived), 410 joined to evidence, 125 videos.
- New feature: aura-purple measured in charged-attack focus shots (camera on one Pokémon), README "Focus shots".
  Recorded by run-node.cjs and the browser from now on (`b.focus`); old runs via sidecars in `WORK/focus/`.
- Held out by video: 299 → 323/410, log-loss 0.504 → 0.461, AUC 0.829 → 0.870; opponents facing your Shadow
  88 → 98/120. Both Shadow directions now pass the gate; a dry run resolves 383 of 993 open Shadow questions.
- **After pulling:** restart the web app, then refit (POST /api/validation/retrain from the same origin) so
  the new classifier and resolutions apply.
- 46 labelled videos are still missing from `relabel-cache` (YouTube bot checks); their labels have no focus
  features. A polite downloader may still be adding them. When more arrive, rerun from `web/tests/meta-benchmark`:
  `node focus-backfill.cjs --shard 0/3` (and 1/3, 2/3 in parallel; skips finished sidecars), then
  `node shadow-dataset.cjs` and `node shadow-cv.cjs --write-default` (prints the before/after splits and gates);
  the app's next refit also retrains from the sidecars on its own.

## Offline retest speed follow-up

See root `VIDEO-ANALYSIS-PERFORMANCE.md` and `HANDOFF-2026-10-11-OBSERVED-META.md` for current speed measurements. Retained-media inventory optionally emits verified, source-bound padded ranges with `--use-saved-ranges --verify-sha`. Batch jobs now accept a fifth JSON range column, clip per overlapping chunk, skip empty windows without launching a decoder and support FORCE_FULL=1. Existing saved extraction provenance is preserved on resume. Unknown legacy media identity stays full-source. Saved-feature refits avoid decoding/OCR for model-only changes; pixel detector changes still require retained originals. No existing process or live dataset was modified during this follow-up.

## Free-LLM Validate answers (2026-10-11)

`scripts/freellm/validate_llm.py` answers simple Validate questions with two free vision models,
Groq qwen and OpenRouter with data_collection=deny. Both are non-training routes, and the frames are
private. Details are in `scripts/freellm/README.md`.

- **Footage "No battle footage"** passed its gate: 22/22 right, covering 61% of the 36 owner answers.
  - Today's run on the open queue closed 6 of 244. Only 49 had a "no" title, and both models agreed on 9.
  - About 1 in 10 agreed answers stays open as a spot check.
- **Battle result** hasn't been measured yet. The free daily quotas ran out: Groq allows 200k tokens
  a day and OpenRouter 50 requests.
- Resolutions go through the new `POST /api/validation/resolve` route (`feedback.resolve_external`) as
  source `freellm`.
  - They are reversible, shown as "Free LLM" under Model resolved, and kept across refits.
  - They are never labels and have no pipeline side effects.
  - A human answer or Reopen wins.
  - **The app must be restarted to load the route.** Then run
    `python3 -I web/scripts/freellm/validate_llm.py run --kind footage`; it uses the cached answers.

## Local-LLM Validate answers (2026-10-12)

The free tiers are phased out (disabled in `scripts/freellm/providers.json`). The router's only enabled
provider is a local Ollama model (`qwen2.5vl:7b`, `http://localhost:11434`): nothing leaves the Mac, no
quota, no cost. Claude Haiku through the API is wired in but disabled (no API billing). Details and
commands: `scripts/freellm/README.md`.

- `validate_llm.py` has gates and runners for `footage`, `result`, `lead` (nameplate second reader),
  `title_footage`, `title_league` and `footage_title`. Agreement rule: two independent calls (different
  option order and seed, or another frame) must agree with confidence ≥ the gate's threshold; ~1 in 10
  agreed answers stays open as a spot check. Gates are held out by video (two folds) and need ≥ 95% exactly
  right with ≥ 10 resolved.
- **No kind passed with qwen2.5vl:7b, so nothing was resolved.** Best: `footage_title` 11/12 (91.7%), 33%
  coverage. `result` fails outright (the model says "Win" for almost everything). Numbers are in `evals.json`.
- Nameplate reading passed (`llm_hud_names`: 108/108 names on 92 benchmark strips) and is available as a
  question-free second reader: `eval_hud.py read VIDEO x0,y0,x1,y1 T...`. Not wired into the extractor.
- The resolve route now accepts source `local-llm` (and `haiku`): one model, ≥ 2 agreeing calls, confidence
  ≥ threshold, model recorded. Old `freellm` records stay readable. The Validate tab shows them as
  "Local LLM · <model> <confidence>". **Restart the app to load the updated route** before any `run`.

## Model performance tracking (2026-10-11)

- **Validate › Model performance** shows held-out accuracy per kind, Shadow AUC and log-loss, queue status
  per refit, calibration and the resolution gates. Details are in `includes/meta/README.md`, *Model
  performance view*.
- Every refit appends a record to `WORK/metrics-history.json` (`metrics_history.py`). The first start of
  the new code backfills refits 1–51 from `learning/refit-N/`, answer times and resolution reasons; only
  refit 51 has held-out metrics. The learning loop now also reports fast-move and form log-loss,
  calibration bins and the effective resolution threshold.
- **Restart the app** to load it. The backfill runs once on start-up and writes only `metrics-history.json`.

## Status 2026-10-11 ~19:00 (battles from zero-battle videos)

Details and numbers: `includes/meta/README.md`, *Battles from zero-battle videos*. Takes effect on the next
harvester start (not restarted).

- Root causes of the 52 probed "HUD seen, 0 battles" runs: 43 had a Japanese (26), Korean (16) or Chinese (1)
  game UI; the rest were a wrong first calibration, a facecam panel taken for the screen, screen boxes a few
  percent too wide, stream chat over the nameplates, and a PvPoke-rankings video without battles.
- Fixed: nameplates in Japanese, Korean, Chinese, German, French, Spanish and Italian (PokeAPI names in
  `includes/meta/species-names.json`; CJK OCR needs Tesseract's `jpn`, `kor`, `chi_tra` and `chi_sim` fast models in
  `~/.cache/gbl-synapse/tessdata`, downloaded from github.com/tesseract-ocr/tessdata_fast, Apache-2.0); German,
  Spanish and Portuguese result screens; recalibration after a wrong first offset; Poké-Ball refit of the
  screen box; a name-text requirement against static art; offsets down to −150 for cropped tops; split battle
  starts and one-frame battles in the tracker; wide-screen HP-bar sides. The 10 re-downloaded videos are in
  `relabel-cache/` (afvH9iu5WsE, lC6aiKQuZ5c, stLd7OkIg3Y, L2Iyrc06j00, -mROfxnNVBk, maw_a7oKYMM,
  3c8JZ4pQq50, u2jAMngLVBw, c-aCjcD7OxQ, DxiBdcqzQME).
- Sample results (before → after): 10 re-downloaded zero-battle videos 0 → 55 battles (Japanese 0 → 22 in
  4 videos, Korean 0 → 5, Chinese 0 → 6, English 0 → 22; a PvPoke-page video and one with chat over the
  nameplates stay at 0); merged-battle videos GMF7uTFAyHM 1 → 9, cVMJbsB5l9c 1 → 10, vPjKop__xf0 4 → 10,
  glOZKkCcUq0 12 → 18; German ktg6J7if8Rc 8 → 16 battles (results 0 → 15). Benchmark and parity unchanged;
  Rocket flags unchanged.
- Requeue: the earlier zero-battle runs with Japanese, Korean or Chinese titles (101 + 39 + 20 videos; most
  videos were deleted) and the German, Spanish and Portuguese videos (results, German species) would gain from a
  re-extraction. Only Validate's "battles are shown" requeue downloads again; nothing was requeued.
- Open: CJK result screens and "Go"/charged-move banners in other languages (the examined CJK videos cut
  their result screens); French and Italian result texts (no sample); the browser has no CJK OCR models;
  `aura-features.cjs` still uses the phone bar windows (Shadow agent's file).

## Status 2026-10-12 (fast-move refit, Shadow default, free-LLM result gate)

- Fast-move evidence settings refitted on the HP-bar evidence (`learning/movefit-params.json`; the old file is
  `movefit-params.before-refit-2026-10-12.json`). Numbers: `includes/meta/README.md`, *Refit on the new HP-bar
  evidence*. **POST /api/validation/retrain** applies them (`learned.fit`).
- The committed Shadow classifier default (256fb9a, 410 rows) was kept: refitting now would use only 361
  rows, with identical in-sample accuracy (295/361, log-loss 0.415), because 34 labelled videos' results are
  moved to `.previous` by a requeue (49 Shadow labels, plus `Mt58K0Gckb8` and `S67R41DZFuY` for fast moves).
  Re-run `shadow-dataset.cjs` and `shadow-cv.cjs --write-default` when those are re-extracted.
- Free-LLM battle-result gate failed (Groq alone: 4/14 right on its resolvable answers, 30% coverage; it
  calls most wins "Loss"; the strips often show no result screen). Not pursued: the free providers are being
  replaced by Haiku via the Claude API. Details: `scripts/freellm/evals.json`, `validate_result`.


## Status 2026-10-12 ~03:30 (local vision model, nameplate reader, chain)
- Local model: `qwen2.5vl:7b` passed only the nameplate-reading gate (108/108) and failed battle type,
  result, lead and title gates (068adfe). It was deleted. `qwen3-vl:32b` is the new default
  (providers.json) and is pulled + re-gated by `<work>/after-harvest.sh` once the 12-worker harvest ends.
- Nameplate reader NOT wired into the extractor, by the owner's rule "only if Tesseract typically fails":
  0 of 10,730 observed team members lack a species identity, the labelled benchmark reads 194/194, and the
  foreign-language gap is covered by Tesseract language packs (9657478). Revisit only if "Species unread"
  reasons appear in Observed meta › Unidentified.
- `<work>/after-harvest.sh <harvester pid>`: refit every 2 h during the harvest; on exit commit the
  registry, re-export the observed meta, launch the 8 h trainer, then pull the 32B model and run all gates.
- Ollama runs locally (`ollama serve`, port 11434); an unexpected `qwen3.6:35b-a3b` is also present.
