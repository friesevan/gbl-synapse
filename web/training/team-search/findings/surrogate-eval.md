# Surrogate error and calibration (2026-10-13)

Scope: the section-12 accuracy row "Surrogate error and calibration" of [../README.md](../README.md). Everything here is a read-only analysis of frozen simulator labels (the completed v4 observed-meta run, 317,655 fixtures on 8,477 teams, and the published v1 data, 235,968 fixtures on 3,453 teams). No battle was simulated, so these are predictive diagnostics on historical labels, not new win rates, and they say nothing about changed mechanics.

## Summary

- **Grouped holdouts.** Holding out candidate teams, opponent teams, or both at once changes per-fixture error very little: on the v4 labels the model's squared error is 0.171 for unseen candidates, 0.177 for unseen opponent teams and 0.177 for both unseen, against 0.206 to 0.208 for the constant predictor. The model carries over to new opponent compositions almost as well as to new candidates. (v1 data: 0.127, 0.125, 0.126 against 0.163 to 0.164.)
- **Most team-level error is label noise.** The observed mean score of a team with 8 fixtures has a standard error near 0.16. Of the v4 team mean squared error of 0.022 for unseen candidates, 0.016 is that sampling noise; after removing it the model explains about 86 to 88% of the true between-team variance (91% for the run's own 12 models). Among heavily sampled leaders, which are the only teams with enough held-out fixtures under an opponent holdout, ranking is weak (Spearman 0.17 to 0.18; 0.34 to 0.37 when each team is judged on the opponents it actually faced).
- **The ensemble spread is not an interval and barely ranks risk.** For the run's own 12 models on 1,756 held-out teams: median spread 0.044, median absolute error 0.079, k90 = 5.0 (it takes five spreads to contain 90% of the teams; ±1 spread contains 31%), Spearman of spread with absolute error 0.19, and −0.02 among the 859 teams with 64 or more fixtures. Adding each team's own sampling noise to the squared spread gives k90 = 1.8 and ±1 containing 65%, close to a Gaussian's 1.64 and 68%: spread plus label noise is nearly a consistent error scale, the spread alone is not.
- **Model variants: nothing promoted.** At 24,000 fixtures per fit, hidden 24 and 32 and nine epochs lower per-fixture error by 0.2 to 4% in every design on both data sets, but none lowers team-level error beyond seed noise on both grouped holdouts (changes range from −11.5% to +3.0%, sign not stable). At the production fit size (48,000) nine epochs is the closest call: per-fixture error is better beyond seed noise on the candidate holdout of all four folds (+0.7 to +1.4%) and slightly better on three of four opponent holdouts (+0.5% on average), but team-level error moves from −4.8% to +7.4% across the folds (+2.3% on average), so it does not pass the pre-set rule and goes to the full-scale audit. Three times the weight decay is a tie. A low-rank antisymmetric interaction is worse per fixture by 0.5 to 6.0%, beyond seed noise in 34 of 36 comparisons. **No production default was changed.**

## What was built

| File | What |
| --- | --- |
| `holdout.cjs` (new) | grouping by candidate identity, opponent identity (canonical lead plus sorted bench) or both (block); the scoring of one ensemble on held-out fixtures; the paired summary of variants |
| `calibration.cjs` (new) | `k80`, `k90`, cross-fitted coverage, `coverage1`, Spearman of spread with absolute error; used by `search.cjs` and the audit |
| `audit-model.cjs` | `--grouping candidate,opponent,block`, `--variants`, `--saved 1`, `--v1 DIR`, `--resample`, `--minTeamFixtures`, resumable `--out`, `--print` |
| `interaction.cjs`, `fit-interaction.cjs`, `interaction-worker.cjs` | opt-in low-rank antisymmetric interaction (`rank`, `K = A Bᵀ − B Aᵀ`) and a weight-decay multiplier (`l2`); both default to the production behaviour |
| `search.cjs` | `uncertaintyCalibration` in each round's diagnostics (one hunk, listed at the end) |
| `neural-report-core.js`, `neural-portable.js` | the validator for the field and the caption under the held-out error chart |

Production fits are byte-identical with the defaults: `benchmark-fit-parity.cjs` against the previous `interaction.cjs` gave `serializedModelsExactlyEqual: true` (median 0.794 s against 0.792 s).

## Settings

Every audit: the v4 checkpoint's labels, 4 models, 16 hidden units unless varied, 6 epochs unless varied, a fresh random sample of 24,000 training fixtures per seed (drawn from the fixtures where no held-out identity appears), three seeds, the same sample and seeds for every variant (paired), fixture bootstrap, 3 workers, `nice -n 10`. Teams are scored at team level when they have at least 8 held-out fixtures (4 for v1, whose teams have 32 paired fixtures). The reference opponent panel (1,024 opponents) is drawn from the training opponents, never from a held-out one, so it follows the observed meta; the v1 data uses the pool's independent weights, as its meta did. `fold` selects the hashed 20% of identities held out (`digest(key) mod 5`); fold 0 is the set the search itself holds out. Fits took 13 s for the baseline, 20 s for hidden 24 and for nine epochs, 30 s for hidden 32 (a loaded machine: load average 11 to 17).

## 1. Grouped holdouts

Mean ± sd over three seeds; in brackets the constant predictor (the mean training score). "Share of true variance explained" removes each team's sampling variance (its fixtures' sample variance divided by their number) from both its squared error and the constant predictor's, and compares what is left. "Same opponents" judges each team by the average of the model's fixture predictions on the very opponents it faced, which is the fair comparison when only some opponents are held out. Under the opponent and block designs team-level numbers describe the heavily sampled leaders only (the teams with 8 or more held-out fixtures), whose true scores are nearly alike: the constant predictor's team error is barely above the noise floor, so explained-variance shares are unstable and the rank correlations are the readable numbers.

