const {test}=require('node:test'),assert=require('node:assert/strict'),C=require('../includes/meta/core.js'),gm=require('../includes/pro/data/gamemaster.json');
const d=C.dictionary(gm.pokemon),hit=name=>C.match(name,d);
test('multiword names and accents normalize, CP ignored',()=>{assert.equal(hit('Mr. Mime').quality,'exact');assert.ok(hit('Flabébé'));assert.ok(hit('Melmetal CP 1499'));});
test('regional and Shadow ambiguity are never assigned automatically',()=>{assert.equal(hit('Corsola').id,'');assert.ok(hit('Corsola').candidates.some(p=>p.id==='corsola_galarian'));assert.equal(hit('Feraligatr').id,'');});
test('fuzzy OCR is only a suggestion',()=>{assert.equal(hit('Melmeta1').quality,'suggestion');assert.equal(hit('Melmeta1').id,'');assert.equal(hit('random text from menu'),null);});
test('two sightings, duplicate filtering, missing result retained',()=>{const t=new C.Tracker();t.observe(0,'opponent',hit('Melmetal'),90,'Melmetal');assert.equal(t.current,null);t.observe(.5,'opponent',hit('Melmetal'),90,'Melmetal');t.observe(1,'opponent',hit('Melmetal'),90,'Melmetal');assert.equal(t.current.opponent.length,1);assert.equal(t.finish(2)[0].result,'Unknown');});
test('short charge HUD absence does not split a battle',()=>{const t=new C.Tracker();for(const n of [0,.5,15,15.5])t.observe(n,'opponent',hit('Melmetal'),90,'Melmetal');assert.equal(t.finish(16).length,1);});
test('a long gap and fourth species create reviewable boundaries',()=>{const t=new C.Tracker();for(const [i,name] of ['Melmetal','Jumpluff','Cramorant','Clodsire'].entries()){t.observe(i*2,'opponent',hit(name),90,name);t.observe(i*2+.5,'opponent',hit(name),90,name);}assert.equal(t.finish(9).length,2);const x=new C.Tracker();[0,.5,30,30.5].forEach(n=>x.observe(n,'opponent',hit('Melmetal'),90,'Melmetal'));assert.equal(x.finish(31).length,2);});
test('results require repeated readings and never turn unknown into a loss',()=>{const t=new C.Tracker();[0,.5].forEach(n=>t.observe(n,'opponent',hit('Melmetal'),90,'Melmetal'));t.result(3,'YOU WIN!',90);assert.equal(t.battles.length,0);t.result(3.5,'YOU WIN!',90);assert.equal(t.battles[0].result,'Win');assert.equal(C.outcome('Good effort!'),'Loss');assert.equal(C.outcome('Continue'),null);});
test('meta counts reviewed observations, training requires a complete verified lead',()=>{const b={reviewed:true,leadConfirmed:true,opponent:['melmetal','cramorant','jumpluff'].map(id=>({id}))};assert.ok(C.eligible(b));assert.equal(C.aggregate([b,{...b,reviewed:false}]).accepted,1);assert.equal(C.aggregate([b,{...b,leadConfirmed:false}]).complete,1);assert.equal(C.aggregate([b,{...b,opponent:b.opponent.slice(0,2)}]).counts.get('melmetal'),2);});
test('bench permutations aggregate but different leads do not',()=>{const b={reviewed:true,leadConfirmed:true,opponent:['melmetal','cramorant','jumpluff'].map(id=>({id}))};assert.equal(C.aggregate([b,{...b,opponent:[b.opponent[0],b.opponent[2],b.opponent[1]]}]).teams[0].count,2);assert.equal(C.aggregate([b,{...b,opponent:[b.opponent[1],b.opponent[0],b.opponent[2]]}]).teams.length,2);});

test('species clause excludes two forms with the same Pokédex number',()=>{assert.equal(C.eligible({reviewed:true,leadConfirmed:true,opponent:[{id:'feraligatr',dex:160},{id:'feraligatr_shadow',dex:160},{id:'melmetal',dex:809}]}),false);});
test('result text tolerates a single glyph error but not arbitrary nearby strings',()=>{assert.equal(C.outcome('YOUMW/IN!'),'Win');assert.equal(C.outcome('Good eff0rt!'),'Loss');assert.equal(C.outcome('Next battle'),null);});

