'use strict';
// Selection protocol after the final test (README sections 8 and 12, findings/selection-protocol.md).
//
// 1. Confirmation (--confirmation-opponents N, 0 disables). The primary is chosen by screening before the final
//    test and stays the primary endpoint. If the final panel then finds a challenger clearly above it (a finalist, or
//    a previous champion, whose simultaneous band against the primary is entirely on the challenger's side), choosing
//    that challenger would be a look at the best of several teams on the very panel that revealed it. So the primary
//    and every such challenger play a new sealed panel of N fixtures: a seed derived from the validation seed by
//    confirmationSeed (distinct from the screening, final, retest-panel and training seeds, checked against absorbed
//    evidence), one common set of fixtures with the deadline-safe prefix semantics, a paired bootstrap and one
//    simultaneous band over every pair of the confirmation teams (paired-stats.cjs). The report says whether the
//    challenger's advantage was confirmed.
// 2. Larger final panel (--validation-opponents-max M). Once the confirmation has run and time remains, the final
//    common panel of finalists, baselines and champions grows in steps of 64 fixtures up to M. The fixture list is
//    prefix-stable, so every earlier fixture keeps its score; the comparisons are recomputed on the longer panel, and
//    a challenger that only the longer panel resolves is added to the same sealed confirmation panel.
const { digest, guardedSeed, screeningSeed, teamKey } = require('./common.cjs');
const { summarize, compare, compareFinalists } = require('./evaluation.cjs');
const { championComparisons } = require('./champions.cjs');
const { pairwiseBands } = require('./paired-stats.cjs');
const { opponentFixtureKey } = require('./acquisition.cjs');

const DEFAULT_OPPONENTS = 256, EXTENSION_STEP = 64, BOOTSTRAP_OFFSET = 830001, BOOTSTRAP_SAMPLES = 5000;
const METHOD = 'paired opponent-fixture bootstrap with one simultaneous 95% band over every pair of the confirmation teams; a sealed panel that no selection or training step used, drawn after the final test; the screening-selected primary stays the primary endpoint';

// A fresh seed for the confirmation panel: derived from the validation seed (so the launcher's single seed fixes it),
// never equal to the validation or screening seed, and never one of `reserved` (search.cjs passes nothing more: the
// retest-panel and every training stream are guarded against this seed instead, see searchSeed there).
function confirmationSeed(validationSeed, reserved = []) {
 const derived = parseInt(digest(['confirmation', validationSeed]).slice(0, 8), 16) || 1;
 return guardedSeed(derived, [validationSeed, screeningSeed(validationSeed), ...reserved]);
}
// The launcher draws validation seeds until none of the evaluation seeds derived from it were used by absorbed evidence.
function freshConfirmationSeed(validationSeed, used = []) { return !used.includes(confirmationSeed(validationSeed)); }

// What would be rejected if it were a training or evaluation fixture again: any (opponent team, battle seed) pair
// that a sealed panel, the retest panel or the training evidence already holds. Returns the offender or null.
function overlapsEvidence(cases, { observations = [], panels = [] } = {}) {
 const keys = new Set(cases.map(c => opponentFixtureKey(c.team, c.seed)));
 for (const panel of panels) for (const c of panel) if (keys.has(opponentFixtureKey(c.team, c.seed))) return 'a sealed or retest panel';
 for (const o of observations) if (keys.has(opponentFixtureKey(o.opponent, o.seed))) return 'training evidence';
 return null;
}

