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
| Result | A YOU WIN / GOOD EFFORT screen (read only when the battle can have ended). Without one, the timeline: three dark balls, or two plus the last HP bar emptied at the end (*Results without a result screen*). | Result screen, ball count, HP bars | No result screen and an undecided timeline: unresolvable when the video cuts to the next battle or ends, else asked |
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
4. **Battle structure from the HUD** (`HudTracker`). Fainted Poké Balls and used shields only increase within a battle, so a reset to fresh nameplates on both sides starts the next battle. Without a result screen the timeline decides when it can (`inferResult`, *Results without a result screen*). A YOU WIN / GOOD EFFORT screen is read only when a battle can have ended (a side down to its last Pokémon, a fade to black, or 8 s without nameplates), and only when the white text is result-sized (70–115 reference px tall). Matchmaking text ends the search. A win with opponent Pokémon left is flagged as a probable early exit.
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
Two type icons sit above each nameplate (yours at x 37/81, the opponent’s at 801/850 of an 886-wide frame; a single type sits in the outer slot). `core.js` reads each disc’s colour from its lower half (the phone status bar can cover the top) and matches it to 18 fitted type colours, rejecting anything more than 40 apart. Icons lag a switch by up to a second, so votes are only taken once a name has held for two samples. On 368 icon samples from the benchmark recordings, colour alone was right 357 times; all 11 misses were sampling the previous Pokémon’s icons or a frame without icons, which the stable-name rule removes. The majority type set keeps only matching forms (e.g. ghost → Galarian Corsola; ground/electric → regular Stunfisk). Shadow and regular forms share types, so Shadow is decided separately. Since v4 the icons also enter as a likelihood. A confusion model allows for missed icons and for colour shifts within a video, so a reading that matches no form still counts as evidence (see *Fast moves and forms from 228 human labels* below).

### Fast moves from HP bars (`hp.js`, `combat.js`)
Each matchup (the same two Pokémon facing each other for ≥ 3 s) is sampled ~10 times per second. HP bars are found from their fill (teal, yellow or red), a solid rectangle 9–18 rows tall with a straight left edge, and must show their outline (see *HP bars on YouTube footage* below). Your bar starts near the left edge; the opponent’s mid-screen; the bar whose left edge recurs through the window is kept. HP never rises within a matchup, so the fill is read as a descending staircase: upward readings (attack glow sweeping over a bar) are ignored and a step counts once two readings confirm it. The orange trail that appears with a hit equals the HP lost and gives the size when no earlier trail remains. Damage that appears after the bars were hidden for more than 1.2 s is a charged attack and is excluded.

Each hit is compared with PvPoke’s formula, `⌊power × STAB × attack/defense × effectiveness × 0.5 × 1.3⌋ + 1` (Shadow: ×1.2 attack, ×0.833 defense), over every level/IV combination consistent with both nameplate CPs. One combination per side must explain both directions at once (its attack sets the damage it deals; its defense and HP the damage it takes). The spacing of hits must fit the move’s duration in 0.5 s turns. PvPoke’s recommended moveset and simulated move usage give a gentle prior. Matchups with the same opponent Pokémon are combined; your own Pokémon are pooled across all battles in the recording. Example: Claydol (CP 1492) against Guzzlord (CP 1498) hit for 5.6–6.0% every 3 turns: Mud Slap predicts 5.2–6.2% per 3 turns; Confusion and Extrasensory don’t fit.

### HP bars on YouTube footage (`hp.js` findBars, 2026-10-11)
Why bars were missed or misread on YouTube crops (223 nameplate-visible frames from 7 labelled videos):
- **Colour test.** Re-encoding shifts the teal fill from (30,254,194) to about (0,228,172), outside the old
  RGB distance of 70. Pixels are now classed by hue windows (teal 148–186°, yellow 47–72°, red ≥ 344° or
  ≤ 12°, trail 20–46°) with value ≥ 0.7 and saturation ≥ 0.38.
- **Split blobs.** Blurred left edges wobble by 3 px; each row was compared with the blob's *first* row
  (≤ 2 px), so a 14-row fill broke into two 7-row pieces, both rejected as too short. Rows now link to the
  previous row (≤ 2 px, ≤ 4 px overall), on the fill or the trail end; a 1–3 px gap (ringing between fill
  and trail) no longer ends a run.
- **False bars.** Grass, attack effects and Pokémon make fill-coloured rectangles. 55% of the opponent bars
  and 10% of your bars the old detector assigned had no outline at all. Every blob must now show the bar's
  outline (white for the opponent, light blue for you): a line 2–10 px above or below the fill, brighter
  than the rows 3 px above and below it, along ≥ 50% of the bar. The score is bimodal: 94% of other blobs
  score < 0.1, real bars ≥ 0.9. The best-outlined bar wins each side.
- **Band.** Bars sit above the Pokémon: Primal Kyogre, Necrozma and short 16:9 screens put them at
  y ≈ 370, above the old 450–1350 search band. `BAND` is now 300–1450 (run-node and the browser).
- **Sub-pixel fill.** Fill and trail ends are a trimmed mean over the fill's rows, not one row's pixel.
- **Flicker.** On heavy compression the fill end flickers 1–3% between frames. A step must also clear 3× the
  series' median frame-to-frame jitter (`hits` noiseK); clean footage is unaffected.
- Not a cause: crops and scale (outline width is 246 px in every probed video), dy calibration (bars don't
  use it; nameplates are absent mainly during charged-attack cutscenes).

Results (the same 223 frames; valid = outline present):

| | Your bar found (valid) | Opponent bar found (valid) | False bars |
| --- | --- | --- | --- |
| Old | 94 (85) | 139 (62) | 9 + 77 |
| New | 139 | 131 | 0 in a 40-frame visual check |

All 37 labelled videos were re-extracted with their saved crops, ranges, league and game data; every
battle structure was unchanged (`reextract-labelled.cjs`). Results:
- **Coverage.** Matchup frames with a bar: 31% → 41% (yours), 31% → 37% (opponent). The old count
  included false bars.
- **Hits.** Fast-move labels with < 2 hits: 84 → 43 of 197 (no hits: 56 → 20). Shadow labels whose
  Pokémon has no hits: 56 → 35 of 210.
- **Damage noise.** Measured/predicted damage per hit for the true move: IQR 0.79–1.22 → 0.76–1.15. Stray
  readings (< 0.6 or > 1.5): 23% → 24%. No matchup has more hits than the true move allows.

Held out by video, with the models' parameters unchanged:

| | Before | After |
| --- | --- | --- |
| Fast moves | 161/197, log-loss 0.428 | **165/197, 0.393** (feedback 67 → 72/89) |
| Forms | 23/31, 0.352 | **26/31**, 0.380 |
| Shadow classifier | 157/208, 0.495, AUC 0.823 | **171/208, 0.356, AUC 0.917** |

Measured on the benchmark recordings (no fast-move labels yet): your team’s fast moves were consistent across battles (Azumarill Bubble, Galarian Corsola Astonish, Registeel Lock-On, Corviknight Sand Attack, Electivire Thunder Shock in 17 of 19 battles, Scrafty Counter in 15 of 18, Ferroseed Metal Claw in 14 of 16). Confirming them with the contributor is the next validation step.

### Battles from zero-battle videos (2026-10-11)

52 harvested videos showed the battle HUD on the probe's keyframes (more than 20 keyframes in 46) but gave
0 battles. Where they were lost, from the saved results plus 10 re-downloaded and 12 cached videos:

