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
2. **Metadata**: full yt-dlp metadata, newest first, 8 workers. `league.guess_league()` combines the GBL schedule (`data/gbl-schedule.json`: seasons, every rotation since 2020 and PvPoke cup rules, with a source URL per entry) for the upload date and the 14 days before it with keywords in the title, tags, description and chapters.
3. **Download**: videos that pass `policy.download_allowed()`, newest first, ≤1080p H.264 video only. Each file gets a SHA-256 prefix, and duplicates and same-channel re-uploads are dropped. Downloading stops at `--disk-budget-gb` (default 150) or `--min-free-gb` (30).
4. **Extract**: `run-batch.cjs` on the downloaded videos. League CP comes from the guess, and GAMEMASTER is PvPoke's file as of the upload date (cached in `~/.cache/gbl-synapse/gamemaster`). Then `<id>.leagues.json` records the per-battle league from observed CPs and species (`league.refine_battle_league`). The video is deleted unless `--keep` is given.

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
