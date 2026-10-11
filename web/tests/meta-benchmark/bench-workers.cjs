#!/usr/bin/env node
// Extraction throughput (video-seconds per wall-second) for worker counts × ffmpeg decoder threads.
// Each worker runs run-node.cjs on its own SEG-second slice of the given videos, all at once, so the
// machine is loaded like the harvester's extract pool. Run it on an otherwise idle machine.
//
// Usage: node bench-workers.cjs VIDEO[,VIDEO...] [CROP]
//   WORKERS=4,6,8,12  THREADS=1,2,auto  SEG=120   → prints one line per configuration, then JSON
'use strict';
const os=require('node:os'),fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const [videos,crop='auto']=process.argv.slice(2);if(!videos){console.error('usage: node bench-workers.cjs VIDEO[,VIDEO...] [CROP]');process.exit(2);}
const list=videos.split(','),SEG=Number(process.env.SEG||120),WORKERS=(process.env.WORKERS||'4,6,8,12').split(',').map(Number),THREADS=(process.env.THREADS||'1,2,auto').split(',');
const dur=v=>Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',v]).toString());
const slices=[];for(const v of list){const d=dur(v);for(let s=0;s+SEG<=d;s+=SEG)slices.push([v,s]);}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bench-workers-'));
function run(n,threads){return new Promise(resolve=>{const t0=Date.now();let left=n,cpu=0;
 for(let i=0;i<n;i++){const [v,s]=slices[i%slices.length],env={...process.env,START:String(s),END:String(s+SEG),CROP:crop};if(threads!=='auto')env.FFMPEG_THREADS=threads;
  const p=spawn(process.execPath,[path.join(__dirname,'run-node.cjs'),v,path.join(tmp,`w${i}.json`)],{env,stdio:'ignore'});
  p.on('close',()=>{if(--left===0)resolve({workers:n,threads,wall:(Date.now()-t0)/1000,videoSeconds:n*SEG});});}});}
(async()=>{const rows=[];for(const n of WORKERS)for(const th of THREADS){const r=await run(n,th);r.throughput=+(r.videoSeconds/r.wall).toFixed(2);rows.push(r);
  console.log(`workers ${n} threads ${th}: ${r.videoSeconds} video-s in ${r.wall.toFixed(0)} s = ${r.throughput}x real time (load ${os.loadavg()[0].toFixed(1)})`);}
 fs.rmSync(tmp,{recursive:true,force:true});console.log(JSON.stringify(rows));})();
