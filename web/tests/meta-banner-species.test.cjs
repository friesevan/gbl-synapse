// Species from banners when the nameplate names are cropped off (core.js bannerTeam, NameLanguage.bannerVote).
const {test}=require('node:test'),assert=require('node:assert/strict'),C=require('../includes/meta/core.js'),gm=require('../includes/pro/data/gamemaster.json');
const names=require('../includes/meta/species-names.json').names,dict=C.dictionary(gm.pokemon);
const locales=Object.fromEntries(Object.keys(C.LOCALES).map(l=>[l,C.localeDictionary(gm.pokemon,names,l,dict)]));
const moveMaps=Object.fromEntries(Object.keys(C.LOCALES).map(l=>[l,C.moveDictionary(gm.moves,require('../includes/meta/move-names.json').names,l)]));
const ctx={locales,moveMaps,moves:gm.moves,dict},lb=(text,lang='ja')=>C.localBanner(text,{...ctx,lang});
// A HUD whose names are cropped off: balls and shields read, no species (hit null).
const A=['alive','alive','alive'],hud=(myShields=2,oppShields=2,oppFainted=0)=>({my:{balls:A,fainted:0,shields:myShields},opponent:{balls:A.map((b,i)=>i<oppFainted?'fainted':b),fainted:oppFainted,shields:oppShields}});
const banner=(tr,t,text)=>{const p=lb(text);if(p.kind==='go')tr.go(t,text,dict,p);else tr.move(t,text,90,gm.moves,p,dict);};

test('CJK send-out banners name the side; Latin "Go, X!" announces either side',()=>{
 assert.deepEqual(lb('相手がゼクロムをくりだした！'),{kind:'go',name:'zekrom',side:'opponent'});
 assert.deepEqual(lb('ゆけっ！メガミュウツーY！'),{kind:'go',name:'megamewtwoy',side:'my'});
 assert.deepEqual(lb('상대가 자시안(을)를 내보냈다!','ko'),{kind:'go',name:'zacian',side:'opponent'});
 assert.deepEqual(lb('Los, Glurak!','de'),{kind:'go',name:'charizard'});assert.equal(C.parseBanner('Go, Zekrom!').side,undefined);});

test('banner language evidence: a candidate model\'s "X used Y!" with a dictionary species and move',()=>{
 assert.equal(C.bannerEvidence('ゼクロムはかみくだくを使った！','ja',ctx).move,'Crunch');
 assert.equal(C.bannerEvidence('相手がゼクロムをくりだした！','ja',ctx),null,'a send-out names no move');
 assert.equal(C.bannerEvidence('ゼクロムはほげほげを使った！','ja',ctx),null,'no such move');
 assert.equal(C.bannerEvidence('Zekrom used Crunch!','ja',ctx),null);assert.equal(C.bannerEvidence('Glurak hat Lohekanonade eingesetzt!','de',ctx),null,'CJK models only');
 const L=new C.NameLanguage();assert.equal(L.bannerSearching(),true);
 assert.equal(L.bannerVote('ja','zekrom|Crunch'),false);assert.equal(L.bannerVote('ja','zekrom|Crunch'),false,'the same banner again is one vote');
 assert.equal(L.bannerVote('ja','megamewtwoy|Shadow Ball'),true);assert.equal(L.lang,'ja');assert.equal(L.bannerSearching(),false);});

test('English videos never read banners with CJK models or switch on them; the budget ends the search',()=>{
 const L=new C.NameLanguage();C.readName({text:'Zekrom',confidence:90},{dict,locales,language:L});assert.equal(L.count('en'),1);
 assert.equal(L.bannerSearching(),false,'English has named a species');assert.equal(L.bannerVote('ja','a|b'),false);assert.equal(L.bannerVote('ja','c|d'),false);assert.equal(L.lang,'en');
 const M=new C.NameLanguage({maxBanners:2});M.bannerTries=2;assert.equal(M.bannerSearching(),false);});

