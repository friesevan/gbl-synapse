// Owner requests 2026-10-16: no form question for look-alike sizes or in-battle form changers; fast-move options cover every
// form still possible, a move only one form learns settles it, and "Other move" lists the remaining legal moves.
const test=require('node:test'),assert=require('node:assert');
const K=require('../includes/meta/combat.js'),Q=require('../includes/meta/questions.js'),C=require('../includes/meta/core.js'),O=require('../includes/meta/observed-core.js');
const gm=require('../includes/pro/data/gamemaster.json'),byId=new Map(gm.pokemon.map(p=>[p.speciesId,p]));
const cand=id=>({id,name:byId.get(id).speciesName,types:byId.get(id).types,dex:byId.get(id).dex});
// A one-matchup battle whose Pokémon is `ids` (candidate forms) with a prior-only inference at `movesP` for the leading moves.
function member(ids,{label,inference,extra}={}){const m={key:ids[0],label:label||byId.get(ids[0]).speciesName,cp:1490,first:5,candidates:ids.map(cand),...extra};
 m.inference=inference||K.priorInference(ids.map(i=>byId.get(i)),{});return m;}
const ask=(m,opts)=>Q.questions([{start:0,end:60,result:'Win',my:[],opponent:[m],matchups:[]}],{pokemon:gm.pokemon,moves:gm.moves,...opts});

test('Gourgeist and Pumpkaboo sizes are never asked about, a real regional split still is',()=>{
 for(const [sp,sizes] of [['gourgeist',['small','average','large','super']],['pumpkaboo',['small','average','large','super']]]){
  const m=member(sizes.map(s=>`${sp}_${s}`));const top=m.inference.forms[0].p;assert.ok(top<.85,'sizes are a near tie');
  assert.ok(!ask(m).some(q=>q.kind==='form'),sp+' asks no form question');
  assert.ok(m.inference.forms.length===4,'the model still ranks the sizes');}
 const split=member(['marowak','marowak_alolan']);assert.ok(ask(split).some(q=>q.kind==='form'),'Alolan Marowak is still asked');
 assert.equal(Q.lookAlike(['gourgeist_small','pumpkaboo_small']),false,'two species are not look-alikes of each other');
});

test('in-battle form changers collapse to one species with no form question',()=>{
 for(const [ids,base] of [[['cramorant','cramorant_gulping','cramorant_gorging'],'cramorant'],[['mimikyu','mimikyu_busted'],'mimikyu'],[['morpeko_full_belly','morpeko_hangry'],'morpeko_full_belly']]){
  const raw=member(ids);assert.ok(!ask(raw).some(q=>q.kind==='form'),base+': no question even before narrowing');
  K.narrowByRankings(raw,new Map());assert.deepEqual(raw.candidates.map(c=>c.id),[base],base+' keeps the base state');assert.equal(raw.formId,base);
  assert.match(raw.formNote,/battle state/);}
 assert.deepEqual(K.collapseForms([{value:'cramorant',p:.5},{value:'cramorant_gulping',p:.3},{value:'cramorant_gorging',p:.2}]),[{value:'cramorant',p:1}]);
 assert.equal(K.battleStateBase('morpeko_hangry_shadow'),'morpeko_full_belly_shadow');
});

test('Aura Wheel is one move whatever the Morpeko state, so neither type rules the form out',()=>{
 const full=byId.get('morpeko_full_belly');
 assert.equal(K.movesetFactor(full,'THUNDER_SHOCK',['AURA_WHEEL_DARK'],null),1);
 assert.equal(K.movesetFactor(full,'THUNDER_SHOCK',['AURA_WHEEL_ELECTRIC','AURA_WHEEL_DARK'],null),1);
 assert.equal(K.movesetFactor(full,'THUNDER_SHOCK',['ICE_BEAM'],null),.02,'a move it cannot learn still rules it out');
});

