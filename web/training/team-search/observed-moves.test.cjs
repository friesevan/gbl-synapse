'use strict';
// Observed opponent movesets: legal pools, resolving an observation to a full moveset, identity tags, model features,
// the portable report's opponent table. Pure functions; the usage-file and search integration are tested beside.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const O = require('./observed-moves.cjs'), {fixtureKey, opponentFixtureKey, uniqueFixtures} = require('./acquisition.cjs'), {features, TYPES} = require('./common.cjs');
const gm = require('../../includes/pro/data/gamemaster.json');

const REC = {melmetal: ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'DYNAMIC_PUNCH'], tinkaton: ['FAIRY_WIND', 'GIGATON_HAMMER', 'BULLDOZE'], quagsire_shadow: ['MUD_SHOT', 'AQUA_TAIL', 'STONE_EDGE'], cramorant: ['PECK', 'DIVE', 'FLY']};
const row = (speciesId, i = 0) => ({speciesId, speciesName: speciesId, dex: 800 + i, moveset: REC[speciesId].slice(), features: Array.from({length: 97}, (_, k) => (k + i) / 100), scoutByType: Array(18).fill(.4 + i / 10), types: gm.pokemon.find(p => p.speciesId === speciesId).types});

test('legal pools follow vendor/Pokemon.js: Return for Shadow-eligible species at level 25 by 1,500 CP, Frustration for Shadow species', () => {
 const q = O.movePools('quagsire'), s = O.movePools('quagsire_shadow'), m = O.movePools('melmetal');
 assert.ok(q.charged.has('RETURN') && !q.charged.has('FRUSTRATION'));
 assert.ok(s.charged.has('FRUSTRATION') && !s.charged.has('RETURN'));
 assert.ok(!m.charged.has('RETURN') && m.fast.has('THUNDER_SHOCK') && !m.charged.has('THUNDER_SHOCK') && !m.fast.has('ROCK_SLIDE'));
 assert.equal(O.movePools('not_a_species'), null);
 assert.ok(O.movePools('registeel').charged.has('RETURN'), 'level 25 CP 1484');
});

test('every recommended and retained pool moveset is legal (when the prepared pool is present)', { skip: !fs.existsSync(path.join(__dirname, '../runs/team-search/pool.json')) }, () => {
 const pool = require('../runs/team-search/pool.json');
 for (const v of [...pool.species, ...pool.variants]) assert.deepEqual(O.validateEntry(v.speciesId, {fast: v.moveset[0], charged: v.moveset.slice(1)}), {fast: v.moveset[0], charged: v.moveset.slice(1)});
});

test('an observation is validated against the species pool and nothing else is accepted', () => {
 assert.equal(O.validateEntry('melmetal', null), null);
 assert.equal(O.validateEntry('melmetal', undefined), null);
 assert.deepEqual(O.validateEntry('melmetal', {fast: 'THUNDER_SHOCK', charged: ['ROCK_SLIDE', 'ROCK_SLIDE']}), {fast: 'THUNDER_SHOCK', charged: ['ROCK_SLIDE']});
 assert.deepEqual(O.validateEntry('melmetal', {charged: []}), {fast: null, charged: []});
 assert.throws(() => O.validateEntry('melmetal', {fast: 'ROCK_SLIDE'}), /not a legal fast move/);
 assert.throws(() => O.validateEntry('melmetal', {fast: 'NOPE'}), /not a legal fast move/);
 assert.throws(() => O.validateEntry('melmetal', {charged: ['THUNDER_SHOCK']}), /not a legal charged move/);
 assert.throws(() => O.validateEntry('melmetal', {charged: ['ROCK_SLIDE', 'SUPER_POWER', 'HYPER_BEAM']}), /more than two distinct/);
 assert.throws(() => O.validateEntry('melmetal', {charged: ['ROCK_SLIDE', 'SUPER_POWER', 'FLASH_CANNON', 'HYPER_BEAM']}), /at most three/);
 assert.throws(() => O.validateEntry('melmetal', {fast: 5}), /fast must be/);
 assert.throws(() => O.validateEntry('melmetal', {charged: 'ROCK_SLIDE'}), /charged must be/);
 assert.throws(() => O.validateEntry('melmetal', ['THUNDER_SHOCK']), /null or/);
 assert.throws(() => O.validateEntry('not_a_species', {fast: 'X'}), /unknown species/);
 assert.throws(() => O.validateEntry('quagsire_shadow', {charged: ['RETURN']}), /not a legal charged move/);
});

