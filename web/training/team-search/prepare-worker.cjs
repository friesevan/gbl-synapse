'use strict';
const {parentPort}=require('node:worker_threads'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {TYPES}=require('./common.cjs');const base=path.resolve(__dirname,'../../includes/pro');
const data=JSON.parse(fs.readFileSync(path.join(base,'data/gamemaster.json')));
function prepare(request){
 const {row,targets,maxMovesets,shortlist}=request;
 const context=vm.createContext({console:{log(){}},host:'localhost',webRoot:'',siteVersion:'team-search',settings:{colorblindMode:false,hardMovesetLinks:false},$:{ajax(){},each(items,cb){items.forEach((x,i)=>cb(i,x));}}});
 for(const f of ['core.js',...['GameMaster','DamageCalculator','ActionLogic','TimelineEvent','TimelineAction','DecisionOption','Battle','Pokemon'].map(n=>'vendor/'+n+'.js')])vm.runInContext(fs.readFileSync(path.join(base,f),'utf8'),context);
 context.input={...request,row,targets,maxMovesets,shortlist,data:structuredClone(data),types:TYPES};
 return vm.runInContext(`(()=>{
 const {row,targets,maxMovesets,shortlist,data,types,offset,chunkSize,mode}=input;
 const gm=GameMaster.getInstance();gm.data=data;gm.originalData=data;gm.createSearchMaps();gm.rankings={};
 const battle=new Battle();battle.setCP(1500);
 const make=(r,side)=>{const p=new Pokemon(r.speciesId,side,battle);p.initialize(1500);p.selectMove('fast',r.moveset[0]);p.selectMove('charged',r.moveset[1],0);p.selectMove('charged',r.moveset[2]||'none',1);if(r.moveset[3]&&p.hasThirdChargedMove())p.selectMove('extra-charged',r.moveset[3],2);return p;};
 const sample=make(row,0);
 const all=PvPPro.enumerate(sample.fastMovePool.map(m=>m.moveId),sample.chargedMovePool.map(m=>m.moveId),sample.hasThirdChargedMove()?sample.extraChargedMovePool.map(m=>m.moveId):[]);
 if(!all.length)throw Error('No legal movesets for '+row.speciesId);if(mode==='count')return {totalCombinations:all.length};
 const opponents=targets.map(t=>make(t,1)),candidateMoves=offset===undefined?all:all.slice(offset,offset+chunkSize);
 const damageCache=new Map();
 const projected=candidateMoves.map(moveset=>{const p=make({...row,moveset},0);let sum=0,total=0;
 targets.forEach((t,i)=>{if(t.speciesId===row.speciesId)return;const f=p.fastMove,key=f.moveId+'|'+i;let fd=damageCache.get(key);if(fd===undefined){fd=DamageCalculator.damage(p,opponents[i],f);damageCache.set(key,fd);}
 const rates=p.activeChargedMoves.map(m=>{const key=f.moveId+'|'+m.moveId+'|'+i;if(!damageCache.has(key))damageCache.set(key,PvPPro.cycleDpt({damage:fd,turns:f.cooldown/500,energyGain:f.energyGain},[{damage:DamageCalculator.damage(p,opponents[i],m),energy:m.energy}]));return damageCache.get(key);});
 sum+=Math.max(fd/(f.cooldown/500),...rates)*t.weight;total+=t.weight;});
 return {moveset,projection:sum/total};}).sort((a,b)=>b.projection-a.projection);
 const selected=offset===undefined?projected.slice(0,shortlist):projected;
 const recommended=projected.find(r=>PvPPro.sameMoveset(r.moveset,row.moveset));if(recommended&&!selected.includes(recommended))selected.push(recommended);
 let simulations=0;
 const records=selected.map(v=>{const p=make({...row,moveset:v.moveset},0);let sum=0,total=0;const byType=types.map(()=>[]),ratings=[];
 targets.forEach((t,j)=>{if(t.speciesId===row.speciesId){ratings.push(.5);return;}let value=0;
 for(const s of data.rankingScenarios){const op=opponents[j];battle.setNewPokemon(p,0,false);battle.setNewPokemon(op,1,false);p.reset();op.reset();p.startEnergy=s.energy[0]?Math.min(100,p.fastMove.energyGain*Math.max(1,Math.floor(s.energy[0]*500/p.fastMove.cooldown))):0;op.startEnergy=0;p.setShields(s.shields[0]);op.setShields(s.shields[1]);battle.simulate();value+=(p.hp/p.stats.hp+(op.stats.hp-op.hp)/op.stats.hp)/2;simulations++;}
 value/=data.rankingScenarios.length;ratings.push(value);sum+=value*t.weight;total+=t.weight;opponents[j].types.forEach(type=>{const i=types.indexOf(type);if(i>=0)byType[i].push(value);});});
 const scoutByType=byType.map(values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:.5);
 const f=p.fastMove,c=p.activeChargedMoves;
 const features=[...types.map(t=>p.types.includes(t)?1:0),p.stats.atk/200,p.stats.def/250,p.stats.hp/300,p.cp/1500,p.level/50,row.score/100,Math.log1p(row.weight)/Math.log(1001),
 ...types.map(t=>f.type===t?1:0),f.power*f.stab*p.shadowAtkMult/(f.cooldown/500)/20,f.energyGain/(f.cooldown/500)/10,f.cooldown/500/5,
 ...types.map(t=>c.some(m=>m.type===t)?1:0),...Array.from({length:3},(_,i)=>c[i]?c[i].energy/100:0),...Array.from({length:3},(_,i)=>c[i]?c[i].power*c[i].stab*p.shadowAtkMult/200:0),
 ...Array.from({length:3},(_,i)=>c[i]?Number(c[i].buffApplyChance||0):0),...ratings.slice(0,24)];
 return {...row,dex:p.dex,types:p.types,stats:{atk:p.stats.atk,def:p.stats.def,hp:p.stats.hp},ivs:p.ivs,level:p.level,cp:p.cp,moveset:v.moveset,projection:v.projection,scoutScore:sum/total,scoutByType,features,recommended:PvPPro.sameMoveset(v.moveset,row.moveset)};
 }).sort((a,b)=>b.scoutScore-a.scoutScore||b.projection-a.projection);
 return {records:records.slice(0,maxMovesets),recommended:records.find(r=>r.recommended),totalCombinations:all.length,shortlisted:selected.length,simulations};
})()`,context);
}
parentPort.on('message',([request])=>{try{parentPort.postMessage({result:prepare(request),heapBytes:process.memoryUsage().heapUsed});}catch(error){parentPort.postMessage({error:error.stack||error.message});}});
