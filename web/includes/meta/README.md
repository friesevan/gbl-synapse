# Meta Extractor — algorithm, prototype audit and development roadmap

Meta Extractor is a working browser demo ported from Evan Fries’s **PoGo Recorder / PoGoAnalyzer** prototype. Open the **Meta Extractor** main tab (`?app=meta`). A recording is selected on the contributor’s device, sampled and OCRed locally. The video is never uploaded to a server. Reviewed observations can be saved in this browser, exported, and imported to combine contributor samples. **There is no centrally hosted contribution database in this demo.**

## How each metric is determined

A battle follows PvPoke's rules:
- Each side brings three Pokémon and two shields.
- Time moves in 0.5 s turns. A fast move takes 1–5 turns and earns energy; a charged move spends it
  and pauses the battle for a cutscene (and a shield prompt).
- A fainted Pokémon is replaced by the trainer's choice. A trainer can also switch voluntarily (then a
  switch timer runs).
- The battle ends when one side has no Pokémon left, the clock runs out, or someone leaves.

The extractor reads everything from what the screen shows at each moment. The nameplate area (the
HUD) shows each active Pokémon's name, CP, Poké Balls (one per team member, dark when fainted),
shields left and type icons. The field shows HP bars, animations and banners.

| Metric | How it is measured | Evidence used | Main gaps |
| --- | --- | --- | --- |
| Battle boundaries | Nameplates (HUD) every ~1 s or 0.5 s. Fainted balls and used shields only increase within a battle; all balls and shields back means a new battle. A gap in the nameplates continues the battle unless a result, a fade to black or a fresh HUD shows it ended. | Poké Balls, shields, result screens, fades to black | A recording that starts mid-battle; two battles back to back with no visible reset (never seen so far) |
| Opponent species | The name box is read once per distinct fingerprint (Tesseract OCR), matched to PvPoke's species list (exact, or one wrong letter as a suggestion), and kept after two sightings. "Mega X" and "Primal X" map to that form. | Nameplate text | Pokémon on screen for under ~2 s; nicknames are impossible for opponents, so only your own side needs care |
| Lead | The first opponent species seen in the battle. | First stable nameplate | If the opponent swaps out within the first second, the lead may be read late or missed. "Go, X!" banners are now recorded and could settle it. |
| Team (up to 3) | Every species revealed in the battle. | Nameplates | The third Pokémon is often never sent out. A team is "complete" only when all three appear. |
| CP | The CP box is read and cached like names; majority vote per Pokémon. | CP text | None significant |
| Result | A YOU WIN / GOOD EFFORT screen (read only when the battle can have ended), cross-checked with three dark balls. | Result screen, ball count | No result screen and no ball count, e.g. you leave the app |
| Forfeits | Yours: the "Surrender and exit?" dialog (a white card, confirmed by OCR), then a loss. The opponent's: a win before all their Pokémon fainted. | Dialog, ball count | Leaving the app without the dialog. An opponent's disconnect looks the same as a forfeit. |
| Shields used | Shield icons on each nameplate; counts only increase. | HUD | None significant |
| Form (regional, Origin, etc.) | Type-icon colours, voted over every stable frame of the battle. Forms that look identical are weighted by PvPoke ranking score, then by reviewer answers. A charged move the form can't learn rules it out. | Type icons, rankings, answers, charged moves | Forms with identical types (Dialga vs Dialga Origin) rest on priors only. Damage helps a little, since the forms' stats differ. |
| Shadow | A joint fit: a Shadow deals ×1.2 and takes ×1.2 damage. Purple aura under the opponent's bar (ignored when your Pokémon is a Shadow). Learned Shadow rates. | HP bars, aura, answers | Few clean hits. Purple-bodied species need exceptions. Damage from charged attacks is not used yet. |
| Fast move | Fast-move hits (steps down the HP bar) and their rhythm in 0.5 s turns, fitted with PvPoke's damage formula. Both directions are fitted, over every level/IV combination consistent with both CPs. Priors come from rankings and answers. | HP bars, CP, rankings, answers, charged-move energy and movesets | Few hits per matchup. Moves with similar damage and timing (Morpeko Thunder Shock vs Bite). Edited videos cut the bars. |
| Charged moves | "X used Y!" banners (OCR), checked against PvPoke's legal moves, read with or without nameplates on screen. | Banner text | A banner missed during a fast cutscene |

### Using every appearance, not just the first
Facts about a Pokémon can come from any of its appearances in a battle:

- A **matchup** is any stretch where the same two Pokémon face each other for at least 3 s.
- Every matchup of the same opponent Pokémon in a battle is pooled (`combineMatchups`, tempered by √n).
- **Example:** an opponent leads Skeledirge, switches out after a second (too short to be a matchup),
  and brings Skeledirge back later. Its fast move, Shadow status and CP all come from the later
  appearance.
- **Type icons** are voted over every stable frame of the battle, not only the first.
- **Your own Pokémon** are pooled across every battle in the recording, since your team is the same
  Pokémon throughout.
- **Opponents are never pooled across battles:** a different battle usually means a different trainer.

**Window lengths, measured (v3).** The batch runner now reads every frame of every matchup in a single
pass. The whole matchup is used for charged hits and the Shadow aura. Fast-move hits, though, are
better from the start of a matchup: later readings (low-HP colours, cutscene edges) add noise.

| Fast-move window | Fast moves right (leave-one-out, 99) |
| --- | --- |
| Whole matchup | 79 |
| First 8–18 s | 86–87 |

The figures are re-evaluated from the stored HP series. The runner and browser use the first 12 s.
The browser samples up to 30 s per matchup at 4× playback.

### What battle structure adds
1. **Charged-move and switch banners (implemented).** "X used Y!" and "Go, X!" are read with or without
   nameplates on screen. The banner box sits at 30.2% of the full screen height, recovered from the
   calibration offset when the top is cropped. A tolerant parser picks the phrase out of OCR junk from
   bright arenas. Each charged move is credited to the Pokémon on the field.