test('a battle whose names are cropped off takes its species from banners, in order, with sides',()=>{
 const tr=new C.HudTracker();for(let t=0;t<=60;t+=.5)tr.observe(t,hud());
 banner(tr,1,'相手がゼクロムをくりだした！');banner(tr,2,'ゆけっ！メガミュウツーY！');
 banner(tr,10,'ゼクロムはかみくだくを使った！');banner(tr,10.5,'ゼクロムはかみくだくを使った！');   // one banner read twice
 banner(tr,20,'相手がザシアンをくりだした！');banner(tr,25,'メガミュウツーYはサイコブレイクを使った！');
 banner(tr,30,'ザシアンはきょじゅうざんを使った！');banner(tr,40,'相手がイベルタルをくりだした！');banner(tr,45,'ゆけっ！カイオーガ！');
 const [b]=tr.finish();
 assert.deepEqual(b.opponent.map(p=>p.key),['zekrom','zacian','yveltal']);assert.deepEqual(b.my.map(p=>p.key),['megamewtwoy','kyogre']);
 assert.ok(b.opponent.every(p=>p.speciesFrom==='banners'&&p.confidence===40));assert.ok(b.flags.some(f=>f.startsWith('Species from banners')));
 assert.deepEqual(b.events.filter(e=>e.kind==='move').map(e=>[e.t,e.side,e.actor,e.move]),[[10,'opponent','zekrom','CRUNCH'],[25,'my','megamewtwoy','PSYSTRIKE'],[30,'opponent','zacian','BEHEMOTH_BLADE']]);
 assert.equal(b.banners,undefined);});

test('"X used Y!" without a send-out takes the side opposite the defender: shield, faint or HP drop; disagreeing cues give none',()=>{
 const run=(frames,banners,defender)=>{const tr=new C.HudTracker();for(const [t,h] of frames)tr.observe(t,h);for(const [t,x] of banners)banner(tr,t,x);return tr.finish({defender})[0];};
 const frames=[];for(let t=0;t<=60;t+=.5)frames.push([t,t<15?hud():hud(2,1)]);   // the opponent shields at 15 s
 let b=run(frames,[[1,'相手がゼクロムをくりだした！'],[12,'カイオーガはこんげんのはどうを使った！']]);
 assert.deepEqual(b.my.map(p=>p.key),['kyogre'],'the opponent shielded: your attack');
 b=run(frames,[[1,'相手がゼクロムをくりだした！'],[12,'カイオーガはこんげんのはどうを使った！']],()=>'my');assert.deepEqual(b.my,[],'shield and HP bar disagree: unassigned');
 b=run(frames.map(([t])=>[t,hud()]),[[1,'相手がゼクロムをくりだした！'],[12,'カイオーガはこんげんのはどうを使った！']],(t)=>t===12?'my':null);
 assert.deepEqual(b.opponent.map(p=>p.key),['zekrom','kyogre'],'your HP bar dropped: their attack');
 b=run(frames,[[1,'相手がゼクロムをくりだした！'],[12,'ゼクロムはかみくだくを使った！']]);assert.equal(b.events.find(e=>e.kind==='move').side,'unknown','sent out by the opponent, but the opponent shielded: no side');
 // Mirror: the species was sent out on both sides; only a cue decides.
 b=run(frames.map(([t])=>[t,hud()]),[[1,'相手がゼクロムをくりだした！'],[2,'ゆけっ！ゼクロム！'],[12,'ゼクロムはかみくだくを使った！']]);
 assert.equal(b.events.find(e=>e.kind==='move').side,'unknown');});

test('species clause: a dropped Mega prefix or a misread X/Y is the same Pokémon; a fourth species is flagged',()=>{
 const tr=new C.HudTracker();for(let t=0;t<=90;t+=.5)tr.observe(t,hud());
 banner(tr,1,'相手がメガミュウツーYをくりだした！');banner(tr,9,'相手がミュウツーをくりだした！');banner(tr,20,'相手がメガミュウツーXをくりだした！');banner(tr,30,'相手がメガミュウツーYをくりだした！');
 for(const [t,x] of [[40,'ゼクロム'],[50,'ザシアン'],[60,'イベルタル']])banner(tr,t,`相手が${x}をくりだした！`);
 const [b]=tr.finish();assert.deepEqual(b.opponent.map(p=>p.key),['megamewtwoy','zekrom','zacian']);assert.ok(b.flags.includes('More than three opponent species: check boundary'));});

