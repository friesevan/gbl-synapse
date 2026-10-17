/* PvPoke Pro's one cup list and its published-rankings loader. Pure functions (no DOM); loaded before ui.js and by
   node tests (pro.cups.test.cjs). README section "Cups".
   - catalog(): the GBL schedule's cup presets (observed-weights.js presets(), by season) followed by every PvPoke cup
     (gamemaster `cups` and `formats`, plus the cups with published rankings in data/published-cups.json). The
     Current › Cup selector, the builder's Cup selector and the cup presets all render this list.
   - rankingCup(): the PvPoke rankings folder for a cup id. GBL's open leagues use PvPoke's "all"; GBL's Little Cup is
     PvPoke's "little" (PvPoke's "all" at 500 CP is every Pokémon under 500 CP, evolved or not: a different format).
   - loadPublished(): bundled data for the CP's default cup, else src/data/rankings/<cup>/<category>/rankings-<cp>.json
     read from PvPoke's repository at the pinned commit; status "missing" when the cup has none at that commit. */
(function(root){
  'use strict';
  const SHA='f627e89e53c0c7b903fff097df7a0ad0ac95decc';
  const DEFAULT_CUPS={500:'little',1500:'all',2500:'all',10000:'all'};
  const OPEN_LEAGUES={great:1500,ultra:2500,master:10000};
  const CATEGORIES=['overall','leads','closers','switches','chargers','attackers'];
  const CP_LABELS={500:'500 CP',1500:'1,500 CP',2500:'2,500 CP',10000:'Master'};
  const CPS=[500,1500,2500,10000];
  const ID=/^[a-z0-9_]+$/;
  function rankingCup(cup){return OPEN_LEAGUES[cup]?'all':cup;}
  const isBundled=(cup,cp)=>DEFAULT_CUPS[cp]===cup;
  // true / false from the bundled index of published rankings, null when unknown (no index, or another commit).
  function hasRankings(index,cup,cp,sha=SHA){
    if(isBundled(cup,Number(cp)))return true;
    if(!index||index.sha!==sha||!index.cups)return null;
    return (index.cups[cup]||[]).includes(Number(cp));
  }
  // A cup's PvPoke include/exclude rules from the gamemaster, used when the GBL schedule does not define the cup.
  function gamemasterRules(gamemaster,cup){
    const c=(gamemaster&&gamemaster.cups||[]).find(x=>x.name===cup);
    return c?{name:c.title||cup,include:c.include||[],exclude:c.exclude||[],source:'gamemaster'}:null;
  }
  function pvpokeEntries(gamemaster,index,schedule){
    const cups=new Map(),formats=gamemaster&&gamemaster.formats||[];
    const add=(cup,cp,name)=>{cp=Number(cp);if(!ID.test(cup||'')||!CP_LABELS[cp]||cup==='custom')return;const k=cup+'|'+cp;if(!cups.has(k))cups.set(k,{cup,cp,name});else if(name&&!cups.get(k).named)cups.get(k).name=name;if(name)cups.get(k).named=true;};
    for(const f of formats)if(f.cup&&f.cp)add(f.cup,f.cp,f.title);
    for(const c of gamemaster&&gamemaster.cups||[]){
      const cps=c.league?[c.league]:[...new Set([...(index&&index.cups&&index.cups[c.name]||[]),...formats.filter(f=>f.cup===c.name).map(f=>f.cp)])];
      for(const cp of cps)add(c.name,cp,null);
    }
    for(const [cup,cps] of Object.entries(index&&index.cups||{}))for(const cp of cps)add(cup,cp,null);
    const title=cup=>(gamemaster&&gamemaster.cups||[]).find(c=>c.name===cup)?.title||schedule?.cups?.[cup]?.name||cup;
    return [...cups.values()].map(({cup,cp,name})=>({key:'pvpoke|'+cup+'|'+cp,season:null,seasonName:null,cup,cp,name:name||title(cup),periods:[],source:'pvpoke'}))
      .sort((a,b)=>a.name.localeCompare(b.name)||a.cp-b.cp);
  }
  // The shared cup list: [{label, entries}] groups plus a flat `entries` list and find(key).
  // presets: observed-weights.js presets(schedule) or null; gamemaster: gamemaster.json; index: published-cups.json.
  function catalog({presets=null,gamemaster=null,index=null,schedule=null,sha=SHA}={}){
    const decorate=e=>{const cup=rankingCup(e.cup);const own=schedule&&schedule.cups&&schedule.cups[e.cup]||OPEN_LEAGUES[e.cup]||e.cup==='little';
      return {...e,rankingCup:cup,published:hasRankings(index,cup,e.cp,sha),rules:e.source==='pvpoke'||!own?gamemasterRules(gamemaster,e.cup):null};};
    const groups=[];
    if(presets){
      for(const s of presets.seasons||[])groups.push({label:'Season '+s.season+(s.name?' · '+s.name:''),entries:s.entries.map(decorate)});
      if(presets.all&&presets.all.length)groups.push({label:'All seasons · pooled (metas change)',entries:presets.all.map(decorate)});
    }
    const pv=pvpokeEntries(gamemaster,index,schedule).map(decorate);
    if(pv.length)groups.push({label:'PvPoke cups · rankings at '+sha.slice(0,7),entries:pv});
    const entries=groups.flatMap(g=>g.entries),byKey=new Map(entries.map(e=>[e.key,e]));
    return {groups,entries,find:key=>byKey.get(key)||null};
  }
  // The entry a CP opens with: the preset default (latest season's open league), else PvPoke's default cup for the CP.
  function defaultEntry(list,cp,preferred=null){
    cp=Number(cp);if(preferred&&preferred.cp===cp)return preferred;
    return list&&list.entries.find(e=>e.source==='pvpoke'&&e.cup===DEFAULT_CUPS[cp]&&e.cp===cp)||{key:'pvpoke|'+DEFAULT_CUPS[cp]+'|'+cp,season:null,cup:DEFAULT_CUPS[cp],cp,name:DEFAULT_CUPS[cp]==='little'?'Little Cup':'All Pokemon',periods:[],source:'pvpoke',rankingCup:DEFAULT_CUPS[cp],published:true,rules:null};
  }
  function optionLabel(e,extra=''){return e.name+' · '+(CP_LABELS[e.cp]||e.cp+' CP')+extra+(e.published===false?' · no published rankings':'');}
  const rawUrl=(sha,path)=>'https://raw.githubusercontent.com/pvpoke/pvpoke/'+sha+'/'+path;
  async function fetchJson(fetchFn,url){
    const response=await fetchFn(url);
    if(response.status===404)return null;
    if(!response.ok)throw new Error('GitHub returned '+response.status+' for '+url.replace(/^https:\/\/[^/]+\/pvpoke\/pvpoke\/[0-9a-f]+\//,'')+'.');
    return response.json();
  }
  // {status:'bundled'|'fetched', league, overrides} or {status:'missing'}. bundled() resolves [league, overrides].
  async function loadPublished({cup,cp,sha=SHA,index=null,bundled,fetch:fetchFn}){
    cp=Number(cp);
    if(!ID.test(cup||'')||!CP_LABELS[cp])throw new Error('Unknown cup '+cup+' at '+cp+' CP.');
    if(isBundled(cup,cp)){const [league,overrides]=await bundled();return {status:'bundled',cup,cp,sha,league,overrides};}
    if(hasRankings(index,cup,cp,sha)===false)return {status:'missing',cup,cp,sha,checked:'index'};
    const get=path=>fetchJson(fetchFn,rawUrl(sha,path));
    const overall=await get('src/data/rankings/'+cup+'/overall/rankings-'+cp+'.json');
    if(overall===null)return {status:'missing',cup,cp,sha,checked:'fetch'};
    if(!Array.isArray(overall))throw new Error('Unexpected PvPoke rankings format for '+cup+' at '+cp+' CP.');
    const rest=await Promise.all(CATEGORIES.slice(1).map(c=>get('src/data/rankings/'+cup+'/'+c+'/rankings-'+cp+'.json').catch(()=>null)));
    const league={overall};CATEGORIES.slice(1).forEach((c,i)=>{if(Array.isArray(rest[i]))league[c]=rest[i];});
    const overrides=await get('src/data/overrides/'+cup+'/'+cp+'.json').catch(()=>null);
    return {status:'fetched',cup,cp,sha,league,overrides:Array.isArray(overrides)?overrides:[]};
  }
  function missingMessage(entry,fallback,sha=SHA){
    return 'PvPoke has no published '+entry.name+' rankings at '+(CP_LABELS[entry.cp]||entry.cp+' CP')+' at commit '+sha.slice(0,7)+' (src/data/rankings/'+entry.rankingCup+'/overall/rankings-'+entry.cp+'.json). '+
      'Create custom rankings to rank it: the builder applies the cup’s rules to the '+fallback+' population.';
  }
  const api={SHA,DEFAULT_CUPS,OPEN_LEAGUES,CATEGORIES,CP_LABELS,CPS,rankingCup,isBundled,hasRankings,gamemasterRules,catalog,defaultEntry,optionLabel,rawUrl,loadPublished,missingMessage};
  if(typeof module!=='undefined')module.exports=api;root.PvPCups=api;
})(typeof window==='undefined'?globalThis:window);
