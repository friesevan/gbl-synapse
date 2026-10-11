#!/usr/bin/env node
// Runs the Meta Extractor's battle logic (includes/meta/*.js) over a recording in Node: the benchmark
// and batch engine. v3 decodes the video ONCE, streaming FPS frames/s (default 10) from ffmpeg:
//   • every HUD_EVERY-th frame (default 5 → 2/s): nameplates, results, surrender dialog, banners;
//   • every frame while a battle is on: HP bars and the Shadow aura (cheap after the findBars
//     pre-pass), so each matchup is measured over its whole length, not a capped window.
// Text comes from the tesseract CLI (names, CP, result/banners), cached by fingerprint.
// v2 (keyframe pass + one ffmpeg seek per matchup, 25 s cap) is kept as run-node-v2.cjs.
//
// Usage: node run-node.cjs VIDEO OUT.json
//   GAMEMASTER=path   PvPoke game data from the recording's date (default: current)
//   LEAGUE=1500|2500|10000|500
//   CROP=auto | x0,y0,x1,y1   phone screen inside a wide video (YouTube etc.), scaled to 886 wide
//   START=s END=s     analyse part of the file (run-batch.cjs splits long files this way)
//   FPS=10 HUD_EVERY=5
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const Aura=require('../../includes/meta/aura.js'),C=require('../../includes/meta/core.js'),K=require('../../includes/meta/combat.js'),Hp=require('../../includes/meta/hp.js');
const gm=(()=>{const g=process.env.GAMEMASTER?JSON.parse(fs.readFileSync(process.env.GAMEMASTER,'utf8')):require('../../includes/pro/data/gamemaster.json');for(const m of g.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);return g;})();
const byId=new Map(gm.pokemon.map(p=>[p.speciesId,p])),movesById=new Map(gm.moves.map(m=>[m.moveId,m]));
const [video,outPath]=process.argv.slice(2);
const FPS=Number(process.env.FPS||10),HUD_EVERY=Number(process.env.HUD_EVERY||5),START=Number(process.env.START||0),END=process.env.END?Number(process.env.END):null;
const dict=C.dictionary(gm.pokemon),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'meta-bench-'));
const metrics={frames:0,hudFrames:0,denseFrames:0,nameReads:0,cpReads:0,cpSkipped:0,resultReads:0,bannerReads:0,cached:0,matchups:0,ms:{decodeWait:0,hud:0,bars:0,ocr:0,fit:0}};
const now=()=>Number(process.hrtime.bigint())/1e6;
function ocr(img,box,{whiteText=false,lines=1}={}){const t0=now(),[x0,y0,x1,y1]=box.map(Math.round),w=x1-x0,h=y1-y0,buf=Buffer.alloc(w*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=((y0+y)*img.width+x0+x)*4,d=img.data;buf[y*w+x]=whiteText?(Math.min(d[i],d[i+1],d[i+2])>215?0:255):Math.round((d[i]+d[i+1]+d[i+2])/3);}
 const file=path.join(tmp,'crop.pgm');fs.writeFileSync(file,Buffer.concat([Buffer.from(`P5 ${w} ${h} 255\n`),buf]));
 const tsv=execFileSync('tesseract',[file,'-','--psm',lines>1?'6':'7','tsv'],{stdio:['ignore','pipe','ignore']}).toString().trim().split('\n').slice(1).map(l=>l.split('\t')).filter(c=>c[11]&&c[11].trim()&&Number(c[10])>=0);
 metrics.ms.ocr+=now()-t0;return {text:tsv.map(c=>c[11]).join(' '),confidence:tsv.length?tsv.reduce((a,c)=>a+Number(c[10]),0)/tsv.length:0};}