| Cause | Videos | Stage that drops the battle |
| --- | --- | --- |
| Game UI in Japanese (26), Korean (16) or Chinese (1) | 43 of 52 | Nameplate OCR and dictionary: no name matches the English list, and the HUD tracker keeps only battles with a species. Over all 462 saved analyses, 101 of 102 Japanese-titled, 39 of 41 Korean and 20 of 20 Chinese videos had no battle. |
| Wrong first calibration | 3c8JZ4pQq50 | Calibration dy: set once, on a team card (−20 instead of 7); 37 of 2,479 HUD frames read. |
| Phone top cropped into the nameplates | L2Iyrc06j00 (Japanese) | Calibration dy: ≈ −128, below the −120 limit; never calibrated. |
| Wrong screen: static art passes the HUD test | u2jAMngLVBw | Screen locate: a facecam panel with a palette of red dots read "balls" on 29 of 32 frames (the phone 24). |
| Screen box 1–11% too wide (frame borders) | GMF7uTFAyHM; afvH9iu5WsE (with a language) | Screen locate: the opponent's third ball reads '?', so no fresh HUD is seen and battles merge, or calibration fails. |
| Stream chat over the nameplates | c-aCjcD7OxQ | Not recoverable: names are covered. |
| No battles (PvPoke rankings page) | DxiBdcqzQME | Correct: 0 battles, before and after. |
| Other English videos with ≤ 14 HUD keyframes (Rocket, events, raids) | 4 | Not examined. |

The same causes cost battles in videos that did produce some:
- German UIs read 1.39 opponent species per battle (English 2.49).
- No German, Spanish or Portuguese result screen was ever read (0 of 464 battles).
- 17 videos had a "battle" longer than 330 s: merged battles, mostly bordered screens.
- maw_a7oKYMM (Chinese, unprobed before) changes its nameplate offset between battles (22 and 37), and a
  bezel line 1% outside the screen hid the HUD from the locator.
- 24 saved battles were the first 0–18 s of a battle split off (a shield or ball misread while the HUD
  settled), and 8 were a single HUD frame.

**Fixes**
- **Other UI languages** (`core.js` LOCALES, `species-names.json`). Species names in Japanese, Korean,
  Chinese (traditional and simplified), German, French, Spanish and Italian come from PokeAPI's CSV data
  (`tests/meta-benchmark/build-species-names.cjs`, BSD-3-Clause), keyed by Pokédex number and mapped to
  the same PvPoke entries as the English name; Mega and Primal forms carry the language's prefix.
  - Latin-script names are matched on the English OCR text. CJK plates are read again with Tesseract's
    `jpn`, `kor`, `chi_tra`, `chi_sim` fast models (`~/.cache/gbl-synapse/tessdata`, `TESSDATA_LOCALES`;
    run-node uses only the models present). Japanese OCR look-alikes (一/ー, 口/ロ, hiragana, small kana)
    and a stray digit or letter at either end are folded.
  - `NameLanguage` decides the video's language from exact matches of distinct species: it switches once,
    after two exact matches (or one long one while English has none). Until then the other languages are
    only consulted, so English videos keep their results. CJK reads stop after English has 3 species or
    40 unread plates. Plates cached as unreadable are read again after the switch.
  - Result screens: DU HAST GEWONNEN! / GUT GEKÄMPFT!, ¡GANASTE! / ¡HAS GANADO! / ¡BUEN INTENTO!,
    VOCÊ VENCEU! / ÓTIMA TENTATIVA! (read from harvested videos). The CJK videos examined cut their result
    screens, so CJK results come only from the Poké Ball count.
  - The browser reads the Latin-script languages; CJK models are fetched on demand (2026-10-12, below).
- **Recalibration** (`core.js` HudOffset, run-node and the browser).
  - A frame whose HUD doesn't read is calibrated again: every 4th such frame until the offset has named a
    species, then every 20th. A new offset (> 4 px from every proven one) is kept only if its nameplates
    name a species on that frame.
  - Proven offsets are tried before calibrating, since some videos change the offset between battles
    (maw_a7oKYMM: 22 and 37). Videos with one offset are unchanged.
  - `calibrate` tries offsets below −120 (down to −150) only when the usual range finds nothing, and boxes
    are clipped at the frame top: uploads that crop the phone's top can leave the names at the edge
    (L2Iyrc06j00: dy ≈ −128).
- **Screen locate** (`screen.js`, probe and browser).
  - A frame counts for a candidate box only if both name boxes hold text (≥ 12 ink cells; real names
    100–200), which rejects static art.
  - `refine`: the six Poké Ball centres on the ball row give the screen's true left edge and width (least
    squares, median over ≥ 3 frames); applied when the box is off by ≥ 0.8% or its width by ≥ 1.2%, and only
    if the HUD reads on at least as many frames.
  - When nothing is found, strong-edge candidates are tried with each side moved in by 1–3% (a bezel line
    just outside the screen: maw_a7oKYMM). This costs about 12 s more on videos without a HUD.
- **Split starts and one-frame battles** (`core.js` HudTracker).
  - A fresh HUD within 20 s of a battle's start, with the nameplates on screen throughout (gaps < 8 s) and
    nobody fainted, continues the battle; the misread "used" shields are cleared.
  - A battle seen on a single HUD frame that opened mid-battle is dropped when a later HUD closes it (kept at
    the end of a recording).
- **Wide, tablet-shaped screens** (`hp.js` barSettings/assignBars/track, run-node and the browser). After
  cropping, phones measure 0.39–0.57 (width/height), tablets 0.62–0.75. Bar positions on 5 wide and 4 phone
  videos:
  - Your bar starts at x ≈ 110–145 of 886 on wide screens (phones 50–80), outside the phone window, so your
    HP series was empty.
  - In a charged-attack cutscene the attacker's bar is drawn centred (x ≈ 320) on every screen, whoever
    attacks. That is inside the opponent's window, so your cutscene bar was read as the opponent's (aura,
    effect text).
  - Screens ≥ 0.6 now use x 30–230 for your bar and skip centred bars. Phone screens keep the old rule: there
    a centred bar can be the opponent's, which is why the earlier guard changed normal videos.
  - Outline colour isn't used: the opponent's outline is bluer (b − r +13…+50 against −29…+5 for yours), but
    the ranges depend on the video and encoding.
  - S67R41DZFuY: matchups with hits on your bar 6 → 18 of 23 (7 → 72 hits); ORyJbp1_81k: 8 → 18 of 28
    (9 → 50). Opponent hits are unchanged except two single hits (0.33, 0.05) from centred bars. 50 harvested
    videos measure ≥ 0.55; they had hits on your bar in 11–43% of matchups (phones 64–68%).

**Battles recovered.** Harvest path (probe → plan → run-node) with the final code; German and wide videos
with their saved crop. Before = the saved harvest result.