2. **Energy accounting (implemented, `combat.energyFactor`).** All energy a Pokémon has spent on
   charged moves must have been earned by fast moves during its fighting time since entering. Energy
   carries over through switches, and banking only loosens the bound. Fighting time counts frames with
   an HP bar visible from the Pokémon's entry ("Go" banner or first nameplate) until the next Pokémon on
   its side. A fast move that can't pay for the energy spent gets weight 0.05. In practice this is a
   safety net: players rarely fire charged moves fast enough for it to bite.
3. **Moveset legality (implemented, `combat.movesetFactor`).**
   - A charged move the form can't learn rules out that form (Weezing vs Galarian Weezing share no
     charged moves).
   - Frustration means Shadow; Return means not Shadow.
   - Charged moves matching PvPoke's recommended set double that set's fast move.
4. **Charged-attack damage (implemented, `hp.chargedDamage`, `combat.inferMatchup({charged})`).**
   A charged move is typically 5–20× a fast move's power, so its damage is measured with little
   rounding error. For each banner, the target's bar is read just before the cutscene. The new level is
   the first run of three agreeing readings below it. The bar can reappear at the old level for a
   moment before the damage lands, and single glitch frames occur, so a single reading isn't trusted.
   - **Skipped** when the target shielded (shield icon change within 10 s) or fainted (the drop is then
     only a lower bound).
   - **Fitted** like fast-move hits, using the named move's damage for every stat combination and
     Shadow status of both sides.
   - Each matchup also stores its HP series (10 readings/s), so fits can be re-run without decoding
     video.

## OCR or our own machine-learning model?

**Current split:**
- Tesseract OCR reads only text that varies: names, CP, result banners, charged-move banners and the
  surrender dialog.
- Everything else is hand-written pixel rules: Poké Balls, shields, type icons, HP bars and the purple
  aura.

**Evidence from the benchmark (9 videos, 3 phones and 3 YouTube channels):**
- **Accuracy:** after this round of fixes, OCR names every labelled opponent species correctly: 194 of 194 in the 7 videos labelled battle by
  battle, and all 39 species in the 2 edited reels.
  Every past naming error came from geometry or caching, not from reading itself: a box clipping
  "Mega Garchomp", a fingerprint threshold on blurry video.
- **Speed:** OCR is cheap. The name cache cuts reads to 16–33 per video. Run time is dominated by
  decoding video for the HP-bar pass, not by OCR.
- **Where the errors are:** fast moves (85/99), Shadow (51/62) and forms. None of these is a text
  problem.

**Recommendation:** keep OCR for text, and put machine learning where the errors are.

1. **Names (closed-set classifier):** only a few hundred names can ever appear, in one font at fixed
   positions. That makes reading a name a classification problem rather than open OCR.
   - A small CNN classifier would be faster and more robust on blurry or low-resolution video.
   - It can be trained without hand labelling: render every species name in a similar font with blur,
     scaling and compression, then mix in real crops auto-labelled by the current pipeline.
   - The model would be well under 1 MB in the browser (TF.js/ONNX) and retrained from PvPoke's data
     when new species arrive.
   - Worth it for live screen-share at high frame rates or very low-resolution streams. Today it would
     add little.
   - Other UI languages are easier with OCR: Tesseract has language packs, while a classifier needs
     new renders.
2. **Shadow aura (best candidate):** a small classifier on the crop under each opponent's bar,
   trained on the answered matchups (92 so far, more as reviewers answer). The current threshold uses
   one colour statistic; a learned model can use shape and motion of the flames and the Pokémon's
   own colours. Combine it with damage and priors as today.
3. **Fast moves (move animation):** each fast move has a distinctive animation and sound. A temporal
   model is a larger project (labels: the answered fast-move questions). It only pays once the cheaper
   gains above are in: whole-matchup windows, energy accounting, charged-attack damage.
4. **Type icons:** colour matching is already 97% (357 of 368 samples) and the misses come from
   timing, so a model gains little.

Free vision models (`scripts/freellm`, quality gate passed for nameplates) can label training crops in
bulk for items 1–2. Validate questions supply the hard cases.


## Speed and scale (v3 batch engine)

The Node batch engine (`tests/meta-benchmark/run-node.cjs`, `run-batch.cjs`) is how large datasets are
processed. It decodes each video once:
- ffmpeg streams 10 frames/s, already cropped to the phone screen and scaled to the 886-wide reference.
- Nameplates, results, the surrender dialog and banners are read on every 5th frame.
- HP bars and the purple aura are read on every frame of a battle, so each matchup is measured over
  its whole length.

Text is read with Tesseract only for new fingerprints. A CP read twice is reused while its digits look
the same.

**Where the time went, and what changed:**

| Step | Before | After |
| --- | --- | --- |
| HP-bar search | 11.4 ms per frame: every pixel of the field | 1.7 ms: a coarse pass over every 3rd row finds candidate rows, then a two-comparison colour reject. Identical output on 900 frames. |
| Per-matchup ffmpeg seeks (v2) | One process and one keyframe seek per matchup; 25 s cap | Gone: one decode per file, whole matchups |
| CP OCR | Read on every new CP fingerprint (hundreds per video) | Reused once settled: 13 reads instead of ~650 on a 670 s stretch |
| ffmpeg filter order | crop + scale every frame (60/s), then drop to 10/s | drop to 10/s first, then crop + scale: +26% total throughput |
| Long files | One process per file | Split into 20-minute chunks with a 6-minute overlap, decoded in parallel and merged. Each battle is kept from the chunk where it starts; one already under way at a chunk's start is dropped. Merging reproduced every battle of both hour-long recordings exactly. |

**Measured on this machine (Apple M2 Max, 12 cores):**
- One video runs at 5–6.5× real time. HEVC phone video is decode-bound; one stream decodes at about
  14× real time.
- The batch of 9 videos (4.75 h) took 23.5 minutes with 6 workers: **12.1× real time**, or about
  5 minutes of compute per hour of video.
- The ceiling is ffmpeg itself: 6 streams of decode + crop + scale alone reach 16–18× real time.
- Apple's hardware decoder (VideoToolbox) adds only ~10% when 6 streams run, and is slower for one
  stream because frames are copied back from the GPU, so it is not used.
- The scaling method makes no difference (bicubic vs bilinear within 2%).

**Scaling further:**
- Throughput grows with cores and machines. Each file (or chunk) is independent, and the batch is
  resumable: finished outputs are skipped. A 1,000-hour dataset is about 3.4 days on one such machine,
  or a few hours across a few dozen cloud workers running the same scripts.
