#!/usr/bin/env node
// Shadow classifier dataset: joins every confirmed Shadow answer (feedback.json + archived labels/*.json
// `verified`; "Not sure" skipped) to the saved evidence for that Pokémon. Each labelled video is refitted
// with priors learned from the OTHER videos' answers only, and the per-species purple baseline excludes
// that video, so rows can be cross-validated by video without leakage. Reads only; writes one JSON.
//   node shadow-dataset.cjs [OUT]          WORK=harvest work dir (default ~/Desktop/Projects/PoGo Recorder/src/yt-harvest)
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {refitRun,loadGameMaster}=require('./refit.cjs'),Q=require('../../includes/meta/questions.js'),Shadow=require('../../includes/meta/shadow-model.js');
const WORK=process.env.WORK||path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src/yt-harvest');
const video=a=>a.video?.id||String(a.recording||'').replace(/\.mp4$/,'');
const readJSON=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return d;}};
// Every human label (feedback first; archived benchmark labels fill in what feedback.json lacks).
function humanAnswers(work=WORK){const fb=readJSON(path.join(work,'feedback.json'),{answers:{}}),out=new Map();
 for(const a of Object.values(fb.answers||{}))if(a&&a.source!=='model'&&!a.modelResolved&&a.value!==null&&a.value!==undefined)out.set(a.qid,{...a,origin:'feedback'});
 const dir=path.join(work,'labels');for(const f of fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')):[]){const v=readJSON(path.join(dir,f),{}).verified||{};
  for(const a of Array.isArray(v)?v:Object.values(v))if(a?.qid&&!out.has(a.qid)&&a.value!==null&&a.value!==undefined)out.set(a.qid,{...a,origin:'labels'});}
 return [...out.values()];}
// Species corrected by a form answer for the same Pokémon (as learning-loop.cjs does).
function corrected(answers){const forms=answers.filter(a=>a.kind==='form');return answers.map(a=>{const f=a.kind!=='form'&&forms.find(f=>video(f)===video(a)&&f.side===a.side&&f.key===a.key&&(f.allBattles||f.battle===a.battle));return f?{...a,species:String(f.value).replace(/_shadow$/,'')}:a;});}
const learnedExcept=(answers,vid)=>Q.learnedFromAnswers([],new Map(answers.filter(a=>video(a)!==vid).map(a=>[a.qid,a])));
function gamemasterFor(raw,reg){const c=raw.learningContext||{};if(c.gamemaster&&fs.existsSync(c.gamemaster))return c.gamemaster;const d=String(reg?.uploadDate||'').replace(/-/g,'');
 if(/^\d{8}$/.test(d)){const day=+d.slice(6)>=16?'16':'01',f=path.join(os.homedir(),'.cache/gbl-synapse/gamemaster',`${d.slice(0,4)}-${d.slice(4,6)}-${day}.json`);if(fs.existsSync(f))return f;}return undefined;}
const LEAGUE={great:1500,ultra:2500,master:10000,little:500};
function build({work=WORK,log=()=>{}}={}){
 const answers=corrected(humanAnswers(work)),shadow=answers.filter(a=>a.kind==='shadow'&&typeof a.value==='boolean');
 const regRaw=readJSON(path.join(__dirname,'sources/registry.json'),[]),registry=new Map((Array.isArray(regRaw)?regRaw:regRaw.videos||[]).map(v=>[v.id,v]));
 const resDir=path.join(work,'results'),runFiles=fs.readdirSync(resDir).filter(f=>/^[^.]+\.json$/.test(f)&&!/^batch-summary/.test(f));
 // Aura of every saved run (unlabelled) → per-species purple baseline, leaving the target video out.
 const auraRuns=new Map();for(const f of runFiles){const r=readJSON(path.join(resDir,f),null);if(r?.full)auraRuns.set(f.replace(/\.json$/,''),{full:r.full.map(b=>({matchups:(b.matchups||[]).map(g=>({my:g.my,opponent:g.opponent,auraMy:g.auraMy,auraOpponent:g.auraOpponent}))}))});}
 const gmCache=new Map(),gmFor=f=>{if(!gmCache.has(f||''))gmCache.set(f||'',loadGameMaster(f));return gmCache.get(f||'');};
 const rows=[],missing=[];const byVid=new Map();for(const a of shadow){const v=video(a);if(!byVid.has(v))byVid.set(v,[]);byVid.get(v).push(a);}
 for(const [vid,list] of byVid){const raw=readJSON(path.join(resDir,vid+'.json'),null);if(!raw?.full){missing.push(...list.map(a=>a.qid));continue;}
  const reg=registry.get(vid),learned=learnedExcept(answers,vid),speciesPurple=Shadow.speciesPurple([...auraRuns].filter(([k])=>k!==vid).map(([,r])=>r));
  const run=refitRun(raw,{learned,league:raw.learningContext?.league||LEAGUE[reg?.leagueId]||1500,gm:gmFor(gamemasterFor(raw,reg)),shadowModel:false,speciesPurple});
  const scr=raw.metrics?.screen||{},crop=raw.crop||[];
  for(const a of list){const battle=a.side==='my'?null:a.battle,bs=battle==null?run.full.filter(b=>(b.my||[]).some(p=>p.key===a.key)):[run.full[battle]].filter(Boolean);
   const m=bs.map(b=>(b[a.side]||[]).find(p=>p.key===a.key)).find(p=>p?.shadowModel);
   if(!m){missing.push(a.qid);continue;}
   rows.push({qid:a.qid,video:vid,channel:reg?.channel||a.video?.channel||(a.origin==='labels'&&!reg?'phone':''),species:a.species,side:a.side,y:a.value?1:0,origin:a.origin,
    x:m.shadowModel.x,info:m.shadowModel.info,oldP:m.inference?m.inference.shadowPOld:Shadow.sigmoid(m.shadowModel.x.priorLogit),askedP:a.modelP??null,askedTop:a.modelTop??null,
    titleShadow:new RegExp('shadow\\s+'+String(a.species||'').split('_')[0],'i').test(reg?.title||a.video?.title||'')?1:0,
    layout:{W:scr.W||raw.width||null,H:scr.H||raw.height||null,cropW:crop[2]?crop[2]-crop[0]:null,cropH:crop[3]?crop[3]-crop[1]:null}});}
  log(`${vid}: ${list.length} labels`);}
 return {builtAt:new Date().toISOString(),rows,missing,answers:shadow.length,speciesPurple:Shadow.speciesPurple([...auraRuns.values()])};}
module.exports={build,humanAnswers,corrected,learnedExcept,video};
if(require.main===module){const out=process.argv[2]||path.join(__dirname,'results/shadow-dataset.json'),t=Date.now(),d=build({log:process.env.VERBOSE?console.log:()=>{}});
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(d));
 console.log(`${d.rows.length} rows from ${new Set(d.rows.map(r=>r.video)).size} videos (${d.answers} labels, ${d.missing.length} without saved evidence) in ${((Date.now()-t)/1000).toFixed(0)} s → ${out}`);}
