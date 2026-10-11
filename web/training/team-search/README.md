# Current controller: observation-limited v4

Neural fitting and inference now reuse minibatch calculations and scratch buffers. See [performance measurements and compatibility](PERFORMANCE.md).

Run a fresh eight-hour experiment from `Desktop/Projects/PvPokeTeamTrainer`:

```sh
node training/team-search/launch-next.cjs --hours 8
```

The launcher uses all available CPU cores and writes `training/runs/team-search-v4`. It automatically supplies the completed v3 refined finalists as **composition hints** if that checkpoint exists; none of its battle labels, scores or neural weights are transferred. Half or more of the initial batch remains random. The expensive unchanged top-300/five-moveset scouting pool is reused. Do not pass the v3 `--warm-start` argument from the previous instructions. A v4 run can subsequently resume under identical code/settings, or supply compatible v4 evidence to a new v4 run.

```sh
node training/team-search/status.cjs training/runs/team-search-v4
node training/team-search/stop.cjs training/runs/team-search-v4
```

Import that directory's `report.pvpteams.json.gz` in Full Team Neural Network. The updated site supports v4 reports and matching battle replay. Original v1/v3 results and adapters remain separate.

See [the v4 information-boundary guide](../next/OBSERVATION_CONTROLLER.md) for precisely what the controller knows, how it predicts hidden information, and its limitations. This patch changes the **battle controller**, not the neural architecture. It is a realism correction, not a proven increase in playing strength. Full-information scores are not directly comparable with v4 scores.

The search acquisition improvements below remain active in v4. Their measured benchmark was performed under v3 and must not be reported as a v4 accuracy measurement. All instructions below this section that reference v1–v3 are historical context.

# October 10 search refinement

The latest acquisition algorithm is `interaction-neural-v6-promising-exploration`. The simulator, candidate pool, feature representation and neural architecture are unchanged. The report's plateau does not establish that the best team was found. This update targets poor exploration and uneven contender evidence rather than claiming a larger network will help.

- Exploration now orders candidates by **predicted mean + ensemble standard deviation**, instead of disagreement alone. This favors uncertain teams that might actually compete. The standard deviation is a search heuristic, not a calibrated confidence bound. The 25% uniform random allocation remains.
- Each proposal pool includes every unseen single-Pokémon moveset substitution and both alternative leads around its eight highest-ranked incumbents. This checks the retained five movesets systematically; it does not add moves excluded by scouting. These neighbors still compete on neural score for simulation slots.
- Retesting alternates the incumbent (every third round) with seven rotating contenders. This spreads common-round opponent evidence across stronger teams and moveset rivals. It does not eliminate noise or convert unequal historical scores into paired comparisons.
- Portable reports record the acquisition algorithm and retest schedule. Sealed screening/final tests and the 20% minimum evaluation reserve remain.

`--exploration disagreement` retains the old acquisition priority for controlled experiments. It still uses the new local neighborhoods/retest schedule; use the archived code to reproduce the full old optimizer. Resume requires identical algorithm fingerprints. **Do not resume an old checkpoint under changed code.** Compatible v3 raw labels can warm-start a new directory because battle mechanics have not changed.

## Reuse the completed run without contaminating the new final test

From `Desktop/Projects/PvPokeTeamTrainer`:

```sh
node training/team-search/absorb-evaluation.cjs training/runs/team-search-v3-refined-20261010/checkpoint.json training/runs/team-search-v3-refined-20261010/pool.json training/runs/v3-next-evidence.json
node training/team-search/launch-next.cjs --hours 8 --warm-start training/runs/v3-next-evidence.json
```

The first command preserves the old report, converts its already-seen evaluations into training evidence, discards old fitted models, and marks those evaluation seeds as used. The launcher chooses a fresh test seed and uses all available CPU cores. New results stay in `training/runs/team-search-v3-next`. To run without inherited labels, omit `--warm-start`. If that directory already has a checkpoint, use a different `--out` for a new experiment.