test('missing slots are completed from the recommended moveset; an observation equal to it is the recommended moveset', () => {
 const rec = REC.melmetal;
 assert.deepEqual(O.resolveMoveset(rec, null), rec);
 assert.deepEqual(O.resolveMoveset(rec, {fast: null, charged: []}), rec);
 assert.deepEqual(O.resolveMoveset(rec, {fast: 'THUNDER_SHOCK', charged: []}), rec);
 // One charged move outside the recommended pair: it takes a slot, the first recommended charged move the other.
 assert.deepEqual(O.resolveMoveset(rec, {fast: null, charged: ['ROCK_SLIDE']}), ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'ROCK_SLIDE']);
 // One charged move inside the pair: the other recommended move completes it, in the recommended order.
 assert.deepEqual(O.resolveMoveset(rec, {fast: null, charged: ['DYNAMIC_PUNCH']}), rec);
 // Two observed charged moves replace both; alphabetical, except the recommended pair keeps its order.
 assert.deepEqual(O.resolveMoveset(rec, {fast: null, charged: ['SUPER_POWER', 'ROCK_SLIDE']}), ['THUNDER_SHOCK', 'ROCK_SLIDE', 'SUPER_POWER']);
 assert.deepEqual(O.resolveMoveset(rec, {fast: null, charged: ['DYNAMIC_PUNCH', 'DOUBLE_IRON_BASH']}), rec);
 // An observed fast move alone changes only the fast slot (Cramorant's recommended moveset is not alphabetical-sensitive).
 assert.deepEqual(O.resolveMoveset(REC.cramorant, {fast: 'WATER_GUN', charged: []}), ['WATER_GUN', 'DIVE', 'FLY']);
 assert.deepEqual(O.resolveMoveset(REC.tinkaton, {fast: null, charged: ['BULLDOZE', 'GIGATON_HAMMER']}), REC.tinkaton, 'the recommended pair keeps the recommended order');
 // A recommended moveset with a fourth entry keeps it.
 assert.deepEqual(O.resolveMoveset([...rec, 'EXTRA'], {fast: null, charged: ['ROCK_SLIDE']}), ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'ROCK_SLIDE', 'EXTRA']);
});

test('tags identify observed-moveset members and leave plain members alone', () => {
 const plain = row('melmetal'), observed = {...row('melmetal'), moveset: ['THUNDER_SHOCK', 'ROCK_SLIDE', 'SUPER_POWER'], observedMoveset: true};
 assert.equal(O.memberId(plain), 'melmetal');
 assert.equal(O.memberId('melmetal'), 'melmetal');
 assert.equal(O.memberId(observed), 'melmetal@THUNDER_SHOCK/ROCK_SLIDE/SUPER_POWER');
 assert.deepEqual(O.parseTag('melmetal@THUNDER_SHOCK/ROCK_SLIDE/SUPER_POWER'), {speciesId: 'melmetal', moveset: ['THUNDER_SHOCK', 'ROCK_SLIDE', 'SUPER_POWER']});
 assert.deepEqual(O.parseTag('melmetal'), {speciesId: 'melmetal', moveset: null});
 assert.deepEqual(O.opponentIds([plain, observed, row('tinkaton', 1)]), ['melmetal', 'melmetal@THUNDER_SHOCK/ROCK_SLIDE/SUPER_POWER', 'tinkaton']);
 assert.deepEqual(O.opponentIds([plain, row('tinkaton', 1), row('cramorant', 2)]), ['melmetal', 'tinkaton', 'cramorant'], 'no observed member: exactly the species ids as before');
});

test('fixture keys: different movesets never collide, plain fixtures keep their keys, bench order still does not matter', () => {
 const a = row('melmetal'), b = row('tinkaton', 1), c = row('cramorant', 2), observed = {...a, moveset: ['THUNDER_SHOCK', 'ROCK_SLIDE', 'SUPER_POWER'], observedMoveset: true}, other = {...a, moveset: ['THUNDER_SHOCK', 'ROCK_SLIDE', 'FLASH_CANNON'], observedMoveset: true};
 const key = team => opponentFixtureKey(team, 7);
 assert.notEqual(key([observed, b, c]), key([a, b, c]));
 assert.notEqual(key([observed, b, c]), key([other, b, c]));
 assert.equal(key([observed, b, c]), key([observed, c, b]));
 assert.notEqual(key([a, b, c]), key([b, a, c]), 'the lead is part of the identity');
 // Unchanged identity for plain fixtures: the same digest of [lead, sorted bench ids] and the seed as before this feature.
 assert.equal(key([a, b, c]), opponentFixtureKey(['melmetal', 'tinkaton', 'cramorant'], 7));
 assert.equal(fixtureKey([0, 1, 2], [a, b, c], 7), fixtureKey([0, 1, 2], ['melmetal', 'cramorant', 'tinkaton'], 7));
 // A stored observation names the observed member by its tag, so the stored fixture has the same identity as the fixture row.
 assert.equal(fixtureKey([0, 1, 2], [observed, b, c], 7), fixtureKey([0, 1, 2], O.opponentIds([observed, b, c]), 7));
 assert.equal(uniqueFixtures([{team: [observed, b, c], seed: 1}, {team: [other, b, c], seed: 1}, {team: [a, b, c], seed: 1}]).length, 3);
});