test('excluded observations are recoverable but do not count; duplicate sightings count once',()=>{const b={reviewed:true,leadConfirmed:true,opponent:[{id:'melmetal'},{id:'melmetal'}]};assert.equal(C.aggregate([b]).counts.get('melmetal'),1);assert.equal(C.aggregate([{...b,included:false}]).accepted,0);});

// ---- HUD tracker (Poké Ball / shield driven) ----
const A=['alive','alive','alive'],side=(name,balls=A,shields=2)=>({balls,fainted:balls.filter(b=>b==='fainted').length,shields,hit:name?{...hit(name),confidence:90,raw:name}:null});
const hud=(my,opp)=>({my,opponent:opp});
test('HUD tracker: a reset to fresh Poké Balls and shields starts the next battle without a result screen',()=>{const t=new C.HudTracker();t.observe(0,hud(side('Melmetal'),side('Clodsire')));t.observe(10,hud(side('Melmetal'),side('Clodsire',A,1)));t.observe(20,hud(side('Melmetal'),side('Azumarill')));const b=t.finish();assert.equal(b.length,2);assert.deepEqual(b[0].opponent.map(p=>p.label),['Clodsire']);});
test('HUD tracker: three fainted balls decide the result; a result screen overrides and is cross-checked',()=>{const t=new C.HudTracker(),X=['fainted','fainted','fainted'];t.observe(0,hud(side('Melmetal'),side('Clodsire')));t.observe(20,hud(side('Melmetal'),side('Clodsire',X,0)));assert.equal(t.finish()[0].result,'Win');const u=new C.HudTracker();u.observe(0,hud(side('Melmetal'),side('Clodsire')));u.observe(20,hud(side('Melmetal'),side('Clodsire',X,0)));u.result(30,'Loss');const b=u.finish()[0];assert.equal(b.result,'Loss');assert.ok(b.flags.some(f=>f.includes('disagrees')));});
test('HUD tracker: result screens are only checked once a battle can have ended',()=>{const t=new C.HudTracker(),F=['fainted','fainted','alive'];t.observe(0,hud(side('Melmetal'),side('Clodsire')));assert.equal(t.awaitingResult(5),false);assert.equal(t.awaitingResult(9),true);t.observe(20,hud(side('Melmetal'),side('Clodsire',F,0)));assert.equal(t.awaitingResult(22),true);});
test('HUD tracker: a win with opponent Pokémon left is flagged as a probable forfeit',()=>{const t=new C.HudTracker();t.observe(0,hud(side('Melmetal'),side('Clodsire')));t.result(30,'Win');const b=t.finish()[0];assert.equal(b.result,'Win');assert.ok(b.flags.some(f=>f.includes('opponent may have left')));});
test('HUD tracker: a recording that starts mid-battle is flagged, and repeated names count once',()=>{const t=new C.HudTracker(),F=['fainted','alive','alive'];t.observe(0,hud(side('Melmetal',F),side('Clodsire')));t.observe(1,hud(side('Melmetal',F),side('Clodsire')));const b=t.finish()[0];assert.ok(b.flags[0].startsWith('Recording starts mid-battle'));assert.equal(b.opponent.length,1);});
const inked=(start,n)=>{const b=new Uint8Array(768);b.fill(1,start,start+n);return b;};
test('name fingerprints reuse one OCR result for near-identical nameplates',()=>{const c=new C.NameCache(),a=inked(0,150),b=inked(10,150);c.set(a,'Melmetal');assert.equal(c.get(b),'Melmetal');assert.equal(c.get(inked(300,150)),undefined);});
test('faint nameplates never share a cached name, and blank ones are never cached',()=>{const c=new C.NameCache();c.set(inked(0,20),'Sandslash');assert.equal(c.get(inked(12,20)),undefined);assert.equal(c.get(inked(0,20)),'Sandslash');const blank=new Uint8Array(768);c.set(blank,'Drifblim');assert.equal(c.get(blank),undefined);});
test('an unreadable nameplate is retried before being cached as unreadable',()=>{const c=new C.NameCache(),a=inked(0,100);c.set(a,null);assert.equal(c.get(a),undefined);c.set(a,null);c.set(a,null);assert.equal(c.get(a),null);const d=new C.NameCache();d.set(a,null);d.set(a,'Qwilfish');assert.equal(d.get(a),'Qwilfish');});
test('charged attacks go to the active Pokémon, separating mirror matches and tolerating one misread letter',()=>{const t=new C.HudTracker(),moves=gm.moves;t.observe(0,hud(side('Mandibuzz'),side('Mandibuzz')));t.observe(1,hud(side('Mandibuzz'),side('Qwilfish')));t.move(2,'Quwilfish used Ice Beam!',90,moves);t.observe(3,hud(side('Hatterene'),side('Qwilfish')));t.move(4,'Hatterene used Psyshock!',90,moves);const e=t.current.events.filter(e=>e.kind==='move');assert.deepEqual(e.map(x=>[x.side,x.actor,x.move]),[['opponent','qwilfish','ICE_BEAM'],['my','hatterene','PSYSHOCK']]);});

