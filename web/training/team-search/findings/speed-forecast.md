# Speed: forecast preparation (2026-10-13)

Section 12 speed row "Forecast preparation dominates". Goal: faster v4 battles with byte-identical outcomes.

**Result.** Five reuse changes behind the existing `simulationOptimizations` switch (on by default; `simulationOptimizations:false` still runs the unchanged baseline path). On 192 search-shaped fixtures with 4 workers on a shared machine, the new optimised path ran **1.97×** as many battles per second as the previous optimised path (9.19 → 18.07 battles/s, median of 3 alternating runs). On the older benchmark fixture set it was 1.90× (14.93 → 28.34). Outcomes are identical: 0 differences in score, turns, remaining Pokémon, charged count, planner statistics, public observations, HP samples and timeline events across every comparison below. The mechanics id is unchanged (1b33a32b…). The 12-worker full-scale measurement has not been run yet (commands at the end).

These are smoke-scale measurements on an M2 Max (12 cores) that other agents were using at the same time (1-minute load average 12–30 during the runs). They show that the change works and that the speed-up is large. They are not a final throughput figure.

## 1. Profile: where the time went

Workload: 48 seeded fixtures in one process, built exactly as `search.cjs` builds its jobs. Own teams are random pool variants, every fourth one led by a special species. Opponents are hybrid-meta draws with the observed usage file (half-life 30 days, as-of 2026-10-12, prior strength 155). The belief roster and the 2,048-lineup bank match the 2026-10-12 run's `checkpoint.json` `beliefPrior` exactly. Default options: lookahead, horizon 24, interval 4, 3 belief worlds. Profiled with `nice -n 10 node --cpu-prof`. Shares are inclusive unless marked otherwise.

| Cost | Before (previous optimised path) | After |
| --- | ---: | ---: |
| Forecast branches (rollouts) | 62.2% | 57.1% |
| Forecast Pokémon construction (`createTeamLookaheadPokemon`: constructor, move copies, initialise, resets) | 28.8% | 14.4% |
| Garbage collection (self) | 12.8% | 12.3% |
| PvPoke's own AI inside forecast duels (`ActionLogic.decideAction`) | 11.1% | 13.4% |
| `terminal()` value | 6.8% | 5.4% |
| Guessed-opponent clones (`foe()`) | 4.7% | 2.4% |
| Seeded RNG hashing (`seeded`, self) | 4.0% | 0.7% |
| Game Master `structuredClone` per encounter (line in `play`) | ≈4.3% | ≈2.5% (`JSON.parse`) |
| Belief worlds (`worlds()`, `hypotheses`, `guessed`) | 3.3% | 5.8% |
| Running the vendor scripts per encounter (`runInContext`) | 1.7% | 3.4% |
| Profile total for 48 battles | 8.9 s | 5.3 s |

The "after" column is a share of a smaller total, so costs that did not change show a larger share. The two totals were taken under different machine load and are not a speed measurement.

Counts over the same 48 battles, from an instrumented copy (not committed):

| | Before | After |
| --- | ---: | ---: |
| Forecast branches (branch-cache misses; hits 4,529) | 10,453 | 10,453 (unchanged) |
| Duel simulations | 10,453 | 6,991 (−33%) |
| Forecast Pokémon built (6 per branch, plus one per `foe()` call) | 69,707 | 18,528 (−73%) |
| `pressure()` evaluations in `terminal()` | 243,736 | 61,156 computed, 182,580 memo hits |
| `foe()` clones built | 6,989 | 726 |

What the task suggested measuring, and what the profile showed:

- **A new `Battle` per rollout branch.** The constructor costs 0.7%. A `Battle` keeps about 40 mutable closure variables (turns, phase, queued actions, timeline, mode and more), so a pooled one cannot be reset exactly without a full audit of `Battle.js`. Not attempted.
- **`createTeamLookaheadPokemon` clones.** The largest item, addressed by changes 1–3 below.
- **`JSON.stringify` state keys.** About 3% (rollout self time). They stay; row keys are memoised per row object.
- **`worlds()` per decision.** 3.3%, computed once per decision. The rows depend on the turn (cooldown estimates) and on live HP and energy, so worlds cannot be reused across steps.
- **`foe()` clones.** 4.7%, addressed by change 3.
- **`isolateTeamScenarioScouting`.** The v4 path never calls it; only `engine-v2-core.cjs` does. 0% of the v4 profile.
- **Pokémon construction and move initialisation** (constructor 12.7%, `resetMoves` 12.0%, `getSimulationMoveById` 6.0%, `initialize` 5.5%, overlapping). Reduced by building fewer clones.
- **`structuredClone` of the Game Master per encounter.** About 4.3%, addressed by change 5.
- **Global name lookups in the contextified VM.** Found by the profile, not on the list. `seeded()`'s inner loop does a single `Math.imul` lookup per character, and it cost 63 ns per character inside the VM against about 13 ns outside it. In a microbenchmark, a global lookup in a contextified context took about 350 ns, 16–85× slower than in an ordinary context. Addressed by change 4.

## 2. What changed

All five changes are in `next/lookahead-v4.js` and `engine-v4-core.cjs`. Each runs only when `simulationOptimizations` is true. The baseline path is the code as it was before, apart from extracting `prepareTeamLookaheadOutgoing` from `prepareTeamLookaheadSwitch`, which does the same operations in the same order. The information boundary is untouched: every reused object is built from the same captured public rows as before, and the hidden-state tests in `observations.test.cjs` pass.

1. **One duel forecast per step for the same duel (`forecastBranch`).** A forecast `Battle` only ever holds the two duel members; bench Pokémon never enter it. Its outcome is therefore a function of the two duel rows, whether each member is switching in, and the two shield counts. Any other world state reaches the value only through `terminal()` and the lock times. Belief worlds usually imagine the same active opponent, so the "opponent stays in" duel was simulated three times per decision. It is now simulated once per step and cached under the duel's rows (their complete JSON, the same identity the branch cache already uses for whole states), its entry flags and the shields. `terminal()` still values each world's own bench. Planner statistics are unchanged because the branch count still counts branch-cache misses.
2. **Shared bench and outgoing clones, with a pressure memo.** In a branch, the four Pokémon outside the duel are only read by `terminal()`. The outgoing member is first transformed exactly as `prepareTeamLookaheadSwitch` would (buffs cleared, form reset). Each such clone is built once from its row and role, in a configured forecast `Battle` that never receives Pokémon, which is the state every forecast `Battle` is in while its clones are built. It is kept in a 64-entry least-recently-used map across steps (bench rows rarely change while benched). Clones that can never change again (these, and duel members after their duel) memoise `pressure(a,b)` in weak maps. `DamageCalculator`'s own cache is keyed by battle but validated by every numeric input, so it returns the same values for clones built in another forecast `Battle`.
3. **Guessed-opponent clones kept across steps (`foe`).** `decideAction`, `decideShield` and `DamageCalculator.damage` read the guess's typing, stats, stages, form, tags, level, CP multiplier, IVs and moves, plus its HP and energy. HP, energy and cooldown enter a clone only as start values that `reset()` copies. No other field prepared from the row depends on them; the move damage that `initializeMove` computes against the live opponent is never read by these consumers. One clone per remaining row content (16-entry LRU) is therefore reused, with those three values and their start values set exactly as `reset()` sets them. 6,989 calls built 726 clones.
4. **An ordinary VM global.** The optimised path creates the context with `vm.constants.DONT_CONTEXTIFY` and installs the same globals (`console`, the seeded `Math`, `$`, timers, settings) with `Object.assign`. The scripts, the main-realm `Math` object and every value are the same. Only the global-object mechanics differ, and no simulator code inspects them. Node 20.18+ is needed for the speed-up; older Node falls back to a contextified empty sandbox with the same globals. The browser replay runs in a worker global and is unaffected.
5. **The Game Master is re-parsed instead of cloned.** Every encounter still gets its own fresh Game Master. `data` is `JSON.parse` of the file text and is never mutated in the host realm, so parsing the text again builds exactly the structure `structuredClone(data)` builds, in about half the time (4.9 vs 11.4 ms in a microbenchmark under load). `scripts/build-neural-replay-v4.cjs` maps the expression back to `structuredClone(data)` for the browser, which clones the data it fetched.

### Measured and not kept

