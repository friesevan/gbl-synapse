#!/usr/bin/env node
// Runs the Meta Extractor's battle logic (includes/meta/core.js) over a recording in Node, for
// accuracy benchmarking without a browser. Frames come from ffmpeg (keyframes only) and text
// from the tesseract CLI, so OCR can differ slightly from tesseract.js; timing is not comparable
// to the browser. The per-frame flow mirrors the analysis loop in includes/meta/ui.js.
// Usage: node run-node.cjs VIDEO OUT.json   (GAMEMASTER=path: PvPoke game data from the recording's date; LEAGUE=1500|2500|10000)
// Wide videos (YouTube uploads with a facecam/overlay): CROP=auto finds the phone screen
// (includes/meta/screen.js) or CROP=x0,y0,x1,y1 sets it; the screen is cropped and scaled to the
// 886-wide reference. SAMPLE_FPS=n decodes n frames/s instead of keyframes only; it is chosen
// automatically (2) when keyframes are missing or more than 2 s apart (YouTube uses about 6 s).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const Aura=require('../../includes/meta/aura.js'),C=require('../../includes/meta/core.js'),Mp4=require('../../includes/meta/mp4index.js'),K=require('../../includes/meta/combat.js'),Hp=require('../../includes/meta/hp.js'),gm=(()=>{const g=process.env.GAMEMASTER?JSON.parse(fs.readFileSync(process.env.GAMEMASTER,'utf8')):require('../../includes/pro/data/gamemaster.json');for(const m of g.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);return g;})();
const byId=new Map(gm.pokemon.map(p=>[p.speciesId,p]));
const [video,outPath]=process.argv.slice(2);
const dict=C.dictionary(gm.pokemon),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'meta-bench-'));
const metrics={frames:0,nameReads:0,resultReads:0,cached:0,cpReads:0,denseFrames:0,matchups:0};
function ocr(img,box,{whiteText=false,lines=1}={}){const [x0,y0,x1,y1]=box,w=x1-x0,h=y1-y0,buf=Buffer.alloc(w*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=((y0+y)*img.width+x0+x)*4,d=img.data;buf[y*w+x]=whiteText?(Math.min(d[i],d[i+1],d[i+2])>215?0:255):Math.round((d[i]+d[i+1]+d[i+2])/3);}
 const file=path.join(tmp,'crop.pgm');fs.writeFileSync(file,Buffer.concat([Buffer.from(`P5 ${w} ${h} 255\n`),buf]));
 const tsv=execFileSync('tesseract',[file,'-','--psm',lines>1?'6':'7','tsv'],{stdio:['ignore','pipe','ignore']}).toString().trim().split('\n').slice(1).map(l=>l.split('\t')).filter(c=>c[11]&&c[11].trim()&&Number(c[10])>=0);
 return {text:tsv.map(c=>c[11]).join(' '),confidence:tsv.length?tsv.reduce((a,c)=>a+Number(c[10]),0)/tsv.length:0};}