**v4 labels, fold 0** (candidate holdout: 6,721 training and 1,756 held-out candidates; opponent holdout: 4,715 training and 1,130 held-out opponent teams; the block design drops 101,045 fixtures with exactly one side held out):

| Holdout | Held-out fixtures | Teams scored | Pair MSE (constant) | Log loss (constant) | Team MSE (constant) | Noise floor | Share of true variance explained | Spearman, team means | Spearman, on the same opponents | Mean SD, team / fixture |
| --- | ---: | ---: | --- | --- | --- | ---: | --- | --- | --- | --- |
| candidate | 63,511 | 1,756 | 0.1713 ± 0.0007 (0.2062) | 0.5182 ± 0.0016 (0.6045) | 0.0224 ± 0.0007 (0.0597) | 0.0163 | 0.86 ± 0.02 | 0.629 ± 0.010 | 0.699 ± 0.001 | 0.0437 / 0.0706 |
| opponent | 62,480 | 3,952 | 0.1765 ± 0.0010 (0.2078) | 0.5331 ± 0.0014 (0.6079) | 0.0179 ± 0.0010 (0.0200) | 0.0157 | 0.50 ± 0.23 | 0.171 ± 0.040 | 0.367 ± 0.034 | 0.0366 / 0.0717 |
| block | 12,473 | 813 | 0.1770 ± 0.0004 (0.2081) | 0.5343 ± 0.0023 (0.6088) | 0.0197 ± 0.0005 (0.0207) | 0.0156 | 0.20 ± 0.09 | 0.169 ± 0.016 | 0.368 ± 0.014 | 0.0395 / 0.0760 |

**v4 labels, fold 1:**

