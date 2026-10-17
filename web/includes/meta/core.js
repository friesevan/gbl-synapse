(function(root){
'use strict';
const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function distance(a,b){const row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let prev=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const old=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,prev+(a[i-1]!==b[j-1]));prev=old;}}return row[b.length];}
// The nameplate shows Mega and Primal forms as "Mega Garchomp", "Mega Mewtwo X", "Primal Kyogre"; PvPoke
// names them "Garchomp (Mega)", "Mewtwo (Mega X)", "Kyogre (Primal)". Both spellings map to that form only.
const inGameName=p=>{const m=/^(.*) \((Mega|Primal)( [XY])?\)$/.exec(p.speciesName);return m?`${m[2]} ${m[1]}${m[3]||''}`:null;};
function dictionary(pokemon){const map=new Map();for(const p of pokemon){const shown=inGameName(p),visible=shown||p.speciesName.replace(/\s*\([^)]*\)/g,'').replace(/\s*Shadow$/i,'');for(const name of [p.speciesName,visible,p.speciesId.replace(/_/g,' ')]){const key=normalize(name);if(!map.has(key))map.set(key,[]);if(!map.get(key).some(x=>x.speciesId===p.speciesId))map.get(key).push(p);}}return map;}
function match(text,dict){const key=normalize(text.replace(/\bCP\s*\d+/gi,''));if(key.length<3)return null;let candidates=dict.get(key),quality='exact';if(!candidates){let best=99;for(const [name,items] of dict){if(Math.abs(name.length-key.length)>1)continue;const d=distance(key,name);if(d<best){best=d;candidates=items;}else if(d===best)candidates=[...candidates,...items];}if(best>1||key.length<5)return null;quality='suggestion';}return hitOf(text,candidates,quality);}
// Match result; `key` is always the English visible name, whatever language the nameplate used.
const englishKey=p=>normalize(inGameName(p)||p.speciesName.replace(/\s*\([^)]*\)/g,'').replace(/\s*Shadow$/i,''));
function hitOf(text,candidates,quality){candidates=[...new Map(candidates.map(p=>[p.speciesId,p])).values()];return {label:text.trim(),candidates:candidates.map(p=>({id:p.speciesId,name:p.speciesName,types:p.types,dex:p.dex})),key:englishKey(candidates[0]),quality,id:quality==='exact'&&candidates.length===1?candidates[0].speciesId:''};}
// ---- Other UI languages (2026-10-11) ----
// Nameplates follow the phone's language: 101 of 102 harvested videos with Japanese titles and 39 of 41
// with Korean ones gave no battle, because no name matched the English list. species-names.json
// (PokeAPI, by Pokédex number) gives each species' name in Japanese, Korean, Chinese, German, French,
// Spanish and Italian. Latin-script names are read by the English OCR; CJK names need that language's
// OCR model (`ocr`). Mega and Primal forms carry the language's prefix.
const LOCALES={de:{mega:'Mega-',primal:'Proto-'},fr:{mega:'Méga-',primal:'Primo-'},es:{mega:'Mega-',primal:''},it:{mega:'Mega',primal:'Archeo'},
 ja:{script:'cjk',ocr:'jpn',mega:'メガ',primal:'ゲンシ'},ko:{script:'cjk',ocr:'kor',mega:'메가',primal:'원시'},'zh-Hant':{script:'cjk',ocr:'chi_tra',mega:'超級',primal:'原始'},'zh-Hans':{script:'cjk',ocr:'chi_sim',mega:'超级',primal:'原始'}};
// Japanese names are katakana: OCR's hiragana and kanji look-alikes (一 for ー, 口 for ロ, 力 for カ…) are folded.
const KANA_LIKE={'一':'ー','-':'ー','‐':'ー','－':'ー','—':'ー','―':'ー','~':'ー','〜':'ー','口':'ロ','工':'エ','力':'カ','二':'ニ','八':'ハ','卜':'ト','夕':'タ','才':'オ','匕':'ヒ','三':'ミ','十':'ト'};
function nameKey(text,lang){const loc=LOCALES[lang];if(!loc?.script)return normalize(text);let s=String(text||'').normalize('NFKC').toLowerCase();
 if(lang==='ja')s=s.replace(/[ぁ-ゖ]/g,c=>String.fromCharCode(c.charCodeAt(0)+0x60)).replace(/[一\-‐－—―~〜口工力二八卜夕才匕三十]/g,c=>KANA_LIKE[c]).replace(/[ァィゥェォッャュョヮ]/g,c=>String.fromCharCode(c.charCodeAt(0)+1));
 return s.replace(/[^\p{L}\p{N}]/gu,'');}
// Localised name → the same PvPoke entries as the English visible name. Latin-script names equal to an
// English name (most Spanish and Italian ones) are left to the English dictionary.
function localeDictionary(pokemon,names,lang,english=null){const loc=LOCALES[lang],table=names?.[lang];if(!loc||!table)return null;const map=new Map();
 for(const p of pokemon){const local=table[p.dex];if(!local)continue;const m=/^(.*) \((Mega|Primal)( [XY])?\)$/.exec(p.speciesName);let shown=local;
  if(m){const pre=m[2]==='Mega'?loc.mega:loc.primal;if(!pre)continue;shown=pre+local+(m[3]?m[3].trim():'');}
  const key=nameKey(shown,lang);if(key.length<(loc.script?2:3)||english?.has(key))continue;if(!map.has(key))map.set(key,[]);if(!map.get(key).some(x=>x.speciesId===p.speciesId))map.get(key).push(p);}
 return map;}
// Korean names are compared by jamo (the letters inside a syllable): blurry plates mostly lose one stroke (메→에,
// 벨→켈), which is one jamo but a whole syllable. Up to a quarter of the jamo may differ when one species is
// closest. Mega X and Y differ only in the final Latin letter, which Korean OCR reads as a syllable (누, 뉘); the
// English read of the same plate (latin) usually still ends in it.
const jamo=s=>{let o='';for(const c of s){const i=c.charCodeAt(0)-0xAC00;o+=i<0||i>11171?c:String.fromCharCode(0x1100+Math.floor(i/588),0x1161+Math.floor(i%588/28))+(i%28?String.fromCharCode(0x11A7+i%28):'');}return o;},jamoNames=new WeakMap();
function matchJamo(key,map,latin){const kj=jamo(key),tol=Math.max(1,kj.length>>2);if(kj.length<6)return null;let names=jamoNames.get(map);if(!names)jamoNames.set(map,names=[...map].map(([name,items])=>[jamo(name),name,items]));
 let best=Infinity,found=[];for(const [nj,name,items] of names){if(Math.abs(nj.length-kj.length)>tol)continue;const d=distance(kj,nj);if(d>tol||d>best)continue;if(d<best){best=d;found=[];}found.push([name,items]);}
 const tail=/([a-z])[^a-z]*$/i.exec(String(latin||''))?.[1]?.toLowerCase();if(found.length>1&&(tail==='x'||tail==='y')&&found.every(([n])=>/[xy]$/.test(n))){const pick=found.filter(([n])=>n.endsWith(tail));if(pick.length)found=pick;}
 return found.length&&found.every(([,items])=>englishKey(items[0])===englishKey(found[0][1][0]))?found[0][1]:null;}
// Exact match, or one wrong character for longer names when exactly one species is that close (Korean: matchJamo).
function matchLocale(text,map,lang,latin=null){if(!map)return null;const cjk=!!LOCALES[lang]?.script;let key=nameKey(String(text).replace(/\bCP\s*\d+/gi,''),lang);if(key.length<(cjk?2:3))return null;
 let candidates=map.get(key),quality='exact';
 // CJK OCR often adds a stray digit or Latin letter at either end (the CP's first digit, a ball's edge).
 if(!candidates&&cjk){const core=key.replace(/^[0-9a-z]+|[0-9a-z]+$/g,'');if(core!==key&&core.length>=2){candidates=map.get(core);if(!candidates&&core.length>=4)key=core;}}
 if(!candidates&&lang==='ko'){candidates=matchJamo(key,map,latin);quality='suggestion';}
 if(!candidates){if(key.length<(cjk?4:5))return null;let found=null,ambiguous=false;for(const [name,items] of map){if(Math.abs(name.length-key.length)>1||distance(key,name)>1)continue;if(found&&englishKey(found[0])!==englishKey(items[0]))ambiguous=true;found=found||items;}
  if(!found||ambiguous)return null;candidates=found;quality='suggestion';}
 return {...hitOf(text,candidates,quality),lang};}
