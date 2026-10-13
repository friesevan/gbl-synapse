# Selection protocol: minimum evidence, sealed confirmation, longer final panels (2026-10-13)

Question (README section 12, accuracy row "Selection and multiple comparisons"): *the primary is chosen by screening before the final test, but the best-looking final score is still optimistic, and a lucky small sample can reach screening. What closes that?*

**Answer, in one paragraph.** Three opt-in-or-default safeguards, all tested, none yet run at full scale. (1) `--min-lead-fixtures N` stops a team with fewer than N fixtures from leading the training ranking, being the retest incumbent or being screened. (2) `--confirmation-opponents N` (default 256) plays any challenger that the final panel puts clearly above the primary, and the primary, on a new sealed panel, and the report says whether the advantage was confirmed; the screening-selected primary stays the primary endpoint. (3) `--validation-opponents-max M` grows the final common panel in steps of 64 fixtures while time remains. A read-only retrospective on the completed v4 run shows that on that run none of the three would have changed the result: no challenger was clearly above the primary, and every screened team already had 64 fixtures. What the data do show is that the optimism the rule targets is real (below).

All numbers from the smoke runs and the synthetic tests are evidence that the machinery works. They are not accuracy claims about Team Rankings.

## What was built

| Piece | Flag (default) | Files | What it does |
| --- | --- | --- | --- |
| Minimum evidence | `--min-lead-fixtures N` (0 = off; 64 recommended) | `selection.cjs`; `search.cjs` `scoreRecords` | a team with fewer than N fixtures ranks after every team with N or more; otherwise the cautious selection score as before |
| Confirmation | `--confirmation-opponents N` (256; 0 disables) | `confirmation.cjs`, `selection-report.cjs`, `budget.cjs` | sealed panel for the primary and every resolved challenger; paired bootstrap and simultaneous band (`paired-stats.cjs`) |
| Longer final panel | `--validation-opponents-max M` (0 = same as `--validation-opponents`, off) | `confirmation.cjs` | steps of 64 fixtures up to M on the same fixture list while time remains; comparisons recomputed |
| Retrospective | `audit-selection.cjs RUN_DIR` | `audit-selection.cjs` | read-only; fixtures at screening, screening set under the rule, which comparisons would trigger a confirmation |
| Reports and viewer | none | `report.cjs`, `export-report.cjs`, `neural-report-core.js`, `neural-portable.js`, `NEURAL_REPORTS.md` | `confirmation`, `selection`, `finalPanel.extension` in the checkpoint, `recommendations.json`, `report.html`, `findings.md` and the portable report; finalist cards and a table in Search Performance |

## 1. Minimum evidence before leading

`scoreRecords()` in `search.cjs` is the single ranking of training teams. Everything that picks a "best" team reads it: the training leader (`history.jsonl` `bestTraining`), the retest incumbent (`propose.cjs` `known[0]`, and with it the rotating contenders `known[1..7]` and the local neighbourhoods of `known[0..7]`), the retest-panel incumbent and the screening set. With N > 0 its comparator gets one extra first key, `leadRank(a) - leadRank(b)`, where `leadRank` is 1 for a team with fewer than N fixtures and 0 otherwise. Within each group the order is the old one: cautious selection score, then games, then team key.

The screening set is `leadPool(scoreRecords()).slice(0, screenTeams)`. `leadPool` keeps only teams at or above N. If fewer than `--screen-teams` have reached N, fewer teams are screened (a thin team is never used to fill the slots). If **no** team has reached N (a run too short to expand any team that far) the ranking is left as it was and the run records `selection.fallback = true`; the smoke test with N = 1000 shows the run is then identical to the unruled one.

Recorded: `config.minLeadFixtures` (only when > 0), `state.selection` (teams, teams at or above N, screening candidates, how many were below N, whether the ranking fell back), the same in `recommendations.json`, `report.html` ("Selection safeguards"), `findings.md` and the portable report (`search.minLeadFixtures`, `search.selection`).

Two design notes. (a) With staged acquisition a promoted team plays the full `--opponents` panel (64 by default), so at N = 64 every promoted team qualifies and the rule removes only the 8-fixture screen-only teams. Above the full panel size a team qualifies only after a retest, and retests go to the incumbent and seven rotating contenders, so N > 64 effectively restricts screening to teams the retest policy has revisited. (b) The rule applies to the ranking, so it also keeps lucky 8-fixture teams out of the local-neighbourhood seeds; whether that helps or hurts the search itself is not measured.

