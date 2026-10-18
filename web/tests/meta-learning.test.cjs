const test=require('node:test'),assert=require('node:assert/strict'),P=require('../includes/meta/validation-policy.js'),L=require('./meta-benchmark/learning-loop.cjs'),{refitRun}=require('./meta-benchmark/refit.cjs');
const gm=require('../includes/pro/data/gamemaster.json');
function fixture(){return {full:[{result:'Unknown',start:0,end:20,my:[{key:'mine',label:'Medicham',cp:1498,candidates:[{id:'medicham',name:'Medicham'}]}],opponent:[{key:'enemy',label:'Claydol',cp:1498,candidates:[{id:'claydol',name:'Claydol'},{id:'claydol_shadow',name:'Claydol'}]}],matchups:[{my:'mine',opponent:'enemy',start:0,end:20,hitsOnMy:[.036,.036,.036,.036,.036],hitsOnOpp:[.045,.045,.045,.045],cadenceOnMy:3,cadenceOnOpp:2,chargedOnMy:[],chargedOnOpp:[],effects:{onMy:{super:0,notVery:0,hits:5},onOpp:{super:0,notVery:0,hits:4}}}],evidence:{my:{mine:{moves:[]}},opponent:{enemy:{moves:[]}}}}]};}
test('offline refit uses saved physical data, clears conditioned answers, and does not compound priors',()=>{const raw=fixture(),learned={moves:{claydol:{MUD_SLAP:24}},shadow:{claydol:{yes:9,no:1},'*':{yes:9,no:1}}};const a=refitRun(raw,{gm,learned});const edited=structuredClone(raw);edited.full[0].opponent[0].answers={shadow:false,fastMove:'CONFUSION'};edited.full[0].opponent[0].inference={allRows:[{id:'claydol',move:'CONFUSION',p:1}]};assert.deepEqual(refitRun(edited,{gm,learned}),a);assert.deepEqual(refitRun(a,{gm,learned}),a);assert.ok(a.full[0].opponent[0].inference.rows.length);assert.deepEqual(a.full[0].matchups[0].effects,raw.full[0].matchups[0].effects);assert.equal(raw.full[0].opponent[0].inference,undefined);});
test('learning excludes model resolution and an entire held-out video; human corrections do not duplicate counts',()=>{const answers=[{qid:'a',kind:'fastMove',species:'claydol',value:'MUD_SLAP',video:{id:'one'}},{qid:'b',kind:'fastMove',species:'claydol',value:'MUD_SLAP',video:{id:'one'}},{qid:'c',kind:'fastMove',species:'claydol',value:'CONFUSION',video:{id:'two'}},{qid:'d',kind:'shadow',species:'claydol',value:true,source:'model'},{qid:'e',kind:'shadow',species:'claydol',value:null}];assert.deepEqual(L.learnedFor(answers,'one').moves,{claydol:{CONFUSION:1}});assert.deepEqual(L.learnedFor(answers).shadow,{});assert.deepEqual(L.mergeLearned({moves:{claydol:{MUD_SLAP:5}}},L.learnedFor(answers)).moves,{claydol:{MUD_SLAP:7,CONFUSION:1}});});
test('confirmed form labels correct species grouping for the same specimen',()=>{const learned=L.learnedFor([{qid:'f',kind:'form',species:'weezing',value:'weezing_galarian',video:{id:'v'},side:'my',key:'w',battle:0,allBattles:true},{qid:'m',kind:'fastMove',species:'weezing',value:'FAIRY_WIND',video:{id:'v'},side:'my',key:'w',battle:2}]);assert.deepEqual(learned.moves,{weezing_galarian:{FAIRY_WIND:1}});});
test('auto resolution needs physical evidence, independent labels and conservative calibration; audit remains',()=>{const q={qid:'q',kind:'fastMove',species:'claydol',video:{id:'target'},options:[{value:'MUD_SLAP'},{value:'CONFUSION'}]},answers=Array.from({length:8},(_,i)=>({qid:'a'+i,kind:'fastMove',species:'claydol',value:'MUD_SLAP',video:{id:'other'+i%3}})),p={value:'MUD_SLAP',p:.995,margin:.99,hits:6},ctx={answers,version:3,calibration:{fastMove:{right:50,total:50,lowerBound:L.wilson(50,50)}}};assert.ok(L.canResolve(q,p,ctx));assert.equal(L.canResolve(q,{...p,hits:0},ctx),null);assert.equal(L.canResolve({...q,audit:true},p,ctx),null);assert.equal(L.canResolve(q,p,{...ctx,calibration:{fastMove:{total:49,lowerBound:.99}}}),null);assert.equal(L.canResolve(q,p,{...ctx,answers:answers.map(a=>({...a,video:{id:'target'}}))}),null);assert.ok(L.wilson(50,50)>.9);});
test('question policy sorts impact, grouped kinds and video moments deterministically; deferred labels do not meet goals',()=>{const qs=[{qid:'a',kind:'result',video:{id:'v'},clip:[90,91]},{qid:'b',kind:'fastMove',modelP:.5,species:'s',video:{id:'v'},clip:[10,11]},{qid:'c',kind:'form',modelP:.5,species:'s',video:{id:'w'},clip:[3,4]}];assert.equal(P.orderQuestions(qs)[0].qid,'c');const v=P.orderQuestions(qs,{mode:'video'});assert.ok(v.findIndex(q=>q.qid==='b')<v.findIndex(q=>q.qid==='a'));assert.equal(P.groupKind(qs[0]),'Battle outcome');assert.equal(P.plan(qs,[{kind:'shadow',value:null}],{pending:7}).ready,false);assert.equal(P.plan(qs,[],{pending:8}).remaining,0);});
// Forms with no Shadow variant settle the Shadow question as false (reversible model resolution).
test('learning loop: open Shadow questions of forms without a Shadow entry resolve as false; eligible species stay open',()=>{
 const opts=[{value:true},{value:false}],mk=(key,ids,rows,extra={})=>({key,label:key,candidates:ids.map(id=>({id})),inference:{allRows:rows.map(([id,p])=>({id,move:'A',p})),forms:Object.entries(rows.reduce((m,[id,p])=>(m[id.replace(/_shadow$/,'')]=(m[id.replace(/_shadow$/,'')]||0)+p,m),{})).map(([value,p])=>({value,p})).sort((a,b)=>b.p-a.p),shadowP:rows.filter(([id])=>/_shadow$/.test(id)).reduce((t,[,p])=>t+p,0)},...extra}),
  run=opponent=>({full:[{opponent,my:[],matchups:[]}]}),q=key=>({qid:'v:'+key,kind:'shadow',video:{id:'v'},side:'opponent',key,battle:0,options:opts}),ctx={gm,version:7,answers:[]};
 // Origin Palkia (form p >= .98): resolved false, with the reason and source the app reads.
 const origin=mk('palkia',['palkia','palkia_shadow','palkia_origin'],[['palkia',.005],['palkia_shadow',.005],['palkia_origin',.99]]);
 const r=L.noShadowForm(q('palkia'),run([origin]),ctx);assert.equal(r.value,false);assert.equal(r.source,'model');assert.equal(r.reason,'form has no Shadow variant (palkia_origin)');assert.equal(r.modelVersion,7);assert.equal(r.rule,'no-shadow-form');
 // Open form with a Shadow-capable candidate: not resolved. A human Origin answer settles it.
 const open=mk('palkia',['palkia','palkia_shadow','palkia_origin'],[['palkia',.3],['palkia_shadow',.3],['palkia_origin',.4]]);
 assert.equal(L.noShadowForm(q('palkia'),run([open]),ctx),null);
 const human={qid:'f',kind:'form',value:'palkia_origin',video:{id:'v'},side:'opponent',key:'palkia',battle:0};
 assert.equal(L.noShadowForm(q('palkia'),run([open]),{...ctx,answers:[human]}).value,false);
 assert.equal(L.noShadowForm(q('palkia'),run([open]),{...ctx,answers:[{...human,source:'model'}]}),null,'model answers never settle the form');
 assert.equal(L.noShadowForm(q('palkia'),run([open]),{...ctx,answers:[{...human,key:'other'}]}),null);
 // Open form, none of the real candidates has a Shadow entry.
 assert.equal(L.noShadowForm(q('x'),run([mk('x',['palkia_origin','dialga_origin'],[['palkia_origin',.5],['dialga_origin',.5]])]),ctx).value,false);
 // Mega (nameplate says so), and a Mega that isn't named stays a regular-form question.
 const mega=mk('venusaur',['venusaur_mega'],[['venusaur_mega',1]],{label:'Mega Venusaur'});assert.equal(L.noShadowForm(q('venusaur'),run([mega]),ctx).value,false);
 // Ordinary Shadow-capable species: stays open. Dated gamemaster without a Shadow entry for it: resolved.
 const qwil=mk('qwilfish',['qwilfish','qwilfish_shadow'],[['qwilfish',.5],['qwilfish_shadow',.5]]);assert.equal(L.noShadowForm(q('qwilfish'),run([qwil]),ctx),null);
 const dated={...gm,pokemon:gm.pokemon.filter(p=>p.speciesId!=='qwilfish_shadow')};assert.equal(L.noShadowForm(q('qwilfish'),run([qwil]),{...ctx,gm:dated}).value,false);
 // Answered by a person elsewhere, wrong kind, or no 'No' option: left alone.
 assert.equal(L.noShadowForm({...q('palkia'),kind:'fastMove'},run([origin]),ctx),null);assert.equal(L.noShadowForm({...q('palkia'),options:[{value:true}]},run([origin]),ctx),null);
 // Your own Pokémon (asked once for every battle) are found in any battle.
 const mine={...q('palkia'),side:'my',allBattles:true,battle:0};assert.equal(L.noShadowForm(mine,{full:[{opponent:[],my:[],matchups:[]},{opponent:[],my:[origin],matchups:[]}]},ctx).value,false);});
