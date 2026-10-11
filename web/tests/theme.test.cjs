// Site themes: colour tokens (includes/familyRanks.css), the System / Light / Dark toggle (includes/theme.js),
// contrast floors for both themes, and the page wiring on the site, the artifact and the README.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const web=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(web,f),'utf8');
const css=read('includes/familyRanks.css'),meta=read('includes/meta/meta.css'),neural=read('includes/pro/neural.css'),themeSrc=read('includes/theme.js');
const site=read('familyRanks.html'),artifact=fs.readFileSync(path.join(web,'..','artifact','pvp-iv-pro.html'),'utf8'),readme=read('includes/pro/README.html');

// ---- tokens ----
const block=(src,selector)=>{const i=src.indexOf(selector+' {');assert.ok(i>=0,selector+' block exists');const start=src.indexOf('{',i)+1;return src.slice(start,src.indexOf('}',start));};
const decls=body=>Object.fromEntries([...body.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)].map(m=>[m[1],m[2].trim()]));
const light=decls(block(css,':root')),mediaDark=decls(block(css,':root:not([data-theme="light"])')),attrDark=decls(block(css,':root[data-theme="dark"]'));
const DERIVED=['--accent-line','--accent-tint','--accent-tint-strong'];
const theme=mode=>({...light,...(mode==='dark'?attrDark:{})});

