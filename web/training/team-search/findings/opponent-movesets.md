# Opponent movesets: observed moves in the usage export, `--observed-moves` and an alternate-moveset stress panel (2026-10-13)

Section 12 accuracy row "Opponent movesets". Until now every opponent played the published recommended moveset, so a counter that relies on an alternate move, or a bait pattern around one, could not exist in a label. This change does three things, all opt-in:

1. The Meta Extractor export (`usage_export.py`) records, for each observed opponent member, the fast move and the charged moves the harvest saw.
2. `--observed-moves` lets the observed component of the meta play those movesets (validated, completed from the recommendation, identified in every key, encoded for the model, replayable from the report).
3. `--alternate-panel N` replays the final-tested finalists on a sealed panel of N fixtures with every opponent member on its best, then second best, scouted alternate moveset.

**Result.** All three work end to end with the real engine. Defaults are untouched: a smoke search without the flags, run on the code before and after this change with the same command and seeds, produced identical observations, records, models, screening, final test, fixture panels, recommendations and portable-report table (only `config.algorithmHash` differs, as it does for any source change). Measured, all exploratory and none an accuracy claim:

- **Coverage of the 2026-10-13 export** (783 eligible opponent teams, 2,349 members): an observed fast move for 1,774 members (75.5%), at least one charged move for 1,069 (45.5%), both for 850 (36.2%). The observed fast move differs from the recommended one for 53 of 1,774 (3.0%); a charged move outside the recommended pair appears for 111 of 1,069 (10.4%); 163 members (6.9%) differ in some way, in 150 of the 783 teams (19.2%).
- **What the trainer sees** (decayed weights, half-life 30 days as of 2026-10-13): 698 distinct team-and-moveset rows for 679 distinct teams, 70 distinct observed (species, moveset) opponents of which 37 are pool variants (exact model features) and 33 are approximated. In a hybrid meta (75.0% observed) about 15% of all fixtures (448 to 474 of 3,000, three seeds) contain an observed member with a non-recommended moveset.
- **Does it matter for the completed run's finalists?** Re-simulated on 128 common fixtures (4 workers, shared machine): with the observed movesets in the opponents' hands, 1 to 3 of the 128 outcomes differ per finalist and the mean score change is −0.5 points, none beyond ±2.3. With every opponent member on its best or second best scouted alternate, the 8 finalists change by −7.0 to +5.1 points (mean −1.1 and −2.3 with recommended opponents, −0.6 and −1.8 with observed ones) and none of the 32 changes is resolved (simultaneous bands of about ±10 points). The primary fell 2.3 and 0.8 points, unresolved.
- **Replay from the report alone:** 60 of 60 saved matches of a smoke run, 40 of them against observed-moveset opponents, re-simulated from the portable report's variants, opponent rows, engine options and seeds reproduce their stored scores.

## 1. What was built

| Part | Files | Notes |
| --- | --- | --- |
| Export | `web/scripts/yt-harvest/usage_export.py`, `observed.py` (one field), `test_usage_export_moves.py` | `movesets` per row; `--no-movesets`, `--gamemaster` |
| Moves, tags, features | `observed-moves.cjs` (new) | legal pools, resolving an observation, identity tags, move-dependent model features, the report's opponent table |
| Loader and meta | `meta.cjs` | `loadUsage(..., {observedMoves})`, `createMeta(..., {observedMoves, variants})`, `groupSampler` |
| Fixture identity | `acquisition.cjs` | `opponentIdentity` counts an observed member by its tag |
| Stress panel | `alternate-panel.cjs` (new), `budget.cjs` (`alternateBattles`) | search wiring, standalone CLI, text, report HTML and Markdown |
| Search | `search.cjs` (13 hunks, below), `common.cjs`, `launch.cjs` | `--observed-moves`, `--alternate-panel N` |
| Reports | `report.cjs`, `export-report.cjs`, `absorb-evaluation.cjs`, `neural-report-core.js`, `neural-portable.js`, `neural.js` (`portable-9`) | block, opponent rows, validation, caption line |
| Tools | `rematch.cjs` (`--observed-moves`), `audit-model.cjs`, `compare-architectures.cjs` | read tagged opponents |
| Docs | README sections 2, 4, 6, 8, 11, 12, 13, 14; README-plain; `NEURAL_REPORTS.md`; `usage-template.json` | |
| Tests | `test_usage_export_moves.py`, `observed-moves.test.cjs`, `meta-moves.test.cjs`, `alternate-panel.test.cjs`, `alternate-standalone.test.cjs`, `alternate-viewer.test.cjs`, `search-moves.test.cjs` | |