## 2. Confirmation test

**Trigger.** After the final panel and its comparisons (`search.cjs`, unchanged) `confirmation.cjs` `challengers(state)` lists every team other than the primary that is `challenger-better` in `finalistComparisons` (simultaneous band over the finalists) or in `championComparisons` (previous champions; a champion that is the primary again, `sameTeam`, is a tie and never a challenger). A team found by both is one challenger with both pieces of evidence. No challenger, no confirmation, nothing recorded (the report says "enabled and not needed").

**Panel.** The primary and the challengers play `--confirmation-opponents` fixtures drawn from `confirmationSeed(validationSeed)`:

- derived as `parseInt(digest(['confirmation', validationSeed]).slice(0, 8), 16)` and run through `guardedSeed` against the validation seed and `screeningSeed(validationSeed)`;
- the training streams are guarded against it (`searchSeed` in `search.cjs` now blocks `[screenSeed, validationSeed, confirmSeed]` when the test is on), and with it the retest-panel seed, which is derived through `searchSeed`; with the test off the guard list is what it was;
- at start the run refuses a confirmation seed that the warm-start's `evaluationEvidence.fixtureSeeds` already used, and a panel whose (opponent team, battle seed) fixtures overlap training evidence, the screening, final or retest panels (checked again when the panel is drawn);
- the launcher (`launch.cjs`) draws validation seeds until the derived confirmation seed is also fresh;
- `absorb-evaluation.cjs` treats a finished run's confirmation panel as evaluation evidence (its seed joins `evaluationEvidence.fixtureSeeds`, its fixtures become labels of the new run), and `champions.cjs` reports it among a source's used seeds so `rematch.cjs` never draws it again;
- the fixtures are saved in `checkpoint.fixturePanels[confirmationSeed]`. The confirmation battles are counted in `battles` but are never labelled fixtures: no observation or record is created.

Sealed panel scheduling is the final panel's: fixture-major `evaluate(..., {commonPanel: true})`, so a deadline keeps the common completed prefix. `budget.cjs` reserves two teams times N fixtures when training stops.

**Statistics.** `pairwiseBands` (paired-stats.cjs) over the confirmation teams: 5,000 whole-fixture bootstrap resamples, one simultaneous 95% band over **every pair** of the confirmation teams (with one challenger that is one pair; with three challengers six pairs, slightly wider than comparing only the primary with each). Verdicts per challenger: `challenger-better` (confirmed), `primary-better`, `unresolved`. Outcome: `challenger-confirmed` if any challenger is confirmed, else `not-confirmed`; `incomplete` if no confirmation fixture finished.

**What it can and cannot say.** At 256 fixtures and the v4 run's median paired sd of 0.449, one comparison resolves about 5.5 points (3.9 at 512, 2.7 at 1,024). A real 3-point advantage will usually come out "unresolved", so `not-confirmed` is not proof of no difference; the record stores the band radius and the summary prints it. The confirmation score of a challenger is an unbiased estimate (the team was not chosen using the panel); its final-panel score is not. The screening-selected primary stays the primary endpoint in every case: adopting a confirmed challenger is the reader's decision, not the run's.

