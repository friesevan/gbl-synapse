/* Meta Extractor › Analyze & review › Re-analysis (from /api/reanalyze/*; scripts/yt-harvest/reanalyze.py).
   Analyses videos again with the current Meta Extractor, in its own process, apart from the YouTube harvester: queue
   videos (ids or URLs), start, follow each video's progress, stop safely or at once. Every video keeps its earlier
   result until the new one replaces it. Rendered by validation.js serviceShell under the harvester card. */
(function(root){
'use strict';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const num=v=>Number(v||0).toLocaleString('en-US');
const span=s=>{s=Math.max(0,Math.round(s||0));if(s<60)return s+' s';const h=Math.floor(s/3600),m=Math.round(s%3600/60);return h?h+' h '+m+' min':m+' min';};
const clock=t=>{const d=new Date(typeof t==='number'&&t<1e12?t*1000:t);return isNaN(d)?'':d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});};
const STATE={ready:['ready','On disk, waiting for a worker'],running:['analysing','Being analysed now'],waitingDownload:['needs download','Not on disk: the harvester downloads it first, or Tornado if ticked'],downloading:['downloading','Being downloaded']};
const OUTCOME={ok:['✓','Replaced'],failed:['✗','Failed; the earlier result is kept'],interrupted:['⏸','Stopped; still queued'],needsDownload:['⬇','The file was gone; queued for a download']};
const WHY=[
 ['When the Meta Extractor improves.','A fix to how frames are read (names, moves, results, Shadow flames) only reaches videos analysed after it. Saved results keep what the old code read until they are analysed again. Fixes to the learned models (fast-move and Shadow priors, refitted from your Validate answers) need no re-analysis: they are applied to the saved measurements.'],
 ['When Validate shows a video was read wrongly.','“Battles are shown” on a video with none found, a different championship screen, or a crop that missed the phone: those requests are queued here automatically.'],
 ['When an analysis was interrupted or failed.','A stopped analysis stays queued. A failed one keeps the earlier result.'],
];
const SPEED='Auto (fastest safe): when the reason doesn’t question where the battles are, only the stretches around the battles found last time are decoded, with the same phone screen and nameplate language. That skips the screen search and the second pass for late language detection, often half the time or less. “Whole video” decodes everything, as the first analysis did.';

