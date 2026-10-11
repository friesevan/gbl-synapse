// "Model performance" view of the Validate tab: per-refit held-out accuracy, Shadow classifier AUC and
// log-loss, queue status and calibration, drawn from the metrics history that feedback.py appends after
// every refit (WORK/metrics-history.json, GET /api/validation/metrics). Pure helpers (records, tiles,
// accuracySeries, statusSeries) are exported for tests; render() builds plain DOM + inline SVG.
(function(root){'use strict';
const NS='http://www.w3.org/2000/svg';
// Fixed categorical order (dataviz palette slots 1-4); a kind keeps its color in every chart.
const KINDS=[
 {key:'fastMove',label:'Fast move',plural:'Fast moves',color:'var(--pf-s1)'},
 {key:'shadow',label:'Shadow',plural:'Shadow',color:'var(--pf-s2)'},
 {key:'form',label:'Form',plural:'Forms',color:'var(--pf-s3)'},
 {key:'result',label:'Battle outcome',plural:'Battle outcomes',color:'var(--pf-s4)'}];
const STATUS=[
 {key:'answered',label:'Human answered',color:'var(--pf-human)'},
 {key:'resolved',label:'Model resolved',color:'var(--pf-model)'},
 {key:'open',label:'Open',color:'var(--pf-open)'}];
const KIND_LABEL={shadow:'Shadow',fastMove:'Fast move',form:'Form',result:'Battle outcome',footage:'Battle footage',league:'League / cup',lead:'Opponent lead',perspective:'Championship perspective',other:'Other'};

// ---- pure helpers ----
const num=v=>typeof v==='number'&&Number.isFinite(v);
const sum=o=>Object.values(o||{}).reduce((s,v)=>s+(num(v)?v:0),0);
const ratio=x=>x&&num(x.right)&&num(x.total)&&x.total>0?x.right/x.total:null;
const fmtInt=n=>num(n)?Math.round(n).toLocaleString('en-US'):'–';
const fmtPct=(v,d=0)=>num(v)?`${(v*100).toFixed(d)}%`:'–';
const fmtNum=(v,d=3)=>num(v)?v.toFixed(d):'–';
function fmtTime(iso){const t=new Date(iso);if(!iso||Number.isNaN(t.getTime()))return '';try{return t.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch(e){return t.toISOString().slice(0,16).replace('T',' ');}}
function fmtDuration(s){if(!num(s))return '';const m=Math.floor(s/60);return m?`${m} min ${Math.round(s%60)} s`:`${Math.round(s)} s`;}
function records(history){return (Array.isArray(history?.records)?history.records:[]).filter(r=>r&&num(r.refit)).slice().sort((a,b)=>a.refit-b.refit);}
// Held-out accuracy per kind, one row per refit that recorded any of it.
function accuracySeries(history){return records(history).filter(r=>KINDS.some(k=>ratio(r.heldOut?.[k.key])!==null)).map(r=>({refit:r.refit,at:r.at,backfilled:!!r.backfilled,labels:r.labels||{},
 values:Object.fromEntries(KINDS.map(k=>[k.key,ratio(r.heldOut?.[k.key])])),heldOut:r.heldOut||{}}));}
// Queue status after each refit; only refits that recorded all three counts (no zero-filling).
function statusSeries(history){return records(history).filter(r=>r.open&&r.resolved&&r.labels&&num(r.questions)).map(r=>{const resolved=sum(r.resolved.model)+Object.entries(r.resolved).filter(([k])=>k!=='model').reduce((s,[,v])=>s+sum(v),0),open=sum(r.open);
 return {refit:r.refit,at:r.at,backfilled:!!r.backfilled,questions:r.questions,open,resolved,answered:Math.max(0,r.questions-open-resolved),resolvedBy:r.resolved};});}
function shadowSeries(history){return records(history).filter(r=>num(r.heldOut?.shadow?.auc)||num(r.heldOut?.shadow?.logLoss)).map(r=>({refit:r.refit,at:r.at,backfilled:!!r.backfilled,s:r.heldOut.shadow,base:r.heldOut.shadow.baseline||{}}));}
// Headline tiles: held-out accuracy per kind with the change since the previous refit that measured it,
// then live queue counts (answers, model resolved, open) with the change since the last refit.
function tiles(history,live={}){const recs=records(history),out=[],last=recs.at(-1);
 for(const k of KINDS){let cur=null,prev=null;for(let i=recs.length-1;i>=0;i--){if(ratio(recs[i].heldOut?.[k.key])===null)continue;if(!cur)cur=recs[i];else{prev=recs[i];break;}}
  if(!cur)continue;const h=cur.heldOut[k.key],v=ratio(h),d=prev?v-ratio(prev.heldOut[k.key]):null;
  out.push({key:k.key,label:`${k.plural} · held out`,value:fmtPct(v),detail:`${fmtInt(h.right)} of ${fmtInt(h.total)} right${num(h.auc)?` · AUC ${h.auc.toFixed(2)}`:''}`,
   delta:d===null?{text:`First measured at refit ${cur.refit}`,dir:0}:Math.abs(d)<5e-4?{text:`Unchanged since refit ${prev.refit}`,dir:0}:{text:`${d>0?'▲':'▼'} ${Math.abs(d*100).toFixed(1)} pts vs refit ${prev.refit}`,dir:Math.sign(d)}});}
 const since=(now,then)=>num(now)&&num(then)&&last?{text:now===then?`Unchanged since refit ${last.refit}`:`${now>then?'+':'−'}${fmtInt(Math.abs(now-then))} since refit ${last.refit}`,dir:0}:null;
 if(num(live.answers))out.push({key:'answers',label:'Answers given',value:fmtInt(live.answers),detail:live.notSure?`${fmtInt(live.answers-live.notSure)} confirmed · ${fmtInt(live.notSure)} not sure`:'Your confirmed answers train the model',delta:since(live.answers,last?.answers?sum(last.answers):null)});
 if(num(live.resolved))out.push({key:'resolved',label:'Model resolved',value:fmtInt(live.resolved),detail:`${fmtInt(live.resolvedModel)} model · ${fmtInt(live.resolvedFree)} free LLM`,delta:since(live.resolved,last?.resolved?statusSeries({records:[last]})[0]?.resolved:null)});
 if(num(live.open))out.push({key:'open',label:'Open questions',value:fmtInt(live.open),detail:num(live.questions)?`of ${fmtInt(live.questions)} questions`:'',delta:since(live.open,last?.open?sum(last.open):null)});
 return out;}

// ---- DOM helpers ----
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined&&text!==null)n.textContent=text;if(cls)n.className=cls;return n;};
function svg(tag,attrs={},text){const n=document.createElementNS?document.createElementNS(NS,tag):document.createElement(tag);for(const [k,v] of Object.entries(attrs))if(v!==undefined&&v!==null)n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n;}
const r1=v=>Math.round(v*10)/10,FIG_PAD=30,GAP=16;
// Column count and each figure's inner chart width for a row of small multiples.
function multiples(width,n,min){const cols=Math.max(1,Math.min(n,Math.floor((width+GAP)/(min+GAP)))),outer=(width-GAP*(cols-1))/cols;return {cols,w:Math.max(220,outer-FIG_PAD)};}
function multi(figs,cols){const g=el('div',undefined,'meta-perf-multi');g.style.gridTemplateColumns=`repeat(${cols},minmax(0,1fr))`;g.append(...figs);return g;}
function niceTicks(lo,hi,count=5){const span=hi-lo||1,raw=span/count,mag=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].map(m=>m*mag).find(s=>span/s<=count)||raw;const out=[];for(let v=Math.ceil(lo/step-1e-9)*step;v<=hi+1e-9;v+=step)out.push(+v.toFixed(10));return out;}
function intTicks(values,max=8){if(values.length<=max)return values;const step=Math.ceil(values.length/max),out=values.filter((_,i)=>i%step===0);if(out.at(-1)!==values.at(-1))out.push(values.at(-1));return out;}
function legend(items){const box=el('div',undefined,'meta-perf-legend');for(const it of items){const s=el('span');const key=el('i',undefined,it.kind==='bar'?'meta-perf-key bar':it.kind==='hollow'?'meta-perf-key hollow':'meta-perf-key');key.style.setProperty?.('--key',it.color);key.setAttribute('aria-hidden','true');s.append(key,el('span',it.label));box.append(s);}return box;}
// Cells are text or {text,title}; columns listed in wrap may wrap, the rest stay on one line.
function tableWrap(caption,head,rows,wrap=[]){const box=el('div',undefined,'meta-perf-scroll'),t=el('table'),thead=el('thead'),tr=el('tr'),tb=el('tbody');t.append(el('caption',caption));
 for(const h of head){const th=el('th',h);th.setAttribute('scope','col');tr.append(th);}thead.append(tr);
 for(const row of rows){const r=el('tr');row.forEach((c,i)=>{const cell=el(i?'td':'th',c&&typeof c==='object'?c.text:c,wrap.includes(i)?'wrap':undefined);if(c&&typeof c==='object'&&c.title)cell.title=c.title;if(!i)cell.setAttribute('scope','row');r.append(cell);});tb.append(r);}
 t.append(thead,tb);box.append(t);return box;}