// ---- Review questions ----
const Q=require('../includes/meta/questions.js');
const member=(key,ids,rows,extra={})=>({key,label:key,first:10,candidates:ids.map(id=>({id,name:id,types:gm.pokemon.find(p=>p.speciesId===id)?.types})),...extra,inference:rows&&{allRows:rows,rows,...Q.marginals(rows)}});
test('questions: an in-between Shadow estimate is asked, a confident one is not; answering settles the species id and narrows the fast move',()=>{
 const rows=[{id:'claydol',move:'MUD_SLAP',p:.3},{id:'claydol_shadow',move:'MUD_SLAP',p:.4},{id:'claydol_shadow',move:'CONFUSION',p:.3}];
 const battles=[{start:0,end:100,result:'Win',my:[],opponent:[member('claydol',['claydol','claydol_shadow'],rows)],matchups:[{start:20,end:40,my:'x',opponent:'claydol',hitsOnMy:[.05,.06],cadenceOnMy:3}]}];
 const qs=Q.questions(battles,{pokemon:gm.pokemon,moves:gm.moves});assert.deepEqual(qs.map(q=>q.kind),['shadow','fastMove']);
 const m=Q.answer(battles,qs[0],true);assert.equal(m.id,'claydol_shadow');assert.ok(Math.abs(m.inference.moves.find(x=>x.value==='MUD_SLAP').p-4/7)<1e-9);
 assert.equal(Q.questions(battles,{pokemon:gm.pokemon,moves:gm.moves}).filter(q=>q.kind==='shadow').length,0);});
test('questions: regional forms the icons could not settle are asked; unknown results are asked; your Pokémon are asked once',()=>{
 const mine=()=>member('corsola',['corsola','corsola_galarian']);
 const battles=[{start:0,end:100,result:'Unknown',my:[mine()],opponent:[member('weezing',['weezing','weezing_galarian'],null,{observedTypes:null,answers:{shadow:false}})]},{start:200,end:300,result:'Win',my:[mine()],opponent:[]}];
 const qs=Q.questions(battles,{pokemon:gm.pokemon,moves:gm.moves});assert.deepEqual(qs.map(q=>q.kind+':'+(q.side||'')),['result:','form:opponent','form:my']);
 Q.answer(battles,qs[2],'corsola_galarian');assert.ok(battles.every(b=>b.my[0].answers.form==='corsola_galarian'));Q.answer(battles,qs[0],'Loss');assert.equal(battles[0].result,'Loss');assert.equal(battles[0].resultSource,'reviewer');});
