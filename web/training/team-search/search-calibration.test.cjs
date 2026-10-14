'use strict';
// fit() records how well the ensemble spread tracks the held-out error (calibration.cjs); selection is untouched.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BattlePool } = require('../pool.cjs'), { search } = require('./search.cjs');
const { VERSION, dataHash, digest, teamKey } = require('./common.cjs');
const core = require('../../includes/pro/neural-report-core.js');

function testPool(poolPath) {
  const gm = require('../../includes/pro/data/gamemaster.json'), published = require('../../includes/pro/data/league-1500.json').overall, used = new Set(), species = [];
  for (const row of published) { const p = gm.pokemon.find(p => p.speciesId === row.speciesId); if (!p || used.has(p.dex)) continue; used.add(p.dex); species.push({ speciesId: p.speciesId, speciesName: p.speciesName, dex: p.dex, types: p.types, moveset: row.moveset, weight: 1, features: [.5], scoutByType: Array(18).fill(.5), scoutScore: .5, ivs: { atk: 0, def: 15, hp: 15 }, cp: 1500, level: 30 }); if (species.length === 7) break; }
  const prepared = { config: { version: VERSION, cp: 1500, inputHash: dataHash(), movesets: 1 }, species, variants: species }; prepared.hash = digest(prepared); fs.writeFileSync(poolPath, JSON.stringify(prepared)); return prepared;
}

test('each search round records an uncertainty calibration on the held-out teams, and an unchanged selection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-calibration-')), poolPath = path.join(directory, 'pool.json');
  testPool(poolPath);
  const opts = { pool: poolPath, hours: 1, workers: 1, initialTeams: 60, batchTeams: 12, opponents: 12, acquisitionFixtures: 4, promotionFraction: 1, screenTeams: 2, screenOpponents: 2, validationTeams: 1, validationOpponents: 2, baselineCount: 3, candidates: 80, epochs: 2, hidden: 4, ensemble: 3, referenceOpponents: 6, fitFixtures: 400, seed: 123, validationSeed: 902, rounds: 2, meta: 'independent', lookaheadTurns: 4, decisionInterval: 4, beliefSamples: 1 };
  const original = BattlePool.prototype.map, listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
  BattlePool.prototype.map = async function (jobs, options = {}) {
    if (jobs.length && !Array.isArray(jobs[0][0])) return original.call(this, jobs, options);
    const { onResult = () => {} } = options, results = jobs.map(([team, opponent, , , o]) => ({ score: parseInt(digest([team.map(p => p.speciesId), opponent.map(p => p.speciesId), o.seed]).slice(0, 2), 16) % 3 / 2 }));
    results.forEach((result, i) => onResult(result, i)); return results;
  };
  try {
    const out = path.join(directory, 'run');
    await search({ ...opts, out });
    const state = JSON.parse(fs.readFileSync(path.join(out, 'checkpoint.json'))), lines = fs.readFileSync(path.join(out, 'history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(state.history.length >= 1);
    assert.deepEqual(lines.map(l => l.diagnostics.uncertaintyCalibration), state.history.map(h => h.diagnostics.uncertaintyCalibration), 'history.jsonl carries the same read-out');
    const latest = state.latestDiagnostics, c = latest.uncertaintyCalibration;
    assert.ok(latest.heldoutTeams >= 10, 'the fixture is large enough to calibrate: ' + latest.heldoutTeams + ' held-out teams');
    assert.ok(c, 'a calibration is recorded once at least 10 teams are held out');
    assert.equal(c.teams, latest.heldoutTeams, 'it covers exactly the held-out teams of the same diagnostic');
    for (const key of ['k80', 'k90', 'coverage80', 'coverage90', 'coverage1', 'spearman', 'medianSpread', 'medianAbsResidual']) assert.ok(c[key] === null || Number.isFinite(c[key]), key);
    assert.ok(c.k80 === null || c.k90 === null || c.k80 <= c.k90, 'a wider share needs a larger multiplier');
    assert.ok(c.coverage1 >= 0 && c.coverage1 <= 1);
    // Recompute it independently from the checkpoint's models.
    const { Network, predict, reference } = require('./interaction.cjs'), { features } = require('./common.cjs');
    const prepared = JSON.parse(fs.readFileSync(path.join(out, 'pool.json'))), models = state.models.map(Network.fromJSON), speciesMap = new Map(prepared.species.map(s => [s.speciesId, s]));
    const meta = require('./meta.cjs').createMeta(prepared.species, { mode: 'independent', weightPower: 1.25 }), refs = reference(models, meta.fixtures(opts.referenceOpponents, state.config.referenceFixtureSeed).map(f => features([0, 1, 2], f.team.map(p => speciesMap.get(p.speciesId)))));
    const held = state.records.filter(r => parseInt(digest(teamKey(r.team)).slice(0, 8), 16) % 5 === 0).map(r => { const p = predict(models, features(r.team, prepared.variants), refs); return { predicted: p.mean, spread: p.uncertainty, observed: r.reward / r.games }; });
    const again = require('./calibration.cjs').uncertaintyCalibration(held);
    assert.equal(held.length, c.teams);
    assert.ok(Math.abs(again.medianAbsResidual - c.medianAbsResidual) < 1e-12 && Math.abs(again.medianSpread - c.medianSpread) < 1e-12);
    assert.equal(again.k90, c.k90);
    // The portable-report validator accepts it and rejects malformed values (see also calibration-viewer.test.cjs).
    assert.equal(state.history.every(h => h.diagnostics.uncertaintyCalibration === null || typeof h.diagnostics.uncertaintyCalibration.teams === 'number'), true);
    assert.doesNotThrow(() => core.validateCalibration(c));
    // The portable report carries it, on the latest diagnostics and on every round, and the viewer's validator accepts the whole report.
    const report = JSON.parse(require('node:zlib').gunzipSync(fs.readFileSync(path.join(out, 'report.pvpteams.json.gz'))));
    assert.deepEqual(report.diagnostics.uncertaintyCalibration, c);
    assert.deepEqual(report.history.map(h => h.diagnostics.uncertaintyCalibration), state.history.map(h => h.diagnostics.uncertaintyCalibration));
    assert.doesNotThrow(() => core.validate(report));
  } finally {
    BattlePool.prototype.map = original;
    for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
