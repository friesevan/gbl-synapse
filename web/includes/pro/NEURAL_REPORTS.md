# Current v4 simulator and staged search

Start a fresh run with `node training/team-search/launch-next.cjs --hours 8`.
Results go to `training/runs/team-search-v4`; use a different `--out` directory
when that directory already contains a checkpoint. Status and stop commands take
that directory as their argument. Import its `report.pvpteams.json.gz` in the site.

The current simulator caches fixed metadata, initializes selected forecast moves,
and skips graphical bookkeeping during headless training. Staged acquisition gives
all candidates eight common opponent fixtures, then expands the promising or
uncertain half. Final evaluation retains its independent opponent panel.

Read [the current guide](../../training/team-search/README.md) and
[performance measurements and compatibility](../../training/team-search/PERFORMANCE.md).
The exact verified simulator implementation preserves historical v4 replay IDs;
changed search settings require a new run or compatible v4 warm-start.

## Previous champions in a report

A run started with `--champions` (the launcher adds the published v1 and v3 primaries and every completed
matching run automatically) tests earlier winning teams on its final panel as a fourth baseline group. In the
report this is `baselines["previous-champions"]` (the same shape as the other groups: `delta`, `interval95`,
`fixtures`, `baselineTeams`) plus an optional top-level `champions` block, `null` when the run had none:

- `champions.teams[]`: `team` (three indexes into `table.variants`, lead first), `label`, `sources[]`
  (`source`, `role` primary or finalist, `rank`, the source's own `finalScore`, which is not comparable);
- `champions.skipped[]`: compositions not mapped into the run's pool, with `reason` and `detail`;
- `champions.comparisons`: `outcome` (`primary-better`, `tie-rediscovered`, `unresolved`, `champion-better`),
  `summary`, `fixtures`, and `entries[]` with each champion's final-panel `score`, `delta` (primary minus
  champion), simultaneous `interval95` and `verdict` (`primary-better`, `challenger-better`, `unresolved`,
  `same-team`).

Champion teams are ordinary rows in `table.rows` with `baseline: "previous-champions"`, so their matchups can be
inspected and replayed like any other tested team. The validator in `neural-report-core.js` checks the block when it is
present; reports without it are unchanged and remain valid. See
[the evaluation protocol](../../training/team-search/EVALUATION_PROTOCOL.md) for how to read the comparison.

## Meta sensitivity in a report

A run started with `--sensitivity-fixtures N` (default 128; 0 disables) re-simulates its final-tested finalists, after the
final test, under alternative opponent metas on sealed panels of their own. The report carries it as the optional top-level
field `sensitivity` beside `finalPanel` (`null` or absent when the run had none; schema stays 1):

- `requestedFixtures`, `fixtures` (the common completed prefix, equal on every meta), `complete`, `groups` (`finalists`, or
  `all` when baseline and previous-champion teams were included), `resamples`, `seed`, `method`;
- `metas[]`: `id` (`independent-1.25`, `coherent`, `observed`, `observed-without-top-creator`, `independent-1.0`,
  `independent-1.5`; the observed ones need a usage file), `label`, `mode`, `weightPower`, `observedShare`, `seed` (derived from
  the validation seed, distinct from every other panel), `fixtures`, `components` (fixtures drawn per meta component), and for
  observed metas `observedCount`, `distinctTeams`, `creators`; the leave-one-creator-out meta carries the removed creator's
  weight share and a short hash, never the name;