| Video | UI | Battles | Opp. species | Results | Full teams | What fixed it |
| --- | --- | --- | --- | --- | --- | --- |
| afvH9iu5WsE | ja | 0 → 5 | 0 → 14 | 0 → 0 | 0 → 4 | language, box refit (2.4%) |
| lC6aiKQuZ5c | ja | 0 → 7 | 0 → 20 | 0 → 0 | 0 → 6 | language |
| stLd7OkIg3Y | ja | 0 → 4 | 0 → 12 | 0 → 0 | 0 → 4 | language |
| L2Iyrc06j00 | ja | 0 → 6 | 0 → 8 | 0 → 0 | 0 → 0 | language, offset −129 |
| -mROfxnNVBk | ko | 0 → 5 | 0 → 12 | 0 → 3 | 0 → 3 | language (288 × 640 source; your names are nicknames) |
| maw_a7oKYMM | zh-Hant | 0 → 6 | 0 → 16 | 0 → 0 | 0 → 4 | language, inset locate, second offset |
| 3c8JZ4pQq50 | en | 0 → 12 | 0 → 36 | 0 → 2 | 0 → 12 | recalibration (−20 → 8) |
| u2jAMngLVBw | en | 0 → 10 | 0 → 30 | 0 → 1 | 0 → 10 | name-text guard (phone instead of facecam art) |
| c-aCjcD7OxQ | en | 0 → 0 | | | | covered by stream chat |
| DxiBdcqzQME | en | 0 → 0 | | | | no battles (PvPoke page) |
| GMF7uTFAyHM | en | 1 → 9 | 1 → 24 | 1 → 2 | 0 → 6 | box refit (11%) |
| cVMJbsB5l9c | en | 1 → 10 | 3 → 29 | 0 → 0 | 1 → 9 | box refit (7%) |
| vPjKop__xf0 | en | 4 → 10 | 12 → 30 | 1 → 2 | 4 → 10 | box refit (2.7%) |
| glOZKkCcUq0 | en | 12 → 18 | 35 → 54 | 6 → 6 | 11 → 18 | box refit (1.9%) |
| khxysRLr8AE | es | 1 → 4 | 3 → 10 | 0 → 1 | 1 → 3 | box refit (1.3%) |
| eEO7b_y_u4c | es | 1 → 5 | 3 → 15 | 0 → 0 | 1 → 5 | today's locator already finds this box (stale saved crop) |
| ktg6J7if8Rc | de | 8 → 16 | 10 → 44 | 0 → 15 | 0 → 13 | language, result text |
| aOHJSU0dVok | de | 6 → 10 | 9 → 29 | 0 → 10 | 1 → 9 | language, result text |
| cGATSvEItIM | de | 15 → 14 | 12 → 36 | 0 → 10 | 0 → 9 | language, result text; a 2-s split start merged |

The sampled videos that gave no battle went from 0 to 55 battles (8 of 10 videos), including 33 in the 6 sampled from
the 52. In an earlier run, the German creators' Master League videos (PbzVRPgmBQY, ftCqcw8_b2U: same names
as English) went from 0 to 10 results each.

**Checks**
- **Labelled benchmark** (HEAD vs this code, same crops): all 9 recordings (10min, hour-gl, hour and the 6 CC
  videos) produce identical JSON (timings aside), so the scores are unchanged: every battle found with 0
  extra, and 100% opponent species (194/194 in the seven battle-labelled recordings plus 39/39 in the two
  species-labelled reels).
- **parity.cjs** (7 stretches, HEAD vs this code): 5 identical. ptxHuMJ5XuE (a wide screen) and PbzVRPgmBQY
  (German UI, wide) differ only in HP-based inference, plus PbzVRPgmBQY gains a "GUT GEKÄMPFT" loss. A
  structural run (boundaries, species, results) on those two and on S67R41DZFuY and ORyJbp1_81k (whole
  videos) found every battle unchanged.
- **Box refit on working videos** (13 of 74 cached videos get a refit box): 5bUC_RoKQZU, EEnbQKeE0hQ,
  GT2HaKrxyDc and NW3GlL5ayBI keep their battles and species (5, 5, 17, 10); two gain a result. The other
  located boxes are unchanged.
- **Team Rocket**: 4xAdR0ReAsc (Rocket grunts) keeps its 11 battles, and all 11 are still flagged
  (`league.rocket_evidence`).
- **No false battles**: a PvPoke rankings page full of Pokémon names (DxiBdcqzQME) and nameplates covered by
  stream chat (c-aCjcD7OxQ) still give 0. English videos never switched language. Battles under 30 s among the
  results: one split start in khxysRLr8AE, 3 + 1 tracker splits in cGATSvEItIM and ktg6J7if8Rc (the same kind
  as in the saved results), and the Rocket battles of 4xAdR0ReAsc (short in both runs).
- Removed by the tracker rules, all noise: the one-frame battle in ktg6J7if8Rc at 1751.5 s (the real battle
  starts 0.5 s later) and a 2-s start in cGATSvEItIM.

**Left** (see the follow-up below for what 2026-10-12 closed)
- Not examined: the 4 English videos with ≤ 14 HUD keyframes (Rocket, events).
- The no-HUD probe is about 12 s slower (inset search).
- `aura-features.cjs` (the Shadow agent's) still assigns bars with the phone windows.

### Result screens, banners and battle boundaries in other languages (2026-10-12)

**Game strings.** Taken from the game's own localisation (Pokémon GO i18n text as datamined publicly by PokeMiners,
`pogo_assets/Texts`; only the few strings below are copied, as matchers):

| Key | ja | ko | zh-Hant | de / fr / it / es / pt |
| --- | --- | --- | --- | --- |
| combat_result_victory / _defeat | WIN! / NICE TRY! | YOU WIN! / NICE TRY! | 獲勝！/ 辛苦了！ | DU HAST GEWONNEN! … / GAGNÉ ! · BEL EFFORT ! / Hai vinto! · Peccato! / (es, pt already read) |
| battle_charged_move_callout | XはYを使った！ | X(은)는 Y(을)를 썼다! | X 使出了 Y！(two lines) | X hat Y eingesetzt! / X a utilisé Y ! / X usa Y! / ¡X ha usado Y! · ¡X usó Y! / X usou Y! |
| battle_throw_callout (_opponent) | ゆけっ！X！(相手が Xをくりだした！) | 가랏! X! (상대가 X(을)를 내보냈다!) | 上吧！X！(對手派出了X！) | Los, X! / Vas-y, X ! / Vai, X! / ¡Adelante, X! / Vamos, X! |
| combat_surrender, matchmaking, effectiveness | 降参しますか？… | 항복하고… | 要投降並退出對戰嗎？… | all five languages |

- **Results** (`core.js` RESULT_TEXT, outcome): the Japanese and Korean screens are in English letters, so the English
  OCR reads them ("WIN!" must be exact; 6+ letter phrases tolerate one wrong letter). Chinese screens are read again with
  `chi_tra` when the English read finds nothing (`run-node.cjs`, `ui.js`). Surrender dialogs of a CJK video are read with
  its model; matchmaking text (`isMatchmaking`) in every language.
- **Banners** (`core.js` parseLocalBanner, localBanner): English is parsed first, exactly as before. Otherwise the
  Latin-script patterns are tried on the same text (Spanish, Italian and Portuguese videos stay `en`, their names being
  English), and a CJK video's banner is read only with its model. The actor goes through the species dictionaries
  (English key), the move through `move-names.json`: PokeAPI `move_names.csv` (BSD-3-Clause; Japanese kana names, as the
  game) mapped to PvPoke moves by English name (`tests/meta-benchmark/build-move-names.cjs`; 348 of 352 PvPoke moves).
  Checked against the game's own move names: 345/349 ja, 344 ko, 344 zh-Hant, 345 de, 345 it, 338 fr, 336 es identical.
  A "+" move gives way to the plain one; names shared by typed variants (Weather Ball, Techno Blast, Hidden Power)
  are not resolved.
- **Finding CJK banners** (`core.js` bannerEdges): their thin strokes over the translucent box are pale blue on a light
  sky (≈150,215,255), so the white-pixel test that finds English banners saw 0.2% text on a Japanese banner and read
  none. A CJK video's banners are found by sharp brightness steps instead (2.5–3.4% of pixels on banners, ≤ 1.8%
  otherwise), the box moved up or down by up to its height to the band with most steps (some phones put the text above
  the English box), twice as tall for Chinese; read as plain grey, not as white text.
- **Effectiveness** (`hp.js` effectKind): the five Latin languages' texts and the CJK ones (read with the video's model)
  are recognised when the English rule finds nothing. Few are seen: the text needs a located HP bar under it.

Before → after on the cached test videos (HEAD 9657478 vs this code, same crops; results = result screen or surrender):

