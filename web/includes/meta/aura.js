// Visual Shadow cues for the Meta Extractor. Shadow Pokémon carry dark purple flames and glowing red
// eyes. Each side's Pokémon stands just below its HP bar, so each region is placed relative to that
// bar: the opponent's is a box under its bar; yours is the larger foreground area under yours. Each
// frame gives the share of aura-purple pixels and of bright-red "eye" pixels in each region; a matchup
// is summarized by medians so one-off attack effects (Shadow Ball, Psychic) don't dominate.
(function(root){
'use strict';
const REF_W=886;
function hsv(r,g,b){const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return [h,mx?d/mx:0,mx/255];}
// Region boxes in frame pixels from a bar ({x0,y0,x1,y1}); s = width / 886.
function regions(bars,width){const s=width/REF_W,out={};
 if(bars.opponent){const b=bars.opponent;out.opponent=[Math.max(0,b.x0-30*s),b.y1+8*s,Math.min(width,b.x1+30*s),b.y1+230*s];}
 if(bars.my){const b=bars.my;out.my=[0,b.y1+10*s,Math.min(width,520*s),b.y1+450*s];}
 return out;}
// img: {data, width, height}; yOffset: frame y of row 0. Returns {opponent:{purple,red}, my:{...}}.
function measure(img,bars,yOffset=0){const out={};for(const [side,box] of Object.entries(regions(bars,img.width)))out[side]=measureBox(img,box,yOffset);return out;}
function measureBox(img,box,yOffset=0){const [x0,y0,x1,y1]=box.map(Math.round);let n=0,purple=0,red=0;
  for(let y=Math.max(0,y0-yOffset);y<Math.min(img.height,y1-yOffset);y+=2)for(let x=Math.max(0,x0);x<Math.min(img.width,x1);x+=2){const i=(y*img.width+x)*4,[h,sa,v]=hsv(img.data[i],img.data[i+1],img.data[i+2]);n++;
   if(h>=262&&h<=305&&sa>=.38&&v>=.22&&v<=.85)purple++;                     // dark violet flames
   else if((h<=12||h>=348)&&sa>=.65&&v>=.7)red++;}                           // glowing red eyes
  return n?{purple:purple/n,red:red/n}:null;}
// Focus shots. During a charged attack the camera frames one Pokémon at a time: the attacker as it
// launches the move (from the "X used Y!" banner, ~1–1.5 s), then the defender as it is hit (~2 s).
// That Pokémon fills the view with its HP bar centred above it, and the other side's Pokémon (and its
// Shadow flames) is out of frame. A frame is a focus candidate when a bar is centred and your usual
// bar (left edge) is absent; the box below the bar is measured like the aura. focusMoments() later
// drops candidates at the opponent's usual bar height and assigns each shot to a Pokémon.
function focusBar(bars,width){const s=width/REF_W;if(!bars?.length||bars.some(b=>b.x0>=30*s&&b.x0<=80*s))return null;
 return bars.filter(b=>Math.abs((b.x0+b.x1)/2-width/2)<=30*s).sort((a,b)=>(b.y1-b.y0)-(a.y1-a.y0))[0]||null;}
function focusRegion(bar,width){const s=width/REF_W;return [Math.max(0,bar.x0-170*s),bar.y1+10*s,Math.min(width,bar.x1+170*s),Math.min(bar.y1+480*s,1450*s)];}// 1450: bottom of the band both readers scan (MetaHp.BAND)
// img/bars/yOffset as for measure(). Returns {y0, fill, trail, purple, red} or null (y0 in 886-wide units).
function measureFocus(img,bars,yOffset=0){const bar=focusBar(bars,img.width);if(!bar)return null;const m=measureBox(img,focusRegion(bar,img.width),yOffset);if(!m)return null;const s=img.width/REF_W;
 return {y0:Math.round(bar.y0/s),fill:+bar.fill.toFixed(3),trail:+(bar.trail||0).toFixed(3),purple:+m.purple.toFixed(5),red:+m.red.toFixed(5)};}
// Assigns focus shots to Pokémon. b: battle with events/segments; frames: [{t, bars, focus}] (dense
// frames over the battle; bars as from MetaHp.findBars). A candidate counts when its bar sits ≥ 100
// units below the opponent's usual bar; candidates form shots (gaps ≤ 0.35 s, steady bar height, ≥ 2
// frames). With a move banner ("X used Y!"): the attacker's shot starts with it (≤ ROLE_SPLIT s after
// it is read), and the first later shot within DEF_BY s is the defender being hit (after a ~1 s cut);
// later shots (Gulp Missile, faints) are ignored. Shots no banner explains (banner OCR often fails on
// small uploads) are assigned by HP: the centred bar's fill (or fill + damage trail) must match one
// side's fill just before (normal view, 0.5–6 s earlier) and clearly not the other's; role 'unknown'.
// A shielded defender sits behind a pink bubble that reads as aura-purple, so those shots are flagged
// (shadow-model.js skips them). Returns [{t, move, side, key, role, shielded, n, purple, red, purpleMax}].
const ROLE_SPLIT=.5,DEF_BY=3.5;
function focusMoments(b,frames,width=REF_W){const s=width/REF_W,ev=b.events||[];if(!frames?.length)return [];
 const normal=f=>{const my=f.bars?.find(x=>x.x0>=30*s&&x.x0<=80*s),op=f.bars?.filter(x=>x.x0>=230*s&&x.x0<=600*s).sort((a,c)=>(c.y1-c.y0)-(a.y1-a.y0))[0];return my&&op?{my,op}:null;};
 const ys=[];for(const f of frames){const n=normal(f);if(n)ys.push(n.op.y0/s);}if(ys.length<5)return [];const oppY=median(ys);
 const other=x=>x==='my'?'opponent':'my',onField=(side,t)=>{const g=(b.segments||[]).find(g=>t>=g.start-1&&t<=g.end+1);if(g)return g[side];let k=null;for(const g of b.segments||[])if(g.start<=t)k=g[side];return k;};
 const fs=frames.filter(f=>f.focus&&f.focus.y0>=oppY+100).sort((x,y)=>x.t-y.t),shots=[];
 for(const f of fs){const last=shots.at(-1),prev=last?.at(-1);if(prev&&f.t-prev.t<=.35&&Math.abs(f.focus.y0-prev.focus.y0)<=60)last.push(f);else shots.push([f]);}
 const usable=shots.filter(x=>x.length>=2),used=new Set(),out=[];
 const push=(l,side,key,role,t,move,shielded)=>{if(!key)return;const v=l.map(f=>f.focus);out.push({t:+t.toFixed(1),move:move||null,side,key,role,shielded:!!shielded,n:v.length,purple:+median(v.map(x=>x.purple)).toFixed(5),red:+median(v.map(x=>x.red)).toFixed(5),purpleMax:+Math.max(...v.map(x=>x.purple)).toFixed(5)});};
 const shieldNear=(side,a,z)=>ev.some(x=>x.kind==='shield'&&x.side===side&&x.t>=a&&x.t<=z);
 for(const e of ev.filter(e=>e.kind==='move'&&e.actor&&(e.side==='my'||e.side==='opponent')).sort((x,y)=>x.t-y.t)){
  const att=usable.filter(x=>!used.has(x)&&x[0].t>=e.t-1&&x[0].t-e.t<=ROLE_SPLIT),def=usable.find(x=>!used.has(x)&&x[0].t-e.t>ROLE_SPLIT&&x[0].t-e.t<=DEF_BY);
  if(att.length){att.forEach(x=>used.add(x));push(att.flat(),e.side,e.actor,'attacker',e.t,e.move,false);}
  if(def){used.add(def);const side=other(e.side);push(def,side,onField(side,e.t),'defender',e.t,e.move,shieldNear(side,e.t-.5,e.t+4));}}
 for(const x of usable){if(used.has(x))continue;const t=x[0].t,P={my:[],opponent:[]};for(const f of frames){if(f.t<t-6||f.t>t-.5)continue;const n=normal(f);if(n){P.my.push(n.my.fill);P.opponent.push(n.op.fill);}}
  const pm=median(P.my),po=median(P.opponent);if(pm==null||po==null||Math.abs(pm-po)<.12)continue;const fill=median(x.map(f=>f.focus.fill)),trail=median(x.map(f=>f.focus.trail||0));
  const d=p=>Math.min(Math.abs(fill-p),Math.abs(fill+trail-p)),dm=d(pm),dop=d(po),side=dm<.06&&dop>.1?'my':dop<.06&&dm>.1?'opponent':null;if(!side)continue;
  push(x,side,onField(side,t),'unknown',t,null,shieldNear(side,t-2,x.at(-1).t+2));}
 return out.sort((p,q)=>p.t-q.t);}
const median=a=>{const s=a.filter(x=>x!=null).sort((p,q)=>p-q);return s.length?s[s.length>>1]:null;};
// frames: [{opponent:{purple,red}, my:{...}}] for one matchup → medians per side.
function summarize(frames){const out={};for(const side of ['opponent','my']){const f=frames.map(x=>x[side]).filter(Boolean);if(f.length<3){out[side]=null;continue;}out[side]={purple:median(f.map(x=>x.purple)),red:median(f.map(x=>x.red)),n:f.length};}return out;}
// Likelihood ratio Shadow : regular from an opponent's aura-purple share, fitted by band on confirmed
// answers. Matchups where your own Pokémon is a Shadow are skipped: its flames reach the opponent's area.
// table: [{max, shadow, regular}] counts per band (from fitBands); returns null when unusable.
const BANDS=[.001,Infinity];
function fitBands(edges,rows){if(Array.isArray(edges)&&!rows){rows=edges;edges=undefined;}const t=(edges||BANDS).map(max=>({max,shadow:0,regular:0}));for(const r of rows){const b=t.find(b=>r.purple<b.max);b[r.shadow?'shadow':'regular']++;}return t;}
function likelihoodRatio(purple,table){if(purple==null||!table)return 1;const S=table.reduce((s,b)=>s+b.shadow,0),R=table.reduce((s,b)=>s+b.regular,0),b=table.find(b=>purple<b.max);return ((b.shadow+.5)/(S+.5*table.length))/((b.regular+.5)/(R+.5*table.length));}
// Fitted on reviewer answers: 92 matchups of confirmed opponents with your Pokémon regular (41 from
// phone recordings, 51 from YouTube uploads, day and night arenas). Leave-one-out over all 195 answers,
// adding it to damage + learned priors raised Shadow calls from 46 to 52 of 62. A third band (0.2–2%)
// did not help (50 of 62).
const DEFAULT_BANDS=[{max:.001,shadow:10,regular:52},{max:Infinity,shadow:22,regular:8}];
// Folds the visual cue into each opponent's Shadow estimate (after MetaCombat.attachInference): the
// per-matchup likelihood ratios are combined (tempered by √n, like the damage evidence) and applied to
// the Shadow forms. Matchups where your Pokémon is probably a Shadow are left out.
// Species whose own body reads as aura-purple (confirmed not Shadow while purple was seen): the cue is
// ignored for them. Seeded from the benchmark answers; extended by learned.purpleBodied.
const PURPLE_BODIED=['drapion'];
function applyToBattle(b,table=DEFAULT_BANDS,learned){for(const p of b.opponent||[]){const inf=p.inference;if(!inf?.allRows)continue;
  const species=(inf.forms?.[0]?.value||'').replace(/_shadow$/,'');if(PURPLE_BODIED.includes(species)||learned?.purpleBodied?.[species])continue;
  const used=(b.matchups||[]).filter(g=>g.opponent===p.key&&g.auraOpponent&&!((b.my||[]).find(m=>m.key===g.my)?.inference?.shadowP>.5)).map(g=>g.auraOpponent.purple);
  if(!used.length||!inf.allRows.some(r=>/_shadow$/.test(r.id)))continue;
  const lr=Math.exp(used.reduce((s,x)=>s+Math.log(likelihoodRatio(x,table)),0)/Math.sqrt(used.length));
  let z=0;const rows=inf.allRows.map(r=>{const q=r.p*(/_shadow$/.test(r.id)?lr:1);z+=q;return {...r,p:q};}).map(r=>({...r,p:r.p/z}));
  const forms=new Map(),moves=new Map();let shadowP=0;for(const r of rows){const f=r.id.replace(/_shadow$/,'');forms.set(f,(forms.get(f)||0)+r.p);moves.set(r.move,(moves.get(r.move)||0)+r.p);if(/_shadow$/.test(r.id))shadowP+=r.p;}
  Object.assign(inf,{allRows:rows,rows,shadowP,forms:[...forms].sort((x,y)=>y[1]-x[1]).map(([value,q])=>({value,p:q})),moves:[...moves].sort((x,y)=>y[1]-x[1]).map(([value,q])=>({value,p:q})),visual:{purple:median(used),matchups:used.length,lr}});}}
const api={measure,measureBox,measureFocus,focusBar,focusRegion,focusMoments,ROLE_SPLIT,DEF_BY,summarize,regions,BANDS,fitBands,likelihoodRatio,DEFAULT_BANDS,PURPLE_BODIED,applyToBattle};if(typeof module!=='undefined')module.exports=api;root.MetaAura=api;
})(typeof window==='undefined'?globalThis:window);