// Which language a video's nameplates use, from exact matches of distinct species. It starts as English
// and switches once to a language with two exact matches, or one long one (≥ 3 CJK characters / 5 letters)
// while English has none. Until then other languages are only consulted, never used, so English videos
// keep their results. Extra OCR for CJK languages stops once English has 3 species, or after `maxTries`
// plates (`maxBlind` while English has named nothing: on blurry 288×640 uploads the first exact Korean
// match came at the 63rd plate). Plates whose English read has no letter are skipped (CJK reads of them were
// empty too). After `narrowAfter` tries a language whose reads average `narrowGap` points of confidence below
// the best language's is no longer read, so a long search costs about one read per plate. `lang` presets the
// language (a second pass over a video whose language was decided late).
class NameLanguage{
 constructor({lang='en',maxTries=40,maxBlind=200,narrowAfter=20,narrowGap=20}={}){this.lang=lang||'en';this.votes={};this.tries=0;this.maxTries=maxTries;this.maxBlind=maxBlind;this.narrowAfter=narrowAfter;this.narrowGap=narrowGap;this.conf={};}
 count(lang){return this.votes[lang]?.size||0;}
 vote(lang,key){(this.votes[lang]||(this.votes[lang]=new Set())).add(key);if(this.lang!=='en'||lang==='en')return false;const k=this.count(lang),long=key.length>=(LOCALES[lang]?.script?3:5);
  if(k>=2||(k===1&&long&&this.count('en')===0)){this.lang=lang;return true;}return false;}
 searching(){return this.lang==='en'&&this.count('en')<3&&this.tries<(this.count('en')?this.maxTries:this.maxBlind);}
 // Mean confidence of a CJK model's reads while searching (a model not read yet, e.g. not loaded in the browser, stays in).
 heard(lang,confidence){const c=this.conf[lang]||(this.conf[lang]={n:0,sum:0});c.n++;c.sum+=confidence||0;}
 reads(lang){if(this.tries<this.narrowAfter||!this.conf[lang]?.n)return true;const mean=l=>this.conf[l]?.n?this.conf[l].sum/this.conf[l].n:0,best=Math.max(...Object.keys(this.conf).map(mean));return mean(lang)>=best-this.narrowGap;}
}
// Resolves one nameplate. eng: {text, confidence} from the English OCR; alt(lang) reads the box with that
// language's OCR model (CJK only; omit it where no model is available). Returns {hit, switched}.
// While the language is English the result equals match(); after a switch the order is English exact,
// the video's language exact, English one-letter suggestion, the video's language suggestion.
function readName(eng,{dict,locales={},language,alt=null,minConfidence=45}){const m=match(eng.text,dict);let switched=false,cjkTried=false;
 const englishHit=m&&eng.confidence>=minConfidence?{...m,confidence:eng.confidence,raw:eng.text}:null;
 if(englishHit?.quality==='exact')return {hit:englishHit,switched:language.vote('en',englishHit.key)};
 let exact=null,fuzzy=null;const searching=language.lang==='en'&&language.searching()&&/\p{L}/u.test(String(eng.text));
 for(const [lang,map] of Object.entries(locales)){if(!map||(language.lang!=='en'&&language.lang!==lang))continue;const cjk=!!LOCALES[lang]?.script;
  if(cjk&&(!alt||(language.lang==='en'&&(!searching||!language.reads(lang)))))continue;const r=cjk?alt(lang):eng;cjkTried=cjkTried||cjk;if(cjk&&r&&language.lang==='en')language.heard(lang,r.confidence);
  const lm=r&&r.confidence>=minConfidence?matchLocale(r.text,map,lang,eng.text):null;if(!lm)continue;const hit={...lm,confidence:r.confidence,raw:r.text};
  if(lm.quality==='exact'){switched=language.vote(lang,lm.key)||switched;exact=hit;break;}fuzzy=fuzzy||hit;}
 if(cjkTried&&language.lang==='en')language.tries++;
 if(language.lang==='en')return {hit:englishHit,switched};
 const own=h=>h&&h.lang===language.lang?h:null;
 return {hit:own(exact)||englishHit||own(fuzzy),switched};}
function outcome(text){const key=normalize(text);if(key.length>=6&&key.length<=11&&distance(key,'youwin')<=1)return 'Win';if(key.length>=9&&key.length<=13&&distance(key,'goodeffort')<=1)return 'Loss';if(/\byou\s+win\b/i.test(text))return 'Win';if(/\bgood\s+effort\b|\byou\s+lose\b/i.test(text))return 'Loss';if(/\btie\b/i.test(text))return 'Tie';return localOutcome(text);}
// Result screens in other UI languages: the game's own texts (Pokémon GO i18n strings combat_result_victory /
// combat_result_defeat, checked on harvested videos). Japanese and Korean screens are in English letters ("WIN!",
// "NICE TRY!", "YOU WIN!"), so the English OCR reads them; Chinese ones (獲勝！/ 辛苦了！) need the chi_tra model.
// One misread letter is tolerated for phrases of 6+ letters (shorter ones must be exact); long phrases are also
// found inside junk.
const RESULT_TEXT=[['duhastgewonnen','Win'],['gutgekampft','Loss'],['ganaste','Win'],['hasganado','Win'],['ganado','Win'],['buenintento','Loss'],['vocevenceu','Win'],['otimatentativa','Loss'],
 ['win','Win'],['nicetry','Loss'],['gagne','Win'],['beleffort','Loss'],['haivinto','Win'],['peccato','Loss']];
function localOutcome(text){const key=normalize(text);for(const [p,v] of RESULT_TEXT){if(p.length<6?key===p:Math.abs(key.length-p.length)<=1&&distance(key,p)<=1)return v;if(p.length>=9&&key.includes(p))return v;}
 const cjk=nameKey(text,'zh-Hant');for(const [p,v] of RESULT_TEXT_CJK)if(cjk.includes(p))return v;return null;}
const RESULT_TEXT_CJK=[['獲勝','Win'],['获胜','Win'],['辛苦了','Loss']];
// "Finding opponent" / "Battle starting" under the matchmaking spinner, in every UI language.
const isMatchmaking=text=>/finding opponent|battle starting|gegner wird gesucht|kampf beginnt|recherche d.?adversaire|d[ée]but du combat|ricerca dell.?avversario|inizio della lotta|buscando (?:rival|oponente)|comienz[ao] (?:del|el) combate|batalha come[cç]ando|対戦相手を|対戦準備中|대전\s*상대를|대전\s*준비|尋找對手|寻找对手|準備對戰|准备对战/i.test(String(text));
class Tracker{
 constructor(){this.battles=[];this.current=null;this.pending={};this.lastSeen=-Infinity;this.lastOutcome=-Infinity;this.resultPending=null;}
 start(t){this.current={id:globalThis.crypto?.randomUUID?.()||String(Math.random()),start:t,end:t,my:[],opponent:[],events:[],result:'Unknown',flags:['Confirm battle boundary and lead'],reviewed:false,leadConfirmed:false};}
 close(t,reason){if(!this.current)return;this.current.end=t;if(reason)this.current.flags.push(reason);if(this.current.my.length||this.current.opponent.length)this.battles.push(this.current);this.current=null;this.pending={};this.resultPending=null;}
 observe(t,side,hit,confidence,raw){if(!hit||confidence<45)return;if(this.current&&t-this.lastSeen>22)this.close(this.lastSeen,'Gap boundary: check for merged or split battles');this.lastSeen=t;const key=hit.key,p=this.pending[side];this.pending[side]=p&&p.key===key&&t-p.t<5?{key,t,n:p.n+1}:{key,t,n:1};if(this.pending[side].n<2)return;if(!this.current)this.start(t);let list=this.current[side],existing=list.find(x=>x.key===key);if(existing){existing.last=t;return;}if(list.length>=3){this.close(t,'Fourth species: probable new battle, review boundary');this.start(t);list=this.current[side];}const member={...hit,first:t,last:t,confidence,raw};list.push(member);this.current.events.push({t,kind:'reveal',side,label:raw,confidence});this.current.end=t;}
 result(t,text,confidence){const value=outcome(text);if(!value||confidence<55||t-this.lastOutcome<8)return;const p=this.resultPending;this.resultPending={value,t};if(!p||p.value!==value||t-p.t>5)return;if(this.current){this.current.result=value;this.current.events.push({t,kind:'result',label:value,confidence});this.close(t);}this.lastOutcome=t;}
 move(t,text,confidence,moves){if(!this.current||confidence<55)return;const found=/^(.+?)\s+used\s+(.+?)[!.]*$/i.exec(text.trim());if(!found)return;const move=moves.find(m=>normalize(m.name)===normalize(found[2]));if(!move)return;const actor=normalize(found[1]);const sides=['my','opponent'].filter(side=>this.current[side].some(p=>p.key===actor));const side=sides.length===1?sides[0]:'unknown';const last=this.current.events.at(-1);if(last?.kind==='move'&&last.move===move.moveId&&last.actor===actor&&t-last.t<8)return;this.current.events.push({t,kind:'move',side,actor,move:move.moveId,label:text.trim(),confidence});}
 finish(t){this.close(t,'No confirmed result: partial recording or missed outcome');return this.battles;}
}
// Usage estimates with uncertainty. Each battle can be down-weighted by age (halfLife days, measured
// back from the newest battle), so the sample tracks balance updates. For every species revealed:
// rate = weighted share of battles; a Wilson 95% interval on the effective sample size; and a smoothed
// estimate that shrinks toward a PvPoke-backed prior (prior: Map id → expected share) with the weight
// of k battles, so a species seen 2 times in 5 battles isn't reported as 40% of the meta.
function usageEstimates(battles,{halfLife=0,prior=null,k=10}={}){const reviewed=battles.filter(b=>b.reviewed&&b.included!==false);if(!reviewed.length)return [];
 const day=d=>Date.parse(d)/864e5,newest=Math.max(...reviewed.map(b=>day(b.context?.collectedAt)||0)),w=b=>halfLife>0&&day(b.context?.collectedAt)?Math.pow(.5,(newest-day(b.context.collectedAt))/halfLife):1;
 let N=0,N2=0;const c=new Map();for(const b of reviewed){const wb=w(b);N+=wb;N2+=wb*wb;for(const id of new Set(b.opponent.map(p=>p.id).filter(Boolean)))c.set(id,(c.get(id)||0)+wb);}
 const n=N*N/N2,z=1.96,wilson=p=>{const d=1+z*z/n,mid=(p+z*z/(2*n))/d,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [Math.max(0,mid-half),Math.min(1,mid+half)];};
 return [...c].map(([id,cnt])=>{const rate=cnt/N,p0=prior?.get(id)??prior?.get(id.replace(/_shadow$/,''))??0;return {id,count:cnt,rate,interval:wilson(rate),estimate:prior?(cnt+k*p0)/(N+k):rate};}).sort((x,y)=>y.estimate-x.estimate);}
