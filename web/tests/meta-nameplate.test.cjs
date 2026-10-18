// Nameplate misreads reported by the owner (2026-10-17): Zekrom read as Corvisquire in Korean, Mime Jr. for a
// covered Melmetal, Stunfisk's cached read reused for other Japanese plates (Mxwep4-3rVI), a hiragana nickname
// read as Blitzle (7u31Xt6Fg4M). core.js dictionary, matchLocale, NameCache, plateCover, plateHit, HudTracker.
const {test}=require('node:test'),assert=require('node:assert/strict'),C=require('../includes/meta/core.js'),gm=require('../includes/pro/data/gamemaster.json');
const names=require('../includes/meta/species-names.json').names,dict=C.dictionary(gm.pokemon);
const locales=Object.fromEntries(Object.keys(C.LOCALES).map(l=>[l,C.localeDictionary(gm.pokemon,names,l,dict)]));
const m=(lang,text,latin)=>C.matchLocale(text,locales[lang],lang,latin);

test('Mime Jr. is "Mime Jr." on the plate: "Mime" is no dictionary name, so a covered "Melmet" plate names nothing',()=>{
 assert.equal(dict.has('mime'),false);assert.equal(C.match('Mime Jr.',dict).key,'mimejr');assert.equal(C.match('Mime Jr.',dict).id,'mime_jr');
 assert.equal(C.match('Meime#”',dict),null,'the 6zhjUeOaERo read');assert.equal(C.match('Melmetal',dict).key,'melmetal');
 assert.equal(C.match('Mr. Mime',dict).key,'mrmime','other brackets still name forms');});

test('candidates carry their highest CP (level 51, perfect IVs) over every form of the species',()=>{
 const cp=n=>C.match(n,dict).candidates[0].maxCp;assert.ok(C.match('Zacian',dict).candidates.every(c=>c.maxCp>5600),'Zacian plates show Crowned Sword CPs');
 assert.ok(C.plateHit({hit:{...C.match('Mewtwo',dict),confidence:80},cp:7529,cover:0}),'Mega Mewtwo Y plates read above PvPoke\'s Mega stats');assert.equal(cp('Melmetal'),4118);assert.ok(cp('Corvisquire')<2000);assert.ok(cp('Zekrom')>4500);assert.ok(cp('Mime Jr.')<1300);});

const alts=h=>[h.key,...(h.alternatives||[]).map(a=>a.key)].sort();
test('Korean: beyond one jamo, another species within one more jamo makes the read ambiguous; the CP decides',()=>{
 for(const t of ['채 크 로우','서 크로우','- 카 크 로 두'])assert.ok(['corvisquire','zekrom'].every(k=>alts(m('ko',t)).includes(k)),`${t} is 2 jamo from Corvisquire and 3 from Zekrom (7qqbqf5Mb7E, 92mROoUiWLM)`);
 const read=(t,cp)=>C.plateHit({hit:{...m('ko',t),confidence:60,raw:t},cp,cover:0});
 assert.equal(read('채 크 로우',4545).key,'zekrom','Master League CP: only Zekrom fits');assert.equal(read('채 크 로 무',4565).key,'zekrom');
 assert.equal(read('채 크 로우',1450),null,'both fit a Great League CP: no species');assert.equal(C.plateHit({hit:{...m('ko','채 크 로우'),confidence:60},cp:1450,cover:0,types:['dragon','electric']})?.key,'zekrom','then the icons decide');assert.equal(read('채 크 로우',null),null,'no CP read: no species');
 assert.equal(m('ko','이 켈 타로').alternatives,undefined);
 assert.equal(m('ko','제크로무').key,'zekrom');assert.equal(m('ko','푸크로우').key,'corvisquire');
 assert.equal(m('ko','이 켈 타로')?.key,'yveltal');assert.equal(m('ko','여 텔 타르')?.key,'yveltal');assert.equal(m('ko','에가여타그로스')?.key,'megametagross');
 assert.equal(m('ko','메가뮤츠누','mARaAyY')?.key,'megamewtwoy','Mega X/Y siblings are decided by the English read, not ambiguity');});

