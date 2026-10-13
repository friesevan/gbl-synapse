// Documentation dialogs (includes/docs.js): the Markdown renderer, and the integrity of the two README pairs
// (Meta Extractor, Team Rankings): every figure exists, every link between the plain and technical documents
// points at a real heading, and the site, the artifact page and the artifact manifest ship what they render.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const web=path.join(__dirname,'..'),D=require('../includes/docs.js');
const read=f=>fs.readFileSync(path.join(web,f),'utf8');

test('headings become the contents list with stable ids; the title line is dropped',()=>{
 const r=D.render('# Title\n\n## 1. Purpose and goals\n\ntext\n\n### Sub heading\n\n#### Deeper\n\n## Second',{prefix:'doc-t-'});
 assert.deepEqual(r.toc,[['doc-t-1-purpose-and-goals','1. Purpose and goals'],['doc-t-second','Second']]);
 assert.match(r.html,/<h3 id="doc-t-1-purpose-and-goals">1\. Purpose and goals<\/h3>/);
 assert.match(r.html,/<h4 id="doc-t-sub-heading">Sub heading<\/h4>/);assert.match(r.html,/<h5 id="doc-t-deeper">Deeper<\/h5>/);
 assert.doesNotMatch(r.html,/Title/);
});
test('duplicate headings get distinct ids',()=>{const r=D.render('## Same\n\n## Same',{});assert.deepEqual(r.toc.map(x=>x[0]),['doc-same','doc-same-2']);});
test('text is escaped; only http(s) links open externally; anchors and sibling documents become switches',()=>{
 const ctx={base:'includes/meta/',docs:[{id:'plain',file:'includes/meta/README-plain.md'},{id:'technical',file:'includes/meta/README.md'}]};
 const r=D.render('<b>x</b> & `a<b>` [ext](https://example.com/a?b=1) [here](#10-gaps) [tech](README.md#4-how) [plain](README-plain.md) [perf](../../training/team-search/PERFORMANCE.md) [bad](javascript:alert) end',ctx).html;
 assert.match(r,/&lt;b&gt;x&lt;\/b&gt; &amp; <code>a&lt;b&gt;<\/code>/);
 assert.match(r,/<a href="https:\/\/example.com\/a\?b=1" target="_blank" rel="noopener">ext<\/a>/);
 assert.match(r,/<a href="#" class="gbl-doc-switch" data-anchor="10-gaps">here<\/a>/);
 assert.match(r,/<a href="#" class="gbl-doc-switch" data-doc="technical" data-anchor="4-how">tech<\/a>/);
 assert.match(r,/<a href="#" class="gbl-doc-switch" data-doc="plain">plain<\/a>/);
 assert.match(r,/<a href="training\/team-search\/PERFORMANCE.md" target="_blank" rel="noopener">perf<\/a>/);
 assert.match(r,/ bad end<\/p>/);assert.doesNotMatch(r,/javascript:/);
});
test('a paragraph that is only an image becomes a figure with a caption; svg figures are marked for inlining; inline images stay inline',()=>{
 const r=D.render('![A caption](docs/a.jpg)\n\n![Diagram](docs/d.svg)\n\nText with ![icon](x.png) inside.',{base:'includes/meta/'}).html;
 assert.match(r,/<figure class="gbl-doc-figure gbl-doc-shot"><img src="includes\/meta\/docs\/a.jpg" alt="A caption" loading="lazy"><figcaption>A caption<\/figcaption><\/figure>/);
 assert.match(r,/<figure class="gbl-doc-figure gbl-doc-diagram"><img src="includes\/meta\/docs\/d.svg" alt="Diagram" loading="lazy" data-inline-svg="1">/);
 assert.match(r,/<p>Text with <img class="gbl-doc-inline-img" src="includes\/meta\/x.png" alt="icon" loading="lazy"> inside.<\/p>/);
});
test('tables, nested lists, fenced code, blockquotes and rules render',()=>{
 const r=D.render('| a | b |\n| --- | --- |\n| 1 | **2** |\n\n- one\n  - two\n    continued\n- three\n\n1. x\n2. y\n\n```\n<raw> & code\n```\n\n> quoted **bold**\n> more\n\n---\n',{}).html;
 assert.match(r,/<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td><strong>2<\/strong><\/td><\/tr><\/tbody><\/table>/);
 assert.match(r,/<ul><li>one<ul><li>two continued<\/li><\/ul><\/li><li>three<\/li><\/ul>/);assert.match(r,/<ol><li>x<\/li><li>y<\/li><\/ol>/);
 assert.match(r,/<pre>&lt;raw&gt; &amp; code<\/pre>/);assert.match(r,/<blockquote><p>quoted <strong>bold<\/strong> more<\/p><\/blockquote>/);assert.match(r,/<hr>/);
});
test('resolvePath never escapes the site root',()=>{assert.equal(D.resolvePath('includes/meta/','../../training/x.md'),'training/x.md');assert.equal(D.resolvePath('includes/meta/','../../../../etc/passwd'),'etc/passwd');assert.equal(D.resolvePath('','./a/b.svg'),'a/b.svg');});

