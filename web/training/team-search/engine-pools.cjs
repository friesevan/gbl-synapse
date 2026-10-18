'use strict';
// The engine's own move pools and IV combinations, for moveset mutation and the IV panel (README sections 7 and 12;
// findings/moveset-iv.md). Both come from the vendored PvPoke Pokemon object, the same source prepare-worker.cjs enumerates
// its 12,335 combinations from, so a mutated moveset is legal by the engine's rules and an IV build is within the league CP cap.
// One VM context is built per process on first use and reused; nothing here touches a battle.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const base = path.resolve(__dirname, '../../includes/pro');
const CP = 1500;
let ctx;

function context() {
 if (ctx) return ctx;
 const sandbox = vm.createContext({console: {log() {}}, host: 'localhost', webRoot: '', siteVersion: 'team-search', settings: {colorblindMode: false, hardMovesetLinks: false}, $: {ajax() {}, each(items, cb) { items.forEach((x, i) => cb(i, x)); }}});
 for (const f of ['core.js', ...['GameMaster', 'DamageCalculator', 'ActionLogic', 'TimelineEvent', 'TimelineAction', 'DecisionOption', 'Battle', 'Pokemon'].map(n => 'vendor/' + n + '.js')]) vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sandbox);
 sandbox.input = {data: JSON.parse(fs.readFileSync(path.join(base, 'data/gamemaster.json'), 'utf8'))};
 vm.runInContext('var gm=GameMaster.getInstance();gm.data=input.data;gm.originalData=input.data;gm.createSearchMaps();gm.rankings={};var battle=new Battle();battle.setCP(' + CP + ');', sandbox);
 return ctx = sandbox;
}
const run = (code, input) => { const c = context(); c.input = input; return JSON.parse(vm.runInContext('JSON.stringify(' + code + ')', c)); };

// Every legal fast/charged combination of a species, in PvPPro.enumerate order (the order preparation scouts them in).
function legalMovesets(speciesId) {
 return run('(()=>{const p=new Pokemon(input.id,0,battle);p.initialize(' + CP + ');return PvPPro.enumerate(p.fastMovePool.map(m=>m.moveId),p.chargedMovePool.map(m=>m.moveId),p.hasThirdChargedMove()?p.extraChargedMovePool.map(m=>m.moveId):[]);})()', {id: speciesId});
}
const FIELDS = ['atk', 'def', 'hp', 'level', 'cp'];
// Ordering of the combinations the engine lists for a species (all legal IV/level pairs at or under the cap).
const ORDER = {
 rank1: (a, b) => b.overall - a.overall,   // rank-1 stat product within the CP cap
 attack: (a, b) => b.a - a.a || b.overall - a.overall,   // highest attack stat the cap allows, then stat product
 bulk: (a, b) => b.d * b.h - a.d * a.h || b.overall - a.overall,   // defence times HP, then stat product
};
// IV builds of a species within the CP cap, with the engine's own legality rules (level cap, IV floors). `default` is what the
// engine plays when a row carries no override (PvPoke's default IVs for the league). Each is {atk, def, hp, level, cp}.
function builds(speciesId) {
 const {def, all} = run('(()=>{const p=new Pokemon(input.id,0,battle);p.initialize(' + CP + ');return {def:{atk:p.ivs.atk,def:p.ivs.def,hp:p.ivs.hp,level:p.level,cp:p.cp},'
  + 'all:p.generateIVCombinations("overall",1,4096).map(c=>({atk:c.ivs.atk,def:c.ivs.def,hp:c.ivs.hp,level:c.level,cp:c.cp,overall:c.overall,a:c.atk,d:c.def,h:c.hp}))};})()', {id: speciesId});
 const out = {default: def};
 for (const [id, cmp] of Object.entries(ORDER)) if (all.length) { const best = all.slice().sort(cmp)[0]; out[id] = Object.fromEntries(FIELDS.map(f => [f, best[f]])); }
 return out;
}
const BUILD_IDS = ['default', ...Object.keys(ORDER)];
// CP of an IV build from base stats and the level table (the engine's own formula), independent of the search that chose it.
function cpOf(speciesId, build) {
 return run('(()=>{const p=new Pokemon(input.id,0,battle);p.initialize(' + CP + ');return p.calculateCP(p.getCPMByLevel(input.b.level),input.b.atk,input.b.def,input.b.hp);})()', {id: speciesId, b: build});
}
// The stats an IV build gives (atk, def, hp as the battle uses them) and their product, from the engine's own level table.
function statsOf(speciesId, build) {
 return run('(()=>{const p=new Pokemon(input.id,0,battle);p.initialize(' + CP + ');const cpm=p.getCPMByLevel(input.b.level),atk=cpm*(p.baseStats.atk+input.b.atk),def=cpm*(p.baseStats.def+input.b.def),hp=Math.floor(cpm*(p.baseStats.hp+input.b.hp));return {atk,def,hp,overall:atk*def*hp};})()', {id: speciesId, b: build});
}
module.exports = {legalMovesets, builds, cpOf, statsOf, BUILD_IDS, CP};
