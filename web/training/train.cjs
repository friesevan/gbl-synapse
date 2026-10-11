#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');const {random,defaults}=require('./utils.cjs');const {BattlePool,availableCores,defaultWorkers}=require('./pool.cjs');
const args=process.argv.slice(2),opts={hours:8,population:6,games:8,evalGames:16,evalEvery:5,top:60,cp:1500,seed:20261009,out:'training/runs/overnight',generations:Infinity,workers:defaultWorkers(),resume:false};
const names={'hours':'hours','population':'population','games':'games','eval-games':'evalGames','eval-every':'evalEvery','top':'top','cp':'cp','seed':'seed','out':'out','generations':'generations','workers':'workers'};
for(let i=0;i<args.length;i++){const a=args[i];if(a==='--resume'){opts.resume=true;continue;}if(a==='--help'){console.log('node training/train.cjs [--hours 8] [--workers N] [--resume] [--out DIR] [--cp 1500] [--top 60] [--population 6] [--games 8] [--eval-games 16] [--eval-every 5] [--generations N] [--seed N]');process.exit(0);}const key=names[a.replace(/^--/,'')];if(!key||!a.startsWith('--')||args[i+1]===undefined)throw Error('Invalid argument '+a);opts[key]=key==='out'?args[++i]:Number(args[++i]);}
for(const k of ['hours','population','games','evalGames','evalEvery','top','cp'])if(!Number.isFinite(opts[k])||opts[k]<=0)throw Error(k+' must be positive');
for(const k of ['population','games','evalGames','evalEvery','top','seed','workers'])if(!Number.isInteger(opts[k]))throw Error(k+' must be an integer');
if(opts.generations!==Infinity&&(!Number.isInteger(opts.generations)||opts.generations<1))throw Error('generations must be a positive integer');
if(opts.population<2||opts.top<12||!['500','1500','2500','10000'].includes(String(opts.cp)))throw Error('Need population >=2, top >=12 and cp in 500/1500/2500/10000');
if(opts.workers<1||opts.workers>availableCores())throw Error('workers must be from 1 to '+availableCores());
const pool=new BattlePool(opts.workers);
const directory=path.resolve(opts.out);fs.mkdirSync(directory,{recursive:true});const checkpoint=path.join(directory,'checkpoint.json');
const rows=require('../includes/pro/data/league-'+opts.cp+'.json').overall.slice(0,opts.top);
if(rows.length<opts.top)throw Error('Not enough ranked species');
const training=rows.filter((_,i)=>i%4!==3),validation=rows.filter((_,i)=>i%4===3);
const config={cp:opts.cp,top:opts.top,seed:opts.seed,source:'f627e89e53c0c7b903fff097df7a0ad0ac95decc',population:opts.population,games:opts.games,evalGames:opts.evalGames,evalEvery:opts.evalEvery};
let state={config,generation:0,battles:0,policy:{...defaults},archive:[],evaluations:[]};
if(opts.resume){state=JSON.parse(fs.readFileSync(checkpoint));if(JSON.stringify(state.config)!==JSON.stringify(config))throw Error('Resume requires the same league, population and evaluation settings');}else if(fs.existsSync(checkpoint))throw Error('Output already contains a checkpoint; use --resume or another --out');
let lastProgress=Date.now();
let stop=false;process.on('SIGINT',()=>{stop=true;console.log('Stopping dispatch; waiting for active battles, then saving checkpoint.');});process.on('SIGTERM',()=>{stop=true;});
const save=()=>{fs.writeFileSync(checkpoint+'.tmp',JSON.stringify(state,null,2));fs.renameSync(checkpoint+'.tmp',checkpoint);fs.writeFileSync(path.join(directory,'policy.json'),JSON.stringify({config,policy:state.policy},null,2));};
const normal=r=>Math.sqrt(-2*Math.log(Math.max(r(),1e-9)))*Math.cos(2*Math.PI*r());
const mutate=(policy,r)=>Object.fromEntries(Object.entries(policy).map(([k,v])=>[k,Math.max(.1,Math.min(10,v*Math.exp(normal(r)*.35)))]));
function team(pool,r){const a=pool.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a.slice(0,3);}
function fixtures(pool,n,seed,useArchive){const r=random(seed);return Array.from({length:n},()=>({a:team(pool,r),b:team(pool,r),seed:Math.floor(r()*0xffffffff),opponent:useArchive&&state.archive.length&&r()<.25?state.archive[Math.floor(r()*state.archive.length)]:defaults}));}
async function evaluateMany(policies,cases){
 const jobs=[];for(const policy of policies)for(const c of cases)for(const reverse of [false,true])jobs.push(reverse?[c.b,c.a,c.opponent,policy,{seed:c.seed,cp:opts.cp}]:[c.a,c.b,policy,c.opponent,{seed:c.seed,cp:opts.cp}]);
 const results=await pool.map(jobs,{shouldStop:()=>stop||Date.now()>=deadline,onResult:result=>{
  state.battles++;if(result.timedOut)throw Error('A battle timed out; investigate the adapter before continuing.');
  if(Date.now()-lastProgress>=10000){lastProgress=Date.now();console.log('[progress] '+state.battles+' battles · '+pool.size+' workers · RSS '+Math.round(process.memoryUsage().rss/1048576)+' MB · largest worker heap '+Math.round(pool.peakWorkerHeapBytes/1048576)+' MB');}
 }});
 if(!results)return null;
 const perPolicy=cases.length*2;
 return policies.map((_,index)=>{const scores=results.slice(index*perPolicy,(index+1)*perPolicy).map((result,i)=>i%2?1-result.score:result.score);return {mean:scores.reduce((a,b)=>a+b,0)/scores.length,wins:scores.filter(s=>s===1).length,draws:scores.filter(s=>s===.5).length,losses:scores.filter(s=>s===0).length,games:scores.length,timedOut:0};});
}
const heldout=fixtures(validation,opts.evalGames,opts.seed+999999,false),deadline=Date.now()+opts.hours*3600000,startGeneration=state.generation;
(async()=>{save();console.log('Training '+(opts.resume?'resumed':'started')+' · '+opts.cp+' CP · '+pool.size+' workers / '+availableCores()+' cores · stop by '+new Date(deadline).toLocaleString()+' · checkpoint '+checkpoint);
while(!stop&&Date.now()<deadline&&state.generation-startGeneration<opts.generations){
 const r=random(opts.seed+state.generation*7919),cases=fixtures(training,opts.games,opts.seed+state.generation*104729,true);
 const candidates=[state.policy,...Array.from({length:opts.population-1},()=>mutate(state.policy,r))];let best=state.policy,bestScore=-Infinity,baseline=null,complete=true;
 const batch=await evaluateMany(candidates,cases);if(!batch)complete=false;else for(let i=0;i<candidates.length;i++){const score=batch[i];if(i===0)baseline=score.mean;if(score.mean>bestScore){bestScore=score.mean;best=candidates[i];}}
 if(!complete){save();break;}
 if(best!==state.policy){state.archive.push({...state.policy});state.archive=state.archive.slice(-12);state.policy=best;}
 state.generation++;
 const record={generation:state.generation,battles:state.battles,trainingScore:bestScore,incumbentScore:baseline,policy:state.policy};
 if(state.generation%opts.evalEvery===0){const evaluated=await evaluateMany([state.policy],heldout),score=evaluated?.[0];if(score){state.evaluations.push({generation:state.generation,...score});record.heldout=score;}}
 record.battles=state.battles;
 fs.appendFileSync(path.join(directory,'history.jsonl'),JSON.stringify(record)+'\n');save();console.log(JSON.stringify(record));
}
save();console.log('Saved '+checkpoint+'; '+state.battles+' battles total.');
})().catch(error=>{save();console.error(error);process.exitCode=1;}).finally(()=>pool.close());