// ---- The shipped documents ----
const pairs=[
 {name:'Meta Extractor',dir:'includes/meta/',docs:[{id:'plain',file:'includes/meta/README-plain.md'},{id:'technical',file:'includes/meta/README.md'}]},
 {name:'Team Rankings',dir:'training/team-search/',docs:[{id:'plain',file:'training/team-search/README-plain.md'},{id:'technical',file:'training/team-search/README.md'}]},
];
const manifest=new Set(fs.readFileSync(path.join(web,'..','artifact','manifest.txt'),'utf8').split('\n').map(s=>s.trim()).filter(Boolean));
for(const pair of pairs){
 const rendered=Object.fromEntries(pair.docs.map(d=>[d.id,D.render(read(d.file),{base:pair.dir,docs:pair.docs,prefix:'doc-'+d.id+'-'})]));
 test(pair.name+': both documents render with a contents list, and the pair link to each other',()=>{
  for(const d of pair.docs)assert.ok(rendered[d.id].toc.length>=5,d.file+' has sections');
  assert.match(rendered.plain.html,/data-doc="technical"/,'plain links to technical');assert.match(rendered.technical.html,/data-doc="plain"/,'technical links to plain');
 });
 test(pair.name+': every figure referenced exists on disk and is shipped in the artifact manifest',()=>{
  for(const d of pair.docs){const md=read(d.file);for(const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)){const file=D.resolvePath(pair.dir,m[1]);assert.ok(fs.existsSync(path.join(web,file)),file+' exists');assert.ok(manifest.has(file),file+' in artifact manifest');}}
 });
 test(pair.name+': every link between the two documents points at a heading that exists',()=>{
  for(const d of pair.docs){const md=read(d.file);for(const m of md.matchAll(/\[[^\]]+\]\(([^)\s#]*)#([^)\s]+)\)/g)){const file=m[1],frag=D.slug(decodeURIComponent(m[2]));const target=file?pair.docs.find(x=>path.basename(x.file)===path.basename(file)):d;if(!target)continue;assert.ok(rendered[target.id].anchors.has('doc-'+target.id+'-'+frag),`${d.file}: #${m[2]} in ${target.file}`);}}
 });
 test(pair.name+': the documents and the renderer are in the artifact manifest',()=>{for(const d of pair.docs)assert.ok(manifest.has(d.file),d.file);assert.ok(manifest.has('includes/docs.js'));});
}
test('site and artifact pages load docs.js and give both dialogs a body for the renderer',()=>{
 for(const [name,html] of [['site',read('familyRanks.html')],['artifact',fs.readFileSync(path.join(web,'..','artifact','pvp-iv-pro.html'),'utf8')]]){
  assert.match(html,/<script defer src="includes\/docs\.js(\?v=[\w-]+)?"><\/script>/,name+' loads docs.js');
  assert.ok(html.indexOf('includes/docs.js')<html.indexOf('includes/pro/neural.js'),name+': docs.js before neural.js');
  assert.ok(html.indexOf('includes/docs.js')<html.indexOf('includes/meta/ui.js'),name+': docs.js before meta/ui.js');
  for(const id of ['nnHelpBody','metaHelpBody'])assert.match(html,new RegExp('id="'+id+'"'),name+' has #'+id);
  assert.match(html,/<dialog id="nnHelp" class="gbl-docs-dialog"/);assert.match(html,/<dialog id="metaHelp" class="meta-help gbl-docs-dialog"/);
 }
 assert.match(read('includes/pro/neural.js'),/GblDocs\.mount\(\{dialog:\$\('nnHelp'\)/);assert.match(read('includes/meta/ui.js'),/GblDocs\.mount\(\{dialog:\$\('metaHelp'\)/);
});
