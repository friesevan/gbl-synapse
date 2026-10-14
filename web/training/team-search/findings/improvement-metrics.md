# Improvement metrics: findings and measurements (2026-10-13)

Question from the owner: *is it as simple as automatically including the previous victors to see whether their performance can be beaten, if the experiment setup is the same?*

**Answer.** Almost. Including the previous victors is the right comparator and is now automatic: they join the final panel as a fixed baseline group (`previous-champions`) and are re-simulated on the same sealed fixtures as the new primary, so the comparison is paired and none of it can be tuned. It answers "did the search find a better team under these assumptions" only when the simulator, controller, meta and pool are unchanged, the comparison is paired on the sealed panel, and the difference is larger than the interval (about 4 points for one comparison and 5 against several, at 512 fixtures). It does not suffice when the assumptions changed (scores under different assumptions say nothing about which assumptions are better), when the new primary simply is a previous champion again (a tie by construction, not a failure; and not evidence of search strength if the search was handed that team as a hint), when the difference is inside the interval, or when the change is to the search itself (one run per arm cannot separate a better algorithm from a lucky seed). The decision procedure for each class of change is in [EVALUATION_PROTOCOL.md](../EVALUATION_PROTOCOL.md).

All numbers below are exploratory or smoke-scale evidence that the tools work. None is an accuracy claim about Team Rankings.

## What was built

| Piece | Files | Notes |
| --- | --- | --- |
| Previous champions | `champions.cjs`, hunks in `evaluation.cjs`, `search.cjs`, `launch.cjs`, `launch-next.cjs`, `report.cjs`, `export-report.cjs` | `--champions FILE[,FILE...]`, `--champions-scope primary\|finalists`; composition parsing from portable reports (validated by `neural-report-core.js`), the v1 archive, `recommendations.json` or a run directory; pool mapping with reasons; the `previous-champions` baseline group; per-champion simultaneous comparison with `same-team` (rediscovery) handling; `launch-next.cjs` adds the published v1 and v3 primaries and every completed matching run |
| Report surfaces | `report.cjs`, `export-report.cjs`, `neural-report-core.js`, `neural-portable.js`, `NEURAL_REPORTS.md` | `report.html` and `findings.md` sections, `recommendations.json` and portable-report `champions` block, viewer baseline chart and champion table, validator |
| Equal-footing rematch | `rematch.cjs`, `paired-stats.cjs` | primaries or all finalists of two or more runs or reports on one fresh panel; paired bootstraps; simultaneous bands over all pairs; JSON and table; `--print` |
| History comparison | `compare-history.cjs` | two `history.jsonl` files at matched cumulative battles; five criteria with verdicts |
| Protocol | `EVALUATION_PROTOCOL.md`, README section 8 paragraph, section 12 row, section 13 commands, `README-plain.md` paragraph | |

Tests added (all in `training/team-search/`): `champions.test.cjs` (11: composition parsing from every source type, pool mapping and skip reasons, merge and dedupe, run discovery, the baseline group, `compare()` on the group, champion-by-champion outcomes), `champions-search.test.cjs` (a full search with simulated battles: the group reaches checkpoint, `recommendations.json`, `report.html`, `findings.md`, the portable report and a resume, and adding champions changes neither the search nor the primary's score), `champions-viewer.test.cjs` (6: the viewer's baseline chart, sentence and champion table, the real `render()` run on a minimal DOM with and without champions, and the report validator), `rematch.test.cjs` (7: statistics, argument parsing, seeds, the pipeline with an injected battle function), `compare-history.test.cjs` (8: synthetic histories, matched budgets, effect floors, strict input, command line).

## Measurement 1: rematch of the v1, v3 and v4 primaries (exploratory, 64 fixtures)

`rematch.cjs` on the three published primaries, 64 fixtures, `--workers 4` under `nice` on a machine with a load average above 20, 192 battles in 43 to 44 seconds each. Same engine (mechanics hash 1b33a32b427c, the v4 observation-limited controller). **64 fixtures is exploratory**: the simultaneous band over three teams is 17 to 19 points wide. The panel seeds are fresh random draws, recorded in the saved JSON.

| Primary (lead first) | Own final score, own assumptions | Hybrid synthetic meta (seed 577963626) | Observed meta, 75.1% observed (seed 750907886) |
| --- | --- | --- | --- |
| v4: Talonflame (Shadow) / Mandibuzz / Bastiodon | 83.5% (512 fixtures, v4, observed) | 81.3% (SE 4.9) | 81.3% (SE 4.9) |
| v3: Houndoom (Shadow) / Melmetal / Mimikyu (Busted) | 73.3% (512, v3 controller, synthetic) | 71.9% (SE 5.7) | 78.1% (SE 5.2) |
| v1: Melmetal / Jumpluff / Quagsire (Shadow) | 68.3% (512, v1 full information) | 63.3% (SE 6.0) | 42.2% (SE 6.2) |

