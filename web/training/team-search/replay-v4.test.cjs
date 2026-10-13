'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {play,defaults}=require('../engine-v4.cjs'),{mechanicsHash,dataHash}=require('./common.cjs');
const base=path.resolve(__dirname,'../../includes/pro');
function prior(){const d=require('../../includes/pro/data/gamemaster.json'),r=require('../../includes/pro/data/league-1500.json').overall;return r.slice(0,300).map(p=>({speciesId:p.speciesId,dex:d.pokemon.find(q=>q.speciesId===p.speciesId).dex,moveset:p.moveset,weight:1}));}
function replay(a,b,seed,options={}){options={beliefRoster:prior(),...options};
 const archetypes=require('../vendor/aiArchetypes.json'),ctx=vm.createContext({structuredClone,console:{log(){}},Math:Object.create(Math),host:'localhost',webRoot:'',siteVersion:'training',settings:{colorblindMode:false,hardMovesetLinks:false},data:structuredClone(require('../../includes/pro/data/gamemaster.json')),$:{ajax(){},getJSON(url,cb){cb(archetypes);},each(items,cb){for(let i=0;i<items.length;i++)if(cb(i,items[i])===false)break;}}});
 ctx.importScripts=(...files)=>files.forEach(f=>vm.runInContext(fs.readFileSync(path.join(base,f),'utf8'),ctx));
 ctx.importScripts('team-replay-v4-runtime.js','team-replay-v4-manifest.js');
 assert.equal(ctx.NeuralReplayV4.mechanicsHash,mechanicsHash({version:'v4'}));assert.equal(ctx.NeuralReplayV4.dataHash,dataHash());
 ctx.request={a,b,seed,options};return vm.runInContext('play(request.a,request.b,defaults,defaults,{...request.options,seed:request.seed,trace:true})',ctx);
}
test('generated v4 browser replay preserves the exact training outcome and complete graph on either side',()=>{
 const d=require('../../includes/pro/data/team-teams/index.json'),a=d.rows[0].team.map(i=>d.variants[i]),b=d.opponents.slice(0,3);
 for(const [x,y,seed] of [[a,b,17],[b,a,17],[a,b,551],[a,a,19]]){
  const training=play(x,y,defaults,defaults,{seed,beliefRoster:prior()}),traced=play(x,y,defaults,defaults,{seed,trace:true,beliefRoster:prior()}),browser=replay(x,y,seed);
  assert.equal(traced.score,training.score);assert.equal(traced.turns,training.turns);
  const plain=JSON.parse(JSON.stringify(browser));plain.timeline.forEach(e=>{delete e.values;delete e.detail;});assert.deepEqual(plain,JSON.parse(JSON.stringify(traced)));
  assert.ok(browser.timeline.filter(e=>e.type.startsWith('charged ')).every(e=>e.detail&&e.values));
  assert.ok(browser.samples.length>3);assert.equal(browser.teamStats.length,2);
  assert.ok(browser.samples.every(s=>s[2].length===6&&s[2].every(hp=>hp>=0)));
 }
});
test('one browser worker compares multiple fixtures and accepts subsequent replay requests without redeclaring globals',async()=>{
 const d=require('../../includes/pro/data/team-teams/index.json'),a=d.rows[0].team.map(i=>d.variants[i]),b=d.opponents.slice(0,3),messages=[];
 const ctx=vm.createContext({structuredClone,console:{log(){}},Math:Object.create(Math),fetch:async file=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(base,file),'utf8'))}),postMessage:m=>messages.push(JSON.parse(JSON.stringify(m)))});
 ctx.importScripts=(...files)=>files.forEach(f=>vm.runInContext(fs.readFileSync(path.join(base,f),'utf8'),ctx));ctx.importScripts('team-replay-v4-worker.js');
 const options={lookahead:true,horizon:8,interval:4,neutralPriority:true,beliefRoster:prior()};
 await ctx.onmessage({data:{mode:'compare',explain:true,teams:[a,b],fixtures:[{opponent:b,opponents:[0,1,2],seed:17},{opponent:a,opponents:[3,4,5],seed:551}],mechanicsHash:mechanicsHash({version:'v4'}),dataHash:dataHash(),engineOptions:options}});
 assert.ok(!messages.some(m=>m.error),JSON.stringify(messages));const rows=messages.at(-1).rows;assert.equal(rows.length,2);assert.ok(rows[0].evidence.a.some(e=>e.detail));
 for(const [i,opponent,seed] of [[0,b,17],[1,a,551]]){assert.equal(rows[i].a,play(a,opponent,defaults,defaults,{...options,seed}).score);assert.equal(rows[i].b,play(b,opponent,defaults,defaults,{...options,seed}).score);}
 messages.length=0;await ctx.onmessage({data:{teams:[a,b],seed:17,mechanicsHash:mechanicsHash({version:'v4'}),dataHash:dataHash(),engineOptions:options}});
 assert.ok(!messages.some(m=>m.error),JSON.stringify(messages));assert.equal(messages.at(-1).pairedScore,rows[0].a);assert.ok(messages.at(-1).a.samples.length>3);
});
test('a run with non-default controller options replays exactly in the browser, and only under its own identity',async()=>{
 const d=require('../../includes/pro/data/team-teams/index.json'),a=d.rows[0].team.map(i=>d.variants[i]),b=d.opponents.slice(0,3);
 const controller={replyModel:'weighted',replyTemperature:.25,rolloutContinuation:8},options={beliefRoster:prior(),...controller};
 for(const [x,y,seed] of [[a,b,17],[b,a,551]]){
  const traced=play(x,y,defaults,defaults,{...options,seed,trace:true}),browser=replay(x,y,seed,options);
  const plain=JSON.parse(JSON.stringify(browser));plain.timeline.forEach(e=>{delete e.values;delete e.detail;});assert.deepEqual(plain,JSON.parse(JSON.stringify(traced)));
  assert.ok(traced.planner.continuations>0);
 }
 // The worker accepts a variant report only with the variant's mechanics id, and never a default report claiming it.
 const messages=[],ctx=vm.createContext({structuredClone,console:{log(){}},Math:Object.create(Math),fetch:async file=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(base,file),'utf8'))}),postMessage:m=>messages.push(JSON.parse(JSON.stringify(m)))});
 ctx.importScripts=(...files)=>files.forEach(f=>vm.runInContext(fs.readFileSync(path.join(base,f),'utf8'),ctx));ctx.importScripts('team-replay-v4-worker.js');
 const variant=mechanicsHash({version:'v4',controller}),send=(hash,engineOptions)=>{messages.length=0;return ctx.onmessage({data:{teams:[a,b],seed:17,mechanicsHash:hash,dataHash:dataHash(),engineOptions}});};
 assert.match(variant,/\+controller:replyModel=weighted,replyTemperature=0\.25,rolloutContinuation=8$/);
 await send(mechanicsHash({version:'v4'}),options);assert.match(messages.at(-1).error||'',/different simulator/);
 await send(variant,{beliefRoster:prior()});assert.match(messages.at(-1).error||'',/different simulator/);
 await send(variant,options);assert.ok(!messages.some(m=>m.error),JSON.stringify(messages));assert.equal(messages.at(-1).pairedScore,play(a,b,defaults,defaults,{...options,seed:17}).score);
 // The page's pre-check (neural-portable.js) uses the same identity.
 const page=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(base,'neural-portable.js'),'utf8'),page);vm.runInContext(fs.readFileSync(path.join(base,'team-replay-v4-manifest.js'),'utf8'),page);
 assert.equal(page.NeuralPortable.expectedMechanics({engineVersion:'neural-team-search-v4',engineOptions:options},page.NeuralReplayV4),variant);
 assert.equal(page.NeuralPortable.expectedMechanics({engineVersion:'neural-team-search-v4',engineOptions:{beliefRoster:[]}},page.NeuralReplayV4),mechanicsHash({version:'v4'}));
 assert.equal(page.NeuralPortable.expectedMechanics({engineVersion:'neural-team-search-v4',engineOptions:{controllerTeams:[{switchMargin:0},null]}},page.NeuralReplayV4),null);
});