- The next per-machine gain would come from reading only the screen bands that are needed (nameplates,
  the bar band, the mid-screen band) as raw YUV. That skips colour conversion of the rest of each
  frame, which is about a third of ffmpeg's work on phone video.

```
node tests/meta-benchmark/run-batch.cjs jobs.txt out/    # jobs: path|league|gamemaster|crop
JOBS=6 SPLIT=20 node tests/meta-benchmark/run-batch.cjs jobs.txt out/
node tests/meta-benchmark/dedup.cjs out/                 # same battle in more than one upload
```

## Shared sample, deduplication and estimates

- **Shared sample (opt-in).** In the published app, *Also contribute these battles* stores each
  reviewed battle in the artifact's database as a structured record: species, result, league, cup,
  date and an opaque contributor id. Never video, frames or trainer names. Observed meta → *Source: All
  contributors* pools everyone's battles. Contributors can remove their own submissions.
- **Representativeness.** Each contributor counts at most 50 of their most recent battles by default
  (25, 100 or no cap are options). The number of contributors is shown. *Recency half-life* (30 or 90
  days) down-weights old battles so the sample follows balance updates.
- **Uncertainty.** Appearance rates carry a Wilson 95% interval on the effective sample size. An
  *Estimate* column shrinks each rate toward a PvPoke-ranking prior with the weight of 10 battles, so a
  handful of battles can't produce extreme rates (`core.usageEstimates`, `core.rankingPrior`).
- **Deduplication.** `dedup.cjs` finds the same battle in different uploads (reposts, compilations).
  It needs the same teams and result, plus every faint and charged move at the same relative time
  within 2 s. Repeated battles against the same team don't match. It caught every battle of a
  simulated re-upload with timing jitter, and found no false duplicates among 86 real battles.
- **Review tools.** Each battle candidate can be merged with the next one or split at a given second
  when the tracker gets a boundary wrong.

## v2 pipeline (October 2026)

v2 replaces the fixed-rate crop sampling, the 22-second gap rule and the two-reading confirmations described under “Processing pipeline” below.

1. **Keyframe sampling.** `mp4index.js` reads keyframe times from the MP4/MOV index without decoding (26 ms for a 10-minute file). Phone recordings have a keyframe about every second, and seeking exactly to one needs no forward decoding. Files without an index fall back to fixed 1 s / 0.5 s sampling.
2. **Nameplate measurements instead of text.** `core.js` `readHud` measures both nameplates: three Poké Balls (red = available, dark = fainted), two shields, and a 64×12 fingerprint of the name. `calibrate` finds the vertical offset once, from the first battle frame, by centring the name boxes on the names’ text rows. Geometry scales with frame width.
3. **One text read per distinct name.** `NameCache` reuses the OCR result for any nameplate within 6% of a fingerprint already read; unreadable plates are retried up to three times.
4. **Battle structure from the HUD** (`HudTracker`). Fainted Poké Balls and used shields only increase within a battle, so a reset to fresh nameplates on both sides starts the next battle. Three fainted Poké Balls decide the result. A YOU WIN / GOOD EFFORT screen is read only when a battle can have ended (a side down to its last Pokémon, a fade to black, or 8 s without nameplates), and only when the white text is result-sized (70–115 reference px tall). Matchmaking text ends the search. A win with opponent Pokémon left is flagged as a probable early exit.
5. **Charged attacks** are read from the banner when its white-letter share looks like text, and credited to the Pokémon on the field (separating mirror matches, tolerating one misread letter).

### Benchmark

Labels and tools are in `tests/meta-benchmark/` (recordings stay on the contributor’s computer). Species labels were checked against nameplate images and every uncertain result was checked by eye; boundaries come from the same Poké Ball/shield cues, so the labels are not fully independent of the method. Forms and Shadow status are not yet labelled.

| Recording | Battles | Opp. species | Leads | Results | Complete teams | Text reads |
| --- | --- | --- | --- | --- | --- | --- |
| 10min (Willpower Cup, tuning set) | 4/4 | 12/12 | 4/4 | 4/4 | 4/4 | 32 |
| hour-gl (Great League) | 19/19 | 56/56 | 19/19 | 18/18 | 18/18 | 154 |
| hour (Little Cup, inferred) | 20/20 | 58/58 | 20/20 | 20/20 | 18/18 | 96 |

v1 on 10min: 4/4 battles, 11/12 species (Qwilfish left as an unconfirmed suggestion), 2/4 results, 1,369 text reads, 154 s (visible tab). v2 in the browser on the same file: everything correct with 64 text reads without charged attacks (146 with them). Browser timings in a hidden tab are throttled and not comparable; the Node harness (`run-node.cjs`, ffmpeg + tesseract CLI, same `core.js` logic) runs 26–34× faster than real time.

```
node tests/meta-benchmark/run-node.cjs RECORDING.mp4 run.json
node tests/meta-benchmark/score.cjs tests/meta-benchmark/labels/10min.json run.json
```

## Forms, fast moves, Shadow status and review questions

### Regional forms from type icons
Two type icons sit above each nameplate (yours at x 37/81, the opponent’s at 801/850 of an 886-wide frame; a single type sits in the outer slot). `core.js` reads each disc’s colour from its lower half (the phone status bar can cover the top) and matches it to 18 fitted type colours, rejecting anything more than 40 apart. Icons lag a switch by up to a second, so votes are only taken once a name has held for two samples. On 368 icon samples from the benchmark recordings, colour alone was right 357 times; all 11 misses were sampling the previous Pokémon’s icons or a frame without icons, which the stable-name rule removes. The majority type set keeps only matching forms (e.g. ghost → Galarian Corsola; ground/electric → regular Stunfisk). Shadow and regular forms share types, so Shadow is decided separately.