const diffShare=(a,b)=>{if(!b)return 1;let n=0;for(let i=0;i<a.length;i++)n+=a[i]!==b[i];return n/a.length;};
(async()=>{const started=Date.now();
 const [W0,H0]=execFileSync('ffprobe',['-v','error','-select_streams','v','-show_entries','stream=width,height','-of','csv=p=0',video]).toString().trim().split(',').map(Number);
 let crop=null;if(process.env.CROP==='auto'){const r=require('./locate-screen.cjs').locateVideo(video);crop=r.box;metrics.screen=r;}else if(process.env.CROP)crop=process.env.CROP.split(',').map(Number);
 const pre=crop?[`crop=${crop[2]-crop[0]}:${crop[3]-crop[1]}:${crop[0]}:${crop[1]}`,'scale=886:-2:flags=bicubic']:[];
 const W=crop?886:W0,H=crop?Math.round((crop[3]-crop[1])*886/(crop[2]-crop[0])/2)*2:H0;
 // Bars and aura live in the middle band of the screen (reference y 450–1350).
 const Y0=Math.round(450*W/886),Hh=Math.min(H-Y0,Math.round(900*W/886));
 const effects=[],effCache=new C.NameCache(.05),tracker=new C.HudTracker(),names=new C.NameCache(),cps=new C.NameCache(.012),cpKnown=new Map(),dense=[];
 let dy=null,k=0,filled=0,lastSurrender=-Infinity,lastSurrenderCheck=-Infinity,lastBanner=null;const frameBytes=W*H*4,frame=Buffer.alloc(frameBytes);
 const args=['-v','error',...(START?['-ss',String(START)]:[]),...(END?['-t',String(END-START)]:[]),'-i',video,'-vf',[`fps=${FPS}`,...pre].join(','),'-f','rawvideo','-pix_fmt','rgba','-'];
 // fps first: crop/scale only the frames that are kept (+26% throughput on 60 fps sources).
 const ff=spawn('ffmpeg',args,{stdio:['ignore','pipe','inherit']});let waitFrom=now();
 for await(const chunk of ff.stdout){let off=0;
  while(off<chunk.length){const n=Math.min(chunk.length-off,frameBytes-filled);chunk.copy(frame,filled,off,off+n);filled+=n;off+=n;if(filled<frameBytes)break;filled=0;
   metrics.ms.decodeWait+=now()-waitFrom;const t=START+k/FPS,isHud=k%HUD_EVERY===0;k++;metrics.frames++;const img={data:frame,width:W,height:H};
   if(isHud){const t0=now();metrics.hudFrames++;
    if(dy===null)dy=C.calibrate(img);
    const hud=dy===null?null:C.readHud(img,dy);
    if(hud){for(const side of ['my','opponent']){const s=hud[side];let hit=names.get(s.bits);if(hit===undefined){metrics.nameReads++;const r=ocr(img,s.nameBox);const m=C.match(r.text,dict);hit=m&&r.confidence>=45?{...m,confidence:r.confidence,raw:r.text}:null;names.set(s.bits,hit);}else metrics.cached++;s.hit=hit;
      // CP: a CP read the same twice for this side and species is reused while the CP digits look the
      // same (≤3% of fingerprint cells differ). Another battle's Pokémon of the same species shows a
      // different number, so it is read again.
      const ck=side+':'+(hit?.key||''),known=hit&&cpKnown.get(ck);if(known&&known.n>=2&&diffShare(s.cpBits,known.bits)<=.03){s.cp=known.cp;metrics.cpSkipped++;}
      else{let cp=cps.get(s.cpBits);if(cp===undefined){metrics.cpReads++;const r=ocr(img,s.cpBox);const m=/(\d{2,5})/.exec(r.text.replace(/[oO]/g,'0'));cp=m?Number(m[1]):null;cps.set(s.cpBits,cp);}s.cp=cp;
       if(hit&&cp){const c=cpKnown.get(ck);cpKnown.set(ck,c&&c.cp===cp?{cp,n:c.n+1,bits:s.cpBits}:{cp,n:1,bits:s.cpBits});}}}
     tracker.observe(t,hud);}
    else{const y0=Math.round(H*700/1920),y1=Math.round(H*1180/1920),band=C.bandStats({data:frame.subarray(y0*W*4,y1*W*4),width:W,height:y1-y0});if(band.black>.9)tracker.blackout(t);
     if(tracker.awaitingResult(t)&&C.resultCandidate(band)){metrics.resultReads++;const r=ocr(img,[0,y0,W,y1],{whiteText:true,lines:2});const value=C.outcome(r.text.replace(/\s+/g,' '));if(value)tracker.result(t,value);else if(/finding opponent|battle starting/i.test(r.text))tracker.matchmaking();}
     else if(C.surrenderCandidate(band)&&t-lastSurrender>4){metrics.surrenderReads=(metrics.surrenderReads||0)+1;const r=ocr(img,[0,y0,W,y1],{lines:2});if(C.isSurrender(r.text)){lastSurrender=t;tracker.surrender(t);}}
}
    // Banners ("X used Y!", "Go, X!"), with or without nameplates on screen; OCR only new text.
    if(tracker.current&&dy!==null){const bn=C.bannerRead(img,dy);if(bn.textPixels>=.03&&bn.textPixels<=.5&&diffShare(bn.sig,lastBanner)>=.04){lastBanner=bn.sig;metrics.bannerReads++;const r=ocr(img,bn.box,{whiteText:true});if(!tracker.go(t,r.text,dict))tracker.move(t,r.text,r.confidence,gm.moves);}}
    metrics.ms.hud+=now()-t0;}
   // The surrender dialog shows for under a second, so it is looked for on every frame of a battle
   // (cheap band statistics; OCR only when a white card fills the middle band).
   if(!isHud&&tracker.current&&t-lastSurrender>4&&t-lastSurrenderCheck>=.3){const y0=Math.round(H*700/1920),y1=Math.round(H*1180/1920),band=C.bandStats({data:frame.subarray(y0*W*4,y1*W*4),width:W,height:y1-y0});
    if(C.surrenderCandidate(band)){lastSurrenderCheck=t;metrics.surrenderReads=(metrics.surrenderReads||0)+1;const r=ocr(img,[0,y0,W,y1],{lines:2});if(C.isSurrender(r.text)){lastSurrender=t;tracker.surrender(t);}}}
   // HP bars + aura on every frame of a battle (and briefly after the nameplates go, for faints).
   if(tracker.current&&t-tracker.lastHud<30){const t0=now(),band={data:frame.subarray(Y0*W*4,(Y0+Hh)*W*4),width:W,height:Hh},bars=Hp.findBars(band,Y0),as=Hp.assignBars(bars,W);dense.push({t,bars,aura:Aura.measure(band,as,Y0)});
    // "SUPER EFFECTIVE!" / "NOT VERY EFFECTIVE…" above a bar: the attack on that Pokémon. Each distinct
    // look of the text is read once (fingerprint cache); repeats within 0.8 s count once.
    for(const side of ['my','opponent']){const bar=as[side];if(!bar)continue;const box=Hp.effectBox(bar,W),e=Hp.effectSig(band,box,Y0);if(e.share<.03||e.share>.45)continue;
     let kind=effCache.get(e.sig);if(kind===undefined){metrics.effectReads=(metrics.effectReads||0)+1;const r=ocr(img,box,{whiteText:true});kind=Hp.effectKind(r.text);effCache.set(e.sig,kind);}
     if(kind){const last=effects.findLast?.(x=>x.side===side)??[...effects].reverse().find(x=>x.side===side);if(!last||last.kind!==kind||t-last.t>.8)effects.push({t,side,kind});else last.t=t;}}metrics.denseFrames++;metrics.ms.bars+=now()-t0;}
   waitFrom=now();}}
 const finished=tracker.finish(),league=Number(process.env.LEAGUE||1500),rankings=new Map(require(`../../includes/pro/data/league-${league}.json`).overall.map(r=>[r.speciesId,r]));
 const t0=now();
 // Each matchup uses every dense frame between its first and last nameplate sighting (+0.5 s).
 const lower=t=>{let lo=0,hi=dense.length;while(lo<hi){const m=(lo+hi)>>1;if(dense[m].t<t)lo=m+1;else hi=m;}return lo;};
 const window=(a,b)=>{const out=[];for(let i=lower(a);i<dense.length&&dense[i].t<=b;i++)out.push(dense[i]);return out;};
 // Fast-move hits come from the matchup's first 12 s: later readings (low-HP colours, cutscene edges)
 // add noise. Leave-one-out over 99 answered fast moves: 87/99 with the first 8–18 s vs 79/99 with the
 // whole matchup. Charged hits and the aura still use the whole matchup.
 const FAST_WINDOW=12;
 function hitsFor(frames){const series=Hp.track(frames,W),out={},t0=frames[0]?.t??0;for(const side of ['my','opponent']){let h=Hp.hits(series[side].map(p=>p&&p.t<=t0+FAST_WINDOW?p:null));if(h.length>=3){const med=h.map(x=>x.size).sort((a,b)=>a-b)[h.length>>1];h=h.filter(x=>x.size<=med*2.2);}out[side]={hits:h,summary:K.summarizeHits(h,Hp.cadence(h))};}out.aura=Aura.summarize(frames.map(f=>f.aura));out.series=series;out.t0=frames[0]?.t;return out;}
 // Fighting time for the charged-move evidence: frames with that side's HP bar visible while the
 // Pokémon is on the field (its matchup windows), up to time t.
 const fightUntil=b=>{// Who is on the field per side: nameplate segments plus "Go, X!" banners, in time order.
  const changes={my:[],opponent:[]};for(const side of ['my','opponent']){for(const g of b.segments)changes[side].push([g.start,g[side]]);for(const e of b.events.filter(e=>e.kind==='go'))if(b[side].some(p=>p.key===e.actor))changes[side].push([e.t,e.actor]);changes[side].sort((x,y)=>x[0]-y[0]);}
  return (side,key,t)=>{const c=changes[side];let n=0;for(let i=0;i<c.length;i++){if(c[i][1]!==key)continue;const a=c[i][0];if(a>=t)break;const z=Math.min(t,i+1<c.length?c[i+1][0]:b.end+.5);
   for(let j=lower(a);j<dense.length&&dense[j].t<z;j++){const as=Hp.assignBars(dense[j].bars,W);if(as.my||as.opponent)n++;}}return n/FPS;};};
 function battleEvidence(b){return K.battleEvidence(b,movesById,fightUntil(b));}
 const entries=p=>(p.candidates||[]).filter(c=>/mega|primal/i.test(p.label||'')||!/_(mega|primal)/.test(c.id)).map(c=>byId.get(c.id)).filter(Boolean);
 for(const b of finished)for(const side of ['my','opponent'])for(const p of b[side])K.narrowByRankings(p,rankings);
 for(const b of finished){b.matchups=[];
  for(const g of b.segments.filter(g=>g.end-g.start>=3)){const o=b.opponent.find(p=>p.key===g.opponent),m=b.my.find(p=>p.key===g.my);if(!o||!m)continue;metrics.matchups++;
   const d=hitsFor(window(g.start+.3,g.end+.5));
   // Charged attacks named by banners in this matchup, measured on the target's bar; skipped when the
   // target shielded (shield icon change within 10 s) or fainted (the drop is only a lower bound).
   const ev=b.events,shielded=(side,t)=>ev.some(e=>e.kind==='shield'&&e.side===side&&Math.abs(e.t-t)<=10),fainted=(side,t)=>ev.some(e=>e.kind==='faint'&&e.side===side&&e.t>=t-1&&e.t<=t+12),charged={onMy:[],onOpp:[]};
   for(const e of ev.filter(e=>e.kind==='move'&&e.t>=g.start-1&&e.t<=g.end+1)){const target=e.side==='opponent'&&e.actor===g.opponent?'my':e.side==='my'&&e.actor===g.my?'opponent':null;if(!target||shielded(target,e.t)||fainted(target,e.t))continue;
    const size=Hp.chargedDamage(d.series[target],e.t);if(size)charged[target==='my'?'onMy':'onOpp'].push({move:e.move,size:+size.toFixed(3),t:+e.t.toFixed(1)});}
   // Effectiveness texts during this matchup's fast-move window, away from charged attacks (±4 s).
   const fw=[g.start+.3,g.start+.3+FAST_WINDOW],nearCharged=t=>ev.some(e=>e.kind==='move'&&Math.abs(e.t-t)<=4),eff={};
   for(const [side,key] of [['my','onMy'],['opponent','onOpp']]){const list=effects.filter(x=>x.side===side&&x.t>=fw[0]&&x.t<=fw[1]&&!nearCharged(x.t));eff[key]={super:list.filter(x=>x.kind==='super').length,notVery:list.filter(x=>x.kind==='notVery').length,hits:d[side].hits.length};}
   const r=K.inferMatchup({opp:{candidates:entries(o),cp:o.cp},my:{candidates:entries(m),cp:m.cp},hitsOnMy:d.my.summary,hitsOnOpp:d.opponent.summary,charged,effects:eff,moves:gm.moves,rankings,league});
   const fit=r&&r.all.map(h=>({opp:h.opp,oppMove:h.oppMove,my:h.my,myMove:h.myMove,evidence:+h.evidence.toFixed(4),oppPrior:+h.oppPrior.toFixed(4),myPrior:+h.myPrior.toFixed(4)}));
   b.matchups.push({...g,hitsOnMy:d.my.hits.map(h=>+h.size.toFixed(3)),hitsOnOpp:d.opponent.hits.map(h=>+h.size.toFixed(3)),hitTimesOnMy:d.my.hits.map(h=>+h.t.toFixed(1)),hitTimesOnOpp:d.opponent.hits.map(h=>+h.t.toFixed(1)),cadenceOnMy:d.my.summary?.turns,cadenceOnOpp:d.opponent.summary?.turns,auraOpponent:d.aura.opponent,auraMy:d.aura.my,chargedOnMy:charged.onMy,chargedOnOpp:charged.onOpp,effects:eff,
    // Compact HP series (10/s, fill fraction or null) so fits can be re-run without decoding video.
    series:{t0:d.t0!=null?+d.t0.toFixed(2):null,fps:FPS,my:d.series.my.map(p=>p?+p.fill.toFixed(3):null),opponent:d.series.opponent.map(p=>p?+p.fill.toFixed(3):null)},fit,result:r});}
  b.evidence=battleEvidence(b);for(const side of ['my','opponent'])for(const [key,info] of Object.entries(b.evidence[side]))K.applyBattleEvidence(b.matchups.filter(g=>g[side]===key).map(g=>g.result),side,info,byId,rankings,movesById);}
 for(const b of finished){b.effects=effects.filter(x=>x.t>=b.start&&x.t<=b.end+1).map(x=>({t:+x.t.toFixed(1),side:x.side,kind:x.kind}));b.hp=Hp.hpTimeline(b);}
 const pooled=K.poolMine(finished);for(const b of finished){K.attachInference(b,pooled);Aura.applyToBattle(b);}
 metrics.ms.fit=now()-t0;
 const pk=p=>({name:p.candidates?.[0]?.name||p.label,types:p.observedTypes,formId:p.formId,cp:p.cp,form:p.inference&&{id:p.inference.forms[0].value,p:+p.inference.forms[0].p.toFixed(3)},shadowP:p.inference&&+p.inference.shadowP.toFixed(3),fastMove:p.inference&&{id:p.inference.moves[0].value,p:+p.inference.moves[0].p.toFixed(3)},matchups:p.inference?.matchups||0});
 const battles=finished.map(b=>({start:b.start,end:b.end,result:b.result,resultSource:b.resultSource,ending:b.ending,my:b.my.map(p=>p.candidates?.[0]?.name||p.label),opponent:b.opponent.map(p=>p.candidates?.[0]?.name||p.label),myDetail:b.my.map(pk),opponentDetail:b.opponent.map(pk),matchups:b.matchups.map(({result,fit,series,...g})=>({...g,best:result&&{opp:result.best.opp,oppMove:result.best.oppMove,my:result.best.my,myMove:result.best.myMove,p:+result.best.p.toFixed(3)}})),moves:b.events.filter(e=>e.kind==='move'||e.kind==='go').map(e=>({t:+e.t.toFixed(1),kind:e.kind,side:e.side,actor:e.actor,move:e.move})),flags:b.flags,fainted:b.fainted,shieldsUsed:b.shieldsUsed}));
 const seconds=(Date.now()-started)/1000,videoSeconds=k/FPS;
 const out={pipeline:'v3 single-pass (node harness, tesseract CLI)',recording:path.basename(video),seconds,videoSeconds,realtime:+(videoSeconds/seconds).toFixed(2),ocrReads:metrics.nameReads+metrics.cpReads+metrics.resultReads+metrics.bannerReads,metrics,calibratedDy:dy,crop,start:START,end:END,battles};
 // Matchup fits are kept (compactly) so pooling and priors can be re-evaluated without re-decoding.
 out.full=finished.map(b=>({...b,matchups:b.matchups.map(({result,...g})=>g)}));
 fs.writeFileSync(outPath,JSON.stringify(out));fs.rmSync(tmp,{recursive:true,force:true});
 const ms=metrics.ms;console.log(`${out.recording}: ${battles.length} battles, ${videoSeconds.toFixed(0)} s video in ${seconds.toFixed(1)} s (${out.realtime}× real time) · ${out.ocrReads} OCR reads · decode wait ${(ms.decodeWait/1000).toFixed(1)} s, HUD ${(ms.hud/1000).toFixed(1)} s (OCR ${(ms.ocr/1000).toFixed(1)} s), bars ${(ms.bars/1000).toFixed(1)} s, fit ${(ms.fit/1000).toFixed(1)} s`);
})();
