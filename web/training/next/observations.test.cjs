'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
// `extra`: controller options (lookahead-v4.js <controller-options>) merged into the battle options; none by default.
function setup(hidden=false,side=0,extra={}){
 const root=path.resolve(__dirname,'../..'),c=vm.createContext({Math:Object.create(Math),console:{log(){}},host:'localhost',webRoot:'',siteVersion:'test',settings:{hardMovesetLinks:false,colorblindMode:false},$:{ajax(){},getJSON(){},each(a,cb){a.forEach((p,i)=>cb(i,p));}}});
 for(const n of ['GameMaster','DamageCalculator','ActionLogic','TimelineEvent','TimelineAction','DecisionOption','Battle','Pokemon'])vm.runInContext(fs.readFileSync(path.join(root,'includes/pro/vendor',n+'.js'),'utf8'),c);
 for(const f of ['training/vendor/TrainingAI.js','training/vendor/Player.js','training/next/lookahead-v4.js','training/next/observations.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c);
 c.gmData=structuredClone(require('../../includes/pro/data/gamemaster.json'));c.ranks=require('../../includes/pro/data/league-1500.json').overall;c.hidden=hidden;c.side=side;c.extra=extra;
 vm.runInContext(`var gm=GameMaster.getInstance();gm.data=gmData;gm.originalData=gmData;gm.createSearchMaps();gm.rankings={};installTeamSimulationSafety();var b=new Battle();b.setCP(1500);var players=[new Player(0,3,b),new Player(1,3,b)];var own=ranks.slice(0,3),opp=[ranks[3],...(hidden?ranks.slice(20,22):ranks.slice(4,6))];[side===0?own:opp,side===0?opp:own].forEach((rows,i)=>{var team=rows.map(row=>{var p=new Pokemon(row.speciesId,i,b);p.initialize(1500);p.selectMove('fast',row.moveset[0]);p.selectMove('charged',row.moveset[1],0);p.selectMove('charged',row.moveset[2],1);return p;});players[i].setRoster(team);players[i].setTeam(team);});b.setPlayers(players);players.forEach((p,i)=>b.setNewPokemon(p.getTeam()[0],i,false));var prior=ranks.map(row=>({speciesId:row.speciesId,dex:gmData.pokemon.find(p=>p.speciesId===row.speciesId).dex,moveset:row.moveset,weight:1}));var options={cp:1500,seed:42,horizon:8,interval:4,audit:true,beliefRoster:prior,beliefSamples:2};Object.assign(options,extra);var stats=installTeamLookahead(b,players,options);var enemy=b.getPokemon()[1-side];if(hidden){enemy.energy=97;enemy.selectMove('charged',enemy.chargedMovePool.at(-1).moveId,1);}var ai=players[side].getAI();var poison=new Proxy({}, {get(){throw Error('Read a private opponent argument');}});var action=ai.decideAction(4,b.getPokemon()[side],poison);var shield=ai.decideShield(poison,b.getPokemon()[side],poison);var view=stats.observed()[side];`,c);
 return c;
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('hidden bench, unrevealed moves and exact energy do not affect action or shield decisions',()=>{
 const a=setup(),b=setup(true);assert.equal(a.action.type,b.action.type);assert.equal(a.action.value,b.action.value);assert.equal(a.shield,b.shield);assert.deepEqual(plain(a.view),plain(b.view));assert.equal(a.view.seen.length,1);assert.equal(a.view.seen[0].energy,0);assert.deepEqual(plain(a.view.seen[0].charged),[]);
});
test('observation-only choices are independent of physical side',()=>{const a=setup(false,0),b=setup(false,1);assert.equal(a.action.type,b.action.type);assert.equal(a.action.value,b.action.value);assert.equal(a.shield,b.shield);assert.deepEqual(plain(a.view),plain(b.view));});
test('energy and moves update only after observed resolution and persist through switching',()=>{
 const c=setup();vm.runInContext(`var k=teamObservedKnowledge(options);k.reveal({speciesId:'melmetal',form:'melmetal',hpFraction:1,buffs:[0,0]});k.attack('melmetal','THUNDER_SHOCK',1);k.attack('melmetal','THUNDER_SHOCK',3);var before=k.view();k.attack('melmetal','DOUBLE_IRON_BASH',4);var after=k.view();k.reveal({speciesId:'altaria',form:'altaria',hpFraction:1,buffs:[0,0]});k.reveal({speciesId:'melmetal',form:'melmetal',hpFraction:.7,buffs:[0,0]});var returned=k.view();`,c);
 assert.equal(c.before.seen[0].energy,18);assert.equal(c.before.seen[0].fast,'THUNDER_SHOCK');assert.equal(c.before.seen[0].charged.length,0);assert.deepEqual(plain(c.after.seen[0].charged),['DOUBLE_IRON_BASH']);assert.equal(c.returned.seen.length,2);assert.equal(c.returned.seen[0].hpFraction,.7);
});
test('joint prior conditions on observed lead and revealed members; forecasts never inspect real bench',()=>{
 const c=setup();vm.runInContext(`options.beliefTeams=[['melmetal','altaria','cramorant'],['melmetal','altaria','quagsire'],['altaria','melmetal','tinkaton']];var k=teamObservedKnowledge(options);k.reveal({speciesId:'melmetal',form:'melmetal',hpFraction:1,buffs:[0,0]});k.reveal({speciesId:'altaria',form:'altaria',hpFraction:1,buffs:[0,0]});var worlds=k.hypotheses(1,b,4,()=>.1,2);`,c);
 assert.ok(c.worlds.every(w=>w.team.map(p=>p.speciesId).sort().join(',')==='altaria,cramorant,melmetal'));assert.ok(c.worlds.every(w=>w.team[w.active].speciesId==='altaria'));
});
// Every controller option keeps the information boundary: hidden bench, unrevealed moves and exact energy change
// neither the decisions nor the observation record, on either physical side, battle-wide or for the decider only.
const CONTROLLER_OPTIONS=[{replyModel:'weighted'},{replyModel:'weighted',replyTemperature:3},{rolloutContinuation:8},{replyModel:'weighted',rolloutContinuation:4},{switchMargin:0},{switchMargin:1e9},{shieldPolicy:'always'},{shieldPolicy:'never'}];
test('counterfactual hidden state leaves decisions unchanged under every controller option',()=>{
 for(const option of CONTROLLER_OPTIONS)for(const side of [0,1])for(const extra of [option,{controllerTeams:side===0?[option,null]:[null,option]}]){
  const a=setup(false,side,extra),b=setup(true,side,extra),label=JSON.stringify(extra)+' side '+side;
  assert.equal(a.action.type,b.action.type,label);assert.equal(a.action.value,b.action.value,label);assert.equal(a.shield,b.shield,label);assert.deepEqual(plain(a.view),plain(b.view),label);
 }
});
test('shield policies decide from the shield count alone; switch margins and reply models stay side independent',()=>{
 assert.equal(setup(false,0,{shieldPolicy:'always'}).shield,true);assert.equal(setup(true,1,{shieldPolicy:'always'}).shield,true);
 assert.equal(setup(false,0,{shieldPolicy:'never'}).shield,false);assert.equal(setup(true,1,{shieldPolicy:'never'}).shield,false);
 for(const extra of CONTROLLER_OPTIONS){const a=setup(false,0,extra),b=setup(false,1,extra);assert.equal(a.action.type,b.action.type,JSON.stringify(extra));assert.equal(a.action.value,b.action.value);assert.equal(a.shield,b.shield);assert.deepEqual(plain(a.view),plain(b.view));}
});