### Fast moves from HP bars (`hp.js`, `combat.js`)
Each matchup (the same two Pokémon facing each other for ≥ 3 s) is sampled ~10 times per second. HP bars are found from their fill (teal, yellow or red), a solid rectangle 9–18 rows tall with straight edges, because the outline is thin and translucent and bars bob with flying Pokémon. Your bar starts near the left edge; the opponent’s mid-screen; the bar whose left edge recurs through the window is kept. HP never rises within a matchup, so the fill is read as a descending staircase: upward readings (attack glow sweeping over a bar) are ignored and a step counts once two readings confirm it. The orange trail that appears with a hit equals the HP lost and gives the size when no earlier trail remains. Damage that appears after the bars were hidden for more than 1.2 s is a charged attack and is excluded.

Each hit is compared with PvPoke’s formula, `⌊power × STAB × attack/defense × effectiveness × 0.5 × 1.3⌋ + 1` (Shadow: ×1.2 attack, ×0.833 defense), over every level/IV combination consistent with both nameplate CPs. One combination per side must explain both directions at once (its attack sets the damage it deals; its defense and HP the damage it takes). The spacing of hits must fit the move’s duration in 0.5 s turns. PvPoke’s recommended moveset and simulated move usage give a gentle prior. Matchups with the same opponent Pokémon are combined; your own Pokémon are pooled across all battles in the recording. Example: Claydol (CP 1492) against Guzzlord (CP 1498) hit for 5.6–6.0% every 3 turns: Mud Slap predicts 5.2–6.2% per 3 turns; Confusion and Extrasensory don’t fit.

Measured on the benchmark recordings (no fast-move labels yet): your team’s fast moves were consistent across battles (Azumarill Bubble, Galarian Corsola Astonish, Registeel Lock-On, Corviknight Sand Attack, Electivire Thunder Shock in 17 of 19 battles, Scrafty Counter in 15 of 18, Ferroseed Metal Claw in 14 of 16). Confirming them with the contributor is the next validation step.

### Effectiveness text (`hp.js` effectBox/effectSig/effectKind, `combat.js` effectLogL)
When a fast attack lands, the game flashes **SUPER EFFECTIVE!** or **NOT VERY EFFECTIVE…** in white just above the target's HP bar. Every sampled frame checks that strip (from 6 px left of the bar to 320 px right, 3–50 px above it, at the 886 px reference width) with a 96×12 fingerprint of near-white pixels. The strip is read only when it looks like text:
- 3–45% of it is lit;
- every one of rows 1–4 (of 12) has ink, since the words sit in the top five rows (arena glare and the bar's own edge light the lower rows).

Each distinct look is read by OCR once and cached. After a successful read, that side isn't read again for 0.9 s (0.3 s between queued reads in the browser). Repeats within 0.8 s count once. On a 150 s test clip this cut OCR reads from 257 to 50 with the same detections. Per matchup, texts in the fast-move window (the first 12 s) are counted, ignoring any within 4 s of a charged-attack banner, which has its own effectiveness. Every candidate fast move then gets a likelihood term from the effectiveness that move would have against the target's types:

| Move vs target | P(super text) | P(not-very text) | P(no text) |
| --- | --- | --- | --- |
| Super effective | .25 | .03 | .72 |
| Not very effective | .03 | .25 | .72 |
| Neutral | .03 | .03 | .94 |

The text is sometimes shown in error and often missed: it is brief and overlaps the bar animation and arena effects. So no reading is treated as certain, and a missing text says little. These rates were tuned on the v23 benchmark (99 confirmed fast moves, leave-one-out):

| Fast moves right | Without priors | With learned priors | log p (with priors) |
| --- | --- | --- | --- |
| v21 (before) | 69/99 | 82/99 | −0.599 |
| v23 without effect text | 75/99 | 87/99 | −0.343 |
| v23 with effect text (P=.80 when visible) | 79/99 | 87/99 | −0.473 (overconfident) |
| **v23 with effect text (P=.25, chosen)** | **78/99** | **89/99** | **−0.334** |

Shadow accuracy is unchanged (53/66 with priors). The term is scaled by 0.5 and added to the damage, cadence and energy evidence. It separates moves with equal damage but different types, such as Water Gun and Peck on Cramorant against a Fire type. `NOEFFECTS=1` turns it off in `tune-learned.cjs` for comparison.

### HP at every turn (`hp.js` hpTimeline)
Each battle gets an HP timeline: every Pokémon's remaining HP (0–1) at every half-second turn from the battle start. The readings are the dense HP-bar samples of every matchup that Pokémon was in. Processing:
1. Readings are smoothed with a median of 5.
2. They are fitted with the best non-increasing curve (pool-adjacent-violators). HP never rises within a battle, so a single misread low value is averaged away instead of becoming a floor.

How the timeline fills each stretch:
- **Before entry:** empty (`null`); on the field without readings yet: full.
- **Between readings:** the last value is held.
- **After its faint:** 0.

Runner outputs carry it as `full[i].hp` and stored summaries as whole percents (`-1` = not on the field yet).

### Battle timeline graph (`timeline.js`)
`MetaTimeline.render(summary)` draws the battle as an SVG:
- **Panels:** two stacked panels, your team above and the opponent below, sharing one time axis.
- **Lines:** one HP line per Pokémon, ending at its faint.
- **Markers:**
  - ▼ charged attacks (hover for the move);
  - ▮ shields; ✕ faints; dashed lines at switches;
  - ● super-effective and ○ not-very-effective hits;
  - the result.

The graph appears in each battle card after an analysis (**HP timeline**) and in the Validate tab once a video is validated.

### Move data from the battle date
Fast moves are rebalanced over time (28 fast moves changed between March 2025 and October 2026, e.g. Charm 15 → 12 power, Mud Slap 12 → 11). Damage is therefore fitted with PvPoke’s game data as of the **battle date**: the browser fetches `gamemaster.min.json` at the last PvPoke commit on or before that date (through the GitHub connector on claude.ai) and falls back to current data, saying so, if it can’t. Benchmark scripts take `GAMEMASTER=path`. With current data, the March 2025 Claydol looked 53% Shadow (its Mud Slap hits seemed 9% too strong); with March 2025 data it is 0% Shadow, matching the reviewer’s answer.

### Shadow status
Damage carries the Shadow multipliers, but within one CP the attack stat can vary by about ±8%, which blurs the 20% Shadow effect. Per battle, the estimate for a known Shadow (Electivire) ranged from 4% to 100%. The visual cue is also unreliable for automation: every Pokémon casts a purplish ground shadow on the night arena, and Dark/Ghost moves add purple effects. Shadow is therefore asked as a review question unless the evidence is decisive.

### What the first 76 reviewer answers taught the model
All 75 questions from the three benchmark recordings were answered (Shadow 41, fast move 33, plus a form and a result). On these deliberately uncertain cases the model had picked the right Shadow status 20 of 33 times and the right fast move 20 of 32 times. Findings, from `tests/meta-benchmark/calibrate.cjs` and `tune.cjs`:

- **No large measurement bias.** Under the confirmed answers, measured hits average 98% (opponent → you) and 96% (you → opponent) of PvPoke’s prediction, so predictions are now scaled by 0.97. But half of matchups sit more than ~±10% from the prediction, comparable to the 20% Shadow effect, so damage alone is close to a coin flip for Shadow (mean log-probability −0.63 vs −0.69 for a guess).
- **Priors matter most.** Some species use a fast move PvPoke doesn’t favour (Inkay was Psywave in all 4 battles; Cradily Bullet Seed and Mandibuzz Air Slash in 3 each), and about 1 in 4 opponents was a Shadow (10 of 41), not 1 in 2.
- **Learned priors, tested leave-one-out** (each answer predicted with priors from the other answers only): fast moves 20 → 27 of 32 right, Shadow 20 → 27 of 33 right. The learned Shadow prior starts from the overall confirmed Shadow rate and is refined by each species’ own answers; fast-move counts blend with PvPoke’s prior (worth 4 answers).

`tune-learned.cjs` reproduces the leave-one-out comparison; `fold-answers.cjs` folds new answers into `learned.json` and the benchmark labels.

### Current accuracy (v3 + effect text, 2026-10-11)
Leave-one-out over 195 answers on 9 videos: 6 YouTube uploads from 3 channels, plus 3 of your phone
recordings.
- **Fast moves:** 89 of 99 (87 before the effect text). Damage, timing, the first 12 s of each
  matchup, the SUPER EFFECTIVE / NOT VERY EFFECTIVE text, learned priors, and charged-move energy and
  movesets all contribute.
- **Shadow:** 53 of 66 (v23 run). Damage, charged-attack damage, the purple aura and learned priors contribute.
  Charged hits raised it from 50, and improved confidence in the right answer (log score −0.504 → −0.462).
- **Battle level, all 9 videos:**
  - every battle, opponent species and result is correct, except the battle where you left the app;
  - leads and complete teams are correct except one Master League battle;
  - YouTube forfeits 6 of 6.

### What 195 answers taught the model (YouTube pilot, 2026-10-10)
119 answers on 6 Creative Commons YouTube videos (3 channels, phone screens of different sizes and
encodings) were added to the 76 from your own recordings. Every figure below is leave-one-out over all
195 answers. Each answer is predicted with priors learned from the others, never from its own Pokémon.

- **Confident calls held up.** In the spot checks, 13/14 fast moves and 9/10 Shadow calls were right.
  The model was right on the 3 hand-made questions too: two creator forfeits and one lead.
- **Charged-attack damage was counted as a fast-move hit.** After a cutscene, `hits()` used the wrong
  gap to decide whether a drop was a charged attack. A stray reading made a hidden charged hit look
  like a fast move 0.5 s before the real ones, which favoured weak one-turn moves (Bite, Lick, Ember)
  over Shadow Claw and Rollout. Fixed. Fast moves went from 84 to 85 of 99 right, and the log-score
  improved from −0.420 to −0.400.
- **Form priors follow PvPoke rankings.** Look-alike forms (Dialga vs Dialga Origin) used to start at
  50/50. They are now weighted by ranking score (exp(Δscore/4)), and reviewer form answers count too
  (`learned.forms`).
- **Shadow** is 51–52 of 62 with priors and the aura, up from 34. The scoring script had been ignoring
  learned Shadow rates; the app itself was unaffected. The aura bands are refitted on 92 matchups;
  per Pokémon the aura separates Shadow from regular with AUC 0.96 on YouTube footage. A third band
  did not help.
- **Still wrong: 14 of 99 fast moves.** Half come from the two edited highlight reels, whose cuts break
  HP tracking. The rest are pairs the damage can't settle with few hits (Morpeko Thunder Shock/Bite,
  Golurk Mud Slap/Astonish, Steelix Thunder Fang/Dragon Tail).

