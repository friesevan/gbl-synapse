'use strict';
// The sealed confirmation test and the longer final panel (confirmation.cjs) on synthetic validations and a fake
// panel evaluator: trigger logic, seed guarding, evidence bookkeeping, late challengers, deadline-cut prefixes and
// extension bookkeeping. The real search loop (resume, reports) is in search-selection.test.cjs.
const test = require('node:test'), assert = require('node:assert/strict');
const { random } = require('../utils.cjs');
const { teamKey, screeningSeed, guardedSeed } = require('./common.cjs');
const { summarize } = require('./evaluation.cjs');
const C = require('./confirmation.cjs');
const { absorb } = require('./absorb-evaluation.cjs');
const { trainingBudget } = require('./budget.cjs');

const T = i => [i, 10 + i, 20 + i];
const fixturesFor = (n, seed) => Array.from({ length: n }, (_, i) => ({ team: [{ speciesId: 'a' + (i % 7) }, { speciesId: 'b' + (i % 5) }, { speciesId: 'c' + i }], seed: seed * 1000 + i }));
// Deterministic win/loss streams with a given win probability.
const stream = (p, n, seed) => { const r = random(seed); return Array.from({ length: n }, () => r() < p ? 1 : 0); };

// A final-test state: `finalists` = {index: scores} (the first is the primary), `baselines` = {index: {kind, scores}}.
function finalState({ finalists, baselines = {}, champions = null, seed = 7 }) {
 const n = Object.values(finalists)[0].length, fixtureSeed = 900;
 const validations = Object.entries(finalists).map(([i, s]) => summarize(s, { team: T(+i), fixtureSeed, paired: false }));
 const baselineResults = Object.entries(baselines).map(([i, b]) => summarize(b.scores, { team: T(+i), kind: b.kind, fixtureSeed, paired: false }));
 const state = { validations, baselineResults, champions, observations: [], fixturePanels: {}, battles: 0, finalPanel: { requestedFixtures: n, completedFixtures: n, teams: validations.length + baselineResults.length, complete: true } };
 return Object.assign(state, C.finalComparisons(state, seed));
}

// Fake panel evaluator: team scores come from tables indexed by team key and fixture index (recovered from the fixture seed),
// optionally cut to `cut` fixtures per call (a deadline) and advancing a fake clock.
function fakeEvaluator(tables, { cut = Infinity, clock = null } = {}) {
 const calls = [];
 const evaluate = async (teams, cases, limit, onTeam, options) => {
  calls.push({ teams: teams.map(teamKey), fixtures: cases.length, first: cases[0].seed, limit, options });
  if (clock) clock.t += clock.step;
  const m = Math.min(cases.length, cut);
  return teams.map(team => { const table = tables[teamKey(team)];return { team, scores: cases.slice(0, m).map(c => (Array.isArray(table) ? table : table[Math.floor(c.seed / 1000)])[c.seed % 1000]) }; });
 };
 return { evaluate, calls };
}
function context(state, tables, extra = {}) {
 const clock = extra.clock || { t: 0, step: 0 }, evaluator = fakeEvaluator(tables, { cut: extra.cut, clock: extra.clock }), saves = [], logs = [];
 return {
  state, seed: 7, opponents: extra.opponents ?? 32, confirmSeed: 777, bootstrapSeed: 123, base: state.finalPanel.requestedFixtures, max: extra.max ?? state.finalPanel.requestedFixtures,
  fixtures: fixturesFor, finalFixtures: n => fixturesFor(n, extra.finalPrefixBroken && n > state.finalPanel.completedFixtures ? 901 : 900), panels: () => extra.panels || [],
  evaluate: evaluator.evaluate, now: () => clock.t, limit: () => extra.limit ?? 1e12, isStopped: () => !!extra.stopped, save: () => saves.push(JSON.stringify(state.finalPanel)), log: m => logs.push(m), step: extra.step,
  extensionLimit: () => extra.extensionLimit ?? 1e12, calls: evaluator.calls, saves, logs,
 };
}
// spec[i] is a win probability, a score array (any panel) or {panelSeed: score array}.
const tablesFor = spec => Object.fromEntries(Object.entries(spec).map(([i, p]) => [teamKey(T(+i)), typeof p === 'number' ? stream(p, 1000, 31 + +i) : p]));

