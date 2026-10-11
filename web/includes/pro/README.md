# PvPoke Pro — ranking logic README

This guide describes the third tab of PvP IV Pro. It documents the code currently shipped, rather than an idealized ranking algorithm. It is also available as a plain Markdown file for AI tools.

## 1. Three different kinds of result

| Result | Inputs and scoring |
| --- | --- |
| Published PvPoke | Exact bundled upstream rankings, with stored editor adjustments. No battles run. |
| Generated custom roster | Every selected Pokémon × selected moveset, versus one recommended moveset per accepted opponent species, across five scenarios. Relative category scores, consistency and overall formula; no editor blend. |
| Moveset Lab subtab | One selected Pokémon's combinations versus the same accepted species roster, in one equal-shield scenario. Weighted mean raw Battle Rating, not Overall. |

Rankings and Moveset Lab are separate subtabs inside PvPoke Pro. League and Include roster controls are shared; the lab has its own Pokémon selector. Selecting a ranking row shows details for that exact variant and can open that species in the lab. Published and generated results remain separate. An overall score of 94 is not a 94% win rate. The first tab's IV stat-product ranks are unrelated to these battle-performance scores.

## 2. Source, data, and reproducibility

All vendor code and bundled data use PvPoke commit `f627e89e53c0c7b903fff097df7a0ad0ac95decc`. The upstream engine and ranker files are copied unchanged and licensed under MIT. The adapter is our code. This is a snapshot, not a live fetch from pvpoke.com, so later changes on that website will not automatically appear here.

