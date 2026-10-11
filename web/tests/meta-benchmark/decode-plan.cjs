'use strict';
// Opt-in experiments. Default pixels and frame cadence match the existing extractor.
function plan({width,height,crop=null,fps=10,analysisWidth='',hwaccel=''}={}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||!Number.isFinite(fps)||fps<=0||fps>60)throw Error('Invalid video dimensions/FPS');
 if(crop&&(!Array.isArray(crop)||crop.length!==4||!crop.every(Number.isInteger)||crop[0]<0||crop[1]<0||crop[2]>width||crop[3]>height||crop[2]<=crop[0]||crop[3]<=crop[1]))throw Error('Invalid screen crop');
 const sourceWidth=crop?crop[2]-crop[0]:width,sourceHeight=crop?crop[3]-crop[1]:height;
 let w=crop?886:width;
 if(analysisWidth==='native')w=sourceWidth;
 else if(analysisWidth!==''&&analysisWidth!=null){w=Number(analysisWidth);if(!Number.isInteger(w)||w<320||w>1920)throw Error('ANALYSIS_WIDTH must be native or an integer from 320 to 1920');}
 const resized=!!crop||w!==width,h=resized?Math.max(2,Math.round(sourceHeight*w/sourceWidth/2)*2):height;
 const pre=[];if(crop)pre.push(`crop=${sourceWidth}:${sourceHeight}:${crop[0]}:${crop[1]}`);if(resized)pre.push(`scale=${w}:-2:flags=bicubic`);
 if(!['','none','auto','videotoolbox'].includes(hwaccel))throw Error('FFMPEG_HWACCEL must be none, auto or videotoolbox');
 return {width:w,height:h,filters:[`fps=${fps}`,...pre],inputArgs:hwaccel&&hwaccel!=='none'?['-hwaccel',hwaccel]:[],hwaccel:hwaccel||'none',pixelRatio:w*h/(width*height)};
}
// Keeps only the top `rows` rows of each decoded frame. format=rgba makes the scaler emit the final pixels
// before crop (a plain copy), so the kept rows are byte-identical to the full frame's: checked on H.264
// YouTube crops (scaled) and the owner's HEVC recordings (unscaled), 2026-10-11. Fewer bytes through the
// pipe: about 23% less on 16:9 screens, where the analysis never reads below the HP-bar band.
function keepRows(p,rows){if(!Number.isInteger(rows)||rows<2||rows>p.height)throw Error('Invalid decoded row count');
 return rows===p.height?{...p,rows}:{...p,rows,filters:[...p.filters,'format=rgba',`crop=${p.width}:${rows}:0:0`]};}
module.exports={plan,keepRows};
