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


## Grouped holdouts, calibration and model variants · October 13, 2026

The October 10 audit held out candidate teams only and said that opponent fixtures are also correlated, so a proper uncertainty analysis would need both grouping dimensions. This section does that on frozen labels (the completed v4 observed-meta run and the published v1 data) and tests the model variants it left open. Method, every table and the caveats are in [findings/surrogate-eval.md](findings/surrogate-eval.md); the headline numbers are here. Nothing was simulated, and no production default changed.

**Added.** `audit-model.cjs` takes `--grouping candidate,opponent,block` (`holdout.cjs`): hold out candidate identities, opponent teams (canonical lead plus sorted bench), or both at once (fit on fixtures where neither side is held out, score only fixtures where both are, drop the mixed ones). It reports per-fixture MSE and log loss, team-mean MSE against the constant predictor, the sampling-noise floor of the observed team means, the share of the true between-team variance explained, Spearman correlation of team means (against the reference estimate and against the average prediction on the opponents the team actually faced), mean ensemble disagreement, and the spread calibration (`calibration.cjs`). `--variants "base;h24;h32;l2x3;e9;rank1;rank2;rank4;rank8"` compares model variants on the same samples and seeds with paired improvements and a seed-noise rule; `--saved 1` scores a checkpoint's own fitted models; `--v1 DIR` reads the published v1 per-team data; `--out` is written after every fit and `--resume` continues it; `--print FILE` re-reads a saved audit. `interaction.cjs` gains an opt-in low-rank antisymmetric interaction (`K = A Bᵀ − B Aᵀ`, `rank` option, gradients checked numerically) and a weight-decay multiplier (`l2`); with the defaults a fit is byte-identical to the previous code (`benchmark-fit-parity.cjs`: `serializedModelsExactlyEqual: true`). Every search round now records `diagnostics.uncertaintyCalibration` (also in `history.jsonl` and the portable report) and the viewer captions the held-out error chart with it.

**Grouped holdouts.** 4 models, 24,000 fitted fixtures, three seeds, fixture bootstrap, 3 workers; mean ± sd over seeds, constant predictor in brackets. Teams are scored at team level with at least 8 held-out fixtures (4 for v1).

v4 labels, fold 0:

| Holdout | Held-out fixtures | Teams scored | Pair MSE (constant) | Log loss (constant) | Team MSE (constant) | Noise floor | Share of true variance explained | Spearman, team means | Spearman, on the same opponents | Mean SD, team / fixture |
| --- | ---: | ---: | --- | --- | --- | ---: | --- | --- | --- | --- |
| candidate | 63,511 | 1,756 | 0.1713 ± 0.0007 (0.2062) | 0.5182 ± 0.0016 (0.6045) | 0.0224 ± 0.0007 (0.0597) | 0.0163 | 0.86 ± 0.02 | 0.629 ± 0.010 | 0.699 ± 0.001 | 0.0437 / 0.0706 |
| opponent | 62,480 | 3,952 | 0.1765 ± 0.0010 (0.2078) | 0.5331 ± 0.0014 (0.6079) | 0.0179 ± 0.0010 (0.0200) | 0.0157 | 0.50 ± 0.23 | 0.171 ± 0.040 | 0.367 ± 0.034 | 0.0366 / 0.0717 |
| block | 12,473 | 813 | 0.1770 ± 0.0004 (0.2081) | 0.5343 ± 0.0023 (0.6088) | 0.0197 ± 0.0005 (0.0207) | 0.0156 | 0.20 ± 0.09 | 0.169 ± 0.016 | 0.368 ± 0.014 | 0.0395 / 0.0760 |

v4 labels, fold 1:

