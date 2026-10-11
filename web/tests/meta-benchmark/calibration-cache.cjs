'use strict';
const {getHeight}=require('./hud-scan-plan.cjs');
// Only cache failed calibration on identical consulted RGBA pixels. The rest of
// a frame cannot affect calibrate/readHud, which use width-based HUD coordinates.
function createCalibrationCache({enabled=true,maxBytes=4*1024*1024}={}){
 if(!Number.isInteger(maxBytes)||maxBytes<1)throw Error('Invalid calibration cache size');
 let previous=null,shape=null;const metrics={attempts:0,computed:0,reused:0,tooLarge:0};
 function run(img,compute){
  if(typeof compute!=='function'||!Buffer.isBuffer(img?.data)||!Number.isInteger(img.width)||!Number.isInteger(img.height)||img.data.length<img.width*img.height*4)throw Error('Invalid calibration input');
  metrics.attempts++;
  if(!enabled){metrics.computed++;return compute();}
  const h=getHeight(img.width,img.height),pixels=img.data.subarray(0,img.width*h*4),key=`${img.width}:${img.height}:${h}`;
  if(shape===key&&previous&&pixels.equals(previous)){metrics.reused++;return null;}
  const result=compute();metrics.computed++;
  if(result===null&&pixels.length<=maxBytes){previous=Buffer.from(pixels);shape=key;}
  else{previous=null;shape=null;if(pixels.length>maxBytes)metrics.tooLarge++;}
  return result;
 }
 return {run,metrics};
}
module.exports={createCalibrationCache};
