#!/usr/bin/env node
'use strict';
// Policy-diversity panel (team-search README section 12, "The controller"; EVALUATION_PROTOCOL.md, `policyPanel`).
//
// The given teams play one common opponent panel once per opponent policy style. The given teams keep their own
// controller (the run's: the default v4 controller unless the run set --reply-model or --rollout-continuation);
// only the OPPONENT side's controller changes:
//   default                v4 as in every search label
//   weighted-replies       softmax-weighted instead of worst-case replies in its switch lookahead
//   no-voluntary-switches  switch margin effectively infinite (forced replacements only)
//   eager-switches         switch margin 0 (switches on any forecast gain)
//   always-shield          shields every charged attack while shields remain
//   never-shield           never shields
// Each team gets a score per style, the mean, the minimum and the spread (best minus worst style) with paired
// opponent-fixture bootstrap bands (paired-stats.cjs). A small spread says the team's score does not hinge on one
// way of playing the opponent; it is a realism check, never a selection criterion (the panel runs after the final
// test and changes nothing about the primary). Every style replays the default battle's seed and orientation, so
// differences between styles are paired by fixture.
//
//   node training/next/policy-panel.cjs RUN_OR_REPORT[,…] [--scope finalists|primary] [--fixtures 32] [--workers 4]
//        [--pool FILE] [--meta hybrid] [--usage-file F --usage-half-life-days N --usage-as-of D --usage-prior-strength N]
//        [--seed N] [--reply-model worst|weighted] [--reply-temperature 0.25] [--rollout-continuation 0] [--out FILE.json]
//   node training/next/policy-panel.cjs --print SAVED.json
//
// Sources are what rematch.cjs and --champions accept (run directories, recommendations.json, portable reports);
// only compositions are read. search.cjs runs the panel itself with --policy-panel N (0 = off).
const fs = require('node:fs'), path = require('node:path');
const { defaults } = require('../utils.cjs');
const { pairwiseBands } = require('../team-search/paired-stats.cjs');
const controllerOptions = require('./controller-options.cjs');

const STYLES = Object.freeze([
 { name: 'default', label: 'Default', controller: null },
 { name: 'weighted-replies', label: 'Weighted replies', controller: { replyModel: 'weighted', replyTemperature: .25 } },
 { name: 'no-voluntary-switches', label: 'No switches', controller: { switchMargin: 1e9 } },
 { name: 'eager-switches', label: 'Eager switches', controller: { switchMargin: 0 } },
 { name: 'always-shield', label: 'Always shield', controller: { shieldPolicy: 'always' } },
 { name: 'never-shield', label: 'Never shield', controller: { shieldPolicy: 'never' } },
].map(Object.freeze));
const SEED_OFFSET = 830001, BOOTSTRAP_OFFSET = 830002, MAX_FIXTURES = 4096, FORMAT = 'pvp-team-policy-panel';

function checkSize(n) { if (!Number.isInteger(n) || n < 0 || n > MAX_FIXTURES) throw Error('policy-panel must be an integer from 0 to ' + MAX_FIXTURES); return n; }
// controllerTeams for one battle: [the given team's controller, the style's], or none when both are the default
// (then the battle is exactly a default search battle).
function sideControllers(own, style) { const a = controllerOptions.teamControllerIdentity(own || {}), b = controllerOptions.teamControllerIdentity(style.controller || {}); return a || b ? [a, b] : null; }

