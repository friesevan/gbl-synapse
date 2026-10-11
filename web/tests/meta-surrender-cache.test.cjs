'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createSurrenderCache,grayscalePgm,hasSurrenderTarget}=require('./meta-benchmark/surrender-cache.cjs');
const predicate=t=>/surrend|won.?t receive any rewards/i.test(t),pgm=x=>Buffer.from(`P5 2 1 255\n${x}`),raw=text=>({text,confidence:90});
test('dense 0.1s and HUD 0.5s share one OCR result for an exact static false positive',()=>{let calls=0;const cache=createSurrenderCache({isSurrender:predicate});for(const t of [0,.1,.2,.3,.4,.5,.5,.6,.7,.8,.9,1]){const r=cache.evaluate({t,identity:pgm('aa'),compute:()=>{calls++;return raw('SUPER EFFECTIVE');}});assert.equal(r.isSurrender,false);}assert.equal(calls,1);assert.equal(cache.metrics.reused,11);});
test('new short dialog is evaluated immediately between dense and HUD checks',()=>{let calls=0;const cache=createSurrenderCache({isSurrender:predicate});cache.evaluate({t:.3,identity:pgm('aa'),compute:()=>{calls++;return raw('White attack flash');}});const r=cache.evaluate({t:.4,identity:pgm('bb'),compute:()=>{calls++;return raw('Surrender and exit?');}});assert.equal(r.confirmed,true);assert.equal(calls,2);});
test('changed pixels are never suppressed by negative cadence, even at the same timestamp',()=>{const cache=createSurrenderCache({isSurrender:predicate});let calls=0;for(const x of ['aa','ab','ac'])cache.evaluate({t:.1,identity:pgm(x),compute:()=>{calls++;return raw('Attack animation');}});assert.equal(calls,3);assert.equal(cache.metrics.reused,0);});
test('confirmed positives retain original strict four-second cooldown across branches',()=>{const cache=createSurrenderCache({isSurrender:predicate});let calls=0;const compute=()=>{calls++;return raw('Surrender and exit?');};assert.equal(cache.evaluate({t:1,identity:pgm('aa'),compute}).confirmed,true);for(const t of [1,1.1,1.5,5])assert.equal(cache.evaluate({t,identity:pgm('bb'),compute}).suppressed,true);assert.equal(calls,1);assert.equal(cache.evaluate({t:5.1,identity:pgm('bb'),compute}).confirmed,true);assert.equal(calls,2);});
test('settings change invalidates exact input reuse',()=>{const cache=createSurrenderCache({isSurrender:predicate});let calls=0;const compute=()=>{calls++;return raw('Not a dialog');};for(const settings of ['PSM6:eng:v1','PSM6:eng:v1','PSM6:eng:v2'])cache.evaluate({t:0,identity:pgm('aa'),settings,compute});assert.equal(calls,2);});
test('caller buffer mutation cannot corrupt copied cache identity or returned raw text',()=>{const cache=createSurrenderCache({isSurrender:predicate});let calls=0;const identity=pgm('aa'),compute=()=>{calls++;return raw('Attack');};const first=cache.evaluate({t:0,identity,compute});identity[identity.length-1]=98;first.raw.text='Surrender';assert.equal(cache.evaluate({t:.1,identity,compute}).cached,false);assert.equal(cache.evaluate({t:.2,identity,compute}).raw.text,'Attack');assert.equal(calls,2);});
test('OCR failure does not poison cache; oversized identity is not retained',()=>{const cache=createSurrenderCache({isSurrender:predicate,maxBytes:2});const compute=()=>raw('Attack');assert.throws(()=>cache.evaluate({t:0,identity:pgm('aa'),compute:()=>{throw Error('OCR failed');}}),/OCR failed/);for(const t of [0,.1])assert.equal(cache.evaluate({t,identity:pgm('aa'),compute}).cached,false);assert.equal(cache.metrics.tooLarge,2);});
test('same grayscale PGM reuses OCR even when a caller had different original RGB source pixels',()=>{const cache=createSurrenderCache({isSurrender:predicate});let calls=0;const compute=()=>{calls++;return raw('Attack');};cache.evaluate({t:0,identity:pgm('aa'),compute});assert.equal(cache.evaluate({t:.1,identity:pgm('aa'),compute}).cached,true);assert.equal(calls,1);});