| Video | UI | Battles | Results read | "X used Y" | "Go"/"sent out" |
| --- | --- | --- | --- | --- | --- |
| afvH9iu5WsE | ja | 5 → 5 | 0 → 0 (result screens cut) | 0 → 27 | 0 → 25 |
| lC6aiKQuZ5c | ja | 7 → 7 | 0 → 3 | 0 → 36 | 0 → 29 |
| stLd7OkIg3Y | ja | 4 → 4 | 0 → 4 | 0 → 36 | 0 → 20 |
| L2Iyrc06j00 | ja | 6 → 6 | 0 → 0 (cut) | 0 → 44 | 0 → 24 |
| -mROfxnNVBk | ko | 5 → 5 | 3 → 5 | 0 → 40 | 0 → 17 |
| maw_a7oKYMM | zh-Hant | 6 → 7 | 0 → 0 (cut) | 0 → 6 | 0 → 24 |
| ktg6J7if8Rc | de | 16 → 15 | 15 → 15 | 0 → 121 | 0 → 105 |
| aOHJSU0dVok | de | 10 → 10 | 10 → 10 | 0 → 40 | 0 → 64 |
| cGATSvEItIM | de | 14 → 10 | 10 → 10 | 0 → 73 | 0 → 80 |

**Battle boundaries** (`core.js` HudTracker; diagnosed by replaying recorded tracker calls of 17 videos):
- *Splits.* A fresh HUD (all balls, both shields) after a "used" shield starts a new battle. In the saved new-code results
  the remaining 28–56 s splits all came from **one frame on which two shields vanished at once** (both sides, or one side
  2 → 0) right before a fresh HUD: the shield icons hide as a charged attack starts. Such a jump, shown for ≤ 3 s and
  followed within 15 s (a cutscene) by a fresh HUD with nobody fainted, is now a misread; a real shield takes one.
- *Merges.* cBePYfn3m1U read your first ball as fainted on every frame, so no HUD was ever fresh and four battles merged
  into one of 772 s, separated only by fades to black. After a fade to black, a HUD returning ≥ 3 s later with fewer
  fainted Pokémon than the battle has seen now starts the next battle (fainted counts never go down within one).
- Effect (replayed, same OCR): cGATSvEItIM 14 → 10 battles, ktg6J7if8Rc 16 → 15, 0lQexfzN7e0, 2SA7zcwXR4w, 2xJ2kb-_P6k,
  ZY_8dEQE1x0 one fewer each (the 28–56 s parts rejoined), ginzc90Wae4 7 → 6, cBePYfn3m1U 1 → 4, maw_a7oKYMM 6 → 7 (two
  "more than three opponent species" battles split at their fades); oF54HR4xMiA, xnSxb3QLToc and the other test
  videos unchanged.

**Browser** (`ui.js`). Latin-script results, banners and effectiveness work as in Node. CJK models (jsDelivr,
`cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.1.0/`, the same files as `~/.cache/gbl-synapse/tessdata`: kor
verified byte-identical) are fetched only when needed: after 6 distinct plates without an English or Latin name while no
language is decided, Japanese, Korean, then Chinese (1.7–2.5 MB each) are tried on up to 8 plates each, with a status
message; `NameLanguage` switches after two exact matches as in Node, the other models are released, and results,
banners, dialogs and effect texts are read with the video's model. If a model can't be fetched (offline, or a page such
as the claude.ai artifact that blocks the download) the run continues in English and the final status says to use the
local app or the Node runner. Checked in a browser: the Japanese model loads from the CDN and reads ゼクロム (92%).

**Checks.** `meta-locale.test.cjs` (strings, banners, effect texts, the split rules). parity.cjs against main
(97f5142): 5 of 7 stretches identical; bB0ZrWjwdZw (a Spanish UI) and PbzVRPgmBQY (German) differ only by the newly read
banners ("¡Adelante, Carbink!", "Altaria ha usado Fuerza Lunar!") and the inference they feed; boundaries, species and
results unchanged. Labelled benchmark: 8 of the 9 recordings (10min, hour-gl, hour, 5 CC videos) give identical JSON against
main; 1p_u7XyvWwU's battles 1, 2 and 4 now end at their last battle HUD (199, 386, 715 s) instead of at a transition HUD
18–25 s later, after the result screen and a fade (the post-fade rule). score.cjs is unchanged everywhere (all battles
found, 0 extra, every opponent species, the same results).

**Left**
- Results of videos that cut their result screens (most CJK uploads) still come only from the Poké Ball count.
- Chinese two-line banners read poorly with `chi_tra` fast (maw_a7oKYMM); effectiveness texts need the HP-bar locator.
- Spanish move names differ from the game's for 13 moves (PokeAPI uses newer translations); Portuguese move names
  aren't in PokeAPI, so Portuguese "X usou Y!" banners resolve only English-named moves.
- The remaining ">3 species" battle in cBePYfn3m1U (534–781 s) has no fade to split on.

### Results without a result screen (2026-10-12)

Most of the result questions came from videos that cut from the end of a battle straight to the next one. `core.js`
`inferResult` now settles a result from the battle timeline when no result screen was read, and stops asking when the
footage can't show one. A read result screen and a reviewer's answer always win. Measured on the saved harvest results
(1,422 battles with a read result screen, the rules run as if none had been read) and the owner's 51 result answers
(`tests/meta-benchmark/result-policy.cjs` repeats it):

| Rule (`resultSource`) | Right vs read results | Right vs answers | Shipped |
|---|---|---|---|
| `faints`: Poké Ball counter at 3 for one side, battle seen from its start | 41/41 | – | yes |
| same, recording started mid-battle | 7/15 | – | only if the HP bar agrees |
| `faints`: counter at 2 on one side and ≤ 1 on the other, that side's last HP bar empty (≤ 3%) within 3 s of the end, the other ≥ 10% | 67/67 (105/105 with the above) | 3/3 | yes |
| same with two fainted on both sides | 41/49 | – | no |
| `surrender`: the dialog, then the HUD gone within 3 s → you forfeited | 118/118 | – | yes (was already used) |
| fade to black with both bars alive → the opponent forfeited | 7/12 wins | 10/14 forfeits | no |

The game fades to black at every battle end (knockouts, forfeits and surrenders alike: 34 of 62 undecided battles in 14
cached videos faded within 4 s of the last HUD, as did the read ones), so a fade doesn't identify a forfeit; the final
knockout usually happens during a charged-attack cutscene, without HP bars. The first fade after the last HUD is kept as
`fadeAt` for later work. Timer endings (both sides alive at 0:00, decided by remaining HP) would need the clock, which
isn't read: they stay questions.

When nothing decides, the result is `unresolvable` (no question) if the next battle's HUD appears within 10 s of the last
one (a cut, or under 3 s a split battle) or the recording ends within 10 s; otherwise the question stays. A result-sized
white text band that OCR couldn't read (`resultUnread`, recorded from now on) keeps the question: a person can read it.
Caveats from the same data: 126 battles whose result screen *was* read would also have met the cut rule (a result screen
shown for a second before the cut), and 34 of the owner's 51 answers were in battles this rule now calls unresolvable
(14 wins, 13 opponent forfeits, 6 losses, 1 tie): a person watching the last frames can often tell. Closures are
reversible policy records, so Reopen brings any of them back.

