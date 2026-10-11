# Neural search performance — 2026-10-10

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
cd ~/Desktop/Projects/PvPokeTeamTrainer
node training/team-search/launch-next.cjs --hours 8
```

Use a new `--out` directory if the default contains a checkpoint. Changed search fingerprints prevent resuming an old run under new code. V4 raw evidence remains reusable through `--warm-start OLD_V4_CHECKPOINT --out NEW_DIRECTORY`; fitted models are rebuilt. V1–v3 labels remain incompatible. Existing v4 reports/replays stay compatible because the mechanics fingerprint is unchanged.

Future speed work should focus on bounded simulator metadata caches with exact replay parity. Reducing forecast worlds, horizons or opponent samples can change decision quality or evaluation reliability and is not a transparent optimization.