// Challengers: teams other than the primary that the final panel put clearly ahead of it, from the finalist
// comparison (simultaneous band over the finalists) and the previous-champions table (simultaneous band over the
// champions). A previous champion that is the primary again (`sameTeam`) is a tie by construction and never a challenger.
function challengers(state) {
 const primary = state.validations?.[0];
 if (!primary) return [];
 const primaryKey = teamKey(primary.team), found = new Map();
 const add = (team, evidence) => { const key = teamKey(team); if (key === primaryKey) return; if (!found.has(key)) found.set(key, { team, evidence: [] }); found.get(key).evidence.push(evidence); };
 for (const c of state.finalistComparisons?.comparisons || []) if (c.distinguishable === 'challenger-better') add(c.team, { kind: 'finalist', delta: c.delta, interval95: c.interval95 });
 for (const e of state.championComparisons?.entries || []) if (e.verdict === 'challenger-better' && !e.sameTeam) add(e.team, { kind: 'previous-champion', label: e.label || null, delta: e.delta, interval95: e.interval95 });
 return [...found.values()];
}

// Every comparison the final panel reports, recomputed from the stored rows: the baseline groups, the finalists and
// the previous champions. Used after the panel grows; on an unextended run it reproduces what search.cjs stored.
function finalComparisons(state, seed) {
 const comparisons = {};
 for (const kind of ['uniform-random', 'weight-sampled-best-moves', 'greedy-scout-coverage', 'previous-champions']) {
  const rows = (state.baselineResults || []).filter(b => b.kind === kind);
  if (rows.length && state.validations.length) comparisons[kind] = compare(state.validations[0], rows, { seed: seed + 800001 });
 }
 return {
  comparisons,
  finalistComparisons: compareFinalists(state.validations[0], state.validations.slice(1), { seed: seed + 800002 }),
  championComparisons: championComparisons(state.validations[0], state.baselineResults, state.champions, { seed: seed + 800003 }),
 };
}

const verdictOf = { 'a-better': 'primary-better', 'b-better': 'challenger-better', unresolved: 'unresolved' };

// Summaries, bands and verdicts from the stored per-fixture scores (all teams cut to the shortest common prefix).
function analyse(record) {
 const keys = record.teams.map(t => teamKey(t.team)), n = Math.min(...keys.map(k => record.scores[k]?.length || 0));
 record.completedFixtures = n;record.complete = n >= record.requestedFixtures;
 record.comparisons = [];record.pairs = [];
 if (n < 1 || record.teams.length < 2) {
  record.teams.forEach(t => { delete t.score;delete t.games;delete t.wins;delete t.draws;delete t.losses;delete t.standardError; });
  record.outcome = 'incomplete';
  record.summary = 'The final panel put ' + (record.triggers.flatMap(t => t.challengers).length) + ' challenger(s) clearly above the screening-selected primary, but no confirmation fixture finished in the time that was left, so the advantage is not confirmed.';
  return record;
 }
 const rows = keys.map(k => ({ id: k, scores: record.scores[k].slice(0, n) })), bands = pairwiseBands(rows, { seed: record.bootstrapSeed, samples: BOOTSTRAP_SAMPLES });
 record.teams.forEach((t, i) => {
  const s = summarize(rows[i].scores, { team: t.team, fixtureSeed: record.seed, paired: false });
  Object.assign(t, { score: s.score, games: s.games, wins: s.wins, draws: s.draws, losses: s.losses, standardError: s.standardError });
 });
 record.radius = bands.radius;
 const primaryKey = keys[0];
 record.comparisons = record.teams.slice(1).map(t => {
  const key = teamKey(t.team), pair = bands.pairs.find(p => p.a === primaryKey && p.b === key);
  const verdict = verdictOf[pair.verdict];
  return { team: t.team, kind: t.kind, sources: t.sources, label: t.label || null, delta: pair.delta, interval95: pair.interval95, simultaneous95: pair.simultaneous95, verdict, confirmed: verdict === 'challenger-better', resolvedByExtension: !!t.resolvedByExtension };
 });
 record.pairs = bands.pairs.map(p => ({ a: record.teams[keys.indexOf(p.a)].team, b: record.teams[keys.indexOf(p.b)].team, delta: p.delta, simultaneous95: p.simultaneous95, verdict: p.verdict }));
 const confirmed = record.comparisons.filter(c => c.confirmed).length, reversed = record.comparisons.filter(c => c.verdict === 'primary-better').length, tied = record.comparisons.length - confirmed - reversed;
 record.outcome = confirmed ? 'challenger-confirmed' : 'not-confirmed';
 const total = record.comparisons.length, panel = n + (record.complete ? ' sealed fixtures' : ' of ' + record.requestedFixtures + ' planned sealed fixtures (the time ran out)');
 record.summary = confirmed
  ? confirmed + ' of ' + total + ' challenger' + (total > 1 ? 's' : '') + ' scored clearly above the screening-selected primary on the new ' + panel + ' (simultaneous 95% band entirely on the challenger\'s side). The primary stays this run\'s primary endpoint; the confirmed challenger\'s confirmation-panel score is an unbiased estimate, its final-panel score is not.'
  : 'The challenger advantage seen on the final panel was not confirmed on ' + panel + ': ' + [reversed ? reversed + ' with the primary clearly ahead' : '', tied ? tied + ' unresolved' : ''].filter(Boolean).join(', ') + '. A gap that does not reappear was probably the optimism of picking the best-looking of several noisy comparisons; but on this panel a difference smaller than about ' + (100 * record.radius).toFixed(1) + ' points cannot be told from noise, so "not confirmed" is not proof that there is no difference. The screening-selected primary stands.';
 return record;
}

