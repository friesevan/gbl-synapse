(function() {
  'use strict';
  const $ = id=>document.getElementById(id);
  const form=$('analysisForm'), status=$('analysisStatus'), host=$('analysisReports');
  let controller, reports = new Map(), activeCap='', view='rows', sortKey='Score', ascending=false, page=0;
  const pageSize=75;
  let optionsLoaded=false, loadingOptions=false;
  const pokemonColumns=['Pokemon','Status','Old Rank','Rank','Old Score','Score','Difference','Fast Move','Charged Move 1','Charged Move 2','Moveset Change','Update','Attack Availability','Buffs','Nerfs','Rework','XL','Level','Attack','Defense','Stamina','Bulk','Stat Product','Types','Shadow'];
  const typeColumns=['Type','Compared','New','Removed','Old Score','Score','Difference','Update'];
  const visible = new Set(pokemonColumns.filter(key=>!['Attack','Defense','Stamina','Bulk','Stat Product','Shadow'].includes(key)));
  function element(tag,text,className) {const node=document.createElement(tag); if(text!=null)node.textContent=text;if(className)node.className=className;return node;}
  const appTabs=['iv','analysis','pro','meta'];
  function appTab(which,replace=false) {
    if(!appTabs.includes(which))which='iv';
    for(const name of appTabs){$(name+'Panel').hidden=name!==which;$(name+'Tab').setAttribute('aria-selected',String(name===which));$(name+'Tab').tabIndex=name===which?0:-1;}
    const titles={iv:'PvP IV Pro',analysis:'PvPoke Analysis',pro:'PvPoke Pro',meta:'Meta Extractor'};
    $('appTitle').textContent=titles[which];document.title=titles[which];
    $('appSubtitle').textContent=which==='iv'?'Modification of PvP IVs':which==='analysis'?'Based on PvPokeAnalysis · Data from PvPoke':which==='meta'?'Built from PoGo Recorder · Battle data powered by you':'Powered by PvPoke';
    $('appSubtitle').href=which==='iv'?'https://pvpivs.com/':which==='analysis'?'https://github.com/friesevan/PvPokeAnalysis':which==='meta'?'https://github.com/evanjfries/PoGoAnalyzer':'https://pvpoke.com/';
    $('appIntro').textContent=which==='iv'?'Compare your Pokémon. Plan your best evolutions.':which==='analysis'?'Explore ranking changes across updates, branches and cups.':which==='meta'?'Review your battles. Reveal the live meta.':'Explore the meta. Build your roster. Test every moveset.';
    if(which==='analysis' && !optionsLoaded)loadOptions();
    if(replace){const url=new URL(location.href);if(which==='iv')url.searchParams.delete('app');else url.searchParams.set('app',which);history.replaceState(null,'',url);}
    document.dispatchEvent(new CustomEvent('pvp-tab-change',{detail:which}));
  }
  for(const name of appTabs)$(name+'Tab').addEventListener('click',()=>appTab(name,true));
  $('appTabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const active=appTabs.findIndex(name=>!$(name+'Panel').hidden);const index=event.key==='Home'?0:event.key==='End'?appTabs.length-1:(active+(event.key==='ArrowRight'?1:appTabs.length-1))%appTabs.length;appTab(appTabs[index],true);$(appTabs[index]+'Tab').focus();});
  appTab(new URLSearchParams(location.search).get('app') || 'iv');
  const earlier=new Date();earlier.setUTCDate(earlier.getUTCDate()-90);$('previousDate').value=earlier.toISOString().slice(0,10);
  function snapshot(prefix){return {branch:$(prefix+'Branch').value.trim(),cup:$(prefix+'Cup').value.trim(),date:$(prefix+'Date').value};}
  function validation(value) {
    if(!value.branch || value.branch.length>200)throw new Error('Select a branch for both snapshots.');
    if(!/^[a-zA-Z0-9_-]+$/.test(value.cup))throw new Error('Cup must be a folder name such as all, remix or sunshine.');
    if(value.date && (Number.isNaN(Date.parse(value.date+'T00:00:00Z')) || new Date(value.date+'T00:00:00Z').toISOString().slice(0,10)!==value.date))throw new Error('Enter a valid cutoff date.');
  }
  function setOptions(id,names,fallback) {
    const select=$(id), current=select.value;
    const options=[...new Set([fallback,...names])];
    select.replaceChildren(...options.map(name=>{const option=element('option',name);option.value=name;return option;}));
    select.value=options.includes(current)?current:fallback;
  }
  async function loadCups(prefix) {
    const branch=$(prefix+'Branch').value;
    // A new branch starts with the safe default, never the previous branch's cup list.
    setOptions(prefix+'Cup',[],'all');
    try {
      const cups=await PvPokeData.cups(branch);
      if($(prefix+'Branch').value===branch)setOptions(prefix+'Cup',cups,'all');
    }catch(error){if($(prefix+'Branch').value===branch)status.textContent='Could not load cups for '+branch+'. Using all. '+error.message;}
  }
  async function loadOptions() {
    if(loadingOptions)return;
    loadingOptions=true;
    for(const prefix of ['previous','current'])$(prefix+'Branch').disabled=true;
    const button=$('analysisDiscover');button.disabled=true;status.textContent='Loading branches and cups…';
    try {
      const results=await Promise.allSettled([PvPokeData.branches(),PvPokeData.cups($('previousBranch').value),PvPokeData.cups($('currentBranch').value)]);
      const branches=results[0].status==='fulfilled'?results[0].value:[];
      for(const prefix of ['previous','current'])setOptions(prefix+'Branch',branches,'master');
      for(const [i,prefix] of ['previous','current'].entries())setOptions(prefix+'Cup',results[i+1].status==='fulfilled'?results[i+1].value:[],'all');
      optionsLoaded=results.every(result=>result.status==='fulfilled');
      const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason.message);
      status.textContent=errors.length?'Some options could not be loaded. Defaults are master and all. '+[...new Set(errors)].join(' '):'All branches and cups loaded. Cup options follow the selected branch.';
    }finally{loadingOptions=false;button.disabled=false;for(const prefix of ['previous','current'])$(prefix+'Branch').disabled=false;}
  }
  $('analysisDiscover').addEventListener('click',loadOptions);
  for(const prefix of ['previous','current'])$(prefix+'Branch').addEventListener('change',()=>loadCups(prefix));
  $('analysisCancel').addEventListener('click',()=>controller?.abort());
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!form.reportValidity())return;
    const previous=snapshot('previous'),current=snapshot('current');
    try{validation(previous);validation(current);}catch(error){status.textContent=error.message;return;}
    const caps=[...form.querySelectorAll('input[name="analysisLeague"]:checked')].map(input=>input.value);
    if(!caps.length){status.textContent='Select at least one league.';return;}
    controller?.abort(); const run=new AbortController();controller=run;
    $('analysisGenerate').disabled=true;$('analysisCancel').hidden=false;$('analysisDiscover').disabled=true;
    status.textContent='Resolving snapshot commits…';status.classList.remove('analysis-error');
    try {
      const snapshots=await Promise.all([PvPokeData.resolveSnapshot(previous,run.signal),PvPokeData.resolveSnapshot(current,run.signal)]);
      status.textContent='Loading Pokémon, moves and league rankings at the selected commits…';
      const [oldData,newData,xl]=await Promise.all([PvPokeData.loadSnapshot(snapshots[0],caps,run.signal),PvPokeData.loadSnapshot(snapshots[1],caps,run.signal),fetch('includes/analysis/xl_table.json',{signal:run.signal}).then(response=>{if(!response.ok)throw new Error('Unable to load XL candy data.');return response.json();})]);
      if(run.signal.aborted)return;
      const next=new Map(),missing=[];
      for(const cap of caps) {
        const oldRanks=oldData.rankings[cap],newRanks=newData.rankings[cap];
        if(!oldRanks || !newRanks){missing.push(PvPokeAnalysis.leagues.find(item=>item[0]===cap)[1]+': rankings missing from '+(!oldRanks?'previous':'')+(!oldRanks&&!newRanks?' and ':'')+(!newRanks?'current':'')+' snapshot');continue;}
        next.set(cap,PvPokeAnalysis.buildReport({...oldData,rankings:oldRanks},{...newData,rankings:newRanks},cap,xl));
      }
      if(!next.size)throw new Error('No shared leagues found. '+missing.join('; ')+'. Check cup folders and dates.');
      reports=next;activeCap=[...reports.keys()][0];view='rows';sortKey='Score';ascending=false;page=0;
      const meta=$('analysisMetadata');meta.replaceChildren();
      for(const [label,data] of [['Previous',oldData],['Current',newData]]) {
        const card=element('div',null,'snapshot-meta');card.append(element('strong',label),element('span',data.branch+' · '+data.cup+' · '+data.committed));
        const link=element('a','Commit '+data.sha.slice(0,7));link.href='https://github.com/pvpoke/pvpoke/commit/'+data.sha;link.target='_blank';link.rel='noopener';card.append(link);meta.append(card);
      }
      $('analysisOutput').hidden=false;renderTabs();renderColumns();render();
      status.textContent='Comparison complete. '+reports.size+' league'+(reports.size===1?'':'s')+' loaded.'+(missing.length?' Skipped: '+missing.join('; ')+'.':'');
    }catch(error){if(controller!==run)return;status.textContent=error.name==='AbortError'?'Comparison cancelled.':error.message;status.classList.toggle('analysis-error',error.name!=='AbortError');}
    finally{if(controller===run){$('analysisGenerate').disabled=false;$('analysisCancel').hidden=true;$('analysisDiscover').disabled=false;}}
  });
  function renderTabs(){
    const leagues=$('analysisLeagueTabs');leagues.replaceChildren();
    for(const [cap] of reports){const button=element('button',PvPokeAnalysis.leagues.find(item=>item[0]===cap)[1]+' League','secondary');button.type='button';button.setAttribute('aria-pressed',String(cap===activeCap));button.addEventListener('click',()=>{activeCap=cap;page=0;renderTabs();render();});leagues.append(button);}
    for(const [id,kind] of [['pokemonReport','rows'],['typeReport','types']])$(id).setAttribute('aria-pressed',String(view===kind));
  }
  function renderColumns(){const host=$('analysisColumns');host.replaceChildren();for(const key of pokemonColumns){const label=element('label');const input=element('input');input.type='checkbox';input.checked=visible.has(key);input.disabled=key==='Pokemon';input.addEventListener('change',()=>{if(input.checked)visible.add(key);else visible.delete(key);render();});label.append(input,document.createTextNode(key));host.append(label);}}
  for(const [id,kind] of [['pokemonReport','rows'],['typeReport','types']])$(id).addEventListener('click',()=>{view=kind;page=0;sortKey='Score';ascending=false;renderTabs();render();});
  for(const id of ['analysisSearch','analysisRowFilter'])$(id).addEventListener('input',()=>{page=0;render();});
  $('analysisPreviousPage').addEventListener('click',()=>{page--;render();});$('analysisNextPage').addEventListener('click',()=>{page++;render();});
  function render(){
    const report=reports.get(activeCap);if(!report)return;
    const query=$('analysisSearch').value.trim().toLowerCase(),filter=$('analysisRowFilter').value;
    let rows=report[view].filter(row=>Object.entries(row).some(([key,value])=>key!=='moveStyles'&&String(value??'').toLowerCase().includes(query)));
    if(view==='rows' && filter!=='all')rows=rows.filter(row=>filter==='changed' ? row.Difference!==null && row.Difference!==0 || !!row.Update || !!row['Moveset Change'] : row.Status===filter);
    rows.sort((a,b)=>{const first=a[sortKey],second=b[sortKey];if(first==null||first==='')return second==null||second===''?0:1;if(second==null||second==='')return -1;return (typeof first==='number'?first-second:String(first).localeCompare(String(second)))*(ascending?1:-1);});
    const columns=view==='types'?typeColumns:pokemonColumns.filter(key=>visible.has(key));
    const table=element('table',null,'analysis-table');table.append(element('caption',(PvPokeAnalysis.leagues.find(item=>item[0]===activeCap)[1])+' League · '+(view==='types'?'Type summary':'Pokémon comparison')));
    const header=table.createTHead().insertRow();
    for(const key of columns){const th=element('th');th.scope='col';th.setAttribute('aria-sort',key===sortKey?(ascending?'ascending':'descending'):'none');const button=element('button',key+(key===sortKey?(ascending?' ↑':' ↓'):' ↕'),'column-sort');button.type='button';button.addEventListener('click',()=>{ascending=key===sortKey?!ascending:!['Score','Old Score','Difference'].includes(key);sortKey=key;page=0;render();});th.append(button);header.append(th);}
    const ranges=Object.fromEntries(['Old Score','Score','Difference'].map(key=>{const values=report[view].map(row=>row[key]).filter(value=>value!=null);return [key,[Math.min(...values),Math.max(...values)]];}));
    const totalPages=Math.max(1,Math.ceil(rows.length/pageSize));page=Math.max(0,Math.min(page,totalPages-1));
    const body=table.createTBody();
    for(const row of rows.slice(page*pageSize,(page+1)*pageSize)) {
      const tr=body.insertRow();
      for(const key of columns){const cell=key===columns[0]?element('th'):element('td');if(key===columns[0])cell.scope='row';tr.append(cell);
        const value=row[key];cell.textContent=value==null || value===''?'—':typeof value==='number'?value.toLocaleString(undefined,{maximumFractionDigits:2}):String(value);
        if(key==='Difference' && value>0)cell.textContent='+'+cell.textContent;
        if(['Old Score','Score','Difference'].includes(key)&&value!=null){const [min,max]=ranges[key];const hue=max===min?65:130*(value-min)/(max-min);cell.style.setProperty('--rating-hue',hue);cell.classList.add('rated-cell','numeric-cell');}
        const moveIndex=['Fast Move','Charged Move 1','Charged Move 2'].indexOf(key);
        if(moveIndex>=0){const style=row.moveStyles[moveIndex];if(style.kind)cell.classList.add('move-'+style.kind);if(style.added)cell.classList.add('move-added');cell.title=style.details+(style.added?' · Newly recommended for this Pokémon':'');if(style.kind==='new')cell.textContent=String(value).toUpperCase();}
        if(key==='Status')cell.classList.add('status-'+value.toLowerCase());
      }
    }
    if(!rows.length){const cell=body.insertRow().insertCell();cell.colSpan=columns.length;cell.textContent='No results match these filters.';}
    const scroll=host.scrollLeft;host.replaceChildren(table);host.scrollLeft=scroll;
    $('analysisCount').textContent=rows.length+' '+(view==='types'?'types':'Pokémon')+' · Page '+(page+1)+' of '+totalPages;
    $('analysisPreviousPage').disabled=page===0;$('analysisNextPage').disabled=page>=totalPages-1;
    $('analysisColumnDetails').hidden=view==='types';$('analysisRowFilter').disabled=view==='types';
    const matched=report.rows.filter(row=>row.Difference!=null);const average=matched.length?matched.reduce((sum,row)=>sum+row.Difference,0)/matched.length:0;
    $('analysisSummary').textContent=matched.length+' compared · '+report.rows.filter(row=>row.Status==='New').length+' new · '+report.rows.filter(row=>row.Status==='Removed').length+' removed · Average score change '+(average>=0?'+':'')+average.toFixed(2);
  }
})();
