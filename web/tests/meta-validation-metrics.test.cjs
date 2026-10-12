// Model performance view (includes/meta/validation-metrics.js): history helpers and DOM rendering.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Node{
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.dataset={};this.attributes={};this.style={setProperty:(k,v)=>{this.style[k]=v;}};this.hidden=false;this.open=false;this.className='';this._text='';}
 get textContent(){return this._text+this.children.map(x=>typeof x==='string'?x:x.textContent).join('');}set textContent(x){this._text=String(x??'');this.children=[];}
 append(...nodes){for(const n of nodes){if(typeof n==='string'){this.children.push(n);continue;}n.parentNode?.children.splice(n.parentNode.children.indexOf(n),1);n.parentNode=this;this.children.push(n);}}
 get lastChild(){return this.children.at(-1);}replaceChildren(...nodes){this.children=[];this.append(...nodes);}remove(){this.parentNode?.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=null;}
 setAttribute(k,v){this.attributes[k]=String(v);}getAttribute(k){return this.attributes[k];}
}
const walk=n=>[n,...n.children.filter(x=>typeof x!=='string').flatMap(walk)];
function load(){const document={createElement:t=>new Node(t),createElementNS:(_,t)=>new Node(t)},window={};const ctx=vm.createContext({window,document,console,Math,JSON,Date,Number,String,Object,Array,Set,Map});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../includes/meta/validation-metrics.js'),'utf8'),ctx);return window.MetaValidationMetrics;}
const M=load();
const rec=(refit,extra={})=>({refit,at:`2026-10-11T${String(10+refit%10).padStart(2,'0')}:00:00+00:00`,labels:{shadow:refit*10,fastMove:refit},answers:{shadow:refit*10,fastMove:refit},...extra});
const held=(f,s,fo)=>({heldOut:{...(f?{fastMove:{right:f,total:200}}:{}),...(s?{shadow:{right:s,total:400,auc:.8+s/10000,logLoss:.5,baseline:{right:280,total:400,auc:.73,logLoss:.65}}}:{}),...(fo?{form:{right:fo,total:30}}:{})}});
const status=(open,model,free=0)=>({open:{shadow:open},resolved:{model:{shadow:model},...(free?{freellm:{footage:free}}:{})},questions:1000});
const history={format:'gbl-validation-metrics',revision:3,records:[rec(1,{backfilled:true,source:'files'}),rec(2,{...held(150,300),...status(700,100)}),rec(3,{...held(160,null,20),...status(650,120,5),reason:'Manual refit',calibration:{shadow:[[.1,.05,20],[.9,.85,30]],fastMove:[[.6,.55,10]]},gates:{fastMove:{threshold:.8,resolveAt:.9,right:127,total:131,videos:21,lowerBound:.92,resolving:true,sweep:[[.9,98,100]]}}})],
 milestones:[{at:'2026-10-11T08:43:11+00:00',commit:'13279f9',change:'Fast-move and form model v4',source:'README',fastMove:{before:{right:153,total:197},after:{right:161,total:197}}}]};

test('tiles compare each kind with the previous refit that measured it, never inventing a value',()=>{
 const t=M.tiles(history,{answers:400,notSure:3,resolved:130,resolvedModel:125,resolvedFree:5,open:640,questions:1000});const by=Object.fromEntries(t.map(x=>[x.key,x]));
 assert.equal(by.fastMove.value,'80%');assert.match(by.fastMove.delta.text,/▲ 5\.0 pts vs refit 2/);assert.equal(by.fastMove.delta.dir,1);
 assert.equal(by.shadow.value,'75%');assert.match(by.shadow.delta.text,/First measured at refit 2/,'refit 3 has no Shadow value; the tile keeps refit 2 instead of a zero');
 assert.equal(by.form.value,'67%');assert.match(by.form.delta.text,/First measured at refit 3/);assert.equal(by.result,undefined,'Battle outcome has no held-out metric, so no tile');
 assert.match(by.answers.delta.text,/\+367 since refit 3/);assert.match(by.answers.detail,/397 confirmed · 3 not sure/);
 assert.match(by.open.delta.text,/−10 since refit 3/);assert.match(by.resolved.detail,/125 model · 5 LLM/);assert.match(by.resolved.delta.text,/\+5 since refit 3/);});
test('series keep gaps: refits without a metric or without complete queue counts are left out',()=>{
 assert.deepEqual(M.accuracySeries(history).map(r=>r.refit),[2,3]);assert.equal(M.accuracySeries(history)[1].values.shadow,null);
 assert.deepEqual(M.statusSeries(history).map(r=>[r.refit,r.answered,r.resolved,r.open]),[[2,200,100,700],[3,225,125,650]]);
 assert.deepEqual(M.shadowSeries(history).map(r=>r.refit),[2]);});
test('render draws labelled charts with table twins, calibration panels and the offline milestones',()=>{
 const host=new Node('section');M.render(host,{history,live:{answers:400,open:640,questions:1000,resolved:130,resolvedModel:125,resolvedFree:5},learning:{status:'idle'},mode:'local',width:900});
 const text=host.textContent,figs=walk(host).filter(n=>n.tagName==='FIGURE');
 for(const title of ['Held-out accuracy by refit','Shadow classifier · AUC','Shadow classifier · log-loss','Questions after each refit','Shadow classifier','Fast moves'])assert.ok(figs.some(f=>f.children[0].textContent.startsWith(title)),title);
 assert.match(text,/Updated after refit 3 · .* · Manual refit/);assert.match(text,/Calibration at refit 3/);assert.match(text,/Model changes measured offline/);assert.match(text,/77\.7% → 81\.7%/);
 assert.equal(figs.length,walk(host).filter(n=>n.tagName==='DETAILS'&&n.className==='meta-perf-table').length,'every chart has a data table');
 const svgs=walk(host).filter(n=>n.tagName==='SVG');assert.ok(svgs.every(s=>s.attributes.role==='img'&&/arrow keys/.test(s.attributes['aria-label'])&&s.attributes.tabindex==='0'));
 const acc=figs.find(f=>f.children[0].textContent.startsWith('Held-out accuracy')),paths=walk(acc).filter(n=>n.tagName==='PATH');assert.equal(paths.length,1,'only the fast-move series has two consecutive points');
 assert.match(walk(acc).find(n=>n.tagName==='TABLE').textContent,/80\.0% \(160\/200\)/);
 assert.match(text,/Gate passed at confidence ≥ 80%: 127 of 131 held-out answers right over 21 videos.*Resolves at ≥ 90%, the minimum allowed \(98 of 100 right/);});
test('keyboard reading shows every series at the selected refit; backfilled points are marked',()=>{
 const h={records:[rec(4,{...held(150,300),backfilled:true,source:'files'}),rec(5,held(160,320))]},host=new Node('section');M.render(host,{history:h,live:{},width:900});
 const svg=walk(host).find(n=>n.tagName==='SVG'),tip=walk(host).find(n=>n.className.startsWith('meta-perf-tip'));svg.onfocus();assert.equal(tip.hidden,false);assert.match(tip.textContent,/Refit 5/);assert.match(tip.textContent,/80\.0%Fast move · 160\/200/);assert.match(tip.textContent,/80\.0%Shadow · 320\/400/);
 svg.onkeydown({key:'ArrowLeft',preventDefault(){}});assert.match(tip.textContent,/Refit 4.*Backfilled/);svg.onblur();assert.equal(tip.hidden,true);
 assert.ok(walk(svg).some(n=>n.tagName==='CIRCLE'&&n.attributes.class==='meta-perf-dot hollow'));assert.match(host.textContent,/Hollow: backfilled from saved files/);});
test('re-rendering keeps opened disclosures open',()=>{const host=new Node('section');M.render(host,{history,live:{},width:900});const hist=walk(host).find(n=>n.dataset.key==='history');hist.open=true;M.render(host,{history,live:{},width:900});assert.equal(walk(host).find(n=>n.dataset.key==='history').open,true);assert.match(walk(host).find(n=>n.dataset.key==='history').textContent,/Backfilled/);});
test('without a history the view explains where refit charts come from and still shows live counts',()=>{const host=new Node('section');M.render(host,{history:null,live:{answers:12,open:30,questions:42,resolved:0,resolvedModel:0,resolvedFree:0,agreement:{shadow:{right:3,total:4}}},mode:'shared',width:360});
 assert.equal(walk(host).filter(n=>n.tagName==='SVG').length,0);assert.match(host.textContent,/recorded by the local app/);assert.match(host.textContent,/Answers given12/);assert.match(host.textContent,/model’s pick matched you for shadow 75% \(4\)/);});
test('narrow widths drop end labels and stack small multiples in one column',()=>{const host=new Node('section');M.render(host,{history,live:{},width:320});const multi=walk(host).filter(n=>n.className==='meta-perf-multi');assert.ok(multi.length>=2);assert.ok(multi.every(m=>m.style.gridTemplateColumns==='repeat(1,minmax(0,1fr))'));assert.equal(walk(host).filter(n=>n.attributes.class==='meta-perf-end').length,0);});
test('a single refit still reads: larger markers, value labels spread with leader lines, labelled column segments',()=>{
 // One backfilled refit, three kinds within a few points of each other (the owner's first recorded refit).
 const h={records:[rec(51,{backfilled:true,heldOut:{fastMove:{right:165,total:197},shadow:{right:325,total:410,auc:.871,logLoss:.458,baseline:{right:300,total:410,auc:.73,logLoss:.646}},form:{right:27,total:31}},...status(3881,488),questions:4910})]};
 for(const width of [900,340]){const host=new Node('section');M.render(host,{history:h,live:{},width});
  const figs=walk(host).filter(n=>n.tagName==='FIGURE'),acc=figs.find(f=>f.children[0].textContent.startsWith('Held-out accuracy'));
  const dots=walk(acc).filter(n=>n.tagName==='CIRCLE');assert.equal(dots.length,3);
  assert.ok(dots.every(d=>d.attributes.r==='7'&&d.attributes.class==='meta-perf-dot hollow solo'&&d.attributes.fill==='var(--pf-panel)'),'single backfilled points: large hollow markers');
  const labels=walk(acc).filter(n=>n.tagName==='TEXT'&&/meta-perf-(end|value)/.test(n.attributes.class)).map(n=>[n.textContent,+n.attributes.y]);
  assert.equal(labels.length,3,'no label is dropped when values sit close together');
  const ys=labels.map(l=>l[1]).sort((a,b)=>a-b);assert.ok(ys[1]-ys[0]>=15&&ys[2]-ys[1]>=15,'labels are spread apart');
  assert.ok(walk(acc).some(n=>n.attributes.class==='meta-perf-leader'),'moved labels keep a leader line to their point');
  assert.ok(labels.some(l=>l[0].endsWith('83.8%'))&&labels.some(l=>l[0].endsWith('87.1%')));
  if(width===900)assert.ok(labels.some(l=>l[0]==='Fast move 83.8%'),'wide charts name the series in the label');
  const auc=figs.find(f=>f.children[0].textContent.startsWith('Shadow classifier · AUC'));assert.deepEqual(walk(auc).filter(n=>n.attributes.class==='meta-perf-value').map(n=>n.textContent).sort(),['0.730','0.871']);
  const stack=figs.find(f=>f.children[0].textContent.startsWith('Questions after each refit'));
  assert.deepEqual(walk(stack).filter(n=>n.attributes.class==='meta-perf-value').map(n=>n.textContent).sort(),['3,881 open','488 model resolved','541 human answered']);}
});
test('chart colours are theme variables, never fixed hex, so a theme switch recolours without re-rendering',()=>{
 const host=new Node('section');M.render(host,{history,live:{},width:900});
 const painted=walk(host).flatMap(n=>['fill','stroke'].map(k=>n.attributes[k]).concat(n.style?.['--key']??[])).filter(Boolean);
 assert.ok(painted.length>20);assert.deepEqual(painted.filter(v=>!/^var\(--[\w-]+\)$/.test(v)),[]);
 const src=fs.readFileSync(path.join(__dirname,'../includes/meta/validation-metrics.js'),'utf8');assert.doesNotMatch(src,/#[0-9a-f]{6}\b/i);
});
