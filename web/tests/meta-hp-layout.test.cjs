// HP-bar sides on phone, 16:9 and wide (tablet-shaped) screens (hp.js assignBars/track/barSettings).
const {test}=require('node:test'),assert=require('node:assert/strict'),Hp=require('../includes/meta/hp.js');
const bar=(x0,o={})=>({x0,y0:500,y1:514,x1:x0+246,fill:.6,trail:0,frame:1,...o});
// A teal fill (rows o+14–o+27, 150 px) under a white outline row o+10, one bar per 40-row strip.
function strips(xs,W=886){const H=40*xs.length,data=new Uint8ClampedArray(W*H*4);for(let i=0;i<data.length;i+=4)data[i+3]=255;
 xs.forEach((x0,k)=>{const o=40*k;for(let y=o;y<o+40;y++)for(let x=x0-2;x<x0+248;x++){const i=(y*W+x)*4;if(y===o+10)data[i]=data[i+1]=data[i+2]=250;else if(y>=o+14&&y<=o+27&&x>=x0&&x<x0+150){data[i]=0;data[i+1]=228;data[i+2]=172;}}});
 return {data,width:W,height:H};}
test('phone screens keep the original windows; the aura and effect text still count a centred bar as the opponent\'s',()=>{
 assert.equal(Hp.barSettings(886,1884),Hp.BAR);assert.equal(Hp.barSettings(886,1628),Hp.BAR,'0.544, the widest phone measured, still uses the phone layout');
 // assignBars places the aura box and the effect-text strip. Skipping the centred bar there cost the Shadow
 // classifier 4 of 391 held-out calls and log-loss (README section 3), so on phones it stays the opponent's.
 const as=Hp.assignBars([bar(55),bar(322)],886,1884);assert.equal(as.my.x0,55);assert.equal(as.opponent.x0,322);
 assert.deepEqual(Hp.assignBars([bar(55),bar(322)],886),as,'no height: phone rule');
 assert.equal(Hp.assignBars([bar(135)],886,1884).my,null);});
test('16:9 screens (0.56) put your bar right of the phone window and skip centred cutscene bars',()=>{
 // Measured on 0.561 videos: Zekrom 122, Lunala 150; the opponent's bar 413–589.
 assert.equal(Hp.barSettings(886,1580),Hp.BAR_WIDE);assert.equal(Hp.barSettings(606,1080),Hp.BAR_WIDE,'source pixels (the browser) agree');
 const as=Hp.assignBars([bar(122),bar(533)],886,1580);assert.equal(as.my.x0,122);assert.equal(as.opponent.x0,533);
 assert.equal(Hp.assignBars([bar(150)],886,1580).my.x0,150);assert.equal(Hp.assignBars([bar(56)],886,1580).my.x0,56);
 const cut=Hp.assignBars([bar(322)],886,1580);assert.equal(cut.my,null);assert.equal(cut.opponent,null);
 assert.equal(Hp.assignBars([bar(122*606/886)],606,1080).my.x0,122*606/886);});
test('track follows your bar on a 16:9 screen; the cutscene bar no longer stands in for the opponent\'s',()=>{
 // The centred bar shows on more frames than the opponent's own bar (as in a matchup with long cutscenes).
 const frames=[0,1,2,3,4,5].map(i=>({t:i*.1,bars:[bar(121,{fill:.8-i*.05}),bar(322,{fill:.3}),...(i%2?[]:[bar(533,{fill:.5})])]}));
 const w=Hp.track(frames,886,1580);assert.deepEqual(w.my.map(p=>+p.fill.toFixed(2)),[.8,.75,.7,.65,.6,.55]);assert.deepEqual(w.opponent.map(p=>p?.fill??null),[.5,null,.5,null,.5,null]);
 const p=Hp.track(frames,886,1884);assert.ok(p.my.every(x=>x===null),'the phone window misses x 121');assert.deepEqual(p.opponent.map(x=>x?.fill??null),[.5,null,.5,null,.5,null],'phones skip the cutscene bar too');});
test('track on a phone: the opponent\'s series follows their own bar, not the more frequent cutscene bar',()=>{
 // Long cutscenes: the centred bar (yours or theirs, whoever attacks) shows on 4 of 6 frames, the opponent's own bar on 3.
 const frames=[0,1,2,3,4,5].map(i=>({t:i*.1,bars:[bar(55,{fill:.9}),...(i<4?[bar(322,{fill:.2+i*.1})]:[]),...(i%2?[]:[bar(450,{fill:.6})])]}));
 const p=Hp.track(frames,886,1884);assert.ok(p.my.every(x=>x.fill===.9));assert.deepEqual(p.opponent.map(x=>x?.fill??null),[.6,null,.6,null,.6,null]);
 assert.ok(Hp.track(frames.map(f=>({...f,bars:f.bars.filter(b=>b.x0===322)})),886,1884).opponent.every(x=>x===null),'cutscene bars alone give no opponent series');});
test('wide screens: your bar further right, a centred cutscene bar belongs to neither side',()=>{
 assert.equal(Hp.barSettings(886,1318),Hp.BAR_WIDE);
 const as=Hp.assignBars([bar(135),bar(450)],886,1318);assert.equal(as.my.x0,135);assert.equal(as.opponent.x0,450);
 const cut=Hp.assignBars([bar(322)],886,1318);assert.equal(cut.my,null);assert.equal(cut.opponent,null);
 assert.equal(Hp.assignBars([bar(55)],886,1318).my.x0,55);});
test('track follows the wide windows and skips centred bars',()=>{
 const frames=[0,1,2,3].map(i=>({t:i*.1,bars:[bar(137,{fill:.8-i*.05}),bar(322,{fill:.2}),bar(412,{fill:.5})]}));
 const w=Hp.track(frames,886,1318);assert.deepEqual(w.my.map(p=>+p.fill.toFixed(2)),[.8,.75,.7,.65]);assert.deepEqual(w.opponent.map(p=>p.fill),[.5,.5,.5,.5]);
 const p=Hp.track(frames,886,1884);assert.ok(p.my.every(x=>x===null),'phone window misses x 137');});
test('findBars keeps bars right of the phone window only with the 16:9 and wide settings',()=>{
 for(const [x0,H] of [[135,1318],[122,1580],[150,1580]]){const img=strips([x0]);assert.equal(Hp.findBars(img,0).length,0);const got=Hp.findBars(img,0,Hp.barSettings(886,H));assert.equal(got.length,1);assert.equal(Math.round(got[0].x0),x0);}});
test('phoneBars of the wide-settings result equals the phone-settings result (focus shots keep their input)',()=>{
 // One bar per strip, at x 55 (yours on a phone), 135 (yours on a tablet), 322 (centred) and 450.
 const img=strips([55,135,322,450]),phone=Hp.findBars(img,0),wide=Hp.findBars(img,0,Hp.BAR_WIDE);
 assert.ok(wide.length>phone.length);assert.deepEqual(Hp.phoneBars(wide,886),phone);});
