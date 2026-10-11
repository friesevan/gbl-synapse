// Shared, deterministic active-review policy. Scores are acquisition heuristics, not confidence.
(function(root){'use strict';
const labels={shadow:'Shadow',form:'Form',result:'Battle outcome',fastMove:'Fast move',league:'League / cup',footage:'Battle footage',lead:'Opponent lead',perspective:'Championship perspective'};
const trainable=new Set(['shadow','form','fastMove']);
const values=x=>x instanceof Map?[...x.values()]:Array.isArray(x)?x:Object.values(x||{});
const id=q=>q.qid||q.id;
const confirmed=a=>a&&a.value!==null&&a.value!==undefined&&a.source!=='model'&&!a.modelResolved;
function groupKind(q){return labels[q.kind]||'Other';}
function priority(q,{answers={},questions=[]}={}){
 const history=values(answers).filter(confirmed),species=q.species||'',n=history.filter(a=>a.kind===q.kind&&a.species===species).length;
 const frequency=Math.min(8,questions.filter(x=>x.species===species&&x.kind===q.kind).length||1);
 const p=Number.isFinite(q.modelP)?Math.max(0,Math.min(1,q.modelP)):.5;
 const uncertainty=1-Math.abs(2*p-1),kind={league:2.5,perspective:2.4,footage:2.3,form:2.1,fastMove:2,shadow:1.8,lead:1.4,result:1.2}[q.kind]||1;
 return kind*(.5+uncertainty)*Math.sqrt(frequency)/(1+n/8)*(q.allBattles?1.35:1)*(q.audit?1.6:1);
}
function orderQuestions(questions,{mode='priority',answers={},resolutions={}}={}){
 const ctx={answers,questions},scored=questions.map(q=>({q,s:priority(q,ctx)}));
 const video=q=>q.video?.id||q.recording||'',kind=q=>groupKind(q);
 const highest=new Map();for(const {q,s}of scored)highest.set(video(q),Math.max(highest.get(video(q))||0,s));
 return scored.sort((a,b)=>{
  if(mode==='kind'){const k=kind(a.q).localeCompare(kind(b.q));if(k)return k;}
  if(mode==='video'){const v=video(a.q),w=video(b.q);if(v!==w)return highest.get(w)-highest.get(v)||v.localeCompare(w);return (a.q.clip?.[0]||0)-(b.q.clip?.[0]||0)||b.s-a.s;}
  return b.s-a.s||String(id(a.q)).localeCompare(String(id(b.q)));
 }).map(x=>x.q);
}
function plan(questions,answers,learning={}){
 const human=values(answers).filter(confirmed),byKind={};for(const a of human)byKind[a.kind]=(byKind[a.kind]||0)+1;
 const pending=Number(learning.pending)||0,minimum=8,target=24;
 return {minimum,target,pending,remaining:Math.max(0,minimum-pending),ready:pending>=minimum,totalConfirmed:human.length,byKind,
  trainableConfirmed:human.filter(a=>trainable.has(a.kind)).length,modelType:'Bayesian species / move priors',
  reason:'Refit after 8 new useful answers; aim for 24 across species and question types. Corrections refit sooner. League and footage answers update the pipeline immediately.'};
}
const api={groupKind,priority,orderQuestions,plan,confirmed};if(typeof module!=='undefined')module.exports=api;root.MetaValidationPolicy=api;
})(typeof window==='undefined'?globalThis:window);