// Shadow eligibility: PvPoke lists `<id>_shadow` only for forms with a released Shadow.
const shadowKinds=(m,extra)=>Q.questions([{start:0,end:100,result:'Win',my:[],opponent:[m],matchups:[{start:20,end:40,my:'x',opponent:m.key,hitsOnMy:[.05,.06],cadenceOnMy:3}]}],{pokemon:gm.pokemon,moves:gm.moves,...extra}).filter(q=>q.kind==='shadow');
const palkiaRows=(po,pd,pshadow)=>[{id:'palkia',move:'WATER_GUN',p:pd},{id:'palkia_shadow',move:'WATER_GUN',p:pshadow},{id:'palkia_origin',move:'WATER_GUN',p:po}];
test('shadow eligibility: a form without a Shadow entry settles Shadow as false, so no Shadow question is asked',()=>{
 const palkia=(rows,extra)=>member('palkia',['palkia','palkia_shadow','palkia_origin'],rows,extra);
 // Form unsettled and the regular form has a Shadow: asked.
 assert.equal(shadowKinds(palkia(palkiaRows(.4,.3,.3))).length,1);
 // Origin settled by the reviewer, by p >= .98, or as the only form left: not asked.
 assert.equal(shadowKinds(palkia(palkiaRows(.4,.3,.3),{answers:{form:'palkia_origin'}})).length,0);
 assert.equal(shadowKinds(palkia(palkiaRows(.985,.01,.005))).length,0);
 assert.equal(shadowKinds(member('palkia',['palkia_origin'],[{id:'palkia_origin',move:'WATER_GUN',p:1}])).length,0);
 // Regular Palkia settled: still asked (it has a Shadow).
 assert.equal(shadowKinds(palkia(palkiaRows(.005,.5,.495),{answers:{form:'palkia'}})).length,1);
 // Answering the form as Origin conditions the posterior to not-Shadow and settles the species id.
 const battles=[{start:0,end:100,result:'Win',my:[],opponent:[palkia(palkiaRows(.4,.3,.3))],matchups:[]}];
 const fq=Q.questions(battles,{pokemon:gm.pokemon,moves:gm.moves}).find(q=>q.kind==='form');assert.ok(fq);const m=Q.answer(battles,fq,'palkia_origin');
 assert.equal(m.id,'palkia_origin');assert.equal(m.inference.shadowP,0);assert.equal(shadowKinds(m).length,0);
 assert.deepEqual(Q.shadowEligibility(m,{hasShadow:Q.hasShadowIn(new Map(gm.pokemon.map(p=>[p.speciesId,p])))}),{form:'palkia_origin',eligible:false});
 // Unsettled form but none of the real candidate forms has a Shadow entry.
 const none=member('palkia',['palkia_origin','dialga_origin'],[{id:'palkia_origin',move:'WATER_GUN',p:.5},{id:'dialga_origin',move:'DRAGON_BREATH',p:.5}]);
 assert.equal(shadowKinds(none).length,0);assert.equal(Q.shadowEligibility(none).eligible,false);});
test('shadow eligibility: Megas have no Shadow, ordinary species do; the gamemaster decides when candidates omit the Shadow id',()=>{
 const mega=member('venusaur',['venusaur_mega'],[{id:'venusaur_mega',move:'VINE_WHIP',p:1}],{label:'Mega Venusaur'});assert.equal(shadowKinds(mega).length,0);
 assert.equal(Q.shadowEligibility(mega,{hasShadow:Q.hasShadowIn(new Map(gm.pokemon.map(p=>[p.speciesId,p])))}).eligible,false);
 const clay=member('claydol',['claydol','claydol_shadow'],[{id:'claydol',move:'MUD_SLAP',p:.5},{id:'claydol_shadow',move:'MUD_SLAP',p:.5}]);assert.equal(shadowKinds(clay).length,1);
 // Candidates without a Shadow id still ask when the gamemaster says the species has one (and not otherwise).
 assert.equal(shadowKinds(member('claydol',['claydol'],null)).length,1);assert.equal(shadowKinds(member('claydol',['claydol'],null),{pokemon:gm.pokemon.filter(p=>p.speciesId!=='claydol_shadow')}).length,0);});
test('question wording names the settled species in English, not the misread nameplate',()=>{
 const rows=[{id:'qwilfish',move:'POISON_STING',p:.5},{id:'qwilfish_shadow',move:'POISON_STING',p:.5}],q=shadowKinds(member('qwilfish',['qwilfish','qwilfish_shadow'],rows,{label:'Quwilfish'}))[0];
 assert.match(q.title,/Is the opponent’s Qwilfish a Shadow Pokémon\?/);assert.doesNotMatch(q.title,/Quwilfish/);assert.equal(q.species,'qwilfish');assert.equal(q.speciesName,'Qwilfish');
 // A settled regional/alternate form is named with its form; its "which form?" question names only the species.
 const origin=shadowKinds(member('palkia',['palkia','palkia_shadow','palkia_origin'],palkiaRows(.2,.4,.4),{label:'Palkla',answers:{form:'palkia'}}))[0];assert.match(origin.title,/Palkia a Shadow/);
 const fq=Q.questions([{start:0,end:100,result:'Win',my:[],opponent:[member('weezing',['weezing_galarian','weezing'],null,{label:'Weezng',observedTypes:null,answers:{shadow:false}})]}],{pokemon:gm.pokemon,moves:gm.moves}).find(x=>x.kind==='form');
 assert.match(fq.title,/Weezing: which form\?/);assert.doesNotMatch(fq.title,/Weezng/);
 // Candidate English name, then the nameplate marked as such, when the gamemaster has nothing.
 assert.equal(Q.displayName({label:'Quwilfish',candidates:[{id:'qwilfish',name:'Qwilfish'}]},new Map()),'Qwilfish');
 assert.equal(Q.displayName({label:'Quwilfish',candidates:[]},new Map()),'Pokémon (nameplate read: “Quwilfish”)');
 assert.equal(Q.speciesLabel('palkia_origin'),'Palkia (Origin)');assert.equal(Q.speciesLabel('charizard_mega_x'),'Charizard (Mega X)');assert.equal(Q.speciesLabel('mr_mime_galarian'),'Mr. Mime (Galarian)');assert.equal(Q.speciesLabel('ho_oh_shadow'),'Ho-Oh');});
