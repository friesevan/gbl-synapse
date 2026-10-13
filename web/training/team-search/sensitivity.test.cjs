'use strict';
// The meta-sensitivity panel (sensitivity.cjs), the meta.cjs additions it needs (coherent-only and leave-one-creator-out
// metas), the budget reserve, and the standalone tool with a deterministic fake battle.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const S = require('./sensitivity.cjs'), { createMeta, loadUsage } = require('./meta.cjs'), { trainingBudget } = require('./budget.cjs');
const { VERSION, dataHash, digest, screeningSeed, teamKey } = require('./common.cjs'), { opponentFixtureKey } = require('./acquisition.cjs'), { random } = require('../utils.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-sensitivity-'));
function writePool(file, count = 8) {
 const gm = require('../../includes/pro/data/gamemaster.json'), published = require('../../includes/pro/data/league-1500.json').overall, used = new Set(), species = [];
 for (const row of published) {
  const p = gm.pokemon.find(p => p.speciesId === row.speciesId);
  if (!p || used.has(p.dex)) continue; used.add(p.dex);
  species.push({ speciesId: p.speciesId, speciesName: p.speciesName, dex: p.dex, types: p.types, moveset: row.moveset, weight: species.length + 1, features: [.5], scoutByType: Array(18).fill(.5).map((v, i) => v + ((species.length + i) % 5) / 20), scoutScore: .5, ivs: { atk: 0, def: 15, hp: 15 }, cp: 1500, level: 30 });
  if (species.length === count) break;
 }
 const pool = { config: { version: VERSION, cp: 1500, inputHash: dataHash(), movesets: 1 }, species, variants: species }; pool.hash = digest(pool);
 if (file) fs.writeFileSync(file, JSON.stringify(pool));
 return pool;
}
// Teams (rows of three species ids) with creators; counts and creators chosen so the largest creator is obvious.
function writeUsage(file, pool, { dated = true } = {}) {
 const id = i => pool.species[i].speciesId, rows = [
  { members: [id(0), id(1), id(2)], count: 6, creator: 'Alpha', weight: .5, collectedAt: '2026-10-10' },
  { members: [id(1), id(2), id(3)], count: 2, creator: 'Beta', collectedAt: '2026-10-11' },
  { members: [id(3), id(4), id(5)], count: 2, creator: 'Gamma', collectedAt: '2026-10-11' },
  { members: [id(0), id(6), id(7)], count: 1, creator: 'Alpha', weight: .5, collectedAt: '2026-10-09' },
 ].map(r => dated ? r : { ...r, collectedAt: undefined });
 fs.writeFileSync(file, JSON.stringify({ source: 'test usage', cp: 1500, cup: 'all', collectedAt: '2026-10-11', teams: rows }));
 return rows;
}

