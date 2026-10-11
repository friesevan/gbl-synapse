// App navigation: PvPIV Pro · PvPoke Pro (Pokémon Rankings › Current | Historical, Team Rankings) · Meta Extractor.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const web=path.join(__dirname,'..'),src=fs.readFileSync(path.join(web,'includes/app-tabs.js'),'utf8');
const site=fs.readFileSync(path.join(web,'familyRanks.html'),'utf8'),artifact=fs.readFileSync(path.join(web,'..','artifact','pvp-iv-pro.html'),'utf8');
const pure=vm.createContext({URLSearchParams,URL});vm.runInContext(src,pure);
const {resolve,search,header,nextIndex,storageKey}=pure.PvPTabs;
const route=(query,remembered)=>({...resolve(query,remembered)});

const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
function tablists(html){
 return [...html.matchAll(/<(nav|div) ([^>]*role="tablist"[^>]*)>([\s\S]*?)<\/\1>/g)].map(m=>({...attrs(m[2]),tabs:[...m[3].matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)].map(b=>({...attrs(b[1]),label:b[2].trim()}))}));
}
function openTag(html,id){const m=new RegExp('<(\\w+) [^>]*id="'+id+'"[^>]*>').exec(html);return m&&{tag:m[1],attrs:attrs(m[0]),index:m.index};}
// Inner HTML of an element, counting nested tags of the same name.
function inner(html,id){
 const open=openTag(html,id);if(!open)return null;
 const re=new RegExp('<(/?)'+open.tag+'\\b[^>]*>','g');re.lastIndex=open.index;let depth=0,start=-1,m;
 while((m=re.exec(html))){if(!m[1]){depth++;if(start<0)start=re.lastIndex;}else if(--depth===0)return html.slice(start,m.index);}
 return null;
}

test('old and new links resolve to the right view',()=>{
 assert.deepEqual(route(''),{app:'iv',proView:'rankings',mode:'current'});
 assert.deepEqual(route('?app=analysis'),{app:'pro',proView:'rankings',mode:'historical'});
 assert.deepEqual(route('?app=analysis&view=neural'),{app:'pro',proView:'rankings',mode:'historical'});
 for(const view of ['rank','lab','current','rankings'])assert.deepEqual(route('?app=pro&view='+view,{proView:'teams',mode:'historical'}),{app:'pro',proView:'rankings',mode:'current'},view);
 assert.deepEqual(route('?app=pro&view=neural'),{app:'pro',proView:'teams',mode:'current'});
 assert.deepEqual(route('?app=pro&view=teams',{mode:'historical'}),{app:'pro',proView:'teams',mode:'historical'});
 assert.deepEqual(route('?app=pro&view=historical'),{app:'pro',proView:'rankings',mode:'historical'});
 assert.deepEqual(route('?app=PRO&view=Historical'),{app:'pro',proView:'rankings',mode:'historical'});
 assert.equal(route('?app=unknown').app,'iv');
 assert.equal(route('?app=meta&view=historical').mode,'current','views only apply to PvPoke Pro');
});
test('the last PvPoke Pro view is remembered unless the link names one',()=>{
 assert.deepEqual(route('?app=pro',{proView:'teams',mode:'historical'}),{app:'pro',proView:'teams',mode:'historical'});
 assert.deepEqual(route('?app=pro&view=bogus',{proView:'rankings',mode:'historical'}),{app:'pro',proView:'rankings',mode:'historical'});
 assert.deepEqual(route('?app=pro',{proView:'lab',mode:'toString'}),{app:'pro',proView:'rankings',mode:'current'},'invalid memory falls back');
 assert.deepEqual(route('?app=pro',null),{app:'pro',proView:'rankings',mode:'current'});
 assert.deepEqual(route('?view=constructor&app=pro'),{app:'pro',proView:'rankings',mode:'current'});
});
test('canonical URLs name the view and keep unrelated parameters',()=>{
 assert.equal(search({app:'iv',proView:'teams',mode:'current'},'?app=pro&view=teams'),'');
 assert.equal(search({app:'pro',proView:'rankings',mode:'current'},''),'?app=pro&view=current');
 assert.equal(search({app:'pro',proView:'rankings',mode:'historical'},'?app=analysis&debug=1'),'?debug=1&app=pro&view=historical');
 assert.equal(search({app:'pro',proView:'teams',mode:'historical'},''),'?app=pro&view=teams');
 assert.equal(search({app:'meta',proView:'teams',mode:'current'},'?view=teams'),'?app=meta');
 for(const r of [{app:'pro',proView:'rankings',mode:'current'},{app:'pro',proView:'rankings',mode:'historical'},{app:'pro',proView:'teams',mode:'current'},{app:'meta',proView:'rankings',mode:'current'}])assert.deepEqual(route(search(r),{}),{...r,mode:r.proView==='teams'?'current':r.mode});
});
test('each view has its own title, credit and intro',()=>{
 const historical=header({app:'pro',proView:'rankings',mode:'historical'}),teams=header({app:'pro',proView:'teams',mode:'current'}),current=header({app:'pro',proView:'rankings',mode:'current'});
 assert.match(historical.subtitle,/PvPokeAnalysis/);assert.equal(historical.href,'https://github.com/friesevan/PvPokeAnalysis');assert.equal(historical.documentTitle,'Historical Rankings · PvPoke Pro');
 assert.equal(teams.documentTitle,'Team Rankings · PvPoke Pro');assert.equal(current.documentTitle,'Pokémon Rankings · PvPoke Pro');
 assert.doesNotMatch(current.intro,/moveset/i,'Moveset Lab is gone');
 assert.equal(header({app:'iv'}).title,'PvP IV Pro');assert.equal(header({app:'meta'}).title,'Meta Extractor');
 assert.equal(new Set([historical.intro,teams.intro,current.intro]).size,3);
});
test('arrow, Home and End keys wrap within a tablist',()=>{
 assert.equal(nextIndex('ArrowRight',2,3),0);assert.equal(nextIndex('ArrowLeft',0,3),2);assert.equal(nextIndex('ArrowLeft',1,2),0);
 assert.equal(nextIndex('Home',1,3),0);assert.equal(nextIndex('End',0,3),2);assert.equal(nextIndex('Enter',0,3),-1);assert.equal(nextIndex('ArrowDown',0,3),-1);
});