test('refit applies the run\u2019s gamemaster to the Shadow answer: no Shadow entry for the form, shadowP is 0',()=>{
 const model={features:['auraT'],mu:[-3],sd:[1],w:[2],b:5},normal=refitRun(fixture(),{gm,shadowModel:model}).full[0].opponent[0].inference;assert.ok(normal.shadowP>0,'Claydol has a Shadow in the current gamemaster');
 const dated={...gm,pokemon:gm.pokemon.filter(p=>p.speciesId!=='claydol_shadow')},old=refitRun(fixture(),{gm:dated,shadowModel:model}).full[0].opponent[0].inference;assert.equal(old.shadowP,0);assert.ok(old.forms.every(f=>!/_shadow$/.test(f.value)));});
module.exports={fixture};

test('Download answers JSON folds without model-generated labels or duplicate correction counts',()=>{const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'meta-fold-'));try{const file=path.join(dir,'answers.json'),out=path.join(dir,'learned.json');fs.writeFileSync(file,JSON.stringify({answers:[{qid:'same',kind:'fastMove',species:'claydol',value:'CONFUSION'},{qid:'same',kind:'fastMove',species:'claydol',value:'MUD_SLAP'},{qid:'model',kind:'fastMove',species:'claydol',value:'CONFUSION',source:'model'},{qid:'null',kind:'shadow',species:'claydol',value:null}]}));cp.execFileSync(process.execPath,[path.join(__dirname,'meta-benchmark/fold-answers.cjs'),file],{env:{...process.env,LEARNED_OUT:out,NO_LABELS:'1'}});assert.deepEqual(JSON.parse(fs.readFileSync(out)).moves,{claydol:{MUD_SLAP:1}});}finally{fs.rmSync(dir,{recursive:true,force:true});}});

