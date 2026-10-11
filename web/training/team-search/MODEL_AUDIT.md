# Neural model audit · October 10, 2026

The interaction network's antisymmetric matchup formula and backpropagation passed numerical gradient checks. Swapping opponents complements a prediction, and the cyclic-counter fixture confirms behavior a scalar-strength model cannot represent. No new architecture or feature set was promoted in this audit.

## Changes retained

- Training reuses activation/projection buffers and computes the pair logit from the already-computed projection, eliminating a redundant projection. The mathematical update order is preserved.
- Invalid zero batches, nonpositive epochs/rates, bad dimensions, nonfinite feature vectors and invalid fitting worker counts fail explicitly. Empty reference panels now throw instead of producing a NaN ranking.
- An optional `fitParallel(..., {bootstrap: 'team'})` research mode resamples complete candidate-team fixture blocks. Production still defaults to `fixture`; the block experiment did not consistently improve accuracy.
- `audit-model.cjs` provides a reproducible, read-only diagnostic on a frozen checkpoint. Canonical lead/bench-equivalent identities remain in one fold. Original checkpoints are never modified.

## Fitting parity and timing

`benchmark-fit-parity.cjs SAVED_BASELINE_INTERACTION_FILE` generates 8,000 deterministic 366-input fixtures and alternates five baseline/current fits (16 hidden units, three epochs). All five serialized models matched **exactly**.

An early warmed benchmark found median 0.778 → 0.742 seconds. A repeat while the machine also ran other audits found 0.784 → 0.786 seconds. The memory/projection reduction is retained for parity and reduced temporary allocation; these timings do not establish a reliable overall throughput improvement. The dominant full-team simulator has a separate performance audit.

## Whole-team bootstrap experiment

Source: completed historical v1 checkpoint, 235,968 fixture rows and 3,453 stored teams. Each run uses the same 24,000-row training subset within its fold, four models, 16 hidden units, six epochs, and three ensemble seeds. Candidate identity, rather than individual fixture, defines the held-out split. Predicted expected scores average a fixed 1,024-opponent panel from the historical independently weighted meta.

| Fold | Held-out teams | Held-out fixtures | Fixture bootstrap team MSE | Whole-team bootstrap team MSE |
| --- | ---: | ---: | ---: | ---: |
| 0 | 630 | 47,280 | 0.004561 | 0.004493 |
| 1 | 649 | 45,712 | 0.004614 | 0.005175 |
| 2 | 649 | 45,024 | 0.004451 | 0.005062 |

Whole-team blocks slightly improved fold 0, but worsened folds 1 and 2 by about 12% and 14%. Their rank correlations also worsened on those folds. **Keep fixture bootstrap as the default.** Neither bootstrap makes ensemble disagreement a calibrated confidence interval. Opponent fixtures are also correlated across candidates, so a proper uncertainty analysis would require both grouping dimensions and independent simulator evaluation.

These are predictive diagnostics on frozen historical simulator labels, using canonical bench features. They are not new-v2 simulated win rates, real usage measurements, or untouched final tests of the selected team. The old engine's bench/side behavior and independently sampled opponent model remain part of these labels. Changed mechanics require new simulation evidence.

The diagnostic command is:

```sh
node training/team-search/audit-model.cjs --checkpoint CHECKPOINT.json --pool POOL.json --fold 0 --cap 24000 --ensemble 4 --epochs 6 --repeats 3 --out model-audit.json
```

Repeat with `--fold 1` and `--fold 2`. The output records checkpoint/pool hashes, source mechanics, exact seeds, sample counts, expected-team MSE, per-fixture MSE, log loss, rank correlation, and mean ensemble disagreement. Settings compared using these diagnostics still need an independent final evaluation; the diagnostic fold is not a final team-selection test.
