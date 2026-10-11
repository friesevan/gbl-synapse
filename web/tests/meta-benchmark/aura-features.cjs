#!/usr/bin/env node
// Extracts visual Shadow cues (includes/meta/aura.js) for every matchup of a run, sampling 2 frames/s
// over up to 12 s. Usage: node aura-features.cjs RUN.json VIDEO OUT.json
const fs=require('node:fs'),{spawn,execFileSync}=require('node:child_process'),Hp=require('../../includes/meta/hp.js'),Aura=require('../../includes/meta/aura.js');
const [runPath,video,outPath]=process.argv.slice(2),run=JSON.parse(fs.readFileSync(runPath,'utf8'));
const [W,H]=execFileSync('ffprobe',['-v','error','-select_streams','v','-show_entries','stream=width,height','-of','csv=p=0',video]).toString().trim().split(',').map(Number);
const Y0=Math.round(450*W/886),Hh=Math.min(H-Y0,Math.round(1000*W/886));
async function frames(start,dur){const ff=spawn('ffmpeg',['-v','error','-ss',String(start),'-t',String(dur),'-i',video,'-vf',`fps=2,crop=${W}:${Hh}:0:${Y0}`,'-f','rawvideo','-pix_fmt','rgba','-'],{stdio:['ignore','pipe','inherit']});
 const fr=Buffer.alloc(W*Hh*4),out=[];let f=0;for await(const chunk of ff.stdout){let off=0;while(off<chunk.length){const n=Math.min(chunk.length-off,fr.length-f);chunk.copy(fr,f,off,off+n);f+=n;off+=n;if(f<fr.length)break;f=0;
  const img={data:fr,width:W,height:Hh},raw=Hp.findBars(img,Y0),bars=Hp.assignBars(raw,W);out.push(Aura.measure(img,bars,Y0));}}return out;}
(async()=>{const res=[];let k=0;const total=run.full.reduce((s,b)=>s+b.matchups.length,0);
 for(const [bi,b] of run.full.entries())for(const g of b.matchups){k++;if(g.end-g.start<3)continue;const fs2=await frames(g.start+.5,Math.min(12,g.end-g.start));const sum=Aura.summarize(fs2);res.push({battle:bi,my:g.my,opponent:g.opponent,start:g.start,end:g.end,auraOpponent:sum.opponent,auraMy:sum.my});if(k%20===0)process.stderr.write(`${k}/${total}\n`);}
 fs.writeFileSync(outPath,JSON.stringify(res));console.log(`${res.length} matchups → ${outPath}`);})();
