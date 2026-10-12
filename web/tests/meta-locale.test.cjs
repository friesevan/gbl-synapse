// Nameplates and result screens in other UI languages (core.js LOCALES, species-names.json).
const {test}=require('node:test'),assert=require('node:assert/strict'),C=require('../includes/meta/core.js'),gm=require('../includes/pro/data/gamemaster.json');
const names=require('../includes/meta/species-names.json').names,dict=C.dictionary(gm.pokemon);
const locales=Object.fromEntries(Object.keys(C.LOCALES).map(l=>[l,C.localeDictionary(gm.pokemon,names,l,dict)]));
const latin=Object.fromEntries(Object.entries(locales).filter(([l])=>!C.LOCALES[l].script));
const m=(lang,text)=>C.matchLocale(text,locales[lang],lang);

test('localised names map to the English entries, Mega and Primal with the language prefix',()=>{
 assert.deepEqual(m('ja','ギャラドス').candidates.map(c=>c.id).sort(),C.match('Gyarados',dict).candidates.map(c=>c.id).sort());
 assert.equal(m('ja','ギャラドス').key,'gyarados');assert.equal(m('ko','갸라도스').key,'gyarados');assert.equal(m('zh-Hant','暴鯉龍').key,'gyarados');assert.equal(m('zh-Hans','暴鲤龙').key,'gyarados');
 assert.equal(m('de','Garados').key,'gyarados');assert.equal(m('fr','Léviator').key,'gyarados');
 assert.equal(m('ja','メガリザードンX').id,'charizard_mega_x');assert.equal(m('de','Mega-Glurak X').id,'charizard_mega_x');assert.equal(m('ja','ゲンシグラードン').id,'groudon_primal');
 assert.equal(m('de','Lanturn'),null,'names equal to English stay with the English dictionary');});
test('Japanese OCR look-alikes and spaces are folded; one wrong character only for a unique long name',()=>{
 assert.equal(m('ja','キング ドラ').key,'kingdra');assert.equal(m('ja','ナツトレイ')?.key,'ferrothorn');assert.equal(m('ja','きんぐどら').key,'kingdra');
 assert.equal(m('ja','メタグロ一ス').key,'metagross');assert.equal(m('ja','ミュ'),null);
 assert.equal(m('ja','キングドラ').quality,'exact');assert.equal(m('ja','キングトラ').quality,'suggestion');assert.equal(m('ja','キングトラ').id,'');});
test('an English video never switches language: other languages are only consulted',()=>{const language=new C.NameLanguage(),read=t=>C.readName({text:t,confidence:90},{dict,locales:latin,language});
 assert.deepEqual(read('Melmetal').hit,{...C.match('Melmetal',dict),confidence:90,raw:'Melmetal'});
 for(const t of ['Melmeta1','random menu text','Garados'])assert.deepEqual(read(t).hit,(x=>x?{...x,confidence:90,raw:t}:null)(C.match(t,dict)));
 assert.equal(language.lang,'en');});
test('two exact German names switch the video to German; unreadable plates are read again',()=>{const language=new C.NameLanguage(),read=t=>C.readName({text:t,confidence:90},{dict,locales:latin,language});
 assert.equal(read('Lanturn').hit.key,'lanturn');assert.equal(read('Glurak').hit,null);const r=read('Garados');assert.equal(r.switched,true);assert.equal(r.hit.key,'gyarados');assert.equal(language.lang,'de');
 assert.equal(read('Glurak').hit.key,'charizard');assert.equal(read('Melmetal').hit.key,'melmetal');
 const cache=new C.NameCache(),bits=new Uint8Array(768).fill(1);cache.set(bits,null);cache.forgetUnread();assert.equal(cache.get(bits),undefined);});
