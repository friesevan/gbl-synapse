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
//   CROPS=x0,y0,x1,y1@s-e,s-e;…   the screen placed differently per stretch (probe.cjs placements; placement-plan.cjs),
//                     every box the size of CROP; each stretch decodes with its own box and HUD offset, one tracker
//   START=s END=s     analyse part of the file (run-batch.cjs splits long files this way)
//   RANGES=s-e,s-e    analyse only these stretches (probe.cjs battle ranges), one tracker throughout
//   FFMPEG_THREADS=n  decoder and filter threads (default: ffmpeg's auto)
//   PROGRESS_FILE=p   write {t: current video seconds} to p every 10 s of video
//   FPS=10 HUD_EVERY=5
//   DECODE_ROWS=full  also decode the rows below the last one the analysis reads (default: cropped)
//   LEARNED_PATH=path   frozen reviewer-only learned priors for this video
//   NAME_LOCALES=de,ja,… | off   nameplate languages tried besides English (default: all; CJK ones need
//                     their Tesseract model in TESSDATA_LOCALES, default ~/.cache/gbl-synapse/tessdata)
//   NAME_LANGUAGE=ko  preset the nameplate language; LATE_LANGUAGE=45  re-run with it when it was decided more
//                     than this many s after the first nameplate (-1: never)
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const Decode=require('./decode-plan.cjs'),Placement=require('./placement-plan.cjs'),Ocr=require('./ocr-cache.cjs'),Range=require('./range-plan.cjs'),Dialog=require('./surrender-cache.cjs'),Calibration=require('./calibration-cache.cjs');
const Aura=require('../../includes/meta/aura.js'),Shadow=require('../../includes/meta/shadow-model.js'),C=require('../../includes/meta/core.js'),K=require('../../includes/meta/combat.js'),Hp=require('../../includes/meta/hp.js');
const gm=(()=>{const g=process.env.GAMEMASTER?JSON.parse(fs.readFileSync(process.env.GAMEMASTER,'utf8')):require('../../includes/pro/data/gamemaster.json');for(const m of g.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);return g;})();
const byId=new Map(gm.pokemon.map(p=>[p.speciesId,p])),movesById=new Map(gm.moves.map(m=>[m.moveId,m]));
const learned=process.env.LEARNED_PATH?JSON.parse(fs.readFileSync(process.env.LEARNED_PATH,'utf8')):undefined;
const [video,outPath]=process.argv.slice(2);
// SPECIES_ONLY=1: nameplates, results and banners only (2 HUD frames/s, no HP bars, aura or effect texts), for
// benchmarks of the nameplate reader: the same HUD timestamps as the default 10 fps / every 5th frame.
const SPECIES_ONLY=process.env.SPECIES_ONLY==='1',FPS=Number(process.env.FPS||(SPECIES_ONLY?2:10)),HUD_EVERY=Number(process.env.HUD_EVERY||(SPECIES_ONLY?1:5)),START=Number(process.env.START||0),END=process.env.END?Number(process.env.END):null;
const rangePlan=Range.planWindow({ranges:Range.parseRanges(process.env.RANGES,{forceFull:process.env.FORCE_FULL==='1'}),start:START,end:END??Infinity,forceFull:process.env.FORCE_FULL==='1'}),RANGES=rangePlan.ranges;
if(rangePlan.mode==='empty')throw Error('No planned ranges intersect START/END; use run-batch for empty tasks');
// FFMPEG_THREADS also caps the filter graph's threads: with 1, ffmpeg spends ~7% less CPU on the same bytes.
// PROGRESS_FILE=path: the current video time is written there every 10 s of video (reanalyze.py's progress bars).
const PROGRESS=process.env.PROGRESS_FILE||'',PROGRESS_EVERY=100;let progressTries=0;
function progress(t){if(progressTries>20)return;try{fs.writeFileSync(PROGRESS+'.tmp',JSON.stringify({t:+t.toFixed(1),at:Date.now()}));fs.renameSync(PROGRESS+'.tmp',PROGRESS);}catch{progressTries++;}}
const THREADS=process.env.FFMPEG_THREADS?['-threads',String(process.env.FFMPEG_THREADS),'-filter_threads',String(process.env.FFMPEG_THREADS)]:[];
const dict=C.dictionary(gm.pokemon),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'meta-bench-'));
// Other UI languages (core.js LOCALES): Latin-script names come from the English OCR text; Japanese, Korean and
// Chinese plates are read again with that language's model, only while the video's language is undecided
// or once it has been recognised (core.js NameLanguage).
const TESSDATA_LOCALES=process.env.TESSDATA_LOCALES||path.join(os.homedir(),'.cache/gbl-synapse/tessdata'),wantLocales=process.env.NAME_LOCALES==='off'?[]:process.env.NAME_LOCALES?process.env.NAME_LOCALES.split(','):Object.keys(C.LOCALES);
const localNames=require('../../includes/meta/species-names.json').names,locales=Object.fromEntries(wantLocales.filter(l=>C.LOCALES[l]&&(!C.LOCALES[l].script||fs.existsSync(path.join(TESSDATA_LOCALES,C.LOCALES[l].ocr+'.traineddata')))).map(l=>[l,C.localeDictionary(gm.pokemon,localNames,l,dict)]));
// NAME_LANGUAGE=ko|ja|… presets the nameplate language (set by the second pass below).
const presetLanguage=process.env.NAME_LANGUAGE&&locales[process.env.NAME_LANGUAGE]?process.env.NAME_LANGUAGE:null,nameLanguage=new C.NameLanguage({lang:presetLanguage});
// Banners in other UI languages: localised move names (move-names.json, PokeAPI) per language.
const localMoves=require('../../includes/meta/move-names.json').names,moveMaps=Object.fromEntries(Object.keys(C.LOCALES).map(l=>[l,C.moveDictionary(gm.moves,localMoves,l)]));
// The language model to read a result screen, banner, dialog or effect text with: the video's CJK language once
// recognised (and its model present), else null (English OCR).
const cjkLang=()=>C.LOCALES[nameLanguage.lang]?.script&&locales[nameLanguage.lang]?nameLanguage.lang:null;
const ocrDirectory=process.env.OCR_CACHE_DIR??path.join(os.homedir(),'.cache/gbl-synapse/ocr-v1'),ocrEngine=Ocr.createTesseractOcr({directory:ocrDirectory,enabled:ocrDirectory!=='off'});
const exactCacheEnabled=process.env.VIDEO_EXACT_CACHE!=='off',targetGateEnabled=process.env.SURRENDER_TARGET_GATE!=='off';
const calibrationCache=Calibration.createCalibrationCache({enabled:exactCacheEnabled});
const surrenderCache=Dialog.createSurrenderCache({isSurrender:C.isSurrender,settings:'fixed-engine:grayscale-v1:psm6:tsv'});
const metrics={frames:0,hudFrames:0,denseFrames:0,nameReads:0,cpReads:0,cpSkipped:0,resultReads:0,bannerReads:0,cached:0,matchups:0,ms:{decodeWait:0,hud:0,bars:0,ocr:0,fit:0}};
const now=()=>Number(process.hrtime.bigint())/1e6;
function recognizePgm(pgm,{lines=1}={}){return ocrEngine.recognize(pgm,{inputPath:path.join(tmp,'crop.pgm'),args:['-','--psm',lines>1?'6':'7','tsv']});}
// A nameplate read with a CJK language model (core.js LOCALES[lang].ocr). TSV is requested by variable, not the
// "tsv" config file, which a separate tessdata directory lacks.
function ocrLocale(img,box,lang,{whiteText=false,lines=1}={}){const t0=now(),pgm=Dialog.grayscalePgm(img,box,{whiteText}),r=ocrEngine.recognize(pgm,{inputPath:path.join(tmp,'crop.pgm'),args:['-','-l',C.LOCALES[lang].ocr,'--tessdata-dir',TESSDATA_LOCALES,'--psm',lines>1?'6':'7','-c','tessedit_create_tsv=1']});
 metrics.localeReads=(metrics.localeReads||0)+1;metrics.ms.ocr+=now()-t0;return r;}