test('Japanese: a 4-character name one character off with a second species two away is ambiguous; hiragana reads',()=>{
 assert.ok(alts(m('ja','ゼラ ロム')).includes('zekrom')&&alts(m('ja','ゼラ ロム')).includes('zeraora'),'one from ゼクロム, two from ゼラオラ');
 assert.equal(C.plateHit({hit:{...m('ja','ゼラ ロム'),confidence:80},cp:4409,cover:0})?.key,'zekrom','CP 4409 rules out Zeraora');assert.ok(m('ja','レデ アン').alternatives?.length);
 assert.equal(m('ja','ゼ ケ クロ ム')?.key,'zekrom','five characters: one extra is fine');assert.equal(m('ja','ゲソ クム シャ')?.key,'golisopod');assert.equal(m('ja','か ルディ オ')?.key,'keldeo');
 assert.equal(m('ja','し まま 4'),null,'a hiragana nickname is not シママ (Blitzle)');assert.equal(m('ja','し まま だ'),null);assert.equal(m('ja','ます ます'),null,'nor デスマス by one letter');
 assert.equal(m('ja','シママ').key,'blitzle');assert.equal(m('ja','きんぐどら').key,'kingdra','long hiragana reads still fold');assert.equal(m('ja','マッ ギョ |').key,'stunfisk');});

test('NameCache.names: different names with similar fingerprints are read again; blur shifts still reuse; closest entry wins',()=>{
 const print=cells=>{const b=new Uint8Array(768);for(const [r,c] of cells)b[r*64+c]=1;return b;};
 const glyph=(c0,shape)=>shape.map(([r,c])=>[r,c0+c]);
 const box=[[2,0],[2,1],[2,2],[2,3],[3,0],[3,3],[4,0],[4,3],[5,0],[5,3],[6,0],[6,1],[6,2],[6,3]],bar=[[2,1],[3,1],[4,1],[5,1],[6,1],[7,1],[8,1],[4,0],[4,2],[4,3],[8,0],[8,2]];
 const word=shapes=>print(shapes.flatMap((s,i)=>glyph(40+5*i,s)));
 // b: the same strokes plus a small mark where a has no ink (a different character), well under the old limits.
 const a=word([box,bar,box,box]),b=print([...[...a.keys()].filter(i=>a[i]).map(i=>[Math.floor(i/64),i%64]),[10,41],[10,42],[10,46],[10,47],[10,51],[10,52]]),shifted=print([...[...a.keys()].filter(i=>a[i]).map(i=>[Math.floor(i/64),i%64]),[1,40],[1,41],[7,40],[7,43]]);   // blurred stroke edges
 const plain=new C.NameCache(),strict=C.NameCache.names();for(const c of [plain,strict])c.set(a,{key:'stunfisk'});
 assert.equal(plain.get(b)?.key,'stunfisk','the old cache reused a different name');assert.equal(strict.get(b),undefined,'read again');
 assert.ok(C.farCells(a,shifted,64)<=C.NAME_FAR);assert.equal(strict.get(shifted)?.key,'stunfisk','blurred edges: the same plate');
 strict.set(b,{key:'jumpluff'});assert.equal(strict.get(b).key,'jumpluff');assert.equal(strict.get(a).key,'stunfisk');});

const plateImage=(w=886,h=400,dy=0)=>{const d=new Uint8ClampedArray(w*h*4);for(let i=0;i<w*h;i++){d[i*4]=60;d[i*4+1]=90;d[i*4+2]=160;d[i*4+3]=255;}
 const fill=(x0,y0,x1,y1,[r,g,b])=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*w+x)*4;d[i]=r;d[i+1]=g;d[i+2]=b;}};
 for(const side of ['my','opponent']){const [x0,y0,x1,y1]=C.HUD.panel[side];fill(x0,y0+dy,x1,y1+dy,[235,238,240]);const [n0,m0,n1,m1]=C.HUD.name[side];fill(n0+40,m0+8+dy,n1-40,m1-8+dy,[60,70,80]);}
 return {img:{data:d,width:w,height:h},fill};};

