'use strict';
// Keyframe screening only; do not crop the extractor's battle/HP/aura frames.
// The crop follows the existing full-height scale, preserving all sampled HUD pixels.
// calibrate searches dy<=160 and can center text by at most +27 reference pixels.
// Probe's known offsets add +/-8. Keep dy<=200, plus the existing 215-pixel HUD
// bottom margin. Larger located offsets also retain their full +/-8 search band.
function hudScanHeight(width,fullHeight,locatedDy=0){
 if(!Number.isInteger(width)||width<2||!Number.isInteger(fullHeight)||fullHeight<2)throw Error('Invalid scan dimensions');
 if(locatedDy!==null&&!Number.isFinite(locatedDy))throw Error('Invalid HUD offset');
 const maxDy=Math.max(200,Math.ceil(locatedDy??0)+8);
 return Math.min(fullHeight,Math.ceil((215+maxDy)*width/886/2)*2);
}
module.exports={getHeight:hudScanHeight,hudScanHeight};
