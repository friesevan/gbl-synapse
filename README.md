# GBL Synapse

Tools for Pokémon GO Battle League analysis, in one codebase:

| Folder | What it is |
| --- | --- |
| `web/` | The PvP IVs site: IV rankings, PvP IV Pro, **PvPoke Pro** with Pokémon Rankings (current and historical) and **Team Rankings**, the full-team neural network (`web/includes/pro/`, `web/training/`), and the **Meta Extractor** that reads battle recordings (`web/includes/meta/`; documented in `web/includes/meta/README.md` (technical) and `README-plain.md` (plain language), both shown by the Info button on the tab). |
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

## Team Rankings (full-team neural network)

The neural network behind PvPoke Pro › Team Rankings searches for the best 3-Pokémon team against a meta. It runs locally, in Node 20 or later, from `web/`:

```bash
node training/team-search/launch-next.cjs --hours 8                # start a detached run
node training/team-search/status.cjs training/runs/team-search-v4  # progress
node training/team-search/stop.cjs training/runs/team-search-v4    # stop safely, saving results
node --test training/*.test.cjs training/next/*.test.cjs training/team-search/*.test.cjs
```

When a run finishes, open **PvPoke Pro › Team Rankings** (`familyRanks.html?app=pro&view=teams`) and import `training/runs/<run>/report.pvpteams.json.gz` to view the report. Runs stay local in `web/training/runs/`, which git ignores. The full guide is in `web/training/team-search/README.md` (technical reference and run guide) with a plain-language summary in `README-plain.md`; the Info button on the Team Rankings tab shows both. The simulator speed work is in `PERFORMANCE.md` next to them.

**Opponent meta.** Without a usage file, opponent teams are built from PvPoke's per-Pokémon default weights (`--meta hybrid`): half are drawn member by member in proportion to weight, and half are built like real teams, favouring members that cover the earlier picks' weaknesses (sometimes in an ABB shape). The main source is now the **opponent teams observed in harvested YouTube battles**. `python3 -I web/scripts/yt-harvest/usage_export.py` writes them as a usage file outside git (`~/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json`) with a quality report beside it. Its rules: Great League and Great League: Mega Edition only; complete opponent teams; human answers first; Shadow form only when confirmed; one date per team; repeated battles removed; each YouTube channel capped at 10% of the weight. They are documented at the top of the script. The file's format is `web/training/next/usage-template.json` plus an optional per-row `weight`. Pass it with `--usage-file FILE --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N`; the exporter prints the date and the N that make observed teams 75% of the opponents. With `--meta observed` they make up all of them. The reviewed-only export, **Observed meta → Export team-training data** (`observed-meta-teams.json`), loads the same way.

Full overnight run with the observed meta (from `web/`; the 2026-10-11 export gave as-of 2026-10-11 and N = 43):

```bash
mkdir -p training/runs/team-search   # one-time: same pool hash as the bundled data, or run prepare.cjs
cp ~/Desktop/Projects/PvPokeTeamTrainer/training/runs/team-search/pool.json training/runs/team-search/pool.json
python3 -I scripts/yt-harvest/usage_export.py        # refresh the usage file; note the as-of date and prior strength
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v4-observed-20261011 \
  --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" \
  --usage-half-life-days 30 --usage-as-of 2026-10-11 --usage-prior-strength 43
```

The trainer was developed separately as PvPokeTeamTrainer and merged here on 2026-10-10.

## YouTube harvest and live validation

Run `python3 web/run_app.py`, then open **Meta Extractor → Analyze & review**. The harvester panel starts/resumes and safely stops local runs, displays live progress, and adds questions as videos finish. Human feedback automatically refits the extractor’s learned priors after eight useful answers, with a separate 24-answer review goal. Priority, Type and Video modes organize review; model-resolved questions remain auditable and reversible. See [the harvester guide](web/scripts/yt-harvest/HANDOFF.md) for confidence gates, persistence and checks.

## Benchmarks

Benchmark runs need ffmpeg: `node web/tests/meta-benchmark/run-batch.cjs JOBS.txt OUTDIR` (see the header of that file).

Overnight YouTube harvest (discover → metadata + league guess → download → Meta Extractor, resumable): `bash web/scripts/yt-harvest/overnight.sh --hours 9`; see "Overnight harvest" in `web/tests/meta-benchmark/sources/README.md`.

## Data policy

Recordings (`*.mp4`, `recorder/src/`) are git-ignored and stay local. Only derived data (labels, summaries) is committed. Opponent trainer names are never read or stored. API keys live in `~/.config/freellm/env`, outside the repo.

## History

`web/` keeps the full history of [friesevan/PvP_IVs](https://github.com/friesevan/PvP_IVs) (branch `not-minified`) and `recorder/` the history of PoGoAnalyzer; both were moved into subfolders with `git mv`, so `git log --follow` works on any file.

## Live observed meta

**Meta Extractor → Observed meta** automatically reads local harvest results and reviewed browser/shared observations. Filter by league, named cup, cup period, team side and review status. Click a complete team to inspect its battle occurrences, outcomes from that team’s perspective, source video at battle start and saved HP/event graph. Partial lineups remain separate. Upload dates and estimated schedule periods are labeled; they are not verified recording dates. The local harvester does not require publishing recordings or validation labels to GitHub.

Implementation, checks and publication details: [UI and Observed meta handoff](HANDOFF-2026-10-11-OBSERVED-META.md).
