# Battles per label: adaptive prefix length and a shared retest panel

Branch work of 2026-10-13 on the "Battles per label" row of README section 12 (speed). Everything here is opt-in; the default (`--acquisition staged`, `--retest-panel 0`) is byte-for-byte the previous behaviour, which a live default-path smoke run and the existing tests confirm.

## Summary

- **Adaptive prefix length** (`--acquisition adaptive --acquisition-step 8`): every candidate plays the common first prefix, then grows `step` fixtures at a time and stops when its optimistic score falls below the pessimistic score of the current k-th best (or at the full panel). Resumable: the round's stage, level and active teams are saved in `pending`, and decisions are a pure function of the recorded scores at completed levels.
- **Shared retest panel** (`--retest-panel N`): a per-run panel of N fixtures drawn once from a guarded seed recorded in the checkpoint config; the retested team and the incumbent play the missing panel fixtures every round; per-team panel scores are saved in the checkpoint and the incumbent-minus-contender paired comparison goes to `history.jsonl` and `recommendations.json`.
- **Offline evaluation without simulation** (`audit-acquisition-offline.cjs`): the two policies replayed with the production decision functions on 122 published v1 batches (exact) and 362 completed-v4 rounds (44% of cells imputed), plus 8 windows of the v4 sealed screening panel (exact, homogeneous leaders).
- **The finding that matters:** the rule as specified (margin 1.28 on both sides, fraction 0.5) is *not a battle saver*. It keeps the true best three teams fully measured essentially always, but spends 47 to 59% more battles per 24-team batch than the staged rule (1,272 to 1,370 against 864); at equal spend it beats the staged curve by 0.0 to 0.4 points of best-three recall. Making the margin a parameter (`--acquisition-margin`, default 1.28, added because of this result) shows the rule can be made budget-neutral: with margin 0.5 and k = 6 (`--promotion-fraction 0.25`) it spends 856 (v1) and 811 (v4) battles and beats the staged curve at the same spend by +4.6 (interval 2.6 to 7.0) and +8.4 (7.0 to 9.9) points of recall@3.
- **Not measured:** whether any of this produces a better final team at equal wall-clock time, and whether the retest panel resolves finalist differences. Both need the full-scale runs listed at the end.

## 1. What changed

| File | Change |
| --- | --- |
| `acquisition.cjs` | `prefixScores`, `pessimisticScore`, `adaptiveContinuation`, `adaptiveNext`, `runAdaptive` (the resumable driver shared with the audit), `adaptiveLabeled`, `DEFAULT_MARGIN`. Existing exports unchanged. |
| `retest-panel.cjs` (new) | panel state, who plays it (`teamsToPlay`), per-team completeness, the paired comparison (`pair`, built on `evaluation.cjs compare`), the compact round summary and the full report (with `compareFinalists` simultaneous bands). Added to the algorithm hash. |
| `search.cjs` | 13 small hunks, listed in section 8. |
| `common.cjs` | `retest-panel.cjs` added to the `algorithmHash` file list (one list entry). |
| `launch.cjs` | the four new flags in its option defaults, so `launch.cjs` / `launch-next.cjs` pass them through. |
| `export-report.cjs` | the portable report's `search` block records `acquisition`, `acquisitionStep`, `acquisitionMargin` and `retestPanel` when they are not the defaults. |
| `audit-acquisition-offline.cjs` (new) | the offline replay audit. |
| tests (new) | `adaptive-acquisition.test.cjs` (10), `retest-panel.test.cjs` (6), `search-adaptive.test.cjs` (3), `audit-acquisition-offline.test.cjs` (11). |

New flags (all validated before any battle): `--acquisition staged|adaptive` (default `staged`), `--acquisition-step N` (default 8), `--acquisition-margin M` (default 1.28, range 0 to 4), `--retest-panel N` (default 0 = off, up to 4096).

Compatibility: the checkpoint `config` gains `acquisition`, `acquisitionStep` (and `acquisitionMargin` when it is not 1.28) only for adaptive runs, and `retestPanel`, `retestPanelSeed` only when the panel is on. A default run's config, history entries and `recommendations.json` carry none of them (checked on a live default run). As with any change to `search.cjs`, the algorithm hash changed, so checkpoints from the previous code cannot be resumed, only warm-started; the algorithm name is unchanged, so portable reports keep their meaning.

