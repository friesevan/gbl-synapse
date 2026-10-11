'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {analyzeOpponents}=require('./opponents.cjs'),{fixtures}=require('./common.cjs');
test('opponent diagnostics reconstruct the sealed fixtures and condition on team membership',()=>{
 const species=[1,2,3,4].map(dex=>({dex,speciesId:'p'+dex,speciesName:'Pokemon '+dex,weight:1,moveset:['F','A','B']})),pool={species},result={team:[0,1,2],fixtureSeed:19,pairs:[0,.5,1,.25,.75]};
 const a=analyzeOpponents(result,pool),cases=fixtures(species,5,19);assert.equal(a.fixtures.length,5);assert.deepEqual(a.fixtures.map(r=>r.battleSeed),cases.map(r=>r.seed));assert.deepEqual(a.fixtures[0].opponents.map(p=>p.speciesId),cases[0].team.map(p=>p.speciesId));assert.equal(a.species.reduce((s,p)=>s+p.fixtures,0),15);for(const p of a.species){const rows=a.fixtures.filter(r=>r.opponents.some(o=>o.speciesId===p.speciesId));assert.equal(p.score,rows.reduce((s,r)=>s+r.score,0)/rows.length);}assert.equal(analyzeOpponents(null,pool),null);
});
test('partially completed v2 panels only analyze the completed common prefix',()=>{
 const species=[1,2,3,4].map(dex=>({dex,speciesId:'p'+dex,speciesName:'Pokemon '+dex,weight:1,moveset:['F','A','B']})),pool={species};
 const sealedFixtures=fixtures(species,8,19),result={team:[0,1,2],fixtureSeed:19,pairs:[0,1,.5],paired:false};
 const a=analyzeOpponents(result,pool,{sealedFixtures});assert.equal(a.fixtures.length,3);assert.equal(a.species.reduce((s,p)=>s+p.fixtures,0),9);assert.ok(a.species.every(p=>Number.isFinite(p.score)));assert.match(a.note,/single-battle/);
 assert.throws(()=>analyzeOpponents(result,pool,{sealedFixtures:sealedFixtures.slice(0,2)}),/complete finite/);
 assert.throws(()=>analyzeOpponents({...result,pairs:[NaN]},pool,{sealedFixtures}),/complete finite/);
});