- [Pinned PvPoke source](https://github.com/pvpoke/pvpoke/tree/f627e89e53c0c7b903fff097df7a0ad0ac95decc)
- [Browser adapter](worker.js): worker setup, generation, moveset simulation, and output capture.
- [Interface](ui.js): accepted roster, weights, filters, state invalidation, and presentation.
- [Validation and combination helpers](core.js).
- [Game master data](data/gamemaster.json): species, base stats, types, moves, default IVs, release flags, forms, cups, and scenarios.
- League bundles: [500 CP](data/league-500.json), [1500 CP](data/league-1500.json), [2500 CP](data/league-2500.json), [Master](data/league-10000.json). Each contains overall, leads, closers, switches, chargers, and attackers arrays.
- Override bundles: [500 CP](data/overrides-500.json), [1500 CP](data/overrides-1500.json), [2500 CP](data/overrides-2500.json), [Master](data/overrides-10000.json).
- [MIT license](vendor/LICENSE).

The Master league uses `10000` as the engine's unlimited-league identifier. Current UI choices are the four open leagues; themed cup rules and custom IV entry are not exposed on this tab.

## 3. Published mode and result identity

Selecting a league loads its bundled arrays. Published mode performs no battles and preserves upstream ranking positions and stored values. Search matches name, type or moves; sorting changes display order; 25 rows are displayed per page. Published scores match the snapshot even when regeneration would depend on curation/settings not used here.

Generated results have unique `variantId = speciesId + "|" + moveset.join("|")`. Distinct combinations for one species occupy separate rows and retain their own score, projection, matchups, and category scores. The table can show every evaluated combination or only the highest-scoring row per species in the selected category. That checkbox is a display filter and never changes simulations. Rank remains the position in the complete selected category array. Ties use variant ID order for deterministic display; best-per-species shows one of tied rows, while the lab's best-only filter includes ties.

## 4. Consolidated Include filters and weights

A shared roster editor exposes all nine Include filter types from PvPoke Custom Rankings: Type (including Mono-type), Tag, Species, Pokédex Number, Move, Move Type, Charged Move Cost, Buddy Walk Distance, and Evolution stage. Types/tags/costs/distances/stages use selectable options; Species and Move use comma-separated IDs with suggestions; Pokédex accepts inclusive ranges such as `1-151, 252-386` or single numbers.

The app sends these filters to the unchanged `GameMaster.generateFilteredPokemonList` in a worker, rather than reimplementing tag/move/evolution semantics. Values within a filter are alternatives. Include filters combine as upstream criteria, with explicit Species IDs overriding other Include criteria. Move and Move Type filters test learnable move pools, not the movesets that will be ranked. Hidden Power does not satisfy the upstream Move Type filter. No Include rules means all eligible Pokémon in the bundled published league population. **Create custom rankings** opens a filter-only builder. Type is expanded with every option selected initially, with Select all / Deselect all controls. The dense searchable preview shows the entire published population; clicking a Pokémon adds an explicit Species inclusion or exclusion. Empty Species inclusion lists add no Include constraint. Explicit exclusions are applied by exact species ID after upstream filtering, so excluding a Shadow does not exclude its ordinary form.

The app intersects upstream eligibility with the published population so every opponent has a recommended moveset. It does not expose an Exclude builder or import Pokebox groups. The `custom` cup uses `includeLowStatProduct: true` and `excludeLowPokemon: false`; release flags, low-CP bans, duplicate-form rules and Little Cup Shadow level restrictions remain upstream. The catalog's ordinary minimum stat-product thresholds (0 / 1370 / 2800 / 4900 by league) are bypassed. Species that exist in gamemaster but not the published population cannot be added as opponents in this version.

Weights offer **Default**, **Equal**, and **Calculate**. Default uses bundled PvPoke override weights, preserving zero; missing or invalid weights use 1. Equal assigns every accepted opponent weight 1. A zero-weight Pokémon is still ranked as a candidate but contributes no opponent score. Weights must be finite, from 0 to 1000; at least two accepted species must have positive weights to avoid an empty non-mirror opponent population. A weight changes importance as an opponent, not a direct bonus to its own score. Filters apply asynchronously; generation remains disabled while pending or invalid.

Movesets offer **Recommended** (one published combination) or **Multiple**, with a configurable maximum per Pokémon. Multiple uses the scouted top-N method below and retains the recommended combination within that maximum. The selection explanation opens from an info icon in a dialog.

## 4a. Calculated meta weights

Calculate is a **performance-based estimate**, not measured usage. Stronger Pokémon tend to be more relevant, but simulations cannot infer availability, popularity, team synergy, tournament trends, or player preferences. The default hybrid preserves curated PvPoke guidance while shrinking the many floor-weight opponents. Similarity to curated weights is a design goal; it is not validation against real usage.

**Scope and battles.** Every accepted species uses its bundled overall recommended moveset. Build a full recommended-versus-recommended matrix in all five scenarios, with default league IVs and the same engine/starting-energy rules as the ranking run. No opponent sampling and no alternate-moveset inflation are used. `U[i,j]` is the arithmetic mean of the five **raw** Battle Ratings divided by 1000. Weight estimation assigns the self-species diagonal a fixed neutral 0.5, rather than simulating or rewarding a mirror; final ranking scores still exclude mirrors. Raw BR is used here so shield bonuses, category normalization and consistency do not create an extra usage multiplier.

**Tapered prior.** For each selected species, let `b` be its finite bundled override weight from 0 to 1000 (missing/invalid defaults to 1), and `r` its published Overall score divided by the best accepted published score:

```
a[i] = max(0.000001, b[i])                         if b[i] > 1
a[i] = max(0.000001, max(b[i], 0.001) × r[i]^20)  otherwise
p[i] = a[i] / sum(a)
```

This preserves curated priorities above 1 while reducing the published 0–1 floor according to strength. A published zero is a tiny prior in Calculate, not a permanent ban. Default mode continues to preserve an actual zero. The prior is normalized within the current roster; Pokémon outside that roster contribute no mass.

**Dynamic response.** Set PvPoke guidance `g` to 0.75 by default; the UI permits 0 through 1. Set temperature `T` to 0.035 (35 BR points). Against the current opponent distribution:

```
s[i] = sum_j(U[i,j] × p[j])
logit[i] = g × log(a[i]) + (1 - g) × s[i] / T
q = softmax(logit)
q = normalize(max(q[i], max(q) × 0.000001))
```

At 0% guidance, only simulated performance drives the response; at 100%, the tapered PvPoke prior does. Softmax expresses relative strength without a hard eligibility cutoff. The tiny relative floor prevents exact zero or a dead-end meta while limiting the aggregate floor mass. The temperature is a model assumption, not a calibrated usage probability.

**Stability.** Updates begin with damping `d = 0.4`. First compute a look-ahead distribution `(1-d) × p + d × q`, then evaluate its response `qLookahead` and update `p = (1-d) × p + d × qLookahead`. If the L1 fixed-point residual increases by more than 1%, halve damping, down to 0.01. The look-ahead step reduces counter/counter-counter oscillation. Stop when the residual is below 0.000001 or after 300 updates. Recompute the residual against the final distribution. If convergence is not achieved, retain the finite final estimate and explicitly label the iteration limit; never silently claim stability. This is not guaranteed to have a unique solution or converge for every performance-only matchup cycle.

**Final weights.** Scale the largest weight to the greatest valid bundled override weight, with a minimum scale of 1: `weight[i] = peak × p[i] / max(p)`. Scaling changes display units, not relative influence. Fractions are retained at full precision in simulations and saved reports; preview formatting does not round the underlying weights. Effective opponents is `1 / sum(p[i]^2)`. The preview also reports the weight range and total mass assigned to the bottom half of the accepted population.

**Ranking integration.** Generate automatically calculates stale weights before selecting movesets. Its recommended-moveset battle records are reused by final ranking/scouting in that same worker run. A separate Calculate weights action allows inspection first; a later generation reuses those weights, but its battle cache starts a new run. Calculate then freezes its explicit opponent weights for scoring and disables the existing seven-pass opponent **meta multiplier**, avoiding double weighting. Existing score curves/passes, Switch hard-loss penalty, shield bonuses, Charger factor, normalization and Overall aggregation remain unchanged. Default and Equal retain their existing scoring behavior. Normalized scores from different modes are not directly interchangeable.

**Lifecycle.** Changing the league, accepted species, or guidance invalidates the weight estimate; moveset limits do not, because weights use recommendations only. Cancel terminates the worker. Reports save exact opponent weights in `_targets` plus model version, guidance, temperature, convergence status, scenario list, per-species shares/performance and summary metrics in `_weightModel`. An already-saved report retains its original weights; rebuilding creates a new calculation.

**Validation.** The pinned Great League top-500 recommended battle matrix, at 75% guidance, converged in 26 updates. The published 0–1 weight group dropped from 35.9% of the input weight mass to 11.0%; the bottom half of the roster had 2.9% of estimated mass. Minimum weight was approximately 0.00174, maximum 40. Cosine similarity to the curated weight vector was 0.966, with 17 of its top 20 weighted species retained. These are resemblance/concentration measurements, not usage accuracy. This controlled comparison still ranked Corsola’s Rock Blast set above Night Shade in Overall; the method was not tuned to force a particular moveset to win.

Additional independent top-100 runs converged in Little, Great, Ultra and Master. Similarity to published input weights was 0.976 in Great, 0.979 in Ultra and 0.973 in Master. Little’s top-100 input weights were all 1, so its performance-weighted result intentionally differs from that flat baseline (similarity 0.388); a top-20 overlap is not informative with such ties. Run `node scripts/benchmark-weights.cjs 100` to reproduce these smaller runs. Tests in `pro.weights.test.cjs` cover fractional tails, deterministic/permutation-invariant results, neutral mirrors, counter sensitivity, cyclic cases, explicit unfinished estimates, frozen category weights, exact saved targets and baseline cache reuse.

## 5. Pokémon initialization, combinations and projection

The unchanged `Pokemon.initialize` uses gamemaster default IVs/levels for the league; Master normally uses 15/15/15 at the applicable cap. The normal level cap is 50 with upstream form-specific exceptions. These defaults do not come from the IV entries in the first tab. Effective Attack and Defense are CPM × (base stat + IV); HP is floored with a minimum of 10, plus the upstream Shedinja exception. Shadows, buffs, forms and special move mechanics remain in the engine.

Each accepted species' actual engine pools are enumerated: every fast move × each unordered pair of distinct ordinary charged moves, with supported extra charged choices. For F fast and C ordinary charged moves, this is `F × C × (C - 1) / 2` when C ≥ 2. One charged move uses a second `none`; extra choices multiply the pairs where supported. Available Elite TM, legacy, Return/Frustration and form-specific pools are inherited. Charged order permutations are not tested separately. A species with no usable combination produces an explicit error.

Recommended is the UI default and retains only the published combination. Multiple uses scouted top N, with a shared maximum from 1 to 10,000 applied independently per species. The worker also retains an all-combinations mode for benchmarks and programmatic callers. The selection pipeline is:

- Compute the cheap type-aware damage/energy cycle proxy below for every legal combination.
- For each limited species, retain up to `min(10000, max(32, 4 × N))` proxy leaders as a shortlist, and ensure its published recommended combination is also present. Species with no limit retain all combinations.
- If any species still needs pruning, choose up to eight recommended opponent species greedily by `enteredWeight × (1 + numberOfNewDefensiveTypes)`. Ties follow roster order. This balances user weights with type coverage. Use all opponents when there are at most eight.
- Run the real upstream combat engine on the shortlisted candidates against that scout sample in all five ranking scenarios. This directly models fast energy generation, fast/charged damage, charged costs, shields, timing, bait heuristics and supported effects. It is not an arbitrary linear blend of damage and energy.
- Compute scout category/consistency/overall scores with the same rectangular scoring formula as the final run, but using the scout target population and its recommended baselines. Rank candidates by this scout score.
- Retain N combinations per limited species, reserving one slot for its published recommendation. If that recommendation is below the cutoff, it replaces the last selected row; N remains the total limit. At N = 1, only the recommendation is retained and unnecessary scouting is skipped. Recommended charged pairs use canonical unordered comparison; upstream special recommendations are preserved as baseline records.
- Run the retained candidates against the entire recommended opponent roster, reusing every matching scout battle from the cache. Scout scores select candidates; final scores determine the displayed ranks.

The protected recommendation is a safeguard, not evidence that the heuristic predicted it correctly. Top N can still miss the full-roster best moveset. All mode is the exhaustive option. Equal projection/scout scores are broken by stable variant ID. The benchmark below measures exact-best retention and near-best losses explicitly.

The cheap first-stage proxy for a fast/charged move against opponent j is:

```
k = ceil(chargedEnergy / fastEnergyGain)
cycleDPT = (k × fastDamage + chargedDamage) / (k × fastTurns)
```

Fast/charged damage uses upstream DamageCalculator with initialized default stats, STAB, typing, Shadow and form modifiers. A combination uses the best of its charged-cycle values and fast-only DPT per opponent. A zero-energy-gain fast move uses fast-only DPT. Its projection is the entered-weight average across accepted recommended opponents, excluding its own species. Thus energy generation and charged cost already affect the proxy, but it ignores shielding/bait timing and can overvalue slow, expensive attacks. It is used for a generous shortlist only, rather than the final N. The Scout stage resolves that weakness with real battles.

The table labels the cheap value as Cycle damage/turn and, when scouting ran, shows Scout score out of 100 separately from the final score. The scout score is an estimate from a smaller meta, not a calibrated win probability or a guarantee.

Opponents always use the bundled overall recommended moveset. One species with 100 candidate variants still contributes exactly one opponent and one weight. A recommended baseline is computed even when an individual combination was not originally enumerated; baseline records and matches are reused where possible. Candidate count never inflates opponent meta relevance.

## 6. Five ranking scenarios and rectangular battles

| Category | Subject shields | Opponent shields | Subject energy advantage | Opponent energy advantage |
| --- | --- | --- | --- | --- |
| Leads | 1 | 1 | 0 turns | 0 turns |
| Closers | 0 | 0 | 0 turns | 0 turns |
| Switches | 1 | 1 | 4 turns | 0 turns |
| Chargers | 1 | 1 | 6 turns | 0 turns |
| Attackers | 0 | 1 | 0 turns | 0 turns |

The scenarios come from the pinned gamemaster. Each variant starts at full HP against each other accepted species' recommended moveset. A nonzero t turns of advantage gives `min(100, fastEnergyGain × max(1, floor(t × 500 / fastCooldown)))` starting energy. A turn is 500 ms; no prior damage is assigned for those imaginary fast moves. Opponent starting energy is zero in all shipped scenarios.

This is a rectangular candidate × recommended-opponent matrix, not variant × variant. Self-species cells are assigned a neutral raw/adjusted 500 without a battle; their final scoring weight is zero. They remain 500 in the initial baseline average. Recommended baseline records are shared with selected candidates where possible. Each other record/opponent/scenario pair is simulated once. The UI reports actual simulated battle count and selected versus available combinations. There is no blanket reverse-match reuse, since a candidate can differ from the recommended moveset on the other side.

## 7. What happens inside a battle

[Battle.js](vendor/Battle.js) advances the upstream turn simulation until a Pokémon faints (default battle-end mode), or until the elapsed simulation time exceeds 240,000 milliseconds. It resolves fast-move timing and energy, charged-move spending, shields, simultaneous actions and charged-move priority, buffs/debuffs, and supported form mechanics. There is no sampled tournament, human-play dataset, or actual three-Pokémon team battle in this calculation.

[ActionLogic.js](vendor/ActionLogic.js) makes the action decisions. It considers available charged moves, projected survival, opponent energy, fast-move knockouts, charged-move knockouts, shield baiting, self debuffs, and move timing. Pokémon defaults include selective shield baiting; the adapter does not override those tactical settings. These heuristics are part of the result, not a proof of optimal play. For complete branch-by-branch behavior, the linked shipped source is authoritative.

[DamageCalculator.js](vendor/DamageCalculator.js) normally computes:

```
damage = floor(power × STAB × effectiveAttack / effectiveDefense
               × typeEffectiveness × chargeMultiplier × megaMultiplier
               × 0.5 × battleBonus) + 1
```

`battleBonus` is approximately 1.3; STAB approximately 1.2; a type weakness approximately 1.6, resistance 0.625, and an immunity-style double resistance 0.390625. Dual-type multipliers multiply. Effective stats include stat stages and applicable Shadow effects. The file includes exact floating-point constants, percentage-of-max-HP damage, and form-specific exceptions; the approximation above is not a replacement for those branches.

The default simulation buff modifier is -1. Guaranteed effects still apply. For chance effects with a buff-application meter, the engine increments that meter by the activation probability and applies the effect when it crosses an integer. Other sandbox/forced/random branches remain upstream behavior. The adapter does not run Monte Carlo repeats or estimate confidence intervals.

## 8. Raw Battle Rating and shield adjustment

After a battle, each side's raw Battle Rating is:

```
H = remainingHP / startingMaxHP
D = (opponentStartingMaxHP - opponentRemainingHP) / opponentStartingMaxHP
BR = floor(500 × (H + D))
```

Raw BR ranges from 0 to 1000: above 500 indicates a win, below 500 a loss, and 500 a tie. For example, a winner retaining half its HP has BR 750. This is the rating displayed for individual key matchups and used directly by the moveset lab.

The category ranker then rewards the winning side for shields burned and retained:

```
adjustedBR = BR + winnerFlag × 100 × (opponentShieldsSpent + ownShieldsRemaining)
```

`winnerFlag` is 1 only for the winner determined by comparing the two raw ratings; both flags are zero for a 500 tie. This adjusted number can exceed 1000 before later score curves. It is an intermediate scoring value, not the raw matchup rating shown to users.

The initial category score S[i,0] is the floored arithmetic average of adjusted ratings across the target count, including the mirror at this initial stage. Later passes assign the mirror zero weight.

## 9. Category scoring against a fixed opponent population

The variant adapter in `worker.js` and pure `core.js` extends the PvPoke scoring design to a rectangular population. It does not call the original square-population Ranker directly. The unchanged vendor Ranker remains available as a reference. This distinction prevents variants from inflating opponent weights or breaking upstream index assumptions.

For each scenario, simulate the N recommended baseline records and selected candidate records against the same N recommended targets. The initial baseline S[j,0] is its floored arithmetic mean adjusted BR, including a neutral 500 self cell. Across seven passes n = 0..6, set B to the highest previous recommended-baseline score and c = 0.1 + 0.06n:

```
metaWeight[j] = max(S[j,n] / B - c, 0)^1.65
weight[i,j] = metaWeight[j] × enteredOpponentWeight[j]
weight[i,j] = 0 when subject and target species IDs match
```

Each pass scores both the candidates and the recommended baselines using those same previous-baseline meta weights. The new baseline scores feed the next pass. Candidate variants never enter the opponent population or influence these baseline meta weights. Adding duplicate candidate records therefore cannot inflate a species' importance. Category normalization still depends on the best selected candidate.

The adjusted matchup value a is curved each pass, following the existing custom path's repeated in-place curvature:

```
if a > 700: a = 700 + sqrt(a - 700)
if a < 300: a = 300^((300 + a) / 600)
if category is Switches and a < 500:
    weight *= 1 + (500 - a)^2 / 20000
nextScore = floor(sum(a × weight) / sum(weight))
```

Candidate and baseline curves use separate copies so sharing a recommended record does not apply a curve twice in one pass. If a subject has zero total non-mirror meta weight, that row/pass falls back to the entered non-mirror opponent weights; the UI reports the number of such fallback rows/passes. This explicitly prevents zero-denominator scores in small/degenerate metas. The fallback does not reapply the Switch loss multiplier. Otherwise weights retain the normal Switch penalty.

After the seventh pass, Chargers also applies the upstream fast-pressure/carryover factor:

```
fastDPT = fastPower × STAB × ShadowAttackMultiplier × (Attack / 100) / fastTurns
carryover = 100 - minimum(activeChargedEnergy)
chargerFactor = ((carryover / 100)^(1/2) × (fastDPT / 5)^(1/6))^(1/6)
```

Each category is normalized across its selected candidate rows:

```
categoryScore = floor(1000 × finalCandidateScore / highestCandidateScore) / 10
```

Each category's best candidate has 100. A non-positive/non-finite category leader produces an explicit error. Changing roster, weights or selected movesets can change normalized scores; compare within one generated report. Generated scoring is a documented extension of PvPoke, not a claim of identical regeneration of its published square-population results.

## 10. Key wins and counters

Generated category rows retain every non-self opponent’s raw Battle Rating and shield-adjusted rating in `matches`. The report retains its opponent IDs, recommended movesets and input weights in `_targets`, including when saved. The older five-entry `matchups`/`counters` fields remain for compatibility, but the detail UI uses the complete list. Wins sort by descending raw BR, losses by ascending BR, and exact 500 ties have their own group. The Overall detail selector can show any of the five constituent scenarios; it never presents Lead BR as the Overall score. Category scoring additionally applies shield bonuses, iterative meta weights, curves, normalization and category factors as described above.

Published ranking files do not contain complete battle records. Their detail lists are reconstructed on demand against all published overall opponents, using their recommended movesets, the bundled engine, default IVs and the selected scenario. The UI labels these as reconstructed results; they do not reproduce editor adjustments or claim to be original published records. Older saved reports without `_targets`/full matches reconstruct against their saved species population and explicitly report that historical weights were not retained. Regenerate and save to retain complete original data.

Clicking an opponent starts a separate cancellable worker battle and opens a right sidebar. It uses the selected candidate moveset, the report’s opponent moveset, full HP, default IVs and the same scenario initialization as ranking: Leads 1–1 shields, Closers 0–0, Switches 1–1 with four turns’ fast energy, Chargers 1–1 with six turns’ fast energy, Attackers 0–1. The graph accumulates actual damage from upstream fast/charged timeline events. Its x-axis is battle turns (half-second turns excluding charged animations), y-axis is remaining HP percentage; charged attacks have labeled hover markers. The sidebar includes HP, IVs, level, shields and an expandable charged-attack/shield event list. It does not navigate away or provide playback controls.

Pokémon type chips and move chips use type colors. Move cards are generated from actual engine pools, including legal special moves. Power/DPT/DPE include STAB and Shadow attack multipliers, before matchup-specific defense and effectiveness. Cards show energy generation/cost, fast duration, archetype, buffs, selected/recommended indicators and Elite/legacy status. Charged counts carry residual energy forward from zero using the selected fast move, with a 100-energy cap. These are timing references; damage in the battle graph comes directly from the simulator.

## 11. Consistency score

[Pokemon.calculateConsistency](vendor/Pokemon.js) is a moveset heuristic rather than another set of battles. It estimates reliance on shield baiting and chance effects.

- Start with a factor of 1. Set fast/charged damage to power × STAB.
- If there are multiple charged moves, consider both neutral; if their first two types differ, also consider either one resisted at 0.625.
- Recompute charged damage per energy for each effectiveness scenario; sort by efficiency. An extra charged move gets the resistance factor of a matching first/second type, otherwise neutral. Power-Up Punch's efficiency gets its special doubling branch when it is the least efficient move.
- Calculate a cycle using `ceil(bestChargedEnergy / fastEnergyGain)` fast moves, their damage, and the best charged move's damage. The source applies its fast-type effectiveness adjustment after constructing total cycle damage; this order is preserved.
- Apply a bait-dependence factor when the most efficient move costs more than the alternative, when equal-cost Acid Spray acts as the alternative, or when the self-debuff branches apply. The factor combines the cycle's fast damage fraction with the alternate/best charged efficiency ratio. Close energy costs partially soften the penalty, with a separate self-buffing branch.
- For each charged move with a chance effect greater than 15% but below 100%, derive `buffConsistency = 0.5 + abs(0.5 - chance)`, `stages = abs(buffAtk) + abs(buffDef)`, and `buffsAsDamage = damage + stages × 25 × (1 - buffConsistency)`. Its factor is `damage / buffsAsDamage`; other charged moves contribute 1. Average these factors across charged moves.
- Multiply the bait and chance factors across effectiveness scenarios, then take their geometric mean.
- Multiply by 0.85 for Power-Up Punch and separately 0.85 for Lunge; multiply by 0.75 for Feather Dance and separately 0.75 for Bubble Beam, if present.
- Return `round(consistency × 1000) / 10`. The commented-out fast-duration penalty does not execute.

The full bait-condition expression and energy corrections are in the linked `calculateConsistency` method. This guide provides the calculation flow; that method is the exact executable definition, including precedence and special cases.

## 12. Overall score

[core.js](core.js) applies the combination formula from [RankerOverall.js](vendor/RankerOverall.js) to the five normalized category scores and consistency C. Generated categories align by variant ID; the original ranker aligned by species name. Let L, K, S, G, A mean Lead, Closer, Switch, Charger, and Attacker scores respectively. Form four values and sort descending:

```
q = descendingSort([L, K, max(S, G), A])
overall = (q[0]^12 × q[1]^6 × q[2]^4 × q[3]^2 × C^2)^(1/26)
```

This is a weighted geometric mean. It emphasizes the best roles, uses the stronger of Switch and Charger, and includes consistency. The actual exponents above govern the result; an older nearby source comment describes a different weighting and is not the executable formula.

If both Attacker and consistency scores are at most 75, apply a second penalty:

```
overall = (overall^14 × A × C)^(1/16)
```

Upstream can then blend an editor score E, if a matching cup/league override exists with a truthy editor score:

```
overall = 0.25 × overall + 0.75 × E
```

Our custom scoring never applies an overall editor override. Therefore this blend is not applied to generated results. Published mode displays the stored upstream values, including any blend already used. The adapter uses bundled override weights only when Published weights is selected; it does not feed their editor scores into custom overall scoring.

Finally, `floor(overall × 10) / 10` truncates the overall score to one decimal and results are sorted descending. Overall scores are not rescaled to force a leader of 100. The six detail scores are Lead, Closer, Switch, Charger, Attacker, and Consistency.

## 13. Moveset lab — separate algorithm

The lab evaluates the selected species against accepted opponents, excluding its own species ID. The subject need not itself be accepted. There must still be at least two accepted roster entries. Every opponent keeps its published moveset and gamemaster default IVs.

The engine's actual fast and charged move pools are deduplicated and enumerated. For F fast moves and C ordinary charged moves (C at least 2), there are `F × C × (C - 1) / 2` combinations. Charged-move order permutations are not separately tested. Supported extra charged move pools multiply those pairs by the number of distinct extra choices. A single ordinary charged move uses a second-slot `none`. Pool accessibility is handled upstream, including available Elite TM, legacy, Return/Frustration, and form-specific rules; this is not a live check of the user's TM inventory or event access.

Each matchup starts with full HP, zero energy, and the chosen equal shield count (0, 1, or 2). Fresh opponent objects and reset battle state prevent previous matchups carrying over. For each moveset m:

```
labRating[m] = sum(rawBR[m,j] × userWeight[j]) / sum(userWeight[j])
```

This uses raw BR. It does not use category shield bonuses, seven-pass meta reweighting, score curves, Charger factors, consistency, or editor adjustments. It therefore answers a different question from Overall: how does this moveset perform against this weighted roster in this one shield scenario?

Movesets are sorted by labRating. Best-only keeps all ties within `1e-8` of the best. Otherwise, a threshold p shows `rating >= best × (1 - p / 100)`. A 10% threshold means at least 90% of the best weighted BR, not 10 points below the overall score. Set 100% to show every evaluated moveset. Below-best percentage is `(1 - rating / best) × 100`, with a zero-best guard.

The combination limit defaults to 500 and can be set from 1 to 10,000. If the complete set exceeds the limit, the run stops with an explicit error; it does not silently sample combinations. A species with no selectable combination reports an error. The Lab remains a one-species raw-BR tool. The Rankings subtab now jointly ranks selected combinations across all accepted species using the five-category pipeline above; opponents remain recommended-only in both tools.

## 14. Browser execution, state and compute

Filters, custom rankings and lab battles run in cancellable Web Workers against bundled data. No server-side simulations or upstream PHP writes occur, and no roster/results are uploaded. The unchanged Battle, Pokemon, DamageCalculator and supporting action classes supply the combat model. The adapter handles rectangular generation; the original category/overall rankers remain as readable reference sources. The overall combination formula is implemented in testable `core.js`, with upstream `Pokemon.calculateConsistency` supplying C.

Rank cost includes a cheap cycle shortlist, five-scenario scout battles against at most eight opponents when pruning is needed, and final retained-candidate battles against the remaining full roster. Matching scout/final cells are cached, including recommended baselines. The cheap cycle stage uses arithmetic and performs no Battle.simulate calls; the scout stage deliberately does. The UI reports actual total battle count including screening. Work estimates include scouting and baseline overhead before cache savings. A large roster can still be expensive even with one moveset per species. Multiple limits the number of combinations per species. The worker’s programmatic All mode has no hidden candidate cap. Top N deliberately uses the documented bounded preliminary shortlist. The UI estimates work, reports progress and provides Cancel; a fresh worker prevents data leaking between runs. Moveset Lab has its own explicit maximum-combination guard.

Changing Include rules/league, weights or candidate-selection settings invalidates generated results and lab output; changing display filters does not. Pending/invalid Include filters disable generation. Individual limits are validated before running. Results are kept in page memory; reload clears them. Published results remain accessible. Selecting a different ranking species clears the previous lab output; the lab selector can choose any published species regardless of whether it is an accepted opponent.

The engine remains heuristic: defaults, move timing, shield baiting, form mechanics and rounding matter. Projections can miss shield- or buff-dependent movesets. Generated scores include the described rectangular scoring changes and omit editor adjustments. They are not calibrated win probabilities or exhaustive optimal-play proofs.

## 15. Developer and AI reading map

Read these files in order to inspect or modify the algorithm. All links resolve directly from this static page; no account or JavaScript execution is required to read this guide.

| File | Responsibility |
| --- | --- |
| [worker.js](worker.js) | Upstream Include filtering, moveset projection/pruning, rectangular battles, variant scores and lab. |
| [core.js](core.js) | Validation, enumeration, cycle DPT, top N, rectangular category scoring, overall formula, lab thresholds. |
| [ui.js](ui.js) | Initial population, weights, user actions, results and state. |
| [GameMaster.js](vendor/GameMaster.js) | Data lookup, filtering, override application. |
| [Pokemon.js](vendor/Pokemon.js) | IV/level/stats, move pools, forms, reset behavior, consistency. |
| [Battle.js](vendor/Battle.js) | Turn simulation, action resolution, shields, buffs, end conditions. |
| [ActionLogic.js](vendor/ActionLogic.js) | Tactical move/energy/bait decisions. |
| [DamageCalculator.js](vendor/DamageCalculator.js) | Exact damage and type multipliers, special damage methods. |
| [Ranker.js](vendor/Ranker.js) | Upstream reference for category scoring; not the active rectangular ranker. |
| [RankerOverall.js](vendor/RankerOverall.js) | Upstream reference for overall/consistency/editor formulas; generated combination lives in core.js. |
| [TimelineAction.js](vendor/TimelineAction.js), [TimelineEvent.js](vendor/TimelineEvent.js), [DecisionOption.js](vendor/DecisionOption.js) | Supporting action/event/decision structures. |

Run `node --test familyRanks.test.cjs analysis.test.cjs pro.test.cjs`. Tests cover the existing tools, complete multi-species variant generation, unique IDs, weight sensitivity, rectangular opponent count, recommended-seeded scout top N and individual limits, all nine upstream filter types, AND/Species override semantics, cycle DPT, candidate-population independence, lab limits and league coverage.

To refresh the snapshot, update all vendor sources, gamemaster, league bundles, overrides and pinned references together. To change scoring, edit the documented adapter/core functions and tests; keep vendor sources unchanged for provenance. Future opponent optimization would require an explicit new policy rather than treating variants as extra independently weighted species.

## 16. Selector benchmark

The original cycle-DPT-only selector was not reliable enough by itself. We compared it with the improved shortlist → real-battle scout → protected recommendation selector using 120 Pokémon–league cases across Little, Great, Ultra and Master.

For each league, published ranks 1–15 form one 15-species equal-weight opponent meta, and ranks 16–30 form a separate held-out meta. Exhaustive All-mode five-scenario results are the reference. A case succeeds if at least one combination tied for that species' highest truncated Overall score is retained. Near-best means a retained combination is within one point of the exhaustive best. Regret is evaluated using the exhaustive report's scores, avoiding normalization changes caused by pruning. These are 120 species/league/meta cases, not necessarily 120 distinct species.

| Selector | Best retained at N=5 | Best retained at N=10 | Published recommendation at N=5 / N=10 |
| --- | --- | --- | --- |
| Cheap cycle DPT only | 85/120 · 70.8% | 109/120 · 90.8% | 86/120 · 71.7% / 105/120 · 87.5% |
| Improved seeded scout | 117/120 · 97.5% | 120/120 · 100% | 120/120 at both limits, protected by design |

Top 5 was within one point in 119/120 cases. Its misses were Little Dewpider (0.8 points), Master Xerneas (1.0), and Great Araquanid in the held-out group (2.4). The initial 60 cases achieved 58/60 exact best at N=5; the separate 60-case check achieved 59/60. N=10 retained a best moveset in both groups.

Exhaustive evaluation used 291,200 battles. The N=5 selector used 118,480 including its scout stage (59.3% fewer); N=10 used 146,415 (49.7% fewer). Cheap damage-cycle arithmetic is additional CPU work but performs no battles. Small rosters can save less or no work; these savings are measured results for the described benchmark, not a universal speedup.

[Detailed benchmark data](benchmark-report.json) contains every case's cheap-proxy rank, per-league screening outcomes, misses and battle counts. Reproduce a full comparison with `node scripts/benchmark-pro.cjs` from the repository; it writes `work/pro-benchmark.json` by default and may take several minutes. It evaluates N=1, 3, 5 and 10 in both bands.

This is evidence of useful screening reliability, not proof of universal optimality. A different roster, skewed weights, unusual forms, IVs, buffs or future move updates can change performance. The benchmark's best is defined by this app's exhaustive simulation/scoring model, not a universal real-play best. Use N=10 as the tested cautious default; use All when a guaranteed exhaustive comparison matters.


## 17. Saved custom rankings

After generating custom rankings, enter a ranking name and select **Save rankings**. Saved entries appear in the **Rankings** dropdown with their league. Selecting an entry restores its calculated categories, movesets, scores, Pokémon details, matchups, and run summary without simulating again. Selecting a ranking from another league switches the league automatically.

To rename a saved entry, select it, edit **Ranking name**, then select **Rename**. **Save a copy** creates a separate snapshot. **Delete saved ranking** removes the stored copy while leaving the displayed results available to save again. Editing the roster starts a new calculation; it does not change stored snapshots.

Snapshots are stored in IndexedDB in the current browser on the current device and site origin. They survive reloads but do not sync to other devices or visitors. Clearing site data removes them. Storage failures are reported next to the save controls.


## 18. PvPoke search strings

The ranking search applies to every category in published, generated and saved reports. It preserves all matching moveset variants. `search.js` compiles comma-separated OR groups containing `&`-joined AND terms; prefix `!` negates one term. Matching ignores case and trims surrounding whitespace. A blank query shows all entries; empty comma groups are ignored. AND binds before OR: `water&@fighting,gfisk` means (Water AND a Fighting move in the displayed moveset) OR Galarian Stunfisk.

Supported terms include name prefixes, exact nicknames, types, tags, generation/region, exact Pokédex number, `+speciesId` evolution families, `@move` prefixes, `@type`, `@1` fast moves, `@2` charged moves, `@legacy`, `@special`, traits, second charged move cost (`10k`/`50k`/`75k`/`100k`), buddy distance (`1km`/`3km`/`5km`/`20km`), `meta`, `notes`, `4*` and `hundo`. Gen1 excludes Alolan forms, following upstream search. Trait `bulky` includes Extremely Bulky, and Less Bulky includes Glassy/Glass Cannon. Trait names come from the pinned engine; the older “Risky” example in upstream help is not an assigned trait in this snapshot.

A dedicated worker builds league-specific search metadata using the unchanged `Pokemon` implementation: initialization, move pools, `generateTraits()` and `needsXLCandy()`. The index is cached in page memory per league. Search itself performs no battles and does not affect roster selection, scores, or saved results. Engine-generated move pools include Elite TM, legacy and supported special moves. Move queries use the metadata only for moves in the displayed row’s moveset. `@legacy` excludes Return and Frustration themselves; other legacy/Elite moves remain searchable when present in the displayed moveset. `@special` includes them.

Traits, XL and hundo use the default league build and published Overall recommended moveset, including when viewing a custom report. Hundo means the default build has 15/15/15 IVs, not that the species could be caught with perfect IVs. `meta` uses pinned PvPoke groups `littlegeneral`, `great`, `ultra` and `master`; it matches both normal and Shadow versions of a listed species. It is not a score cutoff. `notes` tests nonempty editor notes on the displayed ranking row; generated reports do not invent editor notes. Families can resolve a species from the full bundled gamemaster even if that family member is absent from the current report.

Source references: [PvPoke search implementation](https://github.com/pvpoke/pvpoke/blob/f627e89e53c0c7b903fff097df7a0ad0ac95decc/src/js/GameMaster.js), [Pokémon traits and XL logic](https://github.com/pvpoke/pvpoke/blob/f627e89e53c0c7b903fff097df7a0ad0ac95decc/src/js/pokemon/Pokemon.js), and [search syntax guide](https://pvpoke.com/rankings/all/1500/overall/).


## 19. Recommended moveset badges

Generated and saved ranking rows use neutral **Recommended** or **Alternate Moveset** badges. If an alternate has a strictly higher score than the same species’ recommended moveset in the **same report and selected category**, its badge shows the positive difference in score points. Alternates also display the recommended moveset names for comparison. Rows receive no recommendation-based background or border color; type chips and the numeric score gradient remain. Ties do not count as improvements. Published rows use their own category’s recommended moveset. Cycle/Scout screening metrics are omitted from the report table.

For custom reports, the reference is the bundled **Overall** recommended moveset used by the opponent population and protected by the selector. Comparisons look through the full category results, before search, pagination, and best-only display filtering, so hiding the recommended row does not remove its baseline. Ordinary charged-move order is ignored; fast moves and the separate third charged-move slot must match. A missing second move and an explicit `none` are equivalent. Existing saved results work without rerunning when their baseline is present. If an older saved report lacks that baseline, the alternate badge tooltip explains that no score comparison is available. Scores from the published meta are never substituted for scores from a custom roster.

Moveset Lab uses the same neutral badges, comparing weighted Battle Rating under its own opponent roster and shield setting. Its baseline is found among all evaluated variants before the best-only/threshold display filter. The detail panel repeats the ranking row’s badge.


Saved ranking controls, name, save/rename/delete actions, display options, run context and status are grouped inside the collapsed **Edit Saved Ranking** disclosure. Newly generated reports use **Save Ranking & Options**. Detailed move cards are always visible under **Move details**, with compact typography and spacing.

## 4b. Additional score columns

Click **Add Score** above a custom ranking table to choose Default, Equal, Calculate with adjustable PvPoke guidance, or the published PvPoke score for the selected league. The controls use the same weight cards and guidance slider as the builder. The stored battle outcomes are scored in a worker without running battles. The original score, category rows, detail view, moveset selection and opponent roster stay unchanged. Additional scores support sorting and removal. Difference columns are opt-in: double-click a score header, choose Add Difference, then click another score header. The new column is first selected score minus the second selected score; its × button removes it. Rank numbers automatically follow the leftmost score column, highest first (searching does not reset ranks). A subtle border and Rank basis label identify that column; dragging another score to its left changes the rank basis. Drag any header to reorder the table. Column order and differences are saved with a report copy. New scores are inserted immediately after the rightmost score; new differences immediately after the rightmost difference (or after the rightmost score if none exists). Published scores are species-level references for the recommended moveset, shared by alternate variants; missing published entries show — and rank last. They are not newly simulated alternate-moveset scores and use PvPoke’s own opponent pool/normalization. Differences between a custom score and a published PvPoke score display an Alternate Moveset badge beside the delta when the row uses a different moveset, to flag that the published reference evaluates the recommended moveset. An info icon beside each score header opens a dense Preview Pokémon grid of that column’s exact assigned opponent weights and its calculation rules. Default/Equal still use the existing iterative category-scoring multiplier; Calculate freezes the estimated meta weights as described above.

Additional score snapshots and weights are saved with a report copy. Published reference scores are captured from the bundled league snapshot when added, for all six categories, and do not require battle simulation. Reports missing complete category matchups or recommended baselines need regenerating once; published PvPoke scores lack this matrix and cannot receive extra columns directly. Legacy individual-weight reports keep their existing primary score.

## 4c. Limiting opponents

The builder’s Opponents section uses all selected opponents by default, or a configurable top N (minimum two). Opponents are selected by assigned weight descending, then PvPoke default weight for ties, then original roster order. Missing assigned weights fall back to the default. All accepted Pokémon remain ranking candidates, including those outside the opponent subset. Every final candidate is simulated only against the selected opponents; its own species is excluded from scoring. Scouting also uses this subset. Calculate’s full recommended-roster weight-estimation pass remains necessary before selecting its top N unless those weights were already previewed. The report stores exactly the opponent subset; Add Score compares weighting schemes on that fixed subset and cannot introduce opponents whose matchups were never simulated. Regenerate to change the opponent pool or discover other movesets.

## 4d. Candidate and opponent previews

**Ranking candidates** displays the published PvPoke Overall rank in the selected league, rather than opponent weights. These are global league ranks, not renumbered positions within the filtered population. Use all eligible Pokémon or set **Maximum ranking candidates · top PvPoke ranks**. The limit selects the best-ranked entries from the eligible filtered pool; dimmed tiles distinguish entries excluded by filters or the limit. An entry outside the automatic rank limit explains that the limit or filters must be changed to include it. Excluding an eligible selected entry through the existing Species filters lets the next eligible rank fill the slot.

**Battle opponents** uses all ranking candidates or **Maximum opponents · highest weights**. Its separate searchable grid shows actual weights, sorts by weight with the same default-weight tie breaker as generation, and automatically dims entries outside the opponent limit. Those dimmed opponents still receive candidate rankings. With Calculate selected, the preview is provisional using the tapered PvPoke prior until the selected candidate roster’s weights are calculated. Both Calculate preview and Generate refresh the final opponent selection; raw candidate ranks never change with weights. The rank limit is applied before the opponent limit, so opponents come from the selected candidate population.

Opponent weight controls live inside **Battle opponents**, defaulting to Default. Equal updates weights and the preview immediately. Calculate automatically starts a cancellable recommended-roster weight calculation; guidance and candidate-population changes debounce a new calculation when needed. While calculating, the preview labels its selection provisional and shows pending weights. Completed estimates refresh the top-N opponent selection. Changing only the opponent limit reuses the candidate roster’s existing weight estimates.

Ranking search queries beginning with `@` inspect only the displayed row’s moveset (including move types, fast/charged restrictions, legacy and special moves), rather than the species’ learnable pool. This applies to published, generated, and saved rankings. Builder Move filters continue to select eligible species by learnable moves.

Rankings display 500 Pokémon per page. Clicking a Pokémon toggles a detail row immediately beneath that exact moveset variant. Its compact summary, matchup lists and move cards share the available width; clicking a matchup opens the battle graph within that expanded row. Filtering or paging away cancels hidden detail work.

Expanded details omit the name, typing, score, displayed moveset and category ranking scores already visible in the ranking table. Additional battle stats and editor notes remain. A reserved one-third-width battle lane and fixed-height detail area keep the layout stable when a battle opens or closes. PvPoke Pro uses a wider page; smaller screens scroll the expanded row horizontally rather than resize its columns when simulating.

For a simpler matchup display, raw Battle Rating 500 ties are included in the Losses list (ascending), rather than a separate Ties section. Battle results still identify a tie and the underlying rating/scoring calculations are unchanged.

Inline fast and charged move cards share the full move-column width and a fixed 140px height. Their former explanatory footer is removed; move values, flags, and tooltip information remain available.

Changing ranking categories resets display sorting to the leftmost score, highest first. The primary score reads that category’s retained row score directly; cached comparison snapshots cannot override it. Display sorting uses a copy and never changes stored category row order.

Expanded rows use equal horizontal thirds for matchups, move information, and simulated battles. Fast moves appear above charged moves in the middle lane. The battle lane is reserved even before a matchup is selected.