test('the trigger is a resolved challenger-better: a finalist, or a previous champion, clearly above the primary', () => {
 // Unresolved: a close finalist and a clearly worse one.
 let state = finalState({ finalists: { 0: stream(.55, 128, 1), 1: stream(.58, 128, 2), 2: stream(.30, 128, 3) } });
 assert.deepEqual(state.finalistComparisons.comparisons.map(c => c.distinguishable), ['unresolved', 'primary-better']);
 assert.deepEqual(C.challengers(state), []);
 // Resolved: a finalist far above the primary.
 state = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2), 2: stream(.38, 128, 3) } });
 assert.equal(state.finalistComparisons.comparisons[0].distinguishable, 'challenger-better');
 let found = C.challengers(state);
 assert.equal(found.length, 1);assert.deepEqual(found[0].team, T(1));assert.equal(found[0].evidence[0].kind, 'finalist');assert.ok(found[0].evidence[0].delta < 0);
 // A previous champion above the primary triggers through championComparisons; one that is the primary again does not.
 const champions = { teams: [{ team: T(5), label: 'old-1', sources: [] }, { team: T(0), label: 'primary-again', sources: [] }, { team: T(6), label: 'old-2', sources: [] }] };
 state = finalState({
  finalists: { 0: stream(.45, 128, 1), 1: stream(.47, 128, 2) },
  baselines: { 5: { kind: 'previous-champions', scores: stream(.90, 128, 4) }, 0: { kind: 'previous-champions', scores: stream(.45, 128, 1) }, 6: { kind: 'previous-champions', scores: stream(.30, 128, 6) } }, champions,
 });
 assert.equal(state.championComparisons.entries.find(e => e.sameTeam).label, 'primary-again');
 found = C.challengers(state);
 assert.deepEqual(found.map(c => c.team), [T(5)]);assert.equal(found[0].evidence[0].kind, 'previous-champion');assert.equal(found[0].evidence[0].label, 'old-1');
 // The same team found by both comparisons is one challenger with both pieces of evidence.
 state = finalState({
  finalists: { 0: stream(.40, 128, 1), 1: stream(.90, 128, 2) }, baselines: { 1: { kind: 'previous-champions', scores: stream(.90, 128, 2) } }, champions: { teams: [{ team: T(1), label: 'was-champion', sources: [] }] },
 });
 found = C.challengers(state);
 assert.equal(found.length, 1);assert.deepEqual(found[0].evidence.map(e => e.kind), ['finalist', 'previous-champion']);
 // Nothing to confirm without a primary, or with a primary that wins everything.
 assert.deepEqual(C.challengers({ validations: [] }), []);
 assert.deepEqual(C.challengers(finalState({ finalists: { 0: stream(.9, 128, 1), 1: stream(.3, 128, 2) } })), []);
});

test('the confirmation seed is derived from the validation seed and distinct from every other evaluation seed', () => {
 for (const validation of [1, 902, 20261009, 4294967295, 123456789]) {
  const seed = C.confirmationSeed(validation);
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  assert.notEqual(seed, validation);assert.notEqual(seed, screeningSeed(validation));
  assert.equal(C.confirmationSeed(validation), seed, 'deterministic');
  // A guarded derivation: a reserved seed is skipped, exactly as guardedSeed does.
  const skipped = C.confirmationSeed(validation, [seed]);
  assert.notEqual(skipped, seed);assert.equal(skipped, guardedSeed(seed, [seed]));
  assert.notEqual(C.confirmationSeed(validation, [seed, seed + 1]), seed + 1);
 }
 assert.equal(new Set(Array.from({ length: 500 }, (_, i) => C.confirmationSeed(i + 1))).size, 500, 'different validation seeds give different panels');
 // Absorbed evidence: a launcher draws validation seeds until none of the derived seeds was used.
 assert.equal(C.freshConfirmationSeed(902, []), true);
 assert.equal(C.freshConfirmationSeed(902, [C.confirmationSeed(902)]), false);
 assert.equal(C.freshConfirmationSeed(902, [902]), true, 'the other seeds are freshEvaluationSeeds\' business');
});

test('the sealed panel may not reuse training evidence, a sealed panel or the retest panel', () => {
 const cases = fixturesFor(4, 777);
 assert.equal(C.overlapsEvidence(cases, {}), null);
 assert.equal(C.overlapsEvidence(cases, { observations: [{ opponent: ['a9', 'b9', 'c9'], seed: 5 }], panels: [fixturesFor(4, 3)] }), null);
 assert.equal(C.overlapsEvidence(cases, { observations: [{ opponent: ['a2', 'b2', 'c2'], seed: 777002 }] }), 'training evidence');
 assert.equal(C.overlapsEvidence(cases, { panels: [fixturesFor(4, 3), cases.slice(1, 2)] }), 'a sealed or retest panel');
 // A bench permutation of the same opponent with the same battle seed is the same fixture.
 assert.equal(C.overlapsEvidence(cases, { observations: [{ opponent: ['a2', 'c2', 'b2'], seed: 777002 }] }), 'training evidence');
});