Check or safely stop the detached run:

```sh
node training/team-search/status.cjs training/runs/team-search-v3-next
node training/team-search/stop.cjs training/runs/team-search-v3-next
```

## Evidence and remaining priorities

See [REFINEMENT_FINDINGS.md](REFINEMENT_FINDINGS.md) for the retrospective acquisition diagnostic and fresh matched benchmark. Those tests assess proposal selection, not a completed new overnight search. The largest remaining risks are synthetic team frequencies, the full-information fixed controller, excluded movesets/IVs, and uncertain finalist differences. More rounds cannot correct a wrong meta assumption. Priorities after this patch: observed team frequencies, stress tests across plausible metas/controller styles, information-limited strategy, and independent equal-compute optimizer comparisons.

The technical notes below include earlier versions and are retained as historical context.

# Current version: v3

Run `node training/team-search/launch-next.cjs --hours 8`. New runs go to `training/runs/team-search-v3-next`; import `report.pvpteams.json.gz` in Full Team Neural Network. See [v3 changes and portable report guide](../../includes/pro/NEURAL_REPORTS.md). Earlier instructions below describe previous experiments. Do not warm-start v3 from old labels.

# v2 next-run update

Use `node training/team-search/launch-next.cjs --hours 8` for the new side/bench-invariant lookahead experiment. See [next-run instructions](../next/README.md) and [result audit](../next/NEXT_RUN_AUDIT.md). The technical notes below describe the original v1 experiment; v2 changes and remaining limitations are documented in those files.

# Neural search for Great League teams

This system learns a neural matchup model from **complete three-on-three battles**, then uses it to search for strong teams and movesets. It is separate from the earlier five-parameter strategy tuner. It optimizes team composition under Champion's existing battle strategy and an explicit opponent distribution; it cannot certify the globally optimal team or a human win rate.

## Run on the M2 Max

The installed trainer is at `Desktop/Projects/PvPokeTeamTrainer`. From that folder, with Node 20 or later:

```sh
node --test training/team-search/*.test.cjs
node training/team-search/prepare.cjs --shortlist 10000 --scout-opponents 300 --workers 12
node training/team-search/launch.cjs --hours 6 --workers 12
```

The launcher starts a detached, caffeinated process on macOS, writes `launch.json` and `training.log`, and returns immediately. A cached `pool.json` avoids repeating preparation. Direct foreground execution is also available:

```sh
caffeinate -i node training/team-search/search.cjs --hours 6 --workers 12
```

Check progress:

```sh
node training/team-search/status.cjs
```

Resume a launcher-created experiment:

```sh
node training/team-search/launch.cjs --hours 6 --workers 12 --resume
```

Use the original algorithm code and settings when resuming. Checkpoints fingerprint both the learning/search code and the battle engine. Pool inputs must also match the bundled Game Master, rankings and weights; scouting caches fingerprint their scoring code. Use `--warm-start` with a new output directory after algorithm changes; raw evidence remains reusable if the simulator mechanics match. The launcher restores its stored validation seed; worker count and hours can change, while ensemble size stays fixed. Resume creates a new time budget. To stop a foreground run, press Ctrl+C and wait for Saved. For a detached run, use `node training/team-search/stop.cjs` (or pass its output directory). This verifies the launcher’s unique process identity and signals the Node process directly. `process.json` records its PID, start/end times, and exit code. The search catches SIGINT/SIGTERM, stops dispatch, drains active work, and saves. It preserves every fully evaluated team within an incomplete round.

An absolute deadline can replace a relative budget:

```sh
node training/team-search/launch.cjs --until 2026-10-09T21:25:00Z --workers 12
```

Use a future timestamp. Preparation and any warm-start model fit must happen before enough time remains to search. The foreground relative search budget begins after pool preparation; a deadline remains absolute. In-progress battles/model fits can finish shortly after the deadline. Default output is `training/runs/team-search`; the original strategy run in `training/runs/overnight` remains intact.

