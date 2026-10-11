# Pilot findings · October 9, 2026

These findings describe the frozen bundled Great League snapshot and Champion-controlled simulations. They are preliminary, conditional on the modeled opponents, and do not prove globally optimal composition or human win rates.

## Population and scouting

- Top 300 positive-weight entries by PvPoke default weight, ties resolved by published Overall rank; 215 distinct Pokédex numbers.
- All 12,335 legal moveset combinations scored against the 300 recommended-moveset opponents across five shield/energy scenarios: **18,440,825 single-Pokémon simulations**.
- Up to five variants retained per entry: **1,498 variants**. Recommended combinations were retained for 290 entries, without forcing them into the final five.
- Weighted raw 1v1 scouting slightly favored Galarian Corsola's Astonish / Night Shade / Power Gem (0.49650) over Astonish / Power Gem / Rock Blast (0.49481). These are scouting battle ratings, not normalized PvPoke Overall scores.

## Architecture and selection

The initial network predicting average team scores did not beat a constant predictor. Learning individual mirrored matchup outcomes helped. A scalar-strength comparator improved further when augmented with a learned antisymmetric matrix, allowing cyclic counter relationships.

The full-pool pilot's last held-out diagnostics were:

| Diagnostic | Neural | Constant |
| --- | ---: | ---: |
| Per-fixture mean squared error | 0.13471 | 0.15617 |
| Team expected-score mean squared error | 0.00544 | 0.00791 |

This corresponds to about 14% lower per-fixture error and 31% lower team error. Candidate identities were excluded from fitting; final performance was checked separately. Neural proposals averaged 53–59% in the last four rounds versus 31–39% for uniform exploration on the same opponent batches. This is not an equal-total-compute comparison with every alternative search method.

Fresh screening was necessary: some earlier training leaders dropped sharply on new opponents. The final process therefore screens candidates first, then tests the selected primary and baselines on another set.

## Independent full-pool pilot

The pilot saved 56,640 counted 3v3 battles, 411 labeled teams and 12 completed rounds, including inherited verified evidence. Four screened finalists scored 60–63% on 256 untouched opponent fixtures each, with both sides exchanged.

The screening-selected primary was **Melmetal / Jellicent / Umbreon**, with these moves:

- Thunder Shock / Double Iron Bash / Dynamic Punch
- Hex / Shadow Ball / Surf
- Snarl / Dark Pulse / Last Resort

Its final score was **62.1%** over 512 mirrored battles. It beat two uniform-random baseline teams by 27.8 percentage points (95% paired-fixture interval 22.3–33.3) and two weight-sampled best-moves teams by 22.6 points (16.1–29.0). Those intervals are conditional on the baseline teams and simulator. The final unattended run uses larger screening/testing sets and adds greedy coverage baselines with coordinate swaps.

## Refinements tested

- Six versus ten fit epochs, three ensemble seeds, identical sampled training data: mean held-out team error improved from 0.005534 to 0.005024 (**9.2%**); per-fixture error was slightly worse. Six epochs are now the default because candidate selection uses overall expected team performance.
- Increasing the training fixture cap from 12,000 to 48,000 on 56,640 unique fixtures: three seeds reduced mean unseen-team error from 0.005479 to 0.003827 (**30.1%**), and per-fixture error from 0.13628 to 0.12248 (**10.1%**). The 48,000 cap is retained; that experiment used all 44,704 training fixtures.
- Sampling the bounded fit subset without replacement, then bootstrapping once per ensemble member, reduced mean team error from 0.004732 to 0.004166 (**12.0%**) at a 24,000 cap. All three seeds improved; this sampling change is retained for larger datasets.
- Aligning buff features to charge-energy order made essentially no difference. Adding per-charged-move type indicators worsened mean team error to 0.006261; these changes were not retained.
- Parallel candidate inference on all 12 CPU cores reduced 12,000-candidate scoring from approximately **8.4 seconds to 1.5 seconds**, preserving every prediction exactly.
- Caching compiled simulator scripts did not improve throughput and was reverted.
- Larger heaps/recycling intervals barely changed speed across 512 seeded battles and increased memory; the established 128 MB/eight-battle limits were retained. All seeded outcomes matched across the four configurations.
- Numerical gradient checks, cyclic-counter learning, deterministic worker-count comparisons, exhaustive chunk/cache equivalence, checkpoint interruption/resume, detached deadline shutdown and safe stop were verified.

Completed earlier pilots' evaluations can become training evidence for a new experiment. Their seeds are marked as used and cannot serve as that new experiment's screening or final test. The final launcher selects a fresh validation seed.

## Stronger independent comparison

A separate experiment screened 12 training leaders against 128 new opponent fixtures, then evaluated four finalists and 12 fixed baseline teams against 256 untouched fixtures each, with sides exchanged. The screening-selected primary, **Melmetal / Cramorant / Jumpluff**, scored **62.7%**. Other finalists scored 62.3–65.4%; their final scores did not determine the primary.

| Baseline group (four teams each) | Primary advantage | 95% paired-fixture interval |
| --- | ---: | ---: |
| uniform-random | 31.5 points | 26.5 to 36.4 |
| weight-sampled-best-moves | 12.3 points | 7.1 to 17.3 |
| greedy-scout-coverage | 14.0 points | 8.3 to 19.4 |

These intervals remain conditional on these fixed baseline teams and modeled opponents. The installed larger-sample pipeline also completed screening, testing and all three baseline styles. Its separately selected Melmetal / Jumpluff / Quagsire (Shadow) primary scored 67.6% on another 128-fixture test, not a directly comparable score improvement.