test('a triggered confirmation plays the primary and the challengers on one fresh common panel and says whether it was confirmed', async () => {
 const state = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2), 2: stream(.38, 128, 3) } });
 const ctx = context(state, tablesFor({ 0: .35, 1: .80, 2: .35 }));
 const record = await C.ensureConfirmation(ctx);
 assert.equal(ctx.calls.length, 1);assert.deepEqual(ctx.calls[0].teams, [teamKey(T(0)), teamKey(T(1))], 'only the primary and the resolved challenger play');
 assert.deepEqual(ctx.calls[0].options, { commonPanel: true });assert.equal(ctx.calls[0].fixtures, 32);assert.equal(ctx.calls[0].first, 777 * 1000);
 assert.equal(record, state.confirmation);
 assert.equal(record.seed, 777);assert.equal(record.requestedFixtures, 32);assert.equal(record.completedFixtures, 32);assert.equal(record.complete, true);
 assert.deepEqual(record.primary, T(0));assert.deepEqual(record.teams.map(t => t.role), ['primary', 'challenger']);
 assert.equal(record.finalPanelFixtures, 128);assert.equal(record.triggers.length, 1);assert.equal(record.triggers[0].stage, 'final-panel');assert.deepEqual(record.triggers[0].challengers.map(c => c.team), [T(1)]);
 const challenger = record.comparisons[0];
 assert.equal(challenger.verdict, 'challenger-better');assert.equal(challenger.confirmed, true);assert.ok(challenger.delta < 0);assert.ok(challenger.simultaneous95[1] < 0);
 assert.equal(record.outcome, 'challenger-confirmed');assert.match(record.summary, /1 of 1 challenger scored clearly above the screening-selected primary/);assert.match(record.summary, /primary stays/);
 // Scores on the sealed panel, plus the final-panel score each team arrived with.
 assert.equal(record.teams[1].games, 32);assert.equal(record.teams[1].score, record.scores[teamKey(T(1))].reduce((a, b) => a + b, 0) / 32);
 assert.equal(record.teams[0].finalScore, state.validations[0].score);assert.equal(record.teams[1].finalScore, state.validations[1].score);
 // The panel is kept for evidence bookkeeping and was drawn from the confirmation seed.
 assert.equal(state.fixturePanels[777].length, 32);
 assert.equal(ctx.saves.length, 1);assert.match(ctx.logs[0], /seed 777.*32\/32.*challenger-confirmed/);
 // Pairs: every pair of the confirmation teams under the same simultaneous band.
 assert.equal(record.pairs.length, 1);assert.deepEqual(record.pairs[0].a, T(0));assert.deepEqual(record.pairs[0].b, T(1));
 // Asking again changes nothing and plays nothing.
 assert.equal(await C.ensureConfirmation(ctx), record);assert.equal(ctx.calls.length, 1);
 // The public copy drops the per-fixture scores and nothing else.
 const publicRecord = C.publicRecord(record);
 assert.equal('scores' in publicRecord, false);assert.deepEqual(Object.keys(publicRecord), Object.keys(record).filter(k => k !== 'scores'));assert.equal(C.publicRecord(null), null);
});

test('a challenger that does not reappear on the sealed panel is reported as not confirmed', async () => {
 const state = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } });
 // Same strength on the new panel: unresolved.
 const same = stream(.6, 1000, 77);
 let ctx = context(state, tablesFor({ 0: same, 1: same.slice() })), record = await C.ensureConfirmation(ctx);
 assert.equal(record.outcome, 'not-confirmed');assert.equal(record.comparisons[0].verdict, 'unresolved');assert.equal(record.comparisons[0].confirmed, false);assert.match(record.summary, /was not confirmed/);assert.match(record.summary, /1 unresolved/);
 // Reversed: the primary clearly ahead.
 delete state.confirmation;
 ctx = context(state, tablesFor({ 0: Array(1000).fill(1), 1: Array(1000).fill(0) }));record = await C.ensureConfirmation(ctx);
 assert.equal(record.outcome, 'not-confirmed');assert.equal(record.comparisons[0].verdict, 'primary-better');assert.match(record.summary, /1 with the primary clearly ahead/);
});

test('without a challenger, with the test off, or without a primary nothing is played or recorded', async () => {
 const quiet = finalState({ finalists: { 0: stream(.55, 128, 1), 1: stream(.57, 128, 2) } });
 let ctx = context(quiet, tablesFor({ 0: .5, 1: .5 }));
 assert.equal(await C.ensureConfirmation(ctx), null);assert.equal(ctx.calls.length, 0);assert.equal('confirmation' in quiet, false);
 const triggered = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } });
 ctx = context(triggered, tablesFor({ 0: .5, 1: .5 }), { opponents: 0 });
 assert.equal(await C.ensureConfirmation(ctx), null);assert.equal(ctx.calls.length, 0);
 assert.equal(await C.ensureConfirmation(context({ validations: [], finalPanel: { requestedFixtures: 1 } }, {}, {})), null);
});