// Every chart has a table twin behind a disclosure (tooltips enhance, never gate).
function table(caption,head,rows){const d=el('details',undefined,'meta-perf-table');d.dataset.key='table:'+caption;d.append(el('summary','Data table'),tableWrap(caption,head,rows));return d;}
function figure(title,subtitle){const f=el('figure',undefined,'meta-perf-fig'),cap=el('figcaption');cap.append(el('strong',title));if(subtitle)cap.append(el('span',subtitle,'meta-perf-sub'));f.append(cap);return f;}
function tipRow(color,value,label,kind){const row=el('div',undefined,'meta-perf-tip-row'),key=el('i',undefined,kind==='bar'?'meta-perf-key bar':'meta-perf-key');key.style.setProperty?.('--key',color);row.append(key,el('strong',value),el('span',label));return row;}
// Crosshair + one tooltip for every series at the nearest x; arrow keys do the same from the keyboard.
function interact(plot,canvas,{W,xs,top,bottom,tip,label}){const tipEl=el('div',undefined,'meta-perf-tip');tipEl.hidden=true;tipEl.setAttribute('aria-live','polite');plot.append(tipEl);
 const cross=svg('line',{x1:0,x2:0,y1:top,y2:bottom,class:'meta-perf-cross',visibility:'hidden'});canvas.append(cross);let idx=xs.length-1;
 const show=i=>{if(!xs.length)return;idx=Math.max(0,Math.min(xs.length-1,i));const x=xs[idx];cross.setAttribute('x1',r1(x));cross.setAttribute('x2',r1(x));cross.setAttribute('visibility','visible');tipEl.replaceChildren(...tip(idx));tipEl.hidden=false;
  const left=x<W/2;tipEl.style.left=left?`${(x/W*100).toFixed(2)}%`:'auto';tipEl.style.right=left?'auto':`${((W-x)/W*100).toFixed(2)}%`;tipEl.className='meta-perf-tip '+(left?'to-right':'to-left');};
 const hide=()=>{cross.setAttribute('visibility','hidden');tipEl.hidden=true;};
 const nearest=px=>xs.reduce((b,x,i)=>Math.abs(x-px)<Math.abs(xs[b]-px)?i:b,0);
 canvas.setAttribute('tabindex','0');canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`${label}. Use the left and right arrow keys to read each value; a data table follows.`);
 canvas.onpointermove=e=>{const r=canvas.getBoundingClientRect?.();if(!r||!r.width)return;show(nearest((e.clientX-r.left)*W/r.width));};canvas.onpointerleave=hide;canvas.onfocus=()=>show(idx);canvas.onblur=hide;
 canvas.onkeydown=e=>{const step={ArrowLeft:-1,ArrowRight:1}[e.key];if(step){e.preventDefault?.();show(idx+step);}else if(e.key==='Home')show(0);else if(e.key==='End')show(xs.length-1);else if(e.key==='Escape')hide();};
 return {show,hide};}
