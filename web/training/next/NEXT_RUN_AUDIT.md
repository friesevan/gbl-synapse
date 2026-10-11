# Next-run audit: evidence, limitations, and a better meta estimate

Audited the completed Desktop trainer checkpoint and its untouched screening/final panels. This document separates findings about the existing experiment from assumptions in the new experimental controller.

## What the completed search demonstrated

- 517,004 total counted battles, including inherited evidence; 374,540 new battles in the final run. 3,453 saved team records, 24 screened, 8 final-tested, and 12 baseline comparisons.
- New-run throughput averaged 22.7 battles/second, with 11.56 CPU cores busy on average across 12 workers. The M2 Max was already substantially utilized; this is CPU simulation, not GPU/Metal training.
- The preselected primary, Melmetal / Jumpluff / Shadow Quagsire, scored **68.31%** on **512 independent opponent fixtures** (1,024 side-swapped v1 battles). Its standard error is 1.59 percentage points; an approximate conditional normal interval is 65.2–71.4%. This quantifies sampling uncertainty under that simulator/meta, not a human GBL win-rate interval.
- It beat the average of four greedy-coverage baseline teams by **17.58 percentage points**, with a paired-fixture bootstrap interval of **14.10–21.06 points**. That comparison is conditional on those four selected baselines. It does not prove neural search beats every alternative optimizer or a carefully hand-built human team.
- Held-out candidate diagnostics: team-average MSE 0.004062 vs constant 0.017338, a **76.6% reduction**. Matchup-level MSE improved **27.7%**. Team prediction RMSE is still **6.37 percentage points**—much larger than a small moveset score difference.
- In the last four rounds, neural proposals averaged **59.50%**, versus **36.60%** for uniform random proposals against each round's common opponent batch. Useful evidence that the surrogate guides search; not an equal-compute comparison of complete search algorithms.
- All eight finalists led Melmetal. That may reflect strength under the chosen population and controller, but concentration is also a reason to test policy/meta sensitivity, not assume the human meta is solved.

### The Cramorant example

Hydro Pump/Surf's 75.0% training score had only 128 games; Dive/Fly's 65.8% score had 1,792. They did not share the same training fixtures. The apparent gain cannot be attributed to the moveset.

On a shared 512-fixture screening panel, Hydro Pump/Surf scored **63.53%**, while Dive/Fly scored **64.60%**. The paired difference was about −1.07 points, with an exploratory normal interval roughly **−4.4 to +2.2 points**. Canonicalizing both backlines in the earlier browser comparison also did not establish a Hydro Pump advantage. The evidence does not support the original conclusion that the water nuke improved this team.

Individual replay examples also showed Surf and Cramorant's form effects contributing while Hydro Pump was never fired. A listed move is not proof it caused a win. Mechanism claims require controlled move substitutions, paired battle seeds/opponents, and event-level differences.

## Changes implemented for the next run

- v2 identity-based side routing, equal base player priority, seeded equal-attack CMP ties, team/state-based AI randomness, and canonical bench order. Neural features and deduplication now share that bench invariance. The lead remains distinct.
- Bounded worst-case switch lookahead over legal opposing stay/switch responses. Current HP, energy, shields, buffs, cooldowns, forms, switch clocks and remaining teammates feed the forecast. The remaining roster contributes a terminal coverage/resource heuristic.
- One canonical simulation per fixture rather than redundant mirrored simulations. Effective sample counts and confidence calculations use the actual fixture count.
- A fresh versioned output directory and mechanics/feature/meta fingerprints. Old simulation labels cannot warm-start this experiment. Expensive unchanged 1v1 scouting data can be reused.
- Configurable popularity concentration, correlated team sampling, optional observed team-frequency import with small-sample shrinkage, and sealed final/screening fixture panels for exact diagnostics.
- Direct Desktop installation and an eight-hour/all-available-cores launcher. The overnight run is ready but has not been started.

