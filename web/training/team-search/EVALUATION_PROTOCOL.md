# Evaluation protocol: telling an improvement from noise

This is the decision procedure for the question "did this change make Team Rankings better?". It is written for three kinds of change (speed or refactor; search, acquisition and model; simulator, controller and meta), because each needs different evidence, and for the statistics that apply to all of them. The technical reference is [README.md](README.md); section 8 there summarises this page. The tools it relies on are described in section 2.

Every score in this system is a simulated expected score under one pool, one opponent meta, one controller and one pinned engine. A claim of improvement therefore always has the form "under these assumptions, on these untouched opponent fixtures, A is better than B by this much, with this interval". Anything weaker than that is a tie.

## 1. Can we just include the previous victors?

The owner's question: *is it as simple as automatically including the previous victors, to see whether their performance can be beaten, if the experiment setup is the same?*

**Almost, and the almost matters.** Including the previous victors is the right comparator and it is now automatic: `--champions` (and `launch-next.cjs`, which supplies the published v1 and v3 primaries and every completed matching run) adds their compositions to the new run's final panel as a fixed baseline group, `previous-champions`. They are re-simulated on the same sealed 512 fixtures as the new primary, so the comparison is paired, and they are fixed before the test, so nothing about it can be tuned. Their old final scores are never reused: those came from other opponent fixtures (a few points of panel luck each way) and possibly other assumptions, so they cannot be compared with the new primary's. Their *re-simulated* scores share the new primary's panel and assumptions, and no part of the new run was tuned on them.

When that alone suffices. It answers "did this search find a team better than the old champions **under these assumptions**" when all of the following hold:

1. **Same assumptions.** Same simulator (`mechanicsHash`), controller settings, opponent meta (including the usage file, as-of date, half-life and prior strength), and same pool hash. The report prints them; the run refuses a warm start across them for the same reason.
2. **Same panel, paired.** The champions and the primary play identical opponent fixtures and seeds, and the comparison resamples whole fixtures. The group comparison, the champion-by-champion table (simultaneous band) and `rematch.cjs` all do this. Never compare a champion's old final score with a new final score.
3. **A difference outside the interval.** At 512 fixtures a single comparison resolves about 4 points and a comparison against several champions about 5 (measured, section 4). Teams closer than that are tied.
4. **One pre-declared comparison.** The primary was chosen by screening before the final test. Reading the champion table afterwards and announcing whichever team looks best re-introduces the winner's curse.

When it does not suffice:

- **The assumptions changed** (a new controller, meta, or data snapshot). The champions are still re-simulated, which answers "which team is best under the new assumptions" (often a different one: that is information, not failure). It does not answer "is the new setup better", because a higher or lower score under different assumptions says nothing about which assumptions are more realistic. Judge that with realism metrics (section 3c).
- **The new primary is a previous champion again.** The report says `same team (rediscovered)`. That is a tie by construction. It is not a failure of the update (the old champion may simply be the best team under these assumptions) and not evidence of improvement either. If the search was also handed the champion as a composition hint (`launch-next.cjs` passes `--seed-teams` from the v3 checkpoint when it exists), a rediscovery is not even evidence that the search can find it; run without hints (`--seed-teams ""`) when that is the question.
- **The difference is inside the interval.** That is a tie. With finalists typically within 3 points of each other, most re-runs of a working search will tie its predecessor's champion; a clear win means the earlier search was far from converged, not that the method changed.
- **The change is to the search itself.** One new run against the old champion is one draw of a stochastic search. It cannot separate a better algorithm from a lucky seed, and it says nothing about cost. Use the equal-budget A/B of section 3b.
- **A champion is not in the pool.** Compositions whose species or moveset the current pool does not retain are skipped with a reason (shown in `findings.md`, `report.html`, `recommendations.json` and the viewer); the group is then smaller than intended.

## 2. The tools