test('CJK plates are read with the language model while undecided, and one long exact name decides when English has none',()=>{const language=new C.NameLanguage(),calls=[];
 const alt=lang=>{calls.push(lang);return lang==='ko'?{text:'갸라도스',confidence:80}:{text:'',confidence:0};};
 const r=C.readName({text:'7 ll|',confidence:30},{dict,locales,language,alt});assert.equal(r.switched,true);assert.equal(r.hit.key,'gyarados');assert.equal(language.lang,'ko');assert.deepEqual(calls,['ja','ko']);
 calls.length=0;C.readName({text:'x',confidence:20},{dict,locales,language,alt});assert.deepEqual(calls,['ko'],'only the recognised language is read afterwards');});
test('CJK reads stop once English has three species or the budget is spent',()=>{const language=new C.NameLanguage({maxTries:2});let calls=0;const alt=()=>{calls++;return {text:'',confidence:0};};
 for(let i=0;i<5;i++)C.readName({text:'junk',confidence:10},{dict,locales,language,alt});assert.equal(calls,2*4);
 const en=new C.NameLanguage();for(const t of ['Melmetal','Azumarill','Registeel'])C.readName({text:t,confidence:90},{dict,locales,language:en,alt});calls=0;C.readName({text:'junk',confidence:10},{dict,locales,language:en,alt});assert.equal(calls,0);});
test('result screens in German, Spanish and Portuguese; English unchanged',()=>{
 assert.equal(C.outcome('DU HAST GEWONNEN!'),'Win');assert.equal(C.outcome('GUT GEKAMPFT!'),'Loss');assert.equal(C.outcome('iGANASTE!'),'Win');assert.equal(C.outcome('jHAS GANADO!'),'Win');
 assert.equal(C.outcome('iBUEN INTENTO!'),'Loss');assert.equal(C.outcome('VOCE VENCEU!'),'Win');assert.equal(C.outcome('OTIMA TENTATIVA!'),'Loss');
 assert.equal(C.outcome('YOU WIN!'),'Win');assert.equal(C.outcome('GOOD EFFORT!'),'Loss');assert.equal(C.outcome('NO MUY EFICAZ'),null);assert.equal(C.outcome('ABGEWEHRT!'),null);});
test('result screens, dialogs and matchmaking text in Japanese, Korean, Chinese, French and Italian',()=>{
 assert.equal(C.outcome('WIN!'),'Win');assert.equal(C.outcome('NICE TRY!'),'Loss');assert.equal(C.outcome('NICE TRV!'),'Loss');assert.equal(C.outcome('獲勝！'),'Win');assert.equal(C.outcome('辛苦了！'),'Loss');
 assert.equal(C.outcome('GAGNÉ !'),'Win');assert.equal(C.outcome('BEL EFFORT !'),'Loss');assert.equal(C.outcome('Hai vinto!'),'Win');assert.equal(C.outcome('Peccato!'),'Loss');
 for(const t of ['TWIN','WINS','WI','GAGNER'])assert.equal(C.outcome(t),null,t);
 for(const t of ['降参しますか？ リワードは受け取れません。','항복하고 도망가겠습니까?','要投降並退出對戰嗎？','Aufgeben und schließen?','¿Quieres rendirte y salir del combate?'])assert.ok(C.isSurrender(t),t);
 for(const t of ['対戦相手をさがしています','대전 상대를 찾고 있습니다','正在尋找對手','Gegner wird gesucht','Buscando rival','Finding opponent'])assert.ok(C.isMatchmaking(t),t);assert.ok(!C.isMatchmaking('YOU WIN!'));});