Where it runs: `HudTracker.finish({videoEnd})`, then `applyInferredResults` again in `run-node.cjs` and `ui.js` once the
matchups' HP series exist, and in `refit.cjs` on every refit, so saved results get the current rules without decoding
(older saved results lack `fadeAt`/`resultUnread`; the next re-extraction adds them). In Validate, `learning-loop.cjs`
settles open result questions with a `timeline` resolution (the inferred value) or closes them with a `policy` record
(value none, reason "No result screen; timeline inconclusive"); both are re-derived each refit, neither is a label, and
policy closures are counted apart from model resolutions. The metrics record each refit's results by source (read /
inferred / human / unresolvable / open) and the inferred results' agreement with reviewer answers ("Battle outcomes ·
timeline vs your answers"). Observed meta and the usage export apply timeline results like read ones, human answers
still win, and team win rates show how many results were read, inferred or answered. Dry run on 2026-10-12: of the open
result questions, 64 are settled by the timeline (58 faints, 6 surrender), 775 closed as unresolvable, 717 still asked.

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
Since 2026-10-11 the final Shadow probability comes from the learned classifier below (**Shadow classifier**); damage and aura feed it.

**Forms without a Shadow variant (2026-10-12).** Origin Forme Palkia/Dialga, every Mega and many regional forms have no Shadow in Pokémon GO. PvPoke's gamemaster lists `<id>_shadow` only for forms with a released Shadow, so "this form id has a `_shadow` entry" is the eligibility rule (`MetaQuestions.shadowEligibility`). The form counts as settled when a person answered it, the top form has p ≥ .98, or one real form remains; otherwise Shadow is possible if any real candidate form has an entry. An ineligible Pokémon gets no Shadow question, its `inference.shadowP` is set to 0 (so the Observed view's `uncertain` clears) and the Shadow classifier's output is gated to 0 (`shadow-model.js applyToBattles`, features and training untouched). The learning loop resolves its open Shadow questions as "No" with reason "form has no Shadow variant" (`learning-loop.cjs noShadowForm`): a reversible `source: "model"` resolution, re-derived on every refit, using the gamemaster the run was fitted with (dated copies in `~/.cache/gbl-synapse/gamemaster/`). Question titles name the settled species in English from the gamemaster (`Qwilfish`, `Palkia (Origin)`), never the OCR text; Validate re-words stored questions from their `species`.

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

### Fast moves and forms from 228 human labels (v4, 2026-10-11)

**Data.** 197 confirmed fast moves and 31 confirmed forms on 37 videos. 89 fast moves and 25 forms come
from `feedback.json`; 108 and 6 come from the archived legacy labels in the work directory's `labels/`.
Each label is joined to the saved evidence in `results/<video>.json`
(`tests/meta-benchmark/movefit-data.cjs`). Game data is chosen by battle date:
- the run's `learningContext`;
- otherwise the cached PvPoke file for the upload or recording date. The four 2025 dates were added to
  `~/.cache/gbl-synapse/gamemaster/` from the local PvPoke clone and a Dec 2025 copy.

Every number below comes from cross-validation grouped by video (`movefit-eval.cjs`). Each labelled
video is refit from saved evidence, with priors learned only from the other videos. Shadow answers are
used as priors but not scored here.

**Where the old model failed** (`movefit-diagnose.cjs`). Baseline: 153/197 fast moves (62/89 on
feedback answers) and 15/31 forms.

1. **Energy checks counted visible-bar frames as fighting time.** On YouTube footage the HP bars are
   found in a median of 24% of matchup frames (both bars; 0.5 on your own recordings). Fighting time was
   therefore underestimated, and 41 of 265 energy checks (15%) said the *true* move couldn't have
   earned the energy. Each of those multiplied the true move by 0.05. With clock time on the field
   (entry to next switch, minus 5 s per charged-attack cutscene), 3 of 265 still fail.
2. **Damage noise was far too tight for large hits.** The model used a fixed σ of 0.65% of HP, with no
   part proportional to the hit. Under the true move, measured/predicted damage has a median of 0.96 and an
   IQR of 0.85–1.18, because the CP leaves a stat range and steps merge. A 14% Incinerate measured
   at 13% scored as a stray reading, and cadence then picked Bite. The fitted noise is σ 1.3% + 8% of the
   hit, 15% stray readings and a ×0.92 scale.
3. **Cadence was a single mode with hand-set penalties.** It is now a per-gap likelihood. Each gap
   between hits is a whole number of moves (later moves may be missed, with probability 0.35 each), a
   pause, or a stray detection, with 0.12 s timing jitter. Only 46 of 197 labels had a gap mode equal to
   the true move's duration, so the old mode test often pointed the wrong way.
4. **Too few hits.** 84 of 197 labels have fewer than two measured hits on the relevant bar. This comes
   from the same low bar coverage, so the answer rests on priors, energy and icons. The fitted PvPoke
   prior is worth 1 human label, not 4: species-level human answers are the better guide.
5. **Wrong league.** Legacy and some harvested runs had no league, which defaulted to Great League
   rankings for Master League battles. As a result, Dialga was called with p = 1.00 when the truth was
   Dialga Origin, three times. The league now comes from the nameplate CPs when they rule out the
   video's league (`refit.cjs battleLeague`).
6. **Type icons.** On 1,589 Pokémon whose species fixes their types, the majority icon reading matched
   the types only 946 times (60%). Two reasons:
   - a dual type is read as a single type in 47% of frames;
   - some videos shift colours (fire read as ground 10% of the time; 0/9 right in the worst video).

   The old rule only filtered forms on an exact match, so these readings carried no evidence. Ranking
   priors with temperature 4 then decided, sometimes at p ≈ 1.
7. **Unmeasured Pokémon got no answer.** 3 of 31 forms had no prediction at all because they had no matchup.

**What changed** (`combat.js`, with parameters in `FIT`; `movefit-fit.cjs` fits them by coordinate
search on the grouped-CV log-loss):

| Change (ablation: turning only it off) | Fast moves | log-loss |
| --- | --- | --- |
| v4, all changes | **162/197** | **0.426** |
| without gap likelihood (old cadence) | 156 | 0.474 |
| with the old damage noise | 158 | 0.465 |
| without energy (impossible totals not penalised) | 158 | 0.458 |
| PvPoke prior worth 4 labels | 162 | 0.450 |
| without icon evidence | 160 | 0.451 |

For forms, the new evidence sources are:
- **Icon confusion model.** P(read type | true type), fitted on the 1,589 Pokémon above, scores every
  form. Missing icons and colour shifts are allowed, and the model adapts to each video's own
  unambiguous Pokémon (weight 200 votes).
- **Tempering.** Frames repeat the same misreading, so the icon evidence counts as 2 independent reads.
- **Ranking temperature.** It drops from 4 to 2.
- **League from CP.**
- **Prior-only answers** for Pokémon without matchups.

Forms ablations: without icons 22/31 (log-loss 0.50); ranking temperature 4: 24/31 (0.30); without the
CP league: 21/31 (1.15).

`inferMatchup` now computes the per-hit likelihood of each move once per stat combination and then
multiplies, instead of scoring every (move, move, combination) triple. The results are identical
(tested), and a refit of all 37 labelled videos takes 5 s instead of 21 s.

**Before → after** (video-grouped CV, same labels):

| | Fast moves | log-loss | ECE | Forms | log-loss | ECE |
| --- | --- | --- | --- | --- | --- | --- |
| Old (HEAD 41b11f2) | 153/197 (feedback 62/89) | 0.575 | 0.048 | 15/31 (13/25) | 1.93 | 0.26 |
| v4 | **162/197 (68/89)** | **0.426** | **0.033** | **25/31 (19/25)** | **0.263** | 0.09 |
| v4 + Shadow classifier (merged) | 161/197 (67/89) | 0.428 | 0.039 | 23/31 (17/25) | 0.352 | 0.13 |

The Shadow classifier (`shadow-model.js setShadowP`) rescales each Pokémon's Shadow rows to its own
probability. When only one form has a Shadow variant, this also moves probability between forms. Two
of your forms flipped this way:
- Hisuian Typhlosion read as regular (p 0.68);
- Palkia Origin read as Palkia (p 0.67).

