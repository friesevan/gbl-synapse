'use strict';
// End to end, with simulated battles: --reply-model / --rollout-continuation thread into every battle job, change
// the run's mechanics identity (so it never resumes, warm-starts or exports as the default controller), and
// --policy-panel N tests the finalists against six opponent styles after the final test, reaching the checkpoint,
// recommendations.json, report.html, findings.md and the portable report (validated like the viewer validates it).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { BattlePool } = require('../pool.cjs'), { search } = require('./search.cjs');
const { VERSION, dataHash, digest, mechanicsHash } = require('./common.cjs'), core = require('../../includes/pro/neural-report-core.js'), P = require('../next/policy-panel.cjs');
const { buildReport } = require('./export-report.cjs');

function writePool(file) {
 const gm = require('../../includes/pro/data/gamemaster.json'), published = require('../../includes/pro/data/league-1500.json').overall, used = new Set(), species = [];
 for (const row of published) {
  const p = gm.pokemon.find(p => p.speciesId === row.speciesId);
  if (!p || used.has(p.dex)) continue; used.add(p.dex);
  species.push({ speciesId: p.speciesId, speciesName: p.speciesName, dex: p.dex, types: p.types, moveset: row.moveset, weight: 1, features: [.5], scoutByType: Array(18).fill(.5), scoutScore: .5, ivs: { atk: 0, def: 15, hp: 15 }, cp: 1500, level: 30 });
  if (species.length === 8) break;
 }
 const prepared = { config: { version: VERSION, cp: 1500, inputHash: dataHash(), movesets: 1 }, species, variants: species }; prepared.hash = digest(prepared);
 fs.writeFileSync(file, JSON.stringify(prepared)); return prepared;
}
const clean = listeners => { for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener); };
const read = (out, name) => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));

