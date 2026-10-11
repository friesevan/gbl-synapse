#!/usr/bin/env node
// Scores which opponent species a run found against a species list (meta-benchmark-species-v1), for
// edited videos where battle boundaries and results can't be labelled. The list is a lower bound
// (contact sheets every 5 s), so "extra" species are printed for checking by eye, not counted wrong.
// Usage: node score-species.cjs labels/youtube/ID.json run.json
const fs=require('node:fs');
const [labelsPath,runPath]=process.argv.slice(2),labels=JSON.parse(fs.readFileSync(labelsPath,'utf8')),run=JSON.parse(fs.readFileSync(runPath,'utf8'));
// "Kyogre (Primal)" (PvPoke) and "Primal Kyogre" (nameplate) are the same form; other brackets are dropped.
const norm=s=>String(s||'').replace(/^(.*) \((Mega|Primal)( [XY])?\)$/,'$2 $1$3').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s*\([^)]*\)/g,'').replace(/[^a-z0-9]/g,'');
const truth=new Set(labels.oppSpecies.map(norm)),got=new Map();
for(const b of run.battles)for(const n of b.opponent){const k=norm(n);if(k)got.set(k,(got.get(k)||0)+1);}
const found=[...truth].filter(n=>got.has(n)),missed=[...truth].filter(n=>!got.has(n)),extra=[...got.keys()].filter(n=>!truth.has(n));
console.log(`${labels.recording} · species only (${labels.layout})`);
console.log(`  opponent species     recall ${(100*found.length/truth.size).toFixed(0)}% (${found.length}/${truth.size}), battles detected ${run.battles.length}`);
if(missed.length)console.log(`  missed: ${missed.join(', ')}`);
if(extra.length)console.log(`  not in list (check by eye): ${extra.join(', ')}`);
if(run.seconds)console.log(`  time ${run.seconds.toFixed(1)} s`);