## 2. The adaptive rule

After the common first prefix (`--acquisition-fixtures`, default 8) the round proceeds in levels of `--acquisition-step` fixtures. At each completed level, for every candidate with n recorded fixtures:

- shrunk mean m = (sum + 4) / (n + 8) and posterior sd s = sqrt(m (1 - m) / (n + 9)), the same shrinkage as the promotion priority;
- optimistic = `promotionPriority` (m + 1.28 s + ensemble spread); pessimistic = m - 1.28 s;
- k = ceil(`--promotion-fraction` x candidates); the threshold is the k-th largest pessimistic score over *all* candidates, stopped ones included;
- a live candidate continues if its optimistic score is at least the threshold and it has fewer than the full fixture count. The k best by pessimistic score always continue, because optimistic >= pessimistic >= threshold for them.

`--acquisition-margin` replaces the 1.28 on both sides (at the default the optimistic score is exactly `promotionPriority`).

Resumability: decisions are made only when every active candidate has exactly `level` fixtures, and `pending` records `stage` (`screening`, `extending`, `expanding`, then `panel` if the panel is on), `level`, `active` and the completed `levels`. A contiguous-prefix reader treats a hole (a result that arrived out of order before a stop) as the end of the prefix, so a half-dispatched level is never read as complete. Fixtures inside a level are dispatched fixture-major, as before. Tests interrupt the real search loop at six different points (inside the screening prefix, inside several levels, near the end) and require the resumed run's observations, records, round summaries and dispatch order to equal the uninterrupted run's, with no battle replayed.

Checkpoint cost: a v4 checkpoint is about 52 MB and one atomic save took 0.27 to 1.4 s on a loaded machine (load average about 36). The staged flow saves unconditionally at the end of each of its two stages; saving at the end of each adaptive level would add up to six saves per round, which would be several percent of a 60-second round. Intermediate levels therefore rely on the periodic saves (every state a save captures is consistent) and the explicit save when the round's acquisition completes; a crash can lose at most the work since the last periodic save.

## 3. The shared retest panel

- The panel is `uniqueFixtures(fixtures(species, N, retestPanelSeed))` with `retestPanelSeed = guardedSeed(seed + 810001, [screeningSeed, validationSeed])`, recorded in the config, so a resumed run must use the same panel. The run refuses to start if any panel fixture is also a sealed screening or final fixture.
- After a round's acquisition completes, the stage `panel` starts: `teamsToPlay` selects the teams whose source is `retest` (always present when any team is known, because known teams are excluded from the proposals) plus the incumbent (best selection score at that moment), records them in `pending.panelTeams` and `pending.panelIncumbent`, saves, and plays the missing panel fixtures fixture-major. A team that already holds the panel costs nothing, so after the first few rounds the extra cost is the new contenders' panels only.
- Panel outcomes are ordinary labelled fixtures: they go into `observations` (source `retest-panel`) and `records`, so they also feed the selection score and the neural fit. They are checked against the sealed panels, and the portable export's consistency checks pass because records and observations move together.
- `history.jsonl` gets, per round, `retestPanel: {fixtures, incumbent, incumbentScore, teamsOnPanel, comparisons: [...]}`, with the incumbent minus each team that played the panel that round (`delta`, `interval95` from the paired whole-fixture bootstrap of `evaluation.cjs compare`, `standing`). `recommendations.json` gets the full table: the best-ranked team with a complete panel against every other team on the panel, strongest challenger first, plus the simultaneous bands of `compareFinalists`. Per-contender intervals are not multiplicity-corrected, the simultaneous ones are.
- In the smoke run below, 8 panel fixtures gave +0.375 for the incumbent over one contender with a per-contender interval of 0.13 to 0.75, but a simultaneous band of 0 to 0.75 ("unresolved"): a reminder that a small panel resolves little. The panel size is a cost/resolution choice for the full-scale run.

## 4. Offline evaluation

