# Simulator and team-search performance

The dominant slowdown is repeated forecast preparation: every switching response
creates a duel and prepares six Pokémon, while damage checks build guessed opponents.
The earlier twelve-battle CPU profile attributed roughly 15% to type tables, 6% each
to move creation, Pokémon constructors, garbage collection and move resetting,
4% to move initialization, and 5% to damage. Those are sampled shares of a small
workload, not fixed percentages for an overnight run.

## Implemented simulator changes

- Share immutable, ordered type-effectiveness tables; changed forms select the
  matching table. Ordered typing preserves floating-point multiplication order.
- Cache normalized move metadata, copying mutable buffs, tags and form data into
  independent battle move objects. Caches are bounded or weakly referenced.
- Prepare selected attacks for ordinary forecast Pokémon. Species with special
  forms or extra attacks retain their complete pools for mechanical correctness.
- Cache public/default-IV stat templates separately from copied HP, energy,
  cooldown and stages. Never cache hidden live opposing information.
- Reuse damage-only opponent guesses within a turn and reuse serialized forecast
  states and identical branches. Damage caches include final stats, stages,
  Shadow modifiers, typing, charge rules, Mega bonuses and maximum-HP methods.
- Run training and forecast duels headlessly: skip animation/message objects and
  detailed timeline events. Keep compact charged events needed for switch-clock
  elapsed time and charged-attack counts. Traced replays reconstruct full events.

Headless mode uses the authoritative PvPoke `Battle.step` state machine rather
than maintaining a second set of combat rules. Forecasts still use Pokémon objects;
an entirely array-based replacement remains a larger rewrite, beyond this verified
optimization. Forecast worlds, horizons, action timing and policy decisions are
unchanged by the simulator switches. Set `simulationOptimizations:false` when
calling `play` to use the baseline path; damage caching also has an independent
`battle.cacheDamage=false` switch.

## More teams per battle budget

Candidates first play eight shared fixtures. A deterministic optimistic acquisition
score extends the promising or uncertain half to 64 fixtures. The default 24-team
batch requires `24 × 8 + 12 × 56 = 864` battles instead of 1,536, saving **43.75%**.
That permits approximately 1.78 times as many candidate starts at the same training
battle budget; it does not prove better recommendations. Acquisition can discard a
strong team after a noisy prefix. Use `--promotion-fraction 1` for full allocation.

Moveset challengers share opponents and seeds with a known parent on the common
prefix. Equivalent bench orders and repeated fixtures are skipped. Sparse partial
results survive graceful interruption/resume. Evidence is canonically ordered before
fitting/checkpointing and ties use team identity, preserving identical models and
proposals across worker completion order. Proposal-source diagnostics compare
only shared prefix results; overall training means remain adaptively sampled.
Independent screening, untouched final fixtures, fixed simple baselines and paired
final comparisons continue to measure recommendation quality separately.
Training/reference/belief/candidate/baseline RNG seeds avoid both evaluation seeds,
including unsigned wraparound. Inherited raw fixtures that overlap the chosen
screening/final opponents and battle seeds are rejected before fitting.

## Verification and measured throughput

Run:

```sh
node --test training/*.test.cjs training/next/*.test.cjs training/team-search/*.test.cjs
node training/benchmark-simulator-speed.cjs 192 3 12 training/simulator-speed-results.json
```

The benchmark alternates baseline/optimized order over four paired runs, excludes
warmup, checks exact outcome/planner equality, and reports medians for three measured
runs. Both modes use 24-turn forecasts, three belief worlds and the same representative
team/seed fixtures. It includes VM setup, worker startup and worker recycling every
eight battles (or earlier at the heap threshold). The 12-worker pool completes
1,536 battles across the paired runs. Detailed results are in
[simulator-speed-results.json](../simulator-speed-results.json).

| Mode | Median time for 192 battles | Battles/second |
| --- | ---: | ---: |
| Baseline path (`simulationOptimizations:false`) | 15.68 s | 12.24 |
| Optimized headless path | 11.81 s | 16.25 |

Measured full-battle throughput improved **1.33× (32.8%)**.
Node v20.18.1; 12 workers on this device. Peak sampled process RSS was
1445 MB and peak worker heap was
72.7 MB. Workers recycled normally without timeouts.
The benchmark was run without the test suite competing for CPU.

