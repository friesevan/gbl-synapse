# Video analysis speed and reusable storage — 2026-10-11

The classifier processes and running app were not stopped or restarted. No model weights, human labels, live results or source videos were overwritten. New defaults apply to new harvester/analysis processes; an already-running harvester keeps its previous retention setting until its next normal start.

## Second round: per-frame HP-bar work and frame transport (2026-10-11, after fa57ad7)

Every change below gives **identical results**. `web/tests/meta-benchmark/parity.cjs` runs run-node.cjs from a base commit and from the working tree on seven 4-minute stretches and compares the JSON outputs, ignoring timings, metrics, decoding metadata and random battle UUIDs. The stretches cover 1080p, 720p and 1440-wide YouTube crops, 296- and 340-wide phone crops, a short screen and an owner HEVC recording at 886×1920 without a crop. All seven were identical to fa57ad7: battles, species, CP, results, HP series, fast-move hits, effect reads, aura values and fits. `web/tests/meta-hp-speed.test.cjs` compares the new findBars with the old implementation on 240 seeded synthetic scenes, custom settings and canvas arrays.

**Benchmark:** `relabel-cache/bB0ZrWjwdZw.mp4`, 0–240 s, 3 battles, 2,400 frames, of which 2,290 were dense. One worker, nice 10, `FFMPEG_THREADS=1`, warm OCR cache. The runs were interleaved base/new three times while other agents kept the 12-core M2 Max at a load of 12–14, so wall times vary by about ±10%. CPU is user+sys of node plus ffmpeg.

| | fa57ad7 | now |
| --- | ---: | ---: |
| bars: HP bars, aura and effect texts per dense frame | 19.9 s (19.4–20.2) | 8.0 s (7.9–8.1) |
| decode wait | 34.9 s (28.3–40.0) | 26.7 s (23.5–33.0) |
| HUD | 0.69 s | 0.63 s |
| OCR | 0.12 s | 0.11 s |
| wall | 56.4 s, **4.3× real time** (3.9–4.9) | 36.2 s, **6.7×** (5.6–7.3); paired speed-up 1.45–1.76× |
| CPU, node + ffmpeg | 112 s | 86 s (−23%) |

**8-worker estimate:** 8 workers need more than 12 cores, so throughput is CPU-bound. At 0.468 → 0.358 CPU-s per video-second, the aggregate rises from about 26× to 34× real time, or 3.2× → 4.2× per worker (+31%). This is arithmetic from the single-worker CPU figures for an otherwise idle machine; no saturation run was made.

Sources where bars dominated gain most. Small phone crops gain 1.0–1.3× on wall time: they decode faster and the bar work was already small. The owner's HEVC 886×1920 60 fps recording is limited by software HEVC decoding (88 s of 94 s), so its wall time is unchanged. Its bar time fell from 4.5 s to 3.0 s.

What changed:
- **findBars (hp.js)** costs 4.5 → 2.1 ms per frame on 480 dumped band frames from four videos, an isolated, repeatable micro-benchmark.
  - cls is memoised in a lazily filled 16M-colour table, 2 bits per colour (4 MB). Dark pixels skip the table.
  - The coarse row pass tests only every R-th sample, then its neighbours. Any R consecutive samples include exactly one multiple of 2R.
  - Blob linking searches only the blobs that reached the previous row, in creation order, instead of `blobs.find` over all blobs.
- **Rows below the last one read are not decoded into the frame.** ffmpeg emits `…,format=rgba,crop=W:rows:0:0`. The kept rows are byte-identical (checked by hash on H.264 crops and owner HEVC). The cut is below the HP-bar band, the result/surrender band and the top half. That moves 23% fewer bytes on 16:9 screens and saves about 2.4 s of ffmpeg+node CPU per minute of video. `DECODE_ROWS=full` restores full frames.
- **`FFMPEG_THREADS=n` also sets `-filter_threads n`.** The output is byte-identical, and ffmpeg uses about 7% less CPU with n=1.

Measured and rejected:
- **Restricting the fine scan to columns where bars can start**, with an exact fall-back. A row only links to rows starting within spanX of it, but scenery runs start everywhere: 314 of 480 frames needed the fall-back, which made it slower.
- **Reusing the previous frame's bar position.** findBars returns every bar candidate, and track/assignBars use the full list. Searching a window first can't guarantee identical output, so it isn't done.
- **32-bit pixel reads.** They were slower: the closure became polymorphic.
- **rgb24 output plus expansion to RGBA in node.** The bytes are identical, but expanding cost 4 ms per frame and cancelled the transport saving: 20.3 vs 20.0 CPU-s per minute.
- **Other transports.**
  - A FIFO read with fs streams doubled node CPU.
  - Blocking readSync from a FIFO saves about 1.5 s per minute, but it hangs if ffmpeg never opens the FIFO.
  - Node's child pipe is a Unix socket with 8 KB buffers. Fewer bytes was the reliable lever.
