'use strict';
// The standalone alternate-moveset panel for a finished run (alternate-panel.cjs RUN_OR_REPORT): sources, seeds, arms, output.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const A = require('./alternate-panel.cjs'), O = require('./observed-moves.cjs'), {VERSION, dataHash, digest, teamKey} = require('./common.cjs'), {defaults} = require('../utils.cjs');

function writePool(file) {
 const gm = require('../../includes/pro/data/gamemaster.json'), published = require('../../includes/pro/data/league-1500.json').overall, used = new Set(), species = [], variants = [];
 for (const row of published) {
  const p = gm.pokemon.find(p => p.speciesId === row.speciesId), others = p ? [...O.movePools(p.speciesId).charged].filter(m => !row.moveset.includes(m)).sort() : [];
  if (!p || used.has(p.dex) || row.moveset.length !== 3 || others.length < 4) continue;used.add(p.dex);
  const s = {speciesId: p.speciesId, speciesName: p.speciesName, dex: p.dex, types: p.types, moveset: row.moveset, weight: 1, features: Array(97).fill(.5), scoutByType: Array(18).fill(.5), scoutScore: .6, ivs: {atk: 0, def: 15, hp: 15}, cp: 1500, level: 30};
  species.push(s);variants.push({...s, recommended: true}, {...s, moveset: [s.moveset[0], others[0], others[1]], scoutScore: .5, recommended: false}, {...s, moveset: [s.moveset[0], others[2], others[3]], scoutScore: .4, recommended: false});
  if (species.length === 6) break;
 }
 const pool = {config: {version: VERSION, cp: 1500, inputHash: dataHash(), movesets: 3}, species, variants};pool.hash = digest(pool);fs.writeFileSync(file, JSON.stringify(pool));return pool;
}
const member = v => ({speciesId: v.speciesId, speciesName: v.speciesName, moveset: v.moveset});
// A mock engine: a deterministic score from the two rosters, their movesets and the seed.
const mockPlay = calls => async (jobs, {workers, label}) => {
 calls.push({jobs: jobs.length, workers, label, first: jobs[0]});
 return jobs.map(([team, opponent, , , settings]) => ({score: parseInt(digest([team.map(p => [p.speciesId, p.moveset]), opponent.map(p => [p.speciesId, p.moveset]), settings.seed]).slice(0, 2), 16) % 3 / 2}));
};