test('meta.cjs: coherent-only mode and leave-one-creator-out keep the default meta byte-identical', () => {
 const dir = tmp(), pool = writePool(null), file = path.join(dir, 'usage.json');
 try {
  writeUsage(file, pool);
  const coherent = createMeta(pool.species, { mode: 'coherent' }), cases = coherent.fixtures(200, 11);
  assert.deepEqual(new Set(cases.map(c => c.component)), new Set(['coherent']));
  assert.deepEqual(coherent.description.proportions, { coherent: 1 });assert.equal(coherent.description.observedShare, 0);
  assert.deepEqual(cases, createMeta(pool.species, { mode: 'coherent' }).fixtures(200, 11));
  cases.forEach(c => assert.equal(new Set(c.team.map(p => p.dex)).size, 3));
  assert.throws(() => createMeta(pool.species, { mode: 'nonsense' }), /hybrid, independent, observed or coherent/);
  // The ordinary descriptions are unchanged: no excludedCreator key, same proportions.
  const hybrid = createMeta(pool.species, { usageFile: file }), plain = createMeta(pool.species);
  assert.equal('excludedCreator' in hybrid.description, false);assert.deepEqual(plain.description.proportions, { independent: .5, coherent: .5 });
  assert.equal(hybrid.description.observedCount, 11);
  // Leave one creator out: Alpha (weight .5 per appearance: 3.5) is the largest only with the cap; Beta and Gamma have 2 each.
  const usage = loadUsage(file, pool.species);
  assert.equal(usage.topCreator.creator, 'Alpha');assert.ok(Math.abs(usage.topCreator.share - 3.5 / 7.5) < 1e-12);
  const without = createMeta(pool.species, { mode: 'observed', usageFile: file, excludeCreator: 'Alpha' });
  assert.equal(without.description.observedCount, 4);assert.equal(without.description.excludedCreator, 'Alpha');assert.equal(without.description.creators, 2);
  const seen = new Set(without.fixtures(300, 5).map(c => c.team.map(p => p.speciesId).join()));
  assert.ok(![...seen].some(k => k.startsWith(pool.species[0].speciesId + ',' + pool.species[1].speciesId)), 'Alpha\'s lead-first team never appears');
  assert.throws(() => createMeta(pool.species, { mode: 'observed', excludeCreator: 'Alpha' }), /requires --usage-file/);
  const solo = path.join(dir, 'solo.json');fs.writeFileSync(solo, JSON.stringify({ source: 's', cp: 1500, cup: 'all', teams: [{ members: pool.species.slice(0, 3).map(p => p.speciesId), count: 3, creator: 'Alpha' }] }));
  assert.throws(() => loadUsage(solo, pool.species, { excludeCreator: 'Alpha' }), /leaves no observed teams/);
  assert.equal(loadUsage(solo, pool.species).topCreator.share, 1);
  // A file without creator ids has no top creator.
  const anonymous = path.join(dir, 'anon.json');fs.writeFileSync(anonymous, JSON.stringify({ source: 's', cp: 1500, cup: 'all', teams: [{ members: pool.species.slice(0, 3).map(p => p.speciesId), count: 3 }] }));
  assert.equal(loadUsage(anonymous, pool.species).topCreator, null);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seeds derive from the validation seed, are distinct from every other panel seed and from each other, and are guarded', () => {
 const ids = S.ID_ORDER, validation = 2929289829, retest = 777, seeds = S.sensitivitySeeds(validation, ids, [retest]);
 assert.deepEqual(Object.keys(seeds), ids);
 const values = Object.values(seeds);
 assert.equal(new Set(values).size, ids.length);
 for (const v of values) { assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff); assert.ok(![validation, screeningSeed(validation), retest].includes(v)); }
 assert.deepEqual(S.sensitivitySeeds(validation, ids, [retest]), seeds);
 assert.notDeepEqual(S.sensitivitySeeds(validation + 1, ids, [retest]), seeds);
 // A meta keeps its seed whichever others are tested (so an `--metas` subset reproduces the same fixtures).
 assert.equal(S.sensitivitySeeds(validation, ['coherent'], [retest]).coherent, seeds.coherent);
 // A reserved seed that coincides with a derived one moves the derived seed on, never onto it.
 const moved = S.sensitivitySeeds(validation, ['coherent'], [seeds.coherent]).coherent;
 assert.notEqual(moved, seeds.coherent);assert.equal(moved, (seeds.coherent + 1) >>> 0);
 assert.throws(() => S.sensitivitySeeds(1.5, ids), /integer/);
 // Absorbed evaluation evidence: a seed an earlier run used is refused.
 assert.doesNotThrow(() => S.assertFreshSeeds(seeds, [1, 2, 3]));
 assert.throws(() => S.assertFreshSeeds(seeds, [seeds['independent-1.0']]), /absorbed evidence/);
 assert.doesNotThrow(() => S.assertFreshSeeds(seeds, undefined));
});

