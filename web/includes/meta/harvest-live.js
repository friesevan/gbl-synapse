/* YouTube harvester · live status (Meta Extractor › Harvest, from /api/harvest/status; scripts/yt-harvest/service.py).
   Shows any run on this work directory, including runs started from a terminal or a script: a health headline
   (blocked by YouTube's bot check, rate limited, stalled, working), the run's settings and deadline, pipeline
   stages, rates and storage, YouTube access, Tornado API usage, active jobs, recent errors and the log.
   The YouTube sign-in panel (/api/harvest/auth) lets yt-dlp use a browser where the owner is signed in to YouTube:
   the owner signs in there, picks the browser, tests it and saves it. The harvester reads cookies locally at
   request time; this page never sees them. Rendered by validation.js serviceShell (the full harvester card). */
(function(root){
'use strict';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const num=v=>Number(v||0).toLocaleString('en-US');
const time=t=>{if(!t)return '—';const d=new Date(t);return isNaN(d)?'—':d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});};
const when=t=>{if(!t)return '—';const d=new Date(t);if(isNaN(d))return '—';const today=new Date().toDateString()===d.toDateString();return today?time(t):d.toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'});};
const ago=t=>{if(!t)return '';const s=(Date.now()-new Date(t))/1000;return !isFinite(s)?'':s<90?'just now':s<5400?Math.round(s/60)+' min ago':Math.round(s/3600)+' h ago';};
const span=s=>{s=Math.max(0,Math.round(s||0));const h=Math.floor(s/3600),m=Math.round(s%3600/60);return h?h+' h '+m+' min':m+' min';};
const SIGN_IN='https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F';
const guessBrowser=()=>{const ua=navigator.userAgent||'';return /Firefox\//.test(ua)?'firefox':/Edg\//.test(ua)?'edge':/OPR\//.test(ua)?'opera':/Brave/.test(ua)?'brave':/Chrome\//.test(ua)?'chrome':/Safari\//.test(ua)?'safari':'chrome';};

function mount(host,ctx){
 const view={ctx,host,auth:null,authBusy:false};
 const banner=el('div',null,'hl-banner'),bannerText=el('p'),bannerAction=el('button','Sign in to YouTube','');bannerAction.type='button';banner.append(bannerText,bannerAction);
 const facts=el('dl',null,'hl-facts'),stages=el('div',null,'hl-stages'),metrics=el('div',null,'hl-metrics');
 const access=el('section',null,'hl-card'),tornado=el('section',null,'hl-card'),jobs=el('section',null,'hl-card'),errors=el('section',null,'hl-card');
 const grid=el('div',null,'hl-grid');grid.append(access,tornado,jobs,errors);
 // Sign-in panel: built once so polling never resets what the owner is typing or choosing.
 const auth=el('details',null,'hl-auth');auth.append(el('summary','YouTube sign-in'));
 const authState=el('p',null,'hl-auth-state'),steps=el('ol',null,'hl-steps');
 const s1=el('li');const open=el('a','Open YouTube sign-in ↗');open.href=SIGN_IN;open.target='_blank';open.rel='noopener';s1.append(el('strong','Sign in to YouTube in a browser on this Mac. '),open,el('span',' Use the browser you will choose below. A secondary Google account is safest: YouTube can restrict accounts used for bulk downloads.','hint'));
 const s2=el('li'),mode=el('select'),browser=el('select'),profile=el('select'),file=el('input');
 for(const [v,l] of [['browser','A browser I am signed in with'],['file','A cookies.txt file (Netscape format)']]){const o=el('option',l);o.value=v;mode.append(o);}
 mode.setAttribute('aria-label','Where the harvester reads the YouTube sign-in');browser.setAttribute('aria-label','Browser');profile.setAttribute('aria-label','Browser profile');file.type='text';file.placeholder='/Users/you/youtube-cookies.txt';file.setAttribute('aria-label','Cookies file path');
 const browserRow=el('div',null,'hl-auth-row'),fileRow=el('div',null,'hl-auth-row'),note=el('p',null,'hint');
 const bl=el('label','Browser ');bl.append(browser);const pl=el('label','Profile ');pl.append(profile);browserRow.append(bl,pl);const fl=el('label','File ');fl.append(file);fileRow.append(fl);
 s2.append(el('strong','Choose where the harvester reads the sign-in. '),mode,browserRow,fileRow,note);
 const s3=el('li'),testBtn=el('button','Test','secondary'),useBtn=el('button','Test and use for harvesting'),offBtn=el('button','Turn off sign-in','secondary'),result=el('p',null,'hl-auth-result');
 testBtn.type=useBtn.type=offBtn.type='button';const actions=el('div',null,'meta-actions');actions.append(testBtn,useBtn,offBtn);
 s3.append(el('strong','Test it, then use it. '),el('span','The test asks YouTube for a blocked video’s formats with this sign-in (nothing is downloaded). A running harvester picks up the new sign-in within 15 seconds and ends its pause.','hint'),actions,result);
 steps.append(s1,s2,s3);auth.append(authState,steps,el('p','Cookies stay on this computer: yt-dlp reads them from the browser when it contacts YouTube. This page and the harvester’s files store only which browser or file to use.','hint'));
 const logBox=el('details',null,'meta-harvest-log'),logHead=el('summary','Recent activity'),warnOnly=el('input'),logPre=el('pre');warnOnly.type='checkbox';const wl=el('label',' Problems only');wl.prepend(warnOnly);logBox.append(logHead,wl,logPre);
 host.replaceChildren(banner,facts,stages,metrics,grid,auth,logBox);
 Object.assign(view,{banner,bannerText,bannerAction,facts,stages,metrics,access,tornado,jobs,errors,authEl:auth,authState,mode,browser,profile,file,browserRow,fileRow,note,testBtn,useBtn,offBtn,result,warnOnly,logPre});
 bannerAction.onclick=()=>{auth.open=true;loadAuth(view);auth.scrollIntoView({behavior:'smooth',block:'start'});};
 auth.addEventListener('toggle',()=>{if(auth.open)loadAuth(view);});
 mode.onchange=()=>syncForm(view);browser.onchange=()=>{view.profileTouched=false;fillProfiles(view);syncForm(view);};profile.onchange=()=>{view.profileTouched=true;};
 testBtn.onclick=()=>runAuth(view,false);useBtn.onclick=()=>runAuth(view,true);
 offBtn.onclick=async()=>{setBusy(view,true);try{view.auth=await ctx.api('/api/harvest/auth',{mode:'none'});result.textContent='Sign-in turned off. Downloads go out anonymously again.';result.className='hl-auth-result';renderAuth(view);ctx.refresh?.();}catch(e){result.textContent=e.message;}setBusy(view,false);};
 warnOnly.onchange=()=>renderLog(view);
 return view;
}
async function loadAuth(view,force){if(view.auth&&!force)return;try{view.auth=await view.ctx.api('/api/harvest/auth');renderAuth(view);}catch(e){view.authState.textContent='The sign-in settings need the local app (python3 web/run_app.py): '+e.message;}}
function renderAuth(view){
 const a=view.auth;if(!a)return;const c=a.config||{};view.authState.textContent='Current: '+(c.label||'Not signed in')+(c.savedAt?' · saved '+when(c.savedAt):'')+'.';view.authState.className='hl-auth-state '+(c.mode&&c.mode!=='none'?'hl-good':'');
 const keep=view.browser.value;view.browser.replaceChildren(...(a.browsers||[]).map(b=>{const o=el('option',b.label);o.value=b.id;return o;}));
 const want=keep||(c.mode==='browser'?c.browser:guessBrowser());if([...view.browser.options].some(o=>o.value===want))view.browser.value=want;
 if(c.mode==='file'&&!view.file.value){view.mode.value='file';view.file.value=c.cookieFile||'';}
 fillProfiles(view,c.mode==='browser'&&c.browser===view.browser.value&&!view.profileTouched?(c.profile||''):null);view.browserRow.hidden=view.mode.value!=='browser';view.fileRow.hidden=view.mode.value!=='file';
}
function fillProfiles(view,chosen){
 const b=(view.auth?.browsers||[]).find(x=>x.id===view.browser.value),keep=chosen??(view.profileTouched?view.profile.value:null);const def=el('option',"The browser's default profile");def.value='';
 view.profile.replaceChildren(def,...(b?.profiles||[]).map(p=>{const o=el('option',p.label);o.value=p.path;return o;}));
 // Profiles are listed most recently used first: that one is preselected until the owner picks another.
 if(keep!=null&&[...view.profile.options].some(o=>o.value===keep))view.profile.value=keep;else if(b?.profiles?.length)view.profile.value=b.profiles[0].path;else view.profile.value='';
 view.note.textContent=b?.note||'';
}
function syncForm(view){view.browserRow.hidden=view.mode.value!=='browser';view.fileRow.hidden=view.mode.value!=='file';if(view.mode.value!=='browser')view.note.textContent='Export cookies from a signed-in YouTube tab with a cookies.txt extension; the file must stay private.';else fillProfiles(view);}
function formConfig(view){return view.mode.value==='file'?{mode:'file',cookieFile:view.file.value.trim()}:{mode:'browser',browser:view.browser.value,profile:view.profile.value||null};}
function setBusy(view,busy){view.authBusy=busy;for(const b of [view.testBtn,view.useBtn,view.offBtn])b.disabled=busy;}
async function runAuth(view,use){
 const config=formConfig(view);setBusy(view,true);view.result.className='hl-auth-result';view.result.textContent='Testing with YouTube… macOS may ask for keychain access to the browser’s cookies: choose Always Allow.';
 try{const t=await view.ctx.api('/api/harvest/auth/test',{config});
  const ok=t.ok&&!/no YouTube cookies/.test(t.message||'');view.result.className='hl-auth-result '+(ok?'hl-good':'hl-bad');
  const hint=t.kind==='bot-check'?' YouTube still asks for sign-in: make sure you are signed in to YouTube in that browser profile, then test again.':t.kind==='cookies'?' The cookies could not be read. Allow keychain access, close the browser if it locks its cookie store, or choose another profile.':'';
  view.result.textContent=(t.ok?'✓ ':'✗ ')+(t.message||'')+hint+(t.title?' Tested on “'+t.title+'”.':'');
  if(use&&t.ok){view.auth=await view.ctx.api('/api/harvest/auth',config);renderAuth(view);view.result.textContent+=' Saved: the harvester uses this sign-in from its next request.';view.ctx.refresh?.();}
  else if(use)view.result.textContent+=' Not saved.';
 }catch(e){view.result.className='hl-auth-result hl-bad';view.result.textContent=e.message;}
 setBusy(view,false);
}
function fact(dl,label,value,title){const pair=el('div'),dt=el('dt',label),dd=el('dd',value);if(title)dd.title=title;pair.append(dt,dd);dl.append(pair);}
function card(box,title,rows){box.replaceChildren(el('h4',title));for(const r of rows)if(r)box.append(typeof r==='string'?el('p',r):r);box.hidden=rows.filter(Boolean).length===0;}
function bar(label,done,total,extra){const row=el('div',null,'hl-stage'),head=el('div',null,'hl-stage-head');head.append(el('strong',label),el('span',extra||''));const track=el('div',null,'hl-track'),fill=el('div',null,'hl-fill');fill.style.width=(total?Math.min(100,100*done/total):0)+'%';track.append(fill);row.append(head,track);return row;}
function renderLog(view){const lines=view.lines||[];const show=view.warnOnly.checked?lines.filter(l=>/WARNING|ERROR|rate limited|failed|blocked|sign.?in|paused|Traceback|Exception/i.test(l)):lines;view.logPre.textContent=show.slice(-80).join('\n')||(view.warnOnly.checked?'No problems in the recent log.':'');}
function update(view,h){
 h=h||{};const run=h.run,yt=h.youtube||{},health=h.health||{level:'idle',message:''},s=h.summary||{},total=s.total||{},st=h.stages||{},active=!!h.running;
 view.banner.className='hl-banner hl-'+(health.level||'idle');view.bannerText.textContent=health.message||'';view.bannerAction.hidden=health.action!=='signin';view.banner.hidden=!health.message;
 // Run facts
 view.facts.replaceChildren();
 if(run){fact(view.facts,'Started',when(run.startedAt)+(run.origin?' · from '+(run.origin==='app'?'this page':'the command line'):''),run.command);
  const left=run.deadline?(new Date(run.deadline)-Date.now())/1000:null;fact(view.facts,'Ends',run.deadline?when(run.deadline)+(left>0?' · '+span(left)+' left':''):'—');
  fact(view.facts,'Focus',run.focusCup?run.focusCup+(run.focusSince?' since '+run.focusSince:'')+(run.focusOnly?' (only)':' first'):'All cups');
  fact(view.facts,'Workers',(run.extractJobs||'auto')+' analysis'+(run.downloadWorkers?' · '+run.downloadWorkers+' download':''));
  fact(view.facts,'Download pace',(yt.downloadsPerMin!=null?Number(yt.downloadsPerMin).toFixed(1)+'/min now · ':'')+'cap '+(run.downloadsPerMinCap??'—')+'/min');
  fact(view.facts,'Metadata',(yt.metadataSource==='api'?'YouTube Data API':yt.metadataSource==='web'?'Web player':'—')+(yt.metadataPerMin!=null?' · '+Number(yt.metadataPerMin).toFixed(0)+'/min':''));
  fact(view.facts,'Process','PID '+run.pid+(h.duplicateProcesses?' · several harvesters on this folder!':''));
 }else if(h.endedAt||h.phase)fact(view.facts,'Last run',(h.phase||'idle')+(h.endedAt?' · ended '+when(h.endedAt):''));
 if(s.updated)fact(view.facts,'Last report',ago(s.updated)||when(s.updated));
 // Pipeline stages (whole database) with this run's progress.
 const tr=h.thisRun||{},dl=st.download||{},x=st.extraction||{},meta=st.metadata||{},allowed=total.allowed||0;
 view.stages.replaceChildren(el('h4','Pipeline'),
  bar('Discovered',total.videos||st.discovered||0,total.videos||st.discovered||0,num(total.videos||st.discovered)+' videos'+(active&&tr.flatNew!=null?' · +'+num(tr.flatNew)+' this run':'')+(total.queriesPlanned?' · '+num(total.queriesDone)+'/'+num(total.queriesPlanned)+' searches':'')),
  bar('Metadata',meta.done||total.enriched||0,(st.discovered||total.videos||0),num(meta.done||total.enriched)+' read'+(total.relevant?' · '+num(total.relevant)+' relevant':'')+(meta.working?' · '+meta.working+' working':'')+(active&&tr.enriched!=null?' · +'+num(tr.enriched)+' this run':'')),
  bar('Downloaded',(dl.done||0)+(dl.prior||0),allowed||(dl.done||0),num(dl.done)+' on file of '+num(allowed)+' wanted'+(dl.working?' · '+dl.working+' downloading':'')+(dl.tornado?' · '+dl.tornado+' via Tornado':'')+(dl.error?' · '+num(dl.error)+' failed':'')+(active&&tr.downloaded!=null?' · +'+num(tr.downloaded)+' this run':'')),
  bar('Analysed',x.done||0,(dl.done||0)+(dl.prior||0),num(x.done)+' analysed'+(x.working?' · '+x.working+' running':'')+(x.reworking?' · '+x.reworking+' re-analysing':'')+(x.failed?' · '+x.failed+' failed':'')+(active&&tr.extracted!=null?' · +'+num(tr.extracted)+' this run':'')),
  el('p',num(h.counts?.questions)+' detections waiting in Validate'+(total.backlogHours!=null?' · '+Number(total.backlogHours).toFixed(1)+' h of video queued for analysis':''),'hint'));
 // Rates and storage
 const r=s.ratesPerMin||{},m=[];if(active){if(r.newVideos!=null)m.push([Number(r.newVideos).toFixed(1),'new videos / min']);if(r.metadata!=null)m.push([Number(r.metadata).toFixed(1),'metadata / min']);if(s.downloadMBps!=null)m.push([Number(s.downloadMBps).toFixed(1),'MB/s while downloading']);if(tr.xVideoS&&tr.xBusyS)m.push([(tr.xVideoS/Math.max(1,tr.xBusyS)).toFixed(1)+'×','analysis speed (video s per busy s)']);}
 if(total.onDiskGB!=null)m.push([Number(total.onDiskGB).toFixed(0)+' GB',(run?.diskBudgetGB?'of '+run.diskBudgetGB+' GB budget':'video on disk')]);if(s.retention?.tierA)m.push([num(s.retention.tierA.count+(s.retention.tierB?.count||0)),'videos kept']);
 view.metrics.replaceChildren(...m.map(([v,l])=>{const d=el('div');d.append(el('strong',v),el('span',l));return d;}));view.metrics.hidden=!m.length;
 // YouTube access
 const hour=yt.downloadsLastHour||{},blk=yt.lastBlock,cfg=yt.config||{};
 card(view.access,'YouTube access',[
  el('p',(cfg.label||'Not signed in')+(cfg.mode&&cfg.mode!=='none'&&yt.signInApplies===false&&active?' (saved; this run started before sign-in support, so restart it to use it)':''),cfg.mode&&cfg.mode!=='none'?'hl-good':''),
  yt.pausedUntil?el('p','Paused until '+time(yt.pausedUntil)+' · '+span(yt.pauseLeftSeconds)+' left','hl-bad'):null,
  blk?el('p','Last block '+when(blk.at)+': '+(blk.kind==='bot-check'?'bot check (sign-in requested)':'rate limit')+' on '+blk.what+(blk.pauseSeconds?' · paused '+span(blk.pauseSeconds):'')):null,
  (yt.blocks!=null&&run)?el('p',num(yt.blocks)+' block'+(yt.blocks===1?'':'s')+' this run'+(yt.botChecks?' ('+num(yt.botChecks)+' bot checks)':'')):null,
  el('p','Last hour: '+num(hour.success)+' downloaded · '+num(hour.block)+' blocked'+(hour.failed?' · '+num(hour.failed)+' failed':'')+(hour.unavailable?' · '+num(hour.unavailable)+' unavailable':'')),
  el('p','Last successful download: '+(yt.lastDownload?when(yt.lastDownload.at)+(yt.lastDownload.title?' · '+yt.lastDownload.title:yt.lastDownload.id?' · '+yt.lastDownload.id:'')+(yt.lastDownload.mb?' · '+num(yt.lastDownload.mb)+' MB':''):'none this run')),
  yt.source==='log'&&active?el('p','Read from the harvester’s log (it started before live reporting).','hint'):null]);
 // Tornado API
 const t=h.tornado;card(view.tornado,'Tornado API downloads',t?[el('p',Number(t.usedGB).toFixed(1)+' of '+t.capGB+' GB used · '+num(t.videos)+' videos'),(()=>{const track=el('div',null,'hl-track'),fill=el('div',null,'hl-fill');fill.style.width=Math.min(100,100*t.usedGB/Math.max(1,t.capGB))+'%';track.append(fill);return track;})(),el('p',t.running?'Fetch loop running':'Not running',t.running?'hl-good':''),t.last?el('p',t.last,'hint'):null]:[]);
 // Active jobs
 const j=h.activeJobs||h.jobs||[];card(view.jobs,'Working now · '+j.length,j.length?[(()=>{const ul=el('ul',null,'hl-jobs');for(const job of j.slice(0,12)){const stage=job.dl_status==='working'?'download':job.x_status==='working'?'analysis':job.meta_status==='working'?'metadata':'';const li=el('li');li.append(el('span',stage,'hl-tag hl-tag-'+stage),el('span',job.title||job.id));li.title=job.id||'';ul.append(li);}return ul;})()]:[el('p',active?'Waiting for work (paused, rate-limited or between searches).':'Nothing running.','hint')]);
 // Errors
 const errs=(h.errors||[]).filter(e=>e.error);const kindLabel={unavailable:'unavailable','bot-check':'bot check','rate-limit':'rate limit',other:'error'};
 card(view.errors,'Recent problems',errs.length?[(()=>{const ul=el('ul',null,'hl-jobs hl-problems');for(const e of errs.slice(0,8)){const li=el('li');li.append(el('span',kindLabel[e.kind]||'error','hl-tag hl-tag-'+(e.kind||'other')),el('span',(e.title||e.id||'')+(e.error?' — '+e.error.replace(/^\w+: /,'').replace(/ERROR: \[youtube\] [\w-]+: /,'').slice(0,160):'')));ul.append(li);}return ul;})(),el('p',num(total.downloadErrors)+' download and '+num(total.metaErrors)+' metadata failures in total. Unavailable videos (private, members-only, removed) are expected and skipped.','hint')]:[el('p','No recent problems.','hint')]);
 view.lines=h.log||[];renderLog(view);
 if(view.authEl.open&&!view.authBusy&&!view.auth)loadAuth(view);
}
root.HarvestLive={mount,update,parseHelpers:{span,ago}};
})(typeof window==='undefined'?globalThis:window);