`node training/team-search/audit-acquisition-offline.cjs --v4 CHECKPOINT --out FILE` (the published v1 fixtures are the default `--v1` input). It never simulates and never writes into a run directory. Every decision goes through the production functions (`promoteCandidates`, `adaptiveNext`, `pessimisticScore`) on a pending-round object, and a test checks that the audit's replay equals the resumable `runAdaptive` driver. The model-uncertainty bonus is 0 in every replay, because the checkpoints do not keep per-round predictions; the staged replay can therefore promote slightly different teams than the real run did (the real run's promotion also used the ensemble spread).

### Data

| Source | Batches | What is recorded | Imputation |
| --- | --- | --- | --- |
| **v1** published per-team fixtures (`web/includes/pro/data/team-teams`) | 122 clean panels of exactly 24 teams x 64 fixtures (and the fixtures of every panel have the same order for all its teams: 122 of 122). 31 other panels were skipped (inherited pilot panels of 17 to 83 teams x 32 fixtures, a 24 x 128 panel, incomplete or larger ones). | every team has all 64 fixtures | none; exact |
| **v4** completed run `team-search-v4-observed-2026-10-12` | 362 rounds of 24 teams (round 0 with 128 teams and the interrupted last round skipped) | 12 promoted teams with 64 fixtures, 12 teams with only the shared 8-fixture prefix | the 12 x 56 unplayed fixtures per round, 43.75% of the cells |
| **elite**: the same run's sealed screening panel | 8 windows of 64 fixtures over the 24 training leaders' 512 fixtures | every team has every fixture | none; exact, but one fixed set of 24 similar teams |

For v4 the shared prefix is the set of fixtures every team played; it is placed first and the order beyond it is arbitrary, because fixtures are i.i.d. draws from the meta.

### Imputation model (v4 only)