function ocr(img,box,{whiteText=false,lines=1}={}){const t0=now(),pgm=Dialog.grayscalePgm(img,box,{whiteText}),result=recognizePgm(pgm,{lines});
 metrics.ms.ocr+=now()-t0;return result;}
const diffShare=(a,b)=>{if(!b)return 1;let n=0;for(let i=0;i<a.length;i++)n+=a[i]!==b[i];return n/a.length;};
(async()=>{const started=Date.now();
 const [W0,H0]=execFileSync('ffprobe',['-v','error','-select_streams','v','-show_entries','stream=width,height','-of','csv=p=0',video]).toString().trim().split(',').map(Number);
 let crop=null;if(process.env.CROP==='auto'){const r=require('./locate-screen.cjs').locateVideo(video);crop=r.box;metrics.screen=r;}else if(process.env.CROP)crop=process.env.CROP.split(',').map(Number);
 const placements=Placement.parseCrops(process.env.CROPS,crop);
 const decodeFull=Decode.plan({width:W0,height:H0,crop,fps:FPS,analysisWidth:process.env.ANALYSIS_WIDTH||'',hwaccel:process.env.FFMPEG_HWACCEL||''}),W=decodeFull.width,H=decodeFull.height;
 // Bars and aura use the classifier's current reference band.
 const Y0=Math.round(Hp.BAND[0]*W/886),Hh=Math.min(H-Y0,Math.round((Hp.BAND[1]-Hp.BAND[0])*W/886));
 // Wide, tablet-shaped screens put your bar further right and skip centred cutscene bars (hp.js assignBars).
 const barP=Hp.barSettings(W,H),forFocus=bars=>barP===Hp.BAR?bars:Hp.phoneBars(bars,W);
 // Every pixel read sits above the bottom of the HP-bar band (bars, aura, effect texts), the result and
 // surrender band (700–1180 of 1920) or the top half (HUD, banners at any calibrated offset). Lower rows
 // aren't decoded into the frame (they stay 0); DECODE_ROWS=full restores them.
 const rowsUsed=process.env.DECODE_ROWS==='full'?H:Math.min(H,Math.max(Y0+Hh,Math.ceil(H*1180/1920)+1,Math.ceil(H/2))),decode=Decode.keepRows(decodeFull,rowsUsed);
 // Each placement decodes its own box into the same 886-wide frame (all boxes have CROP's size).
 const decodes=placements?.map(p=>Decode.keepRows(Decode.plan({width:W0,height:H0,crop:p.box,fps:FPS,analysisWidth:process.env.ANALYSIS_WIDTH||'',hwaccel:process.env.FFMPEG_HWACCEL||''}),rowsUsed));
 const effects=[],effRead={},effCache=new C.NameCache(.05),tracker=new C.HudTracker(),names=C.NameCache.names(),cps=new C.NameCache(.012),cpKnown=new Map(),dense=[];
 let hudOffset=new C.HudOffset();
 // Nameplate → species, one OCR per distinct fingerprint (NameCache), in the video's language (core.js readName).
 // HUD_LLM=1: the local vision model reads plates the OCR is unsure of (hud-llm.cjs; YouTube footage only).
 const second=require('./hud-llm.cjs').createSecondReader({C,video,box:crop||[0,0,W0,H0],dict,locales,language:nameLanguage,enabled:process.env.HUD_LLM==='1',budget:Number(process.env.HUD_LLM_BUDGET||30)});
 function nameOf(img,s,t,side){let hit=names.get(s.bits);if(hit===undefined){metrics.nameReads++;if(metrics.firstPlateAt===undefined)metrics.firstPlateAt=t;const r=ocr(img,s.nameBox),box=s.nameBox,res=C.readName(r,{dict,locales,language:nameLanguage,alt:lang=>ocrLocale(img,box,lang)});hit=second.check(res.hit,r,side,t);names.set(s.bits,hit);if(res.switched){names.forgetUnread();metrics.nameLanguageAt=t;}}else metrics.cached++;return hit;}
 let dy=null,k=0,filled=0,lastT=null,lastSurrender=-Infinity,lastSurrenderCheck=-Infinity,lastBanner=null;const frameBytes=W*rowsUsed*4,frame=Buffer.alloc(W*H*4);
 // Banners: English text first ("Go, X!", "X used Y!"); other Latin-script UIs from the same text; a CJK UI
 // (once recognised) only with its language model (core.js localBanner). Chinese banners take two lines.
 function readBanner(t,img,box){const lang=cjkLang();let r;
  if(!lang){r=ocr(img,box,{whiteText:true});if(!tracker.go(t,r.text,dict))tracker.move(t,r.text,r.confidence,gm.moves,null,dict);if(C.parseBanner(r.text))return;}
  else r=ocrLocale(img,box,lang,{lines:lang.startsWith('zh')?2:1});   // pale text on the translucent box: plain grey
  let lb=C.localBanner(r.text,{lang:nameLanguage.lang,locales,moveMaps,moves:gm.moves,dict});
  // While the battle's nameplates have named nothing (names cropped off: core.js bannerTeam) a missed CJK banner is read
  // again in the wide two-line box, as a sighting only (HudTracker.sight): battles named by a plate stay as before.
  if(!lb&&lang&&!lang.startsWith('zh')&&!tracker.current.my.length&&!tracker.current.opponent.length){const w=ocrLocale(img,wideBanner(img).box,lang,{lines:2});tracker.sight(t,w.text,C.localBanner(w.text,{lang:nameLanguage.lang,locales,moveMaps,moves:gm.moves,dict}),dict,gm.moves,w.confidence);}if(process.env.BANNER_DEBUG)(metrics.bannerDebug||(metrics.bannerDebug=[])).push({t,lang:lang||'en',text:r.text,conf:Math.round(r.confidence),lb});if(!lb)return;metrics.localBanners=(metrics.localBanners||0)+1;
  if(lb.kind==='go')tracker.go(t,r.text,dict,lb);else tracker.move(t,r.text,r.confidence,gm.moves,lb,dict);}
 // Names cropped off the top: no plate decides the language. While English has named nothing, a banner (found by its
 // stroke edges) is also read with each CJK model (core.js NameLanguage.bannerVote, bannerEvidence). Parses are kept, so
 // once a language is decided the current battle's earlier banners reach the tracker.
 const cjkLocales=Object.keys(locales).filter(l=>C.LOCALES[l].script),searched=[];let lastSearch=null;
 const wideBanner=img=>{const b0=C.bannerBox(img,dy);return C.bannerEdges(img,C.wideBannerBox(img,dy),{search:b0[3]-b0[1]});};
 // A one-line banner fills half the wide box: either box's stroke share can show it.
 function searchBanner(t,img){const b0=C.bannerBox(img,dy),one=C.bannerEdges(img,b0,{search:b0[3]-b0[1]}),wide=wideBanner(img),text=e=>e.share>=.02&&e.share<=.2;if(!text(one)&&!text(wide)||diffShare(wide.sig,lastSearch)<.04)return;lastSearch=wide.sig;nameLanguage.bannerTries++;
  for(const lang of cjkLocales){const r=ocrLocale(img,wide.box,lang,{lines:2}),ctx={lang,locales,moveMaps,moves:gm.moves,dict},lb=C.localBanner(r.text,ctx);
   if(process.env.BANNER_DEBUG)(metrics.bannerDebug||(metrics.bannerDebug=[])).push({t,lang,text:r.text,conf:Math.round(r.confidence),lb});if(!lb)continue;searched.push({t,lang,r,lb});
   if(!C.bannerEvidence(r.text,lang,ctx)||!nameLanguage.bannerVote(lang,lb.actor+'|'+lb.move))break;names.forgetUnread();metrics.nameLanguageAt=t;metrics.nameLanguageFrom='banners';
   for(const s of searched)if(s.lang===lang&&s.t>=tracker.current.start){if(s.lb.kind==='go')tracker.go(s.t,s.r.text,dict,s.lb);else tracker.move(s.t,s.r.text,s.r.confidence,gm.moves,s.lb,dict);}
   tracker.current.events.sort((x,y)=>x.t-y.t);break;}}
 function readSurrender(t,img,box){
  metrics.surrenderCandidates=(metrics.surrenderCandidates||0)+1;
  if(targetGateEnabled&&!Dialog.hasSurrenderTarget(tracker,t)){metrics.surrenderSkippedNoBattle=(metrics.surrenderSkippedNoBattle||0)+1;return;}
  const t0=now(),pgm=Dialog.grayscalePgm(img,box),compute=()=>{metrics.surrenderReads=(metrics.surrenderReads||0)+1;return recognizePgm(pgm,{lines:2});};
  const lang=cjkLang(),positive=lang?C.isSurrender(ocrLocale(img,box,lang,{lines:2}).text):exactCacheEnabled?surrenderCache.evaluate({t,identity:pgm,compute}).isSurrender:C.isSurrender(compute().text);
  metrics.ms.ocr+=now()-t0;
  if(positive){lastSurrender=t;tracker.surrender(t);}
 }
 // RANGES (from probe.cjs): decode only these stretches, in order, with one tracker; frame times stay
 // video times, so the gap between ranges looks like footage without a HUD.
 // CROPS: each range is cut where the placement changes. Every placement keeps its own HUD offset (dy, HudOffset):
 // an offset proven in one clip is never tried on another clip's box.
 const ranges=RANGES||[[START,END]],offsets=new Map();let base=START,k0=0,waitFrom=now(),at=null;
 for(const [rs,re,pi] of Placement.pieces(ranges,placements)){base=rs||0;k0=k;filled=0;
 if(pi!==at){offsets.set(at,{dy,hudOffset});({dy,hudOffset}=offsets.get(pi)||{dy:null,hudOffset:new C.HudOffset()});at=pi;}
 const dec=pi===null?decode:decodes[pi],args=['-v','error',...THREADS,...dec.inputArgs,...(rs?['-ss',String(rs)]:[]),...(re!=null?['-t',String(re-(rs||0))]:[]),'-i',video,'-vf',dec.filters.join(','),'-f','rawvideo','-pix_fmt','rgba','-'];
 // fps first: crop/scale only the frames that are kept (+26% throughput on 60 fps sources).
 const ff=spawn('ffmpeg',args,{stdio:['ignore','pipe','inherit']}),finishedDecode=new Promise(resolve=>{ff.on('error',error=>resolve({error}));ff.on('close',code=>resolve({code}));});
 for await(const chunk of ff.stdout){let off=0;
  while(off<chunk.length){const n=Math.min(chunk.length-off,frameBytes-filled);chunk.copy(frame,filled,off,off+n);filled+=n;off+=n;if(filled<frameBytes)break;filled=0;
   metrics.ms.decodeWait+=now()-waitFrom;const t=base+(k-k0)/FPS,isHud=k%HUD_EVERY===0;k++;lastT=t;metrics.frames++;if(PROGRESS&&k%PROGRESS_EVERY===0)progress(t);const img={data:frame,width:W,height:H};
   if(isHud){const t0=now();metrics.hudFrames++;
    if(dy===null){dy=calibrationCache.run(img,()=>C.calibrate(img));hudOffset.dy=dy;}
    let hud=dy===null?null:C.readHud(img,dy);
    // Other offsets already proven by a species name, then a fresh calibration kept only if its nameplates name
    // a species (core.js HudOffset: a wrong first calibration, or an offset that changes between battles).
    if(!hud&&dy!==null)for(const d of hudOffset.others()){const h=C.readHud(img,d);if(h){hud=h;dy=d;hudOffset.use(d);break;}}
    if(!hud&&dy!==null){const d2=hudOffset.retry(img),h2=d2===null?null:C.readHud(img,d2);if(h2&&['my','opponent'].some(side=>nameOf(img,h2[side],t,side))){hudOffset.accept(d2,t);dy=d2;hud=h2;metrics.recalibrated=hudOffset.changes;}}
    if(hud){for(const side of ['my','opponent']){const s=hud[side];let hit=nameOf(img,s,t,side);s.hit=hit;
      // CP: a CP read the same twice for this side and species is reused while the CP digits look the
      // same (≤3% of fingerprint cells differ). Another battle's Pokémon of the same species shows a
      // different number, so it is read again.
      const ck=side+':'+(hit?.key||''),known=hit&&cpKnown.get(ck);if(known&&known.n>=2&&diffShare(s.cpBits,known.bits)<=.03){s.cp=known.cp;metrics.cpSkipped++;}
      else{let cp=cps.get(s.cpBits);if(cp===undefined){metrics.cpReads++;const r=ocr(img,s.cpBox);const m=/(\d{2,5})/.exec(r.text.replace(/[oO]/g,'0'));cp=m?Number(m[1]):null;cps.set(s.cpBits,cp);}s.cp=cp;
       if(hit&&cp){const c=cpKnown.get(ck);cpKnown.set(ck,c&&c.cp===cp?{cp,n:c.n+1,bits:s.cpBits}:{cp,n:1,bits:s.cpBits});}}}
     if(!hudOffset.trusted&&(hud.my.hit||hud.opponent.hit))hudOffset.trust();
     tracker.observe(t,hud);}
    else{const y0=Math.round(H*700/1920),y1=Math.round(H*1180/1920),band=C.bandStats({data:frame.subarray(y0*W*4,y1*W*4),width:W,height:y1-y0});if(band.black>.9)tracker.blackout(t);
     if(tracker.awaitingResult(t)&&C.resultCandidate(band)){metrics.resultReads++;const r=ocr(img,[0,y0,W,y1],{whiteText:true,lines:2});let value=C.outcome(r.text.replace(/\s+/g,' ')),text=r.text;
      // Chinese result screens (獲勝！/ 辛苦了！) and CJK matchmaking text need the video's language model.
      if(!value&&cjkLang()&&!C.isMatchmaking(text)){metrics.localeResultReads=(metrics.localeResultReads||0)+1;text=ocrLocale(img,[0,y0,W,y1],cjkLang(),{whiteText:true,lines:2}).text;value=C.outcome(text);}
      if(value)tracker.result(t,value);else if(C.isMatchmaking(text))tracker.matchmaking();else tracker.unreadResult(t);}
     else if(C.surrenderCandidate(band)&&t-lastSurrender>4)readSurrender(t,img,[0,y0,W,y1]);
}
    // Banners ("X used Y!", "Go, X!"), with or without nameplates on screen; OCR only new text.
    // A CJK UI's banners are found by their stroke edges instead (core.js bannerEdges); Chinese ones take two lines.
    if(tracker.current&&dy!==null){if(cjkLang()){const b0=C.bannerBox(img,dy),h=b0[3]-b0[1],bb=cjkLang().startsWith('zh')?[b0[0],b0[1]-h/2,b0[2],b0[3]+h/2]:b0,be=C.bannerEdges(img,bb,{search:h});if(be.share>=.02&&be.share<=.2&&diffShare(be.sig,lastBanner)>=.04){lastBanner=be.sig;metrics.bannerReads++;readBanner(t,img,be.box);}}
     else{const bn=C.bannerRead(img,dy);if(bn.textPixels>=.03&&bn.textPixels<=.5&&diffShare(bn.sig,lastBanner)>=.04){lastBanner=bn.sig;metrics.bannerReads++;readBanner(t,img,bn.box);}
      if(nameLanguage.bannerSearching())searchBanner(t,img);}}
    metrics.ms.hud+=now()-t0;}
   // The surrender dialog shows for under a second, so it is looked for on every frame of a battle
   // (cheap band statistics; OCR only when a white card fills the middle band).
   if(!isHud&&tracker.current&&t-lastSurrender>4&&t-lastSurrenderCheck>=.3){const y0=Math.round(H*700/1920),y1=Math.round(H*1180/1920),band=C.bandStats({data:frame.subarray(y0*W*4,y1*W*4),width:W,height:y1-y0});
    if(C.surrenderCandidate(band)){lastSurrenderCheck=t;readSurrender(t,img,[0,y0,W,y1]);}}
   // HP bars + aura on every frame of a battle (and briefly after the nameplates go, for faints).
   // Focus shots (aura.js measureFocus, the Shadow classifier) keep the phone bar windows on every screen.
   if(!SPECIES_ONLY&&tracker.current&&t-tracker.lastHud<30){const t0=now(),band={data:frame.subarray(Y0*W*4,(Y0+Hh)*W*4),width:W,height:Hh},bars=Hp.findBars(band,Y0,barP),as=Hp.assignBars(bars,W,H);dense.push({t,bars,aura:Aura.measure(band,as,Y0),focus:Aura.measureFocus(band,forFocus(bars),Y0)});
    // "SUPER EFFECTIVE!" / "NOT VERY EFFECTIVE…" above a bar: the attack on that Pokémon. Each distinct
    // look of the text is read once (fingerprint cache); repeats within 0.8 s count once.
    for(const side of ['my','opponent']){const bar=as[side];if(!bar)continue;const box=Hp.effectBox(bar,W),e=Hp.effectSig(band,box,Y0);if(e.share<.03||e.share>.45||!Hp.effectShape(e.sig))continue;
     let kind=effCache.get(e.sig);if(kind===undefined&&t-(effRead[side]??-9)<.9)continue;if(kind===undefined){metrics.effectReads=(metrics.effectReads||0)+1;const lang=cjkLang(),r=lang?ocrLocale(img,box,lang,{whiteText:true}):ocr(img,box,{whiteText:true});kind=Hp.effectKind(r.text);if(kind||r.text.replace(lang?/[\s\p{P}]/gu:/[^A-Za-z]/g,'').length>=(lang?3:6))effRead[side]=t;if(process.env.EFFDEBUG){const g=e.sig;let L=0,T=0;const rows=[];for(let rr=0;rr<12;rr++){let n=0;for(let c=0;c<96;c++)if(g[rr*96+c]){n++;T++;if(c<38)L++;}rows.push(n);}(metrics.effDebug||(metrics.effDebug=[])).push({t:+t.toFixed(1),side,kind,text:r.text.slice(0,30),share:+e.share.toFixed(3),left:+(L/T).toFixed(2),rows:rows.join(',')});}effCache.set(e.sig,kind);}
     if(kind){const last=effects.findLast?.(x=>x.side===side)??[...effects].reverse().find(x=>x.side===side);if(!last||last.kind!==kind||t-last.t>.8)effects.push({t,side,kind});else last.t=t;}}metrics.denseFrames++;metrics.ms.bars+=now()-t0;}
   waitFrom=now();}}
 const status=await finishedDecode;if(status.error||status.code!==0||filled)throw status.error||Error(`Incomplete ffmpeg decode (exit ${status.code}, ${filled} trailing bytes)`);}
 // Each matchup uses every dense frame between its first and last nameplate sighting (+0.5 s).
 const lower=t=>{let lo=0,hi=dense.length;while(lo<hi){const m=(lo+hi)>>1;if(dense[m].t<t)lo=m+1;else hi=m;}return lo;};
 const window=(a,b)=>{const out=[];for(let i=lower(a);i<dense.length&&dense[i].t<=b;i++)out.push(dense[i]);return out;};
 // A battle whose nameplates named nothing takes its species from banners (core.js bannerTeam); the HP bars tell which
 // side an attack hit.
 const defender=(t,until)=>{const o={},d=C.barDefender(Hp.track(window(t-8,until),W,H),t,until,o);if(process.env.BANNER_DEBUG)(metrics.bannerDefender||(metrics.bannerDefender=[])).push([+t.toFixed(1),+until.toFixed(1),d,o.drops]);return d;};
 const videoEnd=lastT,finished=tracker.finish({videoEnd,defender,debug:!!process.env.BANNER_DEBUG}),league=Number(process.env.LEAGUE||1500),rankings=new Map(require(`../../includes/pro/data/league-${league}.json`).overall.map(r=>[r.speciesId,r]));
 const t0=now();
 // Fast-move hits come from the matchup's first 12 s: later readings (low-HP colours, cutscene edges)
 // add noise. Leave-one-out over 99 answered fast moves: 87/99 with the first 8–18 s vs 79/99 with the
 // whole matchup. Charged hits and the aura still use the whole matchup.
 const FAST_WINDOW=12;
 function hitsFor(frames){const series=Hp.track(frames,W,H),out={},t0=frames[0]?.t??0;for(const side of ['my','opponent']){let h=Hp.hits(series[side].map(p=>p&&p.t<=t0+FAST_WINDOW?p:null));if(h.length>=3){const med=h.map(x=>x.size).sort((a,b)=>a-b)[h.length>>1];h=h.filter(x=>x.size<=med*2.2);}out[side]={hits:h,summary:K.summarizeHits(h,Hp.cadence(h))};}out.aura=Aura.summarize(frames.map(f=>f.aura));out.series=series;out.t0=frames[0]?.t;return out;}
 // Fighting time for the charged-move evidence: frames with that side's HP bar visible while the
 // Pokémon is on the field (its matchup windows), up to time t.
 const fightUntil=b=>{// Who is on the field per side: nameplate segments plus "Go, X!" banners, in time order.
  const changes={my:[],opponent:[]};for(const side of ['my','opponent']){for(const g of b.segments)changes[side].push([g.start,g[side]]);for(const e of b.events.filter(e=>e.kind==='go'))if(b[side].some(p=>p.key===e.actor))changes[side].push([e.t,e.actor]);changes[side].sort((x,y)=>x[0]-y[0]);}
  return (side,key,t)=>{const c=changes[side];let n=0;for(let i=0;i<c.length;i++){if(c[i][1]!==key)continue;const a=c[i][0];if(a>=t)break;const z=Math.min(t,i+1<c.length?c[i+1][0]:b.end+.5);
   for(let j=lower(a);j<dense.length&&dense[j].t<z;j++){const as=Hp.assignBars(dense[j].bars,W,H);if(as.my||as.opponent)n++;}}return n/FPS;};};
 // Energy checks use clock fighting time (K.clockFight): visible-bar frames undercount on video.
 function battleEvidence(b){return K.battleEvidence(b,movesById,K.clockFight(b,learned?.fit?.energy));}
 const entries=p=>(p.candidates||[]).filter(c=>/mega|primal/i.test(p.label||'')||!/_(mega|primal)/.test(c.id)).map(c=>byId.get(c.id)).filter(Boolean);
 for(const b of finished)for(const side of ['my','opponent'])for(const p of b[side])K.narrowByRankings(p,rankings);
 // Type icons as form evidence, with this video's own icon colours (K.iconModel).
 const fit={...(learned?.fit||{})},icons={...K.FIT.icons,...(fit.icons||{})},iconModel=K.iconModel(finished,icons.alpha);if(icons.w)for(const b of finished)for(const side of ['my','opponent'])for(const p of b[side])p.typeLL=K.iconLogL(p,iconModel,icons);
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
   const r=K.inferMatchup({opp:{candidates:entries(o),cp:o.cp,typeLL:o.typeLL},my:{candidates:entries(m),cp:m.cp,typeLL:m.typeLL},hitsOnMy:d.my.summary,hitsOnOpp:d.opponent.summary,charged,effects:eff,moves:gm.moves,rankings,league,learned});
   const fit=r&&r.all.map(h=>({opp:h.opp,oppMove:h.oppMove,my:h.my,myMove:h.myMove,evidence:+h.evidence.toFixed(4),oppPrior:+h.oppPrior.toFixed(4),myPrior:+h.myPrior.toFixed(4)}));
   b.matchups.push({...g,hitsOnMy:d.my.hits.map(h=>+h.size.toFixed(3)),hitsOnOpp:d.opponent.hits.map(h=>+h.size.toFixed(3)),hitTimesOnMy:d.my.hits.map(h=>+h.t.toFixed(1)),hitTimesOnOpp:d.opponent.hits.map(h=>+h.t.toFixed(1)),cadenceOnMy:d.my.summary?.turns,cadenceOnOpp:d.opponent.summary?.turns,auraOpponent:d.aura.opponent,auraMy:d.aura.my,chargedOnMy:charged.onMy,chargedOnOpp:charged.onOpp,effects:eff,
    // Compact HP series (10/s, fill fraction or null) so fits can be re-run without decoding video.
    series:{t0:d.t0!=null?+d.t0.toFixed(2):null,fps:FPS,my:d.series.my.map(p=>p?+p.fill.toFixed(3):null),opponent:d.series.opponent.map(p=>p?+p.fill.toFixed(3):null)},fit,result:r});}
  b.evidence=battleEvidence(b);for(const side of ['my','opponent'])for(const [key,info] of Object.entries(b.evidence[side]))K.applyBattleEvidence(b.matchups.filter(g=>g[side]===key).map(g=>g.result),side,info,byId,rankings,movesById,fit);}
 // Focus shots during charged attacks (camera on one Pokémon) for the Shadow classifier (aura.js focusMoments).
 // Results from the timeline once the HP series exist (core.js inferResult). The centred cutscene bar around each
 // battle's end is kept too (hp.js centredReadings): a knockout in the final cutscene shows only there (rule 'knockout').
 // A still image of a battle (title card, screenshot) is not footage (core.js stillBattle).
 {const still=C.dropStillBattles(finished);if(still.length)metrics.stillBattles=still;}
 for(const b of finished)b.cutsceneBar=Hp.centredReadings(window(b.end-8,b.end+4),W);
 C.applyInferredResults(finished,{videoEnd});
 for(const b of finished){b.effects=effects.filter(x=>x.t>=b.start&&x.t<=b.end+1).map(x=>({t:+x.t.toFixed(1),side:x.side,kind:x.kind}));b.hp=Hp.hpTimeline(b);b.focus=Aura.focusMoments(b,window(b.start-2,b.end+8).map(f=>barP===Hp.BAR?f:{...f,bars:forFocus(f.bars)}),W);}
 const pooled=K.poolMine(finished);for(const b of finished){K.attachInference(b,pooled,fit);for(const side of ['my','opponent'])for(const p of b[side])if(!p.inference){const c=entries(p);if(c.length)p.inference=K.priorInference(c,{learned,rankings,typeLL:p.typeLL,fit});}Aura.applyToBattle(b,undefined,learned);}Shadow.applyToBattles(finished,undefined,{learned,rankings,moveTypes:new Map(gm.moves.map(m=>[m.moveId,m.type]))});
 metrics.ms.fit=now()-t0;
 const pk=p=>({name:p.candidates?.[0]?.name||p.label,types:p.observedTypes,formId:p.formId,cp:p.cp,form:p.inference&&{id:p.inference.forms[0].value,p:+p.inference.forms[0].p.toFixed(3)},shadowP:p.inference&&+p.inference.shadowP.toFixed(3),fastMove:p.inference&&{id:p.inference.moves[0].value,p:+p.inference.moves[0].p.toFixed(3)},matchups:p.inference?.matchups||0});
 const battles=finished.map(b=>({start:b.start,end:b.end,result:b.result,resultSource:b.resultSource,...(b.resultReason?{resultReason:b.resultReason}:{}),ending:b.ending,my:b.my.map(p=>p.candidates?.[0]?.name||p.label),opponent:b.opponent.map(p=>p.candidates?.[0]?.name||p.label),myDetail:b.my.map(pk),opponentDetail:b.opponent.map(pk),matchups:b.matchups.map(({result,fit,series,...g})=>({...g,best:result&&{opp:result.best.opp,oppMove:result.best.oppMove,my:result.best.my,myMove:result.best.myMove,p:+result.best.p.toFixed(3)}})),moves:b.events.filter(e=>e.kind==='move'||e.kind==='go').map(e=>({t:+e.t.toFixed(1),kind:e.kind,side:e.side,actor:e.actor,move:e.move})),flags:b.flags,fainted:b.fainted,shieldsUsed:b.shieldsUsed}));
 metrics.ocrCache={...ocrEngine.metrics};metrics.ocrCalls=metrics.nameReads+metrics.cpReads+metrics.resultReads+metrics.bannerReads+(metrics.effectReads||0)+(metrics.surrenderReads||0);
 metrics.surrenderCache={...surrenderCache.metrics};metrics.calibrationCache={...calibrationCache.metrics};metrics.plateRejected={...tracker.rejected};if(second.enabled)metrics.secondReader={...second.stats};metrics.nameLanguage={lang:nameLanguage.lang,votes:Object.fromEntries(Object.entries(nameLanguage.votes).map(([l,v])=>[l,v.size])),tries:nameLanguage.tries,...(nameLanguage.bannerTries?{bannerTries:nameLanguage.bannerTries,bannerVotes:Object.fromEntries(Object.entries(nameLanguage.bannerVotes).map(([l,v])=>[l,v.size]))}:{})};
 const seconds=(Date.now()-started)/1000,videoSeconds=k/FPS;
 const out={pipeline:'v3 single-pass (node harness, tesseract CLI)',recording:path.basename(video),seconds,videoSeconds,realtime:+(videoSeconds/seconds).toFixed(2),ocrReads:metrics.nameReads+metrics.cpReads+metrics.resultReads+metrics.bannerReads,metrics,decoding:{width:W,height:H,rows:rowsUsed,fps:FPS,hudEvery:HUD_EVERY,hwaccel:decode.hwaccel,experimental:!!(process.env.ANALYSIS_WIDTH||process.env.FFMPEG_HWACCEL)},calibratedDy:dy,crop,start:START,end:END,ranges:RANGES,battles};
 // Matchup fits are kept (compactly) so pooling and priors can be re-evaluated without re-decoding.
 out.full=finished.map(b=>({...b,matchups:b.matchups.map(({result,...g})=>g)}));
 // All placements (crop stays the main one), with the HUD offset each ended on.
 if(placements){offsets.set(at,{dy,hudOffset});out.placements=placements.map((p,i)=>({box:p.box,stretches:p.stretches,dy:offsets.get(i)?.dy??null}));}
 // The nameplate language, when it isn't English (absent = English).
 if(nameLanguage.lang!=='en')out.nameLanguage=nameLanguage.lang;
 if(presetLanguage)metrics.nameLanguagePreset={lang:presetLanguage,decidedAt:Number(process.env.NAME_LANGUAGE_AT)||null,firstPassSeconds:Number(process.env.NAME_LANGUAGE_FIRST_PASS)||null};
 // The pass is single: battles that ended before the language was decided had no species and were dropped. When the
 // decision came more than LATE_LANGUAGE s after the first nameplate, the video is analysed again with the language
 // preset (OCR is cached, so the second pass mostly costs the decode).
 const late=Number(process.env.LATE_LANGUAGE??45);if(!presetLanguage&&nameLanguage.lang!=='en'&&late>=0&&metrics.nameLanguageAt-metrics.firstPlateAt>late){fs.rmSync(tmp,{recursive:true,force:true});
  console.log(`${out.recording}: nameplates are ${nameLanguage.lang}, decided at ${metrics.nameLanguageAt} s (first plate ${metrics.firstPlateAt} s); analysing again with the language preset`);
  const r=require('node:child_process').spawnSync(process.execPath,[__filename,video,outPath],{env:{...process.env,NAME_LANGUAGE:nameLanguage.lang,NAME_LANGUAGE_AT:String(metrics.nameLanguageAt),NAME_LANGUAGE_FIRST_PASS:String((Date.now()-started)/1000)},stdio:'inherit'});
  if(r.status===0)return;console.log('second pass failed; keeping the first');}
 fs.writeFileSync(outPath,JSON.stringify(out));fs.rmSync(tmp,{recursive:true,force:true});
 const ms=metrics.ms;console.log(`${out.recording}: ${battles.length} battles, ${videoSeconds.toFixed(0)} s video in ${seconds.toFixed(1)} s (${out.realtime}× real time) · ${out.ocrReads} OCR reads · decode wait ${(ms.decodeWait/1000).toFixed(1)} s, HUD ${(ms.hud/1000).toFixed(1)} s (OCR ${(ms.ocr/1000).toFixed(1)} s), bars ${(ms.bars/1000).toFixed(1)} s, fit ${(ms.fit/1000).toFixed(1)} s`);
})();