| Holdout | Held-out fixtures | Teams scored | Pair MSE (constant) | Log loss (constant) | Team MSE (constant) | Noise floor | Share of true variance explained | Spearman, team means | Spearman, on the same opponents | Mean SD, team / fixture |
| --- | ---: | ---: | --- | --- | --- | ---: | --- | --- | --- | --- |
| candidate | 64,014 | 1,697 | 0.1695 ± 0.0005 (0.2057) | 0.5137 ± 0.0015 (0.6036) | 0.0213 ± 0.0002 (0.0581) | 0.0161 | 0.88 ± 0.00 | 0.635 ± 0.012 | 0.701 ± 0.011 | 0.0465 / 0.0738 |
| opponent | 65,556 | 4,103 | 0.1722 ± 0.0005 (0.2015) | 0.5208 ± 0.0017 (0.5944) | 0.0169 ± 0.0003 (0.0215) | 0.0143 | 0.64 ± 0.04 | 0.184 ± 0.030 | 0.341 ± 0.010 | 0.0404 / 0.0750 |
| block | 13,033 | 837 | 0.1728 ± 0.0022 (0.2038) | 0.5222 ± 0.0052 (0.5996) | 0.0175 ± 0.0008 (0.0213) | 0.0146 | 0.58 ± 0.12 | 0.184 ± 0.032 | 0.360 ± 0.026 | 0.0417 / 0.0740 |

Published v1 data, fold 0 (the same 630 held-out teams and 47,280 fixtures as the whole-team bootstrap experiment above):

| Holdout | Held-out fixtures | Teams scored | Pair MSE (constant) | Log loss (constant) | Team MSE (constant) | Noise floor | Share of true variance explained | Spearman, team means | Spearman, on the same opponents | Mean SD, team / fixture |
| --- | ---: | ---: | --- | --- | --- | ---: | --- | --- | --- | --- |
| candidate | 47,280 | 630 | 0.1266 ± 0.0019 (0.1643) | 0.6127 ± 0.0043 (0.6931) | 0.0045 ± 0.0006 (0.0178) | 0.0024 | 0.86 ± 0.04 | 0.853 ± 0.013 | 0.866 ± 0.011 | 0.0426 / 0.0788 |
| opponent | 47,671 | 3,200 | 0.1252 ± 0.0009 (0.1628) | 0.6126 ± 0.0020 (0.6931) | 0.0144 ± 0.0001 (0.0285) | 0.0126 | 0.89 ± 0.01 | 0.705 ± 0.004 | 0.749 ± 0.006 | 0.0386 / 0.0778 |
| block | 9,506 | 628 | 0.1257 ± 0.0010 (0.1626) | 0.6143 ± 0.0024 (0.6930) | 0.0138 ± 0.0003 (0.0267) | 0.0126 | 0.92 ± 0.02 | 0.711 ± 0.002 | 0.746 ± 0.002 | 0.0418 / 0.0795 |

Unseen opponent teams cost the model 2 to 3 points of its 17% per-fixture gain on v4 labels (nothing on v1), and holding out both sides costs about the same. Most of a team-level error is label noise: for unseen v4 candidates 0.016 of the 0.022 mean squared error is the sampling variance of the observed means (a team with 8 fixtures has a standard error near 0.16), and on v1 0.0024 of 0.0045. The model explains about 86 to 91% of the true between-team variance of unseen candidates. Ranking among heavily sampled leaders, the only teams with enough held-out fixtures under an opponent holdout, is weak (Spearman 0.17 to 0.18 on v4, 0.34 to 0.37 on the opponents each team faced).

**Calibration.** The ensemble spread is not an interval. Smallest multiple `k` of the spread that contains 80% and 90% of the held-out teams' absolute errors; a Gaussian would give 1.28 and 1.64. The first three rows are 4-model fits (mean of three seeds, v4 labels, fold 0); the last row is the run's own 12-model ensemble scored without refitting.