// Lines over a numeric x (refit number, or predicted probability for calibration). Gaps stay gaps.
function lineChart(o){const W=Math.max(240,Math.round(o.width||640)),H=o.height||220,narrow=W<520,endLabels=!narrow&&o.endLabels!==false&&o.series.length<=4;
 const m={l:44,r:endLabels?96:14,t:12,b:o.xTitle?42:28},pw=W-m.l-m.r,ph=H-m.t-m.b,[x0,x1]=o.xDomain,[y0,y1]=o.yDomain;
 const X=v=>m.l+(x1===x0?pw/2:(v-x0)/(x1-x0)*pw),Y=v=>m.t+ph-(v-y0)/(y1-y0)*ph;
 const f=figure(o.title,o.subtitle);if(o.series.length>1||o.legendExtra)f.append(legend([...(o.series.length>1?o.series.map(s=>({label:s.label,color:s.color})):[]),...(o.legendExtra||[])]));
 const plot=el('div',undefined,'meta-perf-plot'),c=svg('svg',{viewBox:`0 0 ${W} ${H}`,width:W,height:H,class:'meta-perf-svg'});
 for(const t of o.yTicks||niceTicks(y0,y1)){c.append(svg('line',{x1:m.l,x2:m.l+pw,y1:r1(Y(t)),y2:r1(Y(t)),class:'meta-perf-gridline'}),svg('text',{x:m.l-6,y:r1(Y(t))+4,'text-anchor':'end',class:'meta-perf-tick'},o.yFormat(t)));}
 c.append(svg('line',{x1:m.l,x2:m.l+pw,y1:m.t+ph,y2:m.t+ph,class:'meta-perf-axis'}));
 for(const t of o.xTicks)c.append(svg('text',{x:r1(X(t)),y:m.t+ph+18,'text-anchor':'middle',class:'meta-perf-tick'},o.xFormat?o.xFormat(t):String(t)));
 if(o.xTitle)c.append(svg('text',{x:m.l+pw/2,y:H-6,'text-anchor':'middle',class:'meta-perf-tick'},o.xTitle));
 if(o.diagonal)c.append(svg('line',{x1:X(x0),y1:Y(y0),x2:X(x1),y2:Y(y1),class:'meta-perf-ref'}));
 for(const ref of o.refs||[]){c.append(svg('line',{x1:m.l,x2:m.l+pw,y1:r1(Y(ref.y)),y2:r1(Y(ref.y)),class:'meta-perf-ref'}),svg('text',{x:m.l+pw-2,y:r1(Y(ref.y))-4,'text-anchor':'end',class:'meta-perf-tick'},ref.label));}
 const xs=o.points.map(p=>X(p.x)),marks=[];
 for(const s of o.series){let d='',pen=false,segs=0;s.values.forEach((v,i)=>{if(!num(v)){pen=false;return;}d+=`${pen?'L':'M'}${r1(xs[i])},${r1(Y(v))}`;if(pen)segs++;pen=true;});if(segs)c.append(svg('path',{d,class:'meta-perf-line',stroke:s.color}));
  const dots=s.values.map((v,i)=>{if(!num(v))return null;const hollow=s.hollow?.[i];const dot=svg('circle',{cx:r1(xs[i]),cy:r1(Y(v)),r:4,class:hollow?'meta-perf-dot hollow':'meta-perf-dot',fill:hollow?'var(--pf-panel)':s.color,stroke:hollow?s.color:'var(--pf-panel)'});c.append(dot);return dot;});marks.push(dots);}
 if(endLabels){const placed=[];o.series.forEach((s,si)=>{const i=s.values.map(num).lastIndexOf(true);if(i<0)return;const y=Y(s.values[i]);if(placed.some(p=>Math.abs(p-y)<13))return;placed.push(y);
  c.append(svg('text',{x:r1(xs[i])+10,y:r1(y)+4,class:'meta-perf-end'},`${s.label} ${o.yFormat(s.values[i],true)}`));});}
 plot.append(c);f.append(plot);
 interact(plot,c,{W,xs,top:m.t,bottom:m.t+ph,label:o.title,tip:i=>{const head=el('div',o.points[i].title,'meta-perf-tip-head');if(o.points[i].backfilled)head.append(el('span','Backfilled','meta-pill'));
  return [head,...o.series.filter(s=>num(s.values[i])).map(s=>tipRow(s.color,o.yFormat(s.values[i],true),s.tipLabel?s.tipLabel(i):s.label)),...(o.points[i].extra||[]).map(t=>el('div',t,'meta-perf-tip-extra'))];}});
 if(o.note)f.append(el('p',o.note,'meta-perf-note'));if(o.table)f.append(table(...o.table));return f;}
