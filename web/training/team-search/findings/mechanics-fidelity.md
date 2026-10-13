# Mechanics fidelity: what is pinned, what footage validates, what is still unverified

Written 2026-10-13 for the "Mechanics fidelity" row of the gaps table in [README.md](../README.md#12-gaps-and-improvement-areas) (accuracy). The battle emulator is PvPoke's own `Battle` state machine, pinned at commit `f627e89`, driven by the observation-limited v4 controller. Nothing here changes it. This work does three things:

1. **Pins** what the emulator does in the situations where PvPoke approximates the game, so that any later mechanics edit is noticed and reviewed.
2. **Validates** the damage formula and the move durations against real battles, using what the Meta Extractor measured from footage.
3. **Lists** what no footage of other players can settle, with a plan to record and label it.

The three words mean different things and are not mixed below. *Pinned* means "the emulator still does what it did on 2026-10-13", a regression net with no claim about the game. *Validated* means "measured against real battles, with the agreement stated as measured". *Unverified* means "no evidence either way".

| Area | Pinned | Validated against footage | Unverified |
| --- | --- | --- | --- |
| Damage formula (stats from CP, STAB, effectiveness, Shadow ×1.2 and ×0.833) | 37 traced battles; formula parity with the extractor's copy | 222 charged hits: measured / predicted median 0.98 (IQR 0.92-1.05); 1,065 fast hits: 0.95 (0.76-1.18), noise-limited | Shadow status was unknown for 280 of 306 fast-hit matchups; hits under 4% of HP are too coarse to test the formula |
| Move durations | game-master turns equal the emulator's cooldown for all 306 labelled moves | gaps between hits fall on a multiple of the labelled duration 37% of the time against 8% for the other durations | the extractor's hit times are too noisy to confirm a duration hit by hit; videos differ from 0% to 100% |
| Charged-move priority (CMP) by Attack | 26 battles have a same-turn exchange between different Pokémon, ordered by Attack; 21 of 37 change if the Attack bonus is removed | not tested | whether the game compares the same Attack stat (Shadow bonus, stat stages) |
| CMP ties at equal Attack | seeded coin per turn; 7 battles with an equal-Attack exchange, 2 with a Shadow-against-regular tie | not testable from other players' footage (IVs unknown) | how the game breaks a tie |
| Buff and debuff application | Icy Wind, Power-Up Punch, Lunge, Acid Spray and 9 different chance-based buff moves are thrown in the fixtures | not tested | order of application, and whether chance rolls match the game's odds |
| Switch clock | 45 s of the emulator's clock, which keeps running through charged-move cutscenes; shortest voluntary-switch gap in the fixtures 45.0 s; 33 of 37 battles change at 60 s | not tested | the game's own clock length (60 s on screen) and whether it runs during cutscenes |
| Forms | Cramorant, Aegislash, Morpeko, Mimikyu pinned; Darmanitan as a control | not tested | whether the game changes forms where the emulator does not (Darmanitan) |
| Shields, forced replacements, planner statistics, observations | every HP sample and timeline event of 37 battles | shield counts and faints are read by the extractor but not compared here | catch timing, switch animation timing |

## 1. What is pinned

`training/reference/mechanics-fixtures.json` holds **37 seeded battles** chosen from the prepared pool (300 species, 1,498 variants; opponents drawn the way the search draws them, from the published recommended movesets). For each battle it stores the complete traced outcome under `engine-v4`: score, turns, remaining Pokémon, charged-move count, planner statistics, the observation records the controller was allowed to see (`audit` mode), every HP sample (3,081 in all, 54 to 129 per battle), every timeline event (4,390 in all) and the team stats. `training/mechanics-fixtures.test.cjs` replays each battle and requires exact equality (47 tests, about 17 s), and also requires that the production path (no trace, no audit) reports the same score, turns, remaining, charged count and planner counters. The file is also checked for being the exact output of the regeneration script and for digests that match, so it cannot be edited by hand.

What each fixture exercises is derived from its own outcome (HP samples, timeline events, planner counters) and stored as tags; the test fails if a stored tag is no longer detected, and the pinned set must cover the situations in the table. The set:

| Situation | Battles | How it appears in the trace |
| --- | --- | --- |
| CMP tie, equal Attack (same species, same default IVs) | `cmp-equal-attack-1..3`, `cmp-equal-attack-shadow-1..2`, one swapped copy | both sides throw on the same turn; order in the timeline |
| CMP tie, Shadow against its regular form (equal raw Attack) | `cmp-shadow-raw-tie-1..2` | same |
| CMP decided by Attack | `cmp-unequal-attack-1..2` | the higher Attack throws first |
| Buff chance, certain: Icy Wind, Power-Up Punch, Lunge, Acid Spray | `buff-ICY_WIND`, `buff-POWER_UP_PUNCH`, `buff-LUNGE`, `buff-ACID_SPRAY` | move thrown; later hit sizes follow |
| Buff chance, random: Crunch (20%), Night Slash (12.5%), Moonblast (10%), Bug Buzz (30%), Energy Ball (10%), Muddy Water (30%) | `buff-chance-*` | seeded roll order |
| Forms | `cramorant-1..2` (Gulp Missile), `aegislash-1..2` (blade), `morpeko-1..2` (Aura Wheel toggles Electric/Dark; one swapped copy), `mimikyu-1..2` (Disguise busted), `darmanitan-control-1..2` | named timeline events and charged types |
| Switch clock | `switch-after-expiry-1..3` (a voluntary switch followed by another 45 s or more of battle, and a second voluntary switch after the clock ran out) | active Pokémon changes between HP samples |
| Voluntary switches, forced replacements, shields on both sides, Shadow Pokémon | arise in the battles above: all 37 have shields used on both sides, 32 voluntary switches by both sides, 33 forced replacements on both sides, 30 an active Shadow Pokémon | |
| Identical teams | `identical-teams` (score is the expectation 0.5 of the battle and its mirror) | `scoreMode`, `mirroredOutcomes` |

### What the emulator does, as read from the code and pinned by those battles

These are statements about the pinned engine (`includes/pro/vendor/Battle.js`, `training/engine-v4*.cjs`, `training/next/lookahead-v4.js`). They are not claims about the game.

- **CMP by Attack.** A charged move gets priority +10, and +1 more when the thrower's raw `stats.atk` is strictly higher than the opponent's. The raw stat is `CPM × (base + IV)`: it **excludes the Shadow ×1.2 bonus and in-battle stat stages**, which `getEffectiveStat` applies to damage only. A Shadow Pokémon and its regular form at the same IVs therefore tie.
- **CMP ties.** When the raw stats are equal, `lookahead-v4.js` gives one side +0.001 priority by a seeded coin derived from both Pokémon's identities, both teams' identities and the battle turn. It does not depend on the battle seed or the slot, so the same matchup on the same turn always has the same winner, and the winner varies from turn to turn. Both sides win ties across the pinned battles (the test checks this).
- **Priority KO.** `usePriority` is assigned only in `Battle.start()`, from the two **lead** Pokémon: true when their raw Attack stats differ (or both are Cramorant). While true, a Pokémon knocked out by a charged move earlier in the same turn does not get to throw its own; while false, which is the whole live battle when the leads have exactly equal Attack, both moves resolve. The flag is not recomputed after switches. The controller's rollouts build their own `Battle` and call `start()` for the imagined matchup, so a mirror-lead battle can imagine the cancellation after a switch that the live battle never applies. (Read from the source, not measured.)
- **Buffs.** In emulation the roll is `Math.random() + 0 + shieldBuffModifier > 1 - chance`, with certain moves (chance 1) always applying; the deterministic `buffApplyMeter` path needs sandbox mode and is not used. The roll draws from the battle's seeded generator, so a given seed has fixed outcomes. The controller's imagined rollouts run the vendor's simulate mode instead, where a chance-based buff applies deterministically each time a per-move meter crosses a whole number (a 50% move on its second use, a 20% move on its fourth), so the controller imagines the average rather than a roll. The live battle and its forecasts can therefore disagree about a chance-based buff on any single use.
- **Switch clock.** `Player.switchTime` is 45,000 ms, decremented 500 ms on every `step()` call, including those that run during a charged-move cutscene (the turn counter does not advance then). It therefore counts the emulator's clock time: in the fixtures the shortest gap between two voluntary switches by one side is 45.0 s of clock time, which is only 10 to 17 s of in-turn time when four or five charged moves were thrown in between. A voluntary switch starts it; forced replacements after a faint do not.
- **Forms.** Aegislash changes to Blade on its first charged move and back on a shield (and its Shield-form charged damage uses the Blade Attack); Morpeko toggles Full Belly and Hangry on every charged move (Aura Wheel Electric and Dark); Mimikyu's Disguise turns the first unshielded charged hit into 1 damage and busts the form; Cramorant's Dive and Surf load Gulp Missile (Arrokuda above half HP, Pikachu below) and the loaded form releases when it is hit by an unshielded charged move. **Darmanitan has no in-battle form change** in the pinned game master, so its fixtures are controls (the Zen Mode of the games is not emulated; whether the Pokémon GO battle does it is not verified here).
- **Orientation.** `engine-v4.cjs` orders teams canonically, decides which physical slot each team takes from the order of the two team identities flipped by a seeded coin (so lexical identity never always gets slot 0), and gives both players priority 0.

### Sensitivity: does the net notice an edit?

`training/mechanics-mutation-check.cjs` applies one mechanic change at a time to a throw-away copy of the engine (the repository is never modified), replays the pinned battles there and counts how many outcomes differ from the committed ones. Result on 2026-10-13: **8 of 8 mutations are caught.**

| Mutation | Battles that change (of 37) |
| --- | --- |
| a higher Attack no longer wins a CMP | 21 |
| the equal-Attack tie coin picks the other side | 8 |
| Shadow Attack bonus 1.2 to 1.25 | 28 |
| switch clock 45 s to 60 s | 33 |
| chance-based buffs half as likely | 4 |
| Mimikyu's Disguise never absorbs a hit | 10 |
| a Pokémon knocked out by a charged move still throws its own | 11 |
| Aegislash never changes form | 2 |

The weakest coverage is the two form mechanics and the buff odds (2 to 4 battles each). Adding battles for them is a one-line recipe change in `mechanics-fixtures.cjs`.

### Reviewing a change

```
node training/mechanics-fixtures.cjs                          # replays every pinned battle; prints the first difference per battle; exit 1 if any
node training/mechanics-fixtures.cjs --ids cramorant-1        # only some battles
node training/mechanics-fixtures.cjs --write --reason "why"   # accept a reviewed change; refused without --reason, and nothing is written without --write
node training/mechanics-fixtures.cjs --select --write --reason "why"   # choose battles again (needs training/runs/team-search/pool.json)
```

The accepted reason, the mechanics and data hashes and the changed battle ids go into the file's `changelog`. A behaviour-preserving edit changes the mechanics hash but no outcome; the test reports the hash difference as a diagnostic, not a failure. A game-master refresh changes the data hash and most likely outcomes; accept it the same way after review.

What is **not** pinned: custom IV builds, other league caps, Mega Pokémon, policy styles other than the default, custom shield counts, a Cramorant mirror (the source forces the priority-KO rule on there even at equal Attack), and the unoptimised path (`simulationOptimizations: false`, covered by the frozen-reference tests in `simulator-speed.test.cjs`).

## 2. What footage validates

`tests/meta-benchmark/engine-vs-footage.cjs` joins every confirmed fast move to the Meta Extractor's saved measurements and compares them with three things: the extractor's copy of the damage formula (`combat.js`, over **every level/IV pair consistent with both CPs**), the emulator's own `DamageCalculator.damage` at default IVs (built in a VM exactly as `engine-v4-core` builds a battle; `training/engine-probe.cjs`), and the move's duration in turns. The game data is PvPoke's file for the battle date (as the extractor uses it), so balance changes do not masquerade as formula error. Saved result: `tests/meta-benchmark/engine-vs-footage.json`.

**Evidence.** 197 confirmed fast moves (38 in the tracked benchmark label files, 159 reviewer answers from the harvest's `feedback.json`), all 197 joined to results in 21 videos: 306 matchups of those attackers with measured hits (103 more had none), 1,065 fast-move hits, and 222 charged hits named by a banner with a measured size. Labels are joined to results by video id, battle (by time overlap for the label files, by index for reviewer answers) and species key. Shadow status and form come from confirmed labels. Where a Pokémon has no Shadow answer it is assumed regular and the case is marked "status unknown"; that is 280 of the 306 matchups, so the confirmed subset is small (26 matchups, 82 hits).

### (a) and (b): fast-move hit sizes

"In range" counts a hit between the lowest and highest damage any level/IV pair allowed by the CPs would produce; "in band" widens that by the extractor's own noise model (1.3% of HP plus 15% of the hit). The ratio is measured hit / range centre, and measured hit / the emulator's damage at default IVs. Quartiles in brackets.

| Stratum | Matchups | Hits | In range | In band | Measured / range centre | Measured / emulator default |
| --- | --- | --- | --- | --- | --- | --- |
| All | 306 | 1,065 | 26% | 88% | 0.95 (0.76-1.18) | 1.01 (0.83-1.24) |
| Predicted hit at least 4% of HP | 142 | 417 | 29% | 81% | 0.88 (0.69-1.00) | 0.96 (0.77-1.09) |
| Predicted hit under 4% of HP | 164 | 648 | 24% | 93% | 1.01 (0.81-1.36) | 1.07 (0.87-1.38) |
| Shadow status confirmed (both sides) | 26 | 82 | 33% | 87% | 0.93 (0.75-1.03) | 1.01 (0.85-1.16) |
| Shadow status unknown (assumed regular) | 280 | 983 | 25% | 88% | 0.96 (0.76-1.18) | 1.02 (0.83-1.24) |
| Benchmark label files | 60 | 182 | 24% | 91% | 0.97 (0.76-1.19) | 1.03 (0.81-1.23) |
| Reviewer answers | 246 | 883 | 27% | 88% | 0.95 (0.76-1.17) | 1.01 (0.83-1.24) |
| Reviewer chose a different move than the extractor's top guess | 79 | 294 | 25% | 90% | 0.94 (0.75-1.19) | 0.98 (0.79-1.18) |

How to read this:

- The strict range is narrow (median relative width 21%) against a measurement that sees a bar step to about ±1.3% of HP, while the median hit is 3.1% of HP. A low strict share is therefore expected and is **not** evidence against the formula; the median ratio and the band are the informative numbers. They agree with the extractor's own earlier figure (median 0.96, IQR 0.85-1.18 for the true move).
- Hits predicted at 4% of HP or more read **low**, median 0.88. That is the systematic under-measurement the extractor already corrects with a ×0.92 scale (the drain-trail jump reads a little short). It is a measurement bias, not a formula error: the large, cleanly measured charged hits below are unbiased (0.98).
- The subset where the reviewer overrode the extractor's own guess behaves like the rest, so agreement is not inflated by reviewers accepting the model's suggestion (79 matchups, 294 hits).
- The emulator at default IVs differs from the footage by 1% in the median (ratio 1.01). The spread (IQR 0.83-1.24) is mostly real IV variation between players' Pokémon and the default build, plus measurement noise, not an engine fault.
- Four videos have a median ratio under 0.75 (`8g40gbvbAE4` 0.27, `vPjKop__xf0` 0.64, `deEYSY-vXIw` 0.67, `sH9MNfpYeCQ` 0.69). `8g40gbvbAE4` is a Master League video whose nameplate CPs are implausible (a Crowned Zacian at CP 562), so its predicted ranges are wrong; the causes of the other three were not investigated. No video is above 1.25. The per-video table is in the saved JSON.

### (d): charged hits

222 unshielded charged hits whose move is named by a banner and whose size was measured, in 16 videos:

| | Hits | In range | In band | Measured / range centre | Measured / emulator default |
| --- | --- | --- | --- | --- | --- |
| All | 222 | 64% | 87% | 0.98 (0.92-1.05) | 1.03 (0.99-1.13) |
| Shadow status confirmed (both sides) | 3 | 100% | 100% | 0.94 (0.93-0.96) | 1.00 (0.99-1.01) |

Charged hits are 20 to 50% of a bar, so the bar-step noise is small relative to them, and this is the clean test of the formula: STAB, type effectiveness, the CP multiplier table and the full-charge assumption (a damage multiplier of 1 on the charged move, as the emulator uses) agree with real battles to within about 7% (IQR) with no bias. Almost all of these have Shadow status unknown (assumed regular), which the tight agreement suggests rarely mattered here; only 3 hits have confirmed status, too few to say anything about Shadow multipliers from this test.

### Formula parity between the two implementations

For each of the 278 distinct attacker / defender / move triples in the matchups, 9 level/IV pairs consistent with the CPs were set on both implementations: **2,502 pairs, integer damage equal in 100.00% and stats (attack, defense, HP) equal in 100.00%**. So the extractor's copy of the formula, its CP multiplier table and its type chart are identical to what the emulator computes; footage that fits one fits the other. `training/engine-probe.test.cjs` pins this on committed data.

### (c): hit spacing and move duration

Gaps between consecutive hits of the labelled attacker were compared with the move's duration (turns × 0.5 s, from the game master, which equals the emulator's cooldown for all 306 labelled moves). Gaps over 4 s (cutscenes, switches) are dropped. A move of one turn (0.5 s) cannot be scored: every gap is within 0.25 s of a multiple of 0.5 s (148 such gaps). The scored share is the share of gaps within ±0.25 s of an integer multiple of the duration; the baseline is the same gaps scored against the *other* durations (2 to 5 turns).

| | Gaps | Scored | Within ±0.25 s of a multiple | Other durations | Lift | Cases where the labelled duration beats / ties / loses to the best alternative |
| --- | --- | --- | --- | --- | --- | --- |
| All | 695 | 522 | 37% | 8% | 4.8× | 48 / 16 / 21 |
| Benchmark label files | 121 | 86 | 58% | 9% | 6.8× | 11 / 1 / 2 |
| Gaps at least one duration long ("plausible") | | 223 | 86% | | | |

Many gaps are shorter than half a move, most likely one hit detected twice during the drain animation (not checked frame by frame), which is why the plain share is lower than the plausible one. The labelled duration explains the gaps better than the alternatives in 16 of the 20 videos that have scoreable gaps, and the share ranges from 100% (`1p_u7XyvWwU`, `hour`) to 0 to 13% in four videos where the alternatives score as well or better (`oqxO3iZePPU`, `_LSkr79Bo_c`, `S67R41DZFuY`, `FLJKUTh5ru8`). Conclusion: move durations are **consistent with** the footage on average and clearly better than the alternatives, but the extractor's hit times (10 fps frames and a drain animation) cannot confirm a duration hit by hit. Frame timing at the turn level is a labelling job, not a pipeline output (section 4).

### Limits of these numbers

- Agreement statistics describe the damage formula and move duration, not any controller, switching or shield behaviour.
- Reviewer answers may have been given with the extractor's own guess on screen (the harvest stores it as `modelTop`); the override subset above is the check on that. The benchmark label files were labelled from HUD contact sheets.
- The video set is the harvest's labelled subset, top-tier players' battles; most Great League, some Master League; 2025-03 to 2026-10 game data.
- Hit times and sizes depend on the extractor's bar detection; its own accuracy figures are in the Meta Extractor README section 7.

## 3. What remains unverifiable without recordings of the game itself

Each item is something the emulator decides by an inherited rule and that other players' footage cannot settle, because the quantities that decide it (exact IVs, which turn a tap landed, the tap timing) are not visible or not unique.

| Behaviour | What the emulator does | Why existing footage cannot settle it |
| --- | --- | --- |
| **CMP tie at equal Attack** | seeded coin per (matchup, turn) | the opponent's IVs are unknown, so equal Attack cannot be established; ties are also rare in the wild |
| **What "Attack" CMP compares** | raw `CPM × (base + IV)`, no Shadow bonus, no stat stages | needs pairs whose raw Attack is equal but effective Attack differs (Shadow against regular at equal IVs; a Pokémon after Power-Up Punch or Icy Wind) |
| **`usePriority` from the leads only** | cancellation of the second throw decided at battle start | needs a KO inside a same-turn exchange after a switch; rare |
| **Catch timing** | the controller decides on the tick; no delayed catch | the order in which a fast move that lands on the same turn as a charged move is applied depends on the exact frame |
| **Switch clock length** | 45 s on the emulator's clock, running through cutscenes | the game shows 60 s; whether the real clock runs through cutscenes, and so how many clock seconds apart two voluntary switches can be, is unknown. This is the most consequential single parameter: with 60 s, 33 of 37 pinned battles change |
| **Switch animation timing** | a switch is an action with no animation cost beyond the 500 ms turn | how long the switch itself takes, and what the incoming Pokémon can do during it |
| **Buff application order** | buffs apply when the charged move resolves, in CMP order; chance moves roll the seeded RNG | the order matters only when both players throw on one turn, and the roll is not visible without a buff-arrow detector |
| **Zen Mode and other forms** | not emulated for Darmanitan | needs a recording of the Pokémon dropping below half HP |

## 4. Plan to record and label them with the Meta Extractor

### What the extractor already provides

From the 722 harvested videos on this machine (3,590 battles on 2026-10-13), per battle (`results/<videoId>.json`, `full[]`):

- `events`, each with a video time `t` in seconds (0.5 s resolution): `move` (a charged-move banner: side, actor key, move id; 11,548 in the harvest), `shield` (a used shield, per side; 11,727), `go` (a "Go, X!" switch-in banner; 8,694), `faint` (per side; 10,664) and `reveal` (first sight of a Pokémon).
- `segments` and `matchups`: who faces whom from which second to which; per matchup `hitTimesOnMy` / `hitTimesOnOpp` (hit times), `hitsOnMy` / `hitsOnOpp` (hit sizes), `chargedOnMy` / `chargedOnOpp` (named charged hits with size and time), `series` (HP at 10 fps) and `effects` counts.
- `hp`: each Pokémon's HP at every 0.5 s turn, a monotone fit.
- Per Pokémon: form, CP, Shadow probability, confirmed labels.

What a labeller adds is what the pipeline does not read: **which frame** an event happened on and **which Pokémon had which stat**. `tests/meta-benchmark/engine-vs-footage.cjs` already contains the joins (video, battle, species key) a labelling queue needs.

### Candidates already in the harvest

Banner pairs from opposite sides within 12.5 s of each other number 3,112 in 1,138 battles; 124 of them fall within 2 s, the likely same-turn exchanges, and about 1,100 are 10 to 12.5 s apart (one cutscene apart: same-turn exchanges and adjacent-turn throws look the same at banner resolution). These are candidates by banner time only, not confirmed exchanges, and the counts depend on what the harvest holds today. A first pass at voluntary-switch gaps from `go` banners and nameplate segments was tried and is too noisy to quote (duplicate banners, nameplate flicker, missing faint events); it needs the labelling below.

### Labelling protocol (per behaviour)

1. **CMP by Attack, from existing footage.** Take candidate pairs whose two Pokémon have known CPs with non-overlapping Attack ranges (`statCombos`). The labeller watches the pair and records whether both throws came out on the same turn and which banner came first. Pass criterion: the emulator's order (higher raw Attack first) matches in at least 95% of confirmed same-turn exchanges. This tests the main CMP rule without a special session; the engine-vs-footage joins give the stat ranges.
2. **CMP ties and what Attack means: a controlled recording.** A friendly battle between two accounts holding clones: the same species at the same level and IVs (two hundos at level 50 in Master League, for example; the rule should not depend on the league), with the same moves so both reach the energy together. Record both phones. Repeat with: Shadow against regular at equal IVs; one side buffed by Power-Up Punch or debuffed by Icy Wind before the exchange; both Cramorant. At least 20 same-turn exchanges per variant, with the first-thrower banner (extractor `events`), the frame where both Pokémon fire (labeller), and the sides swapped halfway through. Compare with `cmp-equal-attack-*` and `cmp-shadow-raw-tie-*`: do the sides win about half of ties, and does Shadow win its tie?
3. **Switch clock.** Video seconds are clock seconds including cutscenes, the same unit as the emulator's clock, so footage compares directly. Label 100 voluntary switch pairs by one side: a `go` banner, HP above zero on the leaving Pokémon (from `hp`) and no faint. The shortest gaps decide it: if none is under about 60 s, the game's clock is 60 s and the emulator is too permissive; if gaps of 45 to 60 s occur, 45 s stands. Also count the charged throws between each pair (`events`) to see whether the clock pauses during cutscenes (gap minus throws × cutscene length). A changed `switchTime` goes through the reviewed `--write --reason` path and changes the mechanics hash, so old checkpoints no longer warm-start.
4. **Catch timing.** In a controlled recording, a 2-turn fast move against a charged throw on its landing turn; label per exchange whether the fast hit registers before or after the charged hit (`hitTimesOnMy` against `chargedOnMy.t`, confirmed on the 10 fps `series`). 30 exchanges per ordering.
5. **Buff application and odds.** Add a buff-arrow detector near the HP bar (the extractor has the strip geometry for the effectiveness text), or have a labeller mark each chance-move throw as proc or no proc; 100 throws each of Crunch (20%) and a 50% move give odds to a few points. For order, a same-turn exchange where one side throws a buff move and the other a damaging one; label whether the damage of the second throw is affected.
6. **Zen Mode.** One recorded battle with Darmanitan crossing half HP, labelled by the form change in the nameplate.

### How results flow back

Each confirmed behaviour becomes either an unchanged pin (the emulator already agrees, noted in this file) or a reviewed mechanics change: edit the engine, run `node training/mechanics-fixtures.cjs`, read the differences, accept with `--write --reason`, run `node training/mechanics-mutation-check.cjs` to confirm the fixtures still notice it, and refresh `engine-vs-footage.json`. Each labelled recording would also add fixtures that record, in a new `source` field (not in the schema yet), that the outcome was confirmed in the game rather than only reproduced by the emulator; none exist yet.

## Reproducing

```
node --test training/mechanics-fixtures.test.cjs training/engine-probe.test.cjs   # 52 tests, about 20 s
node training/mechanics-mutation-check.cjs                                         # 8 mutations, about 2 minutes
node tests/meta-benchmark/engine-vs-footage.cjs                                    # needs the harvest results (--work DIR); about 1 minute
node --test tests/meta-engine-vs-footage.test.cjs                                  # statistics and joins on synthetic evidence
```