- `teams[]`: `team` (three indexes into `table.variants`, lead first), `kind` (`finalist`, or a baseline group), `primary`,
  `finalScore` (the run meta's final-panel score, for reference only), `scores[]` (mean per meta, in `metas` order),
  `standardErrors[]`, `ranks[]` (1 = best among the listed teams, per meta), `mean`, `min` and `minMeta`, `max` and `maxMeta`,
  `spread` (max minus min), `spreadInterval95` (bootstrap over fixtures within each meta), `noiseSpread` (the median spread
  that fixture noise alone would give if the team scored the same under every meta) and `meanMinusSpread` (recorded for study;
  it is not used for selection);
- `summary.topByMeta[]`: the index in `teams` of the best team on each meta.

Mean, min and spread are over the alternative metas only. The spread of a team measured on 128 fixtures per meta contains
roughly 7 to 9 points of fixture noise (4 to 5 at 512), so read it against `noiseSpread`. Scores under different metas are not comparable as
strength. The primary stays the screening winner. The validator in `neural-report-core.js` checks the block when present;
`neural-portable.js` shows it as a table in Search Performance and as one line under each finalist's bar
("across 6 metas: min 62.5%, spread 14.1 points"). `training/team-search/sensitivity.cjs` re-runs the panel for a finished
run or report; see its header and [the evaluation protocol](../../training/team-search/EVALUATION_PROTOCOL.md).

The following v3 instructions are historical.

# Neural team search v3: run, import and transfer

## Run tonight

From the `web/` folder of GBL Synapse:

```sh
node training/team-search/launch-next.cjs --hours 8
```

Uses all available cores (12 on the M2 Max), keeps macOS awake, and stops automatically. It starts a fresh `training/runs/team-search-v3` experiment with the prepared top-300 Pokémon / up-to-five-movesets pool. Existing output is protected: use `--resume` with unchanged code/settings, or `--out training/runs/my-new-run` for another experiment. No long training run was started during this update.

```sh
node training/team-search/status.cjs training/runs/team-search-v3
tail -f training/runs/team-search-v3/training.log
node training/team-search/stop.cjs training/runs/team-search-v3
```

The stop command checkpoints after active work. The deadline reserves time for screening and final testing; active battles and export can finish shortly afterward.

## Display a run

The trainer automatically writes **`report.pvpteams.json.gz`** inside its run directory. In PvPoke Pro → Team Rankings, click **Import Report** and select this file. Keep it to reopen after a browser reload. Importing processes data locally; it does not upload the report to a shared database or change the published archive.

A manual export is also available:

```sh
node training/team-search/export-report.cjs training/runs/team-search-v3
```

The file contains all saved teams and matchup outcomes, frozen species/move/search metadata, training history, timing, meta assumptions, simulator/data fingerprints, completed evaluation panels, and finalist uncertainty. It excludes model tensors, machine paths, credentials and the raw checkpoint. A stopped run can be imported, with incomplete validation clearly identified.

The UI provides rankings, search, lead/backline columns, moveset badges, team comparisons, performance graphs, and matchup replay. Replay is allowed only when the report's simulator and data hashes match the installed adapter. A mismatch still permits viewing saved evidence; never simulate it with the legacy engine or label a reconstruction as verified.

## What changed

- Battle correctness: isolated Champion scouting from live battle state and RNG; fixed duplicated native buffs, transformed-form CPM, switch resets, cooldown tracking, switch-clock elapsed time, illegal responses and asymmetric forced replacements.
- Search: deliberate same-species moveset mutations and lead changes; preserved random exploration during leader retests.
- Evaluation: all screened teams share an opponent panel; finalists and baselines share another. Deadline truncation retains a common completed prefix instead of favoring the first team. The primary is selected before the final test. Simultaneous paired uncertainty distinguishes evidence from unresolved small differences.
- Meta: optional dated observations decay exponentially, with explicit as-of date and shrinkage toward a synthetic prior. Efficient sampling preserved 10,000 identical seeded normal-pool fixtures; a local sampling benchmark improved about 4.8×. This is not a claim that battle simulation is 4.8× faster.
- Model: removed redundant work without changing numerical training output. A whole-team bootstrap experiment worsened two held-out folds, so the existing fixture bootstrap remains the production default. No demonstrated overall win-rate improvement is claimed before the new run.
- Portability: versioned compressed report and a browser replay adapter generated from the exact v3 trainer source, with parity tests against Node simulation.

## Keep historical results separate

Do **not** reuse v1/v2 battle labels or trained model weights in v3: mechanics changed, so their targets describe a different simulator. The warm-start guard rejects incompatible versions/mechanics/meta. The published v1 report stays an archive.

The unchanged exhaustive 1v1 scouting pool is reused. Old winning **team compositions** remain useful candidates for fresh testing, but their old scores are not evidence of v3 performance. Old labels are useful for software regression and controlled model-method research, not as current v3 training truth. Compatible v3 evidence can be merged with version-aware tools and fresh held-out evaluation seeds.

## What would improve results most next

1. Recent observed **joint team** frequencies, stratified by cup/rating/date; independent Pokémon weights do not capture actual cores and leads.
2. Hidden-information policies and beliefs over unrevealed teammates/moves. The current controller knows the whole opposing roster.
3. Longer/full-team continuation, delayed switches/catches and diverse charge/shield policies. Current switching is bounded minimax with a heuristic terminal value.
4. Independent seeds and meta-sensitivity tests, larger common finalist panels, and controlled alternate-moveset comparisons. Small score gaps may be noise.
5. Team-context moveset retention and alternative IV builds; the candidate pool is still limited to five 1v1-scouted sets per entry.

The neural network predicts outcomes and guides team selection; it does not learn optimal battle play or establish real-player win rates.

## Other environment: copy/paste instructions

> Integrate the provided neural v3 report support into the existing Team Rankings page (PvPoke Pro › Team Rankings, formerly Full Team Neural Network). Preserve the historical v1 archive. Use `includes/pro/neural-report-core.js` to validate and decompress `report.pvpteams.json.gz`, then render it through `NeuralPortable.render(report)` after the existing TeamBrowser/search/detail dependencies load. The implementation is in `neural-portable.js`; `neural.js` adds the Import Report selector. Copy the matching replay adapter, manifest, lookahead and worker files listed below. Do not recompute rankings or mix reports. Require matching mechanics/data hashes for replay. Test import, team search, a stored matchup replay, comparisons, charts and switching back to the v1 archive. Follow this document's schema and keep all imported content as text, never executable code.

Viewer files under `includes/pro/`:

- `neural.js`, `neural.css`, `neural-report-core.js`, `neural-portable.js`
- `team-browser.js`, `team-comparison.js` (retain existing comparison-core/search/detail dependencies)
- `team-replay-v3-runtime.js`, `team-replay-v3-worker.js`, `team-replay-v3-manifest.js`, `team-lookahead-v3.js`
- `NEURAL_REPORTS.md`

Keep the same `includes/pro/data/` Game Master and `includes/pro/vendor/` battle engine/training AI files for matching replay. If the other environment updates them, regenerate the adapter from its matching trainer with `node scripts/build-neural-replay.cjs`, run `node --test training/team-search/replay-v3.test.cjs`, and retain the old adapter for old reports or disable mismatched replay. Imported JSON never supplies executable code.

### Data contract (schema 1)

Top level: `format: "pvp-team-report"`, `schemaVersion: 1`, `id`, `engineVersion`, `mechanicsHash`, `dataHash`, `fixtureMode` (`single` for v3, `paired` for v1), `engineOptions`, `meta`, `population`, `runtime`, `history`, `screenPanel`, `finalPanel`, `finalistComparisons`, `snapshot`, `table`.

`table.rows` are team records; each `team` is three indices into `table.variants`, lead first. `table.matches[row.id]` has `training`, `screen`, `test`, `baseline` arrays. Each matchup is `[opponentIndices, battleSeed, score]`; opponentIndices reference `table.opponents`. Score is win=1/draw=0.5/loss=0; v1 averages mirrored games, v3 uses one canonical game. Identical v3 team mirrors have a symmetric 0.5 expectation and show a representative physical battle.

Finalist intervals compare `primary − challenger`, using shared fixtures and adjustment across finalists. Preserve the screening-selected primary even if another finalist has a higher final point estimate. `finalPanel.completedFixtures < requestedFixtures` means partial final evidence.

For a redesigned UI, this contract is sufficient to render scores, charts and comparisons without Node or training code. The browser adapter is only needed to reconstruct battle graphs. Keep results from different engines/metas in different reports.

## Reliability and speed refinement (October 10)

The v2 overnight run hibernated at 1% battery after about 61 minutes. The watchdog expired on waking; screening was never reached. Duration-based `--hours` runs now exclude event-loop suspension gaps exceeding 30 seconds, and the battle watchdog allows 120 awake seconds. `--until` remains an absolute wall-clock deadline. Long main-thread stalls are indistinguishable from suspension and can also extend a duration run; keep the Mac on AC power. Runtime metadata records excluded time.

Worker reuse was benchmarked on identical seeded outcomes. The controlled 8-vs-32 comparison initially measured 8.434 vs 8.415 seconds for 144 fixtures (negligible), with higher memory for reuse; the existing eight-battle restart policy remains. Workers can additionally recycle on measured heap pressure. Battle mechanics and learned targets are unchanged. Search code fingerprints prevent resuming across algorithm changes; use a fresh output directory.

## Completed refined run

The October 10 refined run finished at 6:51 p.m. Eastern, exit code 0, with 265,728 battles and 3,647 training teams. All 24 screening candidates completed 512 fixtures; eight finalists and twelve baselines completed another common 512-fixture panel. The screening-selected primary (Shadow Houndoom lead / Melmetal / Mimikyu) scored 73.34%, counting draws as half wins. Several finalist differences remain unresolved under the simultaneous bootstrap. The hosted viewer defaults to this report and keeps earlier archives selectable. The missing `meta-1500.json` export dependency was restored in the Desktop installation, and the report was regenerated successfully from the unchanged checkpoint.

## Reading Search Performance

The performance view computes its analysis from the loaded report, rather than using a fixed success claim. The final baseline chart compares the preselected primary with baseline group means (primary score minus the saved paired delta), on the common final panel. Each baseline group contains only a few teams; this is not an equally budgeted optimizer comparison.

New-team suggestion curves use a trailing, team-count-weighted average of up to ten rounds. Early/middle/late summaries exclude initialization and split neural rounds into quarters/half. The leading training estimate is the saved `bestTraining` field for the selection leader; it is not a monotonic best-so-far curve or independent validation. Held-out prediction error is interpreted relative to the constant-prediction baseline in the same round. Changes across rounds cannot be read as a controlled learning curve because the held-out population changes.

Finalist bars show common-panel scores; the simultaneous paired uncertainty table determines whether a difference is resolved. Draws count as half a win. Simulated scores are conditional on the estimated meta, controller and data snapshot, not measured live-player win rates. Historical reports remain separate.

### Repeated replay safety

The v3 replay generator now bundles the trusted simulator into the scope of each `replayCore` call. Every encounter gets fresh class declarations and singleton state, matching the trainer's isolated VM. Re-importing global scripts on each encounter previously raised `Identifier 'DamageMultiplier' has already been declared` on the second battle in a comparison worker. This viewer fix does not change trainer mechanics or invalidate report hashes. Comparison batches skip trace collection; individual battle replays retain their graphs. Regression checks cover several fixtures and a subsequent request in the same worker, as well as exact trainer parity.

## Explaining a team comparison

V3 matched comparisons now collect viewer-only resolved attack observations: attacker and target identities, damage values, HP before/after, energy before/after, shield use and direct knockouts. `Explain this comparison` reconstructs an evenly spaced subset of up to 64 common fixtures and verifies outcomes against the displayed scores before interpreting them. A newly run matched comparison includes these observations automatically. Imported report files remain data-only; executable replay code comes from the site's trusted, hash-matched adapter.

The explanation distinguishes move cost/timing and type-bonus damage potential from observed attack use, shields and direct knockouts. Aggregate numbers describe the sampled replay panel; target/game-state differences prevent treating per-use damage averages as a controlled damage experiment. A changed move can also alter the controller's decisions without being fired. Changed battle examples identify the first differing action sequence and link to both replays; they do not claim a single decisive causal event.

Battle graphs use separate HP tracks for each of the six Pokémon, a common battle-turn axis, attack markers, team-level shield/switch/faint markers, visible attack ledgers and linked turn inspectors. This avoids six overlapping lines and misleading independent time scales. Viewer observation fields do not change trainer outcomes or report mechanics hashes; exact replay parity remains tested. Older archives lack this detailed attack context and explicitly report that limitation.

## Next acquisition refinement (October 10)

New v3 runs use `interaction-neural-v6-promising-exploration`: mean-plus-disagreement exploration, systematic retained-moveset/lead neighborhoods, and rotating contender retests. Simulator mechanics and replay hashes are unchanged. Portable reports include `search.algorithm`, `search.exploration`, `search.localNeighborhoods`, and `search.retests`; older bundles may omit these fields. Their historical results must retain the historical labels. Compatible old raw labels can supply training evidence for a new report, with old test seeds excluded from its fresh tests. See `training/team-search/REFINEMENT_FINDINGS.md` for measured diagnostics; this patch is not a new final team result.

## Observation-limited v4 reports

v4 requires fresh labels. It uses `training/engine-v4.cjs`, `next/lookahead-v4.js`, and `next/observations.js`; v3 engine files and replay adapter are retained. `engineVersion` is `neural-team-search-v4`, fixture mode is `single`. Portable `engineOptions` now includes the exact **public** `beliefRoster`, finite joint `beliefTeams` prior bank, and `beliefSamples` used in training. These priors are generated separately from actual battle fixtures and conditioned only on observations. They are required to reproduce seeded decisions.

Other environments should copy `neural-report-core.js`, `neural-portable.js`, `neural.js`, and all `team-replay-v4-*` files into their `includes/pro` directory. The v4 importer validates prior sizes and values and selects the v4 worker/manifest. Do not rename a v3 report or overwrite its replay adapter. `scripts/build-neural-replay-v4.cjs` regenerates trusted replay code from the exact trainer. Imported files contain data only. The schema remains 1 with an additional accepted engine version.

No scores from the old reports are reused as v4 labels. Their team identities can be initial hints via `--seed-teams OLD_CHECKPOINT`; those teams are re-simulated. The launcher rejects old-version warm starts before starting a detached process. See `training/next/OBSERVATION_CONTROLLER.md` for decision inputs and forecasting limits.
