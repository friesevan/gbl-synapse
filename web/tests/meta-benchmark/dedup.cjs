#!/usr/bin/env node
// Finds the same battle appearing in more than one upload (reposts, compilations, overlapping clips)
// in a folder of run outputs, without merging genuinely repeated battles against the same team.
// Two battles match when both teams (in reveal order) and the result agree AND their event timelines
// line up: every faint and charged move at the same time relative to the battle start, within 2 s,
// with at least 4 such events. Two real battles almost never share a whole timeline, while a repost
// re-encodes the same one.
// Usage: node dedup.cjs RUN_DIR [OUT.json]
const fs=require('node:fs'),path=require('node:path');
const [dir,outPath]=process.argv.slice(2);
const runs=fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!/\.part\d+\.json$|batch-summary|duplicates/.test(f)).map(f=>({file:f,r:JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))})).filter(x=>x.r.full);
const battles=[];for(const {file,r} of runs)r.full.forEach((b,i)=>{const ev=(b.events||[]).filter(e=>e.kind==='faint'||e.kind==='move').map(e=>({k:e.kind==='faint'?`F:${e.side}`:`M:${e.move}`,t:e.t-b.start}));
 battles.push({id:`${file}#${i+1}`,recording:r.recording,start:b.start,my:b.my.map(p=>p.key),opp:b.opponent.map(p=>p.key),result:b.result,ev});});
function timelinesMatch(a,b){if(a.ev.length<4||b.ev.length<4||Math.abs(a.ev.length-b.ev.length)>1)return false;
 // Align on the first event of the same kind, then require every event to have a partner within 2 s.
 const offset=(()=>{for(const x of a.ev){const y=b.ev.find(e=>e.k===x.k);if(y)return y.t-x.t;}return 0;})();let hits=0;const used=new Set();
 for(const x of a.ev){const j=b.ev.findIndex((y,i)=>!used.has(i)&&y.k===x.k&&Math.abs(y.t-x.t-offset)<=2);if(j>=0){used.add(j);hits++;}}return hits>=Math.min(a.ev.length,b.ev.length)-1&&hits>=4;}
const groups=[];const seen=new Set();
for(let i=0;i<battles.length;i++){if(seen.has(i))continue;const a=battles[i],g=[a];
 for(let j=i+1;j<battles.length;j++){const b=battles[j];if(seen.has(j)||b.recording===a.recording&&Math.abs(b.start-a.start)<5)continue;
  if(a.result===b.result&&a.opp.join()===b.opp.join()&&a.my.join()===b.my.join()&&timelinesMatch(a,b)){g.push(b);seen.add(j);}}
 if(g.length>1)groups.push(g.map(x=>({id:x.id,recording:x.recording,start:+x.start.toFixed(1),opp:x.opp,result:x.result})));}
const out={battles:battles.length,duplicateGroups:groups.length,duplicates:groups.reduce((n,g)=>n+g.length-1,0),groups};
if(outPath)fs.writeFileSync(outPath,JSON.stringify(out,null,1));
console.log(`${battles.length} battles in ${runs.length} runs · ${out.duplicates} duplicates in ${groups.length} groups`);for(const g of groups)console.log('  same battle:',g.map(x=>`${x.recording}@${x.start}s`).join(' = '));
module.exports={timelinesMatch};
