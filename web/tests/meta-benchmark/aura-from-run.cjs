#!/usr/bin/env node
// Extracts the per-matchup aura measurements a run-node.cjs run already made (no video decoding), in
// the format aura-features.cjs writes, for tune-learned.cjs (AURA=) and aura-analyze.cjs.
// Usage: node aura-from-run.cjs RUN.json OUT.json
const fs=require('node:fs'),[runPath,out]=process.argv.slice(2),run=JSON.parse(fs.readFileSync(runPath,'utf8')),rows=[];
run.full.forEach((b,battle)=>{for(const g of b.matchups||[])rows.push({battle,opponent:g.opponent,my:g.my,start:g.start,end:g.end,auraOpponent:g.auraOpponent,auraMy:g.auraMy});});
fs.writeFileSync(out,JSON.stringify(rows));console.log(`${rows.length} matchups → ${out}`);