// Fixture-major, then style, then team: a stopped panel leaves a common prefix of whole fixtures.
function buildJobs({ teams, fixtures, engine, own = null, styles = STYLES }) {
 const jobs = [], index = [];
 fixtures.forEach((c, f) => styles.forEach((style, k) => {
  const sides = sideControllers(own, style);
  teams.forEach((team, t) => { jobs.push([team, c.team, defaults, defaults, { ...engine, seed: c.seed, ...(sides ? { controllerTeams: sides } : {}) }]); index.push({ fixture: f, style: k, team: t }); });
 }));
 return { jobs, index };
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
// One team's style scores on the completed fixtures: means, spread and paired bands.
function summarizeTeam(styleScores, styles, { seed, samples }) {
 const rows = styles.map((s, k) => ({ id: s.name, scores: styleScores[k] })), means = rows.map(r => mean(r.scores));
 let hi = 0, lo = 0;means.forEach((m, k) => { if (m > means[hi]) hi = k; if (m < means[lo]) lo = k; });
 const bands = rows[0].scores.length > 1 && rows.length > 1 ? pairwiseBands(rows, { seed, samples }) : null;
 const band = (x, y) => { // style x minus style y, simultaneous over every pair of styles
  if (!bands || x === y) return { delta: means[x] - means[y], interval95: x === y ? [0, 0] : [-1, 1] };
  const p = bands.pairs.find(q => (q.a === rows[x].id && q.b === rows[y].id) || (q.a === rows[y].id && q.b === rows[x].id));
  return p.a === rows[x].id ? { delta: p.delta, interval95: p.simultaneous95 } : { delta: -p.delta, interval95: [-p.simultaneous95[1], -p.simultaneous95[0]] };
 };
 const verdict = i => i[0] > 0 ? 'higher' : i[1] < 0 ? 'lower' : 'unresolved';
 const spread = band(hi, lo);
 return {
  scores: Object.fromEntries(styles.map((s, k) => [s.name, means[k]])), mean: mean(means), min: means[lo], max: means[hi], spread: means[hi] - means[lo],
  spreadInterval95: spread.interval95, bestStyle: styles[hi].name, worstStyle: styles[lo].name, bandRadius: bands ? bands.radius : null,
  versusDefault: styles.slice(1).map((s, k) => { const b = band(k + 1, 0); return { style: s.name, delta: b.delta, interval95: b.interval95, verdict: verdict(b.interval95) }; }),
 };
}

// Runs the panel. `run(jobs, {shouldStop, onResult})` plays battles (BattlePool.map semantics: results reach
// onResult in any order; it may stop early). Returns the panel result on the completed prefix of fixtures.
async function runPanel({ teams, ids = null, labels = [], fixtures, engine, own = null, styles = STYLES, run, shouldStop = () => false, onBattle = () => {}, seed = null, bootstrapSeed = 1, samples = 5000, log = () => {} }) {
 if (!teams.length || !fixtures.length) throw Error('Policy panel needs teams and fixtures');
 if (styles[0].controller) throw Error('The first style must be the default controller (the reference for every comparison)');
 const started = Date.now(), { jobs, index } = buildJobs({ teams, fixtures, engine, own, styles });
 const scores = teams.map(() => styles.map(() => new Array(fixtures.length)));
 let done = 0, last = Date.now();
 await run(jobs, { shouldStop, onResult: (result, i) => {
  if (result.timedOut) throw Error('Battle timeout: no fabricated draw accepted');
  if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) throw Error('Invalid battle score');
  const at = index[i];scores[at.team][at.style][at.fixture] = result.score;onBattle(result);
  if (++done && Date.now() - last > 10000) { last = Date.now(); log('[policy-panel] ' + done + '/' + jobs.length + ' battles'); }
 } });
 let completed = 0;while (completed < fixtures.length && scores.every(t => t.every(s => Number.isFinite(s[completed])))) completed++;
 const result = {
  format: FORMAT, schemaVersion: 1, createdAt: new Date().toISOString(),
  fixtures: { requested: fixtures.length, completed, seed, exploratory: completed < 256 },
  own: { controller: controllerOptions.teamControllerIdentity(own || {}), label: controllerOptions.describe(own) },
  styles: styles.map(s => ({ name: s.name, label: s.label, controller: s.controller ? { ...s.controller } : null })),
  battles: done, seconds: (Date.now() - started) / 1000,
  method: 'Each team plays the same opponent fixtures once per opponent policy style; the team keeps its own controller. Scores are means over the common completed fixtures; bands are a paired opponent-fixture bootstrap, simultaneous over all pairs of styles for that team.',
  teams: completed ? teams.map((_, t) => ({ team: ids ? ids[t] : null, label: labels[t] || null, ...summarizeTeam(scores[t].map(s => s.slice(0, completed)), styles, { seed: (bootstrapSeed + t) >>> 0, samples }), fixtureScores: scores[t].map(s => s.slice(0, completed)) })) : [],
 };
 return result;
}
// The panel without per-fixture scores, for recommendations.json and the portable report.
function compact(panel) { return panel ? { ...panel, teams: panel.teams.map(({ fixtureScores, ...rest }) => rest) } : null; }

