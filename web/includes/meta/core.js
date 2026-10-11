(function(root){
'use strict';
const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function distance(a,b){const row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let prev=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const old=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,prev+(a[i-1]!==b[j-1]));prev=old;}}return row[b.length];}
// The nameplate shows Mega and Primal forms as "Mega Garchomp", "Mega Mewtwo X", "Primal Kyogre"; PvPoke
// names them "Garchomp (Mega)", "Mewtwo (Mega X)", "Kyogre (Primal)". Both spellings map to that form only.
const inGameName=p=>{const m=/^(.*) \((Mega|Primal)( [XY])?\)$/.exec(p.speciesName);return m?`${m[2]} ${m[1]}${m[3]||''}`:null;};
function dictionary(pokemon){const map=new Map();for(const p of pokemon){const shown=inGameName(p),visible=shown||p.speciesName.replace(/\s*\([^)]*\)/g,'').replace(/\s*Shadow$/i,'');for(const name of [p.speciesName,visible,p.speciesId.replace(/_/g,' ')]){const key=normalize(name);if(!map.has(key))map.set(key,[]);if(!map.get(key).some(x=>x.speciesId===p.speciesId))map.get(key).push(p);}}return map;}
function match(text,dict){const key=normalize(text.replace(/\bCP\s*\d+/gi,''));if(key.length<3)return null;let candidates=dict.get(key),quality='exact';if(!candidates){let best=99;for(const [name,items] of dict){if(Math.abs(name.length-key.length)>1)continue;const d=distance(key,name);if(d<best){best=d;candidates=items;}else if(d===best)candidates=[...candidates,...items];}if(best>1||key.length<5)return null;quality='suggestion';}candidates=[...new Map(candidates.map(p=>[p.speciesId,p])).values()];return {label:text.trim(),candidates:candidates.map(p=>({id:p.speciesId,name:p.speciesName,types:p.types,dex:p.dex})),key:normalize(inGameName(candidates[0])||candidates[0].speciesName.replace(/\s*\([^)]*\)/g,'').replace(/\s*Shadow$/i,'')),quality,id:quality==='exact'&&candidates.length===1?candidates[0].speciesId:''};}
function outcome(text){const key=normalize(text);if(key.length>=6&&key.length<=11&&distance(key,'youwin')<=1)return 'Win';if(key.length>=9&&key.length<=13&&distance(key,'goodeffort')<=1)return 'Loss';if(/\byou\s+win\b/i.test(text))return 'Win';if(/\bgood\s+effort\b|\byou\s+lose\b/i.test(text))return 'Loss';if(/\btie\b/i.test(text))return 'Tie';return null;}
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
function eligible(b){return b.included!==false&&b.reviewed&&b.leadConfirmed&&b.opponent.length===3&&b.opponent.every(p=>p.id)&&new Set(b.opponent.map(p=>p.dex||p.id)).size===3;}
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
function scaleBox(box,width,dy){const s=width/REF_W;return [Math.round(box[0]*s),Math.round((box[1]+dy)*s),Math.round(box[2]*s),Math.round((box[3]+dy)*s)];}
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
function calibrate(img,range=[-120,160]){const ok=[];for(let dy=range[0];dy<=range[1];dy+=2){const hud=readHud(img,dy);if(!hud)continue;const balls=[...hud.my.balls,...hud.opponent.balls];if(balls.filter(b=>b==='alive').length>=2&&balls.filter(b=>b!=='?').length>=5)ok.push(dy);}
 if(!ok.length)return null;const mid=ok[Math.floor(ok.length/2)],center=textCenter(img,125+mid-12,155+mid+12);if(center!==null){const dy=Math.round(center-140);if(readHud(img,dy))return dy;
  // Otherwise the readable offset nearest the text centre (the Poké Ball test is stricter at the edges).
  return ok.reduce((a,b)=>Math.abs(b-dy)<Math.abs(a-dy)?b:a);}return mid;}