- Hybrid meta: no pair separates under the simultaneous band (radius 18.8 points). The v4 over v1 gap (+18.0) lies outside its single-pair interval (+2.3 to +33.6) but inside the simultaneous band (-0.8 to +36.7): resolved if it were the only comparison planned, unresolved as one of three.
- Observed meta (the 75.1% observed share comes from 540 observed appearances; component mix of the panel: 48 observed, 11 independent, 5 coherent): v4 and v3 are tied (+3.1, band -14.1 to +20.3); v1 is clearly below both (v4 minus v1 +39.1, v3 minus v1 +35.9; bands exclude zero; radius 17.2).
- The own final scores in the third column are not comparable with each other. The v1 team's 68.3% in its own run is 42.2% on the observed meta under the v4 controller; that is the case for an equal-footing rematch rather than for quoting old numbers.
- Reading limit: 64 fixtures cannot rank v4 against v3. A 512-fixture rematch resolves about 4 points (single pair) to 5 (several).

Files (gitignored): `web/training/runs/measure/rematch-hybrid.json` and `rematch-observed.json`; reprint with `node training/team-search/rematch.cjs --print FILE`.

## Measurement 2: smoke search with `--champions`

`search.cjs` at smoke scale (`--hours 0.25 --workers 4 --initial-teams 16 --batch-teams 8 --opponents 8 --screen-teams 4 --screen-opponents 16 --validation-teams 2 --validation-opponents 16 --baseline-count 3 --candidates 200 --rounds 2 --seed 4242 --validation-seed 880001`), once without and once with `--champions` set to the v1 archive, the v3 report and the v4 run directory (primaries):

