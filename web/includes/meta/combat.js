// PvPoke combat math for the Meta Extractor: stats from CP, type effectiveness and fast-move damage.
// Used to infer an opponent's fast move and Shadow status from measured HP-bar hits.
(function(root){
'use strict';
// CP multipliers by half level (level 1 → index 0), from includes/calculate.js.
const CPM=[0.0939999967813491,0.135137430784308,0.166397869586944,0.192650914456886,0.215732470154762,0.236572655026622,0.255720049142837,0.273530381100769,0.29024988412857,0.306057381335773,0.321087598800659,0.335445032295077,0.349212676286697,0.36245774877879,0.375235587358474,0.387592411085168,0.399567276239395,0.41119354951725,0.422500014305114,0.432926413410414,0.443107545375824,0.453059953871985,0.46279838681221,0.472336077786704,0.481684952974319,0.490855810259008,0.499858438968658,0.508701756943992,0.517393946647644,0.525942508771329,0.534354329109191,0.542635762230353,0.550792694091796,0.558830599438087,0.566754519939422,0.574569148039264,0.582278907299041,0.589887911977272,0.59740000963211,0.604823657502073,0.61215728521347,0.61940411056605,0.626567125320434,0.633649181622743,0.640652954578399,0.647580963301656,0.654435634613037,0.661219263506722,0.667934000492096,0.674581899290818,0.681164920330047,0.687684905887771,0.694143652915954,0.700542893277978,0.706884205341339,0.713169102333341,0.719399094581604,0.725575616972598,0.731700003147125,0.734741011137376,0.737769484519958,0.740785574597326,0.743789434432983,0.746781208702482,0.749761044979095,0.752729105305821,0.75568550825119,0.758630366519684,0.761563837528228,0.764486065255226,0.767397165298461,0.77029727397159,0.77318650484085,0.776064945942412,0.778932750225067,0.781790064808426,0.784636974334716,0.787473583646825,0.790300011634826,0.792803950958807,0.795300006866455,0.79780392148697,0.800300002098083,0.802803892322847,0.805299997329711,0.807803863460723,0.81029999256134,0.812803834895026,0.815299987792968,0.817803806620319,0.820299983024597,0.822803778631297,0.825299978256225,0.827803750922782,0.830299973487854,0.832803753381377,0.835300028324127,0.837803755931569,0.840300023555755,0.842803729034748,0.845300018787384,0.847803702398935,0.850300014019012,0.852803676019539,0.85530000925064,0.857803649892077,0.860300004482269,0.862803624012168,0.865299999713897];
// Defensive type traits [weaknesses, resistances, immunities], generated from PvPoke's DamageCalculator.getTypeTraits.
const TRAITS={"normal":["fighting","","ghost"],"fighting":["flying psychic fairy","rock bug dark",""],"flying":["rock electric ice","fighting bug grass","ground"],"poison":["ground psychic","fighting poison bug fairy grass",""],"ground":["water grass ice","poison rock","electric"],"rock":["fighting ground steel water grass","normal flying poison fire",""],"bug":["flying rock fire","fighting ground grass",""],"ghost":["ghost dark","poison bug","normal fighting"],"steel":["fighting ground fire","normal flying rock bug steel grass psychic ice dragon fairy","poison"],"fire":["ground rock water","bug steel fire grass ice fairy",""],"water":["grass electric","steel fire water ice",""],"grass":["flying poison bug fire ice","ground water grass electric",""],"electric":["ground","flying steel electric",""],"psychic":["bug ghost dark","fighting psychic",""],"ice":["fighting fire steel rock","ice",""],"dragon":["dragon ice fairy","fire water grass electric",""],"dark":["fighting fairy bug","ghost dark","psychic"],"fairy":["poison steel","fighting bug dark","dragon"]};
const M={BONUS:1.2999999523162841796875,STAB:1.2000000476837158203125,SHADOW_ATK:1.2,SHADOW_DEF:0.83333331,SUPER:1.600000023841858,RESIST:0.625,DOUBLE:0.390625};
function effectiveness(moveType,types){let e=1;for(const t of types){const tr=TRAITS[t];if(!tr)continue;const has=i=>tr[i].split(' ').includes(moveType);if(has(0))e*=M.SUPER;else if(has(1))e*=M.RESIST;else if(has(2))e*=M.DOUBLE;}return e;}
const cpOf=(b,a,d,s,c)=>Math.max(10,Math.floor((b.atk+a)*Math.sqrt(b.def+d)*Math.sqrt(b.hp+s)*c*c/10));
// Every level/IV combination that produces exactly `cp` (levels 1–51). Cached per species and CP.
const comboCache=new Map();
function statCombos(pokemon,cp){const key=pokemon.speciesId+'@'+cp;if(comboCache.has(key))return comboCache.get(key);const b=pokemon.baseStats,out=[];
 for(let li=0;li<CPM.length;li++){const c=CPM[li];if(cpOf(b,15,15,15,c)<cp)continue;if(cpOf(b,0,0,0,c)>cp)break;
  for(let a=0;a<16;a++)for(let d=0;d<16;d++)for(let s=0;s<16;s++)if(cpOf(b,a,d,s,c)===cp)out.push({level:1+li/2,ivs:[a,d,s],atk:(b.atk+a)*c,def:(b.def+d)*c,hp:Math.max(10,Math.floor((b.hp+s)*c))});}
 comboCache.set(key,out);if(comboCache.size>200)comboCache.delete(comboCache.keys().next().value);return out;}
// Stats at PvPoke's default IVs for the league (used when CP is unknown).
function defaultStats(pokemon,league){const iv=pokemon.defaultIVs?.['cp'+league];if(!iv)return null;const c=CPM[Math.round((iv[0]-1)*2)],b=pokemon.baseStats;return {level:iv[0],ivs:iv.slice(1),atk:(b.atk+iv[1])*c,def:(b.def+iv[2])*c,hp:Math.max(10,Math.floor((b.hp+iv[3])*c))};}
// PvPoke fast-move damage (DamageCalculator.damage) with Shadow multipliers applied to the stats.
function damage(move,attackerTypes,attack,defenderTypes,defense){const stab=attackerTypes.includes(move.type)?M.STAB:1;return Math.floor(move.power*stab*(attack/defense)*effectiveness(move.type,defenderTypes)*0.5*M.BONUS)+1;}
const types=p=>p.types.filter(t=>t&&t!=='none');
const isShadow=p=>p.speciesId.endsWith('_shadow')||(p.tags||[]).includes('shadow');
const spread=(list,n)=>list.length<=n?list:Array.from({length:n},(_,i)=>list[Math.floor(i*(list.length-1)/(n-1))]);
// Range of one fast move's hit as a fraction of the defender's max HP, over every stat combination
// consistent with both CPs (PvPoke default IVs when a CP is unknown).
function hitRange(attacker,cpA,move,defender,cpD,league){const A=spread(cpA?statCombos(attacker,cpA):[defaultStats(attacker,league)].filter(Boolean),40),D=spread(cpD?statCombos(defender,cpD):[defaultStats(defender,league)].filter(Boolean),40);if(!A.length||!D.length)return null;
 const sa=isShadow(attacker)?M.SHADOW_ATK:1,sd=isShadow(defender)?M.SHADOW_DEF:1,ta=types(attacker),td=types(defender);let lo=Infinity,hi=0;
 for(const a of A)for(const d of D){const f=damage(move,ta,a.atk*sa,td,d.def*sd)/d.hp;if(f<lo)lo=f;if(f>hi)hi=f;}return [lo,hi];}
// Hits can't come faster than the move's duration; slower spacing means pauses or missed samples.
function cadenceScore(observed,turns){if(!observed||!observed.turns)return 0;const c=observed.turns;if(turns===c)return 0;if(turns>c)return observed.repeats>=2?-8:-4;return c%turns===0?-1:-2.5;}
// Prior over one Pokémon's fast moves from PvPoke rankings: the recommended move is favoured,
// the rest share the remainder by simulated usage. Unknown moves get a small floor.
// learned: {MOVE: count} of reviewer-confirmed fast moves for this species; the PvPoke prior counts
// as LEARN_WEIGHT observations, so confirmations steadily take over.
const LEARN_WEIGHT=4;
// Fast moves only: PvPoke's eliteMoves list mixes fast and charged moves (charged ones end up in
// chargedMoves too), so elite entries are kept only when they are not charged moves.
function movePrior(pokemon,ranking,learned){const charged=new Set(pokemon.chargedMoves||[]),fast=[...pokemon.fastMoves,...(pokemon.eliteMoves||[]).filter(m=>!pokemon.fastMoves.includes(m)&&!charged.has(m))];const uses=new Map((ranking?.moves?.fastMoves||[]).map(m=>[m.moveId,m.uses]));const rec=ranking?.moveset?.[0];const total=fast.reduce((s,m)=>s+(uses.get(m)||1),0);
 const base=new Map(fast.map(m=>[m,(m===rec?.5:0)+(rec?.5:1)*(uses.get(m)||1)/total]));if(!learned)return base;const n=fast.reduce((s,m)=>s+(learned[m]||0),0);if(!n)return base;
 return new Map(fast.map(m=>[m,(LEARN_WEIGHT*base.get(m)+(learned[m]||0))/(LEARN_WEIGHT+n)]));}
// Prior over a Pokémon's candidate forms: base forms share equally; within one, the Shadow variant gets
// the reviewer-confirmed Shadow rate across all answers ('*'), refined by that species' own answers.
// Prior over a Pokémon's possible forms (regional, Origin…) and Shadow. Forms are weighted by PvPoke's
// ranking score in this league (popular forms are far likelier; an unranked form scores 10 below the
// lowest ranked one) and by reviewer answers (learned.forms counts); Shadow uses learned rates.
function formPrior(candidates,learned,rankings){const base=id=>id.replace(/_shadow$/,''),bases=[...new Set(candidates.map(c=>base(c.speciesId)))],out=new Map();
 const score=b=>rankings?.get(b)?.score??rankings?.get(b+'_shadow')?.score,known=bases.map(score).filter(x=>x!=null),top=known.length?Math.max(...known):0,floor=known.length?Math.min(...known)-10:0;
 const w=new Map(bases.map(b=>[b,(known.length?Math.exp(((score(b)??floor)-top)/4):1)*((learned?.forms?.[b]||0)+1)])),total=[...w.values()].reduce((a,x)=>a+x,0);
 for(const c of candidates){const b=base(c.speciesId),both=candidates.some(x=>x.speciesId===b)&&candidates.some(x=>x.speciesId===b+'_shadow'),all=learned?.shadow?.['*'],rate=all?(all.yes+1)/(all.yes+all.no+2):.5,l=learned?.shadow?.[b],sh=l?(l.yes+2*rate)/(l.yes+l.no+2):rate;out.set(c.speciesId,(w.get(b)/total)*(both?(isShadow(c)?sh:1-sh):1));}return out;}
const combosFor=(p,cp,league,n)=>spread(cp?statCombos(p,cp):[defaultStats(p,league)].filter(Boolean),n);
// Jointly scores (opponent form/Shadow, opponent fast move, your form/Shadow, your fast move) against
// the hits seen on both bars. One stat combination per side must explain both directions (its attack
// sets the damage it deals, its defense and HP the damage it takes); the likelihood averages over the
// combinations consistent with each CP. side = {candidates:[pokemon], cp, prior?:Map(speciesId→p)};
// hitsOn* = {sizes:[hit fractions], turns, repeats} measured on that side's bar.
// Each hit is an inlier (Gaussian around the predicted damage) or, with probability `outlier`, a
// stray reading such as a charged attack that slipped through; a stray hit then costs a bounded
// amount instead of overwhelming every other matchup.
// sigma: fixed measurement noise (fraction of HP); relSigma: noise proportional to the hit size;
// scale: correction for systematic under-measurement of hits.
// Effectiveness text as evidence for the fast move's type: per fast-move hit the game shows "super
// effective", "not very effective" or nothing, by the move's type against the target's types. The text
// is occasionally wrong and often missed, so each class allows the other outcomes (3%), and the evidence is
// tempered by half because texts on one bar aren't independent. counts: {super, notVery, hits}.
// Tuned on the v23 benchmark (99 confirmed fast moves): the text is caught on about a quarter of the
// hits where it shows (it is brief and overlaps the bar animation), so a missing text says little.
const EW=.5,EH=.25,EF=.03;const EFFECT_P={super:{super:EH,notVery:EF,none:1-EH-EF},notVery:{super:EF,notVery:EH,none:1-EH-EF},neutral:{super:EF,notVery:EF,none:1-2*EF}};
function effectLogL(counts,move,targetTypes){if(!counts||!(counts.hits>0||counts.super||counts.notVery))return 0;const e=effectiveness(move.type,targetTypes),c=e>1.01?'super':e<.99?'notVery':'neutral',P=EFFECT_P[c],none=Math.max(0,(counts.hits||0)-(counts.super||0)-(counts.notVery||0));
 return EW*((counts.super||0)*Math.log(P.super)+(counts.notVery||0)*Math.log(P.notVery)+none*Math.log(P.none));}
// charged: {onMy:[{move,size}], onOpp:[{move,size}]}: unshielded charged attacks in this matchup whose
// move is known from its banner. Their damage depends on both sides' stats and Shadow status (not on
// the fast moves), and is large enough to measure with little rounding error.
function inferMatchup({opp,my,hitsOnMy,hitsOnOpp,charged,effects,moves,rankings,league=1500,sigma=.0065,relSigma=0,scale=.97,combos=36,learned,outlier=.08}){const moveById=new Map(moves.map(m=>[m.moveId,m]).filter(([,m])=>m.energy===0||m.energyGain>0)),allMoves=new Map(moves.map(m=>[m.moveId,m]));
 const cOnMy=(charged?.onMy||[]).map(c=>({...c,m:allMoves.get(c.move)})).filter(c=>c.m?.power),cOnOpp=(charged?.onOpp||[]).map(c=>({...c,m:allMoves.get(c.move)})).filter(c=>c.m?.power);const floor=outlier*(1/.4)*sigma*Math.sqrt(2*Math.PI);const rank=id=>rankings?.get(id);const out=[],lm=p=>learned?.moves?.[p.speciesId.replace(/_shadow$/,'')];
 opp={...opp,prior:opp.prior||formPrior(opp.candidates,learned,rankings)};my={...my,prior:my.prior||formPrior(my.candidates,learned,rankings)};
 for(const o of opp.candidates){const A=combosFor(o,opp.cp,league,combos);if(!A.length)continue;const so=isShadow(o),to=types(o);
  for(const m of my.candidates){const B=combosFor(m,my.cp,league,combos);if(!B.length)continue;const sm=isShadow(m),tm=types(m);
   for(const [om,omp] of movePrior(o,rank(o.speciesId),lm(o))){const omove=moveById.get(om);if(!omove)continue;
    for(const [mm,mmp] of movePrior(m,rank(m.speciesId),lm(m))){const mmove=moveById.get(mm);if(!mmove)continue;
     let like=0,lo1=Infinity,hi1=0,lo2=Infinity,hi2=0;
     for(const a of A)for(const b of B){const f1=damage(omove,to,a.atk*(so?M.SHADOW_ATK:1),tm,b.def*(sm?M.SHADOW_DEF:1))/b.hp,f2=damage(mmove,tm,b.atk*(sm?M.SHADOW_ATK:1),to,a.def*(so?M.SHADOW_DEF:1))/a.hp;
      lo1=Math.min(lo1,f1);hi1=Math.max(hi1,f1);lo2=Math.min(lo2,f2);hi2=Math.max(hi2,f2);let l=1;const g=(x,f)=>{f*=scale;const s2=sigma*sigma+(relSigma*f)**2;return (1-outlier)*Math.sqrt(sigma*sigma/s2)*Math.exp(-((x-f)**2)/(2*s2))+floor;};for(const x of hitsOnMy?.sizes||[])l*=g(x,f1);for(const x of hitsOnOpp?.sizes||[])l*=g(x,f2);
      for(const c of cOnMy)l*=g(c.size,damage(c.m,to,a.atk*(so?M.SHADOW_ATK:1),tm,b.def*(sm?M.SHADOW_DEF:1))/b.hp);for(const c of cOnOpp)l*=g(c.size,damage(c.m,tm,b.atk*(sm?M.SHADOW_ATK:1),to,a.def*(so?M.SHADOW_DEF:1))/a.hp);like+=l;}
     const evidence=Math.log(like/(A.length*B.length)+1e-300)+cadenceScore(hitsOnMy,omove.turns)+cadenceScore(hitsOnOpp,mmove.turns)+effectLogL(effects?.onMy,omove,tm)+effectLogL(effects?.onOpp,mmove,to),oppPrior=Math.log(opp.prior?.get(o.speciesId)??1/opp.candidates.length)+Math.log(omp),myPrior=Math.log(my.prior?.get(m.speciesId)??1/my.candidates.length)+Math.log(mmp);
     out.push({opp:o.speciesId,oppMove:om,my:m.speciesId,myMove:mm,evidence,oppPrior,myPrior,score:evidence+oppPrior+myPrior,predictedOnMy:[lo1,hi1],predictedOnOpp:[lo2,hi2]});}}}}
 if(!out.length)return null;const top=Math.max(...out.map(h=>h.score));let z=0;for(const h of out){h.p=Math.exp(h.score-top);z+=h.p;}for(const h of out)h.p/=z;out.sort((a,b)=>b.p-a.p);
 const marginal=key=>{const m=new Map();for(const h of out)m.set(h[key],(m.get(h[key])||0)+h.p);return [...m].sort((a,b)=>b[1]-a[1]).map(([value,p])=>({value,p}));};
 return {best:out[0],opp:marginal('opp'),oppMove:marginal('oppMove'),my:marginal('my'),myMove:marginal('myMove'),hypotheses:out.slice(0,12),all:out};}
const logsumexp=a=>{const m=Math.max(...a);return m+Math.log(a.reduce((s,x)=>s+Math.exp(x-m),0));};
// Combines several matchups that share one Pokémon on `side` ('opp' or 'my'): each matchup's evidence
// is marginalized over the other side's unknowns, summed across matchups, and the prior added once.
// Returns [{id, move, p}] over that Pokémon's (form/Shadow, fast move) and marginals.
function combineMatchups(results,side){const other=side==='opp'?'my':'opp',total=new Map();
 for(const r of results.filter(Boolean)){const per=new Map();for(const h of r.all){const k=h[side]+'|'+h[side+'Move'];if(!per.has(k))per.set(k,{prior:h[side+'Prior'],terms:[]});per.get(k).terms.push(h.evidence+h[other+'Prior']);}
  for(const [k,v] of per){const e=logsumexp(v.terms);const cur=total.get(k);total.set(k,{prior:v.prior,sum:(cur?.sum||0)+e,n:(cur?.n||0)+1});}}
 // Matchups share measurement errors (same stats, same bars), so pooled evidence is tempered by √n
 // rather than summed outright; otherwise many weak, correlated matchups look certain.
 const full=Math.max(...[...total.values()].map(v=>v.n)),rows=[...total].filter(([,v])=>v.n===full).map(([k,v])=>{const [id,move]=k.split('|');return {id,move,score:v.sum/Math.sqrt(v.n)+v.prior};});if(!rows.length)return null;
 const top=Math.max(...rows.map(r=>r.score));let z=0;for(const r of rows){r.p=Math.exp(r.score-top);z+=r.p;}for(const r of rows)r.p/=z;rows.sort((a,b)=>b.p-a.p);
 const marg=k=>{const m=new Map();for(const r of rows)m.set(r[k],(m.get(r[k])||0)+r.p);return [...m].sort((a,b)=>b[1]-a[1]).map(([value,p])=>({value,p}));};return {rows,form:marg('id'),move:marg('move'),matchups:full};}
// ---- Evidence from charged-move banners (whole battle) ----
// Energy accounting: all energy a Pokémon has spent on charged moves must have been earned by fast
// moves during its fighting time since it first entered (energy carries over through switches, and
// banking only makes the bound looser). checks: [{spent, fight}] (energy, seconds). A fast move earning
// e energy per d turns can earn at most e × (⌊(fight + slack) / (d × 0.5 s)⌋ + 1) in that time.
function energyFactor(move,checks){if(!move?.energyGain||!checks?.length)return 1;const d=(move.turns||1)*.5;
 for(const c of checks){const most=move.energyGain*(Math.floor((c.fight+2)/d)+1);if(c.spent>most)return .05;}return 1;}
// Movesets: a charged move the form can't learn rules the form out; Frustration means Shadow, Return
// means not Shadow; charged moves matching PvPoke's recommended set favour its fast move (×2).
function movesetFactor(p,fastId,seen,ranking){if(!seen?.length||!p)return 1;const shadow=/_shadow$/.test(p.speciesId);let f=1;
 for(const m of seen){if(m==='FRUSTRATION'){f*=shadow?1:.02;continue;}if(m==='RETURN'){f*=shadow?.05:1;continue;}if(!(p.chargedMoves||[]).includes(m)&&!(p.eliteMoves||[]).includes(m))return .02;}
 const rec=ranking?.moveset;if(rec&&rec[0]===fastId&&seen.every(m=>rec.includes(m)))f*=2;return f;}
// Per battle and Pokémon: charged moves seen (banners) and, at each, the energy spent so far and the
// seconds it has fought since entering. fightUntil(side, key, t) supplies the fighting time (frames with
// its HP bar visible while on the field), from whatever frames the caller sampled.
function battleEvidence(b,movesById,fightUntil){const out={my:{},opponent:{}},evs=(b.events||[]).filter(e=>e.kind==='move'&&(e.side==='my'||e.side==='opponent')).sort((x,y)=>x.t-y.t);
 for(const side of ['my','opponent'])for(const p of b[side]||[]){const mine=evs.filter(e=>e.side===side&&e.actor===p.key);if(!mine.length)continue;let spent=0;const energy=[];
  for(const e of mine){spent+=movesById.get(e.move)?.energy||0;energy.push({t:e.t,spent,fight:+fightUntil(side,p.key,e.t).toFixed(1)});}out[side][p.key]={energy,charged:[...new Set(mine.map(e=>e.move))]};}return out;}
// Applies both to one side's matchup fits for a Pokémon (mutates the priors, which are counted once).
function applyBattleEvidence(results,side,info,byId,rankings,movesById){if(!info)return;const s=side==='opponent'?'opp':'my';
 for(const r of results)for(const h of r?.all||[]){const p=byId.get(h[s]),f=energyFactor(movesById.get(h[s+'Move']),info.energy)*movesetFactor(p,h[s+'Move'],info.charged,rankings?.get(h[s]));if(f!==1)h[s+'Prior']+=Math.log(f);}}
// Summarizes hits on one bar for inferMatchup: median size, count and cadence.
function summarizeHits(list,cadence){if(!list||list.length<2)return null;return {sizes:list.map(h=>h.size),turns:cadence?.turns??null,repeats:cadence?.repeats??0};}
// Attaches the combined fit to every Pokémon in a battle. b.matchups: [{my, opponent, result}] where
// result is inferMatchup's output. Sets member.inference = {allRows, rows, forms, moves, shadowP, matchups}.
// pooled: optional Map(key → [results]) for your own Pokémon, which are the same individuals in every
// battle of a session, so their evidence is combined across battles.
function attachInference(b,pooled){for(const side of ['opponent','my'])for(const p of b[side]||[]){const rs=side==='my'&&pooled?.has(p.key)?pooled.get(p.key):(b.matchups||[]).filter(g=>g[side]===p.key).map(g=>g.result);const c=combineMatchups(rs,side==='opponent'?'opp':'my');if(!c)continue;
 const forms=new Map();let shadowP=0;for(const r of c.rows){const f=r.id.replace(/_shadow$/,'');forms.set(f,(forms.get(f)||0)+r.p);if(/_shadow$/.test(r.id))shadowP+=r.p;}
 p.inference={allRows:c.rows,rows:c.rows,forms:[...forms].sort((x,y)=>y[1]-x[1]).map(([value,q])=>({value,p:q})),moves:c.move,shadowP,matchups:c.matchups};}}
// Forms the type icons can't separate (identical types, e.g. Morpeko's Full Belly / Hangry modes):
// when exactly one of them appears in PvPoke's league rankings, that is the form in use.
function narrowByRankings(member,rankings){const base=id=>id.replace(/_shadow$/,''),c=member.candidates||[],forms=[...new Set(c.map(x=>base(x.id)))].filter(f=>!/_(mega|primal)$/.test(f));if(forms.length<2||!rankings)return;
 const key=f=>[...(c.find(x=>base(x.id)===f)?.types||[])].filter(t=>t&&t!=='none').sort().join('/');if(new Set(forms.map(key)).size!==1)return;
 const ranked=forms.filter(f=>rankings.has(f)||rankings.has(f+'_shadow'));if(ranked.length!==1)return;member.candidates=c.filter(x=>base(x.id)===ranked[0]);member.formNote=`Only ${ranked[0]} is ranked in this league; its other forms look identical`;}
// Groups your Pokémon's matchup results across all battles (same key = same Pokémon).
function poolMine(battles){const m=new Map();for(const b of battles)for(const g of b.matchups||[])if(g.result){if(!m.has(g.my))m.set(g.my,[]);m.get(g.my).push(g.result);}return m;}
const api={effectLogL,battleEvidence,energyFactor,movesetFactor,applyBattleEvidence,CPM,TRAITS,MULT:M,effectiveness,statCombos,defaultStats,damage,types,isShadow,hitRange,inferMatchup,combineMatchups,summarizeHits,movePrior,formPrior,attachInference,poolMine,narrowByRankings};
if(typeof module!=='undefined')module.exports=api;root.MetaCombat=api;
})(typeof window==='undefined'?globalThis:window);