test('dark tokens are declared identically for the system setting and the toggle, and cover every light token',()=>{
 assert.deepEqual(mediaDark,attrDark,'the media-query and [data-theme="dark"] blocks must match');
 assert.equal(light['color-scheme'],'light');assert.equal(attrDark['color-scheme'],'dark');
 for(const name of Object.keys(light))if(!DERIVED.includes(name))assert.ok(name in attrDark,name+' has a dark value');
 for(const name of Object.keys(attrDark))assert.ok(name in light,name+' has a light value');
 for(const name of DERIVED)assert.match(light[name],/color-mix\(in srgb, var\(--accent\)/,name+' is derived from the theme tokens');
 assert.match(css,/@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{/,'OS dark applies unless the toggle chose Light');
});

test('no stylesheet bypasses the toggle with its own colour-scheme query or fixed palette',()=>{
 assert.equal(css.match(/prefers-color-scheme/g).length,1,'only the token block reads the OS setting');
 assert.doesNotMatch(meta+neural,/prefers-color-scheme/);
 assert.deepEqual([...new Set(meta.match(/#[0-9a-f]{3,8}\b/gi))],['#0a1420'],'meta.css: only the letterbox behind video frames is fixed');
 assert.equal(neural.match(/#[0-9a-f]{3,8}\b/gi),null,'neural.css uses tokens only');
 assert.doesNotMatch(meta,/dark in both|dark panel in both/,'the Meta card follows the theme');
 // Outside the token block, familyRanks.css keeps only Pokémon type colours (identity, not theme).
 const rest=css.slice(css.indexOf('/* Theme toggle in the page header. */'));
 const fixed=[...rest.matchAll(/^.*#[0-9a-f]{3,8}\b.*$/gim)].map(m=>m[0]).filter(line=>!/pokemon-tile\[data-type=|var\(--pokemon-color,#888\)/.test(line));
 assert.deepEqual(fixed,[]);
});

test('every var() used by the stylesheets and charts resolves to a token or a property the code sets',()=>{
 const files=['includes/familyRanks.css','includes/meta/meta.css','includes/pro/neural.css','includes/meta/validation-metrics.js','includes/meta/timeline.js','includes/pro/neural.js','includes/pro/neural-portable.js','includes/pro/team-browser.js','includes/pro/team-comparison.js','includes/pro/detail.js'].map(read).join('\n');
 const defined=new Set([...files.matchAll(/(--[\w-]+)\s*:/g)].map(m=>m[1]));
 for(const m of files.matchAll(/setProperty\??\.?\(\s*'(--[\w-]+)'/g))defined.add(m[1]);
 for(const name of ['--rating-hue','--type-color'])defined.add(name);// set inline by the ranking and type renderers
 const used=new Set([...files.matchAll(/var\((--[\w-]+)/g)].map(m=>m[1]));
 const missing=[...used].filter(name=>!defined.has(name));
 assert.deepEqual(missing,[]);
});

// ---- contrast (WCAG 2.x relative luminance) ----
const hex=h=>{h=h.replace('#','');if(h.length===3)h=[...h].map(c=>c+c).join('');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255);};
const lum=h=>{const [r,g,b]=hex(h).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b;};
const contrast=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+.05)/(y+.05);};
function floor(mode,fg,bgs,min){const t=theme(mode);for(const bg of bgs){const ratio=contrast(t[fg],t[bg]);assert.ok(ratio>=min,`${mode}: ${fg} ${t[fg]} on ${bg} ${t[bg]} is ${ratio.toFixed(2)}:1, needs ${min}:1`);}}
for(const mode of ['light','dark'])test(`${mode} theme meets WCAG AA for text and 3:1 for marks and control boundaries`,()=>{
 const surfaces=['--bg','--panel','--sunken','--viz-surface'];
 for(const fg of ['--text','--text-2','--muted','--accent','--good-text','--bad-text','--warn-text','--info-text'])floor(mode,fg,surfaces,4.5);
 floor(mode,'--accent-ink',['--accent'],4.5);
 for(const fg of ['--control-line','--focus','--info-line'])floor(mode,fg,['--bg','--panel','--sunken'],3);
 for(const fg of ['--viz-axis','--viz-neutral'])floor(mode,fg,['--viz-surface','--panel'],3);
 // Series colours sit on --viz-surface (chart backgrounds); slots 1-5, 7 and 8 also clear 3:1 on plain cards.
 for(let i=1;i<=8;i++)floor(mode,'--viz-'+i,['--viz-surface'],3);
 for(const i of [1,2,3,4,5,7,8])floor(mode,'--viz-'+i,['--panel'],3);
 // Rated cells keep body text readable at both ends of the red-yellow-green scale.
 const t=theme(mode),hsl=(h,s,l)=>{s/=100;l/=100;const k=n=>(n+h/30)%12,a=s*Math.min(l,1-l),f=n=>l-a*Math.max(-1,Math.min(k(n)-3,9-k(n),1));return '#'+[f(0),f(8),f(4)].map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('');};
 for(const hue of [0,65,130])assert.ok(contrast(t['--text'],hsl(hue,parseFloat(t['--rating-s']),parseFloat(t['--rating-l'])))>=4.5,mode+' rated cell hue '+hue);
});
test('series colours are the dataviz palette in its fixed order, with each theme\'s validated step',()=>{
 const slots=mode=>Array.from({length:8},(_,i)=>theme(mode)['--viz-'+(i+1)]);
 assert.deepEqual(slots('light'),['#2a78d6','#d95926','#199e70','#c98500','#d55181','#008300','#4a3aa7','#e34948']);
 assert.deepEqual(slots('dark'),['#3987e5','#d95926','#199e70','#c98500','#d55181','#008300','#9085e9','#e66767']);
});

// ---- toggle behaviour (includes/theme.js) against a minimal DOM ----
function mount({stored,host=null,systemDark=false,blockStorage=false,toggles=1}={}){
 const attrs=new Map(host?[['data-theme',host]]:[]),events=[],store=new Map(stored?[['gbl-synapse.theme',stored]]:[]),observers=[],mediaListeners=[],docListeners={},winListeners={};
 const html={getAttribute:k=>attrs.has(k)?attrs.get(k):null,setAttribute:(k,v)=>attrs.set(k,String(v)),removeAttribute:k=>attrs.delete(k),hasAttribute:k=>attrs.has(k)};
 const markup=site.match(/<div class="theme-toggle"[\s\S]*?<\/div>/)[0],choices=[...markup.matchAll(/data-theme-choice="(\w+)" aria-pressed="(\w+)">(\w+)</g)];
 const groups=Array.from({length:toggles},()=>{const listeners=[],group={dataset:{},buttons:[],addEventListener:(type,fn)=>{if(type==='click')listeners.push(fn);},contains:n=>group.buttons.includes(n),querySelectorAll:()=>group.buttons,click:choice=>{const b=group.buttons.find(x=>x.choice===choice);for(const fn of listeners)fn({target:{closest:()=>b}});}};
  group.buttons=choices.map(([,choice,pressed,label])=>{const a=new Map([['data-theme-choice',choice],['aria-pressed',pressed]]);return {choice,label,title:'',getAttribute:k=>a.get(k)??null,setAttribute:(k,v)=>a.set(k,String(v))};});return group;});
 let ready='loading';
 const document={documentElement:html,get readyState(){return ready;},querySelectorAll:sel=>sel==='[data-theme-toggle]'?groups:[],addEventListener:(type,fn)=>(docListeners[type]??=[]).push(fn),dispatchEvent:e=>{events.push({type:e.type,...e.detail});return true;}};
 const media={matches:systemDark,addEventListener:(type,fn)=>mediaListeners.push(fn)};
 const ctx={document,matchMedia:q=>{assert.equal(q,'(prefers-color-scheme: dark)');return media;},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail;}},
  MutationObserver:class{constructor(cb){this.cb=cb;observers.push(this);}observe(target,opts){assert.equal(target,html);assert.deepEqual([...opts.attributeFilter],['data-theme']);}},
  addEventListener:(type,fn)=>(winListeners[type]??=[]).push(fn)};
 Object.defineProperty(ctx,'localStorage',{get(){if(blockStorage)throw new Error('SecurityError');return {getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v))};}});
 vm.createContext(ctx);vm.runInContext(themeSrc,ctx);
 const attrBeforeDom=html.getAttribute('data-theme');
 ready='interactive';for(const fn of docListeners.DOMContentLoaded||[])fn();
 const pressed=(g=0)=>groups[g].buttons.filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.choice);
 return {api:ctx.GblTheme,html,attrs,events,store,groups,pressed,attrBeforeDom,
  setSystem(dark){media.matches=dark;for(const fn of mediaListeners)fn();},
  hostStamps(v){if(v==null)attrs.delete('data-theme');else attrs.set('data-theme',v);for(const o of observers)o.cb([]);},
  otherTab(v){for(const fn of winListeners.storage||[])fn({key:'gbl-synapse.theme',newValue:v});}};
}

test('the header toggle offers System, Light and Dark, defaulting to System',()=>{
 const app=mount();assert.deepEqual(app.groups[0].buttons.map(b=>b.label),['System','Light','Dark']);
 assert.deepEqual(app.pressed(),['system']);assert.equal(app.attrs.has('data-theme'),false,'System leaves the theme to the media query');
 assert.equal(app.api.theme,'light');assert.match(app.groups[0].buttons[0].title,/device setting \(currently Light\)/);
});
test('a stored choice is applied when the script runs in <head>, before the page renders',()=>{
 for(const choice of ['light','dark']){const app=mount({stored:choice,systemDark:choice==='light'});assert.equal(app.attrBeforeDom,choice);assert.deepEqual(app.pressed(),[choice]);assert.equal(app.api.theme,choice);}
 assert.equal(mount({stored:'sepia'}).api.preference,'system','unknown values fall back to System');
});
test('picking a theme stores it, updates every toggle and announces the change once',()=>{
 const app=mount({toggles:2});app.groups[0].click('dark');
 assert.equal(app.attrs.get('data-theme'),'dark');assert.equal(app.store.get('gbl-synapse.theme'),'dark');assert.deepEqual([app.pressed(0),app.pressed(1)],[['dark'],['dark']]);
 assert.deepEqual(app.events,[{type:'gbl-theme-change',preference:'dark',theme:'dark'}]);
 app.groups[1].click('system');assert.equal(app.attrs.has('data-theme'),false);assert.equal(app.store.get('gbl-synapse.theme'),'system');
 assert.deepEqual(app.events.at(-1),{type:'gbl-theme-change',preference:'system',theme:'light'});
 app.groups[0].click('light');assert.equal(app.events.length,2,'System→Light on a light device changes nothing visible, so no event');
});
test('System follows the device setting live; an explicit choice ignores it',()=>{
 const app=mount();app.setSystem(true);assert.equal(app.api.theme,'dark');assert.deepEqual(app.events.at(-1),{type:'gbl-theme-change',preference:'system',theme:'dark'});
 assert.match(app.groups[0].buttons[0].title,/currently Dark/);
 app.api.set('light');app.setSystem(false);app.setSystem(true);assert.equal(app.api.theme,'light');assert.equal(app.attrs.get('data-theme'),'light');
});
test('artifact host: System keeps the host\'s data-theme, explicit choices win, and System restores the host value',()=>{
 const app=mount({host:'dark'});assert.equal(app.attrs.get('data-theme'),'dark');assert.equal(app.api.theme,'dark');
 assert.match(app.groups[0].buttons[0].title,/page host setting/);
 app.api.set('light');assert.equal(app.attrs.get('data-theme'),'light');
 app.hostStamps('dark');assert.equal(app.attrs.get('data-theme'),'light','the reader\'s Light choice is re-applied over a later host stamp');
 app.api.set('system');assert.equal(app.attrs.get('data-theme'),'dark','System hands control back to the host');
 app.hostStamps('light');assert.equal(app.api.theme,'light');assert.equal(app.events.at(-1).theme,'light');
 app.hostStamps(null);assert.equal(app.api.theme,'light','no stamp: the device setting decides');
});
test('blocked storage still switches themes for the page, and another tab\'s choice is picked up',()=>{
 const app=mount({blockStorage:true});app.groups[0].click('dark');assert.equal(app.attrs.get('data-theme'),'dark');assert.deepEqual(app.pressed(),['dark']);
 const other=mount();other.otherTab('dark');assert.equal(other.attrs.get('data-theme'),'dark');assert.deepEqual(other.pressed(),['dark']);
});
test('pure helpers: data-theme value and effective theme',()=>{
 const {attribute,effective}=mount().api;
 assert.equal(attribute('system',null),null);assert.equal(attribute('system','dark'),'dark');assert.equal(attribute('light','dark'),'light');assert.equal(attribute('system','sepia'),null);
 assert.equal(effective('system',null,true),'dark');assert.equal(effective('system','light',true),'light');assert.equal(effective('dark',null,false),'dark');
});

// ---- page wiring ----
test('site, artifact and README load theme.js synchronously in <head>, before any stylesheet',()=>{
 for(const [name,html,src] of [['site',site,'includes/theme.js'],['artifact',artifact,'includes/theme.js'],['README',readme,'../theme.js']]){
  const tag=html.match(new RegExp('<script[^>]*src="'+src.replace(/[.\/]/g,'\\$&')+'"[^>]*>'));assert.ok(tag,name+' loads theme.js');assert.doesNotMatch(tag[0],/defer|async/,name+': runs before first paint');
  assert.ok(html.indexOf(tag[0])<html.indexOf('rel="stylesheet"'),name+': before the stylesheets');
  assert.match(html,/<meta name="color-scheme" content="light dark">/,name+' declares both schemes');}
 assert.match(site,/<header class="site-header">\s*<div class="theme-toggle" data-theme-toggle role="group" aria-label="Colour theme">/,'the toggle sits in the page header');
 assert.ok(fs.readFileSync(path.join(web,'..','artifact','manifest.txt'),'utf8').split('\n').includes('includes/theme.js'),'the artifact ships theme.js');
});