| Tool | Question it answers | Command (from `web/`) |
| --- | --- | --- |
| `--champions FILE[,FILE...]` and the `previous-champions` group | Did this run's primary beat the earlier winners on its own sealed panel? | `node training/team-search/search.cjs ... --champions includes/pro/data/team-search.json,includes/pro/data/team-v3-refined.pvpteams.json.gz,training/runs/RUN` (`--champions-scope finalists` takes every final-tested team; `none` disables). `launch-next.cjs` adds the published v1 and v3 primaries and every completed run with the same pool hash and a final panel of at least 256 fixtures automatically; passing `--champions` there replaces the list. |
| `rematch.cjs` | Which of these teams is best on one fresh panel, under the current engine and a chosen meta, whatever assumptions each run was made under? | `node training/team-search/rematch.cjs RUN_A RUN_B [--finalists] --fixtures 512 --workers 12 --meta hybrid [--usage-file F --usage-half-life-days N --usage-as-of D --usage-prior-strength N] --out FILE.json`; `--print FILE.json` reprints a saved result |
| `compare-history.cjs` | At the same number of battles, did the search itself propose better teams, predict better and label more teams? | `node training/team-search/compare-history.cjs RUN_A RUN_B --labels old,new --json FILE.json` |
| Finalist comparison in every run | Which finalists can be told apart from the primary? | `recommendations.json` (`finalistComparisons`), `report.html` |
| Sealed confirmation test (`--confirmation-opponents`, default 256) | When the final panel puts a challenger clearly above the primary, does that advantage reappear on a new sealed panel? | `recommendations.json` (`confirmation`), `report.html`, the Search Performance tab; `node training/team-search/audit-selection.cjs RUN_DIR` shows retrospectively which comparisons would have triggered it |

Sources for the first two are run directories, `recommendations.json`, portable reports (`.pvpteams.json.gz`, validated with `neural-report-core.js`) and the published v1 archive. Only compositions (species and moveset) are read, and charged-move order is ignored when mapping a composition into the pool. A source whose primary was not final-tested (a stopped run, an incomplete archive) has no champion and is skipped with a reason.

`rematch.cjs` draws a fresh panel seed unless `--seed` is given, and refuses a seed that was a screening or final panel of any source that records them (`recommendations.json` and the v1 archive; portable reports do not carry their panel seeds, so a reused seed cannot be detected there). It prints every pair under one simultaneous band, so picking the best-looking pair afterwards does not manufacture a significant result. It can switch the **meta** (`--meta`, `--usage-file`, as in `search.cjs`) but always uses the current v4 controller: to compare controllers, run it once in a checkout of each version with the same `--seed` and the same meta.

## 3. Decision procedure by class of change

| Class | Evidence required | Passes when |
| --- | --- | --- |
| (a) Pure speed or refactor | byte-identical outcomes; throughput | identical fixtures, labels, models, panels and verdicts; speedup larger than run-to-run spread |
| (b) Search, acquisition or model, same pool, meta, controller and seeds | equal-budget A/B; `rematch` of the two primaries; `previous-champions`; matched histories | new primary resolvably better on a fresh panel, or tied with materially better matched-history efficiency (reported as "same teams, cheaper") |
| (c) Simulator, controller or meta | champions re-simulated under the new assumptions; realism metrics | realism metrics improve; never "the score went up" |

### 3a. Pure speed or refactor

Nothing observable should change, so the test is exact, not statistical.

1. Run the old and new code with the same pool, `--seed`, `--validation-seed`, options and **`--rounds N` with a generous `--hours`**, so that neither run is limited by time (a time-limited run completes a different number of rounds when it is faster). Use smoke scale (`--initial-teams 16 --batch-teams 8 --opponents 8 --screen-teams 4 --screen-opponents 16 --validation-teams 2 --validation-opponents 16 --baseline-count 3 --candidates 200 --rounds 2`).
2. Compare the deterministic parts of both checkpoints:

   ```sh
   node -e "const [a,b]=process.argv.slice(1).map(f=>require(require('path').resolve(f,'checkpoint.json')));const pick=s=>JSON.stringify([s.records,s.observations,s.models,s.screenResults,s.validations,s.baselineResults,s.comparisons,s.finalistComparisons,s.history.map(h=>[h.round,h.battles,h.teams,h.bestTraining,h.proposalScores,h.acquisition])]);console.log(pick(a)===pick(b)?'identical':'DIFFERENT')" training/runs/OLD training/runs/NEW
   ```

   Timings, worker counts and `runtime` are excluded on purpose; results do not depend on worker count (a test enforces this).
3. If the engine or controller source changed, the mechanics hash changes; it keeps its historical id only through a parity-verified entry in `simulator-compatibility.json`. A change that needs a new hash is class (c), not (a).
4. Measure throughput with `node training/benchmark-simulator-speed.cjs 192 3 12 OUT.json` and `node training/team-search/benchmark-neural-speed.cjs`, alternating old and new at least three times on an otherwise idle machine, and report the median and range. A speedup inside the range is not a speedup.

### 3b. Search, acquisition or model changes (same pool, meta, controller and seeds)