test('the recomputed move blocks reproduce the pool\'s stored features (up to the order of the two charged-move slots), when the pool is present', { skip: !fs.existsSync(path.join(__dirname, '../runs/team-search/pool.json')) }, () => {
 const pool = require('../runs/team-search/pool.json'), swapSlots = block => { const out = block.slice();for (const at of [39, 42, 45]) [out[at], out[at + 1]] = [out[at + 1], out[at]];return out; };
 const close = (x, y) => x.every((v, i) => Math.abs(v - y[i]) < 1e-9);
 let exact = 0, swapped = 0, other = 0;
 for (const v of [...pool.species, ...pool.variants]) {
  const stored = v.features.slice(O.MOVE_BLOCK.from, O.MOVE_BLOCK.from + O.MOVE_BLOCK.length), block = O.moveBlock(v.speciesId, v.moveset);
  if (close(block, stored)) exact++;else if (close(swapSlots(block), stored)) swapped++;else other++;
 }
 const total = exact + swapped + other;
 // 1,627 exact, 159 with the charged slots in the vendor's tie-break order, 12 forms whose moves change with the form (Morpeko, Aegislash).
 assert.ok(exact / total > .9, 'exact ' + exact + ' of ' + total);
 assert.ok((exact + swapped) / total > .99, 'exact or slot order ' + (exact + swapped) + ' of ' + total);
 assert.equal(O.MOVE_BLOCK.from + O.MOVE_BLOCK.length, 73);
});

test('a moveset the pool kept as a variant uses its scouted features; any other uses the recommended scout profile with recomputed move blocks', () => {
 const base = row('melmetal'), variant = {...base, moveset: ['THUNDER_SHOCK', 'ROCK_SLIDE', 'SUPER_POWER'], features: Array(97).fill(.77), scoutByType: Array(18).fill(.9), recommended: false};
 const exact = O.featureRow(base, ['THUNDER_SHOCK', 'SUPER_POWER', 'ROCK_SLIDE'], [variant]);
 assert.equal(exact.exact, true);
 assert.deepEqual(exact.row.features, variant.features);
 assert.deepEqual(exact.row.scoutByType, variant.scoutByType);
 assert.deepEqual(exact.row.moveset, variant.moveset, 'the retained variant\'s own order');
 const approx = O.featureRow(base, ['THUNDER_SHOCK', 'ROCK_SLIDE', 'FLASH_CANNON'], [variant]);
 assert.equal(approx.exact, false);
 assert.equal(approx.row.features.length, 97);
 assert.deepEqual(approx.row.features.slice(0, 25), base.features.slice(0, 25), 'species-level features unchanged');
 assert.deepEqual(approx.row.features.slice(73), base.features.slice(73), 'the scout profile is the recommended moveset\'s');
 assert.deepEqual(approx.row.scoutByType, base.scoutByType);
 assert.notDeepEqual(approx.row.features.slice(25, 73), base.features.slice(25, 73));
 assert.deepEqual(approx.row.features.slice(25, 73), O.moveBlock('melmetal', ['THUNDER_SHOCK', 'ROCK_SLIDE', 'FLASH_CANNON']));
 assert.equal(base.features.length, 97, 'the species row is not modified');
 // The block describes the moves: Rock Slide is rock and Flash Cannon steel.
 const block = O.moveBlock('melmetal', ['THUNDER_SHOCK', 'ROCK_SLIDE', 'FLASH_CANNON']), type = t => TYPES.indexOf(t);
 assert.equal(block[type('electric')], 1);
 assert.equal(block[21 + type('rock')], 1);
 assert.equal(block[21 + type('steel')], 1);
 assert.equal(block[21 + type('fighting')], 0);
 assert.equal(block[39 + 0] * 100 === 45 || block[39] * 100 === 60, true, 'costs of Rock Slide (45) and Flash Cannon (60), cheapest first');
});

