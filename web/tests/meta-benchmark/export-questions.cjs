#!/usr/bin/env node
// Turns a benchmark run into validation questions for the artifact's Validate view.
// Usage: node export-questions.cjs RUN.json VIDEO OUTDIR [learned.json]
// RUN.json comes from run-node.cjs (its `full` battles keep each matchup's fit, so the current
// pooling and learned priors are re-applied here without decoding the video again). For each
// question, 8 frames across the relevant moment are cropped to what matters and embedded as small
// JPEGs. One JSON document per question is written to OUTDIR (collection "validation").
// Third-party videos (sources/registry.json) never get frames: the reviewer opens their own local
// copy, and the question carries the channel, link and licence for attribution.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const K=require('../../includes/meta/combat.js'),Q=require('../../includes/meta/questions.js');
// GAMEMASTER=path selects PvPoke game data from the recording's date (older files lack `turns`).
const gm=(()=>{const g=process.env.GAMEMASTER?JSON.parse(require('node:fs').readFileSync(process.env.GAMEMASTER,'utf8')):require('../../includes/pro/data/gamemaster.json');for(const m of g.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);return g;})();
const [runPath,video,outDir,learnedPath]=process.argv.slice(2);
const raw=JSON.parse(fs.readFileSync(runPath,'utf8')),recording=path.basename(video),learned=learnedPath?JSON.parse(fs.readFileSync(learnedPath,'utf8')):null;
const run=require('./refit.cjs').refitRun(raw,{learned,league:Number(process.env.LEAGUE||raw.learningContext?.league||1500),gm});
const FOCUS={icons:[0,40,886,230],opponent:[386,560,886,1080],my:[0,760,520,1380],center:[0,600,886,1300]};
const safeId=s=>String(s).replace(/[^A-Za-z0-9_\-.~:@+]/g,'-').slice(0,200);
const battles=run.full,reg=JSON.parse(fs.readFileSync(path.join(__dirname,'sources/registry.json'),'utf8')),source=(Array.isArray(reg)?reg:reg.videos).find(v=>recording.startsWith(v.id+'.'));
const noFrames=!!source||!!process.env.NO_FRAMES;
// Refitted once from physical evidence; no compounded move/Shadow/form priors.
const qs=Q.questions(battles,{pokemon:gm.pokemon,moves:gm.moves});
// AUDIT=n adds n spot checks of confident calls (picked reproducibly per recording), so reviewers also
// measure how often the model is wrong when it is sure. They are marked audit:true.
if(Number(process.env.AUDIT)>0){const asked=new Set(qs.map(q=>q.id)),all=Q.questions(battles,{pokemon:gm.pokemon,moves:gm.moves,confident:1.01,shadowBand:[-1,2]}).filter(q=>!asked.has(q.id)&&q.kind!=='result');
 let seed=[...recording].reduce((h,c)=>(h*31+c.charCodeAt(0))>>>0,7);const rnd=()=>(seed=(seed*1103515245+12345)>>>0)/2**32;
 for(const q of all.map(q=>[rnd(),q]).sort((x,y)=>x[0]-y[0]).slice(0,Number(process.env.AUDIT)).map(x=>x[1]))qs.push({...q,audit:true,detail:`Spot check: the model is confident here (${Math.round((q.modelP??0)*100)}%). ${q.detail||''}`.trim()});}
const [W,H]=execFileSync('ffprobe',['-v','error','-select_streams','v','-show_entries','stream=width,height','-of','csv=p=0',video]).toString().trim().split(',').map(Number);
fs.mkdirSync(outDir,{recursive:true});const tmp=path.join(outDir,'frame.jpg'),docs=[];
for(const q of qs){const [t0,t1]=q.clip,times=Array.from({length:8},(_,i)=>+(t0+(t1-t0)*i/7).toFixed(2)),s=W/886,[x0,y0,x1,y1]=FOCUS[q.focus]||FOCUS.center,frames=[];
if(!noFrames)for(const t of times){execFileSync('ffmpeg',['-v','error','-ss',String(Math.max(0,t)),'-i',video,'-frames:v','1','-vf',`crop=${Math.round((x1-x0)*s)}:${Math.round(Math.min(H/s,y1)-y0)*s|0}:${Math.round(x0*s)}:${Math.round(y0*s)},scale=220:-2`,'-q:v','6',tmp,'-y']);frames.push('data:image/jpeg;base64,'+fs.readFileSync(tmp).toString('base64'));}
 const doc={qid:safeId(`claude-test:${recording}:${q.id}`),source:'claude-test',recording,createdAt:new Date().toISOString(),kind:q.kind,...(q.audit?{audit:true}:{}),allBattles:!!q.allBattles,purple:q.purple??null,side:q.side||'',key:q.key||'',battle:q.battle,species:q.species||'',title:q.title,detail:q.detail,options:q.options,modelTop:q.modelTop??null,modelP:q.modelP??null,frames,frameTimes:noFrames?[]:times,focus:q.focus,clip:q.clip,...(source?{attribution:{channel:source.channel,url:source.url,license:source.license,uploadDate:source.uploadDate}}:{})};
 fs.writeFileSync(path.join(outDir,doc.qid+'.json'),JSON.stringify(doc));docs.push({qid:doc.qid,bytes:JSON.stringify(doc).length,kind:q.kind});}
fs.rmSync(tmp,{force:true});
fs.writeFileSync(path.join(outDir,'manifest.json'),JSON.stringify(docs,null,1));
const kinds={};for(const d of docs)kinds[d.kind]=(kinds[d.kind]||0)+1;
console.log(`${recording}: ${docs.length} questions ${JSON.stringify(kinds)}, largest ${Math.max(0,...docs.map(d=>d.bytes))} bytes`);