test('a deadline-cut sealed panel keeps the common completed prefix; no time at all records the trigger as unconfirmed', async () => {
 const make = () => finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } });
 let state = make(), ctx = context(state, tablesFor({ 0: .35, 1: .80 }), { cut: 12 }), record = await C.ensureConfirmation(ctx);
 assert.equal(record.completedFixtures, 12);assert.equal(record.complete, false);assert.equal(record.requestedFixtures, 32);assert.equal(record.teams[1].games, 12);
 assert.match(record.summary, /12 of 32 planned sealed fixtures/);assert.ok(['challenger-confirmed', 'not-confirmed'].includes(record.outcome));
 // The clock is already past the limit: the trigger is recorded, nothing is played.
 state = make();ctx = context(state, tablesFor({ 0: .35, 1: .80 }), { limit: 5, clock: { t: 10, step: 0 } });record = await C.ensureConfirmation(ctx);
 assert.equal(ctx.calls.length, 0);assert.equal(record.outcome, 'incomplete');assert.equal(record.completedFixtures, 0);assert.equal(record.teams.length, 1);assert.deepEqual(record.scores[teamKey(T(0))], []);
 assert.match(record.summary, /could not be run|no confirmation fixture finished/);assert.equal(record.triggers[0].challengers.length, 1);assert.equal(record.comparisons.length, 0);
 // A user stop is the same, and asking again does not retry or duplicate the trigger.
 state = make();ctx = context(state, tablesFor({ 0: .35, 1: .80 }), { stopped: true });record = await C.ensureConfirmation(ctx);
 assert.equal(ctx.calls.length, 0);assert.equal(record.outcome, 'incomplete');
});

test('the sealed panel refuses fixtures that training evidence or another panel already holds', async () => {
 const state = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } });
 state.observations = [{ team: T(9), opponent: ['a3', 'b3', 'c3'], seed: 777003, score: 1 }];
 await assert.rejects(C.ensureConfirmation(context(state, tablesFor({ 0: .5, 1: .5 }))), /overlap training evidence/);
 state.observations = [];
 await assert.rejects(C.ensureConfirmation(context(state, tablesFor({ 0: .5, 1: .5 }), { panels: [fixturesFor(32, 777)] })), /overlap a sealed or retest panel/);
 assert.equal('confirmation' in state, false, 'nothing recorded for a refused panel');
});

test('a challenger resolved later joins the same sealed panel without replaying the others, and a late one that cannot finish is not added', async () => {
 const state = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2), 2: stream(.80, 128, 3) } });
 // First call: pretend only team 1 was resolved (hide team 2's comparison).
 const full = state.finalistComparisons;
 state.finalistComparisons = { ...full, comparisons: full.comparisons.map(c => teamKey(c.team) === teamKey(T(2)) ? { ...c, distinguishable: 'unresolved' } : c) };
 const tables = tablesFor({ 0: .35, 1: .80, 2: .78 }), ctx = context(state, tables), first = await C.ensureConfirmation(ctx);
 assert.deepEqual(ctx.calls[0].teams, [teamKey(T(0)), teamKey(T(1))]);const primaryScores = first.scores[teamKey(T(0))].slice();
 // The longer final panel resolves team 2 as well.
 state.finalistComparisons = full;
 const again = await C.ensureConfirmation(ctx);
 assert.equal(again, first, 'one record, one seed');assert.deepEqual(ctx.calls[1].teams, [teamKey(T(2))], 'only the new challenger plays');assert.equal(ctx.calls[1].first, 777 * 1000, 'the same sealed fixtures');
 assert.deepEqual(again.scores[teamKey(T(0))], primaryScores);assert.deepEqual(again.teams.map(t => t.role), ['primary', 'challenger', 'challenger']);
 assert.equal(again.triggers.length, 2);assert.equal(again.pairs.length, 3, 'the band now covers all three pairs');assert.equal(again.comparisons.length, 2);
 // Wider band with three teams than with two (same data, one more comparison in the family).
 const alone = await C.ensureConfirmation(context(Object.assign(finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } })), tables));
 assert.ok(again.radius >= alone.radius - 1e-12);
 // A late challenger that cannot complete the panel is recorded as unfinished and not retried.
 const s2 = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2), 2: stream(.80, 128, 3) } });
 s2.finalistComparisons = { ...full, comparisons: full.comparisons.map(c => teamKey(c.team) === teamKey(T(2)) ? { ...c, distinguishable: 'unresolved' } : c) };
 const c2 = context(s2, tables), r2 = await C.ensureConfirmation(c2);
 s2.finalistComparisons = full;
 const cutting = context(s2, tables, { cut: 5 });await C.ensureConfirmation(cutting);
 assert.equal(r2.teams.length, 2);assert.deepEqual(r2.unfinished.map(u => [teamKey(u.team), u.completedFixtures]), [[teamKey(T(2)), 5]]);
 await C.ensureConfirmation(cutting);assert.equal(cutting.calls.length, 1, 'not retried');
});

