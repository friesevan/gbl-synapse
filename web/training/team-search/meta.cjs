'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
const {random} = require('../utils.cjs');
const DAY = 86400000;
let typeMap;

// Categorical draw. The final positive item covers floating-point rounding;
// zero-weight entries must never become that fallback.
function draw(rows, r, weight) {
 const weights = rows.map(weight), total = weights.reduce((a,b) => a+b, 0);
 if (!(total > 0) || !Number.isFinite(total) || weights.some(w => !Number.isFinite(w) || w < 0)) throw Error('Meta has invalid probability weights');
 let x = r()*total, last;
 for (let i=0; i<rows.length; i++) { if (!weights[i]) continue; last=rows[i]; x-=weights[i]; if (x<0) return rows[i]; }
 return last;
}

function sampler(rows, weights) {
 const cumulative = new Float64Array(rows.length); let total=0, last=-1;
 weights.forEach((w,i) => { total+=w; cumulative[i]=total; if (w>0) last=i; });
 if (!(total>0) || !Number.isFinite(total)) throw Error('Meta has no positive finite probability');
 return r => { const x=r()*total; let lo=0, hi=rows.length; while (lo<hi) { const mid=(lo+hi)>>>1; if (cumulative[mid]>x) hi=mid; else lo=mid+1; } return rows[lo<rows.length?lo:last]; };
}

function independent(species,r,firstDraw) {
 const team=[firstDraw?firstDraw(r):draw(species,r,p=>p.weight)];
 while (team.length<3) team.push(draw(species.filter(p=>!team.some(q=>q.dex===p.dex)),r,p=>p.weight));
 return team;
}

function coherent(species,r,firstDraw) {
 const team=[firstDraw?firstDraw(r):draw(species,r,p=>p.weight)], abb=r()<.4;
 while (team.length<3) {
  const available=species.filter(p=>!team.some(q=>q.dex===p.dex));
  // Compute the current team's coverage once, rather than allocating arrays
  // for every candidate/type inside the probability calculation.
  const length=species[0].scoutByType?.length||0, coverage=new Float64Array(length);
  for (let i=0;i<length;i++) coverage[i]=Math.max(...team.map(q=>q.scoutByType?.[i]??.5));
  const leadTypes=team[0].types||[], backTypes=team[1]?.types||[];
  const next=draw(available,r,p=>{
   let improvement=0;
   for (let i=0;i<length;i++) improvement+=Math.max(0,(p.scoutByType?.[i]??.5)-coverage[i]);
   const types=p.types||[];
   const structure=abb&&team.length===2?(types.some(t=>t!=='none'&&backTypes.includes(t))&&!types.some(t=>t!=='none'&&leadTypes.includes(t))?2.5:.6):1;
   return p.weight*Math.exp(length?3*improvement/length:0)*structure;
  });
  team.push(next);
 }
 return team;
}

function dateValue(value,label) {
 if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) throw Error(label+' must be an ISO date');
 const date=Date.parse(value);
 const calendar=Date.parse(value.slice(0,10));
 if (!Number.isFinite(date) || !Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0,10)!==value.slice(0,10)) throw Error(label+' must be a valid ISO date');
 return date;
}

function loadUsage(file,species,{halfLifeDays=0,asOf=''}={}) {
 if (!file) return null;
 const raw=fs.readFileSync(file,'utf8');
 if (Buffer.byteLength(raw)>10*1024*1024) throw Error('Usage file exceeds 10 MB');
 const data=JSON.parse(raw), map=new Map(species.map(p=>[p.speciesId,p]));
 if (data.cp!==1500 || data.cup!=='all' || typeof data.source!=='string' || !data.source.trim() || !Array.isArray(data.teams) || !data.teams.length || data.teams.length>100000) throw Error('Usage file needs source, cp:1500, cup:"all", and nonempty teams (at most 100,000 rows)');
 const at=halfLifeDays?dateValue(asOf,'usage-as-of'):null;
 const combined=new Map(); let rawCount=0, weightedCount=0;
 for (const row of data.teams) {
  if (!Array.isArray(row.members) || row.members.length!==3 || !Number.isInteger(row.count) || row.count<=0) throw Error('Usage row needs three lead-first species IDs and a positive integer appearance count');
  const team=row.members.map(id=>{if (!map.has(id)) throw Error('Observed opponent outside prepared pool: '+id); return map.get(id);});
  if (new Set(team.map(p=>p.dex)).size!==3) throw Error('Usage team violates Species Clause');
  const collectedAt=row.collectedAt||data.collectedAt;
  const age=halfLifeDays?(at-dateValue(collectedAt,'Observed team collectedAt'))/DAY:0;
  if (age<0) throw Error('Observed team date is later than usage-as-of');
  const count=row.count*Math.pow(.5,age/(halfLifeDays||1));
  rawCount+=row.count; weightedCount+=count;
  const canonical=[team[0],...team.slice(1).sort((a,b)=>a.speciesId.localeCompare(b.speciesId))], key=canonical.map(p=>p.speciesId).join('|');
  const entry=combined.get(key)||{team:canonical,count:0,rawCount:0}; entry.count+=count; entry.rawCount+=row.count; combined.set(key,entry);
 }
 if (!(weightedCount>0) || !Number.isFinite(weightedCount) || !Number.isSafeInteger(rawCount)) throw Error('Usage appearance counts exceed supported range or decay to zero');
 // For weighted individual observations, Kish effective N is (sum w)^2 /
 // sum w^2. Aggregated rows repeat each observation's weight count times.
 let squareSum=0;
 for (const row of data.teams) { const age=halfLifeDays?(at-dateValue(row.collectedAt||data.collectedAt,'Observed team collectedAt'))/DAY:0; const w=Math.pow(.5,age/(halfLifeDays||1)); squareSum+=row.count*w*w; }
 return {rows:[...combined.values()],source:data.source,collectedAt:data.collectedAt||null,rank:data.rank||null,total:rawCount,weightedCount,effectiveObservations:weightedCount*weightedCount/squareSum,halfLifeDays,asOf:halfLifeDays?asOf:null,hash:crypto.createHash('sha256').update(raw).digest('hex')};
}