## Eligible population and movesets

1. Start with published **standard Great League (1,500 CP)** entries and the bundled PvPoke default matchup weights. Sort by descending weight, breaking ties by published overall rank. Keep the top 300 positive-weight entries. Missing weights use 1, matching the app. This is a frozen data/engine snapshot, not live measured usage.
2. Shadow and regional forms are separate candidate entries. A team cannot contain two entries with the same Pokédex number. The current top-300 pool has 215 distinct Pokédex numbers, contains no unreleased or Mega entries, and has total weight 964.
3. Enumerate legal fast/charged combinations from the actual engine pools, including allowed special moves. The full preparation mode (`--shortlist 10000 --scout-opponents 300`) evaluates **every legal combination** against all 300 recommended-moveset opponents, excluding the identical species entry, over the five published shield/energy scenarios.
4. Rank a species' combinations by weighted mean **raw battle rating** across those opponents and scenarios, then retain up to five. This is a clear 1v1 selection metric, not PvPoke's normalized Overall score or proof of the best moveset in every team context. Default IVs and battle assumptions are fixed.
5. Full preparation produced **12,335 legal combinations, 18,440,825 1v1 simulations and 1,498 retained variants**. 299 species have five variants; one has three. Recommended movesets remain in the top five for 290 species. The ranking does not force a recommended combination into the final five.

Exhaustive scouting runs in small chunks, with a 120-second task watchdog and atomic on-disk cache files. It can restart using completed chunks. The returned best five per chunk are sufficient to recover the best five globally; the final result merges all chunks for each species. Worker isolates recycle regularly and have bounded heaps.

For a cheaper approximate preparation, use a smaller shortlist and scout panel:

```sh
node training/team-search/prepare.cjs --shortlist 64 --scout-opponents 24 --out training/runs/approx/pool.json
```

That mode first projects type-aware cycle damage, includes the recommended combination in scouting, then simulates only the shortlist. It may miss combinations. The final overnight run uses the exhaustive pool.

## Neural model

A team's feature vector `x(T)` includes all three ordered members and explicit team coverage summaries. Inputs represent:

- typing, real Great League stats, CP/level, published score and default weight;
- fast-move type, damage/turn, energy/turn and duration;
- charged-move coverage, costs, power and proc chances;
- expected self/opponent attack/defense changes, including moves that affect both;
- Shadow status;
- fixed scout matchup profiles and best/worst coverage by opponent type.

Lead and bench order are retained because the engine's strategy/tie-breaking can depend on roster order. A default network has 16 tanh hidden units. Twelve independently initialized, bootstrapped networks form the ensemble:

```text
h(T) = tanh(W x(T) + b)
s(T) = vᵀ h(T) + c
K = −Kᵀ
P(A, B) = sigmoid(s(A) − s(B) + h(A)ᵀ K h(B))
```

The scalar term learns general strength. The learned antisymmetric interaction matrix captures counter relationships such as A beating B, B beating C, and C beating A. Swapping the teams complements the prediction, and identical feature vectors predict 0.5. The model predicts expected matchup reward; ties count as half a win.

All parameters train by backpropagation and Adam on binary cross-entropy with fractional targets from mirrored fixtures. Gradients are checked numerically, including constrained interaction parameters. A cyclic-counter test verifies that the model learns a relationship a scalar strength model cannot represent. This is implemented directly in JavaScript, with no npm/Python/GPU dependency.

Independent ensemble fits run concurrently using shared, read-only feature/sample buffers; the M2 Max uses all 12 cores for model fitting, candidate inference and battle simulation. Changing the number of concurrent workers does not change the fixed ensemble size or its seeds. GPU/Neural Engine acceleration is not used; the expensive work is the branching battle simulator.