(async()=>{
 const fd=fs.openSync(video,'r'),size=fs.fstatSync(fd).size;
 const times=(await Mp4.keyframeTimes(size,async(a,b)=>{const buf=Buffer.alloc(b-a);fs.readSync(fd,buf,0,b-a,a);return buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.length);})).keyframes;
 const [W0,H0]=execFileSync('ffprobe',['-v','error','-select_streams','v','-show_entries','stream=width,height','-of','csv=p=0',video]).toString().trim().split(',').map(Number);
 let crop=null;if(process.env.CROP==='auto'){const r=require('./locate-screen.cjs').locateVideo(video);crop=r.box;metrics.screen=r;}else if(process.env.CROP)crop=process.env.CROP.split(',').map(Number);
 const pre=crop?[`crop=${crop[2]-crop[0]}:${crop[3]-crop[1]}:${crop[0]}:${crop[1]}`,'scale=886:-2:flags=bicubic']:[];
 const W=crop?886:W0,H=crop?Math.round((crop[3]-crop[1])*886/(crop[2]-crop[0])/2)*2:H0;
 const gaps=times.slice(1).map((t,i)=>t-times[i]).sort((a,b)=>a-b),medGap=gaps.length?gaps[gaps.length>>1]:Infinity;
 const fps=Number(process.env.SAMPLE_FPS||(medGap>2?2:0));metrics.keyframeGap=medGap;metrics.sampleFps=fps||'keyframes';
 const vf=[...pre,...(fps?[`fps=${fps}`]:[])],frameTime=k=>fps?k/fps:times[k];
 const tracker=new C.HudTracker(),names=new C.NameCache(),cps=new C.NameCache(.012),started=Date.now(),debug=!!process.env.DEBUG;let dy=null,k=0,filled=0,lastSurrender=-Infinity;const frameBytes=W*H*4,frame=Buffer.alloc(frameBytes);
 const ff=spawn('ffmpeg',['-v','error',...(fps?[]:['-skip_frame','nokey']),'-i',video,...(vf.length?['-vf',vf.join(',')]:[]),'-vsync','0','-f','rawvideo','-pix_fmt','rgba','-'],{stdio:['ignore','pipe','inherit']});
 for await(const chunk of ff.stdout){let off=0;
  while(off<chunk.length){const n=Math.min(chunk.length-off,frameBytes-filled);chunk.copy(frame,filled,off,off+n);filled+=n;off+=n;if(filled<frameBytes)break;filled=0;
   const img={data:frame,width:W,height:H},t=frameTime(k++)??k;metrics.frames++;
   const bandStats=(y0,y1)=>C.bandStats({data:frame.subarray(y0*W*4,y1*W*4),width:W,height:y1-y0});
   if(dy===null){dy=C.calibrate(img);}
   const hud=dy===null?null:C.readHud(img,dy);
   if(debug&&t>Number(process.env.DBG_FROM||108)&&t<Number(process.env.DBG_TO||132)){const y0=Math.round(H*700/1920),y1=Math.round(H*1180/1920);let wh=0,nn=0;for(let i=y0*W*4;i<y1*W*4;i+=32){nn++;if(Math.min(frame[i],frame[i+1],frame[i+2])>215)wh++;}const st=C.bandStats({data:frame.subarray(Math.round(H*700/1920)*W*4,Math.round(H*1180/1920)*W*4),width:W,height:Math.round(H*1180/1920)-Math.round(H*700/1920)});console.log('dbg',t.toFixed(1),hud?'HUD '+hud.my.balls.join(',')+'|'+hud.opponent.balls.join(','):'-',tracker.awaitingResult(t),'white',st.white.toFixed(3),'run',st.whiteRun.toFixed(0),'black',st.black.toFixed(2));}
   if(hud){for(const side of ['my','opponent']){const s=hud[side];let hit=names.get(s.bits);if(hit===undefined){metrics.nameReads++;const r=ocr(img,s.nameBox);const m=C.match(r.text,dict);hit=m&&r.confidence>=45?{...m,confidence:r.confidence,raw:r.text}:null;names.set(s.bits,hit);}else metrics.cached++;s.hit=hit;let cp=cps.get(s.cpBits);if(cp===undefined){metrics.cpReads++;const r=ocr(img,s.cpBox);const m=/(\d{2,5})/.exec(r.text.replace(/[oO]/g,'0'));cp=m?Number(m[1]):null;cps.set(s.cpBits,cp);}s.cp=cp;}tracker.observe(t,hud);}
   else{const y0=Math.round(H*700/1920),y1=Math.round(H*1180/1920),band=bandStats(y0,y1);if(band.black>.9)tracker.blackout(t);
    if(tracker.awaitingResult(t)&&C.resultCandidate(band)){metrics.resultReads++;const r=ocr(img,[0,y0,W,y1],{whiteText:true,lines:2});const value=C.outcome(r.text.replace(/\s+/g,' '));if(debug)console.log(t.toFixed(1),band.whiteRun.toFixed(0),JSON.stringify(r.text),value);if(value)tracker.result(t,value);else if(/finding opponent|battle starting/i.test(r.text))tracker.matchmaking();}
    else if(C.surrenderCandidate(band)&&t-lastSurrender>4){metrics.surrenderReads=(metrics.surrenderReads||0)+1;const r=ocr(img,[0,y0,W,y1],{lines:2});if(C.isSurrender(r.text)){lastSurrender=t;tracker.surrender(t);}}}}}
 const finished=tracker.finish(),league=Number(process.env.LEAGUE||1500),rankings=new Map(require(`../../includes/pro/data/league-${league}.json`).overall.map(r=>[r.speciesId,r]));
 // Dense HP-bar pass over each matchup (10 frames/s, up to 9 s), then the joint fast-move/Shadow fit.
 async function denseHits(start,dur){const Y0=Math.round(450*W/886),Hh=Math.min(H-Y0,Math.round(900*W/886)),frames=[];
  const ff=spawn('ffmpeg',['-v','error','-ss',String(start),'-t',String(dur),'-i',video,'-vf',[...pre,`fps=10,crop=${W}:${Hh}:0:${Y0}`].join(','),'-f','rawvideo','-pix_fmt','rgba','-'],{stdio:['ignore','pipe','inherit']});
  const fr=Buffer.alloc(W*Hh*4);let f=0,k=0;for await(const chunk of ff.stdout){let off=0;while(off<chunk.length){const n=Math.min(chunk.length-off,fr.length-f);chunk.copy(fr,f,off,off+n);f+=n;off+=n;if(f<fr.length)break;f=0;metrics.denseFrames++;
   const img={data:fr,width:W,height:Hh},bars=Hp.findBars(img,Y0);frames.push({t:start+k++/10,bars,aura:Aura.measure(img,Hp.assignBars(bars,W),Y0)});}}
  const series=Hp.track(frames,W),out={};for(const side of ['my','opponent']){let h=Hp.hits(series[side]);if(h.length>=3){const med=h.map(x=>x.size).sort((a,b)=>a-b)[h.length>>1];h=h.filter(x=>x.size<=med*2.2);}out[side]={hits:h,summary:K.summarizeHits(h,Hp.cadence(h))};}out.aura=Aura.summarize(frames.map(f=>f.aura));return out;}
 const entries=p=>(p.candidates||[]).filter(c=>/mega|primal/i.test(p.label||'')||!/_(mega|primal)/.test(c.id)).map(c=>byId.get(c.id)).filter(Boolean);
 for(const b of finished)for(const side of ['my','opponent'])for(const p of b[side])K.narrowByRankings(p,rankings);
 for(const b of finished){b.matchups=[];
  for(const g of b.segments.filter(g=>g.end-g.start>=3)){const o=b.opponent.find(p=>p.key===g.opponent),m=b.my.find(p=>p.key===g.my);if(!o||!m)continue;metrics.matchups++;
   const d=await denseHits(g.start+.3,Math.min(25,g.end-g.start+.5));
   const r=K.inferMatchup({opp:{candidates:entries(o),cp:o.cp},my:{candidates:entries(m),cp:m.cp},hitsOnMy:d.my.summary,hitsOnOpp:d.opponent.summary,moves:gm.moves,rankings,league});
   b.matchups.push({...g,hitsOnMy:d.my.hits.map(h=>+h.size.toFixed(3)),hitsOnOpp:d.opponent.hits.map(h=>+h.size.toFixed(3)),cadenceOnMy:d.my.summary?.turns,cadenceOnOpp:d.opponent.summary?.turns,auraOpponent:d.aura.opponent,auraMy:d.aura.my,result:r});}
  }
 const pooled=K.poolMine(finished);for(const b of finished){K.attachInference(b,pooled);Aura.applyToBattle(b);}
 const pk=p=>({name:p.candidates?.[0]?.name||p.label,types:p.observedTypes,formId:p.formId,cp:p.cp,form:p.inference&&{id:p.inference.forms[0].value,p:+p.inference.forms[0].p.toFixed(3)},shadowP:p.inference&&+p.inference.shadowP.toFixed(3),fastMove:p.inference&&{id:p.inference.moves[0].value,p:+p.inference.moves[0].p.toFixed(3)},matchups:p.inference?.matchups||0});
 const battles=finished.map(b=>({start:b.start,end:b.end,result:b.result,resultSource:b.resultSource,ending:b.ending,my:b.my.map(p=>p.candidates?.[0]?.name||p.label),opponent:b.opponent.map(p=>p.candidates?.[0]?.name||p.label),myDetail:b.my.map(pk),opponentDetail:b.opponent.map(pk),matchups:b.matchups.map(({result,...g})=>({...g,best:result&&{opp:result.best.opp,oppMove:result.best.oppMove,my:result.best.my,myMove:result.best.myMove,p:+result.best.p.toFixed(3)}})),flags:b.flags,fainted:b.fainted,shieldsUsed:b.shieldsUsed}));
 const out={pipeline:'v2 core logic (node harness, tesseract CLI)',recording:path.basename(video),seconds:(Date.now()-started)/1000,ocrReads:metrics.nameReads+metrics.resultReads,metrics,calibratedDy:dy,crop,battles};
 // Matchup fits are kept (compactly) so pooling and priors can be re-evaluated without re-decoding.
 out.full=finished.map(b=>({...b,matchups:b.matchups.map(({result,...g})=>({...g,fit:result&&result.all.map(h=>({opp:h.opp,oppMove:h.oppMove,my:h.my,myMove:h.myMove,evidence:+h.evidence.toFixed(4),oppPrior:+h.oppPrior.toFixed(4),myPrior:+h.myPrior.toFixed(4)}))}))}));fs.writeFileSync(outPath,JSON.stringify(out,null,1));fs.rmSync(tmp,{recursive:true,force:true});
 console.log(`${out.recording}: ${battles.length} battles, ${metrics.frames} frames, ${metrics.nameReads} name reads, ${metrics.resultReads} result reads, ${out.seconds.toFixed(1)} s`);
})();
