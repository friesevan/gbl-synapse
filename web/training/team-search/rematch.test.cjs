'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pairwiseBands, resolvable } = require('./paired-stats.cjs'), R = require('./rematch.cjs');
const { VERSION, dataHash, digest, screeningSeed } = require('./common.cjs'), { random } = require('../utils.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-rematch-'));
function writePool(file) {
 const gm = require('../../includes/pro/data/gamemaster.json'), published = require('../../includes/pro/data/league-1500.json').overall, used = new Set(), species = [];
 for (const row of published) {
  const p = gm.pokemon.find(p => p.speciesId === row.speciesId);
  if (!p || used.has(p.dex)) continue; used.add(p.dex);
  species.push({ speciesId: p.speciesId, speciesName: p.speciesName, dex: p.dex, types: p.types, moveset: row.moveset, weight: 1, features: [.5], scoutByType: Array(18).fill(.5), scoutScore: .5, ivs: { atk: 0, def: 15, hp: 15 }, cp: 1500, level: 30 });
  if (species.length === 8) break;
 }
 const pool = { config: { version: VERSION, cp: 1500, inputHash: dataHash(), movesets: 1 }, species, variants: species }; pool.hash = digest(pool);
 fs.writeFileSync(file, JSON.stringify(pool)); return pool;
}
const lineup = (pool, ...i) => i.map(k => ({ speciesId: pool.species[k].speciesId, speciesName: pool.species[k].speciesName, moveset: pool.species[k].moveset }));
function writeRun(dir, name, pool, rows) {
 const d = path.join(dir, name); fs.mkdirSync(d);
 fs.writeFileSync(path.join(d, 'recommendations.json'), JSON.stringify({ version: VERSION, poolHash: pool.hash, finalPanel: { complete: true, completedFixtures: 512 }, rows: rows.map(([members, score]) => ({ team: members, validation: { score, fixtureSeed: 1234 }, screen: { fixtureSeed: 4321 } })) }));
 return d;
}
// A deterministic fake battle: team strength is the sum of its members' pool positions, so teams differ reproducibly.
const fakePlay = strength => async jobs => jobs.map(([team, opponent, , , options]) => {
 const s = strength(team.map(p => p.speciesId)), noise = parseInt(digest([team.map(p => p.speciesId), opponent.map(p => p.speciesId), options.seed]).slice(0, 4), 16) / 65535;
 return { score: noise < s ? 1 : noise < s + .1 ? .5 : 0 };
});

test('pairwiseBands: all pairs, deltas, single-pair intervals inside the simultaneous band, deterministic by seed', () => {
 const n = 128, r = random(3), noise = () => (r() - .5) * .5;
 const rows = [['a', .70], ['b', .55], ['c', .548]].map(([id, m]) => ({ id, scores: Array.from({ length: n }, () => Math.max(0, Math.min(1, m + noise()))) }));
 const out = pairwiseBands(rows, { seed: 9, samples: 800 }), again = pairwiseBands(rows, { seed: 9, samples: 800 });
 assert.deepEqual(out, again);assert.equal(out.pairs.length, 3);assert.equal(out.fixtures, n);assert.equal(out.teams, 3);
 const byPair = Object.fromEntries(out.pairs.map(p => [p.a + p.b, p]));
 assert.ok(Math.abs(byPair.ab.delta - (rows[0].scores.reduce((s, v) => s + v, 0) - rows[1].scores.reduce((s, v) => s + v, 0)) / n) < 1e-12);
 assert.equal(byPair.ab.verdict, 'a-better');assert.equal(byPair.ac.verdict, 'a-better');assert.equal(byPair.bc.verdict, 'unresolved');
 for (const p of out.pairs) { assert.ok(Math.abs(p.simultaneous95[0] - (p.delta - out.radius)) < 1e-12 && Math.abs(p.simultaneous95[1] - (p.delta + out.radius)) < 1e-12); assert.ok(p.interval95[0] <= p.delta && p.interval95[1] >= p.delta); }
 assert.ok(out.radius > 0 && out.radius < .2);
 assert.notDeepEqual(pairwiseBands(rows, { seed: 10, samples: 800 }).radius, out.radius);
 // Swapping two teams negates their delta and their verdict.
 const swapped = pairwiseBands([rows[1], rows[0]], { seed: 9, samples: 800 }).pairs[0];assert.ok(Math.abs(swapped.delta + byPair.ab.delta) < 1e-12);assert.equal(swapped.verdict, 'b-better');
});

test('the simultaneous band controls false positives across many pairs where single intervals do not', () => {
 // Six teams with identical true strength: any resolved pair is a false positive.
 let simultaneous = 0, alone = 0;
 for (let trial = 0; trial < 30; trial++) {
  const r = random(100 + trial), rows = Array.from({ length: 6 }, (_, i) => ({ id: 't' + i, scores: Array.from({ length: 64 }, () => r() < .5 ? 1 : 0) }));
  const out = pairwiseBands(rows, { seed: trial + 1, samples: 400 });
  if (out.pairs.some(p => p.verdict !== 'unresolved')) simultaneous++;
  if (out.pairs.some(p => p.alone !== 'unresolved')) alone++;
 }
 // About 5% expected for the simultaneous band and far more for 15 unadjusted looks; seeds are fixed, so this is exact.
 assert.ok(simultaneous <= 4, 'simultaneous false-positive trials: ' + simultaneous);
 assert.ok(alone >= simultaneous + 6, 'unadjusted pairs should be much more liberal: ' + alone + ' vs ' + simultaneous);
});