test('answers become learned priors that move the fast-move and Shadow estimates, and are scored against the model',()=>{
 const qs=[{id:'a',kind:'fastMove',species:'claydol',modelTop:'MUD_SLAP'},{id:'b',kind:'fastMove',species:'claydol',modelTop:'MUD_SLAP'},{id:'c',kind:'shadow',species:'claydol_shadow',modelTop:true}];
 const ans=new Map([['a',{value:'CONFUSION'}],['b',{value:'MUD_SLAP'}],['c',{value:true}]]),learned=Q.learnedFromAnswers(qs,ans);
 assert.deepEqual(learned,{moves:{claydol:{CONFUSION:1,MUD_SLAP:1}},shadow:{claydol:{yes:1,no:0},'*':{yes:1,no:0}}});
 assert.deepEqual(Q.accuracy(qs,ans),{fastMove:{right:1,total:2},shadow:{right:1,total:1}});
 const K=require('../includes/meta/combat.js'),clay=gm.pokemon.find(p=>p.speciesId==='claydol');const before=K.movePrior(clay,null).get('CONFUSION'),after=K.movePrior(clay,null,{CONFUSION:3}).get('CONFUSION');assert.ok(after>before);
 const fp=K.formPrior(['claydol','claydol_shadow'].map(id=>gm.pokemon.find(p=>p.speciesId===id)),{shadow:{claydol:{yes:3,no:0}}});assert.ok(fp.get('claydol_shadow')>fp.get('claydol'));});
test('form prior: identical-looking forms follow PvPoke ranking scores, and reviewer answers move them',()=>{
 const K=require('../includes/meta/combat.js'),P=id=>gm.pokemon.find(p=>p.speciesId===id),c=['dialga','dialga_origin'].map(P);
 const rankings=new Map([['dialga',{score:84}],['dialga_origin',{score:93.8}]]);let fp=K.formPrior(c,null,rankings);assert.ok(fp.get('dialga_origin')>.85);
 fp=K.formPrior(c,{forms:{dialga:200}},rankings);assert.ok(fp.get('dialga')>fp.get('dialga_origin'));
 const flat=K.formPrior(c,null,null);assert.equal(flat.get('dialga'),flat.get('dialga_origin'));
 assert.deepEqual(Q.learnedFromAnswers([{id:'f',kind:'form',species:'weezing'}],new Map([['f',{value:'weezing_galarian'}]])).forms,{weezing_galarian:1});});
test('a forfeit answer keeps the win/loss result and records how the battle ended',()=>{
 const battles=[{start:0,end:100,result:'Unknown',my:[],opponent:[]}];const q=Q.questions(battles,{pokemon:gm.pokemon,moves:gm.moves})[0];
 assert.ok(q.options.some(o=>o.value==='Loss:you-forfeit'&&o.parent==='Loss'));Q.answer(battles,q,'Loss:you-forfeit');assert.equal(battles[0].result,'Loss');assert.equal(battles[0].ending,'you-forfeit');
 const t=new C.HudTracker();t.observe(0,hud(side('Melmetal'),side('Clodsire')));t.result(30,'Win');assert.equal(t.finish()[0].ending,'opponent-forfeit');});
