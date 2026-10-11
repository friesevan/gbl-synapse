#!/usr/bin/env node
// Finds the phone screen inside a wide video (includes/meta/screen.js) from frames spread over it.
// Usage: node locate-screen.cjs VIDEO [N=16] → prints JSON {box (source pixels), score, frames, dy, aspect}
const {execFileSync}=require('node:child_process'),Screen=require('../../includes/meta/screen.js');
function sampleFrames(video,n=16,maxWidth=960){
 const [W,H]=execFileSync('ffprobe',['-v','error','-select_streams','v','-show_entries','stream=width,height','-of','csv=p=0',video]).toString().trim().split(',').map(Number);
 const dur=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',video]).toString());
 const width=Math.min(maxWidth,W),h=Math.round(H*width/W/2)*2,frames=[];
 for(let k=0;k<n;k++){const t=dur*(k+.5)/n;const buf=execFileSync('ffmpeg',['-v','error','-ss',t.toFixed(2),'-i',video,'-frames:v','1','-vf',`scale=${width}:${h}`,'-f','rawvideo','-pix_fmt','rgba','-'],{maxBuffer:64<<20});frames.push({data:new Uint8ClampedArray(buf.buffer,buf.byteOffset,buf.length),width,height:h});}
 return {frames,W,H,scale:W/width};}
function locateVideo(video,n){const {frames,W,H,scale}=sampleFrames(video,n);const r=Screen.locate(frames);if(!r)return {W,H,box:null};
 const box=r.box.map(v=>Math.round(v*scale));box[0]-=box[0]%2;box[1]-=box[1]%2;box[2]-=box[2]%2;box[3]-=box[3]%2;return {...r,W,H,box,sampleBox:r.box};}
module.exports={sampleFrames,locateVideo};
if(require.main===module){const [video,n]=process.argv.slice(2);console.log(JSON.stringify(locateVideo(video,Number(n||16))));}