test('battles named by their nameplates are unchanged; a battle\'s intro banners after a fade belong to the next battle',()=>{
 const side=n=>({balls:A,fainted:0,shields:2,hit:{...C.match(n,dict),confidence:90,raw:n}});
 const tr=new C.HudTracker();for(let t=0;t<=30;t+=.5)tr.observe(t,{my:side('Zekrom'),opponent:side('Lugia')});banner(tr,10,'相手がザシアンをくりだした！');banner(tr,12,'ザシアンはきょじゅうざんを使った！');
 const [named]=tr.finish();assert.deepEqual(named.opponent.map(p=>p.key),['lugia']);assert.equal(named.banners,undefined);assert.ok(!named.flags.some(f=>f.startsWith('Species from banners')));
 assert.deepEqual(named.events.filter(e=>e.kind==='go').map(e=>Object.keys(e).sort()),[['actor','kind','label','t']]);
 const u=new C.HudTracker();for(let t=0;t<=40;t+=.5)u.observe(t,hud(t<20?2:1,t<30?2:1,t<35?0:2));banner(u,5,'相手がゼクロムをくりだした！');u.blackout(42);banner(u,45,'相手がルギアをくりだした！');banner(u,46,'ゆけっ！カイオーガ！');
 for(let t=48;t<=80;t+=.5)u.observe(t,hud());const bs=u.finish();
 assert.equal(bs.length,2);assert.deepEqual(bs[0].opponent.map(p=>p.key),['zekrom']);assert.deepEqual(bs[1].opponent.map(p=>p.key),['lugia']);assert.deepEqual(bs[1].my.map(p=>p.key),['kyogre']);
 // A banner read only in the wide box is a sighting without an event: a battle a plate names later is unchanged.
 const w=new C.HudTracker();for(let t=0;t<=5;t+=.5)w.observe(t,hud());w.sight(2,'相手がザシアンをくりだした！',lb('相手がザシアンをくりだした！'),dict,gm.moves);
 for(let t=5.5;t<=30;t+=.5)w.observe(t,{my:side('Zekrom'),opponent:side('Lugia')});const [wb]=w.finish();assert.deepEqual(wb.events.filter(e=>e.kind==='go'),[]);assert.deepEqual(wb.opponent.map(p=>p.key),['lugia']);
 const x=new C.HudTracker();for(let t=0;t<=30;t+=.5)x.observe(t,hud());x.sight(2,'相手がザシアンをくりだした！',lb('相手がザシアンをくりだした！'),dict,gm.moves);
 x.sight(9,'ザシアンはきょじゅうざんを使った！',lb('ザシアンはきょじゅうざんを使った！'),dict,gm.moves,88);const [xb]=x.finish();assert.deepEqual(xb.opponent.map(p=>p.key),['zacian']);
 assert.deepEqual(xb.events.filter(e=>e.kind==='move').map(e=>[e.side,e.move]),[['opponent','BEHEMOTH_BLADE']]);
 const v=new C.HudTracker();for(let t=0;t<=8;t+=.5)v.observe(t,hud());banner(v,4,'相手がゼクロムをくりだした！');assert.deepEqual(v.finish(),[],'a HUD seen under 10 s');});

test('a species read once with one wrong character is dropped; send-outs between battles without a fade go to the next one',()=>{
 assert.equal(lb('ゆけっ！フッキー！').fuzzy,true);
 const tr=new C.HudTracker();for(let t=0;t<=40;t+=.5)tr.observe(t,hud(2,t<30?2:1));banner(tr,2,'ゆけっ！カイオーガ！');banner(tr,20,'ゆけっ！フッキー！');banner(tr,25,'相手がゼクロムをくりだした！');
 banner(tr,42,'相手がルギアをくりだした！');for(let t=44;t<=80;t+=.5)tr.observe(t,hud());const [b1,b2]=tr.finish();
 assert.deepEqual(b1.my.map(p=>p.key),['kyogre']);assert.deepEqual(b1.opponent.map(p=>p.key),['zekrom']);assert.deepEqual(b2.opponent.map(p=>p.key),['lugia']);
 // A send-out right as a battle ends, before its fade, stays with it (the opponent's last Pokémon, then a forfeit).
 const u=new C.HudTracker();for(let t=0;t<=40;t+=.5)u.observe(t,hud(2,t<30?2:1));banner(u,25,'相手がゼクロムをくりだした！');banner(u,41,'相手がホウオウをくりだした！');u.blackout(43);
 banner(u,47,'相手がルギアをくりだした！');for(let t=49;t<=80;t+=.5)u.observe(t,hud());const [c1,c2]=u.finish();
 assert.deepEqual(c1.opponent.map(p=>p.key),['zekrom','hooh']);assert.deepEqual(c2.opponent.map(p=>p.key),['lugia']);});

test('the HP bar that drops across a charged attack names the defender',()=>{
 const s=(pts)=>pts.map(([t,fill])=>({t,fill}));
 const series={my:s([[1,.8],[1.5,.8],[2,.8],[6,.8],[6.1,.8],[6.2,.8]]),opponent:s([[1,.9],[1.5,.9],[2,.9],[6,.5],[6.1,.5],[6.2,.5]])};
 assert.equal(C.barDefender(series,3,12),'opponent');
 assert.equal(C.barDefender({...series,my:s([[1,.8],[1.5,.8],[2,.8],[6,.5],[6.1,.5],[6.2,.5]])},3,12),null,'both dropped');
 assert.equal(C.barDefender({...series,my:s([[1,.8],[1.5,.8],[2,.8],[6,.7],[6.1,.7],[6.2,.7]])},3,12),'opponent','a fast move on the attacker: a third of the drop');
 assert.equal(C.barDefender({...series,my:[]},3,12),null,'your bar unread');});