test('pairwiseBands rejects unusable input and handles identical teams', () => {
 assert.throws(() => pairwiseBands([{ id: 'a', scores: [1, 0] }]), /at least two teams/);
 assert.throws(() => pairwiseBands([{ id: 'a', scores: [1, 0] }, { id: 'b', scores: [1] }]), /same number/);
 assert.throws(() => pairwiseBands([{ id: 'a', scores: [1, 2] }, { id: 'b', scores: [1, 0] }]), /finite scores/);
 assert.throws(() => pairwiseBands([{ id: 'a', scores: [1, 0] }, { id: 'b', scores: [1, 0] }], { samples: 10 }), /at least 100/);
 const same = pairwiseBands([{ id: 'a', scores: [1, 0, 1, 0] }, { id: 'b', scores: [1, 0, 1, 0] }], { samples: 200 }).pairs[0];assert.equal(same.delta, 0);assert.equal(same.verdict, 'unresolved');
 // The interval a panel can resolve: sd 0.45 over 512 fixtures is about 3.9 points; 64 fixtures about 11.
 assert.ok(Math.abs(resolvable(.45, 512) - .039) < .001);assert.ok(Math.abs(resolvable(.45, 64) - .110) < .001);
});

test('parseArgs takes sources anywhere, typed options, and the boolean --finalists', () => {
 const { opts, sources } = R.parseArgs(['runA', '--fixtures', '64', 'runB.json.gz', '--finalists', '--meta', 'observed', '--seed', '77', '--workers', '2']);
 assert.deepEqual(sources, ['runA', 'runB.json.gz']);assert.equal(opts.fixtures, 64);assert.equal(opts.finalists, true);assert.equal(opts.meta, 'observed');assert.equal(opts.seed, 77);assert.equal(opts.workers, 2);assert.equal(opts.out, '');
 assert.equal(R.parseArgs(['x']).opts.finalists, false);assert.equal(R.parseArgs(['--help']).opts.help, true);
 assert.throws(() => R.parseArgs(['x', '--nonsense', '1']), /Unknown argument --nonsense/);assert.throws(() => R.parseArgs(['x', '--fixtures']), /Unknown argument/);
});

test('panelSeed is fresh, reproducible when asked, and never a panel a source already used', () => {
 const used = [1234, 99];
 for (let i = 0; i < 50; i++) { const s = R.panelSeed(0, used); assert.ok(Number.isInteger(s) && s >= 1 && s <= 0xffffffff);assert.ok(![1234, 99, screeningSeed(1234), screeningSeed(99)].includes(s)); }
 assert.equal(R.panelSeed(555, used), 555);
 assert.throws(() => R.panelSeed(1234, used), /was a screening or final panel/);assert.throws(() => R.panelSeed(screeningSeed(99), used), /was a screening or final panel/);
});

