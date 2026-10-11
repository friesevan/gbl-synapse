# YouTube sources for the Meta Extractor benchmark

`registry.json` lists candidate battle videos found by YouTube search (metadata only: nothing was downloaded to build it). Every video that is ever processed must have an entry here with its permission status.

## Fields
`id`, `url`, `title`, `channel`, `channelUrl`, `uploadDate`, `durationMin`, `license`, `creativeCommons`, `maxWidth`/`maxHeight`/`fps`, `orientation` (portrait = direct phone recording; landscape = phone screen inside a wider frame), `language`, `leagueGuess` and `kindGuess` (from the title; verify), `permission`, `status` (`candidate` → `approved` → `downloaded` → `processed` → `deleted`), `shortlist`, `pilot`, `size1080MB`, `note`.

New harvester fields: `leagueId` (format key from `scripts/yt-harvest/data/gbl-schedule.json`; `cup@cp` for a cup run at another CP), `leagueConfidence` (0–1), `leagueEvidence`, `cupCandidates` (formats on the GBL schedule around the upload date), `relevance`, `harvested`, `deletedDate`. `kindGuess` is now `set/gameplay`, `compilation` (several leagues or a highlights edit: infer the league per battle), `tournament` or `guide/talk`.

## Rules
**2026-10-11: the owner lifted the CC-only download rule for private analysis.** Every plausible Pokémon GO battle video may be downloaded and analysed privately (analysis and training, not content or money). `scripts/yt-harvest/policy.py` `download_allowed()` is the single check; `--cc-only` restores the old rule.

What remains:
- **Record permission anyway.** Every entry keeps `license`, `creativeCommons` and `permission`, so anything published can first be filtered to Creative Commons or consenting creators (use the template below) and credited.
- **Keep videos local.** Download outside the project folder; videos are deleted after processing unless `--keep`. Fingerprint files (SHA-256 prefix) so re-uploads are not counted twice.
- **Never to free-tier APIs.** Non-CC videos and their frames never go to `freellm`; only CC HUD crops may (see `web/CLAUDE.md`).
- **Polite client.** No account cookies, CAPTCHA bypassing or proxy rotation; back off on 429 / "confirm you're not a bot" and resume later.
- **Share only derived data.** Battles, teams, moves, results and HP/aura measurements. Validation questions for YouTube sources carry no frames (the reviewer opens the local copy), and opponent trainer names are never stored.
- **Representativeness.** Creators are mostly high-rated players: label results as a top-tier sample, cap each creator’s influence, and report the number of creators behind each statistic.

## First search (2026-10-10)
131 candidates from 35 channels (31 Creative Commons). 130 are landscape (phone screen embedded, often with a facecam), so layout normalization is required before analysis. 87 were uploaded in 2025–2026.

Shortlist: 25 videos, 16 channels, Great 8 / Ultra 8 / Master 7 / cups 2, 11 Creative Commons. Pilot: the 6 recent Creative Commons sets (KZ FAM, PokeDeeGO, AMaizad97; about 1.6 GB at 1080p).

## Asking creators (template, before publishing results from non-CC videos)
> Hi [creator] — I’m building an open, on-device tool that turns Pokémon GO Battle League recordings into a meta snapshot (which teams, leads, fast moves and Shadows appear, by league and rating). Could I use your full-set uploads from [season] as part of the sample? I would process them locally, share only aggregate statistics (never your footage or anyone’s trainer names), credit your channel, and delete the videos afterwards. Happy to share the results with you. Thanks!

## Pilot download (2026-10-10)
The 6 Creative Commons pilot videos (video only, ≤1080p H.264, 2.3 GB) are in `PoGo Recorder/src/youtube-cc/` on the contributor’s machine, outside the project; `registry.json` records each file’s SHA-256 prefix, the phone-screen box found in it and its layout.

What they need that phone recordings don’t:
- **Layout.** All six are 1920×1080 with the phone as a column: left edge + facecam (KZ FAM), or centre column between a team card / branding and a facecam (AMaizad97, PokeDeeGO). `includes/meta/screen.js` finds the column from persistent vertical edges and checks each candidate by reading the HUD inside it; the crop is scaled to the 886-wide reference. The phone’s status bar is usually cropped away, which `calibrate` absorbs (dy ≈ −55 for KZ FAM).
- **Keyframes.** YouTube re-encodes with a keyframe every 6 s and as fragmented MP4, so keyframe-only sampling is too sparse; the Node runner (`SAMPLE_FPS`, automatic) and the browser (fixed 1 s steps) fall back to regular sampling.
- **Game data.** Each video is fitted with PvPoke’s game data as of its upload date (`GAMEMASTER=`).

