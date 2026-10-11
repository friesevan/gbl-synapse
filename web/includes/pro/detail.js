/* Matchup explorer. Simulations remain in the upstream-engine worker. */
(function(root){
  'use strict';
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  let detailWorker,battleWorker,sequence=0;
  const colors={normal:'#a8a878',fire:'#f08030',water:'#6890f0',electric:'#f8d030',grass:'#78c850',ice:'#98d8d8',fighting:'#c03028',poison:'#a040a0',ground:'#e0c068',flying:'#a890f0',psychic:'#f85888',bug:'#a8b820',rock:'#b8a038',ghost:'#705898',dragon:'#7038f8',dark:'#705848',steel:'#b8b8d0',fairy:'#ee99ac'};
  function typed(node,type){node.classList.add('pro-typed');node.style.setProperty('--type-color',colors[type]||colors.normal);return node;}
  function pokemonTypes(p){const wrap=el('span',null,'pro-types');for(const type of p?.types||[])if(type!=='none')wrap.append(typed(el('span',type,'pro-type-chip'),type));return wrap;}
  function moves(ids,data){const wrap=el('span',null,'pro-move-chips');for(const id of ids||[]){if(id==='none')continue;const m=data.moves.find(m=>m.moveId===id);const chip=typed(el('span',m?.name||id,'pro-move-chip'),m?.type);if(m)chip.title=m.type+' · '+m.power+' base power · '+(m.energyGain?m.energyGain+' energy / '+m.cooldown/500+' turns':m.energy+' energy');wrap.append(chip);}return wrap;}
  function cancel(){sequence++;detailWorker?.terminate();battleWorker?.terminate();detailWorker=battleWorker=null;}
  function mount(config){
    cancel();const token=sequence,{host,data,row,category,battleHost}=config;const lookup=id=>data.pokemon.find(p=>p.speciesId===id),name=id=>lookup(id)?.speciesName||id;
    function resetBattle(){battleHost.hidden=true;battleHost.replaceChildren();document.querySelector('.pro-layout').classList.remove('pro-has-battle');}
    resetBattle();
    const section=el('section',null,'pro-full-matchups'),label=el('label','Battle scenario'),select=el('select');select.setAttribute('aria-label','Battle scenario');
    const scenarios=data.rankingScenarios;for(const s of scenarios){const option=el('option',s.slug[0].toUpperCase()+s.slug.slice(1)+' · '+s.shields.join('–')+' shields');option.value=s.slug;select.append(option);}select.value=category==='overall'?'leads':category;select.disabled=category!=='overall';label.append(select);
    const context=el('p',null,'hint'),progress=el('p','Loading all matchups…','hint'),lists=el('div',null,'pro-matchup-groups'),moveHost=el('section',null,'pro-move-info');
    const profile=el('section',null,'pro-pokemon-summary'),build=el('dl',null,'pro-build-summary');profile.append(el('h3',name(row.speciesId)),pokemonTypes(lookup(row.speciesId)),moves(row.moveset,data),build);build.append(el('dt','Recommended build'),el('dd','Loading…'));
    section.append(el('h4','All opponent matchups'),label,context,progress,lists);host.append(profile,moveHost,section);
    let activeMatches=[];
    function request(){
      battleWorker?.terminate();detailWorker?.terminate();resetBattle();lists.replaceChildren();moveHost.replaceChildren();
      const scenario=select.value,stored=config.custom?config.categoryRow(scenario)?.matches:null;
      context.textContent=(config.custom?(config.historical?'Older saved report: reconstructed against its species roster with published opponents; original weights were not saved.':'Every opponent from this report. Raw Battle Rating is shown; category scoring also applies shield bonuses, iterative weights and normalization.'):'Reconstructed locally against all published league opponents using the bundled engine and default IVs. Published files contain only key matchups; these are not the original published battle records.')+(category==='overall'?' Overall combines five category scores and consistency; each list and graph shows one scenario.':'')+' Same-species matches are excluded. >500 win, ≤500 loss (including ties).';
      progress.textContent=stored?'Loading retained matchup results…':'Simulating all opponents…';
      const current=detailWorker=new Worker('includes/pro/worker.js');
      current.onmessage=event=>{if(token!==sequence||current!==detailWorker)return;const result=event.data;if(result.type==='build'){build.replaceChildren();for(const [label,value] of [['Recommended IVs',result.ivs.atk+' / '+result.ivs.def+' / '+result.ivs.hp],['Level',result.level],['CP',result.cp]])build.append(el('dt',label),el('dd',String(value)));return;}if(result.type==='progress'){progress.textContent=result.text;return;}if(result.type==='error'){progress.textContent='Unable to load matchups: '+result.error;current.terminate();return;}if(result.type!=='details')return;
        activeMatches=result.matches;progress.textContent=activeMatches.length+' opponents · '+(stored?'Retained results from this report':'Locally simulated results');drawLists();drawMoves(result.moveInfo);current.terminate();detailWorker=null;
      };current.onerror=event=>{progress.textContent='Unable to load matchups: '+event.message;};
      current.postMessage({...config,host:undefined,battleHost:undefined,categoryRow:undefined,mode:'details',scenario,matches:stored||null});
    }
    function drawLists(){
      lists.replaceChildren();for(const [title,test,order] of [['Wins',m=>m.rating>500,-1],['Losses',m=>m.rating<=500,1]]){
        const items=activeMatches.filter(test).sort((a,b)=>order*(a.rating-b.rating)||name(a.opponent).localeCompare(name(b.opponent))),group=el('section');group.append(el('h4',title+' ('+items.length+')'));const ul=el('ul',null,'pro-matchups');
        for(const item of items){const li=el('li'),button=el('button',name(item.opponent),'pro-pokemon-button');button.type='button';button.append(pokemonTypes(lookup(item.opponent)));button.addEventListener('click',()=>openBattle(item,button));const score=el('span',String(item.rating),item.rating>500?'pro-win':item.rating<=500?'pro-loss':'');score.title='Raw BR '+item.rating+' · Shield-adjusted BR '+item.adjRating+(config.custom&&!config.historical?' · Opponent weight '+config.targets.find(t=>t.speciesId===item.opponent)?.weight:'');li.append(button,score);ul.append(li);}
        if(!items.length)ul.append(el('li','None'));group.append(ul);lists.append(group);
      }
    }
    function scrollToBattle(){
      const sidebar=battleHost.closest('#proDetailParking');
      if(sidebar&&sidebar.scrollHeight>sidebar.clientHeight)sidebar.scrollTo({top:sidebar.scrollTop+battleHost.getBoundingClientRect().top-sidebar.getBoundingClientRect().top-sidebar.clientTop-12,behavior:'smooth'});
      else battleHost.scrollIntoView({behavior:'smooth',block:'start'});
    }
    function openBattle(item,button){
      battleWorker?.terminate();for(const b of lists.querySelectorAll('button'))b.removeAttribute('aria-current');button.setAttribute('aria-current','true');
      battleHost.hidden=false;document.querySelector('.pro-layout').classList.add('pro-has-battle');battleHost.replaceChildren(el('h3',name(row.speciesId)+' vs '+name(item.opponent)),el('p','Simulating battle…','hint'));
      const current=battleWorker=new Worker('includes/pro/worker.js');current.onmessage=event=>{if(token!==sequence||current!==battleWorker)return;const result=event.data;if(result.type==='error'){battleHost.append(el('p',result.error,'hint'));return;}if(result.type==='battle'){drawBattle(result,item);scrollToBattle();current.terminate();battleWorker=null;}};
      current.onerror=e=>battleHost.append(el('p',e.message,'hint'));
      current.postMessage({...config,host:undefined,battleHost:undefined,categoryRow:undefined,mode:'battle',scenario:select.value,opponent:item.opponent});
      scrollToBattle();
    }
    function drawBattle(result,item){
      battleHost.replaceChildren();const top=el('div',null,'pro-battle-heading'),close=el('button','Close','secondary');close.type='button';close.addEventListener('click',()=>{resetBattle();});top.append(el('h3','Simulated battle'),close);battleHost.append(top);
      result.fighters.forEach((fighter,i)=>{const block=el('section',null,'pro-fighter');block.style.setProperty('--fighter-color',i?'#c5573f':'#2467be');block.append(el('h4',name(fighter.speciesId)),pokemonTypes(lookup(fighter.speciesId)),moves(fighter.moveset,data),el('p','L'+fighter.level+' · IVs '+Object.values(fighter.ivs).join('/')+' · HP '+fighter.remaining+'/'+fighter.hp+' · shields '+fighter.remainingShields+'/'+fighter.shields,'hint'));battleHost.append(block);});
      battleHost.append(el('p',(result.rating>500?'Win':result.rating<500?'Loss':'Tie')+' · Battle Rating '+result.rating+(result.rating!==item.rating?' (stored '+item.rating+')':''),'pro-battle-result'));
      battleHost.append(el('p',select.selectedOptions[0].textContent+' · Starting energy '+result.startEnergy+'–0 · full starting HP · default IVs.','hint'));
      battleHost.append(graph(result,name));
      const events=el('details');events.append(el('summary','Charged attacks & shields'));const list=el('ol',null,'pro-battle-events');for(const e of result.events.filter(e=>e.type.startsWith('charged ')||e.type==='shield'))list.append(el('li','Turn '+e.turn+' · '+name(result.fighters[e.actor].speciesId)+' · '+e.name+(e.type.startsWith('charged ')?' · '+e.damage+' damage':'')));if(!list.children.length)list.append(el('li','No charged attacks or shields.'));events.append(list);battleHost.append(events);
      if(config.custom)battleHost.append(el('p','This graph reruns the same engine, movesets and scenario as the report. Shield-adjusted BR '+result.adjRating+' is used before the category’s weighting and score normalization.','hint'));
    }
    function drawMoves(info){
      moveHost.replaceChildren(el('h4','Move details'));const grid=el('div',null,'pro-move-pools');const p=lookup(row.speciesId),recommended=config.custom?(config.published.find(r=>r.speciesId===row.speciesId)?.moveset||[]):row.moveset;
      for(const kind of ['fast','charged']){const column=el('section'),extraCards=[];column.append(el('h4',kind==='fast'?'Fast moves':'Charged moves'));
        const pool=info.filter(m=>m.kind===kind).sort((a,b)=>Number(row.moveset.includes(b.id))-Number(row.moveset.includes(a.id))||Number(recommended.includes(b.id))-Number(recommended.includes(a.id)));
        for(const [index,m] of pool.entries()){
          const card=typed(el('article',null,'pro-move-card'),m.type),chosen=row.moveset.includes(m.id),rec=recommended.includes(m.id);if(chosen)card.classList.add('pro-chosen-move');if(index>=4){card.hidden=true;card.id='pro-extra-'+kind+'-'+index;extraCards.push(card);}
          const header=el('div',null,'pro-move-card-header');header.append(el('strong',m.name+(m.elite||p?.eliteMoves?.includes(m.id)?'*':m.legacy||p?.legacyMoves?.includes(m.id)?'†':'')),el('span',m.archetype||m.type));card.append(header);
          const power=Math.round(m.power*100)/100;
          card.append(el('p',kind==='fast'?+(power/m.turns).toFixed(2)+' DPT · '+(m.energyGain/m.turns).toFixed(2)+' EPT · '+m.turns+' turns':power+' power · '+m.energy+' energy · '+(power/m.energy).toFixed(2)+' DPE','pro-move-stats'));
          if(m.buffs)card.append(el('p',Math.round(m.buffChance*100)+'% chance · '+m.buffs.map((b,i)=>(b>0?'+':'')+b+' '+(i?'Def':'Atk')).join(' / ')+' · '+m.buffTarget,'pro-move-stats'));
          if(kind==='charged'){const fast=info.find(m=>m.id===row.moveset[0]),gain=fast?.energyGain;let energy=0;const counts=[];for(let i=0;i<4&&gain>0;i++){const count=Math.ceil(Math.max(0,m.energy-energy)/gain);energy=Math.min(100,energy+count*gain)-m.energy;counts.push(count);}card.append(el('p','Fast move count: '+(counts.length?counts.join(' – '):'Cannot generate energy'),'pro-move-stats'));}
          card.append(el('span',[chosen?'Selected moveset':'',rec?'PvPoke recommended':''].filter(Boolean).join(' · '),'pro-move-flags'));column.append(card);
        }if(extraCards.length){const toggle=el('button','Show More','secondary pro-show-more-moves');toggle.type='button';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',extraCards.map(card=>card.id).join(' '));toggle.addEventListener('click',()=>{const expanded=toggle.getAttribute('aria-expanded')!=='true';for(const card of extraCards)card.hidden=!expanded;toggle.setAttribute('aria-expanded',String(expanded));toggle.textContent=expanded?'Show Less':'Show More';});column.append(toggle);}grid.append(column);
      }moveHost.append(grid);
    }
    select.addEventListener('change',request);request();
  }
  function graph(result,name){
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 460 275');svg.setAttribute('role','img');svg.setAttribute('aria-label','Remaining HP percentage by battle turn for '+result.fighters.map(f=>name(f.speciesId)).join(' versus '));svg.classList.add('pro-battle-graph');
    const add=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(text)n.textContent=text;svg.append(n);return n;};
    const hp=result.fighters.map(f=>f.hp),maxTurn=Math.max(1,...result.events.map(e=>e.turn)),x=t=>45+t/maxTurn*390,y=(v,i)=>220-Math.max(0,v)/result.fighters[i].hp*180;
    for(const percent of [0,25,50,75,100]){const yy=220-percent*1.8;add('line',{x1:45,x2:435,y1:yy,y2:yy,stroke:'currentColor',opacity:.15});add('text',{x:38,y:yy+4,'text-anchor':'end','font-size':11,fill:'currentColor'},percent+'%');}
    for(const turn of [0,Math.round(maxTurn/2),maxTurn])add('text',{x:x(turn),y:240,'text-anchor':'middle','font-size':11,fill:'currentColor'},String(turn));
    add('text',{x:240,y:264,'text-anchor':'middle','font-size':12,fill:'currentColor'},'Battle turn (0.5 seconds; charged animations omitted)');
    const paths=hp.map((v,i)=>'M '+x(0)+' '+y(v,i));
    for(const event of result.events){if(!/^(fast |charged )/.test(event.type))continue;const i=1-event.actor;paths[i]+=' H '+x(event.turn);hp[i]=Math.max(0,hp[i]-event.damage);paths[i]+=' V '+y(hp[i],i);
      if(event.type.startsWith('charged ')){const mark=add('circle',{cx:x(event.turn),cy:y(hp[i],i),r:3.5,fill:event.actor?'#c5573f':'#2467be'});const title=document.createElementNS(ns,'title');title.textContent='Turn '+event.turn+' · '+name(result.fighters[event.actor].speciesId)+' · '+event.name+' · '+event.damage+' damage';mark.append(title);}}
    paths.forEach((d,i)=>add('path',{d:d+' H '+x(maxTurn),fill:'none',stroke:i?'#c5573f':'#2467be','stroke-width':2.5}));
    const wrap=el('figure',null,'pro-battle-figure');wrap.append(svg);const caption=el('figcaption',null,'hint');result.fighters.forEach((f,i)=>{const span=el('span',name(f.speciesId));span.style.color=i?'#c5573f':'#2467be';caption.append(span,document.createTextNode(i?'':' · '));});wrap.append(caption,el('p','Lines = remaining HP · dots = charged attacks. Hover a dot for attack details.','hint'));return wrap;
  }
  root.PvPProDetail={mount,cancel,pokemonTypes,moves};
})(globalThis);
