# YouTube sources for the Meta Extractor benchmark

`registry.json` lists candidate battle videos found by YouTube search (metadata only: nothing was downloaded to build it). Every video that is ever processed must have an entry here with its permission status.

## Fields
`id`, `url`, `title`, `channel`, `channelUrl`, `uploadDate`, `durationMin`, `license`, `creativeCommons`, `maxWidth`/`maxHeight`/`fps`, `orientation` (portrait = direct phone recording; landscape = phone screen inside a wider frame), `language`, `leagueGuess` and `kindGuess` (from the title; verify), `permission`, `status` (`candidate` → `approved` → `downloaded` → `processed` → `deleted`), `shortlist`, `pilot`, `size1080MB`, `note`.

## Rules
- **Permission first.** Use only Creative Commons videos (reuse allowed with attribution) or videos whose creator has agreed in writing; record which in `permission`. Credit the channel wherever results are shown.
- **Keep videos local.** Download outside the project folder; delete after processing unless the permission says otherwise. Fingerprint files so re-uploads are not counted twice.
- **Share only derived data.** Battles, teams, moves, results and HP/aura measurements. Validation questions for YouTube sources carry no frames (the reviewer opens the local copy), and opponent trainer names are never stored.
- **Representativeness.** Creators are mostly high-rated players: label results as a top-tier sample, cap each creator’s influence, and report the number of creators behind each statistic.

## First search (2026-10-10)
131 candidates from 35 channels (31 Creative Commons). 130 are landscape (phone screen embedded, often with a facecam), so layout normalization is required before analysis. 87 were uploaded in 2025–2026.

Shortlist: 25 videos, 16 channels, Great 8 / Ultra 8 / Master 7 / cups 2, 11 Creative Commons. Pilot: the 6 recent Creative Commons sets (KZ FAM, PokeDeeGO, AMaizad97; about 1.6 GB at 1080p).

## Asking creators (template)
> Hi [creator] — I’m building an open, on-device tool that turns Pokémon GO Battle League recordings into a meta snapshot (which teams, leads, fast moves and Shadows appear, by league and rating). Could I use your full-set uploads from [season] as part of the sample? I would process them locally, share only aggregate statistics (never your footage or anyone’s trainer names), credit your channel, and delete the videos afterwards. Happy to share the results with you. Thanks!

## Pilot download (2026-10-10)
The 6 Creative Commons pilot videos (video only, ≤1080p H.264, 2.3 GB) are in `PoGo Recorder/src/youtube-cc/` on the contributor’s machine, outside the project; `registry.json` records each file’s SHA-256 prefix, the phone-screen box found in it and its layout.

What they need that phone recordings don’t:
- **Layout.** All six are 1920×1080 with the phone as a column: left edge + facecam (KZ FAM), or centre column between a team card / branding and a facecam (AMaizad97, PokeDeeGO). `includes/meta/screen.js` finds the column from persistent vertical edges and checks each candidate by reading the HUD inside it; the crop is scaled to the 886-wide reference. The phone’s status bar is usually cropped away, which `calibrate` absorbs (dy ≈ −55 for KZ FAM).
- **Keyframes.** YouTube re-encodes with a keyframe every 6 s and as fragmented MP4, so keyframe-only sampling is too sparse; the Node runner (`SAMPLE_FPS`, automatic) and the browser (fixed 1 s steps) fall back to regular sampling.
- **Game data.** Each video is fitted with PvPoke’s game data as of its upload date (`GAMEMASTER=`).
