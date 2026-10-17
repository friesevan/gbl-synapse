'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base=path.resolve(__dirname,'../../includes/pro');
function engine(){
 const c=vm.createContext({console:{log(){}},Math:Object.create(Math),host:'localhost',webRoot:'',siteVersion:'test',settings:{colorblindMode:false,hardMovesetLinks:false},$:{ajax(){},getJSON(){},each(rows,cb){for(let n=0;n<rows.length;n++)if(cb(n,rows[n])===false)break;}}});
 for(const name of ['GameMaster','DamageCalculator','ActionLogic','TimelineEvent','TimelineAction','DecisionOption','Battle','Pokemon'])vm.runInContext(fs.readFileSync(path.join(base,'vendor',name+'.js'),'utf8'),c);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'lookahead.js'),'utf8'),c);c.data=structuredClone(require('../../includes/pro/data/gamemaster.json'));
 vm.runInContext('var gm=GameMaster.getInstance();gm.data=data;gm.originalData=data;gm.createSearchMaps();gm.rankings={};installTeamSimulationSafety();',c);
 return c;
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('decision snapshots advance active cooldowns and both clocks, preserving bench state',()=>{
 const c=engine(),s=[{active:1,timer:1000,team:[{cooldown:1500},{cooldown:1000}]},{active:0,timer:100,team:[{cooldown:1500},{cooldown:2000}]}];
 assert.deepEqual(plain(c.advanceTeamLookaheadState(s)),[{active:1,timer:500,team:[{cooldown:1500},{cooldown:500}]},{active:0,timer:0,team:[{cooldown:1000},{cooldown:2000}]}]);
});
test('only available switches are modeled, including cooldown restrictions and forced replacements',()=>{
 const c=engine(),s={active:0,timer:0,team:[{id:'b',hp:10,cooldown:500},{id:'a',hp:20,cooldown:0},{id:'c',hp:0,cooldown:0}]};
 assert.deepEqual(plain(c.legalTeamLookaheadChoices(s,false)),[0]);s.team[0].cooldown=0;assert.deepEqual(plain(c.legalTeamLookaheadChoices(s,false)),[1,0]);
 s.timer=45000;assert.deepEqual(plain(c.legalTeamLookaheadChoices(s,false)),[0]);s.team[0].hp=0;assert.deepEqual(plain(c.legalTeamLookaheadChoices(s,true)),[1]);
});
test('cloned transformed Pokémon retain CPM, live stats, shields and exactly one native stage',()=>{
 const c=engine();vm.runInContext(`var b=new Battle();b.setCP(1500);var p=new Pokemon('mimikyu',0,b);p.initialize(1500);p.changeForm('mimikyu_busted');p.hp=51;p.energy=37;p.cooldown=1000;p.shields=1;p.statBuffs=[2,-2];var row=captureTeamLookaheadPokemon(p);var q=createTeamLookaheadPokemon(row,0,b);`,c);
 assert.deepEqual(plain(c.captureTeamLookaheadPokemon(c.q)),plain(c.row));c.q.reset();c.q.reset();assert.deepEqual(plain(c.q.statBuffs),[2,-2]);
 const expected=c.q.getFormStats('mimikyu').atk;assert.equal(expected,c.p.getFormStats('mimikyu').atk);assert.equal(c.q.cpm,c.p.cpm);
});
test('native defense stage is not repeatedly added by form resets',()=>{
 const c=engine();vm.runInContext(`var b=new Battle();var p=new Pokemon('mimikyu',0,b);p.initialize(1500);p.changeForm('mimikyu_busted');p.startFormId='mimikyu_busted';p.startStatBuffs=[0,0];p.reset();`,c);
 assert.deepEqual(plain(c.p.statBuffs),[0,-1]);c.p.reset();assert.deepEqual(plain(c.p.statBuffs),[0,-1]);
});
test('hypothetical switching clears outgoing battle stages and resets transient forms without losing HP or energy',()=>{
 const c=engine();vm.runInContext(`var b=new Battle();b.setCP(1500);var p=new Pokemon('morpeko_full_belly',0,b);p.initialize(1500);p.changeForm('morpeko_hangry');p.hp=55;p.energy=61;p.statBuffs=[2,-2];var q=new Pokemon('melmetal',0,b);q.initialize(1500);q.cooldown=1000;q.startCooldown=1000;var teams=[[p,q]];prepareTeamLookaheadSwitch(teams,[{active:0}],[1]);`,c);
 assert.equal(c.p.activeFormId,'morpeko_full_belly');assert.deepEqual(plain(c.p.statBuffs),[0,0]);assert.deepEqual(plain(c.p.startStatBuffs),[0,0]);assert.equal(c.p.hp,55);assert.equal(c.p.energy,61);assert.equal(c.q.cooldown,0);assert.equal(c.q.startCooldown,0);
});
test('isolated Champion scouting leaves live form, stages, starting values and battle binding untouched',()=>{
 const c=engine();vm.runInContext(`var b=new Battle();b.setCP(1500);var p=new Pokemon('mimikyu',0,b);p.initialize(1500);p.changeForm('mimikyu_busted');p.hp=52;p.energy=35;p.shields=1;p.statBuffs=[1,-2];p.startFormId='mimikyu';var q=new Pokemon('morpeko_full_belly',1,b);q.initialize(1500);q.energy=31;q.shields=2;q.changeForm('morpeko_hangry');var before=JSON.stringify([captureTeamLookaheadPokemon(p),captureTeamLookaheadPokemon(q),p.startHp,p.startEnergy,p.startFormId,q.startFormId]);var ai={};isolateTeamScenarioScouting(ai,{cp:1500});var scenario=ai.runScenario('NO_BAIT',p,q);var after=JSON.stringify([captureTeamLookaheadPokemon(p),captureTeamLookaheadPokemon(q),p.startHp,p.startEnergy,p.startFormId,q.startFormId]);`,c);
 assert.equal(c.before,c.after);assert.equal(c.p.getBattle(),c.b);assert.equal(c.q.getBattle(),c.b);assert.equal(c.scenario.matchups.length,6);assert.ok(Number.isFinite(c.scenario.average));
});
test('lookahead lock expiry includes charged-sequence elapsed time rather than only fast turns',()=>{
 const c=engine(),instant={name:'Instant',hasTag:()=>true},normal={name:'Normal',hasTag:()=>false};
 const b={getDuration:()=>99999,getTurns:()=>3,getPokemon:()=>[{chargedMovePool:[instant,normal],chargedMoves:[]}],getTimeline:()=>[{type:'charged water',name:'Normal'},{type:'charged rock',name:'Instant'},{type:'fast water',name:'Fast'}]};
 assert.equal(c.teamLookaheadElapsed(b),14000);
});
test('equivalent scouting scenarios are cached without consuming policy randomness or leaking mutable arrays',()=>{
 const c=engine();vm.runInContext(`var calls=0;Math.random=()=>{calls++;return .25;};var b=new Battle();b.setCP(1500);var p=new Pokemon('melmetal',0,b);p.initialize(1500);p.shields=1;var q=new Pokemon('cramorant',1,b);q.initialize(1500);q.shields=1;var ai={},options={cp:1500};isolateTeamScenarioScouting(ai,options);var one=ai.runScenario('NO_BAIT',p,q);one.matchups[0]=-1;var two=ai.runScenario('NEITHER_BAIT',p,q);`,c);
 assert.equal(c.calls,0);assert.equal(c.options.scoutingCache.size,1);assert.equal(c.two.name,'NEITHER_BAIT');assert.notEqual(c.two.matchups[0],-1);
 c.p.hp--;c.ai.runScenario('NO_BAIT',c.p,c.q);assert.equal(c.options.scoutingCache.size,2);assert.equal(c.calls,0);
});
// v4 controller options (lookahead-v4.js, <controller-options>): pure helpers, evaluated the way the battle VM loads them.
function v4(){const c=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'lookahead-v4.js'),'utf8'),c);return c;}
test('weighted replies: an exact softmax expectation over the opponent\'s own values, tending to the worst case',()=>{
 const c=v4(),w=(values,t)=>c.teamWeightedReply(values,t),close=(x,y)=>assert.ok(Math.abs(x-y)<1e-12,x+' vs '+y);
 // Opponent utility is the rollout value negated: the reply worst for the decider gets the largest weight.
 const values=[.4,-.2,1.1],t=.25,u=values.map(v=>Math.exp(-v/t)),expected=values.reduce((s,v,i)=>s+v*u[i],0)/u.reduce((s,x)=>s+x,0);
 close(w(values,t),expected);assert.ok(w(values,t)>Math.min(...values)&&w(values,t)<values.reduce((s,v)=>s+v,0)/3);
 assert.equal(w(values,1e-9),-.2);assert.equal(w([.3,.3,.3],.25),.3);assert.ok(Math.abs(w(values,1e9)-values.reduce((s,v)=>s+v,0)/3)<1e-8);
 assert.equal(w([],.25),Infinity);assert.equal(w([-10,10],.25),-10);
 // The order of the replies does not matter beyond floating-point summation, and the result is reproducible.
 close(w([1.1,.4,-.2],t),w(values,t));assert.equal(w(values,t),w(values,t));
});
test('controller settings: defaults, battle-wide options, per-side overrides and validation',()=>{
 const c=v4(),plain=x=>JSON.parse(JSON.stringify(x));
 assert.deepEqual(plain(c.teamControllerSettings({seed:4,horizon:24},0)),{replyModel:'worst',replyTemperature:.25,rolloutContinuation:0,switchMargin:.08,shieldPolicy:'default'});
 const o={replyModel:'weighted',controllerTeams:[null,{replyModel:'worst',shieldPolicy:'never'}]};
 assert.equal(c.teamControllerSettings(o,0).replyModel,'weighted');assert.equal(c.teamControllerSettings(o,1).replyModel,'worst');assert.equal(c.teamControllerSettings(o,1).shieldPolicy,'never');
 assert.equal(c.teamControllerIdentity({replyModel:'worst',replyTemperature:3}),null);
 assert.equal(c.teamControllerSuffix({replyModel:'weighted'}),'+controller:replyModel=weighted,replyTemperature=0.25');
 assert.equal(c.teamControllerSuffix({rolloutContinuation:8,replyModel:'weighted',replyTemperature:.5}),'+controller:replyModel=weighted,replyTemperature=0.5,rolloutContinuation=8');
 assert.equal(c.teamControllerSuffix({}),'');assert.throws(()=>c.teamControllerSuffix({controllerTeams:[{switchMargin:0},null]}),/Per-side/);
 assert.deepEqual(plain(c.teamControllerSideKeys({controllerTeams:[{switchMargin:0},{switchMargin:0}]})),[null,null]);
 assert.deepEqual(plain(c.teamControllerSideKeys({controllerTeams:[null,{shieldPolicy:'never'}]})),[null,{shieldPolicy:'never'}]);
 assert.throws(()=>c.teamControllerSettings({controllerTeams:[{replyModle:'weighted'},null]},0),/unknown controller option/);
 assert.throws(()=>c.teamControllerSettings({rolloutContinuation:30},0),/rolloutContinuation/);
});
test('Node, the battle VM and the browser adapter share one controller-options source',()=>{
 const node=require('./controller-options.cjs'),c=v4(),source=fs.readFileSync(path.join(__dirname,'lookahead-v4.js'),'utf8');
 assert.ok(source.includes(node.section()));
 for(const o of [{},{replyModel:'weighted'},{rolloutContinuation:3,switchMargin:0},{shieldPolicy:'always',controllerTeams:[null,{replyModel:'weighted'}]}])for(const side of [0,1])assert.deepEqual(node.teamControllerSettings(o,side),JSON.parse(JSON.stringify(c.teamControllerSettings(o,side))));
 assert.equal(node.searchController({replyModel:'worst',replyTemperature:.25,rolloutContinuation:0}),null);
 assert.deepEqual(node.searchController({replyModel:'weighted',replyTemperature:.5,rolloutContinuation:8}),{replyModel:'weighted',replyTemperature:.5,rolloutContinuation:8});
 assert.equal(node.describe(null),'default');
});