test('result questions: the timeline settles or closes them by policy, re-derived from the saved run; answers and reopened ones are left alone',()=>{
 const opts=require('../includes/meta/questions.js').RESULT_OPTIONS,Cc=require('../includes/meta/core.js');
 const b=(start,end,extra={})=>({start,end,result:'Unknown',resultSource:'',fainted:{my:0,opponent:0},flags:[],events:[],my:[],opponent:[],matchups:[],...extra});
 const raw={end:500,full:[b(0,100,{fainted:{my:1,opponent:3}}),b(107,200),b(205,300,{events:[{t:299,kind:'surrender'}]}),b(360,400)]};
 const run=refitRun(raw,{gm});assert.deepEqual(run.full.map(x=>x.resultSource),['faints','unresolvable','surrender','']);
 const q=i=>({qid:`claude-test:v.mp4:${i}:result`,kind:'result',battle:i,recording:'v.mp4',video:{id:'v'},clip:[raw.full[i].end-2,raw.full[i].end+14],options:opts});
 let r=L.resultResolution(q(0),run,7);assert.deepEqual([r.value,r.source,r.rule],['Win','timeline','faints']);
 r=L.resultResolution(q(1),run,7);assert.deepEqual([r.value,r.source,r.policy],[null,'policy','no-result-screen']);assert.match(r.reason,/No result screen; timeline inconclusive/);
 assert.equal(L.resultResolution(q(2),run,7).value,'Loss:you-forfeit');assert.equal(L.resultResolution(q(3),run,7),null);
 assert.equal(L.resultResolution({...q(0),clip:[50,66]},run,7),null);// the battle moved since the question was exported
 const ans=[{qid:q(0).qid,kind:'result',battle:0,video:{id:'v'},value:'Win'},{qid:q(2).qid,kind:'result',battle:2,video:{id:'v'},value:'Loss'}],stats=L.ruleStats(ans,()=>raw);
 const m=L.resultMetrics(ans,new Map([['v',run]]),stats);
 // The owner's rule: a forfeit is a win or loss, so the surrender rule's "Loss:you-forfeit" matches the answer "Loss".
 assert.deepEqual(m.calibration,{heldOut:2,heldOutRight:2,byRule:{faints:{right:1,total:1,videos:1,uncertain:false,promoted:false},surrender:{right:1,total:1,videos:1,uncertain:false,promoted:false}}});const {byLanguage,byChannel,...totals}=m.sources;assert.deepEqual(totals,{read:0,inferred:0,human:2,unresolvable:1,open:1});assert.deepEqual(byLanguage.en,{read:0,inferred:0,human:2,unresolvable:1,open:1,evidence:0});assert.ok(byChannel.unknown);
 assert.equal(Cc.inferResult(run.full[3],{next:null,videoEnd:500}),null);});