### What the new validation actually establishes

Side/bench regression tests and live-state preservation pass, and complete 12-worker smoke searches exercised the full training/evaluation/report pipeline without timeouts.

A 128-fixture controller comparison gave each controller both rosters. Lookahead's win share was **50.8%**, with an approximate interval **45.2–56.3%** across 256 battles and zero timeouts. That is **not evidence of stronger strategy**. It is a useful parity check and an honest reason to keep the new switching policy experimental.

Initial short controller/distribution sensitivity tests also changed the apparent standings of the three example teams. Such small exploratory tests are for debugging and hypothesis generation. They cannot replace sealed final tests, and their seeds must not be reused to claim unbiased improvement after tuning.

## Remaining weaknesses and priorities

| Priority | Limitation | Consequence and next step |
| --- | --- | --- |
| Highest | Opponents are synthetic, not observed GBL team frequencies | The optimizer finds a best response to our assumptions. Obtain recent lead-first joint team observations by cup/rating/date, then shrink sparse frequencies toward a prior. |
| Highest | Full opposing roster/moves are known to the controller | It can make counter-switch decisions unavailable to a human in blind GBL. Add a belief over unrevealed backlines/moves and update it as information arrives. Do not treat hidden Pokémon as revealed. |
| Highest | The network predicts team quality; it does not learn a battle strategy | More team labels optimize against a fixed controller. Train/evaluate an information-limited policy separately, with diverse opponent policies and explicit observations. |
| High | Bounded lookahead, immediate counter-switch responses, heuristic terminal value | Delayed catches, baiting a switch, future alignment and endgames may be misvalued. Add full-roster continuation rollouts, response timing branches and learned terminal values; retain an untouched controller test. |
| High | Champion charge/farm/shield decisions remain heuristic | Energy management and bait/shield interactions can determine wins despite a correct switch choice. Add policy diversity and evaluate against held-out stronger controllers. |
| High | Minimax uses a pessimistic pure response | Opponents need not have an immediate optimal counter-response, and simultaneous decisions may need mixed strategies. Compare worst-case and response-probability-weighted values under realistic beliefs. |
| High | PvPoke weight-1 floor contributes substantial tail probability | 220 entries account for 22.8% of the original initial draw mass. New exponent 1.25 lowers this to 13.1%; this is an adjustable assumption, not measured usage. Test sensitivity rather than declare this exponent correct. |
| High | Correlated prior is still hand-designed | Complement coverage and ABB preferences are only plausible patterns. They neither reproduce real lead/core frequencies nor guarantee strategically coherent teams. Empirical pair/trio counts are better. |
| High | Opponents use recommended movesets only | Alternate-move counters, bait patterns and human variation are absent. Add observed moveset distributions or carefully bounded alternate-moveset stress panels. |
| Medium | Only up to five 1v1-scouted movesets per entry | Exhaustive 1v1 scouting evaluated all 12,335 legal combinations, but retention is based on 1v1 performance; a valuable team-specific move can be excluded. Allow targeted moveset mutation and retest retention on 3v3 synergy. |
| Medium | 300 entries represent 215 distinct Pokédex numbers; pool is fixed | Requested eligibility excludes lower-priority counter-meta species and alternate IV builds. There are about **1.653 billion** legal lead + unordered-bench variant teams inside this pool alone. Only 3,215 canonical identities appear in the old 3,453 records, about 0.00019% of that space. No exhaustive optimality claim is possible. |
| Medium | Training teams have unequal exposure and different opponent panels | A score gap can be opponent noise rather than team quality. Retest contenders on common panels; use paired differences and minimum sample thresholds. |
| Medium | Surrogate error and adaptive selection | Ensemble disagreement is not a calibrated interval. Held-out diagnostic teams come from the same search process/meta; hyperparameter tuning can reuse those diagnostics. Keep candidate, opponent, policy and meta holdouts. |
| Medium | Finalist selection and multiple comparisons | Eight tested finalists have overlapping uncertainty. The preselected primary is the valid primary endpoint; picking the highest final-test score and reporting its interval creates selection optimism. Use a new test for a newly selected winner. |
| Medium | Shared mechanics data / upstream emulator approximations | IV defaults, fast move timing, CMP ties, buffs, forms, switch/catch timing and actual game behavior need dedicated parity fixtures. Canonical slot routing removes caller-order artifacts; it is not proof of perfect in-game fidelity. |
| Medium | Import supports complete lead-first teams only | Unrevealed members and out-of-pool teams cannot be silently dropped; that would introduce survivorship bias. Future ingestion should represent partial observations and uncertainty explicitly. |
| Medium | Compute tradeoff | Lookahead costs more per battle. Removing redundant mirrored battles offsets part of this. Adapt evaluation reserves to measured throughput; do not sacrifice final validation for additional proposals. |
| Integration | Historical browser runtime is v1 | Keep old report replays exact. v2 results need the new controller in the browser before publishing interactive v2 battle graphs. |

