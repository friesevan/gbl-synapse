# GBL Synapse UI and Observed meta handoff — 2026-10-11

## User request and publication

Clean up Meta Extractor, put the YouTube harvester in Analyze & review, and automatically show observed teams by league, named cup and cup time range. Clicking a team must show its battle occurrences, team-perspective outcomes, source video at battle start and saved battle graph. The user explicitly requested multiple agents, publication before the usage limit, and this handoff, then selected publication to the existing GitHub repository plus the local app.

Target repository: `https://github.com/friesevan/gbl-synapse`, branch `main`.
The existing repository has no GitHub Pages deployment. No new hosting account or public local service is being created. Local harvester data, videos and human labels remain outside Git.

## Implementation state

Authoritative local app repository: `/Users/evanfries/Desktop/Projects/GBL Synapse`. Earlier scratch checkouts are historical and must not overwrite newer concurrent classifier changes. Integrate new work in fresh isolated checkouts and apply only guarded source-file changes. `.claude/` and unstaged learned/registry data are unrelated and must remain untouched/uncommitted.

Assigned work: observed_backend (normalization/API/cache/tests), observed_ui (team/cup/occurrence browser and import/shared preservation), ui_cleanup (Analyze harvester, simplified panels, artifact parity), root (integration, perspective labels in saved timeline, tests, publication, handoff).

## Required integrity rules

- Human feedback overrides inferred outcome/form/Shadow/move/league; model output is not a human label.
- A team's win/loss is relative to the selected side; graph recorder side is explicitly Creator for YouTube sources.
- Incomplete teams remain visible as partial detections but do not silently count as full teams.
- Recording date and upload date are separate; ambiguous cup periods stay unassigned/estimated.
- Graphs use saved observed HP/events. Missing footage or missing graph data are explicitly labeled; do not fabricate replays.
- Stable video/battle IDs deduplicate repeated polling. Polling must preserve selected occurrence and player.
- Harvester controls remain local-only; hosted artifacts review/import data but cannot operate local processes.

## Completion checks and final status

Implementation is installed in GBL Synapse and the local app has been restarted at `http://localhost:65246/familyRanks.html?app=meta`. The harvester remains idle; no harvest/download was started during this task. Existing human feedback was preserved.

Validation: 64 Node meta tests plus 54 Python harvester tests pass (118 total), Python/Node syntax checks and `git diff --check` pass. The artifact build assembled 137 files at `/private/tmp/gbl-observed-artifact-preview`. Live browser verification showed Analyze harvester controls, three harvested battles grouped by league/cup, the Master League opponent team drilldown, its Loss, source URL starting at 1 second, and full HP graph labeled Creator: Win.

Publication: this handoff and all source/test/documentation changes are included in the requested main-branch commit. Verify the published commit using `git log -1 --oneline` and `git ls-remote origin refs/heads/main`; the final chat response supplies its commit link. `.claude/` remains excluded.

Backend: `web/scripts/yt-harvest/observed.py` reads results, latest completed refits, registry, league sidecars and human feedback; file stamps invalidate its cache. `/api/observed-meta?since=REVISION` returns a tiny unchanged response rather than repeating all HP samples. Full inference overrides legacy presentation summaries; human labels override both. Up to 5,000 result files/10,000 battle occurrences are supported, with truncation metadata.

Frontend: `observed-core.js` normalizes/group/deduplicates; `observed.js` mounts lazily in Observed meta and polls every five seconds (15 when document hidden). Same-revision polls preserve selected details/graphs; changed evidence updates them. Unknown Shadow/forms remain partial. Team grouping is unordered for unconfirmed leads and lead-sensitive when confirmed. Sources open on YouTube at the battle boundary; graphs are saved observations, not simulator reconstructions. Browser/import/shared summaries preserve bounded HP/event/source evidence.

## Remaining practical limits