test('the purple aura raises or lowers an opponent’s Shadow estimate, but not when your own Pokémon is a Shadow',()=>{
 const Aura=require('../includes/meta/aura.js');const mk=()=>({allRows:[{id:'swampert',move:'MUD_SHOT',p:.5},{id:'swampert_shadow',move:'MUD_SHOT',p:.5}]});
 const battle=(purple,myShadowP)=>({my:[{key:'electivire',inference:{shadowP:myShadowP}}],opponent:[{key:'swampert',inference:mk()}],matchups:[{my:'electivire',opponent:'swampert',auraOpponent:{purple}}]});
 const seen=battle(.02,0),none=battle(0,0),mine=battle(.05,1);for(const b of [seen,none,mine])Aura.applyToBattle(b);
 assert.ok(seen.opponent[0].inference.shadowP>.8);assert.ok(none.opponent[0].inference.shadowP<.3);assert.equal(mine.opponent[0].inference.shadowP,undefined);});
test('species confirmed regular while purple was seen stop counting the aura',()=>{
 const Aura=require('../includes/meta/aura.js');const learned=Q.learnedFromAnswers([{id:'x',kind:'shadow',species:'sableye',purple:.004}],new Map([['x',{value:false}]]));assert.deepEqual(learned.purpleBodied,{sableye:true});
 const b={my:[{key:'m',inference:{shadowP:0}}],opponent:[{key:'sableye',inference:{forms:[{value:'sableye',p:1}],allRows:[{id:'sableye',move:'SHADOW_CLAW',p:.5},{id:'sableye_shadow',move:'SHADOW_CLAW',p:.5}]}}],matchups:[{my:'m',opponent:'sableye',auraOpponent:{purple:.004}}]};
 Aura.applyToBattle(b,undefined,learned);assert.equal(b.opponent[0].inference.visual,undefined);});
test('the phone screen is found inside a wide frame by its edges and a readable HUD; a portrait recording keeps the whole frame',()=>{
 const S=require('../includes/meta/screen.js');
 // A 443-wide phone frame (half the reference) with white nameplates and red Poké Balls on a green field.
 const phone=(w=443,h=900)=>{const d=new Uint8ClampedArray(w*h*4),s=w/886,fill=(box,c)=>{const [x0,y0,x1,y1]=box.map(v=>Math.round(v*s));for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)d.set([...c,255],(y*w+x)*4);};
  for(let i=0;i<d.length;i+=4)d.set([70,140,80,255],i);for(const side of ['my','opponent']){fill(C.HUD.panel[side],[250,250,250]);for(const b of C.HUD.balls[side])fill(b,[230,40,40]);
   // Name text (dark strokes): a HUD without a name is static art, not a battle (screen.js hudScore).
   const [n0,,n1]=C.HUD.name[side];for(let x=n0+2;x<n1-4;x+=8)fill([x,132,x+4,148],[30,30,30]);}return {data:d,width:w,height:h};};
 const wide=(x0,seed)=>{const W=1200,H=900,d=new Uint8ClampedArray(W*H*4),p=phone();let r=seed;for(let i=0;i<d.length;i+=4){r=(r*1103515245+12345)&0x7fffffff;const v=40+(r>>16)%30;d.set([v,v+10,v+40,255],i);}
  for(let y=0;y<H;y++)d.set(p.data.subarray(y*p.width*4,(y+1)*p.width*4),(y*W+x0)*4);return {data:d,width:W,height:H};};
 const r=S.locate([1,2,3,4].map(k=>wide(500,k)));assert.deepEqual(r.box,[500,0,943,900]);
 const full=S.locate([phone(),phone()]);assert.deepEqual(full.box,[0,0,443,900]);});
test('the Surrender dialog marks a following loss as your forfeit, ends a battle with no result screen, and is ignored if you go on to win',()=>{
 assert.equal(C.isSurrender('Surrender and exit? You won’t receive any rewards.'),true);assert.equal(C.isSurrender('YOU WIN!'),false);assert.equal(C.surrenderCandidate({white:.8}),true);assert.equal(C.surrenderCandidate({white:.05}),false);
 const a=new C.HudTracker();a.observe(0,hud(side('Melmetal'),side('Clodsire')));a.observe(10,hud(side('Melmetal'),side('Clodsire')));a.surrender(12);a.result(18,'Loss');let b=a.finish()[0];assert.equal(b.result,'Loss');assert.equal(b.ending,'you-forfeit');
 const n=new C.HudTracker();n.observe(0,hud(side('Melmetal'),side('Clodsire')));n.observe(10,hud(side('Melmetal'),side('Clodsire')));n.surrender(11);b=n.finish()[0];assert.equal(b.result,'Loss');assert.equal(b.resultSource,'surrender dialog');
 const w=new C.HudTracker(),X=['fainted','fainted','fainted'];w.observe(0,hud(side('Melmetal'),side('Clodsire')));w.surrender(5);w.observe(20,hud(side('Melmetal'),side('Clodsire',X,0)));b=w.finish()[0];assert.equal(b.result,'Win');assert.equal(b.ending,undefined);});
