'use strict';
// --observed-moves in meta.cjs: the usage file's optional per-member movesets reach the observed opponents only when asked for.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createMeta, loadUsage} = require('./meta.cjs'), O = require('./observed-moves.cjs'), {opponentFixtureKey} = require('./acquisition.cjs');
const gm = require('../../includes/pro/data/gamemaster.json');

const RECOMMENDED = {melmetal: ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'DYNAMIC_PUNCH'], tinkaton: ['FAIRY_WIND', 'GIGATON_HAMMER', 'BULLDOZE'], cramorant: ['PECK', 'DIVE', 'FLY'], altaria: ['DRAGON_BREATH', 'MOONBLAST', 'FLAMETHROWER'], mimikyu: ['SHADOW_CLAW', 'SHADOW_SNEAK', 'PLAY_ROUGH']};
const species = Object.keys(RECOMMENDED).map((id, i) => ({speciesId: id, dex: gm.pokemon.find(p => p.speciesId === id).dex, weight: 5 - i, moveset: RECOMMENDED[id], features: Array(97).fill(.2), scoutByType: Array(18).fill(.4)}));
const withFile = (teams, body) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-meta-moves-')), file = path.join(dir, 'usage.json'); try { fs.writeFileSync(file, JSON.stringify({source: 'test', cp: 1500, cup: 'all', teams})); return body(file); } finally { fs.rmSync(dir, {recursive: true, force: true}); } };
const rock = {fast: null, charged: ['ROCK_SLIDE']};

test('without --observed-moves the file\'s movesets are ignored: identical rows, fixtures, description keys and hash-relevant output', () => {
 const teams = [{members: ['melmetal', 'tinkaton', 'cramorant'], count: 3, movesets: [rock, null, {fast: 'WATER_GUN', charged: []}]}, {members: ['altaria', 'mimikyu', 'tinkaton'], count: 2}];
 const bare = teams.map(({movesets, ...rest}) => rest);
 withFile(teams, withMoves => withFile(bare, without => {
  const a = loadUsage(withMoves, species), b = loadUsage(without, species);
  assert.deepEqual(a.rows, b.rows);
  assert.equal('moves' in a, false);
  for (const mode of ['observed', 'hybrid']) {
   const ma = createMeta(species, {mode, usageFile: withMoves}), mb = createMeta(species, {mode, usageFile: without});
   assert.deepEqual(ma.fixtures(300, 11), mb.fixtures(300, 11));
   const {usageHash: _, ...da} = ma.description, {usageHash: __, ...db} = mb.description;
   assert.deepEqual(da, db);
   assert.equal('observedMoves' in ma.description, false);
   assert.match(ma.description.movesets, /Published recommended movesets/);
  }
  // Even malformed movesets cannot affect a run that does not ask for them.
  const broken = [{members: ['melmetal', 'tinkaton', 'cramorant'], count: 1, movesets: 'garbage'}];
  withFile(broken, file => assert.equal(loadUsage(file, species).rows.length, 1));
 }));
});

