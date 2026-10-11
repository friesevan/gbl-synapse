'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {play}=require('./engine-v4.cjs');
const {simulatorFixtures}=require('./simulator-fixtures.cjs');
const source=fs.readFileSync(path.join(__dirname,'reference/simulator-v4-pre-speed.js'),'utf8');
function original(args){
 const archetypes=require('./vendor/aiArchetypes.json');
 const ctx=vm.createContext({structuredClone,console:{log(){}},Math:Object.create(Math),host:'localhost',webRoot:'',siteVersion:'training',settings:{colorblindMode:false,hardMovesetLinks:false},data:structuredClone(require('../includes/pro/data/gamemaster.json')),$:{ajax(){},getJSON(_url,cb){cb(archetypes);},each(items,cb){for(let i=0;i<items.length;i++)if(cb(i,items[i])===false)break;}}});
 vm.runInContext(source,ctx);ctx.args=args;
 const result=JSON.parse(JSON.stringify(vm.runInContext('play(...args)',ctx)));
 result.timeline?.forEach(e=>{delete e.values;delete e.detail;});return result;
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('optimized forecasts and headless battles preserve frozen v4 outcomes and every replay event',()=>{
 for(const args of simulatorFixtures(16)){
  const opts={...args[4],trace:true,audit:true};
  const reference=original([...args.slice(0,4),opts]);
  const traced=plain(play(...args.slice(0,4),opts));
  assert.equal(reference.timedOut,false);assert.deepEqual(traced,reference,'frozen reference seed '+opts.seed);
  const headless=plain(play(...args.slice(0,4),{...opts,trace:false}));
  const expected={...reference};delete expected.samples;delete expected.teamStats;delete expected.timeline;delete expected.traceScore;
  assert.deepEqual(headless,expected,'headless seed '+opts.seed);
 }
});
test('optimization toggle preserves complete traced state and independent seeded replay',()=>{
 for(const args of simulatorFixtures(6)){
  const opts={...args[4],trace:true,audit:true};
  const optimized=play(...args.slice(0,4),opts),baseline=play(...args.slice(0,4),{...opts,simulationOptimizations:false});
  assert.deepEqual(plain(optimized),plain(baseline));
  assert.deepEqual(plain(optimized),plain(play(...args.slice(0,4),opts)));
 }
});
