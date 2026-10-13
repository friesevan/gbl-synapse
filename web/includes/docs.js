// Documentation dialogs for the tools' README pairs. Each tool (Meta Extractor, Team Rankings) ships two
// Markdown documents next to its code: a plain-language summary and a technical reference. The info button
// opens one <dialog> that renders either, with a toggle, a contents list, figures (JPEG screenshots) and
// diagrams (SVG files, inlined so they take the page's colour tokens in both themes), and links between the
// two documents ("see the technical README, section X" switches the toggle and scrolls there).
//
// Markdown subset: #–#### headings (## entries make the contents list), paragraphs, nested - / 1. lists,
// | tables |, ``` fenced code, > blockquotes, --- rules, ![alt](file) images (a paragraph that is only an
// image becomes a <figure> with the alt text as its caption), [text](url) links and `code`, **bold**,
// *italic*. All text is escaped first; only http(s) links become external anchors. Relative links to the
// sibling document switch the toggle; other relative links open the file in a new tab.
//
// render(md, ctx) is pure (returns HTML text and the contents) so Node tests cover it; mount() wires a dialog.
(function(root){
'use strict';
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const slug=t=>String(t).replace(/`/g,'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
const basename=p=>String(p).split('/').pop();
const dirOf=p=>{const i=String(p).lastIndexOf('/');return i<0?'':p.slice(0,i+1);};
// Resolve `rel` against a base directory such as "includes/meta/" (handles ./ and ../ without leaving the site).
function resolvePath(base,rel){const parts=(base+rel).split('/'),out=[];for(const p of parts){if(p==='..'){if(out.length)out.pop();}else if(p!=='.'&&p!=='')out.push(p);}return out.join('/');}
const safeRelative=u=>!/^[a-z][a-z0-9+.-]*:/i.test(u)&&!u.startsWith('//');
// Inline Markdown. ctx: {base, docs:[{id,file}], prefix}. Code spans are protected first so their contents
// are never parsed; images and links are resolved; bold and italic last.
function inline(text,ctx={}){
 const codes=[],hold=s=>{codes.push(s);return '\u0000'+(codes.length-1)+'\u0000';};
 let s=esc(text).replace(/`([^`]+)`/g,(_,c)=>hold('<code>'+c+'</code>'));
 s=s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,(_,alt,src)=>hold(image(alt,src,ctx,true)));
 s=s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(_,label,url)=>hold(link(label,url,ctx)));
 s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g,'$1<em>$2</em>');
 return s.replace(/\u0000(\d+)\u0000/g,(_,i)=>codes[i]);
}
function image(alt,src,ctx,inlineImg){
 if(!safeRelative(src)&&!/^https:\/\//.test(src))return esc(alt);
 const href=/^https:\/\//.test(src)?src:resolvePath(ctx.base||'',src),svg=/\.svg$/i.test(href);
 if(inlineImg)return `<img class="gbl-doc-inline-img" src="${esc(href)}" alt="${esc(alt)}" loading="lazy">`;
 return `<figure class="gbl-doc-figure ${svg?'gbl-doc-diagram':'gbl-doc-shot'}"><img src="${esc(href)}" alt="${esc(alt)}" loading="lazy"${svg?' data-inline-svg="1"':''}><figcaption>${esc(alt)}</figcaption></figure>`;
}
function link(label,url,ctx){
 if(/^https?:\/\//i.test(url))return `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`;
 if(!safeRelative(url))return label;
 const [file,frag='']=url.split('#');
 if(!file)return `<a href="#" class="gbl-doc-switch" data-anchor="${esc(slug(decodeURIComponent(frag)))}">${label}</a>`;
 const target=(ctx.docs||[]).find(d=>basename(d.file)===basename(file));
 if(target)return `<a href="#" class="gbl-doc-switch" data-doc="${esc(target.id)}"${frag?` data-anchor="${esc(slug(decodeURIComponent(frag)))}"`:''}>${label}</a>`;
 return `<a href="${esc(resolvePath(ctx.base||'',file))}${frag?'#'+esc(frag):''}" target="_blank" rel="noopener">${label}</a>`;
}
// Block-level renderer. Returns {html, toc:[[id,text]], anchors:Set} ; the first "# title" line is dropped
// (the dialog shows its own title) and ## headings become the contents list.
function render(md,ctx={}){
 const lines=String(md).replace(/\r/g,'').split('\n'),out=[],toc=[],anchors=new Set(),prefix=ctx.prefix||'doc-';let i=0,titled=false;
 const heading=(level,text)=>{const id=prefix+slug(text);let unique=id,n=2;while(anchors.has(unique))unique=id+'-'+n++;anchors.add(unique);if(level===2)toc.push([unique,text.replace(/`/g,'')]);return `<h${Math.min(6,level+1)} id="${unique}">${inline(text,ctx)}</h${Math.min(6,level+1)}>`;};
 const isList=l=>/^\s*([-*]|\d+\.)\s+/.test(l),isTable=k=>/^\|/.test(lines[k]||'')&&/^\|[\s:|-]+\|?\s*$/.test(lines[k+1]||'');
 while(i<lines.length){const line=lines[i];
  if(/^```/.test(line)){const code=[];i++;while(i<lines.length&&!/^```/.test(lines[i]))code.push(lines[i++]);i++;out.push('<pre>'+esc(code.join('\n'))+'</pre>');continue;}
  const h=/^(#{1,4})\s+(.*)$/.exec(line);
  if(h){const level=h[1].length;i++;if(level===1&&!titled){titled=true;continue;}out.push(heading(level,h[2].trim()));continue;}
  if(/^\s*(-{3,}|\*{3,})\s*$/.test(line)){out.push('<hr>');i++;continue;}
  if(isTable(i)){const row=l=>l.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());const head=row(line);i+=2;const body=[];while(i<lines.length&&/^\|/.test(lines[i]))body.push(row(lines[i++]));
   out.push(`<div class="table-scroll" tabindex="0"><table><thead><tr>${head.map(c=>`<th>${inline(c,ctx)}</th>`).join('')}</tr></thead><tbody>${body.map(r=>`<tr>${r.map(c=>`<td>${inline(c,ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);continue;}
  if(/^>\s?/.test(line)){const q=[];while(i<lines.length&&/^>\s?/.test(lines[i]))q.push(lines[i++].replace(/^>\s?/,''));out.push('<blockquote>'+render(q.join('\n'),{...ctx,prefix:prefix+'q-'}).html+'</blockquote>');continue;}
  if(isList(line)){
   // Indentation of two or more spaces nests; indented lines without a marker continue the item.
   const rootList={children:[],ordered:/^\s*\d+\./.test(line)},stack=[{indent:/^\s*/.exec(line)[0].length,list:rootList}];let last=null;
   while(i<lines.length&&(isList(lines[i])||(/^\s{2,}\S/.test(lines[i])&&last))){const l=lines[i],m=/^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
    if(!m){last.text+=' '+l.trim();i++;continue;}const d=m[1].length;
    if(d>stack.at(-1).indent&&last){last.sub={children:[],ordered:/\d/.test(m[2])};stack.push({indent:d,list:last.sub});}
    else while(stack.length>1&&d<stack.at(-1).indent)stack.pop();
    last={text:m[3],sub:null};stack.at(-1).list.children.push(last);i++;}
   const build=list=>`<${list.ordered?'ol':'ul'}>`+list.children.map(it=>`<li>${inline(it.text,ctx)}${it.sub?build(it.sub):''}</li>`).join('')+`</${list.ordered?'ol':'ul'}>`;out.push(build(rootList));continue;}
  if(!line.trim()){i++;continue;}
  const para=[];while(i<lines.length&&lines[i].trim()&&!/^(#{1,4}\s|```|\||>|\s*(-{3,}|\*{3,})\s*$)/.test(lines[i])&&!isList(lines[i]))para.push(lines[i++].trim());
  const text=para.join(' '),fig=/^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(text);
  out.push(fig?image(fig[1],fig[2],ctx,false):'<p>'+inline(text,ctx)+'</p>');}
 return {html:out.join('\n'),toc,anchors};
}
// Inline an SVG file so its CSS variables (var(--text) …) resolve against the page theme. Scripts, foreign
// content and event attributes are dropped; on any failure the <img> stays.
async function inlineSvg(img){
 try{const r=await fetch(img.getAttribute('src'));if(!r.ok)return;const doc=new DOMParser().parseFromString(await r.text(),'image/svg+xml'),svg=doc.documentElement;
  if(svg.nodeName!=='svg'||doc.querySelector('parsererror'))return;
  for(const n of svg.querySelectorAll('script,foreignObject'))n.remove();
  for(const el of svg.querySelectorAll('*'))for(const a of [...el.attributes])if(/^on/i.test(a.name)||(/href$/i.test(a.name)&&/^\s*(javascript|data):/i.test(a.value)))el.removeAttribute(a.name);
  svg.setAttribute('role','img');if(img.alt)svg.setAttribute('aria-label',img.alt);svg.removeAttribute('width');svg.removeAttribute('height');
  img.replaceWith(document.importNode(svg,true));}catch{/* keep the image */}
}
// Mounts the toggle and body inside `dialog`'s `host` element. docs: [{id, label, file, hint}], first = default.
function mount({dialog,host,docs,storageKey,remember=true}){
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
 const state={current:null,cache:new Map(),loading:null};
 const bar=el('div',null,'gbl-docs-bar'),tabs=el('div',null,'pro-segmented');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Documentation version');
 const buttons=new Map();for(const d of docs){const b=el('button',d.label);b.type='button';b.setAttribute('role','tab');b.setAttribute('aria-selected','false');b.onclick=()=>show(d.id);buttons.set(d.id,b);tabs.append(b);}
 const side=el('div'),hint=el('p','','gbl-docs-hint'),raw=el('a','Open the Markdown file ↗','gbl-docs-raw');raw.target='_blank';raw.rel='noopener';side.append(hint,raw);side.style.display='grid';side.style.gap='4px';side.style.justifyItems='end';
 bar.append(tabs,side);const body=el('div',null,'gbl-docs-body');host.replaceChildren(bar,body);
 const remembered=()=>{try{return remember&&storageKey?localStorage.getItem(storageKey):null;}catch{return null;}};
 const keep=id=>{try{if(remember&&storageKey)localStorage.setItem(storageKey,id);}catch{/* storage unavailable */}};
 async function load(doc){if(state.cache.has(doc.id))return state.cache.get(doc.id);const r=await fetch(doc.file);if(!r.ok)throw Error('HTTP '+r.status);const md=await r.text();const rendered=render(md,{base:dirOf(doc.file),docs,prefix:'doc-'+doc.id+'-'});state.cache.set(doc.id,rendered);return rendered;}
 function scrollTo(anchor){if(!anchor)return;const id='doc-'+state.current+'-'+anchor,n=body.querySelector('#'+CSS.escape(id))||[...body.querySelectorAll('h3,h4,h5')].find(x=>x.id.endsWith('-'+anchor));if(n)n.scrollIntoView({block:'start',behavior:'smooth'});}
 async function show(id,anchor){const doc=docs.find(d=>d.id===id)||docs[0];for(const [k,b] of buttons)b.setAttribute('aria-selected',String(k===doc.id));hint.textContent=doc.hint||'';raw.href=doc.file;
  if(state.current===doc.id&&body.childElementCount){scrollTo(anchor);return;}
  state.current=doc.id;keep(doc.id);body.replaceChildren(el('p','Loading…','gbl-docs-status'));const token=state.loading={};
  try{const {html,toc}=await load(doc);if(state.loading!==token)return;
   const nav=el('nav',null,'meta-readme-toc');nav.setAttribute('aria-label','Sections');nav.append(el('strong','Contents'));const ol=el('ol');for(const [hid,text] of toc){const li=el('li'),b=el('button',text,'linklike');b.type='button';b.onclick=()=>body.querySelector('#'+CSS.escape(hid))?.scrollIntoView({block:'start',behavior:'smooth'});li.append(b);ol.append(li);}nav.append(ol);
   const article=el('article',null,'meta-readme');article.innerHTML=html;body.replaceChildren(nav,article);
   for(const img of article.querySelectorAll('img[data-inline-svg]'))inlineSvg(img);
   if(anchor)requestAnimationFrame(()=>scrollTo(anchor));else dialog.scrollTop=0;}
  catch(e){if(state.loading===token)body.replaceChildren(el('p',`This document couldn’t be loaded (${e.message}).`,'gbl-docs-status'));}}
 body.addEventListener('click',e=>{const a=e.target.closest('a.gbl-doc-switch');if(!a)return;e.preventDefault();show(a.dataset.doc||state.current,a.dataset.anchor||'');});
 function open(id,anchor){if(!dialog.open)dialog.showModal();show(id||state.current||remembered()||docs[0].id,anchor);}
 return {open,show,render};
}
const api={render,inline,slug,resolvePath,mount,inlineSvg};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.GblDocs=api;
})(typeof window==='undefined'?globalThis:window);