- **VideoToolbox (`FFMPEG_HWACCEL=videotoolbox`, still opt-in).** On 1080p H.264 it gives byte-identical frames and cuts ffmpeg CPU by about 30% (16.7 → 11.3 CPU-s per minute). It is **not** identical on the owner's HEVC yuvj420p recordings. With 8 concurrent decodes on the loaded machine, throughput was no better (19.5–20.1 vs 20.6–21.6 video-s per second), and single-stream wall time was about 10% worse.
- **Scale-filter threads, lower resolution and skipping frames.** `scale=…:threads=4` gave no gain. Any change to the scaler, the resolution or frame skipping (`-skip_frame nonref`) changes the pixels. The ffmpeg scale and RGBA conversion (about 8 CPU-s per minute at 886 px) and H.264 decoding (about 7 CPU-s per minute) are now the largest costs. The native-resolution proposal (`ANALYSIS_WIDTH=native`) stays off by default because it would shift aura and HP measurements while the Shadow model is retrained.

Zero-battle screening, checked on 850 saved analyses:
- Zero-battle runs are still 54% of recorded extraction time, but 441 of those 493 runs (28.6 of 35 worker-hours) predate the keyframe probe. They have no `probe` record.
- The 52 probed zero-battle full passes (6.3 worker-hours) all had HUD hits: 46 had more than 20 keyframes with the battle HUD, and the median was 116 for full-coverage runs. A no-HUD screen therefore can't drop them. They look like detection failures or non-GBL battles, and need review with footage answers rather than a cheaper skip.
  - Follow-up (2026-10-11): 43 of the 52 had a Japanese, Korean or Chinese game UI; the others a wrong first calibration, a wrong or slightly too wide screen box, or covered nameplates. Fixed in the extractor; see `web/includes/meta/README.md`, *Battles from zero-battle videos*.
- These runs averaged a median 106 surrender OCR reads each. The exact surrender-pixel cache (fa57ad7) already reuses identical reads. Approximate negative caching still needs short-dialog recall fixtures, so no change was made.

## What was measured

462 saved analyses contained 1,585 battles. The 396 full passes recorded 236,587 seconds of work over 614,691 sampled video-seconds (2.60× realtime). The latest 100 full passes were similar (2.58×). These are historical measurements across loads and extractor versions, not an isolated sustained benchmark.

| Recorded work | Share of full-pass wall time |
| --- | ---: |
| Frame pipe wait / assembly | 64.4% |
| OCR | 24.6% |
| HUD, including some OCR | 20.7% |
| HP/aura, including some OCR | 8.4% |
| Classifier fitting | 0.1% |

Counters overlap: OCR is included in parts of HUD/bars, and pipe wait is not pure decoder CPU. Do not add the percentages. 213 full passes found zero completed battles yet used 53.2% of recorded work (about 35 worker-hours). Some are detection failures, so zero battles alone cannot justify dropping footage. The existing keyframe probe skipped 65 full passes, inspecting 25.5 video-hours in 16.6 minutes. Existing padded ranges and screen cropping remain enabled.

## Changes now implemented

