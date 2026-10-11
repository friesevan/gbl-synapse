(function(root){
  'use strict';
  const source='f627e89e53c0c7b903fff097df7a0ad0ac95decc';
  const customWeight=value=>Number.isFinite(value)&&value>=0&&value<=1000?value:1;
  function sameMoveset(a,b){
    if(!Array.isArray(a)||!Array.isArray(b)||!a.length||!b.length)return false;
    const signature=m=>JSON.stringify([m[0],m.slice(1,3).filter(id=>id&&id!=='none').sort(),m[3]||'none']);
    return signature(a)===signature(b);
  }
  function compareMoveset(row,recommended,baselineScore,score=row.score){
    if(!recommended?.moveset)return null;
    if(sameMoveset(row.moveset,recommended.moveset))return {kind:'recommended',delta:0,baselineScore};
    const comparable=Number.isFinite(baselineScore)&&Number.isFinite(score),delta=comparable?score-baselineScore:null;
    return {kind:comparable&&delta>1e-8?'better':'alternate',delta,baselineScore:comparable?baselineScore:null};
  }
  function validateRoster(roster,allowed){
    if(roster.length<2)throw new Error('Select at least two Pokémon.');
    if(new Set(roster.map(item=>item.speciesId)).size!==roster.length)throw new Error('Each Pokémon must appear only once.');
    const invalid=roster.find(item=>!allowed.has(item.speciesId)||!Number.isFinite(item.weight)||item.weight<0||item.weight>1000);
    if(invalid)throw new Error(!allowed.has(invalid.speciesId)?invalid.speciesId+' is not eligible for this league.':invalid.speciesId+': enter a matchup weight from 0 to 1000.');
    if(roster.filter(item=>item.weight>0).length<2)throw new Error('Select at least two Pokémon with weights greater than 0.');
    return roster;
  }
  function enumerate(fast,charged,extra=[]){
    const rows=[];
    for(const f of [...new Set(fast)]) {
      const charges=[...new Set(charged)];
      for(let i=0;i<charges.length;i++)for(let j=i+1;j<charges.length;j++) {
        if(extra.length)for(const third of [...new Set(extra)])rows.push([f,charges[i],charges[j],third]);
        else rows.push([f,charges[i],charges[j]]);
      }
      if(charges.length===1)rows.push([f,charges[0],'none']);
    }
    return rows;
  }
  function filterVariants(rows,bestOnly,threshold){
    if(!rows.length)return [];
    const sorted=rows.slice().sort((a,b)=>b.rating-a.rating);
    if(bestOnly)return sorted.filter(row=>Math.abs(row.rating-sorted[0].rating)<1e-8);
    return sorted.filter(row=>row.rating>=sorted[0].rating*(1-threshold/100));
  }
  const key=(id,moves)=>id+'|'+moves.join('|');
  function cycleDpt(fast,charges){
    const fastDpt=fast.damage/fast.turns;
    if(!(fast.energyGain>0))return fastDpt;
    const cycles=charges.filter(m=>m.energy>0).map(m=>{const count=Math.ceil(m.energy/fast.energyGain);return (fast.damage*count+m.damage)/(count*fast.turns);});
    return Math.max(fastDpt,...cycles);
  }
  function selectCandidates(rows,policy,topN){
    if(!['all','top'].includes(policy))throw new Error('Choose all movesets or projected top N.');
    if(!Number.isInteger(topN)||topN<1||topN>10000)throw new Error('Top N must be an integer from 1 to 10,000.');
    const sorted=rows.slice().sort((a,b)=>b.projection-a.projection || a.variantId.localeCompare(b.variantId));
    return policy==='all'?sorted:sorted.slice(0,topN);
  }
  // Rectangular scoring: the opponent population has one recommended row per species.
  function categoryScores(candidates,baselines,targets,slug,fixedMeta=false){
    const curved=rows=>rows.map(row=>row.matches.map(m=>m.adjRating));
    const cb=curved(baselines),cc=curved(candidates);
    let previous=cb.map(matches=>Math.floor(matches.reduce((a,b)=>a+b,0)/targets.length)),scores=[],fallbacks=0;
    const calculate=(rows,values,meta)=>rows.map((row,i)=>{
      const weights=targets.map((target,j)=>target.speciesId===row.speciesId?0:meta[j]*target.weight);
      for(let j=0;j<targets.length;j++){
        let a=values[i][j];if(a>700)a=700+Math.sqrt(a-700);if(a<300)a=300**((300+a)/600);values[i][j]=a;
        if(slug==='switches'&&a<500)weights[j]*=1+(500-a)**2/20000;
      }
      if(!weights.some(w=>w>0)){fallbacks++;for(let j=0;j<targets.length;j++)weights[j]=targets[j].speciesId===row.speciesId?0:targets[j].weight;}
      return Math.floor(values[i].reduce((sum,a,j)=>sum+a*weights[j],0)/weights.reduce((a,b)=>a+b,0));
    });
    for(let n=0;n<7;n++){
      const best=previous.reduce((best,value)=>Math.max(best,value),0),meta=previous.map(score=>fixedMeta?1:Math.max((best>0?score/best:0)-(.1+.06*n),0)**1.65);
      scores=calculate(candidates,cc,meta);previous=calculate(baselines,cb,meta);
    }
    if(slug==='chargers')scores=scores.map((score,i)=>score*candidates[i].chargerFactor);
    const highest=scores.reduce((best,value)=>Math.max(best,value),0);
    if(!Number.isFinite(highest)||highest<=0)throw new Error('This roster produced no usable category scores.');
    return {scores:scores.map(score=>Math.floor(score/highest*1000)/10),fallbacks};
  }
  function seededCandidates(rows,n,recommended){
    const sorted=selectCandidates(rows,'top',n);
    if(recommended&&!sorted.some(row=>row.variantId===recommended.variantId)){
      if(sorted.length>=n)sorted.pop();sorted.push(recommended);
    }
    return sorted.sort((a,b)=>b.projection-a.projection||a.variantId.localeCompare(b.variantId));
  }
  function overallScore(scores,consistency){
    const q=[scores[0],scores[1],Math.max(scores[2],scores[3]),scores[4]].sort((a,b)=>b-a);
    let score=(q[0]**12*q[1]**6*q[2]**4*q[3]**2*consistency**2)**(1/26);
    if(scores[4]<=75&&consistency<=75)score=(score**14*scores[4]*consistency)**(1/16);
    return Math.floor(score*10)/10;
  }
  const weightModelVersion='adaptive-meta-v1';
  function weightPrior(rows){
    const best=Math.max(1,...rows.map(r=>r.score||0));
    return rows.map(r=>{
      const base=customWeight(r.weight);
      return Math.max(1e-6,base>1?base:Math.max(base,1e-3)*Math.max(0,(r.score||0)/best)**20);
    });
  }
  // Entropy-regularized, PvPoke-guided fixed point over recommended-only battles.
  // The diagonal is a fixed neutral 0.5; damping limits feedback between counters.
  function calculateMetaWeights(rows,matrix,{guidance=.75,temperature=.035,maxIterations=300,tolerance=1e-6,peak=40}={}){
    const n=rows.length;
    if(n<2||new Set(rows.map(r=>r.speciesId)).size!==n)throw new Error('Calculate weights needs at least two unique Pokémon.');
    if(!Number.isFinite(guidance)||guidance<0||guidance>1||!Number.isFinite(temperature)||temperature<=0||!Number.isFinite(peak)||peak<=0||peak>1000||!Number.isInteger(maxIterations)||maxIterations<1||maxIterations>1000||!Number.isFinite(tolerance)||tolerance<=0)throw new Error('Invalid weight model settings.');
    if(matrix.length!==n||matrix.some(row=>row.length!==n||Array.from(row).some(v=>!Number.isFinite(v)||v<0||v>1)))throw new Error('Invalid weight performance matrix.');
    const prior=weightPrior(rows),normalize=values=>{const sum=values.reduce((a,b)=>a+b,0);return values.map(v=>v/sum);};
    const softmax=values=>{const best=Math.max(...values);return normalize(values.map(v=>Math.exp(v-best)));};
    let probabilities=normalize(prior),residual=Infinity,iterations=0,performance=[],damping=.4,previousResidual=Infinity;
    const response=distribution=>{
      const performance=matrix.map((row,i)=>row.reduce((sum,v,j)=>sum+(i===j?.5:v)*distribution[j],0));
      let target=softmax(performance.map((score,i)=>guidance*Math.log(prior[i])+(1-guidance)*score/temperature));
      const highest=Math.max(...target);return normalize(target.map(v=>Math.max(v,highest*1e-6)));
    };
    for(let step=0;step<maxIterations;step++){
      const target=response(probabilities);
      residual=target.reduce((sum,v,i)=>sum+Math.abs(v-probabilities[i]),0);
      if(residual>previousResidual*1.01)damping=Math.max(.01,damping*.5);
      // A look-ahead response stabilizes counter / counter-counter cycles.
      const lookahead=probabilities.map((v,i)=>(1-damping)*v+damping*target[i]);
      const corrected=response(lookahead);
      probabilities=probabilities.map((v,i)=>(1-damping)*v+damping*corrected[i]);iterations=step+1;previousResidual=residual;
      if(residual<tolerance)break;
    }
    residual=response(probabilities).reduce((sum,v,i)=>sum+Math.abs(v-probabilities[i]),0);
    // Report performance against the final distribution, not the preceding pass.
    performance=matrix.map((row,i)=>row.reduce((sum,v,j)=>sum+(i===j?.5:v)*probabilities[j],0));
    const highest=Math.max(...probabilities),weights=probabilities.map(v=>peak*(v/highest)),sorted=probabilities.slice().sort((a,b)=>a-b);
    return {version:weightModelVersion,guidance,temperature,peak,iterations,residual,damping,converged:residual<tolerance,
      entries:rows.map((r,i)=>({speciesId:r.speciesId,weight:weights[i],share:probabilities[i],performance:performance[i]*1000,prior:prior[i]})),
      effectiveOpponents:1/probabilities.reduce((sum,p)=>sum+p*p,0),minimum:Math.min(...weights),maximum:Math.max(...weights),
      bottomHalfShare:sorted.slice(0,Math.floor(n/2)).reduce((a,b)=>a+b,0),
      lowPriorShare:rows.reduce((sum,r,i)=>sum+(customWeight(r.weight)<=1?probabilities[i]:0),0)};
  }
  function chooseCandidates(roster,published,limit){
    if(limit!=null&&(!Number.isInteger(limit)||limit<2||limit>10000))throw new Error('Candidate limit must be an integer from 2 to 10,000.');
    if(limit==null)return roster.slice();
    const ranks=new Map(published.map((row,i)=>[row.speciesId,i]));
    return roster.slice().sort((a,b)=>(ranks.get(a.speciesId)??Infinity)-(ranks.get(b.speciesId)??Infinity)).slice(0,limit);
  }
  function chooseOpponents(roster,limit,defaults={}){
    if(limit!=null&&(!Number.isInteger(limit)||limit<2||limit>10000))throw new Error('Opponent limit must be an integer from 2 to 10,000.');
    if(limit==null)return roster.slice();
    return roster.map((row,index)=>({row,index})).sort((a,b)=>(b.row.weight??customWeight(defaults[b.row.speciesId]))-(a.row.weight??customWeight(defaults[a.row.speciesId]))||customWeight(defaults[b.row.speciesId])-customWeight(defaults[a.row.speciesId])||a.index-b.index).slice(0,limit).map(item=>item.row);
  }
  function scoreColumn(report,settings){
    const mode=settings.mode,guidance=settings.guidance??.75;
    return {id:settings.id||'score-'+Date.now(),mode,guidance,label:mode==='calculate'?Math.round(guidance*100)+'%':mode==='equal'?'Equal':mode==='manual'?'Individual':'Default',targets:report._targets.map(t=>({...t})),model:report._weightModel||null,scores:Object.fromEntries(['overall','leads','closers','switches','chargers','attackers'].map(slug=>[slug,Object.fromEntries(report[slug].map(r=>[r.variantId,r.score]))]))};
  }
  function rankingColumnOrder(ids,saved=[]){
    const order=[...new Set(saved)].filter(id=>ids.includes(id));
    for(const id of ids){if(order.includes(id))continue;const kind=id.startsWith('score:')?'score:':id.startsWith('diff:')?'diff:':null;if(!kind){order.push(id);continue;}let after=-1;for(let i=0;i<order.length;i++)if(order[i].startsWith(kind))after=i;if(after<0&&kind==='diff:')for(let i=0;i<order.length;i++)if(order[i].startsWith('score:'))after=i;if(after<0){const anchor=ids.indexOf(id);for(let i=0;i<order.length;i++)if(ids.indexOf(order[i])<anchor)after=i;}order.splice(after+1,0,id);}
    return order;
  }
  function publishedScoreColumn(report,league,{id='published-'+Date.now()}={}){
    return {id,mode:'published',label:'PvPoke',targets:[],scores:Object.fromEntries(['overall','leads','closers','switches','chargers','attackers'].map(slug=>{const source=new Map((league[slug]||[]).map(r=>[r.speciesId,r.score]));return [slug,Object.fromEntries((report[slug]||[]).filter(r=>source.has(r.speciesId)).map(r=>[r.variantId,source.get(r.speciesId)]))];}))};
  }
  // Reweight only retained battle outcomes; never invokes the battle engine.
  function rescoreRankings(report,{mode='equal',guidance=.75,defaultWeights={},published=[]}={}){
    const slugs=['leads','closers','switches','chargers','attackers'],targets=report._targets;
    if(!targets?.length||slugs.some(slug=>!report[slug]?.length))throw new Error('This report lacks stored battle results. Regenerate it once to enable weight comparisons.');
    const baseline=(slug,target)=>report[slug].find(r=>r.speciesId===target.speciesId&&sameMoveset(r.moveset,target.moveset));
    const aligned=(row)=>{const matches=new Map((row.matches||[]).map(m=>[m.opponent,m]));return targets.map(t=>{
      if(t.speciesId===row.speciesId)return {opponent:t.speciesId,rating:500,adjRating:500};
      const match=matches.get(t.speciesId);
      if(!match||!Number.isFinite(match.rating)||!Number.isFinite(match.adjRating))throw new Error('Stored matchups are incomplete. Regenerate this report to compare weights.');
      return match;
    });};
    for(const slug of slugs)for(const target of targets)if(!baseline(slug,target))throw new Error('Recommended baseline missing. Regenerate this report to compare weights.');
    const reference=report._weightReference||{targets:targets.map(t=>({...t})),fixedMeta:!!report._weightModel,model:report._weightModel||null,scores:Object.fromEntries(['overall',...slugs].map(slug=>[slug,report[slug].map((r,i)=>({variantId:r.variantId,score:r.score,rank:i+1}))]))};
    let model=null,nextTargets;
    if(mode==='original'){nextTargets=reference.targets.map(t=>({...t}));model=reference.model;}
    else if(mode==='calculate'){
      const prior=targets.map(t=>({speciesId:t.speciesId,score:published.find(r=>r.speciesId===t.speciesId)?.score||0,weight:customWeight(defaultWeights[t.speciesId])}));
      const battles=slugs.map(slug=>targets.map(t=>aligned(baseline(slug,t))));
      const matrix=targets.map((t,i)=>targets.map((o,j)=>battles.reduce((sum,rows)=>sum+rows[i][j].rating,0)/(slugs.length*1000)));
      model=calculateMetaWeights(prior,matrix,{guidance,peak:Math.max(1,...Object.values(defaultWeights).map(customWeight))});
      nextTargets=targets.map((t,i)=>({...t,weight:model.entries[i].weight}));
    }else if(['equal','default','manual'].includes(mode))nextTargets=targets.map(t=>({...t,weight:mode==='equal'?1:mode==='default'?customWeight(defaultWeights[t.speciesId]):t.weight}));
    else throw new Error('Unknown weighting mode.');
    validateRoster(nextTargets,new Set(targets.map(t=>t.speciesId)));
    const output={...report,_targets:nextTargets,_weightModel:model,_weightReference:reference,_weightSettings:{mode,guidance}},scores=new Map();
    for(const slug of slugs){
      const candidates=report[slug].map(r=>({...r,matches:aligned(r)})),baselines=targets.map(t=>candidates.find(r=>r.variantId===baseline(slug,t).variantId));
      if(candidates.some(r=>!Number.isFinite(r.chargerFactor)))throw new Error('Scoring metadata missing.');
      const result=categoryScores(candidates,baselines,nextTargets,slug,mode==='original'?reference.fixedMeta:mode==='calculate');
      output[slug]=report[slug].map((r,i)=>{if(!scores.has(r.variantId))scores.set(r.variantId,[]);scores.get(r.variantId).push(result.scores[i]);return {...r,score:result.scores[i]};}).sort((a,b)=>b.score-a.score||a.variantId.localeCompare(b.variantId));
    }
    output.overall=report.overall.map(r=>{const values=scores.get(r.variantId),consistency=r.scores[5];return {...r,score:overallScore(values,consistency),scores:[...values,consistency]};}).sort((a,b)=>b.score-a.score||a.variantId.localeCompare(b.variantId));
    return output;
  }
  root.PvPPro={source,customWeight,sameMoveset,compareMoveset,validateRoster,enumerate,filterVariants,key,cycleDpt,selectCandidates,categoryScores,overallScore,seededCandidates,weightPrior,calculateMetaWeights,weightModelVersion,rescoreRankings,chooseOpponents,chooseCandidates,scoreColumn,publishedScoreColumn,rankingColumnOrder};
})(typeof self!=='undefined'?self:globalThis);