// PvPoke-backed prior share per species: three Pokémon per team, spread by ranking score (a species
// 10 points below the top is ~7× rarer), capped at 60% per species.
function rankingPrior(rankings){const list=[...rankings.values()].filter(r=>r.score!=null);if(!list.length)return null;const top=Math.max(...list.map(r=>r.score)),w=list.map(r=>Math.exp((r.score-top)/5)),z=w.reduce((a,x)=>a+x,0);
 return new Map(list.map((r,i)=>[r.speciesId,Math.min(.6,3*w[i]/z)]));}
// Team Rocket battles and championship matches never enter GBL team-training exports or meta usage.
function eligible(b){return b.included!==false&&!['rocket','championship'].includes(b.context?.battleType||b.battleType)&&b.reviewed&&b.leadConfirmed&&b.opponent.length===3&&b.opponent.every(p=>p.id)&&new Set(b.opponent.map(p=>p.dex||p.id)).size===3;}
function aggregate(battles){const accepted=battles.filter(b=>b.reviewed&&b.included!==false),counts=new Map(),leads=new Map(),teams=new Map();for(const b of accepted){for(const p of new Map(b.opponent.map(p=>[p.id,p])).values()){if(p.id)counts.set(p.id,(counts.get(p.id)||0)+1);}if(b.leadConfirmed&&b.opponent[0]?.id)leads.set(b.opponent[0].id,(leads.get(b.opponent[0].id)||0)+1);if(eligible(b)){const ids=b.opponent.map(p=>p.id),key=[ids[0],...ids.slice(1).sort()].join('|');if(!teams.has(key))teams.set(key,{members:[ids[0],...ids.slice(1).sort()],count:0});teams.get(key).count++;}}return {accepted:accepted.length,complete:battles.filter(eligible).length,counts,leads,teams:[...teams.values()].sort((a,b)=>b.count-a.count)};}
// ---- Battle HUD (nameplates) ----
// Reference geometry from an 886×1920 iPhone portrait recording. Name boxes reach almost to the CP so
// long names ("Mega Garchomp", "Mega Mewtwo X") fit; yours is left-aligned, the opponent's right-aligned. The battle UI scales with
// screen width; `dy` shifts it vertically for different status-bar / notch heights.
const REF_W=886;
const HUD={panel:{my:[17,117,357,207],opponent:[529,117,869,207]},name:{my:[30,125,232,155],opponent:[650,125,860,155]},
 balls:{my:[[31,165,61,195],[78,165,108,195],[127,165,157,195]],opponent:[[728,165,758,195],[776,165,806,195],[825,165,855,195]]},
 shields:{my:[[194,165,222,195],[235,165,263,195]],opponent:[[622,165,651,195],[664,165,692,195]]},
 cp:{my:[240,125,350,155],opponent:[535,125,640,155]},
 // Type icons above each nameplate (centre x, y; radius 18). Yours: primary left; opponent's: a single type sits right.
 icons:{my:[[37,91],[81,91]],opponent:[[801,91],[850,91]]},
 // Mid-screen banner: "X used Y!" for charged attacks and "Go, X!" when a Pokémon is sent out.
 banner:[71,580,815,653]};
// Icon disc colours per type, fitted from recordings (median of the disc without its white glyph).
const TYPE_COLORS={bug:[169,199,53],dark:[109,112,130],dragon:[15,123,193],electric:[249,220,99],fairy:[243,163,230],fighting:[221,68,95],fire:[255,172,82],flying:[161,185,234],ghost:[118,113,209],grass:[100,192,117],ground:[216,148,102],ice:[142,217,211],normal:[165,163,162],poison:[196,98,213],psychic:[255,155,151],rock:[214,200,149],steel:[90,159,169],water:[110,186,228]};
// Lower part of the disc only (the phone status bar can overlap the top); median of non-white pixels.
function iconType(img,cx,cy,s){const r=16*s,px=[];for(let y=Math.round(cy-4*s);y<Math.round(cy+r-3*s);y++)for(let x=Math.round(cx-r+3*s);x<Math.round(cx+r-3*s);x++){if((x-cx)**2+(y-cy)**2>(r-3*s)**2||y<0||y>=img.height)continue;const i=(y*img.width+x)*4,d=img.data;if(Math.min(d[i],d[i+1],d[i+2])>=200)continue;px.push([d[i],d[i+1],d[i+2]]);}
 if(px.length<20)return null;const med=k=>px.map(p=>p[k]).sort((a,b)=>a-b)[px.length>>1],c=[med(0),med(1),med(2)];let best=null,bd=Infinity;for(const [t,v] of Object.entries(TYPE_COLORS)){const dd=Math.abs(v[0]-c[0])+Math.abs(v[1]-c[1])+Math.abs(v[2]-c[2]);if(dd<bd){bd=dd;best=t;}}return bd<=40?best:null;}
function readTypes(img,dy,side){const s=img.width/REF_W,slots=HUD.icons[side].map(([x,y])=>iconType(img,x*s,(y+dy)*s,s));return side==='my'?slots.filter(Boolean):slots.filter(Boolean);}
// Icons are sampled in their middle half so the pale nameplate around them never mixes in.
const inset=b=>{const dx=(b[2]-b[0])/4,dy=(b[3]-b[1])/4;return [b[0]+dx,b[1]+dy,b[2]-dx,b[3]-dy];};
// Boxes are clipped at the frame top: uploads that crop the status bar can cut into the nameplates (dy < −117).
function scaleBox(box,width,dy){const s=width/REF_W;return [Math.round(box[0]*s),Math.max(0,Math.round((box[1]+dy)*s)),Math.round(box[2]*s),Math.max(0,Math.round((box[3]+dy)*s))];}
// Bottom edge (in frame pixels) of the band that must be captured to read the HUD.
const hudBand=(width,dy=0)=>Math.ceil((215+dy)*width/REF_W);
// img: {data, width, height} RGBA covering the frame from y=0 (at least hudBand rows).
function meanRgb(img,box){const [x0,y0,x1,y1]=box,w=img.width,d=img.data;let r=0,g=0,b=0,n=0;for(let y=Math.max(0,y0);y<Math.min(img.height,y1);y+=2)for(let x=Math.max(0,x0);x<Math.min(w,x1);x+=2){const i=(y*w+x)*4;r+=d[i];g+=d[i+1];b+=d[i+2];n++;}return n?[r/n,g/n,b/n]:[0,0,0];}
function ballState([r,g,b]){if(r>150&&r-b>60)return 'alive';if(Math.max(r,g,b)<120)return 'fainted';return '?';}
const shieldOn=([r,g,b])=>b>180&&r>170&&g<200;
// 64×12 fingerprint of a nameplate's text. The cut-off sits halfway between the plate (median) and the
// darkest ink (5th percentile), so blurry re-encoded uploads, whose text is mid-grey, still give a
// fingerprint; a plate with no contrast gives an empty one, which the name cache never matches.
function nameBits(img,box){const [x0,y0,x1,y1]=box,cols=64,rows=12,lum=new Float32Array(cols*rows),bits=new Uint8Array(cols*rows),w=img.width,d=img.data;for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const x=Math.floor(x0+(c+.5)*(x1-x0)/cols),y=Math.floor(y0+(r+.5)*(y1-y0)/rows),i=(y*w+x)*4;lum[r*cols+c]=(d[i]+d[i+1]+d[i+2])/3;}
 const sorted=[...lum].sort((a,b)=>a-b),bg=sorted[sorted.length>>1],ink=sorted[Math.floor(sorted.length*.05)];if(bg-ink<40)return bits;const cut=Math.min(bg-20,(bg+ink)/2);for(let i=0;i<bits.length;i++)bits[i]=lum[i]<cut?1:0;return bits;}
function readHud(img,dy=0){const out={};for(const side of ['my','opponent']){const p=meanRgb(img,scaleBox(HUD.panel[side],img.width,dy));const panel=Math.min(...p)>170&&Math.max(...p)-Math.min(...p)<60;if(!panel){out[side]=null;continue;}const balls=HUD.balls[side].map(b=>ballState(meanRgb(img,scaleBox(inset(b),img.width,dy))));
 // A pale menu card can pass the panel test; real nameplates always show readable Poké Balls.
 if(balls.every(b=>b==='?')){out[side]=null;continue;}out[side]={balls,fainted:balls.filter(b=>b==='fainted').length,shields:HUD.shields[side].filter(b=>shieldOn(meanRgb(img,scaleBox(inset(b),img.width,dy)))).length,bits:nameBits(img,scaleBox(HUD.name[side],img.width,dy)),nameBox:scaleBox(HUD.name[side],img.width,dy),cpBits:nameBits(img,scaleBox(HUD.cp[side],img.width,dy)),cpBox:scaleBox(HUD.cp[side],img.width,dy),types:readTypes(img,dy,side)};}return out.my&&out.opponent?out:null;}
