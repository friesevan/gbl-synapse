/* Pure saved-team comparison calculations. Fixture identity includes opponent order and seed. */
(function(root){
 'use strict';
 const signature=team=>team.map(p=>p.speciesId+'|'+p.moveset.join('/')).join(';');
 const bench=team=>[team[0],...team.slice(1).sort((a,b)=>a.speciesName.localeCompare(b.speciesName)||a.speciesId.localeCompare(b.speciesId))];
 const ranks=team=>{const r=team.map(p=>p.publishedRank).filter(Number.isFinite);return {minRank:r.length?Math.min(...r):null,maxRank:r.length?Math.max(...r):null,avgRank:r.length?r.reduce((s,n)=>s+n,0)/r.length:null};};
 const fixtureKey=m=>m[0].join(',')+'|'+m[1];
 function shared(a,b){const map=new Map(b.map(m=>[fixtureKey(m),m]));return a.filter(m=>map.has(fixtureKey(m))).map(m=>({opponents:m[0],seed:m[1],a:m[2],b:map.get(fixtureKey(m))[2]}));}
 function summarize(rows){const n=rows.length;if(!n)return null;const a=rows.reduce((s,r)=>s+r.a,0)/n,b=rows.reduce((s,r)=>s+r.b,0)/n,delta=a-b;
 const variance=n>1?rows.reduce((s,r)=>s+(r.a-r.b-delta)**2,0)/(n-1):0;
 return {n,a,b,delta,margin:n>1?1.96*Math.sqrt(variance/n):null,better:rows.filter(r=>r.a>r.b).length,worse:rows.filter(r=>r.a<r.b).length,same:rows.filter(r=>r.a===r.b).length};}
 function stage(a,b){for(const k of ['test','screen','baseline','training']){const rows=shared(a[k]||[],b[k]||[]);if(rows.length)return {name:k,rows};}return {name:null,rows:[]};}
 const outcome=score=>score===1?'2 wins':score===0?'0 wins':score===.75?'Win + draw':score===.25?'Loss + draw':'Split / draws';
 function changes(a,b){const out=[];for(const p of a){const q=b.find(x=>x.speciesId===p.speciesId);if(!q)continue;const left=p.moveset.filter(id=>id!=='none'&&!q.moveset.includes(id)),right=q.moveset.filter(id=>id!=='none'&&!p.moveset.includes(id));if(left.length||right.length)out.push({speciesId:p.speciesId,name:p.speciesName,a:left,b:right});}return out;}
 function attacks(events,side=0){return (events||[]).filter(e=>e.actor===side&&(e.type.startsWith('charged ')||e.type.startsWith('fast '))&&e.detail);}
 function moveEvidence(rows,change,slot){
 const ids=new Set(change[slot]),hits=rows.flatMap(r=>attacks(r.evidence?.[slot]).filter(e=>e.detail.attacker===change.speciesId&&ids.has(e.detail.moveId)).map(e=>({event:e,row:r})));
 const targets=new Map();for(const {event:e} of hits){const key=e.detail.defenderName||e.detail.defender,old=targets.get(key)||{name:key,hits:0,landed:0,knockouts:0};old.hits++;if(!e.detail.shielded)old.landed++;if(e.detail.knockout)old.knockouts++;targets.set(key,old);}
 const fixtures=rows.filter(r=>attacks(r.evidence?.[slot]).some(e=>e.detail.attacker===change.speciesId&&ids.has(e.detail.moveId))),improved=fixtures.filter(r=>slot==='a'?r.a>r.b:r.b>r.a).length;
 return {hits:hits.length,landed:hits.filter(h=>!h.event.detail.shielded).length,shielded:hits.filter(h=>h.event.detail.shielded).length,knockouts:hits.filter(h=>h.event.detail.knockout).length,fixtures:fixtures.length,improved,damagePercent:hits.length?hits.reduce((n,{event:e})=>n+100*Math.min(e.detail.hpBefore,Math.max(0,Number(e.values?.[0])||0))/e.detail.maxHP,0)/hits.length:0,targets:[...targets.values()].sort((a,b)=>b.knockouts-a.knockouts||b.landed-a.landed).slice(0,4)};
 }
 function firstDivergence(a,b){const meaningful=events=>(events||[]).filter(e=>!e.type.startsWith('fast ')&&(!e.type.startsWith('shield')||e.detail)),x=meaningful(a),y=meaningful(b);for(let i=0;i<Math.max(x.length,y.length);i++){const p=x[i],q=y[i];if(!p||!q||p.turn!==q.turn||p.actor!==q.actor||p.name!==q.name||p.detail?.attacker!==q.detail?.attacker||p.detail?.defender!==q.detail?.defender)return {a:p,b:q};}return null;}
 function eventText(e){if(!e)return 'No corresponding event before this battle ended.';const side=e.actor===0?'Your':'Opponent';if(e.detail){const d=e.detail,damage=Math.min(d.hpBefore,Math.max(0,Number(e.values?.[0])||0));return 'Turn '+e.turn+': '+side+' '+d.attackerName+' used '+e.name+' against '+d.defenderName+' — '+damage+' HP damage'+(d.shielded?' (shielded)':'')+(d.knockout?'; knockout':'')+(e.values?.slice(3).filter(v=>typeof v==='string').length?'; '+e.values.slice(3).filter(v=>typeof v==='string').join(', '):'')+'.';}return 'Turn '+e.turn+': '+side+' team · '+e.name+' ('+e.type+').';}
 root.TeamComparisonCore={signature,bench,ranks,fixtureKey,shared,summarize,stage,outcome,changes,attacks,moveEvidence,firstDivergence,eventText};
})(globalThis);