test('result accuracy compares outcomes: a forfeit counts as the win or loss it is',()=>{const Cc=require('../includes/meta/core.js');
 assert.equal(Cc.sameOutcome('Win','Win:opponent-forfeit'),true);assert.equal(Cc.sameOutcome('Loss:you-forfeit','Loss'),true);
 assert.equal(Cc.sameOutcome('Win','Loss:you-forfeit'),false);assert.equal(Cc.sameOutcome(null,'Win'),false);assert.equal(Cc.outcomeOf('Tie'),'Tie');});

test('result rules: the cutscene knockout rule learns from saved runs (b.cutsceneBar) and settles only once the gate passes',()=>{
 const opts=require('../includes/meta/questions.js').RESULT_OPTIONS;
 // Opponent at 2 fainted, you at 1, both own bars standing, the centred cutscene bar empty at the end; no fade, no screen.
 const b=i=>({start:i*100,end:i*100+90,result:'Unknown',resultSource:'',fadeAt:null,resultUnread:0,fainted:{my:1,opponent:2},flags:[],events:[],my:[],opponent:[],
  matchups:[{start:i*100+60,end:i*100+90,my:'a',opponent:'b',series:{t0:i*100+87,fps:10,my:Array(30).fill(.5),opponent:Array(30).fill(.4)}}],cutsceneBar:[[i*100+90.5,.2,980],[i*100+90.8,0,980],[i*100+91.2,0,980]]});
 const raws={},answers=[];for(let v=0;v<6;v++){raws['v'+v]={end:9999,full:[0,1,2,3,4].map(b)};for(let i=0;i<5;i++)answers.push({qid:`k${v}:${i}`,kind:'result',battle:i,video:{id:'v'+v},value:'Win'});}
 const run=refitRun(raws.v0,{gm}),q={qid:'x',kind:'result',battle:0,video:{id:'v0'},clip:[raws.v0.full[0].end-2,raws.v0.full[0].end+14],options:opts};
 assert.deepEqual([run.full[0].result,run.full[0].resultGuess.rule,run.full[0].resultGuess.value],['Unknown','knockout','Win']);assert.equal(L.resultResolution(q,run,1),null);
 const stats=L.ruleStats(answers,vid=>raws[vid]);assert.deepEqual([stats.knockout.right,stats.knockout.total,stats.knockout.videos],[30,30,6]);assert.deepEqual(L.promotedRules(stats),['knockout']);
 assert.deepEqual(L.promotedRules(L.ruleStats(answers.slice(0,29),vid=>raws[vid])),[],'29 answers are too few');
 const run2=refitRun(raws.v0,{gm,promotedRules:['knockout']}),r=L.resultResolution(q,run2,1);assert.deepEqual([run2.full[0].result,run2.full[0].resultSource,r.value,r.source,r.rule],['Win','knockout','Win','timeline','knockout']);});