These are full-battle benchmark results on this machine, not an overnight speed or
neural accuracy claim. All fixture scores, turn counts, remaining Pokémon, charged
counts and planner statistics matched. Frozen pre-optimization reference tests
also compare public observations, every HP sample and every traced attack, shield,
switch and faint event, including special forms and Shadow fixtures. Historical v3
and current v4 browser replay tests pass. Cache isolation and every ordered typing
pair are checked independently. All **104 tests pass**. Two identical 12-worker, two-round search smoke tests each
completed 136 battles and retained 100 unique training labels, fitting three models
and exercising proposal scoring, screening, final testing, baselines and portable
export. Models, recommendation predictions, raw evidence and every evaluation
outcome matched exactly between runs. These small pipelines validate integration,
not recommendation quality. Summary: [simulator-validation.json](../simulator-validation.json).

## Run and compatibility

```sh
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v4-speed
```

Use a new directory after this search-algorithm update. Compatible earlier **v4** raw
fixture evidence may warm-start it via `--warm-start OLD_V4_CHECKPOINT`; models are
refit and the launcher supplies fresh evaluation seeds. V1–v3 labels describe other
controllers and remain incompatible with v4.

`simulator-compatibility.json` maps only exact parity-verified implementation source
hashes to their historical mechanics IDs. Unknown future edits get a new mechanics
hash; they are never silently accepted as equivalent. The algorithm fingerprint
also includes the raw implementation hash, so changed implementation/search code
invalidates checkpoint resume even when mechanical parity was verified. Historical
reports keep their original mechanics IDs and do not need relabeling. The v4 browser
runtime was regenerated from the optimized source.

Worker lifetime remains eight battles, with heap-triggered early recycling and the
existing watchdog. Longer lifetimes did not improve prior benchmarks and increased
memory. Existing live processes use the code loaded at startup; restart a compatible
run or start a fresh run to use this update.

---

# Earlier neural fitting performance — 2026-10-10

Battle mechanics, the information boundary, meta, precision and search parameters are unchanged. The launcher uses all available CPU cores by default.

## Changes

- Cache repeated feature vectors' forward activations and interaction projections within each minibatch. Clear the cache before the next batch because Adam changes model weights.
- Reuse gradient buffers, clearing every element before accumulation.
- Reuse shared-memory feature views in fitting workers, allowing repeated teams to share the minibatch cache.
- Validate inference references once and reuse hidden activation/projection buffers. Calls are synchronous and each worker owns its buffers.

Tests compare every trained parameter and predicted score/uncertainty exactly against the original implementation, including partial batches and multiple epochs.

## Measurements on this device

Run `node training/team-search/benchmark-neural-speed.cjs`. It alternates old/new order over four repetitions, excludes the first warmup and reports the median of the remaining three. Workload: 366 features, 16 hidden units, 4,096 repeated team/opponent fixtures for three epochs; 6,000 candidate scores against 96 reference opponents with 12 models.

| Stage | Original median | Optimized median | Throughput multiplier |
| --- | ---: | ---: | ---: |
| Neural fitting | 382.0 ms | 292.9 ms | 1.30× |
| Candidate inference | 1,125.3 ms | 1,030.9 ms | 1.09× |

These are microbenchmarks, not an overnight throughput claim. Gains depend on vector repetition, batch sizes, reference count, JIT and device load. Battle simulation still dominates runtime; profiling highlighted Pokémon construction, type-effectiveness preparation and move initialization. A complete 12-worker, 192-battle smoke run passed training, screening, final testing and report export.

Rejected experiments: extending worker lifetime from eight to 24 battles raised memory without improving the 96-battle timing; transporting the public prior once per worker also showed no gain. Recycling safeguards remain intact. Flattened inference reference data failed the repeated timing comparison and was replaced with reusable scratch buffers.

## Run and compatibility

```bash
cd ~/Desktop/Projects/GBL\ Synapse/web
node training/team-search/launch-next.cjs --hours 8
```

Use a new `--out` directory if the default contains a checkpoint. Changed search fingerprints prevent resuming an old run under new code. V4 raw evidence remains reusable through `--warm-start OLD_V4_CHECKPOINT --out NEW_DIRECTORY`; fitted models are rebuilt. V1–v3 labels remain incompatible. Existing v4 reports/replays stay compatible because the mechanics fingerprint is unchanged.

The simulator optimizations described above now address these metadata and construction costs. Further gains can come from pooling forecast state or replacing object state with arrays, but a separate combat implementation needs comprehensive timing/form parity. Reducing forecast worlds or horizons can change decisions and is not a transparent optimization.