test('the standalone panel re-simulates a finished run\'s finalists on a fresh sealed panel and writes the block', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-alt-standalone-')), poolFile = path.join(dir, 'pool.json'), pool = writePool(poolFile);
 try {
  const run = path.join(dir, 'run');fs.mkdirSync(run);
  const teams = [[0, 3, 6], [9, 12, 15], [1, 4, 7]], rows = teams.map((team, i) => ({team: team.map(k => member(pool.variants[k])), validation: i < 2 ? {score: .6 - i / 10, fixtureSeed: 11} : null}));
  fs.writeFileSync(path.join(run, 'recommendations.json'), JSON.stringify({version: VERSION, poolHash: pool.hash, rows, baselineResults: [], finalPanel: {}}));
  const calls = [], logs = [], opts = {...A.DEFAULTS, pool: poolFile, fixtures: 4, workers: 2, seed: 5150, bootstrap: 200};
  const result = await A.standalone(opts, [run], {play: mockPlay(calls), log: m => logs.push(m)});
  assert.equal(calls.length, 1);assert.equal(calls[0].jobs, 2 * 4 * 3);assert.equal(calls[0].workers, 2);assert.equal(calls[0].label, 'alternate-panel');
  assert.equal(result.format, 'pvp-team-alternate-panel');assert.equal(result.seed, 5150);
  assert.equal(result.fixtures, 4);assert.equal(result.complete, true);assert.deepEqual(result.teams.map(t => t.primary), [true, false]);
  assert.deepEqual(result.teams.map(t => teamKey(t.team)), [teamKey(teams[0]), teamKey(teams[1])], 'the final-tested finalists, the unvalidated row skipped');
  assert.match(logs[0], /2 teams × 4 fixtures × 3 arms = 24 battles · 2 workers · meta hybrid · panel seed 5150/);
  assert.ok(result.teams.every(t => t.finalScore === null && t.deltas.length === 2));
  assert.equal(Object.keys(result.raw).length, 2);assert.equal(result.raw[teamKey(teams[0])].run.length, 4);
  assert.equal(result.pool.hash, pool.hash);assert.equal(result.meta.mode, 'hybrid');assert.equal(result.observedMoves, false);
  // Fixture-major arms: the first six jobs are fixture 0 at the three arms for both teams, on one seed, with the arms' movesets.
  const info = A.plan(pool, require('./meta.cjs').createMeta(pool.species, {mode: 'hybrid'}), {fixtures: 4, seed: 5150});
  assert.deepEqual(calls[0].first[1].map(p => p.moveset), info.interleaved[0].team.map(p => p.moveset));
  // Every text rendering reads the saved result.
  const text = A.formatTable(result);
  assert.match(text, /^Alternate opponent movesets \(4 common fixtures/);assert.match(text, /Recommended movesets/);assert.match(text, /Best alternate moveset: \d+ of 12 opponent members changed/);assert.match(text, /Panel seed 5150 · meta hybrid/);
  assert.match(text, /Primary ·/);
  // A seed that one of the sources used is refused.
  await assert.rejects(A.standalone({...opts, seed: 11}, [run], {play: mockPlay([])}), /screening or final panel/);
  await assert.rejects(A.standalone({...opts, fixtures: 1}, [run], {play: mockPlay([])}), /at least 2/);
  await assert.rejects(A.standalone({...opts, fixtures: 5000}, [run], {play: mockPlay([])}), /alternate-panel must be/);
  await assert.rejects(A.standalone(opts, [], {play: mockPlay([])}), /Give a run directory/);
  await assert.rejects(A.standalone({...opts, scope: 'all'}, [run], {play: mockPlay([])}), /scope must be/);
  await assert.rejects(A.standalone({...opts, observedMoves: true}, [run], {play: mockPlay([])}), /require --usage-file/);
  await assert.rejects(A.standalone({...opts, pool: path.join(dir, 'missing.json')}, [run], {play: mockPlay([])}), /ENOENT/);
  // The primary scope plays one team.
  const one = await A.standalone({...opts, scope: 'primary'}, [run], {play: mockPlay([])});assert.equal(one.teams.length, 1);
  // A battle that does not complete is an error, not a result.
  await assert.rejects(A.standalone(opts, [run], {play: async () => null}), /did not complete/);
 } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('with --observed-moves the reference arm is the observed meta', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-alt-standalone-')), poolFile = path.join(dir, 'pool.json'), pool = writePool(poolFile), usage = path.join(dir, 'usage.json');
 try {
  const [a, b, c] = pool.species, other = x => [...O.movePools(x.speciesId).charged].filter(m => !x.moveset.includes(m)).sort()[0];
  fs.writeFileSync(usage, JSON.stringify({source: 'test', cp: 1500, cup: 'all', teams: [{members: [a.speciesId, b.speciesId, c.speciesId], count: 3, movesets: [{fast: null, charged: [other(a)]}, null, null]}]}));
  const run = path.join(dir, 'run');fs.mkdirSync(run);
  fs.writeFileSync(path.join(run, 'recommendations.json'), JSON.stringify({version: VERSION, poolHash: pool.hash, rows: [{team: [0, 3, 6].map(k => member(pool.variants[k])), validation: {score: .5, fixtureSeed: 11}}], baselineResults: []}));
  const calls = [], result = await A.standalone({...A.DEFAULTS, pool: poolFile, fixtures: 3, workers: 1, seed: 77, bootstrap: 200, meta: 'observed', usageFile: usage, observedMoves: true}, [run], {play: mockPlay(calls)});
  assert.equal(result.observedMoves, true);assert.match(result.reference.label, /observed movesets where recorded/);assert.equal(result.meta.observedMoves.differingTeamShare, 1);
  const opponent = calls[0].first[1];assert.ok(opponent[0].moveset.includes(other(a)) && opponent[0].moveset[0] === a.moveset[0], 'the observed charged move replaces one of the recommended ones');assert.deepEqual(opponent.slice(1).map(p => p.moveset.join('/')), [b.moveset.join('/'), c.moveset.join('/')]);
  assert.equal(calls[0].first[1][0].observedMoveset, true);
  assert.match(A.formatTable(result), /with observed movesets/);
 } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('command line parsing', () => {
 const {opts, sources} = A.parseArgs(['training/runs/a,training/runs/b', 'c', '--fixtures', '128', '--observed-moves', '--usage-file', 'u.json', '--scope', 'primary', '--workers', '3']);
 assert.deepEqual(sources, ['training/runs/a', 'training/runs/b', 'c']);
 assert.deepEqual([opts.fixtures, opts.observedMoves, opts.usageFile, opts.scope, opts.workers, opts.help], [128, true, 'u.json', 'primary', 3, false]);
 assert.equal(A.parseArgs(['--help']).opts.help, true);
 assert.throws(() => A.parseArgs(['--nope', '1']), /Unknown argument/);
 assert.throws(() => A.parseArgs(['x', '--fixtures']), /Unknown argument/);
 assert.equal(A.DEFAULTS.fixtures, 64);
});

test('rematch.cjs plays the observed movesets only when asked, with the same fixtures otherwise', () => {
 const R = require('./rematch.cjs'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-alt-standalone-')), pool = writePool(path.join(dir, 'pool.json')), usage = path.join(dir, 'usage.json');
 try {
  const [a, b, c] = pool.species, other = x => [...O.movePools(x.speciesId).charged].filter(m => !x.moveset.includes(m)).sort()[0];
  fs.writeFileSync(usage, JSON.stringify({source: 'test', cp: 1500, cup: 'all', teams: [{members: [a.speciesId, b.speciesId, c.speciesId], count: 3, movesets: [{fast: null, charged: [other(a)]}, null, null]}, {members: [c.speciesId, b.speciesId, a.speciesId], count: 1}]}));
  const opts = {...R.DEFAULTS, fixtures: 30, meta: 'observed', usageFile: usage}, plain = R.buildPanel(pool, opts, 5), observed = R.buildPanel(pool, {...opts, observedMoves: true}, 5);
  assert.deepEqual(observed.cases.map(f => [f.seed, f.team.map(p => p.speciesId)]), plain.cases.map(f => [f.seed, f.team.map(p => p.speciesId)]));
  assert.ok(plain.cases.every(f => f.team.every(p => !p.observedMoveset)));assert.ok(observed.cases.some(f => f.team.some(p => p.observedMoveset && p.moveset.includes(other(a)))));
  assert.deepEqual(observed.beliefTeams, plain.beliefTeams);assert.equal(observed.meta.description.observedMoves.differingTeamShare, .75);
  assert.equal(R.parseArgs(['x', 'y', '--observed-moves']).opts.observedMoves, true);assert.equal(R.parseArgs(['x', 'y']).opts.observedMoves, false);
 } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