test('page markup: three nested tablists whose tabs and panels point at each other',()=>{
 const lists=tablists(site);
 assert.deepEqual(lists.map(l=>l.id),['appTabs','proSubTabs','proRankModes']);
 assert.deepEqual(lists.map(l=>l.tabs.map(t=>t.label)),[['PvPIV Pro','PvPoke Pro','Meta Extractor'],['Pokémon Rankings','Team Rankings'],['Current','Historical']]);
 for(const list of lists){
  assert.ok(list['aria-label'],list.id+' needs an accessible name');
  list.tabs.forEach((tab,i)=>{
   assert.equal(tab.role,'tab');assert.equal(tab.type,'button');
   assert.equal(tab['aria-selected'],String(i===0),tab.id);assert.equal(tab.tabindex,i===0?undefined:'-1',tab.id);
   const panel=openTag(site,tab['aria-controls']);assert.ok(panel,tab['aria-controls']+' exists');
   assert.equal(panel.attrs.role,'tabpanel');assert.equal(panel.attrs['aria-labelledby'],tab.id);
  });
 }
 assert.equal(openTag(site,'analysisTab'),null);assert.equal(openTag(site,'analysisPanel'),null);assert.equal(openTag(site,'proLabTab'),null);
 const pro=inner(site,'proPanel'),rankings=inner(site,'proRankingsPanel'),current=inner(site,'proCurrentPanel'),historical=inner(site,'proHistoricalPanel'),teams=inner(site,'proNeuralPanel');
 assert.ok(pro.includes('id="proRankingsPanel"')&&pro.includes('id="proNeuralPanel"'));
 assert.ok(rankings.includes('id="proRankModes"')&&rankings.includes('id="proCurrentPanel"')&&rankings.includes('id="proHistoricalPanel"'));
 for(const id of ['proRankings','proBuilder','proComparePanel','proCompareToggle','proStatus'])assert.ok(current.includes('id="'+id+'"'),id+' belongs to Current');
 for(const id of ['analysisForm','analysisOutput','analysisReports'])assert.ok(historical.includes('id="'+id+'"'),id+' belongs to Historical');
 assert.match(teams,/<h2>Team Rankings<\/h2>/);assert.match(teams,/FULL TEAM NEURAL NETWORK/);
 assert.doesNotMatch(site,/Full Team Neural Network<\/(h2|button)>|>PvPoke Analysis</);
});
test('the artifact page mirrors the site and ships every script it loads',()=>{
 const body=html=>html.slice(html.indexOf('<main>'),html.indexOf('</main>'));
 assert.equal(body(artifact),body(site));
 const manifest=new Set(fs.readFileSync(path.join(web,'..','artifact','manifest.txt'),'utf8').split('\n').map(s=>s.trim()).filter(Boolean));
 const scripts=html=>[...html.matchAll(/<script[^>]*src="([^"?]+)/g)].map(m=>m[1]).filter(s=>!s.includes('artifact-shim'));
 assert.deepEqual(scripts(artifact),scripts(site));
 for(const file of scripts(site)){assert.ok(manifest.has(file),file+' is in artifact/manifest.txt');assert.ok(fs.existsSync(path.join(web,file)),file+' exists');}
 assert.ok(scripts(site).indexOf('includes/app-tabs.js')>scripts(site).indexOf('includes/pro/neural.js'),'the router runs after the views it announces to');
});

