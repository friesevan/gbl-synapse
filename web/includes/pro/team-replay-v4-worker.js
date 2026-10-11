'use strict';
let host='localhost',webRoot='',siteVersion='training',settings={colorblindMode:false,hardMovesetLinks:false},archetypes,data;
const $={ajax(){},getJSON(url,cb){if(url.includes('aiArchetypes'))cb(archetypes);},each(items,cb){for(let i=0;i<items.length;i++)if(cb(i,items[i])===false)break;}};
importScripts('team-replay-v4-runtime.js','team-replay-v4-manifest.js');
onmessage=async({data:request})=>{try{
 if(request.mechanicsHash!==NeuralReplayV4.mechanicsHash||request.dataHash!==NeuralReplayV4.dataHash)throw Error('This report uses a different simulator or data snapshot. Install its matching viewer adapter before replaying.');
 [data,archetypes]=await Promise.all([fetch('data/gamemaster.json').then(r=>{if(!r.ok)throw Error('Game data unavailable');return r.json();}),fetch('vendor/training/aiArchetypes.json').then(r=>r.json())]);
 const options={...(request.engineOptions||{}),trace:request.explain||request.mode!=='compare'};
 function one(a,b,seed){const result=play(a,b,defaults,defaults,{...options,seed});if(result.timedOut)throw Error('Replay timed out');return {a:result,pairedScore:result.score,fixtureMode:'single'};}
 if(request.mode==='compare'){
  const rows=[];for(const c of request.fixtures){const a=one(request.teams[0],c.opponent,c.seed),b=one(request.teams[1],c.opponent,c.seed);rows.push({opponents:c.opponents,seed:c.seed,a:a.pairedScore,b:b.pairedScore,...(request.explain?{evidence:{a:a.a.timeline.filter(e=>!e.type.startsWith('fast ')||(request.focusMoves||[]).includes(e.detail?.moveId)),b:b.a.timeline.filter(e=>!e.type.startsWith('fast ')||(request.focusMoves||[]).includes(e.detail?.moveId))}}:{})});postMessage({progress:rows.length,total:request.fixtures.length});}postMessage({rows});
 }else postMessage(one(request.teams[0],request.teams[1],request.seed));
}catch(e){postMessage({error:e.message});}};
