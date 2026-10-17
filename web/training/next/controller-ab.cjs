#!/usr/bin/env node
'use strict';
// Head-to-head check of two v4 controllers (the controller-check.cjs pattern: both rosters, both controllers).
// Each search-shaped fixture is played twice: roster X under controller A against roster Y under controller B, then
// the rosters swapped (Y under A against X under B). A's share is the mean of its two results; parity is 50%.
// The same fixtures are also played with the default controller on both sides, which gives the reference time
// per battle and how many battles the change alters at all. Exploratory: an interval says whether one controller
// beats the other in this simulator, not whether it plays more like a human.
//
//   node training/next/controller-ab.cjs --b replyModel=weighted [--a default] [--fixtures 64] [--workers 4]
//        [--pool FILE] [--usage-file F --usage-half-life-days 30 --usage-as-of YYYY-MM-DD --usage-prior-strength N]
//        [--seed 20261013] [--out FILE.json]
// A controller is `default`, `key=value,…` (replyModel, replyTemperature, rolloutContinuation, switchMargin,
// shieldPolicy) or JSON.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const controllerOptions = require('./controller-options.cjs');

const DEFAULTS = { a: 'default', b: 'default', fixtures: 64, workers: 4, pool: 'training/runs/team-search/pool.json', usageFile: '', usageHalfLifeDays: 0, usageAsOf: '', usagePriorStrength: 500, seed: 20261013, out: '' };
function parseArgs(argv) {
 const opts = { ...DEFAULTS };
 for (let i = 0; i < argv.length; i++) {
  const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (!argv[i].startsWith('--') || !(key in DEFAULTS) || argv[i + 1] === undefined) throw Error('Unknown argument ' + argv[i]);
  opts[key] = typeof DEFAULTS[key] === 'number' ? Number(argv[++i]) : argv[++i];
 }
 return opts;
}
function parseController(text) {
 if (!text || text === 'default') return null;
 const raw = text.trim().startsWith('{') ? JSON.parse(text) : Object.fromEntries(text.split(',').map(kv => { const [k, v] = kv.split('='); return [k.trim(), v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : (v || '').trim()]; }));
 controllerOptions.teamControllerPick(raw, true, 'controller');
 return controllerOptions.teamControllerIdentity(raw);
}
// Jobs for one pair of controllers: per fixture [X under a vs Y under b, Y under a vs X under b].
function pairJobs(fixtures, a, b) {
 const sides = a || b ? { controllerTeams: [a, b] } : {};
 return fixtures.flatMap(([x, y, px, py, o]) => [[x, y, px, py, { ...o, ...sides }], [y, x, py, px, { ...o, ...sides }]]);
}
const sum = (rows, key) => rows.reduce((s, r) => s + (r.planner?.[key] || 0), 0);
function summarize(rows, n) {
 const pairs = Array.from({ length: n }, (_, i) => (rows[2 * i].score + rows[2 * i + 1].score) / 2), mean = pairs.reduce((s, p) => s + p, 0) / n;
 const se = n > 1 ? Math.sqrt(pairs.reduce((s, p) => s + (p - mean) ** 2, 0) / (n - 1) / n) : 0;
 const planner = {}; for (const key of ['decisions', 'branches', 'branchCacheHits', 'switches', 'forced', 'beliefWorlds', 'rolloutSteps', 'continuations', 'continuationDuels', 'continuationSteps']) { const v = sum(rows, key); if (v || key in (rows[0].planner || {})) planner[key] = v; }
 return { aShare: mean, interval95: [mean - 1.96 * se, mean + 1.96 * se], pairs, timeouts: rows.filter(r => r.timedOut).length, planner };
}
async function main(argv) {
 const opts = parseArgs(argv), a = parseController(opts.a), b = parseController(opts.b);
 const { BattlePool, availableCores } = require('../pool.cjs'), { BattleRunner } = require('../runner.cjs'), { searchFixtures } = require('../simulator-fixtures.cjs'), { mechanicsHash } = require('../team-search/common.cjs');
 if (!Number.isInteger(opts.fixtures) || opts.fixtures < 2 || !Number.isInteger(opts.workers) || opts.workers < 1 || opts.workers > availableCores()) throw Error('fixtures must be at least 2 and workers within the available cores');
 const pool = opts.pool && fs.existsSync(path.resolve(opts.pool)) ? JSON.parse(fs.readFileSync(path.resolve(opts.pool), 'utf8')) : null;
 const fixtures = searchFixtures(opts.fixtures, { pool, usageFile: opts.usageFile, usageHalfLifeDays: opts.usageHalfLifeDays, usageAsOf: opts.usageAsOf, usagePriorStrength: opts.usagePriorStrength, seed: opts.seed });
 const workers = new BattlePool(opts.workers, () => new BattleRunner({ workerFile: path.join(__dirname, '../battle-worker-v4.cjs'), heapMb: 192 }));
 const timed = async jobs => { const start = Date.now(), rows = await workers.map(jobs); return { rows, seconds: (Date.now() - start) / 1000 }; };
 const loadBefore = os.loadavg();
 try {
  // Alternate the order so that a load change during the run does not favour one arm's timing.
  const reference = await timed(pairJobs(fixtures, null, null)), test = await timed(pairJobs(fixtures, a, b)), reference2 = await timed(pairJobs(fixtures, null, null));
  if (JSON.stringify(reference.rows.map(r => r.score)) !== JSON.stringify(reference2.rows.map(r => r.score))) throw Error('Default battles are not reproducible');
  const result = {
   format: 'pvp-controller-ab', createdAt: new Date().toISOString(), a: { controller: a, label: controllerOptions.describe(a) }, b: { controller: b, label: controllerOptions.describe(b) },
   mechanicsHash: mechanicsHash({ version: 'v4' }), fixtures: opts.fixtures, fixtureSeed: opts.seed, pool: pool ? { file: path.resolve(opts.pool), hash: pool.hash } : null, usage: opts.usageFile ? { file: opts.usageFile, halfLifeDays: opts.usageHalfLifeDays, asOf: opts.usageAsOf, priorStrength: opts.usagePriorStrength } : null,
   battles: test.rows.length, workers: opts.workers, ...summarize(test.rows, opts.fixtures),
   reference: { aShare: summarize(reference.rows, opts.fixtures).aShare, planner: summarize(reference.rows, opts.fixtures).planner, seconds: [reference.seconds, reference2.seconds] },
   changedBattles: test.rows.filter((r, i) => r.score !== reference.rows[i].score || r.turns !== reference.rows[i].turns).length,
   seconds: test.seconds, timeRatio: test.seconds / ((reference.seconds + reference2.seconds) / 2), loadAverage: { before: loadBefore, after: os.loadavg() },
   note: 'Both controllers get both rosters for each fixture (controllerTeams). Search-shaped fixtures; small-sample normal interval; exploratory. timeRatio compares wall time with the default-vs-default reference on the same fixtures (run before and after), so it is sensitive to machine load.',
  };
  delete result.pairs;
  const out = path.resolve(opts.out || path.join('training/runs', 'controller-ab-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 1));console.log('Saved ' + out);
 } finally { await workers.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message || e); process.exitCode = 1; });
module.exports = { parseArgs, parseController, pairJobs, summarize };
