'use strict';
const {random}=require('../utils.cjs');const {randomTeam,weightedTeam}=require('./common.cjs');
function summarize(scores,{team,fixtureSeed,kind='finalist',paired=true}={}){
 if(!Array.isArray(scores)||!scores.length||scores.some(s=>!Number.isFinite(s)||s<0||s>1)||paired&&scores.length%2)throw Error('Evaluation requires finite scores and complete opponent fixtures');
 const pairs=paired?Array.from({length:scores.length/2},(_,i)=>(scores[i*2]+scores[i*2+1])/2):scores.slice(),mean=scores.reduce((a,b)=>a+b,0)/scores.length,variance=pairs.length>1?pairs.reduce((s,v)=>s+(v-mean)**2,0)/(pairs.length-1):0;
 return {team,kind,paired,score:mean,games:scores.length,wins:scores.filter(s=>s===1).length,draws:scores.filter(s=>s===.5).length,losses:scores.filter(s=>s===0).length,standardError:pairs.length>1?Math.sqrt(variance/pairs.length):null,pairs,fixtureSeed};
}
// Fixture-major scheduling keeps every contender on the same opponent prefix
// when the deadline expires, including when workers complete out of order.
function panelIndex(index,teamCount){return {team:index%teamCount,fixture:Math.floor(index/teamCount)};}
function commonPanelScores(teams,partial){
 if(!teams.length||partial.length!==teams.length)return [];
 let n=0;while(n<partial[0].length&&partial.every(row=>Number.isFinite(row[n])))n++;
 return n?teams.map((team,i)=>({team,scores:partial[i].slice(0,n)})):[];
}
function matchedRows(primary,rows){
 const n=primary?.pairs?.length;
 if(!n||[primary,...rows].some(b=>b.pairs?.length!==n||b.fixtureSeed!==primary.fixtureSeed||(b.paired!==false)!==(primary.paired!==false)||b.pairs.some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('Comparisons require the same opponent fixtures');
 return n;
}
// Fixed coverage baselines provide a stronger comparator than random team draws.
function coverageTeam(pool,penalty=0,order=0){
 const n=Math.min(24,pool.targets?.length||0),weights=n?pool.targets.slice(0,n).map(t=>t.weight):[1],total=weights.reduce((a,b)=>a+b,0);
 const ratings=pool.variants.map(v=>n?v.features.slice(-n):[v.scoutScore]),chosen=[];
 for(let slot=0;slot<3;slot++){let best=-Infinity,index=-1;
  pool.variants.forEach((v,i)=>{if(chosen.some(j=>pool.variants[j].dex===v.dex))return;let value=0;
   for(let j=0;j<weights.length;j++){const values=[...chosen.map(k=>ratings[k][j]),ratings[i][j]];value+=weights[j]*(Math.max(...values)+penalty*Math.min(...values));}
   value/=total;if(value>best){best=value;index=i;}
  });if(index<0)throw Error('Coverage baseline needs three distinct Pokédex numbers');chosen.push(index);
 }
 // Repair greedy choices with bounded coordinate swaps; avoid an early generalist trapping the team.
 const objective=team=>weights.reduce((sum,w,j)=>{const values=team.map(k=>ratings[k][j]);return sum+w*(Math.max(...values)+penalty*Math.min(...values));},0)/total;
 let score=objective(chosen);
 for(let sweep=0;sweep<3;sweep++){let changed=false;for(let slot=0;slot<3;slot++){let replacement=chosen[slot],best=score;
  pool.variants.forEach((v,i)=>{if(chosen.some((k,s)=>s!==slot&&pool.variants[k].dex===v.dex))return;const trial=chosen.slice();trial[slot]=i;const value=objective(trial);if(value>best+1e-12){best=value;replacement=i;}});
  if(replacement!==chosen[slot]){chosen[slot]=replacement;score=best;changed=true;}
 }if(!changed)break;}
 const shift=order%3,team=[...chosen.slice(shift),...chosen.slice(0,shift)];if(order%4===3)[team[1],team[2]]=[team[2],team[1]];return team;
}
function baselineTeams(pool,count,seed){
 const r=random(seed),best=new Map();pool.variants.forEach((v,i)=>{if(!best.has(v.speciesId)||pool.variants[best.get(v.speciesId)].scoutScore<v.scoutScore)best.set(v.speciesId,i);});
 const uniform=Math.ceil(count/3),weighted=Math.ceil((count-uniform)/2);
 return Array.from({length:count},(_,i)=>i<uniform?{team:randomTeam(pool.variants,r),kind:'uniform-random'}:i<uniform+weighted?{team:weightedTeam(pool.species,r).map(s=>best.get(s.speciesId)),kind:'weight-sampled-best-moves'}:{team:coverageTeam(pool,(i-uniform-weighted)*.25,i-uniform-weighted),kind:'greedy-scout-coverage'});
}
function compare(primary,baselines,{seed=1,samples=5000}={}){
 if(!primary||!baselines.length)return null;const n=matchedRows(primary,baselines);if(!Number.isInteger(samples)||samples<100)throw Error('Bootstrap requires at least 100 samples');
 const differences=primary.pairs.map((v,i)=>v-baselines.reduce((s,b)=>s+b.pairs[i],0)/baselines.length),mean=differences.reduce((s,v)=>s+v,0)/n,r=random(seed),bootstrap=[];
 for(let k=0;k<samples;k++){let sum=0;for(let i=0;i<n;i++)sum+=differences[Math.floor(r()*n)];bootstrap.push(sum/n);}bootstrap.sort((a,b)=>a-b);
 return {delta:mean,interval95:n>1?[bootstrap[Math.floor(samples*.025)],bootstrap[Math.floor(samples*.975)-1]]:[-1,1],fixtures:n,baselineTeams:baselines.length,method:'paired opponent-fixture bootstrap; conditional on these baseline teams'};
}
// Keep the screening-selected primary; the untouched final test only estimates
// performance. Simultaneous bands account for comparing several finalists.
function compareFinalists(primary,otherRows,{seed=1,samples=5000}={}){
 if(!primary||!otherRows.length)return null;const n=matchedRows(primary,otherRows);if(!Number.isInteger(samples)||samples<100)throw Error('Bootstrap requires at least 100 samples');
 const differences=otherRows.map(row=>primary.pairs.map((v,i)=>v-row.pairs[i])),means=differences.map(row=>row.reduce((s,x)=>s+x,0)/n),r=random(seed),errors=[];
 for(let k=0;k<samples;k++){const sums=new Array(otherRows.length).fill(0);for(let i=0;i<n;i++){const index=Math.floor(r()*n);for(let j=0;j<otherRows.length;j++)sums[j]+=differences[j][index];}errors.push(Math.max(...sums.map((sum,j)=>Math.abs(sum/n-means[j]))));}
 errors.sort((a,b)=>a-b);const radius=n>1?errors[Math.min(samples-1,Math.ceil(samples*.95)-1)]:2,comparisons=otherRows.map((row,i)=>({team:row.team,delta:means[i],interval95:[Math.max(-1,means[i]-radius),Math.min(1,means[i]+radius)],distinguishable:means[i]-radius>0?'primary-better':means[i]+radius<0?'challenger-better':'unresolved'}));
 return {primaryTeam:primary.team,fixtures:n,comparisons,primaryResolved:comparisons.every(c=>c.distinguishable==='primary-better'),method:'simultaneous paired opponent-fixture bootstrap; conditional on screened finalists; primary chosen before final test'};
}
module.exports={summarize,panelIndex,commonPanelScores,coverageTeam,baselineTeams,compare,compareFinalists};