test('rematch re-simulates every source on one common panel and compares them with paired, simultaneous statistics', async () => {
 const dir = tmp();
 try {
  const poolFile = path.join(dir, 'pool.json'), pool = writePool(poolFile);
  const strong = lineup(pool, 0, 1, 2), mid = lineup(pool, 3, 4, 5), weak = lineup(pool, 5, 6, 7);
  const a = writeRun(dir, 'run-a', pool, [[strong, .8], [mid, .6]]), b = writeRun(dir, 'run-b', pool, [[weak, .9], [[mid[0], mid[2], mid[1]], .5]]);
  // The fake battle's win probability depends on the lead species: pool position 0 strong, 3 middling, 5 weak.
  const lead = ids => ids[0] === pool.species[0].speciesId ? .7 : ids[0] === pool.species[3].speciesId ? .4 : .1;
  const seen = [];
  const opts = { ...R.DEFAULTS, pool: poolFile, meta: 'independent', fixtures: 96, seed: 2468, workers: 1, bootstrap: 500, beliefSamples: 1, lookaheadTurns: 4 };
  const result = await R.rematch(opts, [a, b], { play: async (jobs, info) => { seen.push(jobs); assert.equal(info.workers, 1); return fakePlay(lead)(jobs); }, log: () => {} });
  assert.equal(result.format, 'pvp-team-rematch');assert.equal(result.scope, 'primary');
  // run-a primary (strong) and run-b primary (weak): two teams, panel of 96 shared fixtures, one battle each.
  assert.equal(result.teams.length, 2);assert.deepEqual(result.teams.map(t => t.origins[0].source), ['run-a', 'run-b']);assert.equal(seen[0].length, 2 * 96);
  assert.equal(result.reference, 't1');assert.ok(result.teams[0].score > result.teams[1].score + .3);assert.equal(result.teams[0].scores.length, 96);
  assert.equal(result.panel.fixtures, 96);assert.equal(result.panel.seed, 2468);assert.equal(result.panel.exploratory, true);assert.equal(Object.values(result.panel.components).reduce((s, v) => s + v, 0), 96);
  // Fixture-major dispatch: jobs 0 and 1 are fixture 0 for team 1 and team 2.
  assert.equal(seen[0][0][4].seed, seen[0][1][4].seed);assert.notEqual(seen[0][0][4].seed, seen[0][2][4].seed);assert.deepEqual(seen[0][0][1].map(p => p.speciesId), seen[0][1][1].map(p => p.speciesId));
  assert.equal(result.versusReference.comparisons.length, 1);assert.equal(result.versusReference.comparisons[0].distinguishable, 'primary-better');assert.equal(result.pairs.pairs.length, 1);assert.equal(result.pairs.pairs[0].verdict, 'a-better');
  assert.equal(result.meta.mode, 'independent');assert.equal(result.pool.hash, pool.hash);assert.match(result.engine.mechanicsHash, /^[0-9a-f]{64}$|^[\w-]+$/);
  const table = R.formatTable(result);
  assert.match(table, /Rematch on 96 common fixtures · meta independent · panel seed 2468 · EXPLORATORY/);assert.match(table, /run-a/);assert.match(table, /reference/);assert.match(table, /reference better/);
  // Same seed, same play: exactly the same result (the panel, the bootstrap and the order are all deterministic).
  const again = await R.rematch(opts, [a, b], { play: fakePlay(lead), log: () => {} });
  assert.deepEqual(again.teams.map(t => t.scores), result.teams.map(t => t.scores));assert.deepEqual(again.pairs, result.pairs);
  // --finalists adds every other final-tested team and de-duplicates the shared composition.
  const all = await R.rematch({ ...opts, finalists: true }, [a, b], { play: fakePlay(lead), log: () => {} });
  assert.equal(all.scope, 'finalists');assert.equal(all.teams.length, 3); // strong, mid (from both runs, merged), weak
  assert.deepEqual(all.teams.find(t => t.members[0].speciesId === pool.species[3].speciesId).origins.map(o => o.source).sort(), ['run-a', 'run-b']);
  assert.equal(all.pairs.pairs.length, 3);
  // A seed that a source used as its own final panel is refused.
  await assert.rejects(R.rematch({ ...opts, seed: 1234 }, [a, b], { play: fakePlay(lead), log: () => {} }), /was a screening or final panel/);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rematch refuses what cannot be compared and reports what it could not map', async () => {
 const dir = tmp();
 try {
  const poolFile = path.join(dir, 'pool.json'), pool = writePool(poolFile), same = lineup(pool, 0, 1, 2);
  const a = writeRun(dir, 'run-a', pool, [[same, .8]]), b = writeRun(dir, 'run-b', pool, [[same.slice(0, 1).concat(same.slice(1).reverse()), .8]]);
  const opts = { ...R.DEFAULTS, pool: poolFile, meta: 'independent', fixtures: 16, seed: 5, workers: 1, bootstrap: 200, beliefSamples: 1, lookaheadTurns: 4 }, play = fakePlay(() => .5);
  await assert.rejects(R.rematch(opts, [a, b], { play, log: () => {} }), /Only one distinct team survived .*tie by construction/);
  const ghost = lineup(pool, 0, 1, 2).map((m, i) => i === 1 ? { ...m, speciesId: 'nonexistent_mon' } : m), c = writeRun(dir, 'run-c', pool, [[ghost, .7]]);
  await assert.rejects(R.rematch(opts, [a, c], { play, log: () => {} }), /Only one distinct team survived.*run-c: species-not-in-pool/);
  await assert.rejects(R.rematch(opts, [c], { play, log: () => {} }), /No team could be mapped/);
  await assert.rejects(R.rematch({ ...opts, fixtures: 4 }, [a, b], { play }), /at least 8/);
  await assert.rejects(R.rematch({ ...opts, bootstrap: 10 }, [a, b], { play }), /bootstrap must be at least 100/);
  await assert.rejects(R.rematch(opts, [], { play }), /at least one run/);
  // An incomplete play is an error, never a table of partial scores.
  const d = writeRun(dir, 'run-d', pool, [[lineup(pool, 3, 4, 5), .7]]);
  await assert.rejects(R.rematch(opts, [a, d], { play: async jobs => jobs.slice(1).map(() => ({ score: .5 })), log: () => {} }), /did not complete every battle/);
  // The table lists skipped teams with their reason when at least two others remain.
  const e = writeRun(dir, 'run-e', pool, [[lineup(pool, 3, 4, 5), .7], [ghost, .6]]), result = await R.rematch({ ...opts, finalists: true }, [a, e], { play, log: () => {} });
  assert.equal(result.skipped.length, 1);assert.match(R.formatTable(result), /Skipped \(not mappable into the current pool\)[\s\S]*run-e#2: species-not-in-pool/);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
