(function(){
  'use strict';
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  let data, leagueData, overrides=[], weights=new Map(), custom=null, selected='', variants=[], variantContext='', worker, loading=0, loadedCp=0, page=0, sortKey='score',descending=true;
  let filters=[],filterWorker,filterTimer,filterPending=false,combinationCounts={},selectedKey='';
  const rankingPageSize=500;let expandedKey='';
  let calculatedModel=null,autoWeightTimer,headerClickTimer,pendingDifference=null,editingColumn=null,draggedColumn=null;
  let savedRankings=[],activeSaved='',saveBusy=false,sourceRequest=0,generatedSnapshot=null;
  let searchWorker,searchIndex=null,searchError='';const searchCache=new Map();
  const isCustom=()=>$('proSource').value!=='published';
  const types='bug dark dragon electric fairy fighting fire flying ghost grass ground ice normal poison psychic rock steel water'.split(' ');
  const filterTypes=[['type','Type'],['tag','Tag'],['id','Species'],['dex','Pokédex Number'],['move','Move'],['moveType','Move Type'],['cost','Charged Move Cost'],['distance','Buddy Walk Distance'],['evolution','Evolution']];
  const choices={type:[...types,'none'],moveType:types,tag:['legendary','mythical','ultrabeast','alolan','galarian','hisuian','regional','starter','shadow','shadoweligible','mega'],cost:[10000,50000,75000,100000],distance:[1,3,5,20],evolution:[0,1,2,3]};
  const labels={none:'Mono-type',ultrabeast:'Ultra Beast',shadoweligible:'Shadow Eligible',0:'No evolution',1:'First stage',2:'Middle stage',3:'Final stage'};
  const rowKey=row=>row.variantId||row.speciesId;
  function subTab(which){
    const lab=which==='lab',neural=which==='neural';$('proRankPanel').hidden=lab||neural;$('proLabPanel').hidden=!lab;$('proNeuralPanel').hidden=!neural;
    $('proPanel').classList.toggle('neural-active',neural);
    for(const [id,on] of [['proRankTab',!lab&&!neural],['proLabTab',lab],['proNeuralTab',neural]]){$(id).setAttribute('aria-selected',String(on));$(id).tabIndex=on?0:-1;}
    for(const node of document.querySelectorAll('.pro-rank-control'))node.hidden=lab||neural;
    $('proOpenBuilder').textContent=lab?'Configure roster':'Create custom rankings';updateSavedControls();
    const url=new URL(location.href);if(which==='rank')url.searchParams.delete('view');else url.searchParams.set('view',which);history.replaceState(null,'',url);
    if(neural)document.dispatchEvent(new Event('neural-open'));
  }
  const proViews=[['proRankTab','rank'],['proLabTab','lab'],['proNeuralTab','neural']];
  for(const [id,view] of proViews)$(id).addEventListener('click',()=>subTab(view));
  $('proSubTabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let i=proViews.findIndex(([id])=>$(id).getAttribute('aria-selected')==='true');i=event.key==='Home'?0:event.key==='End'?2:(i+(event.key==='ArrowRight'?1:2))%3;subTab(proViews[i][1]);$(proViews[i][0]).focus();});
  const initialProView=new URL(location.href).searchParams.get('view');if(['lab','neural'].includes(initialProView))setTimeout(()=>subTab(initialProView),0);
  $('proLabPokemon').addEventListener('change',()=>{stop();selected=$('proLabPokemon').value;variants=[];renderVariants();});
  function renderFilters(){
    $('proFilters').replaceChildren();
    filters.forEach((filter,index)=>{
      const card=el('div',null,'pro-filter-row'),controls=el('div',null,'pro-filter-controls'),select=el('select');select.setAttribute('aria-label','Include filter '+(index+1)+' type');
      for(const [value,label] of filterTypes){const option=el('option',label);option.value=value;select.append(option);}select.value=filter.filterType;
      select.addEventListener('change',()=>{filter.filterType=select.value;filter.values=[];filter.raw=undefined;filter.error='';renderFilters();scheduleFilter();});
      const remove=el('button','Remove filter '+(index+1),'secondary');remove.type='button';remove.addEventListener('click',()=>{filters.splice(index,1);renderFilters();scheduleFilter();});controls.append(select,remove);card.append(controls);
      const values=el('div',null,'pro-filter-values');
      if(choices[filter.filterType]){
        const all=choices[filter.filterType],toggle=el('button',filter.values.length===all.length?'Deselect all':'Select all','secondary pro-select-all');toggle.type='button';toggle.addEventListener('click',()=>{filter.values=filter.values.length===all.length?[]:[...all];renderFilters();scheduleFilter();});controls.insertBefore(toggle,remove);
        for(const value of choices[filter.filterType]){const label=el('label'),input=el('input');input.type='checkbox';input.checked=filter.values.includes(value);input.addEventListener('change',()=>{filter.values=input.checked?[...filter.values,value]:filter.values.filter(v=>v!==value);toggle.textContent=filter.values.length===all.length?'Deselect all':'Select all';scheduleFilter();});
          const title=filter.filterType==='evolution'?labels[value]:filter.filterType==='distance'?value+' km':filter.filterType==='cost'?value.toLocaleString():labels[value]||value[0].toUpperCase()+value.slice(1);
          label.append(input,document.createTextNode(title));values.append(label);}
      }else{
        const input=el('input');input.type='text';input.setAttribute('aria-label','Include filter '+(index+1)+' values');input.value=filter.raw??(filter.filterType==='dex'?filter.values.reduce((a,v,i)=>i%2?a:[...a,v+'-'+filter.values[i+1]],[]).join(', '):filter.values.join(', '));
        input.placeholder=filter.filterType==='dex'?'1-151, 252-386':filter.filterType==='id'?'eevee, umbreon, sylveon':'counter, ice_beam';
        if(filter.filterType!=='dex')input.setAttribute('list',filter.filterType==='id'?'proSpeciesIds':'proMoveIds');
        input.addEventListener('input',()=>{filter.preset=false;filter.raw=input.value;try{filter.values=parseFilterInput(filter.filterType,input.value);filter.error='';}catch(error){filter.error=error.message;}scheduleFilter();});values.append(input);
        card.append(el('p',filter.filterType==='id'?'Species IDs override other Include criteria. Separate IDs with commas.':filter.filterType==='dex'?'Inclusive ranges, separated by commas. A single number is also accepted.':'Learnable move IDs, separated by commas. These do not force move selection.','hint'));
      }
      card.append(values);
      if(filter.filterType==='id'&&filter.excludedValues?.length){const excluded=el('div',null,'pro-species-exclusions');excluded.append(el('span','Excluded:'));for(const id of filter.excludedValues){const restore=el('button',name(id)+' ×','secondary');restore.type='button';restore.setAttribute('aria-label','Restore '+name(id));restore.addEventListener('click',()=>{filter.excludedValues=filter.excludedValues.filter(v=>v!==id);renderFilters();scheduleFilter();});excluded.append(restore);}card.append(excluded);}
      $('proFilters').append(card);
    });
    if(!filters.length)$('proFilters').append(el('p','No Include rules: all eligible Pokémon in the published population are accepted.','hint'));
  }
  function parseFilterInput(type,text){
    const tokens=text.split(',').map(s=>s.trim()).filter(Boolean);
    if(type!=='dex')return tokens.map(s=>type==='move'?s.toUpperCase():s.toLowerCase());
    return tokens.flatMap(token=>{const m=token.match(/^(\d+)(?:\s*-\s*(\d+))?$/);if(!m||Number(m[1])<1||Number(m[2]||m[1])<Number(m[1]))throw new Error('Use inclusive Pokédex ranges such as 1-151, 252-386.');return [Number(m[1]),Number(m[2]||m[1])];});
  }
  function scheduleFilter(){
    clearTimeout(filterTimer);if(filterWorker){filterWorker.terminate();filterWorker=null;}filterPending=true;invalidate();stop();$('proFilterStatus').textContent='Updating eligible Pokémon…';filterTimer=setTimeout(applyFilters,200);
  }
  function applyFilters(){
    if(!data||!leagueData)return;
    const activeFilters=filters;
    const error=activeFilters.find(f=>f.error);if(error){$('proFilterStatus').textContent=error.error;return;}
    for(const filter of activeFilters){
      if(filter.filterType==='id'&&filter.values.some(id=>!data.pokemon.some(p=>p.speciesId===id))){$('proFilterStatus').textContent='Unknown species ID. Use the suggested lowercase IDs.';return;}
      if(filter.filterType==='move'&&filter.values.some(id=>!data.moves.some(m=>m.moveId===id))){$('proFilterStatus').textContent='Unknown move ID. Choose an ID from the suggestions.';return;}
    }
    const current=new Worker('includes/pro/worker.js');filterWorker=current;
    current.onmessage=event=>{if(current!==filterWorker)return;const result=event.data;current.terminate();filterWorker=null;
      if(result.type==='error'){$('proFilterStatus').textContent=result.error;return;}
      if(result.type!=='filtered')return;
      const ids=new Set(result.ids);for(const [id,state] of weights)state.accepted=ids.has(id);combinationCounts=result.counts;filterPending=false;applyWeightMode();stop();renderRoster();$('proFilterStatus').textContent=ids.size.toLocaleString()+' eligible Pokémon selected.';scheduleAutoWeights();
    };
    current.onerror=event=>{current.terminate();filterWorker=null;$('proFilterStatus').textContent='Filter failed: '+event.message;};
    current.postMessage({mode:'filter',data,cp:cp(),published:leagueData.overall,filters:activeFilters.filter(f=>f.filterType!=='id'||f.values.length).map(({filterType,values})=>({filterType,values})),excludedIds:activeFilters.flatMap(f=>f.excludedValues||[])});
  }
  const movesLimit=()=>document.querySelector('input[name=proMovesMode]:checked').value==='recommended'?1:Number($('proMovesTopN').value);
  function openBuilder(open){$('proBuilder').hidden=!open;$('proOpenBuilder').setAttribute('aria-expanded',String(open));updateSavedControls();}
  $('proOpenBuilder').addEventListener('click',()=>openBuilder($('proBuilder').hidden));
  $('proCloseBuilder').addEventListener('click',()=>openBuilder(false));
  $('proAddFilter').addEventListener('click',()=>{filters.push({filterType:'tag',values:[]});renderFilters();scheduleFilter();});
  for(const node of document.querySelectorAll('input[name=proMovesMode],#proMovesTopN'))node.addEventListener('change',()=>{$('proMovesTopControl').hidden=movesLimit()===1&&document.querySelector('input[name=proMovesMode]:checked').value==='recommended';invalidate();updateRosterCount();});
  $('proMovesInfo').addEventListener('click',()=>$('proMovesHelp').showModal());$('proCloseMovesHelp').addEventListener('click',()=>$('proMovesHelp').close());
  for(const node of document.querySelectorAll('input[name=proWeightMode]'))node.addEventListener('change',()=>{applyWeightMode();invalidate();if(leagueData)renderRoster();scheduleAutoWeights();});
  const weightMode=()=>document.querySelector('input[name=proWeightMode]:checked').value;
  const weightScope=()=>JSON.stringify([cp(),Number($('proWeightGuidance').value),roster().map(r=>r.speciesId).sort()]);
  const currentWeightModel=()=>!filterPending&&calculatedModel?.scope===weightScope()?calculatedModel:null;
  const formatWeight=value=>value===0?'0':value<.000001?'<0.000001':value.toLocaleString(undefined,{maximumFractionDigits:value<1?6:2});
  function applyWeightMode(){
    if(!leagueData){renderWeightControls();return;}
    const mode=weightMode(),original=new Map(overrides.map(row=>[row.speciesId,row.weight]));
    const prior=mode==='calculate'?PvPPro.weightPrior(leagueData.overall.map(r=>({...r,weight:original.get(r.speciesId)}))):[];
    const model=currentWeightModel(),estimated=new Map(model?.entries.map(r=>[r.speciesId,r.weight])||[]);
    let i=0;for(const [id,state] of weights){state.weight=mode==='equal'?1:mode==='calculate'?(estimated.get(id)??prior[i]):PvPPro.customWeight(original.get(id));i++;}
    renderWeightControls();
  }
  function renderWeightControls(){
    const mode=weightMode(),model=currentWeightModel();$('proCalculateControls').hidden=mode!=='calculate';$('proGuidanceValue').textContent=$('proWeightGuidance').value+'%';
    $('proCalculateWeights').disabled=!!worker||filterPending||loadedCp!==cp()||roster().length<2;
    $('proCalculateWeights').textContent=model?'Recalculate weights':'Calculate weights';
    $('proWeightStatus').textContent=mode==='equal'?'Every accepted opponent has equal weight.':mode==='default'?'Uses bundled PvPoke weights; missing weights use 1. A weight of 0 keeps a Pokémon in the rankings but excludes it from the opponent score.':model?(model.converged?'Weights converged':'Iteration limit reached; final estimates retained')+' after '+model.iterations+' updates. Estimated performance, not measured usage. Weights are saved with the report.':'Weights need calculating for this roster and guidance setting. Weights update automatically for the selected roster and guidance setting.';
    const host=$('proWeightMetrics');host.hidden=mode!=='calculate'||!model;host.replaceChildren();
    if(model)for(const [value,label] of [[formatWeight(model.minimum)+'–'+formatWeight(model.maximum)+'×','weight range'],[model.effectiveOpponents.toFixed(1),'effective opponents'],[(100*model.bottomHalfShare).toFixed(2)+'%','bottom half of roster · total weight']]){const metric=el('div',null,'pro-build-metric');metric.append(el('strong',value),el('span',label));host.append(metric);}
  }
  function scheduleAutoWeights(){clearTimeout(autoWeightTimer);if(weightMode()==='calculate'&&!filterPending&&leagueData&&roster().length>=2&&!currentWeightModel())autoWeightTimer=setTimeout(()=>launch('weights'),400);}
  $('proWeightGuidance').addEventListener('input',()=>{applyWeightMode();invalidate();if(leagueData)renderRoster();scheduleAutoWeights();});
  $('proCalculateWeights').addEventListener('click',()=>{invalidate();launch('weights');});
  $('proWeightsInfo').addEventListener('click',()=>$('proWeightsHelp').showModal());$('proCloseWeightsHelp').addEventListener('click',()=>$('proWeightsHelp').close());
  $('proRankBestOnly').addEventListener('change',()=>{page=0;render();});

  const cache=new Map();const status=text=>{$('proStatus').textContent=text;};
  const name=id=>data?.pokemon.find(p=>p.speciesId===id)?.speciesName || id;
  const move=id=>data?.moves.find(m=>m.moveId===id)?.name || (id==='none'?'None':id || '—');
  const cp=()=>Number($('proLeague').value);
  const leagueName=()=>({500:'Little Cup',1500:'Great League',2500:'Ultra League',10000:'Master League'})[cp()];
  function rows(){return isCustom() && custom ? custom[$('proCategory').value] || [] : leagueData?.[$('proCategory').value] || [];}
  function eligibleRoster(){return [...weights].filter(([,value])=>value.accepted).map(([speciesId,value])=>({speciesId,weight:value.weight}));}
  function roster(){const eligible=eligibleRoster();return PvPPro.chooseCandidates(eligible,leagueData?.overall||[],$('proAllCandidates').checked?null:Math.max(2,Math.min(10000,Math.floor(Number($('proCandidateLimit').value)||2))));}
  function previewOpponents(){return PvPPro.chooseOpponents(roster(),$('proAllOpponents').checked?null:Math.max(2,Math.min(10000,Math.floor(Number($('proOpponentLimit').value)||2))),Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1])));}
  async function json(path){if(cache.has(path))return cache.get(path);const r=await fetch('includes/pro/data/'+path);if(!r.ok)throw new Error('Unable to load bundled PvPoke data: '+path);const result=await r.json();cache.set(path,result);return result;}
  function stop(){clearTimeout(autoWeightTimer);if(worker){worker.terminate();worker=null;}$('proApplyScore').disabled=!custom?._targets?.length;$('proAddScore').disabled=false; $('proCancel').hidden=true;$('proGenerate').disabled=filterPending||loadedCp!==cp()||roster().filter(row=>row.weight>0).length<2;$('proEvaluate').disabled=filterPending||!selected || loadedCp!==cp();}
  function invalidate(){generatedSnapshot=null;activeSaved='';updateSavedControls();stop();custom=null;variants=[];$('proSource').value='published';$('proSource').querySelector('option[value=custom]').disabled=true;$('proSource').querySelector('option[value=custom]').hidden=true;variantContext='';$('proRunSummary').textContent='';renderVariants();updateSavedControls();if(leagueData)render();status('Roster changed. Generate rankings to apply your selection and weights.');}
  function prepareSearch(league,request){
    if(searchWorker){searchWorker.terminate();searchWorker=null;}
    searchError='';searchIndex=searchCache.get(league)||null;$('proSearchStatus').textContent=searchIndex?'PvPoke search syntax supported.':'Preparing PvPoke search…';
    if(searchIndex)return;
    const current=new Worker('includes/pro/worker.js');searchWorker=current;
    current.onmessage=event=>{if(current!==searchWorker||loading!==request)return;const result=event.data;current.terminate();searchWorker=null;
      if(result.type==='error'){searchError='Search unavailable: '+result.error;$('proSearchStatus').textContent=searchError;render();return;}
      searchIndex=new Map(result.records.map(record=>[record.id,record]));searchCache.set(league,searchIndex);$('proSearchStatus').textContent='PvPoke search syntax supported.';render();
    };
    current.onerror=event=>{current.terminate();searchWorker=null;searchError='Search unavailable: '+event.message;$('proSearchStatus').textContent=searchError;render();};
    current.postMessage({mode:'searchIndex',data,cp:league,published:leagueData.overall,meta:leagueMeta});
  }
  let leagueMeta=[];
  async function load(){
    PvPProDetail.cancel();$('proBattlePanel').hidden=true;renderedDetail=null;
    if(searchWorker){searchWorker.terminate();searchWorker=null;}searchIndex=null;
    generatedSnapshot=null;activeSaved='';updateSavedControls();
    clearTimeout(filterTimer);if(filterWorker){filterWorker.terminate();filterWorker=null;}filterPending=false;selectedKey='';loadedCp=0;selected='';variants=[];leagueData=null;weights.clear();calculatedModel=null;stop();$('proRankings').textContent='Loading league…';$('proDetail').textContent='Loading Pokémon details…';renderVariants();const league=cp(),request=++loading;status('Loading published PvPoke rankings…');$('proGenerate').disabled=true;
    try{
      const result=await Promise.all([data?Promise.resolve(data):json('gamemaster.json'),json('league-'+league+'.json'),json('overrides-'+league+'.json'),json('meta-'+league+'.json')]);
      if(loading!==request)return;
      [data,leagueData,overrides,leagueMeta]=result;loadedCp=league;custom=null;variants=[];page=0;selected='';$('proSource').value='published';$('proSource').querySelector('option[value=custom]').disabled=true;$('proSource').querySelector('option[value=custom]').hidden=true;
      weights=new Map(leagueData.overall.map((row,i)=>[row.speciesId,{accepted:true,weight:1}]));
      $('proCategory').replaceChildren(...Object.keys(leagueData).map(category=>{const option=el('option',category[0].toUpperCase()+category.slice(1));option.value=category;return option;}));
      filters=[{filterType:'type',values:[...choices.type]}];applyWeightMode();
      $('proSource').querySelector('option[value=published]').textContent=leagueName();
      $('proLabPokemon').replaceChildren(...leagueData.overall.map(row=>{const option=el('option',row.speciesName);option.value=row.speciesId;return option;}));
      $('proSpeciesIds').replaceChildren(...leagueData.overall.map(row=>{const option=el('option',row.speciesName);option.value=row.speciesId;return option;}));
      $('proMoveIds').replaceChildren(...data.moves.map(row=>{const option=el('option',row.name);option.value=row.moveId;return option;}));
      $('proSearchTraits').textContent=[...data.pokemonTraits.pros,...data.pokemonTraits.cons].join(' · ');
      prepareSearch(league,request);renderFilters();renderRoster();render();scheduleFilter();status(leagueName()+' rankings loaded.');
      $('proGenerate').disabled=filterPending;
    }catch(error){if(loading===request)status(error.message);}
  }
  document.addEventListener('pvp-tab-change',event=>{if(event.detail==='pro'&&!data)load();});
  $('proLeague').addEventListener('change',()=>{sourceRequest++;load();});
  function toggleSpecies(id){
    const accepted=weights.get(id).accepted;let filter=filters.find(f=>f.filterType==='id');if(!filter){filter={filterType:'id',values:[],excludedValues:[]};filters.push(filter);}
    filter.excludedValues=filter.excludedValues||[];filter.raw=undefined;filter.error='';
    if(accepted){filter.values=filter.values.filter(v=>v!==id);if(!filter.excludedValues.includes(id))filter.excludedValues.push(id);}else{filter.excludedValues=filter.excludedValues.filter(v=>v!==id);if(!filter.values.includes(id))filter.values.push(id);}
    weights.get(id).accepted=!accepted;renderFilters();renderRoster();scheduleFilter();
  }
  function renderRoster(){
    const query=$('proRosterSearch').value.trim().toLowerCase(),host=$('proRoster');host.replaceChildren();
    const selectedIds=new Set(roster().map(r=>r.speciesId)),ranks=new Map(leagueData.overall.map((r,i)=>[r.speciesId,i+1]));
    const matches=leagueData.overall.filter(row=>row.speciesName.toLowerCase().includes(query)||row.speciesId.includes(query));
    for(const row of matches){
      const state=weights.get(row.speciesId),selected=selectedIds.has(row.speciesId),limited=state.accepted&&!selected,button=el('button',null,'pro-pokemon-tile');button.type='button';button.setAttribute('aria-pressed',String(selected));button.setAttribute('aria-label',(selected?'Exclude ':limited?'Outside candidate limit: ':'Include ')+row.speciesName);
      button.append(el('span',selected?'✓':'+','pro-tile-check'),el('span',row.speciesName,'pro-tile-name'));const rank=el('small','#'+ranks.get(row.speciesId),'pro-tile-rank');rank.title=leagueName()+' · published PvPoke rank '+ranks.get(row.speciesId);button.append(rank);button.dataset.type=data.pokemon.find(p=>p.speciesId===row.speciesId)?.types?.[0];
      button.title=limited?'Outside the top-ranked candidate limit. Increase the limit or narrow the filters to include this Pokémon.':rank.title;button.addEventListener('click',()=>{if(limited){$('proPreviewStatus').textContent=button.title;return;}toggleSpecies(row.speciesId);});host.append(button);
    }
    $('proPreviewStatus').textContent=matches.length.toLocaleString()+' Pokémon shown · '+selectedIds.size+' ranking candidates · '+eligibleRoster().length+' eligible before the rank limit.';updateRosterCount();renderWeightControls();renderOpponentPreview();
  }
  function renderOpponentPreview(){
    if(!leagueData)return;
    const candidates=roster(),selected=new Set(previewOpponents().map(r=>r.speciesId)),pending=weightMode()==='calculate'&&!currentWeightModel(),query=$('proOpponentSearch').value.trim().toLowerCase();
    const ordered=PvPPro.chooseOpponents(candidates,10000,Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1]))),host=$('proOpponentPreview');host.replaceChildren();
    for(const row of ordered){if(query&&!name(row.speciesId).toLowerCase().includes(query)&&!row.speciesId.includes(query))continue;const included=selected.has(row.speciesId),tile=el('div',null,'pro-pokemon-tile');tile.setAttribute('aria-pressed',String(included));tile.setAttribute('aria-label',(included?'Included opponent: ':'Excluded opponent: ')+name(row.speciesId));tile.dataset.type=data.pokemon.find(p=>p.speciesId===row.speciesId)?.types?.[0];tile.append(el('span',included?'✓':'−','pro-tile-check'),el('span',name(row.speciesId),'pro-tile-name'),el('small',pending?'—':formatWeight(row.weight)+'×','pro-tile-weight'));tile.title=pending?'Provisional selection using tapered PvPoke priors; calculate weights to finalize.':name(row.speciesId)+' · opponent weight '+row.weight+'×';host.append(tile);}
    $('proOpponentPreviewCount').textContent=selected.size+' / '+candidates.length+' opponents';$('proOpponentPreviewStatus').textContent=pending?'Updating calculated weights. The top-N opponent preview will refresh automatically when ready.':selected.size+' opponents selected by '+(weightMode()==='equal'?'equal weights, with PvPoke default weights breaking ties':weightMode()==='calculate'?'calculated weights':'PvPoke default weights')+'. Dimmed Pokémon remain ranking candidates.';
  }
  function updateRosterCount(){
    const accepted=roster(),n=accepted.length,top=movesLimit();
    const combinations=accepted.reduce((sum,row)=>sum+Math.min(combinationCounts[row.speciesId]||1,top),0);
    const pruning=top>1&&accepted.some(row=>top<(combinationCounts[row.speciesId]||0));
    const shortlist=accepted.reduce((sum,row)=>sum+Math.min(combinationCounts[row.speciesId]||1,top===1?1:Math.max(32,top*4)+1),0);
    const opponentCount=$('proAllOpponents').checked?n:Math.min(n,Math.max(2,Number($('proOpponentLimit').value)||2));
    const sample=Math.min(8,opponentCount),estimate=pruning?5*((shortlist+n)*sample+(combinations+n)*Math.max(0,opponentCount-sample)):5*(combinations+n)*opponentCount;
    $('proPreviewCount').textContent=n.toLocaleString()+' / '+eligibleRoster().length.toLocaleString()+' candidates';
    const host=$('proRosterCount');host.replaceChildren();for(const [value,label] of [[n,'Pokémon'],[combinations,'candidate movesets'],[opponentCount,'opponents'],[estimate,'battles · upper estimate']]){const metric=el('div',null,'pro-build-metric');metric.append(el('strong',value.toLocaleString()),el('span',label));host.append(metric);}const active=accepted.filter(row=>row.weight>0).length;if(active<2)host.append(el('p','Select at least two opponents with positive weights.','pro-weight-warning'));
  }
  for(const id of ['proAllOpponents','proOpponentLimit'])$(id).addEventListener('input',()=>{$('proOpponentLimitControl').hidden=$('proAllOpponents').checked;invalidate();updateRosterCount();renderOpponentPreview();scheduleAutoWeights();});
  for(const id of ['proAllCandidates','proCandidateLimit'])$(id).addEventListener('input',()=>{$('proCandidateLimitControl').hidden=$('proAllCandidates').checked;applyWeightMode();invalidate();if(leagueData)renderRoster();scheduleAutoWeights();});
  $('proOpponentSearch').addEventListener('input',renderOpponentPreview);
  $('proRosterSearch').addEventListener('input',()=>{if(leagueData)renderRoster();});
  function launch(mode){
    if(filterPending||!data || !leagueData || loadedCp!==cp())return;
    let accepted;
    try{PvPPro.chooseCandidates(eligibleRoster(),leagueData.overall,$('proAllCandidates').checked?null:Number($('proCandidateLimit').value));accepted=PvPPro.validateRoster(roster(),new Set(leagueData.overall.map(row=>row.speciesId)));}catch(error){status(error.message);return;}
    if(mode==='variants' && accepted.every(row=>row.speciesId===selected)){status('Select at least one other opponent for the moveset lab.');return;}
    const limits={},policy='top',topN=movesLimit();
    try{PvPPro.chooseOpponents(accepted,$('proAllOpponents').checked?null:Number($('proOpponentLimit').value));}catch(error){status(error.message);return;}
    try{PvPPro.selectCandidates([],policy,topN);}catch(error){status(error.message);return;}
    const limit=Number($('proLimit').value);if(!Number.isInteger(limit)||limit<1||limit>10000){status('Moveset limit must be an integer from 1 to 10,000.');return;}
    stop();worker=new Worker('includes/pro/worker.js');const current=worker;renderWeightControls();
    $('proGenerate').disabled=true;$('proEvaluate').disabled=true;$('proCancel').hidden=false;
    status(mode==='weights'?'Simulating the recommended roster to estimate meta weights…':mode==='variants'?'Evaluating movesets against the accepted weighted roster…':'Projecting and ranking moveset combinations against recommended opponents…');
    const scope=weightScope(),model=currentWeightModel();
    const context=accepted.length+' accepted Pokémon · '+$('proLeague').selectedOptions[0].textContent+(mode==='variants'?' · '+$('proShields').value+' shields each':' · five ranking scenarios')+' · '+(weightMode()==='calculate'?'Calculated weights ('+$('proWeightGuidance').value+'% PvPoke guidance)':weightMode()==='equal'?'Equal weights':'PvPoke default weights');
    current.onmessage=event=>{
      if(worker!==current)return;
      const result=event.data;
      if(result.type==='progress'){status(result.text);return;}
      if(result.type==='error'){stop();renderWeightControls();status('Calculation failed: '+result.error);return;}
      if(result.type==='weights'){calculatedModel={...result.model,scope};for(const entry of result.model.entries)weights.get(entry.speciesId).weight=entry.weight;if(mode==='weights'){stop();renderRoster();status('Calculated weights ready. Generate to apply them to the rankings.');}else renderRoster();return;}
      if(result.type==='result'){
        activeSaved='';$('proSavedName').value='';selectedKey='';custom={_targets:result.targets,_weightModel:result.weightModel,_weightSettings:{mode:weightMode(),guidance:Number($('proWeightGuidance').value)/100},overall:result.rows,...Object.fromEntries(result.categories.map(item=>[item.slug,item.rows]))};
        $('proSource').querySelector('option[value=custom]').disabled=false;$('proSource').querySelector('option[value=custom]').hidden=false;$('proSource').value='custom';$('proCategory').value='overall';page=0;render();
        $('proGeneratedContext').textContent='Generated: '+context+'. All selected movesets versus recommended-only opponents. Rectangular PvPoke-style scores; editor adjustments are not applied.';const summary=result.summary;
        $('proRunSummary').textContent=summary.selectedCombinations+' / '+summary.totalCombinations+' combinations ranked · '+summary.opponents+' recommended opponents · '+summary.simulations.toLocaleString()+' simulated battles'+(summary.scoutOpponents?' · Scout sample: '+summary.scoutOpponents+' opponents; recommended moveset retained':'')+(summary.fallbacks?' · '+summary.fallbacks+' scoring rows/passes used the zero-meta-weight fallback':'')+'.';
        generatedSnapshot={rankings:custom,context:$('proGeneratedContext').textContent,summary:$('proRunSummary').textContent};
        openBuilder(false);status('Custom ranking generation complete.');
      }else if(result.type==='variants'){
        variants=result.rows;variantContext=context;$('proVariantContext').textContent=result.total+' movesets evaluated · '+context+'. Weighted mean Battle Rating (0–1000), not published overall score.';renderVariants();status('Moveset evaluation complete.');
      }
      stop();renderWeightControls();
    };
    current.onerror=event=>{stop();renderWeightControls();status('Calculation failed: '+event.message);};
    current.postMessage({mode,data,opponentLimit:$('proAllOpponents').checked?null:Number($('proOpponentLimit').value),weightMode:weightMode(),weightGuidance:Number($('proWeightGuidance').value)/100,defaultWeights:Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1])),weightModel:mode==='weights'?null:model,cp:cp(),published:leagueData.overall,roster:accepted,speciesId:selected,limit,policy,topN,limits,shields:Number($('proShields').value)});
  }
  $('proGenerate').addEventListener('click',()=>launch('generate'));$('proEvaluate').addEventListener('click',()=>launch('variants'));$('proCancel').addEventListener('click',()=>{stop();renderWeightControls();status('Calculation cancelled.');});
  $('proCategory').addEventListener('change',()=>{clearTimeout(headerClickTimer);page=0;sortKey='score';descending=true;expandedKey='';pendingDifference=null;render();});
  $('proSource').addEventListener('change',selectSource);
  $('proSearch').addEventListener('input',()=>{page=0;render();});
  $('proPrev').addEventListener('click',()=>{page--;render();});$('proNext').addEventListener('click',()=>{page++;render();});
  function comparison(row,lab=false){
    const recommended=leagueData?.overall.find(item=>item.speciesId===row.speciesId);
    if(!lab&&!isCustom())return PvPPro.compareMoveset(row,leagueData?.[$('proCategory').value]?.find(item=>item.speciesId===row.speciesId),row.score);
    const baseline=(lab?variants:rows()).find(item=>item.speciesId===row.speciesId&&PvPPro.sameMoveset(item.moveset,recommended?.moveset));
    return PvPPro.compareMoveset(row,recommended,lab?baseline?.rating:baseline?.score,lab?row.rating:row.score);
  }
  function movesetBadge(comparison,lab=false,row){
    if(!comparison)return null;
    const wrap=el('span',null,'pro-moveset-comparison');
    const gain=comparison.delta<.1?'<0.1':comparison.delta?.toFixed(1);
    const text=comparison.kind==='recommended'?'Recommended':'Alternate Moveset'+(comparison.kind==='better'?' · Beats recommended by '+gain+(lab?' BR':' points'):'');
    const badge=el('span',text,'pro-moveset-badge');wrap.append(badge);
    badge.title=comparison.kind==='recommended'?'PvPoke recommended moveset (charged move order ignored).':comparison.baselineScore==null?'Recommended moveset is not present in this saved report; a score comparison is unavailable.':(lab?'Recommended weighted Battle Rating: ':'Recommended moveset score in this report: ')+comparison.baselineScore.toFixed(1)+(lab?'. Compared against the same lab opponents and shield setting.':'. Compared in the current category against the same opponents.');
    if(comparison.kind!=='recommended'&&row){const recommended=leagueData?.overall.find(item=>item.speciesId===row.speciesId);if(recommended)wrap.append(el('span','Recommended: '+recommended.moveset.filter(id=>id!=='none').map(move).join(' · '),'pro-recommended-reference'));}
    return wrap;
  }
  function render(){
    updateSavedControls();
    let list=rows();if(!list.length){$('proRankings').textContent='Load a league to view rankings.';$('proDetailParking').hidden=true;document.querySelector('.pro-layout').classList.remove('pro-has-details','pro-has-battle');PvPProDetail.cancel();renderedDetail=null;return;}
    const query=$('proSearch').value.trim().toLowerCase();
    if(!selected || !list.some(row=>row.speciesId===selected))selected=list[0].speciesId;
    if(!list.some(row=>rowKey(row)===selectedKey))selectedKey=rowKey(list.find(row=>row.speciesId===selected)||list[0]);
    const columns=scoreColumns(),columnMaps=new Map(columns.map(c=>[c.id,c.scores[$('proCategory').value]||{}]));
    const differences=(custom?._differenceColumns||[]).filter(d=>columnMaps.has(d.left)&&columnMaps.has(d.right));
    const scoreValue=(row,id)=>id==='primary'?row.score:columnMaps.get(id)?.[row.variantId];
    const value=(row,key)=>{if(key==='speciesName')return row.speciesName;if(key==='score')return row.score;if(key.startsWith('score:'))return scoreValue(row,key.slice(6));const d=differences.find(d=>'diff:'+d.id===key);return d?scoreValue(row,d.left)-scoreValue(row,d.right):undefined;};
    if(!['score','speciesName'].includes(sortKey)&&!columns.some(c=>'score:'+c.id===sortKey)&&!differences.some(d=>'diff:'+d.id===sortKey))sortKey='score';
    const baseHeaders=[{id:'rank',label:'Rank'},{id:'pokemon',label:'Pokémon',key:'speciesName'},...(columns.length?columns.map(c=>({id:'score:'+c.id,label:'Score ('+c.label+')',key:'score:'+c.id,column:c})):[{id:'score',label:'Score',key:'score'}]),...differences.map(d=>({id:'diff:'+d.id,label:'Difference ('+columns.find(c=>c.id===d.left).label+' − '+columns.find(c=>c.id===d.right).label+')',key:'diff:'+d.id,difference:d})),{id:'moves',label:isCustom()?'Moveset':'Recommended moveset'}];
    const order=PvPPro.rankingColumnOrder(baseHeaders.map(h=>h.id),isCustom()?custom?._columnOrder||[]:[]),headers=order.map(id=>baseHeaders.find(h=>h.id===id));
    const ranked=rows().slice(),rankColumn=headers.find(h=>h.column)?.column;
    if(rankColumn&&sortKey==='score')sortKey='score:'+rankColumn.id;
    if(rankColumn)ranked.sort((a,b)=>(scoreValue(b,rankColumn.id)??-Infinity)-(scoreValue(a,rankColumn.id)??-Infinity)||a.speciesName.localeCompare(b.speciesName)||rowKey(a).localeCompare(rowKey(b)));
    const rankMap=new Map(ranked.map((row,i)=>[rowKey(row),i+1]));
    if($('proRankBestOnly').checked&&isCustom()){const seen=new Set();list=list.slice().sort((a,b)=>rankMap.get(rowKey(a))-rankMap.get(rowKey(b))).filter(row=>{if(seen.has(row.speciesId))return false;seen.add(row.speciesId);return true;});}
    const matches=PvPProSearch.compile(query,data);
    const filtered=query?(searchIndex?list.filter(row=>matches(row,searchIndex)):[]):list.slice();
    filtered.sort((a,b)=>(sortKey==='speciesName'?a.speciesName.localeCompare(b.speciesName):(value(a,sortKey)??-Infinity)-(value(b,sortKey)??-Infinity))*(descending?-1:1));
    const pages=Math.max(1,Math.ceil(filtered.length/rankingPageSize));page=Math.max(0,Math.min(page,pages-1));
    document.querySelector('.pro-layout').classList.toggle('pro-has-score-columns',columns.length>1);
    const table=el('table',null,'pro-ranking-table'+(columns.length>1?' pro-score-table':''));table.append(el('caption',(activeSaved?(savedRankings.find(item=>item.id===activeSaved)?.name||'Saved'):(isCustom()?'Generated':leagueName()))+' · '+$('proCategory').selectedOptions[0].textContent+(isCustom()?' · '+$('proLeague').selectedOptions[0].textContent:'')));
    const head=table.createTHead().insertRow();
    for(const {id,label,key,column,difference} of headers){const th=el('th');th.scope='col';if(column&&column.id===rankColumn?.id){th.classList.add('pro-rank-basis');const indicator=el('span','Rank basis','pro-rank-basis-label');th.append(indicator);}
      if(key){const button=el('button',label+(sortKey===key?(descending?' ↓':' ↑'):' ↕'),'column-sort');button.type='button';button.addEventListener('click',()=>{clearTimeout(headerClickTimer);if(pendingDifference&&column){addDifference(pendingDifference,column.id);return;}headerClickTimer=setTimeout(()=>{descending=sortKey===key?!descending:key!=='speciesName';sortKey=key;render();},260);});th.append(button);th.setAttribute('aria-sort',sortKey===key?(descending?'descending':'ascending'):'none');}else th.textContent=label;
      if(column){th.addEventListener('dblclick',event=>{if(event.target.closest('.pro-info-button,.pro-remove-score'))return;clearTimeout(headerClickTimer);editingColumn=column.id;$('proColumnTitle').textContent='Score ('+column.label+')';$('proColumnDialog').showModal();});const info=el('button','i','pro-info-button');info.type='button';info.setAttribute('aria-label','Information for Score ('+column.label+')');info.addEventListener('click',()=>previewScore(column));th.append(info);if(column.id!=='primary'){const remove=el('button','×','pro-remove-score');remove.type='button';remove.setAttribute('aria-label','Remove Score ('+column.label+')');remove.addEventListener('click',()=>{custom._scoreColumns=custom._scoreColumns.filter(c=>c.id!==column.id);custom._differenceColumns=differences.filter(d=>d.left!==column.id&&d.right!==column.id);persistColumnView();});th.append(remove);}}
      if(difference){const remove=el('button','×','pro-remove-score');remove.type='button';remove.setAttribute('aria-label','Remove '+label);remove.addEventListener('click',()=>{custom._differenceColumns=differences.filter(d=>d.id!==difference.id);persistColumnView();});th.append(remove);}
      if(isCustom()){th.draggable=true;th.title='Drag to reorder'+(column?' · Double-click for score actions':'');th.addEventListener('dragstart',event=>{draggedColumn=id;event.dataTransfer.setData('text/plain',id);event.dataTransfer.effectAllowed='move';});th.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';});th.addEventListener('drop',event=>{event.preventDefault();const from=draggedColumn;if(!from||from===id)return;const ids=headers.map(h=>h.id);ids.splice(ids.indexOf(from),1);ids.splice(ids.indexOf(id),0,from);custom._columnOrder=ids;const firstScore=ids.find(id=>id.startsWith('score:'));if(firstScore!=='score:'+rankColumn?.id){sortKey=firstScore;descending=true;page=0;}draggedColumn=null;persistColumnView();});th.addEventListener('dragend',()=>{draggedColumn=null;});}head.append(th);
    }
    const detailHost=$('proDetail'),battleHost=$('proBattlePanel'),parking=$('proDetailParking');parking.append(detailHost,battleHost);detailHost.className='pro-sidebar-content';
    const body=table.createTBody();
    for(const row of filtered.slice(page*rankingPageSize,(page+1)*rankingPageSize)){
      const tr=body.insertRow(),comp=comparison(row);if(rowKey(row)===selectedKey)tr.classList.add('pro-selected');
      for(const header of headers){const cell=tr.insertCell();if(header.column&&header.column.id===rankColumn?.id)cell.classList.add('pro-rank-basis');if(header.id==='rank'){cell.textContent=rankMap.get(rowKey(row));continue;}if(header.id==='pokemon'){const button=el('button',row.speciesName,'pro-pokemon-button');button.type='button';button.setAttribute('aria-expanded',String(expandedKey===rowKey(row)));button.setAttribute('aria-controls','proDetail');button.addEventListener('click',()=>{if(selected!==row.speciesId){stop();variants=[];selected=row.speciesId;renderVariants();}selectedKey=rowKey(row);expandedKey=expandedKey===selectedKey?'':selectedKey;if(!expandedKey){PvPProDetail.cancel();renderedDetail=null;}render();if(expandedKey)$('proDetail').scrollIntoView({behavior:'smooth',block:'nearest'});});cell.append(button,PvPProDetail.pokemonTypes(data.pokemon.find(p=>p.speciesId===row.speciesId)));continue;}if(header.id==='moves'){cell.append(PvPProDetail.moves(row.moveset,data));const badge=movesetBadge(comp,false,row);if(badge&&isCustom())cell.append(badge);continue;}const v=value(row,header.key);cell.textContent=Number.isFinite(v)?(header.difference&&v>0?'+':'')+v.toFixed(1):'—';if(header.difference){cell.className='pro-score-difference '+(v>0?'positive':v<0?'negative':'');const left=columns.find(c=>c.id===header.difference.left),right=columns.find(c=>c.id===header.difference.right);if(Number.isFinite(v)&&((left?.mode==='published')!==(right?.mode==='published'))&&['alternate','better'].includes(comp?.kind)){const badge=el('span','Alternate Moveset','pro-moveset-badge pro-difference-moveset-badge');badge.title='This row uses an alternate moveset. The published PvPoke score refers to the recommended moveset.';cell.append(badge);}}else{cell.classList.add('rated-cell');cell.style.setProperty('--rating-hue',Math.max(0,Math.min(130,(v||0)*1.3)));if(header.column?.mode==='published')cell.title='Published PvPoke score for the recommended moveset; shared by all variants of this species.';}}
    }
    if(!filtered.length){const cell=body.insertRow().insertCell();cell.colSpan=headers.length;cell.textContent=query&&!searchIndex?(searchError||'Preparing search data…'):'No Pokémon match this search.';}
    $('proRankings').replaceChildren(table);$('proPagination').textContent=filtered.length+' Pokémon · Page '+(page+1)+' / '+pages+' · '+rankingPageSize+' per page';$('proPrev').disabled=page===0;$('proNext').disabled=page===pages-1;
    if(!selected || !list.some(row=>row.speciesId===selected))selected=list[0].speciesId;
    const expanded=filtered.slice(page*rankingPageSize,(page+1)*rankingPageSize).find(row=>rowKey(row)===expandedKey);parking.hidden=!expanded;document.querySelector('.pro-layout').classList.toggle('pro-has-details',!!expanded);if(expanded)renderDetail(expanded);else{PvPProDetail.cancel();renderedDetail=null;battleHost.hidden=true;document.querySelector('.pro-layout').classList.remove('pro-has-battle');}
    $('proGeneratedContext').hidden=!isCustom();
  }
  let renderedDetail;
  function renderDetail(row){
    if(!row)return;const identity=[row,cp(),$('proSource').value,$('proCategory').value];if(renderedDetail&&identity.every((v,i)=>v===renderedDetail[i]))return;renderedDetail=identity;selected=row.speciesId;$('proLabPokemon').value=selected;const p=data.pokemon.find(item=>item.speciesId===row.speciesId),host=$('proDetail');host.replaceChildren();const summary=el('div',null,'pro-inline-summary');
    if(row.stats)summary.append(el('p','Attack '+row.stats.atk+' · Defense '+row.stats.def+' · HP '+row.stats.hp,'hint'));
    if(row.editorNotes)summary.append(el('p',row.editorNotes,'hint'));
    const targets=isCustom()?(custom._targets||[...new Set(custom.overall.map(r=>r.speciesId))].map(speciesId=>({speciesId,weight:1,moveset:leagueData.overall.find(r=>r.speciesId===speciesId)?.moveset}))).filter(t=>t.moveset):leagueData.overall.map(r=>({speciesId:r.speciesId,moveset:r.moveset,weight:1}));
    PvPProDetail.mount({host,data,cp:cp(),published:leagueData.overall,row,category:$('proCategory').value,targets,custom:isCustom(),historical:isCustom()&&!custom._targets,
      categoryRow:slug=>custom?.[slug]?.find(r=>rowKey(r)===rowKey(row)),battleHost:$('proBattlePanel')});host.querySelector('.pro-move-info').after(summary);
    const labButton=el('button','Open this Pokémon in Moveset Lab','secondary');labButton.type='button';labButton.addEventListener('click',()=>{subTab('lab');$('proLabPanel').scrollIntoView({behavior:'smooth',block:'start'});});host.append(labButton);$('proEvaluate').disabled=!!worker||filterPending;
  }
  function renderVariants(){
    const host=$('proVariants');host.replaceChildren();
    $('proLabMovesetLegend').hidden=true;
    if(!variants.length){host.textContent='Select a Pokémon, then evaluate its movesets against your accepted roster.';$('proVariantContext').textContent='';return;}
    const threshold=Number($('proThreshold').value);if(!Number.isFinite(threshold)||threshold<0||threshold>100){host.textContent='Threshold must be from 0 to 100%.';return;}
    const shown=PvPPro.filterVariants(variants,$('proBestOnly').checked,threshold),table=el('table',null,'pro-variants-table');
    table.append(el('caption',name(selected)+' · '+shown.length+' / '+variants.length+' movesets shown'));
    const head=table.createTHead().insertRow();for(const text of ['Moveset','Weighted Battle Rating','Below best']){const th=el('th',text);th.scope='col';head.append(th);}
    const body=table.createTBody();
    for(const row of shown){const tr=body.insertRow(),comp=comparison(row,true);tr.insertCell().append(PvPProDetail.moves(row.moveset,data));const badge=movesetBadge(comp,true,row);if(badge)tr.cells[0].append(badge);tr.insertCell().textContent=row.rating.toFixed(1);tr.insertCell().textContent=(variants[0].rating ? (1-row.rating/variants[0].rating)*100 : 0).toFixed(2)+'%';
      const detail=el('details');detail.append(el('summary','Matchups'));for(const item of row.matches)detail.append(el('p',name(item.opponent)+' · '+item.rating,'hint'));tr.cells[0].append(detail);}
    host.append(table);
  }
  function updateSavedControls(){
    const available=!!custom&&isCustom();
    $('proRankingOptions').hidden=!available;$('proRankingOptionsTitle').textContent=activeSaved?'Edit Saved Ranking':'Save Ranking & Options';$('proSavedControls').hidden=!available;$('proBestFilter').hidden=!available;$('proMovesetLegend').hidden=true;
    $('proAddScore').hidden=!available||!custom?._targets?.length;$('proAddScore').disabled=!!worker;$('proApplyScore').disabled=!!worker||!available;
    if(available)$('proRankingOptions').append($('proStatus'));else $('proRankPanel').before($('proStatus'));
    $('proStatus').hidden=$('proBuilder').hidden&&!available&&$('proLabPanel').hidden;
    $('proRunSummary').hidden=!available;
    $('proSaveRanking').disabled=saveBusy||!available;
    $('proSaveRanking').textContent=activeSaved?'Save a copy':'Save rankings';
    $('proRenameRanking').hidden=!activeSaved;$('proDeleteRanking').hidden=!activeSaved;
    $('proRenameRanking').disabled=saveBusy;$('proDeleteRanking').disabled=saveBusy;
  }
  const scoreMode=()=>document.querySelector('input[name=proScoreMode]:checked').value;
  const scoreRules=column=>column.mode==='published'?'Published PvPoke score':column.mode==='calculate'?'Calculate with '+Math.round(column.guidance*100)+'% PvPoke guidance':column.mode==='equal'?'Equal':column.mode==='manual'?'Individual weights':'Default';
  function primaryScore(){
    if(!custom)return null;
    if(!custom._primaryScore){const settings=custom._weightSettings,context=$('proGeneratedContext').textContent;const mode=settings&&settings.mode!=='original'?settings.mode:custom._weightModel?'calculate':context.includes('Equal weights')?'equal':'default';custom._primaryScore=PvPPro.scoreColumn(custom,{id:'primary',mode,guidance:settings?.guidance??custom._weightModel?.guidance??.75});}
    return custom._primaryScore;
  }
  function scoreColumns(){return isCustom()&&custom?._targets?[primaryScore(),...(custom._scoreColumns||[])]:[];}
  function configureScore(){const mode=scoreMode();$('proScoreCalculateControls').hidden=mode!=='calculate';$('proScoreGuidanceValue').textContent=$('proScoreGuidance').value+'%';$('proScoreModeHint').textContent=mode==='default'?'Uses bundled PvPoke weights; missing weights use 1.':mode==='equal'?'Every stored opponent has equal weight.':mode==='published'?'Uses the published category score for this league and recommended moveset. All variants of a species share that reference score.':'Estimates weights from stored recommended matchups against this report’s opponents.';}
  for(const node of document.querySelectorAll('input[name=proScoreMode],#proScoreGuidance'))node.addEventListener('input',configureScore);
  $('proAddScore').addEventListener('click',()=>{configureScore();$('proScoreStatus').textContent='';$('proAddScoreDialog').showModal();});
  $('proCloseAddScore').addEventListener('click',()=>$('proAddScoreDialog').close());
  $('proScoreWeightsInfo').addEventListener('click',()=>$('proWeightsHelp').showModal());
  let previewColumn=null;
  function previewScore(column){if(column.mode==='published'){$('proScorePreviewTitle').textContent='Score (PvPoke)';$('proScorePreviewRules').textContent='Published '+leagueName()+' category scores from the bundled PvPoke ranking snapshot. Scores refer to each species’ recommended moveset, not the alternate moveset in this row. Different opponent pools and normalization can affect comparisons.';$('proScorePreviewGrid').replaceChildren();$('proScorePreviewCount').textContent='Published reference · no custom opponent weights';$('proScorePreviewSearch').hidden=true;$('proScorePreviewDialog').showModal();return;}$('proScorePreviewSearch').hidden=false;previewColumn=column;$('proScorePreviewSearch').value='';$('proScorePreviewTitle').textContent='Score ('+column.label+')';$('proScorePreviewRules').textContent=scoreRules(column)+' · '+column.targets.length+' opponents. These are the assigned weights used for this score.'+(column.mode==='calculate'?' Weight estimation pool: '+(column.model?.entries.length||column.targets.length)+' Pokémon.':'');renderScorePreview();$('proScorePreviewDialog').showModal();}
  function renderScorePreview(){const query=$('proScorePreviewSearch').value.trim().toLowerCase(),host=$('proScorePreviewGrid');host.replaceChildren();const targets=(previewColumn?.targets||[]).filter(t=>name(t.speciesId).toLowerCase().includes(query)||t.speciesId.includes(query));for(const t of targets){const tile=el('div',null,'pro-pokemon-tile');tile.dataset.type=data.pokemon.find(p=>p.speciesId===t.speciesId)?.types?.[0];tile.append(el('span','✓','pro-tile-check'),el('span',name(t.speciesId),'pro-tile-name'),el('small',formatWeight(t.weight)+'×','pro-tile-weight'));tile.title=name(t.speciesId)+' · '+t.weight+'×';host.append(tile);}$('proScorePreviewCount').textContent=targets.length+' / '+(previewColumn?.targets.length||0)+' opponents';}
  $('proScorePreviewSearch').addEventListener('input',renderScorePreview);$('proCloseScorePreview').addEventListener('click',()=>$('proScorePreviewDialog').close());
  $('proApplyScore').addEventListener('click',()=>{
    if(!custom?._targets?.length)return;
    const mode=scoreMode(),guidance=Number($('proScoreGuidance').value)/100;primaryScore();
    if(mode==='published'){const column=PvPPro.publishedScoreColumn(custom,leagueData,{id:crypto.randomUUID()});custom._scoreColumns=[...(custom._scoreColumns||[]),column];persistColumnView();$('proAddScoreDialog').close();return;}
    const source=custom;stop();worker=new Worker('includes/pro/worker.js');const current=worker;$('proApplyScore').disabled=true;$('proScoreStatus').textContent='Calculating scores from stored battles…';
    current.onmessage=event=>{if(worker!==current)return;const result=event.data;if(result.type==='error'){stop();$('proScoreStatus').textContent=result.error;return;}if(result.type!=='reweighted')return;
      const column=PvPPro.scoreColumn(result.report,{id:crypto.randomUUID(),mode,guidance});custom={...source,_scoreColumns:[...(source._scoreColumns||[]),column]};stop();page=0;render();$('proScoreStatus').textContent='Score added · 0 battles simulated.';$('proAddScoreDialog').close();
      generatedSnapshot={rankings:custom,context:$('proGeneratedContext').textContent,summary:$('proRunSummary').textContent};
    };
    current.onerror=event=>{stop();$('proScoreStatus').textContent=event.message;};
    current.postMessage({mode:'reweight',data,cp:cp(),published:leagueData.overall,report:custom,settings:{mode,guidance,defaultWeights:Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1])),published:leagueData.overall}});
  });
  function persistColumnView(){if(generatedSnapshot)generatedSnapshot.rankings=custom;render();}
  function addDifference(left,right){if(left===right){$('proColumnStatus').textContent='Select a different score column.';return;}custom._differenceColumns=[...(custom._differenceColumns||[]),{id:crypto.randomUUID(),left,right}];pendingDifference=null;$('proColumnStatus').textContent='Difference added: selected score minus comparison score.';persistColumnView();}
  $('proCloseColumn').addEventListener('click',()=>$('proColumnDialog').close());
  $('proAddDifference').addEventListener('click',()=>{if(scoreColumns().length<2){$('proColumnStatus').textContent='Add another score before comparing columns.';$('proColumnDialog').close();return;}pendingDifference=editingColumn;$('proColumnDialog').close();$('proColumnStatus').textContent='Click another score header to add: '+scoreColumns().find(c=>c.id===editingColumn).label+' minus that score. Press Escape to cancel.';});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&pendingDifference){pendingDifference=null;$('proColumnStatus').textContent='Difference selection cancelled.';}});
  function refreshSavedOptions(){
    const select=$('proSource'),value=select.value;
    for(const option of [...select.options])if(option.value.startsWith('saved:'))option.remove();
    for(const item of savedRankings){const option=el('option',item.name+' · '+item.leagueLabel);option.value='saved:'+item.id;select.append(option);}
    if([...select.options].some(o=>o.value===value))select.value=value;
  }
  async function selectSource(){
    const value=$('proSource').value,request=++sourceRequest;
    if(!value.startsWith('saved:')){activeSaved='';if(value==='custom'&&generatedSnapshot){custom=generatedSnapshot.rankings;$('proGeneratedContext').textContent=generatedSnapshot.context;$('proRunSummary').textContent=generatedSnapshot.summary;}page=0;render();return;}
    try{
      const record=await PvPProSaved.get(value.slice(6));
      if(request!==sourceRequest)return;
      if(!record)throw new Error('This saved ranking is no longer available.');
      if(cp()!==record.cp){$('proLeague').value=String(record.cp);await load();}
      if(request!==sourceRequest)return;
      if(loadedCp!==record.cp)throw new Error('Unable to load the saved ranking’s league.');
      stop();$('proRankingOptions').open=false;custom=record.rankings;activeSaved=record.id;selectedKey='';selected='';page=0;
      $('proSource').value=value;$('proCategory').value='overall';$('proSavedName').value=record.name;
      $('proGeneratedContext').textContent=record.context;$('proRunSummary').textContent=record.summary;
      render();status('Loaded saved rankings: '+record.name+'.');
    }catch(error){$('proSource').value='published';activeSaved='';render();$('proSavedStatus').textContent=error.message;}
  }
  async function saveAction(action){
    if(saveBusy)return;
    const rankingName=$('proSavedName').value.trim();
    if(action!=='delete'&&!rankingName){$('proSavedStatus').textContent='Enter a name for these rankings.';$('proSavedName').focus();return;}
    saveBusy=true;updateSavedControls();
    try{
      if(action==='save'){
        if(!custom||!isCustom())throw new Error('Generate custom rankings first.');
        const record={id:crypto.randomUUID(),name:rankingName,cp:cp(),leagueLabel:$('proLeague').selectedOptions[0].textContent,updatedAt:Date.now(),rankings:custom,context:$('proGeneratedContext').textContent,summary:$('proRunSummary').textContent,source:PvPPro.source};
        await PvPProSaved.put(record);activeSaved=record.id;$('proRankingOptions').open=false;
        savedRankings=await PvPProSaved.list();refreshSavedOptions();$('proSource').value='saved:'+record.id;
      }else if(action==='rename'){
        const record=await PvPProSaved.get(activeSaved);if(!record)throw new Error('Saved ranking not found.');
        record.name=rankingName;record.updatedAt=Date.now();await PvPProSaved.put(record);
        savedRankings=await PvPProSaved.list();refreshSavedOptions();
      }else{
        await PvPProSaved.remove(activeSaved);generatedSnapshot={rankings:custom,context:$('proGeneratedContext').textContent,summary:$('proRunSummary').textContent};activeSaved='';$('proSource').querySelector('option[value=custom]').disabled=false;$('proSource').querySelector('option[value=custom]').hidden=false;$('proSource').value='custom';
        savedRankings=await PvPProSaved.list();refreshSavedOptions();
      }
      $('proSavedStatus').textContent=action==='delete'?'Saved copy deleted. The displayed results remain available.':'Rankings '+(action==='rename'?'renamed':'saved')+' in this browser.';
    }catch(error){$('proSavedStatus').textContent='Unable to '+action+' rankings: '+error.message;}
    finally{saveBusy=false;updateSavedControls();if(leagueData)render();}
  }
  $('proSaveRanking').addEventListener('click',()=>saveAction('save'));
  $('proRenameRanking').addEventListener('click',()=>saveAction('rename'));
  $('proDeleteRanking').addEventListener('click',()=>saveAction('delete'));
  PvPProSaved.list().then(records=>{savedRankings=records;refreshSavedOptions();}).catch(error=>{$('proSavedStatus').textContent='Browser storage is unavailable: '+error.message;});
  if(!$('proPanel').hidden)load();
  for(const id of ['proBestOnly','proThreshold'])$(id).addEventListener('input',renderVariants);
})();