// Finds the vertical offset that best fits both nameplates; img must cover y = 0..hudBand(width, maxDy).
// Calibration: the Poké Balls read correctly over a band of offsets, which proves a battle HUD is
// on screen (red balls are required: dark menus otherwise read as fainted balls). The exact
// offset centers the name boxes on the rows that hold the names' dark text.
// Text is "dark" relative to the nameplate: re-encoded uploads blur it to mid-grey, so the cut-off
// sits 70 levels below the plate's median brightness (and never above the old fixed 110).
function textCenter(img,lo,hi){const s=img.width/REF_W,y0=Math.max(0,Math.round(lo*s)),y1=Math.min(img.height,Math.round(hi*s)),px=[];
 for(let y=y0;y<y1;y+=3)for(const side of ['my','opponent']){const [x0,,x1]=HUD.name[side];for(let x=Math.round(x0*s);x<Math.round(x1*s);x+=4){const i=(y*img.width+x)*4;px.push(img.data[i]+img.data[i+1]+img.data[i+2]);}}
 const bg=px.sort((a,b)=>a-b)[px.length>>1]??0,cut=Math.max(330,bg-210),dark=y=>{let n=0,c=0;for(const side of ['my','opponent']){const [x0,,x1]=HUD.name[side];for(let x=Math.round(x0*s);x<Math.round(x1*s);x+=2){const i=(y*img.width+x)*4;c++;if(img.data[i]+img.data[i+1]+img.data[i+2]<cut)n++;}}return n/c;};
 let best=null,run=null;for(let y=Math.max(0,Math.round(lo*s));y<Math.min(img.height,Math.round(hi*s));y++){if(dark(y)>.03){run=run?{a:run.a,b:y}:{a:y,b:y};if(!best||run.b-run.a>best.b-best.a)best={...run};}else run=null;}
 return best&&best.b-best.a>=8*s?(best.a+best.b)/2/s:null;}
// An upload that crops the phone's top can leave the names at the frame's top edge (L2Iyrc06j00: dy ≈ −128).
// Offsets below −120 are tried only when the usual range finds nothing, so other videos are unchanged.
function calibrate(img,range=[-120,160]){const r=calibrateIn(img,range);return r===null&&range[0]===-120&&range[1]===160?calibrateIn(img,[-150,-122]):r;}
function calibrateIn(img,range){const ok=[];for(let dy=range[0];dy<=range[1];dy+=2){const hud=readHud(img,dy);if(!hud)continue;const balls=[...hud.my.balls,...hud.opponent.balls];if(balls.filter(b=>b==='alive').length>=2&&balls.filter(b=>b!=='?').length>=5)ok.push(dy);}
 if(!ok.length)return null;const mid=ok[Math.floor(ok.length/2)],center=textCenter(img,125+mid-12,155+mid+12);if(center!==null){const dy=Math.round(center-140);if(readHud(img,dy))return dy;
  // Otherwise the readable offset nearest the text centre (the Poké Ball test is stricter at the edges).
  return ok.reduce((a,b)=>Math.abs(b-dy)<Math.abs(a-dy)?b:a);}return mid;}
// The nameplates' offset is calibrated once, on the first frame that shows a HUD. A first calibration on a
// team card or menu can land on a wrong offset (3c8JZ4pQq50: dy −20 instead of 7; 37 of 2,479 HUD frames
// read, no battle), and some videos change it between battles (maw_a7oKYMM: 22 and 37). A frame whose HUD
// doesn't read is calibrated again, every 4th such frame until the offset has named a species, then every
// 20th; a different offset (> 4 px from every proven one) is accepted only if its nameplates name a species
// on that frame (the caller checks, with its OCR). An offset is proven once it names a species; the caller
// tries the other proven offsets (others()) before calibrating. Videos with one offset are unchanged.
class HudOffset{constructor(dy=null){this.dy=dy;this.trusted=false;this.misses=0;this.changes=[];this.known=[];}
 others(){return this.known.filter(d=>d!==this.dy);}
 retry(img){if(this.dy===null||this.misses++%(this.trusted?20:4))return null;const d=calibrate(img);return d!==null&&Math.abs(d-this.dy)>4&&this.known.every(k=>Math.abs(d-k)>4)?d:null;}
 accept(dy,t){this.changes.push({t,from:this.dy,to:dy});if(!this.trusted)this.known=[];this.known.push(dy);this.dy=dy;this.trusted=true;}
 use(dy){this.dy=dy;}
 trust(){if(!this.trusted){this.trusted=true;if(!this.known.includes(this.dy))this.known.push(this.dy);}}}
// Middle-of-screen statistics for result detection. img covers the band only.
// whiteRun: tallest run of rows containing large white text, in reference (886-wide) pixels.
function bandStats(img){const s=img.width/REF_W;let white=0,black=0,n=0,run=0,tallest=0;for(let y=0;y<img.height;y++){let w=0,c=0;for(let x=0;x<img.width;x+=6){const i=(y*img.width+x)*4,lo=Math.min(img.data[i],img.data[i+1],img.data[i+2]),hi=Math.max(img.data[i],img.data[i+1],img.data[i+2]);c++;if(lo>215)w++;if(hi<28)black++;}n+=c;white+=w;run=w/c>.02?run+1:0;tallest=Math.max(tallest,run);}return {white:white/n,black:black/n,whiteRun:tallest/s};}
// YOU WIN / GOOD EFFORT letters are ~85–95 reference pixels tall; matchmaking text is ~25–30 and
// bright battle effects fill far taller bands. Only text in this range is worth an OCR read.
const resultCandidate=st=>st.white>=.01&&st.whiteRun>=70&&st.whiteRun<=115;
// The "Surrender and exit?" dialog is a white card filling the middle band; its dark text is read only then.
const surrenderCandidate=st=>st.white>=.5;
// combat_surrender in every UI language (CJK dialogs are read with that language's model).
const isSurrender=text=>/surrend|won.?t receive any rewards/i.test(text)||/aufgeben und schlie|keine belohnungen|abandonner et quitter|pas de r[ée]compenses|arrenderti e abbandonare|alcuna ricompensa|rendirte y salir|ninguna recompensa|se render e sair|receber[áa] recompensas|降参しますか|リワードは受け取れません|항복하고|리워드는\s*받을|要投降|無法領取任何獎勵|无法领取/i.test(String(text));
// Nameplate text fingerprints: the same species renders identically, so one OCR per distinct image.
// An unreadable plate is retried on later frames (up to `retries` times) before it is cached as unreadable.
// Reuses one OCR result for near-identical fingerprints. Two fingerprints match when they differ in at most
// `limit` of all cells AND in at most 30% of their ink: with faint text the first test alone would let
// every name match every other. Fingerprints with almost no ink are never cached.
const MIN_INK=12,inkOf=b=>{let n=0;for(let i=0;i<b.length;i++)n+=b[i];return n;};
class NameCache{constructor(limit=.06,retries=3){this.entries=[];this.limit=limit;this.retries=retries;}
 find(bits){const ink=inkOf(bits);if(ink<MIN_INK)return null;for(const e of this.entries){let diff=0;for(let i=0;i<bits.length;i++)diff+=bits[i]!==e.bits[i];if(diff/bits.length<=this.limit&&diff<=.3*Math.max(ink,e.ink))return e;}return null;}
 get(bits){const e=this.find(bits);if(!e||(e.value===null&&e.misses<this.retries))return undefined;return e.value;}
 set(bits,value){const ink=inkOf(bits);if(ink<MIN_INK)return;const e=this.find(bits);if(e){e.value=value;e.misses=value===null?e.misses+1:0;return;}this.entries.push({bits,ink,value,misses:value===null?1:0});if(this.entries.length>400)this.entries.shift();}
 // After the nameplate language is recognised, plates cached as unreadable are read again.
 forgetUnread(){this.entries=this.entries.filter(e=>e.value!==null);}}