// Stacked columns: human answered (bottom), model resolved, open; 2px surface gaps, rounded top.
function stackedChart(o){const W=Math.max(240,Math.round(o.width||640)),H=o.height||220,m={l:52,r:14,t:12,b:28},pw=W-m.l-m.r,ph=H-m.t-m.b,rows=o.rows;
 const max=Math.max(1,...rows.map(r=>r.questions)),ticks=niceTicks(0,max,4),top=ticks.at(-1)>=max?ticks.at(-1):max,Y=v=>m.t+ph-v/top*ph,band=pw/Math.max(1,rows.length),bw=Math.max(3,Math.min(24,band*.7));
 const f=figure(o.title,o.subtitle);f.append(legend(STATUS.map(s=>({label:s.label,color:s.color,kind:'bar'}))));
 const plot=el('div',undefined,'meta-perf-plot'),c=svg('svg',{viewBox:`0 0 ${W} ${H}`,width:W,height:H,class:'meta-perf-svg'});
 for(const t of ticks){c.append(svg('line',{x1:m.l,x2:m.l+pw,y1:r1(Y(t)),y2:r1(Y(t)),class:'meta-perf-gridline'}),svg('text',{x:m.l-6,y:r1(Y(t))+4,'text-anchor':'end',class:'meta-perf-tick'},fmtInt(t)));}
 const xs=rows.map((_,i)=>m.l+band*(i+.5));
 rows.forEach((r,i)=>{let base=0;const segs=STATUS.map(s=>({s,v:r[s.key]})).filter(x=>x.v>0);segs.forEach((g,j)=>{const y0=Y(base),y1=Y(base+g.v),last=j===segs.length-1,h=Math.max(0,y0-y1-(j?2:0)),x=xs[i]-bw/2,yTop=y1;
   if(last&&h>4){const rr=Math.min(4,bw/2);c.append(svg('path',{d:`M${r1(x)},${r1(yTop+h)}V${r1(yTop+rr)}Q${r1(x)},${r1(yTop)} ${r1(x+rr)},${r1(yTop)}H${r1(x+bw-rr)}Q${r1(x+bw)},${r1(yTop)} ${r1(x+bw)},${r1(yTop+rr)}V${r1(yTop+h)}Z`,fill:g.s.color,class:'meta-perf-bar'}));}
   else c.append(svg('rect',{x:r1(x),y:r1(yTop),width:r1(bw),height:r1(h),fill:g.s.color,class:'meta-perf-bar'}));base+=g.v;});});
 c.append(svg('line',{x1:m.l,x2:m.l+pw,y1:m.t+ph,y2:m.t+ph,class:'meta-perf-axis'}));
 const tickIdx=new Set(intTicks(rows.map((_,i)=>i),Math.max(2,Math.floor(pw/48))));rows.forEach((r,i)=>{if(tickIdx.has(i))c.append(svg('text',{x:r1(xs[i]),y:m.t+ph+18,'text-anchor':'middle',class:'meta-perf-tick'},String(r.refit)));});
 plot.append(c);f.append(plot);
 interact(plot,c,{W,xs,top:m.t,bottom:m.t+ph,label:o.title,tip:i=>{const r=rows[i],head=el('div',`Refit ${r.refit} · ${fmtTime(r.at)}`,'meta-perf-tip-head');if(r.backfilled)head.append(el('span','Backfilled','meta-pill'));
  return [head,...[...STATUS].reverse().map(s=>tipRow(s.color,fmtInt(r[s.key]),s.label,'bar')),el('div',`${fmtInt(r.questions)} questions`,'meta-perf-tip-extra')];}});
 if(o.note)f.append(el('p',o.note,'meta-perf-note'));if(o.table)f.append(table(...o.table));return f;}

