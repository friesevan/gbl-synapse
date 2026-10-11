# GBL Synapse

Tools for Pokémon GO Battle League analysis, in one codebase:

| Folder | What it is |
| --- | --- |
| `web/` | The PvP IVs site: IV rankings, PvP IV Pro, the **Full Team Neural Network** (`web/includes/pro/`, `web/training/`) and the **Meta Extractor** that reads battle recordings (`web/includes/meta/`, documented in `web/includes/meta/README.md`). |
| `web/tests/meta-benchmark/` | Node runner and batch engine for scoring the Meta Extractor on long recordings, plus labels and tuning tools. |
| `web/scripts/freellm/` | Router for free-tier vision models used to pre-label public (Creative Commons) footage. Never sent private recordings. |
| `recorder/` | PoGo Recorder: the original Python battle recorder and analyzer (OpenCV/OCR). |
| `artifact/` | The claude.ai artifact build: its page (`pvp-iv-pro.html`), shim and a manifest of the `web/` files it ships. |

## Running

```bash
cd web && python3 run_app.py        # or open START.command
node web/tests/meta-extractor.test.cjs
node artifact/build.cjs /path/to/out   # assemble the artifact for publishing
```

Benchmark runs need ffmpeg: `node web/tests/meta-benchmark/run-batch.cjs JOBS.txt OUTDIR` (see the header of that file).

## Data policy

Recordings (`*.mp4`, `recorder/src/`) are git-ignored and stay local. Only derived data (labels, summaries) is committed. Opponent trainer names are never read or stored. API keys live in `~/.config/freellm/env`, outside the repo.

## History

`web/` keeps the full history of [friesevan/PvP_IVs](https://github.com/friesevan/PvP_IVs) (branch `not-minified`) and `recorder/` the history of PoGoAnalyzer; both were moved into subfolders with `git mv`, so `git log --follow` works on any file.
