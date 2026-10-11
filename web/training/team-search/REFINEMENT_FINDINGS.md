# Search acquisition refinement · October 10, 2026

## Why change the optimizer?

The completed v3 experiment showed that its neural surrogate guided proposals better than uniform sampling, but round averages plateaued. Proposal averages are not the best-so-far frontier; a flat curve alone does not prove convergence or failure. The held-out expected-score RMSE at the end was about 7.4 percentage points, large enough to misorder small moveset differences. All finalists' uncertainty also overlaps for some pairwise comparisons.

One actionable inefficiency: across 154 rounds, the 918 pure-disagreement proposals averaged **37.43%**, close to the 918 random proposals' **34.04%**. Neural exploitation proposals averaged **60.49%**. Maximizing uncertainty alone often spends expensive full-team simulations on confidently weak regions with noisy predictions.

## Retrospective diagnostic

Source: `training/runs/team-search-v3-refined-20261010/checkpoint.json`; checkpoint digest `81bf90cd8b90bd7827ff3a603fa9f6fd015955057e26abda663f99bdaa50f921`.

The final fitted ensemble was evaluated on all **757 candidate identities excluded from fitting**. In 100 deterministic overlapping subsets of 200 teams, remove the top 11 neural-mean picks, then compare the next six exploration picks:

| Priority | Mean historical observed score |
| --- | ---: |
| Ensemble disagreement alone | 32.93% |
| Predicted mean + disagreement | 59.95% |

This is a retrospective acquisition diagnostic. Historical outcomes have unequal sample sizes and different opponent panels. Subsets overlap; they are not 100 independent experiments. No statistical significance or new best-team claim is made from this check.

Reproduce with `audit-exploration.cjs --checkpoint FILE --pool FILE --out FILE`. It preserves source files and uses the documented old candidate holdout. It supports the frozen v5 synthetic-meta model only.

## Fresh paired simulation benchmark

Both strategies scored the **same 12,000 unseen candidate teams** with the frozen final model. Both removed the same top neural picks before selecting six exploration candidates. Local-neighborhood generation was disabled for this test, isolating the acquisition priority change. All selections were frozen before a fresh 128-opponent panel was generated (seed 20261012, fixture panel seed 21161013). The two groups had no overlapping selected identities: **12 teams, 1,536 canonical full-team battles**, 12 CPU workers, unchanged lookahead horizon/interval, unchanged simulator fingerprint.

| Exploration batch | Mean score against identical opponents |
| --- | ---: |
| Disagreement alone | 35.42% |
| Predicted mean + disagreement | 54.23% |
| Paired improvement | **18.82 percentage points** |

Approximate paired-fixture 95% interval: **13.57 to 24.06 points**. Each observation is the difference of the two six-team group averages against one identical opponent fixture. This is conditional on these fixed candidate batches, the fitted model, synthetic meta, and controller. It establishes a useful improvement in this acquisition example; it does not establish an equal-compute advantage of a complete new search or a human win rate.

Reproduce with `benchmark-acquisition.cjs --checkpoint FILE --pool FILE --out FILE`. It does not edit the source checkpoint or feed benchmark outcomes into the network. Its already-used seed must not be reused as independent confirmation after further tuning.

## Changes retained

1. Promising exploration ranks by `predicted mean + ensemble SD`. SD is a heuristic priority bonus, not a calibrated upper confidence bound. Neural, exploration and uniform-random allocations are preserved.
2. Enumerate unseen single-member retained-moveset changes and alternative leads around eight incumbents before filling the candidate pool with random mutations/fresh teams. This is an exhaustive local neighborhood, not exhaustive global search. Tests verify all 12 alternative movesets and two lead changes when each member has five variants. It only guarantees their inclusion in inference, not that each gets a simulation slot.
3. Retest the leader every third round; rotate other retests among the next seven contenders. This distributes exposure instead of repeatedly reinforcing only the current leader. Ranks can change, so this is not a guaranteed fixed-panel evaluation of each contender.
4. Export acquisition provenance in portable reports and use a new default output directory. Old reports and mechanics remain intact. Compatible v3 raw evidence can warm-start the new optimizer after old evaluations are marked as used.

The local-neighborhood and retest changes passed regression and pipeline tests; their independent contribution to final team quality has not been measured. A new full search with sealed final tests is required to assess the combined patch.

## Verification

- All 57 team-search tests passed, including neural gradient checks, cyclic-counter behavior, worker parity, checkpoint/evaluation logic and replay parity. New tests cover acquisition priority, exhaustive local neighborhoods and rotating retests.
- A two-round live search smoke test completed screening and final testing, exported a portable UI report, and recorded the new search settings. Tiny smoke-test scores are correctness checks, not accuracy evidence.
- No controller, game-data, eligible population, 1v1 scouting or neural architecture change. Mechanics hash remains `31b4a52b7983e83d4d8f40132066cc26fd0ed954c1397d53f7eb61c6ec717c75`. Existing v3 raw battles remain compatible; exact resume requires the original optimizer code.

## What matters next

The largest unresolved issue is the target distribution: this remains a best-response search against synthetic PvPoke-derived teams. A better acquisition rule cannot correct inaccurate usage assumptions. Obtain observed lead/backline/moves frequencies, evaluate plausible-meta sensitivity, and test diverse information-limited opponent policies. Then consider targeted moves outside the retained five and alternative IV builds. Larger neural layers or more hours should be accepted only after held-out prediction and independent team-selection tests improve, not merely because training loss falls.