Upload-lag ambiguity can leave the cup time range unassigned; a single compatible schedule period is clearly marked upload-date estimate. Weekly cup names, including Willpower Cup, come from the existing schedule. The graph may be event-only or unavailable when an old result has no HP evidence. Provisional detected observations are not automatically eligible for training export; the reviewed sample/export rules remain enforced. For much larger catalogs, add pagination/lazy per-battle graph retrieval beyond the current bounded catalog. Hosted artifacts have no local API access and continue using browser/shared/imported observations. Existing shared-store subscription caps and lack of a YouTube Data API key remain as documented in `web/scripts/yt-harvest/HANDOFF.md`.

## Saved local validation analyses follow-up

Observed meta now reads `MetaValidation.observations()` as well as manually saved reports and harvested results. It applies saved human answers to battle summaries and preserved HP/event graphs, subscribes to local/shared answer changes, and stores recording context plus original battle ID for future analyses. Older summaries with no league/date retain unknown provenance and remain visible under All leagues; no date/cup is invented. Validation-only questions without a saved battle summary remain in Validate → Answered and cannot provide a complete battle graph by themselves. Browser storage keys: `pvp-meta-validation-v1` (questions/answers/analyses), `pvp-meta-records-v1` (reviewed reports). Harvester files: external `PoGo Recorder/src/yt-harvest/results`, `feedback.json`, `labels`. Browser storage is scoped to origin; use the same localhost port or export/import when moving origins. Follow-up Node suite: 65 tests pass.

Recovered legacy local v23 results (hour, hour-gl, 10min; 43 battles) from previous-session scratch into persistent external results. Deduplicated historic answer snapshots by latest answeredAt into per-recording labels/verified; current feedback overrides recovered labels. League metadata comes from committed benchmark labels and retains evidence. Raw recovered data remains local and outside Git.

## Standard YouTube preview follow-up

At the user’s request, Validate now uses `https://www.youtube.com/embed/` instead of the privacy-enhanced `youtube-nocookie.com` host. Existing start timestamps, stable player reuse, IFrame API controls and strict-origin-when-cross-origin referrer policy are preserved. This permits standard YouTube embed behavior but does not guarantee removal of YouTube’s bot-check prompt; no embedded Google sign-in or credential collection was added.

The additional six recovered YouTube benchmark results contain 43 battles, bringing the local catalog to 89 total (86 recovered plus three original harvested battles). Historic answers remain applied through external per-recording labels.

## Browser-specific YouTube bot-check follow-up

The user still sees YouTube’s sign-in/bot prompt in their local browser despite standard embeds. The prior playback check was specific to the Codex browser and did not establish a fix for the user’s browser. Added a Playback selector above the video: Embedded player or YouTube tab. The preference is persisted in the existing validation store. YouTube tab mode destroys the iframe and supplies a normal watch-page link at the current question timestamp, while answers and question navigation remain in the app. It does not automatically open tabs or submit answers. Local recording selection and browser-cookie guidance are directly accessible beside the selector. No downloading, cookie harvesting, sign-in automation or browser privacy-setting changes were introduced.

Validation: 13 validation UI tests pass, including fallback persistence, question continuity, timestamp advancement after answering, polling and switching back to embedded playback. Live UI verified the same question and timestamp after selecting YouTube tab. Source of cookie guidance: https://support.google.com/chrome/answer/95647. Top-level YouTube can still request its own sign-in; the app does not bypass that.

## Video analysis speed / retention follow-up

See `VIDEO-ANALYSIS-PERFORMANCE.md` and committed aggregate `web/tests/meta-benchmark/sources/video-speed-report.json`. Sources are kept by default on new harvester starts, with explicit --discard-videos opt-out; no existing processes were restarted or interrupted. Added raw OCR cache keyed by exact pixels/tool/traineddata, persisted screen/range probe cache keyed by source identity/code/settings, offline media inventory/jobs, corrected total OCR metrics, and optional width/hardware/720p experiments. Classifier modules, learned.json, registry.json, human feedback and live result datasets were not changed by this work. Existing unstaged model/registry changes remain excluded from publication. Native-size full-frame reduction lost detections and remains opt-in. Warm-cache 60-second excerpt: 8.262 s uncached / 8.628 s cold / 7.936 s warm; battle and evidence parity excludes random IDs. No proxy implementation or sustained multicore speedup is claimed. Current retained-main inventory has zero available sources and 454 missing, with six older CC pilots available separately. Past deletions cannot be undone by this feature.