test('controller options reach every battle and the identity; the policy panel reaches every report', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-controller-search-')), poolFile = path.join(dir, 'pool-source.json');writePool(poolFile);
 const original = BattlePool.prototype.map, listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)])), seen = [];
 // Deterministic fake battles. A panel battle (controllerTeams) shifts the score by its opponent style.
 BattlePool.prototype.map = async function (jobs, options = {}) {
  if (jobs.length && !Array.isArray(jobs[0][0])) return original.call(this, jobs, options);
  const results = jobs.map(([team, opponent, , , o]) => {
   seen.push(o);const base = parseInt(digest([team.map(p => p.speciesId), opponent.map(p => p.speciesId), o.seed]).slice(0, 2), 16) % 3 / 2;
   return { score: o.controllerTeams?.[1]?.shieldPolicy === 'never' ? 1 : base };
  });
  results.forEach((r, i) => (options.onResult || (() => {}))(r, i));
  return results;
 };
 try {
  const opts = { pool: poolFile, hours: 1, workers: 1, initialTeams: 16, batchTeams: 4, opponents: 6, acquisitionFixtures: 2, promotionFraction: .5, screenTeams: 2, screenOpponents: 4, validationTeams: 2, validationOpponents: 8, baselineCount: 3, candidates: 32, epochs: 2, hidden: 4, ensemble: 3, referenceOpponents: 4, fitFixtures: 64, seed: 321, validationSeed: 905, rounds: 2, meta: 'independent', lookaheadTurns: 4, decisionInterval: 4, beliefSamples: 1 };
  const plainOut = path.join(dir, 'plain'), variantOut = path.join(dir, 'weighted');
  await search({ ...opts, out: plainOut });clean(listeners);
  const plainJobs = seen.splice(0);
  await search({ ...opts, out: variantOut, replyModel: 'weighted', replyTemperature: .25, rolloutContinuation: 0, policyPanel: 4 });clean(listeners);
  const variantJobs = seen.splice(0), plain = read(plainOut, 'checkpoint.json'), state = read(variantOut, 'checkpoint.json');

  // The default run is untouched: no controller keys anywhere, the plain v4 mechanics id, no panel.
  assert.equal(plain.config.controller, undefined);assert.equal(plain.config.policyPanel, undefined);assert.equal(plain.config.mechanicsHash, mechanicsHash({ version: 'v4' }));
  assert.ok(plainJobs.every(o => !('replyModel' in o) && !('controllerTeams' in o)));assert.equal(plain.policyPanel, undefined);assert.equal(read(plainOut, 'recommendations.json').policyPanel, undefined);
  // The weighted run: identity, every search, screening and final battle under the same controller on both sides.
  assert.deepEqual(state.config.controller, { replyModel: 'weighted', replyTemperature: .25 });
  assert.equal(state.config.mechanicsHash, mechanicsHash({ version: 'v4' }) + '+controller:replyModel=weighted,replyTemperature=0.25');
  const panelJobs = variantJobs.filter(o => o.controllerTeams), labelJobs = variantJobs.filter(o => !o.controllerTeams);
  assert.equal(labelJobs.length, plainJobs.length);assert.ok(labelJobs.every(o => o.replyModel === 'weighted' && o.replyTemperature === .25));
  // The panel: finalists x fixtures x styles, the finalists keep the run's controller, opponents take each style.
  assert.equal(panelJobs.length, state.validations.length * 4 * P.STYLES.length);
  assert.ok(panelJobs.every(o => JSON.stringify(o.controllerTeams[0]) === JSON.stringify({ replyModel: 'weighted', replyTemperature: .25 }) && !('replyModel' in o)));
  assert.equal(state.config.policyPanel, 4);assert.equal(state.policyPanel.fixtures.completed, 4);assert.equal(state.policyPanel.teams.length, state.validations.length);
  assert.deepEqual(state.policyPanel.teams.map(t => t.team), state.validations.map(v => v.team));assert.equal(state.policyPanel.own.label, 'replyModel=weighted, replyTemperature=0.25');
  assert.ok(state.policyPanel.teams.every(t => t.scores['never-shield'] === 1 && t.fixtureScores.length === P.STYLES.length));
  assert.equal(state.battles, plain.battles + panelJobs.length);
  // The panel changes nothing about selection or the final test.
  assert.deepEqual(state.finalistTeams, plain.finalistTeams);assert.deepEqual(state.validations, plain.validations);

  const recommendations = read(variantOut, 'recommendations.json');assert.equal(recommendations.policyPanel.teams.length, state.validations.length);assert.equal(recommendations.policyPanel.teams[0].fixtureScores, undefined);
  assert.match(fs.readFileSync(path.join(variantOut, 'report.html'), 'utf8'), /<h2>Opponent policy styles<\/h2>/);
  assert.match(fs.readFileSync(path.join(variantOut, 'findings.md'), 'utf8'), /Opponent policy styles \(4 fixtures x 6 styles/);
  const portable = core.validate(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(variantOut, 'report.pvpteams.json.gz')))));
  assert.equal(portable.mechanicsHash, state.config.mechanicsHash);assert.equal(portable.engineOptions.replyModel, 'weighted');assert.equal(portable.engineOptions.replyTemperature, .25);
  assert.equal(portable.policyPanel.teams.length, state.validations.length);assert.equal(portable.policyPanel.teams[0].fixtureScores, undefined);
  const plainPortable = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(plainOut, 'report.pvpteams.json.gz'))));
  assert.equal(plainPortable.policyPanel, undefined);assert.equal(plainPortable.engineOptions.replyModel, undefined);assert.equal(plainPortable.mechanicsHash, mechanicsHash({ version: 'v4' }));

  // Never as the default controller: no resume, no warm start, no export under a stripped identity.
  await assert.rejects(search({ ...opts, out: plainOut, resume: true, replyModel: 'weighted' }), /Resume requires/);clean(listeners);
  await assert.rejects(search({ ...opts, out: path.join(dir, 'warm'), warmStart: path.join(plainOut, 'checkpoint.json'), validationSeed: 977, replyModel: 'weighted' }), /same simulator version, mechanics and meta/);clean(listeners);
  await assert.rejects(search({ ...opts, out: path.join(dir, 'warm2'), warmStart: path.join(variantOut, 'checkpoint.json'), validationSeed: 979 }), /same simulator version, mechanics and meta/);clean(listeners);
  const pool = JSON.parse(fs.readFileSync(path.join(variantOut, 'pool.json'), 'utf8')), stripped = { ...state, config: { ...state.config } };delete stripped.config.controller;
  assert.throws(() => buildReport(stripped, pool), /original simulator/);
  assert.throws(() => buildReport({ ...plain, config: { ...plain.config, controller: { rolloutContinuation: 8 } } }, JSON.parse(fs.readFileSync(path.join(plainOut, 'pool.json'), 'utf8'))), /original simulator/);
 } finally { BattlePool.prototype.map = original; clean(listeners); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('the detached launcher and the search accept the controller and policy-panel options', () => {
 for (const script of ['launch.cjs', 'search.cjs']) {
  const out = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, script), '--reply-model', 'weighted', '--reply-temperature', '0.5', '--rollout-continuation', '8', '--policy-panel', '64', '--help'], { encoding: 'utf8' });
  assert.equal(out.status, 0, script + ': ' + out.stderr);
 }
});
