'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),zlib=require('node:zlib');
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync('includes/pro/neural-portable.js','utf8'),ctx);
test('analysis compares new proposals with weighted early/late means and excludes initialization',()=>{
 const r=(n,mean,teams=1)=>({round:n,proposalScores:[{source:'neural',meanScore:mean,teams},{source:'random',meanScore:.3,teams:1}]});const h=[{round:0,proposalScores:[{source:'initial',meanScore:.1,teams:128}]},r(1,.5),r(2,.7,3),r(3,.6),r(4,.6),r(5,.6),r(6,.6),r(7,.6),r(8,.6)];const a=ctx.NeuralPortable.analyze(h);
 assert.equal(a.rounds.length,8);assert.ok(Math.abs(a.phases[0].neural-.65)<1e-12);assert.ok(Math.abs(a.phases[2].neural-.6)<1e-12);assert.ok(Math.abs(a.rolling[1].neuralAverage-.65)<1e-12);
 assert.equal(ctx.NeuralPortable.analyze([]).rounds.length,0);
});
test('published report plateau analysis is computed from the saved run',()=>{
 const d=JSON.parse(zlib.gunzipSync(fs.readFileSync('includes/pro/data/team-v3-refined.pvpteams.json.gz'))),a=ctx.NeuralPortable.analyze(d.history);
 assert.equal(a.rounds.length,153);assert.ok(a.phases[0].neural>.60&&a.phases[0].neural<.61);assert.ok(a.phases[2].neural>.59&&a.phases[2].neural<.61);assert.ok(Math.abs(a.phases[2].neural-a.phases[0].neural)<.02);
});