test('banners in other UI languages resolve to English keys and PvPoke moves; English banners are left to parseBanner',()=>{
 const moveMaps=Object.fromEntries(Object.keys(C.LOCALES).map(l=>[l,C.moveDictionary(gm.moves,require('../includes/meta/move-names.json').names,l)]));
 const ctx=lang=>({lang,locales,moveMaps,moves:gm.moves,dict}),lb=(t,l)=>C.localBanner(t,ctx(l));
 assert.deepEqual(lb('ゼクロムはワイルドボルトを使った！','ja'),{kind:'move',actor:'zekrom',move:'Wild Charge',lang:'ja'});
 assert.deepEqual(lb('ゆけっ！ルギア！','ja'),{kind:'go',name:'lugia'});
 assert.deepEqual(lb('메타그로스(은)는 코멧펀치 (을)를 썼다!','ko'),{kind:'move',actor:'metagross',move:'Meteor Mash',lang:'ko'});
 assert.deepEqual(lb('路卡利歐 使出了\n波導彈！','zh-Hant'),{kind:'move',actor:'lucario',move:'Aura Sphere',lang:'zh-Hant'});
 assert.deepEqual(lb('Glurak hat Lohekanonade eingesetzt!','de'),{kind:'move',actor:'charizard',move:'Blast Burn',lang:'de'});
 assert.deepEqual(lb('Los, Glurak!','de'),{kind:'go',name:'charizard'});
 assert.equal(lb('¡Charizard ha usado Anillo Ígneo!','en').move,'Blast Burn');assert.equal(lb('Dracaufeu a utilisé Rafale Feu !','en').actor,'charizard');
 assert.equal(lb('Zekrom used Wild Charge!','en'),null);assert.equal(lb('aa ee = ~seneep','en'),null);
 const t=new C.HudTracker(),A=['alive','alive','alive'],side=n=>({balls:A,fainted:0,shields:2,hit:{...C.match(n,dict),confidence:90,raw:n}});t.observe(0,{my:side('Zekrom'),opponent:side('Lugia')});
 t.move(1,'ゼクロムはワイルドボルトを使った！',90,gm.moves,lb('ゼクロムはワイルドボルトを使った！','ja'));const e=t.current.events.find(x=>x.kind==='move');assert.equal(e.side,'my');assert.equal(e.move,'WILD_CHARGE');});
test('effectiveness texts in other UI languages; English unchanged',()=>{const H=require('../includes/meta/hp.js');
 for(const [t,k] of [['Super effective!','super'],['Not very effective...','notVery'],['Nicht sehr effektiv …','notVery'],['Sehr effektiv!','super'],['Pas très efficace...','notVery'],['Non è molto efficace...','notVery'],['No muy eficaz...','notVery'],['Não é muito eficaz...','notVery'],['Supereficaz!','super'],['効果はばつぐんだ！','super'],['効果はいまひとつだ…','notVery'],['효과가 굉장했다!','super'],['효과가 별로인 듯하다...','notVery'],['效果絕佳！','super'],['效果不太好……','notVery'],['random junk',null]])assert.equal(H.effectKind(t),k,t);});
test('HUD tracker: a fresh HUD right after a one-frame read of no shields on both sides continues the battle',()=>{
 const A=['alive','alive','alive'],side=(n,shields=2)=>({balls:A,fainted:0,shields,hit:{...C.match(n,dict),confidence:90,raw:n}}),h=(s1,s2)=>({my:side('Zekrom',s1),opponent:side('Lugia',s2)});
 const t=new C.HudTracker();for(let x=0;x<=35;x+=.5)t.observe(x,h());t.observe(35.5,h(0,0));t.observe(36.5,h());t.observe(60,h(1,2));const b=t.finish();
 assert.equal(b.length,1);assert.deepEqual(b[0].shieldsUsed,{my:1,opponent:0});
 const u=new C.HudTracker();for(let x=0;x<=35;x+=.5)u.observe(x,h());u.observe(35.5,h(1,2));u.observe(40,h());assert.equal(u.finish().length,2,'one side\'s shield, then a fresh HUD: a new battle');
 const v=new C.HudTracker();for(let x=0;x<=35;x+=.5)v.observe(x,h());v.observe(35.5,h(0,0));v.observe(43.5,h());assert.equal(v.finish().length,1,'across an 8 s cutscene');
 const w=new C.HudTracker();for(let x=0;x<=35;x+=.5)w.observe(x,h());for(let x=35.5;x<=40;x+=.5)w.observe(x,h(0,0));w.observe(41,h());assert.equal(w.finish().length,2,'no shields shown for 4.5 s: real');});
