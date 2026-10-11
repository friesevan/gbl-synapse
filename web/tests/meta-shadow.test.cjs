// Shadow classifier (includes/meta/shadow-model.js), its CV/threshold tools and resolution gates.
const test=require('node:test'),assert=require('node:assert');
const S=require('../includes/meta/shadow-model.js'),C=require('./meta-benchmark/shadow-cv.cjs'),L=require('./meta-benchmark/learning-loop.cjs');
// One battle: opponent Swampert vs your Azumarill; the Shadow-Swampert hypotheses explain the hits better.
function battle({purpleOpp=.02,purpleMy=0,shadowBetter=true}={}){
 const rows=[];for(const opp of ['swampert','swampert_shadow'])for(const my of ['azumarill','azumarill_shadow'])rows.push({opp,oppMove:'MUD_SHOT',my,myMove:'BUBBLE',evidence:(opp.endsWith('_shadow')===shadowBetter?0:-2)+(my.endsWith('_shadow')?-1:0),oppPrior:Math.log(.5),myPrior:Math.log(.5),predictedOnMy:[.05,.06],predictedOnOpp:[.04,.05]});
 const inf=ids=>({allRows:ids.map((id,i)=>({id,move:i<2?'A':'B',p:.25})),forms:[{value:ids[0],p:1}],moves:[{value:'A',p:.5},{value:'B',p:.5}],shadowP:.5});
 return {my:[{key:'azumarill',candidates:[{id:'azumarill'},{id:'azumarill_shadow'}],inference:{...inf(['azumarill','azumarill_shadow','azumarill','azumarill_shadow']),shadowP:.1}}],
  opponent:[{key:'swampert',candidates:[{id:'swampert'},{id:'swampert_shadow'}],inference:inf(['swampert','swampert_shadow','swampert','swampert_shadow'])},{key:'mewtwo',candidates:[{id:'mewtwo'}]}],
  matchups:[{my:'azumarill',opponent:'swampert',hitsOnMy:[.066,.066,.066],hitsOnOpp:[.045,.045],auraOpponent:{purple:purpleOpp},auraMy:{purple:purpleMy},result:{all:rows}}]};}

test('features: damage cells favour the better-explaining Shadow status; aura and side recorded; unshadowable → null',()=>{
 const b=battle(),f=S.features([b],{side:'opponent',key:'swampert',battle:0},{});
 assert.ok(f.x.dmgReg>1.5&&f.x.dmgQ>1.5,'Shadow hypotheses explain the hits better');assert.ok(f.x.ratioDealt>.1,'hits 20% above the regular prediction');
 assert.equal(f.x.side,0);assert.ok(Math.abs(f.x.auraT-Math.log10(.02+3e-4))<1e-9);assert.equal(f.info.matchups,1);
 const g=S.features([battle({shadowBetter:false})],{side:'opponent',key:'swampert',battle:0},{});assert.ok(g.x.dmgReg<-1.5);
 assert.equal(S.features([b],{side:'opponent',key:'mewtwo',battle:0},{}),null,'no Shadow form → no question');
 const mine=S.features([b,battle()],{side:'my',key:'azumarill',battle:null},{});assert.equal(mine.x.side,1);assert.equal(mine.info.aura,2,'your Pokémon pools every battle');});

test('missing measurements are imputed as the training mean; fit separates a clean signal',()=>{
 const rows=[];for(let i=0;i<80;i++){const y=i%2;rows.push({video:'v'+(i%8),y,x:{auraT:y?-1.5:-3.4,dmgQ:(i%5-2)/2,oldLogit:0}});}
 const m=S.fit(rows,{l2:1,names:['auraT','dmgQ','oldLogit']});assert.ok(S.predict({auraT:-1.5,dmgQ:0,oldLogit:0},m)>.9);assert.ok(S.predict({auraT:-3.4,dmgQ:0,oldLogit:0},m)<.1);
 const none=S.predict({auraT:null,dmgQ:0,oldLogit:0},m);assert.ok(none>.3&&none<.7,'unknown aura moves nothing');
 const oof=C.crossValidate(rows,{l2:1,names:['auraT','dmgQ','oldLogit']});assert.equal(C.metrics(oof,rows.map(r=>r.y)).right,80);});

