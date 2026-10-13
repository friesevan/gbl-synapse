'use strict';
// End to end, with simulated battles: a search given --champions tests them as the `previous-champions` baseline group
// on the sealed final panel, and the group reaches checkpoint, recommendations.json, report.html, findings.md and the
// portable report (validated by neural-report-core, the same validator the viewer uses).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { BattlePool } = require('../pool.cjs'), { search } = require('./search.cjs');
const { VERSION, dataHash, digest, teamKey } = require('./common.cjs'), core = require('../../includes/pro/neural-report-core.js');

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
const lineup = (pool, ...i) => i.map(k => ({ speciesId: pool.species[k].speciesId, speciesName: pool.species[k].speciesName, moveset: pool.species[k].moveset }));
const clean = listeners => { for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener); };

test('champions join the sealed final panel as a baseline group without changing the primary, and reach every report', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-champions-search-')), poolFile = path.join(dir, 'pool-source.json'), pool = writePool(poolFile);
 const original = BattlePool.prototype.map, listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
 // Deterministic fake battles; fitting uses the real worker pool with non-battle payloads.
 BattlePool.prototype.map = async function (jobs, options = {}) {
  if (jobs.length && !Array.isArray(jobs[0][0])) return original.call(this, jobs, options);
  const results = jobs.map(([team, opponent, , , o]) => ({ score: parseInt(digest([team.map(p => p.speciesId), opponent.map(p => p.speciesId), o.seed]).slice(0, 2), 16) % 3 / 2 }));
  results.forEach((r, i) => (options.onResult || (() => {}))(r, i));
  return results;
 };
 try {
  const champions = path.join(dir, 'champions.json'), ghost = lineup(pool, 0, 1, 2).map((m, i) => i === 2 ? { ...m, speciesId: 'not_in_this_pool' } : m);
  fs.writeFileSync(champions, JSON.stringify({ rows: [{ team: lineup(pool, 0, 1, 2), validation: { score: .8 } }, { team: lineup(pool, 3, 4, 5), validation: { score: .7 } }, { team: ghost, validation: { score: .6 } }] }));
  const opts = { pool: poolFile, hours: 1, workers: 1, initialTeams: 16, batchTeams: 4, opponents: 6, acquisitionFixtures: 2, promotionFraction: .5, screenTeams: 2, screenOpponents: 4, validationTeams: 2, validationOpponents: 8, baselineCount: 3, candidates: 32, epochs: 2, hidden: 4, ensemble: 3, referenceOpponents: 4, fitFixtures: 64, seed: 123, validationSeed: 903, rounds: 2, meta: 'independent', lookaheadTurns: 4, decisionInterval: 4, beliefSamples: 1 };
  const read = (out, name) => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8')), plainOut = path.join(dir, 'plain'), champOut = path.join(dir, 'champions');
  await search({ ...opts, out: plainOut });clean(listeners);
  await search({ ...opts, out: champOut, champions, championsScope: 'finalists' });clean(listeners);
  const plain = read(plainOut, 'checkpoint.json'), state = read(champOut, 'checkpoint.json');

  // Registration: two teams mapped, the one with a species outside the pool is reported, not dropped silently.
  assert.equal(plain.champions, undefined);assert.equal(plain.comparisons['previous-champions'], undefined);assert.equal(plain.championComparisons ?? null, null);
  assert.deepEqual(state.champions.teams.map(c => c.team), [[0, 1, 2], [3, 4, 5]]);assert.equal(state.champions.skipped.length, 1);assert.equal(state.champions.skipped[0].reason, 'species-not-in-pool');assert.equal(state.champions.scope, 'finalists');
  // The champion rows are in the baseline results with their own kind, on the same sealed fixtures as the finalists.
  const rows = state.baselineResults.filter(b => b.kind === 'previous-champions');
  assert.equal(rows.length, 2);assert.deepEqual(rows.map(r => r.team), [[0, 1, 2], [3, 4, 5]]);assert.ok(rows.every(r => r.fixtureSeed === state.validations[0].fixtureSeed && r.pairs.length === state.validations[0].pairs.length));
  assert.equal(state.baselineResults.filter(b => b.kind !== 'previous-champions').length, 3);
  // The group is compared like the other groups; the champion-by-champion table agrees with the group's data.
  const group = state.comparisons['previous-champions'];assert.equal(group.baselineTeams, 2);assert.equal(group.fixtures, 8);assert.ok(group.interval95[0] <= group.delta && group.delta <= group.interval95[1]);
  assert.ok(Math.abs(group.delta - (state.validations[0].score - (rows[0].score + rows[1].score) / 2)) < 1e-12);
  assert.equal(state.championComparisons.entries.length, 2);assert.ok(['primary-better', 'tie-rediscovered', 'champion-better', 'unresolved'].includes(state.championComparisons.outcome));assert.equal(state.championComparisons.fixtures, 8);
  // Adding champions changes nothing about the search itself or the primary's final score.
  assert.deepEqual(state.config, plain.config);assert.deepEqual(state.records, plain.records);assert.deepEqual(state.finalistTeams, plain.finalistTeams);assert.deepEqual(state.validations, plain.validations);
  assert.deepEqual(state.baselineResults.filter(b => b.kind !== 'previous-champions'), plain.baselineResults);assert.equal(state.battles, plain.battles + (state.finalPanel.teams - plain.finalPanel.teams) * 8);
  assert.ok(state.finalPanel.teams >= plain.finalPanel.teams);assert.ok(state.finalPanel.teams <= plain.finalPanel.teams + 2);

  // recommendations.json, report.html and findings.md.
  const recommendations = read(champOut, 'recommendations.json');assert.equal(recommendations.champions.teams.length, 2);assert.equal(recommendations.championComparisons.entries.length, 2);assert.ok(recommendations.comparisons['previous-champions']);
  assert.equal(read(plainOut, 'recommendations.json').champions, null);
  const html = fs.readFileSync(path.join(champOut, 'report.html'), 'utf8'), md = fs.readFileSync(path.join(champOut, 'findings.md'), 'utf8');
  assert.match(html, /<h2>Previous champions<\/h2>/);assert.match(html, /previous-champions<\/strong>: /);assert.match(html, /Not tested \(could not be mapped into this pool\)/);assert.match(html, /<td>previous-champions<\/td>/);
  assert.match(md, /Previous champions: /);assert.match(md, /Not tested: .*species-not-in-pool/);assert.match(md, /Versus previous-champions:/);
  assert.doesNotMatch(fs.readFileSync(path.join(plainOut, 'report.html'), 'utf8'), /Previous champions/);assert.doesNotMatch(fs.readFileSync(path.join(plainOut, 'findings.md'), 'utf8'), /Previous champions/);

  // Portable report: validated by the viewer's own validator; the group and the per-champion table are there.
  const report = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(champOut, 'report.pvpteams.json.gz'))));core.validate(report);
  assert.ok(report.baselines['previous-champions']);assert.equal(report.champions.teams.length, 2);assert.equal(report.champions.skipped.length, 1);assert.equal(report.champions.comparisons.entries.length, 2);
  assert.deepEqual(report.champions.teams.map(c => c.team), [[0, 1, 2], [3, 4, 5]]);
  const championRows = report.table.rows.filter(r => r.baseline === 'previous-champions');assert.equal(championRows.length, 2);assert.ok(championRows.every(r => Number.isFinite(r.test)));
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(plainOut, 'report.pvpteams.json.gz')))).champions, null);

  // A resumed run keeps the champions its checkpoint registered (the flag is not needed again and cannot swap them).
  await search({ ...opts, out: champOut, resume: true, champions: 'none' });clean(listeners);
  const resumed = read(champOut, 'checkpoint.json');assert.equal(resumed.champions.fingerprint, state.champions.fingerprint);assert.equal(resumed.baselineResults.filter(b => b.kind === 'previous-champions').length, 2);
  assert.equal(teamKey(resumed.championComparisons.entries[0].team), teamKey(state.championComparisons.entries[0].team));
 } finally { BattlePool.prototype.map = original; clean(listeners); fs.rmSync(dir, { recursive: true, force: true }); }
});