test('the longer final panel grows in steps of 64 on the same fixtures, keeps every earlier score and recomputes the comparisons', async () => {
 const finalists = { 0: stream(.50, 64, 1), 1: stream(.52, 64, 2), 2: stream(.30, 64, 3) };
 const state = finalState({ finalists, baselines: { 3: { kind: 'uniform-random', scores: stream(.2, 64, 4) }, 1: { kind: 'previous-champions', scores: finalists[1] } }, champions: { teams: [{ team: T(1), label: 'was-finalist', sources: [] }] } });
 const tables = tablesFor({ 0: stream(.50, 1000, 1), 1: stream(.52, 1000, 2), 2: stream(.30, 1000, 3), 3: stream(.2, 1000, 4) });
 for (const i of [0, 1, 2, 3]) tables[teamKey(T(i))].splice(0, 64, ...(i === 3 ? stream(.2, 64, 4) : finalists[i] || []));
 const before = JSON.parse(JSON.stringify({ v: state.validations, b: state.baselineResults }));
 const clock = { t: 0, step: 10 }, ctx = context(state, tables, { max: 200, clock, extensionLimit: 1e12 });
 const result = await C.extendFinalPanel(ctx);
 assert.deepEqual(ctx.calls.map(c => [c.fixtures, c.first]), [[64, 900 * 1000 + 64], [64, 900 * 1000 + 128], [8, 900 * 1000 + 192]], 'steps of 64 up to the target, each on the next unplayed fixtures');
 assert.ok(ctx.calls.every(c => c.options.commonPanel && c.teams.length === 4), 'finalists, baselines and the champion share the panel: four distinct teams');
 assert.equal(result.completedFixtures, 200);assert.equal(result.stoppedBecause, 'target-reached');assert.deepEqual(result.steps.map(s => [s.fixtures, s.added, s.requested]), [[128, 64, 64], [192, 64, 64], [200, 8, 8]]);
 assert.ok(result.steps.every(s => s.seconds === .01), 'the fake clock advances 10 ms per step');
 assert.equal(state.finalPanel.completedFixtures, 200);assert.equal(state.finalPanel.requestedFixtures, 64, 'the planned base stays what was planned');assert.equal(state.finalPanel.complete, true);
 assert.deepEqual({ ...state.finalPanel.extension, steps: undefined }, { baseFixtures: 64, requestedMax: 200, step: 64, completedFixtures: 200, steps: undefined, stoppedBecause: 'target-reached' });
 // Every earlier fixture keeps its score, the same team on the panel twice stays identical, and the summaries are recomputed.
 state.validations.forEach((v, i) => { assert.equal(v.pairs.length, 200);assert.deepEqual(v.pairs.slice(0, 64), before.v[i].pairs);assert.equal(v.score, v.pairs.reduce((a, b) => a + b, 0) / 200);assert.equal(v.fixtureSeed, 900); });
 state.baselineResults.forEach((b, i) => { assert.equal(b.pairs.length, 200);assert.deepEqual(b.pairs.slice(0, 64), before.b[i].pairs);assert.equal(b.kind, before.b[i].kind); });
 assert.deepEqual(state.baselineResults.find(b => b.kind === 'previous-champions').pairs, state.validations[1].pairs, 'finalist 1 is also a previous champion and played once');
 assert.equal(state.finalistComparisons.fixtures, 200);assert.equal(state.comparisons['uniform-random'].fixtures, 200);assert.equal(state.championComparisons.fixtures, 200);
 // It is exactly what a fresh computation on the final rows gives.
 assert.deepEqual({ comparisons: state.comparisons, finalistComparisons: state.finalistComparisons, championComparisons: state.championComparisons }, C.finalComparisons(state, 7));
 assert.equal(ctx.saves.length, 3);assert.match(ctx.logs.at(-1), /extended to 200\/200 common fixtures/);
 assert.ok(ctx.saves.every(saved => JSON.parse(saved).extension.stoppedBecause === 'in-progress'), 'a checkpoint written mid-way says the extension was interrupted, not finished');
});