- **Retain source videos by default**, including extraction failures. `--keep` remains supported; `--discard-videos` explicitly restores deletion after processing. Startup preserves complete ID-named sources even if older database records say deleted, while incomplete download fragments remain eligible for cleanup. Duplicate download copies are still discarded; results and feedback remain outside Git. No automatic source eviction was added. The 150 GB media budget and minimum-free-space guard pause new downloads instead of deleting retained data. Already deleted sources are unavailable; retention does not recover them.
- **Raw OCR cache** at `~/.cache/gbl-synapse/ocr-v1`. Exact transformed PGM bytes, OCR arguments, Tesseract version, selected traineddata content hashes and environment identify each entry. Learned predictions are never cached. Atomic writes and checksums support concurrent workers; corruption or unavailable cache/model identity falls back to fresh OCR. `OCR_CACHE_DIR=off` disables it; a directory overrides its location. `OCR_CACHE_REVISION` can invalidate custom configurations.
- **Persistent screen/range probe cache** in `<work-dir>/probe/<id>.json.cache.json`. Source path, recorded SHA prefix, size, mtime/ctime, screen/HUD/probe code and probe settings must match. Raw probe metadata is retained; classifier priors do not invalidate it. A reviewer-requested full reanalysis still bypasses range trimming.
- **Offline media inventory / retest jobs.** `media_cache.py` reads SQLite in read-only mode, reports available/missing/unsafe sources, can verify hashes, and generates `run-batch.cjs` jobs plus a source/context manifest. Stored crop and original source timestamps are preserved. Generated jobs analyze whole original files by default. Explicit `--use-saved-ranges --verify-sha` adds padded ranges only when the current digest matches both the recorded source hash and the original extraction's media hash. Legacy/unbound, invalid and explicitly full-source metadata stays full. Existing results keep their original media provenance when resumed. It does not download, delete, or create proxies.
- **Correct range-aware batch jobs.** Optional fifth JSON range column and inherited `RANGES` are normalized, merged and clipped to each chunk including its six-minute overlap. Empty windows produce mergeable empty outputs without launching FFmpeg; a missing plan remains a full pass. `FORCE_FULL=1` overrides all range plans for detector/crop review. Standalone `run-node.cjs` also clips to `START`/`END` and rejects an empty intersection rather than accidentally decoding the entire file. Batch/merged throughput now uses actual sampled seconds, with source duration and per-chunk metrics reported separately.
- **Complete OCR counts** now include effectiveness and surrender reads in `metrics.ocrCalls`, with cache hit/miss counters. Historically the displayed OCR count omitted 320,602 such calls. Incomplete/failed FFmpeg streams now fail the extraction instead of publishing partial output as success.
- **Explicit quality experiments:** `ANALYSIS_WIDTH=native` or a numeric width changes analysis size; `FFMPEG_HWACCEL=videotoolbox` requests hardware decoding; `--max-video-height 720` requests smaller future downloads. Defaults remain the existing 886-wide cropped analysis, up to 1080p downloads and 10 fps dense sampling. Result metadata records requested decoding settings and source/crop/range provenance. FFmpeg may fall back to software when hardware initialization fails.

## Verified benefit and accuracy limits

On one existing 60-second CC excerpt, sequential low-priority single-worker checks took 8.262 s with caching disabled, 8.628 s filling the cache, and 7.936 s with a warm cache. All 37 warm OCR calls hit, reducing recorded OCR from about 2.5 s to 0.1 s. Battle output and stored evidence matched after excluding generated battle IDs. Warm throughput improved about 4% versus uncached (about 9% versus cold cache). Initial cache writes cost time, and decoding still dominates. This is not an overnight or multicore speedup claim. Details: `web/tests/meta-benchmark/sources/video-speed-report.json`. These timings precede concurrent HP classifier commit a70c9ae; publication preserves that change and its wider analysis band. They are not measurements of the merged classifier.

Reducing the entire cropped image from 886 to its 560 native pixels lost an opponent and misread a move-banner actor in the same excerpt. It is therefore experimental, not the default. VideoToolbox could not initialize in the sandbox trial, so no hardware speedup is claimed. 720p downloads have not passed held-out recall checks. Do not lower temporal sampling just to get faster runs: HP trails and fast-move cadence need short events.

## How to retest without downloading

For **classifier weights / priors / pooling changes**, use existing saved physical evidence:

```sh
GAMEMASTER=/path/to/original-historical-gamemaster.json LEAGUE=1500 \
  node web/tests/meta-benchmark/refit.cjs /path/to/saved-result.json \
  /private/tmp/retested-result.json /path/to/learned.json
```

This path already skips video decoding and OCR. It is usually the largest improvement for model-only experiments. Use original held-out splits and historical game data; fresh predictions are not human labels.

For **screen/OCR/HP/aura extraction changes**, use retained sources:

```sh
python3 -I web/scripts/yt-harvest/media_cache.py \
  --download-dir "$HOME/Desktop/Projects/PoGo Recorder/src/youtube" \
  --work-dir "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest" \
  --jobs /private/tmp/retest-jobs.txt
JOBS=1 FFMPEG_THREADS=1 node web/tests/meta-benchmark/run-batch.cjs \
  /private/tmp/retest-jobs.txt /private/tmp/new-retest-output
```

Choose a new output directory each experiment: the batch runner intentionally skips existing outputs. Unknown CP context requires explicit `--default-cp`; `--verify-sha` validates sources at the cost of streaming each file. Inventory does not silently substitute a different encode for an authoritative missing/unsafe source path. Six old CC pilot recordings also remain in `PoGo Recorder/src/youtube-cc`; most harvested originals were deleted by earlier runs.

