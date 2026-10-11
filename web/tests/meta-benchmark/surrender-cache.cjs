'use strict';
// Exact OCR-input reuse for both HUD and dense surrender branches. The caller still
// preserves existing branch eligibility and `.3s` dense cadence outside this helper.
// A cached negative must still update lastSurrenderCheck on the dense branch, just
// like an OCR attempt, to preserve future eligibility exactly. The identity MUST contain
// actual grayscale PGM bytes (including width/height header), never a perceptual
// fingerprint, threshold mask, rounded signature, text result, or learned prior.
// settings identifies OCR executable/model/PSM/preprocessing. Use one instance per
// fixed OCR engine, and change settings whenever any OCR-affecting setting changes.
function grayscalePgm(img,box,{whiteText=false}={}){
 const [x0,y0,x1,y1]=box.map(Math.round),w=x1-x0,h=y1-y0,buf=Buffer.alloc(w*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=((y0+y)*img.width+x0+x)*4,d=img.data;buf[y*w+x]=whiteText?(Math.min(d[i],d[i+1],d[i+2])>215?0:255):Math.round((d[i]+d[i+1]+d[i+2])/3);}
 return Buffer.concat([Buffer.from(`P5 ${w} ${h} 255\n`),buf]);
}
function createSurrenderCache({isSurrender,settings='',cooldownSeconds=4,maxBytes=8*1024*1024}={}){
 if(typeof isSurrender!=='function')throw TypeError('Surrender text predicate required');
 if(typeof settings!=='string'||!Number.isFinite(cooldownSeconds)||cooldownSeconds<0||!Number.isInteger(maxBytes)||maxBytes<1)throw TypeError('Invalid surrender cache settings');
 let lastIdentity=null,lastSettings=null,lastRaw=null,lastConfirmed=-Infinity;
 const metrics={candidates:0,computed:0,reused:0,positiveCooldown:0,tooLarge:0,changed:0};
 function evaluate({t,identity,compute,settings:currentSettings=settings}={}){
  if(!Number.isFinite(t)||!Buffer.isBuffer(identity)||typeof compute!=='function'||typeof currentSettings!=='string')throw TypeError('Finite timestamp, exact OCR Buffer, settings and callback required');
  metrics.candidates++;
  // This retains the original strict `t-lastSurrender > 4` confirmed-positive gate.
  if(t-lastConfirmed<=cooldownSeconds){metrics.positiveCooldown++;return {raw:null,isSurrender:false,confirmed:false,cached:false,suppressed:true,reason:'confirmed-positive-cooldown'};}
  const same=lastIdentity!==null&&lastSettings===currentSettings&&identity.equals(lastIdentity);let raw;
  if(same){raw={...lastRaw};metrics.reused++;}
  else{
   metrics.changed++;raw=compute();
   if(!raw||typeof raw.text!=='string'||!Number.isFinite(raw.confidence))throw TypeError('OCR must return raw text and finite confidence');
   // Copy exact identity because decoders/PGM builders reuse their working Buffer.
   // No cache state is committed when compute throws or returns invalid OCR.
   const saved={text:raw.text,confidence:raw.confidence};metrics.computed++;
   if(identity.length<=maxBytes){lastIdentity=Buffer.from(identity);lastSettings=currentSettings;lastRaw=saved;}else{lastIdentity=null;lastSettings=null;lastRaw=null;metrics.tooLarge++;}
   raw={...saved};
  }
  const positive=!!isSurrender(raw.text);if(positive)lastConfirmed=t;
  return {raw,isSurrender:positive,confirmed:positive,cached:same,suppressed:false,changed:!same};
 }
 function clear(){lastIdentity=null;lastSettings=null;lastRaw=null;lastConfirmed=-Infinity;}
 return {evaluate,clear,metrics};
}
// Exactly the attachment window used by HudTracker.surrender. Outside this
// window an OCR result cannot attach a dialog to any battle.
function hasSurrenderTarget(tracker,t){
 return !!(tracker.current&&t-tracker.lastHud<20||tracker.lastClosed&&t-tracker.lastClosed.end<20);
}
module.exports={createSurrenderCache,grayscalePgm,hasSurrenderTarget};
