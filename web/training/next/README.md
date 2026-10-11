# Current v3 update

The launcher now creates `training/runs/team-search-v3`. Read [the v3 guide](../../includes/pro/NEURAL_REPORTS.md) for changes, import/export, and current commands. The v2 notes below describe the preceding implementation.

# Next-run team search (v2)

This version is installed directly in Desktop/Projects/PvPokeTeamTrainer. It prepares a **new experiment**, preserving the completed v1 run and historical browser replays. It is not an optimal-play agent. The neural network predicts team outcomes; the battle controller still uses Champion charge/farm/shield logic, with bounded lookahead for switching.

## Run

From the trainer directory:

```sh
node training/team-search/launch-next.cjs --hours 8
```

This starts a detached, caffeinated process using all available CPU cores (12 on this M2 Max), reuses the exhaustive 300-entry / 1,498-variant scouting pool, and writes to `training/runs/team-search-v2`. It prints the PID and log path. Do not use the old checkpoint as a warm start: controller mechanics, features, and labels have changed. A fresh model is required. Existing output requires `--resume`, or a different `--out` directory. To monitor:

```sh
tail -f training/runs/team-search-v2/training.log
node training/team-search/status.cjs training/runs/team-search-v2
```

It stops automatically after the configured search/evaluation budget. To stop early:

```sh
node training/team-search/stop.cjs training/runs/team-search-v2
```

Stopping requests checkpointing after active battles. Final screening/testing may be incomplete if stopped early. Worker battles have a watchdog; startup and active batches can run past a deadline briefly. The new run has **not** been started on your behalf. The short verification runs are finished.

## Side and bench independence

The lead remains meaningful. The two bench members are canonicalized by identity for the simulator, team deduplication, and neural features. Physical player slots are assigned from team identity and a seeded coin, and outcomes are mapped back to caller order. Team-specific policy settings follow the correct team. AI decision randomness uses team/state/method keys, rather than a shared sequence consumed in player order.

Both players have equal base priority; actual attack-stat priority is preserved. Equal-attack charged-move ties use a seeded identity-based tie break. Engine iteration order still exists internally; canonical routing standardizes it, rather than proving every upstream mechanic matches the live game. Exact identical team/controller mirrors are explicitly recorded as the expectation of a seeded battle and its counterpart (0.5), not a claim that a single physical battle ended in a tie.

One canonical battle per fixture now supplies one label. There is no second redundant side-swapped simulation. Sample sizes and confidence calculations use independent fixture labels. Saved v1 labels remain paired under their original semantics.

## Switch lookahead

At eligible action turns, compare staying in with each living bench member if the switch clock permits. A fainted active Pokémon requires a replacement. The planner freezes both sides' state before their actions are chosen, so it does not peek at a queued opponent action.

For each choice, enumerate the opponent's legal stay/switch responses, respecting their switch lock. Use cloned Pokémon with current HP, energy, cooldowns, shields, buffs, level/IV statistics, forms, and selected moves. Roll out up to 24 simulator steps with PvPoke's deterministic 1v1 action logic. The opponent's response with the lowest value is used; select the own choice with the highest such worst-case value.

Terminal value, from side A's perspective:

```
remaining HP/energy resources A − B
+ 0.32 × (remaining shields A − B)
+ 0.24 × (remaining-roster coverage A − B)
− 0.12 × (switch-lock cost A − B)
```

A living member's resource is `HP fraction × (1 + 0.18 × energy / 100)`. Coverage compares damage/energy throughput of surviving members against the remaining opposing roster, using type effectiveness and actual current combat stats. It is a heuristic, not a fully simulated continuation through every teammate. A voluntary switch needs a value improvement of at least 0.08. Decisions normally run every four battle turns; low-HP emergencies and forced replacements can run sooner.

`--lookahead-turns 24` (4–120) controls the step horizon; `--decision-interval 4` controls voluntary planning cadence. Steps are not always elapsed battle turns, especially around charged moves. Switch-lock continuation uses the actual elapsed simulated turns. Cloned rollouts cannot consume the live battle's random stream or alter its Pokémon.

The horizon does not plan complete 3v3 continuations, future switch-clock expiry, precise delayed catches, or a game-theoretic mixed strategy. Opponent charge/shield decisions in the rollout use fixed action heuristics; probabilistic buffs are approximated using the upstream deterministic convention. These are important next improvements.

## Meta model

Default `--meta hybrid --meta-weight-power 1.25`:

1. Transform each positive PvPoke weight to `weight ^ 1.25`. This is a popularity prior, not measured usage. The weight-1 entries' aggregate first-slot probability falls from 22.8% to 13.1% in this pinned pool. Later slots are conditional and have different probabilities.
2. Sample half the teams independently from these weights, avoiding duplicate Pokédex numbers.
3. Sample half using a correlated prior: prefer complementary scouting coverage, and in 40% of this component prefer an ABB-like shared backline type with a different lead type. Candidate probability is proportional to popularity weight times `exp(3 × coverage improvement)`, with a 2.5/0.6 ABB compatibility multiplier.
4. Keep the lead distinct; canonicalize the bench. Opponents use published recommended movesets.

The mixture proportions, ABB multiplier, and exponent are assumptions. They do not establish which teams are popular. To reproduce the old independent population model, use `--meta independent --meta-weight-power 1`.

### Observed-team import

Replace the **example** `training/next/usage-template.json` with authorized observations of actual opposing teams. `members` is lead first; `count` is appearances, not wins. Reversed backlines represent the same team; different leads are separate observations.

```sh
node training/team-search/launch-next.cjs --hours 8 --usage-file /absolute/path/my-usage.json
```

The hybrid observed share is `min(0.8, observations / (observations + 500))`; the remaining mass is divided equally between the two priors. Thus sparse observations are shrunk toward the prior. `--meta observed --usage-file ...` uses only the provided frequency distribution, without smoothing.

The importer validates Great League/open cup, exactly three known species, Species Clause, positive counts, and the prepared population. It refuses unknown/out-of-pool members rather than silently discarding them and biasing the distribution. The saved run records source, rating/date metadata, source hash, exponent, mixture, and complete final/screening fixture panels. Recommended opponent movesets are assumptions; they are not represented as observed moves. This initial format does not yet model partial/unrevealed teams, recency decay, individual reporter bias, or observed move-frequency distributions. Filter your input to the intended cup, season/date, and rating bracket first.

## Verification and evidence

Regression tests cover reproducibility, bench/side invariance, policy mapping, live-state preservation, team feature invariance, observed-frequency sampling and import validation. A complete 12-worker smoke experiment exercised fitting, screening, final testing, baselines and report writing.

`node training/next/controller-check.cjs 128` gives both controllers both rosters against a matched opponent panel. The first 128-fixture check gave lookahead 50.8%, with an approximate 95% normal interval of 45.2–56.3%. **There is no demonstrated controller strength improvement yet.** This panel is exploratory and must not become the final test set after parameter tuning.

`node training/next/benchmark.cjs` tests controller/distribution sensitivity on three fixed teams. These short tests cannot rank all teams or predict a human win rate. See NEXT_RUN_AUDIT.md for the complete interpretation of the completed search and research sources.

New reports currently replay via the v2 training engine. The deployed viewer's v1 battle replay must not be used to reconstruct v2 seeds. Browser integration of the new engine is a separate follow-up; historical published results remain valid under their original engine.
