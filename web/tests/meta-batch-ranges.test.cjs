'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-ranges-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const file of ['run-batch.cjs','range-plan.cjs'])fs.copyFileSync(path.join(__dirname,'meta-benchmark',file),path.join(dir,file));
 fs.writeFileSync(path.join(dir,'ffprobe'),'#!/usr/bin/env node\nconsole.log(2400);\n',{mode:0o755});
 fs.writeFileSync(path.join(dir,'run-node.cjs'),`const fs=require('node:fs');const e=process.env;fs.appendFileSync(e.CALLS,JSON.stringify({start:e.START,end:e.END,ranges:e.RANGES})+'\\n');const ranges=e.RANGES?e.RANGES.split(',').map(r=>r.split('-').map(Number)):null;const seconds=ranges?ranges.reduce((n,[a,b])=>n+b-a,0):Number(e.END)-Number(e.START);fs.writeFileSync(process.argv[3],JSON.stringify({pipeline:'fixture',recording:'video',seconds:1,videoSeconds:seconds,realtime:seconds,battles:[],full:[],metrics:{frames:seconds*10},ranges}));`);
 return {dir,run(line,env={}){
  fs.writeFileSync(path.join(dir,'jobs.txt'),line+'\n');
  const result=spawnSync(process.execPath,[path.join(dir,'run-batch.cjs'),path.join(dir,'jobs.txt'),path.join(dir,'out')],{encoding:'utf8',env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,JOBS:'1',SPLIT:'20',RANGES:'',FORCE_FULL:'',CALLS:path.join(dir,'calls'),...env}});
  return {...result,calls:fs.existsSync(path.join(dir,'calls'))?fs.readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').map(JSON.parse):[],summary:fs.existsSync(path.join(dir,'out','batch-summary.json'))?JSON.parse(fs.readFileSync(path.join(dir,'out','batch-summary.json'))):null};
 }};
}
test('batch clips inherited ranges per overlapping chunk and reports actual decoded work',t=>{
 const f=fixture(t),r=f.run('/video.mp4|1500||',{RANGES:'50-55,1300-1302'});
 assert.equal(r.status,0,r.stderr);assert.deepEqual(r.calls,[{start:'0',end:'1560',ranges:'50-55,1300-1302'},{start:'1200',end:'2400',ranges:'1300-1302'}]);
 assert.equal(r.summary.avoidedVideoSeconds,2751);
 const merged=JSON.parse(fs.readFileSync(path.join(f.dir,'out','video.json')));
 assert.equal(merged.videoSeconds,9);assert.equal(merged.sourceDuration,2400);assert.equal(merged.realtime,4.5);assert.equal(merged.chunkMetrics.length,2);
});
test('empty chunks create mergeable results without launching a decoder',t=>{
 const f=fixture(t),r=f.run('/video.mp4|1500|||[[50,55]]');
 assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,1);
 const second=JSON.parse(fs.readFileSync(path.join(f.dir,'out','video.part1.json')));
 assert.equal(second.videoSeconds,0);assert.deepEqual(second.full,[]);
});
test('reviewer force-full overrides per-video plans and clears inherited ranges',t=>{
 const r=fixture(t).run('/video.mp4|1500|||stale-malformed-plan',{FORCE_FULL:'1',RANGES:'stale-malformed-environment'});
 assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,2);assert.ok(r.calls.every(c=>c.ranges===''));assert.equal(r.summary.avoidedVideoSeconds,0);
});
test('invalid plans fail before any classifier process starts',t=>{
 const r=fixture(t).run('/video.mp4|1500|||[[50,40]]');
 assert.notEqual(r.status,0);assert.equal(r.calls.length,0);
});