// search.cjs: the finalists, after the final test, until the run's deadline. Results go to state.policyPanel.
async function searchPanel({ state, opts, variants, meta, beliefRoster, beliefTeams, controller, pool, now, deadline, isStopped, save, fixtures, seed, bootstrapSeed }) {
 const teams = state.validations.map(v => v.team), cases = meta.fixtures(fixtures, seed);
 state.runtime.phase = 'policy-panel';save();
 console.log('Policy panel: ' + teams.length + ' finalists × ' + cases.length + ' fixtures × ' + STYLES.length + ' opponent styles');
 state.policyPanel = await runPanel({
  teams: teams.map(t => t.map(i => variants[i])), ids: teams, labels: teams.map(t => t.map(i => variants[i].speciesName).join(' / ')), fixtures: cases, own: controller,
  engine: { cp: 1500, beliefRoster, beliefTeams, beliefSamples: opts.beliefSamples || 3, horizon: opts.lookaheadTurns || 24, interval: opts.decisionInterval || 4 },
  run: (jobs, hooks) => pool.map(jobs, hooks), shouldStop: () => isStopped() || now() >= deadline, onBattle: () => { state.battles++; }, seed, bootstrapSeed, log: console.log,
 });
 save();console.log('Policy panel: ' + state.policyPanel.fixtures.completed + '/' + cases.length + ' fixtures completed');
 return state.policyPanel;
}

