(function(){
  'use strict';
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  let data, leagueData, overrides=[], weights=new Map(), custom=null, selected='', worker, loading=0, loadedCp=0, page=0, sortKey='score',descending=true;
  let filters=[],filterWorker,filterTimer,filterPending=false,combinationCounts={},selectedKey='';
  const rankingPageSize=500;let expandedKey='';
  let calculatedModel=null,autoWeightTimer,headerClickTimer,pendingDifference=null,editingColumn=null,draggedColumn=null;
  let savedRankings=[],activeSaved='',saveBusy=false,sourceRequest=0,generatedSnapshot=null;
  let searchWorker,searchIndex=null,searchError='';const searchCache=new Map();
  // Cup presets (GBL schedule) and observed usage weights (Meta Extractor); see observed-weights.js and README 4e.
  const O=window.PvPObserved,USAGE_KEY='pvp-pro-observed-usage-v1';
  let scheduleData=null,presetList=null,preset=null,presetNone=false,cupRosterState=null,gmMap=null,usage=null,usageSource='none',usageError='',observedReady=null,lastObserved=null;
  // One cup list (cups.js catalog) for Current › Cup, the builder's Cup and the cup presets. cupEntry is the cup whose
  // published rankings are the population; published describes how they loaded (bundled, fetched, missing, error).
  const C=window.PvPCups;
  let cupIndex=null,cupList=null,cupListKey=[],cupEntry=null,cupAuto=true,published=null,loadedCup='';const cupCache=new Map();
  const isCustom=()=>$('proSource').value!=='published';
  const types='bug dark dragon electric fairy fighting fire flying ghost grass ground ice normal poison psychic rock steel water'.split(' ');
  const filterTypes=[['type','Type'],['tag','Tag'],['id','Species'],['dex','Pokédex Number'],['move','Move'],['moveType','Move Type'],['cost','Charged Move Cost'],['distance','Buddy Walk Distance'],['evolution','Evolution']];
  const choices={type:[...types,'none'],moveType:types,tag:['legendary','mythical','ultrabeast','alolan','galarian','hisuian','regional','starter','shadow','shadoweligible','mega'],cost:[10000,50000,75000,100000],distance:[1,3,5,20],evolution:[0,1,2,3]};
  const labels={none:'Mono-type',ultrabeast:'Ultra Beast',shadoweligible:'Shadow Eligible',0:'No evolution',1:'First stage',2:'Middle stage',3:'Final stage'};
  const rowKey=row=>row.variantId||row.speciesId;
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
      const ids=new Set(result.ids),cupIds=cupRosterState?.allowed;let n=0;for(const [id,state] of weights){state.accepted=ids.has(id)&&(!cupIds||cupIds.has(id));if(state.accepted)n++;}combinationCounts=result.counts;filterPending=false;applyWeightMode();stop();renderRoster();$('proFilterStatus').textContent=n.toLocaleString()+' eligible Pokémon selected'+(cupIds?' within '+preset.name:'')+'.';scheduleAutoWeights();
    };
    current.onerror=event=>{current.terminate();filterWorker=null;$('proFilterStatus').textContent='Filter failed: '+event.message;};
    current.postMessage({mode:'filter',data,cp:cp(),published:leagueData.overall,filters:activeFilters.filter(f=>f.filterType!=='id'||f.values.length).map(({filterType,values})=>({filterType,values})),excludedIds:activeFilters.flatMap(f=>f.excludedValues||[])});
  }
  const movesLimit=()=>document.querySelector('input[name=proMovesMode]:checked').value==='recommended'?1:Number($('proMovesTopN').value);
  function openBuilder(open){$('proBuilder').hidden=!open;if(open){ensureObserved();if(cupDirty&&leagueData&&loadedCp===cp()){cupDirty=false;scheduleFilter();}}$('proOpenBuilder').setAttribute('aria-expanded',String(open));updateSavedControls();}
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
    lastObserved=mode==='observed'?observedModel():null;
    let i=0;for(const [id,state] of weights){state.weight=mode==='equal'?1:mode==='calculate'?(estimated.get(id)??prior[i]):mode==='observed'&&lastObserved?(lastObserved.weights.get(id)??0):PvPPro.customWeight(original.get(id));i++;}
    renderWeightControls();
  }
  // ---- observed usage weights and cup presets ----
  const priorStrength=()=>{const v=Number($('proPriorStrength').value);return Number.isFinite(v)&&v>=0?Math.min(100000,v):O.PRIOR_STRENGTH;};
  const selection=()=>preset||(presetList?O.defaultPreset(presetList,cp()):null);
  const cpLabels={500:'500 CP',1500:'1,500 CP',2500:'2,500 CP',10000:'Master'};
  function readImported(){try{const raw=localStorage.getItem(USAGE_KEY);return raw?O.parseUsage(JSON.parse(raw)):null;}catch{return null;}}
  async function fetchUsage(){
    try{const r=await fetch('/api/observed-usage',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);usage=O.parseUsage(await r.json());usageSource='local';usageError='';}
    catch(error){usage=readImported();usageSource=usage?'imported':'none';usageError=/^(localhost|127\.0\.0\.1)$/.test(location.hostname)?'the local observed-usage API did not answer: '+error.message:'';}
  }
  function ensureObserved(){
    if(!observedReady)observedReady=Promise.all([
      fetch('scripts/yt-harvest/data/gbl-schedule.json').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(s=>{scheduleData=s;presetList=O.presets(s);}).catch(()=>{scheduleData=null;presetList=null;}),
      json('published-cups.json').then(x=>{cupIndex=x;}).catch(()=>{cupIndex=null;}),
      fetchUsage()
    ]).then(()=>syncPreset(true));
    return observedReady;
  }
  let cupDirty=false;
  // Keeps the preset on the loaded CP (else the latest season's open league of that CP, unless the user chose none).
  function syncPreset(refilter){
    const list=cups();
    if(preset&&preset.cp!==cp())preset=null;else if(preset)preset=list.find(preset.key)||preset;
    if(!preset&&!presetNone&&presetList){const d=O.defaultPreset(presetList,cp());preset=d?list.find(d.key):null;}
    if(cupEntry&&cupEntry.cp!==cp())cupEntry=null;else if(cupEntry)cupEntry=list.find(cupEntry.key)||cupEntry;
    // Until a cup is chosen, Current › Cup follows the builder's default preset (this season's open league) when it shares the rankings.
    if(!cupEntry||cupAuto&&preset&&preset!==cupEntry&&preset.rankingCup===cupEntry.rankingCup){cupAuto=true;cupEntry=preset&&preset.rankingCup===(published?.cup||C.DEFAULT_CUPS[cp()])?preset:C.defaultEntry(list,cp());}
    computeCupRoster();renderCupSelect();
    if(refilter&&leagueData&&data&&loadedCp===cp()){if(custom){cupDirty=true;applyWeightMode();}else scheduleFilter();}
    else{applyWeightMode();if(leagueData&&loadedCp===cp())renderRoster();}
  }
  let gmSource=null;
  function computeCupRoster(){
    cupRosterState=null;if(!preset||!data||!leagueData||loadedCp!==cp())return;
    const ids=leagueData.overall.map(r=>r.speciesId);
    // The cup's own published rankings already are PvPoke's eligible roster for it (every species its rules allow).
    if(ownRankings(preset)){cupRosterState={key:preset.key,allowed:new Set(ids),unknown:0,rulesUnknown:false,fromRankings:true};return;}
    if(gmSource!==data){gmMap=new Map(data.pokemon.map(p=>[p.speciesId,p]));gmSource=data;}
    cupRosterState={key:preset.key,...O.cupRoster(scheduleData,preset.cup,preset.cp,ids,gmMap,preset.rules)};
  }
  // The shared cup list as <option>s; GBL presets show their observed battle counts.
  function cups(){const key=[presetList,data,cupIndex,scheduleData];if(!cupList||key.some((v,i)=>v!==cupListKey[i])){cupList=C.catalog({presets:presetList,gamemaster:data,index:cupIndex,schedule:scheduleData});cupListKey=key;}return cupList;}
  const ownRankings=e=>!!(e&&published&&loadedCp===e.cp&&published.cp===e.cp&&published.cup===e.rankingCup&&(published.status==='bundled'||published.status==='fetched'));
  function cupOptions(withNone,current){
    const options=[];if(withNone){const none=el('option','None · manual filters only');none.value='';options.push(none);}
    const list=cups();if(current&&!list.find(current.key)){const o=el('option',C.optionLabel(current));o.value=current.key;options.push(o);}
    for(const g of list.groups){const group=document.createElement('optgroup');group.label=g.label;
      for(const e of g.entries)if(C.CP_LABELS[e.cp]){const u=O.group(usage,e.cp,e.cup,e.season);const o=el('option',C.optionLabel(e,u?' · '+u.battles.toLocaleString()+' battles':''));o.value=e.key;group.append(o);}
      if(group.children.length)options.push(group);}
    return options;
  }
  function renderCupSelect(){
    const select=$('proCup'),pub=$('proPublishedCup'),list=cups();
    select.replaceChildren(...cupOptions(true,preset));select.value=preset?.key||'';select.disabled=!list.entries.length;
    pub.replaceChildren(...cupOptions(false,cupEntry));pub.value=cupEntry?.key||'';pub.disabled=!cupEntry;
    renderCupInfo();renderPublishedInfo();
  }
  function renderPublishedInfo(){
    const info=$('proPublishedInfo'),e=cupEntry,p=published;if(!info)return;
    if(!e||!p){info.textContent='';return;}
    const file='src/data/rankings/'+p.cup+'/<category>/rankings-'+p.cp+'.json',gbl=e.season!=null?' · '+O.presetLabel(e)+(C.OPEN_LEAGUES[e.cup]?' uses PvPoke’s open “all” rankings':''):'';
    info.textContent=p.status==='bundled'?'Published PvPoke rankings, bundled: '+file+' at '+C.SHA.slice(0,7)+gbl+'.':p.status==='fetched'?'Published PvPoke rankings read from PvPoke’s repository: '+file+' at '+C.SHA.slice(0,7)+gbl+'.':p.status==='missing'?'No published PvPoke rankings for this cup at '+C.SHA.slice(0,7)+'.':p.status==='error'?'PvPoke’s repository could not be read.':'';
  }
  function periodList(list){const text=list.map(p=>O.range(p.start,p.end)+(p.battles!=null?' ('+p.battles.toLocaleString()+')':''));return text.length>6?[...text.slice(0,3),'… '+(text.length-5)+' more …',...text.slice(-2)].join(', '):text.join(', ');}
  function renderCupInfo(){
    const info=$('proCupInfo');
    if(!presetList&&!cups().entries.length){info.textContent=observedReady&&!scheduleData?'The GBL schedule is unavailable here; use the Pokémon filters.':'Loading the GBL schedule…';return;}
    if(!preset){const s=selection();info.textContent='No cup: the roster is the published '+leagueName()+' population, narrowed by your filters.'+(s?' Observed weights use '+O.presetLabel(s)+'.':'');return;}
    const g=O.group(usage,preset.cp,preset.cup,preset.season),parts=[O.presetLabel(preset)+(preset.periods.length?' · '+(preset.periods.length>1?preset.periods.length+' schedule periods pooled: ':'schedule period: ')+periodList(preset.periods):'')];
    if(cupRosterState?.fromRankings)parts.push('Roster: all '+leagueData.overall.length.toLocaleString()+' Pokémon in PvPoke’s published '+preset.name+' rankings (the cup’s eligible roster)');
    else if(cupRosterState)parts.push((preset.rankingCup!==loadedCup?'No published rankings for this cup: its rules are applied to the '+openName()+' population · ':'')+(cupRosterState.rulesUnknown?'Cup rules can’t be checked from a team (for example, caught-during-season), so the roster is not restricted':cupRosterState.allowed.size.toLocaleString()+' of '+leagueData.overall.length.toLocaleString()+' ranked Pokémon meet the cup rules'+(cupRosterState.unknown?' ('+cupRosterState.unknown+' not checkable, kept)':'')));
    parts.push(g?'Weights from '+g.battles.toLocaleString()+' observed battles ('+g.lineups.toLocaleString()+' settled lineups) in '+periodList(g.periods):usage?'No observed battles for this cup and season yet: weights are PvPoke’s':'Observed usage unavailable: weights are PvPoke’s');
    if(preset.season==='all')parts.push('Pools every season; metas change between seasons');
    info.textContent=parts.join(' · ')+'.';
  }
  function observedModel(){
    const sel=selection();if(!usage||!sel||!leagueData||sel.cp!==cp())return null;
    const ids=[...weights].filter(([,s])=>s.accepted).map(([id])=>id),g=O.group(usage,sel.cp,sel.cup,sel.season);
    return {...O.weights({ids,pvpoke:Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight])),group:g,priorStrength:priorStrength()}),selection:sel,group:g,source:usageSource,revision:usage.revision,generated:usage.generated};
  }
  // What a report keeps about its observed weights (provenance, sample size, per-opponent observed vs PvPoke).
  const sibling=id=>id.endsWith('_shadow')?id.slice(0,-7):id+'_shadow';
  function observedInfo(m,ids){if(!m)return null;const set=new Set(ids),g=m.group,all=new Set(m.rows.map(r=>r.id));
    return {forms:ids.map(sibling).filter(id=>all.has(id)&&!set.has(id)),   // roster forms that shared a species' Shadow split
selection:{cp:m.selection.cp,cup:m.selection.cup,season:m.selection.season,label:O.presetLabel(m.selection)},source:m.source,revision:m.revision,generated:m.generated,battles:g?.battles||0,lineups:m.lineups,leadLineups:m.leadLineups,creators:g?.creators||0,first:g?.first||null,last:g?.last||null,periods:g?.periods||[],priorStrength:m.priorStrength,priorTotal:m.priorTotal,leadBonus:m.leadBonus,observedFraction:m.observedFraction,
      species:Object.fromEntries(m.rows.filter(r=>set.has(r.id)).map(r=>[r.id,{weight:r.weight,observed:r.observed,pvpoke:r.pvpoke}]))};}
  const pct=x=>x==null||!Number.isFinite(x)?'—':x>0&&x<.001?'<0.1%':(100*x).toFixed(x<.1?1:0)+'%';
  function renderObservedControls(){
    const m=lastObserved,g=m?.group,sel=m?.selection||selection();
    $('proObservedSource').textContent=usage?(usageSource==='local'?'Source: Meta Extractor (this app’s harvested battles)':'Source: imported usage file')+(usage.generated?' · generated '+usage.generated.slice(0,10):'')+(sel?' · '+O.presetLabel(sel):''):'Observed usage is unavailable'+(usageError?' ('+usageError+')':'')+', so opponents use PvPoke weights. The local app reads the Meta Extractor; elsewhere, import a file from Meta Extractor › Observed meta › Export usage weights for PvPoke Pro.';
    let stored=false;try{stored=!!localStorage.getItem(USAGE_KEY);}catch{}$('proUsageClear').hidden=!stored;
    const host=$('proObservedMetrics');host.replaceChildren();host.hidden=!m;
    if(m)for(const [value,label] of [[(g?.battles||0).toLocaleString(),'battles'],[m.lineups.toLocaleString(),'settled lineups · sample size'],[(g?.creators||0).toLocaleString(),'creators'],[g?.first?O.range(g.first,g.last):'—','battle dates'],[Math.round(100*m.observedFraction)+'%','observed share of each weight']]){const metric=el('div',null,'pro-build-metric');metric.append(el('strong',value),el('span',label));host.append(metric);}
    const notes=[];
    if(m&&g?.periods?.length)notes.push('Observed periods: '+periodList(g.periods)+'.');
    if(sel?.season==='all')notes.push('All seasons are pooled; metas change between seasons.');
    if(m?.unmatched.length)notes.push('Observed but not in this roster (dropped): '+m.unmatched.slice(0,6).map(u=>name(u.id)+' '+pct(u.share)).join(', ')+(m.unmatched.length>6?' and '+(m.unmatched.length-6)+' more':'')+'.');
    if(usage&&usageSource==='local'&&stored)notes.push('An imported file is stored in this browser; the local app’s live data is used instead.');
    $('proObservedNote').textContent=notes.join(' ');
  }
  // Choosing a cup in either selector selects it in both and loads its published rankings when they are not loaded.
  function chooseCup(e){
    if(!e)return;preset=e;presetNone=false;cupEntry=e;cupAuto=false;
    if(e.cp!==cp()||!published||published.cp!==e.cp||published.cup!==e.rankingCup){$('proLeague').value=String(e.cp);sourceRequest++;load();return;}
    computeCupRoster();renderCupSelect();scheduleFilter();if(leagueData){$('proSource').querySelector('option[value=published]').textContent=leagueName();render();}
  }
  $('proCup').addEventListener('change',()=>{const e=cups().find($('proCup').value);if(!e){preset=null;presetNone=true;computeCupRoster();renderCupInfo();scheduleFilter();return;}chooseCup(e);});
  $('proPublishedCup').addEventListener('change',()=>chooseCup(cups().find($('proPublishedCup').value)));
  $('proPriorStrength').addEventListener('input',()=>{applyWeightMode();invalidate();if(leagueData)renderRoster();});
  $('proUsageImport').addEventListener('change',async event=>{
    const file=event.target.files[0];event.target.value='';if(!file)return;let message;
    try{const parsed=O.parseUsage(JSON.parse(await file.text()));let saved=true;try{localStorage.setItem(USAGE_KEY,JSON.stringify(parsed));}catch{saved=false;}
      if(usageSource!=='local'){usage=parsed;usageSource='imported';}message='Imported '+parsed.groups.length+' usage groups'+(parsed.generated?' (generated '+parsed.generated.slice(0,10)+')':'')+(saved?'.':'; browser storage is blocked, so it lasts until you reload.');}
    catch(error){message='Import failed: '+error.message;}
    renderCupSelect();applyWeightMode();invalidate();if(leagueData)renderRoster();$('proObservedNote').textContent=message;
  });
  $('proUsageClear').addEventListener('click',()=>{try{localStorage.removeItem(USAGE_KEY);}catch{}if(usageSource==='imported'){usage=null;usageSource='none';}renderCupSelect();applyWeightMode();invalidate();if(leagueData)renderRoster();});
  function renderWeightControls(){
    const mode=weightMode(),model=currentWeightModel();$('proCalculateControls').hidden=mode!=='calculate';$('proGuidanceValue').textContent=$('proWeightGuidance').value+'%';
    $('proCalculateWeights').disabled=!!worker||filterPending||loadedCp!==cp()||roster().length<2;
    $('proCalculateWeights').textContent=model?'Recalculate weights':'Calculate weights';
    $('proObservedControls').hidden=mode!=='observed';if(mode==='observed')renderObservedControls();
    const obs=lastObserved;
    $('proWeightStatus').textContent=mode==='observed'?(obs?'Weight = 100 × (observed lineups containing the Pokémon + lead bonus + '+obs.priorStrength+' × its PvPoke share) ÷ ('+obs.lineups.toLocaleString()+' + '+obs.priorStrength+'): '+Math.round(100*obs.observedFraction)+'% observed, '+(100-Math.round(100*obs.observedFraction))+'% PvPoke. Shadow forms split by the observed Shadow share. Weights are saved with the report.':'Observed usage unavailable: using bundled PvPoke weights.'):mode==='equal'?'Every accepted opponent has equal weight.':mode==='default'?'Uses bundled PvPoke weights; missing weights use 1. A weight of 0 keeps a Pokémon in the rankings but excludes it from the opponent score.':model?(model.converged?'Weights converged':'Iteration limit reached; final estimates retained')+' after '+model.iterations+' updates. Estimated performance, not measured usage. Weights are saved with the report.':'Weights need calculating for this roster and guidance setting. Weights update automatically for the selected roster and guidance setting.';
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
  const openName=()=>({500:'Little Cup',1500:'Great League',2500:'Ultra League',10000:'Master League'})[cp()];
  // The loaded population's name: the selected cup when its own published rankings are loaded, else the open league.
  const leagueName=()=>ownRankings(cupEntry)?cupEntry.name:openName();
  function rows(){if(!isCustom()&&published?.message)return [];return isCustom() && custom ? custom[$('proCategory').value] || [] : leagueData?.[$('proCategory').value] || [];}
  function eligibleRoster(){return [...weights].filter(([,value])=>value.accepted).map(([speciesId,value])=>({speciesId,weight:value.weight}));}
  function roster(){const eligible=eligibleRoster();return PvPPro.chooseCandidates(eligible,leagueData?.overall||[],$('proAllCandidates').checked?null:Math.max(2,Math.min(10000,Math.floor(Number($('proCandidateLimit').value)||2))));}
  function previewOpponents(){return PvPPro.chooseOpponents(roster(),$('proAllOpponents').checked?null:Math.max(2,Math.min(10000,Math.floor(Number($('proOpponentLimit').value)||2))),Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1])));}
  async function json(path){if(cache.has(path))return cache.get(path);const r=await fetch('includes/pro/data/'+path);if(!r.ok)throw new Error('Unable to load bundled PvPoke data: '+path);const result=await r.json();cache.set(path,result);return result;}
  function stop(){clearTimeout(autoWeightTimer);if(worker){worker.terminate();worker=null;}$('proApplyScore').disabled=!custom?._targets?.length;$('proAddScore').disabled=false; $('proCancel').hidden=true;$('proGenerate').disabled=filterPending||loadedCp!==cp()||roster().filter(row=>row.weight>0).length<2;}
  function invalidate(){generatedSnapshot=null;activeSaved='';updateSavedControls();stop();custom=null;$('proSource').value='published';$('proSource').querySelector('option[value=custom]').disabled=true;$('proSource').querySelector('option[value=custom]').hidden=true;$('proRunSummary').textContent='';updateSavedControls();if(leagueData)render();status('Roster changed. Generate rankings to apply your selection and weights.');}
  function prepareSearch(league,request){
    if(searchWorker){searchWorker.terminate();searchWorker=null;}
    searchError='';searchIndex=searchCache.get(league+'|'+loadedCup)||null;$('proSearchStatus').textContent=searchIndex?'PvPoke search syntax supported.':'Preparing PvPoke search…';
    if(searchIndex)return;
    const current=new Worker('includes/pro/worker.js');searchWorker=current;
    current.onmessage=event=>{if(current!==searchWorker||loading!==request)return;const result=event.data;current.terminate();searchWorker=null;
      if(result.type==='error'){searchError='Search unavailable: '+result.error;$('proSearchStatus').textContent=searchError;render();return;}
      searchIndex=new Map(result.records.map(record=>[record.id,record]));searchCache.set(league+'|'+loadedCup,searchIndex);$('proSearchStatus').textContent='PvPoke search syntax supported.';render();
    };
    current.onerror=event=>{current.terminate();searchWorker=null;searchError='Search unavailable: '+event.message;$('proSearchStatus').textContent=searchError;render();};
    current.postMessage({mode:'searchIndex',data,cp:league,published:leagueData.overall,meta:leagueMeta});
  }
  let leagueMeta=[];
  const bundledFor=league=>Promise.all([json('league-'+league+'.json'),json('overrides-'+league+'.json')]);
  // Published rankings for a cup: bundled for the CP's default cup, else read from PvPoke at the pinned commit (cached).
  async function publishedFor(cup,league){
    const key=cup+'|'+league;if(cupCache.has(key))return cupCache.get(key);
    let result;
    try{result=await C.loadPublished({cup,cp:league,index:cupIndex,bundled:()=>bundledFor(league),fetch:url=>fetch(url)});cupCache.set(key,result);}
    catch(error){result={status:'error',error:error.message};}
    return result;
  }
  async function load(){
    ensureObserved();cupDirty=false;
    PvPProDetail.cancel();$('proBattlePanel').hidden=true;renderedDetail=null;
    if(searchWorker){searchWorker.terminate();searchWorker=null;}searchIndex=null;
    generatedSnapshot=null;activeSaved='';updateSavedControls();
    clearTimeout(filterTimer);if(filterWorker){filterWorker.terminate();filterWorker=null;}filterPending=false;selectedKey='';loadedCp=0;selected='';leagueData=null;weights.clear();calculatedModel=null;stop();$('proRankings').textContent='Loading league…';$('proDetail').textContent='Loading Pokémon details…';const league=cp(),request=++loading,entry=cupEntry&&cupEntry.cp===league?cupEntry:null,want=entry?entry.rankingCup:C.DEFAULT_CUPS[league];
    status(C.isBundled(want,league)?'Loading published PvPoke rankings…':'Loading published '+entry.name+' rankings from PvPoke’s repository…');$('proGenerate').disabled=true;
    try{
      const result=await Promise.all([data?Promise.resolve(data):json('gamemaster.json'),publishedFor(want,league),json('meta-'+league+'.json')]);
      if(loading!==request)return;
      let pub;[data,pub,leagueMeta]=result;
      // No published rankings for the cup (or GitHub failed): the population is the CP's bundled default, so the
      // builder can still apply the cup's rules; the published view shows the message instead of a table.
      const base=pub.league?pub:await bundledFor(league).then(([l,o])=>({league:l,overrides:o}));
      if(loading!==request)return;
      leagueData=base.league;overrides=base.overrides;loadedCup=pub.league?want:C.DEFAULT_CUPS[league];
      published={...pub,cup:want,cp:league,message:pub.status==='missing'?C.missingMessage(entry||{name:want,cp:league,rankingCup:want},openName()):pub.status==='error'?'Could not load PvPoke’s published '+(entry?.name||want)+' rankings: '+pub.error+' Create custom rankings to rank the cup from the '+openName()+' population.':''};
      loadedCp=league;custom=null;page=0;selected='';$('proSource').value='published';$('proSource').querySelector('option[value=custom]').disabled=true;$('proSource').querySelector('option[value=custom]').hidden=true;
      weights=new Map(leagueData.overall.map((row,i)=>[row.speciesId,{accepted:true,weight:1}]));
      $('proCategory').replaceChildren(...Object.keys(leagueData).map(category=>{const option=el('option',category[0].toUpperCase()+category.slice(1));option.value=category;return option;}));
      filters=[{filterType:'type',values:[...choices.type]}];syncPreset(false);
      $('proSource').querySelector('option[value=published]').textContent=leagueName();
      $('proSpeciesIds').replaceChildren(...leagueData.overall.map(row=>{const option=el('option',row.speciesName);option.value=row.speciesId;return option;}));
      $('proMoveIds').replaceChildren(...data.moves.map(row=>{const option=el('option',row.name);option.value=row.moveId;return option;}));
      $('proSearchTraits').textContent=[...data.pokemonTraits.pros,...data.pokemonTraits.cons].join(' · ');
      prepareSearch(league,request);renderFilters();renderRoster();render();scheduleFilter();status(published.message?(published.status==='missing'?'No published rankings for '+(entry?.name||want)+'.':'Published rankings unavailable.'):leagueName()+' rankings loaded'+(published.status==='fetched'?' from PvPoke’s repository at '+C.SHA.slice(0,7)+'.':'.'));
      $('proGenerate').disabled=filterPending;
    }catch(error){if(loading===request)status(error.message);}
  }
  // The app router (includes/app-tabs.js) announces each view; published rankings load on the first visit to Current.
  document.addEventListener('pvp-view-change',event=>{const route=event.detail||{};if(route.app==='pro'&&route.proView==='rankings'&&route.mode==='current'&&!data)load();});
  $('proLeague').addEventListener('change',()=>{cupEntry=null;cupAuto=true;sourceRequest++;load();});
  function toggleSpecies(id){
    const accepted=weights.get(id).accepted;let filter=filters.find(f=>f.filterType==='id');if(!filter){filter={filterType:'id',values:[],excludedValues:[]};filters.push(filter);}
    filter.excludedValues=filter.excludedValues||[];filter.raw=undefined;filter.error='';
    if(accepted){filter.values=filter.values.filter(v=>v!==id);if(!filter.excludedValues.includes(id))filter.excludedValues.push(id);}else{filter.excludedValues=filter.excludedValues.filter(v=>v!==id);if(!filter.values.includes(id))filter.values.push(id);}
    weights.get(id).accepted=!accepted;renderFilters();renderRoster();scheduleFilter();
  }
  function renderRoster(){
    const query=$('proRosterSearch').value.trim().toLowerCase(),host=$('proRoster');host.replaceChildren();
    const selectedIds=new Set(roster().map(r=>r.speciesId)),ranks=new Map(leagueData.overall.map((r,i)=>[r.speciesId,i+1]));
    const cupIds=cupRosterState?.allowed,matches=leagueData.overall.filter(row=>(!cupIds||cupIds.has(row.speciesId))&&(row.speciesName.toLowerCase().includes(query)||row.speciesId.includes(query)));
    for(const row of matches){
      const state=weights.get(row.speciesId),selected=selectedIds.has(row.speciesId),limited=state.accepted&&!selected,button=el('button',null,'pro-pokemon-tile');button.type='button';button.setAttribute('aria-pressed',String(selected));button.setAttribute('aria-label',(selected?'Exclude ':limited?'Outside candidate limit: ':'Include ')+row.speciesName);
      button.append(el('span',selected?'✓':'+','pro-tile-check'),el('span',row.speciesName,'pro-tile-name'));const rank=el('small','#'+ranks.get(row.speciesId),'pro-tile-rank');rank.title=leagueName()+' · published PvPoke rank '+ranks.get(row.speciesId);button.append(rank);button.dataset.type=data.pokemon.find(p=>p.speciesId===row.speciesId)?.types?.[0];
      button.title=limited?'Outside the top-ranked candidate limit. Increase the limit or narrow the filters to include this Pokémon.':rank.title;button.addEventListener('click',()=>{if(limited){$('proPreviewStatus').textContent=button.title;return;}toggleSpecies(row.speciesId);});host.append(button);
    }
    $('proPreviewStatus').textContent=matches.length.toLocaleString()+' Pokémon shown'+(cupIds?' (outside '+preset.name+' hidden)':'')+' · '+selectedIds.size+' ranking candidates · '+eligibleRoster().length+' eligible before the rank limit.';updateRosterCount();renderWeightControls();renderOpponentPreview();
  }
  function renderOpponentPreview(){
    if(!leagueData)return;
    const candidates=roster(),selected=new Set(previewOpponents().map(r=>r.speciesId)),pending=weightMode()==='calculate'&&!currentWeightModel(),query=$('proOpponentSearch').value.trim().toLowerCase();
    const ordered=PvPPro.chooseOpponents(candidates,10000,Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1]))),host=$('proOpponentPreview');host.replaceChildren();
    for(const row of ordered){if(query&&!name(row.speciesId).toLowerCase().includes(query)&&!row.speciesId.includes(query))continue;const included=selected.has(row.speciesId),tile=el('div',null,'pro-pokemon-tile');tile.setAttribute('aria-pressed',String(included));tile.setAttribute('aria-label',(included?'Included opponent: ':'Excluded opponent: ')+name(row.speciesId));tile.dataset.type=data.pokemon.find(p=>p.speciesId===row.speciesId)?.types?.[0];tile.append(el('span',included?'✓':'−','pro-tile-check'),el('span',name(row.speciesId),'pro-tile-name'),el('small',pending?'—':formatWeight(row.weight)+'×','pro-tile-weight'));tile.title=pending?'Provisional selection using tapered PvPoke priors; calculate weights to finalize.':name(row.speciesId)+' · opponent weight '+row.weight+'×';host.append(tile);}
    $('proOpponentPreviewCount').textContent=selected.size+' / '+candidates.length+' opponents';$('proOpponentPreviewStatus').textContent=pending?'Updating calculated weights. The top-N opponent preview will refresh automatically when ready.':selected.size+' opponents selected by '+(weightMode()==='equal'?'equal weights, with PvPoke default weights breaking ties':weightMode()==='calculate'?'calculated weights':weightMode()==='observed'&&lastObserved?'observed usage weights':'PvPoke default weights')+'. Dimmed Pokémon remain ranking candidates.';
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
    const limits={},policy='top',topN=movesLimit();
    try{PvPPro.chooseOpponents(accepted,$('proAllOpponents').checked?null:Number($('proOpponentLimit').value));}catch(error){status(error.message);return;}
    try{PvPPro.selectCandidates([],policy,topN);}catch(error){status(error.message);return;}
    stop();worker=new Worker('includes/pro/worker.js');const current=worker;renderWeightControls();
    $('proGenerate').disabled=true;$('proCancel').hidden=false;
    status(mode==='weights'?'Simulating the recommended roster to estimate meta weights…':'Projecting and ranking moveset combinations against recommended opponents…');
    const scope=weightScope(),model=currentWeightModel();
    const observed=weightMode()==='observed'?observedInfo(lastObserved,accepted.map(r=>r.speciesId)):null,effectiveMode=weightMode()==='observed'&&!observed?'default':weightMode();
    const context=accepted.length+' accepted Pokémon · '+$('proLeague').selectedOptions[0].textContent+(preset?' · '+O.presetLabel(preset):'')+' · five ranking scenarios'+' · '+(weightMode()==='calculate'?'Calculated weights ('+$('proWeightGuidance').value+'% PvPoke guidance)':weightMode()==='equal'?'Equal weights':observed?'Observed usage weights ('+observed.selection.label+' · '+observed.lineups.toLocaleString()+' settled lineups, prior strength '+observed.priorStrength+')':'PvPoke default weights');
    current.onmessage=event=>{
      if(worker!==current)return;
      const result=event.data;
      if(result.type==='progress'){status(result.text);return;}
      if(result.type==='error'){stop();renderWeightControls();status('Calculation failed: '+result.error);return;}
      if(result.type==='weights'){calculatedModel={...result.model,scope};for(const entry of result.model.entries)weights.get(entry.speciesId).weight=entry.weight;if(mode==='weights'){stop();renderRoster();status('Calculated weights ready. Generate to apply them to the rankings.');}else renderRoster();return;}
      if(result.type==='result'){
        activeSaved='';$('proSavedName').value='';selectedKey='';custom={_targets:result.targets,_weightModel:result.weightModel,_weightSettings:{mode:effectiveMode,guidance:Number($('proWeightGuidance').value)/100},...(observed?{_observedWeights:observed}:{}),...(preset?{_cupPreset:{key:preset.key,label:O.presetLabel(preset)}}:{}),overall:result.rows,...Object.fromEntries(result.categories.map(item=>[item.slug,item.rows]))};
        $('proSource').querySelector('option[value=custom]').disabled=false;$('proSource').querySelector('option[value=custom]').hidden=false;$('proSource').value='custom';$('proCategory').value='overall';page=0;render();
        $('proGeneratedContext').textContent='Generated: '+context+'. All selected movesets versus recommended-only opponents. Rectangular PvPoke-style scores; editor adjustments are not applied.';const summary=result.summary;
        $('proRunSummary').textContent=summary.selectedCombinations+' / '+summary.totalCombinations+' combinations ranked · '+summary.opponents+' recommended opponents · '+summary.simulations.toLocaleString()+' simulated battles'+(summary.scoutOpponents?' · Scout sample: '+summary.scoutOpponents+' opponents; recommended moveset retained':'')+(summary.fallbacks?' · '+summary.fallbacks+' scoring rows/passes used the zero-meta-weight fallback':'')+'.';
        generatedSnapshot={rankings:custom,context:$('proGeneratedContext').textContent,summary:$('proRunSummary').textContent};
        openBuilder(false);status('Custom ranking generation complete.');
      }
      stop();renderWeightControls();
    };
    current.onerror=event=>{stop();renderWeightControls();status('Calculation failed: '+event.message);};
    current.postMessage({mode,data,opponentLimit:$('proAllOpponents').checked?null:Number($('proOpponentLimit').value),weightMode:weightMode(),weightGuidance:Number($('proWeightGuidance').value)/100,defaultWeights:Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1])),weightModel:mode==='weights'?null:model,cp:cp(),published:leagueData.overall,roster:accepted,policy,topN,limits});
  }
  $('proGenerate').addEventListener('click',()=>launch('generate'));$('proCancel').addEventListener('click',()=>{stop();renderWeightControls();status('Calculation cancelled.');});
  $('proCategory').addEventListener('change',()=>{clearTimeout(headerClickTimer);page=0;sortKey='score';descending=true;expandedKey='';pendingDifference=null;render();});
  $('proSource').addEventListener('change',selectSource);
  $('proSearch').addEventListener('input',()=>{page=0;render();});
  $('proPrev').addEventListener('click',()=>{page--;render();});$('proNext').addEventListener('click',()=>{page++;render();});
  function comparison(row){
    const recommended=leagueData?.overall.find(item=>item.speciesId===row.speciesId);
    if(!isCustom())return PvPPro.compareMoveset(row,leagueData?.[$('proCategory').value]?.find(item=>item.speciesId===row.speciesId),row.score);
    const baseline=rows().find(item=>item.speciesId===row.speciesId&&PvPPro.sameMoveset(item.moveset,recommended?.moveset));
    return PvPPro.compareMoveset(row,recommended,baseline?.score,row.score);
  }
  function movesetBadge(comparison,row){
    if(!comparison)return null;
    const wrap=el('span',null,'pro-moveset-comparison');
    const gain=comparison.delta<.1?'<0.1':comparison.delta?.toFixed(1);
    const text=comparison.kind==='recommended'?'Recommended':'Alternate Moveset'+(comparison.kind==='better'?' · Beats recommended by '+gain+' points':'');
    const badge=el('span',text,'pro-moveset-badge');wrap.append(badge);
    badge.title=comparison.kind==='recommended'?'PvPoke recommended moveset (charged move order ignored).':comparison.baselineScore==null?'Recommended moveset is not present in this saved report; a score comparison is unavailable.':'Recommended moveset score in this report: '+comparison.baselineScore.toFixed(1)+'. Compared in the current category against the same opponents.';
    if(comparison.kind!=='recommended'&&row){const recommended=leagueData?.overall.find(item=>item.speciesId===row.speciesId);if(recommended)wrap.append(el('span','Recommended: '+recommended.moveset.filter(id=>id!=='none').map(move).join(' · '),'pro-recommended-reference'));}
    return wrap;
  }
  // Compare with snapshot (Current): optional Old rank / Old score / Change columns from PvPoke's published
  // rankings on an earlier date, loaded with the Historical engine (includes/analysis/data.js and core.js).
  // Off by default; nothing is fetched until the columns are added. Each league and category loads once.
  const compare={info:null,tables:new Map(),controller:null};
  const compareKey=()=>cp()+'|'+loadedCup+'|'+$('proCategory').value;
  const compareTable=()=>compare.info?compare.tables.get(compareKey()):undefined;
  const compareStatus=text=>{$('proCompareStatus').textContent=text;};
  const categoryName=()=>$('proCategory').selectedOptions[0]?.textContent||'Overall';
  function snapshotTitle(id){const when='PvPoke '+compare.info.date+' (commit '+compare.info.sha.slice(0,7)+')';return id==='snap:rank'?'Published rank at '+when:id==='snap:score'?'Published score at '+when+'. Scores refer to the recommended moveset.':'Score that sets rank minus the published score at '+when+'.';}
  function describeCompare(){
    const info=compare.info,table=compareTable(),commit=' · commit '+info.sha.slice(0,7)+' from '+new Date(info.committed).toLocaleDateString(undefined,{timeZone:'UTC'});
    if(table?.error)return 'Could not load the snapshot rankings. '+table.error;
    if(table===null)return 'No published '+leagueName()+' · '+categoryName()+' rankings at the '+info.date+' snapshot'+commit+'.';
    return 'Comparing with PvPoke '+info.branch+' on '+info.date+commit+'. Rows missing from the snapshot show New.';
  }
  function updateCompareControls(){
    const active=!!compare.info;$('proCompareToggle').dataset.active=String(active);
    $('proCompareToggle').textContent=active?'Snapshot · '+compare.info.date:'Compare with snapshot';
    $('proCompareApply').textContent=active?'Update comparison':'Add comparison columns';$('proCompareClear').hidden=!active;
  }
  function openCompare(open){$('proComparePanel').hidden=!open;$('proCompareToggle').setAttribute('aria-expanded',String(open));if(open)$('proCompareDate').focus();}
  async function loadCompareTable(){
    const info=compare.info,tables=compare.tables,key=compareKey(),category=$('proCategory').value,league=cp();
    if(!info||tables.has(key))return;
    tables.set(key,'loading');compareStatus('Loading '+leagueName()+' · '+categoryName()+' rankings from '+info.date+'…');
    try{const rankings=await PvPokeData.loadRankings({...info,cup:loadedCup||'all'},league,category,compare.controller.signal);tables.set(key,rankings?PvPokeAnalysis.snapshotLookup(rankings):null);}
    catch(error){if(error.name==='AbortError'){tables.delete(key);return;}tables.set(key,{error:error.message});}
    if(compare.info!==info)return;
    if(leagueData)render();else if(compareKey()===key)compareStatus(describeCompare());
  }
  async function applyCompare(){
    const date=$('proCompareDate').value,today=new Date().toISOString().slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T00:00:00Z'))){compareStatus('Choose a snapshot date.');$('proCompareDate').focus();return;}
    if(date>today){compareStatus('Choose today or an earlier date.');$('proCompareDate').focus();return;}
    compare.controller?.abort();const controller=compare.controller=new AbortController();
    $('proCompareApply').disabled=true;compareStatus('Finding the PvPoke commit for '+date+'…');
    try{
      const resolved=await PvPokeData.resolveSnapshot({branch:'master',cup:'all',date},controller.signal);
      if(compare.controller!==controller)return;
      compare.info={...resolved,date};compare.tables=new Map();updateCompareControls();
      await loadCompareTable();
    }catch(error){if(compare.controller===controller&&error.name!=='AbortError')compareStatus('Could not find that snapshot. '+error.message);}
    finally{if(compare.controller===controller)$('proCompareApply').disabled=false;}
  }
  function clearCompare(){
    compare.controller?.abort();compare.controller=null;compare.info=null;compare.tables=new Map();updateCompareControls();
    $('proCompareApply').disabled=false;compareStatus('Comparison columns removed.');
    if(sortKey.startsWith('snap:')){sortKey='score';descending=true;}
    if(leagueData)render();
  }
  function snapshotCell(cell,header,v,comp){
    if(header.first)cell.classList.add('pro-snapshot-first');
    if(header.id==='snap:rank'){if(Number.isFinite(v)){cell.textContent=v;return;}cell.textContent='New';cell.classList.add('pro-snapshot-new');cell.title='Not in the published '+leagueName()+' rankings at this snapshot.';return;}
    if(header.id==='snap:score'){cell.textContent=Number.isFinite(v)?v.toFixed(1):'—';if(Number.isFinite(v)){cell.classList.add('rated-cell');cell.style.setProperty('--rating-hue',Math.max(0,Math.min(130,v*1.3)));}return;}
    cell.textContent=Number.isFinite(v)?(v>0?'+':'')+v.toFixed(1):'—';cell.classList.add('pro-score-difference');if(v>0)cell.classList.add('positive');else if(v<0)cell.classList.add('negative');
    if(isCustom()&&['alternate','better'].includes(comp?.kind))cell.title='This row uses an alternate moveset; the snapshot score refers to the recommended moveset.';
  }
  {const earlier=new Date();earlier.setUTCDate(earlier.getUTCDate()-90);$('proCompareDate').value=earlier.toISOString().slice(0,10);$('proCompareDate').max=new Date().toISOString().slice(0,10);}
  $('proCompareToggle').addEventListener('click',()=>openCompare($('proComparePanel').hidden));
  $('proCloseCompare').addEventListener('click',()=>{openCompare(false);$('proCompareToggle').focus();});
  $('proCompareApply').addEventListener('click',applyCompare);
  $('proCompareClear').addEventListener('click',clearCompare);
  $('proCompareDate').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyCompare();}});
  $('proOpenHistorical').addEventListener('click',()=>{if(compare.info||$('proCompareDate').value)$('previousDate').value=compare.info?.date||$('proCompareDate').value;globalThis.PvPTabs?.show({app:'pro',proView:'rankings',mode:'historical'});});
  function render(){
    updateSavedControls();
    let list=rows();if(!list.length){$('proRankings').textContent=!isCustom()&&published?.message?published.message:'Load a league to view rankings.';$('proDetailParking').hidden=true;document.querySelector('.pro-layout').classList.remove('pro-has-details','pro-has-battle');PvPProDetail.cancel();renderedDetail=null;return;}
    const query=$('proSearch').value.trim().toLowerCase();
    if(!selected || !list.some(row=>row.speciesId===selected))selected=list[0].speciesId;
    if(!list.some(row=>rowKey(row)===selectedKey))selectedKey=rowKey(list.find(row=>row.speciesId===selected)||list[0]);
    const columns=scoreColumns(),columnMaps=new Map(columns.map(c=>[c.id,c.scores[$('proCategory').value]||{}]));
    const differences=(custom?._differenceColumns||[]).filter(d=>columnMaps.has(d.left)&&columnMaps.has(d.right));
    const scoreValue=(row,id)=>id==='primary'?row.score:columnMaps.get(id)?.[row.variantId];
    const snapshot=compareTable(),snap=snapshot instanceof Map?snapshot:null;if(compare.info&&snapshot===undefined)loadCompareTable();
    if(compare.info&&snapshot!==undefined&&snapshot!=='loading'){const text=describeCompare();if($('proCompareStatus').textContent!==text)compareStatus(text);}
    // Change compares the score that sets rank (the leftmost score column) with the snapshot's published score.
    const snapshotValue=(row,key)=>{const old=snap?.get(row.speciesId);if(key==='snap:rank')return old?.rank;if(key==='snap:score')return old?.score??undefined;return PvPokeAnalysis.scoreChange(rankColumn?scoreValue(row,rankColumn.id):row.score,old?.score)??undefined;};
    const value=(row,key)=>{if(key==='speciesName')return row.speciesName;if(key==='score')return row.score;if(key.startsWith('score:'))return scoreValue(row,key.slice(6));if(key.startsWith('snap:'))return snapshotValue(row,key);const d=differences.find(d=>'diff:'+d.id===key);return d?scoreValue(row,d.left)-scoreValue(row,d.right):undefined;};
    if(!['score','speciesName'].includes(sortKey)&&!columns.some(c=>'score:'+c.id===sortKey)&&!differences.some(d=>'diff:'+d.id===sortKey)&&!(snap&&sortKey.startsWith('snap:')))sortKey='score';
    const baseHeaders=[{id:'rank',label:'Rank'},{id:'pokemon',label:'Pokémon',key:'speciesName'},...(columns.length?columns.map(c=>({id:'score:'+c.id,label:'Score ('+c.label+')',key:'score:'+c.id,column:c})):[{id:'score',label:'Score',key:'score'}]),...differences.map(d=>({id:'diff:'+d.id,label:'Difference ('+columns.find(c=>c.id===d.left).label+' − '+columns.find(c=>c.id===d.right).label+')',key:'diff:'+d.id,difference:d})),{id:'moves',label:isCustom()?'Moveset':'Recommended moveset'}];
    const order=PvPPro.rankingColumnOrder(baseHeaders.map(h=>h.id),isCustom()?custom?._columnOrder||[]:[]),headers=order.map(id=>baseHeaders.find(h=>h.id===id));
    if(snap){const last=headers.reduce((at,h,i)=>h.key&&(h.key==='score'||h.key.startsWith('score:')||h.key.startsWith('diff:'))?i:at,1);headers.splice(last+1,0,{id:'snap:rank',label:'Old rank',key:'snap:rank',snapshot:true,first:true},{id:'snap:score',label:'Old score',key:'snap:score',snapshot:true},{id:'snap:change',label:'Change',key:'snap:change',snapshot:true});}
    const ranked=rows().slice(),rankColumn=headers.find(h=>h.column)?.column;
    if(rankColumn&&sortKey==='score')sortKey='score:'+rankColumn.id;
    if(rankColumn)ranked.sort((a,b)=>(scoreValue(b,rankColumn.id)??-Infinity)-(scoreValue(a,rankColumn.id)??-Infinity)||a.speciesName.localeCompare(b.speciesName)||rowKey(a).localeCompare(rowKey(b)));
    const rankMap=new Map(ranked.map((row,i)=>[rowKey(row),i+1]));
    if($('proRankBestOnly').checked&&isCustom()){const seen=new Set();list=list.slice().sort((a,b)=>rankMap.get(rowKey(a))-rankMap.get(rowKey(b))).filter(row=>{if(seen.has(row.speciesId))return false;seen.add(row.speciesId);return true;});}
    const matches=PvPProSearch.compile(query,data);
    const filtered=query?(searchIndex?list.filter(row=>matches(row,searchIndex)):[]):list.slice();
    filtered.sort((a,b)=>{if(sortKey==='speciesName')return a.speciesName.localeCompare(b.speciesName)*(descending?-1:1);const x=value(a,sortKey),y=value(b,sortKey),missingX=!Number.isFinite(x),missingY=!Number.isFinite(y);if(missingX||missingY)return missingX===missingY?0:missingX?1:-1;return (x-y)*(descending?-1:1);});
    const pages=Math.max(1,Math.ceil(filtered.length/rankingPageSize));page=Math.max(0,Math.min(page,pages-1));
    document.querySelector('.pro-layout').classList.toggle('pro-has-score-columns',columns.length>1||!!snap);
    const table=el('table',null,'pro-ranking-table'+(columns.length>1||snap?' pro-score-table':''));table.append(el('caption',(activeSaved?(savedRankings.find(item=>item.id===activeSaved)?.name||'Saved'):(isCustom()?'Generated':leagueName()))+' · '+$('proCategory').selectedOptions[0].textContent+(isCustom()?' · '+$('proLeague').selectedOptions[0].textContent:'')+(snap?' · compared with PvPoke '+compare.info.date:'')));
    const head=table.createTHead().insertRow();
    for(const {id,label,key,column,difference,snapshot:snapshotHeader,first} of headers){const th=el('th');th.scope='col';if(first)th.classList.add('pro-snapshot-first');if(snapshotHeader)th.title=snapshotTitle(id);if(column&&column.id===rankColumn?.id){th.classList.add('pro-rank-basis');const indicator=el('span','Rank basis','pro-rank-basis-label');th.append(indicator);}
      if(key){const button=el('button',label+(sortKey===key?(descending?' ↓':' ↑'):' ↕'),'column-sort');button.type='button';button.addEventListener('click',()=>{clearTimeout(headerClickTimer);if(pendingDifference&&column){addDifference(pendingDifference,column.id);return;}headerClickTimer=setTimeout(()=>{descending=sortKey===key?!descending:!['speciesName','snap:rank'].includes(key);sortKey=key;render();},260);});th.append(button);th.setAttribute('aria-sort',sortKey===key?(descending?'descending':'ascending'):'none');}else th.textContent=label;
      if(column){th.addEventListener('dblclick',event=>{if(event.target.closest('.pro-info-button,.pro-remove-score'))return;clearTimeout(headerClickTimer);editingColumn=column.id;$('proColumnTitle').textContent='Score ('+column.label+')';$('proColumnDialog').showModal();});const info=el('button','i','pro-info-button');info.type='button';info.setAttribute('aria-label','Information for Score ('+column.label+')');info.addEventListener('click',()=>previewScore(column));th.append(info);if(column.id!=='primary'){const remove=el('button','×','pro-remove-score');remove.type='button';remove.setAttribute('aria-label','Remove Score ('+column.label+')');remove.addEventListener('click',()=>{custom._scoreColumns=custom._scoreColumns.filter(c=>c.id!==column.id);custom._differenceColumns=differences.filter(d=>d.left!==column.id&&d.right!==column.id);persistColumnView();});th.append(remove);}}
      if(difference){const remove=el('button','×','pro-remove-score');remove.type='button';remove.setAttribute('aria-label','Remove '+label);remove.addEventListener('click',()=>{custom._differenceColumns=differences.filter(d=>d.id!==difference.id);persistColumnView();});th.append(remove);}
      if(isCustom()&&!snapshotHeader){th.draggable=true;th.title='Drag to reorder'+(column?' · Double-click for score actions':'');th.addEventListener('dragstart',event=>{draggedColumn=id;event.dataTransfer.setData('text/plain',id);event.dataTransfer.effectAllowed='move';});th.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';});th.addEventListener('drop',event=>{event.preventDefault();const from=draggedColumn;if(!from||from===id)return;const ids=headers.filter(h=>!h.snapshot).map(h=>h.id);ids.splice(ids.indexOf(from),1);ids.splice(ids.indexOf(id),0,from);custom._columnOrder=ids;const firstScore=ids.find(id=>id.startsWith('score:'));if(firstScore!=='score:'+rankColumn?.id){sortKey=firstScore;descending=true;page=0;}draggedColumn=null;persistColumnView();});th.addEventListener('dragend',()=>{draggedColumn=null;});}head.append(th);
    }
    const detailHost=$('proDetail'),battleHost=$('proBattlePanel'),parking=$('proDetailParking');parking.append(detailHost,battleHost);detailHost.className='pro-sidebar-content';
    const body=table.createTBody();
    for(const row of filtered.slice(page*rankingPageSize,(page+1)*rankingPageSize)){
      const tr=body.insertRow(),comp=comparison(row);if(rowKey(row)===selectedKey)tr.classList.add('pro-selected');
      for(const header of headers){const cell=tr.insertCell();if(header.column&&header.column.id===rankColumn?.id)cell.classList.add('pro-rank-basis');if(header.id==='rank'){cell.textContent=rankMap.get(rowKey(row));continue;}if(header.id==='pokemon'){const button=el('button',row.speciesName,'pro-pokemon-button');button.type='button';button.setAttribute('aria-expanded',String(expandedKey===rowKey(row)));button.setAttribute('aria-controls','proDetail');button.addEventListener('click',()=>{selected=row.speciesId;selectedKey=rowKey(row);expandedKey=expandedKey===selectedKey?'':selectedKey;if(!expandedKey){PvPProDetail.cancel();renderedDetail=null;}render();if(expandedKey)$('proDetail').scrollIntoView({behavior:'smooth',block:'nearest'});});cell.append(button,PvPProDetail.pokemonTypes(data.pokemon.find(p=>p.speciesId===row.speciesId)));continue;}if(header.id==='moves'){cell.append(PvPProDetail.moves(row.moveset,data));const badge=movesetBadge(comp,row);if(badge&&isCustom())cell.append(badge);continue;}const v=value(row,header.key);if(header.snapshot){snapshotCell(cell,header,v,comp);continue;}cell.textContent=Number.isFinite(v)?(header.difference&&v>0?'+':'')+v.toFixed(1):'—';if(header.difference){cell.className='pro-score-difference '+(v>0?'positive':v<0?'negative':'');const left=columns.find(c=>c.id===header.difference.left),right=columns.find(c=>c.id===header.difference.right);if(Number.isFinite(v)&&((left?.mode==='published')!==(right?.mode==='published'))&&['alternate','better'].includes(comp?.kind)){const badge=el('span','Alternate Moveset','pro-moveset-badge pro-difference-moveset-badge');badge.title='This row uses an alternate moveset. The published PvPoke score refers to the recommended moveset.';cell.append(badge);}}else{cell.classList.add('rated-cell');cell.style.setProperty('--rating-hue',Math.max(0,Math.min(130,(v||0)*1.3)));if(header.column?.mode==='published')cell.title='Published PvPoke score for the recommended moveset; shared by all variants of this species.';}}
    }
    if(!filtered.length){const cell=body.insertRow().insertCell();cell.colSpan=headers.length;cell.textContent=query&&!searchIndex?(searchError||'Preparing search data…'):'No Pokémon match this search.';}
    $('proRankings').replaceChildren(table);$('proPagination').textContent=filtered.length+' Pokémon · Page '+(page+1)+' / '+pages+' · '+rankingPageSize+' per page';$('proPrev').disabled=page===0;$('proNext').disabled=page===pages-1;
    if(!selected || !list.some(row=>row.speciesId===selected))selected=list[0].speciesId;
    const expanded=filtered.slice(page*rankingPageSize,(page+1)*rankingPageSize).find(row=>rowKey(row)===expandedKey);parking.hidden=!expanded;document.querySelector('.pro-layout').classList.toggle('pro-has-details',!!expanded);if(expanded)renderDetail(expanded);else{PvPProDetail.cancel();renderedDetail=null;battleHost.hidden=true;document.querySelector('.pro-layout').classList.remove('pro-has-battle');}
    $('proGeneratedContext').hidden=!isCustom();
  }
  let renderedDetail;
  function renderDetail(row){
    if(!row)return;const identity=[row,cp(),$('proSource').value,$('proCategory').value];if(renderedDetail&&identity.every((v,i)=>v===renderedDetail[i]))return;renderedDetail=identity;selected=row.speciesId;const p=data.pokemon.find(item=>item.speciesId===row.speciesId),host=$('proDetail');host.replaceChildren();const summary=el('div',null,'pro-inline-summary');
    if(row.stats)summary.append(el('p','Attack '+row.stats.atk+' · Defense '+row.stats.def+' · HP '+row.stats.hp,'hint'));
    if(row.editorNotes)summary.append(el('p',row.editorNotes,'hint'));
    const targets=isCustom()?(custom._targets||[...new Set(custom.overall.map(r=>r.speciesId))].map(speciesId=>({speciesId,weight:1,moveset:leagueData.overall.find(r=>r.speciesId===speciesId)?.moveset}))).filter(t=>t.moveset):leagueData.overall.map(r=>({speciesId:r.speciesId,moveset:r.moveset,weight:1}));
    PvPProDetail.mount({host,data,cp:cp(),published:leagueData.overall,row,category:$('proCategory').value,targets,custom:isCustom(),historical:isCustom()&&!custom._targets,
      categoryRow:slug=>custom?.[slug]?.find(r=>rowKey(r)===rowKey(row)),battleHost:$('proBattlePanel')});host.querySelector('.pro-move-info').after(summary);
  }
  function updateSavedControls(){
    const available=!!custom&&isCustom();
    $('proRankingOptions').hidden=!available;$('proRankingOptionsTitle').textContent=activeSaved?'Edit Saved Ranking':'Save Ranking & Options';$('proSavedControls').hidden=!available;$('proBestFilter').hidden=!available;$('proMovesetLegend').hidden=true;
    $('proAddScore').hidden=!available||!custom?._targets?.length;$('proAddScore').disabled=!!worker;$('proApplyScore').disabled=!!worker||!available;
    if(available)$('proRankingOptions').append($('proStatus'));else $('proRankPanel').before($('proStatus'));
    $('proStatus').hidden=$('proBuilder').hidden&&!available;
    $('proRunSummary').hidden=!available;
    $('proSaveRanking').disabled=saveBusy||!available;
    $('proSaveRanking').textContent=activeSaved?'Save a copy':'Save rankings';
    $('proRenameRanking').hidden=!activeSaved;$('proDeleteRanking').hidden=!activeSaved;
    $('proRenameRanking').disabled=saveBusy;$('proDeleteRanking').disabled=saveBusy;
  }
  const scoreMode=()=>document.querySelector('input[name=proScoreMode]:checked').value;
  const scoreRules=column=>column.mode==='published'?'Published PvPoke score':column.mode==='calculate'?'Calculate with '+Math.round(column.guidance*100)+'% PvPoke guidance':column.mode==='equal'?'Equal':column.mode==='manual'?'Individual weights':column.mode==='observed'?'Observed usage weights'+(column.observed?' · '+column.observed.selection.label:''):'Default (PvPoke weights)';
  function primaryScore(){
    if(!custom)return null;
    if(!custom._primaryScore){const settings=custom._weightSettings,context=$('proGeneratedContext').textContent;const mode=settings&&settings.mode!=='original'?settings.mode:custom._weightModel?'calculate':context.includes('Equal weights')?'equal':'default';custom._primaryScore=PvPPro.scoreColumn(custom,{id:'primary',mode,guidance:settings?.guidance??custom._weightModel?.guidance??.75});if(mode==='observed')Object.assign(custom._primaryScore,{label:'Observed',observed:custom._observedWeights||null});}
    return custom._primaryScore;
  }
  // Observed weights for a stored report's opponents: the report's own cup/season selection, else the builder's.
  function observedForReport(report){
    const saved=report._observedWeights?.selection,sel=saved?{...saved,name:saved.label}:selection();
    if(!usage)throw new Error('Observed usage is unavailable here. Use the local app, or import a usage file in the builder’s Battle opponents section.');
    if(!sel||sel.cp!==cp())throw new Error('No observed cup selection for this league.');
    // Same split and normalization as the report's roster: its sibling Shadow/base forms and PvPoke total (else today's roster).
    const ids=report._targets.map(t=>t.speciesId),g=O.group(usage,sel.cp,sel.cup,sel.season),pvpoke=Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight]));
    const accepted=[...weights].filter(([,s])=>s.accepted).map(([id])=>id),forms=report._observedWeights?.forms||ids.map(sibling).filter(id=>weights.get(id)?.accepted&&!ids.includes(id));
    const priorTotal=report._observedWeights?.priorTotal??accepted.reduce((s,id)=>s+PvPPro.customWeight(pvpoke[id]),0);
    const m={...O.weights({ids:[...ids,...forms],pvpoke,group:g,priorStrength:report._observedWeights?.priorStrength??priorStrength(),priorTotal}),selection:saved?{cp:sel.cp,cup:sel.cup,season:sel.season,name:saved.label,periods:[]}:sel,group:g,source:usageSource,revision:usage.revision,generated:usage.generated};
    const info=observedInfo(m,ids);if(saved)info.selection=saved;return {weights:m.weights,info};
  }
  function scoreColumns(){return isCustom()&&custom?._targets?[primaryScore(),...(custom._scoreColumns||[])]:[];}
  function configureScore(){const mode=scoreMode();$('proScoreCalculateControls').hidden=mode!=='calculate';$('proScoreGuidanceValue').textContent=$('proScoreGuidance').value+'%';$('proScoreModeHint').textContent=mode==='observed'?(usage?'Meta Extractor usage for '+(custom?._observedWeights?.selection.label||O.presetLabel(selection())||'this league')+', smoothed toward PvPoke weights.':'Observed usage is unavailable here; import a usage file in the builder first.'):mode==='default'?'Uses bundled PvPoke weights; missing weights use 1.':mode==='equal'?'Every stored opponent has equal weight.':mode==='published'?'Uses the published category score for this league and recommended moveset. All variants of a species share that reference score.':'Estimates weights from stored recommended matchups against this report’s opponents.';}
  for(const node of document.querySelectorAll('input[name=proScoreMode],#proScoreGuidance'))node.addEventListener('input',configureScore);
  $('proAddScore').addEventListener('click',()=>{configureScore();$('proScoreStatus').textContent='';$('proAddScoreDialog').showModal();});
  $('proCloseAddScore').addEventListener('click',()=>$('proAddScoreDialog').close());
  $('proScoreWeightsInfo').addEventListener('click',()=>$('proWeightsHelp').showModal());
  let previewColumn=null;
  function observedRules(o){if(!o)return ' Observed-usage details were not retained for this score.';
    return ' Source: '+(o.source==='local'?'Meta Extractor (local app)':'imported usage file')+(o.generated?', generated '+o.generated.slice(0,10):'')+'. Sample: '+o.battles.toLocaleString()+' battles, '+o.lineups.toLocaleString()+' settled lineups, '+o.creators.toLocaleString()+' creators'+(o.first?', '+O.range(o.first,o.last):'')+(o.periods?.length?' (periods: '+periodList(o.periods)+')':'')+'. Prior strength '+o.priorStrength+' lineups: '+Math.round(100*o.observedFraction)+'% observed. Tiles: weight, share of observed lineups containing the Pokémon (“seen”) and its PvPoke share.'+(o.selection?.season==='all'?' All seasons pooled; metas change.':'');}
  function previewScore(column){if(column.mode==='published'){$('proScorePreviewTitle').textContent='Score (PvPoke)';$('proScorePreviewRules').textContent='Published '+leagueName()+' category scores from the bundled PvPoke ranking snapshot. Scores refer to each species’ recommended moveset, not the alternate moveset in this row. Different opponent pools and normalization can affect comparisons.';$('proScorePreviewGrid').replaceChildren();$('proScorePreviewCount').textContent='Published reference · no custom opponent weights';$('proScorePreviewSearch').hidden=true;$('proScorePreviewDialog').showModal();return;}$('proScorePreviewSearch').hidden=false;previewColumn=column;$('proScorePreviewSearch').value='';$('proScorePreviewTitle').textContent='Score ('+column.label+')';$('proScorePreviewRules').textContent=scoreRules(column)+' · '+column.targets.length+' opponents. These are the assigned weights used for this score.'+(column.mode==='calculate'?' Weight estimation pool: '+(column.model?.entries.length||column.targets.length)+' Pokémon.':'')+(column.mode==='observed'?observedRules(column.observed):'');renderScorePreview();$('proScorePreviewDialog').showModal();}
  function renderScorePreview(){const query=$('proScorePreviewSearch').value.trim().toLowerCase(),host=$('proScorePreviewGrid');host.replaceChildren();const targets=(previewColumn?.targets||[]).filter(t=>name(t.speciesId).toLowerCase().includes(query)||t.speciesId.includes(query));for(const t of targets){const tile=el('div',null,'pro-pokemon-tile');tile.dataset.type=data.pokemon.find(p=>p.speciesId===t.speciesId)?.types?.[0];tile.append(el('span','✓','pro-tile-check'),el('span',name(t.speciesId),'pro-tile-name'),el('small',formatWeight(t.weight)+'×','pro-tile-weight'));tile.title=name(t.speciesId)+' · '+t.weight+'×';
    const o=previewColumn.mode==='observed'?previewColumn.observed?.species?.[t.speciesId]:null;if(o){tile.append(el('small','seen '+pct(o.observed)+' · PvPoke '+pct(o.pvpoke),'pro-tile-observed'));tile.title+=' · in '+pct(o.observed)+' of observed lineups · PvPoke share '+pct(o.pvpoke);}host.append(tile);}$('proScorePreviewCount').textContent=targets.length+' / '+(previewColumn?.targets.length||0)+' opponents';}
  $('proScorePreviewSearch').addEventListener('input',renderScorePreview);$('proCloseScorePreview').addEventListener('click',()=>$('proScorePreviewDialog').close());
  $('proApplyScore').addEventListener('click',()=>{
    if(!custom?._targets?.length)return;
    const mode=scoreMode(),guidance=Number($('proScoreGuidance').value)/100;primaryScore();
    if(mode==='published'){const column=PvPPro.publishedScoreColumn(custom,leagueData,{id:crypto.randomUUID()});custom._scoreColumns=[...(custom._scoreColumns||[]),column];persistColumnView();$('proAddScoreDialog').close();return;}
    let observed=null;if(mode==='observed'){try{observed=observedForReport(custom);}catch(error){$('proScoreStatus').textContent=error.message;return;}}
    const source=custom;stop();worker=new Worker('includes/pro/worker.js');const current=worker;$('proApplyScore').disabled=true;$('proScoreStatus').textContent='Calculating scores from stored battles…';
    current.onmessage=event=>{if(worker!==current)return;const result=event.data;if(result.type==='error'){stop();$('proScoreStatus').textContent=result.error;return;}if(result.type!=='reweighted')return;
      const column=PvPPro.scoreColumn(result.report,{id:crypto.randomUUID(),mode,guidance});if(observed)Object.assign(column,{label:'Observed',observed:observed.info});custom={...source,_scoreColumns:[...(source._scoreColumns||[]),column]};stop();page=0;render();$('proScoreStatus').textContent='Score added · 0 battles simulated.';$('proAddScoreDialog').close();
      generatedSnapshot={rankings:custom,context:$('proGeneratedContext').textContent,summary:$('proRunSummary').textContent};
    };
    current.onerror=event=>{stop();$('proScoreStatus').textContent=event.message;};
    // Observed scores reuse the worker's "manual" path (the report's targets carry the observed weights); protocol unchanged.
    current.postMessage({mode:'reweight',data,cp:cp(),published:leagueData.overall,report:observed?{...custom,_targets:custom._targets.map(t=>({...t,weight:observed.weights.get(t.speciesId)??0}))}:custom,settings:{mode:observed?'manual':mode,guidance,defaultWeights:Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1])),published:leagueData.overall}});
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
})();
