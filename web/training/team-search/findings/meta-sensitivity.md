# Meta sensitivity and observed-data strata (2026-10-13)

Section 12 of the README lists "the target distribution" as the largest accuracy gap: the search finds a best response to one modelled opponent meta, so its final score is conditional on that assumption. This change adds (1) a **sensitivity panel** that re-simulates a run's finalists under several alternative metas and records the spread, in every run and as a standalone tool, and (2) **date strata** for the observed-meta exporter. Rating strata turned out to be impossible with the data we have. Everything is a read-out: the primary team is still the screening winner and nothing is selected by it.

Numbers below are **exploratory** and were measured on a shared machine (load average 31 to 35 from the batch video analysis, `nice -n 10`, 4 workers). They are correctness evidence for the pipeline and a first look at the spread, not accuracy claims.

## What was built

| Piece | Where |
| --- | --- |
| Sensitivity module: meta catalog, sealed seeds, plan, assembly, statistics, text, and the standalone tool | `training/team-search/sensitivity.cjs` (new) |
| `--meta coherent` (coherent draws only) and a leave-one-creator-out option, `loadUsage(...).topCreator` | `meta.cjs` |
| Panel in the search: `--sensitivity-fixtures N` (default 128, 0 disables), `--sensitivity-groups finalists\|all` | `search.cjs`, `launch.cjs` |
| Budget reserve for the panel's battles | `budget.cjs` (`sensitivityBattles`) |
| Algorithm fingerprint includes the module | `common.cjs` (`algorithmHash` list) |
| Checkpoint `sensitivity` and `sensitivityScores` (per-fixture), `recommendations.json`, `report.html`, `findings.md`, portable report | `search.cjs`, `report.cjs`, `export-report.cjs` |
| Report validation (schema stays 1) | `includes/pro/neural-report-core.js` |
| Viewer: table in Search Performance, one line under each finalist's bar | `includes/pro/neural-portable.js`, `neural.css` |
| `defaultPlay` exported with a progress label | `rematch.cjs` |
| `--since` / `--until` | `web/scripts/yt-harvest/usage_export.py` |
| Tests | `sensitivity.test.cjs`, `search-sensitivity.test.cjs`, `sensitivity-viewer.test.cjs`, `test_usage_export.py` |
| Docs | README sections 2, 4, 8, 11, 12, 13; README-plain; EVALUATION_PROTOCOL; `NEURAL_REPORTS.md` |

### search.cjs hunks (for the three-way merge)

1. Line 7, new line: `const sensitivity=require('./sensitivity.cjs');`.
2. After the `retest-panel` validation, two new lines: `sensitivityFixtures` and `sensitivityGroups` constants and their validation.
3. In the `config` object: `...(sensitivityFixtures?{sensitivityFixtures,sensitivityGroups}:{}),` after the `retestPanel` spread (so it joins the resume digest only when on).
4. Before `const activeClock=`, a comment and one `const sensitivityPlan=...,sensitivityBattles=...;`. **Any panel seed another change adds (a confirmation panel, a policy panel) must be appended to this hunk's `reserved:[...]` list**, and its fixtures to `sealedKeys`.
5. In `updateBudget`: `,sensitivityBattles` added to the `trainingBudget({...})` call.
6. After the blank line that follows the champion comparisons, a block (`state.sensitivity=null;...if(sensitivityPlan&&...){...}`) that runs the panel through the existing `evaluate()` with `commonPanel:true`. The original blank line is left in place as a separate insertion point.
7. In the `recommendations.json` report: `sensitivity:state.sensitivity||null,` after `finalPanel:state.finalPanel,`.
8. In the CLI defaults: `sensitivityFixtures:128,sensitivityGroups:'finalists',` after `usagePriorStrength:500,`; in the `--help` text: `[--sensitivity-fixtures 128] [--sensitivity-groups finalists|all]` before `[--validation-teams 8]`.

