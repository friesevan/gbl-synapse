#!/usr/bin/env node
// Batch engine for large datasets: runs run-node.cjs over many videos with a pool of workers.
// Long files are split into chunks that decode in parallel and are merged afterwards. Resumable:
// finished outputs are skipped, so an interrupted batch picks up where it stopped.
//
// Usage: node run-batch.cjs JOBS.txt OUTDIR
//   JOBS.txt: path|league|gamemaster|crop|ranges|crops (optional fifth JSON range column; optional sixth CROPS,
//             placement-plan.cjs: the screen placed differently per stretch).
//             ranges use original source seconds; legacy four-column jobs stay full-file.
//   JOBS=n         parallel workers (default: cores ÷ 3; each ffmpeg decodes with several threads)
//   SPLIT=minutes  split files longer than this into chunks (default 20; 0 = never)
//
// Chunks: chunk i decodes [s_i, e_i + 6 min] and keeps the battles that START in [s_i, e_i). A battle
// lasts well under 6 minutes, so each battle is complete in exactly one chunk; a chunk's battle that
// was already under way when the chunk began (flagged "starts mid-battle") is dropped, since the
// previous chunk has it whole. Your-team pooling then runs per chunk.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const Range=require('./range-plan.cjs');
const [jobsFile,outDir]=process.argv.slice(2);
const JOBS=Number(process.env.JOBS||Math.max(1,Math.floor(os.cpus().length/3))),SPLIT=Number(process.env.SPLIT??20)*60,OVERLAP=360;
fs.mkdirSync(outDir,{recursive:true});
const jobs=fs.readFileSync(jobsFile,'utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')).map(l=>{const [video,league='1500',gm='',crop='',ranges,crops]=l.split('|');return {video,league,gm,crop,crops:crops??process.env.CROPS??'',ranges:Range.parseRanges(ranges??process.env.RANGES,{forceFull:process.env.FORCE_FULL==='1'})};});
const name=v=>path.basename(v,path.extname(v));
const duration=v=>Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',v]).toString());
// Expand to tasks (whole files or chunks).
const tasks=[];for(const j of jobs){const dur=duration(j.video),n=name(j.video);j.duration=dur;
 if(SPLIT&&dur>SPLIT*1.25){const k=Math.ceil(dur/SPLIT);j.chunks=[];for(let i=0;i<k;i++){const s=i*SPLIT,e=Math.min(dur,(i+1)*SPLIT),out=path.join(outDir,`${n}.part${i}.json`);j.chunks.push({s,e,out});tasks.push({job:j,out,start:s,end:Math.min(dur,e+OVERLAP),label:`${n} [${(s/60).toFixed(0)}–${(e/60).toFixed(0)} min]`});}}
 else tasks.push({job:j,out:path.join(outDir,`${n}.json`),label:n});}
for(const t of tasks)t.plan=Range.planWindow({ranges:t.job.ranges,start:t.start??0,end:t.end??t.job.duration,forceFull:process.env.FORCE_FULL==='1'});
const todo=tasks.filter(t=>!fs.existsSync(t.out));
console.log(`${jobs.length} videos (${(jobs.reduce((a,j)=>a+j.duration,0)/3600).toFixed(2)} h) → ${tasks.length} tasks, ${tasks.length-todo.length} already done · ${JOBS} workers`);
const started=Date.now();let videoSecondsDone=0;
function runTask(t){return new Promise(resolve=>{const env={...process.env,LEAGUE:t.job.league,GAMEMASTER:t.job.gm,CROP:t.job.crop,CROPS:t.job.crops,RANGES:t.plan.RANGES,START:String(t.plan.start),END:String(t.plan.end)};
 if(t.plan.mode==='empty'){
  const result={pipeline:'v3 single-pass · empty planned window',recording:path.basename(t.job.video),seconds:0,videoSeconds:0,realtime:0,start:t.plan.start,end:t.plan.end,ranges:[],crop:t.job.crop,battles:[],full:[],metrics:{}};
  fs.writeFileSync(t.out+'.tmp',JSON.stringify(result));fs.renameSync(t.out+'.tmp',t.out);console.log(`skipped ${t.label}: no planned footage`);resolve();return;
 }
 const tmpOut=t.out+'.tmp',p=spawn(process.execPath,[path.join(__dirname,'run-node.cjs'),t.job.video,tmpOut],{env,stdio:['ignore','pipe','pipe']});let log='';p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);
 p.on('close',code=>{if(code===0&&fs.existsSync(tmpOut)){fs.renameSync(tmpOut,t.out);const r=JSON.parse(fs.readFileSync(t.out,'utf8'));videoSecondsDone+=r.videoSeconds;const wall=(Date.now()-started)/1000;console.log(`done ${t.label}: ${r.battles.length} battles, ${r.realtime}× · batch ${(videoSecondsDone/wall).toFixed(1)}× real time`);}else console.log(`FAILED ${t.label} (exit ${code})\n${log.slice(-800)}`);resolve();});});}