Posterior-predictive completion, repeated 20 times per round with a fixed seed: per round, fixture effects are estimated from the recorded cells (additive team + fixture model; the survivors' per-fixture means vary about three times more than independent battles would, so opponent difficulty is shared) and shrunk by their estimated reliability; each source (neural, uncertainty, random, retest) has a Beta prior for a team's true mean, fitted from the shared prefix, which is unselected, by moment matching on fixture-adjusted means with the within-team sampling variance removed; a cut team's posterior comes from its adjusted prefix wins, and each unplayed cell is drawn from that posterior shifted by the fixture's effect. The fitted priors (prefix mean and between-team sd): neural 0.71 and 0.067, uncertainty 0.69 and 0.075, random 0.31 and 0.098, retest 0.78 and 0.062. In other words the model says neural proposals within one round differ by only a few points of true strength, so their ranking is mostly sampling noise, which is also why every policy has trouble here. About 12% of the true top-three slots in the completed matrices are filled by imputed (never fully observed) teams. Opponent-level correlation among teams is only partly modelled, and the v4 recall figures depend on this model; the exact v1 and elite numbers do not.

### Metrics

Per batch: battles spent; teams fully measured; truth is each team's mean over all 64 fixtures; **recall@k** is the share of the true top k that reached 64 fixtures ("how often the true top-k end up fully measured"); "all top 3" is the share of batches in which all three did; leader regret is the true mean of the best team minus the true mean of the team the selection score would pick as training leader from the fixtures each team actually has. Staged policies are `staged m=M` (promote the top M to 64, M = 1 to 24). Adaptive policies are `step S k=K [margin Z]`. The equal-spend comparison interpolates the staged curve at the adaptive policy's mean spend and bootstraps over whole batches (1,000 resamples; 300 in the margin sweep).

### Results at the specified margin (1.28), 24 teams, prefix 8, full 64

| Data | Policy | Battles per batch | Recall@1 | Recall@3 | All top 3 | Recall@6 | Leader regret (points) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v1 (122) | staged m=12 (current default) | 864 | 95.1% | 93.4% | 80.3% | 89.5% | 0.07 |
| v1 | staged m=18 | 1,200 | 100.0% | 99.5% | 98.4% | 98.8% | 0.00 |
| v1 | adaptive step 8, k=3 | 1,143 | 100.0% | 100.0% | 100.0% | 100.0% | 0.00 |
| v1 | adaptive step 8, k=12 (the default fraction) | 1,370 | 100.0% | 100.0% | 100.0% | 100.0% | 0.00 |
| v4 (362, 44% imputed) | staged m=12 | 864 | 91.0% | 88.9% | 70.8% | 86.0% | 0.27 |
| v4 | staged m=18 | 1,200 | 99.4% | 99.1% | 97.5% | 98.7% | 0.02 |
| v4 | adaptive step 8, k=3 | 1,117 | 99.9% | 99.9% | 99.7% | 99.7% | 0.00 |
| v4 | adaptive step 8, k=12 | 1,272 | 100.0% | 100.0% | 100.0% | 100.0% | 0.00 |
| elite (8) | staged m=12 | 864 | 62.5% | 66.7% | 37.5% | 60.4% | 0.29 |
| elite | staged m=18 | 1,200 | 87.5% | 95.8% | 87.5% | 91.7% | 0.00 |
| elite | adaptive step 8, k=12 | 1,523 | 100.0% | 100.0% | 100.0% | 100.0% | 0.00 |

At equal spend (recall@3, adaptive minus the staged curve, 95% interval): v1 k=3 step 8 +1.1 (0.3 to 2.2), k=6 +0.4 (0.0 to 1.2), k=12 0.0; v4 k=3 +2.0 (1.7 to 2.5), k=6 +1.0 (0.7 to 1.4), k=12 +0.4 (0.2 to 0.7); elite 0.0 everywhere (it spends almost the whole 1,536). The "spend saved at the same recall" column in the audit output saturates when the adaptive recall is about 100% (the staged curve reaches 100% only at M = 24), so use the equal-spend recall difference instead.

Reading: at the specified margin the rule is a high-assurance rule. It makes the three best teams of a batch fully measured almost surely, and the leader pick essentially never wrong, but it needs 27 to 59% more battles than staged m=12 to do so, and where candidates are indistinguishable (elite) it simply measures everyone. It is not the "fewer battles per label" change the row asked for.

### Step size, and the cost of synchronisation

| Step (v1, k=12) | Battles | Recall@3 | Worker time lost to level barriers, 12 workers |
| --- | ---: | ---: | ---: |
| 4 | 1,349 | 100.0% | 3.3% |
| 8 | 1,370 | 100.0% | 1.6% |
| 16 | 1,397 | 100.0% | 0.8% |

A smaller step stops candidates a little earlier (up to about 7% fewer battles between step 16 and step 4) but adds synchronisation barriers. The barrier figure is a lower bound: it assumes equal battle times and counts only the idle slots a level leaves when its job count is not a multiple of the worker count (the staged flow has two barriers, adaptive about six to eight); real battle durations vary, so tails are longer. Step 8, the requested default, is a reasonable middle, and the full-scale run's telemetry (`battlesPerSecond`, `averageCoresUsed`) is what settles the real cost.

### Budget-matched settings (margin sweep, step 8)

`--steps 8 --fractions 0.125,0.25,0.375,0.5 --margins 1.28,1,0.75,0.5,0.25,0 --replicates 10 --bootstrap 300`. Selected rows; "same spend" is the interpolated staged curve:

| Data | Policy | Battles | Recall@1 | Recall@3 | All top 3 | Recall@6 | Staged at same spend (recall@3) | Difference (95% interval) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| v1 | staged m=12 | 864 | 95.1% | 93.4% | 80.3% | 89.5% | | |
| v1 | **k=6, margin 0.5** | 856 | 98.4% | 97.5% | 92.6% | 95.4% | 92.9% | **+4.6 (2.6 to 7.0)** |
| v1 | k=12, margin 0 | 815 | 95.1% | 95.6% | 86.9% | 91.3% | 90.4% | +5.3 (3.2 to 7.1) |
| v1 | k=9, margin 0.25 | 800 | 96.7% | 94.3% | 82.8% | 90.8% | 89.4% | +4.9 (2.8 to 7.2) |
| v4 | staged m=12 | 864 | 91.0% | 89.1% | 71.2% | 86.0% | | |
| v4 | **k=6, margin 0.5** | 811 | 96.0% | 94.8% | 86.0% | 90.2% | 86.4% | **+8.4 (7.0 to 9.9)** |
| v4 | k=12, margin 0 | 858 | 94.9% | 93.0% | 81.9% | 89.8% | 88.8% | +4.3 (3.1 to 5.4) |
| v4 | k=9, margin 0.25 | 773 | 92.7% | 90.2% | 74.2% | 85.8% | 84.0% | +6.2 (4.9 to 7.4) |
| elite | k=6, margin 0.5 | 1,125 | 87.5% | 91.7% | 75.0% | 89.6% | 88.8% | +2.8 (-12.5 to 12.5) |

Margin controls the budget: at k=6, v1 spends 1,222 / 1,125 / 1,017 / 856 / 638 / 485 battles for margins 1.28 / 1 / 0.75 / 0.5 / 0.25 / 0, with recall@3 falling from 100% to 65.6%; below about 0.5 it stops candidates too eagerly (k=6, margin 0.25: 86.1%). On the elite batches no setting is distinguishable from the staged curve (intervals contain 0), as expected for near-identical teams.

Two cautions. First, these settings were picked on the same recorded batches they are scored on. The choice of margin 0.5 / k=6 was made from the exact v1 sweep and then checked on v4 (a different controller and meta, partly imputed), where the direction and size of the gain held, but a fresh run is the real test. Second, recall of the best three teams of one batch is a proxy: the search objective is the quality of the final team at a fixed time budget, which also depends on how many candidates a round can start and on the neural fit, and an offline replay cannot see either.

### Imputation-free check on v4

At the first decision, the one that uses only the recorded 8-fixture prefix of all 24 teams, the model-free staged replay promotes 12 teams and retains the true best three of the 12 recorded survivors 95.6% of the time (the real run used the ensemble spread as well); the adaptive rule (specified margin) continues on average 23.0 (k=12) or 21.7 (k=6) of 24 teams and retains them 100% of the time. That is why it cannot save much at the specified margin: after eight fixtures almost nobody is statistically out.

## 5. Live smoke runs

All with `nice -n 10`, `--workers 4`, `--validation-seed 902`, on a machine whose load average was about 35 on 12 cores, so throughput (3.6 to 5.4 battles per second, 1.5 to 2.1 cores busy) says nothing about speed. They are correctness evidence.

Adaptive + panel:

```
nice -n 10 node training/team-search/search.cjs --pool training/runs/team-search/pool.json --out training/runs/smoke-acquisition-whole --hours 1 --workers 4 --initial-teams 16 --batch-teams 8 --opponents 24 --acquisition-fixtures 4 --acquisition adaptive --acquisition-step 4 --promotion-fraction 0.25 --acquisition-margin 0.5 --retest-panel 8 --screen-teams 4 --screen-opponents 16 --validation-teams 2 --validation-opponents 16 --baseline-count 3 --candidates 200 --rounds 2 --validation-seed 902
```

- Round 1 (16 candidates, 24 fixtures): levels 4, 8, 12, 16, 20, 24 with 16, 11, 9, 6, 6, 6 teams; 216 of 384 possible fixtures (56%); 6 teams fully measured. Round 2 (8 candidates): 8, 8, 7, 7, 7, 7 teams; 176 of 192 (the candidates are indistinguishable at this scale). Panel: the incumbent played 8 fixtures in round 1, the retested team and the incumbent in round 2 (16 tagged `retest-panel` observations in total). 552 battles including screening and final test.
- **Interruption and resume with real battles** (`--out training/runs/smoke-acquisition-resumed`, same command): SIGINT sent to the search process while round 1 was in level 12 of the extension (the checkpoint then held `stage extending, level 12, 9 active teams`, and the checkpoint saved at the stop held 138 battles); `--resume`; a second SIGINT at the panel stage of round 1 landed after that panel had finished, so that stop happened at the round boundary; `--resume`; a third SIGINT during round 2's panel stage, with the retested team's panel half played (8/4 fixtures); `--resume` finished the run. Result: observations, records, battle counter, round summaries (levels, panel comparisons), panel scores, screening, final validations, baselines, finalists and the config were **identical** to the uninterrupted run (408 observations, 552 battles).
- A default-path run with the same code (the command from the task: `--opponents 8`, no new flags) completed: 336 battles, 2 rounds, no new keys in its config, history or `recommendations.json`, no panel state.

The mid-level and mid-panel resume cases are also covered deterministically by `search-adaptive.test.cjs` (six interruption points in adaptive acquisition; two inside the panel stage).

## 6. Limits

- Offline numbers are batch-level recall on recorded outcomes; the v4 ones rest on an imputation model for 44% of the cells (the v1 and elite ones do not). Model uncertainty is 0 in the replay. They are not accuracy or speed claims about a full search.
- The budget-matched settings were chosen on the same data they were scored on (v1 chosen, v4 as a transfer check).
- The elite regime (24 very similar leaders, one fixed set) shows no distinguishable gain; the rule is for rounds where candidates differ.
- The adaptive rule adds synchronisation barriers (estimated 1 to 5% of worker time at 12 workers if battle times were equal; likely more) and, with step 8, spends more of its time at partial occupancy once few candidates remain. The save-skipping above avoids the checkpoint cost; neither effect has been measured at full scale.
- Adaptive spend per round varies with how separable the candidates are, so the number of rounds in a fixed time budget varies; at the specified margin it is fewer than staged.
- The panel's value (does it resolve finalist differences?) is unmeasured; with N = 8 it resolved nothing in the smoke run. Panel fixtures are training labels and enter the fit and the selection score, which slightly changes which teams lead.
- The retest panel reuses the existing retest schedule (`retestTeam` / `movesetRival`); it does not add a second schedule.

## 7. Full-scale benchmarks still to run

Both arms must use the same pool, seeds and opponent meta. The meta file is outside git; copy it first so both arms read the same bytes (the completed v4 run used a file with hash `f772260861ec8e232f376bcc4dc60644c949c3dd8831a3fedf7cab49390eaf64`; the current export may differ, which does not matter as long as both arms use the same copy). From `web/`, one run at a time (each takes all 12 cores):

```
cp "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" training/runs/acq-bench-meta.json

# Arm A: staged (current default)
node training/team-search/launch.cjs --hours 4 --workers 12 --pool training/runs/team-search/pool.json --out training/runs/acq-staged --seed 20261009 --validation-seed 2929289829 --usage-file training/runs/acq-bench-meta.json --usage-half-life-days 30 --usage-as-of 2026-10-12 --usage-prior-strength 155

# Arm B: adaptive, budget-matched (about 856 battles per 24-team batch in the offline replay)
node training/team-search/launch.cjs --hours 4 --workers 12 --pool training/runs/team-search/pool.json --out training/runs/acq-adaptive --seed 20261009 --validation-seed 2929289829 --usage-file training/runs/acq-bench-meta.json --usage-half-life-days 30 --usage-as-of 2026-10-12 --usage-prior-strength 155 --acquisition adaptive --acquisition-step 8 --promotion-fraction 0.25 --acquisition-margin 0.5
```

Same `--hours` means equal wall-clock budget; the sealed screening and final panels are identical because the validation seed, meta and pool are. To compare: the finalists' final scores and their paired difference on the shared final panel, for example

```
node -e "const {compare}=require('./training/team-search/evaluation.cjs'),a=require('./training/runs/acq-staged/checkpoint.json'),b=require('./training/runs/acq-adaptive/checkpoint.json');console.log(compare(b.validations[0],[a.validations[0]],{seed:1}))"
```

(`validations[0]` is each run's screening-selected primary; both use the same 512 fixtures.) Also read from each `checkpoint.json`: `round`, `battles`, `records.length` (teams started), `latestDiagnostics`, `runtime.battlesPerSecond` and `runtime.averageCoresUsed` (the real synchronisation and save cost), and the best screened score. One pair of runs is one sample of a noisy search; if the difference is within the final panel's uncertainty, repeat with a second seed pair before choosing a default.

Optional third arm (the rule exactly as specified, expected to be about 50% more battles per round and so fewer rounds): add `--acquisition adaptive --acquisition-step 8` (margin 1.28, fraction 0.5) to Arm A's command. Optional panel arm: add `--retest-panel 32` to Arm A or B and read `recommendations.json` `retestPanel` (comparisons and the simultaneous bands) for whether contenders become distinguishable; this adds about 32 battles per newly retested contender.

An offline re-run of the audit on any later checkpoint: `node training/team-search/audit-acquisition-offline.cjs --v4 CHECKPOINT --out FILE --markdown FILE` (add `--steps`, `--fractions`, `--margins` for sweeps).

## 8. `search.cjs` hunks (to re-apply if a merge conflicts)

Anchors are unique strings in the file as of this branch.

1. After the long `require` block (line 4): `const {runAdaptive}=require('./acquisition.cjs'),retestPanelTools=require('./retest-panel.cjs');`.
2. After the `promotion-fraction must be in (0, 1]` check: `const acquisitionMode=...,acquisitionStep=...,acquisitionMargin=...,retestPanelSize=...,adaptive=...` and four validation lines (`acquisition must be staged or adaptive`, `acquisition-step`, `acquisition-margin`, `retest-panel`).
3. The `referenceFixtureSeed=...` statement: append `,retestPanelSeed=searchSeed(seed+retestPanelTools.SEED_OFFSET)`.
4. In the `config={...}` object, after `acquisitionFixtures,promotionFraction,`: `...(adaptive?{acquisition:'adaptive',acquisitionStep,...(acquisitionMargin!==1.28?{acquisitionMargin}:{})}:{}),...(retestPanelSize?{retestPanel:retestPanelSize,retestPanelSeed}:{}),`.
5. Before `const activeClock=`: the panel cases (`retestCases`), the sealed-overlap guard and `state.retestPanel??=createPanel(...)` (two lines and a comment).
6. After the `if(observation)scores[i]=observation.score;}}` recovery loop: one line recovering panel scores from evidence for `state.pending.panelTeams`.
7. `async function evaluateAcquisition(teams,n)` becomes `(teams,n,target=state.pending,panel=cases,tag='')`: `missingFixtures(target,teams,panel,n)`, `cases[w.fixture]` -> `panel[w.fixture]` (four places), `source:tag||state.pending.sources?.[key]||'initial'`, `(target.scores[key]??=[])[w.fixture]=...`.
8. The end of `evaluateAcquisition`: `save();return stageComplete(state.pending,teams,n);` becomes `const complete=stageComplete(target,teams,n);if(!adaptive||tag||!complete)save();return complete;` (with a comment).
9. Before `if(state.pending.stage==='screening'){`: `if(adaptive){if(!await runAdaptive(state.pending,{prefix:screenCount,full:cases.length,step:acquisitionStep,fraction:promotionFraction,margin:acquisitionMargin,evaluate:evaluateAcquisition}))break;save();}` and the existing line becomes `else if(...)`.
10. After `if(!await evaluateAcquisition(state.pending.promoted,cases.length))break;`: the `let panelSummary=null; if(retestCases.length){...}` panel stage (six lines).
11. In the `acquisition={...}` summary: append `...(adaptive?{mode:'adaptive',step:acquisitionStep,...margin,levels:state.pending.levels}:{})`; in the `summary={...}` object, `...(panelSummary?{retestPanel:panelSummary}:{}),` after `acquisition,`.
12. In the final `report={...}` of the `finally` block: `...(adaptive?{acquisition:{...}}:{}),...(retestCases.length?{retestPanel:retestPanelTools.report(...)}:{}),` before `warning:`.
13. The CLI defaults object (`acquisition:'staged',acquisitionStep:8,acquisitionMargin:1.28,retestPanel:0,`) and the `--help` string.

Other files touched outside `search.cjs`: `acquisition.cjs` (append), `common.cjs` (one list entry), `launch.cjs` (one defaults entry), `export-report.cjs` (one object spread), README.md (sections 2, 7, 10, 12, 13, 14; headings unchanged), REFINEMENT_FINDINGS.md (pointer).