// ---- sections ----
function tileRow(list){const box=el('div',undefined,'meta-perf-tiles');for(const t of list){const d=el('div',undefined,'meta-perf-tile');d.dataset.key=t.key;d.append(el('small',t.label),el('strong',t.value));if(t.detail)d.append(el('span',t.detail,'meta-perf-detail'));
 if(t.delta){const s=el('span',t.delta.text,'meta-perf-delta'+(t.delta.dir>0?' up':t.delta.dir<0?' down':''));d.append(s);}box.append(d);}return box;}
function refitXAxis(list,pw){const refits=list.map(r=>r.refit),lo=refits[0],hi=refits.at(-1);return {xDomain:lo===hi?[lo-1,hi+1]:[lo,hi],xTicks:intTicks(refits,Math.max(2,Math.floor(pw/56)))};}
function accuracyFigure(history,width){const rows=accuracySeries(history);if(!rows.length)return null;const kinds=KINDS.filter(k=>rows.some(r=>num(r.values[k.key])));
 const all=rows.flatMap(r=>kinds.map(k=>r.values[k.key])).filter(num),lo=Math.max(0,Math.min(50,Math.floor((Math.min(...all)*100-5)/10)*10))/100;
 const first=rows[0].refit,single=rows.length===1;
 return lineChart({title:'Held-out accuracy by refit',subtitle:'Share of human labels the model got right on videos it was refitted without',width,height:230,...refitXAxis(rows,width-140),xTitle:'Refit',
  yDomain:[lo,1],yTicks:niceTicks(lo,1,5),yFormat:(v,full)=>fmtPct(v,full?1:0),points:rows.map(r=>({x:r.refit,title:`Refit ${r.refit} · ${fmtTime(r.at)}`,backfilled:r.backfilled,extra:[labelsLine(r.labels)].filter(Boolean)})),
  series:kinds.map(k=>({label:k.label,color:k.color,values:rows.map(r=>r.values[k.key]),hollow:rows.map(r=>r.backfilled),tipLabel:i=>{const h=rows[i].heldOut[k.key];return `${k.label} · ${fmtInt(h.right)}/${fmtInt(h.total)}`;}})),
  legendExtra:rows.some(r=>r.backfilled)?[{label:'Hollow: backfilled from saved files',color:'var(--pf-ink2)',kind:'hollow'}]:null,
  note:single?`Recorded from refit ${first} on; each refit adds a point. Earlier refits saved no held-out results (see Model changes measured offline).`:`Recorded from refit ${first} on.`,
  table:['Held-out accuracy by refit',['Refit','Time',...kinds.map(k=>k.label)],[...rows].reverse().map(r=>[`${r.refit}${r.backfilled?' (backfilled)':''}`,fmtTime(r.at),...kinds.map(k=>{const h=r.heldOut[k.key];return h?`${fmtPct(r.values[k.key],1)} (${h.right}/${h.total})`:'–';})])]});}
function labelsLine(labels){const parts=KINDS.filter(k=>num(labels?.[k.key])).map(k=>`${fmtInt(labels[k.key])} ${k.key==='shadow'?'Shadow':k.label.toLowerCase()}`);return parts.length?`Your labels: ${parts.join(' · ')}`:'';}
function shadowFigures(history,width){const rows=shadowSeries(history);if(!rows.length)return null;const {cols,w}=multiples(width,2,300),axis=refitXAxis(rows,w-60);
 const pts=rows.map(r=>({x:r.refit,title:`Refit ${r.refit} · ${fmtTime(r.at)}`,backfilled:r.backfilled,extra:[`${fmtInt(r.s.total)} Shadow labels`]}));
 const series=(key)=>[{label:'Classifier',color:'var(--pf-s2)',values:rows.map(r=>num(r.s[key])?r.s[key]:null),hollow:rows.map(r=>r.backfilled)},{label:'Old posterior (baseline)',color:'var(--pf-base)',values:rows.map(r=>num(r.base[key])?r.base[key]:null),hollow:rows.map(r=>r.backfilled)}];
 const maxLL=Math.max(.8,...rows.flatMap(r=>[r.s.logLoss,r.base.logLoss]).filter(num));
 const auc=lineChart({title:'Shadow classifier · AUC',subtitle:'Higher is better; 0.5 is a coin flip, 1 is perfect',width:w,height:190,...axis,yDomain:[.5,1],yTicks:[.5,.6,.7,.8,.9,1],yFormat:(v,full)=>fmtNum(v,full?3:1),points:pts,series:series('auc'),endLabels:false,
  table:['Shadow classifier AUC by refit',['Refit','Classifier','Old posterior'],[...rows].reverse().map(r=>[String(r.refit),fmtNum(r.s.auc),fmtNum(r.base.auc)])]});
 const ll=lineChart({title:'Shadow classifier · log-loss',subtitle:'Lower is better; confident mistakes cost the most',width:w,height:190,...axis,yDomain:[0,Math.ceil(maxLL*10)/10],yFormat:(v,full)=>fmtNum(v,full?3:1),points:pts,series:series('logLoss'),endLabels:false,
  refs:[{y:Math.log(2),label:'coin flip 0.693'}],table:['Shadow classifier log-loss by refit',['Refit','Classifier','Old posterior'],[...rows].reverse().map(r=>[String(r.refit),fmtNum(r.s.logLoss),fmtNum(r.base.logLoss)])]});
 return multi([auc,ll],cols);}