// Router wiring against a minimal DOM built from the page's own tab markup.
function mount(query='',stored,{blockStorage=false}={}){
 const els=new Map(),docListeners={},events=[],store=new Map(stored?[[storageKey,JSON.stringify(stored)]]:[]);
 const doc={title:'',activeElement:null,getElementById:id=>els.get(id)||null,addEventListener(type,fn){(docListeners[type]??=[]).push(fn);},dispatchEvent(event){events.push({type:event.type,detail:event.detail&&{...event.detail}});for(const fn of docListeners[event.type]||[])fn(event);return true;}};
 const element=id=>({id,hidden:false,tabIndex:0,textContent:'',href:'',attributes:{},listeners:{},setAttribute(key,value){this.attributes[key]=String(value);},getAttribute(key){return this.attributes[key]??null;},addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);},focus(){doc.activeElement=this;},fire(type,event={}){for(const fn of this.listeners[type]||[])fn(event);return event;}});
 const lists=tablists(site);
 for(const list of lists){els.set(list.id,element(list.id));for(const tab of list.tabs){els.set(tab.id,element(tab.id));els.set(tab['aria-controls'],element(tab['aria-controls']));}}
 for(const id of ['appTitle','appSubtitle','appIntro'])els.set(id,element(id));
 const location={href:'http://localhost/familyRanks.html'+query,get search(){return new URL(this.href).search;}};
 let replaced=0;
 const context=vm.createContext({document:doc,location,history:{state:null,replaceState(state,title,url){replaced++;location.href=String(url);}},
  localStorage:blockStorage?{getItem(){throw new Error('SecurityError');},setItem(){throw new Error('SecurityError');}}:{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,String(value))},URL,URLSearchParams,
  CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail;}},Event:class{constructor(type){this.type=type;}}});
 vm.runInContext(src,context);
 const key=(id,name)=>els.get(id).fire('keydown',{key:name,prevented:false,preventDefault(){this.prevented=true;}});
 const selected=list=>lists.find(l=>l.id===list).tabs.filter(t=>els.get(t.id).getAttribute('aria-selected')==='true').map(t=>t.label);
 return {els,doc,events,store,location,key,selected,lists,replaced:()=>replaced,tabs:context.PvPTabs};
}
test('router: old PvPoke Analysis links open Historical and rewrite the URL',()=>{
 const app=mount('?app=analysis');
 assert.deepEqual([app.selected('appTabs'),app.selected('proSubTabs'),app.selected('proRankModes')],[['PvPoke Pro'],['Pokémon Rankings'],['Historical']]);
 assert.equal(app.location.search,'?app=pro&view=historical');assert.equal(app.doc.title,'Historical Rankings · PvPoke Pro');
 assert.equal(app.els.get('appSubtitle').href,'https://github.com/friesevan/PvPokeAnalysis');
 assert.equal(app.els.get('proHistoricalPanel').hidden,false);assert.equal(app.els.get('proCurrentPanel').hidden,true);assert.equal(app.els.get('ivPanel').hidden,true);
 assert.deepEqual(app.events.map(e=>e.type),['pvp-tab-change','pvp-view-change']);
 assert.deepEqual(app.events[1].detail,{app:'pro',proView:'rankings',mode:'historical'});
 assert.deepEqual(JSON.parse(app.store.get(storageKey)),{proView:'rankings',mode:'historical'});
});
test('router: keyboard navigation works at every level with roving tabindex',()=>{
 const app=mount('?app=pro&view=current');
 const roving=list=>app.lists.find(l=>l.id===list).tabs.map(t=>app.els.get(t.id).tabIndex);
 assert.deepEqual(roving('proRankModes'),[0,-1]);
 let event=app.key('proRankModes','ArrowRight');assert.ok(event.prevented);
 assert.deepEqual(app.selected('proRankModes'),['Historical']);assert.equal(app.doc.activeElement.id,'proHistoricalTab');assert.deepEqual(roving('proRankModes'),[-1,0]);
 assert.equal(app.location.search,'?app=pro&view=historical');
 app.key('proRankModes','ArrowRight');assert.deepEqual(app.selected('proRankModes'),['Current'],'wraps');
 app.key('proSubTabs','End');assert.deepEqual(app.selected('proSubTabs'),['Team Rankings']);assert.equal(app.doc.activeElement.id,'proNeuralTab');
 assert.equal(app.els.get('proRankingsPanel').hidden,true);assert.equal(app.els.get('proNeuralPanel').hidden,false);
 assert.equal(app.location.search,'?app=pro&view=teams');assert.equal(app.events.at(-1).type,'neural-open');
 app.key('appTabs','ArrowLeft');assert.deepEqual(app.selected('appTabs'),['PvPIV Pro']);assert.equal(app.location.search,'');assert.equal(app.els.get('proPanel').hidden,true);
 app.key('appTabs','Home');app.key('appTabs','ArrowLeft');assert.deepEqual(app.selected('appTabs'),['Meta Extractor']);assert.equal(app.location.search,'?app=meta');
 event=app.key('appTabs','Enter');assert.equal(event.prevented,false,'other keys are left alone');
 app.els.get('proTab').fire('click');
 assert.deepEqual([app.selected('proSubTabs'),app.selected('proRankModes')],[['Team Rankings'],['Current']],'returning to PvPoke Pro restores the last view');
 assert.equal(app.location.search,'?app=pro&view=teams');
});
test('router: remembered view, click handling and storage failures',()=>{
 const app=mount('?app=pro',{proView:'rankings',mode:'historical'});
 assert.deepEqual(app.selected('proRankModes'),['Historical']);
 app.els.get('proCurrentTab').fire('click');assert.deepEqual(JSON.parse(app.store.get(storageKey)),{proView:'rankings',mode:'current'});
 const before=app.replaced();app.els.get('proCurrentTab').fire('click');assert.equal(app.replaced(),before,'an unchanged URL is not rewritten');
 app.tabs.show({app:'pro',proView:'rankings',mode:'historical'});assert.deepEqual(app.selected('proRankModes'),['Historical']);
 const plain=mount('?app=pro&view=lab');assert.deepEqual(plain.selected('proRankModes'),['Current']);assert.equal(plain.location.search,'?app=pro&view=current');
 // A browser that blocks storage still navigates; it just forgets the view.
 const blocked=mount('?app=pro&view=teams',null,{blockStorage:true});assert.deepEqual(blocked.selected('proSubTabs'),['Team Rankings']);
 blocked.key('proSubTabs','ArrowLeft');assert.deepEqual(blocked.selected('proSubTabs'),['Pokémon Rankings']);assert.equal(blocked.location.search,'?app=pro&view=current');
});
