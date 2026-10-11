'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { absorb } = require('./absorb-evaluation.cjs');
const { fixtures } = require('./common.cjs');
test('earlier evaluation labels reconstruct exact fixtures, deduplicate and require a fresh test', () => {
  const species = [1, 2, 3, 4].map(dex => ({ speciesId: 'p' + dex, dex, weight: 1 }));
  const pool = { hash: 'p', species, variants: species };
  const c = fixtures(species, 3, 19)[0];
  const row = { team: [0, 1, 2], fixtureSeed: 19, games: 6, pairs: [1, .5, 0], kind: 'finalist' };
  const state = { config: { poolHash: 'p' }, round: 2,
    observations: [{ team: row.team, opponent: c.team.map(p => p.speciesId), seed: c.seed, score: 1 }],
    validations: [row], screenResults: [], baselineResults: [], models: [1] };
  const result = absorb(state, pool);
  assert.equal(result.observations.length, 3);
  assert.equal(result.records[0].games, 6); assert.equal(result.records[0].reward, 3);
  assert.equal(result.evaluationEvidence.addedFixtures, 2);
  assert.deepEqual(result.evaluationEvidence.fixtureSeeds, [19]);
  assert.equal(result.evaluationEvidence.requiresFreshValidationSeed, true);
  assert.deepEqual(result.models, []); assert.equal(state.models.length, 1);
  assert.throws(() => absorb({ ...state, runtime: { phase: 'validating' } }, pool), /finished/);
  assert.throws(() => absorb({ ...state, validations: [{ ...row, pairs: [0, .5, 0] }] }, pool), /Conflicting/);
});
test('modern evidence uses saved opponent panels and one battle per fixture',()=>{
 const species=[1,2,3,4].map(dex=>({speciesId:'p'+dex,dex,weight:1})),pool={hash:'p',species,variants:species};
 const state={config:{version:'neural-team-search-v3',poolHash:'p'},round:2,observations:[],validations:[{team:[0,1,2],fixtureSeed:19,games:1,pairs:[1]}],fixturePanels:{19:[{team:[species[3],species[2],species[1]],seed:999}]}};
 const out=absorb(state,pool);assert.equal(out.battles,1);assert.equal(out.records[0].games,1);assert.deepEqual(out.observations[0].opponent,['p4','p3','p2']);assert.equal(out.observations[0].seed,999);
 assert.throws(()=>absorb({...state,fixturePanels:{}},pool),/sealed/);
});