test('applyToBattles sets a consistent posterior; model false only records features',()=>{
 const b=battle();S.applyToBattles([b],false,{});const o=b.opponent[0];assert.equal(o.inference.shadowP,.5);assert.ok(o.shadowModel.x);assert.equal(o.shadowModel.p,null);
 const model={features:['auraT'],mu:[-3],sd:[1],w:[2],b:0},b2=battle();S.applyToBattles([b2],model,{});const p=b2.opponent[0];
 assert.ok(Math.abs(p.inference.shadowP-p.shadowModel.p)<1e-9);assert.equal(p.inference.shadowPOld,.5);
 const tot=p.inference.allRows.reduce((s,r)=>s+r.p,0),forms=p.inference.forms.reduce((s,r)=>s+r.p,0);assert.ok(Math.abs(tot-1)<1e-9&&Math.abs(forms-1)<1e-9);
 assert.ok(!b2.opponent[1].shadowModel,'unshadowable species untouched');});

test('the committed default model is complete and calibrated per direction',()=>{const m=S.DEFAULT_MODEL;
 assert.deepEqual(m.features,S.MODEL_FEATURES);assert.ok(m.w.every(Number.isFinite)&&m.mu.length===m.w.length);
 assert.ok(m.thresholds.regular.accuracy>=.95&&m.thresholds.regular.n>=25);assert.ok(m.cv.new.logLoss<m.cv.old.logLoss,'beats the old posterior out of fold');
 assert.ok(Object.keys(m.speciesPurple.opponent).length>20);});

test('thresholds are per direction; trainShadow refuses tiny data',()=>{
 const ps=[.02,.03,.04,.05,.3,.6,.9,.95],ys=[0,0,0,0,1,0,0,1];const r=C.threshold(ps,ys,{target:.95,minN:4,direction:'regular'});
 assert.equal(r.n,4);assert.ok(Math.abs(r.confidence-.95)<1e-9);assert.equal(C.threshold(ps,ys,{target:.95,minN:2,direction:'shadow'}),null);
 assert.equal(C.trainShadow([{x:{},y:1,video:'a'}]),null);});

test('Shadow resolution follows the classifier gate; audits, weak thresholds and unproven directions stay open',()=>{
 const t={confidence:.88,n:28,right:27,accuracy:.964,lowerBound:.82,videos:14},model={thresholds:{regular:t,shadow:null}};
 const q={qid:'q',kind:'shadow',options:[{value:true},{value:false}]},no={value:false,p:.93,margin:.86,hits:0};
 const r=L.canResolve(q,no,{shadowModel:model,version:5,answers:[],calibration:{}});assert.equal(r.value,false);assert.equal(r.source,'model');assert.match(r.reason,/27\/28/);
 assert.equal(L.canResolve({...q,audit:true},no,{shadowModel:model}),null);assert.equal(L.canResolve(q,{...no,p:.8},{shadowModel:model}),null);
 assert.equal(L.canResolve(q,{value:true,p:.99,margin:.98},{shadowModel:model}),null,'no proven Shadow-direction threshold');
 assert.equal(L.canResolve(q,no,{shadowModel:{thresholds:{regular:{...t,n:20}}}}),null);assert.equal(L.canResolve(q,no,{shadowModel:{thresholds:{regular:{...t,videos:3}}}}),null);
 assert.equal(L.canResolve(q,no,{}),null,'no classifier → no resolution');});

test('classifier rows: your Pokémon are found in any battle; labels without evidence are skipped',()=>{
 const run={full:[{my:[{key:'x'}],opponent:[]},{my:[{key:'x',shadowModel:{x:{a:1}}}],opponent:[{key:'o',shadowModel:{x:{a:2}}}]}]};
 const rows=L.shadowRows([{qid:'1',kind:'shadow',side:'my',key:'x',battle:0,value:true,video:{id:'v'}},{qid:'2',kind:'shadow',side:'opponent',key:'o',battle:1,value:false,video:{id:'v'}},{qid:'3',kind:'shadow',side:'opponent',key:'o',battle:0,value:false,video:{id:'v'}},{qid:'4',kind:'shadow',side:'my',key:'x',battle:0,value:null,video:{id:'v'}}],()=>run);
 assert.deepEqual(rows.map(r=>[r.qid,r.y,r.x.a]),[['1',1,1],['2',0,2]]);});