This is the case where the owner's question mostly applies, with the additions below.

1. **Freeze the design before running.** Same pool, meta, controller and data snapshot; the same `--seed` and `--validation-seed` in both arms (common random numbers: identical initial teams and identical training opponents round by round); the same worker count; the old arm run from a checkout of the old commit (`git worktree add`), because the algorithm fingerprint refuses to resume across code. Decide in advance whether the budget is **wall time** (answers "better per hour", includes any speed change) or **battles** (answers "better per battle", isolates the algorithm). Run the arms one after the other on an idle machine, or together with the cores split evenly.
2. **Give both arms the same yardsticks.** Pass the same explicit `--champions` list to both (not `launch-next.cjs`'s automatic list, which would add arm A's result to arm B), and `--seed-teams ""` if rediscovery is to mean anything.
3. **Judge by three things, in this order.**
   1. *Primary criterion:* re-simulate the two primaries (add `--finalists` to include all finalists) together on a **fresh panel** with `rematch.cjs`, at least 512 fixtures (1,024 or more if the target effect is under 3 points), under the same meta as the arms. The new primary is better when its simultaneous band against the old primary excludes zero on the good side; worse when it excludes zero on the bad side; otherwise tied. The arms' own final scores are not compared.
   2. *The `previous-champions` group in each arm:* how each arm's primary stands against the same older teams. This gives an anchor that does not depend on the other arm.
   3. *Matched histories:* `compare-history.cjs` at equal cumulative battles: neural-proposal quality, held-out team error relative to the constant predictor, best training score, teams labelled, battles per labelled team. It judges the search process, with its own effect floors, and flags a best-training-score difference as indicative only (it is a maximum over unequal samples). Read its random-proposal control row too: random picks should score about the same in both runs (within a point or two); if they do not, the opponent panels were not equally hard and the other rows are not equal-footing.
4. **Rule.** *Improvement* if the primary criterion shows the new primary resolvably better and nothing regresses badly. *Tie* if the primary criterion is unresolved. If it is a tie and the matched histories improve on at least two criteria with no regression, report "the same team found more cheaply", not "better teams". *Regression* if the primary criterion is resolvably worse. If the criteria disagree (better history, worse team), trust the rematch and treat the history metric as misleading for that change.
5. **A rediscovered champion is a tie, not a failure.** If both arms select the same composition, or the new arm re-selects an old champion, the arms are tied on the primary criterion. The efficiency evidence then decides whether the change is worth keeping.
6. **Replicate before claiming a small gain.** With one run per arm, search-to-search variation is not measured. Run a second seed per arm (A1, A2, B1, B2) and put all four primaries on one `rematch.cjs` panel: if A1 and A2 differ about as much as A and B, the change has not been shown to matter.

### 3c. Simulator, controller or meta changes

These change the labels, so scores under the old and new assumptions are not comparable and a higher score proves nothing: a weaker opponent model also raises scores.

1. **Re-simulate the old champions under the new assumptions.** The `previous-champions` group does this automatically in the first run under the new setup (and `rematch.cjs` does it for any set of teams under a chosen meta). Read it as "is the old champion still best under the new assumptions", not as progress. The champion-better outcome is an expected and informative result of changing assumptions.
2. **Judge the assumption change by realism, not by score.** The meta-sensitivity field exists and is tested; the other metrics are produced by work in progress, and their fields below are the *expected* report fields and have not been verified against this checkout:
   - *Mechanics fidelity fixtures* (the simulator against recorded game outcomes): more fixtures matching, or smaller error, is the evidence for a simulator change.
   - *Policy-diversity spread* (`policyPanel` in the report): the spread of the primary's score across a panel of controller styles. A smaller spread means the team does not depend on one controller; compare spreads on the same panel only.
   - *Meta-sensitivity spread* (`sensitivity` in the report, written by every run since 2026-10-13 and re-runnable on any finished run with `sensitivity.cjs`): the spread (max minus min) of a finalist's score across K alternative opponent metas, each on its own sealed panel. A smaller spread is a more robust team, but read it against the spread that fixture noise alone gives (recorded as `noiseSpread`: roughly 7 to 9 points at 128 fixtures per meta, 4 to 5 at 512), compare spreads only between teams on the same panels, and never read a mean across metas as strength. It is a read-out: it does not change the primary and has not been used to select anything.
   - For a meta change, the exporter's quality report (eligible share, distinct teams, creators, as-of date, unknown Shadow share) and the effective sample size, not the score.
   - For a controller change, the information-boundary tests and parity against held-out stronger or more diverse policies. A parity result near 50% (the v4 check gave 50.8%, interval 45.2 to 56.3) shows the controller did not change strength; it does not show it became more human-like.