function newRecord(ctx, primary, finalFixtures) {
 return {
  version: 1, seed: ctx.confirmSeed, bootstrapSeed: ctx.bootstrapSeed, requestedFixtures: ctx.opponents, completedFixtures: 0, complete: false,
  primary: primary.team, finalPanelFixtures: finalFixtures, triggers: [], teams: [{ team: primary.team, role: 'primary' }], scores: {},
  comparisons: [], pairs: [], outcome: 'incomplete', summary: '', method: METHOD,
 };
}

const finalScoreOf = (state, team) => {
 const key = teamKey(team), row = [...(state.validations || []), ...(state.baselineResults || [])].find(r => teamKey(r.team) === key);
 return row ? { finalScore: row.score, finalFixtures: row.games } : {};
};

// Play the sealed panel for whichever challengers it does not hold yet. First call: primary plus every challenger on one
// common prefix. Later calls (after the final panel grew) add only the new challengers to the SAME panel: they were not
// chosen using it, and the primary's scores are already there. Returns the (possibly unchanged) record.
async function ensureConfirmation(ctx) {
 const { state } = ctx, primary = state.validations?.[0];
 // A record belongs to one primary and one seed; one left by an earlier finalisation of a resumed run is never extended.
 const have = state.confirmation && primary && teamKey(state.confirmation.primary) === teamKey(primary.team) && state.confirmation.seed === ctx.confirmSeed ? state.confirmation : null;
 if (!primary || !(ctx.opponents > 0)) return have;
 const present = new Set([...(have?.teams || []), ...(have?.unfinished || [])].map(t => teamKey(t.team))), fresh = challengers(state).filter(c => !present.has(teamKey(c.team)));
 if (!fresh.length) { if (state.confirmation && !have) delete state.confirmation;return have; }
 const record = have || newRecord(ctx, primary, state.finalPanel?.requestedFixtures ?? primary.pairs.length), late = !!have;
 // `extended`: the challenger was only resolved after the final panel grew beyond the planned size.
 const extended = primary.pairs.length > record.finalPanelFixtures;
 record.triggers.push({ stage: extended ? 'extended-final-panel' : 'final-panel', fixtures: primary.pairs.length, challengers: fresh.map(c => ({ team: c.team, evidence: c.evidence })) });
 const freshTeams = fresh.map(c => ({ team: c.team, role: 'challenger', kind: c.evidence[0].kind, sources: [...new Set(c.evidence.map(e => e.kind))], label: c.evidence.find(e => e.label)?.label || null, ...(extended ? { resolvedByExtension: true } : {}) }));
 if (!late) record.teams[0] = { ...record.teams[0], ...finalScoreOf(state, primary.team) };
 const accepted = [];
 if (!ctx.isStopped() && ctx.now() < ctx.limit()) {
  if (state.runtime) state.runtime.phase = 'confirming';
  const cases = ctx.fixtures(ctx.opponents, ctx.confirmSeed);
  const offender = overlapsEvidence(cases, { observations: state.observations, panels: ctx.panels() });
  if (offender) throw Error('Confirmation fixtures overlap ' + offender + '; choose a fresh validation-seed');
  state.fixturePanels ??= {};state.fixturePanels[ctx.confirmSeed] = cases;
  const rows = await ctx.evaluate(late ? freshTeams.map(t => t.team) : [primary.team, ...freshTeams.map(t => t.team)], cases, ctx.limit(), () => {}, { commonPanel: true });
  const prefix = rows[0]?.scores.length || 0;
  // A challenger added late must have played at least as many fixtures as the panel already holds, or the others'
  // comparisons would be cut to its shorter prefix; otherwise it is reported as not confirmed for lack of time.
  if (prefix >= (late ? Math.max(1, record.completedFixtures) : 1)) { for (const row of rows) record.scores[teamKey(row.team)] = row.scores.slice(); accepted.push(...freshTeams); }
  else record.unfinished = [...(record.unfinished || []), ...freshTeams.map(t => ({ team: t.team, completedFixtures: prefix }))];
 } else record.unfinished = [...(record.unfinished || []), ...freshTeams.map(t => ({ team: t.team, completedFixtures: 0 }))];
 for (const t of freshTeams) if (accepted.includes(t)) record.teams.push({ ...t, ...finalScoreOf(state, t.team) });
 for (const t of record.teams) record.scores[teamKey(t.team)] ??= [];
 analyse(record);
 state.confirmation = record;
 ctx.log('Confirmation panel (seed ' + record.seed + '): ' + record.completedFixtures + '/' + record.requestedFixtures + ' sealed fixtures · ' + record.outcome);
 ctx.save();
 return record;
}

