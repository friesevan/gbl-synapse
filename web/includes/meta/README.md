# Meta Extractor — algorithm, prototype audit and development roadmap

Meta Extractor is a working browser demo ported from Evan Fries’s **PoGo Recorder / PoGoAnalyzer** prototype. Open the **Meta Extractor** main tab (`?app=meta`). A recording is selected on the contributor’s device, sampled and OCRed locally. The video is never uploaded to a server. Reviewed observations can be saved in this browser, exported, and imported to combine contributor samples. **There is no centrally hosted contribution database in this demo.**

## Contributor workflow

1. Select an English-language battle recording. Portrait screen recordings work best; browser codec support determines which MP4/MOV/WebM files can be decoded. H.264 MP4 is the most portable choice.
2. Set the actual **recording date**, league, cup and rating bracket. The recording date deliberately does not default to today: old recordings must not masquerade as current usage.
3. Pause during a normal battle. Check name crops using the colored overlay; use **Read this frame** to test OCR. Adjust left/top/width/height percentages for your screen. Portrait defaults come from the original 1179×2556 reference layout.
4. Select a start/end range and sampling rate, then analyze. Cancel preserves partial detections. First use loads a local English OCR model; subsequent sessions reuse its browser cache.
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
{"source":"Meta Extractor: human-reviewed video observations","cp":1500,"cup":"all","collectedAt":"ISO export timestamp","rank":"2200–2400","teams":[{"members":["melmetal","cramorant","jumpluff"],"count":1}]}
```

The reviewed report retains each battle’s original date. Trainer aggregate `collectedAt` is the export time; select an appropriate date window before exporting. Moveset and IV uncertainty is not resolved by that team-only format; the trainer’s opponent initialization still applies.

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
