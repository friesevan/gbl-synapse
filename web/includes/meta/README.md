# Meta Extractor — technical reference

The Meta Extractor turns recordings of Pokémon GO Battle League battles into structured battle records: which Pokémon each side used, which led, who won, the charged moves thrown, each Pokémon's fast move, Shadow status and regional form, shields and faints, and an HP timeline. It reads only what the screen shows, runs entirely on the contributor's own machine (in the browser for a single recording, in a Node batch engine for the YouTube harvest), asks a person about the few things it cannot settle, and learns from those answers. The resulting observed meta feeds [Team Rankings](../../training/team-search/README.md), the full-team neural network.

This is the technical reference. A short plain-language summary is in [README-plain.md](README-plain.md). This revision describes the code as of 2026-10-12.

> **Status in one paragraph.** On the labelled benchmark (9 recordings: 3 phones, 6 Creative Commons YouTube videos) every battle is found with none invented, every opponent species is read correctly (194 of 194, plus 39 of 39 in two edited reels), and every result is right except the one battle where the recorder left the app. Held out by video, fast moves are right 166 of 197 times (log-loss 0.339), regional forms 25 of 31, and the Shadow classifier 323 of 410 (AUC 0.87). The Node engine runs one video at 5–7× real time per worker and about 34× real time aggregated over 8 workers on a 12-core machine; decoding is now the largest cost. The biggest open problems are fast moves that hit equally hard on the same turns, Shadows whose flames the camera never frames, result screens cut from uploads, and the cost of video decoding itself.

## 1. Purpose, goals and design principles

### The problem

Published usage statistics for GO Battle League describe only what one website's users log by hand. Recordings exist in quantity: players record their sets, and creators upload hours of battles. Each recording contains everything needed to reconstruct the battle, but only as pixels. The extractor's job is to recover the battle record from those pixels with known, measured accuracy, cheaply enough to process thousands of hours, and without any footage leaving the machine it is on.

### Two goals, measured separately

| Goal | What is measured | How it is measured | Where the numbers are |
| --- | --- | --- | --- |
| **Accuracy** | per field: battle boundaries, species, lead, result, charged moves, fast move, Shadow, form | labelled benchmark (`score.cjs`, battle by battle) and human answers held out *by video* (`movefit-eval.cjs`, `shadow-cv.cjs`, `result-policy.cjs`) | section 7 |
| **Speed** | wall time and CPU per video-second, per worker and per machine; refit time without video | `run-node.cjs` metrics, `parity.cjs` (identical output check) and timed runs | section 8 |

Every model change is accepted only if the labelled benchmark is unchanged or better *and* the held-out answers improve (or the change is a pure speed-up with byte-identical output, checked by `parity.cjs`). Numbers quoted below are always from videos the fitted parameters never saw.

### Design principles, and why

1. **Read, never simulate.** The extractor records what is visible. It never invents an event to make a battle fit a simulation, and a missing result stays *Unknown* rather than becoming a loss. A dataset that silently filled gaps would bias the meta toward whatever the filler assumed.
2. **Pixel rules where the signal is fixed, OCR where text varies, learned models where the errors are.** Poké Balls, shields, type icons, HP bars and the purple aura are drawn at fixed positions in fixed colours, so hand-written colour and geometry rules are exact, fast and auditable. Names, CP, result banners and move banners are text and change constantly, so they go to OCR. Fast moves, forms and Shadow status are not written anywhere and must be inferred, so those are statistical models fitted to human answers (section 4).
3. **Ask people only when unsure, and never train on guesses.** Human answers are scarce and expensive. The pipeline asks only below confidence thresholds, orders questions by expected information, and keeps model outputs out of the label set. A model may stop asking a kind of question only after proving, on videos it was not fitted on, that it is at least 95% right (section 5).
4. **Everything local.** A recording is decoded on the contributor's machine. What leaves it, if the contributor chooses, is a structured summary: species, results, moves, dates, HP percentages. No frames, no video, no trainer names.
5. **One logic, two runtimes.** The battle logic (`core.js`, `hp.js`, `combat.js`, `aura.js`, `shadow-model.js`, `questions.js`) is shared by the browser and the Node engine, so a fix proven on the benchmark applies to both.

## 2. Architecture

![Meta Extractor architecture: sources, decoding, frame readers, the battle model, people in the loop, and outputs](docs/meta-architecture.svg)

| Stage | What it does | Files | Browser | Node |
| --- | --- | --- | --- | --- |
| Decode | Frames from the recording. Browser: the video element seeks keyframe to keyframe (`mp4index.js` reads keyframe times from the MP4 index without decoding). Node: one ffmpeg stream per file at 10 fps, already cropped and scaled. | `ui.js`, `mp4index.js`, `tests/meta-benchmark/run-node.cjs`, `run-batch.cjs`, `decode-plan.cjs` | yes | yes |
| Locate the phone screen | Wide uploads embed the phone beside a facecam. Persistent vertical edges give candidate columns; the column where the battle HUD reads on the most frames wins. Clips placed a few pixels apart get their own boxes. | `screen.js`, `probe.cjs`, `placement-plan.cjs` | yes | yes |
| Nameplates (HUD) | Both nameplates every sample: Poké Balls, shields, type icons, name and CP fingerprints; one OCR read per distinct name. | `core.js` (`readHud`, `calibrate`, `NameCache`) | yes | yes |
| Mid-screen text | Result screens, "X used Y!" and "Go, X!" banners, the surrender dialog, fades to black, in ten UI languages. | `core.js` (`bandStats`, `bannerBox`, `parseBanner`, `outcome`) | yes | yes |
| Dense pass | Every frame of a battle: HP bars, damage steps, Shadow aura, focus shots, effectiveness text. | `hp.js`, `aura.js` | yes (2× playback) | yes (every frame) |
| Battle tracker | Boundaries, reveals, lead, events and results from the HUD sequence. | `core.js` (`HudTracker`, `inferResult`) | yes | yes |
| Inference | Fast moves, forms and Shadow status from the evidence, with game data as of the battle date. | `combat.js`, `shadow-model.js` | yes | yes |
| Questions and Validate | Uncertain items become questions; answers are stored, scored and fed back. | `questions.js`, `validation.js`, `validation-policy.js`, `validation-metrics.js` | yes | questions written by `export-questions.cjs` |
| Learning loop | Refits priors, evidence settings and the Shadow classifier from saved evidence; held-out gates decide what may auto-resolve. | `scripts/yt-harvest/feedback.py`, `tests/meta-benchmark/learning-loop.cjs`, `refit.cjs`, `movefit-fit.cjs`, `shadow-cv.cjs` | | yes |
| Observed meta and exports | Battle catalog by league, cup and period; usage export for Team Rankings; deduplication. | `observed.py`, `observed-core.js`, `observed.js`, `usage_export.py`, `dedup.cjs` | yes | yes |

**Why two runtimes.** The browser version exists so that a contributor can analyse their own recording with nothing installed and nothing uploaded. The Node engine exists because a browser cannot decode hours of video quickly: it can only seek, it throttles hidden tabs, and it cannot run several files in parallel. The Node engine streams every frame once through ffmpeg, runs several files at once, caches OCR and probes on disk, and is what the YouTube harvester uses. Both call the same functions on the same 886-pixel-wide reference frame, so results agree.

**Reference geometry.** Every rule is written for a frame scaled to 886 pixels wide (the width of the first phone recording the prototype was built on). Wider or narrower screens are scaled to that width first; a vertical offset `dy` (found by calibration) absorbs cropped status bars. All coordinates below are in those reference pixels.

## 3. The frame: what is checked, where, and why

This section shows exactly what the extractor looks at. The figures are frames from two Creative Commons recordings (KZ FAM and PokeDeeGO, both CC BY), with the extractor's own boxes drawn by its own geometry functions.

### Locating the phone screen

![Phone screen located at the left of a wide upload (KZ FAM)](docs/frame-screen-kzfam.jpg)

![Phone screen located in the centre column of a wide upload (PokeDeeGO)](docs/frame-screen-pokedeego.jpg)

A phone recording fills the frame and needs no locating. A YouTube upload or stream usually puts the phone in a tall column beside a facecam, branding or a team card. `screen.js` samples frames across the range, measures how often each column of pixels is a sharp, persistent brightness step (`edgeProfile`, `peaks`), and tries each rectangle between candidate edges by reading the battle HUD inside it (`hudScore`). The rectangle where both nameplates read on the most frames wins. Four refinements came from harvest failures:

- A frame only counts if both name boxes hold text (at least 12 of the 64×12 fingerprint cells inked; real names have 100–200). A facecam panel with a palette of red dots once read as "Poké Balls" on more frames than the phone itself.
- `refine` fits the six Poké Ball centres by least squares over at least three frames and corrects the box when it is off by 0.8% or wider by 1.2%. Frame borders had made boxes 1–11% too wide, which pushed the opponent's third ball out of its box and merged battles.
- If nothing is found, strong-edge candidates are retried with each side moved in by 1–3% (a bezel line just outside the screen). This costs about 12 s on videos without a HUD.
- If that fails too, each frame's own strong edges are tried, kept only where the HUD reads inside them on that frame; the box that reads on the most frames (at least 20%) wins. The median search needs an edge in the same column on half the frames. Edited compilations place each battle clip a few pixels apart (Npoke: the right edge at 690–697 of 960 over five clips), and a dark arena against a dark backdrop hides the edge in most scenes (_bnPdUKMYpw: strong on 6 of 16 frames). Four Japanese Npoke uploads went from 0 to 19 battles (46 opponent species, 10 full teams) and the Spanish _bnPdUKMYpw from 0 to 11 (33 species, 11 full teams). One box fits only the clips placed within about 3 px of it; the other placements get their own boxes (next paragraph). This costs about 3 s more on videos without a HUD.

**Placements** (2026-10-17). Edited compilations place the phone a few pixels differently in each clip, and a box reads the HUD only within about 1% of its width. Measured on every keyframe of the four Npoke uploads, with the phone's left edge from its six Poké Balls (`ballFit`, at 960 wide):

| Video | Left edge per clip (HUD keyframes) | Keyframes the located box reads (each calibrated alone) |
| --- | --- | --- |
| M5ED7uc0aao (box 432) | 429.3 (19) · 438.2 (32) · 431.7 (20) · 435.7 (12) · 431.7 (19) | 19 · **0** · 20 · 4 · 19 |
| -QiUVfUf8jo (box 430) | 428.9 (24) · 430.9 (13) · 433.6 (28) · 430.9 (21) · 434.9 (12) | 24 · 13 · 22 · 21 · **0** |
| SwlQC3kwKIs (box 432) | 432.1 (14) · 434.1 (19) · 431.0 (17) · 427.5 (39) | 14 · 19 · 17 · 18 |
| avOqMEM2QmA (box 436) | 430.1 (13) · 433.9 (25) · 436.5 (42) · 438.3 (20) | **0** · 25 · 42 · 19 |

