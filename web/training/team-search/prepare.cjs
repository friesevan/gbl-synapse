#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');const {BattlePool,defaultWorkers,availableCores}=require('../pool.cjs');const {BattleRunner}=require('../runner.cjs');
const {VERSION,digest,atomic,population,options}=require('./common.cjs');
async function prepare({species=300,movesets=5,shortlist=32,scoutOpponents=8,workers=defaultWorkers(),out='training/runs/team-search/pool.json'}={}){
 for(const [k,v] of Object.entries({species,movesets,shortlist,scoutOpponents,workers}))if(!Number.isInteger(v)||v<1)throw Error(k+' must be a positive integer');
 if(species<3||movesets>5||shortlist<movesets||workers>availableCores())throw Error('Need species >=3, movesets <=5, shortlist >=movesets and workers <= available cores');
 const start=Date.now();
 const base=path.resolve(__dirname,'../../includes/pro/data'),published=require(base+'/league-1500.json').overall,overrides=require(base+'/overrides-1500.json'),data=require(base+'/gamemaster.json');
 const rows=population(published,overrides,species);if(rows.length!==species)throw Error('Not enough eligible positive-weight species');
 const lookup=new Map(data.pokemon.map(p=>[p.speciesId,p]));const speciesRows=rows.map(r=>({...r,dex:lookup.get(r.speciesId).dex}));
 // A weighted and type-diverse scout panel; all full team opponents still come from the entire eligible pool.
 const remaining=rows.slice(),targets=[],covered=new Set();while(targets.length<Math.min(scoutOpponents,rows.length)&&remaining.length){let best=-1,index=0;remaining.forEach((r,i)=>{const types=lookup.get(r.speciesId).types;const score=r.weight*(1+types.filter(t=>!covered.has(t)).length);if(score>best){best=score;index=i;}});const r=remaining.splice(index,1)[0];targets.push(r);lookup.get(r.speciesId).types.forEach(t=>covered.add(t));}
 const inputHash=digest([published,overrides,data]);const config={version:VERSION,cp:1500,species,movesets,shortlist,scoutOpponents,inputHash,scoutingHash:digest([fs.readFileSync(path.join(__dirname,'prepare-worker.cjs'),'utf8'),fs.readFileSync(path.join(base,'../core.js'),'utf8'),require('./common.cjs').mechanicsHash()]),exhaustive:shortlist>=10000};
 const pool=new BattlePool(workers,()=>new BattleRunner({workerFile:path.join(__dirname,'prepare-worker.cjs'),heapMb:192}));let done=0;
 try{console.log('Preparing '+species+' species · up to '+movesets+' movesets each · '+workers+' workers');let results;
 if(shortlist>=10000){
  const counts=await pool.map(rows.map(row=>[{row,targets:[],maxMovesets:movesets,shortlist,mode:'count'}]));
  const chunkSize=16,jobs=[];rows.forEach((row,i)=>{for(let offset=0;offset<counts[i].totalCombinations;offset+=chunkSize)jobs.push({row,targets,maxMovesets:movesets,shortlist,offset,chunkSize});});
  const cacheRoot=path.resolve(out)+'.chunks',cacheHash=digest([config,'exact-chunks-v1']);fs.mkdirSync(cacheRoot,{recursive:true});
  const complete=new Array(jobs.length),pending=[];jobs.forEach((job,i)=>{const file=path.join(cacheRoot,i+'.json');if(fs.existsSync(file)){const c=JSON.parse(fs.readFileSync(file));if(c.hash===cacheHash&&c.speciesId===job.row.speciesId&&c.offset===job.offset)complete[i]=c.result;}if(!complete[i])pending.push(i);});
  console.log('Exhaustive scouting · '+jobs.length+' chunks of at most '+chunkSize+' movesets · '+(jobs.length-pending.length)+' cached');
  let finished=jobs.length-pending.length;
  await pool.map(pending.map(i=>[jobs[i]]),{onResult:(result,index)=>{const i=pending[index];complete[i]=result;atomic(path.join(cacheRoot,i+'.json'),{hash:cacheHash,speciesId:jobs[i].row.speciesId,offset:jobs[i].offset,result});if(++finished%20===0||finished===jobs.length)console.log('Scouting chunks '+finished+'/'+jobs.length);}});
  results=rows.map((row,i)=>{const chunks=complete.filter((_,j)=>jobs[j].row.speciesId===row.speciesId),records=chunks.flatMap(c=>c.records).sort((a,b)=>b.scoutScore-a.scoutScore||b.projection-a.projection||a.moveset.join('|').localeCompare(b.moveset.join('|'))).slice(0,movesets);return {records,recommended:chunks.map(c=>c.recommended).find(Boolean),totalCombinations:counts[i].totalCombinations,simulations:chunks.reduce((sum,c)=>sum+c.simulations,0)};});
 }else results=await pool.map(rows.map(row=>[{row,targets,maxMovesets:movesets,shortlist}]),{onResult:()=>{if(++done%10===0||done===rows.length)console.log('Moveset scouting '+done+'/'+rows.length);}});
 speciesRows.forEach((r,i)=>{if(!results[i].recommended)throw Error('Recommended moveset missing for '+r.speciesId);r.features=results[i].recommended.features;r.scoutByType=results[i].recommended.scoutByType;});
 const variants=results.flatMap(r=>r.records);variants.forEach((r,i)=>r.index=i);
 const output={config,species:speciesRows,targets:targets.map(r=>({speciesId:r.speciesId,weight:r.weight})),variants,summary:{elapsedSeconds:(Date.now()-start)/1000,species:rows.length,variants:variants.length,totalCombinations:results.reduce((s,r)=>s+r.totalCombinations,0),simulations:results.reduce((s,r)=>s+r.simulations,0)}};output.hash=digest(output);atomic(path.resolve(out),output);console.log('Saved '+out+' · '+variants.length+' variants');return output;
 }finally{await pool.close();}
}
if(require.main===module){const o=options(process.argv.slice(2),{species:300,movesets:5,shortlist:32,scoutOpponents:8,workers:defaultWorkers(),out:'training/runs/team-search/pool.json'});if(o.help)console.log('node training/team-search/prepare.cjs [--species 300] [--movesets 5] [--shortlist 32] [--scout-opponents 8] [--workers N] [--out FILE]');else prepare(o).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={prepare};