// Battle tracker driven by HUD state. Within one battle, fainted Poké Balls and used shields
// only ever increase, so a reset to a fresh HUD marks the next battle without needing results.
class HudTracker{
 constructor(){this.battles=[];this.current=null;this.lastHud=-Infinity;this.lastClosed=null;}
 static fresh(s){return s.fainted===0&&s.balls.every(b=>b==='alive')&&s.shields===2;}
 static used(s){return s.fainted+(2-s.shields);}
 open(t,midBattle){this.current={id:globalThis.crypto?.randomUUID?.()||String(Math.random()),start:t,end:t,my:[],opponent:[],events:[],result:'Unknown',resultSource:'',fadeAt:null,resultUnread:0,flags:midBattle?['Recording starts mid-battle: lead may be missing']:[],reviewed:false,leadConfirmed:false,used:0,fainted:{my:0,opponent:0},shieldsUsed:{my:0,opponent:0},active:{my:'',opponent:''},segments:[]};}
 static ballVerdict(b){const lost=['my','opponent'].filter(s=>b.fainted[s]===3);return lost.length===1?(lost[0]==='opponent'?'Win':'Loss'):null;}
 close(dropLone=false){const b=this.current;if(!b)return;this.current=null;
  // A battle seen on a single HUD frame that opened mid-battle, closed by a later HUD, is noise: usually the
  // first frame of the next battle read before its HUD settled (7 of the 8 one-frame battles among 1,585 saved
  // ones were followed within a second by the real battle), or a lone frame between battles when a video
  // changes its nameplate offset. At the end of the recording it is kept.
  const lone=dropLone&&b.end===b.start&&b.flags.includes('Recording starts mid-battle: lead may be missing');
  if((b.my.length||b.opponent.length)&&!lone){this.battles.push(b);this.lastClosed=b;}}
 // hud: readHud() result with optional .hit per side ({...match(), confidence, raw}); null when no HUD.
 observe(t,hud){if(!hud)return;const fresh=HudTracker.fresh(hud.my)&&HudTracker.fresh(hud.opponent),used=HudTracker.used(hud.my)+HudTracker.used(hud.opponent);
  // A long HUD gap usually means the battle ended, but some recordings hide the nameplates for 30 s or
  // more mid-battle. Continue the same battle when nothing says it ended: no result, no fade to black,
  // no fresh HUD, and fainted counts that never go down (up to 3 minutes).
  const b0=this.current,gap=t-this.lastHud,resumes=b0&&gap>25&&gap<180&&b0.result==='Unknown'&&!b0.resultSearchOver&&b0.endCue===undefined&&!fresh&&hud.my.fainted>=b0.fainted.my&&hud.opponent.fainted>=b0.fainted.opponent;
  // A fresh HUD within 20 s of a battle's start, with the nameplates on screen throughout and nobody fainted, is
  // the same battle: the "used" shield or ball before it was a misread while the HUD settled (24 of 1,585 saved
  // battles were such starts split off, 0–18 s long, each followed at once by the rest of the battle).
  // Likewise when two shields "went" on the same frame (both sides, or one side 2 → 0) and the HUD showed that for at
  // most 3 s before a fresh HUD (within 15 s, a charged-attack cutscene): shield icons hide or blur as a charged attack
  // starts; a real shield takes one. Nobody may have fainted. In 35 saved videos 5 of 264 battles were
  // such 28–56 s parts split off at 0.5–1 s gaps; cGATSvEItIM had 3 more, one across an 8 s cutscene.
  // Such a fresh HUD also shows the battle's start: a battle that opened on a misread (a shield, or a ball read '?', often
  // on the first HUD after a fade, below) and turns fresh within 20 s was seen from its start, so it drops the "mid-battle"
  // flag, which cost the 2026-10-12 re-analysis full teams in the usage export and the counter's results (5d9UzKXX_XQ 110.5 s).
  const c0=this.current,settling=c0&&t-c0.start<20&&gap<8,transient=c0&&c0.usedJump>=2&&this.lastHud-c0.usedAt<=3&&gap<15,clean=c0&&fresh&&(settling||transient)&&c0.fainted.my+c0.fainted.opponent===0;
  if(clean&&c0.used>0){c0.used=0;c0.shieldsUsed={my:0,opponent:0};c0.events=c0.events.filter(e=>e.kind!=='shield');}
  if(clean&&t-c0.start<20)c0.flags=c0.flags.filter(f=>!f.startsWith('Recording starts mid-battle'));
  // After a fade to black, a HUD that returns (≥ 3 s later) with fewer fainted Pokémon than the battle has seen starts
  // the next battle even when it doesn't read as fresh (a misread ball or shield on every frame): fainted counts never go
  // down within a battle. cBePYfn3m1U merged 4 battles into one 772 s "battle" that way (fades at 136, 322 and 522 s).
  const reset=b0&&b0.endCue!==undefined&&gap>=3&&gap<=25&&!fresh&&hud.my.fainted+hud.opponent.fainted<b0.fainted.my+b0.fainted.opponent;
  if(reset){this.close(true);this.open(t,true);}
  if(this.current&&((gap>25&&!resumes)||(fresh&&this.current.used>0)))this.close(true);
  if(!this.current){if(!fresh&&t-this.lastHud<25){this.lastHud=t;return;}this.open(t,!fresh);}
  const b=this.current;b.end=t;this.lastHud=t;if(used>0&&!b.used){b.usedAt=t;b.usedJump=used;}b.used=Math.max(b.used,used);
  for(const side of ['my','opponent']){const s=hud[side];
   if(s.fainted>b.fainted[side]){b.events.push({t,kind:'faint',side,label:`${side==='my'?'Your':'Opponent'} Pokémon fainted (${s.fainted}/3)`});b.fainted[side]=s.fainted;}
   if(2-s.shields>b.shieldsUsed[side]){b.events.push({t,kind:'shield',side,label:`${side==='my'?'You':'Opponent'} used a shield`});b.shieldsUsed[side]=2-s.shields;}
   const hit=s.hit;if(!hit)continue;const stable=b.active[side]===hit.key;b.active[side]=hit.key;const list=b[side],existing=list.find(p=>p.key===hit.key);
   // Type icons and CP are read only once the name has held for two samples (icons lag switches).
   if(existing&&stable){if(s.types?.length){const k=[...s.types].sort().join('/');existing.typeVotes=existing.typeVotes||{};existing.typeVotes[k]=(existing.typeVotes[k]||0)+1;}if(s.cp){existing.cpVotes=existing.cpVotes||{};existing.cpVotes[s.cp]=(existing.cpVotes[s.cp]||0)+1;}}if(existing){existing.last=t;continue;}
   if(list.length>=3){if(!b.flags.includes(`More than three ${side} species: check boundary`))b.flags.push(`More than three ${side} species: check boundary`);continue;}
   list.push({...hit,first:t,last:t});b.events.push({t,kind:'reveal',side,label:hit.raw,confidence:hit.confidence});}
  // Matchups: stretches where the same two Pokémon face each other (used for HP-bar analysis).
  if(b.active.my&&b.active.opponent){const g=b.segments.at(-1);if(g&&g.my===b.active.my&&g.opponent===b.active.opponent&&t-g.end<15)g.end=t;else b.segments.push({start:t,end:t,my:b.active.my,opponent:b.active.opponent});}}
 // A YOU WIN / GOOD EFFORT screen applies to the battle whose HUD ended within the last 45 s.
 result(t,value){const b=this.current&&t-this.lastHud<45?this.current:this.lastClosed&&t-this.lastClosed.end<45?this.lastClosed:null;if(!b||b.resultSource==='result screen')return false;
  const fromBalls=HudTracker.ballVerdict(b);b.result=value;b.resultSource='result screen';b.events.push({t,kind:'result',label:value});
  if(fromBalls&&fromBalls!==value)b.flags.push(`Result screen (${value}) disagrees with Poké Ball count (${fromBalls})`);return true;}
 // Only look for a result screen when the battle can have ended: one side is on its last
 // Pokémon, or the nameplates have been gone longer than a charged-attack sequence (forfeit).
 // The screen fades to black when a battle ends, including when an opponent leaves early.
 // The first black frame after the last HUD frame is kept as fadeAt (evidence only: the game fades to black at
 // every battle end, so a fade alone doesn't tell a forfeit from a knockout; see inferResult).
 blackout(t){const b=this.current;if(b&&t-this.lastHud<20){b.endCue=t;if(!(b.fadeAt>this.lastHud))b.fadeAt=t;}}
 // A result-sized white text band was OCR'd while the battle could have ended, but read as no result: a person
 // can probably tell from the screen, so the result question stays (inferResult).
 unreadResult(t){const b=this.current&&t-this.lastHud<45?this.current:this.lastClosed&&t-this.lastClosed.end<45?this.lastClosed:null;if(b&&b.resultSource!=='result screen')b.resultUnread=(b.resultUnread||0)+1;}
 // The player opened the forfeit dialog. It can be cancelled, so it only counts if the battle then
 // ends as a loss (or the HUD never returns and no result screen is read).
 surrender(t){const b=this.current&&t-this.lastHud<20?this.current:this.lastClosed&&t-this.lastClosed.end<20?this.lastClosed:null;if(b){b.surrender=t;b.events.push({t,kind:'surrender',label:'Surrender dialog'});}}
 // Matchmaking text means the previous result screen has already passed.
 matchmaking(){for(const b of [this.current,this.lastClosed])if(b)b.resultSearchOver=true;}
 awaitingResult(t){const b=this.current&&t-this.lastHud<45?this.current:this.lastClosed&&t-this.lastClosed.end<45?this.lastClosed:null;if(!b||b.resultSource==='result screen'||b.resultSearchOver)return false;
  return b!==this.current||b.endCue!==undefined||Math.max(b.fainted.my,b.fainted.opponent)>=2||t-this.lastHud>=8;}
 // videoEnd: the last analysed second (for "the recording ends before a result"). Results without a result screen
 // come from inferResult; run-node.cjs and ui.js apply it again once the matchups' HP series exist.
 finish({videoEnd=null}={}){if(this.current){if(this.current.result==='Unknown'&&this.current.fainted.my<3&&this.current.fainted.opponent<3)this.current.flags.push('Recording ends before a result');this.close();}
  for(const b of this.battles){if(b.surrender!==undefined){if(b.result==='Loss'&&b.resultSource==='result screen')b.ending='you-forfeit';delete b.surrender;}
   if(b.result==='Win'&&b.fainted.opponent<3&&b.opponent.length<3){b.flags.push('Win before all opponent Pokémon fainted: opponent may have left; team incomplete');b.ending=b.ending||'opponent-forfeit';}
   for(const side of ['my','opponent'])for(const p of b[side])resolveForm(p);
   delete b.used;delete b.usedAt;delete b.usedJump;delete b.endCue;delete b.resultSearchOver;delete b.active;}
  return applyInferredResults(this.battles,{videoEnd});}
}
// ---- Results from the battle timeline (README "Results without a result screen") ----
// A read result screen (or a reviewer's answer) always wins. Without one, three outcomes (owner's rule: only ask
// when the answer isn't confident and feedback is needed):
// - CONFIDENT, no question (measured on 1,422 read results and the owner's answers, 2026-10-12):
//   faints: the Poké Ball counter shows all three of one side fainted, battle seen from its start (41/41), or two
//   fainted on one side (≤1 on the other) and that side's last HP bar empty within 3 s of the end (67/67);
//   surrender: the "Surrender and exit?" dialog, then the HUD gone within 3 s (118/118).
// - UNCERTAIN, ask with the guess shown (resultGuess {rule, value, p, reason}; result stays Unknown). Rules and
//   default p (the owner's answers; learning-loop.cjs recomputes them on every refit and promotes a rule to
//   confident once it is ≥95% on ≥30 answers from ≥5 videos, applyInferredResults' `promoted`):
//   fade (a fade to black after the last HUD with both sides alive: opponent forfeit, 10/14), tie (counter 2/2, the
//   last bar empty on one side: that side lost, 41/49), mid-start (counter 3 but the recording began mid-battle and
//   the bars don't agree: 7/15), unread (a result-like screen OCR couldn't read), both-alive (older saved results
//   without fade data and both bars alive at the end: the forfeit-looking case; re-extraction adds the fields),
//   knockout (counter 2 on one side, ≤1 on the other, and the centred bar of the final charged-attack cutscene read
//   empty within 3 s of the end, the other side's own bar ≥ 10%: the knockout of that side's last Pokémon; the
//   cutscene bar is the defender's, framed alone as it is hit; b.cutsceneBar from run-node.cjs; 74/77 read result
//   screens on 122 re-extracted labelled videos, 7/9 owner answers, 2026-10-13).
//   Timer endings (both alive at 0:00) can't be told apart: the clock isn't read.
// - UNRESOLVABLE, closed (policy) when no rule applies, there is no fade and no result-like screen, and the next
//   battle's HUD follows within 10 s or the recording ends (a hard cut).
const RESULT_RULES={zero:.03,alive:.1,lag:3,cut:10,fade:6};
const RESULT_GUESS_P={fade:.71,tie:.84,'mid-start':.47,unread:.5,'both-alive':.46,knockout:.96};
const PROMOTABLE=new Set(Object.keys(RESULT_GUESS_P));
// Sources that inference may set and re-derive; legacy names from saved results are replaced too.
const INFERRED_SOURCES=new Set(['','faints','surrender','unresolvable','Poké Ball count','surrender dialog',...PROMOTABLE]);
function median(a){const s=a.filter(Number.isFinite).sort((p,q)=>p-q),n=s.length;return n?(n%2?s[n>>1]:(s[n/2-1]+s[n/2])/2):null;}
// Each side's last HP reading in the battle's latest matchup with an HP series: {v: median fill over the last 2 s
// of readings, t: time of the last reading}.
function lastHp(b){let g=null;for(const m of b.matchups||[])if(m.series&&(!g||m.end>g.end))g=m;if(!g)return {};const s=g.series,out={};
 for(const side of ['my','opponent']){const pts=[];(s[side]||[]).forEach((v,i)=>{if(v!=null&&Number.isFinite(v))pts.push([s.ts?s.ts[i]:s.t0+i/s.fps,v]);});if(!pts.length)continue;const tl=pts.at(-1)[0];out[side]={t:tl,v:median(pts.filter(p=>p[0]>=tl-2).map(p=>p[1]))};}
 return out;}