// --- command line ---------------------------------------------------------------------------------------------
const CLI_DEFAULTS = { pool: 'training/runs/team-search/pool.json', scope: 'finalists', meta: 'hybrid', usageFile: '', usageHalfLifeDays: 0, usageAsOf: '', usagePriorStrength: 500, metaWeightPower: 1.25, fixtures: 32, seed: 0, workers: 4, beliefSamples: 3, lookaheadTurns: 24, decisionInterval: 4, bootstrap: 5000, replyModel: 'worst', replyTemperature: .25, rolloutContinuation: 0, out: '', print: '' };
function parseArgs(argv) {
 const numbers = new Set(Object.keys(CLI_DEFAULTS).filter(k => typeof CLI_DEFAULTS[k] === 'number')), opts = { ...CLI_DEFAULTS, help: false }, sources = [];
 for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help') { opts.help = true; continue; }
  if (!a.startsWith('--')) { sources.push(...a.split(',').filter(Boolean)); continue; }
  const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (!(key in CLI_DEFAULTS) || argv[i + 1] === undefined) throw Error('Unknown argument ' + a);
  opts[key] = numbers.has(key) ? Number(argv[++i]) : argv[++i];
 }
 return { opts, sources };
}
const pc = x => (100 * x).toFixed(1), signed = x => (x >= 0 ? '+' : '') + pc(x);
function formatTable(result) {
 const styles = result.styles, lines = [];
 lines.push('Policy panel · ' + result.fixtures.completed + (result.fixtures.completed !== result.fixtures.requested ? '/' + result.fixtures.requested : '') + ' common fixtures × ' + styles.length + ' opponent styles' + (result.meta ? ' · meta ' + result.meta.mode + (result.meta.observedCount ? ' (' + pc(result.meta.observedShare) + '% observed)' : '') : '') + ' · panel seed ' + result.fixtures.seed + ' · own controller: ' + result.own.label + (result.fixtures.exploratory ? ' · EXPLORATORY: fewer than 256 fixtures' : ''));
 lines.push('Scores: simulated expected score of each team when the opponent plays in that style. Spread: best minus worst style, with a simultaneous 95% band.');
 lines.push('');
 const head = ['#', 'Team (lead first)', ...styles.map(s => s.label), 'Mean', 'Min', 'Spread [95%]'], rows = [head];
 result.teams.forEach((t, i) => rows.push([String(i + 1), t.label || (t.team || []).join(','), ...styles.map(s => pc(t.scores[s.name])), pc(t.mean), pc(t.min), pc(t.spread) + ' [' + pc(t.spreadInterval95[0]) + ', ' + pc(t.spreadInterval95[1]) + ']']));
 const widths = head.map((_, j) => Math.max(...rows.map(r => String(r[j]).length)));
 for (const r of rows) lines.push(r.map((v, j) => String(v).padEnd(widths[j])).join('  ').trimEnd());
 lines.push('', 'Style minus default (simultaneous 95% band; "unresolved" = a tie at this panel size):');
 result.teams.forEach((t, i) => lines.push('  ' + (i + 1) + ': ' + t.versusDefault.map(v => v.style + ' ' + signed(v.delta) + ' [' + signed(v.interval95[0]) + ', ' + signed(v.interval95[1]) + ']' + (v.verdict === 'unresolved' ? '' : ' ' + v.verdict)).join(' · ')));
 if (result.skipped?.length) { lines.push('', 'Skipped (not mappable into the pool):'); for (const s of result.skipped) lines.push('  ' + s.label + ': ' + s.reason); }
 lines.push('', result.battles + ' battles in ' + result.seconds.toFixed(0) + ' s' + (result.workers ? ' on ' + result.workers + ' workers' : '') + (result.loadAverage ? ' · load average ' + result.loadAverage.map(x => x.toFixed(1)).join(' / ') : ''));
 return lines.join('\n');
}
async function poolPlay(jobs, hooks, workers) {
 const { BattlePool, availableCores } = require('../pool.cjs'), { BattleRunner } = require('../runner.cjs');
 if (workers > availableCores()) throw Error('workers exceeds the available cores');
 const pool = new BattlePool(workers, () => new BattleRunner({ workerFile: path.join(__dirname, '../battle-worker-v4.cjs'), heapMb: 192 }));
 try { return await pool.map(jobs, hooks); } finally { await pool.close(); }
}
async function main(argv) {
 const { opts, sources } = parseArgs(argv);
 if (opts.print) { console.log(formatTable(JSON.parse(fs.readFileSync(path.resolve(opts.print), 'utf8')))); return; }
 if (opts.help || !sources.length) { console.log('node training/next/policy-panel.cjs RUN_OR_REPORT[,…] [--scope finalists|primary] [--fixtures 32] [--workers 4] [--pool FILE] [--meta hybrid|independent|observed] [--usage-file JSON] [--usage-half-life-days N] [--usage-as-of YYYY-MM-DD] [--usage-prior-strength 500] [--meta-weight-power 1.25] [--seed N] [--belief-samples 3] [--lookahead-turns 24] [--decision-interval 4] [--reply-model worst|weighted] [--reply-temperature 0.25] [--rollout-continuation 0] [--bootstrap 5000] [--out FILE.json] | --print SAVED.json'); return; }
 checkSize(opts.fixtures);if (opts.fixtures < 2) throw Error('fixtures must be at least 2');
 const { digest, dataHash, mechanicsHash, atomic } = require('../team-search/common.cjs'), { loadChampions } = require('../team-search/champions.cjs'), { buildPanel, panelSeed } = require('../team-search/rematch.cjs');
 const pool = JSON.parse(fs.readFileSync(path.resolve(opts.pool), 'utf8')), check = { ...pool };delete check.hash;
 if (digest(check) !== pool.hash) throw Error('Pool hash mismatch');
 if (pool.config.inputHash !== dataHash()) throw Error('Pool data differs from bundled rankings, weights or Game Master');
 const found = loadChampions(sources, pool, { scope: opts.scope });
 if (!found.teams.length) throw Error('No team could be mapped into the pool' + (found.skipped.length ? ': ' + found.skipped.map(s => s.label + ': ' + s.reason).join('; ') : ''));
 const own = controllerOptions.searchController(opts), seed = panelSeed(opts.seed, found.sources.flatMap(s => s.usedSeeds)), panel = buildPanel(pool, opts, seed);
 const engine = { cp: 1500, beliefRoster: panel.beliefRoster, beliefTeams: panel.beliefTeams, beliefSamples: opts.beliefSamples, horizon: opts.lookaheadTurns, interval: opts.decisionInterval };
 const total = found.teams.length * panel.cases.length * STYLES.length;
 console.log('Policy panel · ' + found.teams.length + ' teams × ' + panel.cases.length + ' fixtures × ' + STYLES.length + ' styles = ' + total + ' battles · ' + opts.workers + ' workers · panel seed ' + seed);
 const result = await runPanel({ teams: found.teams.map(c => c.team.map(i => pool.variants[i])), ids: found.teams.map(c => c.team), labels: found.teams.map(c => c.label + ': ' + c.members.map(m => m.speciesName).join(' / ')), fixtures: panel.cases, engine, own, run: (jobs, hooks) => poolPlay(jobs, hooks, opts.workers), seed, bootstrapSeed: (seed + 1) >>> 0, samples: opts.bootstrap, log: console.log });
 Object.assign(result, { mechanicsHash: mechanicsHash({ version: 'v4', controller: own }), pool: { file: path.resolve(opts.pool), hash: pool.hash }, meta: panel.meta.description, components: panel.components, sources: found.sources.map(s => ({ file: s.file, label: s.label, kind: s.kind })), skipped: found.skipped, workers: opts.workers, loadAverage: require('node:os').loadavg() });
 const out = path.resolve(opts.out || path.join('training/runs', 'policy-panel-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '.json'));
 atomic(out, result);console.log('\n' + formatTable(result) + '\n\nSaved ' + out);
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message || e); process.exitCode = 1; });
module.exports = { STYLES, SEED_OFFSET, BOOTSTRAP_OFFSET, MAX_FIXTURES, FORMAT, checkSize, sideControllers, buildJobs, summarizeTeam, runPanel, compact, searchPanel, parseArgs, formatTable };