// Merge chunk outputs of one video into a single result.
function merge(j){const parts=j.chunks.map(c=>({c,r:JSON.parse(fs.readFileSync(c.out,'utf8'))}));const keep=(c,b,i)=>b.start>=c.s&&b.start<c.e&&!(c.s>0&&b.start<c.s+10&&(b.flags||[]).some(f=>/mid-battle/.test(f)));
 const sum=key=>parts.reduce((a,p)=>a+(p.r[key]||0),0),seconds=sum('seconds'),videoSeconds=sum('videoSeconds');
 const first=parts.find(p=>p.r.videoSeconds>0)?.r||parts[0].r;
 const out={...first,pipeline:first.pipeline+' · merged from '+parts.length+' chunks',recording:path.basename(j.video),seconds,videoSeconds,realtime:seconds?+(videoSeconds/seconds).toFixed(2):0,sourceDuration:j.duration,start:0,end:j.duration,ranges:process.env.FORCE_FULL==='1'?null:j.ranges,battles:[],full:[],chunks:parts.map(p=>({start:p.c.s,end:p.c.e,seconds:p.r.seconds,realtime:p.r.realtime,videoSeconds:p.r.videoSeconds,ranges:p.r.ranges}))};
 // First-chunk counters are not whole-video counters. Preserve per-chunk metrics explicitly.
 out.chunkMetrics=parts.map(p=>p.r.metrics);delete out.metrics;
 for(const {c,r} of parts)r.battles.forEach((b,i)=>{if(keep(c,b,i)){out.battles.push(b);out.full.push(r.full[i]);}});
 out.battles.sort((a,b)=>a.start-b.start);out.full.sort((a,b)=>a.start-b.start);fs.writeFileSync(path.join(outDir,`${name(j.video)}.json`),JSON.stringify(out));return out;}
(async()=>{const queue=[...todo];await Promise.all(Array.from({length:Math.min(JOBS,queue.length)},async()=>{while(queue.length)await runTask(queue.shift());}));
 for(const j of jobs)if(j.chunks&&j.chunks.every(c=>fs.existsSync(c.out))){const m=merge(j);console.log(`merged ${name(j.video)}: ${m.battles.length} battles from ${j.chunks.length} chunks`);}
 const wall=(Date.now()-started)/1000,total=todo.reduce((a,t)=>a+t.plan.seconds,0),full=todo.reduce((a,t)=>a+t.plan.end-t.plan.start,0);
 const summary={videos:jobs.length,tasks:todo.length,workers:JOBS,wallSeconds:+wall.toFixed(1),plannedVideoHours:+(total/3600).toFixed(2),videoHours:+(videoSecondsDone/3600).toFixed(2),avoidedVideoSeconds:+(full-total).toFixed(1),realtime:wall?+(videoSecondsDone/wall).toFixed(1):0};
 fs.writeFileSync(path.join(outDir,'batch-summary.json'),JSON.stringify(summary,null,1));console.log(`batch: ${summary.videoHours} h of video in ${(wall/60).toFixed(1)} min with ${JOBS} workers = ${summary.realtime}× real time`);})();