test('a deadline-cut or stopped extension keeps the common prefix; nothing extends unless the base panel is complete', async () => {
 const make = () => finalState({ finalists: { 0: stream(.50, 64, 1), 1: stream(.52, 64, 2) } });
 const tables = () => { const t = tablesFor({ 0: stream(.50, 1000, 1), 1: stream(.52, 1000, 2) }); return t; };
 // The clock passes the limit after two steps.
 let state = make(), clock = { t: 0, step: 100 }, ctx = context(state, tables(), { max: 640, clock, extensionLimit: 150 }), result = await C.extendFinalPanel(ctx);
 assert.equal(ctx.calls.length, 2);assert.equal(result.stoppedBecause, 'time');assert.equal(result.completedFixtures, 192);assert.equal(state.validations[0].pairs.length, 192);
 // A step cut short by the deadline: only the fixtures every team finished are kept, and the extension ends.
 state = make();ctx = context(state, tables(), { max: 640, cut: 20 });result = await C.extendFinalPanel(ctx);
 assert.equal(ctx.calls.length, 1);assert.equal(result.completedFixtures, 84);assert.equal(result.stoppedBecause, 'time');assert.equal(state.validations[1].pairs.length, 84);assert.equal(state.finalPanel.complete, true);assert.deepEqual(result.steps.map(s => [s.added, s.requested]), [[20, 64]]);
 // A stop request before the first step, or a finished target, or a base panel that is itself incomplete or no larger target: nothing.
 state = make();ctx = context(state, tables(), { max: 640, stopped: true });assert.equal(await C.extendFinalPanel(ctx), null);assert.equal(ctx.calls.length, 0);assert.equal(state.finalPanel.extension.stoppedBecause, 'stopped');assert.equal(state.validations[0].pairs.length, 64);
 state = make();ctx = context(state, tables(), { max: 64 });assert.equal(await C.extendFinalPanel(ctx), null);assert.equal('extension' in state.finalPanel, false);
 state = make();state.finalPanel.complete = false;ctx = context(state, tables(), { max: 640 });assert.equal(await C.extendFinalPanel(ctx), null);assert.equal(ctx.calls.length, 0);assert.equal(state.finalPanel.extension.stoppedBecause, 'base-incomplete');assert.equal(state.finalPanel.extension.requestedMax, 640);
 // A fixture list whose prefix changes is refused rather than silently mixing panels.
 state = make();ctx = context(state, tables(), { max: 640, finalPrefixBroken: true });
 await assert.rejects(C.extendFinalPanel(ctx), /prefix changed/);
 // Rows of different length cannot be extended.
 state = make();state.baselineResults = [summarize(stream(.2, 60, 5), { team: T(3), kind: 'uniform-random', fixtureSeed: 900, paired: false })];ctx = context(state, tables(), { max: 640 });
 await assert.rejects(C.extendFinalPanel(ctx), /different lengths/);
});

test('finish: confirm what the final panel found, then extend, then confirm what only the longer panel found', async () => {
 // Primary and team 1 are close on the first 64 fixtures; the longer panel separates them.
 const base0 = stream(.5, 64, 1), base1 = base0.slice(), longer0 = Array(300).fill(0), longer1 = Array(300).fill(1);
 const state = finalState({ finalists: { 0: base0, 1: base1 } });
 assert.equal(state.finalistComparisons.comparisons[0].distinguishable, 'unresolved');
 const tables = tablesFor({ 0: { 900: [...base0, ...longer0.slice(64)], 777: Array(1000).fill(0) }, 1: { 900: [...base1, ...longer1.slice(64)], 777: Array(1000).fill(1) } });
 const ctx = context(state, tables, { max: 128, opponents: 16 });
 await C.finish(ctx);
 assert.deepEqual(ctx.calls.map(c => c.fixtures), [64, 16], 'the longer panel first (nothing to confirm yet), then the sealed panel for the challenger it resolved');
 assert.equal(ctx.calls[1].teams.length, 2);
 assert.equal(state.confirmation.triggers[0].stage, 'extended-final-panel');assert.equal(state.confirmation.triggers[0].fixtures, 128);assert.equal(state.confirmation.teams[1].resolvedByExtension, true);assert.equal(state.confirmation.comparisons[0].resolvedByExtension, true);
 assert.equal(state.confirmation.outcome, 'challenger-confirmed');assert.equal(state.finalistComparisons.comparisons[0].distinguishable, 'challenger-better');
 // Priority: a challenger the base panel resolved is confirmed BEFORE any extension step is played.
 const state2 = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } }), ctx2 = context(state2, tablesFor({ 0: .35, 1: .8 }), { max: 192, opponents: 16 });
 await C.finish(ctx2);
 assert.deepEqual(ctx2.calls.map(c => c.fixtures), [16, 64], 'confirmation first, then the longer panel');assert.equal(state2.confirmation.triggers.length, 1);assert.equal(state2.finalPanel.extension.completedFixtures, 192);
 assert.ok(ctx2.saves.length >= 2);
 // A stop request ends everything before it starts; with both features off finish is a no-op.
 const state3 = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } }), ctx3 = context(state3, tablesFor({ 0: .35, 1: .8 }), { max: 192, stopped: true });
 await C.finish(ctx3);assert.equal(ctx3.calls.length, 0, 'nothing is played after a stop request');
 assert.equal(state3.confirmation.outcome, 'incomplete', 'but what the final panel found is recorded');assert.equal(state3.finalPanel.extension.stoppedBecause, 'stopped');assert.equal(state3.validations[0].pairs.length, 128);
 const state4 = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } }), ctx4 = context(state4, tablesFor({ 0: .35, 1: .8 }), { opponents: 0 });
 await C.finish(ctx4);assert.equal(ctx4.calls.length, 0);
});