| Holdout | Held-out fixtures | Teams scored | Pair MSE (constant) | Log loss (constant) | Team MSE (constant) | Noise floor | Share of true variance explained | Spearman, team means | Spearman, on the same opponents | Mean SD, team / fixture |
| --- | ---: | ---: | --- | --- | --- | ---: | --- | --- | --- | --- |
| candidate | 64,014 | 1,697 | 0.1695 ± 0.0005 (0.2057) | 0.5137 ± 0.0015 (0.6036) | 0.0213 ± 0.0002 (0.0581) | 0.0161 | 0.88 ± 0.00 | 0.635 ± 0.012 | 0.701 ± 0.011 | 0.0465 / 0.0738 |
| opponent | 65,556 | 4,103 | 0.1722 ± 0.0005 (0.2015) | 0.5208 ± 0.0017 (0.5944) | 0.0169 ± 0.0003 (0.0215) | 0.0143 | 0.64 ± 0.04 | 0.184 ± 0.030 | 0.341 ± 0.010 | 0.0404 / 0.0750 |
| block | 13,033 | 837 | 0.1728 ± 0.0022 (0.2038) | 0.5222 ± 0.0052 (0.5996) | 0.0175 ± 0.0008 (0.0213) | 0.0146 | 0.58 ± 0.12 | 0.184 ± 0.032 | 0.360 ± 0.026 | 0.0417 / 0.0740 |

**Published v1 data, fold 0** (the same 630 held-out teams and 47,280 fixtures as the October 10 whole-team-bootstrap audit):

| Holdout | Held-out fixtures | Teams scored | Pair MSE (constant) | Log loss (constant) | Team MSE (constant) | Noise floor | Share of true variance explained | Spearman, team means | Spearman, on the same opponents | Mean SD, team / fixture |
| --- | ---: | ---: | --- | --- | --- | ---: | --- | --- | --- | --- |
| candidate | 47,280 | 630 | 0.1266 ± 0.0019 (0.1643) | 0.6127 ± 0.0043 (0.6931) | 0.0045 ± 0.0006 (0.0178) | 0.0024 | 0.86 ± 0.04 | 0.853 ± 0.013 | 0.866 ± 0.011 | 0.0426 / 0.0788 |
| opponent | 47,671 | 3,200 | 0.1252 ± 0.0009 (0.1628) | 0.6126 ± 0.0020 (0.6931) | 0.0144 ± 0.0001 (0.0285) | 0.0126 | 0.89 ± 0.01 | 0.705 ± 0.004 | 0.749 ± 0.006 | 0.0386 / 0.0778 |
| block | 9,506 | 628 | 0.1257 ± 0.0010 (0.1626) | 0.6143 ± 0.0024 (0.6930) | 0.0138 ± 0.0003 (0.0267) | 0.0126 | 0.92 ± 0.02 | 0.711 ± 0.002 | 0.746 ± 0.002 | 0.0418 / 0.0795 |

Reading:

- Holding out opponents costs 2 to 3 points of the 17% per-fixture gain on v4 labels and nothing on v1, and holding out both sides costs about the same: the per-fixture gain does not rest on having seen the opponents.
- The v4 candidate holdout has a noise floor of 0.016 against a model error of 0.022, so 73 to 76% of the headline team error is label noise. On v1 the same split gives 0.0024 of 0.0045, about 4.6 points of model error inside the quoted 6.4.
- Ranking is much better among all unseen candidates (0.63 to 0.65; 0.85 on v1) than among v4's heavily sampled leaders (0.17 to 0.18). Those leaders were selected by an adaptive search for being strong, so their true differences are small and the surrogate cannot sort them: the same fact as the unresolved finalist bands. The v1 data has no such selection (every team has 32 paired fixtures, so the opponent holdout scores all 3,200 teams) and ranks 0.71 there.
- The run's own saved ensemble (12 models, 48,000 fixtures) scores on the candidate holdout: pair MSE 0.1636 (the checkpoint's own diagnostic recorded 0.1636), team MSE 0.0202, explained share 0.91, Spearman 0.645 (0.733 on the same opponents).

## 2. Uncertainty calibration