test('HUD tracker: a long nameplate gap mid-battle continues the battle; after a fade to black or a fresh HUD it does not',()=>{
 const F=['fainted','alive','alive'],t=new C.HudTracker();t.observe(0,hud(side('Blastoise'),side('Wigglytuff')));t.observe(10,hud(side('Blastoise',F,1),side('Wigglytuff')));t.observe(45,hud(side('Clodsire',F,1),side('Marowak')));
 let b=t.finish();assert.equal(b.length,1);assert.deepEqual(b[0].opponent.map(p=>p.label),['Wigglytuff','Marowak']);
 const u=new C.HudTracker();u.observe(0,hud(side('Blastoise'),side('Wigglytuff')));u.observe(10,hud(side('Blastoise',F,1),side('Wigglytuff')));u.blackout(15);u.observe(45,hud(side('Clodsire',F,1),side('Marowak')));
 assert.equal(u.finish().length,2);});
test('banners: "X used Y!" and "Go, X!" are found inside OCR junk; the box follows the full screen height',()=>{
 assert.deepEqual(C.parseBanner('| Clodsire used Sludge Bomb! _'),{kind:'move',actor:'Clodsire',move:'Sludge Bomb'});
 assert.deepEqual(C.parseBanner('PP Go Pidgeoct!) nh'),{kind:'go',name:'Pidgeoct'});assert.equal(C.parseBanner('aa ee = ~seneep'),null);
 const box=(h,dy)=>C.bannerRead({data:new Uint8ClampedArray(886*h*4),width:886,height:h},dy).box;assert.deepEqual(box(1920,0).slice(1,2),[580]);assert.ok(Math.abs(box(1708,-50)[1]-481)<=1);
 const t=new C.HudTracker();t.observe(0,hud(side('Mandibuzz'),side('Clodsire')));t.observe(1,hud(side('Mandibuzz'),side('Clodsire')));t.move(2,'"4 lodsire used Sludge Bomb! =',60,gm.moves);
 assert.deepEqual(t.current.events.filter(e=>e.kind==='move').map(e=>[e.side,e.actor,e.move]),[['opponent','clodsire','SLUDGE_BOMB']]);
 const d=C.dictionary(gm.pokemon);assert.equal(t.go(3,'Go. Gourgeist!',d),true);assert.equal(t.current.events.at(-1).kind,'go');});
test('charged-move evidence: energy rules out slow-charging fast moves; illegal charged moves rule out a form',()=>{
 const K=require('../includes/meta/combat.js'),M=id=>gm.moves.find(m=>m.moveId===id),P=id=>gm.pokemon.find(p=>p.speciesId===id);
 // 3 charged moves (spent 150 energy) after 20 s of fighting: Mud Shot (9 per 1 s) can, a 3-energy-per-turn move cannot.
 const checks=[{spent:150,fight:20}];assert.equal(K.energyFactor(M('MUD_SHOT'),checks),1);assert.ok(K.energyFactor({energyGain:3,turns:1},checks)<1);
 assert.ok(K.movesetFactor(P('weezing'),'TACKLE',['PLAY_ROUGH'])<.1);assert.equal(K.movesetFactor(P('weezing_galarian'),'FAIRY_WIND',['PLAY_ROUGH']),1);
 assert.ok(K.movesetFactor(P('swampert'),'MUD_SHOT',['FRUSTRATION'])<.1);assert.equal(K.movesetFactor(P('swampert_shadow'),'MUD_SHOT',['FRUSTRATION']),1);});
