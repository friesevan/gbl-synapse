'use strict';
// The real search loop with the meta-sensitivity panel (--sensitivity-fixtures). Battles are replaced by a deterministic hash of
// (team, opponent, seed), so a run with the panel and the same run without it can be compared exactly.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { BattlePool } = require('../pool.cjs'), { search } = require('./search.cjs'), S = require('./sensitivity.cjs'), { createMeta } = require('./meta.cjs');
const core = require('../../includes/pro/neural-report-core.js'), { VERSION, dataHash, digest, teamKey, screeningSeed } = require('./common.cjs');
const ctx = require('node:vm').createContext({});
require('node:vm').runInContext(fs.readFileSync(path.join(__dirname, '../../includes/pro/neural-portable.js'), 'utf8'), ctx);

function testPool(poolPath) {
 const gm = require('../../includes/pro/data/gamemaster.json'), published = require('../../includes/pro/data/league-1500.json').overall, used = new Set(), species = [];
 for (const row of published) { const p = gm.pokemon.find(p => p.speciesId === row.speciesId); if (!p || used.has(p.dex)) continue; used.add(p.dex); species.push({ speciesId: p.speciesId, speciesName: p.speciesName, dex: p.dex, types: p.types, moveset: row.moveset, weight: 1, features: [.5], scoutByType: Array(18).fill(.5), scoutScore: .5, ivs: { atk: 0, def: 15, hp: 15 }, cp: 1500, level: 30 }); if (species.length === 6) break; }
 const prepared = { config: { version: VERSION, cp: 1500, inputHash: dataHash(), movesets: 1 }, species, variants: species }; prepared.hash = digest(prepared); fs.writeFileSync(poolPath, JSON.stringify(prepared)); return { species, prepared };
}
const REAL_MAP = BattlePool.prototype.map, identityOf = (team, opponent, seed) => digest([team.map(p => p.speciesId), opponent.map(p => p.speciesId), seed]);
const listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
const dropListeners = () => { for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener); };
const read = (out, name = 'checkpoint.json') => JSON.parse(fs.readFileSync(path.join(out, name)));

// Deterministic battles that honour shouldStop. `interrupt` = {jobs, after}: in the call that has `jobs` jobs, send SIGINT after `after` of them.
function mockBattles({ interrupt = null } = {}) {
 const log = { calls: [] };
 BattlePool.prototype.map = async function (jobs, options = {}) {
  if (jobs.length && !Array.isArray(jobs[0][0])) return REAL_MAP.call(this, jobs, options);
  const { onResult = () => {}, shouldStop = () => false } = options, results = [], call = { size: jobs.length, jobs: [] };
  log.calls.push(call);
  for (let i = 0; i < jobs.length; i++) {
   if (shouldStop()) return null;
   const [team, opponent, , , settings] = jobs[i], id = identityOf(team, opponent, settings.seed);
   call.jobs.push({ team: team.map(p => p.speciesId), opponent: opponent.map(p => p.speciesId), seed: settings.seed, beliefSamples: settings.beliefSamples, horizon: settings.horizon });
   const result = { score: parseInt(id.slice(0, 2), 16) % 3 / 2 }; results.push(result); onResult(result, i);
   if (interrupt && jobs.length === interrupt.jobs && i + 1 === interrupt.after) process.emit('SIGINT');
  }
  return results;
 };
 return { log, restore: () => { BattlePool.prototype.map = REAL_MAP; } };
}
const base = poolPath => ({ pool: poolPath, hours: 1, workers: 1, initialTeams: 8, batchTeams: 4, opponents: 6, acquisitionFixtures: 1, promotionFraction: .5, screenTeams: 3, screenOpponents: 2, validationTeams: 2, validationOpponents: 2, baselineCount: 3, candidates: 8, epochs: 1, hidden: 4, ensemble: 1, referenceOpponents: 2, fitFixtures: 16, seed: 123, validationSeed: 902, rounds: 1, meta: 'independent', lookaheadTurns: 4, decisionInterval: 4, beliefSamples: 1 });