For each held-out team: the ensemble mean over the reference panel is the prediction, the ensemble's standard deviation of that mean is the spread, and the observed mean score is the target. `k80` and `k90` are the smallest multiples of the spread that contain 80% and 90% of the teams' absolute errors; "inside ±1" is the share of teams within one spread; Spearman correlates spread with absolute error; "with sampling noise added" widens each team's spread to `sqrt(spread² + sampling variance of its observed mean)`. The out-of-sample coverage of ±k × spread (k estimated on one half of the teams, applied to the other) averaged 0.80 and 0.90 (0.77 to 0.82 and 0.88 to 0.91 in single fits), i.e. the error-to-spread ratio is stable across teams; it is recorded in the field as a stability check and carries no further information about calibration.

**v4 fold 0** (4-model fits, mean of three seeds) and **the run's own 12 models on fold 0** (`--saved 1`):

| Holdout / model | Teams | Median spread | Median abs error | k80 | k90 | Share inside ±1 spread | Spearman | Teams with 64+ fixtures: k90 / Spearman | With sampling noise added: k90 / inside ±1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| candidate | 1,756 | 0.0391 | 0.0799 | 4.69 | 7.15 | 0.27 | 0.17 | 4.24 / 0.09 (859 teams) | 1.90 / 0.63 |
| opponent | 3,952 | 0.0342 | 0.0873 | 5.61 | 8.10 | 0.22 | 0.03 | — | 1.85 / 0.67 |
| block | 813 | 0.0372 | 0.0929 | 5.60 | 7.88 | 0.22 | -0.03 | — | 1.94 / 0.65 |
| candidate (the run's own 12 models) | 1,756 | 0.0439 | 0.0786 | 3.55 | 5.01 | 0.31 | 0.19 | 3.19 / -0.02 (859 teams) | 1.79 / 0.65 |

**v4 fold 1:**

| Holdout / model | Teams | Median spread | Median abs error | k80 | k90 | Share inside ±1 spread | Spearman | Teams with 64+ fixtures: k90 / Spearman | With sampling noise added: k90 / inside ±1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| candidate | 1,697 | 0.0421 | 0.0749 | 4.19 | 6.46 | 0.32 | 0.12 | 3.42 / 0.04 (854 teams) | 1.79 / 0.66 |
| opponent | 4,103 | 0.0382 | 0.0923 | 5.24 | 7.45 | 0.22 | 0.03 | — | 1.97 / 0.64 |
| block | 837 | 0.0407 | 0.0926 | 4.68 | 6.74 | 0.22 | 0.03 | — | 1.93 / 0.64 |

**Published v1 data:**

| Holdout / model | Teams | Median spread | Median abs error | k80 | k90 | Share inside ±1 spread | Spearman | Teams with 64+ fixtures: k90 / Spearman | With sampling noise added: k90 / inside ±1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| candidate | 630 | 0.0406 | 0.0454 | 2.29 | 3.38 | 0.47 | 0.08 | 3.36 / 0.09 (585 teams) | 1.74 / 0.66 |
| opponent | 3,200 | 0.0369 | 0.0791 | 4.64 | 6.71 | 0.25 | 0.02 | — | 1.86 / 0.66 |
| block | 628 | 0.0398 | 0.0759 | 4.19 | 5.96 | 0.29 | 0.01 | — | 1.74 / 0.68 |

Reading:

- The spread is far too small to be an interval. A Gaussian error would give k90 = 1.64; the v4 labels give 6.5 to 8.1 with four models (4 to 5 times), 5.0 with the production twelve (3 times), and the v1 candidates 3.4 (2 times; every v1 team has 32 paired fixtures, so its label noise is smaller; 6.0 to 6.7 under its opponent and block holdouts).
- Most of that is label noise, not a flaw in the ensemble. With each team's own sampling noise added, k90 is 1.7 to 2.0 and ±1 contains 63 to 68% in every holdout and both data sets, near a Gaussian's 1.64 and 68%. The residual excess (k90 1.8 to 2.0 against 1.64) is the part of the model error the ensemble members do not disagree about, because they share training data.
- The spread hardly ranks which predictions miss by more: Spearman 0.12 to 0.19 across unseen candidates, −0.03 to 0.03 under opponent and block holdouts, 0.08 for v1 candidates, and about zero among teams with at least 64 fixtures (−0.02 to 0.09). Using it as a risk signal, as the exploration rule does, is a heuristic; it is not evidence that high-spread teams are the poorly predicted ones. This agrees with the earlier finding that pure-disagreement proposals were barely above random (37.4% against 34.0%, section 7).
- Four models give larger k than twelve (a four-member standard deviation is noisy and on average about 20% below that of a large ensemble, against 6% for twelve), so the 12-model line is the one to quote.

## 3. Model variants

Decision rule, fixed before the runs: a variant is promoted to the production default only if, on both the candidate-grouped and the opponent-grouped holdout, its team-level error (reference estimate for candidates, "same opponents" for the opponent design) improves in every one of the three paired seeds and the mean improvement exceeds both the sd of the paired differences and the baseline's own sd across seeds (the ✓ below); it must also not be clearly worse per fixture on either. Team-level error is the criterion because the search ranks teams by their team estimates (the same reason six epochs were chosen over ten); per-fixture error and rank correlation are reported alongside.

Cell = relative improvement over the baseline (positive is better), on the same seeds and samples; ✓ = beats the noise by that rule, ✗ = clearly worse. The first row is the baseline in absolute terms.

**v4 labels, fold 0:**

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

**v4 labels, fold 1:**

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

**Published v1 data:**

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

**At the production fit size** (48,000 fixtures per fit, 4 models, three seeds; candidate and opponent holdouts only). Fold 0 for all four variants:

| Variant | Cand.: pair MSE | Cand.: log loss | Cand.: team MSE | Cand.: Spearman | Opp.: pair MSE | Opp.: log loss | Opp.: team MSE (same opponents) | Opp.: Spearman (same opponents) | Block: pair MSE | Block: team MSE (same opponents) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base (absolute) | 0.1652 ± 0.0002 | 0.5026 ± 0.0004 | 0.0215 ± 0.0007 | 0.629 ± 0.015 | 0.1727 ± 0.0012 | 0.5230 ± 0.0028 | 0.0151 ± 0.0003 | 0.403 ± 0.017 | — | — |
| h32 | +1.8% ✓ | +1.5% ✓ | +2.4% | +1.3% | +0.6% | +0.5% | -3.2% ✗ | -2.4% | — | — |
| e9 | +1.4% ✓ | +1.2% ✓ | +5.1% ✓ | +2.4% ✓ | +0.6% | +0.6% ✓ | +0.6% | +2.1% | — | — |
| hidden=32,epochs=9 | +2.2% ✓ | +1.9% ✓ | +6.0% ✓ | +1.0% | +0.9% ✓ | +0.6% ✓ | -0.6% | +2.1% | — | — |

Nine epochs against six on four folds (relative improvement; the most consistent per-fixture gain above):

| Fold | Cand.: pair MSE | Cand.: log loss | Cand.: team MSE | Cand.: Spearman | Opp.: pair MSE | Opp.: log loss | Opp.: team MSE (same opponents) | Opp.: Spearman (same opponents) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | +1.4% ✓ | +1.2% ✓ | +5.1% ✓ | +2.4% ✓ | +0.6% | +0.6% ✓ | +0.6% | +2.1% |
| 1 | +0.8% ✓ | +0.6% ✓ | +7.4% ✓ | +0.1% | +1.0% ✓ | +0.8% ✓ | +2.3% | +1.0% |
| 2 | +0.7% ✓ | +0.6% ✓ | +1.6% | -0.5% | -0.2% | -0.1% | -0.3% | +1.6% |
| 3 | +1.2% ✓ | +1.1% ✓ | -4.8% ✗ | +0.8% | +0.6% | +0.5% | +2.0% ✓ | +4.9% ✓ |
| mean over folds (folds better) | +1.0% (4/4) | +0.9% (4/4) | +2.3% (3/4) | +0.7% (3/4) | +0.5% (3/4) | +0.4% (3/4) | +1.1% (3/4) | +2.4% (4/4) |

Reading:

- **Hidden 24, hidden 32, nine epochs.** Per-fixture error improves in every design on both data sets (0.2 to 4.3%; beyond seed noise in 17 of 27 comparisons) with no ✗ on either per-fixture metric, and the gain grows from v4 (0.2 to 1.7%) to v1 (1.2 to 4.3%). The team-level error, which is what the search consumes, does not improve reliably: for hidden 32 it ranges from −11.5% to +2.9% and for nine epochs from −3.8% to +1.9% across folds and designs, and on the opponent holdout "same opponents" error only hidden 24 and 32 on v1 clear the rule. No variant passes on both groupings, so none is promoted. The cost is real but small against hours of simulation: +55% (hidden 24), +58% (nine epochs) and +130% (hidden 32) fitting time.
- **Three times the weight decay** moves every metric by less than the seed noise: it is a tie, and the current decay is not binding.
- **Low-rank antisymmetric K** is worse per fixture in all 36 comparisons (0.4 to 6.0%, beyond seed noise in 34), worst for rank 1 and smallest for rank 8, which can represent any antisymmetric matrix of the free model and so shows how much the factored parametrisation alone costs (0.5 to 5.0%). Team-level results are a tie or worse. The free matrix stays the default; the option remains for later experiments.
- **At the production fit size** the baseline improves (candidate pair MSE 0.1652, team MSE 0.0215, explained share 0.88, against 0.1713, 0.0224 and 0.86 at 24,000 fixtures) and nine epochs becomes the most promising change. Per fixture it is better beyond seed noise on every fold's candidate holdout (+0.7% to +1.4%, log loss +0.6% to +1.2%) and by less on the opponent holdouts (+0.5% on average; beyond noise on one fold for pair MSE and two for log loss). Team level is mixed: the candidate team error changes by +5.1%, +7.4%, +1.6% and −4.8% on folds 0 to 3 (clearly better on two, clearly worse on one), the 'same opponents' error on the opponent holdout by +0.6%, +2.3%, −0.3% and +2.0%. Hidden 32 alone is worse on the opponent holdout (−3.2%, clearly) and a tie on candidates; hidden 32 with nine epochs gives the largest candidate gain (+6.0% team error on fold 0) at three times the fitting time (24 s, 37 s and 49 s for baseline, nine epochs and width 32 on a loaded machine) and nothing on opponents (−0.6%). The pre-set rule asks for a team-level win on the opponent holdout too; that metric is the weakest in this study (it covers only heavily sampled leaders, whose true scores are nearly alike, so even the baseline's explained share swings between 0.49 and 0.67 across folds), so a rule built on the opponent holdout's per-fixture log loss would have passed nine epochs on folds 0 and 1. That is a different rule from the one fixed before the runs; it is recorded here as the reason the full-scale audit is worth running, not as grounds for changing the default.
- The earlier finding that six epochs beat ten at team level (pilot, 12,000-fixture cap) is not contradicted: at a 24,000-fixture cap nine epochs is no longer worse at team level on average, and at the production cap it is better per fixture everywhere it was measured. A decision on width or epochs belongs to the full-scale audit below, with all five folds.

