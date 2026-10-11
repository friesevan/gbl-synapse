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
1. **Discover**: date-sorted YouTube searches (leagues, every cup in the schedule, seasons, years, 8 languages), then the uploads of every channel that produced a battle video, then relevance-sorted searches. Flat extraction only. Shorts and unrelated titles are dropped by `policy.relevance()`. Learned from reviewer footage answers, it also vetoes Greek basketball ("STOIXIMAN GBL") and the separate Pokémon Champions game. Max battles, raids, Community Day, events, tips and similar titles are vetoed unless the title has a PvP marker.
2. **Metadata**: newest first. With a YouTube Data API key (see below), 50 videos per request; otherwise yt-dlp through the web player, capped at 20/min. Videos whose title already looks like a battle video skip this stage: their metadata comes with the download request, so each downloaded video costs YouTube one player request, not two. `league.guess_league()` combines the GBL schedule (`data/gbl-schedule.json`: seasons, every rotation since 2020 and PvPoke cup rules, with a source URL per entry) for the upload date and the 14 days before it with keywords in the title, tags, description and chapters.
3. **Download**: videos that pass `policy.download_allowed()` (or, before metadata, battle-like titles; the download is skipped if the full metadata says no), newest first by upload date or the approximate date in channel listings, ≤1080p H.264 video only. Each file gets a SHA-256 prefix, and duplicates and same-channel re-uploads are dropped. Downloading stops at `--disk-budget-gb` (default 150) or `--min-free-gb` (30).
4. **Extract**: a pool of extraction workers, one video each (default: two thirds of the cores, ffmpeg decoding single-threaded via `--ffmpeg-threads 1`). A finished worker takes the next video at once. First, `probe.cjs` decodes only the keyframes, locates the phone screen and tests each keyframe for the battle HUD. Then:
   - no HUD: the full pass is skipped;
   - HUD in under 80 % of the video: `run-node.cjs` decodes only the padded battle ranges (`RANGES`);
   - otherwise: the whole video.
   League CP comes from the guess, and GAMEMASTER is PvPoke's file as of the upload date (cached in `~/.cache/gbl-synapse/gamemaster`). `<id>.leagues.json` records the per-battle league from observed CPs and species (`league.refine_battle_league`), Team Rocket flags and the championship format. Every open question is written for the **Validate** tab (next section), and the video is deleted unless `--keep` is given (also after failures, skips and duplicates).

   **Disk.** Downloads pause while more than `--max-backlog-hours` (2) of extraction work is queued, as well as at the disk budget. At startup the download dir is cleaned: files the state DB marks processed, deleted, duplicate or partial, and `<id>.<ext>` files it doesn't know, are removed and logged. Other files are left alone.

   **Measured (2026-10-11, while the 6-worker harvester was running, so wall times are slow).**
   - Probe cost: 1–3 % of a full pass, e.g. 16–24 s for a 70–99-minute stream.
   - On the 109 queued videos (51 h): 30 have no HUD (skipped), 14 are decoded in ranges and 65 in full. The full pass decodes 65 % of the footage, about 1.5x fewer extraction worker-hours.
   - Same battles as the full pass, faster:
     - WE2BYyJyn4o: 32 s instead of 357 s (0 battles).
     - DxiBdcqzQME: 681 s instead of 862 s.
     - u3bK2DIXDSM (99 min): 771 s instead of 1629 s, 2.1x (the same 4 battles plus one 0-second fragment).
   - INMpMrmY7GI: the probe located the screen where the full pass's CROP=auto failed (1 battle instead of 0).
   - Labelled benchmark with probe + `--ffmpeg-threads 1`: 10min, 1p_u7XyvWwU, 2xvzDbWx-RE, cyu1yFuGtZA and Mv4o3HC29iU all have 100 % of battles found and 100 % opponent-species recall and precision.
   - Decoder threads, CPU-seconds per video-second: 0.477 with 1 thread, 0.492 with 2, 0.510 with auto. Battles are identical.

### Validate questions from harvested videos
Every decision the pipeline couldn't settle becomes a question in Meta Extractor › Validate:
- **Extractor questions** (fast move, Shadow, regional form, unread result), from `export-questions.cjs` with `NO_FRAMES=1`.
- **League/cup** (`validate.py`): asked once per video when the per-battle CP and eligibility check leaves close candidates and the title/schedule guess is below 90%; asked per battle for compilations or when battles disagree.
- **No battles found**: the screen wasn't located or the video has no battle footage. The detail says whether the keyframe probe saw a battle HUD.
- **Team Rocket battle?** Asked when opponent CPs exceed what a player's Pokémon can reach, or the cap the creator's team fits. Rocket battles train the extractor but never count in the observed meta. Every league question also offers "Team Rocket battle".
- **Championship perspective**: asked for championship or tournament footage. Strong title or channel words (regional/world championship, NAIC/EUIC/LAIC, top cut, Play! Pokémon) set the separate "Championship" format; weak words or two phone screens only ask. Left/right re-analyses that phone; "not a championship" keeps GBL.
- **Opponent lead**: up to two per video, for complete teams; a confirmed lead marks the team's lead in observed meta.
- Footage answer **obscured**: the video is labelled and never requeued.

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
  - `--no-probe` (always analyse whole videos), `--ffmpeg-threads N` (0 = auto), `--max-backlog-hours H` (0 = disk budget only)
- **Per-battle league after analysis**: `python3 -I web/scripts/yt-harvest/league.py refine '{"cps":[1500,1498],"species":["medicham","azumarill"]}' 2025-01-10` returns the formats that survive the CP-cap and cup-eligibility checks, ranked.

### Live controls, queue order and refitting

The local Validate panel supports start/resume, graceful stop, live jobs/errors, Priority/Type/Video question modes, and durable feedback. Eight new useful answers trigger a prior refit; 24 diverse confirmations is the initial review goal. Corrections and league changes trigger earlier updates. Saved uncertain detections are re-scored without decoding footage. Conservative evidence and held-out calibration gates may move them into a reversible model-resolution audit; model outputs never become training labels. See [`scripts/yt-harvest/HANDOFF.md`](../../../scripts/yt-harvest/HANDOFF.md) for the exact gates and local/hosted differences.