test('focus shots: the attacker is framed first, then the defender; shielded hits are flagged',()=>{
 const Aura=require('../includes/meta/aura.js'),normal=t=>({t,bars:[{x0:56,x1:302,y0:1140,y1:1152,fill:.8},{x0:452,x1:698,y0:600,y1:612,fill:.6}],focus:null});
 const focus=(t,purple,y0=850)=>({t,bars:[{x0:320,x1:566,y0,y1:y0+12,fill:.6}],focus:{y0,fill:.6,trail:0,purple,red:0}});
 const frames=[];for(let t=4;t<9.9;t+=.1)frames.push(normal(+t.toFixed(1)));for(const t of [9.8,9.9,10,10.1,10.2,10.3])frames.push(focus(t,.2));for(const t of [11.2,11.3,11.4,11.5,11.6])frames.push(focus(t,0,830));
 frames.push(focus(13.5,.5),focus(13.6,.5));// a shot no banner explains: assigned by HP fill (0.6 = the opponent's)
 const b={start:0,end:30,events:[{t:10,kind:'move',side:'opponent',actor:'gengar',move:'SHADOW_BALL'}],segments:[{start:0,end:30,my:'mew',opponent:'gengar'}]};
 const all=Aura.focusMoments(b,frames),m=all.filter(x=>x.role!=="unknown");assert.equal(m.length,2);assert.deepEqual(all.filter(x=>x.role==="unknown").map(x=>[x.side,x.key,x.purple]),[["opponent","gengar",.5]]);
 assert.deepEqual(m.map(x=>[x.role,x.side,x.key,x.purple,x.shielded]),[['attacker','opponent','gengar',.2,false],['defender','my','mew',0,false]]);
 b.events.push({t:10.5,kind:'shield',side:'my'});assert.equal(Aura.focusMoments(b,frames)[1].shielded,true);
 assert.deepEqual(Aura.focusMoments(b,frames.filter(f=>!f.focus)),[]);});
test('setShadowP keeps each form’s probability (the change applies within forms)',()=>{
 const inf={allRows:[{id:'typhlosion_hisuian',move:'A',p:.6},{id:'typhlosion',move:'A',p:.2},{id:'typhlosion_shadow',move:'A',p:.2}]};S.setShadowP(inf,.05);
 assert.equal(inf.forms[0].value,'typhlosion_hisuian');assert.ok(Math.abs(inf.forms[0].p-.6)<1e-9);assert.ok(inf.shadowP<.2);
 const one={allRows:[{id:'x',move:'A',p:.7},{id:'x_shadow',move:'A',p:.3}]};S.setShadowP(one,.8);assert.ok(Math.abs(one.shadowP-.8)<1e-9);});
test('focus features: shielded hits and purple-effect moves are skipped; no focus shots → empty',()=>{
 const types=new Map([['SHADOW_BALL','ghost'],['SURF','water']]),b={focus:[{side:'opponent',key:'a',role:'attacker',n:5,purple:.1,move:'SURF'},{side:'opponent',key:'a',role:'defender',n:5,purple:.3,move:'SURF',shielded:true},{side:'opponent',key:'a',role:'attacker',n:5,purple:.4,move:'SHADOW_BALL'}]};
 assert.deepEqual(S.focusList([b],'opponent','a',types).map(m=>m.purple),[.1]);assert.deepEqual(S.focusList([{}],'opponent','a',types),[]);});
test('Pokémon without focus shots use the no-focus held-out thresholds',()=>{
 const ok={confidence:.9,n:30,right:30,accuracy:1,lowerBound:.88,videos:9},model={thresholds:{regular:ok,shadow:null},thresholdsNoFocus:{regular:null,shadow:null}};
 assert.ok(L.shadowGate(model,false,4));assert.equal(L.shadowGate(model,false,0),null);assert.ok(L.shadowGate({thresholds:{regular:ok}},false,0));});
