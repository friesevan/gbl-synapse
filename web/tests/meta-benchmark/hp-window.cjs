#!/usr/bin/env node
// Prints HP-bar hits for one window of a recording: node hp-window.cjs VIDEO START SECONDS [fps]
const {spawn}=require('node:child_process'),Hp=require('../../includes/meta/hp.js');
const [video,start,dur,fpsArg]=process.argv.slice(2),fps=Number(fpsArg||10),W=886,Y0=450,H=900;
(async()=>{const ff=spawn('ffmpeg',['-v','error','-ss',start,'-t',dur,'-i',video,'-vf',`fps=${fps},crop=${W}:${H}:0:${Y0}`,'-f','rawvideo','-pix_fmt','rgba','-'],{stdio:['ignore','pipe','inherit']});
 const frame=Buffer.alloc(W*H*4);let filled=0,k=0;const frames=[];
 for await(const chunk of ff.stdout){let off=0;while(off<chunk.length){const n=Math.min(chunk.length-off,frame.length-filled);chunk.copy(frame,filled,off,off+n);filled+=n;off+=n;if(filled<frame.length)break;filled=0;
  frames.push({t:Number(start)+k++/fps,bars:Hp.findBars({data:frame,width:W,height:H},Y0)});}}
 const series=Hp.track(frames,W);
 for(const side of ['my','opponent']){const h=Hp.hits(series[side]);console.log(side,'bar seen',series[side].filter(Boolean).length+'/'+series[side].length,'hits:',h.map(x=>`${x.t.toFixed(1)}s ${(x.size*100).toFixed(1)}%`).join('  '),'cadence',JSON.stringify(Hp.cadence(h)));}
})();
