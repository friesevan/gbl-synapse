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
Team-card OCR, battle-chapter skipping, lower-resolution decode trials, and uncertain schedule gaps
remain separate experiments. Do not run neural team training concurrently when measuring extraction speed.

## Observed meta browser

The new **Observed meta** dashboard reads `/api/observed-meta` automatically, alongside reviewed browser/shared observations. League/cup/time-range grouping, selected team occurrences, team-perspective outcomes, source timestamps and saved battle graphs are documented in the root `HANDOFF-2026-10-11-OBSERVED-META.md`. Detected lineups are provisional; incomplete teams stay separate.

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