test('Electrode: Thunder Shock (Hisuian only) is offered, Other move lists the rest, and choosing it settles the form',()=>{
 const m=member(['electrode','electrode_hisuian']);
 // Reproduction of Whoko23NhtM: the leading moves are Tackle / Spark; Thunder Shock exists only in the Hisuian pool.
 m.inference.moves=[{value:'TACKLE',p:.6},{value:'SPARK',p:.35},{value:'VOLT_SWITCH',p:.04},{value:'THUNDER_SHOCK',p:.01}];
 const q=ask(m,{}).find(x=>x.kind==='fastMove');assert.ok(q);const vals=q.options.map(o=>o.value);
 assert.ok(vals.includes('THUNDER_SHOCK'),'Thunder Shock is an option');
 const ts=q.options.find(o=>o.value==='THUNDER_SHOCK');assert.equal(ts.form,'electrode_hisuian');assert.match(ts.hint,/only Electrode \(Hisuian\) learns it/);
 assert.deepEqual(q.moveForms,{THUNDER_SHOCK:'electrode_hisuian',SPARK:'electrode',VOLT_SWITCH:'electrode'});
 assert.deepEqual(vals.slice().sort(),['SPARK','TACKLE','THUNDER_SHOCK','VOLT_SWITCH'],'union of both pools, nothing else');
 // answering settles the form
 const battles=[{start:0,end:60,result:'Win',my:[],opponent:[m],matchups:[]}];
 const done=Q.answer(battles,q,'THUNDER_SHOCK');assert.equal(done.answers.formByMove,'electrode_hisuian');
 assert.equal(done.inference.forms.length,1);assert.equal(done.inference.forms[0].value,'electrode_hisuian');assert.equal(Q.shadowEligibility(done).form,'electrode_hisuian');
 assert.ok(!Q.questions(battles,{pokemon:gm.pokemon,moves:gm.moves}).some(x=>x.kind==='form'),'no form question afterwards');
});

test('options with a settled form use only that form’s pool; the remaining legal moves are under Other move',()=>{
 const m=member(['gourgeist_average']);m.inference.moves=[{value:'HEX',p:.5},{value:'RAZOR_LEAF',p:.45},{value:'INCINERATE',p:.05}];
 const q=ask(m,{}).find(x=>x.kind==='fastMove');
 // four leading choices would hide a fifth legal move behind "Other"; use a pool larger than the leading list
 const big=member(['starmie']);big.inference.moves=['WATER_GUN','QUICK_ATTACK','TACKLE','PSYWAVE','HIDDEN_POWER_FIRE'].map((value,i)=>({value,p:[.3,.28,.2,.12,.1][i]}));
 const bq=ask(big,{}).find(x=>x.kind==='fastMove');
 assert.ok(bq.options.some(o=>o.other),'moves beyond the leading choices go under Other move');
 const legal=new Set([...byId.get('starmie').fastMoves,...(byId.get('starmie').eliteMoves||[]).filter(x=>!byId.get('starmie').chargedMoves.includes(x))]);
 assert.deepEqual(new Set(bq.options.map(o=>o.value)),legal,'every legal fast move is reachable');
 assert.ok(bq.options.filter(o=>!o.other).length<=6);
 assert.ok(q.options.every(o=>byId.get('gourgeist_average').fastMoves.includes(o.value)));
 // a reviewer-settled form restricts the pool
 const e=member(['electrode','electrode_hisuian']);e.answers={form:'electrode_hisuian'};Q.condition(e);
 const eq=ask(e,{confident:1.1}).find(x=>x.kind==='fastMove');assert.deepEqual(eq.options.map(o=>o.value).sort(),['THUNDER_SHOCK','TACKLE'].sort());
 assert.ok(!eq.options.some(o=>o.form),'one possible form: nothing to settle');
});

