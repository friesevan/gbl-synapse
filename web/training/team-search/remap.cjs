#!/usr/bin/env node
'use strict';
const E=require('./evidence.cjs');
const fs=require('node:fs');const {digest,atomic}=require('./common.cjs');
function remap(state,oldPool,newPool){
 const factor=E.factor(state);
 const population=p=>p.species.map(s=>[s.speciesId,s.weight,s.dex]);
 if(oldPool.config.inputHash!==newPool.config.inputHash||digest(population(oldPool))!==digest(population(newPool)))throw Error('Remapping requires identical engine/data inputs and eligible weighted population');
 if(state.config.poolHash!==oldPool.hash||!state.observations?.length)throw Error('Checkpoint does not match old pool or lacks raw fixture evidence');
 const signature=v=>v.speciesId+'|'+v.moveset.join('|'),indices=new Map(newPool.variants.map((v,i)=>[signature(v),i]));const team=t=>{const mapped=t.map(i=>indices.get(signature(oldPool.variants[i])));return mapped.every(i=>i!==undefined)?mapped:null;};
 const observations=state.observations.flatMap(o=>{const t=team(o.team);return t?[{...o,team:t}]:[];}),records=new Map();
 for(const o of observations){const key=E.identity(state,o.team),r=records.get(key)||{team:o.team,reward:0,games:0};r.reward+=o.score*factor;r.games+=factor;records.set(key,r);}
 if(records.size<8)throw Error('Too few retained teams; use a new initial search');
 const out={...state,config:{...state.config,poolHash:newPool.hash},records:[...records.values()],observations,models:[],pending:null,validations:[],screenResults:[],finalistTeams:[],baselineResults:[],comparisons:{},runtime:null,history:[],battles:observations.length*factor,remapped:{oldPool:oldPool.hash,newPool:newPool.hash,oldTeams:state.records.length,retainedTeams:records.size,oldFixtures:state.observations.length,retainedFixtures:observations.length}};
 return out;
}
if(require.main===module){const [checkpoint,oldFile,newFile,out]=process.argv.slice(2);if(!out)throw Error('node remap.cjs CHECKPOINT OLD_POOL NEW_POOL OUTPUT');const result=remap(JSON.parse(fs.readFileSync(checkpoint)),JSON.parse(fs.readFileSync(oldFile)),JSON.parse(fs.readFileSync(newFile)));atomic(out,result);console.log(JSON.stringify(result.remapped));}
module.exports={remap};