test('with --observed-moves the observed opponents play their movesets, completed from the recommendation, and nothing else changes', () => {
 const teams = [{members: ['melmetal', 'tinkaton', 'cramorant'], count: 3, movesets: [rock, null, {fast: 'WATER_GUN', charged: ['DIVE']}]}];
 withFile(teams, file => {
  const usage = loadUsage(file, species, {observedMoves: true}), [row] = usage.rows;
  assert.deepEqual(row.team.map(p => p.speciesId), ['melmetal', 'cramorant', 'tinkaton'], 'canonical: lead, then the bench by species id');
  assert.deepEqual(row.movesets, [['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'ROCK_SLIDE'], ['WATER_GUN', 'DIVE', 'FLY'], null], 'movesets follow their members through the sort; the missing slots come from the recommendation');
  const meta = createMeta(species, {mode: 'observed', usageFile: file, observedMoves: true}), cases = meta.fixtures(40, 5);
  for (const c of cases) {
   assert.equal(c.component, 'observed');
   const [lead, cramorant, tinkaton] = c.team;
   assert.deepEqual([lead.moveset, lead.observedMoveset, lead.recommendedMoveset], [['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'ROCK_SLIDE'], true, RECOMMENDED.melmetal]);
   assert.deepEqual([cramorant.moveset, cramorant.observedMoveset], [['WATER_GUN', 'DIVE', 'FLY'], true]);
   assert.deepEqual([tinkaton.moveset, 'observedMoveset' in tinkaton], [RECOMMENDED.tinkaton, false], 'a member without an observation plays the recommended moveset');
  }
  // The same seeds and species as a run that does not use the moves: only the movesets differ.
  const plain = createMeta(species, {mode: 'observed', usageFile: file}).fixtures(40, 5);
  assert.deepEqual(cases.map(c => [c.seed, c.team.map(p => p.speciesId)]), plain.map(c => [c.seed, c.team.map(p => p.speciesId)]));
  assert.ok(plain.every(c => c.team.every(p => !p.observedMoveset && p.moveset === RECOMMENDED[p.speciesId])));
  // Their identity carries the moves; the plain fixture's does not.
  assert.notEqual(opponentFixtureKey(cases[0].team, cases[0].seed), opponentFixtureKey(plain[0].team, plain[0].seed));
  assert.deepEqual(O.opponentIds(cases[0].team), ['melmetal@THUNDER_SHOCK/DOUBLE_IRON_BASH/ROCK_SLIDE', 'cramorant@WATER_GUN/DIVE/FLY', 'tinkaton']);
 });
});

test('rows with the same species and different movesets stay apart; an observation equal to the recommendation is the plain row', () => {
 const same = {members: ['melmetal', 'tinkaton', 'cramorant'], count: 1};
 const teams = [
  {...same, movesets: [rock, null, null]}, {...same, count: 2, movesets: [rock, null, null]},                                      // same observed moveset: merged
  {...same, movesets: [{fast: null, charged: ['SUPER_POWER']}, null, null]},                                                       // another moveset: its own row
  {...same, count: 4, movesets: [{fast: 'THUNDER_SHOCK', charged: ['DYNAMIC_PUNCH', 'DOUBLE_IRON_BASH']}, null, null]},            // equals the recommendation (other order)
  {...same, count: 8},                                                                                                              // no observation
  {members: ['melmetal', 'cramorant', 'tinkaton'], count: 16, movesets: [null, null, null]},                                        // bench reordered, nothing observed
 ];
 withFile(teams, file => {
  const usage = loadUsage(file, species, {observedMoves: true}), by = new Map(usage.rows.map(r => [r.movesets.map(m => m ? m.join('/') : '-').join(' | '), r.count]));
  assert.equal(usage.rows.length, 3);
  assert.equal(by.get('THUNDER_SHOCK/DOUBLE_IRON_BASH/ROCK_SLIDE | - | -'), 3);
  assert.equal(by.get('THUNDER_SHOCK/DOUBLE_IRON_BASH/SUPER_POWER | - | -'), 1);
  assert.equal(by.get('- | - | -'), 28);
  assert.equal(usage.total, 32);
  assert.equal(usage.distinctTeams, 1, 'distinct teams are still counted by species');assert.equal(usage.moves.distinctMovesetTeams, 3);assert.equal(loadUsage(file, species).distinctTeams, 1);
  assert.equal(loadUsage(file, species).rows.length, 1, 'without the option every row of this team is one team');
  assert.equal(loadUsage(file, species).rows[0].count, 32);
 });
});

test('the option changes only the movesets: the same teams, order, seeds and components are drawn, and variants follow their counts', () => {
 const x = ['melmetal', 'tinkaton', 'cramorant'], y = ['altaria', 'mimikyu', 'tinkaton'];
 const teams = [{members: x, count: 3, movesets: [rock, null, null]}, {members: y, count: 4}, {members: x, count: 2, movesets: [{fast: null, charged: ['SUPER_POWER']}, null, null]}, {members: ['melmetal', 'cramorant', 'tinkaton'], count: 5}, {members: [...y].reverse(), count: 1, movesets: [null, {fast: null, charged: ['THUNDER']}, null]}];
 withFile(teams, file => {
  for (const mode of ['observed', 'hybrid']) {
   const off = createMeta(species, {mode, usageFile: file}), on = createMeta(species, {mode, usageFile: file, observedMoves: true}), a = off.fixtures(3000, 31), b = on.fixtures(3000, 31);
   assert.deepEqual(b.map(c => [c.seed, c.component, c.team.map(p => p.speciesId)]), a.map(c => [c.seed, c.component, c.team.map(p => p.speciesId)]), mode + ': identical stream');
   assert.deepEqual(on.fixtures(2048, 99).map(c => c.team.map(p => p.speciesId)), off.fixtures(2048, 99).map(c => c.team.map(p => p.speciesId)), 'the belief bank is the same lineups');
   assert.equal(on.description.observedShare, off.description.observedShare);assert.equal(on.description.distinctTeams, off.description.distinctTeams);assert.equal(on.description.weightedObservations, off.description.weightedObservations);
  }
  // Within a species team the variants appear in proportion to their counts (3 : 2 : 5 for the first team).
  const big = createMeta(species, {mode: 'observed', usageFile: file, observedMoves: true}).fixtures(40000, 7).filter(c => c.team[0].speciesId === 'melmetal'), by = new Map();
  for (const c of big) { const k = c.team[0].moveset[2];by.set(k, (by.get(k) || 0) + 1); }
  const total = big.length, share = k => (by.get(k) || 0) / total;
  assert.ok(Math.abs(share('ROCK_SLIDE') - .3) < .015 && Math.abs(share('SUPER_POWER') - .2) < .015 && Math.abs(share('DYNAMIC_PUNCH') - .5) < .015, JSON.stringify([...by]));
 });
});

test('invalid movesets are refused instead of silently changing the opponents', () => {
 const row = movesets => [{members: ['melmetal', 'tinkaton', 'cramorant'], count: 1, movesets}];
 const refuse = (movesets, pattern) => withFile(row(movesets), file => assert.throws(() => loadUsage(file, species, {observedMoves: true}), pattern));
 refuse([{fast: 'ROCK_SLIDE', charged: []}, null, null], /not a legal fast move/);
 refuse([{fast: null, charged: ['THUNDER_SHOCK']}, null, null], /not a legal charged move/);
 refuse([null, {fast: null, charged: ['ROCK_SLIDE']}, null], /tinkaton: ROCK_SLIDE is not a legal charged move/);
 refuse([null, null], /three members/);
 refuse('x', /three members/);
 refuse([{fast: null, charged: ['ROCK_SLIDE', 'SUPER_POWER', 'FLASH_CANNON']}, null, null], /more than two distinct/);
 assert.throws(() => createMeta(species, {observedMoves: true}), /require --usage-file/);
});

test('the description records that observed moves were used and how much of the meta they touch', () => {
 const teams = [{members: ['melmetal', 'tinkaton', 'cramorant'], count: 6, movesets: [{fast: 'THUNDER_SHOCK', charged: ['ROCK_SLIDE']}, null, {fast: 'WATER_GUN', charged: []}]}, {members: ['altaria', 'mimikyu', 'tinkaton'], count: 2, movesets: [null, {fast: null, charged: ['PLAY_ROUGH']}, null]}, {members: ['mimikyu', 'tinkaton', 'altaria'], count: 4}];
 withFile(teams, file => {
  const meta = createMeta(species, {mode: 'observed', usageFile: file, observedMoves: true, variants: []}), d = meta.description, m = d.observedMoves;
  assert.match(d.movesets, /^Observed movesets where the usage file records them/);
  assert.match(d.movesets, /belief prior use published recommended movesets/);
  const weight = 12;   // appearances
  assert.equal(m.fastShare, (6 * 2 + 2 * 0) / (3 * weight), 'members with an observed fast move');
  assert.equal(m.chargedShare, (6 * 1 + 2 * 1) / (3 * weight), 'Rock Slide in the first team, Play Rough in the second');
  assert.equal(m.differingMemberShare, (6 * 2) / (3 * weight), 'Rock Slide and Water Gun differ from the recommendation; Play Rough is the recommended move');
  assert.equal(m.differingTeamShare, 6 / weight);
  assert.equal(m.distinctWithMoves, 1);
  assert.deepEqual(m.featureMatch, {distinctMovesets: 2, exact: 0, approximate: 2});
  const exact = createMeta(species, {mode: 'observed', usageFile: file, observedMoves: true, variants: [{...species[0], moveset: ['THUNDER_SHOCK', 'DOUBLE_IRON_BASH', 'ROCK_SLIDE']}]}).description.observedMoves.featureMatch;
  assert.deepEqual(exact, {distinctMovesets: 2, exact: 1, approximate: 1});
  assert.equal(JSON.stringify(d.proportions), JSON.stringify({observed: 1}));
 });
});
