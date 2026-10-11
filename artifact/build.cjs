#!/usr/bin/env node
// Assembles the claude.ai artifact (PvP IV Pro with the Meta Extractor and Full Team Neural Network)
// from this repo: the artifact's own page and shim from artifact/, everything else from web/ as listed
// in artifact/manifest.txt. Publish the output folder with pvp-iv-pro.html as the page.
// Usage: node artifact/build.cjs OUT_DIR
const fs=require('node:fs'),path=require('node:path');
const out=process.argv[2];if(!out){console.error('Usage: node artifact/build.cjs OUT_DIR');process.exit(1);}
const here=__dirname,web=path.join(here,'..','web');
const copy=(from,to)=>{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);};
const list=fs.readFileSync(path.join(here,'manifest.txt'),'utf8').split('\n').map(s=>s.trim()).filter(Boolean);
let n=0;for(const f of list){const src=path.join(web,f);if(!fs.existsSync(src)){console.error('missing in web/:',f);process.exitCode=1;continue;}copy(src,path.join(out,f));n++;}
copy(path.join(here,'pvp-iv-pro.html'),path.join(out,'pvp-iv-pro.html'));copy(path.join(here,'includes','artifact-shim.js'),path.join(out,'includes','artifact-shim.js'));
console.log(`${n+2} files → ${out}`);