## Overnight harvest (`web/scripts/yt-harvest/`)
```bash
bash web/scripts/yt-harvest/overnight.sh --hours 9          # one command, unattended
python3 -I web/scripts/yt-harvest/test_yt_harvest.py       # unit tests
```
It creates `~/.cache/gbl-synapse/venv` and installs/updates yt-dlp there, keeps the Mac awake (`caffeinate -i`), and runs four stages at once until the deadline:
1. **Discover**: date-sorted YouTube searches (leagues, every cup in the schedule, seasons, years, 8 languages), then the uploads of every channel that produced a battle video, then relevance-sorted searches. Flat extraction only. Shorts and unrelated titles are dropped by `policy.relevance()`.
2. **Metadata**: newest first. With a YouTube Data API key (see below), 50 videos per request; otherwise yt-dlp through the web player, capped at 20/min. Videos whose title already looks like a battle video skip this stage: their metadata comes with the download request, so each downloaded video costs YouTube one player request, not two. `league.guess_league()` combines the GBL schedule (`data/gbl-schedule.json`: seasons, every rotation since 2020 and PvPoke cup rules, with a source URL per entry) for the upload date and the 14 days before it with keywords in the title, tags, description and chapters.
3. **Download**: videos that pass `policy.download_allowed()` (or, before metadata, battle-like titles; the download is skipped if the full metadata says no), newest first by upload date or the approximate date in channel listings, ≤1080p H.264 video only. Each file gets a SHA-256 prefix, and duplicates and same-channel re-uploads are dropped. Downloading stops at `--disk-budget-gb` (default 150) or `--min-free-gb` (30).
4. **Extract**: a pool of `run-node.cjs` processes, one video each (default: half the cores). A finished worker takes the next video at once, so long videos don't hold up short ones. Measured alone: 5–8× real time per worker. Running it alongside a neural-network training run slows it about tenfold (0.7× in the first smoke run). League CP comes from the guess, and GAMEMASTER is PvPoke's file as of the upload date (cached in `~/.cache/gbl-synapse/gamemaster`). Then `<id>.leagues.json` records the per-battle league from observed CPs and species (`league.refine_battle_league`). Then every open question is written for the **Validate** tab (next section), and the video is deleted unless `--keep` is given.

### Validate questions from harvested videos
Every decision the pipeline couldn't settle becomes a question in Meta Extractor › Validate:
- **Extractor questions** (fast move, Shadow, regional form, unread result), from `export-questions.cjs` with `NO_FRAMES=1`.
- **League/cup** (`validate.py`): asked once per video when the per-battle CP and eligibility check leaves close candidates and the title/schedule guess is below 90%; asked per battle for compilations or when battles disagree.
- **No battles found**: the screen wasn't located or the video has no battle footage.

Questions go to `PoGo Recorder/src/yt-harvest/validation/<id>/` and are collected into `web/tests/meta-benchmark/results/validation-inbox.json` (git-ignored). When the site runs locally (`python3 web/run_app.py`), the Validate tab uses the live local API, checking every four seconds while harvesting/refitting and every 15 seconds when idle. Human answers persist in the work directory, with a browser retry journal. On claude.ai, use **Import questions…** with the same file to add them to the shared store.

The videos are deleted after analysis, so each question carries its YouTube id: with no local copy, the tab plays the question's moment in an embedded YouTube player (**Restart** returns to it), with a link to open YouTube at that time. If an artifact host blocks the embed, the link still works. **Download answers** saves all answers (with the question, video and clip) as JSON.

### YouTube Data API key (optional, recommended)
Without a key, metadata uses the same web-player requests that trigger "Sign in to confirm you're not a bot". With one, metadata uses the Data API (`videos.list`, 1 quota unit per 50 videos; the free 10,000 units/day covers about 500,000 videos), and web requests are left for downloads. To set it up, create a project in Google Cloud Console, enable YouTube Data API v3, create an API key, and put `YOUTUBE_API_KEY=...` in `~/.config/gbl-synapse/env`. The harvester never logs or stores it. When the quota runs out, metadata pauses (downloads continue) unless `--web-meta-when-quota-out` is given.

The script is a polite client: on a 429 or a "confirm you're not a bot" response, all workers pause (starting at 60 s, doubling up to 30 min) and then carry on.

- **Outputs** (outside git): videos go to `~/Desktop/Projects/PoGo Recorder/src/youtube/`. Everything else is in `~/Desktop/Projects/PoGo Recorder/src/yt-harvest/`: `harvest.log`, `summary.json` (counts by league guess, year and licence, GB downloaded, error counts, rates), `state.sqlite`, `results/` (extractor JSON), `extract.log`. `registry.json` is rewritten every 30 min, sorted by id and holding metadata only. Commit it afterwards.
- **Progress**: `tail -f ~/Desktop/Projects/PoGo\ Recorder/src/yt-harvest/harvest.log`. For the latest summary, run `python3 -I web/scripts/yt-harvest/harvest.py status`.
- **Stop safely**: press Ctrl-C, or run `touch ~/Desktop/Projects/PoGo\ Recorder/src/yt-harvest/STOP`. State and registry are saved on the way out.
- **Resume**: run the same command again. Finished work is never fetched again. Interrupted metadata, download and extraction work goes back on the queue. Date-sorted searches repeat after 12 h, channels after 24 h, and relevance searches after 7 days.
- **Useful flags**:
  - `--no-extract`: download only.
  - `--cc-only`: the old rule (CC licence or written permission only).
  - `--max-downloads 0`: metadata only.
  - `--enrich-workers`
  - `--download-workers`
  - `--extract-jobs`
  - `--download-dir`
  - `--work-dir`
- **Per-battle league after analysis**: `python3 -I web/scripts/yt-harvest/league.py refine '{"cps":[1500,1498],"species":["medicham","azumarill"]}' 2025-01-10` returns the formats that survive the CP-cap and cup-eligibility checks, ranked.

### Live controls, queue order and refitting

The local Validate panel supports start/resume, graceful stop, live jobs/errors, Priority/Type/Video question modes, and durable feedback. Eight new useful answers trigger a prior refit; 24 diverse confirmations is the initial review goal. Corrections and league changes trigger earlier updates. Saved uncertain detections are re-scored without decoding footage. Conservative evidence and held-out calibration gates may move them into a reversible model-resolution audit; model outputs never become training labels. See [`scripts/yt-harvest/HANDOFF.md`](../../../scripts/yt-harvest/HANDOFF.md) for the exact gates and local/hosted differences.
