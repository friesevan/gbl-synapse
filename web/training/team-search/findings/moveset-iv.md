# Retained movesets and IVs: moveset mutation (`--moveset-mutation`) and an IV-build panel (`--iv-panel`) (2026-10-18)

Section 12 row "Retained movesets and IVs". Until now each Pokémon entry kept only its five best 1-v-1-scouted movesets (1,498 variants from 12,335 combinations) and every Pokémon played PvPoke's default IVs for the league, so a moveset that is only good inside one team could never be played, and nothing said how much a team's score depends on the default spread. This change does two things, both opt-in:

1. `--moveset-mutation N` proposes, for each of the best screened teams, N swaps of one member to a legal moveset outside its species' retained five, keeps a swap only if it beats its parent on the parent's own screening fixtures (paired), and lets the sealed final panel measure it.
2. `--iv-panel N` replays the final-tested finalists, last of all, on one sealed panel of N fixtures with every member on the default, rank-1 stat-product, attack-weighted and bulk-weighted IV build within the 1,500 CP cap.

**Result.** Both work end to end with the real engine. Defaults are untouched (section 4). The smoke-scale measurement (section 5) shows that most single-move swaps outside the five hurt (mean −10.0 points over 18 swaps) and that the three swaps that were kept, and every IV difference, sit inside noise. **Nothing here shows that mutation or alternate IVs improve a team, or that they do not.** The full-scale commands are in section 7 and have not been run.

## 1. What was built