// The centred cutscene bar at the end of the battle (b.cutsceneBar: [[t, fill, y0], …] around the end): {v: median fill
// over the last 1 s of readings up to `lag` s after the end, t: time of the last one}, or null.
function lastCutscene(b,lag=RESULT_RULES.lag){const pts=(b.cutsceneBar||[]).filter(p=>Number.isFinite(p[1])&&p[0]<=b.end+lag);if(!pts.length)return null;const tl=pts.at(-1)[0];return {t:tl,v:median(pts.filter(p=>p[0]>=tl-1).map(p=>p[1]))};}
const GUESS_WHY={fade:'The screen faded to black with both sides still standing, which usually means the opponent left or forfeited, but the game fades at every ending',
 tie:'Both sides had two Pokémon down and one last HP bar read empty at the end; the empty side probably lost, but the final knockout is often hidden by the attack animation',
 'mid-start':'All three of one side’s Pokémon show as fainted, but the recording began mid-battle so the counter may be stale and the HP bars don’t confirm it',
 unread:'A result-like screen appeared but could not be read, and nothing on the timeline decides',
 'both-alive':'Both HP bars were still above empty at the end, so the opponent probably left or forfeited (this saved result has no fade data)',
 knockout:'Two Pokémon of the losing side had fainted on the Poké Ball counter and the HP bar shown alone in the final charged-attack cutscene emptied as the battle ended; that bar is the defender\u2019s, but the cutscene does not show whose it is'};
const GUESS_VALUE={'Win:opponent-forfeit':'the opponent forfeited','Win':'you won','Loss':'you lost','Loss:you-forfeit':'you forfeited','Tie':'a tie'};
// The question text for a guess; p is the measured precision when known ({right,total}) else the default.
function guessDetail(g,stat){const n=stat&&stat.total>=10?`${stat.right} of ${stat.total} of your earlier answers agreed`:`about ${Math.round(g.p*100)}% right in earlier checks`;
 return `The timeline suggests ${GUESS_VALUE[g.value]||g.value} (${n}). ${GUESS_WHY[g.rule]||g.reason}. Check the frames after the battle.`;}
// The result of one finished battle from its timeline: {result, ending?, source, reason}, {source:'guess', rule,
// value, p, reason} (uncertain: ask with this guess), {source:'unresolvable', reason} or null (undecided; ask).
// ctx: next = start of the next battle (null if none), videoEnd = last second read.
function inferResult(b,{next=null,videoEnd=null}={}){const R=RESULT_RULES,ev=b.events||[],f=b.fainted||{my:0,opponent:0},name={my:'your',opponent:'the opponent’s'};
 const guess=(rule,value,reason)=>({source:'guess',rule,value,p:RESULT_GUESS_P[rule],reason});
 if(ev.some(e=>e.kind==='surrender'&&b.end<=e.t+3))return {result:'Loss',ending:'you-forfeit',source:'surrender',reason:'Surrender dialog, then the battle ended'};
 const mid=(b.flags||[]).some(x=>x.startsWith('Recording starts mid-battle')),three=['my','opponent'].filter(s=>f[s]>=3);
 if(three.length===1&&!mid)return {result:three[0]==='opponent'?'Win':'Loss',source:'faints',reason:`Poké Ball counter: all three of ${name[three[0]]} Pokémon fainted`};
 const hp=lastHp(b),empty=x=>{const h=hp[x];return !!h&&h.v<=R.zero&&b.end-h.t<=R.lag;},standing=x=>{const h=hp[x];return !!h&&h.v>=R.alive;};
 const zeroed=['my','opponent'].filter(x=>{const y=x==='my'?'opponent':'my';return f[x]>=2&&f[y]<2&&empty(x)&&standing(y);});
 if(zeroed.length===1){const x=zeroed[0];return {result:x==='opponent'?'Win':'Loss',source:'faints',reason:`Two of ${name[x]} Pokémon fainted on the Poké Ball counter and the last one's HP bar emptied at the end`};}
 const lose=x=>x==='opponent'?'Win':'Loss';
 // The last knockout inside a cutscene: the defender's bar is centred there, not in either side's own HP series.
 const cut=lastCutscene(b,R.lag),ko=!!cut&&cut.v<=R.zero&&Math.abs(b.end-cut.t)<=R.lag,knocked=['my','opponent'].filter(x=>{const y=x==='my'?'opponent':'my';return ko&&f[x]>=2&&f[y]<2&&standing(y);});
 if(knocked.length===1)return guess('knockout',lose(knocked[0]),`Counter at 2 for ${name[knocked[0]]} side; the bar shown alone in the final cutscene emptied at the end`);
 if(three.length===1)return guess('mid-start',lose(three[0]),`Poké Ball counter shows all three of ${name[three[0]]} Pokémon fainted, but the recording started mid-battle`);
 if(f.my===2&&f.opponent===2){const e=['my','opponent'].filter(empty);if(e.length===1&&standing(e[0]==='my'?'opponent':'my'))return guess('tie',lose(e[0]==='my'?'my':'opponent'),`Counter at 2 on both sides; ${name[e[0]]} last HP bar is empty`);}
 if(b.resultUnread)return guess('unread',three[0]?lose(three[0]):'Win:opponent-forfeit','A result-like screen could not be read');
 // Both sides alive at the end: neither last bar is empty (a missing reading counts as alive for new extractions).
 const alive=x=>!empty(x)&&f[x]<3,bothAlive=alive('my')&&alive('opponent'),tracked=b.fadeAt!==undefined;
 if(tracked&&b.fadeAt!==null&&b.fadeAt-b.end<=R.fade&&bothAlive)return guess('fade','Win:opponent-forfeit','Fade to black after the last HUD with both sides alive');
 if(!tracked&&standing('my')&&standing('opponent')&&f.my<3&&f.opponent<3)return guess('both-alive','Win:opponent-forfeit','Both HP bars alive at the end (no fade data in this saved result)');
 const gap=next!=null?next-b.end:null,left=next==null&&videoEnd!=null?videoEnd-b.end:null;
 if(gap!==null&&gap<R.cut)return {source:'unresolvable',reason:gap<3?'The next battle’s HUD follows at once (a cut or a split battle): no result screen':`No result screen: the video cuts to the next battle ${gap.toFixed(1)} s later, no fade, and the timeline doesn’t decide`};
 if(left!==null&&left<R.cut)return {source:'unresolvable',reason:'The recording ends before a result screen, and the timeline doesn’t decide'};
 return null;}