## What this does and does not show

- Held-out candidates are held out by canonical identity, not by species or moveset family, so a held-out team usually has close relatives in the fitted set. A stricter holdout (by species set) would be harsher; none was run.
- Opponent identities are hashed, but the observed meta repeats a few hundred teams thousands of times; a held-out identity may be a heavily repeated observed team. The held-out share of fixtures ranges from 19% to 21% (candidates) and 18% to 21% (opponents) across folds.
- The noise floor assumes a team's fixtures are independent draws from one distribution. The first 8 fixtures of a batch are shared by the teams in it, which does not change one team's variance of its own mean. The ratio "explained share" is unstable when the true between-team variance is small (the opponent and block designs, sd up to 0.23).
- The labels are the fixtures the search itself chose to simulate (strong teams get 64 fixtures, half the teams have 8), so held-out teams are not a random sample of candidate space.
- Four-member ensembles and 24,000-fixture fits are smaller than production (12 and 48,000). Three seeds cannot detect team-level effects under about 3 to 4% (the baseline's seed sd on team MSE is 3 to 13% of its value), so a variant could help by less than that without being seen.
- Everything is one search's labels under one controller and meta; policy and meta holdouts (the other part of the gap) need other panels' labels, which this checkpoint does not contain.

## Open items

1. The full-scale audit below, on all five folds, to decide nine epochs (and hidden 32) at the production fit size: 12 models, three seeds, a pooled analysis fixed in advance.
2. A noise-aware calibration inside `search.cjs` (the round's diagnostic could add each held-out team's sample variance; it needs the per-team sum of squared scores in `records`), so the viewer can say "spread plus noise covered 90% at k = 1.8" instead of only the raw multiplier.
3. A species-set holdout, a controller-style holdout (labels from `policyPanel`) and a meta holdout (labels from `sensitivity`).
4. `report.cjs` (report.html, findings.md) does not print the calibration; the portable report and viewer do.

## Commands

The audits above (from `web/`, one at a time, 3 workers, `nice -n 10`; the checkpoint copy and pool are read-only inputs):

```
V="base;h24;h32;l2x3;e9;rank1;rank2;rank4;rank8"
nice -n 10 node training/team-search/audit-model.cjs --checkpoint training/runs/v4-checkpoint-copy.json --pool training/runs/team-search/pool.json --grouping candidate,opponent,block --variants "$V" --cap 24000 --ensemble 4 --epochs 6 --repeats 3 --workers 3 --bootstrap fixture --resample 1 --minTeamFixtures 8 --fold 0 --out training/runs/audit/v4-fold0.json     # and --fold 1
nice -n 10 node training/team-search/audit-model.cjs --v1 includes/pro/data/team-teams --pool training/runs/team-search/pool.json --grouping candidate,opponent,block --variants "$V" --cap 24000 --ensemble 4 --epochs 6 --repeats 3 --workers 3 --bootstrap fixture --resample 1 --minTeamFixtures 4 --fold 0 --out training/runs/audit/v1-fold0.json
nice -n 10 node training/team-search/audit-model.cjs --checkpoint training/runs/v4-checkpoint-copy.json --pool training/runs/team-search/pool.json --saved 1 --repeats 0 --grouping candidate --variants base --minTeamFixtures 1 --referenceOpponents 256 --out training/runs/audit/v4-saved.json
nice -n 10 node training/team-search/audit-model.cjs --checkpoint training/runs/v4-checkpoint-copy.json --pool training/runs/team-search/pool.json --grouping candidate,opponent --variants "base;h32;e9;hidden=32,epochs=9" --cap 48000 --ensemble 4 --epochs 6 --repeats 3 --workers 3 --bootstrap fixture --resample 1 --minTeamFixtures 8 --fold 0 --out training/runs/audit/v4-fold0-cap48000.json
for FOLD in 1 2 3; do nice -n 10 node training/team-search/audit-model.cjs --checkpoint training/runs/v4-checkpoint-copy.json --pool training/runs/team-search/pool.json --grouping candidate,opponent --variants "base;e9" --cap 48000 --ensemble 4 --epochs 6 --repeats 3 --workers 3 --bootstrap fixture --resample 1 --minTeamFixtures 8 --fold $FOLD --out training/runs/audit/v4-fold$FOLD-cap48000.json; done
node training/team-search/audit-model.cjs --print training/runs/audit/v4-fold0.json
```

**Full scale** (12 workers, ensemble 12, cap 48,000, the completed v4 run, from `web/`; roughly 30 to 60 minutes per fold on an idle machine, all folds are independent so they can run one after another):

```
for FOLD in 0 1 2 3 4; do
  node training/team-search/audit-model.cjs --checkpoint training/runs/team-search-v4-observed-2026-10-12/checkpoint.json --pool training/runs/team-search/pool.json --grouping candidate,opponent,block --variants "base;h32;e9;hidden=32,epochs=9;rank4" --cap 48000 --ensemble 12 --epochs 6 --repeats 3 --workers 12 --bootstrap fixture --resample 1 --minTeamFixtures 8 --fold $FOLD --out training/runs/audit/full-fold$FOLD.json
done
node training/team-search/audit-model.cjs --checkpoint training/runs/team-search-v4-observed-2026-10-12/checkpoint.json --pool training/runs/team-search/pool.json --saved 1 --repeats 0 --grouping candidate --variants base --minTeamFixtures 1 --referenceOpponents 256 --out training/runs/audit/full-saved.json
node training/team-search/audit-model.cjs --v1 includes/pro/data/team-teams --pool training/runs/team-search/pool.json --grouping candidate,opponent,block --variants "base;h32;e9;hidden=32,epochs=9;rank4" --cap 48000 --ensemble 12 --epochs 6 --repeats 3 --workers 12 --bootstrap fixture --resample 1 --minTeamFixtures 4 --out training/runs/audit/full-v1.json
```

Read each file with `--print`; the paired improvement lines carry the ✓/✗ rule used above. A variant is promoted only if it clears the rule on the team-level metric of both the candidate and the opponent holdout on every fold (or on a pooled analysis the coordinator pre-registers); otherwise leave the defaults. A run that is interrupted resumes with the same command plus `--resume`.

## Files and shared-file hunks

New: `holdout.cjs`, `calibration.cjs`, and their tests `holdout.test.cjs`, `calibration.test.cjs`, `calibration-viewer.test.cjs`, `search-calibration.test.cjs`. Changed: `audit-model.cjs` and test, `interaction.cjs` and test, `fit-interaction.cjs` (2 lines), `interaction-worker.cjs` (2 lines), README.md (section 2 tools row, section 6, section 11 bullet, section 12 row, section 13 command, section 14 row), README-plain.md (one paragraph), `MODEL_AUDIT.md` (new section), `../../includes/pro/NEURAL_REPORTS.md` (one paragraph).

Hunks in files other agents also edit:

- **`search.cjs`: one hunk**, inside `fit()` in the `diagnostics` object literal, between `heldoutMean:avg,` and `fitSeconds:`: `uncertaintyCalibration:require('./calibration.cjs').calibrationSummary(measured.map(r=>{const p=predict(ownInput(r.team));return {key:teamKey(r.team),predicted:p.mean,spread:p.uncertainty,observed:r.reward/r.games,fixtures:r.fixtures||r.games};})),`. It only adds a field; selection, seeds and every other output are unchanged. Because `algorithmHash` covers `search.cjs`, `interaction.cjs`, `fit-interaction.cjs` and `interaction-worker.cjs`, a run started before this merge cannot be resumed after it (warm-start instead).
- **`neural.js`: one line**, the script cache version `?v=portable-8` becomes `?v=portable-9` (keep the larger number if another change also bumped it).
- **`neural-portable.js`: three small hunks**: `calibrationCaption` and `calibrated` after the `caption` helper; the held-out error chart's `caption(graph(...))` call wrapped as `calibrated(caption(graph(...)),history)`; `calibrationCaption` added to the exported object.
- **`neural-report-core.js`: two small hunks**: four validation lines before `return d;` in `validate`, with `calibrationOk` and `validateCalibration` after it; `validateCalibration` added to the exported object.
- `export-report.cjs`, `report.cjs`, `common.cjs`: **not changed**. The portable report already carries `history` and `diagnostics` as they are; `search-calibration.test.cjs` checks that the field arrives and validates.