For repeated tests of existing pixel measurements, add `--use-saved-ranges --verify-sha` to the inventory command. This deliberately reuses existing padded battle windows; use `FORCE_FULL=1` or omit saved ranges when changing battle detection, screen selection or reviewing missed battles. Current source verification alone does not establish that historical probe ranges belong to the same encode; old results without media identity remain full-source.

## Next-round measurements and priority

One worker at nice 19 refitted six saved CC recordings containing 21 battles in **0.817 seconds**, or **0.865 seconds including reads, game-data loading and integrity checks** (24.3 battles/second overall). Those files recorded 1,280.5 seconds of historical extraction. This is an avoided-work comparison, not a controlled fresh extraction speedup or an accuracy evaluation. Old runs lacked learningContext; leagues were checked against saved CP and dated cached game data was used, without a current-data fallback.

On 27 historical sources with padded ranges below 80% coverage and valid recorded durations, ordinary 20-minute chunks plus overlap would sample 113,112 seconds; clipped ranges would sample 70,265 seconds: **37.9% fewer video seconds**. This is planning arithmetic, not measured runtime or battle recall. One duration/range mismatch was excluded. Most old originals are unavailable and their summaries lack source-bound media metadata, so this estimate is not an immediately executable replay batch. Newly retained sources with verified context can use the fix.

The next highest-impact extraction work is conservative no-HUD screening and negative surrender candidate handling. Zero-battle historical runs used over half of extraction time, but some missed real battles. A structural dialog gate or approximate negative cache needs short confirmed-dialog and missed-battle fixtures before becoming default. Current surrender cooldown is bypassed by the HUD branch; changing that also needs short-dialog recall checks. Classifier owners should coordinate those changes with their ongoing detector work.

Lossless proxy experiments preserved complete RGBA bytes on existing opaque H264 footage. FFV1 and Huffyuv were slower than original decoding. A 60-second UtVideo proxy took **7.702 s including source/cache verification versus 7.873 s direct** (only 2.2% faster), required **751 MB** and cost **21.118 s** to prepare with full parity validation. This is a decoder/stream comparison, not a complete classifier benchmark; the marginal gain could disappear under load variation. UtVideo also failed a synthetic nonopaque-alpha parity case. Proxies were therefore **not integrated into the runner or enabled by default**; tested prototypes remain isolated research code. Retained originals, exact OCR/probe caches and saved features provide storage reuse without that disk expansion. Measurements and aggregate evidence are recorded in `web/tests/meta-benchmark/sources/video-speed-next-report.json`.

## Highest-impact next steps

Updated after the second round: the per-frame bar work is no longer the largest cost. Decoding is: about 7 CPU-s per minute for H.264 decoding plus about 8 for the ffmpeg scale and RGBA conversion, against about 2 for bars. Item 2 (native-size HP/aura with enlarged OCR crops) is now the largest remaining lever, once the Shadow retraining allows aura measurement changes. Item 1 should target the 52 probed zero-battle runs, which have HUD hits.

1. Improve cheap screen/HUD screening and false-positive dialog detection before full passes; keep padded result/countdown windows and explicit reviewer full-pass fallback. Validate recall on footage containing short/edited battles before tightening cuts.
2. Separate spatial resolution: HP/aura can use native/smaller phone pixels, while OCR text crops are enlarged to the existing reference size. This is a classifier-owner change requiring species/CP/move/outcome parity and Shadow calibration checks. Whole-frame downscaling already failed the small trial.
3. Revisit predecoded proxies only if a new codec/storage design has a substantial measured benefit. FFV1/Huffyuv were slower, and the exact opaque UtVideo trial improved warm stream throughput only 2.2% with substantial storage/build cost. The prototypes remain outside the production runner. Keep original footage for crop/perspective changes.
4. Cache rejected surrender candidates / debounce OCR carefully: some zero-battle runs caused thousands of surrender OCR reads. Exact-pixel caching is now safe; approximate fingerprint reuse needs negative-dialog recall tests.
5. Benchmark hardware decoding on an idle machine with exact evidence comparison. FFmpeg documents that GPU→CPU transfers can erase the advantage: https://ffmpeg.org/ffmpeg.html . Spatial/time filters: https://ffmpeg.org/ffmpeg-filters.html .

Do not increase worker counts blindly while classifier jobs share the machine. Existing workers remain configured as before; no sustained saturation benchmark was run during this task.
