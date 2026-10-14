# Controller: weighted replies, rollout continuation and a policy-diversity panel (2026-10-13)

Section 12 accuracy row "The controller". Goal: two controller alternatives behind options whose defaults leave every v4 battle byte-identical, and a panel that shows how much a team's score depends on the opponent's way of playing.

**Result.** Both options and the panel work end to end and default outcomes are unchanged (0 differences in 216 traced and headless before/after comparisons, all pinned fixtures pass). Measured at smoke scale on a shared machine, nothing here is a strength or accuracy claim:

- **Weighted replies** (`--reply-model weighted`, T = 0.25) changed 15 of 128 battles and scored exactly 50.0% head to head against the default controller (64 fixtures, interval 46.9–53.1%). At this temperature it is nearly the worst-case controller. It costs no extra simulation.
- **Rollout continuation** (`--rollout-continuation 8`) changed 94 of 128 battles and scored 53.5% against the default (interval 46.5–60.6%): unresolved. It costs about 1.16× CPU per battle and 1.3× per decision with both sides continuing.
- **Policy panel** on the eight finalists of the 2026-10-12 observed run (32 fixtures per style, exploratory): the default v4 controller was the hardest opponent style for five of the eight finalists. Every crude style scored at or above the default for the primary. No style was resolved below the default for any finalist, and never-shield was resolved above it for five. The panel's "spread" is therefore mostly how easy a never-shielding opponent is. The more useful readings are the lowest style and any style below the default (three finalists, all unresolved).

All measurements ran with `nice -n 10` and 4 workers while other agents and a batch video analysis shared the machine (1-minute load average 33 to 48).

## 1. What was built

**Controller options** are defined once, in `next/lookahead-v4.js` between `<controller-options>` markers. The battle VM, Node (`next/controller-options.cjs`, which evaluates that same section) and the generated browser adapter all use that section. Absent options are the defaults.