3. **Check robustness across the change.** Re-simulate the finalists of both setups with `rematch.cjs` under each meta in question (`--meta`, `--usage-file`) and, for a controller change, in a checkout of each version with the same seed. A team that stays near the top under every plausible assumption is robust; one that tops only a single assumption set is a best response to it.
4. **State the comparison honestly.** Report scores "under the new assumptions" next to the realism metrics. Never report "the score rose from X to Y" across a change of assumptions.

## 4. The statistical fine print

**Sealed seeds.** Screening and final fixtures use seeds the launcher generates before the search starts, derived from `--validation-seed`, checked against any absorbed evidence, and kept out of every proposal, fit and training stream (`guardedSeed`). A panel is a one-use instrument: once a decision was made on it, the next decision needs a new seed. `rematch.cjs` draws fresh seeds and refuses the sources' own panel seeds where they are recorded. Record the seed with every result.

**Pairing.** All teams in a comparison must play identical opponent teams and battle seeds. Teams compared on different fixtures (the Cramorant example: 128 games against 1,792 on different opponents) cannot be compared at all. Intervals come from a bootstrap that resamples whole fixtures, so the correlation between teams that faced the same opponent is kept; an unpaired interval would be wrong and, in the v4 final panel, 1.0 to 1.9 times (median about 1.2) too wide, because teams that beat the same opponents are positively correlated.

**Multiple comparisons.** Comparing several teams invites picking the best-looking pair. Finalist comparisons, champion comparisons and `rematch.cjs` therefore use one **simultaneous** band: the 95th percentile, over bootstrap resamples, of the largest deviation across all comparisons in the family. It is wider than a single interval and widens with the number of teams. The three baseline groups plus `previous-champions` are four separate group comparisons that are not adjusted against each other; they are fixed groups, not selected, so this is a smaller risk, but do not read four intervals as one test. Comparisons across stages (training, screening, final) and across experiments over time are not adjusted at all: test twenty ideas on twenty fresh panels and expect about one false positive. Demand replication for any surprising or small gain.

**Minimum fixtures.**

| Fixtures | Use |
| --- | --- |
| 64 | smoke and exploratory only; a pair of teams must differ by about 12 points to separate, 18 across a few teams |
| 256 | discovery; also the minimum final panel for a run to count as a champion in `launch-next.cjs` |
| 512 | the standard final panel; the minimum for a claim |
| 1,024 to 2,048 | needed to resolve differences of about 3 to 2 points |

