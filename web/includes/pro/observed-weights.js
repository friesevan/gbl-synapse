/* Observed opponent weights and GBL cup presets for PvPoke Pro's custom-rankings builder.
   Pure functions (no DOM); loaded by the page before ui.js and by node tests.
   - Cup rules: a port of scripts/yt-harvest/league.py species_allowed() / roster_allowed() (PvPoke include/exclude
     semantics). Both are tested against tests/fixtures/cup-rules.json.
   - Cup presets: the GBL schedule (scripts/yt-harvest/data/gbl-schedule.json) by season, repeat runs of a cup in a
     season consolidated into one entry.
   - Weights: observed usage counts (GET /api/observed-usage, or an imported export) smoothed toward PvPoke's weights.
   The formula is documented in README.md section 4e. */
(function(root){
  'use strict';
  const PRIOR_STRENGTH=50,LEAD_BONUS=.25,SHADOW_PSEUDO=2,FORMAT='gbl-synapse-observed-usage';
  const BASE_CUPS={500:'little',1500:'great',2500:'ultra',10000:'master'};
  const MEGA_CUPS=['mega','catchmega'];
  // ---- cup rules (league.py) ----
  function stage(mon,gm){let n=1;const seen=new Set();while(mon&&mon.family&&mon.family.parent&&n<4){const parent=mon.family.parent;if(seen.has(parent))break;seen.add(parent);mon=gm?gm.get(parent):null;n++;}return n;}
  function matches(filter,sid,mon,moves,gm){
    const type=filter.filterType,values=filter.values||[];
    if(!values.length)return null;
    if(type==='evolution')return values.includes(stage(mon,gm));
    if(type==='id')return values.includes(sid);
    if(type==='type')return (mon.types||[]).some(t=>t!=='none'&&values.includes(t));
    if(type==='tag')return (mon.tags||[]).some(t=>values.includes(t));
    if(type==='dex'){const lo=values[0],hi=values.length>1?values[1]:values[0],dex=mon.dex??-1;return lo<=dex&&dex<=hi;}
    if(type==='move')return moves&&moves.length?moves.some(m=>values.includes(m)):null;
    return null;
  }
  // true / false, or null when the rules cannot be judged (unknown rules, a move filter without moves).
  function speciesAllowed(cup,sid,mon,moves=[],gm=null){
    if(cup.rulesUnknown)return null;
    const cp=cup.cp,live=fs=>(fs||[]).filter(f=>!f.leagues||!f.leagues.length||f.leagues.includes(cp));
    const inc=live(cup.include),exc=live(cup.exclude);
    const incIds=new Set(inc.filter(f=>f.filterType==='id').flatMap(f=>f.values||[]));
    const explicit=incIds.has(sid),nonId=inc.filter(f=>f.filterType!=='id'&&(f.values||[]).length);
    let ok;
    if(explicit)ok=true;
    else if(nonId.length){const res=nonId.map(f=>matches(f,sid,mon,moves,gm));ok=res.some(r=>r===false)?false:res.every(r=>r===true)?true:null;}
    else ok=!incIds.size;
    if(ok===false)return false;
    for(const f of exc){if(explicit&&f.filterType!=='id')continue;if(matches(f,sid,mon,moves,gm)===true)return false;}
    return ok;
  }
  // GBL's Mega rule on top: Mega Evolutions only in Mega Edition-style cups.
  function rosterAllowed(cupId,cup,sid,mon,gm=null){
    if((mon.tags||[]).includes('mega')&&!MEGA_CUPS.includes(cupId)&&!cup.megaAllowed)return false;
    return speciesAllowed(cup,sid,mon,[],gm);
  }
  function cupDefinition(schedule,cupId,cp){
    const base={500:['Little Cup'],1500:['Great League'],2500:['Ultra League'],10000:['Master League']};
    const c=(schedule&&schedule.cups||{})[cupId]||(Object.values(BASE_CUPS).includes(cupId)?{name:base[Object.keys(BASE_CUPS).find(k=>BASE_CUPS[k]===cupId)][0],include:[],exclude:[]}:null);
    return c?{...c,cp}:null;
  }
  // The preset roster: allowed ids among `ids` (the ranked population). Unknown (null) counts as allowed.
  function cupRoster(schedule,cupId,cp,ids,gm){
    const cup=cupDefinition(schedule,cupId,cp);if(!cup)return {allowed:new Set(ids),unknown:ids.length,rulesUnknown:true,cup:null};
    const allowed=new Set();let unknown=0;
    for(const id of ids){const mon=gm.get(id)||gm.get(id.replace(/_shadow$/,''));if(!mon){unknown++;allowed.add(id);continue;}const ok=rosterAllowed(cupId,cup,id,mon,gm);if(ok===null)unknown++;if(ok!==false)allowed.add(id);}
    return {allowed,unknown,rulesUnknown:!!cup.rulesUnknown,cup};
  }
  // ---- presets from the schedule ----
  const key=e=>e.season+'|'+e.cup+'|'+e.cp;
  function presets(schedule){
    const seasons=new Map(),all=new Map(),names=new Map((schedule&&schedule.seasons||[]).map(s=>[s.season,s]));
    for(const p of schedule&&schedule.periods||[]){
      if(p.season==null)continue;
      if(!seasons.has(p.season)){const s=names.get(p.season)||{};seasons.set(p.season,{season:p.season,name:s.name||null,start:s.start||null,end:s.end||null,entries:new Map()});}
      for(const f of p.formats||[]){
        const cp=Number(f.cp||(schedule.cups?.[f.id]?.cp));if(!f.id||!cp)continue;
        const S=seasons.get(p.season),k=f.id+'|'+cp;
        if(!S.entries.has(k))S.entries.set(k,{season:p.season,seasonName:S.name,cup:f.id,cp,name:f.name||schedule.cups?.[f.id]?.name||f.id,periods:[]});
        S.entries.get(k).periods.push({start:p.start,end:p.end});
        if(!all.has(k))all.set(k,{season:'all',seasonName:'All seasons',cup:f.id,cp,name:f.id,periods:[]});
        all.get(k).name=f.name||schedule.cups?.[f.id]?.name||f.id;   // periods are chronological: the latest name wins
        all.get(k).periods.push({start:p.start,end:p.end,season:p.season});
      }
    }
    const order=(a,b)=>(Object.values(BASE_CUPS).includes(b.cup)&&BASE_CUPS[b.cp]===b.cup)-(Object.values(BASE_CUPS).includes(a.cup)&&BASE_CUPS[a.cp]===a.cup)||a.cp-b.cp||a.name.localeCompare(b.name);
    const list=[...seasons.values()].sort((a,b)=>b.season-a.season).map(s=>({...s,entries:[...s.entries.values()].map(e=>({...e,key:key(e),periods:e.periods.sort((a,b)=>String(a.start).localeCompare(String(b.start)))})).sort(order)}));
    return {seasons:list,all:[...all.values()].map(e=>({...e,key:key(e)})).sort(order)};
  }
  function find(p,k){if(!p||!k)return null;for(const s of p.seasons)for(const e of s.entries)if(e.key===k)return e;return p.all.find(e=>e.key===k)||null;}
  // Latest season (the one running today, else the newest that has started) offering the CP's open league.
  function defaultPreset(p,cp,today=new Date().toISOString().slice(0,10)){
    const cup=BASE_CUPS[cp];if(!p||!cup)return null;
    const started=p.seasons.filter(s=>!s.start||s.start<=today);
    for(const s of started){const e=s.entries.find(x=>x.cup===cup&&x.cp===Number(cp));if(e)return e;}
    return p.all.find(x=>x.cup===cup&&x.cp===Number(cp))||null;
  }
  // ---- usage data ----
  function parseUsage(value){
    if(!value||value.format!==FORMAT||!Array.isArray(value.groups))throw new Error('Not an observed-usage export (expected "'+FORMAT+'").');
    if(value.version!==1)throw new Error('Unsupported observed-usage version '+value.version+'.');
    const groups=value.groups.filter(g=>g&&Number.isFinite(g.cp)&&typeof g.cup==='string'&&g.species&&typeof g.species==='object').map(g=>({cp:g.cp,cup:g.cup,season:g.season,seasonName:g.seasonName??null,cupName:String(g.cupName||g.cup),battles:+g.battles||0,lineups:+g.lineups||0,leadLineups:+g.leadLineups||0,creators:+g.creators||0,first:g.first||null,last:g.last||null,periods:Array.isArray(g.periods)?g.periods:[],seasons:Array.isArray(g.seasons)?g.seasons:[],
      species:Object.fromEntries(Object.entries(g.species).filter(([id,u])=>/^[a-z0-9_]+$/.test(id)&&u&&Number.isFinite(u.teams)).map(([id,u])=>[id,{teams:u.teams,leads:+u.leads||0,shadow:{yes:+u.shadow?.yes||0,no:+u.shadow?.no||0,unknown:+u.shadow?.unknown||0}}]))}));
    return {format:FORMAT,version:1,revision:value.revision||null,generated:value.generated||null,groups};
  }
  function group(usage,cp,cup,season){return usage?usage.groups.find(g=>g.cp===Number(cp)&&g.cup===cup&&String(g.season)===String(season))||null:null;}
  // ---- weights ----
  // ids: the eligible roster (form ids). pvpoke: {id: PvPoke weight}. group: one usage group, or null.
  function weights({ids,pvpoke={},group:g=null,priorStrength=PRIOR_STRENGTH,leadBonus=LEAD_BONUS,priorTotal=null}){
    const K=Math.max(0,Number.isFinite(priorStrength)?priorStrength:PRIOR_STRENGTH),idSet=new Set(ids);
    const w=id=>{const v=pvpoke[id];return Number.isFinite(v)&&v>=0&&v<=1000?v:1;},total=Number.isFinite(priorTotal)&&priorTotal>0?priorTotal:ids.reduce((s,id)=>s+w(id),0);
    const prior=new Map(ids.map(id=>[id,total>0?3*w(id)/total:0]));
    const N=g?g.lineups:0,leadN=g?g.leadLineups:0,counts=new Map(),unmatched=[];
    for(const [base,u] of Object.entries(g?g.species:{})){
      const hasBase=idSet.has(base),hasShadow=idSet.has(base+'_shadow'),mass=u.teams+(leadN>0?leadBonus*N*u.leads/leadN:0);
      if(!hasBase&&!hasShadow){unmatched.push({id:base,teams:u.teams,share:N?u.teams/N:0});continue;}
      let f=hasBase&&hasShadow?null:hasShadow?1:0;
      if(f===null){const pb=w(base),ps=w(base+"_shadow"),f0=pb+ps>0?ps/(pb+ps):.5,yes=u.shadow.yes,no=u.shadow.no;f=(yes+SHADOW_PSEUDO*f0)/(yes+no+SHADOW_PSEUDO);}
      if(hasBase)counts.set(base,{count:mass*(1-f),teams:u.teams*(1-f)});
      if(hasShadow)counts.set(base+'_shadow',{count:mass*f,teams:u.teams*f});
    }
    const rows=ids.map(id=>{const c=counts.get(id),count=c?c.count:0,pi=prior.get(id),p=N+K>0?(count+K*pi)/(N+K):pi;return {id,weight:100*p,share:p,observed:N?count/N:null,teams:c?c.teams:0,pvpoke:pi,pvpokeWeight:w(id)};});
    return {rows,weights:new Map(rows.map(r=>[r.id,r.weight])),priorTotal:total,lineups:N,leadLineups:leadN,priorStrength:K,leadBonus,observedFraction:N+K>0?N/(N+K):0,unmatched:unmatched.sort((a,b)=>b.teams-a.teams||a.id.localeCompare(b.id))};
  }
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function range(a,b){const p=d=>{const m=/^(\d{4})-(\d\d)-(\d\d)$/.exec(d||'');return m?[m[1],MONTHS[m[2]-1],+m[3]]:null;},x=p(a),y=p(b);if(!x||!y)return a||b||'dates unknown';if(x[0]!==y[0])return `${x[1]} ${x[2]}, ${x[0]} – ${y[1]} ${y[2]}, ${y[0]}`;return x[1]===y[1]?`${x[1]} ${x[2]}–${y[2]}, ${x[0]}`:`${x[1]} ${x[2]} – ${y[1]} ${y[2]}, ${x[0]}`;}
  function presetLabel(e){return e?(e.season==='all'?'All seasons':'Season '+e.season+(e.seasonName?' · '+e.seasonName:''))+' › '+e.name:'';}
  const api={PRIOR_STRENGTH,LEAD_BONUS,SHADOW_PSEUDO,FORMAT,BASE_CUPS,MEGA_CUPS,stage,speciesAllowed,rosterAllowed,cupDefinition,cupRoster,presets,find,defaultPreset,parseUsage,group,weights,range,presetLabel};
  if(typeof module!=='undefined')module.exports=api;root.PvPObserved=api;
})(typeof window==='undefined'?globalThis:window);