- Three champions mapped into the pool exactly (every member `exact`), none skipped; the final panel grew from 5 to 8 teams (two finalists, three generated baselines, three champions) and the run played 384 instead of 336 battles (3 champion teams x 16 fixtures = 48 more).
- The group appears everywhere: `state.comparisons["previous-champions"]` (group comparison; `baselineTeams: 3`), `championComparisons` (three entries, simultaneous bands), `recommendations.json` (`champions`, `championComparisons`, `comparisons`), `report.html` ("Previous champions" section and three rows in the baseline table), `findings.md` (champion lines), the portable report (`baselines["previous-champions"]`, `champions` block, three rows with `baseline: "previous-champions"`; accepted by `neural-report-core.js`), and the viewer functions that draw the chart (eight bars: selected team, three simple groups, the champion average and one bar per champion) and the champion table.
- Adding champions changed nothing else: records, observations, fitted models, screening results, final results of the two finalists and of the three generated baselines are byte-identical with and without (primary final score 37.5% both times; `config` equal). That is the property that makes the group safe to add to every run.
- Smoke-scale outcome (16 final fixtures, so not an accuracy claim): the smoke primary scored 37.5% against champions at 62.5%, 56.3% and 68.8%; every per-champion verdict is unresolved, as 16 fixtures give a band of about 40 points.
- The automatic list for `launch-next.cjs` was checked against the real run directories (a copy of the v4 run's `recommendations.json`): v1 archive, v3 report and the v4 run, in that order, with the launching run's own output directory excluded and smoke-scale runs (final panel under 256 fixtures) never qualifying.

A second plain smoke run with the same seeds reproduced the first byte for byte (the class (a) check of the protocol).

## Measurement 3: `compare-history.cjs` on real histories (demonstration, not an A/B)

The v4 observed run's `history.jsonl` against itself gives no difference on every criterion (z 0.0), as it must. The embedded history of the published v3 run against the v4 run, at matched battles (243,200 battles shared; 154 against 277 rounds):

| Criterion | v3 | v4 | v4 - v3 | Verdict |
| --- | --- | --- | --- | --- |
| Neural proposal quality | 59.7% | 74.5% | +14.9 pp | improvement |
| Held-out team error vs constant | 74.4% | 64.9% | -9.6 pp | regression |
| Best training score (indicative) | 68.3% | 85.4% | +17.1 pp | improvement |
| Teams labelled | 3,647 | 6,476 | +2,829 | improvement |
| Battles per labelled team (derived) | 66.7 | 37.5 | -29.2 | improvement |

Neither run is a controlled A/B for the search: the controller, the meta and the acquisition all changed together, so these are different assumptions and the protocol would not accept the verdict as evidence of improvement (class (c)). It is a demonstration of the tool, and of two warnings it prints. The context rows show the random-proposal control at 34.5% against 34.2%, so the panels were about equally hard for random teams, which supports comparing the neural picks at all. And the z values (6 to 40) use within-run noise only; the held-out error criterion has a tiny within-run spread (its curve is smooth) and so a huge z for a 9.6-point difference between two different held-out sets; the 2-point effect floor, not the z, is what keeps it honest, and seed-to-seed variation is not measured with one run per arm.

## Measured interval widths (v4 final panel, 512 fixtures)

From `recommendations.json` of the completed v4 run: group baseline intervals have half-widths 3.8 to 4.0 points; the simultaneous band over the seven primary-versus-finalist comparisons has half-width 5.1 points (6.1 for all 28 pairs of the eight finalists); the paired standard deviation of per-fixture differences between the primary and the other finalists was 0.28 to 0.48 (median 0.43); pairing narrows a single interval by a factor of 1.0 to 1.9 (median about 1.2) against an unpaired one; every finalist difference (-3.2 to +2.9 points) was unresolved.

## Verification

- From `web/`: `node --test training/*.test.cjs training/next/*.test.cjs training/team-search/*.test.cjs` passes 142 of 142 (109 existing plus 33 new); `node --test tests/docs.test.cjs` 15 of 15; the viewer and report tests `pro.neural-performance`, `pro`, `pro.team-comparison`, `pro.search`, `pro.observed` and `pro.weights` 60 of 60; `tests/theme.test.cjs` and `tests/app-tabs.test.cjs` 24 of 24.
- No engine, lookahead, observation or worker file was touched; the mechanics hash is unchanged (1b33a32b427c).

## `search.cjs` hunks (to re-apply if a merge conflicts)

1. After the `acquisition.cjs` require (new line): `const {loadChampions,championComparisons}=require('./champions.cjs');`
2. After the resume/warm-start checkpoint line, before the "Historical labels may already contain" comment (two new lines): register `state.champions` from `opts.champions`/`opts.championsScope` when the state has none (a resumed run keeps its checkpoint's), log the mapping, and define `const championCount=state.champions?.teams.length||0;`.
3. `updateBudget`: `baselineCount` becomes `baselineCount:baselineCount+championCount` in the `trainingBudget({...})` call.
4. Screening limit: `finalWork=(validationTeams+baselineCount)*validationOpponents` becomes `(validationTeams+baselineCount+championCount)*validationOpponents`.
5. Final panel: `baselineTeams(prepared,baselineCount,baselineFixtureSeed)` gains the fourth argument `{champions:state.champions?.teams}`.
6. Comparison kinds array gains `'previous-champions'`.
7. After `state.finalistComparisons=compareFinalists(...)`: `state.championComparisons=championComparisons(state.validations[0],state.baselineResults,state.champions,{seed:seed+800003});`
8. Final `recommendations.json` report literal: `champions:state.champions||null,championComparisons:state.championComparisons||null` after `finalistComparisons:state.finalistComparisons,`.
9. CLI defaults and help: `champions:'',championsScope:'primary'` in the `options({...})` call and `--champions`/`--champions-scope` in the help string.

Other edits outside `search.cjs`: `evaluation.cjs` (`baselineTeams` fourth parameter), `launch.cjs` (two option defaults), `launch-next.cjs` (automatic champions, logged), `report.cjs` and `export-report.cjs` (champion sections), `absorb-evaluation.cjs` (clears `champions` and `championComparisons`), `neural-report-core.js` (optional `champions` validation), `neural-portable.js` (`baselineChart`, `baselineSentence`, `championTable`, baseline chart and champion table), `NEURAL_REPORTS.md`, `artifact/manifest.txt` (ships `EVALUATION_PROTOCOL.md`).

Because `algorithmHash` digests `search.cjs` and `evaluation.cjs`, a checkpoint from before this change will not resume under it; runs started after it are unaffected. A run without `--champions` produces the same checkpoint config as before apart from that hash.

## Open items

- Time-to-champion (battles until a search first finds a known good team) is not measurable from `history.jsonl`, which records the training leader's score and not its identity.
- Seed-to-seed variance of the search is unmeasured until at least two seeds per arm exist; the protocol asks for them before small gains are claimed.
- `policyPanel` and `sensitivity` (realism metrics for assumption changes) belong to other work in progress and are referenced by their expected names only.
- `rematch.cjs` always uses the current v4 controller and can switch only the meta; comparing controllers means running it in a checkout of each version with the same seed.
- The champions' own final scores are shown for context but are never compared with the new primary's.
- A 512-fixture rematch of the v1, v3 and v4 primaries has not been run (the measurement above is 64 fixtures by design).

## Full-scale commands to run later

From `web/`, on an idle machine:

```sh
# A run that tests the earlier winners automatically (published v1 and v3, plus every completed run with this pool)
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v5 --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N

# An explicit list, or none
node training/team-search/launch-next.cjs --hours 8 --champions includes/pro/data/team-search.json,includes/pro/data/team-v3-refined.pvpteams.json.gz,training/runs/team-search-v4-observed-2026-10-12
node training/team-search/launch-next.cjs --hours 8 --champions none

# The equal-footing test of two finished runs (512 fixtures; use the meta of the claim)
node training/team-search/rematch.cjs training/runs/RUN_A training/runs/RUN_B --finalists --fixtures 512 --workers 12 --meta hybrid --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N --out training/runs/rematch-A-vs-B.json

# Matched-battle history comparison
node training/team-search/compare-history.cjs training/runs/RUN_A training/runs/RUN_B --labels old,new --json training/runs/history-A-vs-B.json
```

## Full-scale results (2026-10-14)

512-fixture rematch of the v1 and v3 finalists and the v4 finalists under the observed meta (`rematch-512.json`, seed 237547096): v4 finalists 76.1–83.6%, all resolved above the v1 primary (57.1%); v3 primary 64.4% unresolved against it; v1 finalist 5 (Melmetal / Guzzlord / Stunfisk) 68.7% resolved above the v1 primary; simultaneous half-width 10.3 over 276 pairs. Scores from different runs are only comparable this way.