The width never changes (±0.5 px), the edge holds within ±0.3 px inside a clip, and every change falls in the 11–35 s without a HUD between two battles: placements change only at clip cuts (a clip may hold two battles). A clip 5–6.5 px from the box reads nothing (M5ED7uc0aao's 438 clip holds two battles), and at 3.6–4.5 px about half its keyframes read. The fix, in three places:

- **Finding them** (`screen.js` `placements`). On the probe's keyframes (its whole reservoir, up to 63) where the located box reads nothing, the box is moved sideways in steps of 0.75% of its width, up to 4%; where the HUD reads, the six balls give the screen's exact position, and its centre is compared with the box's centre. A placement must be at least 1% of the width from the box (nearer, the box reads it), and shifts within 0.6% of each other form one placement. Centres, not left edges: a box a little too wide stays centred on its screen (maw_a7oKYMM's box is 277 px for a 273.5 px screen; its left edge is 3.1 px out, its centre 1.35 px), and only a clip moved sideways moves the centre. Each frame's own edges can't do this: `peaks` keeps one edge per 6 px, and Npoke's art-panel border sits 6 px from the phone. Beyond one Poké Ball spacing (5.3%) the balls would read in the wrong slots.
- **Planning them** (`probe.cjs`). Up to three candidates are scanned over every keyframe like the box. Each HUD keyframe goes to the placement whose box centre is nearest the fitted centre, compared directly: a box between two clips (-QiUVfUf8jo's at 430, clips at 428.9 and 430.9) has no better margin of its own, and one taken from its reads moved a switch 70 s into the wrong clip there. The current placement stays while it reads, unless another is more than 0.3% of the width nearer: reads alone would put the switch anywhere in a clip 3–4 px off. A placement other than the located box needs at least 4 keyframes of its own. Only with two or more does the probe add `placements` ([{box, hits, stretches}], the timeline split halfway between the last keyframe of one placement and the first of the next); hits, ranges and coverage then count every placement. Without them the output is unchanged.
- **Decoding them** (`run-node.cjs`, `placement-plan.cjs`). The harvester passes `CROPS=x0,y0,x1,y1@s-e,…;…` with `CROP` (the located box), whether ranges or the whole video are decoded, and on the requeue path too. Each decode range is cut where the placement changes, and each piece is cropped with its own box into the same 886-wide frame (every box has the located box's size, so HP bars, aura and focus shots see the same geometry). Each placement keeps its own calibration and HudOffset, so an offset proven in one clip is never applied to another clip's box; one tracker runs throughout. The result keeps `crop` as the located box and lists `placements` with their stretches and offsets; `media.crops` records the plan; re-extraction tools (`parity.cjs`, `reextract-labelled.cjs`, `focus-backfill.cjs`, `media_cache.py` batch jobs through `run-batch.cjs`'s sixth column) reuse them, since the located box alone would lose those clips again. Frame crops for people and the local model keep using `crop`: a few pixels off still shows the nameplates.

Before → after on the four uploads (main's code, then this; the harvest path probe → plan → run-node and the requeue path, whole video with the probe's boxes, give the same after numbers): battles 17 → 21, opponent species 45 → 56 (requeue 44 → 56), full teams 13 → 16 (requeue 12 → 16), results 1 → 2. M5ED7uc0aao 4 → 6 battles (the 438 clip's two; species 8 → 13, a win from the Poké Ball counter), avOqMEM2QmA 4 → 5 (its first battle), -QiUVfUf8jo 4 → 5 (its last); SwlQC3kwKIs keeps 5, but the two battles of its 427.5 clip are now seen from the start (both "starts mid-battle" flags and a "more than three species" flag gone, the lead found). The probe found 3, 2, 2 and 2 placements; keyframes with a HUD 69 → 102, 87 → 100, 89 → 101 and 93 → 93; M5ED7uc0aao's ranges grew from 74% to the whole video.

Across the harvest: the placement step over the 256 retained single-screen uploads with a cached probe (4–30 s each, mostly the keyframe decode) finds placements in 7, the four above plus three: eQphfsMBt_A (Npoke, three placements; 3 → 4 battles, opponent species 8 → 12, full teams 2 → 4, a merged battle split), tePa5aI85zY (El Tío Boris, 720p, a clip 2.6 px off; 4 → 5 battles, 12 → 15 species, a merged battle split) and 0rJx8daiA3U (Npoke; counts unchanged, but its box had read a clip 13 px away through the Poké Balls one slot over, so that battle lost its "starts mid-battle" flag and gained a team member). The other 249 have no placements, and ten retained single-placement videos give byte-identical probe output (timings aside). A clip that changes the phone's size is not a placement (eQphfsMBt_A's last clip: 240.7 px wide at 359.6 instead of 260 at 431) and is still lost. The search costs about 3 s per probe (2.8 s on M5ED7uc0aao's 44 reservoir frames) plus one keyframe scan per candidate.

**The browser** can't scan every keyframe (it seeks), so `findScreen` keeps the placements in its 12 frames, and while the HUD doesn't read the known placements are tried. After 10 s without a HUD, the current frame is searched around the located box (at most every 10 s of video). A switch needs the balls to put the screen's centre within 1% of that box's centre, so a box a few pixels off can't take over a clip on one lucky read; each placement keeps its own HUD offset. A battle in a new placement can lose up to about 10 s from its start there.

**Why not a learned detector?** The screen is a rectangle with hard edges and a known interior; edge statistics plus a functional test ("does the HUD read here?") are exact and need no training data. The functional test also doubles as the keyframe pre-screen (`probe.cjs`), which decides whether a video has battles at all before the expensive pass.

### Nameplates: Poké Balls, shields, names, CP and type icons

![Nameplates: nameplate panels, name and CP OCR boxes, Poké Balls, shields and type icon discs](docs/frame-hud.jpg)

Both nameplates are read on every sampled frame (`readHud`). The geometry, in reference pixels:

| Element | Your side | Opponent | How it is read |
| --- | --- | --- | --- |
| Nameplate panel | 17–357 × 117–207 | 529–869 × 117–207 | mean colour must be pale and grey (all channels > 170, spread < 60); a pale menu card can pass, so readable Poké Balls are also required |
| Name box | 30–232 × 125–155 | 650–860 × 125–155 | 64×12 fingerprint of dark pixels (threshold halfway between the plate's median and its darkest 5%); OCR once per distinct fingerprint |
| CP box | 240–350 × 125–155 | 535–640 × 125–155 | fingerprint and OCR like the name; a CP read twice is reused while its digits look the same |
| Poké Balls | three 30×30 boxes at y 165–195 | same | mean colour of the inner half: red = alive, dark = fainted, else unknown |
| Shields | two 28×30 boxes at y 165–195 | same | blue and bright = shield still available |
| Type icons | discs at (37, 91), (81, 91), radius 18 | (801, 91), (850, 91) | median colour of the lower half of the disc, matched to 18 fitted type colours, rejected beyond a distance of 40 |

**Calibration.** Uploads crop the phone's status bar, which shifts everything up. `calibrate` tries vertical offsets from −120 to +160 (and −150 to −122 as a fallback) in steps of 2, keeps the offsets where the Poké Balls read (at least two red balls and five readable ones), and then centres the name boxes on the rows that hold the names' dark text. The offset is re-checked on frames where the HUD does not read (every 4th such frame until an offset has named a species, then every 20th), and proven offsets are tried first, because some videos change offset between battles. A wrong first calibration on a team card once cost a whole video its battles. Below −125 the name boxes run off the frame's top: at −136 the names are cut in half (te5W8Jrc-Mk), at −144 only the Poké Ball row is left (K7vaQKc1Gxs). The species then come from the banners (*Species from banners when the names are cropped off*).

**Why fingerprints and a cache.** Names and CP change only when a Pokémon changes, yet appear on every frame. Reading a 64×12 fingerprint is a few hundred pixel reads; an OCR call is milliseconds in Node and far more in the browser. The `NameCache` reuses the OCR result for any plate within 6% of a fingerprint already read and retries unreadable plates up to three times, which brings text reads down to 16–33 per video.

**Different names, similar fingerprints (2026-10-17).** On small or blurry uploads a name has only 80–100 inked cells, and two short names can differ by fewer cells than the same name on two frames: on the 572-wide Japanese upload Mxwep4-3rVI the same plate differed in up to 18 cells and マッギョ (Stunfisk) from ワタッコ (Jumpluff) in 29, inside both limits, so Jumpluff, Magnezone, Cramorant and Jellicent plates reused Stunfisk's read (the owner's "Jellicent read as Stunfisk"). The name cache (`NameCache.names()`) now also counts *far* cells (`farCells`): differing cells with no ink of the other print within one row and column. Blur moves stroke edges by a cell, a different character puts ink where there was none: on that video the same name had 0–2 far cells and different names 8–22, so at most 4 are allowed (`NAME_FAR`), and the closest entry is reused instead of the first. The CP and effect-text caches are unchanged.

**Covered plates (2026-10-17).** Stream overlays, chat pop-ups and stickers can sit over a nameplate: in 6zhjUeOaERo a sticker covers the end of every opponent name, and "Melmet…" read as "Meime", one letter from "Mime" (see below). The plate rows just above and below the name (reference rows 120, 123, 158, 161) hold no text, so `plateCover` counts the name box's columns (of 64) where at least two of those margin pixels are 60 levels darker than the plate's median margin or strongly coloured, over the name's ink or within 4 columns of its ends; uniform grey or near-black columns (the phone's bezel, when a crop is a few pixels wider than the screen) and the 20 px at each end of the plate (its rounded corners show the background; maw_a7oKYMM's 鳳王 starts there) never count. A plate with 3 or more covered columns (`COVER.max`) gives no species on that frame. Counting only near the text matters: on Mxwep4-3rVI the crop runs past the screen's right edge, so sky and bezel sit inside the opponent's name box on every frame, away from the right-aligned name (flagged on 2 of 94 sampled frames, against 47 when every column counted). Measured on sampled HUD frames: no clean plate flagged on 1p_u7XyvWwU (181), 10min (65, phone) or -mROfxnNVBk (164, 288×640); the sticker covers 4 columns next to every opponent name in 6zhjUeOaERo; on maw_a7oKYMM 2 of 110 sampled plates are flagged, both under transitions.

**Why the type icons use only the lower half.** The phone's status bar can cover the top of the discs. Icons also lag a switch by up to a second, so votes are taken only once a name has held for two samples; on 368 benchmark samples colour alone was right 357 times, and all 11 misses were frames from the previous Pokémon or without icons. The figure shows a harder case: the recorder's own icons are hidden under the status bar and are not read, while the opponent's steel icon is.

### Battle boundaries from the HUD

![“Go, Cramorant!” switch banner; the first Poké Ball on the recorder's side is now dark (fainted)](docs/frame-go.jpg)

Within a battle, fainted balls and used shields can only increase. So a HUD with all balls red and both shields back on both sides is a new battle, and a gap in the nameplates (cutscenes hide them) continues the battle unless a result screen, a fade to black or a fresh HUD shows it ended. `HudTracker` is a small state machine over this sequence. Rules added from harvest failures, each verified by replaying recorded tracker inputs from 17 videos:

- A fresh HUD within 20 s of a battle's start, with the nameplates on screen throughout and nobody fainted, continues the battle (a misread shield while the HUD settles used to split off the first seconds).
- Two shields vanishing at once on one frame right before a fresh HUD is a misread: the icons hide as a charged attack starts. A real shield takes one.
- After a fade to black, a HUD returning at least 3 s later with fewer fainted Pokémon than the battle has seen starts the next battle (one video had the recorder's first ball misread as fainted on every frame, so no HUD was ever "fresh" and four battles merged).
- A battle seen on a single HUD frame that opened mid-battle is dropped when a later HUD closes it.
- A battle that opened on a HUD that wasn't fresh (the first frame after a fade with a shield icon still appearing or a ball read '?', or a misread while the HUD settles) and turns fresh within 20 s under the first two rules was seen from its start: it loses the "Recording starts mid-battle" flag. It used to keep the flag, so its full team was left out of the usage export ("lead unknown") and the lead questions, and the Poké Ball counter could not settle its result (asked as "mid-start").
- A battle whose nameplates named no species used to be dropped. It is kept when banners named a species and its HUD showed for at least 10 s (names cropped off the top: *Species from banners when the names are cropped off* below). A battle's intro announces both leads before its HUD appears, so banner sightings after the previous battle's fade or result screen belong to the new battle; without a fade or result, so do send-outs after the previous battle's last HUD and at most 6 s before the fresh one (cc1z7nZJbgk: 3 s). A battle's own last send-out can come after its last HUD too (iC4-0ss8p40: the opponent's Ho-Oh 7.5 s before the next HUD, then a fade).

**Still images of a battle (2026-10-17).** A screenshot of a battle on a title card or in a talking-head video shows a full HUD, so it used to become a short "battle" with questions about it (INMpMrmY7GI: Lucario vs Zekrom for 5 s, the video's opening still). Once the matchups' HP series exist, `core.js` `stillBattle` drops a battle with no hits and no "used"/"Go" banners whose most common HP reading makes up ≥ 90% of each side's readings (≥ 20 readings): real footage jitters with compression and animation. Over the 4,678 saved battles of 2026-10-17 the most common reading was ≤ 67% of a side in every hitless real battle and 96–100% on the two stills (INMpMrmY7GI, -S98unxGFow at 424 s; frame-to-frame difference 0.000 against 5–9 on live play). Node and the browser both apply it; dropped spans are in `metrics.stillBattles`.

### HP bars, damage trails and the dense pass

![Dense pass: HP bars found with fill, trail and outline score; the effect-text strip above each bar; the Shadow aura regions below](docs/frame-bars.jpg)

Each active Pokémon has an HP bar 253 px wide (246 px of fill) above it: teal above half HP, yellow, then red, with an orange trail that shows the HP just lost and drains over about half a second. The trail's jump is a clean measurement of one hit. Bars are searched in rows 300–1450 of the reference frame (`BAND`), because large Pokémon and short 16:9 screens put them as high as y ≈ 370.

`findBars` works in three steps:

1. **Classify pixels** by hue, not RGB distance: teal 148–186°, yellow 47–72°, red ≥ 344° or ≤ 12°, trail 20–46°, with value ≥ 0.7 and saturation ≥ 0.38. YouTube re-encoding shifts the teal fill from (30, 254, 194) to about (0, 228, 172), which the earlier RGB-distance test rejected.
2. **Find solid runs and link rows into blobs** 9–18 rows tall whose left edge wobbles by at most 2 px between rows and 4 px overall (blurred edges), tolerating 1–3 px gaps of compression ringing between fill and trail. Fill and trail ends are a trimmed mean over the blob's rows, which gives sub-pixel precision on small hits.
3. **Require the bar's outline.** Grass, attack effects and the Pokémon themselves make fill-coloured rectangles; on 223 YouTube and phone frames 55% of the "opponent bars" the old detector assigned had no outline. A real bar has a bright line (white for the opponent, light blue for the recorder) 2–10 px above or below the fill along at least half its width, brighter than the rows 3 px above and below it. The score is bimodal (94% of other blobs score < 0.1, real bars ≥ 0.9), so the best-outlined bar wins each side.

`assignBars` and `track` then decide which bar is whose: the recorder's bar starts near the left edge (x 30–80 on phones, 30–230 on screens of aspect ≥ 0.55: 16:9 phones and tablets), the opponent's mid-screen (230–600); the bar whose left edge recurs through a window is kept. In a charged-attack cutscene the attacker's bar is drawn centred (x ≈ 320) whoever attacks, so `track` (each side's HP series: fast-move hits, charged damage, the HP timeline and the results read from it) skips centred bars on every screen. `assignBars` (where the aura box and the effect-text strip go) skips them on wide screens only; on phones a centred bar still places the opponent's aura box, because the Shadow classifier is measurably better with it (*Centred bars on phones* below).

**Why the cutoff is 0.55 (2026-10-13).** It was 0.6 until videos just below it still lost your bar (hits on your bar in 6 of 15 matchups on L-FikW4OvnU at 0.56, 8/38 on lC6aiKQuZ5c, 10/35 on KuaffxQ-zTA at 0.58, against 12, 27 and 23 for the opponent). The usual left edge of each of your Pokémon's bars on 19 videos: phones up to 0.544, 52–78 (most ≈ 55); 16:9 screens (0.561–0.563), 56–150 (Zacian 56, Dialga 106, Zekrom 122, Lunala 150); 0.58, 74–99; 0.61–0.64, 56–140; 0.67, 126–142; 0.75, 154–160. Above 16:9 a bar moves right as the screen widens (about an offset from the centre ∝ 1/aspect), but it jumps at 16:9 (Zekrom 76 at 0.531, 122 at 0.561, where 1/aspect predicts 89) and differs between devices of the same shape, so a window that scales with the aspect either misses Lunala and Palkia at 0.562 or widens every phone window. A cutoff at 0.55 does neither. A lone centred bar matched your bar's last reading about as often as the opponent's (97 and 113 frames at 0.56–0.61), and under the phone rule it had become the opponent's series whenever it showed more often than their own bar ("hits" of 13–29% in 8 matchups). On 7 whole videos at 0.56–0.58, matchups with hits on your bar went from 104 to 175 of 243 (43% → 72%) and on the opponent's from 170 to 172; battle boundaries, species and results were unchanged, and phones below 0.55 and screens ≥ 0.6 take the same code path as before (11 checked, identical). Phones then still counted a centred bar as the opponent's everywhere; the next paragraph measures what changed when the HP series stopped doing so.

**Centred bars on phones (2026-10-13).** Every labelled phone video with a local file (92 of 95: 908 battles, 4,830 matchups) was re-extracted once and read three ways from the same frames: the old phone rule (A), centred bars skipped in both `assignBars` and `track` (B), and skipped in `track` only (C). C takes the aura and effect-text reads from A and the HP series from B, which `run-node.cjs` computes independently; on three 4-minute stretches it matched a real run of the new code exactly. Under A the opponent's series followed the cutscene bar in 696 matchups on 78 videos, 249 of them with "hits" (307, of 1.5–35%). Under B and C those matchups follow the opponent's own bar (311 hits), and no series can follow a centred bar. Held out by video (`movefit-eval.cjs` with the current evidence settings, `shadow-cv.cjs` leave-one-video-out; 196 fast moves, 31 forms and 391 Shadow answers on 127 videos):

| | A (before) | B (skipped in both) | C (skipped in `track`: adopted) |
| --- | --- | --- | --- |
| Fast moves | 169/196, log-loss 0.317; p ≥ .90: 104/105 | 171/196, 0.311; 106/107 | **171/196, 0.311; 106/107** |
| Fast moves, evidence settings refitted (nested 4-fold) | 167/196, 0.354 | | **170/196, 0.341** |
| Forms | 25/31, 0.302 | 25/31, 0.299 | 25/31, 0.299 |
| Shadow classifier, refitted per fold | 317/391, 0.415, AUC 0.890 | 313/391, 0.421, AUC 0.885 | 317/391, 0.415, AUC 0.890 |
| Shadow, current fitted model unchanged | 323/391, 0.385, AUC 0.908 | 318/391, 0.391, AUC 0.904 | 323/391, 0.384, AUC 0.908 |

Paired by answer, C against A: two fast moves go from wrong to right and none the other way (log-loss −0.006, 95% video bootstrap −0.019 to 0.000), and Shadow is unchanged (log-loss within ±0.001). B loses Shadow accuracy beyond noise on phones (log-loss +0.009, interval +0.001 to +0.021; AUC −0.005). The aura box under a centred bar sees whichever Pokémon the camera frames, and those close-ups carry Shadow evidence the classifier uses, so `assignBars` keeps the phone rule. Refitting the evidence settings (`movefit-fit.cjs`, as the learning loop does) gives identical parameters on A, B and C evidence, so the change needs no refit. Battle boundaries and species are unchanged on all 92 videos, and the seven phone recordings of the labelled benchmark score identically.

Results differ in 19 of 908 battles. Thirteen "faints" wins under A came from the defender's bar emptying in the final cutscene, read as the opponent's series. They now go to review: 12 with the guess that you won (the one that has an answer was a win), and one closed as unresolvable. One battle gained a "faints" result, and 5 "unresolvable" endings became questions with a guess. The `knockout` rule (section 4) now reads that final knockout from the centred bar: 12 of the 13 are asked with the guess that you won, and it settles them on its own once owner answers pass the promotion gate.

HP never rises within a matchup, so the fill is read as a descending staircase: upward readings (an attack glow sweeping over the bar) are ignored, a step counts once two readings confirm it, and a step must also clear three times the series' median frame-to-frame jitter (heavy compression makes the fill end flicker by 1–3%). Damage that appears after the bars were hidden for more than 1.2 s is a charged attack and is excluded from fast-move hits. All of this is documented with before/after numbers under *HP bars on YouTube footage* in section 7.

### The Shadow aura and focus shots

![Shadow aura regions under each bar; the opponent's Feraligatr is a confirmed Shadow and shows the dark purple flames](docs/frame-shadow-aura.jpg)

Shadow Pokémon carry dark violet flames. Each side's Pokémon stands just below its HP bar, so `aura.js` measures the share of aura-purple pixels (hue 262–305°, saturation ≥ 0.38, value 0.22–0.85) in a box placed relative to the bar: the opponent's in a box 30 px wider than its bar and 230 px tall below it, the recorder's in the larger foreground area (0–520 × bar + 10 to bar + 450). Each matchup is summarised by the *median* over its frames, so a one-off Shadow Ball or Psychic effect does not dominate. A red-eye cue was tried and dropped (AUC ≈ 0.5: the eyes are a few pixels and red attack effects swamp them).

![Focus shot during a charged attack: one Pokémon fills the view with its HP bar centred above it, and the aura box below the bar sees only that Pokémon](docs/frame-focus.jpg)

The aura box has a known flaw: the recorder's Shadow flames spill into the opponent's box, and the opponent's box even shows the recorder's Pokémon while the camera frames it. During a charged attack the camera frames one Pokémon at a time: the attacker as it launches (from the "X used Y!" banner, about a second) and then the defender as it is hit. That Pokémon fills the view with its bar centred above it, and the other side is out of frame. `measureFocus` measures the box under a centred bar when the recorder's usual bar is absent; `focusMoments` groups these frames into shots, names attacker and defender from the banner, and assigns shots without a banner by matching the centred bar's fill to one side's fill just before. Shielded defenders (the pink bubble reads as purple) and ghost, dark, poison and psychic moves (purple effects) are skipped. On labelled Pokémon with shots, median focus purple is 0.0% for regular and 14% for Shadow Pokémon (AUC 0.91), and 0.94 for opponents facing the recorder's own Shadow, where the plain aura box scores 0.75.

### Effectiveness text

![SUPER EFFECTIVE! strip above the HP bar of the Pokémon that was hit](docs/frame-effect.jpg)

When a fast attack lands, the game flashes **SUPER EFFECTIVE!** or **NOT VERY EFFECTIVE…** in white just above the target's bar. Every dense frame fingerprints the strip from 6 px left of the bar to 320 px right of it and 3–50 px above it (96×12 cells of near-white pixels). The strip is read by OCR only when it looks like text: 3–45% of the strip lit, with ink in every one of rows 1–4 (the words sit in the top five rows; arena glare and the bar's own edge light the lower rows). Each distinct look is read once and cached; after a successful read the side is not read again for 0.9 s. On a 150 s clip this cut OCR reads from 257 to 50 with the same detections. The texts feed the fast-move likelihood (section 4): they separate moves with equal damage but different types.

### Charged-attack and switch banners

![Charged-attack banner box: “Melmetal used Double Iron Bash!”, read while the nameplates are hidden](docs/frame-banner.jpg)

The banner sits at 30.2% of the full screen height and is 3.8% tall, between x 71 and 815; when the top is cropped, the box is recovered from the calibration offset. It is read with or without nameplates on screen, when its share of white letters looks like text (English) or, for Japanese, Korean and Chinese UIs whose thin strokes are pale blue on a light sky, when the box shows sharp brightness steps (2.5–3.4% of pixels on banners, ≤ 1.8% otherwise). A tolerant parser picks "X used Y!" or "Go, X!" out of OCR junk from bright arenas, tolerating one wrong letter, resolves the actor through the species dictionaries and the move through `move-names.json` (PvPoke moves by English name, with PokeAPI's localised names, 348 of 352 moves). A move is credited to a side only when the actor uniquely matches one side's revealed team; mirror matches stay unassigned. "Go, X!" banners mark switches and entries, which give each Pokémon's fighting time for the energy accounting.

**Send-out banners name the side (2026-10-17).** In Japanese, Korean and Chinese UIs your Pokémon enters with "ゆけっ！X！" / "가랏! X!" / "上吧！X！" and the opponent's with "相手が Xを くりだした！" / "상대가 X(을)를 내보냈다!" / "對手派出了X！", and `parseLocalBanner` returns that side. In the saved Japanese results, 1,297 of the 1,303 "ゆけっ" species that are on one side's team are on yours and 2,311 of 2,390 "相手が" species on the opponent's; Latin "Go, X!" banners announce either side (English: 1,395 on yours, 1,179 on the opponent's), so they carry none. Long CJK banners wrap onto two lines ("相手が / メガミュウツーYをくりだした！") and run to x ≈ 845, past the box (see the next section).

### Species from banners when the names are cropped off

Some uploads crop the phone's top so far that the nameplate names leave the frame (K7vaQKc1Gxs, te5W8Jrc-Mk, y_ubrafzmFI: Japanese Master League videos of one channel; *Calibration* above). The HUD tracker followed their battles on the Poké Balls and shields (1,350–1,750 HUD frames each) but kept only battles with a nameplate species, so they gave 0 battles, or a few with one species. The banners still name every Pokémon that attacks or is sent out, in every language, and a CJK send-out also names the side. Everything here is a fallback: a battle in which a nameplate named a species is unchanged.

- **Language.** No plate decides it, so banners can (section 6, *Language from banners*).
- **Keeping the battle.** The tracker keeps a battle whose nameplates named nothing when banners named a species and its HUD showed for at least 10 s; a battle's intro banners belong to it, not to the previous battle (*Battle boundaries from the HUD*).
- **Two-line banners.** While a battle's nameplates have named nothing, a CJK banner the one-line read can't parse is read again in a box 20–866 wide and twice as tall (`wideBannerBox`), and kept only as a sighting (`HudTracker.sight`, no event), so a battle that a plate names later is exactly as before.
- **Sides** (`bannerTeam`, when the tracker finishes). A send-out gives its side. "X used Y!" has two cues, which must agree when both speak: the side X was sent out on (when that is one side), and the opposite of the defender. The defender is the side whose shield goes 0.5 s before to 3 s after the banner, whose Pokémon faints within 2.25 s of it, or whose HP bar drops across it (`barDefender`: one side by at least 4%, the other, read too, by at most a third of that, since a fast move can land on the attacker). On a synthetic crop of iC4-0ss8p40 (below) the defender's shield went 0–1.5 s after the banner and its Pokémon fainted 2–2.5 s after it, while the attacker's shields went at least 12.5 s later and its Pokémon could faint from 2.5 s on. The side of the species alone was right 14 times and wrong 5 (mirror matches whose other copy was never announced), the defender cue right 25 times and never wrong. An attack without an agreeing cue stays side-unknown and adds no species. Latin "Go, X!" takes its species' side when that is one side.
- **One Pokémon per Pokédex number.** GBL's species clause: on one side, sightings with the same Pokédex number are one Pokémon (a banner or OCR that drops a Mega prefix, a Mega Mewtwo X/Y misread), named by a Mega or Primal key if one was read (a lost prefix is a misread), else by the key read most often. A species read only once with one wrong character needs a second read or an exact one ("ゆけっ！フッキー" for カイオーガ matched ラッキー, Chansey).
- **Output.** At most 3 species per side in order of appearance (a fourth raises the boundary flag, which keeps the team out of the usage export), confidence 40, `speciesFrom: 'banners'`, the flag "Species from banners: …", and the battle's go/move events rebuilt with their sides. The review shows "read from a banner", and every question about such a Pokémon says that its species and side came from banners.

K7vaQKc1Gxs and te5W8Jrc-Mk couldn't be downloaded again (YouTube's bot check refused every download on 2026-10-17 and 18, the harvester's too), so the layout was reproduced by cropping more of the top off two videos whose names read, which also gives a reference: the nameplate run of the same video. Frames were checked where they disagree. main is the code before this change.

| Video | Layout | main | With banners |
| --- | --- | --- | --- |
| iC4-0ss8p40, 15 px more cropped | dy −142: only the Poké Ball row (as K7vaQKc1Gxs) | 0 battles | 6 battles (nameplate run: 6). Opponents: 17 species, 16 of the nameplate run's 17 plus Ho-Oh, which the frames show sent out as battle 1 ended and never on a nameplate; one Mega Mewtwo Y named X; leads as the nameplate run in 4 of 6. 5 full teams (5), 2 results (2). Your side: 10 of 17, none wrong. Of 33 attacks whose attacker's side is known, 27 right, 2 wrong, 4 unassigned (14 more in mirror matchups) |
| iC4-0ss8p40, 10 px | dy −134: names cut in half (as te5W8Jrc-Mk) | 0 | 6 battles; opponents 17: 16 of 17 plus Ho-Oh; 5 full teams; yours 9 of 17; 31 attacks right, 2 wrong, 3 unassigned. Language from banners at 33.5 s, after 12 banners |
| cc1z7nZJbgk, 9 px | dy −142 | 0 | 6 battles, 17 opponent species, 5 full teams (the uncropped video's own half-cut plates name 6). Nine send-outs and nameplates checked on frames agree, among them a lead Zacian and a Mega Mewtwo X; a "ゆけっ！フッキー" misread as Chansey is dropped |
| y_ubrafzmFI (720p, real) | dy −131: names cut in half | 3 battles, 2 opponent species | 4 battles, 4 species: the battle at 199–388 s, whose plates read nothing, gets the opponent's Necrozma and Palkia and your Lugia (all three on frames); the other three battles are named by a plate and unchanged |
| L2Iyrc06j00 (real) | dy −129: names cut at the top | 6 battles, 8 opponent species | 7 battles, 9: the battle at 171–240 s (a Ho-Oh mirror, then your Dialga, both on frames) gets the opponent's Ho-Oh and your Dialga. The battle before it now closes its result as unresolvable (the next HUD follows 9 s after it, without a fade: the hard-cut rule of section 4); everything else is unchanged |
| cc1z7nZJbgk (real) | dy −130 | 6 battles, 6 opponent species | identical: every battle is named by one half-cut plate |

Per battle the cropped iC4-0ss8p40 shows 7–20 distinct banners: 0–3 of your send-outs, 2–6 of the opponent's and 4–11 attacks (407 banner candidates read with the Japanese model over 977 s; 33 distinct send-outs and 47 attacks, 38 of them given a side). The language came from banners at 77 s (iC4-0ss8p40, 15 px) and 54.5 s (cc1z7nZJbgk), so these two were analysed again with it preset.

What it doesn't do: battles from banners have no matchups (no nameplate says who faces whom), so they get no fast moves, HP timeline or Shadow evidence from bars, and the lead is the first opponent send-out, which a recording that starts mid-battle lacks. Mirror matches keep some attacks side-unknown. The browser has no HP-bar cue (it reads bars only per matchup, after the scan), so there only shields and faints decide an attack's side. A battle in which the CJK model reads one half-cut name takes nothing from its banners (y_ubrafzmFI, cc1z7nZJbgk: about one nameplate species per battle); using banners to complete such teams is listed under gaps.

### Result screens, the surrender dialog and fades

![Result screen: large white letters in the middle band pass the pre-test, then OCR reads YOU WIN](docs/frame-result.jpg)

![A mostly white card passes the surrender dialog pre-test; OCR must then find the word Surrender, which it does not here](docs/frame-whitecard.jpg)

Rows 700–1180 of a 1920-tall reference frame are the band where the game shows results, the surrender dialog and the fade to black. `bandStats` measures the share of white and black pixels and the tallest run of rows with white in them, which decides without OCR what the band could be:

- a **result candidate** has at least 1% white and a tallest white run of 70–115 px (the height of YOU WIN / GOOD EFFORT letters): then OCR reads it, with one wrong letter tolerated for 6+ letter phrases and exact matching for short ones ("WIN!" on Japanese and Korean screens, which are in English letters). Chinese screens are re-read with the `chi_tra` model;
- a **surrender candidate** is at least 50% white: OCR must then find "Surrender and exit?" (or its translation) and the HUD must vanish within 3 s;
- a **fade** is more than 90% black.

Result screens are read only when the battle can have ended: a side down to its last Pokémon, a fade, or 8 s without nameplates. The reason is visible in the focus-shot figure above: the big white move name in a cutscene also passes the result pre-test (81 px run), and reading results everywhere produced false endings. Matchmaking text ends the search. A win read while the opponent still had Pokémon is flagged as a probable early exit.

## 4. How each answer about a battle is produced

| Metric | How it is determined | Evidence used | Main gaps |
| --- | --- | --- | --- |
| Battle boundaries | Nameplates every ~1 s (browser) or every 5th frame at 10 fps (Node); fainted balls and used shields only increase within a battle; fresh HUD = new battle; gaps continue the battle unless a result, fade or fresh HUD ends it | Poké Balls, shields, result screens, fades | a recording that starts mid-battle; two battles back to back with no visible reset (never seen) |
| Opponent species | OCR of the name box once per distinct fingerprint, matched to PvPoke's species list in the video's language (exact, or one wrong letter for names of 5+ letters; CJK names of 4 characters only without a second species two away; Korean by jamo with a margin), kept after two sightings; sightings on covered plates, suggestions with a CP above the species' maximum and ambiguous reads that the CP or both type icons don't settle are dropped; a suggestion whose type icons contradict it is flagged where the video's icons are reliable; the local vision model as second reader where OCR is unsure (`HUD_LLM=1`); when the names are cropped off, from the banners (send-outs and "X used Y!" with their sides; flagged) | nameplate text, CP, type icons, banners | Pokémon on screen under ~2 s; nicknames (impossible for opponents); plates covered by overlays give no species; banner sides in mirror matches |
| Lead | the first opponent species seen in the battle | first stable nameplate; the intro's send-out banner when the names are cropped off | an opponent swapping within the first second; "Go, X!" banners could settle it |
| Team | every species revealed; complete only when all three appeared | nameplates | the third Pokémon is often never sent out |
| CP | the CP box, read and cached like names; majority vote per Pokémon | CP text | none significant |
| Result | a result screen, read only when the battle can have ended; otherwise the timeline rules below; otherwise a question | result screen, ball count, HP bars, surrender dialog, fade | uploads that cut result screens and have an undecided timeline |
| Forfeits | yours: the surrender dialog, then a loss; the opponent's: a win before all their Pokémon fainted | dialog, ball count | leaving the app without the dialog; a disconnect looks like a forfeit |
| Shields used | shield icons on each nameplate; counts only increase | HUD | none significant |
| Form | type icons through a confusion model, PvPoke ranking prior, charged-move legality, reviewer answers | icons, rankings, answers, banners | forms with identical types and no deciding move (Dialga vs Dialga Origin) |
| Shadow | a logistic classifier over aura, focus shots, damage ratios, species rates and ranking differences | HP bars, aura, answers | Shadows whose flames are never in a box; purple-bodied species; low-resolution uploads |
| Fast move | likelihood over damage, cadence, energy, effect text and priors, over every level/IV pair consistent with both CPs | HP bars, CP, banners, effect text, rankings, answers | pairs that hit equally hard on the same turns; edited videos that cut the bars |
| Charged moves | "X used Y!" banners, checked against the form's legal moves | banner text | a banner missed during a fast cutscene |

### Species: OCR, or a classifier?

Only a few hundred names can appear, in one font at fixed positions, so reading a name is a closed-set classification problem, and a small CNN would be faster and more robust on blurry video. The decision was to keep OCR, for evidence and for cost:

- after the geometry and caching fixes, OCR reads every labelled opponent species correctly (194 of 194 plus 39 of 39), and every past naming error came from a box clipping "Mega Garchomp" or a fingerprint threshold on blurry video, not from reading;
- OCR is cheap once cached (16–33 reads per video) and run time is dominated by decoding, not text;
- other UI languages are language packs for Tesseract, while a classifier would need new renders per language. Japanese, Korean and Chinese nameplates are read with that language's fast model, and `NameLanguage` switches a video's language after two exact matches, so English videos keep their results.

A local vision model (`scripts/freellm`, `qwen2.5vl:7b`) passed its quality gate as a *second reader* for nameplates (108 of 108 names on 92 Creative Commons HUD strips, none invented) and is used only where the OCR is unsure.

**Checks on a read (2026-10-17).** Four owner-reported misreads showed that a name that matches the dictionary can still be wrong. Each is now checked against the rest of the plate (`core.js` `plateHit`, `HudTracker.finish`):

- **CP.** Every candidate carries the highest CP its Pokédex number can show (`maxCp`: level 51, perfect IVs, over every form, since a plate cannot tell Zacian from Zacian Crowned Sword). A suggestion whose CP, read on the same frame as a 2–4 digit number, is more than 6% above every candidate's maximum is not used on that frame (also without a leading 1, often a bracket read as a digit: "1498" may be 498). The 6% covers PvPoke's Mega stats, a little below the game's (Mega Mewtwo Y computes to 7,354; plates read 7,529). 5-digit reads ("11495") are junk. Exact reads keep their species whatever the CP: Team Rocket's Pokémon show CPs no player's can reach.
- **Ambiguous reads.** A Korean read more than one jamo off with another species within one more jamo, or a CJK read of 4 characters one off with another species two away (section 6), carries its rivals (`alternatives`). It names a species only when the same frame's CP rules out all but one of them, or else when both of the frame's type icons were read and fit exactly one (single icons are confused, bug for grass). Korean 채크로우 at CP 4545 was matched to Corvisquire (2 jamo; at most 1,6xx CP) instead of Zekrom (3 jamo); it now reads Zekrom, and 채크로무 (2 jamo from Zekrom, 3 from Corvisquire) still does.
- **Type icons.** Type icons demote, they never drop: a suggestion (one letter or jamo off) is flagged "Check species" (`typeConflict`) at the end of the video when at least 4 of its icon votes were cast, under 20% fit any candidate's types and one contradicting reading has at least 3 votes (small uploads misread single icons: Stunfisk as normal, Kyogre as steel), but only where icons are reliable in that video: at least 85% of the icon votes of exact reads (3 or more of them) fit their species. 7u31Xt6Fg4M reads fire icons as ground and electric as rock, so icons decide nothing there. Exact reads are never flagged. Dropping was tried and rejected: on stLd7OkIg3Y the recorder's Charjabug (デンヂムシ read デンヂデムシ) had its bug icon read as grass on 45 of 45 votes and was dropped from all four battles.
- **Covered plates** (section 3) give no species on that frame.
- **Second reader** (`tests/meta-benchmark/hud-llm.cjs`, `HUD_LLM=1`): where the OCR read is a suggestion, or has three or more letters and names nothing, the plate's time is sent to `eval_hud.py read`, which crops the HUD strip of the phone screen and needs two agreeing calls of the local model and the passed `llm_hud_names` gate. Only YouTube footage is sent (a video in a `youtube` or `youtube-cc` folder; never the owner's recordings, which `eval_hud.py` refuses too). The model's answer counts only as an exact dictionary name (English, or the video's decided language): it confirms or replaces the OCR's suggestion or names an unread plate; a disagreement or unknown name changes nothing. At most 30 calls per video (`HUD_LLM_BUDGET`), one per distinct OCR text. It is off by default, because Ollama must be running and each call takes seconds.

The dictionary also lost a false name: PvPoke writes Mime Jr. as "Mime (Jr)", and dropping the bracket like a form name made "Mime" a species name, one letter from "Meime". It is now "Mime Jr." only (`visibleName`), which changes the species key from `mime` to `mimejr`.

### Results without a result screen

Owner's rule: ask the result question only when the answer is not confident. `inferResult` puts every battle without a read result screen into one of three outcomes. The precisions come from 1,422 read results and the owner's 51 answers (`result-policy.cjs`):

| Outcome | Condition | Guess | Precision | Question? |
| --- | --- | --- | --- | --- |
| confident `faints` | counter at 3 for one side, battle seen from its start | that side lost | 41/41 | no |
| confident `faints` | counter 2 vs ≤ 1, that side's last bar empty ≤ 3 s before the end, other ≥ 10% | that side lost | 67/67 | no |
| confident `surrender` | "Surrender and exit?" dialog, HUD gone within 3 s | you forfeited | 118/118 | no |
| uncertain `fade` | fade to black after the last HUD, both sides alive | opponent forfeit | .71 (10/14) | yes, guess shown |
| uncertain `tie` | counter 2 vs 2, one last bar empty | the empty side lost | .84 (41/49) | yes |
| uncertain `mid-start` | counter 3 but the recording began mid-battle, bars disagree | counter's loser | .47 (7/15) | yes |
| uncertain `unread` | a result-like screen OCR could not read | by the counter, else opponent forfeit | .5 | yes |
| uncertain `both-alive` | older saved result (no fade recorded), both bars alive at the end | opponent forfeit | .46 (11/24) | yes |
| uncertain `knockout` | counter 2 vs ≤ 1, the centred bar of the final charged-attack cutscene empty ≤ 3 s from the end, other side's own bar ≥ 10% | that side lost | .96 (74/77 read screens; owner 7/9) | yes, until promoted |
| unresolvable | none of the above, no fade, next battle's HUD within 10 s or the recording ends | – | – | no (closed by policy, reversible) |

Timer endings cannot be told from a fade because the clock is not read. The rules learn: `ruleStats` re-runs every rule on every human result answer at each refit (the rules are fixed, so every answer is held out), and an uncertain rule is promoted to confident at ≥ 95% right on ≥ 30 answers from ≥ 5 videos, and demoted again below that. Observed meta and the usage export treat confident inferred results like read ones.

**Knockout in the final cutscene (`knockout`, 2026-10-13).** The last knockout of a battle often happens inside a charged-attack cutscene. There the defender's bar is drawn centred while it is hit, and `track` leaves centred bars out of both sides' HP (section 3), so the confident two-fainted rule above cannot see it. `run-node.cjs` therefore saves, per battle, every centred bar from 8 s before the battle's end to 4 s after (`cutsceneBar`: time, fill and height; about 12 readings), and refits apply the rule to saved results without video. The rule: the counter shows 2 fainted on one side and at most 1 on the other, the centred bar's median over its last second of readings is empty, that last reading is within 3 s of the end, and the other side's own bar is at ≥ 10%; then that side lost. Run as if no result screen had been read, it agrees with 74 of 77 read screens on 122 re-extracted labelled videos (phones 52/54, wide screens 22/23; wins 45/46, losses 29/31) and with 7 of 9 owner answers on 6 videos (both misses were forfeits). It is an uncertain rule like `fade` and `tie`: it asks with its guess until owner answers pass the promotion gate (≥ 95% on ≥ 30 answers from ≥ 5 videos), then settles on its own. On the 92 phone videos it guesses in 59 battles (43 wins, 16 losses), 12 of them the wins the old phone rule had settled from the cutscene bar (section 3); the one of those with an answer was a win. No battle gets a confident result from it before the gate passes, and the nine benchmark recordings score as before. The browser samples only the first 30 s of each matchup and records no cutscene readings, so the rule applies to Node runs.

### Regional forms from type icons

Forms with different types (Galarian Corsola is ghost; regular Stunfisk is ground/electric) are separated by the icons; forms with identical types cannot be. Three sources of evidence are combined per Pokémon:

1. **An icon confusion model.** On 1,589 Pokémon whose species fixes their types, the majority icon reading matched the true types only 60% of the time: a dual type reads as a single type in 47% of frames, and some videos shift colours (fire read as ground 10% of the time; 0 of 9 in the worst video). An exact-match filter therefore threw away most of the evidence. `ICON_CONFUSION`, P(read type | true type), fitted on those 1,589 Pokémon and adapted to each video's own unambiguous Pokémon (weight 200 votes), scores every form, allowing missed icons and colour shifts. Frames repeat the same misreading, so the icon evidence counts as two independent reads.
2. **A ranking prior.** Look-alike forms are weighted by PvPoke ranking score for the battle's league, `exp(Δscore / 2)` (temperature 4 → 2 after the v4 refit), and by reviewer form answers. The league comes from the nameplate CPs when they rule out the video's league: Master League Dialga was being called regular with p = 1.00 three times because Great League rankings were used.
3. **Moveset legality.** A charged move the form cannot learn rules the form out (Weezing and Galarian Weezing share no charged moves); Frustration means Shadow, Return means not Shadow.

Pokémon without a matchup get a prior-only answer rather than none. Ablations on the 31 labelled forms (video-grouped cross-validation): without icons 22/31 (log-loss 0.50), ranking temperature 4: 24/31 (0.30), without the CP league 21/31 (1.15); v4 with everything 25/31 (0.26).

### Fast moves from HP bars

Each fast-move hit is a step down the target's bar. Its size is compared with PvPoke's damage formula, `⌊power × STAB × attack/defense × effectiveness × 0.5 × 1.3⌋ + 1` (a Shadow attacks at ×1.2 and defends at ×0.833), over **every level/IV combination consistent with both nameplate CPs** (`statCombos`; up to 40 spread combinations per side). One combination per side must explain both directions at once: its attack sets the damage it deals, its defence and HP the damage it takes. Four more terms make the per-move likelihood (`inferMatchup`, parameters in `FIT`, fitted by coordinate search on video-grouped log-loss with `movefit-fit.cjs`):

- **Damage noise** proportional to the hit: σ = 1.3% of HP + 15% of the hit, with 15% stray readings and a ×0.92 scale (the measured/predicted ratio under the true move has median 0.96 and IQR 0.85–1.18, because the CP leaves a stat range and steps merge). A fixed σ of 0.65% had made a 14% Incinerate measured at 13% a "stray reading".
- **Gap likelihood** instead of a single cadence mode: each gap between hits is a whole number of moves (later moves missed with probability q = 0.2 each), a pause, or a stray detection, with τ = 0.2 s timing jitter. Only 46 of 197 labels had a gap mode equal to the true move's duration, so the old mode test often pointed the wrong way.
- **Energy accounting** (`energyFactor`): all energy spent on charged moves must have been earned by fast moves during the Pokémon's fighting time, measured as clock time on the field (entry to next switch, minus 5 s per charged-attack cutscene). Counting only frames with a visible bar had made 15% of true moves "impossible" on YouTube footage, where bars are found in a median of 24% of matchup frames. A move that cannot pay gets weight 0.05.
- **Effectiveness text** as a likelihood term: P(super text) = .25 for a super-effective move, .03 otherwise, and symmetrically for "not very"; P(no text) .72 / .94. The text is brief and often missed, so no reading is certain and a missing text says little; a stronger P = .80 was overconfident (log-loss −0.473 vs −0.334).
- **Priors**: PvPoke's recommended moveset and simulated usage, worth one human label (not four: species-level human answers are the better guide), reviewer answers per species, and charged moves matching PvPoke's recommended set, which double that set's fast move. Matchups with the same opponent Pokémon in a battle are pooled as `sum / n^0.7`; the recorder's own Pokémon are pooled across all battles in the recording.

Window: the whole matchup is used for charged hits and the aura, but fast-move hits come from the first 12 s of a matchup; later readings (low-HP colours, cutscene edges) add noise (whole matchup 79 vs first 8–18 s 86–87 of 99 right in the v3 measurement).

**Example.** Claydol (CP 1492) against Guzzlord (CP 1498) hit for 5.6–6.0% every 3 turns: Mud Slap predicts 5.2–6.2% per 3 turns; Confusion and Extrasensory do not fit.

### Fast moves and forms from 228 human labels

This is the v4 evidence model (2026-10-11), measured by video-grouped cross-validation on 197 confirmed fast moves and 31 confirmed forms over 37 videos (`movefit-eval.cjs`; each video refit with priors from the other videos only). The old model's failures and the changes that fixed them are the list above. Ablations, turning only one change off:

| Change (ablation) | Fast moves | log-loss |
| --- | --- | --- |
| v4, all changes | **162/197** | **0.426** |
| without gap likelihood (old cadence) | 156 | 0.474 |
| with the old damage noise | 158 | 0.465 |
| without energy (impossible totals not penalised) | 158 | 0.458 |
| PvPoke prior worth 4 labels | 162 | 0.450 |
| without icon evidence | 160 | 0.451 |

Before → after, same labels: fast moves 153/197 (log-loss 0.575, ECE 0.048) → 162/197 (0.426, 0.033); forms 15/31 (1.93) → 25/31 (0.263). A nested 4-fold refit (parameters fitted without the test videos) gave 160/197 (0.441), so the gain is not an artefact of tuning. The HP-bar detector rework (section 7) then raised fast moves to 165/197 (0.393), and a refit of the evidence settings on the new hits (2026-10-12: relSigma 0.08 → 0.15, timing weight 0.5 → 0.25, q 0.35 → 0.2, τ 0.12 → 0.2, learnWeight 1 → 0.5) to **166/197, log-loss 0.339** (nested: 165/197, 0.376); at p ≥ 0.90, 102 of 103 right. Forms are 25/31 (0.303) after that refit.

`inferMatchup` computes each move's per-hit likelihood once per stat combination and multiplies, instead of scoring every (move, move, combination) triple; results are identical and a refit of all 37 labelled videos takes 5 s instead of 21.

### Shadow status

Shadow is the hardest field. Damage carries the ×1.2 multipliers, but within one CP the attack stat varies by about ±8%, which blurs a 20% effect: per battle, the estimate for a known Shadow ranged from 4% to 100%. Three generations of evidence are combined today:

**Visual Shadow detector** (`aura.js`, 2026-10-10). The purple share under each bar entered as a likelihood ratio from two bands fitted on the answers (purple < 0.1%: 3 Shadow vs 26 regular; ≥ 0.1%: 10 vs 2). Leave-one-out on 33 answers, Shadow calls went from 27 to 30 right on top of damage and learned priors. Species whose body reads purple (Drapion) were excluded by a rule that turned out to be a bug: one "not Shadow" answer with purple ≥ 0.1% switched the aura off for that species for good, and on live data 19 species were flagged, usually because the recorder's own Shadow flames spilled into the box.

**Shadow classifier** (`shadow-model.js`, 2026-10-11). On the questions people had answered, the old estimate's Shadow pick was right only about half the time, for four measured reasons: the recorder's own Pokémon never used the aura (yet that side separates best, AUC 0.91); the aura was two bands, so 10–18% purple (an unmistakable flame) was outvoted by noisy damage; the purple-bodied rule above; and damage cannot tell which side is the Shadow (a Shadow on either side scales both directions by 1.2; damage alone has AUC 0.62, species priors 0.53). The replacement is an L2-regularised logistic regression (plain JS Newton steps, L2 = 8, missing values imputed at the training mean so they move nothing) over: the old posterior; target and other-side aura (log purple), the side and its interactions; the share of matchups with ≥ 0.5% purple; damage evidence conditioned on the other side's estimate; the species' high-purple rate in unlabelled footage (a per-species baseline instead of the exclusion rule); PvPoke's Shadow-minus-regular ranking score; and the focus-shot features. It runs after `MetaAura.applyToBattle` in Node, the browser and refits, and rescales each Pokémon's Shadow rows to the new probability as a likelihood ratio within each form, so form probabilities stay as the form model left them (an earlier version moved probability between forms and flipped Hisuian Typhlosion and Palkia Origin).

| Leave-one-video-out | Old posterior | Classifier (208 labels, 35 videos) | + focus shots (410 labels, 125 videos) |
| --- | --- | --- | --- |
| Right | 130 (62.5%) | 155 (74.5%) | **323 (78.8%)** |
| Log-loss / Brier | 0.653 / 0.230 | 0.513 / 0.169 | **0.461** |
| AUC | 0.685 | 0.814 | **0.870** |
| Your Pokémon / opponents | 23/43, 107/165 | 36/43, 119/165 | 63/73, 260/337 |
| Opponents facing your Shadow | | | 98/120 (AUC 0.886, was 0.774) |

Out-of-fold calibration: predicted 0.07 / 0.20 / 0.40 / 0.60 / 0.80 / 0.94 → observed 0 / 0.20 / 0.43 / 0.55 / 0.86 / 0.82. With aura and hits both measured it is 115/144; with neither 19/32, barely above the prior. Features were chosen by video-grouped CV over L2 4/8/16 and focus-feature sets; `focusMax`, `sideFocusT` and attacker/defender splits added nothing. Pokémon without focus shots (runs analysed before shots were recorded, or videos with no centred bars) are judged against thresholds from held-out predictions with the focus features removed.

**Forms without a Shadow variant.** PvPoke's game master lists `<id>_shadow` only for forms with a released Shadow, so "this form id has a `_shadow` entry" is the eligibility rule (`shadowEligibility`). An ineligible Pokémon gets no Shadow question, its probability is set to 0, and the learning loop resolves its open Shadow questions as "No" with the reason "form has no Shadow variant" (reversible, re-derived on every refit, with the dated game master the run was fitted with).

### Move data from the battle date

Fast moves are rebalanced over time (28 fast moves changed between March 2025 and October 2026: Charm 15 → 12 power, Mud Slap 12 → 11). Damage is fitted with PvPoke's game data as of the battle date: the browser fetches `gamemaster.min.json` at the last PvPoke commit on or before that date and falls back to current data, saying so; the harvester caches dated copies in `~/.cache/gbl-synapse/gamemaster/`. With current data, a March 2025 Claydol looked 53% Shadow (its Mud Slap hits seemed 9% too strong); with March 2025 data it is 0%, matching the reviewer.

### Using every appearance

- A **matchup** is any stretch where the same two Pokémon face each other for at least 3 s.
- Every matchup of the same opponent Pokémon in a battle is pooled (`combineMatchups`, tempered by n^0.7). An opponent that leads Skeledirge, switches out after a second and brings it back later gets its fast move, Shadow status and CP from the later appearance.
- Type icons are voted over every stable frame of the battle, not only the first.
- The recorder's own Pokémon are pooled across every battle in the recording: their team is the same Pokémon throughout.
- Opponents are never pooled across battles: a different battle usually means a different trainer.

### HP at every turn, and the timeline graph

Each battle gets an HP timeline (`hpTimeline`): every Pokémon's remaining HP at every half-second turn from the battle start. Readings are the dense samples of every matchup the Pokémon was in, smoothed with a median of 5 and fitted with the best non-increasing curve (pool-adjacent-violators), because HP never rises within a battle and a single misread low value must be averaged away rather than become a floor. Before entry the value is empty; on the field without readings, full; between readings, held; after a faint, 0. Stored summaries carry it as whole percents. `timeline.js` draws it as an SVG with two panels (your team above, the opponent below), one line per Pokémon ending at its faint, and markers for charged attacks, shields, faints, switches, effective hits and the result. The graph appears in each battle card, in Validate once a video is validated, and in Observed meta for each occurrence.

## 5. Learning from people

![The learning loop: uncertain detections become questions, answers refit the models, held-out gates decide what may be settled automatically](docs/meta-learning-loop.svg)

### Review questions

After an analysis, `questions.js` turns the uncertain parts into short questions with the evidence to look at: a regional form the icons could not settle (top form p < .85), a Shadow estimate between .15 and .85 (or with no measurable fast moves), a fast move below .85, and a battle result the timeline could not settle. Each question carries the clip of the longest matchup (12 s), three frame times, the evidence in plain words ("Measured 5 hits of about 6% HP, every 3 turns"), the model's confidence per option, and "Not sure" (recorded, changes nothing) and "Ask later". Questions about your own Pokémon are asked once and applied to every battle. Answers restrict the joint posterior (confirming Shadow can settle the fast move), set the species id once form and Shadow are known, and are kept in each battle's `reviewLog` so they can become benchmark labels.

**Why these thresholds.** They are the points where the held-out accuracy of the top pick drops below what the project accepts without a check (section 7, calibration): above .85 the model is right far more often than not, and asking there would spend reviewer time on questions it would mostly get right.

**Forms that are never asked (2026-10-17).** Two groups never produce a "which form?" question.
- *Look-alikes*: Gourgeist and Pumpkaboo sizes (Small / Average / Large / Super) are identical on screen. `combat.js` `LOOKALIKE` / `lookAlikeFamily`; `questions.js` skips the form question when every remaining form is a size of one species. Their stats differ, so the CP, the damage steps and the ranking prior still choose (the model keeps ranking all four; the top one is the species identity). `observed.py` `settle_forms` and `observed-core.js` `settledForms` treat such a Pokémon as identified (form p = 1 on the top size), so a team is no longer held out as "form unsettled".
- *In-battle form changers* are one species with battle states (`combat.js` `BATTLE_STATES`, mirrored by `observed.py` `BATTLE_FORMS`, which `usage_export.py` imports; a test keeps the two equal). Cramorant starts in its base form and turns Gulping / Gorging only after Dive or Surf; Mimikyu starts Disguised and turns Busted when hit by an unshielded charged attack; Morpeko alternates Full Belly / Hangry with every Aura Wheel, which changes the move's type (AURA_WHEEL_ELECTRIC / AURA_WHEEL_DARK). Aegislash Blade and Zen Darmanitan were already mapped the same way and use the same table. `narrowByRankings` collapses the state candidates onto the base state (the one PvPoke ranks, which is also the id the trainer pool needs: `cramorant`, `mimikyu`, `morpeko_full_belly`), `realForms` and the observed meta do the same for stored results, and `movesetFactor` treats the two Aura Wheel ids as one move so seeing either never rules the form out.

**Fast-move options cover every possible form.** `questions.js` `fastOptions` builds the choices from the union of the fast-move pools (fast plus non-charged elite) of every form still possible, or of the settled form once known (reviewer answer, p >= .98 or a single real form). The leading choices are the top four of the posterior plus each possible form's best move and any move only one form learns (at most six); every other legal move is listed as an `other: true` option, shown as an "Other move..." list in both the review card and the Validate view (the answer must be one of the question's options, so `feedback.py` accepts them). A move exactly one possible form learns carries `form` on its option and `moveForms` on the question; choosing it sets `answers.formByMove`, conditions the posterior (the form is settled, as a charged move already settles it through `movesetFactor`) and fills in the species id. `learnedFromAnswers` credits such an answer to the form that learns it (via the option's `form`, or the game master move pools when the stored answer has no options), and counts it as a form label too.

*Why Hisuian Electrode was missing* (reproduced on `Whoko23NhtM`): `core.js` `resolveForm` keeps only the candidates whose types equal the majority icon reading. The icons read Electric 23 times and never Grass, so Hisuian Electrode (Electric/Grass) was dropped before inference and the question listed Tackle / Spark / Volt Switch only. A single-type reading also fits a dual-typed form (the second icon is missed in about half the frames), so `fastOptions` adds such forms (`iconAlternates`: same Pokédex number, two types, one of them the reading, member note "rule out other forms") to the possible forms for the options only. The model itself keeps the exact filter: widening its candidates was tried first and flipped Zacian (Hero) to Crowned Sword at 97% in 57 saved questions, so form accuracy (section 7) stays as measured. A move only such a form learns carries the form's candidate record on its option; choosing it adds the candidate, settles the form and the species id (Thunder Shock settles Hisuian Electrode).

*Effect on saved results* (854 saved results re-derived through `refit.cjs` on the harvester's results, a copy, not the live work dir; open questions as `questions.js` would ask them): form questions 370 -> 269 (101 gone, none new: Gourgeist 47 (large 27, super 14, small 5, average 1) plus Pumpkaboo 2, Mimikyu 24, Cramorant 23, Morpeko 5); fast-move questions 3,154 -> 3,145 (9 gone, all battle-state species: Cramorant 4, Morpeko 4, Mimikyu 1) and 302 with changed options (an added Other move list, or a form's moves such as Kyurem (White) 61, Zacian 59, Electrode 21); Shadow questions unchanged (1,846). The Electrode question in `Whoko23NhtM` now offers Tackle, Spark, Volt Switch and Thunder Shock.

### Validate view and the learning loop

The **Validate** tab lists every open question from any source (your own analyses, the harvester) and works without video: a question from a harvested video plays its moment in an embedded YouTube player (or links to a YouTube tab), and a local recording can be opened to see full frames. Questions are ordered by an impact heuristic (`validation-policy.js`): uncertainty × a per-kind weight × √(how often the species appears) ÷ (1 + answers already given for that species and kind), with bonuses for questions that apply to all battles and for audit checks. **Priority**, **Type** and **Video** modes reorder the same queue.

Answers are durable (atomic writes in the work directory, a browser retry journal; on claude.ai the artifact's shared store). After eight new useful answers, `feedback.py` refits from saved evidence (never video): species priors (`learnedFromAnswers`: confirmed fast moves blend with PvPoke's prior, confirmed Shadow answers set the species' Shadow share), the Shadow classifier weights, and, every 24 new fast-move/form answers, the evidence settings (`movefit-fit.cjs` → `learning/movefit-params.json`, applied as `learned.fit`). Corrections and league changes refit sooner. Every refit re-derives every saved result and appends a record to `metrics-history.json`.

**Answers follow their battle when a labelled video is re-extracted.** Answers address battles by index, so `reextract-labelled.cjs` installs a new result only when its battles are unchanged; `--keep DIR` saves the others for `scripts/yt-harvest/remap_battles.py` (app stopped: it takes the validation lease, backs up every file and can `--restore`). Old and new battles are matched by time overlap (≥ 25% of the shorter battle; teams and CPs as a check); an answer moves to the new battle that holds its Pokémon and its question's clip, agreeing answers on rejoined battles are kept once, a conflict keeps the answer from the battle covering more of the new one, and answers on vanished battles are archived in `feedback.json` history, never deleted. The video's model resolutions and predictions are re-derived by the next refit.

**Championship footage with two phone screens.** `probe.cjs` finds a second phone of the same size (`secondScreen`) and `harvest.py` analyses the LEFT screen as the creator's battle by default (`perspective_crop`, `league.left_screen`): no question. A reviewer's earlier perspective answer always wins (left/right pick that screen; single, switches and "not a championship" leave the probe's screen). Weak championship words (`possibleChampionship`) plus two distinguishable screens also set the championship format (`refine_video`). The "perspective" question (`validate.perspective_reason`) is asked only when (1) one screen is shown and the championship evidence is weak, so it may be ordinary GBL, or (2) two screens were reported but the probe could not tell them apart (boxes overlapping by more than 30%), so there is no reliable left screen. One screen with strong evidence needs no question. `python3 validate.py withdraw-perspective <work dir> [--dry-run]` moves open questions the rule no longer asks into a backup (reversible) and lists `reanalyse`, the videos whose stored crop is not the left screen, for requeueing.

### What the model may settle on its own

Model resolutions leave the open queue but remain in a reversible **Model resolved** audit; a human answer always replaces them, and they are never labels. The gates, all measured out of fold by video:

| Kind | Rule | Current state |
| --- | --- | --- |
| Fast move, form | the lowest confidence threshold at which held-out answers were ≥ 95% right at that threshold and every higher one, over ≥ 30 answers from ≥ 5 videos, Wilson 95% lower bound ≥ .90, never below .90, margin to the runner-up ≥ .8; the label-free model (priors from traceable labels only) must agree | fast moves resolve at p ≥ .90 (102/103 held out); forms do not qualify (21 answers at the threshold, 30 needed) |
| Shadow | per direction: the classifier's held-out calls in that direction ≥ 95% right at that confidence, over ≥ 25 calls from ≥ 5 videos, lower bound ≥ .80; separate thresholds for Pokémon without focus shots | "not Shadow" at ≥ .72 (128/134), "Shadow" at ≥ .94 (27/28; chosen without the test video 14/16, so thin) |
| Shadow, by form | a form with no Shadow variant is never Shadow (deterministic rule) | resolves as "No" with the reason |
| Result | confident timeline rules (table in section 4); uncertain rules promoted at ≥ 95% on ≥ 30 answers from ≥ 5 videos | faints and surrender confident; fade, tie, mid-start, unread, both-alive asked with the guess |
| Audit | two deterministic confident-call spot checks per video stay open until a person answers | keeps measuring confident calls |

The old gates (posterior ≥ .98, four hits, eight same-species labels, 50 held-out checks) were kept for anything not covered above; on this data they never passed (calibration counted one answer per video and needed 50).

### Model performance view

Validate's second view charts the per-refit history: held-out accuracy per kind with the change since the previous refit, Shadow AUC and log-loss against the old posterior, stacked human-answered / model-resolved / open counts, calibration panels for the latest refit, the resolution gates in words, and the offline milestones (v4 moves, the Shadow classifier, HP bars, focus shots). Every chart has a crosshair, arrow-key reading and a data table. The history is backfilled from `learning/refit-N/` for refits that ran before it existed, marked `backfilled`.

### Assistance from a local vision model

`scripts/freellm` routes bulk, checkable work to a local Ollama vision model; nothing leaves the machine. A task type is delegated only after passing a gate of ≥ 95% exactly right on the owner's answers held out by video, every delegated answer is checked by a script or by two independent calls that agree, and resolutions are reversible and never labels. Only nameplate reading has passed; no Validate question kind has, so the model resolves no questions today. Nameplate reading is wired into the Node engine as an opt-in second reader (`HUD_LLM=1`, section 4).

### Re-analysis (`reanalyze.py`)

The harvester analyses each downloaded video once. Analysing a video again is a separate tool, `scripts/yt-harvest/reanalyze.py`, with its own process, lock (`WORK/reanalyze.lock`), log (`reanalyze.log`) and live report (`reanalyze-summary.json`), shown in Analyze & review › **Re-analysis**. The split exists because the two have different limits: the harvester waits on YouTube (in October 2026 its bot check paused downloads for hours at a time, and one stuck request kept a harvester from exiting for five hours), while re-analysis needs only local CPU. Before the split, queued re-analyses ran inside the harvester and so waited behind its pauses and shutdowns.

**When a video needs re-analysis.** A saved result keeps what the code read at the time. A video needs re-analysis when the code that reads frames changes in a way that affects it (names, moves, results, battle boundaries, screens), when Validate shows it was read wrongly ("battles are shown" on a video with none, a different championship screen, a missed phone), or when an analysis was interrupted. Fixes to the learned models do not need it: fast-move and Shadow priors are refitted from the saved measurements (§ 5, "Validate view and the learning loop"). Which videos a reading fix affects can often be found without video, by replaying the saved reads through the new rule; the 2026-10-18 nameplate fix found its 79 videos that way.

**Queue.** `reprocess(id, requested, reason, scope, source)` in the harvester's state database (`reanalysis_queue.py`). The card's **Queue videos** takes ids or links and a reason; Validate's requests arrive as files in `WORK/requeue/` and join the same queue (`reanalysis_queue.consume_requests`). A queued video keeps its earlier result and `x_status 'done'` until the new result replaces it atomically (the old one is kept as `.previous`); a failed re-analysis keeps the earlier result and leaves the queue; a stopped one stays queued. A queued video that is not on disk goes first in the harvester's download queue, or, when the card's Tornado box is ticked, is fetched through `tornado_fetch.py` within its allowance.

**Sharing the database.** The harvester claims only videos with no analysis and no queue entry (`X_CLAIM`); the re-analysis tool only queued ones (`X_REPROCESS_CLAIM`, claimed atomically across processes). At start each resets only its own interrupted work (`State(reset="all" | "reprocess")`), and the harvester leaves `reworking` claims alone while the re-analysis lock is held. Both rebuild the Validate inbox under `WORK/validation.lock`.

**Progress.** `run-node.cjs` writes the current video time to `PROGRESS_FILE` every 10 s of video; the card shows each video's bar, the run's count, and an estimate from this run's measured speed per worker (3× real time until two videos are done). **Stop safely** finishes the videos being analysed; **Stop now** ends them, and their earlier results stay.

## 6. Other game languages

Harvested uploads come from phones in many languages. Before 2026-10-11, 101 of 102 Japanese-titled, 39 of 41 Korean and 20 of 20 Chinese videos gave no battle, because no nameplate matched the English list and the tracker keeps only battles with a species. German UIs read 1.39 opponent species per battle against 2.49 for English, and no German, Spanish or Portuguese result screen was ever read. The fixes:

- **Species names** in Japanese, Korean, Chinese (traditional and simplified), German, French, Spanish and Italian from PokeAPI (`species-names.json`, keyed by Pokédex number, mapped to the same PvPoke entries; Mega and Primal carry the language's prefix). Latin-script names are matched on the English OCR text; CJK plates are re-read with Tesseract's `jpn`, `kor`, `chi_tra`, `chi_sim` fast models. Japanese look-alikes (一/ー, 口/ロ, hiragana, small kana) and stray edge characters are folded. The browser fetches a CJK model (1.7–2.5 MB) from jsDelivr only after 6 distinct plates gave no Latin name.
- **Game strings** for results, banners, the surrender dialog, matchmaking and effectiveness in each language (from the game's public localisation text), and **CJK banners** found by brightness steps rather than white pixels.
- **Battle boundaries**: the two-shields-at-once and post-fade rules above.

| Video | UI | Battles | Opponent species | Results | Full teams | What fixed it |
| --- | --- | --- | --- | --- | --- | --- |
| afvH9iu5WsE | ja | 0 → 5 | 0 → 14 | 0 → 0 (cut) | 0 → 4 | language, box refit (2.4%) |
| lC6aiKQuZ5c | ja | 0 → 7 | 0 → 20 | 0 → 3 | 0 → 6 | language |
| -mROfxnNVBk | ko | 0 → 5 | 0 → 12 | 0 → 5 | 0 → 3 | language (288×640 source) |
| maw_a7oKYMM | zh-Hant | 0 → 7 | 0 → 16 | 0 → 0 (cut) | 0 → 4 | language, inset locate, second offset |
| 3c8JZ4pQq50 | en | 0 → 12 | 0 → 36 | 0 → 2 | 0 → 12 | recalibration (−20 → 8) |
| u2jAMngLVBw | en | 0 → 10 | 0 → 30 | 0 → 1 | 0 → 10 | name-text guard (phone instead of facecam art) |
| GMF7uTFAyHM | en | 1 → 9 | 1 → 24 | 1 → 2 | 0 → 6 | box refit (11%) |
| ktg6J7if8Rc | de | 8 → 15 | 10 → 44 | 0 → 15 | 0 → 13 | language, result text, boundary rules |
| cGATSvEItIM | de | 15 → 10 | 12 → 36 | 0 → 10 | 0 → 9 | language, result text; split parts rejoined |

Ten sampled videos that gave no battle went from 0 to 55 battles. All 9 labelled recordings produced identical JSON before and after each of these changes, and English videos never switched language. Still open: results of videos that cut their result screens (most CJK uploads) come only from the Poké Ball count; Chinese two-line banners read poorly with the fast model; Portuguese move names are not in PokeAPI.

**At harvest scale, and the language search (2026-10-13).** The 2026-10-12 harvest re-analysed 286 requeued videos with these fixes. Japanese-titled videos went from 0 to 409 battles (45 of 74 gained), Korean from 1 to 92, Chinese from 0 to 38; on Latin-script videos the results read went from 6 to 351. Of the CJK videos still at 0, most are not battle footage (events, raids, guides); 36 analyses had spent the CJK search budget with English never reaching three species, 16 of them uploads of one Korean channel at 288×640, whose other 33 videos switched and gave about 5 battles each (one per game of a 5-game set). Their plates are blurry: the Korean model reads 메가뮤츠Y as 메가뮤츠누 and 이벨타르 as 이켈타로, so the first exact match came at the 53rd–79th plate, after the 40-plate budget, and every new fingerprint of the same unreadable plate (a "0", an empty read) cost a try. Changes:

- **Search budget** (`NameLanguage`): plates whose English read has no letter cost no CJK read and no try; the budget is 200 plates while English has named nothing (40 once it has); after 20 tries a model whose reads average 20 points of confidence below the best one's is no longer asked, so a long search costs about one read per plate (models not read yet, such as ones the browser hasn't loaded, stay in).
- **Korean by jamo** (`matchJamo`): after the switch to Korean, a plate matches the species whose name is closest in jamo (the letters inside a syllable), within a quarter of the jamo, when one species is closest. A blurred stroke changes one jamo but a whole syllable. Mega X and Y differ only in the final Latin letter, which Korean OCR reads as a syllable; the English read of the same plate usually still ends in it. Damaging each of the 1,076 Korean names with random jamo errors gave the wrong species 3 times at one error, 0 at two and 3 at three (the rest right or unmatched), and two consistent reads are still needed per species. Suggestions never switch the language.
- **Second pass** (`run-node.cjs`): the pass is single, so battles that ended before the language was decided had no species and were dropped. When the language was decided more than 45 s after the first nameplate (`LATE_LANGUAGE`), the video is analysed again with it preset (`NAME_LANGUAGE`); OCR is cached, so this mostly costs a second decode. The two Japanese videos tested whose first battle starts at the switch have long intros: the decision came within 45 s of their first plate and their output is unchanged.

| Video | UI | Harvest 2026-10-12 | Budget | + jamo | + second pass |
| --- | --- | --- | --- | --- | --- |
| 99komx6lfIw (288×640) | ko | 0 battles | 2 battles, 3 species | 2, 3 | **5 battles**, 7 opponent species, 5 results |
| 9KDK30i9hOI (288×640) | ko | 0 | 3, 3 + 3 | 3, 7 + 6, 1 full team | **5 battles**, 12 + 14 species, 2 full teams |
| 6qkOGaSvDIk (phone mock-up frame) | ja | 0 | 2 | — | 2 |

**Re-analysis at harvest scale (2026-10-13).** 125 videos were requeued for these changes (CJK search ran out 34, Korean 33, screen never located 38, wrong mid-battle flags 15, 16:9 HP bars 6) and analysed in a 6-hour harvest together with 51 earlier requests; 116 finished. Battles 341 → 515, opponent species 775 → 1,298, full opponent teams 173 → 343, results 181 → 341; 29 videos went from no battle to some (Korean 288×640 sets 0 → 5 each, Japanese uploads 0 → 3–7, the Npoke and Spanish screen-locate cases 0 → 4–11). The second pass ran on 21 videos. Four Korean 5-game sets lost a battle (6–7 → 5–6), a split battle rejoined: their full teams held or rose. 60 requests were still waiting for their download at the end.

**Language from banners (2026-10-17).** Uploads whose crop cuts the names off the phone's top (K7vaQKc1Gxs: only the ball row is in the frame; te5W8Jrc-Mk: the names are cut in half) give no plate to decide on, and a CJK video's banners were read with its model only once the plates had decided the language, so they stayed at 0 battles. `NameLanguage` now also takes banners: while English has named no species, up to 40 banners (found by their stroke edges in the one-line or the wide two-line box) are read with each CJK model, and one that parses as that language's "X used Y!" with a dictionary species and move (`bannerEvidence`) is a vote; two distinct votes switch. A send-out banner names no move and is no vote. The parses are kept, so once the language is decided the current battle's earlier banners reach the tracker, and a decision more than 45 s after the first plate triggers the second pass as before. English videos name a species on their first plates, so their banners are never read this way: the labelled recordings never read one (`metrics.nameLanguage` has no `bannerTries`) and give byte-identical output. Species then come from the banners (section 3, *Species from banners when the names are cropped off*).

**Battles lost in the 2026-10-12 re-analysis (checked 2026-10-13).** Against the previous results of the requeued videos:

| Video | UI | Battles | Full teams | Why |
| --- | --- | --- | --- | --- |
| _bnPdUKMYpw | es | 11 → 0 | 10 → 0 | no screen found (see *Locating the phone screen*); with today's `locate`: 11 battles, 33 opponent species, 11 full teams, 5 results |
| uYt7eHxdT8I | es | 17 → 12 | 12 → 11 | correct: 5 split parts rejoined; one team had been counted twice |
| PyY0dvrz9m8, iMkGf4Flu0k, o-RROgfJWJg, 5d9UzKXX_XQ | en | 7 → 5, 7 → 5, 9 → 6, 6 → 5 | unchanged | correct: split parts rejoined |

Every rejoined part shows the same opponent Pokémon, with the same CPs, on both sides of its join, 0.5–5.5 s apart, and in most the same matchup runs across the join. uYt7eHxdT8I's lost full team is a double count: one battle (Thievul 1488, Corviknight 1492, Clodsire 1500 CP; Charjabug against Clodsire from 463 to 474 s) had been split at 467.5 s by one frame that read no shields on either side, exactly the case of the two-shields rule.

The re-analysis also raised the number of later battles flagged "Recording starts mid-battle" from 5 to 83. Most are in Japanese uploads whose first Poké Ball reads as fainted on every frame, where the flag stays. Others came from the boundary rules: the post-fade rule opens the next battle on its first HUD, often read with a shield icon still appearing or a ball read '?', and the settling rule kept the flag although the HUD turned fresh half a second later (5d9UzKXX_XQ at 110.5 s). Replaying the recorded tracker inputs of 10 videos with the fix in *Battle boundaries from the HUD*: 8 battles (all full teams, in 6 videos) lose the flag, two videos whose HUD never reads fresh keep theirs (khxysRLr8AE, Mxwep4-3rVI), and nothing else changes.

**Stricter matching and plate checks (2026-10-17).** Owner-reported misreads, reproduced on the saved results and the videos:

| Report | Video | What was read | Cause | Now |
| --- | --- | --- | --- | --- |
| Zekrom as Corvisquire | 7qqbqf5Mb7E, 92mROoUiWLM, a-ltV3MZuTI, KnjGXqdTeps, Q7NtGwsfHR4, UMFxriyzb_0, zXKnx4V1v5U, gX8vb2b06R4, Ev5nq1Odt5c (ko, Master League) | 채크로우, 서크로우, 카크로두 at CP 4545–4565, both sides | jamo matcher: 2 jamo from 푸크로우, 3 from 제크로무 | ambiguous; CP leaves Zekrom |
| Jellicent as Stunfisk | Mxwep4-3rVI (ja, 572 px wide) | Jumpluff, Magnezone, Cramorant and Jellicent plates labelled マッギョ | name cache: their fingerprints were within 6% / 30% of Stunfisk's | far cells keep them apart (section 3) |
| Mime Jr. for Melmetal | 6zhjUeOaERo (en, stream overlay) | "Meime#”" on all 9 opponent Melmetals | a sticker over the name's end; "Mime" was a dictionary name | no "Mime"; covered plates not used |
| Blitzle | 7u31Xt6Fg4M (ja, Master League; video no longer on disk) | しまま4, しままま.』… on 6 battles, no CP, a water icon | hiragana folded to katakana: シママ is Blitzle (a hiragana nickname) | mostly-hiragana reads of under 4 characters match nothing |

Rules in `matchLocale`: a Japanese read that is at least half hiragana (species names are katakana) gives no suggestion and no exact name under 4 characters (しまま → シママ, ますます → デスマス); long ones still fold (きんぐどら). A one-character suggestion for a 4-character CJK key with another species two characters away is ambiguous (ゼラロム: ゼクロム at one, ゼラオラ at two), and so is a Korean jamo match beyond one jamo with another species within one more. Random jamo damage to the 1,076 Korean names (`jamo-sim`, seeded): one error 1,014 right / 1 wrong / 69 unmatched before and after; two errors 701 right / 2 wrong / 381 unmatched before, 648 / 2 / 381 after plus 53 ambiguous (the right species always among them, left to CP or icons); three errors 254 / 0 / 830 before, 231 / 0 / 830 plus 23 ambiguous after.

**Before and after (2026-10-18).** Every recording below was analysed by the code before and after this change with `SPECIES_ONLY=1` (nameplates, results and banners at the same 2 HUD frames per second, without HP bars), 4 workers, the saved crop, league and game data. The 9 labelled recordings are identical in battles, opponent species, leads and results: 194 of 194 opponent species (10min 12, hour-gl 56, hour 58, 1p_u7XyvWwU 15, 2xvzDbWx-RE 15, Mv4o3HC29iU 23, cyu1yFuGtZA 15), FLJKUTh5ru8 18 of 18 and jZ4ux4QBdUU 19 of 21 in both (regidrago and dragonite are only missed in species-only mode; the full pass reads all 21). The language test videos:

| Video | UI | Battles | Opponent species | Full teams | Species changed | Plates set aside (cover / CP / ambiguous) |
| --- | --- | --- | --- | --- | --- | --- |
| afvH9iu5WsE | ja | 5 → 5 | 14 → 14 | 4 → 4 | none | 0 / 0 / 0 |
| lC6aiKQuZ5c | ja | 7 → 7 | 21 → 21 | 7 → 7 | none | 9 / 0 / 0 |
| stLd7OkIg3Y | ja | 4 → 4 | 12 → 12 | 4 → 4 | none (the recorder's Charjabug flagged by its icons, kept) | 5 / 0 / 0 |
| L2Iyrc06j00 | ja | 6 → 6 | 8 → 8 | 0 → 0 | none | 0 / 0 / 0 |
| -mROfxnNVBk | ko | 5 → 5 | 14 → 14 | 4 → 4 | the recorder's Lugia now read in all 5 battles | 1 / 4 / 0 |
| maw_a7oKYMM | zh-Hant | 9 → 9 | 22 → 22 | 6 → 6 | none | 0 / 0 / 0 |
| ktg6J7if8Rc | de | 15 → 15 | 43 → 43 | 13 → 13 | none | 3 / 0 / 0 |
| aOHJSU0dVok | de | 10 → 10 | 29 → 29 | 9 → 9 | none | 13 / 0 / 0 |
| cGATSvEItIM | de | 11 → 11 | 32 → 32 | 10 → 10 | none | 11 / 0 / 0 |

And the reported videos (7u31Xt6Fg4M is no longer on disk; its saved reads replay as described above):

| Video | Battles | Opponent species | Full teams | Change |
| --- | --- | --- | --- | --- |
| Mxwep4-3rVI | 6 → 6 | 14 → 17 | 3 → 5 | 5 wrong Stunfisk entries gone; Jumpluff (4 battles), Cradily, Kingdra and Marowak read where their plates had reused Stunfisk's read |
| 7qqbqf5Mb7E | 5 → 5 | 13 → 13 | 3 → 3 | Corvisquire → Zekrom in 2 battles |
| 92mROoUiWLM | 5 → 5 | 13 → 13 | 4 → 4 | the recorder's Mega Mewtwo Y read in 3 more battles |
| 6zhjUeOaERo | 2 → 0 | 2 → 0 | 0 → 0 | every opponent name ends under a sticker: the two "Houndoo”" plates (right by luck) are set aside like the "Meime" ones; the full harvest's 9 Mime Jr. are gone |

On the saved harvest results (1,721 videos), replaying each saved member's nameplate read and majority CP through the new matching changes the species of 77 videos (`affected` scan; it cannot replay the name cache, plate cover or icons, so CJK videos with similar short names can change too).

## 7. Accuracy: what has been measured

### Battle level, on the labelled benchmark

Labels and tools are in `tests/meta-benchmark/`; recordings stay on the contributor's computer. Species labels were checked against nameplate images and every uncertain result by eye; boundaries come from the same Poké Ball cues, so the labels are not fully independent of the method.

| Recording | Battles | Opponent species | Leads | Results | Complete teams |
| --- | --- | --- | --- | --- | --- |
| 10min (Willpower Cup, phone, tuning set) | 4/4 | 12/12 | 4/4 | 4/4 | 4/4 |
| hour-gl (Great League, phone) | 19/19 | 56/56 | 19/19 | 18/18 | 18/18 |
| hour (Little Cup, phone) | 20/20 | 58/58 | 20/20 | 20/20 | 18/18 |
| 6 Creative Commons YouTube videos (3 channels) | all found, 0 extra | 100% recall and precision | all but one Master League battle | all read (forfeits 6/6) | all but one |

Across all nine: every battle, opponent species and result is correct except the battle where the recorder left the app; leads and complete teams are correct except one Master League battle. The phone HP-series change and the `knockout` result rule (2026-10-13, sections 3 and 4) leave all nine scores unchanged (each recording re-extracted with the old and the new code). Precision matters as much as recall: a PvPoke rankings page full of Pokémon names and nameplates covered by stream chat still give 0 battles.

### Fast moves, forms and Shadow, held out by video

| Model | Fast moves (197) | log-loss | Forms (31) | Shadow | Note |
| --- | --- | --- | --- | --- | --- |
| v21 (damage, cadence, hand-set priors) | 69/99 without priors, 82/99 with | −0.599 (log p) | | 34 → 51–52/62 with aura | 99-label benchmark, leave-one-out |
| v23 + effect text (P = .25) | 89/99 | −0.334 | | 53/66 | charged-hit damage raised Shadow from 50 |
| old joint model on 37 videos | 153/197 | 0.575 | 15/31 | | video-grouped CV |
| v4 evidence model | 162/197 | 0.426 | 25/31 | | 2026-10-11 |
| + HP-bar rework | 165/197 | 0.393 | 26/31 | classifier 171/208, AUC 0.917 (on its 208 labels) | 2026-10-11 |
| + refit of evidence settings | **166/197** | **0.339** | 25/31 | | 2026-10-12; nested 165/197 |
| Shadow classifier + focus shots | | | | **323/410, log-loss 0.461, AUC 0.870** | 125 videos |
| + phone HP series skip centred cutscene bars | 169 → **171/196** | 0.317 → 0.311 | 25/31 | 317/391, AUC 0.890 (unchanged) | 2026-10-13; 92 phone videos re-extracted, section 3 |

### HP bars on YouTube footage

Why bars were missed or misread on YouTube crops (223 nameplate-visible frames from 7 labelled videos), and the detector rework of 2026-10-11 that is now in `hp.js`: the hue classes, the row linking, the outline requirement, the wider band, sub-pixel ends and the flicker guard described in section 3. Results on the same frames (valid = outline present):

| | Your bar found (valid) | Opponent bar found (valid) | False bars |
| --- | --- | --- | --- |
| Old | 94 (85) | 139 (62) | 9 + 77 |
| New | 139 | 131 | 0 in a 40-frame visual check |

All 37 labelled videos were re-extracted; every battle structure was unchanged. Matchup frames with a bar rose from 31% to 41% (yours) and 31% to 37% (opponent); fast-move labels with fewer than two hits fell from 84 to 43 of 197 (none: 56 → 20); the damage ratio's IQR tightened from 0.79–1.22 to 0.76–1.15; no matchup has more hits than the true move allows. Wide, tablet-shaped screens (aspect 0.62–0.75) got their own bar windows: on two such videos matchups with hits on the recorder's bar went from 6 to 18 of 23 and 8 to 18 of 28.

### Calibration and thresholds

v4 held-out accuracy of the top pick by confidence: at p ≥ 0.80, fast moves 110/115 and forms 22/24; at ≥ 0.90, 80/81 and 19/19; at ≥ 0.95, 44/44 and 18/18. After the 2026-10-12 refit, fast moves at ≥ 0.90 are 102/103. Confident prior-only calls (no hits) were 24/24 and 1–3-hit calls 28/29, which is why the old four-hit gate was dropped. The old model had been overconfident (23/25 fast moves and 6/9 forms at p ≥ 0.98).

### Known failure modes

- **Fast moves with fewer than two measured hits** (18 of 84 wrong before the bar rework): the answer rests on priors, energy and icons.
- **Pairs that hit equally hard on the same turns**: Psywave/Tackle on Inkay, Shadow Claw/Metal Claw on Necrozma, Thunder Shock/Bite on Morpeko; 13 of 70 wrong among 4+ hit cases. Damage and cadence cannot separate them; the effect text can when the types differ.
- **Edited highlight reels**: cuts break HP tracking (half of the 14 remaining errors in the 2026-10-10 measurement).
- **Forms with identical types and no deciding move or icon**: Kyurem Black read as White (p 0.59–0.81), Mega Mewtwo Y whose nameplate read X. None reach the resolution threshold, so they are asked.
- **Shadows with no purple measured**: the aura box missed (Reuniclus, Cradily, a Sableye over 9 matchups), low-resolution reads (Gyarados at 288×640), purple-bodied species (Sableye, Giratina), videos without HP or aura evidence.
- **Results**: uploads that cut the result screen with an undecided timeline; timer endings indistinguishable from a fade.
- **Nameplate misreads that matched a real name** (fixed 2026-10-17, section 6): a fingerprint cache that reused one short Japanese name for others, a Korean jamo match two strokes from the wrong species, a hiragana nickname folded to katakana, a covered plate one letter from "Mime". The labelled benchmark never contained these (194/194 before and after); the checks against CP, cover and icons are measured on the language and reported videos instead.

## 8. Speed: where the time goes

### The Node batch engine

`run-node.cjs` decodes each video once. ffmpeg streams 10 frames per second, already cropped to the phone screen and scaled to 886 wide, with the rows below the last one the analysis reads cut off (23% fewer bytes on 16:9 screens). Nameplates, results, the surrender dialog and banners are read on every 5th frame; HP bars and the aura on every frame of a battle. Text is read with the Tesseract CLI only for new fingerprints, and every read is cached on disk by the exact pixels, arguments and model (`~/.cache/gbl-synapse/ocr-v1`). Long files are split into 20-minute chunks with a 6-minute overlap, decoded in parallel and merged; each battle is kept from the chunk where it starts, and merging reproduced every battle of both hour-long recordings exactly. The keyframe probe (`probe.cjs`) decodes only keyframes first (1–3% of a full pass), locates the screen and tests each keyframe for the HUD; videos with no HUD are skipped, and videos with a HUD in under 80% of their length are decoded only in padded battle ranges.

### Measurements

| Step | Before | After | Date |
| --- | --- | --- | --- |
| HP-bar search per frame | 11.4 ms: every pixel of the field | 1.7 ms: coarse pass over every 3rd row, two-comparison colour reject; identical output on 900 frames | 2026-10-10 |
| `findBars` per frame (480 band frames, 4 videos) | 4.5 ms | 2.1 ms: colour classes memoised in a 4 MB table, coarse sampling, blob linking only over open blobs; identical results on 7 stretches | 2026-10-11 |
| bars, aura and effect text per dense frame (240 s, 2,290 dense frames) | 19.9 s | 8.0 s | 2026-10-11 |
| one worker on that stretch | 56.4 s, 4.3× real time | 36.2 s, **6.7× real time** (paired speed-up 1.45–1.76×), CPU −23% | 2026-10-11 |
| 8 workers on 12 cores, estimated from CPU per video-second | ~26× real time | **~34× real time** (4.2× per worker) | 2026-10-11 |
| batch of 9 videos (4.75 h), 6 workers | | 23.5 min, 12.1× real time, about 5 minutes of compute per hour of video | 2026-10-10 |
| CP OCR | every new CP fingerprint (hundreds per video) | 13 reads instead of ~650 on a 670 s stretch | 2026-10-10 |
| ffmpeg filter order | crop + scale every frame, then drop to 10/s | drop first, then crop + scale: +26% throughput | 2026-10-10 |
| per-matchup ffmpeg seeks (v2) | one process and keyframe seek per matchup, 25 s cap | gone: one decode per file, whole matchups | 2026-10-10 |
| refit of saved evidence, 37 labelled videos | 21 s | 5 s (per-combination likelihoods multiplied) | 2026-10-11 |
| refit of 21 saved battles | 1,280 s of historical extraction | 0.82 s | 2026-10-11 |
| historical average, 396 full harvest passes | | 2.60× real time (mixed loads and versions) | 2026-10-11 |

Where a full pass spends its time (462 saved analyses): frame pipe wait and assembly 64%, OCR 25%, HUD 21%, HP and aura 8%, classifier fitting 0.1% (counters overlap). After the second round the bar work is no longer the largest cost; decoding is: about 7 CPU-seconds per minute of video for H.264 decoding and 8 for ffmpeg's scale and RGBA conversion, against 2 for bars. The owner's 60 fps HEVC recording is limited by software HEVC decoding (88 of 94 s).

**Measured and rejected** (each with identical-output checks): restricting the fine scan to columns where bars can start (314 of 480 frames needed the fallback, slower); reusing the previous frame's bar position (cannot guarantee identical output); 32-bit pixel reads (polymorphic closure, slower); rgb24 output expanded in Node (4 ms per frame cancelled the saving); FIFO and blocking-read transports (more CPU, or hangs); VideoToolbox hardware decoding (byte-identical on H.264 and −30% ffmpeg CPU, but not identical on HEVC and no gain with 8 concurrent decodes, so opt-in only); scale-filter threads (no gain); lower resolution or frame skipping (changes the pixels: a 560-wide trial lost an opponent and misread a banner actor); lossless frame proxies (FFV1 and Huffyuv slower than decoding, UtVideo 2.2% faster for 751 MB per minute). Keep temporal sampling at 10 fps: HP trails and fast-move cadence are short events.

### Re-analysis

Measured 2026-10-18 while designing the re-analysis tool:

| Idea | Result | Decision |
| --- | --- | --- |
| Decode only the earlier battles (±30 s), reuse the screen box, preset the nameplate language | 3 queued videos: identical on one; on a Japanese Little Cup video the recorder's Hoothoot disappeared from all four battles (the language preset alone changed the reads); on a Korean Master League video a battle starting at 4 s was cut off and three team lists changed. Battles cover 94% of the median video (134 of 200 h on disk), so the decode saving was small anyway | not used: every re-analysis decodes the whole video |
| VideoToolbox decoding, 8 parallel 720p streams of 120 s | software 5.0–5.7 s, VideoToolbox 8.9 s (frames byte-identical); the media engine is the bottleneck | not used (as before) |
| Skip the first pass when the language is decided late | 40 of 280 non-English results were analysed twice; their first pass was 58% of their time | open: needs a check that presetting gives the same answers |

The real levers are the number of workers against other load on the machine, and not re-analysing videos a fix doesn't affect (replay saved reads first). Larger gains would need work in the reader itself: one long-running OCR process instead of about 2,000 Tesseract launches per video, and keeping each battle's nameplate crops so name-reading fixes can be applied without the video.

### The browser

The browser seeks keyframe to keyframe (about one per second on phones; YouTube re-encodes with one every 6 s, so it falls back to fixed 1 s steps), reads the HUD, and plays each matchup at 2× to sample bars about 10 times per video second. Hidden tabs are throttled and timings there are not comparable. The last measured whole-recording run was the v1 era: 650 s of video in 154 s with 1,694 OCR reads; v2 brought the same file to 64 text reads (146 with charged attacks). A 150 s clip took 32 s.

### Scaling

Each file (or chunk) is independent and the batch is resumable, so throughput grows with cores and machines: at the 2026-10-10 rate a 1,000-hour dataset was about 3.4 days on one 12-core machine, and the per-worker rate has risen by about a third since. The next per-machine gains are decode-side: reading only the needed bands as raw YUV (skipping colour conversion of the rest of each frame, about a third of ffmpeg's work), and measuring HP and aura at the phone's native resolution while OCR crops are enlarged, which waits on a Shadow retraining because it shifts the aura measurement.

## 9. Outputs and data policy

- **Battle summaries.** Each battle's summary holds the teams, fast moves with confidence, Shadow estimates, events relative to the battle start, and the HP timeline as whole percents; no video, frames or trainer names. In the browser they are stored at `analyses/<recording>#<n>`; the harvester writes `results/<video>.json` with the full evidence (HP series at 10 readings per second, aura, hits, focus shots) so refits need no video.
- **Reviewed reports** (`schema: "meta-extractor-v1"`) carry battle ids (file fingerprint plus half-second start), recording context, teams, outcomes, events, confidence and review flags; imports are bounded to 10 MB and 5,000 battles with validated species ids.
- **Observed meta** reads harvested results, saved browser analyses and imported reports, applies human answers over detections, groups by League › Cup › Period with a per-battle schedule check, keeps partial lineups separate from complete teams, and shows each team's occurrences with the source video at battle start and the saved HP graph. Appearance rates carry a Wilson 95% interval on the effective sample size, and an estimate shrinks each rate toward a PvPoke-ranking prior worth 10 battles. Team Rocket and championship battles are flagged and excluded.
- **Shared sample** (opt-in, hosted app): species, result, league, cup, date and an opaque contributor id; each contributor counts at most 50 recent battles by default; a recency half-life down-weights old battles; contributors can withdraw.
- **Deduplication.** `dedup.cjs` matches the same battle across uploads by teams, result and every faint and charged move within 2 s; it caught every battle of a simulated re-upload with timing jitter and found no false duplicates among 86 real battles. The usage export also removes split battles and same-creator re-uploads.
- **Usage export for Team Rankings.** `usage_export.py` writes complete Great League opponent teams (human answers first, Shadow only when confirmed or resolved, every member in the pool, dated by recording else upload date, each channel capped at 10% of the weight) with a quality report. The first export (2026-10-11) gave 190 teams (181 distinct) from 46 videos by 18 creators.
- **Stored video.** Complete source videos are kept (tiered retention: human-labelled and queued videos always; analysed videos with battles newest first up to `--retain-budget-gb`, 100 GB by default; failed, duplicate and battle-free ones deleted), because re-analysis needs the frames. Only the battles are needed, but cutting the rest saves little and loses something: battles cover 94% of the median video and 67% of all stored hours, a lossless cut can only fall on keyframes (up to 6 s apart on YouTube uploads), and a later fix that finds battles the old code missed would find nothing to read. Two ways to make the files smaller keep every timestamp: cropping to the phone screen (64% of the frame's pixels in the median video, so about a third smaller), and re-encoding to HEVC (typically a similar saving; not measured here). Both re-encode an already compressed video, so both lose detail the reader may depend on (small nameplate text, one-pixel HP-bar steps, the colours of Shadow flames). They would be safe only behind a check that the compact copy gives the same answers as the original; until then the originals are kept and the retention budget is the size control. The harvester downloads video only, without the audio track.
- **Policy.** Recordings never enter the repository; only derived data is committed. Opponent trainer names are never read or stored. Non-Creative-Commons footage is analysed privately and never sent to any remote model; Creative Commons HUD crops may be.

## 10. Gaps and improvement areas

Ordered by expected impact, with the evidence behind each estimate.

### Accuracy

| Gap | Evidence | What would close it |
| --- | --- | --- |
| **Shadows the camera never frames** | 233 of 410 labelled Pokémon have no focus shots; on that subset the classifier is 168/233 against 155/177 with shots | re-download the 46 videos that failed YouTube's bot check and backfill focus shots; a learned aura classifier on the crop (shape and motion of the flames) instead of one colour statistic, trained on the 410 answers |
| **Equal-damage fast-move pairs** | 13 of 70 wrong among 4+ hit cases are pairs that hit equally hard on the same turns | each fast move has a distinctive animation: a small temporal model on the matchup's first seconds, labelled by the answered questions; cheaper first: use the effect text more often (currently read only with a located bar) |
| **Results cut from uploads** | most CJK uploads cut the result screen; fade, tie and mid-start rules sit at .71, .84 and .47 | read the battle clock (timer endings vs fades), use the post-battle rewards card as a result cue, collect more answers so the rules can promote |
| **Forms with identical types** | Kyurem, Mega Mewtwo, Dialga/Palkia Origin rest on priors; forms never qualify for auto-resolution (21 answers) | use charged-attack damage (the forms' stats differ), ask for form labels specifically on those species |
| **Low-resolution sources** | 288×640 and 360×640 uploads lose matchups entirely (23 labels with no evidence) | enlarge OCR crops while measuring bars at native size; lower the minimum bar height for small sources with its own validation |
| **Lead when the opponent swaps immediately** | "Go, X!" banners are recorded but not yet used to set the lead | use the first opponent "Go" banner as the lead when it precedes the first stable nameplate |
| **Centred cutscene bars on phones** (resolved 2026-10-13) | the opponent's HP series followed the attacker's centred bar in 696 of 4,830 phone matchups (249 with false hits of 1.5–35%) | done: `track` skips centred bars on every screen (fast moves 169 → 171/196 held out, Shadow unchanged; section 3). The knockout inside the final cutscene, which this cost (13 of 908 "faints" wins became questions), is read by the learned rule `knockout` (section 4): 74/77 against read result screens, 12 of the 13 asked with the right guess. It settles them on its own once owner answers pass the promotion gate (7/9 on 6 videos so far; 30 at ≥ 95% from 5 videos needed) |
| **Names cropped off the top** (fallback done 2026-10-17) | uploads that crop the names off the phone's top (K7vaQKc1Gxs) or in half (te5W8Jrc-Mk) gave 0 battles: the tracker needed a nameplate species | done for battles whose nameplates name nothing: language and species from the banners (section 3, *Species from banners when the names are cropped off*; on synthetic crops of two Japanese videos 0 → 6 battles each, 17 opponent species and 5 full teams, against 17 and 5 from their nameplates; the real y_ubrafzmFI 3 → 4 battles and L2Iyrc06j00 6 → 7). Open: K7vaQKc1Gxs and te5W8Jrc-Mk themselves are measured only through synthetic crops until the harvester can download them again |
| **Teams from half-cut names** | when the CJK model reads one half-cut name, the battle counts as named and takes nothing from its banners: y_ubrafzmFI, cc1z7nZJbgk and L2Iyrc06j00 have about one nameplate species per battle, while their banners name most of each team | complete a battle's teams from its banners when its nameplates named fewer than two species per side, measured against the nameplate runs of uncropped videos (the synthetic crops above) before it touches battles that are named today |
| **Sides of attacks in mirror matches** | an attack whose species both sides fielded needs a shield, faint or HP-drop cue; in the synthetic crop 14 of 47 attacks were in such matchups, and your side found 11 of 17 species | the focus shot's centred bar (whose fill matches one side's last reading, as `focusMoments` does) as a fourth cue |
| **Nicknamed recorder Pokémon** | only the recorder's side can be nicknamed; OCR cannot resolve them. Hiragana nicknames in Japanese (しまま in 7u31Xt6Fg4M, read as Blitzle) no longer match (section 6) | a species check question when nameplate confidence is below ~60; the local vision model as second reader (wired in, `HUD_LLM=1`, not yet run at harvest scale) |
| **Plates under overlays** | stickers and chat pop-ups next to or over a name (6zhjUeOaERo: every opponent name) now give no species instead of a wrong one | species from the "X used Y!" and send-out banners, which overlays rarely cover; a cover test on the banner area |
| **Label independence** | boundary labels come from the same Poké Ball cues as the method | a second labeller, and labels from the game's own battle log where creators share it |
| **Phone placed differently in each clip** (resolved 2026-10-17) | one crop per video; a clip 5–6.5 px (at 960 wide) from it read no HUD, at 3.6–4.5 px about half its keyframes, and at 13 px it read the Poké Balls one slot over. 7 of 256 retained uploads have 2–3 placements (six Npoke, one El Tío Boris), changing only at clip cuts | done: per-placement boxes from the probe (`screen.js` placements, `probe.cjs`), `CROPS` in the runner with a HUD offset per placement, the same plan on the requeue path (section 3). On the 7: battles 29 → 35, opponent species 80 → 98, full teams 24 → 30, all 8 "starts mid-battle" and "more than three species" flags gone. Left: a clip that also changes the phone's size (eQphfsMBt_A's last); `CROP=auto` without a probe; the browser re-locates only after the HUD stops reading, so a battle in a new placement can lose about 10 s |

### Speed

| Gap | Evidence | What would close it |
| --- | --- | --- |
| **Decoding dominates** | ~7 CPU-s per minute for H.264 decoding + ~8 for scale and RGBA conversion, vs ~2 for bars | decode only the needed bands as raw YUV; native-resolution HP and aura with enlarged OCR crops (after a Shadow retraining); hardware decoding on an idle machine with exact comparison for H.264 only |
| **Zero-battle passes** | 213 full passes found no battle yet used 53% of recorded work; after the language fixes most are non-GBL footage | cheaper HUD screening with padded windows, and negative caching of rejected surrender candidates (some runs made thousands of surrender OCR reads), each validated on short-dialog and missed-battle fixtures before becoming the default |
| **Browser throughput** | seeking decodes intervening keyframes repeatedly; hidden tabs throttle | a WebCodecs stream for browsers that support it, decoding once like the Node engine |
| **Refits scale with labels** | a full refit of all videos is seconds today but re-derives every saved result | incremental refits per changed video (the observed catalog already rebuilds per video) |

## 11. Reproducibility

```
node --test tests/meta-extractor.test.cjs tests/meta-locale.test.cjs tests/meta-nameplate.test.cjs tests/meta-hp-speed.test.cjs   # unit tests
node tests/meta-benchmark/run-node.cjs RECORDING.mp4 run.json                                         # one recording
node tests/meta-benchmark/score.cjs tests/meta-benchmark/labels/10min.json run.json                   # battle-level score
node tests/meta-benchmark/run-batch.cjs jobs.txt out/            # jobs: path|league|gamemaster|crop ; JOBS=6 SPLIT=20
node tests/meta-benchmark/parity.cjs                              # identical-output check against a base commit
node tests/meta-benchmark/movefit-eval.cjs                        # fast moves and forms, held out by video
node tests/meta-benchmark/shadow-cv.cjs                           # Shadow classifier, leave-one-video-out
node tests/meta-benchmark/result-policy.cjs                       # result rules against human answers
node tests/meta-benchmark/learning-loop.cjs                       # refit, gates and resolutions (dry run)
python3 web/run_app.py                                            # local app: harvester, Validate, Observed meta
bash web/scripts/yt-harvest/overnight.sh --hours 9                # unattended harvest
```

Environment variables of the runner: `GAMEMASTER=path` (game data as of the recording date), `LEAGUE=1500|2500|10000|500`, `CROP=auto|x0,y0,x1,y1`, `CROPS=x0,y0,x1,y1@s-e,…;…` (a box per stretch, probe placements), `START`/`END`/`RANGES`, `FPS=10`, `HUD_EVERY=5`, `FFMPEG_THREADS=1`, `DECODE_ROWS=full`, `LEARNED_PATH`, `NAME_LOCALES`, `NAME_LANGUAGE` (preset nameplate language), `LATE_LANGUAGE=45` (second pass when the language was decided this many seconds after the first nameplate; −1 never), `OCR_CACHE_DIR`, `SPECIES_ONLY=1` (nameplates, results and banners only, at 2 HUD frames/s and no HP bars: for nameplate-reader benchmarks), `HUD_LLM=1` and `HUD_LLM_BUDGET=30` (second nameplate reader, YouTube footage only). Benchmark runs need ffmpeg and the Tesseract CLI; CJK models live in `~/.cache/gbl-synapse/tessdata`.

## 12. History and provenance

The extractor was ported from the owner's **PoGo Recorder / PoGoAnalyzer** prototype (Python, OpenCV, pytesseract). The port kept the portrait name-box layout and the idea of change-gated crop OCR, and replaced subprocesses with the browser's decoder, Canvas crops and a persistent Tesseract.js worker. The main improvements over the prototype were: editable, normalised geometry instead of hard-coded pixels; one decoder serving all crops instead of two full decodes; fixed-size fingerprints instead of resolution-dependent pixel norms; full-line, multiword dictionary matching with explicit, unassigned one-character suggestions; a reviewable battle state machine instead of result screens as the only boundaries; partial battles kept as Unknown instead of dropped; explicit form candidates and a lead check; cancellation, progress and evidence links; charged-attack capture; a reproducible report format with repeat-file ids and a trainer export; confirmed-result denominators; and sampling strata (date, league, cup, rating).

| Version | Date | Change |
| --- | --- | --- |
| v1 | 2026-10 | browser port: fixed-rate crops, 22-second gap rule, two-reading confirmations; 650 s in 154 s with 1,694 OCR reads |
| v2 | 2026-10 | keyframe sampling, nameplate measurements instead of text, one OCR read per name, battle structure from the HUD, charged banners; 64 text reads on the same file |
| v3 | 2026-10-10 | single-pass Node engine at 10 fps, whole-matchup HP series, energy and moveset reconciliation, charged-attack damage, effect text, learned priors from 195 answers, cross-upload dedup, shared sample |
| v4 | 2026-10-11 | evidence model refit on 228 labels (gap likelihood, proportional noise, clock-time energy, icon confusion), Shadow classifier, focus shots, HP-bar detector rework, recalibration and screen refit, other UI languages |
| | 2026-10-12 | results from the timeline with learning rules, result screens and banners in ten languages, boundary rules, evidence refit on the new hits, per-video observed catalog |
| | 2026-10-13 | language search for blurry CJK uploads (budget, model narrowing), Korean names by jamo, second pass when the language was decided late |
| | 2026-10-13 | a battle that turns fresh within 20 s of its start is not flagged as starting mid-battle |

## 13. Dependencies and attribution

- Original prototype: https://github.com/evanjfries/PoGoAnalyzer
- Pokémon and move data: https://github.com/pvpoke/pvpoke (bundled game master, dated copies cached locally)
- Browser OCR: https://github.com/naptha/tesseract.js and tesseract.js-core; Node: the Tesseract CLI
- OCR models: https://github.com/tesseract-ocr/tessdata_fast (`eng` bundled; `jpn`, `kor`, `chi_tra`, `chi_sim` fetched on demand, Apache-2.0)
- Species and move names in other languages: https://github.com/PokeAPI/pokeapi (BSD-3-Clause)
- Game strings for results, banners and dialogs: Pokémon GO localisation text as published by PokeMiners (a few matcher strings only)
- Licence texts for the OCR dependencies are kept in `vendor/`.
- Figures in this document are frames from Creative Commons Attribution videos: KZ FAM (YouTube 1p_u7XyvWwU) and PokeDeeGO (2xvzDbWx-RE). No private recordings or frames are shipped with the site.