Focused verification: 49 Node tests (extractor, exact OCR cache, decode plans) and 58 Python tests (harvester, inventory, probe cache), 107 total, all pass. Node syntax and git diff checks pass. Worker source SHA claim and successful extraction → validation export → retained media are covered. Publication includes source/tests/docs only; live classifier data stays unstaged. No app restart is required for static files or newly spawned analyses; retention defaults apply at the next normal harvester start.

Publication integration: Concurrent remote commit a70c9ae improves HP detection and widens Hp.BAND. Its classifier/UI/test/documentation changes were preserved. The only runner conflict was resolved by combining the decode plan with the new Hp.BAND-derived analysis band. Merge occurred in an isolated checkout before a fast-forward of the local app; no dirty classifier datasets were stashed or overwritten. The reported excerpt timings predate this HP change and are historical, not timings of the merged classifier.

Merged verification: 50 Node + 58 Python focused tests, 108 total, pass with the concurrent HP classifier changes included.

## Video speed next round: range-aware offline retests

Three agents investigated safe range planning, lossless frame proxies and saved-feature refitting. Work integrated in `/private/tmp/gbl-video-next-integration`, based on published c03e78b. No existing app/harvester/classifier process was stopped, restarted or reconfigured, and no media was downloaded. No learned weights, labels, registry or live results were edited. Benchmarks ran sequentially at nice 19 with one worker/thread; only agent-owned benchmark subprocesses were managed.

Implemented optional fifth JSON range column in offline batch jobs. Absolute source ranges are merged and clipped to chunk START/END including six-minute overlap. Empty tasks write empty mergeable outputs without spawning analysis; missing plans stay full. Inherited RANGES are clipped instead of repeated in every chunk. FORCE_FULL=1 always wins. Standalone extraction clips ranges too and rejects empty intersections. Batch sampled throughput and merged videoSeconds now reflect actual decoded work, with source duration and chunk metrics kept separately.

Inventory `--use-saved-ranges` requires `--verify-sha`; original result.media.sha256 must match the verified current file in addition to the state hash. Unknown/legacy/unbound/corrupt/full-source context stays full. Resuming an old extraction no longer replaces its media source/crop/ranges with the current process defaults or a replacement download. Legacy extract callers without a source hash work conservatively. Existing service test mocks were updated for the probe source-hash keyword.

Measurements: 21 saved battles from six CC runs refit in 0.817 s (0.865 s with reads/GM/integrity checks, 24.3 battles/s overall). Recorded old extraction totaled 1,280.5 s; this quantifies avoided work, not a controlled fresh pipeline speedup. Planning across 27 saved ranged sources: 113,112 → 70,265 sampled seconds (37.9% reduction), not measured runtime/recall. Their old unbound summaries are not automatically enabled. Aggregate evidence: `web/tests/meta-benchmark/sources/video-speed-next-report.json`; operational details: `VIDEO-ANALYSIS-PERFORMANCE.md`.

Verification: 63 Node tests covering extractor/cache/decode/range plans and fake-process batch integration, plus all 92 Python harvester/service/inventory/probe tests pass (155 total). Existing ResourceWarnings come from old test fixtures; no failure remains. Range integration handles explicit empty plans, per-video override, overlapping chunks, original timestamps, reviewer full-pass (even with malformed ambient range plans) and malformed-input failure before classifiers start. Reviewer reprocess clears inherited START/END/RANGES and forces whole-source analysis. Original model/registry dirty files must remain excluded from the commit.

Next priority: conservative cheap screening and false surrender-candidate gates with confirmed short-dialog/missed-battle fixtures, coordinated with the active classifier owners. Whole-frame downscaling remains experimental after lost detections. Do not enable a proxy cache just because it is lossless: decompression, hash validation, initial construction and larger disk footprints can exceed original H264 decoding cost.

