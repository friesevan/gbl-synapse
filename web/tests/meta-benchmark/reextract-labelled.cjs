#!/usr/bin/env node
// Re-extracts human-labelled videos with the current extractor and installs the results in the work dir,
// so the learning loop and the held-out checks (movefit-eval.cjs, shadow-dataset.cjs) use the new HP bars.
// Labels address battles by index and Pokémon by key, so each run reuses the saved result's crop, decode
// ranges, league and game data, and a result is installed only if its battle structure is unchanged.
//   node reextract-labelled.cjs VIDEO_DIR [--jobs 4] [--only id,id] [--dry] [--keep DIR]
//   WORK_DIR=... (default ~/Desktop/Projects/PoGo Recorder/src/yt-harvest)
// --keep DIR saves every re-extracted result to DIR/<id>.json and installs nothing: a result whose battle structure
// changed is installed by scripts/yt-harvest/remap_battles.py, which moves the labels onto the new battles.
// VIDEO_DIR holds <videoId>.mp4 (local files only; nothing is downloaded). The originals are kept once in
// results-backup-hpbars/<id>.json. Long chunked runs (the owner's hour-long recordings) use run-batch.cjs.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),D=require('./movefit-data.cjs');
const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};
const VIDEOS=process.argv[2],JOBS=Number(arg('--jobs')||Math.max(1,Math.floor(os.cpus().length/3))),only=arg('--only')?.split(','),dry=process.argv.includes('--dry'),keep=arg('--keep');
const results=path.join(D.WORK,'results'),backup=path.join(D.WORK,'results-backup-hpbars'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'reextract-'));
const sig=r=>(r.full||[]).map(b=>[Math.round(b.start),b.my.map(p=>p.key).join('+'),b.opponent.map(p=>p.key).join('+')].join('|')).join(';');
function envFor(id,old){const lc=old.learningContext||{},ctx=D.runContext(id),env={...process.env,FFMPEG_THREADS:'1'};
 const learned=path.join(D.WORK,'learned.json');if(fs.existsSync(learned))env.LEARNED_PATH=learned;
 // Rankings narrow species candidates by league: without a recorded league, the highest nameplate CP sets it.
 const top=Math.max(0,...(old.full||[]).flatMap(b=>[...b.my,...b.opponent].map(p=>Number(p.cp)).filter(c=>c>0&&c<9000)));
 env.LEAGUE=String(lc.league||ctx?.league||(top<=500?500:top<=1500?1500:top<=2500?2500:10000));
 const gm=lc.gamemaster||ctx?.gamemaster;if(gm&&fs.existsSync(gm))env.GAMEMASTER=gm;
 if(old.crop)env.CROP=old.crop.join(',');if(old.ranges)env.RANGES=old.ranges.map(r=>r.join('-')).join(',');
 if(old.start)env.START=String(old.start);if(old.end!=null&&!old.chunks)env.END=String(old.end);return env;}
function run(id){return new Promise(done=>{const file=path.join(results,id+'.json'),old=JSON.parse(fs.readFileSync(fs.existsSync(path.join(backup,id+'.json'))?path.join(backup,id+'.json'):file,'utf8')),video=path.join(VIDEOS,id+'.mp4'),env=envFor(id,old),t=Date.now();
 let cmd,out;if(old.chunks){const jobs=path.join(tmp,id+'.jobs.txt'),dir=path.join(tmp,id+'-batch');fs.writeFileSync(jobs,[video,env.LEAGUE,env.GAMEMASTER||'',old.crop?old.crop.join(','):''].join('|')+'\n');cmd=[path.join(__dirname,'run-batch.cjs'),jobs,dir];out=path.join(dir,id+'.json');env.JOBS='4';}
 else{out=path.join(tmp,id+'.json');cmd=[path.join(__dirname,'run-node.cjs'),video,out];}
 const p=spawn('node',cmd,{env,stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',d=>{err=(err+d).slice(-400);});
 p.on('close',code=>{const s=((Date.now()-t)/1000).toFixed(0);if(code!==0||!fs.existsSync(out)){console.log(`${id}: failed after ${s} s ${err.trim()}`);return done();}
  const nw=JSON.parse(fs.readFileSync(out,'utf8')),cur=JSON.parse(fs.readFileSync(file,'utf8'));for(const [k,v] of Object.entries(cur))if(!(k in nw))nw[k]=v;
  if(keep){nw.hpBars={reextracted:new Date().toISOString()};fs.mkdirSync(keep,{recursive:true});const k=path.join(keep,id+'.json');fs.writeFileSync(k+'.tmp',JSON.stringify(nw));fs.renameSync(k+'.tmp',k);
   console.log(`${id}: saved to ${keep} (${s} s, ${nw.full.length} battles, was ${(old.full||[]).length}; structure ${sig(nw)===sig(old)?'unchanged':'changed'})`);return done();}
  if(sig(nw)!==sig(old)){console.log(`${id}: battle structure changed, not installed (${s} s)`);return done();}
  fs.mkdirSync(backup,{recursive:true});if(!fs.existsSync(path.join(backup,id+'.json')))fs.copyFileSync(file,path.join(backup,id+'.json'));
  nw.hpBars={reextracted:new Date().toISOString()};fs.writeFileSync(file+'.tmp',JSON.stringify(nw));fs.renameSync(file+'.tmp',file);console.log(`${id}: installed (${s} s, ${nw.full.length} battles)`);done();});});}
(async()=>{const ids=[...new Set(D.loadLabels().map(l=>l.video))].filter(id=>(!only||only.includes(id))&&fs.existsSync(path.join(results,id+'.json')));
 const todo=ids.filter(id=>fs.existsSync(path.join(VIDEOS,id+'.mp4'))),missing=ids.filter(id=>!todo.includes(id));
 console.log(`${todo.length} labelled videos to re-extract; no local file for ${missing.length}${missing.length?': '+missing.join(' '):''}`);if(dry)return;
 const queue=[...todo];await Promise.all(Array.from({length:JOBS},async()=>{while(queue.length)await run(queue.shift());}));fs.rmSync(tmp,{recursive:true,force:true});})();
