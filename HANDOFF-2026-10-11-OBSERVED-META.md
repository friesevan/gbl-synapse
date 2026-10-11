# GBL Synapse UI and Observed meta handoff — 2026-10-11

## User request and publication

Clean up Meta Extractor, put the YouTube harvester in Analyze & review, and automatically show observed teams by league, named cup and cup time range. Clicking a team must show its battle occurrences, team-perspective outcomes, source video at battle start and saved battle graph. The user explicitly requested multiple agents, publication before the usage limit, and this handoff, then selected publication to the existing GitHub repository plus the local app.

Target repository: `https://github.com/friesevan/gbl-synapse`, branch `main`.
The existing repository has no GitHub Pages deployment. No new hosting account or public local service is being created. Local harvester data, videos and human labels remain outside Git.

## Implementation state

Work is being integrated in `/private/tmp/gbl-synapse-harvester-work` before applying to `/Users/evanfries/Desktop/Projects/GBL Synapse` with original-file hash checks. Prior harvester/feedback changes from this conversation are included in the requested publication. `.claude/` is unrelated and must remain untouched/uncommitted.

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