// Middle-of-screen statistics for result detection. img covers the band only.
// whiteRun: tallest run of rows containing large white text, in reference (886-wide) pixels.
function bandStats(img){const s=img.width/REF_W;let white=0,black=0,n=0,run=0,tallest=0;for(let y=0;y<img.height;y++){let w=0,c=0;for(let x=0;x<img.width;x+=6){const i=(y*img.width+x)*4,lo=Math.min(img.data[i],img.data[i+1],img.data[i+2]),hi=Math.max(img.data[i],img.data[i+1],img.data[i+2]);c++;if(lo>215)w++;if(hi<28)black++;}n+=c;white+=w;run=w/c>.02?run+1:0;tallest=Math.max(tallest,run);}return {white:white/n,black:black/n,whiteRun:tallest/s};}
// YOU WIN / GOOD EFFORT letters are ~85–95 reference pixels tall; matchmaking text is ~25–30 and
// bright battle effects fill far taller bands. Only text in this range is worth an OCR read.
const resultCandidate=st=>st.white>=.01&&st.whiteRun>=70&&st.whiteRun<=115;
// The "Surrender and exit?" dialog is a white card filling the middle band; its dark text is read only then.
const surrenderCandidate=st=>st.white>=.5;
const isSurrender=text=>/surrend|won.?t receive any rewards/i.test(text);
// Nameplate text fingerprints: the same species renders identically, so one OCR per distinct image.
// An unreadable plate is retried on later frames (up to `retries` times) before it is cached as unreadable.
// Reuses one OCR result for near-identical fingerprints. Two fingerprints match when they differ in at most
// `limit` of all cells AND in at most 30% of their ink: with faint text the first test alone would let
// every name match every other. Fingerprints with almost no ink are never cached.
const MIN_INK=12,inkOf=b=>{let n=0;for(let i=0;i<b.length;i++)n+=b[i];return n;};
class NameCache{constructor(limit=.06,retries=3){this.entries=[];this.limit=limit;this.retries=retries;}
 find(bits){const ink=inkOf(bits);if(ink<MIN_INK)return null;for(const e of this.entries){let diff=0;for(let i=0;i<bits.length;i++)diff+=bits[i]!==e.bits[i];if(diff/bits.length<=this.limit&&diff<=.3*Math.max(ink,e.ink))return e;}return null;}
 get(bits){const e=this.find(bits);if(!e||(e.value===null&&e.misses<this.retries))return undefined;return e.value;}
 set(bits,value){const ink=inkOf(bits);if(ink<MIN_INK)return;const e=this.find(bits);if(e){e.value=value;e.misses=value===null?e.misses+1:0;return;}this.entries.push({bits,ink,value,misses:value===null?1:0});if(this.entries.length>400)this.entries.shift();}}