test('the extension keeps time back for a late confirmation', async () => {
 const state = finalState({ finalists: { 0: stream(.5, 64, 1), 1: stream(.5, 64, 2) } });
 state.runtime = { battlesPerSecond: 2 };
 // 2 teams x 100 fixtures at 2 battles/s with a 25% margin = 125 s reserved of the 200 s that remain.
 const ctx = context(state, tablesFor({ 0: .5, 1: .5 }), { max: 640, opponents: 100, limit: 200000, clock: { t: 0, step: 0 } });
 let seenLimit = null;const evaluate = ctx.evaluate;ctx.evaluate = async (teams, cases, limit, ...rest) => { seenLimit = limit;return evaluate(teams, cases, limit, ...rest); };
 await C.finish(ctx);
 assert.equal(seenLimit, 200000 - 125000, 'each extension step is limited to the deadline minus the reserve');
 // With the sealed test off nothing is reserved.
 seenLimit = null;const off = context(finalState({ finalists: { 0: stream(.5, 64, 1), 1: stream(.5, 64, 2) } }), tablesFor({ 0: .5, 1: .5 }), { max: 128, opponents: 0, limit: 200000 });
 const ev2 = off.evaluate;off.evaluate = async (teams, cases, limit, ...rest) => { seenLimit = limit;return ev2(teams, cases, limit, ...rest); };await C.finish(off);
 assert.equal(seenLimit, 200000);
});

test('the confirmation panel is absorbed as evaluation evidence: its seed becomes a used seed and its fixtures labels', async () => {
 const species = [...'abcdefghijkl'].map((c, i) => ({ speciesId: c, dex: i + 1, weight: 1 })), pool = { hash: 'p', species, variants: species };
 // Teams 0..2 over the pool; the fixture panels hold species objects as search.cjs stores them.
 const panel = seed => Array.from({ length: 4 }, (_, i) => ({ team: [species[3 + (i % 3)], species[6], species[7 + (i % 2)]], seed: seed + i }));
 const primary = summarize([1, 0, 1, 1], { team: [0, 1, 2], fixtureSeed: 900, paired: false }), challenger = summarize([0, 0, 1, 0], { team: [4, 5, 11], fixtureSeed: 900, paired: false });
 const state = {
  config: { version: 'neural-team-search-v4', poolHash: 'p' }, round: 3, observations: [], battles: 0, validations: [primary, challenger], screenResults: [], baselineResults: [], fixturePanels: { 900: panel(5000), 777: panel(9000) },
  confirmation: { seed: 777, completedFixtures: 4, teams: [{ team: [0, 1, 2], role: 'primary' }, { team: [4, 5, 11], role: 'challenger' }], scores: { [teamKey([0, 1, 2])]: [1, 1, 0, 1], [teamKey([4, 5, 11])]: [0, 1, 0, 0] } },
 };
 assert.deepEqual(C.evidenceRows(state).map(r => [r.kind, r.fixtureSeed, r.pairs.length, r.games]), [['confirmation', 777, 4, 4], ['confirmation', 777, 4, 4]]);
 assert.deepEqual(C.evidenceRows({ confirmation: { completedFixtures: 0, teams: [], scores: {} } }), []);assert.deepEqual(C.evidenceRows({}), []);
 const out = absorb(state, pool);
 assert.deepEqual(out.evaluationEvidence.fixtureSeeds.sort((a, b) => a - b), [777, 900], 'the confirmation seed is recorded beside the final seed');
 assert.equal(out.confirmation, null);assert.equal(out.observations.filter(o => [9000, 9001, 9002, 9003].includes(o.seed)).length, 8);
 // A later run whose derived confirmation seed collides with absorbed evidence is refused by the launcher's draw.
 assert.equal(C.freshConfirmationSeed(902, out.evaluationEvidence.fixtureSeeds), true);
 assert.equal(C.freshConfirmationSeed(902, [...out.evaluationEvidence.fixtureSeeds, C.confirmationSeed(902)]), false);
});