function statusFigure(history,width){const rows=statusSeries(history).slice(-40);if(!rows.length)return null;
 return stackedChart({title:'Questions after each refit',subtitle:'Human answered, model resolved and still open',width,height:220,rows,
  note:`Recorded from refit ${rows[0].refit} on${rows.length===40?' (last 40 refits shown)':''}. Earlier refits saved only answer counts (data table of the refit history).`,
  table:['Questions after each refit',['Refit','Human answered','Model resolved','Open','Total'],[...rows].reverse().map(r=>[String(r.refit),fmtInt(r.answered),fmtInt(r.resolved),fmtInt(r.open),fmtInt(r.questions)])]});}
const MIN_BIN=5;
const CAL=[{key:'shadow',title:'Shadow classifier',x:'Predicted chance of Shadow',y:'Share that were Shadow',color:'var(--pf-s2)'},{key:'fastMove',title:'Fast moves',x:'Confidence in the top pick',y:'Share right',color:'var(--pf-s1)'},{key:'form',title:'Forms',x:'Confidence in the top pick',y:'Share right',color:'var(--pf-s3)'}];
function calibrationFigures(history,width){const last=[...records(history)].reverse().find(r=>r.calibration&&Object.keys(r.calibration).length);if(!last)return null;
 const kinds=CAL.filter(k=>Array.isArray(last.calibration[k.key])&&last.calibration[k.key].length);if(!kinds.length)return null;const {cols,w}=multiples(width,kinds.length,230);
 // Bins with fewer than MIN_BIN labels are too noisy to plot; the data table lists every bin.
 const figs=kinds.map(k=>{const all=last.calibration[k.key].filter(b=>Array.isArray(b)&&num(b[0])&&num(b[1])),bins=all.filter(b=>(b[2]||0)>=MIN_BIN),small=all.length-bins.length;if(!bins.length)return null;const lo=k.key==='shadow'?0:Math.min(.5,Math.floor(Math.min(...bins.map(b=>Math.min(b[0],b[1])))*10)/10);
  return lineChart({title:k.title,subtitle:`${k.x} against ${k.key==='shadow'?'the share that were Shadow':'the share right'}; the diagonal is perfect calibration`,width:w,height:Math.min(260,Math.max(200,w*.75)),xDomain:[lo,1],xTicks:niceTicks(lo,1,4),xFormat:v=>fmtPct(v),yDomain:[lo,1],yFormat:(v,full)=>fmtPct(v,full?1:0),diagonal:true,endLabels:false,
   points:bins.map(b=>({x:b[0],title:`Predicted ${fmtPct(b[0],1)}`,extra:[`${fmtInt(b[2])} held-out labels`]})),series:[{label:k.y,color:k.color,values:bins.map(b=>b[1])}],
   note:small?`${small} bin${small===1?'':'s'} with fewer than ${MIN_BIN} labels ${small===1?'is':'are'} only in the data table.`:null,
   table:[`${k.title} calibration, refit ${last.refit}`,['Mean predicted',k.y,'Labels'],all.map(b=>[fmtPct(b[0],1),fmtPct(b[1],1),fmtInt(b[2])])]});}).filter(Boolean);if(!figs.length)return null;
 const sec=el('section',undefined,'meta-perf-section');sec.append(el('h4',`Calibration at refit ${last.refit}`),el('p','Held-out predictions grouped by confidence. Points on the diagonal mean the stated confidence matches how often the model was right.','hint'),multi(figs,Math.min(cols,figs.length)));return sec;}
