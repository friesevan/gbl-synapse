#!/usr/bin/env node
'use strict';
// Sensitivity check for reference/mechanics-fixtures.json: does the pinned set notice a mechanics edit?
// Each mutation below changes one mechanic in a throw-away COPY of the engine (the repository is never touched),
// then re-runs every pinned battle there and counts how many outcomes differ from the committed fixtures.
// A mutation that changes no battle is a mechanic the fixtures do not pin.
//
//   node training/mechanics-mutation-check.cjs [--only name,...] [--keep]
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const FIXTURES=path.join(__dirname,'reference/mechanics-fixtures.json');
const MUTATIONS=[
 {name:'cmp-higher-attack-wins',file:'includes/pro/vendor/Battle.js',find:'action.settings.priority++;',replace:'action.settings.priority+=0;',what:'a higher Attack stat no longer wins a charged-move tie'},
 {name:'cmp-tie-coin-flipped',file:'training/next/lookahead-v4.js',find:"+battle.getTurns())()<.5",replace:"+battle.getTurns())()>.5",what:'the seeded coin that breaks equal-Attack ties picks the other side'},
 {name:'shadow-attack-multiplier',file:'includes/pro/vendor/DamageCalculator.js',find:'static SHADOW_ATK = 1.2;',replace:'static SHADOW_ATK = 1.25;',what:'Shadow Attack bonus 1.2 to 1.25'},
 {name:'switch-clock-60s',file:'training/vendor/Player.js',find:'this.switchTime = 45000;',replace:'this.switchTime = 60000;',what:'voluntary switch clock 45 s to 60 s of battle time'},
 {name:'buff-chance-halved',file:'includes/pro/vendor/Battle.js',find:'buffRoll > 1 - move.buffApplyChance){',replace:'buffRoll > 1 - move.buffApplyChance * 0.5){',what:'chance-based stat buffs half as likely'},
 {name:'mimikyu-disguise-off',file:'includes/pro/vendor/Battle.js',find:'if(defender.formChange && defender.formChange.trigger == "charged_move_damage" && defender.formChange.effect == "protect"',replace:'if(false && defender.formChange && defender.formChange.trigger == "charged_move_damage" && defender.formChange.effect == "protect"',what:'Mimikyu\'s Disguise never absorbs a hit'},
 {name:'priority-ko-always-off',file:'includes/pro/vendor/Battle.js',find:'if(usePriority && poke.hp <= 0 && poke.faintSource == "charged"',replace:'if(false && usePriority && poke.hp <= 0 && poke.faintSource == "charged"',what:'a Pokémon knocked out by a charged move in the same turn still throws its own'},
 {name:'aegislash-no-form-change',file:'includes/pro/vendor/Battle.js',find:'attacker.changeForm(attacker.formChange.alternativeFormId);',replace:'/* no form change */',what:'Aegislash never changes form when it throws a charged move'},
];
function copyEngine(dir){
 const copy=(from,to)=>fs.cpSync(path.join(root,from),path.join(dir,'web',to),{recursive:true,filter:src=>!src.includes(path.join('training','runs'))});
 copy('training','training');copy('includes/pro/vendor','includes/pro/vendor');
 fs.symlinkSync(path.join(root,'includes/pro/data'),path.join(dir,'web/includes/pro/data'));
}
function mutate(dir,m){
 const file=path.join(dir,'web',m.file),source=fs.readFileSync(file,'utf8'),at=source.indexOf(m.find);
 if(at<0||source.indexOf(m.find,at+1)>=0)throw new Error('Mutation "'+m.name+'" does not match exactly once in '+m.file+'; update the check after changing the engine');
 fs.writeFileSync(file,source.replace(m.find,()=>m.replace));
}
function main(argv){
 const only=argv.includes('--only')?argv[argv.indexOf('--only')+1].split(','):null,results=[];
 for(const m of MUTATIONS.filter(m=>!only||only.includes(m.name))){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mechanics-mutation-'));
  try{
   copyEngine(dir);mutate(dir,m);
   const run=spawnSync(process.execPath,[path.join(dir,'web/training/mechanics-fixtures.cjs'),'--file',FIXTURES],{encoding:'utf8',maxBuffer:64*1024*1024});
   const summary=/(\d+) battles; (\d+) changed/.exec(run.stdout),changed=[...run.stdout.matchAll(/^  changed (\S+)/gm)].map(x=>x[1]);
   results.push({name:m.name,what:m.what,battles:summary?Number(summary[1]):null,changed:summary?Number(summary[2]):null,ids:changed,error:summary?null:(run.stderr||run.stdout).slice(0,300)});
   console.log(m.name.padEnd(26)+(summary?(summary[2]+' of '+summary[1]+' battles change').padEnd(28):'run failed: '+(run.stderr||run.stdout).slice(0,200))+m.what+(changed.length&&changed.length<=16?'\n'+''.padEnd(26)+changed.join(', '):''));
  }finally{if(!argv.includes('--keep'))fs.rmSync(dir,{recursive:true,force:true});}
 }
 const missed=results.filter(r=>r.changed===0);
 console.log('\n'+(results.length-missed.length)+' of '+results.length+' mutations are caught by the pinned fixtures'+(missed.length?'; NOT caught: '+missed.map(r=>r.name).join(', '):'')+'.');
 if(missed.length||results.some(r=>r.changed===null))process.exitCode=1;
 return results;
}
module.exports={MUTATIONS,main};
if(require.main===module)try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
