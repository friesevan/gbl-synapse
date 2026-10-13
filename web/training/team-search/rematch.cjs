#!/usr/bin/env node
'use strict';
// Equal-footing rematch. Re-simulates the primaries (or every finalist) of two or more finished runs or reports on
// ONE fresh common opponent panel, under the current engine and a chosen meta, and compares them with paired
// bootstraps and simultaneous bands. Use it when two runs were made under different assumptions (controller, meta,
// seeds): their own final scores answer different questions and cannot be compared; a rematch can.
//
//   node training/team-search/rematch.cjs RUN_OR_REPORT RUN_OR_REPORT [...] [--finalists] [--meta hybrid]
//        [--usage-file F --usage-half-life-days N --usage-as-of D --usage-prior-strength N] [--fixtures 512]
//        [--seed N] [--workers 4] [--out FILE.json]
//
// Sources are run directories, recommendations.json, portable reports (.pvpteams.json.gz) or the v1 archive
// (team-search.json). Only compositions (species and moveset) are read; every score is re-simulated.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createMeta } = require('./meta.cjs');
const { digest, mechanicsHash, dataHash, guardedSeed, screeningSeed, teamKey, atomic } = require('./common.cjs');
const { summarize, compareFinalists } = require('./evaluation.cjs');
const { pairwiseBands } = require('./paired-stats.cjs');
const { loadChampions } = require('./champions.cjs');
const { defaults } = require('../utils.cjs');

const DEFAULTS = { pool: 'training/runs/team-search/pool.json', meta: 'hybrid', usageFile: '', usageHalfLifeDays: 0, usageAsOf: '', usagePriorStrength: 500, metaWeightPower: 1.25, fixtures: 512, seed: 0, workers: 4, beliefSamples: 3, lookaheadTurns: 24, decisionInterval: 4, bootstrap: 5000, out: '', print: '' };
const NUMBERS = new Set(Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k] === 'number'));

// Positional sources first or last, flags anywhere. --finalists and --help take no value.
function parseArgs(argv) {
 const opts = { ...DEFAULTS, finalists: false, help: false }, sources = [];
 for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help') { opts.help = true; continue; }
  if (a === '--finalists') { opts.finalists = true; continue; }
  if (!a.startsWith('--')) { sources.push(a); continue; }
  const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (!(key in DEFAULTS) || argv[i + 1] === undefined) throw Error('Unknown argument ' + a);
  opts[key] = NUMBERS.has(key) ? Number(argv[++i]) : argv[++i];
 }
 return { opts, sources };
}

function validate(opts, sourceCount) {
 for (const k of ['fixtures', 'workers', 'beliefSamples', 'lookaheadTurns', 'decisionInterval', 'bootstrap']) if (!Number.isInteger(opts[k]) || opts[k] < 1) throw Error(k + ' must be a positive integer');
 if (opts.bootstrap < 100) throw Error('bootstrap must be at least 100');
 if (opts.fixtures < 8) throw Error('fixtures must be at least 8; below about 64 only large differences can be resolved');
 if (!Number.isInteger(opts.seed) || opts.seed < 0 || opts.seed > 0xffffffff) throw Error('seed must fit an unsigned 32-bit integer (0 draws a fresh one)');
 if (sourceCount < 1) throw Error('Give at least one run directory or report (two or more to compare runs)');
}

// A fresh panel seed that no source's own screening or final panel used. An explicit seed that collides is refused:
// a team that was selected on a panel cannot be tested on it.
function panelSeed(requested, usedSeeds) {
 const used = new Set((usedSeeds || []).flatMap(s => [s >>> 0, screeningSeed(s)]));
 if (requested) { if (used.has(requested >>> 0)) throw Error('seed ' + requested + ' was a screening or final panel of one of the sources; choose a fresh seed'); return requested >>> 0; }
 let seed; do { seed = crypto.randomBytes(4).readUInt32LE(0) || 1; } while (used.has(seed));
 return seed;
}

function buildPanel(pool, opts, seed) {
 const meta = createMeta(pool.species, { mode: opts.meta, usageFile: opts.usageFile, weightPower: opts.metaWeightPower, halfLifeDays: opts.usageHalfLifeDays, asOf: opts.usageAsOf, priorStrength: opts.usagePriorStrength });
 const beliefSeed = guardedSeed((seed + 620001) >>> 0, [seed]);
 const cases = meta.fixtures(opts.fixtures, seed), components = {};
 for (const c of cases) components[c.component] = (components[c.component] || 0) + 1;
 return {
  meta, cases, components, beliefSeed,
  beliefRoster: pool.species.map(p => ({ speciesId: p.speciesId, dex: p.dex, moveset: p.moveset, weight: p.weight ** opts.metaWeightPower })),
  beliefTeams: meta.fixtures(2048, beliefSeed).map(c => c.team.map(p => p.speciesId)),
 };
}

