'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {frames}=require('./meta-benchmark/probe.cjs');
async function fake(mode,requireTimes=true){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'probe-stream-test-')),prior=process.env.PATH;
 const code=`#!/usr/bin/env node
 const mode=${JSON.stringify(mode)};
 process.stdout.write(Buffer.alloc(mode==='partial'?24:mode==='missing-index'?48:32));
 if(mode!=='missing-time')process.stderr.write('[showinfo] n: 0 pts_time:0\\n'+(mode==='missing-index'?'[showinfo] n: 2 pts_time:12\\n':'[showinfo] n: 1 pts_time:6\\n'));
 process.exitCode=mode==='failed'?1:0;
 `;fs.writeFileSync(path.join(dir,'ffmpeg'),code,{mode:0o755});process.env.PATH=dir+path.delimiter+prior;
 try{return await frames([],2,2,()=>{},{requireTimes});}
 finally{process.env.PATH=prior;fs.rmSync(dir,{recursive:true,force:true});}
}
test('complete raw frames and all showinfo source times are returned exactly',async()=>{
 const result=await fake('complete');assert.equal(result.count,2);assert.deepEqual(result.times,[0,6]);
});
test('decoder nonzero exit with complete frames rejects instead of becoming no-HUD evidence',async()=>{
 await assert.rejects(fake('failed'),/Incomplete keyframe stream/);
});
test('partial final frame rejects instead of screening only a prefix of the footage',async()=>{
 await assert.rejects(fake('partial'),/8 trailing bytes/);
});
test('missing timestamps including sparse middle indices reject before range generation',async()=>{
 await assert.rejects(fake('missing-time'),/Incomplete keyframe timestamps/);
 await assert.rejects(fake('missing-index'),/Incomplete keyframe timestamps/);
});
test('locating pass without showinfo does not require timestamps',async()=>{
 const result=await fake('missing-time',false);assert.equal(result.count,2);
});