function mount(host,ctx){
 const v={ctx,host,data:null,busy:false,timer:null};
 const head=el('div',null,'ra-head');head.append(el('h3','Re-analysis'));
 const intro=el('p','Analyse videos again with the current Meta Extractor, separately from the harvester. Each video keeps its earlier result until the new one replaces it.','meta-demo-note');
 const banner=el('p',null,'ra-status');banner.setAttribute('role','status');
 const counts=el('div',null,'hl-metrics ra-counts');
 const controls=el('div',null,'meta-actions ra-controls');
 const queueBtn=el('button','Queue videos…','secondary'),startBtn=el('button','Start re-analysis'),stopBtn=el('button','Stop safely','secondary'),abortBtn=el('button','Stop now','secondary');
 for(const b of [queueBtn,startBtn,stopBtn,abortBtn])b.type='button';
 const jobs=el('input');jobs.type='number';jobs.min='1';jobs.max='16';jobs.step='1';jobs.setAttribute('aria-label','Parallel analyses');const jl=el('label','Workers ');jl.append(jobs);
 const fetch=el('input');fetch.type='checkbox';const fl=el('label',null,'ra-check');const fetchText=el('span',' Download missing videos through Tornado');fl.append(fetch,fetchText);
 controls.append(queueBtn,jl,fl,startBtn,stopBtn,abortBtn);
 // Queue form (built once; polling never resets what the owner is typing).
 const form=el('form',null,'ra-form');form.hidden=true;
 const ids=el('textarea');ids.rows=4;ids.placeholder='Video ids or YouTube links, one per line or separated by commas';ids.setAttribute('aria-label','Videos to analyse again');
 const reason=el('select');reason.setAttribute('aria-label','Why these videos need re-analysis');
 const scope=el('select');scope.setAttribute('aria-label','How much of each video to analyse');
 for(const [val,label] of [['auto','Auto: battles found last time (fastest)'],['full','Whole video']]){const o=el('option',label);o.value=val;scope.append(o);}
 const rl=el('label','Reason ');rl.append(reason);const sl=el('label','Analyse ');sl.append(scope);
 const add=el('button','Add to queue'),cancel=el('button','Cancel','secondary');add.type='submit';cancel.type='button';
 const formActions=el('div',null,'meta-actions');formActions.append(rl,sl,add,cancel);
 const formResult=el('p',null,'hint');formResult.setAttribute('role','status');
 form.append(ids,formActions,el('p',SPEED,'hint'),formResult);
 const hint=el('p',null,'hint ra-hint');
 const overall=el('div',null,'hl-stages ra-overall');
 const active=el('section',null,'hl-card ra-active'),recent=el('section',null,'hl-card ra-recent');
 const grid=el('div',null,'hl-grid');grid.append(active,recent);
 const queued=el('details',null,'meta-advanced ra-queue');const qsum=el('summary','Queued videos');const qlist=el('ul',null,'hl-jobs');const clear=el('button','Remove waiting videos from the queue','secondary');clear.type='button';queued.append(qsum,qlist,clear);
 const why=el('details',null,'meta-advanced ra-why');why.append(el('summary','When and why videos need re-analysis'));for(const [t,d] of WHY){const p=el('p');p.append(el('strong',t+' '),document.createTextNode(d));why.append(p);}why.append(el('p',SPEED,'hint'));
 const logBox=el('details',null,'meta-harvest-log');const logPre=el('pre');logBox.append(el('summary','Re-analysis log'),logPre);
 host.classList.add('ra');host.replaceChildren(head,intro,banner,counts,controls,form,hint,overall,grid,queued,why,logBox);
 Object.assign(v,{banner,counts,queueBtn,startBtn,stopBtn,abortBtn,jobs,fetch,fetchText,form,ids,reason,scope,formResult,hint,overall,active,recent,queued,qsum,qlist,clear,logPre});
 queueBtn.onclick=()=>{form.hidden=!form.hidden;if(!form.hidden)ids.focus();};
 cancel.onclick=()=>{form.hidden=true;};
 form.onsubmit=async e=>{e.preventDefault();if(!ids.value.trim()){formResult.textContent='Paste at least one video id or link.';return;}
  add.disabled=true;formResult.textContent='Queuing…';
  try{const d=await ctx.api('/api/reanalyze/queue',{ids:ids.value,reason:reason.value,scope:scope.value});const q=d.queued||{};
   const parts=[num(q.queued)+' queued'];if(q.onDisk)parts.push(num(q.onDisk)+' on disk');if(q.needDownload)parts.push(num(q.needDownload)+' need a download');if(q.busy)parts.push(num(q.busy)+' busy right now (queued anyway)');
   if(q.unknown)parts.push(num(q.unknown)+' not in the harvest ('+(d.queuedIds?.unknown||[]).slice(0,5).join(', ')+((q.unknown||0)>5?'…':'')+')');if(q.obscured)parts.push(num(q.obscured)+' skipped: marked obscured in Validate');
   formResult.textContent=parts.join(' · ')+'.';if(q.queued)ids.value='';render(v,d.reanalyze);}
  catch(err){formResult.textContent=err.message;}add.disabled=false;};
 startBtn.onclick=()=>act(v,'/api/reanalyze/start',{jobs:Number(jobs.value),fetchMissing:fetch.checked});
 stopBtn.onclick=()=>act(v,'/api/reanalyze/stop',{});
 abortBtn.onclick=()=>{if(confirm('Stop the videos being analysed now? Their earlier results stay, and they stay queued.'))act(v,'/api/reanalyze/stop',{now:true});};
 clear.onclick=async()=>{const waiting=(v.data?.queue?.items||[]).filter(i=>i.state==='ready'||i.state==='waitingDownload').map(i=>i.id);if(!waiting.length)return;
  if(!confirm('Remove '+waiting.length+' waiting videos from the re-analysis queue? Their earlier results stay.'))return;act(v,'/api/reanalyze/remove',{ids:waiting});};
 poll(v);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll(v);});
 return v;
}
async function act(v,path,body){v.busy=true;sync(v);try{const d=await v.ctx.api(path,body);render(v,d.reanalyze);}catch(e){v.banner.textContent=e.message;v.banner.className='ra-status hl-bad';}v.busy=false;sync(v);}
async function poll(v){clearTimeout(v.timer);if(!v.host.isConnected&&v.data)return;
 if(!document.hidden){try{const d=await v.ctx.api('/api/reanalyze/status');render(v,d.reanalyze);}catch(e){v.data=null;v.banner.textContent='Re-analysis needs the local app (python3 web/run_app.py).';v.banner.className='ra-status';sync(v);}}
 v.timer=setTimeout(()=>poll(v),v.data?.running?3000:8000);}