test('the panel runs after the final test, changes nothing else, and lands in the checkpoint, recommendations, reports and viewer', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-sens-search-')), poolPath = path.join(directory, 'source-pool.json'), { species } = testPool(poolPath);
 try {
  const opts = base(poolPath);
  let mock = mockBattles();const without = path.join(directory, 'without');await search({ ...opts, out: without });dropListeners();const reference = read(without), referenceCalls = mock.log.calls.slice();mock.restore();
  assert.equal(reference.sensitivity, null);assert.equal(read(without, 'recommendations.json').sensitivity, null);assert.equal('sensitivityFixtures' in reference.config, false);
  mock = mockBattles();const withPanel = path.join(directory, 'with');await search({ ...opts, out: withPanel, sensitivityFixtures: 3 });dropListeners();const state = read(withPanel), calls = mock.log.calls.slice();mock.restore();
  // Everything the search produced before the panel is byte-identical: same training evidence, screening, final test and baselines.
  const stable = h => h.map(r => ({ round: r.round, battles: r.battles, teams: r.teams, bestTraining: r.bestTraining, proposalScores: r.proposalScores, acquisition: r.acquisition }));assert.deepEqual(stable(state.history), stable(reference.history));
  for (const key of ['observations', 'records', 'screenResults', 'validations', 'baselineResults', 'finalistTeams', 'finalPanel', 'comparisons', 'finalistComparisons', 'fixturePanels']) assert.deepEqual(state[key], reference[key], key);
  assert.deepEqual(calls.slice(0, referenceCalls.length), referenceCalls);
  assert.equal(calls.length, referenceCalls.length + 1);
  // The panel: 2 finalists x 4 metas (independent 1.25 / coherent / independent 1.0 / 1.5; no usage file) x 3 fixtures.
  const panel = calls.at(-1);assert.equal(panel.size, 2 * 4 * 3);assert.equal(state.battles, reference.battles + 24);
  assert.deepEqual(state.config.sensitivityFixtures, 3);assert.equal(state.config.sensitivityGroups, 'finalists');
  const block = state.sensitivity;
  assert.equal(block.version, 1);assert.equal(block.requestedFixtures, 3);assert.equal(block.fixtures, 3);assert.equal(block.complete, true);assert.equal(block.groups, 'finalists');
  assert.deepEqual(block.metas.map(m => m.id), ['independent-1.25', 'coherent', 'independent-1.0', 'independent-1.5']);
  assert.deepEqual(block.teams.map(t => teamKey(t.team)), state.validations.map(v => teamKey(v.team)));
  assert.deepEqual(block.teams.map(t => t.primary), [true, false]);assert.equal(teamKey(block.teams[0].team), teamKey(state.finalistTeams[0]));
  block.teams.forEach((t, i) => { assert.equal(t.finalScore, state.validations[i].score);assert.equal(t.scores.length, 4);assert.ok(t.min <= t.mean && t.mean <= t.max);assert.ok(Math.abs(t.spread - (t.max - t.min)) < 1e-12);assert.ok(block.metas.some(m => m.id === t.minMeta)); });
  // Seeds: derived from the validation seed, all distinct, none a seed the search already sealed.
  const config = state.config, sealed = [902, screeningSeed(902), config.retestPanelSeed, config.referenceFixtureSeed, config.beliefFixtureSeed, config.baselineFixtureSeed].filter(Number.isInteger);
  assert.equal(new Set(block.metas.map(m => m.seed)).size, 4);assert.ok(block.metas.every(m => !sealed.includes(m.seed)));
  assert.deepEqual(Object.fromEntries(block.metas.map(m => [m.id, m.seed])), S.sensitivitySeeds(902, block.metas.map(m => m.id), sealed.slice(2)));
  // The jobs are the meta panels, interleaved fixture by fixture, with the run's controller settings; every team plays the same list.
  const specs = Object.fromEntries(S.metaSpecs(species, {}).specs.map(s => [s.id, s]));
  const expected = block.metas.map(m => createMeta(species, specs[m.id].options).fixtures(3, m.seed));
  panel.jobs.forEach((job, index) => { const team = index % 2, position = Math.floor(index / 2), meta = position % 4, fixture = Math.floor(position / 4);
   assert.equal(job.seed, expected[meta][fixture].seed);assert.deepEqual(job.opponent, expected[meta][fixture].team.map(p => p.speciesId));assert.equal(job.beliefSamples, 1);assert.equal(job.horizon, 4);assert.deepEqual(job.team, state.validations[team].team.map(i => species[i].speciesId)); });
  // Fixture noise only: raw fixture scores are in the checkpoint and reproduce the recorded means.
  for (const m of block.metas) block.teams.forEach((t, ti) => { const raw = state.sensitivityScores[m.id][teamKey(t.team)];assert.equal(raw.length, 3);assert.ok(Math.abs(raw.reduce((a, b) => a + b, 0) / 3 - t.scores[block.metas.indexOf(m)]) < 1e-12); });
  // recommendations.json, report.html, findings.md and the portable report carry it beside finalPanel.
  const recommendations = read(withPanel, 'recommendations.json');assert.deepEqual(recommendations.sensitivity, block);assert.deepEqual(Object.keys(recommendations).slice(Object.keys(recommendations).indexOf('finalPanel'), Object.keys(recommendations).indexOf('finalPanel') + 2), ['finalPanel', 'sensitivity']);
  const html = fs.readFileSync(path.join(withPanel, 'report.html'), 'utf8'), findings = fs.readFileSync(path.join(withPanel, 'findings.md'), 'utf8');
  assert.match(html, /<h2>Meta sensitivity<\/h2>/);assert.match(html, /independent-1\.5/);assert.match(html, /Primary · /);assert.match(html, /fixture noise alone gives a spread of about/);
  assert.match(findings, /Meta sensitivity: 4 alternative metas × 3 fixtures per team/);assert.match(findings, /across 4 metas: min \d+\.\d%, spread \d+\.\d points/);
  assert.doesNotMatch(fs.readFileSync(path.join(without, 'report.html'), 'utf8'), /Meta sensitivity/);assert.doesNotMatch(fs.readFileSync(path.join(without, 'findings.md'), 'utf8'), /Meta sensitivity/);
  const gz = path.join(withPanel, 'report.pvpteams.json.gz');assert.ok(fs.existsSync(gz), 'the portable report was written');
  const report = JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)));
  assert.deepEqual(report.sensitivity, block);assert.equal(report.schemaVersion, 1);assert.equal(core.validate(report), report);
  assert.deepEqual(Object.keys(report).slice(Object.keys(report).indexOf('finalPanel'), Object.keys(report).indexOf('finalPanel') + 2), ['finalPanel', 'sensitivity']);
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(without, 'report.pvpteams.json.gz')))).sensitivity, null);
  // The viewer: the table and the finalist line, built from the same block.
  const names = team => team.map(i => report.table.variants[i].speciesName).join(' / '), table = ctx.NeuralPortable.sensitivityTable(report, names), notes = ctx.NeuralPortable.sensitivityNotes(report);
  assert.equal(table.rows.length, 2);assert.equal(table.header.length, 1 + 4 + 5);assert.match(table.rows[0][0], /^Primary · /);assert.doesNotMatch(table.rows[1][0], / \((Random teams|Popularity|Simple coverage|Previous champions)/);
  for (const t of block.teams) { const line = S.line(t, block);assert.equal(ctx.NeuralPortable.sensitivityLine(t, block), line);assert.equal(notes.get([t.team[0], ...t.team.slice(1).sort((a, b) => a - b)].join(',')), line); }
  assert.equal(table.caption, S.caption(block));
 } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('groups all adds the baseline teams once; a deadline leaves every meta with the same completed prefix', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-sens-search-')), poolPath = path.join(directory, 'source-pool.json');testPool(poolPath);
 try {
  const opts = { ...base(poolPath), sensitivityFixtures: 3, sensitivityGroups: 'all' };
  let mock = mockBattles();const all = path.join(directory, 'all');await search({ ...opts, out: all });dropListeners();const state = read(all), calls = mock.log.calls.slice();mock.restore();
  const kinds = state.sensitivity.teams.map(t => t.kind), unique = new Set([...state.validations, ...state.baselineResults].map(r => teamKey(r.team))).size;
  assert.equal(state.sensitivity.teams.length, unique);assert.equal(kinds.filter(k => k === 'finalist').length, 2);assert.ok(kinds.includes('uniform-random'));assert.equal(state.sensitivity.groups, 'all');
  assert.equal(calls.at(-1).size, unique * 4 * 3);assert.equal(new Set(state.sensitivity.teams.map(t => teamKey(t.team))).size, unique);
  const table = ctx.NeuralPortable.sensitivityTable({ sensitivity: state.sensitivity }, t => t.join('/'));
  assert.ok(table.rows.some(r => / \(Random teams\)$/.test(r[0])));assert.equal(ctx.NeuralPortable.sensitivityNotes({ sensitivity: state.sensitivity }).size, 2);
  // SIGINT after 9 positions of the 12-position sweep (two teams): K = 4, so each meta keeps 2 fixtures and the run says it is partial.
  const teams = state.sensitivity.teams.length, stopAfter = teams * 9 + 1;
  mock = mockBattles({ interrupt: { jobs: teams * 12, after: stopAfter } });const cut = path.join(directory, 'cut');await search({ ...opts, out: cut });dropListeners();const partial = read(cut);mock.restore();
  assert.equal(partial.sensitivity.fixtures, 2);assert.equal(partial.sensitivity.complete, false);assert.equal(partial.sensitivity.requestedFixtures, 3);assert.ok(partial.sensitivity.metas.every(m => m.fixtures === 2));
  assert.deepEqual(partial.validations, state.validations);assert.deepEqual(partial.baselineResults, state.baselineResults);
  assert.equal(partial.battles, state.battles - teams * 12 + stopAfter);assert.match(fs.readFileSync(path.join(cut, 'report.html'), 'utf8'), /partial: the run ran out of time/);
  // Stopped before a single position per meta completes: nothing is recorded.
  mock = mockBattles({ interrupt: { jobs: teams * 12, after: teams * 3 } });const none = path.join(directory, 'none');await search({ ...opts, out: none });dropListeners();mock.restore();
  assert.equal(read(none).sensitivity, null);assert.equal(read(none, 'recommendations.json').sensitivity, null);
 } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the panel refuses seeds and fixtures that earlier evidence already used, and invalid options', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-sens-search-')), poolPath = path.join(directory, 'source-pool.json'), { species } = testPool(poolPath);
 try {
  const opts = { ...base(poolPath), sensitivityFixtures: 3 };
  await assert.rejects(search({ ...opts, out: path.join(directory, 'bad1'), sensitivityFixtures: -1 }), /sensitivity-fixtures/);
  await assert.rejects(search({ ...opts, out: path.join(directory, 'bad2'), sensitivityFixtures: 2.5 }), /sensitivity-fixtures/);
  await assert.rejects(search({ ...opts, out: path.join(directory, 'bad3'), sensitivityGroups: 'everyone' }), /sensitivity-groups/);
  dropListeners();
  // A warm start whose evidence lists one of the sensitivity seeds is refused before any battle.
  const probe = S.sensitivitySeeds(902, S.ID_ORDER, []);
  const old = { config: { version: VERSION, mechanicsHash: require('./common.cjs').mechanicsHash({ version: 'v4' }), meta: createMeta(species, { mode: 'independent' }).description, poolHash: JSON.parse(fs.readFileSync(poolPath)).hash, seed: 123 }, observations: [{ team: [0, 1, 2], opponent: [], score: 1, seed: 1, round: 0 }], records: [], battles: 1, round: 1, evaluationEvidence: { fixtureSeeds: [probe['independent-1.25']] } };
  const warm = path.join(directory, 'old-checkpoint.json');fs.writeFileSync(warm, JSON.stringify(old));
  const mock = mockBattles();
  try { await assert.rejects(search({ ...opts, out: path.join(directory, 'warm'), warmStart: warm }), /absorbed evidence|Sensitivity panel seed/); } finally { mock.restore();dropListeners(); }
  assert.equal(mock.log.calls.length, 0);
 } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
