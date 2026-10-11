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