test('result rules: uncertain inferences are asked with the measured guess, and a rule is promoted at 95% on 30 answers from 5 videos',()=>{
 const opts=require('../includes/meta/questions.js').RESULT_OPTIONS,Cc=require('../includes/meta/core.js');
 // 40 battles each in 8 videos: fade after both alive (tracked extraction), answers 'Win:opponent-forfeit' 38 times.
 const b=(i)=>({start:i*100,end:i*100+90,result:'Unknown',resultSource:'',fadeAt:i*100+92,resultUnread:0,fainted:{my:1,opponent:1},flags:[],events:[],my:[],opponent:[],matchups:[]});
 const raws={},answers=[];for(let v=0;v<8;v++){raws['v'+v]={end:9999,full:[0,1,2,3,4].map(b)};for(let i=0;i<5;i++)answers.push({qid:`q${v}:${i}`,kind:'result',battle:i,video:{id:'v'+v},value:v*5+i<38?'Win:opponent-forfeit':'Loss'});}
 let stats=L.ruleStats(answers,vid=>raws[vid]);assert.deepEqual([stats.fade.right,stats.fade.total,stats.fade.videos],[38,40,8]);assert.deepEqual(L.promotedRules(stats),['fade']);
 // 36/40 (90%) is not enough; 38/29 answers is too few.
 stats=L.ruleStats(answers.map((a,i)=>i<4?{...a,value:'Loss'}:a),vid=>raws[vid]);assert.deepEqual(L.promotedRules(stats),[]);
 assert.deepEqual(L.promotedRules(L.ruleStats(answers.slice(0,25),vid=>raws[vid])),[]);
 // Not promoted: the question stays open with the guess and the measured precision; promoted: a reversible timeline resolution.
 const run=refitRun(raws.v0,{gm}),q={qid:'x',kind:'result',battle:0,video:{id:'v0'},clip:[raws.v0.full[0].end-2,raws.v0.full[0].end+14],options:opts};
 assert.equal(run.full[0].resultGuess.rule,'fade');assert.equal(L.resultResolution(q,run,1),null);
 const pr=L.resultPrediction(q,run,L.ruleStats(answers.slice(0,25),vid=>raws[vid]));assert.deepEqual([pr.modelTop,pr.resultRule],['Win:opponent-forfeit','fade']);assert.equal(pr.modelP,1);assert.match(pr.detail,/25 of 25|agreed/);
 const run2=refitRun(raws.v0,{gm,promotedRules:['fade']});assert.deepEqual([run2.full[0].result,run2.full[0].ending,run2.full[0].resultSource],['Win','opponent-forfeit','fade']);
 const r=L.resultResolution(q,run2,1);assert.deepEqual([r.value,r.source,r.rule],['Win:opponent-forfeit','timeline','fade']);});

test('result evidence: read result screens, held out by video, settle a state only when it is ≥95% one way',()=>{const C=require('../includes/meta/core.js');
 // A battle that ended with these counters and no HP readings: its evidence keys are the counters alone.
 const battle=(my,opponent,extra={})=>({start:0,end:100,fainted:{my,opponent},matchups:[],events:[],flags:[],...extra});
 const ex=[];for(let v=0;v<10;v++)for(let i=0;i<5;i++){ex.push({video:'v'+v,result:i<5?'Win':'Loss',keys:C.resultEvidenceKey(battle(1,2))});ex.push({video:'v'+v,result:i<3?'Win':'Loss',keys:C.resultEvidenceKey(battle(2,2))});}
 const m=C.fitResultEvidence(ex),one=m.states['1-2'],tie=m.states['2-2'];
 assert.deepEqual([one.n,one.videos,one.value,one.precision],[50,10,'Win',1]);assert.deepEqual([tie.n,tie.value],[50,'Win']);assert.equal(tie.precision,.6);
 const d=C.evidenceDecision(battle(1,2),m);assert.deepEqual([d.value,d.confident,d.key],['Win',true,'1-2|unknown|no-fade'],'the most specific state with enough battles');
 assert.equal(C.evidenceDecision(battle(2,2),m).confident,false,'a 60% state guesses, never settles');
 assert.equal(C.evidenceDecision(battle(0,0),m),null,'no state with enough battles');
 // Settled through inferResult (source "evidence"); the 2–2 state only adds a guess to an otherwise guessless question.
 assert.deepEqual([C.inferResult(battle(1,2),{evidence:m}).result,C.inferResult(battle(1,2),{evidence:m}).source],['Win','evidence']);
 const g=C.inferResult(battle(2,2),{evidence:m});assert.deepEqual([g.source,g.rule,g.value,g.p],['guess','evidence-guess','Win',.6]);
 assert.equal(C.inferResult(battle(1,2),{evidence:{...m,ownerBlocked:true}}).source,'guess','blocked by the owner’s answers: guesses only');
 // Fewer than 5 videos or 30 battles: no decision.
 assert.equal(C.evidenceDecision(battle(1,2),C.fitResultEvidence(ex.filter(e=>['v0','v1','v2','v3'].includes(e.video)))),null);
 // A battle settled this way resolves its Validate question like any timeline rule.
 const L=require('./meta-benchmark/learning-loop.cjs'),opts=require('../includes/meta/questions.js').RESULT_OPTIONS;const b=battle(1,2);C.applyInferredResults([b],{evidence:m});
 const r=L.resultResolution({qid:'x',kind:'result',battle:0,recording:'v.mp4',video:{id:'v'},clip:[98,114],options:opts},{full:[b]},3);assert.deepEqual([r.value,r.rule,r.source],['Win','evidence','timeline']);});
