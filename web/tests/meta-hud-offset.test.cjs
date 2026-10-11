// Recalibration of the nameplate offset after a wrong first calibration (core.js HudOffset).
const {test}=require('node:test'),assert=require('node:assert/strict'),C=require('../includes/meta/core.js');
// An 886-wide frame with both nameplates (white panel, red balls, dark name strokes) drawn dy px lower.
function hudFrame(dy){const W=886,H=400,data=new Uint8ClampedArray(W*H*4);for(let i=0;i<data.length;i+=4)data.set([40,70,120,255],i);
 const fill=([a,b,z,d],c)=>{for(let y=Math.max(0,b+dy);y<d+dy;y++)for(let x=a;x<z;x++)data.set([...c,255],(y*W+x)*4);};
 for(const side of ['my','opponent']){fill(C.HUD.panel[side],[250,250,250]);for(const b of C.HUD.balls[side])fill(b,[230,40,40]);const [x0,,x1]=C.HUD.name[side];for(let x=x0+2;x<x1-2;x+=7)fill([x,132,x+3,148],[30,30,30]);}
 return {width:W,height:H,data};}
test('an untrusted offset is recalibrated every 4th HUD miss, a trusted one every 20th; proven offsets are kept',()=>{const img=hudFrame(8);assert.ok(Math.abs(C.calibrate(img)-8)<=2);
 const o=new C.HudOffset(-20);const first=o.retry(img);assert.ok(first!==null&&Math.abs(first-8)<=2);assert.equal(o.retry(img),null);assert.equal(o.retry(img),null);assert.equal(o.retry(img),null);assert.ok(o.retry(img)!==null);
 o.accept(first,6);assert.equal(o.dy,first);assert.deepEqual(o.changes,[{t:6,from:-20,to:first}]);assert.deepEqual(o.known,[first],'the unproven first offset is dropped');assert.deepEqual(o.others(),[]);
 const near=new C.HudOffset(7);assert.equal(near.retry(img),null,'an offset within 4 px is kept');
 // Trusted: a second offset (another battle's layout) is proposed on every 20th miss and added to the proven ones.
 const t=new C.HudOffset(-20);t.trust();assert.deepEqual(t.known,[-20]);const d=t.retry(img);assert.ok(d!==null&&Math.abs(d-8)<=2);for(let i=1;i<20;i++)assert.equal(t.retry(img),null);
 t.accept(d,50);assert.deepEqual(t.known,[-20,d]);assert.deepEqual(t.others(),[-20]);t.use(-20);assert.deepEqual(t.others(),[d]);for(let i=0;i<40;i++)assert.equal(t.retry(img),null,'a proven offset is not proposed again');});
test('start-of-battle misreads stay in the battle; a lone mid-battle frame closed by a later HUD is dropped, kept at the end',()=>{
 const gm=require('../includes/pro/data/gamemaster.json'),d=C.dictionary(gm.pokemon),A=['alive','alive','alive'],F=['fainted','alive','alive'];
 const side=(name,balls=A,shields=2)=>({balls,fainted:balls.filter(b=>b==='fainted').length,shields,hit:{...C.match(name,d),confidence:90,raw:name}}),hud=(m,o)=>({my:m,opponent:o});
 const t=new C.HudTracker();t.observe(0,hud(side('Azumarill',A,1),side('Melmetal')));t.observe(.5,hud(side('Azumarill'),side('Melmetal')));t.observe(1,hud(side('Azumarill'),side('Melmetal')));
 const b=t.finish();assert.equal(b.length,1);assert.equal(b[0].start,0);assert.deepEqual(b[0].shieldsUsed,{my:0,opponent:0});assert.ok(!b[0].events.some(e=>e.kind==='shield'));
 const v=new C.HudTracker();v.observe(0,hud(side('Azumarill'),side('Melmetal')));v.observe(5,hud(side('Azumarill',F,1),side('Melmetal')));v.blackout(8);v.observe(60,hud(side('Azumarill',F,1),side('Melmetal',F)));v.observe(100,hud(side('Lanturn'),side('Skarmory')));
 assert.deepEqual(v.finish().map(x=>x.start),[0,100],'the lone frame at 60 is dropped');
 const w=new C.HudTracker();w.observe(0,hud(side('Azumarill'),side('Melmetal')));w.observe(3,hud(side('Azumarill',A,1),side('Melmetal')));w.observe(15,hud(side('Lanturn'),side('Skarmory')));
 assert.equal(w.finish().length,2,'after a HUD gap a fresh HUD is a new battle, even early');
 const u=new C.HudTracker();u.observe(0,hud(side('Azumarill'),side('Melmetal')));u.observe(5,hud(side('Azumarill',F,1),side('Melmetal')));u.blackout(8);u.observe(60,hud(side('Azumarill',F,1),side('Melmetal',F)));
 assert.equal(u.finish().length,2,'a lone frame at the end of the recording is kept');});
