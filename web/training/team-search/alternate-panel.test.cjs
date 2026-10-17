'use strict';
// The alternate-moveset stress panel: which alternates are chosen, how the arms are built and interleaved, what the block
// records and how it reads. The search wiring is tested in search-moves.test.cjs.
const test = require('node:test'), assert = require('node:assert/strict');
const A = require('./alternate-panel.cjs'), {createMeta} = require('./meta.cjs'), {teamKey} = require('./common.cjs'), {trainingBudget} = require('./budget.cjs');
const gm = require('../../includes/pro/data/gamemaster.json');

const REC = {melmetal: ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'DYNAMIC_PUNCH'], tinkaton: ['FAIRY_WIND', 'GIGATON_HAMMER', 'BULLDOZE'], cramorant: ['PECK', 'DIVE', 'FLY'], altaria: ['DRAGON_BREATH', 'MOONBLAST', 'FLAMETHROWER']};
const species = Object.keys(REC).map((id, i) => ({speciesId: id, speciesName: id, dex: gm.pokemon.find(p => p.speciesId === id).dex, weight: 4 - i, moveset: REC[id], features: Array(97).fill(.2), scoutByType: Array(18).fill(.4), types: []}));
// Five retained variants per species, scouted best first except melmetal, whose recommended moveset is only the third best.
const variants = [
 ...['ROCK_SLIDE', 'SUPER_POWER', 'FLASH_CANNON', 'THUNDERBOLT'].map((m, i) => ({speciesId: 'melmetal', moveset: ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', m], scoutScore: .6 - i / 100})),
 {speciesId: 'melmetal', moveset: REC.melmetal, scoutScore: .595},
 ...['ROCK_SMASH'].flatMap(f => [{speciesId: 'tinkaton', moveset: [f, 'GIGATON_HAMMER', 'BULLDOZE'], scoutScore: .4}]), {speciesId: 'tinkaton', moveset: REC.tinkaton, scoutScore: .7},
 {speciesId: 'cramorant', moveset: REC.cramorant, scoutScore: .5},          // no alternate at all
 {speciesId: 'altaria', moveset: REC.altaria, scoutScore: .9}, {speciesId: 'altaria', moveset: ['PECK', 'MOONBLAST', 'FLAMETHROWER'], scoutScore: .5},   // one alternate
];
const prepared = {species, variants};

test('alternates are the species\' retained variants other than the recommended one, best scouted first', () => {
 const alts = A.alternates(prepared);
 assert.deepEqual(alts.get('melmetal').map(m => m[2]), ['ROCK_SLIDE', 'SUPER_POWER', 'FLASH_CANNON', 'THUNDERBOLT'], 'the recommended moveset (third best) is not an alternate, whatever its rank');
 assert.deepEqual(alts.get('tinkaton'), [['ROCK_SMASH', 'GIGATON_HAMMER', 'BULLDOZE']]);
 assert.deepEqual(alts.get('cramorant'), []);
 assert.deepEqual(alts.get('altaria'), [['PECK', 'MOONBLAST', 'FLAMETHROWER']]);
 // The recommended moveset in another order is still the recommended one.
 const reordered = {species, variants: [{speciesId: 'melmetal', moveset: ['THUNDER_SHOCK', 'DYNAMIC_PUNCH', 'DOUBLE_IRON_BASH'], scoutScore: .9}, {speciesId: 'melmetal', moveset: ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'ROCK_SLIDE'], scoutScore: .5}]};
 assert.deepEqual(A.alternates(reordered).get('melmetal').map(m => m[2]), ['ROCK_SLIDE']);
});

test('an arm gives every member its rank-th alternate; a species with fewer uses its last, one with none keeps its moveset', () => {
 const alts = A.alternates(prepared), row = id => species.find(s => s.speciesId === id);
 const c = {team: [row('melmetal'), row('altaria'), row('cramorant')], seed: 9, component: 'observed'};
 const one = A.swapCase(c, alts, 1), two = A.swapCase(c, alts, 2);
 assert.deepEqual(one.case.team.map(p => p.moveset[2]), ['ROCK_SLIDE', 'FLAMETHROWER', 'FLY']);
 assert.equal(one.case.team[1].moveset[0], 'PECK');
 assert.deepEqual(two.case.team.map(p => p.moveset[2]), ['SUPER_POWER', 'FLAMETHROWER', 'FLY'], 'altaria has one alternate, so its second arm repeats it');
 assert.deepEqual([one.changed, two.changed], [2, 2]);
 assert.equal(one.case.team[2], c.team[2], 'a member with no alternate is the same object');
 assert.deepEqual(c.team.map(p => p.moveset), [REC.melmetal, REC.altaria, REC.cramorant], 'the fixture is not modified');
 assert.equal(one.case.seed, 9);
 assert.equal(one.case.team[0].alternateRank, 1);
 // An observed member leaves its observed flags behind: it now plays the alternate.
 const observed = {...row('melmetal'), moveset: ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'ROCK_SLIDE'], observedMoveset: true, recommendedMoveset: REC.melmetal};
 const swapped = A.swapCase({team: [observed, row('altaria'), row('cramorant')], seed: 1}, alts, 2).case.team[0];
 assert.equal(swapped.moveset[2], 'SUPER_POWER');
 assert.equal('observedMoveset' in swapped, false);
 // An alternate that is the moveset the member already plays changes nothing.
 assert.equal(A.swapCase({team: [observed, row('altaria'), row('cramorant')], seed: 1}, alts, 1).changed, 1);
 assert.equal(A.swapCase({team: [{...observed, moveset: ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'ROCK_SLIDE']}, row('altaria'), row('cramorant')], seed: 1}, alts, 1).case.team[0].moveset[2], 'ROCK_SLIDE');
});