## Can actual usage be retrieved?

**Crowdsourced actual GBL observations exist. A comprehensive official public team-usage API was not verified.** Public rank/leaderboard data is not team usage, and Game Master/Battle League API endpoints describe game settings rather than actual opponent rosters.

- [GO Battle Log guide](https://gobattlelog.com/guide): users record opposing teams; the product provides usage, lead/backline charts and rating/cup selections. This is the most directly relevant source found. Authorized exports or an agreed data feed would allow joint frequencies. I did not verify a documented public bulk API or obtain private data.
- [holoholo GBL Usage](https://holoholo.gg/en/usage): the public page states it aggregates real opponent observations from GO Battle Log and currently reports 1,073 logged Great League battles. It provides individual usage and common builds. Its sourcing is a publisher claim; rating/date sampling, duplication and representativeness still require checking. Individual marginal usage cannot recover which Pokémon occurred together on teams.
- [PvPoke Training Analysis](https://pvpoke.com/train/analysis/): team usage and CSV exports exist, but the site's own documentation identifies player **and bot** website-training battles. Useful as a composition prior or controller benchmark; not measured live GBL usage.
- [Dracoviz](https://www.dracoviz.com/): competitive tournament rosters/usage are another source. Show-six/bring-three tournament composition is a different decision problem from blind three-member GBL; do not merge it unmarked into GBL frequencies.

The strongest practical route is a recent, authorized GO Battle Log export or your own logged opposing teams. Use **appearance counts**, not winning-team counts. Record cup, date, rating bracket, known lead, revealed members, and observed moves. Distinguish inferred recommended moves from actually observed moves.

## Better meta prediction when data is sparse

1. Estimate `P(lead, unordered backline, moves | cup, date, rating)` rather than multiplying individual species weights. Preserve correlated cores and lead preferences.
2. Decay older observations, stratify by rating/cup, and shrink sparse joint frequencies toward a mixture of measured marginal popularity and plausible cores. A source's userbase and incomplete-team recording can bias the estimate.
3. Use PvPoke ranks/weights as a **prior**, not as usage truth. Calibrate concentration and core preferences on an independent observed sample when available.
4. Evaluate candidate teams across several plausible metas and human-policy styles; show scenario scores and uncertainty. An eventual objective can balance average win rate with lower-tail performance across these scenarios, rather than optimize one precise synthetic distribution.
5. Seal fresh observation/test panels before choosing finalists. Test across dates or rating brackets to expose distribution shift. More training is less valuable than correcting a systematically wrong target population.

The code implements a first correlated/shrunk prior and observed-frequency ingestion. Belief-state strategy, recency/reporter correction, alternate opponent movesets, robust multi-meta optimization and automatic data feeds remain future work. They are documented limitations, not silently represented as completed features.
