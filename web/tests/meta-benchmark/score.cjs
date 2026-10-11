#!/usr/bin/env node
// Scores a Meta Extractor run against benchmark labels.
// Usage: node score.cjs labels/10min.json run.json
// run.json: {seconds, ocrReads, battles:[{start,end,result,my:[name],opponent:[name]}]}
// Names are compared as visible species names (form/Shadow are scored separately later).
const fs=require('node:fs');
// "Kyogre (Primal)" (PvPoke) and "Primal Kyogre" (nameplate) are the same form; other brackets are dropped.
const norm=s=>String(s||'').replace(/^(.*) \((Mega|Primal)( [XY])?\)$/,'$2 $1$3').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s*\([^)]*\)/g,'').replace(/[^a-z0-9]/g,'');
const [labelsPath,runPath]=process.argv.slice(2);
const labels=JSON.parse(fs.readFileSync(labelsPath,'utf8')),run=JSON.parse(fs.readFileSync(runPath,'utf8'));
const overlap=(a,b)=>Math.max(0,Math.min(a.end,b.end)-Math.max(a.start,b.start));
const used=new Set(),pairs=[];
for(const truth of labels.battles){let best=null,bestO=0;run.battles.forEach((b,i)=>{const o=overlap(truth,b);if(!used.has(i)&&o>bestO){best=i;bestO=o;}});if(best!==null){used.add(best);pairs.push([truth,run.battles[best]]);}else pairs.push([truth,null]);}
const s={battles:labels.battles.length,found:pairs.filter(p=>p[1]).length,extra:run.battles.length-used.size,oppTP:0,oppFP:0,oppFN:0,lead:0,leadOf:0,resultRight:0,resultWrong:0,resultMissed:0,teamsExact:0,teamsTruth:0,ending:0,endingOf:0,endingExtra:0};
const misses=[];
for(const [t,b] of pairs){const truth=new Set(t.opp.map(norm)),got=new Set((b?.opponent||[]).map(norm));
 for(const n of got)truth.has(n)?s.oppTP++:(s.oppFP++,misses.push(`#${t.n} extra opponent ${n}`));
 for(const n of truth)if(!got.has(n)){s.oppFN++;misses.push(`#${t.n} missed opponent ${n}`);}
 if(t.oppLead){s.leadOf++;if(b&&norm(b.opponent[0])===norm(t.oppLead))s.lead++;else misses.push(`#${t.n} lead ${b?.opponent[0]||'none'} ≠ ${t.oppLead}`);}
 if(t.result!=='Unknown'){if(!b||b.result==='Unknown'){s.resultMissed++;misses.push(`#${t.n} result missed (${t.result})`);}else if(b.result===t.result)s.resultRight++;else{s.resultWrong++;misses.push(`#${t.n} result ${b.result} ≠ ${t.result}`);}}
 if(t.ending){s.endingOf++;if(b?.ending===t.ending)s.ending++;else misses.push(`#${t.n} ending ${b?.ending||'none'} ≠ ${t.ending}`);}else if(b?.ending&&!t.endingUncertain){s.endingExtra++;misses.push(`#${t.n} ending ${b.ending} not in labels`);}
 if(t.opp.length===3){s.teamsTruth++;if(b&&truth.size===got.size&&[...truth].every(n=>got.has(n))&&norm(b.opponent[0])===norm(t.oppLead))s.teamsExact++;}}
const pct=(a,b)=>b?`${(100*a/b).toFixed(0)}% (${a}/${b})`:'—';
console.log(`${labels.recording} · ${run.pipeline||'run'}`);
console.log(`  battles found        ${pct(s.found,s.battles)}, extra ${s.extra}`);
console.log(`  opponent species     recall ${pct(s.oppTP,s.oppTP+s.oppFN)}, precision ${pct(s.oppTP,s.oppTP+s.oppFP)}`);
console.log(`  opponent lead        ${pct(s.lead,s.leadOf)}`);
console.log(`  results              correct ${pct(s.resultRight,s.resultRight+s.resultWrong+s.resultMissed)}, wrong ${s.resultWrong}, missed ${s.resultMissed}`);
if(s.endingOf||s.endingExtra)console.log(`  forfeits             correct ${pct(s.ending,s.endingOf)}, extra ${s.endingExtra}`);
console.log(`  complete teams exact ${pct(s.teamsExact,s.teamsTruth)}`);
if(run.seconds)console.log(`  time ${run.seconds.toFixed(1)} s for ${(labels.durationS/60).toFixed(1)} min video (${(labels.durationS/run.seconds).toFixed(1)}× real time), ${run.ocrReads} text reads`);
for(const m of misses)console.log('   - '+m);