test('the plan interleaves the arms fixture by fixture on the run\'s own meta and counts the battles', () => {
 const meta = createMeta(species.map(s => ({...s, types: undefined})), {mode: 'independent'}), info = A.plan(prepared, meta, {fixtures: 5, seed: 321});
 assert.deepEqual(info.arms, ['run', 'alternate-1', 'alternate-2']);
 assert.equal(info.interleaved.length, 15);
 assert.equal(info.battles(8), 8 * 5 * 3);
 info.cases.forEach((c, f) => {
  const [run, one, two] = info.interleaved.slice(f * 3, f * 3 + 3);
  assert.equal(run, c);
  for (const arm of [one, two]) { assert.equal(arm.seed, c.seed);assert.deepEqual(arm.team.map(p => p.speciesId), c.team.map(p => p.speciesId), 'same opponent species in the same order'); }
 });
 assert.deepEqual(info.cases, meta.fixtures(5, 321), 'the base arm is the meta\'s own fixture list for the seed');
 assert.equal(info.levels.length, 2);
 for (const l of info.levels) { assert.equal(l.members, 15);assert.ok(l.changedMembers > 0 && l.changedMembers <= 15);assert.ok(l.changedFixtures <= 5); }
 // Sealed panels and training evidence are refused.
 assert.throws(() => A.plan(prepared, meta, {fixtures: 5, seed: 321, sealed: [meta.fixtures(5, 321)]}), /overlap a sealed/);
 const first = info.cases[0];
 assert.throws(() => A.plan(prepared, meta, {fixtures: 5, seed: 321, observations: [{team: [0, 1, 2], opponent: first.team.map(p => p.speciesId), seed: first.seed}]}), /overlap inherited training evidence/);
 A.plan(prepared, meta, {fixtures: 5, seed: 321, sealed: [meta.fixtures(5, 322)], observations: [{team: [0, 1, 2], opponent: ['melmetal', 'tinkaton', 'cramorant'], seed: 1}]});
 assert.throws(() => A.plan(prepared, meta, {fixtures: 5, seed: 321, evidenceSeeds: [321]}), /absorbed evidence/);
});

test('size, seed and budget', () => {
 assert.equal(A.checkSize(0), 0);
 assert.equal(A.checkSize(64), 64);
 for (const bad of [-1, 1.5, 4097, '8', NaN]) assert.throws(() => A.checkSize(bad), /alternate-panel must be/, String(bad));
 const reserved = [10, 20, 30];
 assert.equal(A.panelSeed(123456, reserved), 123456 + A.SEED_OFFSET);
 assert.equal(A.panelSeed(10 - A.SEED_OFFSET + 2 ** 32, reserved) >>> 0, 11, 'a reserved seed is skipped');
 assert.notEqual(A.SEED_OFFSET, 830001, 'not the policy panel\'s or the confirmation bootstrap\'s offset');
 const base = {start: 0, deadline: 7200000, now: 600000, newBattles: 6000, screenTeams: 10, screenOpponents: 500, validationTeams: 5, validationOpponents: 1000, baselineCount: 5};
 const without = trainingBudget(base), withPanel = trainingBudget({...base, alternateBattles: 3000});
 assert.equal(withPanel.estimatedEvaluationSeconds, without.estimatedEvaluationSeconds + 3000 / 10, '6000 battles in 600 s: 10 per second');
 assert.ok(withPanel.deadline < without.deadline, 'the panel moves the end of training earlier');
 assert.deepEqual(trainingBudget({...base, alternateBattles: 0}), without);
});