// Grow the final common panel in steps (default 64) up to `max` while time remains. Every team already on the panel
// (finalists, baselines, previous champions) plays the same new fixtures; a deadline-cut step keeps only the common
// completed prefix. Rows and comparisons are recomputed after every step and the checkpoint saved.
async function extendFinalPanel(ctx) {
 const { state } = ctx, panel = state.finalPanel, step = ctx.step || EXTENSION_STEP;
 if (!(ctx.max > ctx.base) || !state.validations?.length) return null;
 if (!panel?.complete) { state.finalPanel = { ...panel, extension: { baseFixtures: ctx.base, requestedMax: ctx.max, step, completedFixtures: panel?.completedFixtures ?? 0, steps: [], stoppedBecause: 'base-incomplete' } };return null; }
 const members = new Map();
 for (const row of [...state.validations, ...state.baselineResults]) { const key = teamKey(row.team); if (!members.has(key)) members.set(key, { team: row.team, rows: [] });members.get(key).rows.push(row); }
 let n = panel.completedFixtures;
 for (const m of members.values()) for (const row of m.rows) if (row.pairs.length !== n) throw Error('Final panel rows have different lengths; refusing to extend');
 const teams = [...members.values()].map(m => m.team), steps = [];
 let known = ctx.finalFixtures(n), stopReason = 'target-reached';
 if (state.runtime) state.runtime.phase = 'extending-final-panel';
 const resum = row => summarize(row.pairs, { team: row.team, kind: row.kind, fixtureSeed: row.fixtureSeed, paired: false });
 while (n < ctx.max) {
  if (ctx.isStopped()) { stopReason = 'stopped'; break; }
  const limit = ctx.extensionLimit();
  if (ctx.now() >= limit) { stopReason = 'time'; break; }
  const target = Math.min(ctx.max, n + step), all = ctx.finalFixtures(target);
  // The panel is one fixture list that grows: an earlier fixture may never change.
  for (let i = 0; i < n; i++) if (opponentFixtureKey(all[i].team, all[i].seed) !== opponentFixtureKey(known[i].team, known[i].seed)) throw Error('Final panel prefix changed while extending');
  known = all;
  const started = ctx.now(), battles0 = state.battles, rows = await ctx.evaluate(teams, all.slice(n, target), limit, () => {}, { commonPanel: true }), added = rows[0]?.scores.length || 0;
  if (!added) { stopReason = ctx.isStopped() ? 'stopped' : 'time'; break; }
  for (const row of rows) for (const r of members.get(teamKey(row.team)).rows) r.pairs.push(...row.scores);
  state.validations = state.validations.map(resum);state.baselineResults = state.baselineResults.map(resum);
  for (const m of members.values()) m.rows = [...state.validations, ...state.baselineResults].filter(r => teamKey(r.team) === teamKey(m.team));
  n += added;
  steps.push({ fixtures: n, added, requested: target - (n - added), seconds: (ctx.now() - started) / 1000, battles: state.battles - battles0 });
  Object.assign(state, finalComparisons(state, ctx.seed));
  state.finalPanel = { ...panel, completedFixtures: n, complete: n >= panel.requestedFixtures, extension: { baseFixtures: ctx.base, requestedMax: ctx.max, step, completedFixtures: n, steps, stoppedBecause: 'in-progress' } };
  ctx.save();
  if (added < target - (n - added)) { stopReason = ctx.isStopped() ? 'stopped' : 'time'; break; }
 }
 if (!steps.length) { state.finalPanel = { ...panel, extension: { baseFixtures: ctx.base, requestedMax: ctx.max, step, completedFixtures: n, steps, stoppedBecause: stopReason } }; return null; }
 state.finalPanel.extension.stoppedBecause = stopReason;
 ctx.log('Final panel extended to ' + n + '/' + ctx.max + ' common fixtures (' + stopReason + ')');
 return state.finalPanel.extension;
}