function gatesSection(rec){const g=rec?.gates;if(!g)return null;const box=el('section',undefined,'meta-perf-section'),list=el('ul',undefined,'meta-perf-gates');box.append(el('h4','When questions resolve without you'));
 const status=ok=>el('span',ok?'Resolving':'Not yet','meta-pill '+(ok?'win':''));
 const res=rec.resolved?.model||{},vals=rec.shadowValues||{};
 const item=(label,ok,text)=>{const li=el('li');li.append(status(ok),el('strong',label),el('span',text));list.append(li);};
 for(const k of ['fastMove','form']){const x=g[k];if(!x)continue;const at=num(x.resolveAt)?x.resolveAt:x.threshold;
  const sweepAt=(x.sweep||[]).find(s=>s[0]===at);
  const floor=x.resolving&&num(x.threshold)&&num(at)&&at>x.threshold?` Resolves at ≥ ${fmtPct(at)}, the minimum allowed${sweepAt?` (${sweepAt[1]} of ${sweepAt[2]} right at that level)`:''}.`:'';
  item(KIND_LABEL[k],!!x.resolving,x.resolving?`Gate passed at confidence ≥ ${fmtPct(x.threshold??at)}: ${x.right} of ${x.total} held-out answers right${num(x.videos)?` over ${x.videos} videos`:''} (95% lower bound ${fmtPct(x.lowerBound,1)}).${floor}${num(res[k])?` ${fmtInt(res[k])} resolved.`:''}`
   :`Best threshold so far: ${x.right} of ${x.total} held-out answers right over ${x.videos||0} videos. The gate needs ≥ 30 answers from ≥ 5 videos, ≥ 95% right, with a lower bound ≥ 90%.`);}
 for(const [dir,label,count] of [['regular','Not Shadow',vals.notShadow],['shadow','Shadow',vals.shadow]]){const x=g.shadow?.[dir];if(!x)continue;
  item(label,!!x.resolving,`${x.resolving?'Gate passed at':'Best so far at'} classifier confidence ≥ ${fmtPct(x.confidence,1)}: ${x.right} of ${x.total} held-out calls right${num(x.videos)?` over ${x.videos} videos`:''} (95% lower bound ${fmtPct(x.lowerBound,1)}).${x.resolving?'':' The gate needs ≥ 25 calls from ≥ 5 videos, ≥ 95% right, with a lower bound ≥ 80%.'}${num(count)?` ${fmtInt(count)} resolved.`:''}`);}
 const free=Object.entries(rec.resolved||{}).filter(([k])=>k!=='model').reduce((s,[,v])=>s+sum(v),0);if(free)list.append(el('li',`Free-LLM answers closed ${fmtInt(free)} footage question${free===1?'':'s'}; they never train the model.`,'meta-perf-free'));
 box.append(list);return box;}
function milestonesSection(history){const ms=Array.isArray(history?.milestones)?history.milestones:[];if(!ms.length)return null;const box=el('details',undefined,'meta-perf-section meta-advanced');box.dataset.key='milestones';box.open=accuracySeries(history).length<3;box.append(el('summary','Model changes measured offline, before per-refit tracking'));
 const cell=x=>x?`${fmtPct(ratio(x.before),1)} → ${fmtPct(ratio(x.after),1)} (${x.before.right}→${x.after.right}/${x.after.total})${num(x.after.auc)?`, AUC ${fmtNum(x.before.auc,2)}→${fmtNum(x.after.auc,2)}`:''}`:'–';
 box.append(el('p','Each change was scored by the same held-out-by-video method on the labels available then. These are documented evaluations, not refit records.','hint'));
 box.append(tableWrap('Model changes measured offline',['When','Change','Fast moves','Forms','Shadow','Source'],ms.map(m=>[fmtTime(m.at),`${m.change} (${m.commit})`,cell(m.fastMove),cell(m.form),cell(m.shadow),m.source]),[1,4,5]));return box;}
function historySection(history){const recs=[...records(history)].reverse();if(!recs.length)return null;const box=el('details',undefined,'meta-perf-section meta-advanced');box.dataset.key='history';box.append(el('summary',`Refit history (${recs.length} refit${recs.length===1?'':'s'})`));
 if(recs.some(r=>r.backfilled))box.append(el('p','Backfilled rows were rebuilt when this history began: times and runs from each refit’s output folder, label counts from answer times (they may include answers saved while that refit ran), thresholds from the reasons quoted in resolutions, and the newest refit’s held-out metrics from what it stored. A dash means the files do not record it. Hover a row’s note for its exact sources.','hint'));
 const held=(r,k)=>{const h=r.heldOut?.[k];return h?`${fmtPct(ratio(h),1)} (${h.right}/${h.total})`:'–';};
 box.append(tableWrap('Refit history',['Refit','Time','Reason','Your labels (fast / Shadow / form / all)','Fast move','Shadow','Form','Shadow AUC / log-loss','Model resolved','Open','Notes'],recs.map(r=>{const s=statusSeries({records:[r]})[0];
  return [String(r.refit),fmtTime(r.at),r.reason||'–',r.labels?`${fmtInt(r.labels.fastMove||0)} / ${fmtInt(r.labels.shadow||0)} / ${fmtInt(r.labels.form||0)} / ${fmtInt(sum(r.labels))}`:'–',held(r,'fastMove'),held(r,'shadow'),held(r,'form'),
   r.heldOut?.shadow?`${fmtNum(r.heldOut.shadow.auc)} / ${fmtNum(r.heldOut.shadow.logLoss)}`:'–',s?fmtInt(s.resolved):'–',s?fmtInt(s.open):'–',r.backfilled?{text:'Backfilled',title:r.source||'Saved files'}:'Recorded'];}),[2]));return box;}