async function defaultPlay(jobs, { workers, log, label = 'rematch' }) {
 const { BattlePool, availableCores } = require('../pool.cjs'), { BattleRunner } = require('../runner.cjs');
 if (workers > availableCores()) throw Error('workers exceeds the available cores');
 const pool = new BattlePool(workers, () => new BattleRunner({ workerFile: path.join(__dirname, '../battle-worker-v4.cjs'), heapMb: 192 }));
 let done = 0, last = Date.now();
 try {
  return await pool.map(jobs, { onResult: result => {
   if (result.timedOut) throw Error('Battle timeout: no fabricated draw accepted');
   if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) throw Error('Invalid battle score');
   if (++done && Date.now() - last > 10000) { last = Date.now(); log('[' + label + '] ' + done + '/' + jobs.length + ' battles'); }
  } });
 } finally { await pool.close(); }
}

async function rematch(opts, sources, { play = defaultPlay, log = console.log } = {}) {
 validate(opts, sources.length);
 const poolFile = path.resolve(opts.pool), pool = JSON.parse(fs.readFileSync(poolFile, 'utf8')), check = { ...pool };
 delete check.hash;
 if (digest(check) !== pool.hash) throw Error('Pool hash mismatch');
 if (pool.config.inputHash !== dataHash()) throw Error('Pool data differs from bundled rankings, weights or Game Master');
 const found = loadChampions(sources, pool, { scope: opts.finalists ? 'finalists' : 'primary' });
 if (found.teams.length < 2) throw Error(found.teams.length ? 'Only one distinct team survived mapping into the pool, so there is nothing to compare: ' + found.teams[0].label + (found.skipped.length ? ' (skipped: ' + found.skipped.map(s => s.label + ': ' + s.reason).join('; ') + ')' : '') + '. Identical compositions in two runs are a tie by construction.' : 'No team could be mapped into the pool' + (found.skipped.length ? ': ' + found.skipped.map(s => s.label + ': ' + s.reason).join('; ') : ''));
 const seed = panelSeed(opts.seed, found.sources.flatMap(s => s.usedSeeds)), panel = buildPanel(pool, opts, seed);
 const teams = found.teams.map((c, i) => ({ ...c, id: 't' + (i + 1) }));
 // Fixture-major order: if the process is stopped, every team has the same completed prefix.
 const jobs = [];
 for (const c of panel.cases) for (const t of teams) jobs.push([t.team.map(i => pool.variants[i]), c.team, defaults, defaults, { seed: c.seed, cp: 1500, beliefRoster: panel.beliefRoster, beliefTeams: panel.beliefTeams, beliefSamples: opts.beliefSamples, horizon: opts.lookaheadTurns, interval: opts.decisionInterval }]);
 log('Rematch · ' + teams.length + ' teams × ' + panel.cases.length + ' fixtures = ' + jobs.length + ' battles · ' + opts.workers + ' workers · meta ' + opts.meta + ' · panel seed ' + seed);
 const started = Date.now(), results = await play(jobs, { workers: opts.workers, log });
 if (!results || results.length !== jobs.length) throw Error('Rematch did not complete every battle');
 const scores = teams.map(() => []);
 results.forEach((r, index) => scores[index % teams.length].push(r.score));
 const rows = teams.map((t, i) => ({ ...summarize(scores[i], { team: t.team, fixtureSeed: seed, kind: 'rematch', paired: false }), id: t.id, scores: scores[i] }));
 const bands = pairwiseBands(rows.map(r => ({ id: r.id, scores: r.scores })), { seed: seed + 1, samples: opts.bootstrap });
 const reference = rows[0], versusReference = compareFinalists(reference, rows.slice(1), { seed: seed + 2, samples: opts.bootstrap });
 return {
  format: 'pvp-team-rematch', schemaVersion: 1, createdAt: new Date().toISOString(), seconds: (Date.now() - started) / 1000,
  engine: { version: 'neural-team-search-v4', mechanicsHash: mechanicsHash({ version: 'v4' }), lookaheadTurns: opts.lookaheadTurns, decisionInterval: opts.decisionInterval, beliefSamples: opts.beliefSamples },
  pool: { file: poolFile, hash: pool.hash }, meta: panel.meta.description,
  panel: { fixtures: panel.cases.length, seed, beliefSeed: panel.beliefSeed, components: panel.components, exploratory: panel.cases.length < 256 },
  scope: found.scope, sources: found.sources, skipped: found.skipped, reference: reference.id,
  teams: teams.map((t, i) => ({ id: t.id, label: t.label, team: t.team, key: teamKey(t.team), members: t.members, origins: t.sources, score: rows[i].score, standardError: rows[i].standardError, games: rows[i].games, wins: rows[i].wins, draws: rows[i].draws, losses: rows[i].losses, scores: rows[i].scores })),
  versusReference: { ...versusReference, primaryTeam: reference.team }, pairs: bands,
 };
}