Proxy decision: experimental modules/tests remain only in `/private/tmp/gbl-video-next-proxy`; do not copy them into production as an approved optimization. FFV1/Huffyuv were slower; UtVideo 60 s warm total 7.702 s versus 7.873 s direct (~2.2%), cold preparation 21.118 s, cache 751 MB. Full opaque RGBA bytes matched; synthetic nonopaque alpha failed with UtVideo. Five prototype tests passed, but no proxy integration is shipped. Aggregate measurements are committed, with the explicit rejected-default decision and limits.

## Observed teams as the Full Team Neural Network's meta

This change feeds the opponent teams from the harvested YouTube battles into the trainer as its main opponent meta, in place of PvPoke's per-Pokémon weights, which was the project's original purpose.

- **Exporter:** `web/scripts/yt-harvest/usage_export.py` builds on `observed.py`, so human answers override detections. Its eligibility rules are in the module docstring and tested in `test_usage_export.py`:
  - open Great League and Great League: Mega Edition only;
  - no Team Rocket, championship, no-footage or obscured videos;
  - complete opponent teams only; Shadow form only when confirmed;
  - members mapped to the pool's speciesIds;
  - dated by recording date, else upload date;
  - split and re-uploaded battles removed;
  - each channel capped at 10% of the weight.

  The output goes outside git to `~/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json`, with `.report.md` and `.report.json` beside it.
- **Trainer:** `meta.cjs` accepts an optional per-row `weight` in (0, 1]. It records distinct teams, creators and the date range in the run's meta. `report.html` and the site's Full Team Neural Network report show a line like "Opponent meta: 75% observed teams, 25% PvPoke prior · 190 teams (181 distinct) from 18 creators · dates".
- **First export (2026-10-11):**
  - 1,585 battles in the catalog, 965 of them at 1,500 CP.
  - 190 eligible opponent teams (181 distinct) from 46 videos by 18 creators, dated 2026-09-20 to 2026-10-11.
  - Exclusions among the 1,500 CP battles:
    - restricted cups: 501
    - partial teams: 166
    - unmapped members: 62 (mostly Megas)
    - boundary flags: 21
    - mid-battle start: 8
    - no date: 16 (the owner's legacy recordings)
    - duplicates: 1
  - Exclusions across all battles: other leagues 602, Team Rocket 14, championship 4.
  - Species observed more often than PvPoke predicts include Marowak, Quagsire, Charjabug, Ninetales and Sableye. Their Shadow forms are under-counted because 43% of members have an unknown Shadow status and are mapped to the base form.
- **Smoke run:** two workers under `nice`, about one minute, in `web/training/runs/observed-meta-smoke-20261011` (git-ignored). The file loaded, the observed share was 0.749, 12 of 24 final fixtures and 12 of 16 screening fixtures were observed teams, and 75% of the 2,048 belief-prior teams matched observed teams. The report shows the source.
- **Full overnight run (not started):** run it from `web/`. Copy the prepared pool once (the PvPokeTeamTrainer pool has the same input hash), then refresh the export and use the as-of date and prior strength it prints:

```bash
mkdir -p training/runs/team-search
cp ~/Desktop/Projects/PvPokeTeamTrainer/training/runs/team-search/pool.json training/runs/team-search/pool.json
python3 -I scripts/yt-harvest/usage_export.py
node training/team-search/launch-next.cjs --hours 8 --out training/runs/team-search-v4-observed-20261011 \
  --usage-file "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/usage/observed-gl-opponents.json" \
  --usage-half-life-days 30 --usage-as-of 2026-10-11 --usage-prior-strength 43
```

## Observed meta hierarchy, schedule check and unidentified lineups (2026-10-12)

Observed meta is now League › Cup › Period with multi-select period chips grouped by GBL season, a per-battle schedule check (confirmed / estimated / unassigned, contradictions flagged), per-member reasons and Validate links for unidentified lineups, provisional (Shadow-unknown) teams, Pokémon usage with PvPoke comparison, pairings and per-period sparklines. Details and the real-data counts are in `web/scripts/yt-harvest/HANDOFF.md` ("Observed meta browser"). `/api/observed-meta` gained `schedule`, `pvpoke` and `summary.periodStatus`; the `since` short-circuit is unchanged. The backend change needs a restart of `run_app.py` to take effect; the browser files apply on reload.