test('the catalog follows the data the run has', () => {
 const dir = tmp(), pool = writePool(null), file = path.join(dir, 'usage.json');
 try {
  const plain = S.metaSpecs(pool.species, {});
  assert.deepEqual(plain.specs.map(s => s.id), ['independent-1.25', 'coherent', 'independent-1.0', 'independent-1.5']);
  assert.deepEqual(plain.skipped.map(s => s.id), ['observed', 'observed-without-top-creator']);
  assert.deepEqual(plain.specs.map(s => s.weightPower), [1.25, 1.25, 1, 1.5]);
  // Coherent draws use the run's own exponent; the independent ones are pinned to theirs.
  assert.equal(S.metaSpecs(pool.species, { weightPower: 1.1 }).specs.find(s => s.id === 'coherent').weightPower, 1.1);
  writeUsage(file, pool);
  const full = S.metaSpecs(pool.species, { usageFile: file, halfLifeDays: 30, asOf: '2026-10-12', priorStrength: 5 });
  assert.deepEqual(full.specs.map(s => s.id), S.ID_ORDER);assert.deepEqual(full.skipped, []);
  const dropped = full.specs.find(s => s.id === 'observed-without-top-creator');
  assert.equal(dropped.options.excludeCreator, 'Alpha');assert.match(dropped.label, /\(\d+\.\d% of the observed weight\)/);assert.equal(dropped.options.mode, 'observed');
  assert.equal(full.specs.find(s => s.id === 'observed').options.halfLifeDays, 30);
  // Reports never carry the creator's name, only its share and a short hash.
  const panel = S.buildPanels(pool.species, [dropped], 6, { [dropped.id]: 9 })[0], published = S.publicMeta(dropped, panel, 6);
  assert.equal(JSON.stringify(published).includes('Alpha'), false);assert.equal(published.excludedCreatorHash, dropped.excludedCreatorHash);assert.ok(published.excludedCreatorShare > 0);
  assert.deepEqual(published.components, { observed: 6 });
  // One creator only: no leave-one-out meta, and it says why.
  const solo = path.join(dir, 'solo.json');fs.writeFileSync(solo, JSON.stringify({ source: 's', cp: 1500, cup: 'all', teams: [{ members: pool.species.slice(0, 3).map(p => p.speciesId), count: 3, creator: 'Alpha' }] }));
  const one = S.metaSpecs(pool.species, { usageFile: solo });
  assert.ok(!one.specs.some(s => s.id === 'observed-without-top-creator'));assert.match(one.skipped[0].reason, /at least two creators/);
  // A subset, and an unknown id.
  assert.deepEqual(S.metaSpecs(pool.species, { usageFile: file, only: ['coherent', 'observed'] }).specs.map(s => s.id), ['coherent', 'observed']);
  assert.throws(() => S.metaSpecs(pool.species, { only: ['mystery'] }), /Unknown meta mystery/);
  assert.deepEqual(S.metaSpecs(pool.species, { only: ['observed'] }).skipped.map(s => s.id), ['observed']);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('plan: one sealed panel per meta, interleaved by fixture, checked against sealed and inherited fixtures', () => {
 const dir = tmp(), pool = writePool(null), file = path.join(dir, 'usage.json');
 try {
  writeUsage(file, pool);
  const opts = { fixtures: 5, validationSeed: 4242, reserved: [31337], usage: { usageFile: file, halfLifeDays: 30, asOf: '2026-10-12', priorStrength: 5 } };
  const plan = S.plan(pool, opts);
  assert.equal(plan.metaCount, 6);assert.equal(plan.interleaved.length, 30);assert.equal(plan.battles(8), 8 * 5 * 6);
  plan.panels.forEach((p, k) => { assert.equal(p.cases.length, 5);for (let f = 0; f < 5; f++) assert.equal(plan.interleaved[f * 6 + k], p.cases[f]); });
  const seeds = plan.panels.map(p => p.seed);
  assert.equal(new Set(seeds).size, 6);assert.ok(!seeds.includes(4242) && !seeds.includes(screeningSeed(4242)) && !seeds.includes(31337));
  assert.deepEqual(plan.panels[0].cases, createMeta(pool.species, plan.specs[0].options).fixtures(5, seeds[0]));
  assert.deepEqual(S.plan(pool, opts).panels.map(p => p.cases), plan.panels.map(p => p.cases));
  // A sealed panel's fixture inside a sensitivity panel is refused, as is a training observation of one.
  const hit = plan.panels[2].cases[3], sealed = new Set([opponentFixtureKey(hit.team, hit.seed)]);
  assert.throws(() => S.plan(pool, { ...opts, sealedKeys: sealed }), /overlaps a sealed or training fixture/);
  assert.throws(() => S.plan(pool, { ...opts, observations: [{ opponent: hit.team.map(p => p.speciesId), seed: hit.seed, team: [0, 1, 2], score: 1 }] }), /overlap inherited training evidence/);
  assert.doesNotThrow(() => S.plan(pool, { ...opts, observations: [{ opponent: hit.team.map(p => p.speciesId), seed: hit.seed + 1, team: [0, 1, 2], score: 1 }] }));
  assert.throws(() => S.plan(pool, { ...opts, evidenceSeeds: [seeds[1]] }), /absorbed evidence/);
  assert.throws(() => S.plan(pool, { ...opts, groups: 'everything' }), /finalists or all/);
  assert.throws(() => S.plan(pool, { ...opts, fixtures: 0 }), /positive integer/);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget: the sensitivity battles move the training deadline earlier and nothing else', () => {
 const base = { start: 0, deadline: 7200000, now: 600000, screenTeams: 10, screenOpponents: 500, validationTeams: 5, validationOpponents: 1000, baselineCount: 5, newBattles: 6000 };
 const plain = trainingBudget(base), extra = trainingBudget({ ...base, sensitivityBattles: 5 * 128 * 6 });
 assert.equal(plain.estimatedEvaluationSeconds, 3000);
 // 6000 battles in 600 s is 10/s; the evaluation estimate gains (3840 battles x 2 per fixture) / 10 s and the deadline loses 1.25x that.
 assert.equal(extra.estimatedEvaluationSeconds, 3000 + 3840 * 2 / 10);
 assert.equal(extra.deadline, plain.deadline - 3840 * 2 / 10 * 1250);
 assert.ok(extra.deadline < plain.deadline);
 // Before enough battles are measured, and when the fixed 80% cap binds, nothing changes.
 assert.equal(trainingBudget({ ...base, newBattles: 100, sensitivityBattles: 9999 }).deadline, 5760000);
 assert.equal(trainingBudget({ ...base, newBattles: 30000, sensitivityBattles: 100 }).deadline, 5760000);
 assert.equal(trainingBudget({ ...base, sensitivityBattles: 0 }).deadline, plain.deadline);
});

test('summarizeTeam: means, min, spread, a deterministic bootstrap interval and a fixture-noise floor', () => {
 const constant = S.summarizeTeam([[.5, .5, .5, .5], [.5, .5, .5, .5], [.5, .5, .5, .5]], { seed: 3, resamples: 200 });
 assert.equal(constant.spread, 0);assert.deepEqual(constant.spreadInterval95, [0, 0]);assert.equal(constant.noiseSpread, 0);assert.equal(constant.mean, .5);
 const r = random(8), draw = p => Array.from({ length: 128 }, () => r() < p ? 1 : 0);
 const scores = [draw(.9), draw(.6), draw(.75)], team = S.summarizeTeam(scores, { seed: 4, resamples: 400 });
 const means = scores.map(s => s.reduce((a, b) => a + b, 0) / s.length);
 assert.deepEqual(team.scores, means);assert.equal(team.min, Math.min(...means));assert.equal(team.max, Math.max(...means));assert.ok(Math.abs(team.spread - (Math.max(...means) - Math.min(...means))) < 1e-12);
 assert.equal(team.minIndex, means.indexOf(Math.min(...means)));assert.equal(team.maxIndex, means.indexOf(Math.max(...means)));
 assert.ok(Math.abs(team.mean - means.reduce((a, b) => a + b, 0) / 3) < 1e-12);assert.ok(Math.abs(team.meanMinusSpread - (team.mean - team.spread)) < 1e-12);
 assert.ok(team.spreadInterval95[0] <= team.spread + .05 && team.spreadInterval95[1] >= team.spread - .05 && team.spreadInterval95[0] < team.spreadInterval95[1]);
 assert.deepEqual(S.summarizeTeam(scores, { seed: 4, resamples: 400 }), team);assert.notDeepEqual(S.summarizeTeam(scores, { seed: 5, resamples: 400 }).spreadInterval95, team.spreadInterval95);
 team.standardErrors.forEach((se, k) => assert.ok(Math.abs(se - Math.sqrt(means[k] * (1 - means[k]) / 127)) < 1e-9));
 // The noise floor: the median range of K normals with these standard errors; about 1.7 sd for K = 3.
 const sd = Math.sqrt(team.standardErrors.reduce((a, b) => a + b * b, 0) / 3);
 assert.ok(team.noiseSpread > 1.2 * sd && team.noiseSpread < 2.3 * sd, 'noise floor ' + team.noiseSpread + ' vs sd ' + sd);
 // Six metas with the same true score (a team that does not depend on the meta): the observed spread sits near the floor.
 const flat = S.summarizeTeam(Array.from({ length: 6 }, () => draw(.7)), { seed: 6, resamples: 400 });
 assert.ok(flat.spread < flat.noiseSpread * 2 && flat.noiseSpread > .05, 'flat spread ' + flat.spread + ' floor ' + flat.noiseSpread);
 // One fixture or one meta: no interval, no floor.
 const single = S.summarizeTeam([[1], [0], [.5]], { resamples: 100 });assert.equal(single.spreadInterval95, null);assert.equal(single.noiseSpread, null);assert.deepEqual(single.standardErrors, [null, null, null]);
 assert.equal(S.summarizeTeam([[.2, .4]], { resamples: 100 }).spreadInterval95, null);
 assert.deepEqual(S.ranksByMeta([{ scores: [.9, .5] }, { scores: [.9, .6] }, { scores: [.1, .6] }]), [[1, 3], [1, 1], [3, 1]]);
});

// A fake sweep over an interleaved list: row t scores a deterministic value from (team, position).
function fakeRows(info, teams, count) {
 return teams.map((t, ti) => ({ team: t.team, scores: Array.from({ length: count }, (_, i) => parseInt(digest([ti, i]).slice(0, 4), 16) % 3 / 2) }));
}
test('assemble keeps the same prefix on every meta and records the block', () => {
 const pool = writePool(null), plan = S.plan(pool, { fixtures: 6, validationSeed: 99, usage: {} }), teams = [{ team: [0, 1, 2], kind: 'finalist', primary: true, finalScore: .7 }, { team: [3, 4, 5], kind: 'finalist', primary: false, finalScore: .6 }];
 const K = plan.metaCount;assert.equal(K, 4);
 const full = S.assemble(plan, teams, fakeRows(plan, teams, 6 * K), { seed: 1, resamples: 100 });
 assert.equal(full.block.fixtures, 6);assert.equal(full.block.complete, true);assert.equal(full.block.requestedFixtures, 6);
 assert.equal(full.block.metas.length, K);full.block.metas.forEach((m, k) => { assert.equal(m.id, plan.panels[k].spec.id);assert.equal(m.fixtures, 6);assert.equal(m.seed, plan.panels[k].seed); });
 // Position f * K + k is fixture f of meta k: meta k's score is the mean of those positions.
 const rows = fakeRows(plan, teams, 6 * K);
 teams.forEach((t, ti) => full.block.teams[ti].scores.forEach((score, k) => {
  const expected = Array.from({ length: 6 }, (_, f) => rows[ti].scores[f * K + k]);assert.ok(Math.abs(score - expected.reduce((a, b) => a + b, 0) / 6) < 1e-12);
  assert.deepEqual(full.raw[plan.panels[k].spec.id][teamKey(t.team)], expected);
 }));
 assert.equal(full.block.teams[0].primary, true);assert.equal(full.block.teams[0].finalScore, .7);assert.equal(full.block.groups, 'finalists');
 // The deadline arrives after 21 of 24 interleaved positions: three metas have 6 fixtures, one has 5; every meta keeps 5.
 const partial = S.assemble(plan, teams, fakeRows(plan, teams, 21), { seed: 1, resamples: 100 });
 assert.equal(partial.block.fixtures, 5);assert.equal(partial.block.complete, false);assert.ok(partial.block.metas.every(m => m.fixtures === 5 && m.components));
 assert.equal(Object.values(partial.raw)[0][teamKey([0, 1, 2])].length, 5);
 assert.equal(partial.block.metas.reduce((n, m) => n + Object.values(m.components).reduce((a, b) => a + b, 0), 0), 5 * K);
 assert.match(S.caption(partial.block), /partial: the run ran out of time/);
 // Fewer positions than metas (or nothing): no block rather than a one-sided comparison.
 assert.equal(S.assemble(plan, teams, fakeRows(plan, teams, K - 1)), null);assert.equal(S.assemble(plan, teams, []), null);assert.equal(S.assemble(plan, teams, null), null);assert.equal(S.assemble(plan, [], []), null);
 // Rows from a common-panel sweep can arrive in any team order.
 const shuffled = fakeRows(plan, teams, 6 * K).reverse();assert.deepEqual(S.assemble(plan, teams, shuffled, { seed: 1, resamples: 100 }).block.teams.map(t => t.scores), full.block.teams.map(t => t.scores));
});

test('teamsFor: finalists first (primary flagged), baseline and champion teams only with groups all, each team once', () => {
 const state = { finalistTeams: [[0, 1, 2], [3, 4, 5]], validations: [{ team: [0, 1, 2], score: .8 }, { team: [3, 4, 5], score: .7 }], baselineResults: [{ team: [3, 5, 4], kind: 'previous-champions', score: .65 }, { team: [6, 7, 1], kind: 'uniform-random', score: .2 }, { team: [6, 1, 7], kind: 'greedy-scout-coverage', score: .3 }] };
 const finalists = S.teamsFor(state);
 assert.deepEqual(finalists.map(t => [t.team, t.kind, t.primary, t.finalScore]), [[[0, 1, 2], 'finalist', true, .8], [[3, 4, 5], 'finalist', false, .7]]);
 const all = S.teamsFor(state, { groups: 'all' });
 assert.deepEqual(all.map(t => t.kind), ['finalist', 'finalist', 'uniform-random']);   // the champion equals a finalist, the second random team equals the first
 assert.equal(all.filter(t => t.primary).length, 1);
 // A truncated final panel can leave the first screened finalist untested; the primary is still the screening winner.
 const truncated = S.teamsFor({ ...state, validations: [state.validations[1]] });
 assert.equal(truncated.length, 1);assert.equal(truncated[0].primary, false);
 assert.deepEqual(S.teamsFor({}), []);
});

test('the finalist-card line and table rows read the same everywhere', () => {
 const block = { fixtures: 128, requestedFixtures: 128, complete: true, metas: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], teams: [{ team: [0, 1, 2], kind: 'finalist', primary: true, finalScore: .835, scores: [.9, .625, .8], mean: .775, min: .625, minMeta: 'b', max: .9, maxMeta: 'a', spread: .275, spreadInterval95: [.2, .35], noiseSpread: .09 }] };
 assert.equal(S.line(block.teams[0], block), 'across 3 metas: min 62.5%, spread 27.5 points');
 const d = S.describe(block, t => t.join('-'));
 assert.deepEqual(d.header, ['Team', 'Kind', 'a', 'b', 'c', 'Run meta (final test)', 'Mean', 'Min', 'Spread (points)', 'Noise alone (points)']);
 assert.deepEqual(d.rows[0], ['Primary · 0-1-2', 'finalist', '90.0%', '62.5%', '80.0%', '83.5%', '77.5%', '62.5% (b)', '27.5 [20.0, 35.0]', '9.0']);
 assert.match(S.caption(block), /fixture noise alone gives a spread of about 9\.0 points/);assert.match(S.caption(block), /not selected for robustness/);
});

// ---- the standalone tool ----------------------------------------------------------------------------------------------

const lineup = (pool, ...i) => i.map(k => ({ speciesId: pool.species[k].speciesId, speciesName: pool.species[k].speciesName, moveset: pool.species[k].moveset }));
function writeRun(root, name, pool, rows, { checkpoint = true, usage = null, extra = {} } = {}) {
 const d = path.join(root, name); fs.mkdirSync(d);
 fs.writeFileSync(path.join(d, 'recommendations.json'), JSON.stringify({ version: VERSION, poolHash: pool.hash, finalPanel: { complete: true, completedFixtures: 512 }, baselineResults: [{ team: [6, 7, 1], kind: 'uniform-random', score: .2, fixtureSeed: 1234 }], rows: rows.map(([members, score]) => ({ team: members, validation: { score, fixtureSeed: 1234 }, screen: { fixtureSeed: 4321 } })), ...extra }));
 if (checkpoint) fs.writeFileSync(path.join(d, 'checkpoint.json'), JSON.stringify({ config: { beliefSamples: 2, lookaheadTurns: 6, decisionInterval: 5, validationSeed: 1234, screenSeed: 4321, meta: { weightPower: 1.25, usageHalfLifeDays: 30, usageAsOf: '2026-10-12', usagePriorStrength: 5, usageHash: usage ? require('node:crypto').createHash('sha256').update(fs.readFileSync(usage, 'utf8')).digest('hex') : null } }, beliefPrior: { roster: pool.species.map(p => ({ speciesId: p.speciesId, dex: p.dex, moveset: p.moveset, weight: 1 })), teams: [pool.species.slice(0, 3).map(p => p.speciesId)] } }));
 if (usage) fs.writeFileSync(path.join(d, 'launch.json'), JSON.stringify({ command: ['node', 'search.cjs', '--usage-file', usage, '--usage-half-life-days', '30', '--usage-as-of', '2026-10-12', '--usage-prior-strength', '5'] }));
 return d;
}
// Team strength depends on the meta: teams containing species 0 do well against opponents containing species 5 and badly otherwise.
const fakePlay = pool => async jobs => jobs.map(([team, opponent, , , options]) => {
 const hasLead = team.some(p => p.speciesId === pool.species[0].speciesId), vsFive = opponent.some(p => p.speciesId === pool.species[5].speciesId);
 const strength = (hasLead ? .8 : .4) + (vsFive ? .1 : -.1), noise = parseInt(digest([team.map(p => p.speciesId), opponent.map(p => p.speciesId), options.seed]).slice(0, 4), 16) / 65535;
 return { score: noise < strength ? 1 : 0 };
});

test('parseArgs: sources anywhere, typed options, the boolean --baselines', () => {
 const { opts, sources } = S.parseArgs(['runA', '--fixtures', '64', 'report.json.gz', '--baselines', '--metas', 'coherent,observed', '--seed', '9', '--scope', 'primary']);
 assert.deepEqual(sources, ['runA', 'report.json.gz']);assert.equal(opts.fixtures, 64);assert.equal(opts.baselines, true);assert.equal(opts.metas, 'coherent,observed');assert.equal(opts.seed, 9);assert.equal(opts.scope, 'primary');
 assert.equal(S.parseArgs(['x']).opts.baselines, false);assert.equal(S.parseArgs(['--help']).opts.help, true);assert.equal(S.parseArgs(['--print', 'f.json']).opts.print, 'f.json');
 assert.throws(() => S.parseArgs(['x', '--nonsense', '1']), /Unknown argument --nonsense/);assert.throws(() => S.parseArgs(['x', '--fixtures']), /Unknown argument/);
});

test('the standalone tool re-runs the panel for a run\'s finalists with the run\'s own usage settings and belief prior', async () => {
 const root = tmp(), poolFile = path.join(root, 'pool.json'), pool = writePool(poolFile), usage = path.join(root, 'usage.json');
 try {
  writeUsage(usage, pool);
  const run = writeRun(root, 'run', pool, [[lineup(pool, 0, 1, 2), .8], [lineup(pool, 3, 4, 5), .7], [lineup(pool, 4, 5, 6), .6]], { usage });
  const seen = [], play = async (jobs, o) => { seen.push(jobs); return fakePlay(pool)(jobs, o); };
  const opts = { ...S.DEFAULTS, pool: poolFile, fixtures: 16, workers: 1, seed: 2468, resamples: 200, bootstrap: 200 };
  const result = await S.sensitivityRun(opts, [run], { play, log: () => {} });
  assert.equal(result.format, 'pvp-team-sensitivity');assert.equal(result.exploratory, true);assert.equal(result.teams.length, 3);assert.equal(result.sensitivity.metas.length, 6);
  assert.equal(seen[0].length, 3 * 6 * 16);
  const job = seen[0][0];assert.equal(job[4].beliefSamples, 2);assert.equal(job[4].horizon, 6);assert.equal(job[4].interval, 5);assert.equal(job[4].beliefRoster.length, 8);assert.equal(job[4].cp, 1500);
  // Fixture-major, then meta, then team: the first three jobs are the three teams on fixture 0 of the first meta.
  assert.deepEqual(seen[0].slice(0, 3).map(j => j[4].seed), [job[4].seed, job[4].seed, job[4].seed]);assert.equal(new Set(seen[0].slice(0, 3).map(j => j[1].map(p => p.speciesId).join())).size, 1);
  assert.equal(result.usage.hashMatchesRun, true);assert.equal(result.usage.halfLifeDays, 30);assert.equal(result.usage.asOf, '2026-10-12');assert.equal(result.baseSeed, 2468);
  const b = result.sensitivity;
  assert.equal(b.fixtures, 16);assert.equal(b.complete, true);assert.equal(b.teams.length, 3);assert.equal(b.teams[0].primary, true);assert.equal(b.groups, 'finalists');
  for (const t of b.teams) { assert.equal(t.scores.length, 6);assert.ok(t.spread >= 0 && t.spread <= 1);assert.ok(t.min <= t.mean && t.mean <= t.max); }
  // The fake game makes teams with species 0 stronger and the meta with more of species 5 easier: scores must differ across metas.
  assert.ok(b.teams[0].spread > 0);assert.equal(b.teams[0].mean > b.teams[1].mean, true);
  assert.deepEqual(b.metas.map(m => m.id), S.ID_ORDER);assert.equal(new Set(b.metas.map(m => m.seed)).size, 6);
  assert.ok(b.metas.every(m => ![1234, 4321, screeningSeed(1234), 2468].includes(m.seed)));
  assert.equal(result.perMeta.length, 6);assert.ok(result.perMeta.every(p => p.radius > 0 && p.ranking.length === 3 && p.versusReference.length === 2));
  assert.equal(result.perMeta[0].versusReference[0].id, 't2');
  const table = S.formatTable(result);
  assert.match(table, /EXPLORATORY/);assert.match(table, /Primary · /);assert.match(table, /Best team per meta/);assert.match(table, /Order by mean − spread \(exploratory objective, not used for selection\)/);assert.match(table, /simultaneous 95% half-width/);
  assert.equal(table.includes('Alpha'), false);
  // Saved JSON round-trips through --print.
  const saved = path.join(root, 'sensitivity.json');fs.writeFileSync(saved, JSON.stringify(result));
  const printed = spawnSync(process.execPath, [path.join(__dirname, 'sensitivity.cjs'), '--print', saved], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);assert.match(printed.stdout, /Meta sensitivity · 16 fixtures per meta · 6 metas/);
  // Primary scope, a subset of metas, baselines on request, and no usage file: the observed metas are reported as not run.
  const small = await S.sensitivityRun({ ...opts, scope: 'primary', metas: 'coherent,independent-1.0', baselines: true, usageFile: '' }, [run], { play: fakePlay(pool), log: () => {} });
  assert.equal(small.teams.length, 2);assert.equal(small.teams[1].kind, 'uniform-random');assert.equal(small.sensitivity.groups, 'all');assert.deepEqual(small.sensitivity.metas.map(m => m.id), ['coherent', 'independent-1.0']);
  assert.ok(small.usage.file, 'the run\'s own launch.json supplies the usage file');
  // Fresh seeds when none is requested; a requested seed that a source used is refused.
  const random1 = await S.sensitivityRun({ ...opts, seed: 0, metas: 'coherent' }, [run], { play: fakePlay(pool), log: () => {} });
  assert.ok(Number.isInteger(random1.baseSeed) && ![1234, 4321].includes(random1.baseSeed));
  await assert.rejects(S.sensitivityRun({ ...opts, seed: 1234 }, [run], { play: fakePlay(pool), log: () => {} }), /panel seed of one of the sources/);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the standalone tool refuses what it cannot do honestly', async () => {
 const root = tmp(), poolFile = path.join(root, 'pool.json'), pool = writePool(poolFile);
 try {
  const noBelief = writeRun(root, 'nobelief', pool, [[lineup(pool, 0, 1, 2), .8]], { checkpoint: false });
  const opts = { ...S.DEFAULTS, pool: poolFile, fixtures: 8, workers: 1, resamples: 100, bootstrap: 100 };
  await assert.rejects(S.sensitivityRun(opts, [noBelief], { play: fakePlay(pool), log: () => {} }), /belief prior/);
  const run = writeRun(root, 'run', pool, [[lineup(pool, 0, 1, 2), .8]]);
  await assert.rejects(S.sensitivityRun({ ...opts, fixtures: 4 }, [run], { play: fakePlay(pool), log: () => {} }), /at least 8/);
  await assert.rejects(S.sensitivityRun({ ...opts, scope: 'nobody' }, [run], { play: fakePlay(pool), log: () => {} }), /finalists or primary/);
  await assert.rejects(S.sensitivityRun(opts, [], { play: fakePlay(pool), log: () => {} }), /Give a run directory/);
  await assert.rejects(S.sensitivityRun({ ...opts, metas: 'observed' }, [run], { play: fakePlay(pool), log: () => {} }), /No meta to test.*needs --usage-file/);
  await assert.rejects(S.sensitivityRun(opts, [run], { play: async jobs => jobs.slice(1).map(() => ({ score: .5 })), log: () => {} }), /did not complete every battle/);
  // A pool that is not the run's cannot map the finalists.
  const other = writePool(path.join(root, 'other.json'), 7), edge = writeRun(root, 'edge', pool, [[lineup(pool, 5, 6, 7), .8]]);
  await assert.rejects(S.sensitivityRun({ ...opts, pool: path.join(root, 'other.json') }, [edge], { play: fakePlay(other), log: () => {} }), /No team could be mapped/);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the launcher and the search accept the sensitivity options', () => {
 for (const script of ['launch.cjs', 'search.cjs']) {
  const out = spawnSync(process.execPath, [path.join(__dirname, script), '--sensitivity-fixtures', '64', '--sensitivity-groups', 'all', '--help'], { encoding: 'utf8' });
  assert.equal(out.status, 0, script + ': ' + out.stderr);
 }
 assert.match(spawnSync(process.execPath, [path.join(__dirname, 'search.cjs'), '--help'], { encoding: 'utf8' }).stdout, /--sensitivity-fixtures 128\] \[--sensitivity-groups finalists\|all\]/);
});