| Option | Default | Effect |
| --- | --- | --- |
| `replyModel` | `worst` | `weighted`: for each own choice and imagined lineup, the expectation over the opponent's legal replies with weight ∝ exp(u/T). u is the reply's value for the opponent: the rollout value negated, under the same lineup. The expectation is computed exactly, not sampled, so it is deterministic and consumes no random stream. |
| `replyTemperature` | 0.25 | T in (0, 10]. T → 0 reproduces the worst case exactly (tested at T = 1e-7 on 6 fixtures). |
| `rolloutContinuation` | 0 | N in 1..24: when a forecast duel ends with a faint and that side has a living bench, each legal replacement continues the duel for up to N steps. The survivor keeps its post-duel state; the replacement enters with no cooldown. The replacing side keeps its best one (the decider maximises, the opponent minimises; a double faint is the decider's maximin). |
| `switchMargin` | 0.08 | The voluntary-switch threshold: 0 is eager; 1e9 or more never switches voluntarily and skips that decision. |
| `shieldPolicy` | `default` | `always` or `never`. |

- **Scope.** Options apply to both sides, or per side through `controllerTeams: [A, B]` in caller order; per-side controllers follow their teams into physical slots. Only `replyModel`, `replyTemperature` and `rolloutContinuation` are search flags. The other two exist for the panel.
- **Forecast-reuse caches.** Rollout values do not depend on the reply model, so a cached branch is shared by both models and only the aggregation differs. A continued rollout is a different forecast, so the branch key carries N. Continuation duels are cached per step under their captured rows, as first duels are. The new counters (`rolloutSteps`, `continuations`, `continuationDuels`, `continuationSteps`) count logical work, so they agree on both forecast paths. They appear only when a side continues, so default planner statistics keep their exact keys.
- **Orientation.** When the two sides run different controllers, distinct teams keep the default orientation (so every panel style replays the default battle's seed and physical slots). Only identical teams are then ordered by controller, and they are no longer reported as a mirrored pair.

**Identity.** A run with options records them in `config.controller`. Its mechanics id becomes the v4 id plus a readable suffix, for example `1b33a32b…+controller:replyModel=weighted,replyTemperature=0.25`. These checks then refuse to mix it with default runs:

- resume, which compares the config digest;
- warm start and `merge.cjs`, which compare the mechanics id;
- `export-report.cjs`, which recomputes the id from `config.controller`;
- the browser. The portable report's `engineOptions` carries the options, and the v4 adapter (`team-replay-v4-manifest.js` `controllerSuffix`, worker and page check) replays a report only when its id equals the adapter's id plus the suffix of those options. A variant report under the default id, a default report claiming a suffix, per-side controllers in a report, and a variant report in an older adapter are all refused.

The search integration test exercises each of these refusals, and the replay test exercises the browser ones.

**Policy-diversity panel** (`next/policy-panel.cjs`). The given teams keep their own controller (the run's), and the opponent side plays six styles: default v4, weighted replies, no voluntary switches, eager switches, always shield and never shield. Jobs are fixture-major, so a deadline leaves a common prefix. For each team the panel reports per style the mean, the lowest score, the spread (best minus worst style), a simultaneous paired bootstrap band over all pairs of styles (`paired-stats.cjs`), and each style minus the default with its band. It is available in two ways:

- In a search, `--policy-panel N` (0 = off) runs it on the finalists after the final test, up to the run's deadline. The training budget reserves its battles and the screening share counts them. The results go to `state.policyPanel` (with per-fixture scores) and, without them, to `recommendations.json`, `report.html`, `findings.md` and the portable report's `policyPanel`, which `neural-report-core.js` validates.
- On any finished run: `node training/next/policy-panel.cjs RUN_OR_REPORT --fixtures N`.

The viewer adds a caption line to the "Finalists on the same final opponents" card and a table to Search Performance.

`next/controller-ab.cjs` is the head-to-head check. It uses the `controller-check.cjs` pattern (both rosters, both controllers), on search-shaped fixtures, with a default-vs-default reference run before and after for timing and changed-battle counts.

## 2. Default behaviour is byte-identical

- **Before/after comparison.** A frozen copy of `engine-v4.cjs`, `engine-v4-core.cjs`, `utils.cjs`, `lookahead-v4.js` and `observations.js` at `2902a40` was compared with the new code on 216 fixtures, each traced with `audit` and headless:
  - 96 search-shaped fixtures from in-git data;
  - 24 `simulatorFixtures`;
  - 96 search-shaped fixtures from the prepared pool with the observed usage file (half-life 30 days, as of 2026-10-12, prior strength 155).

  The whole result was required to be JSON-equal: score, turns, remaining, charged count, planner statistics with the observation records, every HP sample and every timeline event. Result: **0 differences**, covering 761 voluntary and 852 forced switches, 23,594 timeline events and 17,336 HP samples.
- **Existing tests, unchanged and passing.** `mechanics-fixtures.test.cjs` (37 pinned battles), `forecast-reuse.test.cjs`, `simulator-speed.test.cjs`, `replay-v4.test.cjs` (regenerated adapter), `observations.test.cjs`, `forecast-performance.test.cjs`, `engine-v4.test.cjs` and `simulator-compatibility.test.cjs`.
- **Registration.** The new v4 source hash `9441bc39…` is registered under the existing mechanics id `1b33a32b…` in `simulator-compatibility.json`, so default reports, replays and warm starts stay compatible. `algorithmHash` changes, as with any source change, so an old checkpoint cannot `--resume` under this code. A warm start from the same mechanics id still works.
- **`controller-options.test.cjs`.** Explicit default options, including `controllerTeams: [{}, {replyModel:'worst'}]` and an irrelevant temperature, equal the default controller byte for byte.

## 3. The options are correct

- **Exact on both forecast paths.** Every option (11 settings, battle-wide and per side) is deterministic and reproduces exactly on the unoptimised forecast path, traced, so the forecast-reuse caches stay correct (`controller-options.test.cjs`). An earlier scratch check found 0 differences on 6 fixtures for each of 8 settings.
- **Side invariance.** Swapping caller order together with `controllerTeams` mirrors score, remaining Pokémon, turns and planner statistics.
- **Hidden-information counterfactuals.** The hidden bench, an unrevealed charged move and true energy 97 leave the action, the shield decision and the observation record unchanged under 8 option settings. This holds battle-wide and for the deciding side only, on both physical sides (`observations.test.cjs`).
- **The options act where they should.** With no voluntary switches the planner records 0 switches. Eager switching switches more. A never-shield side never shields. An always-shield side uses at least as many shields. The continuation's extra work stays within its bounds: at most 4 continuation duels per continued branch and at most N steps per duel.
- **Unit tests** for the weighted expectation (the exact softmax formula, its two limits, empty and tied inputs) and for settings, identity, suffix and validation (`lookahead.test.cjs`).
- **Search integration** (`search-controller.test.cjs`, with deterministic fake battles):
  - every training, screening and final job carries the controller;
  - panel jobs carry `[run controller, style]`;
  - the panel's battles are counted, and selection and final scores are unchanged;
  - the results reach every output, and the portable report validates;
  - resume and warm start between default and variant runs are refused, and so is an export with a stripped identity.
- **Browser.** The regenerated adapter reproduces traced battles of a weighted plus continuation controller event for event and refuses mismatched identities (`replay-v4.test.cjs`).
- **Full suite.** `node --test training/*.test.cjs training/next/*.test.cjs training/team-search/*.test.cjs` gives 243 tests, all passing (226 before), in 226 s at load 35. `tests/docs.test.cjs` and the `pro.*.test.cjs` viewer tests pass (76).
- **Smoke search** (2 rounds, 4 workers, `--reply-model weighted --rollout-continuation 8 --policy-panel 8`): see section 4.4.

## 4. Measurements (exploratory, shared machine)

### 4.1 Weighted replies against the default (64 fixtures)

`controller-ab.cjs --a replyModel=weighted --b default --fixtures 64`. Search-shaped fixtures: random pool teams against hybrid observed-meta teams, with the run's 2,048-lineup belief bank. There were 128 battles; the load average was 35.

| | Value |
| --- | --- |
| Weighted controller's share | **50.0%** (normal 95% interval 46.9–53.1%) |
| Battles whose score or length changed against default-vs-default | 15 of 128 |
| Decisions, branches | 3,269 and 27,229 against 3,234 and 26,852 for the reference |
| Wall time against the default reference | 0.99× |

At T = 0.25 the softmax puts almost all weight on the worst reply whenever replies differ by more than a few tenths of a Pokémon's HP, which is usual. In a 24-fixture sweep, T = 1 changed 7 battles and T = 5 changed 9. The option is a different but nearly equivalent controller at its default temperature; a temperature fitted to human choices is the open part. CPU per decision was 0.96–1.10× the default across two single-process runs (noise).

### 4.2 Rollout continuation 8 against the default (64 fixtures)

Same fixtures; 128 battles; the load average rose from 35 to 41.

| | Value |
| --- | --- |
| Continuation controller's share | **53.5%** (interval 46.5–60.6%, unresolved) |
| Battles changed | 94 of 128 |
| Continued branches | 7,266 of 25,626 branches (28%) |
| Continuation duels | 12,378 (1.7 per continued branch) |
| Continuation steps | 88,167, against 202,044 first-duel steps of the continuing side (+44% logical steps) |
| Wall time against the reference (one side continuing) | 1.13× |

With both sides continuing, the logical extra steps were +43% (152,224 against 357,044). Two single-process CPU measurements, alternating arms over 24 and 32 search-shaped fixtures, put continuation 8 at **1.16× CPU per battle** and 1.29–1.32× per decision. Continuation 4 cost 1.22–1.35× per battle; the number of continuation duels, not their length, dominates the cost. A 64-fixture both-sides run measured 0.98× wall time against the reference, but its load average rose from 40 to 48 during the run, so that wall-time figure is not usable. The changed battles show that the option changes play a lot. The share says nothing about whether it plays better.

### 4.3 Policy panel on the 2026-10-12 v4 observed finalists (32 fixtures per style)

`policy-panel.cjs <run> --fixtures 32` used the run's meta settings (hybrid, 75.1% observed, half-life 30 days, as of 2026-10-12, prior strength 155), panel seed 20261013 and a fresh belief bank. It played 1,536 battles in 158 s (9.7 battles/s, load average 46). Exploratory: with 32 fixtures, the simultaneous bands are ±19–22 points.

| Finalist (lead first) | Default | Weighted | No switches | Eager | Always shield | Never shield | Lowest | Spread [simultaneous 95%] |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Talonflame (Shadow) / Mandibuzz / Bastiodon (primary) | 71.9 | 75.0 | 87.5 | 84.4 | 78.1 | 100.0 | 71.9 (default) | 28.1 [6.3, 50.0] |
| Magcargo / Charjabug / Mandibuzz | 75.0 | 75.0 | 87.5 | 78.1 | 79.7 | 100.0 | 75.0 (default) | 25.0 [3.1, 46.9] |
| Talonflame (Shadow) / Mandibuzz / Carbink | 75.0 | 75.0 | 84.4 | 81.3 | 78.1 | 100.0 | 75.0 (default) | 25.0 [6.3, 43.8] |
| Talonflame (Shadow) / Umbreon / Carbink | 90.6 | 90.6 | 84.4 | 87.5 | 90.6 | 96.9 | 84.4 (no switches) | 12.5 [−6.3, 31.3] |
| Talonflame (Shadow) / Mandibuzz / Bastiodon (other moveset) | 78.1 | 81.3 | 90.6 | 87.5 | 81.3 | 96.9 | 78.1 (default) | 18.8 [0.0, 37.5] |
| Talonflame (Shadow) / Mandibuzz / Carbink (other moveset) | 71.9 | 71.9 | 81.3 | 78.1 | 78.1 | 100.0 | 71.9 (default) | 28.1 [6.3, 50.0] |
| Talonflame (Shadow) / Umbreon / Carbink (other moveset) | 87.5 | 87.5 | 78.1 | 78.1 | 87.5 | 100.0 | 78.1 (no or eager switches) | 21.9 [3.1, 40.6] |
| Talonflame (Shadow) / Empoleon / Umbreon | 71.9 | 71.9 | 87.5 | 65.6 | 75.0 | 96.9 | 65.6 (eager) | 31.3 [12.5, 50.0] |

What it says:

- **The default controller is the strongest opponent style here.** The crude styles are easier to beat. Never-shield was resolved above the default for 5 of 8 finalists; no style was resolved below it for any finalist.
- **The headline spread mostly measures the never-shield extreme.** EVALUATION_PROTOCOL.md describes `policyPanel` as "the spread of the primary's score". The lowest style and any style below the default are the better robustness readings. Three finalists dipped below their default score against a non-default style, all unresolved at 32 fixtures:
  - the two Talonflame / Umbreon / Carbink variants against non-switching and eager opponents (−6 to −9 points);
  - Talonflame / Empoleon / Umbreon against eager switching (−6 points).
- **The primary's default-style score of 71.9% is lower than its 83.5% final score.** That final score came from 512 different fixtures. This 32-fixture sample has a standard error near 8 points and a different belief bank; it is not a re-estimate.

### 4.4 Smoke search

`search.cjs --pool training/runs/team-search/pool.json --out training/runs/smoke-controller --hours 0.12 --workers 4 --initial-teams 16 --batch-teams 8 --opponents 8 --screen-teams 4 --screen-opponents 16 --validation-teams 2 --validation-opponents 16 --baseline-count 3 --candidates 200 --rounds 2 --champions none --reply-model weighted --rollout-continuation 8 --policy-panel 8`

It completed training, screening, the final test and the 96-battle panel (8 fixtures, 2 finalists, 6 styles), with 432 battles in 55 s. Its outputs:

- `config.controller` and the mechanics id `1b33a32b…+controller:replyModel=weighted,replyTemperature=0.25,rolloutContinuation=8`;
- `policyPanel` in the checkpoint, `recommendations.json`, `report.html`, `findings.md` and the portable report, which passes `neural-report-core.js`;
- `engineOptions` that the viewer's identity check accepts.

16 stored training labels, sampled evenly, reproduced exactly in process with the run's options. The default controller gave a different score or length for 14 of them, so the options reached the workers.

## 5. Limits

- **Smoke scale, heavy load.** Intervals are from 32 to 64 fixtures. Wall-time ratios move with machine load; the single-process CPU ratios are the better cost figures.
- **Not human.** The temperature 0.25 is not fitted to anything. The panel's styles are deliberately crude extremes, not models of human play. "Lowest across styles" is a stress reading, not a human win rate.
- **Bounded continuation.** It is one replacement deep, and it chooses the replacement by the controller's own continued forecast, not the way a player chooses.
- **Weighted replies keep the same three imagined lineups.** They model uncertainty about the reply, not about the backline.
- **Different controllers in a run.** A search with either option is a different controller: its labels never mix with default runs. Scores across controllers are not comparable; the change has to be judged by realism (panel, fixtures), never by a higher score (EVALUATION_PROTOCOL.md).

## 6. `search.cjs` hunks (all small insertions)

1. After the `belief-samples` check, one new line: `controller` from `--reply-model`, `--reply-temperature` and `--rollout-continuation`; the policy panel's tools, size, guarded seed (`seed + 830001`) and battle count.
2. `config`: `mechanicsHash:mechanicsHash({version:'v4',controller})`, plus `...(controller?{controller}:{})` and `...(policyPanelFixtures?{policyPanel,policyPanelSeed}:{})`. Default configs are unchanged.
3. `updateBudget`: `extraBattles:policyPanelBattles` is passed to `trainingBudget` (`budget.cjs`, default 0).
4. The two job-option literals (`evaluate` and `evaluateAcquisition`) end with `...controller`; spreading `null` adds nothing for the default.
5. The screening share: `finalWork` adds `policyPanelBattles`.
6. After `state.championComparisons=…;save();`, one new line runs `policyPanelTools.searchPanel(…)` when the panel is on, not stopped, and before the deadline.
7. The `recommendations.json` object: `...(state.policyPanel?{policyPanel:…compact(…)}:{})`.
8. The command line: defaults `replyModel:'worst',replyTemperature:.25,rolloutContinuation:0,policyPanel:0` and the help text.

`launch.cjs` accepts the same four flags. `common.cjs` changes in two places: `mechanicsHash({version,controller})` appends the suffix, and `algorithmHash` adds `../next/policy-panel.cjs` and `../next/controller-options.cjs`.

## 7. Files

- **Controller** (`web/training/`): `next/lookahead-v4.js` (the `<controller-options>` section, weighted aggregation, `continueRollout` and `continuationDuel`, switch margin, shield policy), `engine-v4-core.cjs` (threads the options), `engine-v4.cjs` (per-side mapping, orientation, identical teams), `next/controller-options.cjs` (Node access) and `simulator-compatibility.json`.
- **Panel and A/B check** (`web/training/next/`): `policy-panel.cjs` and `controller-ab.cjs`.
- **Search and reports** (`web/training/team-search/`): `search.cjs`, `budget.cjs`, `common.cjs`, `export-report.cjs`, `report.cjs` and `launch.cjs`.
- **Viewer and browser replay** (`web/includes/pro/`): `neural-report-core.js`, `neural-portable.js`, `team-replay-v4-worker.js` and the regenerated `team-replay-v4-runtime.js`, `team-replay-v4-manifest.js` and `team-lookahead-v4.js`; plus `web/scripts/build-neural-replay-v4.cjs`.
- **Tests**:
  - new: `training/controller-options.test.cjs`, `training/next/policy-panel.test.cjs` and `training/team-search/search-controller.test.cjs`;
  - extended: `training/next/observations.test.cjs`, `training/next/lookahead.test.cjs`, `training/team-search/replay-v4.test.cjs` and `pro.neural-performance.test.cjs`.
- **Docs**: `next/OBSERVATION_CONTROLLER.md` ("Controller options"), README sections 5 and 12, `README-plain.md` (one sentence) and `includes/pro/NEURAL_REPORTS.md`.

## 8. Full-scale commands for later

From `web/`, on an otherwise idle machine. The A/B checks and the panel take minutes; the searches take a night each.

```
# Head to head, 512 fixtures (resolves about 4 points)
node training/next/controller-ab.cjs --a replyModel=weighted --b default --fixtures 512 --workers 12 --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" --usage-half-life-days 30 --usage-as-of 2026-10-12 --usage-prior-strength 155 --out training/runs/controller-ab-weighted-512.json
node training/next/controller-ab.cjs --a replyModel=weighted,replyTemperature=1 --b default --fixtures 512 --workers 12 --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" --usage-half-life-days 30 --usage-as-of 2026-10-12 --usage-prior-strength 155 --out training/runs/controller-ab-weighted-t1-512.json
node training/next/controller-ab.cjs --a rolloutContinuation=8 --b default --fixtures 512 --workers 12 --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" --usage-half-life-days 30 --usage-as-of 2026-10-12 --usage-prior-strength 155 --out training/runs/controller-ab-continuation8-512.json

# Policy panel on the completed observed run's finalists at 256 fixtures per style (8 x 256 x 6 = 12,288 battles)
node training/next/policy-panel.cjs training/runs/team-search-v4-observed-2026-10-12 --fixtures 256 --workers 12 --meta hybrid --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" --usage-half-life-days 30 --usage-as-of 2026-10-12 --usage-prior-strength 155 --out training/runs/policy-panel-v4-observed-256.json

# Overnight runs: the default controller with the panel, and the two alternatives (each its own controller and output directory)
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v4-panel-YYYY-MM-DD --policy-panel 256 --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v4-weighted-YYYY-MM-DD --reply-model weighted --policy-panel 256 --usage-file … (same meta flags)
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v4-continuation8-YYYY-MM-DD --rollout-continuation 8 --policy-panel 256 --usage-file … (same meta flags)
```

Compare the overnight runs by their panels and by a `rematch.cjs` of all three primaries under the default controller, never by their own final scores. A panel at 256 fixtures per style costs about 12,000 battles for eight finalists, minutes on 12 idle workers; the training budget reserves it.

## Full-scale results (2026-10-14)

Both-rosters A/B at 512 fixtures (`controller-ab-weighted-512.json`, `controller-ab-continuation8-512.json`; load average 18 from another session, timings only): weighted replies 50.1% (49.4–50.8), 59/1,024 battles changed, time ratio 1.01; continuation 8: 52.5% (50.4–54.6), 726/1,024 changed, time ratio 1.12. Policy panel at 256 (`policy-panel-256.json`): min style = default for finalists 1 and 5, weighted for 3, 4, 6 and 7, always-shield for 2, eager-switches for 8; never-shield +11.9 to +21.5 (all resolved), no-voluntary-switches +1.2 to +12.1 (resolved for 1, 3 and 5). The primary scored 73.8% under the default style on this panel against 84.4% for finalist 2.
