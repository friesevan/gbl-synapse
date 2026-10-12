# Autonomous tasks

Worked through by the claude-usage-router autonomous runner on branch `claude-autonomous` (never pushed;
the owner reviews and merges). One task per line. `- [ ]` runs next; `[x]` done; `[!]` failed; `[?]` proposed,
not run until a person changes it to `[ ]`. Optional tag `(class: feature|refactor|tests|docs|edit|mechanical)`.

Rules for every task: read `web/CLAUDE.md` first; run `npm test` (node + Python suites) before committing and
keep it green; never commit data from `~/Desktop/Projects/PoGo Recorder/` or anything under `web/training/runs/`
or `web/tests/meta-benchmark/results/`; never change aura/HP measurement values (`web/includes/meta/aura.js`,
`hp.js`) or the Shadow classifier features without a held-out evaluation in the commit message; keep
`artifact/pvp-iv-pro.html` and `artifact/manifest.txt` in parity with `web/familyRanks.html`; no new
dependencies; no redesigns. Anything that changes product behaviour the owner hasn't asked for goes in as
`[?]` with a one-line rationale instead of being done.

## Accuracy
- [ ] Rename the Team Rocket confirmation question kind from `league` to `rocket` (validate.py, feedback.py side effects, validation.js wording/filters, metrics_history.py counts) with a migration so existing stored questions keep working; add tests (class: refactor)
- [ ] Effectiveness text ("SUPER EFFECTIVE" / "NOT VERY EFFECTIVE") on YouTube crops is rarely read because it needs an HP bar found beneath it: measure on saved results how often `effectReads` is 0 for battles with ≥20 hits, then make the effect-text search independent of the bar when the nameplate side is known; parity.cjs on relabel videos must show only added effect reads (class: feature)
- [ ] CP OCR: 91 battles have no league because the CP read was truncated ("149" for "1490"); add a second read at 2× scale when the digits are fewer than 3 or the value is below 400 for a non-Little-Cup video, with a test on synthetic crops (class: feature)
- [ ] Form questions: when the type icons are unreadable but the creator's team card (overlay layouts) names the form, use it as evidence for the creator's side only; tests with a synthetic overlay (class: feature)
- [ ] Timeline results: add the timer-expiry rule (read the battle clock when the HUD is present; at 0:00 with both sides alive the higher remaining HP% wins) behind the same promotion gate as the other uncertain rules; document precision on the owner's answers (class: feature)

## Speed
- [ ] Add `bench-workers.cjs` results on an idle machine to VIDEO-ANALYSIS-PERFORMANCE.md and set the default extractor worker count from the measurement (currently cores×2/3); do not change workers if the measurement is within 5% (class: tests)
- [ ] Observed meta API: paginate `/api/observed-meta` occurrences (keep `since` short-circuit) and lazy-load per-battle HP graphs so a 5,000-battle catalog returns in under 300 ms; tests for the cache and paging (class: feature)
- [ ] Validate: the questions list re-renders every poll; diff by revision so only changed cards update, and keep the player and scroll position stable; add a UI test (class: refactor)

## UX/UI
- [ ] Team Rankings report: show "Opponent meta" source line with the observed share, team count, creators and date range at the top of the report, and link to Observed meta (class: edit)
- [ ] Validate › Model performance: add a per-rule results table (fade / tie / mid-start / unread / both-alive) with right/total and gate progress, in both themes (class: edit)
- [ ] Observed meta: the "Unknown cup" entry should show the schedule hint distribution ("schedule ran: Mega Color Cup ×120, …") so the owner can see what text-free videos probably were (class: edit)
- [ ] Phone width: audit every Meta Extractor view at 375 px for horizontal scroll and overflowing tables; fix with the existing table-scroll wrapper (class: edit)
- [ ] Docs: consolidate the three handoff files (web/scripts/yt-harvest/HANDOFF.md, HANDOFF-2026-10-11-OBSERVED-META.md, VIDEO-ANALYSIS-PERFORMANCE.md) into one dated status section each plus a short index in README.md; keep all facts, drop duplicates (class: docs)

## Proposed (need the owner's go-ahead)
- [?] Decode at native resolution for small sources (changes measured values; needs the Shadow classifier re-evaluated) (class: feature)
- [?] Merge "Analyze & review" and "Observed meta" into one Meta Extractor page with a side navigation (class: feature)
- [?] Auto-answer "lead" questions from the first nameplate seen after the VS screen when the battle was seen from its start (would remove ~450 questions; needs a precision check vs the 39 lead answers) (class: feature)
