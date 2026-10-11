'use strict';
function random(seed){let s=seed>>>0;return ()=>{s=(s+0x6D2B79F5)>>>0;let t=Math.imul(s^(s>>>15),1|s);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};}
const defaults={switch:1,switchFarm:1,bait:1,farm:1,shield:1};
module.exports={random,defaults};
