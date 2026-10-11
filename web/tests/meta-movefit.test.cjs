// Fast-move and form evidence (combat.js FIT terms), league from CPs, threshold choice and move auto-resolution.
const test=require('node:test'),assert=require('node:assert/strict'),K=require('../includes/meta/combat.js'),L=require('./meta-benchmark/learning-loop.cjs'),T=require('./meta-benchmark/movefit-threshold.cjs'),{battleLeague}=require('./meta-benchmark/refit.cjs');
const gm=require('../includes/pro/data/gamemaster.json');for(const m of gm.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);
const P=id=>gm.pokemon.find(p=>p.speciesId===id),M=id=>gm.moves.find(m=>m.moveId===id);
const timing={...K.FIT.timing,w:1};
test('hit spacing: gaps that are whole moves favour the true duration; a missed hit is allowed, too-fast hits are not',()=>{
 const every3=[0,1.5,3,4.5,6],withMiss=[0,1.5,4.5,6];
 assert.ok(K.gapLogL(every3,3,timing)>K.gapLogL(every3,1,timing));assert.ok(K.gapLogL(every3,3,timing)>K.gapLogL(every3,5,timing));
 assert.ok(K.gapLogL(withMiss,3,timing)>K.gapLogL(withMiss,5,timing));assert.equal(K.gapLogL(every3,3,{...timing,w:0}),0);});
test('energy accounting uses clock fighting time; a move that cannot have earned the energy is penalized',()=>{
 const b={start:0,end:60,my:[{key:'a'}],opponent:[{key:'x'}],segments:[{start:0,end:30,my:'a',opponent:'x'}],events:[{t:20,kind:'move',side:'opponent',actor:'x',move:'M'}]};
 const fight=K.clockFight(b,{perCharged:5});assert.equal(fight('my','a',20),20);assert.equal(fight('my','a',30),25);
 const slow={energyGain:3,turns:2},fast={energyGain:10,turns:2};const checks=[{spent:50,fight:12}];
 assert.ok(K.energyLogL(slow,checks)<0);assert.equal(K.energyLogL(fast,checks),0);});
test('type icons: a missed second icon does not rule out a dual type, and a colour shift learned from the video is applied',()=>{
 const p={candidates:[{id:'typhlosion',types:['fire','none']},{id:'typhlosion_hisuian',types:['fire','ghost']}],typeVotes:{ghost:9,fire:2}};
 const ll=K.iconLogL(p,K.iconModel([]),{nEff:6});assert.ok(ll.get('typhlosion_hisuian')>ll.get('typhlosion'));
 // In this video fire icons read as ground: a regular Typhlosion read "ground" stays plausible.
 const shifted=[{my:[{key:'c',candidates:[{id:'charizard',types:['fire','flying']}],typeVotes:{'flying/ground':30}},{key:'n',candidates:[{id:'arcanine',types:['fire','none']}],typeVotes:{ground:30}}],opponent:[]}];
 const q={candidates:p.candidates,typeVotes:{ground:20}},plain=K.iconLogL(q,K.iconModel([],200),{nEff:6}),adapted=K.iconLogL(q,K.iconModel(shifted,20),{nEff:6});
 assert.ok(adapted.get('typhlosion')-adapted.get('typhlosion_hisuian')>=plain.get('typhlosion')-plain.get('typhlosion_hisuian'));});
test('prior-only inference gives forms and moves for a Pokémon never measured',()=>{const inf=K.priorInference([P('ninetales'),P('ninetales_alolan')],{learned:{moves:{ninetales:{FIRE_SPIN:5}}}});
 assert.equal(inf.matchups,0);assert.ok(Math.abs(inf.forms.reduce((a,f)=>a+f.p,0)-1)<1e-9);assert.ok(inf.moves.some(m=>m.value==='FIRE_SPIN'));});
test('vectorized matchup likelihood matches the direct sum over stat combinations',()=>{
 const opp={candidates:[P('claydol')],cp:1498},my={candidates:[P('medicham')],cp:1498},hitsOnMy={sizes:[.04,.041,.039],times:[0,1.5,3]},hitsOnOpp={sizes:[.05,.052],times:[0,1]};
 const r=K.inferMatchup({opp,my,hitsOnMy,hitsOnOpp,moves:gm.moves,combos:6,timing:{...timing,w:0}}),F=K.FIT,floor=F.outlier*(1/.4)*F.sigma*Math.sqrt(2*Math.PI);
 const h=r.all.find(x=>x.oppMove==='MUD_SLAP'&&x.myMove==='COUNTER'),A=K.statCombos(P('claydol'),1498),B=K.statCombos(P('medicham'),1498),sp=(l,n)=>l.length<=n?l:Array.from({length:n},(_,i)=>l[Math.floor(i*(l.length-1)/(n-1))]);
 const g=(x,f)=>{f*=F.scale;const s2=F.sigma**2+(F.relSigma*f)**2;return (1-F.outlier)*Math.sqrt(F.sigma**2/s2)*Math.exp(-((x-f)**2)/(2*s2))+floor;};let like=0;const a6=sp(A,6),b6=sp(B,6);
 for(const a of a6)for(const b of b6){let l=1;for(const x of hitsOnMy.sizes)l*=g(x,K.damage(M('MUD_SLAP'),K.types(P('claydol')),a.atk,K.types(P('medicham')),b.def)/b.hp);for(const x of hitsOnOpp.sizes)l*=g(x,K.damage(M('COUNTER'),K.types(P('medicham')),b.atk,K.types(P('claydol')),a.def)/a.hp);like+=l;}
 const direct=Math.log(like/(a6.length*b6.length)+1e-300);assert.ok(Math.abs(h.evidence-direct)<1e-9,`${h.evidence} vs ${direct}`);});
test('league from nameplate CPs overrides an impossible video league',()=>{const b=cps=>({my:cps.map(cp=>({cp})),opponent:[]});
 assert.equal(battleLeague(b([3500,2400]),1500),10000);assert.equal(battleLeague(b([2400,1490]),1500),2500);assert.equal(battleLeague(b([480,499,450]),1500),500);assert.equal(battleLeague(b([1490,1200]),1500),1500);});
test('resolution threshold: lowest posterior whose resolved answers stay at least 95% right',()=>{
 const rows=[...Array.from({length:40},(_,i)=>({p:.95,right:true,video:'v'+i%8})),...Array.from({length:20},(_,i)=>({p:.85,right:i%2===0,video:'w'+i%5}))];
 const c=T.choose(rows,.95);assert.equal(c.pick.t,.9);assert.equal(c.pick.n,40);assert.ok(c.pick.lower>.9);});
test('fast moves and forms auto-resolve only above the held-out threshold; audits and unknown options stay open',()=>{
 const q={qid:'q',kind:'fastMove',species:'claydol',video:{id:'t'},options:[{value:'MUD_SLAP'},{value:'CONFUSION'}]},cal={fastMove:{threshold:.9,right:80,total:81,videoCount:20,lowerBound:.93}},p={value:'MUD_SLAP',p:.95,margin:.92,hits:0};
 assert.ok(L.canResolve(q,p,{answers:[],calibration:cal,version:1}));assert.equal(L.canResolve(q,{...p,p:.85,margin:.75},{answers:[],calibration:cal,version:1}),null);
 assert.equal(L.canResolve({...q,audit:true},p,{answers:[],calibration:cal,version:1}),null);assert.equal(L.canResolve(q,{...p,value:'BITE'},{answers:[],calibration:cal,version:1}),null);
 assert.equal(L.canResolve(q,p,{answers:[],calibration:{fastMove:{threshold:null,lowerBound:0}},version:1}),null);});