| Part | Files | Notes |
| --- | --- | --- |
| Engine pools | `engine-pools.cjs` (new) | one VM context per process from the vendored PvPoke `Pokemon`: `legalMovesets(speciesId)` (the `PvPPro.enumerate` source preparation uses; sums to 12,335 over the 300 pool species, checked), `builds(speciesId)` (`default`, `rank1`, `attack`, `bulk` from the engine's own IV combinations: level cap and IV floors included), `cpOf`, `statsOf` |
| Mutation | `moveset-mutation.cjs` (new) | options, mechanics-id suffix, proposals, the paired keep rule, the final-panel check, report text |
| IV panel | `iv-panel.cjs` (new) | plan (sealed fixtures), arm teams, assembly with paired simultaneous bands (`next/policy-panel.cjs` `summarizeTeam`), report text |
| Engine | `engine-v4-core.cjs` (one hunk), `simulator-compatibility.json` (one line) | a team row may carry `ivBuild`; absent, nothing changes |
| Search | `search.cjs` (hunks in section 6), `common.cjs`, `launch.cjs`, `report.cjs`, `export-report.cjs` | flags, stages, budget, seeds, mechanics-id suffix, reports |
| Tests | `moveset-iv.test.cjs` (9 tests) | defaults, legality, CP cap and ordering of the builds, engine honours `ivBuild`, deterministic panel, order of the panels, options refused, resume |
| Docs | README sections 2, 3, 7, 8, 12, 13, 14, README-plain | |

## 2. Moveset mutation

- **Stage.** After screening (all `--screen-teams` play the sealed screening fixtures) and before the final test. The `--mutation-teams` (default 4) best screened teams are the parents. Per parent, `propose()` builds, for each member, the legal movesets of its species minus the species' retained variants minus the member's own, keeps those one move away from the member's moveset (fast move, or one charged move; any legal alternative if none is), shuffles each list with a stream fixed by the run seed and the parent, and takes proposals round-robin over the three members until N.
- **Variants.** Each proposal appends one variant after the pool's own (index at or beyond the pool size): the parent's variant with the new moveset, `recommended: false`, `scoutScore: null`, `mutated: true`, `mutatedFrom`. They are stored in `checkpoint.movesetMutation.variants`, restored on resume, and reports and the portable report read them like any variant (the pool is hashed as the pool it came from). They are never fed to the surrogate (their model features would be the parent's).
- **Keep rule.** The mutant plays the parent's screening fixtures in one common panel; the difference is the paired mean over the common prefix with the same paired bootstrap as `compare()` (5,000 resamples, 95%). A swap is **kept** when its mean difference exceeds `--mutation-margin` (default 0, i.e. any improvement). The best kept swap of each parent (and only that) joins the screened set and competes for the final slots beside its parent. Every proposal is recorded with its interval whether kept or not.
- **Why the weak keep rule is acceptable.** Screening is a selection stage; the final panel is sealed and the swap is measured there against its parent when both are finalists (`events[].final`, with a verdict `swap-better`, `parent-better` or `unresolved`). A kept swap is the best of several noisy looks and is optimistic; the report says so.
- **Cost.** T × N × `--screen-opponents` battles, reserved in `budget.cjs` as extra battles (training ends earlier, screening and the final test never shrink) and taken as a share of the time left after screening.

## 3. The IV panel

- **Arms.** `default` is the finalist's own team with no override (the engine path of the final test); `rank1`, `attack`, `bulk` are copies of its variants with an `ivBuild` the engine applies after `initialize()` (`isCustom`, IVs, level, then `initialize(false)` so stats, HP and CP follow). `attack` is the highest attack stat the cap allows (ties by stat product); `bulk` is the highest defence times HP (ties by stat product); `rank1` is the highest stat product. All three kinds are computed from the engine's own combinations, so each is at or under 1,500 CP (the test recomputes every CP from base stats and the level table, and checks, for 24 species, that `rank1` has the best stat product, `attack` the highest attack and `bulk` the best defence times HP among the builds).
- **The default spread is not rank 1.** PvPoke's default IVs equal the rank-1 spread for 3 of the 300 pool species; for the other 297 they differ, which is why the `rank1` arm is not a copy of the reference. `bulk` often coincides with `rank1` (it did for all 12 members in the smoke run, so those two columns are identical); the report counts members whose build differs from the default per arm.
- **Order and seed.** Last of all, after the confirmation, the policy panel, the alternate panel and the sensitivity panel. Seed offset 850001, guarded against every other panel seed; fixtures checked against the sealed panels, the alternate panel and the training evidence; a test pins the seed formula.
- **What it does not do.** It does not change the primary; opponents stay on default IVs; every member of a team gets the same build kind (no per-member mix); it is not in the portable report or the viewer yet.

## 4. Defaults are unchanged

- **Mechanics id.** With neither option the run's `mechanicsHash` is the registered v4 id (`1b33a32b…`), checked in a test. The engine hunk changes the source hash, so the new source hash is registered to the same id in `simulator-compatibility.json` after the 37 pinned mechanics fixtures reproduced exactly (`node training/mechanics-fixtures.cjs`: 37 battles; 0 changed, 0 new, 0 removed), and a test checks that a row whose `ivBuild` is the default spread plays exactly the same battle as a row without one.
- **Suffixes.** `--moveset-mutation N` appends `+moveset-mutation:swaps=N,teams=T,margin=M`; `--iv-panel N` appends `+iv-panel:builds=default|rank1|attack|bulk`; both can appear. Resume, warm start, merge and export therefore never mix them with default runs (`export-report.cjs` expects the suffix).
- **Byte identity, mocked battles.** The same search (every panel on: sensitivity, confirmation, policy, alternate) on the base commit and on this branch with a deterministic battle stand-in: `checkpoint.json`, `recommendations.json`, `history.jsonl`, `report.html`, `findings.md` and the portable report have identical hashes once wall-clock fields, the algorithm hash and the report id (which hash the changed source) are removed (script and digests in the PR).
- **Byte identity, real engine.** The same defaults-only search with the real engine (`--rounds 2`, 4 workers, 32 final fixtures, confirmation 8, sensitivity 4, alternate panel 4, policy panel 4; pool, seed 20261018 and validation seed 777002 fixed) on the base commit and on this branch: the checkpoint, `recommendations.json`, `history.jsonl`, `findings.md` and the portable report have identical hashes (wall-clock fields, algorithm hash and report id removed); `report.html` differs only in the run-time telemetry line (peak RSS and worker recycles) and its generation timestamp.
- **In the test suite:** no new key in the checkpoint, config, `recommendations.json`, report or findings; explicit zeros reproduce the plain run's battles in the same order and the same stored results.

## 5. Smoke-scale measurement (exploratory; inside noise unless stated)

Real engine, 4 workers on a shared machine, 90 s, 1,848 battles. The moveset-mutation parents are the 3 best of 6 screened teams, 6 swaps each, on 32 screening fixtures; 4 finalists on 64 final fixtures; the IV panel is 4 finalists × 4 builds × 32 fixtures.

```
nice -n 10 node training/team-search/search.cjs --pool training/runs/team-search/pool.json --out training/runs/smoke-moveset-iv --hours 1 --workers 4 \
  --initial-teams 16 --batch-teams 4 --opponents 8 --acquisition-fixtures 4 --rounds 2 --screen-teams 6 --screen-opponents 32 \
  --validation-teams 4 --validation-opponents 64 --baseline-count 3 --confirmation-opponents 0 --candidates 64 --epochs 2 --hidden 8 \
  --ensemble 2 --reference-opponents 16 --fit-fixtures 400 --seed 20261018 --validation-seed 777001 --meta independent --sensitivity-fixtures 0 \
  --moveset-mutation 6 --mutation-teams 3 --iv-panel 32
```

**Moveset mutation** (18 swaps; paired change against the parent on 32 screening fixtures, points; interval is the 95% paired bootstrap):

| Result | Count | Detail |
| --- | ---: | --- |
| Worse | 13 | mean of all 18 swaps: −10.0 points; three have the interval clear of zero: −37.5 [−56.3, −18.8], −28.1 [−43.8, −12.5], −21.9 [−40.6, −3.1] |
| Equal | 2 | 0.0 |
| Kept (better than the parent) | 3 | +9.4 [−6.3, +25.0] (Bastiodon charged move to RETURN), +3.1 [−18.8, +25.0] (Ampharos), +1.6 [−15.6, +18.8] (Ampharos); none has the interval clear of zero |
| Entered the screened set | 2 | the best kept swap of two parents (Bastiodon +9.4, Ampharos +1.6) |
| Reached the final panel beside its parent | 1 | the Bastiodon swap: −4.7 [−17.2, +6.3], `unresolved` |

Reading: single-move swaps outside the five are mostly worse than the scouted sets, as the 1-v-1 retention would suggest; the three kept swaps are what noise produces when the best of several comparisons is taken (a mean of +4.7 for three of 18), and the one that could be checked on the sealed panel was not better. At 32 fixtures a pair of teams must differ by about 15 to 20 points to separate. **This is not evidence that mutation helps or hurts the final team.**

**IV panel** (4 finalists, 32 fixtures, exploratory; change against the default build, points; the band is simultaneous over the arms):

| Finalist | Default | Rank-1 | Attack | Bulk | Band |
| --- | ---: | --- | --- | --- | ---: |
| 1 (primary) | 43.8% | +17.2 | −9.4 | +17.2 | ±21.9 |
| 2 | 50.0% | +9.4 | −9.4 | +9.4 | ±21.9 |
| 3 | 59.4% | +3.1 | −21.9 (lower) | +3.1 | ±18.8 |
| 4 | 59.4% | +1.6 | −14.1 | +1.6 | ±23.4 |

The rank-1 build is higher for all four finalists (+1.6 to +17.2) and the attack build lower for all four (−9.4 to −21.9), the direction one would expect when a team is built around bulk; but only one of the twelve comparisons has its simultaneous band clear of zero (finalist 3, attack, −21.9), the bands are ±19 to ±23 points, and the 32 fixtures are the exploratory regime. The first finalist's default score on this panel (43.8%) is far below its final-test score (59.4% on 64 other fixtures) which shows the size of the fixture noise. Treat these as a check that the panel runs, not as a finding.

## 6. `search.cjs` hunks (small insertions; to re-apply if a merge conflicts)

Another session may have uncommitted edits to `search.cjs`; the changes here are these lines.

1. After the `alternateTools` require: `const movesetMutation=require('./moveset-mutation.cjs'),ivPanelTools=require('./iv-panel.cjs');`.
2. After the line that ends `baselineFixtureSeed]);` (the `alternateSeed` line): `mutation`, `mutationSwaps`, `mutationBattles`, `ivFixtures` (validated by `checkSize`) and `ivSeed` (guarded against the other seeds, including `alternateSeed`).
3. `const variants=[...prepared.variants],poolSize=prepared.variants.length,config={` (a copy, so mutated and IV variants never touch `prepared`).
4. `config`: `mechanicsHash:mechanicsHash({version:'v4',controller})+movesetMutation.suffix(opts)+ivPanelTools.suffix(opts)`, and `...(mutationSwaps?{movesetMutation,mutationTeams,mutationMargin}:{}),...(ivFixtures?{ivPanel,ivPanelSeed}:{}),` after the alternate-panel spread.
5. After the resume line: `if(state.movesetMutation?.variants?.length)variants.push(...state.movesetMutation.variants);`.
6. The sensitivity plan's `reserved:[…]`: `...(ivFixtures?[ivSeed]:[]),`. **Any other panel seed a merge adds belongs in that list and in `ivSeed`'s guard.**
7. A comment and `ivPlan`, `ivBattles` after the `alternatePlan` line.
8. `updateBudget`: `extraBattles:policyPanelBattles+ivBattles+mutationBattles`.
9. `reportPool` before the `speciesMap` line; `writeReport` and `writeReportBundle` take `reportPool()`.
10. Screening stage: `variants.length=poolSize;delete state.movesetMutation;delete state.ivPanel;delete state.ivScores;` before `delete state.confirmation`; `finalWork` adds `+ivBattles`; the screening share divides by `screenWork+mutationBattles+finalWork`.
11. After the `Screened … common fixtures` log: the mutation stage (about six lines).
12. After `championComparisons(...)`: `if(state.movesetMutation)movesetMutation.finalCheck(...)`.
13. After the sensitivity block: the IV block (about eight lines, `variants.length=mark` in a `finally`).
14. `recommendations()`: a record-less finalist (a mutant) is listed, and `neural` is null for a team with a variant beyond the pool; the report object gains `movesetMutation` and `ivPanel`.
15. CLI: defaults `movesetMutation:0,mutationTeams:4,mutationMargin:0,ivPanel:0,` (and in `launch.cjs`); help text.

Other shared files: `common.cjs` (three names in the `algorithmHash` list), `report.cjs` (three insertions), `export-report.cjs` (the suffix in `expected`; a pool extended by mutation hashes as the pool it came from), `engine-v4-core.cjs` (one hunk), `simulator-compatibility.json` (one line).

## 7. Limits, open items and the full-scale commands

- **Proposals are local and unranked.** A seeded shuffle of one-move neighbours, filtered only by the paired comparison. A cheap damage-projection prior (as preparation uses for its shortlist), or the surrogate scoring the mutated team (needs features for unscouted movesets), would spend the same battles better.
- **One round, one swap, parents only from screening.** The mutation does not iterate (a kept swap is not mutated again), and the surrogate never learns from mutated teams.
- **The keep rule is optimistic.** The best of N noisy looks per parent; only the sealed final panel is a measurement, and only for swaps whose parent is also a finalist. A larger `--mutation-margin` trades recall for fewer lucky keeps.
- **Mutated teams are outside the pool.** `champions.cjs`, `rematch.cjs` and `sensitivity.cjs` map compositions into the pool and skip a moveset it does not hold; the portable report lists them but a rematch cannot. Extending the pool file with accepted mutants is the natural follow-up.
- **IVs are a read-out.** Not searched; every member gets the same build kind; opponents stay on default IVs; the `bulk` arm often equals `rank1`. A per-member IV choice, or a CP-cap-aware search of IVs inside the engine's combinations, is open. `iv-panel.cjs` has no standalone mode for finished runs (unlike `alternate-panel.cjs`), because the panel is run by the search; a standalone tool would let the completed run's finalists be tested without a rerun.
- **Not in the viewer.** `movesetMutation` and `ivPanel` are in the checkpoint, `recommendations.json`, `report.html` and `findings.md`; the portable report and the Teams view do not show them (mutated finalists do appear as teams, with their real movesets, and replay).
- **Smoke scale only.** Everything in section 5 is exploratory.

**Full-scale commands, still to run** (12 workers, idle machine, from `web/`). The comparison is two runs with the same pool, seeds and `--rounds`, one with the options and one without, so that the difference in the sealed final panel is the effect of the options and `rematch.cjs` can put both primaries on one fresh panel (EVALUATION_PROTOCOL.md):

```
# A: unmutated reference (any recent default run on the same seed works)
nice -n 10 node training/team-search/launch.cjs --hours 8 --rounds 150 --seed 20261018 --validation-seed 777001 --out training/runs/team-search-v4-ref ...same flags as the current overnight command...
# B: mutation on every screening parent, IV panel at 256 fixtures
nice -n 10 node training/team-search/launch.cjs --hours 8 --rounds 150 --seed 20261018 --validation-seed 777001 --out training/runs/team-search-v4-mut ...same flags... \
  --moveset-mutation 16 --mutation-teams 8 --mutation-margin 0.005 --iv-panel 256
node training/team-search/rematch.cjs training/runs/team-search-v4-ref training/runs/team-search-v4-mut --finalists --fixtures 1024 --workers 12 --meta hybrid --out training/runs/rematch-moveset-iv.json
```

At 512 screening fixtures a swap must beat its parent by about 4 to 5 points to be resolved; the final-panel check (`movesetMutation.events[].final`) is the number to read. A swap that is kept in most runs and `swap-better` on the sealed panel would justify enlarging the pool; if no swap is ever resolved better, the retention of five is not the limit and the row can be closed. For the IV panel, a build that is `higher` with its simultaneous band clear of zero at 256 fixtures on several finalists would justify a per-member IV search; otherwise default IVs stay.