// The name's fingerprint for plateImage's text block (box columns 40 px in from each end).
const inkBits=side=>{const [n0,,n1]=C.HUD.name[side],b=new Uint8Array(768);for(let c=0;c<64;c++){const x=n0+(c+.5)*(n1-n0)/64;if(x>n0+40&&x<n1-40)for(let r=3;r<9;r++)b[r*64+c]=1;}return b;};
test('plateCover: a clean plate is uncovered; a sticker over the end of the name covers it; the bezel and far sky do not',()=>{
 const cv=(img,side)=>C.plateCover(img,0,side,inkBits(side));
 const {img,fill}=plateImage();assert.equal(cv(img,'opponent'),0);assert.equal(cv(img,'my'),0);
 fill(820,110,886,140,[20,20,20]);fill(820,140,886,215,[150,40,40]);assert.ok(cv(img,'opponent')>=C.COVER.max,'a sticker where the name ends');
 const e=plateImage();e.fill(845,0,886,400,[110,110,110]);e.fill(830,0,845,400,[40,150,240]);assert.ok(cv(e.img,'opponent')<C.COVER.max,'a crop wider than the screen: sky and bezel past the name');assert.equal(cv(img,'my'),0);
 const p=plateImage(),[n0,,n1]=C.HUD.name.my;p.fill(n0,112,n1,124,[220,60,60]);assert.ok(cv(p.img,'my')>20,'a coloured chat box over the plate');});

test('plateHit: covered plates and CPs above every candidate\'s maximum drop the sighting; junk CPs are ignored',()=>{
 const hit=n=>({...C.match(n,dict),confidence:80,raw:n}),rej={cover:0,cp:0};
 const sugg=n=>({...hit(n),quality:'suggestion',id:''});assert.equal(C.plateHit({hit:sugg('Corvisquire'),cp:4545,cover:0},rej),null);assert.equal(rej.cp,1);
 assert.ok(C.plateHit({hit:hit('Persian'),cp:4012,cover:0}),'exact reads stand: Team Rocket CPs exceed a player\'s');
 assert.ok(C.plateHit({hit:hit('Corvisquire'),cp:1490,cover:0}));assert.ok(C.plateHit({hit:hit('Stunfisk'),cp:11495,cover:0}),'5-digit CP: a misread');
 assert.ok(C.plateHit({hit:hit('Zekrom'),cp:4545,cover:0}));assert.ok(C.plateHit({hit:sugg('Mime Jr.'),cp:1498,cover:0}),'a leading 1 may be junk: 498 fits');assert.ok(C.plateHit({hit:hit('Zekrom'),cover:0}),'no CP read');
 assert.equal(C.plateHit({hit:hit('Melmetal'),cp:3600,cover:5},rej),null);assert.equal(rej.cover,1);});

const A=['alive','alive','alive'];
const plate=(n,{types=[],cp=null,quality}={})=>{const h={...(C.match(n,dict)||C.matchLocale(n,locales.ja,'ja')),confidence:80,raw:n};if(quality)h.quality=quality;return {balls:A,fainted:0,shields:2,hit:h,types,cp,cover:0};};
function battle(opp,mine='Registeel',start=0){const t=new C.HudTracker();let x=start;for(const o of opp)for(let k=0;k<12;k++,x+=.5)t.observe(x,{my:plate(mine,{types:['steel']}),opponent:o()});return t;}

test('HUD tracker: a CP that cannot fit drops those sightings, so the species is never added',()=>{
 const t=battle([()=>plate('Zekrom',{types:['dragon','electric'],cp:4545}),()=>plate('Corvisquire',{types:['dragon','electric'],cp:4545,quality:'suggestion'})]);const b=t.finish();
 assert.deepEqual(b[0].opponent.map(p=>p.key),['zekrom']);assert.equal(t.rejected.cp,12);});