// Re-derives every battle result that didn't come from a result screen or a reviewer (idempotent; saved runs
// get the current rules on every refit). promoted: rules the learning loop found ≥95% right on the owner's answers;
// they are confident (resultSource = the rule). Returns the battles.
// A battle that never moves is a still image of one (a screenshot on a title card or in a talking-head video,
// INMpMrmY7GI), not footage. On real footage the HP readings jitter with compression and animation; on a still one
// value repeats, apart from a few frames of the cut into it. In the 2026-10-17 harvest (4,678 battles) the most common
// reading made up ≤ 67% of a side's readings in every hitless real battle, and 96–100% on the two stills found
// (frame-to-frame difference 0.000 against 5–9 on live play). Hits or banners mean play.
function stillBattle(b,{minReadings=20,share=.9}={}){let n=0;const values={my:[],opponent:[]};
 if((b.events||[]).some(e=>e.kind==='move'||e.kind==='go'))return false;
 for(const g of b.matchups||[]){if((g.hitsOnMy||[]).length||(g.hitsOnOpp||[]).length)return false;for(const side of ['my','opponent'])for(const v of g.series?.[side]||[])if(v!=null){n++;values[side].push(v);}}
 if(n<minReadings)return false;
 return Object.values(values).every(v=>{if(!v.length)return true;const c=new Map();for(const x of v)c.set(x,(c.get(x)||0)+1);return Math.max(...c.values())>=share*v.length;});}
// Drops still battles in place (run-node and the browser, once the matchups' HP series exist); returns their spans.
function dropStillBattles(battles){const out=[];for(let i=battles.length-1;i>=0;i--)if(stillBattle(battles[i])){out.unshift({start:battles[i].start,end:battles[i].end});battles.splice(i,1);}return out;}
function applyInferredResults(battles,{videoEnd=null,promoted=null}={}){(battles||[]).forEach((b,i)=>{if(!INFERRED_SOURCES.has(b.resultSource||''))return;
  let r=inferResult(b,{next:battles[i+1]?.start??null,videoEnd});delete b.resultGuess;
  if(r?.source==='guess'){if(promoted&&(promoted.has?promoted.has(r.rule):promoted.includes(r.rule))){const [res,ending]=r.value.split(':');r={result:res,ending,source:r.rule,reason:r.reason};}
   else{b.resultGuess={rule:r.rule,value:r.value,p:r.p,reason:r.reason};r=null;}}
  b.result=r?.result||'Unknown';b.resultSource=r?r.source:'';
  if(r?.ending)b.ending=r.ending;else delete b.ending;if(r?.reason)b.resultReason=r.reason;else delete b.resultReason;});
 return battles;}
// The last second a saved run analysed (its END, the end of its last decoded range, or START + decoded seconds).
function runEnd(raw){if(Number.isFinite(raw?.end))return raw.end;const rs=raw?.ranges;if(Array.isArray(rs)&&rs.length&&Number.isFinite(rs.at(-1)?.[1]))return rs.at(-1)[1];return Number.isFinite(raw?.videoSeconds)?(raw.start||0)+raw.videoSeconds:null;}
// Keeps the candidate forms whose types match the majority icon reading, and the most-read CP.
function resolveForm(p){const top=o=>o&&Object.entries(o).sort((a,b)=>b[1]-a[1])[0];const tv=top(p.typeVotes),cv=top(p.cpVotes);if(cv)p.cp=Number(cv[0]);
 if(!tv||!p.candidates?.length)return;p.observedTypes=tv[0].split('/');const want=tv[0],fits=p.candidates.filter(c=>[...(c.types||[])].filter(t=>t&&t!=='none').sort().join('/')===want);
 if(fits.length&&fits.length<p.candidates.length){p.candidates=fits;p.formNote=`Type icons (${p.observedTypes.join(' / ')}) rule out other forms`;}
 // Shadow and regular forms share types; a single remaining non-Shadow form is the species' form.
 const base=[...new Set(fits.map(c=>c.id.replace(/_shadow$/,'')))];if(base.length===1)p.formId=base[0];}