// Battle tracker driven by HUD state. Within one battle, fainted Poké Balls and used shields
// only ever increase, so a reset to a fresh HUD marks the next battle without needing results.
class HudTracker{
 constructor(){this.battles=[];this.current=null;this.lastHud=-Infinity;this.lastClosed=null;}
 static fresh(s){return s.fainted===0&&s.balls.every(b=>b==='alive')&&s.shields===2;}
 static used(s){return s.fainted+(2-s.shields);}
 open(t,midBattle){this.current={id:globalThis.crypto?.randomUUID?.()||String(Math.random()),start:t,end:t,my:[],opponent:[],events:[],result:'Unknown',resultSource:'',flags:midBattle?['Recording starts mid-battle: lead may be missing']:[],reviewed:false,leadConfirmed:false,used:0,fainted:{my:0,opponent:0},shieldsUsed:{my:0,opponent:0},active:{my:'',opponent:''},segments:[]};}
 static ballVerdict(b){const lost=['my','opponent'].filter(s=>b.fainted[s]===3);return lost.length===1?(lost[0]==='opponent'?'Win':'Loss'):null;}
 close(){const b=this.current;if(!b)return;this.current=null;const verdict=HudTracker.ballVerdict(b);
  if(b.result==='Unknown'&&verdict){b.result=verdict;b.resultSource='Poké Ball count';}
  if(b.my.length||b.opponent.length){this.battles.push(b);this.lastClosed=b;}}
 // hud: readHud() result with optional .hit per side ({...match(), confidence, raw}); null when no HUD.
 observe(t,hud){if(!hud)return;const fresh=HudTracker.fresh(hud.my)&&HudTracker.fresh(hud.opponent),used=HudTracker.used(hud.my)+HudTracker.used(hud.opponent);
  // A long HUD gap usually means the battle ended, but some recordings hide the nameplates for 30 s or
  // more mid-battle. Continue the same battle when nothing says it ended: no result, no fade to black,
  // no fresh HUD, and fainted counts that never go down (up to 3 minutes).
  const b0=this.current,gap=t-this.lastHud,resumes=b0&&gap>25&&gap<180&&b0.result==='Unknown'&&!b0.resultSearchOver&&b0.endCue===undefined&&!fresh&&hud.my.fainted>=b0.fainted.my&&hud.opponent.fainted>=b0.fainted.opponent;
  if(this.current&&((gap>25&&!resumes)||(fresh&&this.current.used>0)))this.close();
  if(!this.current){if(!fresh&&t-this.lastHud<25){this.lastHud=t;return;}this.open(t,!fresh);}
  const b=this.current;b.end=t;this.lastHud=t;b.used=Math.max(b.used,used);
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
 blackout(t){if(this.current&&t-this.lastHud<20)this.current.endCue=t;}
 // The player opened the forfeit dialog. It can be cancelled, so it only counts if the battle then
 // ends as a loss (or the HUD never returns and no result screen is read).
 surrender(t){const b=this.current&&t-this.lastHud<20?this.current:this.lastClosed&&t-this.lastClosed.end<20?this.lastClosed:null;if(b){b.surrender=t;b.events.push({t,kind:'surrender',label:'Surrender dialog'});}}
 // Matchmaking text means the previous result screen has already passed.
 matchmaking(){for(const b of [this.current,this.lastClosed])if(b)b.resultSearchOver=true;}
 awaitingResult(t){const b=this.current&&t-this.lastHud<45?this.current:this.lastClosed&&t-this.lastClosed.end<45?this.lastClosed:null;if(!b||b.resultSource==='result screen'||b.resultSearchOver)return false;
  return b!==this.current||b.endCue!==undefined||Math.max(b.fainted.my,b.fainted.opponent)>=2||t-this.lastHud>=8;}
 finish(){if(this.current){if(this.current.result==='Unknown'&&this.current.fainted.my<3&&this.current.fainted.opponent<3)this.current.flags.push('Recording ends before a result');this.close();}
  for(const b of this.battles){if(b.surrender!==undefined){if(b.result==='Unknown'&&b.end<=b.surrender+3){b.result='Loss';b.resultSource='surrender dialog';}if(b.result==='Loss')b.ending='you-forfeit';delete b.surrender;}
   if(b.result==='Win'&&b.fainted.opponent<3&&b.opponent.length<3){b.flags.push('Win before all opponent Pokémon fainted: opponent may have left; team incomplete');b.ending=b.ending||'opponent-forfeit';}
   for(const side of ['my','opponent'])for(const p of b[side])resolveForm(p);
   delete b.used;delete b.endCue;delete b.resultSearchOver;delete b.active;}
  return this.battles;}
}
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
// Banner crop: a 96×12 fingerprint of its white letters and their share (text when ~3–30%).
// The banner sits at a fixed share of the FULL screen height (30.2%, height 3.8%), unlike the
// nameplates, which hang from the top. With the top cut off (dy < 0, YouTube crops) the full height is
// the frame height minus dy, so the box is placed from that, not by shifting the phone layout.
function bannerBox(img,dy){const s=img.width/REF_W,full=img.height-dy*s,y0=Math.round(.302*full+dy*s);return [Math.round(71*s),y0,Math.round(815*s),y0+Math.round(.038*full)];}
function bannerRead(img,dy){const box=bannerBox(img,dy),[x0,y0,x1,y1]=box,sig=new Uint8Array(96*12),d=img.data;let n=0;
 for(let r=0;r<12;r++)for(let c=0;c<96;c++){const x=Math.floor(x0+(c+.5)*(x1-x0)/96),y=Math.floor(y0+(r+.5)*(y1-y0)/12);if(y<0||y>=img.height)continue;const i=(y*img.width+x)*4;if(Math.min(d[i],d[i+1],d[i+2])>200){sig[r*96+c]=1;n++;}}
 return {box,sig,textPixels:n/sig.length};}
// "Go, Marowak!" names the Pokémon being sent out at that moment (either side), even with the
// nameplates hidden: kept as a 'go' event for switch timing and leads.
HudTracker.prototype.go=function(t,text,dict){const b=this.current;if(!b)return false;const pb=parseBanner(text);if(pb?.kind!=='go')return false;const hit=match(pb.name,dict);if(!hit)return false;
 const last=b.events.filter(e=>e.kind==='go').at(-1);if(last&&last.actor===hit.key&&t-last.t<6)return true;b.events.push({t,kind:'go',actor:hit.key,label:text.trim()});return true;};
HudTracker.prototype.move=function(t,text,confidence,moves){const b=this.current;if(!b||confidence<40)return;const pb=parseBanner(text);if(pb?.kind!=='move')return;
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
const api={normalize,dictionary,match,outcome,Tracker,eligible,aggregate,trainingExport,usageEstimates,rankingPrior,HUD,hudBand,readHud,calibrate,NameCache,HudTracker,bandStats,bannerBox,bannerRead,parseBanner,resultCandidate,surrenderCandidate,isSurrender,readTypes,TYPE_COLORS,resolveForm};if(typeof module!=='undefined')module.exports=api;root.MetaExtractorCore=api;
})(typeof window==='undefined'?globalThis:window);