### Visual Shadow detector (`aura.js`)
Shadow Pokémon carry dark violet flames. During the HP-bar pass, each side’s Pokémon is located just below its bar (the opponent’s in a box under its bar; yours in the larger foreground area under yours), and each frame gives the share of aura-violet pixels (hue 262–305°, saturation ≥ 0.38, value 0.22–0.85). A matchup is summarized by the median over frames, so one-off Shadow Ball or Psychic effects don’t dominate.

On the benchmark (opponent truth from the 41 answers; your team’s truth from its pooled estimate): your side separates almost perfectly (Shadow median 4.6% vs 0%, AUC 0.98); the opponent separates well when your Pokémon is regular (0.6% vs 0%, AUC 0.90; 0.94 per Pokémon). When your Pokémon is a Shadow, its flames reach the opponent’s area (regular opponents then read 4.2%, AUC 0.68), so those matchups are left out. A red-eye cue (bright red pixels) was tried and dropped: AUC ≈ 0.5, the eyes are a few pixels and red attack effects swamp them.

The cue enters as a likelihood ratio from two bands fitted on the answers (purple < 0.1%: 3 Shadow vs 26 regular; ≥ 0.1%: 10 vs 2), combined across matchups like the damage evidence and applied to the Shadow forms. Leave-one-out on the answers, Shadow calls went from 27 to 30 of 33 right (mean log-probability −0.59 → −0.35) on top of damage and learned priors. Species whose own body reads as purple (Drapion, confirmed regular while purple was seen) are excluded; a “not Shadow” answer given while purple was seen adds that species automatically. Known misses: large or small models whose aura falls outside the box (two Shadow Steelix, a Shadow Skorupi).