**What interval widths to expect.** The half-width of a 95% interval for a paired difference is about 1.96 x sd / sqrt(n), where sd is the standard deviation of per-fixture paired differences. In the completed v4 run the primary-versus-finalist sd was 0.28 to 0.48 (median 0.43) per fixture. At sd 0.45 the half-width is 11.0 points at 64 fixtures, 7.8 at 128, 5.5 at 256, 3.9 at 512, 2.8 at 1,024 and 1.9 at 2,048. The measured v4 final panel at 512 fixtures gave a half-width of 3.8 to 4.0 points against the baseline groups and 5.1 points for the simultaneous band over the seven finalist comparisons (6.1 points if all 28 pairs among the eight finalists are compared); all seven differences from the primary (-3.2 to +2.9 points) were unresolved. A simultaneous band over several teams runs about 1.2 to 1.5 times the single interval, because a single paired interval was 2.4 to 4.2 points (a team whose results closely track the primary's resolves finer differences).

The fixtures needed before a true difference of a given size is just resolved half the time, at sd 0.45, are about 311 for 5 points, 864 for 3, 1,945 for 2 and 7,780 for 1; roughly double those for 80% power, and about 1.5 to 2 times more again against several teams at once. A one-point improvement is not something this system can establish in a night.

**Conditional inference.** Intervals are conditional on this meta, this controller, the pinned engine and these particular teams. They are not human win rates and say nothing about other metas; that is what the sensitivity checks in section 3c are for. A draw counts as half a win. Neural predictions, training scores and the best training score are selection-biased and are never evidence of strength; the sealed panels are.

**Winner's curse.** The primary is fixed by screening before the final test. If another finalist scores higher on the final panel, the primary stays the primary; choosing it afterwards needs its own fresh panel. Since 2026-10-13 the run supplies that panel itself, the `confirmation` step: whenever `finalistComparisons` shows a finalist `challenger-better` (a simultaneous band entirely on its side), or `championComparisons` shows a previous champion `challenger-better`, the primary and every such challenger play a new sealed panel (256 fixtures by default, a seed derived from the validation seed and guarded against every other panel, checked against absorbed evidence, never used for training) and are compared with a paired bootstrap and a simultaneous band over every pair. Read the outcome this way: `challenger-confirmed` means the challenger is better on fresh opponents and its confirmation-panel score is an unbiased estimate of its strength (its final-panel score is not); `not-confirmed` means the primary was ahead or the two were unresolved, which is not proof of equality, because 256 fixtures resolve only about 5.5 points for one comparison at a paired sd of 0.45 (use more fixtures for smaller gaps); `incomplete` means the time ran out. The screening-selected primary stays the run's primary endpoint in every case; adopting a confirmed challenger is a decision for the reader, and the next run can carry it as a previous champion. A longer final panel (`--validation-opponents-max`, steps of 64 fixtures while time remains) tightens the final comparisons without a new look: it extends the same fixture list, so the first 512 fixtures keep their scores. A challenger that only the longer panel resolves joins the same sealed confirmation panel.

## 5. A worked example (exploratory)

The v1, v3 and v4 primaries re-simulated with `rematch.cjs` on a 64-fixture panel (4 workers, `nice`), under the default hybrid synthetic meta and under the observed meta (75.1% observed teams, as the v4 run used). **64 fixtures is exploratory**: the simultaneous band is 17 to 19 points wide. The panel seeds were fresh random draws, recorded in the saved JSON (577963626 for the hybrid meta, 750907886 for the observed one).

| Primary (lead first) | Own final score, own assumptions | Hybrid meta, 64 fixtures | Observed meta, 64 fixtures |
| --- | --- | --- | --- |
| v4: Talonflame (Shadow) / Mandibuzz / Bastiodon | 83.5% (512, v4, observed) | 81.3% | 81.3% |
| v3: Houndoom (Shadow) / Melmetal / Mimikyu | 73.3% (512, v3 controller, synthetic) | 71.9% | 78.1% |
| v1: Melmetal / Jumpluff / Quagsire (Shadow) | 68.3% (512, v1 full information) | 63.3% | 42.2% |

Under the observed meta the v1 primary is clearly below both others (simultaneous bands exclude zero: -39.1 against v4 and -35.9 against v3), and v3 and v4 are tied (-3.1, band -20.3 to +14.1). Under the hybrid meta no pair separates. The own final scores in the second column are not comparable with each other and the example shows why: the same v1 team scores 68.3% in its own run and 42.2% (SE 6 points) on the observed meta under the v4 controller. Under the hybrid meta the v4 over v1 gap (+18.0 points) is outside its own single-pair interval (+2.3 to +33.6) but inside the simultaneous band (-0.8 to +36.7): resolved if it were the only comparison planned, unresolved as one of three. This is the difference between "its old number" and "how it does on a common footing", and it is why `rematch.cjs` exists. It is a small exploratory panel, not a ranking: run 512 fixtures before saying more.

## 6. Checklist before writing "improved"

1. Which class is this change, and are the assumptions really unchanged (hashes, meta description, pool hash)? Did the report's `confirmation` block say a challenger was confirmed, and does the claim name the confirmation panel's score rather than the final panel's?
2. Was the comparison planned before the run, on a panel that no decision had used?
3. Are both teams on identical fixtures, with at least 512 of them (or the number the target effect needs)?
4. Does the simultaneous band exclude zero? If not, the word is "tied".
5. Did a champion get rediscovered, or the search get hints? Then say so.
6. For a search change: does the matched-history evidence agree, and has a second seed been run if the gain is small?
7. For an assumption change: are the realism metrics reported, and are scores only described under the new assumptions?

## 7. What this protocol does not cover

Time-to-champion (how many battles until a search first finds a known good team) is not measured: `history.jsonl` records the training leader's score, not its identity. The report field `sensitivity` exists (see 3c); the realism metric `policyPanel` belongs to other work in progress and is referenced here by its expected name. The sensitivity panel's data-side counterpart is stratification of the observed meta by date (`usage_export.py --since/--until`); stratification by rating is impossible, because the catalog holds no opponent rating. Seed-to-seed variance of the search is unmeasured until replicated runs exist. All results remain simulated, conditional on the pool of 300 entries with five movesets each, default IVs and the modelled opponent meta.
