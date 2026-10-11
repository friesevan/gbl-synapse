// HP-bar sides on phone and wide (tablet-shaped) screens (hp.js assignBars/track/barSettings).
const {test}=require('node:test'),assert=require('node:assert/strict'),Hp=require('../includes/meta/hp.js');
const bar=(x0,o={})=>({x0,y0:500,y1:514,x1:x0+246,fill:.6,trail:0,frame:1,...o});
test('phone screens keep the original windows, centred bars included',()=>{
 assert.equal(Hp.barSettings(886,1884),Hp.BAR);assert.equal(Hp.barSettings(886,1576),Hp.BAR,'9:16 phones (0.56) use the phone layout');
 const as=Hp.assignBars([bar(55),bar(322)],886,1884);assert.equal(as.my.x0,55);assert.equal(as.opponent.x0,322);
 assert.deepEqual(Hp.assignBars([bar(55),bar(322)],886),as,'no height: phone rule');
 assert.equal(Hp.assignBars([bar(135)],886,1884).my,null);});
test('wide screens: your bar further right, a centred cutscene bar belongs to neither side',()=>{
 assert.equal(Hp.barSettings(886,1318),Hp.BAR_WIDE);
 const as=Hp.assignBars([bar(135),bar(450)],886,1318);assert.equal(as.my.x0,135);assert.equal(as.opponent.x0,450);
 const cut=Hp.assignBars([bar(322)],886,1318);assert.equal(cut.my,null);assert.equal(cut.opponent,null);
 assert.equal(Hp.assignBars([bar(55)],886,1318).my.x0,55);});
test('track follows the wide windows and skips centred bars',()=>{
 const frames=[0,1,2,3].map(i=>({t:i*.1,bars:[bar(137,{fill:.8-i*.05}),bar(322,{fill:.2}),bar(412,{fill:.5})]}));
 const w=Hp.track(frames,886,1318);assert.deepEqual(w.my.map(p=>+p.fill.toFixed(2)),[.8,.75,.7,.65]);assert.deepEqual(w.opponent.map(p=>p.fill),[.5,.5,.5,.5]);
 const p=Hp.track(frames,886,1884);assert.ok(p.my.every(x=>x===null),'phone window misses x 137');});
test('findBars keeps bars in the wide window only with wide settings',()=>{const W=886,H=40,data=new Uint8ClampedArray(W*H*4);
 // A teal fill (rows 14–27, x 135–381) under a white outline row 10.
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;data[i+3]=255;if(y===10&&x>=133&&x<=383){data[i]=data[i+1]=data[i+2]=250;}else if(y>=14&&y<=27&&x>=135&&x<381){data[i]=0;data[i+1]=228;data[i+2]=172;}}
 const img={data,width:W,height:H};assert.equal(Hp.findBars(img,0).length,0);const wide=Hp.findBars(img,0,Hp.barSettings(W,1318));assert.equal(wide.length,1);assert.equal(Math.round(wide[0].x0),135);});
test('phoneBars of the wide-settings result equals the phone-settings result (focus shots keep their input)',()=>{const W=886,H=170,data=new Uint8ClampedArray(W*H*4);
 for(let i=0;i<data.length;i+=4)data[i+3]=255;
 // One bar per 40-row strip, at x 55 (yours on a phone), 135 (yours on a tablet), 322 (centred) and 450.
 [55,135,322,450].forEach((x0,k)=>{const o=40*k;for(let y=o;y<o+40;y++)for(let x=x0-2;x<x0+248;x++){const i=(y*W+x)*4;if(y===o+10)data[i]=data[i+1]=data[i+2]=250;else if(y>=o+14&&y<=o+27&&x>=x0&&x<x0+150){data[i]=0;data[i+1]=228;data[i+2]=172;}}});
 const img={data,width:W,height:H},phone=Hp.findBars(img,0),wide=Hp.findBars(img,0,Hp.BAR_WIDE);
 assert.ok(wide.length>phone.length);assert.deepEqual(Hp.phoneBars(wide,W),phone);});