For a proposed team's estimated overall score, average each network's predictions against 256 independently sampled, weight-distributed reference opponent teams, then average the ensemble. Network disagreement guides exploration; it is **not a calibrated confidence interval**.

## Simulation and search

- Both sides use the unmodified Champion preferences. The system does not train switching/catching strategy or use the earlier tuned policy.
- Candidate teams use retained movesets. Opponents use published recommended movesets, sampled by weight without replacement by Pokédex number. This models individual usage weights, not observed or correlated human team compositions.
- Start with 128 random legal teams. Each round evaluates 24 teams against 64 **new** opponent fixtures, with sides exchanged: 128 battles per candidate.
- Propose 12,000 unseen ordered teams each round, mixing mutations of observed leaders and fresh random teams. Half the evaluation slots target neural predictions, a quarter explores disagreement, and the remaining slots include genuine uniform exploration and a leader retest.
- Log the average score of neural, uncertainty, random and retest groups on their shared opponent batch. This measures proposal quality; it is not an equal-total-compute proof that neural search beats every alternative.
- Retain raw per-opponent outcomes. A fixed hash reserves approximately 20% of candidate identities from fitting. Prediction diagnostics compare the neural model with a constant-score baseline on those identities. At most 48,000 distinct labeled training fixtures are uniformly sampled without replacement per fit (`--fit-fixtures`), keeping fitting bounded as evidence grows. Increasing the cap from 12,000 to 48,000 reduced mean held-out team error by about 30% across three ensemble seeds on 56,640 unique fixtures, at the cost of more training steps. Each ensemble member then bootstraps that subset once; avoiding a duplicate-heavy initial subset improved mean team error by another 12% in a separate 24,000-fixture, three-seed comparison.
- Training leaders use a cautious selection heuristic: shrink their fixture-score average toward 0.5 with eight pseudo-fixtures, then subtract 1.28 posterior-standard-deviation units. This heuristic reduces noise but is not a frequentist confidence bound or enough by itself to prevent multiple-comparison selection bias.

Six epochs per fit reduced held-out team-average error by about 9% versus ten in a three-seed comparison, although per-matchup error was slightly higher. Team selection uses expected overall performance, so six is the current default. Extra per-charged-move type features worsened this pilot and were not retained. Parallel inference preserved all 12,000 candidate predictions exactly and reduced a controlled benchmark from about 8.4 seconds to 1.5 seconds.

The initial average-score regression model failed to outperform a constant predictor in a small pilot. Training on individual opponent results and adding counter interactions improved preliminary held-out matchup error by roughly 11–13%. That is predictive evidence; final team performance must still be measured independently.

## Screening, final testing and baselines

Reserve at least the final 20% of wall-clock budget for evaluation. After 512 completed battles, continually estimate the requested screening/final/baseline work using measured end-to-end throughput and a 25% time margin. Slow runs stop proposing earlier if that work needs a larger reserve; this check also runs inside a large first batch:

1. Screen up to 24 training leaders on a separately seeded batch of 512 fresh opponent fixtures. These outcomes never fit the network. Select up to eight finalists from screening results, rather than noisy training scores.
2. Evaluate the screened finalists on another independently seeded set of 512 opponent fixtures. The primary team is selected **before** this final set. The detached launcher generates a fresh validation seed for a new experiment, and derives a distinct screening seed from it. Both seeds are checked against any earlier evaluations absorbed into training, preventing those fixtures from being reused for screening or final testing.
3. Evaluate twelve fixed baseline teams on the same final opponent fixtures: four uniform-random teams, four weight-sampled teams with each member's best scouted moveset, and four deterministic greedy coverage teams. Coverage baselines maximize weighted best-member scout ratings over the first 24 scouted opponents, with different weak-link penalties, bounded coordinate swaps and lead orders. They are fixed before final opponent testing.
4. Compare the primary team with each baseline group using a paired bootstrap over whole opponent fixtures, preserving correlated mirrored battles. Intervals are conditional on these particular baseline teams and the pinned simulator.