const rowsFor = (teams, arms, n, fn) => teams.map((t, ti) => ({team: t.team, scores: Array.from({length: n * arms}, (_, p) => fn(ti, Math.floor(p / arms), p % arms))}));
test('assemble pairs the arms by fixture, keeps only whole fixtures and records deltas with simultaneous bands', () => {
 const meta = createMeta(species, {mode: 'independent'}), info = A.plan(prepared, meta, {fixtures: 40, seed: 5}), teams = [{team: [0, 1, 2], primary: true, finalScore: .6}, {team: [3, 4, 5], primary: false, finalScore: .55}];
 // Team 0 loses 10 points to the best alternate and 20 to the second; team 1 is unaffected. Scores are the same fixtures' outcomes plus a fixture effect.
 const score = (ti, f, arm) => Math.max(0, Math.min(1, .5 + .2 * Math.sin(f) + (ti === 0 ? [0, -.1, -.2][arm] : 0)));
 const rows = rowsFor(teams, 3, 40, score), {block, raw} = A.assemble(info, teams, rows, {seed: 11});
 assert.equal(block.version, 1);
 assert.deepEqual([block.requestedFixtures, block.fixtures, block.complete, block.exploratory], [40, 40, true, true]);
 assert.equal(block.seed, 5);
 assert.deepEqual(block.reference.id, 'run');
 assert.deepEqual(block.levels.map(l => [l.id, l.rank, l.label]), [['alternate-1', 1, 'Best alternate moveset'], ['alternate-2', 2, 'Second alternate moveset']]);
 const [t0, t1] = block.teams;
 assert.deepEqual(t0.team, [0, 1, 2]);assert.equal(t0.primary, true);assert.equal(t0.finalScore, .6);assert.equal(t1.primary, false);
 assert.ok(Math.abs(t0.deltas[0].delta + .1) < 1e-9 && Math.abs(t0.deltas[1].delta + .2) < 1e-9);
 assert.ok(Math.abs(t1.deltas[0].delta) < 1e-9);
 assert.equal(t0.deltas[0].verdict, 'lower');
 assert.equal(t0.deltas[1].verdict, 'lower');
 assert.equal(t1.deltas[0].verdict, 'unresolved');
 assert.equal(t0.worstLevel, 'alternate-2');assert.ok(Math.abs(t0.worstDelta + .2) < 1e-9);
 assert.ok(t0.deltas.every(d => d.interval95[0] <= d.delta && d.delta <= d.interval95[1]));
 assert.ok(Math.abs(t0.scores.run - raw[teamKey([0, 1, 2])].run.reduce((a, b) => a + b, 0) / 40) < 1e-12);
 assert.equal(raw[teamKey([0, 1, 2])]['alternate-2'].length, 40);
 assert.deepEqual(A.assemble(info, teams, rows, {seed: 11}).block, block, 'deterministic');
 // A deadline: every team has 100 of 120 positions, which is 33 whole fixtures; the incomplete fixture is dropped.
 const cut = rows.map(r => ({...r, scores: r.scores.slice(0, 100)})), partial = A.assemble(info, teams, cut, {seed: 11}).block;
 assert.deepEqual([partial.fixtures, partial.requestedFixtures, partial.complete], [33, 40, false]);
 assert.equal(A.assemble(info, teams, rows.map(r => ({...r, scores: r.scores.slice(0, 2)}))), null, 'not even one whole fixture');
 assert.equal(A.assemble(info, teams, []), null);
});

test('the text is built from the block alone', () => {
 const meta = createMeta(species, {mode: 'independent'}), info = A.plan(prepared, meta, {fixtures: 40, seed: 5, observed: true}), teams = [{team: [0, 1, 2], primary: true, finalScore: .6}, {team: [3, 4, 5], primary: false, finalScore: .55}];
 const rows = rowsFor(teams, 3, 40, (ti, f, arm) => Math.max(0, Math.min(1, .6 + .2 * Math.sin(f) + [0, -.05, -.1][arm]))), {block} = A.assemble(info, teams, rows, {seed: 3});
 const name = team => team.map(i => 'P' + i).join('/'), text = A.caption(block, name);
 assert.match(text, /^Alternate opponent movesets \(40 common fixtures, after the final test\)/);
 assert.match(text, /P0\/P1\/P2 scored \d+\.\d% with the modelled movesets, \d+\.\d% \(−5\.0 pp\) with the best alternate and \d+\.\d% \(−10\.0 pp\) with the second alternate/);
 assert.match(text, /worst arm changed the score by −10\.0 to −10\.0 pp/);
 assert.match(text, /Exploratory: fewer than 256 fixtures/);
 assert.match(text, /\d+% and \d+% of members changed/);
 assert.equal(A.caption({...block, teams: []}), '');
 const table = A.describe(block, name);
 assert.equal(table.header.length, 2 + 2 * block.levels.length);
 assert.match(table.header[1], /Run opponents \(observed movesets where recorded/);
 assert.equal(table.rows.length, 2);
 assert.match(table.rows[0][0], /^Primary · P0\/P1\/P2$/);
 assert.match(table.rows[0][3], /^−5\.0 pp \[[−+]\d+\.\d, [−+]\d+\.\d\] lower$/);
 const pool = {variants: Array.from({length: 6}, (_, i) => ({speciesName: 'P' + i}))}, escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
 const html = A.html({alternatePanel: block}, pool, {escape, pct: x => x}), md = A.markdown({alternatePanel: block}, pool);
 assert.match(html, /<h2>Alternate opponent movesets<\/h2>/);assert.match(html, /<tr class="primary">/);assert.match(html, /P0 · P1 · P2/);
 assert.match(md, /^\nAlternate opponent movesets \(40 common fixtures/);assert.match(md, /- Primary · P0 \/ P1 \/ P2: \d+\.\d% modelled; alternate-1 −5\.0 pp \[/);
 assert.equal(A.html({}, pool, {escape, pct: x => x}), '');assert.equal(A.markdown({}, pool), '');
});
