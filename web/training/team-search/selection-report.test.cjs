'use strict';
// The report text for the selection protocol (selection-report.cjs): what report.html and findings.md say.
const test = require('node:test'), assert = require('node:assert/strict');
const { random } = require('../utils.cjs');
const { summarize, compareFinalists } = require('./evaluation.cjs');
const { selectionLines, html, markdown, confirmationTable } = require('./selection-report.cjs');

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), pct = n => Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—';
const pool = { variants: Array.from({ length: 12 }, (_, i) => ({ speciesName: 'Mon' + i })) };
const stream = (p, n, seed) => { const r = random(seed); return Array.from({ length: n }, () => r() < p ? 1 : 0); };
const T = i => [i, 6 + i, 3 + i];

test('the safeguards paragraph says what the rule, the longer panel and the confirmation did or why nothing happened', () => {
 assert.deepEqual(selectionLines({ config: {} }), [], 'nothing to say for a run without the safeguards');
 const rule = selectionLines({ config: { minLeadFixtures: 64 }, selection: { teams: 100, teamsAtOrAboveThreshold: 40, screeningCandidates: 24, screeningCandidatesBelowThreshold: 0, fallback: false } });
 assert.match(rule[0], /needed at least 64 fixtures to lead the training ranking, to be the retest incumbent or to be screened/);assert.match(rule[0], /40 of 100 teams had reached it; 0 of the 24 screened teams were below it/);
 assert.match(selectionLines({ config: { minLeadFixtures: 64 }, selection: { teams: 9, teamsAtOrAboveThreshold: 0, fallback: true } })[0], /none had, so the ranking was left unchanged/);
 assert.match(selectionLines({ config: { minLeadFixtures: 64 } })[0], /^Minimum evidence before leading/, 'without the recorded description the rule is still named');
 const ext = (stoppedBecause, completedFixtures = 768) => selectionLines({ config: {}, finalPanel: { extension: { baseFixtures: 512, requestedMax: 1024, step: 64, completedFixtures, steps: [], stoppedBecause } } })[0];
 assert.match(ext('target-reached', 1024), /Final panel: 1024 of 1024 common fixtures \(base 512, extended in steps of 64 while time remained; target reached\)/);
 assert.match(ext('time'), /768 of 1024.*stopped when the time ran out/);assert.match(ext('stopped'), /stopped by request/);assert.match(ext('base-incomplete'), /base panel itself was not completed/);assert.match(ext('in-progress'), /interrupted/);

 const finalists = [stream(.5, 128, 1), stream(.5, 128, 2)].map((s, i) => summarize(s, { team: T(i), fixtureSeed: 9, paired: false }));
 const quiet = { config: { confirmationOpponents: 256 }, validations: finalists, finalistComparisons: compareFinalists(finalists[0], finalists.slice(1), { seed: 3, samples: 300 }) };
 assert.match(selectionLines(quiet)[0], /enabled and not needed: no challenger was clearly above the primary/);
 const strong = [stream(.3, 128, 1), stream(.9, 128, 2)].map((s, i) => summarize(s, { team: T(i), fixtureSeed: 9, paired: false }));
 const waiting = { config: { confirmationOpponents: 256 }, validations: strong, finalistComparisons: compareFinalists(strong[0], strong.slice(1), { seed: 3, samples: 300 }) };
 assert.match(selectionLines(waiting)[0], /needed for 1 challenger clearly above the primary on the final panel, but it was not recorded \(the run ended first\)/);
 assert.deepEqual(selectionLines({ config: { confirmationOpponents: 0 }, validations: strong, finalistComparisons: waiting.finalistComparisons }), [], 'a disabled test says nothing');
});

const confirmed = {
 seed: 1688725709, requestedFixtures: 256, completedFixtures: 256, complete: true, primary: T(0), finalPanelFixtures: 512, triggers: [{ stage: 'final-panel', fixtures: 512, challengers: [] }, { stage: 'extended-final-panel', fixtures: 1024, challengers: [] }],
 teams: [{ team: T(0), role: 'primary', finalScore: .8, score: .74 }, { team: T(1), role: 'challenger', kind: 'finalist', sources: ['finalist', 'previous-champion'], finalScore: .88, score: .79 }, { team: T(2), role: 'challenger', kind: 'previous-champion', sources: ['previous-champion'], finalScore: .7, score: .6, resolvedByExtension: true }],
 comparisons: [{ team: T(1), delta: -.05, simultaneous95: [-.09, -.01], verdict: 'challenger-better', confirmed: true }, { team: T(2), delta: .14, simultaneous95: [.09, .19], verdict: 'primary-better', confirmed: false }],
 outcome: 'challenger-confirmed', summary: '1 of 2 challengers scored clearly above the screening-selected primary on the new 256 sealed fixtures.', method: 'paired opponent-fixture bootstrap',
};

test('the confirmation table and its HTML and Markdown carry both scores, the band and the verdict for every team', () => {
 const rows = confirmationTable(confirmed, pool);
 assert.deepEqual(rows.map(r => r.role), ['primary', 'finalist and previous champion challenger', 'previous champion challenger (resolved only by the longer final panel)']);
 assert.deepEqual(rows.map(r => r.verdict), ['reference', 'challenger better: confirmed', 'primary better']);
 assert.deepEqual(rows[0].names, ['Mon0', 'Mon6', 'Mon3']);
 const page = html({ config: {}, confirmation: confirmed }, pool, { escape, pct });
 assert.match(page, /<h2>Sealed confirmation test<\/h2>/);assert.match(page, /Final-panel score at the trigger/);assert.match(page, /<td>74\.0%<\/td>/);assert.match(page, /<td>-5\.0 pp<\/td><td>-9\.0 to -1\.0 pp<\/td><td>challenger better: confirmed<\/td>/);
 assert.match(page, /256 of 256 sealed fixtures, seed 1688725709/);assert.match(page, /as of the trigger \(512 \/ 1024 final fixtures\)/);assert.doesNotMatch(page, /Selection safeguards/);
 const md = markdown({ config: {}, confirmation: confirmed }, pool, { pct });
 assert.match(md, /Sealed confirmation test: 1 of 2 challengers/);assert.match(md, /- Mon1 \/ Mon7 \/ Mon4 \(finalist and previous champion challenger\): final panel at the trigger 88\.0%, confirmation 79\.0%; primary minus team -5\.0 points, simultaneous 95% interval -9\.0 to -1\.0 points \(challenger better: confirmed\)/);
 // Text is escaped.
 assert.match(html({ config: {}, confirmation: { ...confirmed, summary: '<b>x</b>' } }, pool, { escape, pct }), /&lt;b&gt;x&lt;\/b&gt;/);
 // Nothing to show: nothing added.
 assert.equal(html({ config: {} }, pool, { escape, pct }), '');assert.equal(markdown({ config: {} }, pool, { pct }), '');
 // An incomplete record still lists the primary and says it was not played.
 const incomplete = { ...confirmed, outcome: 'incomplete', completedFixtures: 0, complete: false, comparisons: [], teams: [{ team: T(0), role: 'primary', finalScore: .8 }], summary: 'no time' };
 assert.match(html({ config: {}, confirmation: incomplete }, pool, { escape, pct }), /<td>Mon0 · Mon6 · Mon3<\/td><td>primary<\/td><td>80\.0%<\/td><td>—<\/td>/);
});