Each default screened/validated team gets 1,024 battles. Work checks the deadline and retains completed teams if time expires. Screening gets at most half the remaining evaluation budget, preserving room for final testing and baselines. A short deadline may leave incomplete evaluation; unvalidated teams are labeled accordingly. Selecting the best-looking *final* score among multiple finalists still introduces selection bias; the main comparison uses the screening-selected primary team.

## Files

Within the selected output directory:

- `pool.json`: population, selected variants, stats/IVs, scouting settings, source-input hash and pool hash.
- `checkpoint.json`: raw fixture labels, models, pending-round progress, latest fit diagnostics (including warm-start fitting), screening, final testing and baselines; atomically saved after completed teams and rounds. Fresh warm-starts advance past any already labeled partial round; ordinary resume preserves pending progress.
- `history.jsonl`: timestamped round summaries and neural-versus-random proposal scores.
- `opponent-analysis.json`: every completed primary final fixture, opponent movesets and battle seed; conditional scores for teams containing each opponent. These are team outcomes, not 1v1 ratings.
- `models.json`: serialized ensemble.
- `recommendations.json`: teams, movesets, simulation IVs/levels/CPs, training estimates, screening/final results and comparisons.
- `report.html` / `findings.md`: readable results. Open the HTML report locally; it needs no server or external assets.
- `training.log` / `launch.json` / `process.json`: detached execution log, verified process identity, start/end times and deadline metadata. Checkpoint runtime telemetry records throughput, average CPU cores busy, peak sampled process memory, worker heap and recycling.

Preparation's `.chunks` directory stores reusable scouting work. It is separate from the original strategy run.

## Reusing verified pilot evidence

`merge.cjs` combines raw fixture observations from checkpoints with the same pool and compatible simulator mechanics. It deduplicates identical team/opponent/seed records and rejects conflicting seeded results. `remap.cjs` translates retained legal movesets into another pool only when the original data and eligible weighted population match. Dropped movesets' teams are discarded. Models are discarded and retrained with the new features. New search checkpoints fingerprint the engine/vendor code and reject warm starts across changed mechanics. Legacy pilot checkpoints without that fingerprint are accepted with a warning and should only be used when their fixture evidence has been locally verified. These tools preserve simulation evidence while refining scouting/model architecture.

```sh
node training/team-search/merge.cjs MERGED.json CHECKPOINT_A.json CHECKPOINT_B.json
node training/team-search/remap.cjs MERGED.json OLD_POOL.json NEW_POOL.json REMAPPED.json
node training/team-search/search.cjs --pool NEW_POOL.json --warm-start REMAPPED.json --out NEW_DIRECTORY
```

A merged inherited battle counter represents unique retained labeled battles; it includes any explicitly absorbed earlier evaluations, and excludes discarded or unabsorbed pilot work. Subsequent execution adds actual completed battles.

Finished pilots' screening, final testing and baseline battles can also supply labels for a **new** experiment:

```sh
node training/team-search/absorb-evaluation.cjs FINISHED_CHECKPOINT.json POOL.json NEW_EVIDENCE.json
```

The source report remains unchanged. The tool reconstructs seeded fixtures, checks/deduplicates outcomes and clears old models/evaluation. It marks the old evaluation seeds as used; a warm-start search rejects reusing them for screening or final testing. Use the detached launcher to generate a fresh validation seed. This makes efficient use of pilot simulations without treating fitted data as a final test of the new experiment.

## Remaining limits

The simulator inherits full-information Champion heuristics and the existing virtual-timer adapter. Dedicated catch-timing, side-parity and comprehensive mechanics comparisons remain necessary before competitive claims. Uniformly random candidate teams and independently weight-sampled opponent teams do not represent every human meta lineup. Only up to five individually scored movesets are explored; an excluded moveset might still be useful for a particular team. Better neural predictions do not automatically imply better recommendations, which is why screening and untouched final comparisons are required.