// Everything that follows the final test, in priority order: confirm what the final panel found, then spend leftover
// time on a longer panel (keeping time back for a late confirmation), then confirm what only the longer panel found.
async function finish(ctx) {
 const { state } = ctx;
 if (!state.validations?.length) return;
 // A stop request still records what the final panel found (an `incomplete` confirmation, an extension that stopped at once).
 await ensureConfirmation(ctx);
 // Time kept back from the longer panel for a late confirmation: two teams on the whole sealed panel, 25% margin, at the
 // run's average battle rate (the same estimate budget.cjs reserves when training stops).
 const rate = Math.max(.5, state.runtime?.battlesPerSecond || 1), reserve = ctx.opponents > 0 ? Math.ceil(2 * ctx.opponents / rate * 1250) : 0;
 const extended = await extendFinalPanel({ ...ctx, extensionLimit: () => ctx.limit() - reserve });
 if (extended) await ensureConfirmation(ctx);
 ctx.save();
}

// A copy for recommendations.json, the portable report and the report pages: no per-fixture scores.
function publicRecord(record) {
 if (!record) return null;
 const { scores, ...rest } = record;
 return JSON.parse(JSON.stringify(rest));
}

// Rows for absorb-evaluation.cjs: the confirmation panel is evaluation evidence once the run is finished.
function evidenceRows(state) {
 const c = state.confirmation;
 if (!c?.completedFixtures) return [];
 return c.teams.map(t => ({ team: t.team, kind: 'confirmation', fixtureSeed: c.seed, pairs: c.scores[teamKey(t.team)].slice(0, c.completedFixtures), games: c.completedFixtures }));
}

module.exports = { DEFAULT_OPPONENTS, EXTENSION_STEP, BOOTSTRAP_OFFSET, METHOD, confirmationSeed, freshConfirmationSeed, overlapsEvidence, challengers, finalComparisons, analyse, ensureConfirmation, extendFinalPanel, finish, publicRecord, evidenceRows };
