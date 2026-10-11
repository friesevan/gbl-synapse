#!/usr/bin/env node
// Prints 1 if the Meta Extractor's HUD reader finds both nameplates on the phone screen at time T,
// else 0. Local only; used by eval_hud.py so coverage counts only strips that show nameplates.
// Usage: node hud_present.cjs VIDEO x0,y0,x1,y1 T
const {execFileSync}=require('node:child_process'),C=require('../../includes/meta/core.js');
const [video,box,t]=process.argv.slice(2),[x0,y0,x1,y1]=box.split(',').map(Number),W=886,H=Math.round((y1-y0)*W/(x1-x0)/2)*2;
const data=execFileSync('ffmpeg',['-v','error','-ss',t,'-i',video,'-frames:v','1','-vf',`crop=${x1-x0}:${y1-y0}:${x0}:${y0},scale=${W}:${H}:flags=bicubic`,'-f','rawvideo','-pix_fmt','rgba','-'],{maxBuffer:1<<28});
const img={data,width:W,height:H},dy=C.calibrate(img),hud=dy===null?null:C.readHud(img,dy);
console.log(hud&&hud.my&&hud.opponent?1:0);