### Review questions (`questions.js`)
After analysis the review pane shows a short queue of questions that need a person: a regional form the icons couldn’t settle, a Shadow estimate between 15% and 85% (or with no measurable fast moves), a fast move below 85% confidence, and a battle result nobody could read. Each question shows three frames cropped to what matters (the type icons, the opponent, your Pokémon or the middle of the screen), a button that plays the relevant moment, the evidence in plain words, and answer buttons with the model’s confidence. “Not sure” records the question without changing anything; “Ask later” moves on. Questions about your own Pokémon are asked once and applied to every battle. Answers restrict the joint posterior (confirming Shadow can settle the fast move), set the species id once form and Shadow status are known, and are kept in each battle’s `reviewLog` so they can become benchmark labels.

### Validate view and the learning loop (`validation.js`)
The **Validate** tab lists every open question, whether it came from a video you analyzed in the browser or from a benchmark run Claude did for you, and works without any video loaded. Each question is answered from the recording itself: the small evidence crops stored with each question (8 frames, 220 px wide) are too small to judge from and are no longer shown; the analysis itself always reads full-resolution frames. **Open recording** loads the original video from your device (nothing is uploaded): each question then shows the full frame first, in a player positioned at its moment, with the question and answer buttons directly below. Scrub with the video’s own timeline; **Play** and **Restart** (back to the question’s moment) are the only extra controls. Answering (or Not sure / Skip) moves straight to the next question and starts playing its moment.

- **Storage.** On claude.ai, questions live in the artifact’s shared store at `validation/<id>` and answers at `answers/<id>` (value, label, the model’s pick, time, who answered). Owners and editors can answer; view-only visitors can look. Frames are embedded as small JPEGs (≈ 60 KB per question) rather than uploaded as artifact assets, because declaring assets would make the page organization-only. Outside claude.ai, answers are kept in this browser.
- **Learning.** Answers become per-species learned priors (`MetaQuestions.learnedFromAnswers`): confirmed fast moves blend with PvPoke’s prior (which counts as 4 observations), and confirmed Shadow answers set that species’ Shadow share. Every new analysis in the browser uses them. Claude’s benchmark exports can use the same answers (`export-questions.cjs … learned.json`).
- **Accuracy.** Each answer is compared with the model’s pick, and the view reports how often the model was right per question kind, so improvements (or regressions) are visible.
- **Claude’s test runs.** After a benchmark run, `node tests/meta-benchmark/export-questions.cjs RUN.json VIDEO OUTDIR` writes one question document per open question, which Claude uploads to the artifact’s store. Answers are read back from `answers` (saved to a folder) and folded in with `node tests/meta-benchmark/fold-answers.cjs FOLDER`, which writes `learned.json` for refits/exports and records each answer under `verified` in the matching benchmark label.

### Validate only what the model is unsure of
After a browser analysis finishes, everything below the question thresholds is sent to the Validate tab automatically, so nobody has to rewatch whole battles. The thresholds are the same as in the review pane:
- a fast move below 85%;
- a Shadow estimate between 15% and 85%;
- an unsettled regional form;
- an unread result.

Each question carries its clip times, so answering only plays those few seconds of the recording. The checkbox **Send uncertain detections to the Validate tab** (on by default) controls this.

With the questions, each battle's summary is stored at `analyses/<recording>#<n>`. The summary holds:
- the teams, the fast moves with confidence, and Shadow estimates;
- the events, relative to the battle start;
- the HP timeline as whole percents.

No video, frames or trainer names are stored. Under **Your analyses**, each recording shows how many questions are left. Once none are left it is **Validated**, and **View analysis** shows every battle's timeline graph with the answers applied: confirmed fast moves, Shadow status, forms and results.

## Contributor workflow

1. Select an English-language battle recording. Portrait screen recordings work best; browser codec support determines which MP4/MOV/WebM files can be decoded. iPhone recordings are HEVC (H.265): Chrome, Edge and Safari on macOS decode them, Firefox does not. H.264 MP4 is the most portable choice.
2. Set the actual **recording date**, league, cup and rating bracket. The recording date deliberately does not default to today: old recordings must not masquerade as current usage.
3. Optional: pause during a normal battle and use **Read this frame** to check the nameplate reading (names, Poké Balls, shields). The layout is found automatically; only the charged-attack banner box is adjustable.
4. Select a start/end range and sampling (keyframes by default), then analyze. Cancel preserves partial detections. First use loads a local English OCR model; subsequent sessions reuse its browser cache.
5. Review every battle. Search exact species/form names in the inputs. Verify Shadow/region/form visually, correct the outcome, boundary times and lead. Mark the battle reviewed. Do not fill in Pokémon that were never revealed.
6. Save reviewed battles. Observations can be reversibly excluded/restored from the sample. The observed-meta view gives appearances, confirmed leads, complete-team counts, known-outcome win rate and a battle log. Export reviewed reports to combine samples from other players. The team-training export includes only real, complete opponent teams with verified leads.

## What was ported

Original files inspected: `textDetectorFast.py`, `textDetector.py`, `classes.py`, and reference image/array files. The portrait name ROI layout and change-gated crop OCR idea are preserved. OpenCV / FFmpeg / pytesseract subprocesses are replaced by the browser’s video decoder, Canvas crop processing and a persistent Tesseract.js worker. Battle assembly is rewritten as a reviewable state machine rather than using result screens as the sole boundaries.

The original local source remains untouched. No private recordings or their frames are shipped with the site. The example report is synthetic, labeled, and excluded from team-training exports.

## Processing pipeline

### 1. Decode and sample

A single HTML video element seeks monotonically through a selected range. Sampling modes are 1, 2 or 4 frames per second. There is no array of full video frames and no full-file buffer. Individual crop images are ephemeral. Browser seeking can decode intervening keyframes repeatedly; this is a single decoder, **not a guarantee of one-pass hardware decoding**. For hour-long recordings, a future native FFmpeg streaming worker could outperform browser seeking.

The only content digest buffers the first/last 64 KiB, not an entire gigabyte recording. Its SHA-256 plus file size forms a repeat-file fingerprint. Battle IDs combine that fingerprint and the half-second start time. Reprocessing the same file/range generally overwrites its same detected battles rather than counting them twice. Re-encoding, alternate sampling boundaries and edited clips are not reliably deduplicated yet.

### 2. Small crops and inexpensive change detection