test('the evaluation reserve includes the sealed confirmation panel', () => {
 const base = { start: 0, deadline: 7200000, now: 600000, screenTeams: 10, screenOpponents: 500, validationTeams: 5, validationOpponents: 1000, baselineCount: 5, newBattles: 6000 };
 const plain = trainingBudget(base), withConfirmation = trainingBudget({ ...base, confirmationOpponents: 256 }), three = trainingBudget({ ...base, confirmationOpponents: 256, confirmationTeams: 3 });
 // 6,000 battles in 600 s = 10 per second; 2 battles per fixture; two teams on 256 fixtures add 1,024 battles.
 assert.equal(plain.estimatedEvaluationSeconds, 3000);assert.equal(plain.deadline, 3450000);
 assert.equal(withConfirmation.estimatedEvaluationSeconds, 3000 + 1024 / 10);assert.equal(withConfirmation.deadline, 7200000 - (3000 + 102.4) * 1250);
 assert.ok(three.estimatedEvaluationSeconds > withConfirmation.estimatedEvaluationSeconds);
 assert.deepEqual(trainingBudget({ ...base, confirmationOpponents: 0 }), plain);
 assert.equal(trainingBudget({ ...base, newBattles: 100, confirmationOpponents: 256 }).deadline, 5760000, 'before throughput is measured the fixed 80% applies');
});

test('a rematch against a run refuses the run\'s confirmation seed as well as its screening and final seeds', () => {
 const { extractCompositions } = require('./champions.cjs'), { screeningSeed } = require('./common.cjs');
 const member = id => ({ speciesId: id, speciesName: id, moveset: ['A', 'B'] });
 const data = { rows: [{ team: [member('a'), member('b'), member('c')], validation: { score: .7, fixtureSeed: 900 }, screen: { fixtureSeed: screeningSeed(900) } }], baselineResults: [{ fixtureSeed: 900 }], confirmation: { seed: 555 } };
 assert.deepEqual(extractCompositions(data, 'recommendations').info.usedSeeds.sort((a, b) => a - b), [555, 900, screeningSeed(900)].sort((a, b) => a - b));
 delete data.confirmation;assert.ok(!extractCompositions(data, 'recommendations').info.usedSeeds.includes(555));
});

test('a confirmation record of another primary or seed is never extended; it is replaced or cleared', async () => {
 const stale = { version: 1, seed: 777, bootstrapSeed: 1, requestedFixtures: 32, completedFixtures: 32, complete: true, primary: T(9), finalPanelFixtures: 128, triggers: [], teams: [{ team: T(9), role: 'primary' }, { team: T(1), role: 'challenger' }], scores: { [teamKey(T(9))]: Array(32).fill(1), [teamKey(T(1))]: Array(32).fill(0) }, comparisons: [], pairs: [], outcome: 'not-confirmed', summary: 'stale' };
 const state = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } });
 state.confirmation = JSON.parse(JSON.stringify(stale));
 let ctx = context(state, tablesFor({ 0: .35, 1: .80 })), record = await C.ensureConfirmation(ctx);
 assert.deepEqual(ctx.calls[0].teams, [teamKey(T(0)), teamKey(T(1))], 'played from scratch, not extended');assert.deepEqual(record.primary, T(0));assert.equal(record.outcome, 'challenger-confirmed');assert.ok(!(teamKey(T(9)) in record.scores));
 // The same primary under another seed is just as stale.
 const other = finalState({ finalists: { 0: stream(.40, 128, 1), 1: stream(.85, 128, 2) } });
 other.confirmation = { ...JSON.parse(JSON.stringify(stale)), primary: T(0), seed: 12345, teams: [{ team: T(0), role: 'primary' }, { team: T(1), role: 'challenger' }] };
 ctx = context(other, tablesFor({ 0: .35, 1: .80 }));record = await C.ensureConfirmation(ctx);assert.equal(record.seed, 777);assert.equal(ctx.calls.length, 1);
 // With nothing to confirm, a stale record is removed rather than reported.
 const quiet = finalState({ finalists: { 0: stream(.55, 128, 1), 1: stream(.57, 128, 2) } });quiet.confirmation = JSON.parse(JSON.stringify(stale));
 assert.equal(await C.ensureConfirmation(context(quiet, tablesFor({ 0: .5, 1: .5 }))), null);assert.equal('confirmation' in quiet, false);
});