test('shared cache preserves outside legacy branch eligibility and raw recognitions',()=>{function simulate(cached){let lastCheck=-Infinity,lastPositive=-Infinity,calls=0,attempts=0;const answers=[],cache=createSurrenderCache({isSurrender:predicate});for(let frame=0;frame<100;frame++){const t=frame/10,hud=frame%5===0;if(!(t-lastPositive>4&&(hud||t-lastCheck>=.3)))continue;const identity=pgm(frame===25?'bb':'aa'),compute=()=>{calls++;return raw(frame===25?'Surrender and exit?':'White animation');};attempts++;if(!hud)lastCheck=t;const r=cached?cache.evaluate({t,identity,compute}):{raw:compute()};answers.push([t,r.raw.text]);if(predicate(r.raw.text))lastPositive=t;}return {calls,attempts,answers};}const old=simulate(false),next=simulate(true);assert.deepEqual(next.answers,old.answers);assert.equal(next.attempts,old.attempts);assert.ok(next.calls<old.calls);});
test('grayscale input exactly matches existing averaging and white threshold preprocessing',()=>{const img={width:2,height:2,data:Buffer.from([1,2,3,255,10,20,30,255,215,255,255,255,216,216,216,255])};assert.deepEqual(grayscalePgm(img,[0,0,2,2]),Buffer.concat([Buffer.from('P5 2 2 255\n'),Buffer.from([2,20,242,216])]));assert.deepEqual(grayscalePgm(img,[0,0,2,2],{whiteText:true}),Buffer.concat([Buffer.from('P5 2 2 255\n'),Buffer.from([255,255,255,0])]));});
test('candidate target gate agrees with actual tracker attachment including closed-battle fallback and strict boundary',()=>{
 const C=require('../includes/meta/core.js');
 for(const currentAge of [null,0,19.9,20,21,100])for(const closedAge of [null,0,19.9,20,21,100]){
  const tracker=new C.HudTracker(),t=200;
  if(currentAge!==null){tracker.current={events:[]};tracker.lastHud=t-currentAge;}
  if(closedAge!==null)tracker.lastClosed={end:t-closedAge,events:[]};
  const canAttach=hasSurrenderTarget(tracker,t);tracker.surrender(t);
  const attached=!!(tracker.current?.events.length||tracker.lastClosed?.events.length);
  assert.equal(canAttach,attached,JSON.stringify({currentAge,closedAge}));
 }
});
test('targetless surrender text cannot start a cooldown that hides the next real short dialog',()=>{
 const C=require('../includes/meta/core.js');
 function simulate(gated){
  const tracker=new C.HudTracker();let lastPositive=-Infinity;
  const cache=createSurrenderCache({isSurrender:C.isSurrender});
  function attempt(t){
   if(t-lastPositive<=4||gated&&!hasSurrenderTarget(tracker,t))return;
   const result=cache.evaluate({t,identity:pgm('aa'),compute:()=>raw('Surrender and exit?')});
   if(result.isSurrender){lastPositive=t;tracker.surrender(t);}
  }
  attempt(100); // Text on an unattached menu cannot describe a battle.
  tracker.open(101,false);tracker.lastHud=101;attempt(102);
  return tracker.current.events;
 }
 assert.deepEqual(simulate(false),[]); // Old global cooldown loses the new dialog.
 assert.deepEqual(simulate(true),[{t:102,kind:'surrender',label:'Surrender dialog'}]);
});