test('HUD tracker: a suggestion whose type icons contradict it is flagged (not dropped), only where icons agree with exact reads',()=>{
 const mimeLike=()=>{const p=plate('Mime Jr.',{types:['steel']});p.hit.quality='suggestion';return p;};
 const good=[()=>plate('Lugia',{types:['flying','psychic']}),()=>plate('Swampert',{types:['ground','water']})];
 const t=battle([...good,mimeLike]),b=t.finish();assert.deepEqual(b[0].opponent.map(p=>p.key),['lugia','swampert','mimejr']);assert.equal(t.rejected.types,1);
 assert.equal(b[0].opponent[2].typeConflict,true);assert.ok(b[0].flags.some(f=>/Check species: .*type icons read steel/.test(f)));
 const u=battle([()=>plate('Lugia',{types:['fire']}),()=>plate('Swampert',{types:['rock']}),mimeLike]),c=u.finish();
 assert.equal(c[0].opponent[2].typeConflict,undefined,'icons that disagree with exact reads decide nothing');
 let k=0;const scattered=()=>{const p=plate('Mime Jr.',{types:[['steel'],['normal'],['ground'],['rock'],['ice'],['bug']][k++%6]});p.hit.quality='suggestion';return p;};
 assert.equal(battle([...good,scattered]).finish()[0].opponent[2].typeConflict,undefined,'scattered single misreads: no flag');
 assert.equal(battle([...good,()=>plate('Mime Jr.',{types:['steel']})]).finish()[0].opponent[2].typeConflict,undefined,'exact reads are never flagged');});

test('second reader: YouTube footage only, only where the OCR is unsure, exact names only, budget and reuse',()=>{
 const R=require('./meta-benchmark/hud-llm.cjs'),os=require('node:os'),path=require('node:path');
 const own=path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src/hour.mp4'),yt=path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src/youtube/X.mp4');
 assert.equal(R.youtubeOnly(own),false);assert.equal(R.youtubeOnly(yt),true);assert.equal(R.youtubeOnly('/tmp/x.mp4'),false);
 const calls=[],answers={opponent:'Melmetal',my:'Registeel',agreed:true},run=(v,box,t)=>{calls.push(t);return answers;};
 const language=new C.NameLanguage(),mk=(o={})=>R.createSecondReader({C,video:yt,box:[0,0,560,1080],dict,locales,language,enabled:true,run,...o});
 assert.equal(R.createSecondReader({C,video:own,box:[0,0,886,1920],dict,locales,language,enabled:true,run}).enabled,false,'never the owner\'s recordings');
 const r=mk(),sugg={...C.match('Melmetaa',dict),confidence:70,raw:'Melmetaa'};assert.equal(sugg.quality,'suggestion');
 const exact={...C.match('Lugia',dict),confidence:90,raw:'Lugia'};assert.equal(r.check(exact,{text:'Lugia'},'opponent',1),exact);assert.equal(calls.length,0,'exact reads are not asked');
 assert.equal(r.check(sugg,{text:'Melmetaa'},'opponent',2).secondReader,true);assert.equal(r.stats.confirmed,1);
 const wrong={...C.match('Mime Jr',dict),quality:'suggestion',confidence:70,raw:'Mime Jr'};assert.equal(r.check(wrong,{text:'Mime Jr'},'opponent',3).key,'melmetal');assert.equal(r.stats.replaced,1);
 assert.equal(r.check(null,{text:'Meime#'},'opponent',4).key,'melmetal','an unread plate with letters');assert.equal(r.check(null,{text:'0 |'},'opponent',5),null,'no letters: not asked');
 const n=calls.length;r.check(wrong,{text:'Mime Jr'},'opponent',6);assert.equal(calls.length,n,'the same misread is asked once');
 const off=R.createSecondReader({C,video:yt,box:[0,0,560,1080],dict,locales,language,enabled:true,run:()=>({opponent:'Mime Jr',agreed:false})});assert.equal(off.check(sugg,{text:'Melmetaa'},'opponent',1),sugg,'two calls that disagree change nothing');
 const odd=R.createSecondReader({C,video:yt,box:[0,0,560,1080],dict,locales,language,enabled:true,run:()=>({opponent:'Melmetax',agreed:true})});assert.equal(odd.check(sugg,{text:'Melmetaa'},'opponent',1),sugg,'the model\'s name must be exact');
 const tight=mk({budget:1});tight.check(sugg,{text:'a1'},'opponent',1);assert.equal(tight.check(wrong,{text:'b2'},'opponent',2),wrong,'budget spent');});
