#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {fixtures,mechanicsHash,dataHash}=require('../training/team-search/common.cjs');
const teamKey=team=>team.join(','); // Historical v1 identities retain bench order.
const run=path.resolve(process.argv[2]||''),out=path.resolve(process.argv[3]||'includes/pro/data/team-teams');
const state=JSON.parse(fs.readFileSync(path.join(run,'checkpoint.json'))),pool=JSON.parse(fs.readFileSync(path.join(run,'pool.json')));
if(state.config.version!=='neural-team-search-v1')throw Error('v2 reports require a v2 browser replay adapter; refuse to publish them with the historical runtime');
if(state.runtime.phase!=='finished'||state.config.poolHash!==pool.hash||state.config.mechanicsHash!==mechanicsHash({version:'v1'})||pool.config.inputHash!==dataHash())throw Error('Require completed run with identical pool and simulator');
fs.mkdirSync(out,{recursive:true});
const published=new Map(pool.species.map(p=>[p.speciesId,p]));
const compact=p=>({...Object.fromEntries(['speciesId','speciesName','types','moveset','ivs','cp','level'].map(k=>[k,p[k]])),publishedRank:published.get(p.speciesId)?.rank??null,recommended:published.get(p.speciesId)?.moveset||[]});
const species=new Map(pool.species.map((p,i)=>[p.speciesId,i])),matches=new Map(state.records.map(r=>[teamKey(r.team),{training:[],screen:[],test:[],baseline:[]}])) ;
for(const o of state.observations){const m=matches.get(teamKey(o.team));if(m)m.training.push([o.opponent.map(id=>species.get(id)),o.seed,o.score]);}
for(const [kind,rows] of [['screen',state.screenResults],['test',state.validations],['baseline',state.baselineResults]])for(const r of rows){const cases=fixtures(pool.species,r.pairs.length,r.fixtureSeed);matches.get(teamKey(r.team))[kind]=cases.map((c,i)=>[c.team.map(p=>species.get(p.speciesId)),c.seed,r.pairs[i]]);}
const evaluation=(rows,team)=>rows.find(x=>teamKey(x.team)===teamKey(team));
const rows=state.records.map((r,i)=>{const n=r.games/2,m=(r.reward/2+4)/(n+8),screen=evaluation(state.screenResults,r.team),test=evaluation(state.validations,r.team),baseline=evaluation(state.baselineResults,r.team),matched=matches.get(teamKey(r.team));if(matched.training.length*2!==r.games)throw Error('Training evidence count mismatch '+teamKey(r.team));return {id:i,team:r.team,training:r.reward/r.games,selection:m-1.28*Math.sqrt(m*(1-m)/(n+9)),games:r.games,screen:screen?.score??null,test:test?.score??baseline?.score??null,finalist:!!test,baseline:baseline?.kind||null,matchCounts:Object.fromEntries(Object.entries(matched).map(([k,v])=>[k,v.length])),chunk:Math.floor(i/100)};});
for(let start=0;start<rows.length;start+=100){const chunk={};for(const row of rows.slice(start,start+100))chunk[row.id]=matches.get(teamKey(row.team));fs.writeFileSync(path.join(out,Math.floor(start/100)+'.json'),JSON.stringify(chunk));}
const report={version:1,rows,variants:pool.variants.map(compact),opponents:pool.species.map(compact),counts:{teams:rows.length,screened:state.screenResults.length,tested:state.validations.length,baselines:state.baselineResults.length,trainingFixtures:state.observations.length},mechanicsHash:state.config.mechanicsHash};
fs.writeFileSync(path.join(out,'index.json'),JSON.stringify(report));console.log('Exported '+rows.length+' teams, '+state.observations.length+' training fixtures, '+state.screenResults.length+' screening and '+state.validations.length+' test reports.');