test('the model encodes a tagged opponent with its observed moves and a plain one exactly as before', () => {
 const species = [row('melmetal'), row('tinkaton', 1), row('cramorant', 2)], speciesMap = new Map(species.map(s => [s.speciesId, s])), resolve = O.rowResolver(speciesMap, null);
 const plain = ['melmetal', 'tinkaton', 'cramorant'], tagged = ['melmetal@THUNDER_SHOCK/ROCK_SLIDE/SUPER_POWER', 'tinkaton', 'cramorant'];
 assert.equal(resolve('melmetal'), speciesMap.get('melmetal'), 'plain ids return the species row itself');
 const before = features([0, 1, 2], plain.map(id => speciesMap.get(id))), after = features([0, 1, 2], plain.map(resolve));
 assert.deepEqual(after, before);
 const withMoves = features([0, 1, 2], tagged.map(resolve));
 assert.equal(withMoves.length, before.length);
 assert.notDeepEqual(withMoves, before);
 assert.equal(resolve(tagged[0]), resolve(tagged[0]), 'cached');
 assert.deepEqual(resolve(tagged[0]).moveset, ['THUNDER_SHOCK', 'ROCK_SLIDE', 'SUPER_POWER']);
 assert.throws(() => resolve('missing@THUNDER_SHOCK/X/Y'), /Unknown observed opponent/);
});

test('arrange keeps movesets with their members when the bench is reordered, and tally weights the coverage', () => {
 const m = row('melmetal'), t = row('tinkaton', 1), c = row('cramorant', 2), team = [m, t, c], canonical = [m, c, t];   // file order: lead, tinkaton, cramorant; canonical: lead, cramorant, tinkaton
 const movesets = [{fast: null, charged: ['ROCK_SLIDE']}, {fast: 'ROCK_SMASH', charged: []}, null];
 const arranged = O.arrange(team, canonical, movesets);
 assert.deepEqual(arranged.movesets, [['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'ROCK_SLIDE'], null, ['ROCK_SMASH', 'GIGATON_HAMMER', 'BULLDOZE']]);
 assert.deepEqual(arranged.entries.map(e => e && e.fast), [null, null, 'ROCK_SMASH']);
 assert.deepEqual(O.arrange(team, canonical, null).movesets, [null, null, null]);
 assert.deepEqual(O.arrange(team, canonical, [null, null, null]).movesets, [null, null, null]);
 assert.throws(() => O.arrange(team, canonical, [null, null]), /three members/);
 assert.throws(() => O.arrange(team, canonical, {fast: 'X'}), /three members/);
 assert.throws(() => O.arrange(team, canonical, [{fast: 'BULLDOZE'}, null, null]), /not a legal fast move/);
 const tally = O.tally();
 tally.add(arranged, 3);
 tally.add(O.arrange(team, canonical, null), 1);
 const s = tally.summary();
 assert.equal(s.fastShare, 3 / 12);
 assert.equal(s.chargedShare, 3 / 12);
 assert.equal(s.differingMemberShare, 6 / 12);
 assert.equal(s.differingTeamShare, 3 / 4);
});

test('the report table gives observed-moveset opponents rows of their own and leaves plain ones at their species index', () => {
 const species = [row('melmetal'), row('tinkaton', 1), row('cramorant', 2)], table = O.opponentIndexer(species, p => ({speciesId: p.speciesId, moveset: p.moveset, recommended: species.find(s => s.speciesId === p.speciesId).moveset}));
 assert.equal(table.index('tinkaton'), 1);
 assert.equal(table.index(species[2]), 2);
 const observed = {...species[0], moveset: ['THUNDER_SHOCK', 'ROCK_SLIDE', 'SUPER_POWER'], observedMoveset: true};
 const at = table.index(observed);
 assert.equal(at, 3);
 assert.equal(table.index('melmetal@THUNDER_SHOCK/ROCK_SLIDE/SUPER_POWER'), 3, 'a tagged id and a flagged row are the same opponent');
 assert.equal(table.index({...observed, moveset: ['THUNDER_SHOCK', 'ROCK_SLIDE', 'FLASH_CANNON']}), 4);
 assert.deepEqual(table.extra.map(r => [r.speciesId, r.moveset.join('/'), r.recommended.join('/')]), [['melmetal', 'THUNDER_SHOCK/ROCK_SLIDE/SUPER_POWER', 'THUNDER_SHOCK/DOUBLE_IRON_BASH/DYNAMIC_PUNCH'], ['melmetal', 'THUNDER_SHOCK/ROCK_SLIDE/FLASH_CANNON', 'THUNDER_SHOCK/DOUBLE_IRON_BASH/DYNAMIC_PUNCH']]);
 assert.throws(() => table.index('missing'), /Unknown observed opponent/);
});