function sync(v){const d=v.data,on=!!d,running=!!d?.running;
 v.startBtn.disabled=!on||running||v.busy||!(d?.queue?.total);v.stopBtn.disabled=!on||!running||v.busy||d?.stopRequested;v.abortBtn.disabled=!on||!running||v.busy||d?.abortRequested;
 v.queueBtn.disabled=!on;v.jobs.disabled=v.fetch.disabled=running;}
function bar(fraction){const track=el('div',null,'hl-track'),fill=el('div',null,'hl-fill');fill.style.width=Math.max(0,Math.min(100,(fraction||0)*100)).toFixed(1)+'%';track.append(fill);return track;}
function render(v,d){
 if(!d)return;const first=!v.data;v.data=d;const q=d.queue||{},s=d.summary||{},fin=s.finished||{},running=!!d.running;
 if(first){v.jobs.value=String(d.run?.jobs||d.defaultJobs||4);v.reason.replaceChildren(...Object.entries(d.reasons||{}).map(([k,l])=>{const o=el('option',l);o.value=k;return o;}));}
 const t=d.tornado;v.fetchText.textContent=' Download missing videos through Tornado'+(t?' ('+Number(t.usedGB).toFixed(0)+' of '+t.capGB+' GB used)':'');
 // Headline
 const phase=d.phase||'idle',stopping=d.stopRequested;
 v.banner.className='ra-status '+(running?'hl-good':'');
 v.banner.textContent=running?(d.abortRequested?'Stopping now: the videos being analysed end and keep their earlier results.':stopping?'Stopping safely: finishing the videos being analysed.':'Re-analysing'+(s.fetching?' · downloading missing videos through Tornado':'')+(s.etaSeconds?' · about '+span(s.etaSeconds)+' left for the videos on disk':'')+'.')
  :phase==='finished'&&s.updated?'Last run finished at '+clock(s.updated)+': '+num(fin.ok)+' replaced, '+num(fin.failed)+' failed'+(fin.interrupted?', '+num(fin.interrupted)+' stopped':'')+'.'
  :phase==='interrupted'?'The last run ended unexpectedly; its videos are still queued.':q.total?'Ready to start.':'Nothing queued.';
 // Counts
 const c=[[num(q.total),'queued'],[num(q.ready),'on disk'],[num(q.waitingDownload),'need a download'],[num((q.running||0)+(q.downloading||0)),'in progress']];if(running||fin.ok||fin.failed)c.push([num(fin.ok),'replaced this run']);
 v.counts.replaceChildren(...c.map(([n,l])=>{const x=el('div');x.append(el('strong',n),el('span',l));return x;}));
 // Hint about videos that need a download
 v.hint.textContent=q.waitingDownload?(num(q.waitingDownload)+' queued video'+(q.waitingDownload===1?' is':'s are')+' not on disk. '+(running&&s.fetchMissing==='tornado'?'Tornado downloads them as it goes.':d.harvesterRunning?'The harvester downloads them first (YouTube permitting); they are analysed here once they arrive.':'Tick “Download missing videos through Tornado”, or start the harvester, which downloads queued videos first.')):'';
 v.hint.hidden=!v.hint.textContent;
 // Overall progress (this run)
 v.overall.replaceChildren();
 if(running||s.active?.length){const done=(fin.ok||0)+(fin.failed||0),total=done+(q.total||0);const head=el('div',null,'hl-stage-head');
  head.append(el('strong','This run'),el('span',num(done)+' of '+num(total)+' done · '+(s.workersBusy||0)+' of '+(s.jobs||0)+' workers busy · '+Number(s.realtimePerWorker||0).toFixed(1)+'× real time per worker'+(s.etaSeconds?' · about '+span(s.etaSeconds)+' left':'')));
  const row=el('div',null,'hl-stage');row.append(head,bar(total?done/total:0));v.overall.append(row);}
 v.overall.hidden=!v.overall.childNodes.length;
 // Active videos
 const act=s.active||[];v.active.replaceChildren(el('h4','Analysing now · '+act.length));
 if(act.length){const ul=el('ul',null,'hl-jobs ra-jobs');for(const j of act){const li=el('li');const top=el('div',null,'ra-job-head');
   top.append(el('span',j.mode==='battles only'?'battles':'whole','hl-tag hl-tag-analysis'),el('span',j.title||j.id,'ra-title'));
   const planned=j.plannedSeconds||j.videoSeconds||0;
   li.append(top,bar(j.fraction),el('small',(j.doneSeconds!=null?span(j.doneSeconds)+' of '+span(planned)+' of video':span(planned)+' of video')+(j.etaSeconds!=null?' · about '+span(j.etaSeconds)+' left':'')+(j.language?' · nameplates '+j.language:'')+' · started '+clock(j.startedAt)));ul.append(li);}
  v.active.append(ul);}else v.active.append(el('p',running?'Waiting for videos on disk.':'Not running.','hint'));
 // Recent outcomes
 const rec=s.recent||[];v.recent.replaceChildren(el('h4','Finished · '+num((fin.ok||0)+(fin.failed||0))));
 if(rec.length){const ul=el('ul',null,'hl-jobs ra-done');for(const r of rec.slice(0,12)){const [mark,label]=OUTCOME[r.outcome]||['•',r.outcome];const li=el('li');
   li.append(el('span',mark,'ra-mark ra-'+r.outcome),el('span',r.title||r.id,'ra-title'),el('small',(r.outcome==='ok'?(r.change?.summary||'no change'):label+(r.error?': '+r.error:''))+' · '+span(r.seconds)+(r.mode?' · '+r.mode:'')));
   li.title=label;ul.append(li);}v.recent.append(ul);}else v.recent.append(el('p','Nothing finished in this run yet.','hint'));
 // Queue list
 const items=q.items||[];v.qsum.textContent='Queued videos · '+num(q.total)+(q.total>items.length?' (first '+num(items.length)+' shown)':'');
 v.qlist.replaceChildren(...items.map(i=>{const li=el('li');const [tag,tip]=STATE[i.state]||[i.state,''];const t=el('span',tag,'hl-tag '+(i.state==='waitingDownload'?'hl-tag-download':i.state==='running'?'hl-tag-analysis':''));t.title=tip;
  const a=el('a',i.title||i.id);a.href='https://www.youtube.com/watch?v='+encodeURIComponent(i.id);a.target='_blank';a.rel='noopener';
  li.append(t,a,el('small',' '+((d.reasons||{})[i.reason]||i.reason)+(i.scope==='full'?' · whole video':'')+(i.duration?' · '+span(i.duration):'')));return li;}));
 v.queued.hidden=!q.total;v.clear.hidden=!items.some(i=>i.state==='ready'||i.state==='waitingDownload');
 v.logPre.textContent=(d.log||[]).slice(-40).join('\n')||'No re-analysis runs yet.';
 sync(v);
}
root.Reanalyze={mount,render,helpers:{span}};
})(typeof window==='undefined'?globalThis:window);