| Holdout / model | Teams | Median spread | Median abs error | k80 | k90 | Share inside ±1 spread | Spearman | Teams with 64+ fixtures: k90 / Spearman | With sampling noise added: k90 / inside ±1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| candidate | 1,756 | 0.0391 | 0.0799 | 4.69 | 7.15 | 0.27 | 0.17 | 4.24 / 0.09 (859 teams) | 1.90 / 0.63 |
| opponent | 3,952 | 0.0342 | 0.0873 | 5.61 | 8.10 | 0.22 | 0.03 | — | 1.85 / 0.67 |
| block | 813 | 0.0372 | 0.0929 | 5.60 | 7.88 | 0.22 | -0.03 | — | 1.94 / 0.65 |
| candidate (the run's own 12 models) | 1,756 | 0.0439 | 0.0786 | 3.55 | 5.01 | 0.31 | 0.19 | 3.19 / -0.02 (859 teams) | 1.79 / 0.65 |

With the production twelve models it takes 5.0 spreads to contain 90% of the 1,756 held-out teams (±1 contains 31%), and the spread hardly ranks which predictions miss by more (Spearman 0.19; −0.02 among the 859 teams with 64 or more fixtures). Adding each team's own sampling noise to the squared spread gives k90 = 1.8 and ±1 containing 65%, close to a Gaussian's: spread plus label noise is nearly a consistent error scale; the spread alone is not.

**Variants.** Relative improvement over the baseline on the same seeds and samples (positive is better; ✓ = every seed better and the mean beats both the paired sd and the baseline's sd; ✗ = the same, worse).

v4 labels, fold 0:

| Variant | Cand.: pair MSE | Cand.: log loss | Cand.: team MSE | Cand.: Spearman | Opp.: pair MSE | Opp.: log loss | Opp.: team MSE (same opponents) | Opp.: Spearman (same opponents) | Block: pair MSE | Block: team MSE (same opponents) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base (absolute) | 0.1713 ± 0.0007 | 0.5182 ± 0.0016 | 0.0224 ± 0.0007 | 0.629 ± 0.010 | 0.1765 ± 0.0010 | 0.5331 ± 0.0014 | 0.0159 ± 0.0006 | 0.367 ± 0.034 | 0.1770 ± 0.0004 | 0.0171 ± 0.0004 |
| h24 | +0.9% ✓ | +0.8% ✓ | -0.4% | -1.0% | +0.6% | +0.6% ✓ | -1.0% | -0.5% | +0.5% | -2.8% |
| h32 | +1.7% ✓ | +1.4% ✓ | -1.9% | -2.0% ✗ | +1.2% ✓ | +1.0% ✓ | +0.3% | +3.0% | +1.2% ✓ | -0.8% |
| l2x3 | -0.1% | -0.1% | +0.5% | +0.1% | +0.0% | +0.1% | +0.3% | -0.6% | -0.1% | -0.4% |
| e9 | +1.2% ✓ | +1.0% ✓ | +1.8% | +0.9% | +0.6% ✓ | +0.5% ✓ | +1.4% | +5.7% | +0.2% | -1.6% |
| rank1 | -2.3% ✗ | -2.0% ✗ | -4.7% ✗ | -1.2% | -1.1% ✗ | -0.8% ✗ | +0.7% | -2.6% | -1.7% ✗ | -2.5% |
| rank2 | -1.8% ✗ | -1.6% ✗ | -2.3% | -0.4% | -1.3% ✗ | -0.9% ✗ | -0.0% | -3.1% | -1.6% ✗ | -2.2% |
| rank4 | -1.5% ✗ | -1.2% ✗ | -2.8% | -0.6% | -0.9% ✗ | -0.6% ✗ | +1.3% | -0.1% | -1.0% ✗ | -1.6% |
| rank8 | -1.0% ✗ | -0.9% ✗ | -1.2% | -0.2% | -0.5% | -0.4% ✗ | +1.3% | -0.3% | -0.8% ✗ | -0.9% |

v4 labels, fold 1:

| Variant | Cand.: pair MSE | Cand.: log loss | Cand.: team MSE | Cand.: Spearman | Opp.: pair MSE | Opp.: log loss | Opp.: team MSE (same opponents) | Opp.: Spearman (same opponents) | Block: pair MSE | Block: team MSE (same opponents) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base (absolute) | 0.1695 ± 0.0005 | 0.5137 ± 0.0015 | 0.0213 ± 0.0002 | 0.635 ± 0.012 | 0.1722 ± 0.0005 | 0.5208 ± 0.0017 | 0.0154 ± 0.0001 | 0.341 ± 0.010 | 0.1728 ± 0.0022 | 0.0153 ± 0.0005 |
| h24 | +0.6% ✓ | +0.5% ✓ | -1.5% | -1.3% | +0.5% | +0.4% | +0.1% | +3.5% | +0.5% | -0.8% |
| h32 | +0.9% ✓ | +0.8% ✓ | -4.0% | -1.9% ✗ | +1.2% ✓ | +0.9% ✓ | -0.4% | +4.3% ✓ | +0.9% | -0.9% |
| l2x3 | -0.1% | -0.1% | -1.0% | -0.5% | -0.1% | -0.0% | -0.7% | -1.7% | -0.1% | -0.4% |
| e9 | +0.4% | +0.3% | -3.8% | -0.2% | +0.4% | +0.2% | -0.8% | +4.1% | +0.3% | -2.7% |
| rank1 | -2.2% ✗ | -1.9% ✗ | -4.7% ✗ | -0.9% | -1.6% ✗ | -1.4% ✗ | -2.5% ✗ | -8.0% ✗ | -2.3% ✗ | -3.3% |
| rank2 | -2.0% ✗ | -1.7% ✗ | -4.5% ✗ | -0.6% | -1.4% ✗ | -1.2% ✗ | -2.1% ✗ | -7.9% ✗ | -2.3% ✗ | -3.0% |
| rank4 | -1.7% ✗ | -1.4% ✗ | -2.3% ✗ | -0.2% | -1.1% ✗ | -0.9% ✗ | -1.1% | -4.1% ✗ | -1.5% ✗ | -3.5% ✗ |
| rank8 | -1.0% ✗ | -0.8% ✗ | -1.1% | -0.2% | -0.5% ✗ | -0.4% ✗ | +0.4% ✓ | -0.5% | -0.8% | -0.4% |

Published v1 data:

| Variant | Cand.: pair MSE | Cand.: log loss | Cand.: team MSE | Cand.: Spearman | Opp.: pair MSE | Opp.: log loss | Opp.: team MSE (same opponents) | Opp.: Spearman (same opponents) | Block: pair MSE | Block: team MSE (same opponents) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base (absolute) | 0.1266 ± 0.0019 | 0.6127 ± 0.0043 | 0.0045 ± 0.0006 | 0.853 ± 0.013 | 0.1252 ± 0.0009 | 0.6126 ± 0.0020 | 0.0128 ± 0.0001 | 0.749 ± 0.006 | 0.1257 ± 0.0010 | 0.0126 ± 0.0003 |
| h24 | +3.2% ✓ | +1.5% ✓ | +2.5% | +0.6% | +2.4% ✓ | +1.1% ✓ | +2.2% ✓ | +0.9% ✓ | +2.5% ✓ | +2.8% |
| h32 | +3.9% ✓ | +1.8% ✓ | -11.5% | -1.2% | +4.3% ✓ | +2.1% ✓ | +2.9% ✓ | +1.3% ✓ | +2.2% | -0.6% |
| l2x3 | -0.1% | -0.0% | -1.0% | -0.2% | -0.2% | -0.1% | +0.5% | +0.1% | -0.0% | +0.4% |
| e9 | +2.3% ✓ | +1.1% ✓ | +1.1% | +0.2% | +1.5% ✓ | +0.7% ✓ | +0.2% | +0.5% | +1.2% ✓ | -0.9% |
| rank1 | -5.9% ✗ | -2.7% ✗ | +2.0% | +0.6% | -5.8% ✗ | -2.7% ✗ | -4.3% ✗ | -1.9% ✗ | -5.4% ✗ | -4.2% ✗ |
| rank2 | -5.8% ✗ | -2.7% ✗ | +0.0% | +0.2% | -6.0% ✗ | -2.8% ✗ | -4.8% ✗ | -1.9% ✗ | -5.4% ✗ | -3.6% ✗ |
| rank4 | -5.6% ✗ | -2.6% ✗ | +3.2% | +0.7% | -5.7% ✗ | -2.6% ✗ | -4.8% ✗ | -1.9% ✗ | -5.1% ✗ | -4.4% ✗ |
| rank8 | -4.1% ✗ | -1.9% ✗ | +0.9% | +0.4% | -5.0% ✗ | -2.3% ✗ | -4.1% ✗ | -1.6% ✗ | -4.2% ✗ | -4.0% ✗ |

**At the production fit size** (48,000 fixtures per fit, 4 models, three seeds). Fold 0, four variants:

| Variant | Cand.: pair MSE | Cand.: log loss | Cand.: team MSE | Cand.: Spearman | Opp.: pair MSE | Opp.: log loss | Opp.: team MSE (same opponents) | Opp.: Spearman (same opponents) | Block: pair MSE | Block: team MSE (same opponents) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base (absolute) | 0.1652 ± 0.0002 | 0.5026 ± 0.0004 | 0.0215 ± 0.0007 | 0.629 ± 0.015 | 0.1727 ± 0.0012 | 0.5230 ± 0.0028 | 0.0151 ± 0.0003 | 0.403 ± 0.017 | — | — |
| h32 | +1.8% ✓ | +1.5% ✓ | +2.4% | +1.3% | +0.6% | +0.5% | -3.2% ✗ | -2.4% | — | — |
| e9 | +1.4% ✓ | +1.2% ✓ | +5.1% ✓ | +2.4% ✓ | +0.6% | +0.6% ✓ | +0.6% | +2.1% | — | — |
| hidden=32,epochs=9 | +2.2% ✓ | +1.9% ✓ | +6.0% ✓ | +1.0% | +0.9% ✓ | +0.6% ✓ | -0.6% | +2.1% | — | — |

Nine epochs against six on folds 0 to 3:

| Fold | Cand.: pair MSE | Cand.: log loss | Cand.: team MSE | Cand.: Spearman | Opp.: pair MSE | Opp.: log loss | Opp.: team MSE (same opponents) | Opp.: Spearman (same opponents) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | +1.4% ✓ | +1.2% ✓ | +5.1% ✓ | +2.4% ✓ | +0.6% | +0.6% ✓ | +0.6% | +2.1% |
| 1 | +0.8% ✓ | +0.6% ✓ | +7.4% ✓ | +0.1% | +1.0% ✓ | +0.8% ✓ | +2.3% | +1.0% |
| 2 | +0.7% ✓ | +0.6% ✓ | +1.6% | -0.5% | -0.2% | -0.1% | -0.3% | +1.6% |
| 3 | +1.2% ✓ | +1.1% ✓ | -4.8% ✗ | +0.8% | +0.6% | +0.5% | +2.0% ✓ | +4.9% ✓ |
| mean over folds (folds better) | +1.0% (4/4) | +0.9% (4/4) | +2.3% (3/4) | +0.7% (3/4) | +0.5% (3/4) | +0.4% (3/4) | +1.1% (3/4) | +2.4% (4/4) |

**Decision: keep the defaults.** The promotion rule was fixed in advance: better on both the candidate- and opponent-grouped holdout, at team level, in every paired seed and by more than the seed noise. Hidden width 24 and 32 and nine epochs reliably lower per-fixture error (0.2 to 4.3% at 24,000 fixtures per fit, with no case clearly worse) but not team-level error, whose changes run from −11.5% to +3.0% with unstable sign; their fits take 55%, 130% and 58% longer. At the production fit size (48,000) nine epochs is the closest call: better per fixture on every fold's candidate holdout (+0.7 to +1.4%, beyond seed noise) and slightly on three of four opponent holdouts, but its team-level change runs from −4.8% to +7.4% across folds 0 to 3 (+2.3% on average; +1.1% on average for the opponent holdout's same-opponents error), so it does not pass. Three times the weight decay is a tie. A low-rank antisymmetric interaction is worse per fixture in all 36 comparisons (0.5 to 6.0%, beyond seed noise in 34), worst at rank 1 and best at rank 8; the free matrix stays. Whether nine epochs (or width 32) pays at the full production size (12 models, 48,000 fixtures) is for the full-scale audit in the findings (all five folds, a pooled analysis fixed in advance), not decided here.

The same caveats as the whole-team bootstrap experiment apply: these are predictive diagnostics on frozen historical simulator labels, held-out candidates are held out by canonical identity (not species or moveset family), and three seeds cannot see team-level differences under about 3 to 4%.

```sh
node training/team-search/audit-model.cjs --checkpoint CHECKPOINT.json --pool POOL.json --grouping candidate,opponent,block --variants "base;h24;h32;l2x3;e9;rank1;rank2;rank4;rank8" --cap 24000 --ensemble 4 --epochs 6 --repeats 3 --workers 3 --bootstrap fixture --resample 1 --minTeamFixtures 8 --fold 0 --out model-audit-grouped.json
node training/team-search/audit-model.cjs --print model-audit-grouped.json
```

Full scale (12 workers, ensemble 12, cap 48,000, five folds, the v1 data and the saved models) is in the findings.