Fixed 2026-10-11: `setShadowP` now applies the classifier's change as a likelihood ratio within each form, so
form probabilities stay as the form model left them.

**Overfitting check.** The parameters were refitted on three quarters of the videos and scored on the
remaining quarter, for each quarter (`movefit-fit.cjs --nested 4`, one search round from the fitted
values). This gave 160/197 fast moves (log-loss 0.441), against 162/197 (0.426) with the parameters
fitted on all videos, so the gain is not an artefact of tuning.

**Calibration and auto-resolution.** The old model was overconfident: at p ≥ 0.98 it was right on
23/25 fast moves and 6/9 forms. v4 held-out accuracy by threshold:

| Threshold | Fast moves | Forms |
| --- | --- | --- |
| p ≥ 0.80 | 110/115 | 22/24 |
| p ≥ 0.90 | **80/81** (Wilson lower bound 0.93) | **19/19** |
| p ≥ 0.95 | 44/44 | 18/18 |

With the Shadow classifier merged, the learning loop's own held-out check gives:
- fast moves: 79/80 at p ≥ 0.90 (21 videos at p ≥ 0.80);
- forms: 16/16 at p ≥ 0.90.

How the learning loop resolves fast moves and forms (`learning-loop.cjs moveCalibration`):
- Every refit repeats this held-out check over all traceable human labels (feedback answers and legacy
  labels).
- It picks the lowest threshold whose resolved answers are ≥ 95% right at that threshold and every
  higher one. A higher threshold with fewer than 20 answers can't veto the pick.
- The pick must also cover ≥ 30 answers from ≥ 5 videos with a Wilson lower bound ≥ 0.90. The threshold
  is never below 0.90, and the margin to the runner-up must be ≥ 0.8.

Gates dropped for these two kinds, on this evidence:
- the 98% / four-hit / eight-same-species-labels gates. Confident prior-only calls were 24/24 right and
  1–3-hit calls 28/29. The old gates were unreachable in any case: calibration counted one answer per
  video and needed 50.

Gates kept:
- the label-free (new-labels-only) model must agree;
- audit spot checks stay open;
- human answers win.

Shadow keeps its previous gates.

Forms do not yet qualify: there are 21 held-out answers at the threshold, below the 30 required, so
none are auto-resolved.

On the open queue of 2026-10-11, a dry run of the learning loop resolves 19 of the 270 open fast-move
questions:
- 48 have p ≥ 0.90;
- the rest of those are audit spot checks, or the label-free model disagrees.

The app applies this at its next refit once it runs this code.

**Keeps improving.**
- `feedback.py` passes the work directory, channel and `learning/movefit-params.json` to the learning
  loop.
- After every 24 new fast-move/form answers, it reruns `movefit-fit.cjs` for both kinds from saved
  evidence (no video). The next refit applies the result as `learned.fit`, which the extractor and the
  browser also read.
- `learned.channels` holds your side's confirmed moves per channel, since a creator's team repeats. Its
  weight is fitted, and is currently 0: there are too few repeat channels to measure it.

**Refit on the new HP-bar evidence (2026-10-12).** The evidence settings had been fitted on the old hits.
`movefit-fit.cjs --rounds 2` on the 197 fast-move and 31 form labels (89 + 25 from `feedback.json`, unchanged
since 2026-10-11) moved five settings: damage noise relSigma 0.08 → 0.15, timing weight 0.5 → 0.25,
timing q 0.35 → 0.2 and tau 0.12 → 0.2, and learnWeight 1 → 0.5. Held out by video:
- fast moves 165/197 → 166/197, log-loss 0.385 → 0.339 (nested 4-fold, parameters fitted without the
  test videos: 0.392 → 0.376 at 165/197). At p ≥ 0.90: 97/99 → 102/103 right;