## 2. The export

For each opponent member of a kept battle (members in canonical order, lead first):

- **fast move**: a human answer first, else a model-resolved answer (`observed.model_answers`, which passed the held-out gate in the learning loop), else the extractor's top inference when its probability is at least .90, else null. `observed.py` `_member` now records where the value came from (`fastMoveSource`: `reviewer`, `model` or `inference`) because the merged catalog value alone cannot tell a certain inference from an answer.
- **charged moves**: the moves the battle's `move` events credit to that Pokémon (`actor` equals the member key, on the member's side), in order of first use, at most two. On the current data the events and the catalog's `chargedMoves` evidence agree for all 11,415 members. Three or more distinct charged moves for one member cannot be right (a detection error); that member keeps none.
- **validation**: every move must exist in `gamemaster.json`, be a fast or a charged move as appropriate and be legal for the exported species, using the vendor's pool rules (`fastMoves`; `chargedMoves` and `extraChargedMoves`; Return for a Shadow-eligible species with level-25 CP at most 1,500; Frustration for a Shadow species). Others are dropped and counted.

Rows that differ only in their movesets are separate rows; a row with no usable move has no `movesets` key. The 2026-10-13 export has 782 rows (781 without movesets; same teams, dates, creators and counts either way) and is 356 KB (190 KB without).

| Coverage, 2,349 opponent members | Members | Share |
| --- | ---: | ---: |
| Observed fast move | 1,774 | 75.5% |
| ... from the extractor's inference at p ≥ .90 / a model-resolved answer / a reviewer | 1,650 / 99 / 25 | |
| At least one charged move seen | 1,069 | 45.5% |
| Fast and charged | 850 | 36.2% |
| Fast move differs from the recommended one | 53 of 1,774 | 3.0% |
| A charged move outside the recommended pair | 111 of 1,069 | 10.4% |
| Moveset differs in some way | 163 | 6.9% |

Battles with any observed move: 773 of 783. Dropped: 575 fast-move inferences under .90 (24% of the candidates), one illegal and one contradictory charged move. The 3.0% is the extractor's output, not measured truth: its fast-move inference is a likelihood over the species' legal moves, and how far its prior leans on the recommendation has not been measured, so it may understate real deviations. The report (`.report.md`) carries the same table.

## 3. The trainer

