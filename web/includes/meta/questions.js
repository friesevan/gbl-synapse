// Review questions for the Meta Extractor: turns the uncertain parts of an analysis into short,
// answerable questions with the video evidence to look at, and applies the answers.
// Pure logic (no DOM) so it runs in the page and in Node tests.
(function(root){
'use strict';
const base=id=>id.replace(/_shadow$/,'');
// Mega and Primal forms only count when the nameplate says so.
const realForms=m=>[...new Set((m.candidates||[]).filter(c=>/mega|primal/i.test(m.label||'')||!/_(mega|primal)/.test(c.id)).map(c=>base(c.id)))];
const isShadowId=id=>/_shadow$/.test(id);
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
// Shadow eligibility. PvPoke's gamemaster lists `<id>_shadow` only for species/forms with a released
// Shadow, so "this form id has a _shadow entry" is the rule (Origin Forme Palkia/Dialga, every Mega and
// many regional forms have none). The form counts as settled when the reviewer answered it, when the
// top form has p >= .98, or when only one real form remains; otherwise Shadow is possible if ANY real
// candidate form has a Shadow entry. opts.hasShadow(id) → true | false | undefined (id unknown to the
// gamemaster: fall back to the member's own candidates); opts.form overrides the settled form.
// Returns {form, eligible}; eligible null when no form is known at all.
function shadowEligibility(m,opts={}){const own=id=>(m.candidates||[]).some(c=>c.id===id+'_shadow'),has=id=>{const v=opts.hasShadow?opts.hasShadow(id):undefined;return v===undefined?own(id):!!v;};
 const forms=realForms(m),top=m.inference?.forms?.[0];let form=opts.form||m.answers?.form;form=form?base(form):null;
 if(!form&&top&&top.value&&(top.p||0)>=.98)form=base(top.value);if(!form&&forms.length===1)form=forms[0];
 if(form)return {form,eligible:has(form)};if(!forms.length)return {form:null,eligible:null};return {form:null,eligible:forms.some(has)};}
// Gamemaster-backed lookup for shadowEligibility: byId is a Map(speciesId → entry).
const hasShadowIn=byId=>byId&&byId.size?id=>byId.has(id)?byId.has(id+'_shadow'):undefined:undefined;
// English species name from a species id, for display. Used when the gamemaster isn't at hand (the
// Validate view re-wording stored questions); `byId` is preferred.
const NAME_EXCEPTIONS={ho_oh:'Ho-Oh',porygon_z:'Porygon-Z',jangmo_o:'Jangmo-o',hakamo_o:'Hakamo-o',kommo_o:'Kommo-o',mr_mime:'Mr. Mime',mr_rime:'Mr. Rime',mime_jr:'Mime Jr.',farfetchd:'Farfetch’d',sirfetchd:'Sirfetch’d',type_null:'Type: Null',nidoran_female:'Nidoran♀',nidoran_male:'Nidoran♂'};
const FORM_WORDS={mega:'Mega',primal:'Primal',origin:'Origin',alolan:'Alolan',galarian:'Galarian',hisuian:'Hisuian',paldean:'Paldean',altered:'Altered',incarnate:'Incarnate',therian:'Therian',zen:'Zen',standard:'Standard',sunny:'Sunny',rainy:'Rainy',snowy:'Snowy',attack:'Attack',defense:'Defense',speed:'Speed',crowned:'Crowned',eternamax:'Eternamax',ultimate:'Ultimate',apex:'Apex',unbound:'Unbound',confined:'Confined'};
function speciesLabel(id,byId){id=base(String(id||''));if(!id)return '';const e=byId?.get?.(id);if(e?.speciesName)return String(e.speciesName).replace(/ \(Shadow\)$/,'');
 for(const k of Object.keys(NAME_EXCEPTIONS))if(id===k)return NAME_EXCEPTIONS[k];
 const t=id.split('_');let tail=[];if(/^(x|y)$/.test(t[t.length-1])&&t[t.length-2]==='mega')tail=t.splice(-2);else if(t.length>1&&FORM_WORDS[t[t.length-1]])tail=t.splice(-1);
 const head=NAME_EXCEPTIONS[t.join('_')]||t.map(cap).join(' '),form=tail.map(w=>FORM_WORDS[w]||w.toUpperCase()).join(' ');return form?`${head} (${form})`:head;}
// member.inference.rows: [{id, move, p}] joint posterior over (form incl. Shadow, fast move).
function marginals(rows){const by=k=>{const m=new Map();for(const r of rows)m.set(r[k],(m.get(r[k])||0)+r.p);return [...m].sort((a,b)=>b[1]-a[1]).map(([value,p])=>({value,p}));};
 const shadow=rows.reduce((s,r)=>s+(isShadowId(r.id)?r.p:0),0),forms=new Map();for(const r of rows)forms.set(base(r.id),(forms.get(base(r.id))||0)+r.p);
 return {forms:[...forms].sort((a,b)=>b[1]-a[1]).map(([value,p])=>({value,p})),moves:by('move'),shadowP:shadow};}
// Restricts the joint posterior to what the reviewer confirmed and renormalizes.
function condition(member){const inf=member.inference;if(!inf?.allRows)return;const a=member.answers||{},noShadow=a.shadow===undefined&&shadowEligibility(member).eligible===false;
 let rows=inf.allRows.filter(r=>(!a.form||base(r.id)===a.form)&&(a.shadow===undefined?!noShadow||!isShadowId(r.id):isShadowId(r.id)===a.shadow)&&(!a.fastMove||r.move===a.fastMove));
 if(!rows.length)rows=inf.allRows.map(r=>({...r}));const z=rows.reduce((s,r)=>s+r.p,0);inf.rows=rows.map(r=>({...r,p:r.p/z}));Object.assign(inf,marginals(inf.rows));}
const pct=x=>`${Math.round(x*100)}%`;
// A forfeit (the Forfeit button, or leaving/closing the battle) still counts as a win or loss; how the
// battle ended is kept separately. Values are "<result>" or "<result>:<ending>".
const RESULT_OPTIONS=[{value:'Win',label:'You won'},{value:'Win:opponent-forfeit',label:'Opponent forfeited',hint:'They tapped Forfeit or left the battle',parent:'Win'},{value:'Loss',label:'You lost'},{value:'Loss:you-forfeit',label:'You forfeited',hint:'Forfeit button, or you left / closed the battle',parent:'Loss'},{value:'Tie',label:'Tie'}];
const ENDINGS={'opponent-forfeit':'Opponent forfeited','you-forfeit':'You forfeited'};
// thresholds: ask when the leading answer is below `confident` probability.
// The name shown in a question: the settled species in English from the gamemaster (e.g. "Qwilfish",
// "Palkia (Origin)"), else the top candidate's English name, and only then the nameplate text as read
// (it may be misspelt or in another language). `species` drops the form (for "which form?").
function displayName(m,byId,species){const id=m.answers?.form||m.inference?.forms?.[0]?.value||m.formId||base(m.candidates?.[0]?.id||''),cand=(m.candidates||[]).find(c=>base(c.id)===base(id))||m.candidates?.[0];
 const n=(id&&byId?.get?.(base(id))?.speciesName&&speciesLabel(id,byId))||(cand?.name&&String(cand.name).replace(/ \(Shadow\)$/,''))||(id&&speciesLabel(id,byId))||(cand&&speciesLabel(cand.id,byId));
 if(!n)return m.label?`Pokémon (nameplate read: “${m.label}”)`:'Pokémon';return species?n.replace(/ \([^)]*\)$/,''):n;}
function questions(battles,{pokemon,moves,confident=.85,shadowBand=[.15,.85]}={}){const byId=new Map((pokemon||[]).map(p=>[p.speciesId,p])),moveName=id=>(moves||[]).find(m=>m.moveId===id)?.name||id,out=[];
 battles.forEach((b,bi)=>{const label=`Battle ${bi+1}`;
  for(const side of ['opponent','my'])for(const m of b[side]||[]){const who=side==='opponent'?'Opponent’s':'Your',a=m.answers||{},inf=m.inference,name=displayName(m,byId),formName=displayName(m,byId,true);
   const seg=(b.matchups||[]).filter(g=>g[side]===m.key).sort((x,y)=>(y.end-y.start)-(x.end-x.start))[0],clip=seg?[seg.start,Math.min(seg.end,seg.start+12)]:[m.first,m.first+8];
   const frames=seg?[.2,.5,.8].map(f=>seg.start+(seg.end-seg.start)*f):[m.first+1,m.first+3,m.first+5];
   // Form: several regional forms still possible (type icons unreadable or ambiguous).
   const forms=realForms(m);
   if(forms.length>1&&!a.form){const ranked=inf?.forms?.length?inf.forms:forms.map(value=>({value,p:1/forms.length}));if((ranked[0]?.p||0)<confident)out.push({id:`${bi}:${side}:${m.key}:form`,battle:bi,side,key:m.key,kind:'form',title:`${label} · ${who} ${formName}: which form?`,
    detail:!m.observedTypes?'The type icons above the nameplate weren’t readable. Check them in the frames.':forms.some(id=>{const t=(byId.get(id)?.types||[]).filter(x=>x!=='none').sort().join('/');return t===[...m.observedTypes].sort().join('/');})?`Type icons read as ${m.observedTypes.map(cap).join(' / ')}, which doesn’t settle it.`:`Type icons read as ${m.observedTypes.map(cap).join(' / ')}, which fits none of its forms (probably read during a switch). Check the icons in the frames.`,focus:'icons',frames:[m.first+1.5,m.first+3,m.first+5],clip:[m.first,m.first+6],
    options:forms.map(id=>({value:id,label:byId.get(id)?.speciesName||id,hint:(byId.get(id)?.types||[]).filter(t=>t!=='none').map(cap).join(' / ')}))});}
   // Shadow: only for Shadow-eligible species, when the damage evidence is in between.
   const shadowable=shadowEligibility(m,{hasShadow:hasShadowIn(byId)}).eligible===true;
   if(shadowable&&a.shadow===undefined){const p=inf?.shadowP;if(p===undefined||(p>shadowBand[0]&&p<shadowBand[1]))out.push({id:`${bi}:${side}:${m.key}:shadow`,battle:bi,side,key:m.key,kind:'shadow',title:`${label} · Is ${side==='opponent'?'the opponent’s':'your'} ${name} a Shadow Pokémon?`,
    detail:p===undefined?'There wasn’t a clear stretch of fast moves to measure. Look for dark purple flames around the Pokémon, especially as it enters.':`Damage and the purple aura check put it at ${pct(p)} Shadow${inf?.visual?` (aura ${inf.visual.purple>=.001?'seen':'not seen'} in ${inf.visual.matchups} matchup${inf.visual.matchups===1?'':'s'})`:''}. Shadow Pokémon have dark purple flames around them (not the purple ground shadow every Pokémon casts).`,
    focus:side,frames,clip,options:[{value:true,label:'Yes, Shadow'},{value:false,label:'No, not Shadow'}]});}
   // Fast move: the measured damage and rhythm fit more than one move.
   if(!a.fastMove&&inf?.moves?.length>1&&inf.moves[0].p<confident){const evidence=seg?(side==='opponent'?seg.hitsOnMy:seg.hitsOnOpp):null;
    out.push({id:`${bi}:${side}:${m.key}:fast`,battle:bi,side,key:m.key,kind:'fastMove',title:`${label} · ${who} ${name}: which fast move?`,
     detail:`Measured ${evidence?.length?`${evidence.length} hit${evidence.length===1?'':'s'} of about ${pct(evidence.slice().sort((x,y)=>x-y)[evidence.length>>1])} HP`:'few hits'}${seg?.[side==='opponent'?'cadenceOnMy':'cadenceOnOpp']?`, every ${seg[side==='opponent'?'cadenceOnMy':'cadenceOnOpp']} turns`:''}. Watch the clip: the move’s animation and timing usually tell them apart.`,
     focus:side,frames,clip,options:inf.moves.slice(0,4).map(x=>({value:x.value,label:moveName(x.value),hint:`model ${pct(x.p)}`}))});}}
  // Result: no result screen read and the timeline doesn't decide (core.js inferResult). Not asked when the footage
  // can't show a result screen (resultSource 'unresolvable': the video cuts to the next battle or ends).
  if(b.result==='Unknown'&&b.resultSource!=='unresolvable'&&!b.answers?.result)out.push({id:`${bi}:result`,battle:bi,kind:'result',title:`${label}: who won?`,detail:'No result screen was read and the timeline doesn’t decide: neither side lost all three Pokémon on the Poké Ball counter or HP bars. Check the frames after the battle.',focus:'center',frames:[b.end+4,b.end+8,b.end+12],clip:[b.end-2,b.end+14],
   options:RESULT_OPTIONS});});
 // Species and the model's leading answer travel with each question, so answers can train priors
 // and measure accuracy later.
 for(const q of out){if(!q.side)continue;const m=battles[q.battle][q.side].find(p=>p.key===q.key),inf=m.inference;
  q.species=m.answers?.form||inf?.forms?.[0]?.value||m.formId||base(m.candidates?.[0]?.id||'');q.speciesName=displayName(m,byId,q.kind==='form');
  if(q.kind==='shadow'&&inf){q.modelTop=inf.shadowP>=.5;q.modelP=Math.max(inf.shadowP,1-inf.shadowP);if(inf.visual)q.purple=inf.visual.purple;}
  if(q.kind==='fastMove'&&inf){q.modelTop=inf.moves[0].value;q.modelP=inf.moves[0].p;}
  if(q.kind==='form'&&inf?.forms?.[0]){q.modelTop=inf.forms[0].value;q.modelP=inf.forms[0].p;}}
 // Your own Pokémon repeat across battles: ask once per Pokémon and question kind.
 const seen=new Set(),deduped=out.filter(q=>{if(q.side!=='my')return true;const k=q.key+':'+q.kind;if(seen.has(k))return false;seen.add(k);q.title=q.title.replace(/^Battle \d+ · /,'');q.allBattles=true;return true;});
 const order={result:0,form:1,shadow:2,fastMove:3};return deduped.sort((x,y)=>(x.side==='my')-(y.side==='my')||order[x.kind]-order[y.kind]||x.battle-y.battle);}
// Applies one answer (value null = "not sure": recorded, no change). Questions about your own
// Pokémon apply to every battle it appears in.
function answer(battles,q,value){if(q.allBattles&&q.side==='my'){let last=null;battles.forEach((b,i)=>{if((b.my||[]).some(p=>p.key===q.key))last=answerOne(battles,{...q,battle:i,allBattles:false},value);});return last;}return answerOne(battles,q,value);}
function answerOne(battles,q,value){const b=battles[q.battle];b.reviewLog=b.reviewLog||[];b.reviewLog.push({question:q.kind,side:q.side,key:q.key,value,at:new Date().toISOString()});
 if(value===null)return b;if(q.kind==='result'){const [result,ending]=String(value).split(':');b.answers={...(b.answers||{}),result:value};b.result=result;b.ending=ending||'normal';b.resultSource='reviewer';return b;}
 const m=b[q.side].find(p=>p.key===q.key);m.answers=m.answers||{};if(q.kind==='form')m.answers.form=value;if(q.kind==='shadow')m.answers.shadow=value;if(q.kind==='fastMove')m.answers.fastMove=value;condition(m);
 // Settle the species id once form and Shadow status are both known.
 const forms=realForms(m),form=m.answers.form||(forms.length===1?forms[0]:null),shadow=m.answers.shadow??(m.inference&&shadowEligibility(m).eligible===false?false:undefined);
 if(form&&shadow!==undefined){const id=shadow?form+'_shadow':form;if((m.candidates||[]).some(c=>c.id===id))m.id=id;}
 return m;}
// Turns stored reviewer answers into learned priors for the fit: confirmed fast moves and Shadow
// status per species (base form id). questions: [{id, kind, species}], answers: Map(id → {value}).
function learnedFromAnswers(questions,answers){const out={moves:{},shadow:{}},byId=new Map(questions.map(q=>[q.id,q]));
 // Answers carry their own kind and species, so they still count if the question was later removed.
 for(const [id,a] of answers){const q=byId.get(id)||a;if(!a||a.value===null||a.value===undefined||!q.species)continue;const sp=q.species.replace(/_shadow$/,'');
  if(q.kind==='fastMove'){out.moves[sp]=out.moves[sp]||{};out.moves[sp][a.value]=(out.moves[sp][a.value]||0)+1;}
  if(q.kind==='form'){const f=String(a.value).replace(/_shadow$/,'');out.forms=out.forms||{};out.forms[f]=(out.forms[f]||0)+1;}
  if(q.kind==='shadow'){for(const k of [sp,'*']){out.shadow[k]=out.shadow[k]||{yes:0,no:0};out.shadow[k][a.value?'yes':'no']++;}
   // Not Shadow, yet aura-purple was seen: this species' own colouring triggers the visual cue.
   const purple=a.purple??q.purple;if(a.value===false&&purple>=.001){out.purpleBodied=out.purpleBodied||{};out.purpleBodied[sp]=true;}}}return out;}
// How often the model's leading option matched the reviewer, per question kind.
function accuracy(questions,answers){const out={},byId=new Map(questions.map(q=>[q.id,q]));for(const [id,a] of answers){const q=byId.get(id)||a;if(!a||a.value===null||a.value===undefined||q.modelTop===undefined||q.modelTop===null)continue;const k=out[q.kind]=out[q.kind]||{right:0,total:0};k.total++;if(String(q.modelTop)===String(a.value))k.right++;}return out;}
const api={questions,answer,condition,shadowEligibility,hasShadowIn,speciesLabel,displayName,marginals,learnedFromAnswers,accuracy,RESULT_OPTIONS,ENDINGS};if(typeof module!=='undefined')module.exports=api;root.MetaQuestions=api;
})(typeof window==='undefined'?globalThis:window);
