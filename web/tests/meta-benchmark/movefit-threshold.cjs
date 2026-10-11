#!/usr/bin/env node
// Picks the auto-resolution confidence threshold from video-grouped CV predictions (movefit-eval.cjs
// --dump): the lowest posterior p whose resolved answers are at least TARGET correct, with the Wilson
// 95% lower bound reported. node movefit-threshold.cjs ROWS.json [TARGET=0.95]
const fs=require('node:fs');
function wilson(right,total){if(!total)return 0;const z=1.96,p=right/total;return (p+z*z/(2*total)-z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total)))/(1+z*z/total);}
// For each candidate threshold: resolved count, accuracy and lower bound among rows with p ≥ t.
function sweep(rows,{grid=[.8,.85,.9,.93,.95,.97,.98,.99]}={}){return grid.map(t=>{const r=rows.filter(x=>x.p>=t),right=r.filter(x=>x.right).length;return {t,n:r.length,right,acc:r.length?right/r.length:null,lower:wilson(right,r.length),videos:new Set(r.map(x=>x.video)).size};});}
// Lowest threshold at which every higher threshold also keeps accuracy ≥ target (monotone choice);
// higher thresholds with fewer than minN answers are too small to veto (one miss among 18 is 94%).
function choose(rows,target=.95,opts={}){const minN=opts.minN??20,s=sweep(rows,opts);let pick=null;for(let i=s.length-1;i>=0;i--){if(s[i].n&&s[i].acc>=target)pick=s[i];else if(s[i].n>=minN)break;}return {pick,sweep:s};}
module.exports={sweep,choose,wilson};
if(require.main===module){const rows=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),target=Number(process.argv[3]||.95);
 for(const kind of [...new Set(rows.map(r=>r.kind))]){const rs=rows.filter(r=>r.kind===kind),c=choose(rs,target);console.log(kind,c.sweep.map(s=>`p≥${s.t}: ${s.right}/${s.n} lb ${s.lower.toFixed(2)}`).join(' | '));console.log(`  chosen: ${c.pick?`p≥${c.pick.t} (${c.pick.right}/${c.pick.n}, ${c.pick.videos} videos)`:'none'}`);}}