test('a fast-move answer counts for the form that learns it, even when the question named another form',()=>{
 const asked={id:'q1',kind:'fastMove',species:'electrode',value:'THUNDER_SHOCK'};
 const viaPools=Q.learnedFromAnswers([],new Map([['q1',asked]]),Q.movePools(gm.pokemon));
 assert.deepEqual(viaPools.moves,{electrode_hisuian:{THUNDER_SHOCK:1}});assert.deepEqual(viaPools.forms,{electrode_hisuian:1});
 const viaOption=Q.learnedFromAnswers([{...asked,options:[{value:'THUNDER_SHOCK',form:'electrode_hisuian'}]}],new Map([['q1',{value:'THUNDER_SHOCK'}]]),new Map());
 assert.deepEqual(viaOption.moves,{electrode_hisuian:{THUNDER_SHOCK:1}});
 const own=Q.learnedFromAnswers([],new Map([['q2',{kind:'fastMove',species:'electrode',value:'SPARK'}]]));
 assert.deepEqual(own.moves,{electrode:{SPARK:1}},'a move the named form learns stays with it');assert.equal(own.forms,undefined);
});

test('Electrode as the saved result has it: the icon filter dropped Hisuian, yet Thunder Shock is offered and settles it',()=>{
 // Whoko23NhtM: icons read Electric 23 times and never Grass, so core.js resolveForm kept [electrode, electrode_shadow] only.
 const m=member(['electrode','electrode_shadow'],{extra:{observedTypes:['electric'],formNote:'Type icons (electric) rule out other forms',typeVotes:{electric:23}}});
 m.inference.moves=[{value:'TACKLE',p:.59},{value:'SPARK',p:.4},{value:'VOLT_SWITCH',p:.01}];
 const battles=[{start:0,end:60,result:'Win',my:[],opponent:[m],matchups:[]}];
 assert.deepEqual(Q.iconAlternates(m,byId),['electrode_hisuian']);
 const q=Q.questions(battles,{pokemon:gm.pokemon,moves:gm.moves}).find(x=>x.kind==='fastMove');
 const ts=q.options.find(o=>o.value==='THUNDER_SHOCK');assert.ok(ts,'Thunder Shock is offered');assert.equal(ts.form,'electrode_hisuian');assert.equal(ts.candidate.id,'electrode_hisuian');assert.ok(!ts.other);
 assert.ok(!q.options.some(o=>o.value==='THUNDER_SHOCK'&&o.other));
 const done=Q.answer(battles,q,'THUNDER_SHOCK');
 assert.equal(done.answers.formByMove,'electrode_hisuian');assert.ok(done.candidates.some(c=>c.id==='electrode_hisuian'));
 assert.equal(done.inference.forms[0].value,'electrode_hisuian');assert.equal(done.id,'electrode_hisuian');
 // the model is untouched: a mono-type species never gains alternates, and a settled reading of two types adds none
 const quag=member(['quagsire'],{extra:{observedTypes:['water'],formNote:'Type icons (water) rule out other forms'}});
 assert.deepEqual(Q.iconAlternates(quag,byId),[]);
 const two=member(['electrode'],{extra:{observedTypes:['electric','grass'],formNote:'Type icons (electric / grass) rule out other forms'}});assert.deepEqual(Q.iconAlternates(two,byId),[]);
});

test('observed meta: battle states are one species and look-alike sizes never leave a team unidentified',()=>{
 const forms=[{value:'cramorant_gulping',p:.55},{value:'cramorant',p:.4},{value:'cramorant_gorging',p:.05}];
 const s=O.status({id:'',key:'cramorant',shadow:false,inference:{forms}});assert.equal(s.id,'cramorant');assert.ok(s.formKnown);
 const g=O.status({key:'gourgeist',shadow:false,inference:{forms:[{value:'gourgeist_large',p:.4},{value:'gourgeist_small',p:.3},{value:'gourgeist_average',p:.2},{value:'gourgeist_super',p:.1}]}});
 assert.equal(g.id,'gourgeist_large');assert.ok(g.formKnown);
 const r=O.status({key:'marowak',shadow:false,inference:{forms:[{value:'marowak_alolan',p:.6},{value:'marowak',p:.4}]}});assert.ok(!r.formKnown);
 assert.equal(O.status({id:'morpeko_hangry',shadow:false}).id,'morpeko_full_belly');
});
