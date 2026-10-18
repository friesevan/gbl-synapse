// Second nameplate reader (2026-10-17): the local vision model behind scripts/freellm (task llm_hud_names, gate
// passed with qwen2.5vl:7b: 108/108 names on Creative Commons HUD strips, none invented), asked only where the OCR is
// unsure: a one-letter (or one-jamo) suggestion, or a plate whose text has letters but names no species.
// - YouTube footage only: never the owner's own recordings (files directly in PoGo Recorder/src), which
//   eval_hud.py refuses as well; the video must sit in a folder named youtube or youtube-cc.
// - Two independent calls must agree (eval_hud.py read: freellm --agree 2); eval_hud.py refuses unless the gate passed.
// - The model's name counts only as an exact dictionary name (English, or the video's language once decided):
//   it confirms the OCR's suggestion, replaces a different one, or names an unread plate. No answer, a disagreement
//   or an unknown name leaves the OCR's result as it was.
// - At most `budget` calls per video; one call per distinct OCR text (the same misread gets the same answer).
// Enabled by run-node.cjs with HUD_LLM=1 (HUD_LLM_BUDGET=n).
const path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const OWN=path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src');
const EVAL=path.resolve(__dirname,'../../scripts/freellm/eval_hud.py');
function youtubeOnly(video){const dir=path.dirname(path.resolve(video));return dir!==path.resolve(OWN)&&/^youtube(-cc)?$/.test(path.basename(dir));}
// run(video, box, t) → {my, opponent, agreed} or null; the default calls eval_hud.py read.
function evalHudRead(video,box,t){const r=spawnSync('python3',['-I',EVAL,'read',video,box.join(','),t.toFixed(2)],{encoding:'utf8',timeout:180000});
 if(r.status!==0)return null;try{return JSON.parse(r.stdout.trim().split('\n').pop());}catch{return null;}}
// Unsure: a suggestion, or no species from a read with at least three letters.
const unsure=(hit,text)=>hit?hit.quality==='suggestion':((String(text||'').match(/\p{L}/gu)||[]).length>=3);
function createSecondReader({C,video,box,dict,locales,language,enabled=false,budget=30,run=evalHudRead}){
 const on=enabled&&!!video&&youtubeOnly(video)&&!!box,seen=new Map(),stats={calls:0,confirmed:0,replaced:0,named:0,kept:0};
 // The model's text → a hit (exact only), in English or the video's decided language.
 function name(text){if(!text)return null;const en=C.match(String(text),dict);if(en?.quality==='exact')return en;const lang=language.lang;
  if(lang!=='en'&&locales[lang]){const lm=C.matchLocale(String(text),locales[lang],lang);if(lm?.quality==='exact')return lm;}return null;}
 // hit: the OCR's result for this plate (or null); eng: the English OCR read; side, t: where to look.
 function check(hit,eng,side,t){if(!on||!unsure(hit,eng?.text))return hit;const k=side+'\u0000'+(hit?.raw||eng?.text||'');
  let ans=seen.get(k);if(ans===undefined){if(stats.calls>=budget)return hit;stats.calls++;const r=run(video,box,t);ans=r&&r.agreed?name(r[side]):null;seen.set(k,ans);}
  if(!ans){stats.kept++;return hit;}const out={...ans,confidence:hit?.confidence??eng?.confidence??0,raw:hit?.raw||eng?.text||'',secondReader:true};
  if(!hit){stats.named++;return out;}if(ans.key===hit.key){stats.confirmed++;return {...hit,secondReader:true};}stats.replaced++;return out;}
 return {enabled:on,check,stats};}
module.exports={createSecondReader,youtubeOnly,unsure,evalHudRead};