function createMeta(species,{mode='hybrid',usageFile='',weightPower=1.25,halfLifeDays=0,asOf='',priorStrength=500}={}) {
 if (!Number.isFinite(weightPower) || weightPower<.25 || weightPower>3) throw Error('meta weight power must be between .25 and 3');
 if (!Number.isFinite(halfLifeDays) || halfLifeDays<0 || !Number.isFinite(priorStrength) || priorStrength<0) throw Error('Usage half-life and prior strength must be finite and nonnegative');
 if (halfLifeDays && !usageFile) throw Error('Usage half-life requires --usage-file');
 if (!['hybrid','independent','observed'].includes(mode)) throw Error('meta must be hybrid, independent or observed');
 if (species.some(p=>!Number.isFinite(p.weight)||p.weight<0) || new Set(species.map(p=>p.speciesId)).size!==species.length) throw Error('Meta species need unique IDs and finite nonnegative weights');
 if (new Set(species.filter(p=>p.weight>0).map(p=>p.dex)).size<3) throw Error('Meta needs three positive-weight distinct species');
 if (!typeMap) typeMap=new Map(require('../../includes/pro/data/gamemaster.json').pokemon.map(p=>[p.speciesId,p.types]));
 species=species.map(p=>({...p,originalWeight:p.weight,weight:p.weight**weightPower,types:p.types||typeMap.get(p.speciesId)||[]}));
 const observed=loadUsage(usageFile,species,{halfLifeDays,asOf});
 if (mode==='observed' && !observed) throw Error('Observed meta requires --usage-file');
 // Decayed counts govern both the posterior probabilities AND trust in the
 // observation source: a large stale archive must not dominate current play.
 const observedShare=observed?Math.min(.8,observed.weightedCount/(observed.weightedCount+priorStrength)):0;
 const description={version:'meta-v3-recency',mode,weightPower,observedShare:mode==='observed'?1:mode==='independent'?0:observedShare,source:observed?.source||'Synthetic PvPoke prior',usageHash:observed?.hash||null,observedCount:observed?.total||0,weightedObservations:observed?.weightedCount||0,effectiveObservations:observed?.effectiveObservations||0,usageHalfLifeDays:halfLifeDays,usageAsOf:halfLifeDays?asOf:null,usagePriorStrength:priorStrength,collectedAt:observed?.collectedAt||null,rank:observed?.rank||null,
  proportions:mode==='observed'?{observed:1}:mode==='independent'?{independent:1}:observed?{observed:observedShare,independent:(1-observedShare)/2,coherent:(1-observedShare)/2}:{independent:.5,coherent:.5},movesets:'Published recommended movesets; observed moves are not inferred as fact'};
 const firstDraw=sampler(species,species.map(p=>p.weight)), observedDraw=observed?sampler(observed.rows,observed.rows.map(p=>p.count)):null;
 function fixtures(n,seed) {
  if (!Number.isInteger(n)||n<0||!Number.isInteger(seed)||seed<0||seed>0xffffffff) throw Error('Fixture count must be nonnegative and seed unsigned 32-bit');
  const r=random(seed);
  return Array.from({length:n},()=>{
   const x=r(); let team,component;
   if (mode==='observed'||mode==='hybrid'&&observed&&x<observedShare) { team=observedDraw(r).team; component='observed'; }
   else if (mode==='independent'||mode==='hybrid'&&x<(observed?observedShare+(1-observedShare)/2:.5)) { team=independent(species,r,firstDraw); component='independent'; }
   else { team=coherent(species,r,firstDraw); component='coherent'; }
   return {team:[team[0],...team.slice(1).sort((a,b)=>a.speciesId.localeCompare(b.speciesId))],seed:Math.floor(r()*0xffffffff),component};
  });
 }
 return {description,fixtures};
}
module.exports={createMeta,loadUsage,coherent,dateValue};