Five calibrated regions are used: contributor name, opponent name, win result, loss result, charged-attack banner. An optional standard-nameplate gate skips name OCR when fewer than 35% of the downsampled crop pixels are bright. Disable this optimization for altered UI colors, tight text-only crops or edited layouts. Charged-attack capture can also be disabled for a teams/results-only pass. Each crop is downsampled to 96×12; pixels with average RGB >200 form a binary fingerprint. Changed-pixel fraction ≥0.04 triggers another OCR read. Stable names are checked again every three seconds, and still-unconfirmed sightings are checked at the next sample. Stable result/banner crops are normally checked after four seconds, with a shorter retry when a result needs confirmation.

The result and banner reads normally occur when nameplate OCR is absent, with a roughly three-second fallback. A missing nameplate during a charge animation is not itself a result. The threshold is resolution-independent but not layout/lighting-independent; it is a heuristic that needs broader validation. It can miss tiny text changes and can over-trigger on bright backgrounds.

### 3. OCR and dictionary matching

Tesseract.js 6.0.1 / core 6.0.0 run in a persistent Web Worker, using the English `tessdata_fast` model and line segmentation (PSM 7). Crops below 48 pixels high are upscaled 2× before OCR. Assets are served from this site, avoiding runtime OCR CDN dependencies. A single worker bounds CPU/memory demand; separate contributors parallelize computation on their own devices.

Names use the bundled PvPoke Game Master (snapshot already used by PvPoke Pro). Normalization removes case, accents and punctuation and strips a CP token. Full lines are matched, supporting names such as Mr. Mime and Tapu Fini. Exact visible-name matches can map to several species IDs (regular / Shadow / region / special form). These remain **unresolved**. An edit-distance-one match for strings at least five characters long is a **suggestion only**, never an automatic form assignment. Arbitrary nicknames and other languages are not resolved.

OCR confidence is Tesseract’s score, not a calibrated probability of species correctness. Confidence must be at least 45 for a name observation, and two matching observations less than five seconds apart are needed to confirm a sighting. Per-battle duplicate base-name sightings are merged. This cannot automatically distinguish two forms of the same base species; review is necessary, and standard GBL species-duplication rules constrain legitimate teams.

### 4. Battle structure

`core.js` contains the pure tracker and aggregator; `ui.js` handles video, OCR, correction and persistence.

- A battle candidate starts after repeated names, with a flag to confirm its actual start and lead.
- A Pokémon reveal records first/last timestamps, OCR text, confidence and candidate forms.
- At most three distinct visible species are allowed per side. A fourth starts a new **flagged** candidate.
- More than 22 seconds since a valid name observation creates a **flagged** gap boundary. Long consecutive charge animations or edited footage can produce false splits.
- Win/loss and charged-banner crops threshold near-white letters (all RGB channels >200) to black on white. `YOU WIN` / `GOOD EFFORT` tolerate one OCR character error after normalization; exact `YOU LOSE` / `TIE` also work. Results require confidence ≥55 and a repeated reading within five seconds; a detected result triggers a confirmation sample 0.15 seconds later to help capture short-lived screens. Results close the current candidate, and a short cooldown avoids repeatedly creating the same result.
- End of file, cancellation, decode errors and missed result screens preserve partial candidates as **Unknown**, never implicitly as losses.
- A charged banner must match “<actor> used <move>” and a named PvPoke move. Assignment to a side is made only if the actor uniquely matches one side’s revealed team. Mirror species are left unassigned. The timeline is observational; omitted attacks are not inferred.

PvPoke supplies name/form/type/move vocabulary and three-member team constraints. It does **not** supply an OCR detector. Its battle rules motivate future consistency checks: charge energy feasibility, fast-move cadence, faint / switch timing and shield counts. Those checks require reliable additional observations and must not invent events to make a video fit a simulation.

## Meta and trainer outputs

The reviewed report has `schema: "meta-extractor-v1"`, battle IDs, recording context, teams, outcomes, events, confidence, manual-review flags and timestamps. Imported files are bounded to 10 MB and 5,000 battles; species IDs and basic context are validated. Repeated battle IDs are skipped on import. Raw videos are not exported.

Species appearance rate = reviewed battles revealing that species / reviewed battle count. This is a **lower bound** with partial opponent teams. A win rate uses only confirmed Win/Loss outcomes; ties and Unknown are excluded. These statistics describe the contributed sample, not a representative global population.

Complete teams require exactly three confirmed distinct species (Pokédex number when known), human review and confirmed lead. Leads remain first; bench members are sorted for counting equivalent teams. Trainer export excludes synthetic examples and requires one rating bracket, with league/cup/date filtering. It uses the existing trainer import format:

```json
{"source":"Meta Extractor: human-reviewed video observations","cp":1500,"cup":"all","collectedAt":"latest recording date","rank":"2200–2400","teams":[{"members":["melmetal","cramorant","jumpluff"],"count":1,"collectedAt":"2026-10-09"}]}
```

The reviewed report retains each battle’s original date. The trainer export keeps it too: teams are counted per recording date (`teams[].collectedAt`), and the top-level `collectedAt` is the latest recording date, so `--usage-half-life` ages battles from when they were played. Moveset and IV uncertainty is not resolved by that team-only format; the trainer’s opponent initialization still applies.

## Audit: improvements over the original prototype

| Original issue | Demo improvement |
| --- | --- |
| Fixed filename and environment dependencies | File input, drop zone, browser OCR; no Python setup for visitors |
| Hard-coded geometry | Normalized, editable crop rectangles and visible overlays |
| Two full decodes for names plus result passes | One video decoder servicing all crops |
| Resolution-dependent raw pixel norm | Fixed-size normalized fingerprints |
| Highest-confidence single word | Complete line recognition and multiword dictionary |
| Dictionary file reread on each OCR | Indexed Game Master dictionary loaded once |
| Exact matching only | Conservative one-character suggestions, explicitly unassigned |
| Result screens create all battle ranges | Repeated sightings, three-species constraint, result/gap boundaries |
| Missing result merges/drops evidence | Retained partial candidates and Unknown outcome |
| No form ambiguity handling | Explicit candidates and searchable manual form review |
| No lead verification | Lead selector / confirmation before complete-team export |
| No cancellation or review evidence | Progress, stop/partial results, timestamps and video seek links |
| No charged-attack capture | Conditional banner OCR and move vocabulary validation |
| No reproducible contributed data format | Reviewed reports, merging, repeat-file IDs, trainer export |
| Implicit win/loss counting | Confirmed-result denominator and Unknown/tie preservation |
| Output lacks sampling strata | Recording date, league, cup and rating metadata |