**Loading** (`meta.cjs`). With `--observed-moves`, `loadUsage` reads each row's `movesets`, validates every move against the species' legal pools (a bad file stops the launch; the same pools as the exporter's, cross-checked against all 300 recommended and 1,498 retained pool movesets) and completes missing slots: the observed fast move or the recommended one; the observed charged moves, then the first recommended charged moves not already present. Charged moves are alphabetical except that a result with the recommended pair keeps the recommended order, so an observation equal to the recommendation is the recommended moveset itself and plays as the plain row. Without the flag the file's `movesets` are ignored entirely, even malformed ones.

**Drawing.** Rows with the same species and different movesets are separate opponents with their own weight, but the sampler draws the species team exactly as before and then picks the moveset variant from the same random number (`groupSampler`). The random stream is therefore identical to a run without the flag: the same teams, order, seeds and components in training, in every sealed panel and in the belief bank, and only the movesets differ. On the real file: 3,000 fixtures at each of three seeds were identical in species, seeds and component. `distinctTeams` is still counted per species team.

**What carries the moves.** The fixture row's `moveset` (`engine-v4-core.cjs` selects `row.moveset[0..3]`), flagged `observedMoveset` with the recommended one in `recommendedMoveset`. The engine, the controller and the worker are untouched.

**Identity.** An observed member is `speciesId@FAST/CHARGED/CHARGED` in `acquisition.cjs` `opponentIdentity` and in the stored observation's `opponent` array. Everything that keys, merges or compares observations by `opponent` (the evidence map, `uniqueFixtures`, the overlap checks of the confirmation, retest, sensitivity and alternate panels, `merge.cjs`, `absorb-evaluation.cjs`, `remap.cjs`) therefore distinguishes fixtures with different movesets with no further change, and a fixture without observed moves has exactly its old identity (tested by key equality).

**Model features.** `opponentInput` resolves a tagged id through `observed-moves.cjs` `rowResolver`. If the pool kept that moveset as a variant, its scouted `features` and `scoutByType` are used exactly. Otherwise the species' recommended row supplies the scout profile (the 24-opponent matchup block) and the per-type coverage, and the 48 move-dependent numbers (indices 25 to 72: fast-move type, damage and energy per turn, duration, charged-move types, costs, powers, buff chances) are recomputed from the moves. This is an approximation: the new moveset's matchups are not simulated. Checked against the pool: the recomputation equals the stored features for 1,627 of the 1,798 species and variant rows (90.5%), equals them up to the order of the two charged-move slots for another 159 (8.8%; the vendor orders them by energy with opponent-dependent tie-breakers), and differs for 12 (0.7%; Morpeko and Aegislash, whose moves follow their form). It only steers which teams are worth simulating; every reported number is a simulated score.

**Belief prior.** `beliefRoster` stays the recommended movesets. The prior is what a player knows before a move is used (public rankings). Giving it the observed set would tell the controller exactly what the opponent will do in the fixture it is playing, and the 2,048-lineup bank comes from the same meta, so it would contain it: that is the information boundary section 5 draws. As for a human, an unexpected move is a surprise until it is used. The bank itself is species ids only and, with the shared random stream, is the same with and without the flag.

**Other metas.** Independent and coherent draws keep recommended movesets. The sensitivity metas are built from the usage file without the option, so they are the recommended-moveset alternative to the run's meta (and `rematch.cjs` and `policy-panel.cjs` default to it; `rematch.cjs` takes `--observed-moves`).

**Record.** `config.observedMoves: true` (resume digest), `meta.description.movesets` says what was done, and `meta.description.observedMoves` holds `fastShare`, `chargedShare`, `differingMemberShare` (weighted by the decayed appearance counts), `differingTeamShare`, `distinctWithMoves`, `distinctMovesetTeams` and `featureMatch` (`distinctMovesets`, `exact`, `approximate`). The report page shows the usual meta line.

**Report.** The portable report appends a row to `table.opponents` for each observed (species, moveset), with the moves it was simulated with and the species' `recommended` moveset, and matches name it by index, so the browser replays the moves a battle used. `neural-report-core.js` allows 2,000 opponent rows; the current export needs 70 extra. `opponent-analysis.json` already lists each final fixture's opponent movesets and now shows the observed ones.

## 4. The alternate-moveset stress panel

`--alternate-panel N` (0 = off, at most 4,096). After the final test, the confirmation and the policy panel, and before the sensitivity panel, the final-tested finalists play one sealed panel of N fixtures from the run's own meta three ways on the same opponent species, order and battle seeds:

| Arm | Opponent members play |
| --- | --- |
| `run` | the run's movesets (recommended, or observed where recorded with `--observed-moves`) |
| `alternate-1` | the best scouted moveset other than the recommended one |
| `alternate-2` | the second best such moveset |

"Scouted" ranks the pool's retained variants of a species by scout score (`prepare.cjs` keeps the top five per species); a species with fewer alternates repeats its last, and one with none keeps its moveset (the pool has none of these). The ranking is by 1-v-1 results, not by how often a moveset is played, and each arm replaces all three members of every fixture at once, so the drop is an upper bound on a moveset surprise, not a prediction.

- **Statistics.** Per finalist: the three scores, each alternate minus `run` with a paired whole-fixture bootstrap band that is simultaneous over the three arms (`paired-stats.cjs` via the policy panel's summary), the worst of the two changes, and what the swap changed (`changedMembers`, `changedFixtures`). Fewer than 256 fixtures is labelled exploratory.
- **Seed and guards.** `panelSeed(seed)` = `seed + 840001` guarded against the screening, final, confirmation, policy, retest, reference, belief and baseline seeds; the sensitivity panel's seeds treat it as reserved; absorbed evidence that used it is refused; the fixtures are checked against the screening, final, confirmation and retest panels and the training evidence (seed first, so a 340,000-observation checkpoint costs one set lookup per observation).
- **Budget.** `budget.cjs` gets `alternateBattles` (finalists × N × 3) in the evaluation reserve, and `finalWork` in the screening share counts it, so the panel moves the end of training earlier and never shortens screening or the final panel. A deadline keeps a common prefix of whole fixtures per arm; fewer than one whole fixture records nothing.
- **Outputs.** `checkpoint.json` (`alternatePanel`, per-fixture `alternateScores`, `config.alternatePanel`/`alternatePanelSeed`), `recommendations.json`, `report.html` (table), `findings.md` (caption), the portable report (`alternatePanel`, validated by `neural-report-core.js`) and a caption line on the finalists card (`neural-portable.js` `alternatePanelCaption`, text identical to `alternate-panel.cjs` `caption`; a test compares them).
- **Standalone.** `alternate-panel.cjs RUN_OR_REPORT --fixtures N` runs the same panel for the finalists of any finished run on a fresh seed that none of the sources used, with the meta flags you give it (use the run's own; its `launch.json` lists them).
- **Cost.** 8 finalists × 64 fixtures × 3 arms = 1,536 battles (about two minutes at the v4 run's 14.4 battles/s); 256 fixtures = 6,144 (about seven minutes). At 128 fixtures the simultaneous band is about ±10 points, so 256 or more is the size to read.

## 5. Measurements, in detail

All with `nice -n 10` and 4 workers on a shared machine (the 1-minute load average was about 16 when checked).

**Defaults unchanged (real engine).** `search.cjs` smoke command (below) on the code at `e6e7cdb` and on this branch, hybrid meta from the 2026-10-13 export (the file carries `movesets`, which the old code ignores). Identical: `observations`, `records`, `battles`, `round`, `screenResults`, `validations`, `baselineResults`, `finalistTeams`, `finalPanel`, `comparisons`, `finalistComparisons`, `fixturePanels`, `beliefPrior`, `models`, the history (minus timing), `recommendations.json` rows, the portable report's table. Only `config.algorithmHash` differs.

**Both flags, smoke** (`--observed-moves --alternate-panel 8`, same command otherwise, 384 battles at 20.6/s, 2 rounds):

- the run drew the same fixtures as the default run (species, seeds, sealed panels), and the 168 fixtures they shared in training included 53 with an observed moveset: all 115 plain ones scored the same and 16 of the 53 observed ones scored differently (only fixtures with observed moves changed);
- 56 of 192 stored observations (29%) name an observed member by its tag; 11 extra opponent rows in the report (311 against the pool's 300);
- the alternate panel: 2 finalists × 8 fixtures × 3 arms = 48 battles; 22 of 24 and 24 of 24 opponent members changed; the primary changed by −12.5 and +12.5 points, both unresolved (simultaneous bands of ±25 to ±50 points at 8 fixtures);
- replay: 60 of 60 saved matches re-simulated from the report alone reproduce their scores, 40 of them against observed-moveset opponents.

**Engine probe.** 16 traced battles of random pool teams against observed-moveset fixtures: in 8 the opponent used an observed non-recommended move in the timeline (for example a Milotic with Dragon Tail). Fast moves show every turn; charged moves are used less often.

**The completed v4 run's finalists** (`team-search-v4-observed-2026-10-12`, read-only; hybrid meta, 2026-10-13 export, half-life 30 days, prior strength 225, 128 fixtures, seed 4242, 3,072 battles in about 125 s per panel). Score with the run's opponents, then change with the best and second alternate (simultaneous 95% band):

| Finalist (lead first) | Recommended opponents | Best alt | Second alt | Observed movesets as opponents | Best alt | Second alt |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Talonflame (Shadow) / Mandibuzz / Bastiodon (primary) | 77.0 | −2.3 [−12.9, +8.2] | −0.8 [−11.3, +9.8] | 77.7 | −3.1 [−13.3, +7.0] | −1.6 [−11.7, +8.6] |
| Magcargo / Charjabug / Mandibuzz | 78.1 | +0.0 [−10.2, +10.2] | +2.3 [−7.8, +12.5] | 77.3 | +0.8 [−9.4, +10.9] | +3.1 [−7.0, +13.3] |
| Talonflame (Shadow) / Mandibuzz / Carbink | 84.4 | −4.7 [−13.3, +3.9] | −2.3 [−10.9, +6.3] | 83.6 | −3.9 [−12.5, +4.7] | −1.6 [−10.2, +7.0] |
| Talonflame (Shadow) / Umbreon / Carbink | 86.7 | −2.3 [−10.5, +5.9] | −1.2 [−9.4, +7.0] | 85.9 | −1.6 [−10.2, +7.0] | −0.4 [−9.0, +8.2] |
| Talonflame (Shadow) / Mandibuzz / Bastiodon (#5) | 80.5 | −3.1 [−12.9, +6.6] | −2.7 [−12.5, +7.0] | 79.7 | −2.3 [−11.7, +7.0] | −2.0 [−11.3, +7.4] |
| Talonflame (Shadow) / Mandibuzz / Carbink (#6) | 80.5 | +0.0 [−8.6, +8.6] | −2.3 [−10.9, +6.3] | 79.7 | +0.8 [−8.6, +10.2] | −1.6 [−10.9, +7.8] |
| Talonflame (Shadow) / Umbreon / Carbink (#7) | 85.2 | −0.8 [−10.2, +8.6] | −4.3 [−13.7, +5.1] | 85.2 | −0.8 [−10.2, +8.6] | −4.3 [−13.7, +5.1] |
| Talonflame (Shadow) / Empoleon / Umbreon | 78.1 | +4.3 [−5.9, +14.5] | −7.0 [−17.2, +3.1] | 77.3 | +5.1 [−5.1, +15.2] | −6.3 [−16.4, +3.9] |

The two "run" columns use the same species, order and seeds; the observed-moveset column differs from the recommended one in 1 to 3 of 128 fixtures per finalist (mean −0.5 points, none beyond ±2.3). Nothing is resolved in either panel (0 of 16 changes each); mean change −1.1 (best) and −2.3 (second) points with recommended opponents, −0.6 and −1.8 with observed ones. Read as a stress test of 8 near-identical finalists at one panel size: it neither shows that these finalists depend on recommended opponent movesets nor that they do not. The scores are not the run's own 83.5%, which was a different meta and panel (section 9 of the README).

## 6. `search.cjs` hunks (small insertions; to re-apply if a merge conflicts)

1. New line after the `selectionTools` requires: `const alternateTools=require('./alternate-panel.cjs'),observedMoves=require('./observed-moves.cjs');`.
2. `createMeta(...)` call: `observedMoves:!!opts.observedMoves,variants:prepared.variants` appended to its options.
3. New line after the line that ends with `retestPanelSeed=searchSeed(seed+retestPanelTools.SEED_OFFSET);`: `alternateFixtures` (validated by `checkSize`) and `alternateSeed` (guarded against the other seeds).
4. `config`: `...(alternateFixtures?{alternatePanel:alternateFixtures,alternatePanelSeed:alternateSeed}:{}),...(opts.observedMoves?{observedMoves:true}:{}),` after the policy panel spread.
5. The sensitivity plan's `reserved:[…]`: `...(alternateFixtures?[alternateSeed]:[]),` after `baselineFixtureSeed,`. **Any other panel seed a merge adds belongs in that list and in `alternateSeed`'s guard list.**
6. A comment and one `const alternatePlan=…,alternateBattles=…;` line before `const activeClock=`.
7. `updateBudget`: `extraBattles:policyPanelBattles,alternateBattles`.
8. `const speciesMap=…` line: `opponentRow=observedMoves.rowResolver(speciesMap,variants)` added; `opponentInput` maps `ids.map(opponentRow)` instead of `ids.map(id=>speciesMap.get(id))`.
9. The observation record: `opponent:observedMoves.opponentIds(panel[w.fixture].team)` instead of `…map(p=>p.speciesId)`.
10. The screening share: `finalWork` adds `+alternateBattles`.
11. Five new lines after the policy panel statement: the panel itself, through the existing `evaluate()` with `commonPanel:true`, before the sensitivity block.
12. `recommendations.json`: `...(state.alternatePanel?{alternatePanel:state.alternatePanel}:{}),` after the policy panel spread.
13. CLI: defaults `alternatePanel:0,observedMoves:false,` after `policyPanel:0,`; help text.

Other shared files: `common.cjs` (`--observed-moves` in `options()`, two names in the `algorithmHash` list), `budget.cjs` (one parameter, one term), `acquisition.cjs` (`opponentIdentity` and one require), `launch.cjs` (two defaults), `report.cjs` (three insertions), `export-report.cjs` (four), `absorb-evaluation.cjs` (one), `meta.cjs` (about ten), `rematch.cjs` (three), `audit-model.cjs` and `compare-architectures.cjs` (two each), `neural.js` (`portable-8` to `portable-9`, which another change may also bump). `algorithmHash` changes, so a checkpoint from before this change will not resume under it; a run started after it is unaffected.

## 7. Limits and open items

- **Frequencies.** The file holds one moveset per observed battle. A species seen once fixes its moves for that fixture; there is no per-species distribution of movesets, and the meta does not mix them. A distribution (and a belief prior that learns it without leaking the fixture's set) is the natural next step.
- **Inference quality.** 24% of fast-move candidates are under .90 and dropped; the 3.0% fast-move deviation may be understated if the extractor leans on the recommendation. Answering the fast-move questions (the "which fast move?" Validate kind) raises coverage and checks the rate.
- **Charged moves are only those used.** 45.5% of members showed one, 36.2% a fast and a charged move; the rest are completed from the recommendation, which can hide an alternate move that was never thrown.
- **Model features are approximate** for 33 of the 70 observed movesets (the scout profile is the recommended moveset's).
- **Sensitivity metas and `policy-panel.cjs`** use recommended movesets; `rematch.cjs` and `alternate-panel.cjs` take the flag. A sensitivity meta with observed moves is not built.
- **The stress panel changes all three members at once** and ranks alternates by 1-v-1 scouting. A one-member-at-a-time or frequency-weighted version would be closer to a real moveset surprise.
- **The completed run's finalists were never exposed to this meta in training.** The standalone panels are re-simulations, not that run's own result.
- **Browser check.** The viewer changes were tested through the real `render()` on a stubbed DOM and through `neural-report-core.js`, and once by hand in the Browser pane (a static server on this worktree, the smoke report imported in Team Rankings): the caption line appears under the finalists chart, and four saved matches against observed-moveset opponents replayed with the page's own v4 adapter to their stored scores. The Teams-view battle list and the comparison dialog were not exercised with observed-moveset opponent rows; they index `table.opponents` by position, so the extra rows should behave like any other, but that is unchecked.

## 8. Commands

Smoke (about a minute and a half each, from `web/`):

```
nice -n 10 node training/team-search/search.cjs --pool training/runs/team-search/pool.json --out training/runs/smoke-moves --hours 0.12 --workers 4 \
  --initial-teams 16 --batch-teams 8 --opponents 8 --screen-teams 4 --screen-opponents 16 --validation-teams 2 --validation-opponents 16 --baseline-count 3 \
  --candidates 200 --rounds 2 --champions none --sensitivity-fixtures 0 --confirmation-opponents 0 --meta hybrid \
  --usage-file training/runs/usage-moves/observed-gl-opponents.json --usage-half-life-days 30 --usage-as-of 2026-10-13 --usage-prior-strength 225 \
  --observed-moves --alternate-panel 8
nice -n 10 python3 -I scripts/yt-harvest/usage_export.py --out training/runs/usage-moves/observed-gl-opponents.json
nice -n 10 node training/team-search/alternate-panel.cjs training/runs/RUN --fixtures 128 --workers 4 --meta hybrid --usage-file FILE --usage-half-life-days 30 --usage-as-of DATE --usage-prior-strength N [--observed-moves] --out training/runs/alternate.json
```

Full scale, for later (an otherwise idle machine; each run takes the night). Export first (it prints the as-of date and the prior strength for 75% observed), then two runs on the same seeds so their sealed panels have identical species and seeds and differ only in the opponents' movesets:

```
python3 -I scripts/yt-harvest/usage_export.py
USAGE="$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json"
# A: recommended opponents, then the stress panel
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v4-observed-YYYY-MM-DD --seed 20261013 --validation-seed 777001 \
  --usage-file "$USAGE" --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N --alternate-panel 256
# B: observed movesets, then the stress panel
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v4-moves-YYYY-MM-DD --seed 20261013 --validation-seed 777001 \
  --usage-file "$USAGE" --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N --observed-moves --alternate-panel 256
# equal-footing comparison of the two primaries and finalists under the observed movesets
node training/team-search/rematch.cjs training/runs/team-search-v4-observed-YYYY-MM-DD training/runs/team-search-v4-moves-YYYY-MM-DD --finalists --fixtures 512 --workers 12 \
  --meta hybrid --usage-file "$USAGE" --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N --observed-moves --out training/runs/rematch-moves.json
# the stress panel for the completed 2026-10-12 run, without a rerun
node training/team-search/alternate-panel.cjs training/runs/team-search-v4-observed-2026-10-12 --fixtures 256 --workers 12 --meta hybrid --usage-file "$USAGE" \
  --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N [--observed-moves] --out training/runs/alternate-v4-observed.json
```

Start B only after A has finished (each uses every core). `--alternate-panel 64` is a quick pass (1,536 battles; exploratory); 256 (6,144 battles, about seven minutes) is the size to read. The A/B pair is a search comparison (equal budget, same seeds), so judge it as section 8 and EVALUATION_PROTOCOL.md describe: the sealed panels differ in movesets, and the rematch under the observed movesets is the paired answer.