// Charged-attack banner: "<actor> used <move>!". Only the two Pokémon on the field can attack, so the
// actor is matched against the active nameplates first (this also separates mirror matches),
// tolerating one misread letter; the revealed teams are the fallback.
// Banner text, tolerant of junk OCR picks up from bright scenery around the translucent box:
// finds "Go, X!" or "X used Y!" anywhere in the text. Returns {kind:'go',name} | {kind:'move',actor,move}.
function parseBanner(text){const t=String(text).replace(/[“”"|_—=~‘\[\](){}<>*#^]/g,' ').replace(/\s+/g,' ');
 let m=/\bgo[.,:;]?\s+([a-z][a-z .'’-]{1,24}?)\s*[!1l]/i.exec(t);if(m)return {kind:'go',name:m[1].trim()};
 m=/([a-z][a-z .'’-]{1,40}?)\s+used\s+([a-z][a-z '’-]{1,30}?)\s*[!1.]/i.exec(t);if(m)return {kind:'move',actor:m[1].trim(),move:m[2].trim()};return null;}
// ---- Banners in other UI languages (game strings battle_throw_callout / battle_charged_move_callout) ----
// Latin scripts come from the English OCR text: "Los, X!" "X hat Y eingesetzt!" (de), "Vas-y, X !" "X a utilisé Y !"
// (fr), "Vai, X!" "X usa Y!" (it), "¡Adelante, X!" "¡X ha usado Y!" "¡X usó Y!" (es), "Vamos, X!" "X usou Y!" (pt).
// CJK banners are read with the video's language model: "ゆけっ！X！" "XはYを使った！" (ja), "가랏! X!"
// "X(은)는 Y(을)를 썼다!" (ko), "上吧！X！" "X 使出了 Y！" (zh, on two lines).
const LATIN_GO=/\b(?:los|vas-y|vas y|vai|adelante|vamos)[.,:;]?\s+([a-zà-ÿ][a-zà-ÿ .'’-]{1,24}?)\s*[!1]/i;
const LATIN_MOVE=[/([a-zà-ÿ][a-zà-ÿ .'’-]{1,40}?)\s+hat\s+([a-zà-ÿ][a-zà-ÿ '’-]{1,30}?)\s+eingesetzt/i,/([a-zà-ÿ][a-zà-ÿ .'’-]{1,40}?)\s+a\s+utilis[ée]\s+([a-zà-ÿ][a-zà-ÿ '’-]{1,30}?)\s*[!1.]/i,
 /([a-zà-ÿ][a-zà-ÿ .'’-]{1,40}?)\s+(?:ha\s+usado|us[óo]u?|usa)\s+([a-zà-ÿ][a-zà-ÿ '’-]{1,30}?)\s*[!1.]/i];
// Opponents' Pokémon are announced as "相手が Xをくりだした！" (ja), "상대가 X(을)를 내보냈다!" (ko), "對手派出了X！" (zh).
const ZH_BANNER={go:[/上吧[!！]*([^!！]+)/,/派出了([^!！]+)/],move:/^(.+?)使出了(.+?)[!！]?$/};
const CJK_BANNER={ja:{go:[/ゆ[けげ][っッつ]?[!！。]*([^!！]+)/,/手が([^!！]+?)をく/],move:/^(.+?)[はば](.+?)を使/},
 ko:{go:[/가랏[!！]*([^!！]+)/,/상대가([^!！]+?)\(?[을울]?\)?[를틀]내/],move:/^(.+?)\(?[은온]?\)?[는눈](.+?)\(?[을울]?\)?[를틀]썼/},'zh-Hant':ZH_BANNER,'zh-Hans':ZH_BANNER};
function parseLocalBanner(text,lang){
 if(LOCALES[lang]?.script){const pat=CJK_BANNER[lang];if(!pat)return null;const t=String(text).normalize('NFKC').replace(/[\s|_"“”'‘’「」『』]/g,'');let m=pat.move.exec(t);if(m)return {kind:'move',actor:m[1],move:m[2]};for(const re of pat.go){m=re.exec(t);if(m)return {kind:'go',name:m[1]};}return null;}
 const t=String(text).replace(/[“”"|_—=~‘\[\](){}<>*#^¡¿]/g,' ').replace(/\s+/g,' ');for(const re of LATIN_MOVE){const m=re.exec(t);if(m)return {kind:'move',actor:m[1].trim(),move:m[2].trim()};}
 const m=LATIN_GO.exec(t);return m?{kind:'go',name:m[1].trim()}:null;}
// move-names.json (PokeAPI) → localised name key → PvPoke move, per language. A "+" move or Aegislash's charge variant
// gives way to the plain move (as English matching does); null when several plain moves share the name (Weather
// Ball, Techno Blast, Hidden Power: the banner doesn't show the type).
function moveDictionary(moves,names,lang){const table=names?.[lang];if(!table)return null;const byId=new Map(moves.map(m=>[m.moveId,m])),map=new Map();
 const variant=m=>/_PLUS$|^AEGISLASH_CHARGE_/.test(m.moveId);
 for(const [id,name] of Object.entries(table)){const m=byId.get(id),key=nameKey(name,lang);if(!m||!key)continue;const o=map.get(key);
  map.set(key,!map.has(key)?m:o===null||o===m?o:variant(m)?o:variant(o)?m:null);}return map;}
// Exact name, the English name (Latin languages list only names that differ), or one wrong character when only
// one move is that close (≥ 3 CJK characters / 5 letters).
function findMove(text,lang,moveMaps,moves){const cjk=!!LOCALES[lang]?.script,key=nameKey(text,lang),map=moveMaps?.[lang];if(key.length<2)return null;
 if(map?.has(key))return map.get(key);if(!cjk){const ms=moves.filter(x=>normalize(x.name.replace(/\s*\([^)]*\)$/,''))===key);if(ms.length)return ms.length===1?ms[0]:null;}
 if(!map||key.length<(cjk?3:5))return null;let found=null;for(const [k,m] of map)if(Math.abs(k.length-key.length)<=1&&distance(k,key)<=1){if(!m||found&&found!==m)return null;found=m;}return found;}
// Actor or "Go" name → English nameplate key; junk before the name is dropped (last 1–3 words, or up to 3
// leading CJK characters).
function findSpecies(text,lang,locales,dict){const cjk=!!LOCALES[lang]?.script,cands=[];
 if(cjk){const s=String(text).trim(),mega=LOCALES[lang].mega&&s.startsWith(LOCALES[lang].mega);for(let i=0;i<=(mega?0:Math.min(3,s.length-2));i++)cands.push(s.slice(i));}   // never cut a Mega prefix
 else{const w=String(text).split(' ').filter(Boolean);for(const n of [1,2,3])if(n<=w.length)cands.push(w.slice(-n).join(' '));}
 for(const c of cands){const h=(locales?.[lang]&&matchLocale(c,locales[lang],lang))||(!cjk&&match(c,dict));if(h)return h.key;}return null;}
// A banner in another UI language → {kind:'go',name} or {kind:'move',actor,move,lang} with the English nameplate
// key and the PvPoke move name, for HudTracker.go/move. lang: the CJK language the text was read in, or the
// video's nameplate language for Latin text ('en' tries every Latin language: Spanish, Italian and Portuguese
// nameplates mostly equal English, so those videos stay 'en').
function localBanner(text,{lang='en',locales={},moveMaps={},moves=[],dict}){const cjk=!!LOCALES[lang]?.script;
 const langs=cjk?[lang]:[...new Set([lang,'de','fr','es','it'])].filter(l=>l!=='en'&&!LOCALES[l]?.script);
 const pb=parseLocalBanner(text,cjk?lang:'de');if(!pb)return null;
 for(const l of langs){if(pb.kind==='go'){const name=findSpecies(pb.name,l,locales,dict);if(name)return {kind:'go',name};continue;}
  const move=findMove(pb.move,l,moveMaps,moves),actor=move&&findSpecies(pb.actor,l,locales,dict);if(move&&actor)return {kind:'move',actor,move:move.name,lang:l};}
 return null;}
// Banner crop: a 96×12 fingerprint of its white letters and their share (text when ~3–30%).
// The banner sits at a fixed share of the FULL screen height (30.2%, height 3.8%), unlike the
// nameplates, which hang from the top. With the top cut off (dy < 0, YouTube crops) the full height is
// the frame height minus dy, so the box is placed from that, not by shifting the phone layout.
function bannerBox(img,dy){const s=img.width/REF_W,full=img.height-dy*s,y0=Math.round(.302*full+dy*s);return [Math.round(71*s),y0,Math.round(815*s),y0+Math.round(.038*full)];}
function bannerRead(img,dy){const box=bannerBox(img,dy),[x0,y0,x1,y1]=box,sig=new Uint8Array(96*12),d=img.data;let n=0;
 for(let r=0;r<12;r++)for(let c=0;c<96;c++){const x=Math.floor(x0+(c+.5)*(x1-x0)/96),y=Math.floor(y0+(r+.5)*(y1-y0)/12);if(y<0||y>=img.height)continue;const i=(y*img.width+x)*4;if(Math.min(d[i],d[i+1],d[i+2])>200){sig[r*96+c]=1;n++;}}
 return {box,sig,textPixels:n/sig.length};}
// CJK banners: thin glyphs, and over a light sky the translucent box leaves the text pale blue (≈150,215,255), so
// the white-pixel share above stays near 0 (0.2% on a Japanese banner). Their strokes still make sharp brightness
// steps: the share of pixels differing by > 60 from the pixel 2 px to the left is 2.5–3.4% on Japanese banners and
// ≤ 1.8% otherwise (sky, arena, "NICE!") over 60 s of lC6aiKQuZ5c. sig: 96×12 cells holding such a step.
// search > 0: the box is moved up or down by up to that many rows to the band with the most steps (the banner's
// height share differs between phones: afvH9iu5WsE and stLd7OkIg3Y put the text just above the English box).
function bannerEdges(img,box,{search=0}={}){let [x0,y0,x1,y1]=box.map(Math.round);const d=img.data,W=img.width,H=img.height,sig=new Uint8Array(96*12),h=y1-y0;
 const step=(i,j)=>Math.abs(d[i]+d[i+1]+d[i+2]-d[j]-d[j+1]-d[j+2])>180;
 if(search>0){const top=Math.max(0,y0-search),bottom=Math.min(H,y1+search),rows=[];for(let y=top;y<bottom;y++){let c=0;for(let x=Math.max(2,x0);x<Math.min(W,x1);x+=2){const i=(y*W+x)*4;if(step(i,i-8))c++;}rows.push(c);}
  let best=-1,at=y0,sum=0;for(let k=0;k<rows.length;k++){sum+=rows[k];if(k>=h)sum-=rows[k-h];if(k>=h-1&&sum>best){best=sum;at=top+k-h+1;}}y0=at;y1=at+h;box=[x0,y0,x1,y1];}
 let e=0,n=0;
 for(let y=Math.max(0,y0);y<Math.min(H,y1);y++)for(let x=Math.max(2,x0);x<Math.min(W,x1);x++){const i=(y*W+x)*4;n++;
  if(step(i,i-8)){e++;sig[Math.min(11,Math.floor((y-y0)*12/(y1-y0)))*96+Math.min(95,Math.floor((x-x0)*96/(x1-x0)))]=1;}}
 return {box,sig,share:n?e/n:0};}
// "Go, Marowak!" names the Pokémon being sent out at that moment (either side), even with the
// nameplates hidden: kept as a 'go' event for switch timing and leads.
HudTracker.prototype.go=function(t,text,dict,parsed=null){const b=this.current;if(!b)return false;const pb=parsed||parseBanner(text);if(pb?.kind!=='go')return false;const hit=match(pb.name,dict);if(!hit)return false;
 const last=b.events.filter(e=>e.kind==='go').at(-1);if(last&&last.actor===hit.key&&t-last.t<6)return true;b.events.push({t,kind:'go',actor:hit.key,label:text.trim()});return true;};
HudTracker.prototype.move=function(t,text,confidence,moves,parsed=null){const b=this.current;if(!b||confidence<40)return;const pb=parsed||parseBanner(text);if(pb?.kind!=='move')return;
 const move=moves.find(m=>normalize(m.name)===normalize(pb.move));if(!move)return;
 // Junk can precede the name: try the last 1–3 words and keep the one that matches a Pokémon on the field.
 const words=pb.actor.split(' ').filter(Boolean),cands=[1,2,3].filter(n=>n<=words.length).map(n=>normalize(words.slice(-n).join(' '))),keys=[b.active.my,b.active.opponent,...b.my.map(p=>p.key),...b.opponent.map(p=>p.key)].filter(Boolean);
 const close=(k,a)=>k===a||(a.length>=5&&distance(k,a)<=1);const actor=cands.find(a=>keys.some(k=>close(k,a)))||cands.at(-1),near=k=>k&&close(k,actor);
 let sides=['my','opponent'].filter(side=>near(b.active[side]));if(sides.length!==1)sides=['my','opponent'].filter(side=>b[side].some(p=>near(p.key)));
 const side=sides.length===1?sides[0]:'unknown',key=side==='unknown'?actor:b.active[side]&&near(b.active[side])?b.active[side]:(b[side].find(p=>near(p.key))?.key||actor);
 const last=b.events.filter(e=>e.kind==='move').at(-1);if(last&&last.move===move.moveId&&last.actor===key&&t-last.t<8)return;
 b.events.push({t,kind:'move',side,actor:key,move:move.moveId,label:text.trim(),confidence});};

// Team-training export in the trainer's usage-file format (training/team-search/meta.cjs loadUsage).
// Rows are split by recording date so the trainer's half-life weighting uses when battles were played.
function trainingExport(battles,{cp,cup,rank=''}){const byDate=new Map();for(const b of battles.filter(b=>!b.context?.example&&eligible(b))){const d=String(b.context?.collectedAt||'').slice(0,10);if(!byDate.has(d))byDate.set(d,[]);byDate.get(d).push(b);}const dates=[...byDate.keys()].filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)).sort(),teams=[...byDate].flatMap(([d,bs])=>aggregate(bs).teams.map(t=>/^\d{4}-\d{2}-\d{2}$/.test(d)?{...t,collectedAt:d}:t));return {source:'Meta Extractor: human-reviewed video observations',cp,cup,collectedAt:dates.at(-1)||null,rank,teams:teams.sort((a,b)=>b.count-a.count)};}
const api={stillBattle,dropStillBattles,normalize,dictionary,match,LOCALES,nameKey,localeDictionary,matchLocale,NameLanguage,readName,outcome,Tracker,eligible,aggregate,trainingExport,usageEstimates,rankingPrior,HUD,hudBand,readHud,calibrate,HudOffset,NameCache,HudTracker,bandStats,bannerBox,bannerRead,bannerEdges,parseBanner,parseLocalBanner,localBanner,moveDictionary,isMatchmaking,resultCandidate,surrenderCandidate,isSurrender,readTypes,TYPE_COLORS,resolveForm,inferResult,applyInferredResults,runEnd,RESULT_RULES,RESULT_GUESS_P,PROMOTABLE,INFERRED_SOURCES,guessDetail,lastCutscene};if(typeof module!=='undefined')module.exports=api;root.MetaExtractorCore=api;
})(typeof window==='undefined'?globalThis:window);