## Remaining priorities, ordered by impact

**Status (2026-10-10):**
- Done:
  - automatic HUD localization (`screen.js`, `calibrate`);
  - stronger state detection (surrender dialog, gap-resume rule, merge/split tools);
  - single-pass sampling (replaces items 4–5);
  - energy and moveset reconciliation, plus charged-attack damage (7);
  - shared submission service (8, as an opt-in artifact-database sample);
  - cross-upload deduplication (9);
  - per-contributor caps, contributor counts and recency weighting (10);
  - uncertainty intervals and a PvPoke-backed prior (11).
- Open:
  - a labelled corpus beyond the 9 benchmark videos (1);
  - learned form/Shadow classifiers (6), deferred until more answers exist (see "OCR or our own
    machine-learning model?");
  - authentication and moderation for a public contribution service.

The original list follows.

1. **Labeled benchmark corpus.** Manually label every battle boundary, reveal, exact form, result and charge in recordings across iOS/Android layouts. Measure complete-team exact accuracy, species precision/recall, result accuracy, segmentation errors, correction time, seconds/video-minute and OCR calls. Split by contributor/video, not adjacent frames.
2. **Automatic HUD localization.** Find the two symmetric nameplates and canonical UI anchors; derive crop transforms including letterboxing and overlays. Save device-specific crop profiles. Calibrated detection beats guessing frame coordinates.
3. **Stronger state detection.** Detect battle countdown, Vs, result and faint/switch panels cheaply before OCR. Combine multiple cues rather than relying on the 22-second gap. Add explicit split/merge tools.
4. **Adaptive two-pass sampling.** Cheap sequential scan finds HUD changes; densely resample short reveal/result windows only. A bounded native FFmpeg pipeline can decode once and batch small crops, particularly for long recordings.
5. **Text-aware change gate.** Mask nameplate text, normalize illumination and compare connected glyph regions. Cache repeated crop OCR results. Keep a periodic fallback to measure missed changes.
6. **Form/Shadow visual classifiers.** Use silhouette/type icons/Shadow effects with a labeled model. Expose confidence and alternative candidates; never turn an uncertain regular form into a high-confidence meta count.
7. **Contributor battle analysis.** Extract shields, HP bars and switch/faint timestamps, then reconcile a constrained energy interval with legal moves. Different IVs, unknown fast moves, lag and desync prevent exact energy claims. Only simulate counterfactuals after sufficient verified state is known.
8. **Shared structured submission service.** Preserve on-device video processing; upload only consented reviewed observations with contributor ID, cup/date/rating, evidence provenance and revision history. Use durable database storage, authentication, rate limits, idempotent submission IDs, review status and correction/deletion controls. Optional short cropped evidence can be opt-in; raw full videos need not be stored.
9. **Cross-upload deduplication.** Robust event-sequence / perceptual fingerprints identify reposts or overlapping clips, while not falsely collapsing repeated battles against the same team.
10. **Representative sampling.** Ask for continuous sets, not highlight reels. Stratify by cup, date and rating; cap contribution influence per player and report contributor counts. Do not treat repeated observations from one creator as independent. Recent usage should decay with time and reset across balance updates/cup changes. Complete-only samples can bias toward longer/closer battles: preserve partial evidence and model censoring separately.
11. **Quality-aware training prior.** Use observed full-team counts, uncertainty intervals and a PvPoke-backed prior when observations are sparse. Learn correlations / team archetypes from real teams rather than independently sampling high-ranked species. Keep holdout contributors and a recent evaluation window.

## Verification

`node --test tests/meta-extractor.test.cjs` checks full-line normalization, form ambiguity, conservative fuzzy matching, repeated sightings, duplicate filtering, missing results, charge-gap handling, boundaries, result confirmation, reviewed-only counting and lead/bench semantics.

Real-video browser checks use the original local `src/10min.mp4` (886×1920, 650 seconds, approximately 1.16 GB). Its metadata date is March 5, 2025; it is a test fixture, **not current-meta evidence**. The initial 150-second test took 34.8 seconds, 302 OCR reads and revealed all three Pokémon on each side of the first battle, plus the next battle’s start. That first test missed the Win screen; it prompted separate narrow win/loss crops. See the final validation note for the subsequent result.

No benchmark currently establishes global extraction accuracy or a speedup over the original native prototype. Its README’s previous native timings (roughly 66 seconds for its ten-minute file) were not measured again under identical conditions; browser seeking and extra move capture are different workloads.

## Dependencies and attribution

- Original prototype: https://github.com/evanjfries/PoGoAnalyzer (user-owned local source)
- Pokémon/move data: https://github.com/pvpoke/pvpoke (existing bundled Game Master)
- Browser OCR: https://github.com/naptha/tesseract.js, https://github.com/naptha/tesseract.js-core
- English fast LSTM data: https://github.com/tesseract-ocr/tessdata_fast
- OCR dependency license texts are retained in `vendor/`.

Final full-recording check before the last speed refinements: 650 seconds processed in **154.4 seconds**, with **1,694 OCR reads**, four battle candidates and three revealed Pokémon per side for each candidate. Two Wins were confirmed; the third result was missed and the fourth battle ended without a result in the file. “Quwilfish” remained a fuzzy, unresolved suggestion. This demonstrates why review remains mandatory. Later refinements add a pale-nameplate gate, tighter thresholded charged-banner crop, and a 0.15-second result confirmation sample. The full timing does not establish a speedup over the native prototype.

Final optimized 150-second browser check: **32.2 seconds**, **304 OCR reads**, the complete first battle plus the next battle’s opening. The first Win was detected at about 1:58. The tighter charged-text crop recovered Mandibuzz’s Aerial Ace / Shadow Ball, Hatterene’s Psyshock and Claydol’s Scorching Sands / Rock Tomb with clear actor labels, where the broader crop had garbled several actors. This is a single recording, not a general accuracy estimate.
