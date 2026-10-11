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
function measure(img,bars,yOffset=0){const out={};for(const [side,box] of Object.entries(regions(bars,img.width))){const [x0,y0,x1,y1]=box.map(Math.round);let n=0,purple=0,red=0;
  for(let y=Math.max(0,y0-yOffset);y<Math.min(img.height,y1-yOffset);y+=2)for(let x=Math.max(0,x0);x<Math.min(img.width,x1);x+=2){const i=(y*img.width+x)*4,[h,sa,v]=hsv(img.data[i],img.data[i+1],img.data[i+2]);n++;
   if(h>=262&&h<=305&&sa>=.38&&v>=.22&&v<=.85)purple++;                     // dark violet flames
   else if((h<=12||h>=348)&&sa>=.65&&v>=.7)red++;}                           // glowing red eyes
  out[side]=n?{purple:purple/n,red:red/n}:null;}return out;}
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
const api={measure,summarize,regions,BANDS,fitBands,likelihoodRatio,DEFAULT_BANDS,PURPLE_BODIED,applyToBattle};if(typeof module!=='undefined')module.exports=api;root.MetaAura=api;
})(typeof window==='undefined'?globalThis:window);
