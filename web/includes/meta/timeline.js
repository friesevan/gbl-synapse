// Battle timeline for the Meta Extractor: each Pokémon's HP through the battle (from the HP bars,
// MetaHp.hpTimeline) with the battle's events on top — charged attacks, shields, switches, faints and
// the result. Pure SVG built with DOM calls; the data is a stored battle summary (see summarize()).
(function(root){
'use strict';
const NS='http://www.w3.org/2000/svg';
// Compact, storable summary of one analyzed battle: HP as whole percent per half second (-1 = not on
// the field yet), events relative to the battle start. No trainer names are read or kept.
function summarize(b,{recording='',index=0,moveName=id=>id}={}){const hp=b.hp||root.MetaHp?.hpTimeline(b),t0=b.start;
 const pk=p=>({key:p.key,label:p.label||p.candidates?.[0]?.name||'Pokémon',species:p.inference?.forms?.[0]?.value||p.formId||String(p.candidates?.[0]?.id||'').replace(/_shadow$/,''),fastMove:p.inference?.moves?.[0]?.value||null,fastMoveName:p.inference?.moves?.[0]?moveName(p.inference.moves[0].value):null,fastP:p.inference?.moves?.[0]?.p??null,shadowP:p.inference?.shadowP??null,cp:p.cp||null});
 const q=list=>Object.fromEntries(Object.entries(list||{}).map(([k,s])=>[k,s.map(v=>v==null?-1:Math.round(v*100))]));
 const events=(b.events||[]).filter(e=>['move','shield','faint','go','result','surrender'].includes(e.kind)&&e.t>=t0-1).map(e=>({t:+(e.t-t0).toFixed(1),kind:e.kind,side:e.side||null,actor:e.actor||null,move:e.move?moveName(e.move):null}));
 for(const e of b.effects||[])events.push({t:+(e.t-t0).toFixed(1),kind:'effect',side:e.side,effect:e.kind});
 return {recording,battle:index,start:+t0.toFixed(1),duration:+(b.end-t0).toFixed(1),result:b.result,ending:b.ending||'normal',my:(b.my||[]).map(pk),opponent:(b.opponent||[]).map(pk),events:events.sort((a,c)=>a.t-c.t),hp:hp?{step:hp.step,my:q(hp.my),opponent:q(hp.opponent)}:null};}
const COLORS=['var(--meta-tl-1, #2f7de1)','var(--meta-tl-2, #e0752d)','var(--meta-tl-3, #2aa876)'];
const make=(tag,attrs={},text)=>{const n=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;};
const clock=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
// Two stacked panels (your team above, the opponent below) sharing one time axis.
function render(s,{width=720,sideLabels={my:'You',opponent:'Opponent'}}={}){const pad={l:40,r:12,t:12},ph=110,gap=34,axis=22,H=pad.t+ph*2+gap+axis,W=width,iw=W-pad.l-pad.r,dur=Math.max(1,s.duration),x=t=>pad.l+Math.max(0,Math.min(1,t/dur))*iw;
 const svg=make('svg',{viewBox:`0 0 ${W} ${H}`,class:'meta-tl',role:'img','aria-label':`HP timeline, ${sideLabels.my&&sideLabels.my!=='You'?sideLabels.my+': ':''}${s.result||'unknown result'}`});
 const panels=[['my',sideLabels.my||'You',pad.t],['opponent',sideLabels.opponent||'Opponent',pad.t+ph+gap]];
 for(const [side,name,top] of panels){const y=v=>top+ph-(v/100)*ph;
  svg.append(make('rect',{x:pad.l,y:top,width:iw,height:ph,class:'meta-tl-panel'}));
  for(const v of [0,50,100]){svg.append(make('line',{x1:pad.l,x2:pad.l+iw,y1:y(v),y2:y(v),class:'meta-tl-grid'}));svg.append(make('text',{x:pad.l-6,y:y(v)+4,'text-anchor':'end',class:'meta-tl-tick'},`${v}%`));}
  svg.append(make('text',{x:pad.l+4,y:top-2,class:'meta-tl-label'},name));
  (s[side]||[]).forEach((p,i)=>{const series=s.hp?.[side]?.[p.key];if(!series)return;let d='',ended=false;series.forEach((v,k)=>{if(v<0||ended){return;}if(v===0)ended=true;const px=x(k*s.hp.step),py=y(v);d+=(d&&series[k-1]>=0?'L':'M')+px.toFixed(1)+' '+py.toFixed(1);});
   if(d){const path=make('path',{d,class:'meta-tl-hp',stroke:COLORS[i%3]});path.append(make('title',{},`${p.label}${p.fastMoveName?` · ${p.fastMoveName}`:''}`));svg.append(path);}});
  // events on this side
  for(const e of s.events.filter(e=>e.side===side||(e.kind==='go'&&(s[side]||[]).some(p=>p.key===e.actor)))){const ex=x(e.t);
   if(e.kind==='move'){const m=make('path',{d:`M${ex-5} ${top+2}L${ex+5} ${top+2}L${ex} ${top+10}Z`,class:'meta-tl-move'});m.append(make('title',{},`${clock(e.t)} · ${e.move||'Charged attack'}`));svg.append(m);}
   else if(e.kind==='shield'){const m=make('rect',{x:ex-4,y:top+ph-12,width:8,height:10,rx:2,class:'meta-tl-shield'});m.append(make('title',{},`${clock(e.t)} · Shield used`));svg.append(m);}
   else if(e.kind==='faint'){const m=make('path',{d:`M${ex-4} ${top+ph-4}l8 -8M${ex-4} ${top+ph-12}l8 8`,class:'meta-tl-faint'});m.append(make('title',{},`${clock(e.t)} · Fainted`));svg.append(m);}
   else if(e.kind==='go'){svg.append(make('line',{x1:ex,x2:ex,y1:top,y2:top+ph,class:'meta-tl-switch'}));}
   else if(e.kind==='effect'){const m=make('circle',{cx:ex,cy:top+16,r:3,class:e.effect==='super'?'meta-tl-super':'meta-tl-weak'});m.append(make('title',{},`${clock(e.t)} · ${e.effect==='super'?'Super effective':'Not very effective'} hit`));svg.append(m);}}}
 // time axis
 const ay=pad.t+ph*2+gap+4,step=dur>150?30:dur>60?15:10;for(let t=0;t<=dur;t+=step){svg.append(make('text',{x:x(t),y:ay+12,'text-anchor':'middle',class:'meta-tl-tick'},clock(t)));}
 const customPerspective=sideLabels.my&&sideLabels.my!=='You';const res=s.result&&s.result!=='Unknown'?`${customPerspective?sideLabels.my+': ':''}${s.result}${s.ending&&s.ending!=='normal'?` (${s.ending==='you-forfeit'?(customPerspective?sideLabels.my+' forfeited':'you forfeited'):(sideLabels.opponent||'Opponent')+' forfeited'})`:''}`:null;if(res)svg.append(make('text',{x:pad.l+iw,y:pad.t+ph+gap-4,'text-anchor':'end',class:'meta-tl-result'},res));
 return svg;}
function legend(s,{sideLabels={my:'You',opponent:'Opponent'}}={}){const box=document.createElement('div');box.className='meta-tl-legend';for(const [side,name] of [['my',sideLabels.my||'You'],['opponent',sideLabels.opponent||'Opponent']]){const row=document.createElement('div');row.append(Object.assign(document.createElement('strong'),{textContent:name+': '}));(s[side]||[]).forEach((p,i)=>{const sw=document.createElement('span');sw.className='meta-tl-swatch';sw.style.background=COLORS[i%3];const t=document.createElement('span');const bits=[p.label];if(p.fastMoveName)bits.push(p.fastMoveName);if(p.shadowP!=null&&p.shadowP>=.5)bits.push('Shadow');t.textContent=bits.join(' · ');row.append(sw,t);});box.append(row);}
 const key=document.createElement('p');key.className='hint';key.textContent='▼ charged attack · ▮ shield · ✕ faint · │ switch · ● super effective / ○ not very effective';box.append(key);return box;}
const api={summarize,render,legend};if(typeof module!=='undefined')module.exports=api;root.MetaTimeline=api;
})(typeof window==='undefined'?globalThis:window);