function notesSection(live){const box=el('details',undefined,'meta-perf-section meta-advanced meta-perf-notes');box.dataset.key='notes';box.append(el('summary','What these numbers mean'));const ul=el('ul');
 for(const [b,text] of [
  ['Held out by video.','Each labelled video is scored by a model refitted without any label from that video, so the accuracy describes videos the model has not seen. Fast moves and forms are scored on every traceable human label (your answers plus archived labels); Shadow on the classifier’s out-of-fold calls.'],
  ['AUC and log-loss.','AUC is the chance that a random Shadow Pokémon scores higher than a random regular one (0.5 is a coin flip). Log-loss averages how surprised the model was by the true answer; confident mistakes cost the most. The baseline is the old Bayesian posterior on the same labels.'],
  ['Calibration.','Predictions are grouped by confidence. A well-calibrated model is right 80% of the time when it says 80%, which puts the points on the diagonal.'],
  ['Resolution thresholds.','A question leaves the queue only when held-out predictions at that confidence were at least 95% right over enough answers and videos, with a 95% lower bound on accuracy (Wilson) above the gate. Thresholds are recomputed at every refit, and the resolution is undone if the model no longer qualifies.'],
  ['Human answers win.','Your answer always replaces a model or free-LLM resolution, and Reopen sends a resolved question back to the queue. Only confirmed human answers train the model; “Not sure” never does.'],
  ['Backfilled.','Refits that ran before this history existed were rebuilt from saved files (refit output folders, answer times and the thresholds quoted in resolution reasons). Anything those files do not record is left blank.']]){const li=el('li');li.append(el('strong',b+' '),text);ul.append(li);}
 box.append(ul);const acc=live?.agreement||{},parts=KINDS.filter(k=>acc[k.key]?.total).map(k=>`${k.plural.toLowerCase()} ${fmtPct(acc[k.key].right/acc[k.key].total)} (${acc[k.key].total})`);
 if(parts.length)box.append(el('p',`When you answered, the model’s pick matched you for ${parts.join(', ')}. These questions were asked because the model was unsure, so expect lower agreement than held-out accuracy.`,'hint'));return box;}

// Renders the whole view into host. opts: {history, live, learning, mode:'local'|'shared'|'browser', error, width}
function render(host,opts={}){const history=opts.history,live=opts.live||{},learning=opts.learning||{},width=Math.max(260,Math.round(opts.width||host.clientWidth||720)),recs=records(history),last=recs.at(-1);
 const out=[],head=el('div',undefined,'meta-perf-head');head.append(el('h3','Model performance'));
 const busy=['queued','running'].includes(learning.status);const status=[last?`Updated after refit ${last.refit}${last.at?` · ${fmtTime(last.at)}`:''}${last.reason?` · ${last.reason}`:''}${num(last.durationSec)?` · took ${fmtDuration(last.durationSec)}`:''}`:'No refit recorded yet',busy?`Refitting now: ${learning.progress||'updating the model'}`:''].filter(Boolean).join(' · ');
 head.append(el('p',status,'meta-perf-status'));out.push(head);
 out.push(tileRow(tiles(history,live)));
 if(!recs.length){out.push(el('p',opts.error?`Refit history is unavailable: ${opts.error}`:opts.mode==='local'?'Refit history appears here after the first refit.':'Refit history is recorded by the local app (python3 web/run_app.py). This page shows the answers and agreement it can see; charts appear when a metrics history is available.','meta-empty'));out.push(notesSection(live));replace(host,out);return;}
 out.push(accuracyFigure(history,width-FIG_PAD),milestonesSection(history),shadowFigures(history,width),statusFigure(history,width-FIG_PAD),calibrationFigures(history,width));
 const gateRec=[...recs].reverse().find(r=>r.gates);out.push(gatesSection(gateRec),notesSection(live),historySection(history));
 replace(host,out);}
// Keeps disclosures the reader opened (data tables, history) open across live re-renders.
function replace(host,nodes){const open=new Set(),walk=(n,f)=>{for(const c of [...(n?.children||[])])if(c&&typeof c==='object'){f(c);walk(c,f);}};
 walk(host,n=>{if(n.tagName==='DETAILS'&&n.open&&n.dataset?.key)open.add(n.dataset.key);});host.replaceChildren(...nodes.filter(Boolean));walk(host,n=>{if(n.tagName==='DETAILS'&&open.has(n.dataset?.key))n.open=true;});}
const api={render,records,tiles,accuracySeries,statusSeries,shadowSeries,KINDS};if(typeof module!=='undefined')module.exports=api;root.MetaValidationMetrics=api;
})(typeof window==='undefined'?globalThis:window);