Other shared files: `common.cjs` (one name added to the `algorithmHash` list), `launch.cjs` (the two defaults, so `launch-next.cjs` accepts the flags), `report.cjs` (a `sensitivityTools` require, a `sensitivitySummary` const, `+sensitivitySummary` before `+opponentSection`, a `sensitivityMd` const, `+sensitivityMd` after `championMd`), `export-report.cjs` (`sensitivity:state.sensitivity||null,` after `finalPanel`), `rematch.cjs` (export `defaultPlay`, a `label` option), `meta.cjs` (about ten small insertions), `neural.js` (`portable-7` to `portable-8`) and `familyRanks.html` (`neural.css?v=theme-1` to `theme-2`) for cache busting.

## Design

**The metas.** Six, in report order, each on its own sealed panel of N fixtures shared by every team:

| id | what it is | needs |
| --- | --- | --- |
| `independent-1.25` | independent draws at PvPoke weight power 1.25 (the run's synthetic default) | |
| `coherent` | coherent draws only: weighted lead, then coverage-weighted members, 40% ABB shape (run's weight power) | |
| `observed` | observed teams only, with the run's half-life, as-of date and creator caps | usage file |
| `observed-without-top-creator` | the same without the creator with the largest decayed, capped weight (10.2% of it in the current file) | usage file with at least two creators |
| `independent-1.0`, `independent-1.5` | independent draws at the other two exponents | |

The exponent variants use independent draws so that the popularity assumption is isolated and comparable with `independent-1.25`; with the hybrid meta the exponent would move only the 25% synthetic share. Without a usage file a run has four metas. The standalone tool names the creator on its console; the search does not print it, and reports carry only its weight share and a 12-character hash.

**The controller keeps the run's belief prior** in every meta. Only the opponents change, so the panel isolates the target distribution; regenerating the 2,048-lineup prior per meta (as `rematch.cjs` does for its one meta) would also change the controller's beliefs and mix two effects.

**Seeds.** `sensitivitySeeds(validationSeed, ids, reserved)` hashes the validation seed and the meta id (like `screeningSeed`), then `guardedSeed`s the result against the validation seed, the screening seed, the retest-panel, reference, belief and baseline seeds and the seeds already issued to the other metas. A meta keeps its seed whichever others are tested. `assertFreshSeeds` refuses any seed listed in absorbed `evaluationEvidence`. The panels' fixtures are checked against the screening, final and retest fixtures and against inherited training observations (matching the per-fixture battle seed first, so the check costs one set lookup per observation).

**Scheduling and budget.** The jobs are one interleaved list (fixture 0 of every meta, then fixture 1, ...) played fixture-major through the existing `evaluate(..., {commonPanel:true})`, so a deadline or a stop leaves every team with the same prefix and every meta with the same length (`floor(done / K)` fixtures; fewer than K positions records nothing). The panel runs after the final test, bounded by the run's deadline, so it can never shorten screening or the final panel. `trainingBudget` adds its battles to the evaluation estimate, which can only move the end of training earlier. For an 8-hour, 12-worker run at the measured 14.4 battles/s the 20% reserve (1.6 h) still binds: the panel (8 finalists x 6 metas x 128 = 6,144 battles, about 7 minutes) fits inside it and training is not shortened. At `--sensitivity-fixtures 512` (24,576 battles, about 28 minutes) the estimate becomes (22,528 + 24,576) / 14.4 s x 1.25 = 1.1 h, still inside the reserve.

**Statistics.** Per team and meta: the mean score and its standard error. Per team: the mean over metas, the min (and which meta), the max, the **spread = max − min**, the rank among the listed teams per meta, a 95% bootstrap interval for the spread (fixtures resampled within each meta, because the metas use different fixtures), and **`noiseSpread`**, the median spread that fixture noise alone would produce if the team scored the same under every meta (K normal draws with the observed standard errors). The last one matters: the maximum minus the minimum of K noisy means is biased upward, by roughly 2.5 standard errors for six metas, so at 128 fixtures a team with identical true scores everywhere still shows a spread of about 7 to 9 points (4 to 5 at 512). A spread is only evidence of meta dependence where it clearly exceeds that floor. `meanMinusSpread` is recorded per team for study and is not used for anything.

**Report.** The block sits beside `finalPanel` under the field name `sensitivity` (schema stays 1; `neural-report-core.js` validates its shape, ranges and sizes and refuses malformed blocks; reports without it are unchanged). `report.html` and `findings.md` get a section; the viewer gets the table (teams down, metas across, the run meta's final-test score for reference, mean, min, spread with its interval, noise floor; it scrolls sideways inside `.table-scroll`) and one line under each finalist's bar: `across 6 metas: min 62.5%, spread 14.1 points`. The line and caption wording is duplicated in the viewer (it cannot load the Node module) and a test compares both copies.

**The standalone tool.** `node training/team-search/sensitivity.cjs RUN_OR_REPORT ...` maps the finalists of a run directory, `recommendations.json` or portable report into the pool with `champions.loadChampions` (as `rematch.cjs` does), takes the belief prior and controller settings from the run's checkpoint (or the report's `engineOptions`) and the usage settings from `launch.json` and the checkpoint's `meta` (flags override; it warns when the usage file's hash differs from the run's), draws a base seed that no source used and derives the per-meta seeds from it, plays the jobs with `rematch.defaultPlay`, and prints the table, the best team per meta, a simultaneous 95% band per meta over all pairs (`paired-stats.cjs`) and the order by mean − spread. `--scope primary`, `--baselines`, `--metas`, `--seed` and `--print SAVED.json` are available.

**Date strata.** `usage_export.py --since YYYY-MM-DD --until YYYY-MM-DD` (inclusive, validated) keeps teams dated inside the window by the exporter's existing date rule. It is applied after the repeated-battle rule, so which copy of a re-uploaded battle is kept does not change with the window (a test pins this), and before the creator cap, so the cap is computed on the window's own creators. The quality report counts the dropped teams as `date-range` and states the window; the file gets a `window` key only when a window was given, so unwindowed exports are unchanged.

**Rating strata: not possible.** No battle or video record in the catalog has an opponent rating or rank bracket: the per-battle fields are `battleType, best, cpCap, cps, cup*, end, ending, fainted, flags, league, matchups, moves, my, myDetail, opponent, opponentDetail, result*, rocket*, scheduled, shieldsUsed, start`, and the extractor does not read a rating from the result screen. The only rating information is free text in video titles: 64 of the 3,773 registry titles mention ELO or MMR and 19 give a number, and that number is the **creator's own** rating at that moment, not their opponent's. A `--rating` filter would have been invented, so none was added; the README says so and the file's `rank` text keeps saying "rating not measured".

## Measurements

### 1. The completed v4 observed run's eight finalists under three metas (exploratory)

```
cd web
nice -n 10 node training/team-search/sensitivity.cjs "/Users/evanfries/Desktop/Projects/GBL Synapse/web/training/runs/team-search-v4-observed-2026-10-12" \
  --scope finalists --metas observed,independent-1.25,coherent --fixtures 64 --workers 4 --seed 20261013 \
  --out training/runs/sensitivity-v4-observed-64.json
```

1,536 battles in 128 s (12.0 battles/s). The tool took the run's belief prior and controller settings (24-turn forecasts, 3 belief worlds) from its checkpoint and the usage file, half-life 30 days and as-of 2026-10-12 from its `launch.json`; the usage file's hash matches the run's. Panel seeds: `independent-1.25` 1693383008, `coherent` 3371202328, `observed` 2838343755 (base seed 20261013). 64 fixtures per meta: every number has a standard error of about 4 to 5 points.

| # | Team (lead first) | Final test, run meta (512) | Independent 1.25 | Coherent | Observed | Mean | Min | Spread [95% interval] | Noise alone |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| t1 | **Primary** Talonflame (Shadow) / Mandibuzz / Bastiodon | 83.5% | 82.8% | 89.1% | 82.0% | 84.6% | 82.0% (observed) | 7.0 [1.6, 20.3] | 7.3 |
| t2 | Magcargo / Charjabug / Mandibuzz | 86.7% | 92.2% | 82.8% | 89.1% | 88.0% | 82.8% (coherent) | 9.4 [1.6, 21.9] | 6.3 |
| t3 | Talonflame (Shadow) / Mandibuzz / Carbink | 85.0% | 81.3% | 81.3% | 82.8% | 81.8% | 81.3% (independent) | 1.6 [1.6, 18.8] | 7.7 |
| t4 | Talonflame (Shadow) / Umbreon / Carbink | 84.0% | 84.4% | 76.6% | 87.5% | 82.8% | 76.6% (coherent) | 10.9 [3.1, 25.0] | 7.5 |
| t5 | Talonflame (Shadow) / Mandibuzz / Bastiodon (other moveset) | 83.9% | 82.8% | 85.9% | 82.8% | 83.9% | 82.8% (independent) | 3.1 [1.6, 17.2] | 7.3 |
| t6 | Talonflame (Shadow) / Mandibuzz / Carbink (other moveset) | 82.7% | 76.6% | 83.6% | 84.4% | 81.5% | 76.6% (independent) | 7.8 [1.6, 21.9] | 7.4 |
| t7 | Talonflame (Shadow) / Umbreon / Carbink (other moveset) | 82.4% | 84.4% | 75.8% | 82.8% | 81.0% | 75.8% (coherent) | 8.6 [2.3, 23.4] | 7.8 |
| t8 | Talonflame (Shadow) / Empoleon / Umbreon | 80.6% | 85.2% | 75.0% | 81.3% | 80.5% | 75.0% (coherent) | 10.2 [2.3, 24.2] | 7.7 |

What it shows, and what it does not:

- **Nothing here is distinguishable from fixture noise.** The mean spread of the eight finalists is 7.3 points against a mean noise floor of 7.4; no team's spread interval excludes the floor. No pair of finalists is resolved on any meta: the simultaneous 95% band over all 28 pairs is ±16.4 (independent), ±18.8 (coherent) and ±16.4 points (observed). The paired differences between the primary and each other finalist run from −9.4 to +14.1 points, all unresolved.
- **Scores are high everywhere** (75% to 92%): the finalists are strong against all three distributions, not just the one they were searched against. The mean score over the eight teams is 83.7% (independent), 81.3% (coherent) and 84.1% (observed).
- **The orderings move, within noise.** The primary ranks 5th, 1st and 7th of 8 on the three metas; the best team is t2, t1, t2. t2 (Magcargo / Charjabug / Mandibuzz, the highest final-test score in the run but not the screening winner) has the best mean (88.0%) and a min (82.8%) that is no worse than the primary's (82.0%). That is a hint, not a finding: it is the pattern the selection protocol says to expect from eight near-equal finalists.
- **A possible weakness of the Umbreon / Empoleon teams against coherent draws** (t4, t7, t8: 75.0% to 76.6% there against 81% to 88% on the other metas, +12.5 to +14.1 points for the primary on that meta) is the only structure that stands apart, and it is still inside the band (lower ends −4.7 to −6.3). A 512-fixture panel is the way to find out.
- **Mean − spread** orders the teams t5 > t3 > t2 > t1 > t6 > t7 > t4 > t8 (80.7% down to 70.3%; the primary is fourth). At 64 fixtures this ordering mostly rewards teams whose three noisy scores happened to be close (t3's 1.6-point spread is well below its 7.7-point noise floor), so it is not evidence for or against a robust objective.

The full result, with every fixture score and the per-meta paired bands (machine paths removed), is saved beside this note as [meta-sensitivity-v4-observed-64.json](meta-sensitivity-v4-observed-64.json) (17 KB); `node training/team-search/sensitivity.cjs --print findings/meta-sensitivity-v4-observed-64.json` redisplays it, and the per-fixture scores in it are the data a robust-objective study would start from.

### 2. Smoke search with the panel (pipeline, report and viewer)

```
nice -n 10 node training/team-search/search.cjs --pool training/runs/team-search/pool.json --out training/runs/smoke-sensitivity \
  --hours 0.1 --workers 4 --initial-teams 16 --batch-teams 8 --opponents 8 --screen-teams 4 --screen-opponents 16 \
  --validation-teams 2 --validation-opponents 16 --baseline-count 3 --candidates 200 --rounds 2 --champions none \
  --sensitivity-fixtures 16 --sensitivity-groups all \
  --usage-file ".../observed-gl-opponents.json" --usage-half-life-days 30 --usage-as-of 2026-10-12 --usage-prior-strength 155
```

816 new battles in 87 s (9.4 battles/s, load average about 32). The panel ran after the final test on 5 teams (2 finalists and the 3 baselines) x 6 metas x 16 fixtures = 480 battles, complete (16 of 16 fixtures on every meta). The checkpoint holds `sensitivity` (and the per-fixture `sensitivityScores`), `recommendations.json` carries the identical block beside `finalPanel`, `report.html` has the "Meta sensitivity" section, `findings.md` the per-team lines, and `report.pvpteams.json.gz` (394 KB) carries it, validates with `neural-report-core.js` and renders in the viewer: checked in the browser pane against this report, where each of the two finalists' bars has its line (`across 6 metas: min 31.3%, spread 18.8 points`, `across 6 metas: min 12.5%, spread 43.8 points`) and the table scrolls sideways. The smoke scores themselves mean nothing (8 teams per round, 16 fixtures: the noise floor is 30 points).

The automated check of the same path, `search-sensitivity.test.cjs`, runs the real search loop with deterministic battles and shows that a run with the panel is byte-identical to the same run without it in everything produced before the panel (training evidence, history, screening, final test, baselines, fixture panels), plays exactly teams x metas x fixtures extra battles, stops cleanly (SIGINT) with a common prefix of 2 of 3 fixtures on every meta and says so, records nothing when not one position per meta completed, and refuses a warm start whose evidence used one of the panel's seeds.

### 3. Date window on the real archive

The exporter was **not** run against the harvester's work directory (the batch video analysis is writing there, and the catalog build may write caches); the filters are tested on a synthetic harvest. From the current usage file (read-only): 540 appearances, of which 535 are dated 2026-10-01 or later (36 in ISO week 40, 427 in week 41, 72 in week 42) and 5 are from 2025-04; 356 are from 2026-10-08 on. A date comparison (an early against a late window) is therefore not yet meaningful: the archive spans about three weeks and 79% of it is one week. It becomes possible as the harvest grows.

## Limits

- The alternative metas are a **hand-chosen list, not a sample of plausible metas**. A team's min and spread are over these six; a different list gives different numbers, and the maximum minus the minimum grows with the number of metas. The metas are also not independent (`observed-without-top-creator` shares about 90% of `observed`'s weight; the three exponents are similar), so the spread is not a calibrated uncertainty about the real meta.
- **Fixture noise dominates at the sizes tried.** 64 fixtures per meta (exploratory) and 128 (the default) leave 7 to 9 points of spread from noise alone; 512 leaves 4 to 5. Only the full-scale panel can show a meta dependence of a few points.
- The controller's belief prior is the run's own in every meta, so a meta far from it (coherent only) is also a test of the controller's beliefs; both players share them.
- Scores under different metas are not comparable as strength, and the mean over metas is not a strength. The run-meta column is on a different panel (512 fixtures, its own seed) and is for reference.
- One canonical battle per fixture (v4); the standard errors count fixtures, not mirrored games.
- Opponents use recommended movesets and the observed metas are the top-creator sample the README describes; the sensitivity panel does not vary either.
- The panel needs the run's belief prior: v1 to v3 reports have none, so the standalone tool needs a v4 run directory or report.
- The spread of one team is not compared with another team's with a paired test; teams share fixtures within a meta, so the per-meta simultaneous bands are paired, but the spread statistic itself is not.
- `usage_export.py --since/--until` is verified on a synthetic harvest only; rating strata do not exist.

## What remains (full-scale runs, exact commands)

Run from `web/` of the main checkout on an idle machine.

1. **The panel on the completed v4 run's eight finalists at full scale: 512 fixtures per meta, 12 workers.** 8 teams x 6 metas x 512 = 24,576 battles, about 20 to 30 minutes at the run's measured 14.4 battles/s (12 workers, idle machine).

   ```
   nice -n 5 node training/team-search/sensitivity.cjs training/runs/team-search-v4-observed-2026-10-12 \
     --scope finalists --fixtures 512 --workers 12 --seed 20261014 \
     --out training/runs/sensitivity-v4-observed-512.json
   node training/team-search/sensitivity.cjs --print training/runs/sensitivity-v4-observed-512.json
   ```

   Add `--baselines` to include the 12 baseline teams (20 teams, 61,440 battles, about 70 minutes). Run it a second time with a different `--seed` (for example 20261015) to see how much the spread moves between panels: that is the replication a robust-objective study needs.

2. **Every new search now includes the panel** (128 fixtures; 6,144 battles for eight finalists). For a sharper read-out in the next overnight run: `node training/team-search/launch-next.cjs --hours 8 ... --sensitivity-fixtures 512`, or `--sensitivity-groups all` to include the baselines and previous champions. Disable with `--sensitivity-fixtures 0`.

3. **Date strata** once the archive is wider (run when the batch analysis is idle, because the exporter reads the harvest directory):

   ```
   python3 -I scripts/yt-harvest/usage_export.py --since 2026-10-08 --out training/runs/usage-from-oct-08.json
   python3 -I scripts/yt-harvest/usage_export.py --until 2026-10-07 --out training/runs/usage-to-oct-07.json
   ```

   then `sensitivity.cjs ... --usage-file training/runs/usage-from-oct-08.json` for each, to see how the finalists fare against an early and a late window.

4. **Robust objective (future work).** Whether selecting by mean minus spread (or by the minimum) gives better teams cannot be answered from one run. The data to evaluate it is recorded: per-team per-meta scores in `recommendations.json` and every fixture score in the checkpoint's `sensitivityScores`; the study needs the 512-fixture panels above, replicated seeds, and a judgement on an independent panel, since the spread and the selection would otherwise be measured on the same fixtures.

5. **Rating or skill brackets**, which no current data supports: reading the rank or rating shown on the battle result screen would be new Meta Extractor work, after which the exporter could gain a `--rating` filter.

## Tests

`node --test training/*.test.cjs training/next/*.test.cjs training/team-search/*.test.cjs`: 245 tests, all pass (228 s under load average 35 to 45); `python3 -I -m unittest discover -s web/scripts/yt-harvest -p 'test_*.py'`: 145 tests pass; `node --test tests/docs.test.cjs`: 15 pass. New: 13 tests in `sensitivity.test.cjs` (meta modes, seeds, catalog, plan and overlap checks, budget, statistics, prefix assembly, team lists, wording, the standalone tool end to end with a deterministic fake battle, refusals, launcher flags), 3 in `search-sensitivity.test.cjs` (the real search loop), 3 in `sensitivity-viewer.test.cjs` (viewer table, lines, validation), and 4 in `test_usage_export.py` (window bounds, duplicate rule, validation, command line). `tests/docs.test.cjs` and the Python suite pass.

## Full-scale results (2026-10-14)

Eight finalists × six metas × 512 fixtures (`training/runs/full-scale/sensitivity-512.json`, about 6 minutes at 12 workers after forecast reuse). Spreads 2.4 (primary), 4.0, 5.9, 4.2, 4.3, 4.1, 4.5, 6.8 points; fixture-noise floor 4.0; simultaneous half-width per meta ±6 points; best team per meta: finalist 2 on independent-1.25, observed and independent-1.5, finalist 3 on coherent, observed-without-top-creator and independent-1.0; mean − spread order: t2 80.8 > t1 80.4 > t4 80.1. No finalist depends strongly on the meta; no pair resolved.
