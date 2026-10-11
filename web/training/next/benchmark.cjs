#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');const {BattlePool,defaultWorkers}=require('../pool.cjs'),{BattleRunner}=require('../runner.cjs'),{defaults}=require('../utils.cjs');const {createMeta}=require('../team-search/meta.cjs');
async function main(){
 const prepared=JSON.parse(fs.readFileSync(path.resolve(process.argv[2]||'training/runs/team-search/pool.json'))),n=Number(process.argv[3]||64);
 if(!Number.isInteger(n)||n<4)throw Error('Fixture count must be >=4');
 const ids=[['melmetal','jumpluff','quagsire_shadow'],['melmetal','jumpluff','cramorant'],['melmetal','jumpluff','cramorant']],teams=ids.map((team,j)=>team.map(id=>{
  const records=prepared.variants.filter(r=>r.speciesId===id);return id==='cramorant'?records.find(r=>j===1?r.moveset.includes('HYDRO_PUMP'):r.moveset.includes('DIVE')&&r.moveset.includes('FLY'))||records[0]:records[0];
 }));
 const workers=defaultWorkers(),pool=new BattlePool(workers,()=>new BattleRunner({workerFile:path.resolve(__dirname,'../battle-worker-v2.cjs'),heapMb:192})),output={createdAt:new Date().toISOString(),workers,fixturesPerPanel:n,panels:[],warning:'Small controller/distribution sensitivity check, not proof of stronger human play. Same controlled roster; both sides use the selected controller.'};
 try{
  for(const mode of ['independent','hybrid']){
   const meta=createMeta(prepared.species,{mode,weightPower:mode==='independent'?1:1.25}),cases=meta.fixtures(n,1294861),start=Date.now(),jobs=[];
   for(const team of teams)for(const lookahead of [false,true])for(const c of cases)jobs.push([team,c.team,defaults,defaults,{seed:c.seed,lookahead}]);
   const rows=await pool.map(jobs),summary=teams.map((team,i)=>{const score=lookahead=>rows.slice((i*2+Number(lookahead))*n,(i*2+Number(lookahead)+1)*n).reduce((sum,r)=>sum+r.score,0)/n;return {team:team.map(p=>({speciesId:p.speciesId,moveset:p.moveset})),canonicalChampion:score(false),lookahead:score(true),delta:score(true)-score(false)};});
   const panel={meta:meta.description,seconds:(Date.now()-start)/1000,battles:rows.length,battlesPerSecond:rows.length/((Date.now()-start)/1000),timeouts:rows.filter(r=>r.timedOut).length,rows:summary};output.panels.push(panel);console.log(JSON.stringify(panel));
  }
  const file=path.resolve(process.argv[4]||'training/next/benchmark-results.json');fs.writeFileSync(file,JSON.stringify(output,null,2));console.log('Saved '+file);
 }finally{await pool.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
