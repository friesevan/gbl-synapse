# Video analysis speed and reusable storage — 2026-10-11

The classifier processes and running app were not stopped or restarted. No model weights, human labels, live results or source videos were overwritten. New defaults apply to new harvester/analysis processes; an already-running harvester keeps its previous retention setting until its next normal start.

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

1. Improve cheap screen/HUD screening and false-positive dialog detection before full passes; keep padded result/countdown windows and explicit reviewer full-pass fallback. Validate recall on footage containing short/edited battles before tightening cuts.
2. Separate spatial resolution: HP/aura can use native/smaller phone pixels, while OCR text crops are enlarged to the existing reference size. This is a classifier-owner change requiring species/CP/move/outcome parity and Shadow calibration checks. Whole-frame downscaling already failed the small trial.
3. Revisit predecoded proxies only if a new codec/storage design has a substantial measured benefit. FFV1/Huffyuv were slower, and the exact opaque UtVideo trial improved warm stream throughput only 2.2% with substantial storage/build cost. The prototypes remain outside the production runner. Keep original footage for crop/perspective changes.
4. Cache rejected surrender candidates / debounce OCR carefully: some zero-battle runs caused thousands of surrender OCR reads. Exact-pixel caching is now safe; approximate fingerprint reuse needs negative-dialog recall tests.
5. Benchmark hardware decoding on an idle machine with exact evidence comparison. FFmpeg documents that GPU→CPU transfers can erase the advantage: https://ffmpeg.org/ffmpeg.html . Spatial/time filters: https://ffmpeg.org/ffmpeg-filters.html .

Do not increase worker counts blindly while classifier jobs share the machine. Existing workers remain configured as before; no sustained saturation benchmark was run during this task.
