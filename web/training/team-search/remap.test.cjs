'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {remap}=require('./remap.cjs');
test('pool remapping preserves raw outcomes for retained movesets and rejects changed populations',()=>{
 const species=[1,2,3,4].map((dex,i)=>({speciesId:'p'+i,dex,weight:1})),variants=Array.from({length:8},(_,i)=>({speciesId:'p'+(i%4),moveset:['F'+i,'A','B']})),old={config:{inputHash:'same'},species,variants,hash:'old'},fresh={...old,variants:variants.slice().reverse(),hash:'new'};
 const teams=[[0,1,2],[0,1,3],[0,2,3],[1,2,3],[4,1,2],[4,1,3],[4,2,3],[5,2,3]];
 const state={config:{poolHash:'old'},records:teams.map(team=>({team,reward:1,games:2})),observations:teams.map(team=>({team,opponent:['p0','p1','p2'],score:.5}))};
 const result=remap(state,old,fresh);assert.equal(result.records.length,8);assert.equal(result.observations[0].score,.5);assert.deepEqual(result.observations[0].team,[7,6,5]);assert.equal(result.config.poolHash,'new');assert.deepEqual(result.models,[]);
 assert.throws(()=>remap(state,old,{...fresh,species:[...species,{speciesId:'extra',dex:9,weight:1}]}),/identical/);
});
