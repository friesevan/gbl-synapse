// Validation queue for the Meta Extractor. Questions that need a person (from Claude's test runs or
// from your own analyses) live in the artifact's shared store with their evidence frames, so they can
// be answered without the video. Answers are saved beside them, scored against the model, and turned
// into learned priors for the next analysis (MetaQuestions.learnedFromAnswers).
// Store: validation/<id> = question, answers/<id> = answer. Outside claude.ai, this browser's storage.
(function(){
'use strict';
const $=id=>document.getElementById(id),Q=window.MetaQuestions;
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const LOCAL='pvp-meta-validation-v1';
const state={files:new Map(),player:null,db:null,userId:null,questions:new Map(),answers:new Map(),analyses:new Map(),showing:null,filter:'open',source:'all',current:null,skipped:new Set(),ready:false,writeError:''};
const safeId=s=>String(s).replace(/[^A-Za-z0-9_\-.~:@+]/g,'-').slice(0,200);
// ---- storage ----
function loadLocal(){try{const d=JSON.parse(localStorage.getItem(LOCAL)||'{}');for(const q of d.questions||[])state.questions.set(q.qid,q);for(const a of d.answers||[])state.answers.set(a.qid,a);for(const x of d.analyses||[])state.analyses.set(x.aid,x);}catch(e){}}
function saveLocal(){try{localStorage.setItem(LOCAL,JSON.stringify({questions:[...state.questions.values()].filter(q=>!q._inbox),answers:[...state.answers.values()],analyses:[...state.analyses.values()]}));}catch(e){state.writeError='This browser could not save answers (storage full or blocked).';}}
async function putQuestion(doc){state.questions.set(doc.qid,doc);if(state.db){try{await state.db.doc('validation/'+safeId(doc.qid)).set(doc);}catch(e){state.writeError=writeMessage(e);}}else saveLocal();}
async function putAnswer(doc){state.answers.set(doc.qid,doc);if(state.db){try{await state.db.doc('answers/'+safeId(doc.qid)).set(doc);}catch(e){state.writeError=writeMessage(e);}}else saveLocal();render();}
const writeMessage=e=>e?.code==='invalid_argument'?'Your access to this page is view-only, so answers can’t be saved here.':e?.code==='quota_exceeded'?'The validation store is full. Ask the owner to clear answered questions.':'The answer could not be saved right now. Try again in a moment.';
// ---- harvested questions (scripts/yt-harvest) ----
// When the site runs locally (run_app.py), the overnight harvester's open questions are read from this
// file (git-ignored) and shown without being copied into storage. Elsewhere, Import adds them.
const INBOX='tests/meta-benchmark/results/validation-inbox.json';
async function loadInbox(){if(location.protocol==='file:')return;try{const r=await fetch(INBOX,{cache:'no-store'});if(!r.ok)return;const d=await r.json();let added=0;
 for(const q of d.questions||[])if(q&&q.qid&&!state.questions.has(q.qid)){state.questions.set(q.qid,{...q,_inbox:true});added++;}if(added)render();}catch(e){}}
function importButton(){const lab=el('label',undefined,'meta-v-open secondary'),inp=el('input');inp.type='file';inp.accept='.json,application/json';inp.className='meta-hidden';
 inp.onchange=async()=>{const f=inp.files[0];if(!f)return;try{const d=JSON.parse(await f.text()),list=Array.isArray(d)?d:(d.questions||[]);let n=0;
  for(const q of list)if(q&&q.qid&&(!state.questions.has(q.qid)||state.questions.get(q.qid)._inbox)){const {_inbox,...doc}=q;await putQuestion(doc);n++;}
  state.writeError=state.writeError||(n?'':'No new questions in that file.');}catch(e){state.writeError='That file isn’t a question list (validation-inbox.json).';}inp.value='';render();};
 lab.append(el('span','Import questions…'),inp);return lab;}
function downloadAnswers(){const answers=[...state.answers.values()].map(a=>{const q=state.questions.get(a.qid);return {...a,question:q?{kind:q.kind,title:q.title,battle:q.battle,recording:q.recording,video:q.video||null,clip:q.clip,modelTop:q.modelTop??null}:null};});
 const blob=new Blob([JSON.stringify({format:'meta-validation-answers',version:1,exported:new Date().toISOString(),answers},null,1)],{type:'application/json'}),a=el('a');a.href=URL.createObjectURL(blob);a.download='validation-answers.json';document.body.append(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},0);}
async function connect(){const use=window.claude?.use;state.db=use?await use('db').catch(()=>null):null;if(use){const u=await use('user').catch(()=>null);state.userId=u?await u.id().catch(()=>null):null;}
 if(!state.db){loadLocal();state.ready=true;render();await loadInbox();setInterval(loadInbox,300000);return;}
 state.db.collection('validation').limit(1000).onSnapshot(s=>{state.questions=new Map(s.docs.map(d=>[d.data().qid,d.data()]));state.ready=true;render();},()=>{state.ready=true;render();});
 state.db.collection('answers').limit(1000).onSnapshot(s=>{state.answers=new Map(s.docs.map(d=>[d.data().qid,d.data()]));render();},()=>{});
 state.db.collection('analyses').limit(500).onSnapshot(s=>{state.analyses=new Map(s.docs.map(d=>[d.data().aid,d.data()]));render();},()=>{});}
async function putAnalysis(doc){state.analyses.set(doc.aid,doc);if(state.db){try{await state.db.doc('analyses/'+safeId(doc.aid)).set(doc);}catch(e){state.writeError=writeMessage(e);}}else saveLocal();}
// ---- public API used by ui.js ----
// Stored questions are keyed by qid; the shared helpers expect id.
const asQuestions=()=>[...state.questions.values()].map(q=>({...q,id:q.qid}));
function learned(){return Q.learnedFromAnswers(asQuestions(),state.answers);}
// Saves a question answered in the analysis review (your own video) together with its evidence frames.
async function record(q,value,{recording,frames=[],frameTimes=[]}={}){const qid=safeId(`browser:${recording||'video'}:${q.id}`);const label=q.options?.find(o=>o.value===value)?.label||(value===null?'Not sure':String(value));
 if(!state.questions.has(qid))await putQuestion({qid,source:'browser',recording:recording||'',createdAt:new Date().toISOString(),kind:q.kind,side:q.side||'',key:q.key||'',battle:q.battle,species:q.species||'',title:q.title,detail:q.detail,options:q.options,modelTop:q.modelTop??null,modelP:q.modelP??null,frames,frameTimes,focus:q.focus||''});
 await putAnswer({qid,value,label,kind:q.kind,species:q.species||'',side:q.side||'',modelTop:q.modelTop??null,purple:q.purple??null,answeredAt:new Date().toISOString(),by:state.userId||'',source:'browser'});}
// Queues every below-threshold detection of a finished analysis (questions.js decides which) and
// stores each battle's summary and HP timeline, so the analysis can be shown once it is validated.
// Questions already answered for this recording keep their answers.
async function submit(questions,summaries,{recording}){const rec=recording||'video',now=new Date().toISOString();let n=0;
 for(const q of questions){const qid=safeId(`browser:${rec}:${q.id}`);if(state.answers.has(qid))continue;n++;
  await putQuestion({qid,source:'browser',recording:rec,createdAt:now,kind:q.kind,side:q.side||'',key:q.key||'',battle:q.battle,allBattles:!!q.allBattles,species:q.species||'',title:q.title,detail:q.detail,options:q.options||[],modelTop:q.modelTop??null,modelP:q.modelP??null,purple:q.purple??null,clip:q.clip||null,frameTimes:q.frames||[],frames:[],focus:q.focus||''});}
 for(const sm of summaries)await putAnalysis({...sm,aid:`${rec}#${sm.battle}`,recording:rec,createdAt:now,by:state.userId||''});
 render();return n;}
// The answer to a stored question about this battle's Pokémon (your own Pokémon: any battle).
function answerFor(rec,battle,side,key,kind){for(const q of state.questions.values()){if(q.recording!==rec||q.kind!==kind)continue;if(kind==='result'?q.battle!==battle:(q.side!==side||q.key!==key||(side!=='my'&&q.battle!==battle)))continue;const a=state.answers.get(q.qid);if(a)return a;}return null;}
const openFor=rec=>[...state.questions.values()].filter(q=>q.source==='browser'&&q.recording===rec&&!state.answers.has(q.qid));
// A validated battle: the model's summary with the reviewer's answers applied.
function validated(sm){const out=structuredClone(sm),res=answerFor(sm.recording,sm.battle,null,null,'result');if(res&&res.value){const [r,e]=String(res.value).split(':');out.result=r;out.ending=e||'normal';}
 for(const side of ['my','opponent'])for(const p of out[side]){const f=answerFor(sm.recording,sm.battle,side,p.key,'fastMove'),sh=answerFor(sm.recording,sm.battle,side,p.key,'shadow'),fo=answerFor(sm.recording,sm.battle,side,p.key,'form');
  if(f&&f.value){p.fastMove=f.value;p.fastMoveName=f.label;p.fastP=1;p.confirmed=true;}if(sh&&sh.value!==null)p.shadowP=sh.value?1:0;if(fo&&fo.value){p.species=fo.value;p.label=fo.label;}}return out;}
function analysesView(host){const recs=new Map();for(const a of state.analyses.values()){if(!recs.has(a.recording))recs.set(a.recording,[]);recs.get(a.recording).push(a);}if(!recs.size)return;
 const box=el('section',undefined,'meta-v-analyses');box.append(el('h3','Your analyses'));
 for(const [rec,list] of [...recs].sort((a,b)=>String(b[1][0].createdAt).localeCompare(String(a[1][0].createdAt)))){const open=openFor(rec),row=el('div',undefined,'meta-event');
  row.append(el('span',open.length?`${open.length} to validate`:'Validated','meta-pill '+(open.length?'':'win')),el('span',`${rec} · ${list.length} battle${list.length===1?'':'s'}`));
  if(open.length){const go=el('button','Answer these','secondary');go.onclick=()=>{state.filter='open';state.source='browser';state.current=open[0].qid;render();};row.append(go);}
  else{const view=el('button',state.showing===rec?'Hide analysis':'View analysis');view.onclick=()=>{state.showing=state.showing===rec?null:rec;render();};row.append(view);}box.append(row);
  if(state.showing===rec&&!open.length)for(const sm of list.sort((a,b)=>a.battle-b.battle)){const v=validated(sm),card=el('article',undefined,'meta-battle reviewed'),h=el('header');
   h.append(el('strong',`Battle ${sm.battle+1}`),el('span',`${clock(sm.start)} · ${Math.round(sm.duration)} s`,'meta-pill'),el('span',v.result||'Unknown','meta-pill '+(v.result==='Win'?'win':v.result==='Loss'?'loss':'')));card.append(h);
   if(v.hp&&window.MetaTimeline)card.append(MetaTimeline.render(v),MetaTimeline.legend(v));else card.append(el('p','No HP readings for this battle.','hint'));box.append(card);}}
 host.append(box);}
// ---- view ----
function pct(x){return `${Math.round(x*100)}%`;}
// Plain-language question and a short context line, from the stored title.
function wording(q){const battle=/Battle (\d+)/.exec(q.title||'')?.[1],m=/(?:[Oo]pponent’s|[Yy]our) (.+?)(?:: which| a Shadow)/.exec(q.title||''),name=m?.[1]||'Pokémon',owner=q.side==='my'?(q.attribution?'the creator’s':'your'):'the opponent’s';
 const question=q.kind==='fastMove'?`Which fast move is ${owner} ${name} using?`:q.kind==='form'?`Which form is ${owner} ${name}?`:q.kind==='shadow'?`Is ${owner} ${name} a Shadow Pokémon?`:q.kind==='result'?`Who won battle ${battle}?`:q.title;
 const context=[battle&&q.kind!=='result'?`Battle ${battle}`:null,q.side==='my'?(q.attribution?'Creator’s Pokémon':'Your Pokémon'):q.side==='opponent'?'Opponent':null,q.recording].filter(Boolean).join(' · ');return {question,context};}
// ---- Full-size scrubbing from your own recording (nothing is uploaded) ----
const clock=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}.${Math.floor((t%1)*10)}`;
function recordingFile(name){if(state.files.has(name))return state.files.get(name);return state.files.size===1?[...state.files.values()][0]:null;}
function openButton(label){const lab=el('label',undefined,'meta-v-open secondary'),inp=el('input');inp.type='file';inp.accept='video/*,.mp4,.mov';inp.multiple=true;inp.className='meta-hidden';
 inp.onchange=()=>{for(const f of inp.files){const old=state.files.get(f.name);if(old)URL.revokeObjectURL(old.url);state.files.set(f.name,{file:f,url:URL.createObjectURL(f)});}render();};lab.append(el('span',label),inp);return lab;}
// Whole-recording player: the video's own timeline is the scrubber; Play and Restart (back to the
// question's moment) are the only extra controls. After an answer, the next question's moment plays
// immediately.
function scrubber(q,rec){const box=el('div',undefined,'meta-v-player');if(!state.player){state.player=el('video');state.player.muted=true;state.player.playsInline=true;state.player.preload='auto';state.player.controls=true;}
 const v=state.player,[c0,c1]=q.clip||[0,0];const fresh=state.playerQ!==q.qid;state.playerQ=q.qid;
 const now=el('span',undefined,'meta-v-time'),sync=()=>{now.textContent=`${clock(v.currentTime)} · question moment ${clock(c0)}–${clock(c1)}`;};
 const restart=(play)=>{v.currentTime=c0;if(play)v.play().catch(()=>{});else v.pause();};
 // Re-rendering briefly detaches the video, which pauses it, so playback starts once it is back on the page.
 const auto=state.autoplay,start=()=>setTimeout(()=>restart(auto),0);
 if(v.dataset.src!==rec.url){v.src=rec.url;v.dataset.src=rec.url;v.onloadedmetadata=()=>{start();sync();};}else if(fresh&&v.readyState>=1)start();
 state.autoplay=false;v.ontimeupdate=sync;v.onseeked=sync;
 const play=el('button',v.paused?'Play':'Pause');play.type='button';play.onclick=()=>{if(v.paused)v.play().catch(()=>{});else v.pause();};v.onplay=()=>{play.textContent='Pause';};v.onpause=()=>{play.textContent='Play';};
 const again=el('button','Restart','secondary');again.type='button';again.onclick=()=>restart(true);
 const bar=el('div',undefined,'meta-actions');bar.append(play,again,now);box.append(v,bar);sync();return box;}
// No local copy: play the question's moment on YouTube (video times match the harvested file).
const ytTime=t=>Math.max(0,Math.floor(t||0));
function youtubePlayer(q){const v=q.video,[c0,c1]=q.clip||[0,0],box=el('div',undefined,'meta-v-player meta-v-yt');
 let frame=state.yt&&state.yt.qid===q.qid?state.yt.frame:null;
 const src=n=>`https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?start=${ytTime(c0)}&autoplay=1&mute=1&rel=0&playsinline=1&n=${n}`;
 if(!frame){frame=el('iframe');frame.src=src(0);frame.title=`YouTube: ${v.title||v.id}`;frame.allow='autoplay; encrypted-media; picture-in-picture';frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';state.yt={qid:q.qid,frame,n:0};}
 const again=el('button','Restart','secondary');again.type='button';again.onclick=()=>{state.yt.n++;frame.src=src(state.yt.n);};
 const link=el('a',`Open on YouTube at ${clock(c0).replace(/\.\d$/,'')}`);link.href=`https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}&t=${ytTime(c0)}s`;link.target='_blank';link.rel='noopener';
 const bar=el('div',undefined,'meta-actions');bar.append(again,link,el('span',`question moment ${clock(c0)}–${clock(c1)}`,'meta-v-time'));box.append(frame,bar);return box;}
function render(){const host=$('metaValidatePane');const all=[...state.questions.values()],answered=all.filter(q=>state.answers.has(q.qid)),open=all.filter(q=>!state.answers.has(q.qid));
 const count=$('metaValidateCount');if(count)count.textContent=open.length;if(!host||host.hidden)return;host.replaceChildren();
 const head=el('div',undefined,'meta-heading'),title=el('div');title.append(el('p','REVIEW → LEARN','meta-eyebrow'),el('h2','Validate detections'));head.append(title);host.append(head);
 host.append(el('p',state.db?'Answer questions the analysis couldn’t settle. They come from Claude’s test runs and from videos you analyze; no video is needed here. Your answers are saved for everyone with access, scored against the model, and used as learned priors in later analyses.':'Answer questions the analysis couldn’t settle. Outside claude.ai, answers are saved in this browser only.','meta-demo-note'));
 if(state.writeError)host.append(el('p',state.writeError,'meta-flags'));
 // accuracy and learning summary
 const acc=Q.accuracy(asQuestions(),state.answers),metrics=el('div',undefined,'meta-metrics');const tile=(n,l)=>{const d=el('div');d.append(el('strong',n),el('small',l));return d;};
 metrics.append(tile(String(open.length),'Open questions'),tile(String(answered.length),'Answered'));for(const [k,l] of [['fastMove','Fast moves'],['shadow','Shadow'],['form','Forms']])if(acc[k])metrics.append(tile(pct(acc[k].right/acc[k].total),`Model right · ${l} (${acc[k].total})`));host.append(metrics);
 const lp=learned(),nm=Object.keys(lp.moves).length,ns=Object.keys(lp.shadow).length;if(nm||ns)host.append(el('p',`Learned so far: confirmed fast moves for ${nm} species and Shadow status for ${ns}. New analyses weight these alongside PvPoke’s data.`,'hint'));
 analysesView(host);
 // filters
 const bar=el('div',undefined,'meta-tabs');for(const [v,l] of [['open',`Open (${open.length})`],['answered',`Answered (${answered.length})`]]){const b=el('button',l,v===state.filter?'':'secondary');b.setAttribute('aria-pressed',v===state.filter);b.onclick=()=>{state.filter=v;state.current=null;render();};bar.append(b);}
 const src=el('select');src.id='metaValidateSource';src.setAttribute('aria-label','Question source');for(const [v,l] of [['all','All sources'],['claude-test','From Claude’s test runs'],['youtube','From YouTube videos'],['youtube-harvest','From the overnight harvester'],['audit','Spot checks'],['browser','From your analyses']]){const o=el('option',l);o.value=v;src.append(o);}src.value=state.source;src.onchange=()=>{state.source=src.value;state.current=null;render();};const dl=el('button','Download answers','secondary');dl.type='button';dl.disabled=!state.answers.size;dl.onclick=downloadAnswers;bar.append(src,openButton(state.files.size?`Recordings open: ${state.files.size}`:'Open recording…'),importButton(),dl);host.append(bar);
 if(!state.ready){host.append(el('p','Loading questions…','hint'));return;}
 const pool=(state.filter==='open'?open:answered).filter(q=>state.source==='all'||(state.source==='youtube'?!!q.attribution:state.source==='audit'?!!q.audit:q.source===state.source)).sort((a,b)=>(a.recording||'').localeCompare(b.recording||'')||(a.battle??0)-(b.battle??0)||String(a.kind).localeCompare(String(b.kind)));
 if(!pool.length){host.append(el('p',state.filter==='open'?'Nothing to validate right now. New questions appear here after each test run or analysis.':'No answers yet.','meta-empty'));return;}
 if(state.filter==='answered'){const list=el('div',undefined,'meta-battles');for(const q of pool.slice().reverse()){const a=state.answers.get(q.qid),row=el('div',undefined,'meta-event');const right=q.modelTop!==null&&q.modelTop!==undefined&&a.value!==null?String(q.modelTop)===String(a.value):null;
   row.append(el('span',right===null?'—':right?'Model right':'Model wrong','meta-pill '+(right?'win':right===false?'loss':'')),el('span',`${q.title} → ${a.label}${q.recording?` · ${q.recording}`:''}`));const redo=el('button','Change','secondary');redo.onclick=()=>{state.filter='open';state.current=q.qid;state.answers.delete(q.qid);render();};row.append(redo);list.append(row);}host.append(list);return;}
 const visible=pool.filter(q=>!state.skipped.has(q.qid)),q=(state.current&&pool.find(x=>x.qid===state.current))||visible[0]||pool[0];state.current=q.qid;
 const card=el('section',undefined,'meta-questions');card.setAttribute('aria-live','polite');
 const rec=recordingFile(q.recording),w=wording(q);
 card.append(el('p',`Question ${pool.indexOf(q)+1} of ${pool.length}${q.audit?' · Spot check':''}`,'meta-eyebrow'));
 const ask=[el('p',w.context,'meta-q-context'),el('h3',w.question,'meta-q-title'),el('p',q.detail,'meta-q-detail')];
 // Third-party videos (Creative Commons uploads) are credited; the file itself stays on the reviewer's device.
 if(q.attribution){const p=el('p',undefined,'hint'),link=el('a',`${q.attribution.channel} on YouTube`);link.href=q.attribution.url;link.target='_blank';link.rel='noopener';p.append('Video: ',link,` · ${String(q.attribution.license||'').replace(/ \(reuse allowed\)/,'')}`);ask.push(p);}
 // Answers need the recording: the saved crops are too small to judge from.
 if(!rec&&q.video?.provider==='youtube'){card.append(youtubePlayer(q),...ask,el('p',`Or open your local copy (${q.recording}) for frame-accurate scrubbing.`,'hint'));}
 else if(!rec){card.append(...ask);const need=el('div',undefined,'meta-q-need');need.append(el('p',`Open ${q.recording||'the recording'} to watch this moment and answer. The video stays on your device.`),openButton(`Open ${q.recording||'recording'}`));card.append(need);host.append(card);return;}
 else{card.append(scrubber(q,rec),...ask);if(!state.files.has(q.recording))card.append(el('p',`Using ${rec.file.name} for ${q.recording}. Open the matching file if that’s not the same recording.`,'hint'));}
 const choices=el('div',undefined,'meta-q-options'),opts=q.kind==='result'?Q.RESULT_OPTIONS:(q.options||[]);for(const o0 of opts){const o=q.attribution?{...o0,label:o0.label.replace(/^You (won|lost|forfeited)/,'Creator $1'),hint:o0.hint&&o0.hint.replace(/\byou\b/gi,'the creator')}:o0;const b=el('button');b.type='button';b.append(el('span',o.label));const top=q.modelTop!==null&&q.modelTop!==undefined&&String(q.modelTop)===String(o.value),hint=top?`Model’s pick${q.modelP?` · ${pct(q.modelP)}`:''}`:(o.hint||'').replace(/^model /,'Model ');if(hint)b.append(el('small',hint));
  b.onclick=()=>{state.current=null;state.autoplay=true;putAnswer({qid:q.qid,purple:q.purple??null,value:o.value,label:o.label,kind:q.kind,species:q.species||'',side:q.side||'',modelTop:q.modelTop??null,answeredAt:new Date().toISOString(),by:state.userId||'',source:q.source});};if(o.parent){b.classList.add('meta-q-sub');const host=[...choices.children].find(g=>g.dataset.value===o.parent);if(host){host.append(b);continue;}}const group=el('div',undefined,'meta-q-group');group.dataset.value=o.value;group.append(b);choices.append(group);}
 const actions=el('div',undefined,'meta-actions'),unsure=el('button','Not sure','secondary'),skip=el('button','Skip for now','secondary');
 unsure.onclick=()=>{state.current=null;state.autoplay=true;putAnswer({qid:q.qid,purple:q.purple??null,value:null,label:'Not sure',kind:q.kind,species:q.species||'',side:q.side||'',modelTop:q.modelTop??null,answeredAt:new Date().toISOString(),by:state.userId||'',source:q.source});};
 skip.onclick=()=>{state.skipped.add(q.qid);if(visible.length<=1)state.skipped.clear();state.current=null;state.autoplay=true;render();};actions.append(unsure,skip);card.append(choices,actions);host.append(card);}
window.MetaValidation={learned,record,submit,render,ready:connect()};
})();