test('HP bars: YouTube-shifted fill colours are found inside an outline; outline-less look-alikes are not',()=>{
 const Hp=require('../includes/meta/hp.js'),W=886,H=400,data=new Uint8ClampedArray(W*H*4);
 const rect=(x0,y0,x1,y1,c)=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*W+x)*4;data[i]=c[0];data[i+1]=c[1];data[i+2]=c[2];data[i+3]=255;}};
 rect(0,0,W,H,[70,110,60]);// grass
 // Opponent bar at x 447–702: white outline rows 100–101 / 125–126, dark inside, fill 60% teal as YouTube
 // encodes it (0,228,172; the old RGB test rejected it), a blurred left edge, then a 4% orange trail.
 rect(447,100,703,127,[215,215,215]);rect(449,102,701,125,[40,42,38]);
 for(let y=106;y<121;y++)rect(453+(y%3===0?1:0),y,453+148,y+1,[0,228,172]);rect(601,106,611,121,[235,160,20]);
 // Your bar (light-blue outline) at red, low HP.
 rect(47,250,303,277,[110,160,250]);rect(49,252,301,275,[45,40,40]);rect(53,256,53+20,271,[245,105,100]);
 // A teal blob the size of a bar fill with no outline (scenery / attack effect).
 rect(300,330,500,345,[10,230,170]);
 const bars=Hp.findBars({data,width:W,height:H},1000),as=Hp.assignBars(bars,W);
 assert.equal(bars.length,2,JSON.stringify(bars));
 assert.ok(Math.abs(as.opponent.fill-.6)<.02&&Math.abs(as.opponent.trail-.04)<.015&&as.opponent.y0===1106,JSON.stringify(as.opponent));
 assert.ok(as.my&&Math.abs(as.my.fill-20/246)<.02,JSON.stringify(as.my));});
test('HP hits: a step with no visible damage trail is measured by the step, never as a zero-size hit',()=>{
 const Hp=require('../includes/meta/hp.js'),series=[];let f=.8;for(let k=0;k<40;k++){const t=k*.1;if(k===10||k===25)f-=.04;series.push({t,fill:f,trail:0});}
 const h=Hp.hits(series);assert.equal(h.length,2);for(const x of h)assert.ok(Math.abs(x.size-.04)<.005,String(x.size));});
test('charged hits: the new level after the cutscene is the first steady run below the old one',()=>{
 const Hp=require('../includes/meta/hp.js'),pts=[[58.5,.89],[58.6,.886],[58.7,.89],[60,.89],[60.1,.886],[61.2,.48],[61.3,.48],[61.5,.472],[62.3,.033],[62.5,.484],[63,.48]].map(([t,fill])=>({t,fill}));
 assert.ok(Math.abs(Hp.chargedDamage(pts,59)-.41)<.01);assert.equal(Hp.chargedDamage(pts.slice(0,5),59),null);});
test('effectiveness text: OCR variants classify, and the matching move gains likelihood',()=>{const H=require('../includes/meta/hp.js'),K=require('../includes/meta/combat.js');
 assert.equal(H.effectKind('SUPER EFFECTIVE!'),'super');assert.equal(H.effectKind('Not very effective...'),'notVery');assert.equal(H.effectKind('Supar effectve'),'super');assert.equal(H.effectKind('Gyarados used Hydro'),null);
 const moves=gm.moves,byId=new Map(moves.map(m=>[m.moveId,m])),grass=['grass','none'];const counts={super:3,notVery:0,hits:4};
 if(K.effectLogL){assert.ok(K.effectLogL(counts,byId.get('EMBER'),grass)>K.effectLogL(counts,byId.get('WATER_GUN'),grass));}});
test('HP timeline is non-increasing per Pokémon, empty before entry, zero after faint',()=>{const H=require('../includes/meta/hp.js');
 const fills=[1,1,.9,.9,.8,.2,.8,.7,.7,.6,.5,.5,.4,.4,.3],b={start:0,end:10,my:[{key:'a',first:0}],opponent:[{key:'x',first:0},{key:'y',first:6}],segments:[{start:0,end:6,my:'a',opponent:'x'},{start:6,end:10,my:'a',opponent:'y'}],events:[{t:5.8,kind:'faint',side:'opponent'}],
  matchups:[{my:'a',opponent:'x',series:{t0:0,fps:2,my:fills.slice(0,12),opponent:fills.slice(0,12)}}]};
 const tl=H.hpTimeline(b),s=tl.my.a;for(let i=1;i<s.length;i++)assert.ok(s[i]<=s[i-1]+1e-9);assert.ok(Math.min(...s)>.2,'a single low glitch is not a floor');
 assert.equal(tl.opponent.x.at(-1),0);assert.equal(tl.opponent.y[0],null);
 const T=require('../includes/meta/timeline.js'),sum=T.summarize({...b,hp:tl,result:'Win'});assert.equal(sum.hp.opponent.y[0],-1);assert.equal(sum.hp.my.a[0],100);});