- forms 27/31 → 25/31 with log-loss 0.305 → 0.303 (forms use the same settings and don't auto-resolve).

The fit needs `refit.cjs` to drop a saved `typeLL` before recomputing it; otherwise a candidate with
`icons.w = 0` crashed the form fit (the learning loop's form fit hit it too).

**Remaining failures** (35 fast moves, 6 forms):
- Fast moves with fewer than two measured hits: 18 of 84 wrong (prior and energy only). The root cause
  is HP-bar detection on YouTube crops (24% frame coverage). Fixed in `hp.js` and all 37 videos
  re-extracted (see *HP bars on YouTube footage*).
- Fast moves with 4+ hits: 13 of 70 wrong, mostly pairs that hit equally hard on the same turns, such
  as Psywave/Tackle on Inkay and Shadow Claw/Metal Claw on Necrozma, or moves with mixed stray steps.
- Forms with identical types and no deciding move or icon:
  - Kyurem Black read as White (3, p 0.59–0.81);
  - Mega Mewtwo Y, whose nameplate OCR read X and whose icons weren't read (3, p 0.50).

  None of them reach the resolution threshold.

### Visual Shadow detector (`aura.js`)
Shadow Pokémon carry dark violet flames. During the HP-bar pass, each side’s Pokémon is located just below its bar (the opponent’s in a box under its bar; yours in the larger foreground area under yours), and each frame gives the share of aura-violet pixels (hue 262–305°, saturation ≥ 0.38, value 0.22–0.85). A matchup is summarized by the median over frames, so one-off Shadow Ball or Psychic effects don’t dominate.

On the benchmark (opponent truth from the 41 answers; your team’s truth from its pooled estimate): your side separates almost perfectly (Shadow median 4.6% vs 0%, AUC 0.98); the opponent separates well when your Pokémon is regular (0.6% vs 0%, AUC 0.90; 0.94 per Pokémon). When your Pokémon is a Shadow, its flames reach the opponent’s area (regular opponents then read 4.2%, AUC 0.68), so those matchups are left out. A red-eye cue (bright red pixels) was tried and dropped: AUC ≈ 0.5, the eyes are a few pixels and red attack effects swamp them.

The cue enters as a likelihood ratio from two bands fitted on the answers (purple < 0.1%: 3 Shadow vs 26 regular; ≥ 0.1%: 10 vs 2), combined across matchups like the damage evidence and applied to the Shadow forms. Leave-one-out on the answers, Shadow calls went from 27 to 30 of 33 right (mean log-probability −0.59 → −0.35) on top of damage and learned priors. Species whose own body reads as purple (Drapion, confirmed regular while purple was seen) are excluded; a “not Shadow” answer given while purple was seen adds that species automatically. Known misses: large or small models whose aura falls outside the box (two Shadow Steelix, a Shadow Skorupi).

### Shadow classifier (`shadow-model.js`, 2026-10-11)
On the questions people had answered, the model's Shadow pick was right only about half the time. Data: 210 human Shadow
labels (136 in `feedback.json`, 74 archived in `labels/*.json`); 208 could be joined to saved evidence (35 videos).
`shadow-dataset.cjs` rebuilds the table (each video refitted with priors from the other videos only);
`shadow-cv.cjs` cross-validates it by video.

**Why the old estimate failed** (numbers on the 208 labels):
- **Your own Pokémon never used the aura.** `aura.js` only scores opponents, yet your side separates best
  (YouTube: AUC 0.91, Shadow median 10% purple vs 0%). The old model got 23 of 43 of your Pokémon right.
- **The aura was two bands.** Any purple ≥ 0.1% counted the same, so 10–18% purple (an unmistakable flame)
  was outvoted by noisy damage. Clear Shadows such as Pidgeot, Quagsire, Marowak and Skuntank were left at 0.06–0.41.
- **Purple-bodied learning bug.** One "not Shadow" answer with purple ≥ 0.1% switches the aura off for that
  species for good. On live data 19 species are flagged, including Mewtwo, Tyranitar, Metagross, Venusaur and
  Annihilape. Usually the purple came from flames spilling over from your Shadow. The classifier uses a per-species
  purple baseline taken from all footage instead (Sableye and Drapion read purple; Mewtwo doesn't).
- **Damage can't tell which side is the Shadow.** Within a matchup, a Shadow on either side scales both damage
  directions by 1.2. Opponents were marginalised over your Pokémon's prior rather than its pooled estimate.
  Damage evidence alone: AUC 0.62. Species priors: AUC 0.53.
- **Missing measurements.** 64 of the 208 labelled Pokémon have no measured hits; 377 of the 1,371 matchups in
  these videos have none. The 360×640 upload `tPEBKgLqMuA` lost all its matchups (23 labels with no evidence at
  all) and `z24QfdmszfI` lost 53 of 53. CP misreads (14, 149) leave no stat combinations, so no fit. This needs
  re-extraction (HP-bar reader), not modelling.

**Model.** L2-regularised logistic regression (plain JS Newton steps, L2 = 8). Missing values are imputed at the
training mean, so they move nothing. Features:
- old posterior;
- target and other-side aura (log purple), your side and its interactions;
- the share of matchups with ≥ 0.5% purple;
- damage evidence conditioned on the other side's estimate;
- the species' high-purple rate in unlabelled footage;
- PvPoke's Shadow-minus-regular ranking score;
- focus-shot purple (`focusT`, `focusHi`, `focusN`; "Focus shots" below).

It runs after `MetaAura.applyToBattle` in `run-node.cjs`, the browser (`ui.js`) and `refit.cjs`. It rescales each
Pokémon's Shadow rows to the new probability, so forms and moves stay consistent; the old value is kept as
`inference.shadowPOld` and the features as `member.shadowModel`. `DEFAULT_MODEL` is committed
(`node shadow-cv.cjs --write-default`); the learning loop refits it from held-out refits on every pass
(`learned.shadowModel`).

| Leave-one-video-out, 208 labels | Old posterior | Classifier |
| --- | --- | --- |
| Right | 130 (62.5%) | **155 (74.5%)** |
| Log-loss / Brier | 0.653 / 0.230 | **0.513 / 0.169** |
| AUC | 0.685 | **0.814** |
| Your Pokémon / opponents | 23/43, 107/165 | 36/43, 119/165 |

Calibration (out of fold): predicted 0.07 / 0.20 / 0.40 / 0.60 / 0.80 / 0.94 → observed 0 / 0.20 / 0.43 / 0.55 /
0.86 / 0.82. With aura and hits both measured it is 115/144 (old 92); with neither it is 19/32 (old 18), barely above the prior.

**Focus shots (2026-10-11, second round).** Your Shadow's flames spill into the opponent's aura box, and the
opponent's box even shows your Pokémon while the camera frames it. During a charged attack the camera frames one
Pokémon at a time: the attacker as it launches (from the "X used Y!" banner, ~1 s), then the defender as it is hit
(after a ~1 s cut). That Pokémon fills the view with its HP bar centred above it, and the other side is out of
frame. `aura.js measureFocus` measures aura-purple in a box under a centred bar when your usual bar is absent;
`focusMoments` keeps bars ≥ 100 units below the opponent's usual bar, groups them into shots, names attacker and
defender from the banner, and assigns shots without a banner by HP fill (the bar's fill must match one side's fill
just before). Shielded defenders (the pink bubble reads as purple) and ghost/dark/poison/psychic moves (purple
effects) are skipped. Run-node and the browser record `b.focus`; `focus-backfill.cjs` measures old runs from video
into `WORK/focus/<id>.json`, which `shadow-dataset.cjs` and the learning loop attach. Features: `focusT` (log median
purple over shots), `focusHi` (share of shots ≥ 0.5% purple), `focusN` (log shot count; 0 = no shots, the others are
then imputed). On labelled Pokémon with shots, median focus purple is 0.0% (regular) vs 14% (Shadow); AUC 0.91
(0.94 for opponents facing your Shadow, where the old aura has 0.75).

| Leave-one-video-out, 410 labels (125 videos) | Classifier before | With focus features |
| --- | --- | --- |
| Right / log-loss / AUC | 299 (72.9%) / 0.504 / 0.829 | **323 (78.8%) / 0.461 / 0.870** |
| Your Pokémon (73) | 59 / 0.459 / 0.859 | **63 / 0.414 / 0.897** |
| Opponents (337) | 240 / 0.514 / 0.816 | **260 / 0.471 / 0.861** |
| Opponents facing your Shadow (120) | 88 / 0.543 / 0.774 | **98 / 0.453 / 0.886** |
| Opponents facing your regular (217) | 152 / 0.498 / 0.839 | **162 / 0.481 / 0.854** |
| Pokémon with focus shots (177) | 130 / 0.475 / 0.851 | **155 / 0.352 / 0.918** |
| Pokémon without (233) | 169 / 0.526 / 0.815 | 168 / 0.543 / 0.801 |

Both columns use the HP-bar re-extraction (3a6c2e0) and the 412 labels. 233 labels have no shots: 46 of the needed
videos could not be re-downloaded (YouTube bot checks), and some videos give no centred bars (low resolution, no HP
bars found). The model was about as accurate on both subsets before (73% vs 73%), so the gain is not from easier
videos; on the no-shot subset it is slightly worse (imputed focus features), which is why those questions use
separate thresholds (below). Chosen by video-grouped CV over L2 4/8/16 and focus-feature sets; `focusMax`,
`sideFocusT` and attacker/defender splits added nothing.

**Model resolution.** Thresholds are chosen per direction on out-of-fold predictions. "Not Shadow" at p ≤ 0.12 was
right 27 of 28 times (96%, Wilson lower bound 0.82, 14 videos). Choosing that threshold without the test video
(nested) gave 19 of 19. "Shadow" calls never reach 95% (the top 10 were 8 right), because purple-bodied species and
flames spilling over from the other side make false Shadows, so Shadow is never auto-resolved. The old gate
(posterior ≥ 0.98, ≥ 4 hits, 8 same-species labels, 50 held-out checks, lower bound ≥ 0.90) had collected one qualifying
Shadow check after 40 refits. For Shadow it is replaced by the classifier gate: ≥ 95% out-of-fold, ≥ 25 calls, ≥ 5 videos, lower bound
≥ 0.80, same call under priors learned only from traceable labels. Human answers still win, audit questions stay
open, and resolutions are recomputed (reversible) on every refit. On the live queue this resolves 15 of 135 open
Shadow questions as "not Shadow".

Second round (410 labels, focus features): "not Shadow" at confidence ≥ 0.72 was right 128/134 (Wilson 0.91, 56 videos;
nested 127/133) and "Shadow" at ≥ 0.94 27/28 (Wilson 0.82, 15 videos), so both directions pass the unchanged gate.
The Shadow direction is thin: chosen without the test video (nested) it was 14/16. Pokémon without focus shots are
judged against thresholds from held-out predictions with the focus features removed (`thresholdsNoFocus`: not Shadow
85/89 at ≥ 0.76, Shadow 32/33 at ≥ 0.89). A dry run of the learning loop on the app's last input resolves 383 of 993
open Shadow questions (347 not Shadow, 36 Shadow).

**Still wrong.** Shadows with no purple measured (aura box missed, e.g. Reuniclus, Cradily, your Sableye over
9 matchups); regular purple-bodied or low-resolution reads (Gyarados at 288×640, Sableye, Giratina); videos
without HP or aura evidence.

### Review questions (`questions.js`)
After analysis the review pane shows a short queue of questions that need a person: a regional form the icons couldn’t settle, a Shadow estimate between 15% and 85% (or with no measurable fast moves), a fast move below 85% confidence, and a battle result nobody could read. Each question shows three frames cropped to what matters (the type icons, the opponent, your Pokémon or the middle of the screen), a button that plays the relevant moment, the evidence in plain words, and answer buttons with the model’s confidence. “Not sure” records the question without changing anything; “Ask later” moves on. Questions about your own Pokémon are asked once and applied to every battle. Answers restrict the joint posterior (confirming Shadow can settle the fast move), set the species id once form and Shadow status are known, and are kept in each battle’s `reviewLog` so they can become benchmark labels.

### Validate view and the learning loop (`validation.js`)
The **Validate** tab lists every open question, whether it came from a video you analyzed in the browser or from a benchmark run Claude did for you, and works without any video loaded. Each question is answered from the recording itself: the small evidence crops stored with each question (8 frames, 220 px wide) are too small to judge from and are no longer shown; the analysis itself always reads full-resolution frames. **Open recording** loads the original video from your device (nothing is uploaded): each question then shows the full frame first, in a player positioned at its moment, with the question and answer buttons directly below. Scrub with the video’s own timeline; **Play** and **Restart** (back to the question’s moment) are the only extra controls. Answering (or Not sure / Skip) moves straight to the next question and starts playing its moment.

- **Storage.** On claude.ai, questions live in the artifact’s shared store at `validation/<id>` and answers at `answers/<id>` (value, label, the model’s pick, time, who answered). Owners and editors can answer; view-only visitors can look. Frames are embedded as small JPEGs (≈ 60 KB per question) rather than uploaded as artifact assets, because declaring assets would make the page organization-only. Outside claude.ai, answers are kept in this browser.
- **Learning.** Answers become per-species learned priors (`MetaQuestions.learnedFromAnswers`): confirmed fast moves blend with PvPoke’s prior (which counts as 4 observations), and confirmed Shadow answers set that species’ Shadow share. Every new analysis in the browser uses them. Claude’s benchmark exports can use the same answers (`export-questions.cjs … learned.json`).
- **Accuracy.** Each answer is compared with the model’s pick, and the view reports how often the model was right per question kind, so improvements (or regressions) are visible.
- **Claude’s test runs.** After a benchmark run, `node tests/meta-benchmark/export-questions.cjs RUN.json VIDEO OUTDIR` writes one question document per open question, which Claude uploads to the artifact’s store. Answers are read back from `answers` (saved to a folder) and folded in with `node tests/meta-benchmark/fold-answers.cjs FOLDER`, which writes `learned.json` for refits/exports and records each answer under `verified` in the matching benchmark label.

### Model performance view (`validation-metrics.js`, 2026-10-11)
Validate has two views: **Questions** (default, the answering flow) and **Model performance**. Switching
views keeps the player and the selected question; the choice is remembered in this browser.

- **Per-refit history.** After every successful refit `feedback.py` appends one record to
  `WORK/metrics-history.json` (`scripts/yt-harvest/metrics_history.py`, atomic write). Each record has:
  - the refit number, time, duration and reason;
  - human answers and confirmed labels per kind in the fit snapshot;
  - held-out-by-video right/total per kind (fast moves and forms add log-loss; Shadow adds log-loss, AUC,
    Brier and the old posterior as a baseline);
  - resolution gates (chosen and effective thresholds, support, lower bound, whether each kind resolves);
  - calibration bins (Shadow classifier, and the top pick for fast moves and forms);
  - resolved counts per source (model or free LLM) and kind, open counts per kind;
  - Shadow classifier and evidence-settings (movefit) versions.
  `GET /api/validation/metrics` serves the history. `/api/validation` carries only its revision and the
  latest record, so the page fetches the history once per refit. A second local server reads the file
  read-only.
- **Backfill.** The history file is created once, from saved files. For refits that ran before it existed:
  - time and runs come from `learning/refit-N/`;
  - label counts come from answer times, so they may include answers saved during that refit;
  - thresholds come from the reasons quoted in model resolutions.
  The newest refit's held-out metrics come from what it stored in `feedback.json`. These records are
  marked `backfilled` with their sources, and anything not recorded stays blank.
  Earlier offline evaluations (v4 moves, the Shadow classifier, HP bars, focus shots) are listed as
  milestones, not as refits.
- **View.**
  - Tiles: held-out accuracy per kind with the change since the previous refit; live answers,
    model-resolved and open counts.
  - Line charts over refits: accuracy per kind; Shadow AUC and log-loss against the old posterior.
  - Stacked columns: human answered, model resolved and open after each refit.
  - Calibration panels for the latest refit. Bins with fewer than 5 labels appear only in the table.
  - The resolution gates in words, plain-language notes, the milestones, and the full refit history.
  Every chart has a crosshair tooltip, arrow-key reading and a data table. The Meta card is dark in both
  page themes, so the chart colours are the dark-surface steps, validated against the card colours.
- **Hosted artifact.** With no local API, the view shows the counts it can see. It draws the charts from a
  shared-store document `metrics/<id>` with `format: "gbl-validation-metrics"`, if one was uploaded.
  Otherwise it says where the history comes from.

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

1. Select a battle recording. English, German, French, Spanish, Portuguese and Italian game UIs are read in the browser; for Japanese, Korean and Chinese ones the browser fetches that language's OCR model (about 2 MB) from jsDelivr when the nameplates aren't English, and points to the local app or Node runner if it can't (*Result screens, banners and battle boundaries in other languages*). Portrait screen recordings work best; browser codec support determines which MP4/MOV/WebM files can be decoded. iPhone recordings are HEVC (H.265): Chrome, Edge and Safari on macOS decode them, Firefox does not. H.264 MP4 is the most portable choice.
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

Names use the bundled PvPoke Game Master (snapshot already used by PvPoke Pro). Normalization removes case, accents and punctuation and strips a CP token. Full lines are matched, supporting names such as Mr. Mime and Tapu Fini. Exact visible-name matches can map to several species IDs (regular / Shadow / region / special form). These remain **unresolved**. An edit-distance-one match for strings at least five characters long is a **suggestion only**, never an automatic form assignment. Arbitrary nicknames are not resolved. Other game languages: see *Battles from zero-battle videos* below.

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
- English fast LSTM data: https://github.com/tesseract-ocr/tessdata_fast (the Node runner also uses its `jpn`, `kor`, `chi_tra` and `chi_sim` models, Apache-2.0, kept in `~/.cache/gbl-synapse/tessdata`, not in the project)
- Species names in other languages (`species-names.json`): https://github.com/PokeAPI/pokeapi, `data/v2/csv/pokemon_species_names.csv` (BSD-3-Clause)
- OCR dependency license texts are retained in `vendor/`.

Final full-recording check before the last speed refinements: 650 seconds processed in **154.4 seconds**, with **1,694 OCR reads**, four battle candidates and three revealed Pokémon per side for each candidate. Two Wins were confirmed; the third result was missed and the fourth battle ended without a result in the file. “Quwilfish” remained a fuzzy, unresolved suggestion. This demonstrates why review remains mandatory. Later refinements add a pale-nameplate gate, tighter thresholded charged-banner crop, and a 0.15-second result confirmation sample. The full timing does not establish a speedup over the native prototype.

Final optimized 150-second browser check: **32.2 seconds**, **304 OCR reads**, the complete first battle plus the next battle’s opening. The first Win was detected at about 1:58. The tighter charged-text crop recovered Mandibuzz’s Aerial Ace / Shadow Ball, Hatterene’s Psyshock and Claydol’s Scorching Sands / Rock Tomb with clear actor labels, where the broader crop had garbled several actors. This is a single recording, not a general accuracy estimate.