const pc = x => (100 * x).toFixed(1), signed = x => (x >= 0 ? '+' : '') + pc(x);
function teamNames(t) { return t.members.map(m => m.speciesName || m.speciesId).join(' / '); }
function formatTable(result) {
 // One family of comparisons throughout: every pair, with the same simultaneous band. (versusReference in the JSON is the
 // narrower family of only reference-vs-others, valid when those were the only comparisons planned.)
 const lines = [], byId = new Map(result.teams.map(t => [t.id, t])), vs = new Map(result.pairs.pairs.filter(p => p.a === result.reference).map(p => [p.b, p]));
 lines.push('Rematch on ' + result.panel.fixtures + ' common fixtures · meta ' + result.meta.mode + (result.meta.observedCount ? ' (' + pc(result.meta.observedShare) + '% observed)' : '') + ' · panel seed ' + result.panel.seed + (result.panel.exploratory ? ' · EXPLORATORY: fewer than 256 fixtures' : ''));
 lines.push('Scores are simulated expected scores under this meta and the current v4 controller; they replace each run\'s own final score.');
 lines.push('');
 const head = ['#', 'Team (lead first)', 'Origin', 'Score', 'SE (pp)', 'W-D-L', 'vs ' + result.reference + ' [simultaneous 95%]', 'Verdict'], rows = [head];
 result.teams.slice().sort((a, b) => b.score - a.score).forEach(t => {
  const c = vs.get(t.id), origin = t.origins.map(o => o.source + (o.role === 'primary' ? '' : '#' + o.rank)).join(', ');
  rows.push([t.id, teamNames(t), origin, pc(t.score) + '%', pc(t.standardError ?? 0), t.wins + '-' + t.draws + '-' + t.losses, t.id === result.reference ? 'reference' : signed(-c.delta) + ' [' + signed(-c.simultaneous95[1]) + ', ' + signed(-c.simultaneous95[0]) + ']', t.id === result.reference ? '' : c.verdict === 'a-better' ? 'reference better' : c.verdict === 'b-better' ? 'this team better' : 'unresolved']);
 });
 const widths = head.map((_, j) => Math.max(...rows.map(r => String(r[j]).length)));
 for (const r of rows) lines.push(r.map((v, j) => String(v).padEnd(widths[j])).join('  ').trimEnd());
 const p = result.pairs;
 lines.push('', 'All ' + p.pairs.length + ' pairs: simultaneous 95% band half-width ' + pc(p.radius) + ' points (single-pair intervals are narrower; only the simultaneous band survives picking the best-looking pair).');
 if (p.pairs.length <= 21) for (const x of p.pairs) lines.push('  ' + byId.get(x.a).id + ' - ' + byId.get(x.b).id + ': ' + signed(x.delta) + ' [' + signed(x.simultaneous95[0]) + ', ' + signed(x.simultaneous95[1]) + ']  ' + (x.verdict === 'unresolved' ? 'unresolved (a tie at this panel size)' : x.verdict === 'a-better' ? byId.get(x.a).id + ' better' : byId.get(x.b).id + ' better'));
 if (result.skipped.length) { lines.push('', 'Skipped (not mappable into the current pool):'); for (const s of result.skipped) lines.push('  ' + s.label + ': ' + s.reason + ' · ' + s.detail); }
 return lines.join('\n');
}

async function main(argv) {
 const { opts, sources } = parseArgs(argv);
 if (opts.print) { console.log(formatTable(JSON.parse(fs.readFileSync(path.resolve(opts.print), 'utf8')))); return; }
 if (opts.help) { console.log('node training/team-search/rematch.cjs RUN_OR_REPORT RUN_OR_REPORT [...] [--finalists] [--pool FILE] [--meta hybrid|independent|observed] [--usage-file JSON] [--usage-half-life-days N] [--usage-as-of YYYY-MM-DD] [--usage-prior-strength 500] [--meta-weight-power 1.25] [--fixtures 512] [--seed N] [--workers 4] [--belief-samples 3] [--lookahead-turns 24] [--decision-interval 4] [--bootstrap 5000] [--out FILE.json] | --print SAVED.json'); return; }
 const result = await rematch(opts, sources);
 const out = path.resolve(opts.out || path.join('training/runs', 'rematch-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '.json'));
 atomic(out, result);
 console.log('\n' + formatTable(result) + '\n\nSaved ' + out);
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message || e); process.exitCode = 1; });
module.exports = { parseArgs, panelSeed, buildPanel, defaultPlay, rematch, formatTable, DEFAULTS };