- **Exact recycling of duel Pokémon** (scratch implementation, not committed). The idea was to restore last step's duel members, instead of building new ones, from a layout learned by building each row twice and comparing the builds. Shared values stay shared, self references stay self references, and owned plain objects and arrays are copied fresh with their original realm prototypes. A static scan of `Pokemon.js` (acorn, closure references from methods to constructor scope) showed that the only per-instance closure state is the bound battle (rebound by `setBattle`), the species data, the construction battle (read only for its level cap) and a loop scratch variable. The approach was exact (0 mismatches on 24 traced fixtures), but it was **slower: 0.92× CPU time** against the same code without it. A restore copies about as much state as a build, and learning a layout costs two builds and property-descriptor checks (`plainData` alone took 6.6%). Dropped.
- **Skipping redundant `reset()` calls** (a duel member is reset three times). Not exact. `resetMoves` is not idempotent: PvPoke's Focus Blast / Zap Cannon clause rewrites a move's buffs depending on DPE, which depends on whether an opponent is set.
- **One Game Master per worker instead of per encounter.** This would need proof that no code path mutates game data. The baseline `getMoveById` shares buff arrays with the data, so that proof is not obvious. Change 5 is the safe half of this.
- **Fewer worlds, shorter horizons, larger intervals.** These change decisions, so they are not transparent (as recorded before).

## 3. Identity evidence

- **`training/forecast-reuse.test.cjs` (new).** 96 search-shaped fixtures from in-git data only (`searchFixtures` in `simulator-fixtures.cjs`): rankings population, hybrid synthetic meta, a 2,048-lineup bank and default options. The panel includes Cramorant, Aegislash, Morpeko, Galarian Darmanitan, Shadow Darmanitan and Mimikyu, more than 48 Shadow members, and voluntary and forced switches. Each fixture runs traced with `audit` on both paths and asserts `deepEqual` on the complete result: score, turns, remaining, charged count, planner statistics with the public observation views, every HP sample, team stats and every timeline event. The headless optimised result must equal the traced labels. A second test runs 12 fixtures under other settings on both paths: 1 and 5 belief worlds, horizons 8 and 32, intervals 2 and 6, an empty belief bank, and an asymmetric policy.
- **Existing tests.** `simulator-speed.test.cjs` (frozen pre-optimisation reference, every event), `replay-v4.test.cjs` (browser runtime regenerated from the new source), `forecast-performance`, `observations`, `lookahead`, `engine-v4`, `simulation-metadata` and `simulator-compatibility` all pass. The full suite (`node --test training/*.test.cjs training/next/*.test.cjs training/team-search/*.test.cjs`) passes: **111 tests**.
- **Pool-based checks (scratch scripts, pool outside git).** 192 fixtures built from the pool and the observed usage file were compared traced and headless (96 each) on both paths: 0 differences. **192 stored observations of the completed 2026-10-12 v4 run**, sampled evenly from its 317,655 and simulated by the previous engine, gave identical scores under the new optimised path. 64 observations from a new smoke search run gave identical scores under the baseline path.
- **Benchmarks.** Every timed run of both benchmarks below checks that all labels (score, turns, charged, remaining, planner) are equal across runs and paths.
- **Smoke search.** `search.cjs` at smoke scale (2 rounds, 4 workers) completed training, screening, final testing, baselines and report export.

## 4. Throughput (4 workers, `nice -n 10`, shared machine)

Previous optimised path (a frozen copy of the engine at c4f1538) against the new one, alternating order, one warm-up, median of 3:

| Fixtures | Battles per run | Previous | New | Speed-up | Paired ratios |
| --- | ---: | ---: | ---: | ---: | --- |
| Search-shaped: pool variants, observed meta, 2,048-lineup bank | 192 | 9.19 battles/s | 18.07 battles/s | **1.97×** | 1.93, 2.01, 1.97 |
| Same, smaller panel | 96 | 11.07 | 25.57 | 2.31× | noisier (load rose from 17 to 29) |
| `simulatorFixtures` (the earlier benchmark set, no belief bank) | 192 | 14.93 | 28.34 | 1.90× | 1.50, 1.91, 1.90 |

`training/benchmark-simulator-speed.cjs` (baseline path against the optimised path in the same code), 4 workers:

| Fixtures | Baseline | Optimised | Ratio | Peak worker heap |
| --- | ---: | ---: | ---: | ---: |
| `--fixtures legacy`, 192 battles | 11.40 battles/s | 31.05 battles/s | 2.72× | 65 MB |
| `--fixtures search --pool … --usage-file …`, 96 battles | 8.27 | 22.29 | 2.70× | 79 MB |

The previous optimised path measured 1.33× over the same baseline on 12 workers (2026-10-10). Peak worker heap stays well below the 192 MB limit, and workers recycled normally with no timeouts. Single-process CPU time on 48 search fixtures fell 1.74–1.86× (alternating runs, including GC helper threads).

## 5. Compatibility

- **Mechanics.** The new v4 source hash `f8daf8b1…` is registered in `simulator-compatibility.json` under the existing mechanics id `1b33a32b…`; the old source entry is kept. Reports, replays and warm starts from v4 runs remain compatible. The v1 and v2 hashes are untouched: no vendor file and no `engine.cjs` was edited.
- **Resume.** `algorithmHash` includes the raw source hash, so a checkpoint started under the old code cannot resume under this code. Use a new `--out` directory; earlier v4 evidence can warm-start it.
- **Browser.** `includes/pro/team-replay-v4-runtime.js` and `team-lookahead-v4.js` were regenerated. The manifest is unchanged.
- **`search.cjs`** was not changed (no hunks).

## 6. Limits

- Smoke scale, 4 workers, a shared and heavily loaded machine. The 12-worker figure is pending.
- The gain depends on the workload. It is larger when belief worlds agree (a real belief bank, a revealed opponent) and when benches stay unchanged. The pool-based search fixtures are the representative case.
- The remaining time is mostly inherent to this design: PvPoke's AI and state machine inside forecast duels, building two fresh duel members per simulated duel (about 11% of the profile; exact recycling did not pay), belief-world templates built per encounter, garbage collection, and per-encounter VM setup (about 6–9%). The next step with a large gain is still an array-based combat state for forecasts, a rewrite that needs full timing and form parity.

## 7. Full-scale benchmarks to run (coordinator)

From `web/`, on an otherwise idle machine:

```
node training/benchmark-simulator-speed.cjs 192 3 12 training/simulator-speed-results.json
node training/benchmark-simulator-speed.cjs 192 3 12 training/simulator-speed-search.json --fixtures search --pool training/runs/team-search/pool.json --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" --usage-half-life-days 30 --usage-as-of 2026-10-12 --usage-prior-strength 155
```

The first command is the one behind the earlier 12-worker figures (12.24 baseline, 16.25 optimised, 2026-10-10). The baseline path is unchanged code, so its new figure shows whether the machine is in the same state, and the new optimised figure against 16.25 gives the 12-worker gain. The second command measures the representative search workload. Afterwards, update README section 10, PERFORMANCE.md and README-plain.md ("about 16 full battles per second"), which still quote the earlier figure.

## Files

- `web/training/next/lookahead-v4.js`: `forecastBranch`, `sharedClone`, the pressure memo, `foe` reuse, and `prepareTeamLookaheadOutgoing` (extracted, same behaviour).
- `web/training/engine-v4-core.cjs`: the `DONT_CONTEXTIFY` context and the Game Master re-parse (optimised path only).
- `web/training/simulator-compatibility.json`: new v4 source hash under the existing id.
- `web/scripts/build-neural-replay-v4.cjs`: maps the re-parse to `structuredClone` for the browser. The regenerated files are `web/includes/pro/team-replay-v4-runtime.js` and `team-lookahead-v4.js`.
- `web/training/simulator-fixtures.cjs`: `searchFixtures()`, search-shaped fixtures (in-git by default, or from a pool and usage file).
- `web/training/benchmark-simulator-speed.cjs`: `--fixtures search`, `--pool` and `--usage-*` flags; records the load average.
- `web/training/forecast-reuse.test.cjs`: the identity tests.

## Full-scale results (2026-10-14)

Idle machine, 12 workers, median of 3: optimised 50.2 battles/s vs baseline 18.2 (2.76×); search-shaped 50.0 vs 19.3 (2.60×). Files: `training/simulator-speed-results.json`, `training/simulator-speed-search.json`.