## Published results dashboard

In PvPoke Pro, select **Full Team Neural Network** to view the completed run’s search-quality, held-out error, simulation-count and baseline charts, plus all eight independently tested finalists. The info button opens the algorithm documentation. `?app=pro&view=neural` links directly to this tab.

The dashboard is a snapshot, not a live trainer. To update its public data after another completed run, from the application repository:

```sh
python3 scripts/export-neural-dashboard.py /path/to/training/runs/team-search
```

The export checks final outcomes, common validation seeds and chronological history, and includes only compact metrics and team details. It excludes credentials, local machine paths, checkpoints, model tensors and raw fixture arrays. Publish the updated static app after exporting.

### All-team rankings and deterministic replay

The Team Rankings view shows every evaluated team with training, cautious selection, screening and fresh-test scores (missing evaluations display a dash), 500 per page. Twelve baseline comparison teams also have fresh test scores, marked separately from the eight finalists. Pokémon show the pinned Great League published rank and an Alternate Moveset badge; swapping charged move order is not an alternate.

Export the complete team report with:

```sh
node scripts/export-neural-teams.cjs /path/to/training/runs/team-search
```

The exporter verifies the pool and simulator fingerprint, and checks that each team’s stored fixture count matches its training battle count. Matchup chunks load only when a team is selected. The browser uses the same game data and Champion code in a dedicated worker. Two seed-matched battles reconstruct each paired fixture; the viewer checks their average against the saved score. Six HP curves describe the complete team battle. Timelines are reconstructed, not recorded during training. The parity test compares portable replay outcomes, turns and remaining Pokémon with the original Node simulator. The replay initializer follows the trainer’s default IV initialization; exported IVs describe that initialization, not a custom IV override.

Team searches reuse the ranking search parser and Great League engine metadata. AND terms can match different members (`melmetal&cramorant&@counter`); comma separates OR groups; negation excludes any team containing the matching term. Move queries inspect the selected team moveset, rather than learnable moves. Other predicates (types, tags, nicknames, generations, families, traits, costs, distances, meta, notes, XL and hundo) follow the Rankings search.

### Team Comparison

The report separates Lead and alphabetically displayed Backline, preserving stored simulation order. Min, Max and Average Ranking summarize the pinned Great League species ranks. `lead:` scopes any predicate to the first member; slash joins lead-only terms (`lead:melmetal/@thunder shock`).

Select two team checkboxes, or use Compare Teams below an opponent replay. Comparison matches exact opponent order and seed within the freshest common stage. It shows paired score deltas, improvement/regression counts, an approximate paired normal 95% interval and conditional opponent associations. Samples are not pooled across stages. Cramorant screenshot teams 2605 and 804 share 512 screening fixtures: 63.525% vs 64.600%, with 111 better and 119 worse outcomes for team 2605. Unequal training samples (64 vs 896 paired fixtures) cannot establish a moveset advantage. Bench order also differs.

A configurable 64/128/512-fixture exploratory replay comparison uses the freshest available saved panel from one team, capped to the chosen number of distinct fixtures. Both teams use the same opponents, seeds and two orientations, requiring four simulations per fixture. It does not constitute independent validation. An optional identical alphabetical bench order controls that confound when species and lead are the same. The browser worker can be cancelled; simulations do not alter saved report scores.

Comparison graphs reconstruct both teams, verify scores and show actual charged-attack counts. Changed moves that were never fired are identified. Cramorant Dive/Surf activate Gulp Missile; HP above 50% loads Arrokuda (Defense −1), otherwise Pikachu (Attack −2); an unshielded incoming charged attack releases a 15%-max-HP attack. Hydro Pump/Fly do not arm this mechanic. Raw DPE cannot explain team outcomes by itself. The battle list searches opponent teams with the same syntax, shows paired results and saved Selection ranks where exact teams exist, otherwise a published-Pokémon average-rank fallback.