**Longer panel interplay.** A challenger that only the longer final panel resolves (below) is added to the same sealed panel afterwards: only the new challenger plays (the primary's scores are already there), the band is recomputed over all teams, and the trigger is recorded with `stage: 'extended-final-panel'`. A late challenger that cannot finish the whole panel in the time left is listed as `unfinished` and not retried. A challenger that stops being resolved after extension keeps its confirmation entry; the trigger record keeps the fixture count at which it was found.

## 3. Longer final panel

After screening, the final test and the first confirmation, while time remains, `extendFinalPanel`:

1. refuses to start unless the base panel completed (`finalPanel.extension.stoppedBecause = 'base-incomplete'`) and every row has the same length;
2. plays the next 64 fixtures (or the rest up to M) for every team on the panel (finalists, baselines, previous champions, deduplicated) as one common panel; a deadline keeps only the common completed prefix and ends the extension;
3. checks that the new fixture list's prefix equals the old one (the list is a sequence of draws from one stream, so it is prefix-stable; a change throws);
4. re-summarises every row, recomputes `comparisons`, `finalistComparisons` and `championComparisons` with the same seeds as the base panel (so an unextended run reproduces exactly: a test asserts it) and saves the checkpoint;
5. leaves `finalPanel.requestedFixtures` (the planned base) and `complete` (the base was completed), raises `completedFixtures`, and records `extension: {baseFixtures, requestedMax, step, completedFixtures, steps[{fixtures, added, requested, seconds, battles}], stoppedBecause}`.

Each step is limited to the run deadline minus the time a late confirmation would need (two teams times N fixtures at the run's average battle rate, with a 25% margin). Screening, the base final panel and the first confirmation always come first; the extension only uses what is left.

## 4. Retrospective on the completed v4 run

`node training/team-search/audit-selection.cjs training/runs/team-search-v4-observed-2026-10-12 --min-lead 64` (read-only; checkpoint only; the recomputed screening set matches the 24 teams the run screened, and the leader rebuilt after each of 364 rounds agrees with all 363 recorded `bestTraining` values).

**Fixtures per team.** 8,477 teams; per team min 8, median 8, max 3,976. Below 64 fixtures: 4,303 (50.8%); below 128: 8,423 (99.4%); below 256: 8,462 (99.8%).

**Finalists, when they entered screening** (primary first): 1,008; 3,976; 936; 600; 64; 64; 520; 192 fixtures. The 24 screened teams had 64, 64, 79, 80, 128, 128, 136, 144, 192, 192, 200, 280, 296, 336, 392, 520, 600, 680, 800, 880, 936, 1,008, 2,136 and 3,976.

**Would the rule have changed the screening set?**

| N | screened teams below N | screening set changes | finalists dropped | training leader changes (rounds of 364) |
| --- | --- | --- | --- | --- |
| 64 | 0 of 24 | no | 0 | 0 (leader below 64 fixtures in 0 rounds) |
| 128 | 4 of 24 | 4 dropped, 4 added | 2 | 36 (leader below 128 in 37 rounds; first team at 128 in round 1) |
| 256 | 11 of 24 | 11 dropped, 2 added | 3 | not computed here |

So the rule at the recommended 64 is insurance on this run, not a fix: the cautious score already ranks 8-fixture teams low, and the search expanded the leaders early (a team at 64 fixtures existed in round 0). At 128 it would have bitten, and both finalists it would have dropped had exactly 64 fixtures and a training score of 89.1%.

**Is the optimism real?** Training score minus sealed screening score of the 24 screened teams, by evidence at screening: fewer than 128 fixtures: **+7.9 points** (n = 4); 128 to 511: **+3.7** (n = 11); 512 or more: **+0.9** (n = 9); all 24: +3.3. Descriptive, tiny groups, not a test; but it is the direction and rough size the winner's curse predicts, and it shrinks with evidence.

**Which comparisons would have triggered a confirmation?** On the 512-fixture final panel (8 finalists, 20 teams): the actual primary had **no** challenger clearly above it (all seven simultaneous bands unresolved, differences -3.2 to +2.9 points; half-width 5.1), so **no confirmation panel would have run**. Taking each finalist as the primary in turn (a counterfactual for how often screening's pick would be challenged): 1 of 8 would have triggered one (Talonflame (Shadow) / Empoleon / Umbreon, final 80.6%, with a challenger clearly above it). Under one simultaneous band over all 28 finalist pairs (radius 6.2 points) none of the pairs is resolved. Median paired sd 0.449: one-comparison half-width 5.5 points at 256 fixtures, 3.9 at 512, 2.7 at 1,024.

## 5. Smoke runs with the real engine

Pool: the prepared 300-species pool; v4 hybrid synthetic meta; 4 workers under `nice -n 10`; the machine was shared (load average 30 to 47). Command:

```
nice -n 10 node training/team-search/search.cjs --pool training/runs/team-search/pool.json --out training/runs/smoke-selection \
  --hours 0.2 --workers 4 --initial-teams 16 --batch-teams 8 --opponents 16 --acquisition-fixtures 4 --screen-teams 4 --screen-opponents 16 \
  --validation-teams 2 --validation-opponents 32 --baseline-count 3 --candidates 200 --rounds 2 \
  --champions training/runs/team-search-v4-observed-2026-10-12 --confirmation-opponents 16 --validation-opponents-max 96 --min-lead-fixtures 16
```

The v4 primary (Talonflame (Shadow) / Mandibuzz / Bastiodon) enters as a previous champion; it is far above any team a 2-round smoke search finds, so the confirmation trigger fires naturally with the real engine (the forced cases are in the tests). Results (912 battles in 104 s, 8.8 battles/s on the loaded machine, 23 teams; a repeat of the identical command with the final code gave identical numbers):

- **Minimum evidence (N = 16):** 12 of 23 teams reached 16 fixtures; the 4 screened teams had 16, 16, 16 and 20; none below N.
- **Final test:** primary 56.3% (Qwilfish (Shadow) / Dewgong / Houndoom (Shadow)), champion 90.6% on 32 fixtures: `challenger-better`.
- **Confirmation (16 sealed fixtures, seed 1824840731, distinct from validation 21161010 and screening 1986668050):** primary 43.8%, champion 68.8%, difference -25.0, simultaneous band -50.0 to 0.0: `unresolved`, outcome `not-confirmed`. A 16-fixture panel has a band radius of 25 points, so it cannot confirm even this gap; that is the expected smoke behaviour and exactly the caveat to read in the report ("a difference smaller than about 25.0 points cannot be told from noise").
- **Longer final panel (32 to 96 fixtures, one step of 64 fixtures, 384 battles, 42 s):** primary 53.1%, champion 87.0% on 96 fixtures, difference -33.9 (-46.4 to -21.4): now clearly `challenger-better`. The sealed record was not re-run (the champion is already in it).
- **Bookkeeping:** 0 of the 240 training observations carry a confirmation fixture; the portable report validates with `neural-report-core.js` (`confirmation.outcome = 'not-confirmed'`, `finalPanel.extension.steps = 1`); `recommendations.json` has `confirmation` (no per-fixture scores) and `selection`; `report.html` and `findings.md` carry both.
- **Resume (`--resume` of the finished run, real engine):** the final stage is replayed from the saved training state: screening, final panel, the sealed panel and the extension, 672 more battles (battle counter 912 to 1,584). Every result is identical to the first pass: records, observations, history, screening, finalists, validations, baselines, all three comparison sets, the confirmation record and the saved fixtures (only the wall-clock seconds of the extension step differ). **A bug found this way:** the first resume skipped the sealed panel, because the checkpoint still held the earlier run's `confirmation` record and the trigger saw it as already done. The results were identical only because everything is seeded; a resume with more training could have extended a record belonging to a different primary. Fixed in two places (`delete state.confirmation` where the final stage restarts, and `ensureConfirmation` ignoring a record whose primary or seed differs), each covered by a test that fails without it.

## 6. Tests

`node --test training/*.test.cjs training/next/*.test.cjs training/team-search/*.test.cjs` from `web/`: 267 tests, all pass (226 before; 41 new). `node --test tests/docs.test.cjs` passes; the viewer-side tests outside that glob (`pro.*.test.cjs`, `tests/theme`, `tests/app-tabs`) pass.

| File | Covers |
| --- | --- |
| `selection.test.cjs` (5) | ordering with the threshold (N = 0 identical; 63 vs 64 vs 65; ties; input not mutated), the lead pool and its fallback, the description recorded, option validation |
| `confirmation.test.cjs` (17) | trigger logic on synthetic validations (resolved, unresolved, primary-better; finalist, previous champion, both, the primary again); seed derivation and guarding; evidence overlap; the confirmation record and verdicts (confirmed, unresolved, reversed); no challenger, test off, no primary; deadline-cut prefix, no time, user stop; refusal of overlapping fixtures; late challengers (same panel, nobody replayed, wider band; unfinished, not retried); extension (steps of 64, prefix preserved, comparisons equal a fresh computation, saves marked in-progress); cut and stopped extensions, base incomplete, changed prefix, uneven rows; `finish` ordering and priority; the time reserve; absorb and `evaluationEvidence`; the budget; rematch bookkeeping; a record of another primary or seed is replaced or cleared, never extended |
| `search-selection.test.cjs` (9) | the real search loop with deterministic mock battles and per-phase overrides: default run and the off switch; invalid options; the rule on the leader (checked against the rebuilt trajectory) and the screening set, with a canary that thin teams were screened without it; a forced confirmed case (retest panel on, seeds distinct, nothing used for training, every report, viewer helper, validator, absorb, collision refusal); a forced not-confirmed case; a previous champion trigger and an unresolved no-trigger case; interruption inside the confirmation panel and resume at three offsets, and a resume of the finished run that must replay the sealed panel (it fails without the `delete state.confirmation` line); the longer panel end to end; launcher flags |
| `selection-report.test.cjs` (2) | the safeguards paragraph (rule, fallback, extension reasons, confirmation enabled and not needed, needed but not recorded), the confirmation table in HTML and Markdown, escaping, incomplete records |
| `confirmation-viewer.test.cjs` (4) | view model, sentence and badge, the rendered tab (finalist card, intro, table, fixture counter), validator accept and refuse |
| `audit-selection.test.cjs` (4) | the retrospective on a synthetic checkpoint with known answers, the rebuilt leader trajectory, triggers with and without a resolvable challenger, the command line |

Forcing: the search-level tests run pass 1 to learn the finalists, then override only sealed final-test phases (final, extension, confirmation) for chosen teams; training and screening outcomes are never overridden, so pass 2 selects the same finalists.

## 7. search.cjs changes (hunks, line numbers of main at efbdcc8-era `search.cjs`)

Each is a small insertion or substitution; the coordinator's three-way merge should see no overlap with the acquisition or retest-panel changes. New logic lives in `selection.cjs`, `confirmation.cjs`, `selection-report.cjs`.

1. line 7: new line `const selectionTools=require('./selection.cjs'),confirmationTools=require('./confirmation.cjs');`
2. line 23 (`searchSeed`): a new line before it defines `confirmationOpponents` and `confirmSeed`; the guard list gains `...(confirmationOpponents>0?[confirmSeed]:[])`.
3. after line 29 (the `exploration` check): new line defining `minLeadFixtures` and `validationOpponentsMax` and calling `selectionTools.validateOptions`.
4. line 43 (the `config` literal): one insertion after the `retestPanel` spread: `...(minLeadFixtures?{minLeadFixtures}:{}),...(confirmationOpponents?{confirmationOpponents,confirmationSeed:confirmSeed}:{}),...(validationOpponentsMax>validationOpponents?{validationOpponentsMax}:{}),`.
5. line 54 (training-evidence overlap check): `meta.fixtures(validationOpponents,validationSeed)` becomes `...(validationOpponentsMax,...)`.
6. line 59 (retest-panel overlap guard): the same substitution.
7. new lines before the `activeClock` line: the confirmation seed and fixture checks (absorbed evidence, training evidence, sealed and retest panels).
8. line 64 (`updateBudget`): `,confirmationOpponents` appended to the `trainingBudget` call.
9. line 77 (`scoreRecords`): a new line before it defines `leadRank` and `leadPool`; the sort gains `leadRank(a)-leadRank(b)||` as its first key.
10. line 149 (screening): `scoreRecords().slice(0,screenTeams)` becomes `leadPool(scoreRecords()).slice(0,screenTeams)`; two new lines after it: `delete state.confirmation;` (the final stage starts over, so a record from an earlier finalisation of a resumed run must not survive) and the one that records `state.selection` and logs the rule when it is on.
11. after line 162 (the comparisons and `save()`): new line `await confirmationTools.finish({...})`.
12. line 165 (`finally`, `recommendations.json`): `confirmation:confirmationTools.publicRecord(state.confirmation),...(state.selection?{selection:state.selection}:{}),` inserted after `finalistComparisons`.
13. line 167 (CLI): `validationOpponentsMax:0,confirmationOpponents:256,minLeadFixtures:0,` after `validationOpponents:512,` in the defaults; the three flags in the help text.

Other shared files touched: `common.cjs` (the `algorithmHash` file list gains `selection.cjs`, `confirmation.cjs`, `paired-stats.cjs`), `launch.cjs` (the three defaults; seed draw also checks `freshConfirmationSeed`), `budget.cjs`, `absorb-evaluation.cjs`, `champions.cjs` (one `usedSeeds` term), `report.cjs` (a require, a `const`, two insertions), `export-report.cjs`, `neural-report-core.js`, `neural-portable.js`, `README.md`, `README-plain.md`, `EVALUATION_PROTOCOL.md`, `NEURAL_REPORTS.md`. Another agent adding a seed derived from the validation seed (a sensitivity panel) should either derive it through `searchSeed` (which now blocks `confirmSeed`), or pass it as the second argument of the one `confirmationTools.confirmationSeed(validationSeed)` call (hunk 2) so that the two are guarded against each other; `confirmationSeed(validationSeed, reserved)` skips every seed in `reserved`.

## 8. Decisions to review, and open items

- **Default 256 for the confirmation test.** It is on by default (0 disables) because it costs nothing unless a challenger is resolved and the reserve is small (two teams times 256 fixtures against about 20 times 512 for the final test). Existing smoke commands now spend 256 extra fixtures per team when a challenger happens to be resolved; pass `--confirmation-opponents 0` for the old run exactly.
- **Strict screening pool.** A thin team is never used to fill screening slots; the cost is a smaller screening set when few teams reach N. The alternative (fill the slots with the best thin teams) is a one-line change in `selection.cjs` `leadPool`.
- **All-pairs band.** The confirmation band is over every pair of the confirmation teams, not just primary against each challenger. It is the conservative choice and equals the single-pair interval when there is one challenger (the usual case).
- **Power.** 256 fixtures cannot confirm gaps under about 5 points. If confirming a 3-point gap matters, use `--confirmation-opponents 1024` (2.7 points) and let the budget reserve it.
- **Not repeated: screening.** The 24 screened teams' choice of primary still rests on one 512-fixture panel; the confirmation only tests a challenger that the final panel flagged. A primary that is wrongly ahead of an unflagged challenger is not caught.
- **Resume replays the final stage.** The screening, final, confirmation and extension are not checkpointed incrementally (as before); an interrupted run replays them from the saved training state with identical seeded results. To redo only the final stage pass `--rounds <rounds completed>` and enough `--hours` for it. A checkpoint from before this change cannot be resumed (algorithm hash), like any code change.
- **N above the expanded panel size** depends on the retest policy (section 1). Whether 128 would improve the final team is not measured; the retrospective only shows it would have excluded two finalists whose sealed scores matched the rest.
- **Not measured:** the effect of any of the three on the final team's quality at full scale; the frequency of resolved challengers (the v4 run had none among its actual pairs); the cost of the extension at 12 workers (the smoke step was 384 battles in 42 s, 9.2 battles/s on a loaded machine).

## 9. Full-scale commands (run later)

From `web/`, after the standard test command passes:

```
# Retrospective on any finished run (read-only; seconds)
node training/team-search/audit-selection.cjs training/runs/team-search-v4-observed-2026-10-12 --min-lead 64 --json training/runs/audit-selection-v4.json

# Full run with the protocol: 8 hours, the observed meta of that run, minimum 64 fixtures, 256-fixture confirmation, final panel grown to 1,024 while time remains
python3 -I scripts/yt-harvest/usage_export.py
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v4-selection-YYYY-MM-DD \
  --min-lead-fixtures 64 --confirmation-opponents 256 --validation-opponents-max 1024 \
  --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" \
  --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N

# The old behaviour exactly (no rule, no confirmation, no longer panel)
node training/team-search/launch-next.cjs --hours 8 --out training/runs/RUN --min-lead-fixtures 0 --confirmation-opponents 0

# After the run: read the sealed confirmation in report.html / findings.md, then compare the audit
node training/team-search/audit-selection.cjs training/runs/team-search-v4-selection-YYYY-MM-DD --min-lead 64
```

`launch-next.cjs` passes unknown-to-it flags through to `launch.cjs` and the later flag wins, so the three new flags need no other change. Budget: at 14 battles/s the final test is about 27 minutes, the sealed panel about 1 minute, and the extension to 1,024 about 12 minutes; all fit inside the 20% reserve of an 8-hour run, and the extension only uses the time that is left.
