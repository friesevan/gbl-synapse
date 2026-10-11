// Reads keyframe (sync sample) presentation times from an MP4/MOV file without decoding video.
// Seeking a <video> exactly to a keyframe needs no forward decoding, so the coarse scan
// visits ~1 frame per second at a fraction of the cost of arbitrary-time seeks.
(function(root){
'use strict';
const text=(view,offset)=>String.fromCharCode(view.getUint8(offset),view.getUint8(offset+1),view.getUint8(offset+2),view.getUint8(offset+3));
function boxes(view,start,end){const list=[];let p=start;while(p+8<=end){let size=view.getUint32(p),header=8;const type=text(view,p+4);if(size===1){size=Number(view.getBigUint64(p+8));header=16;}else if(size===0)size=end-p;if(size<header||p+size>end)break;list.push({type,start:p,body:p+header,end:p+size});p+=size;}return list;}
const child=(view,box,type)=>boxes(view,box.body,box.end).find(b=>b.type===type);
function path(view,box,types){let b=box;for(const t of types){b=b&&child(view,b,t);}return b;}
async function findMoov(size,read){let p=0;while(p+8<=size){const head=new DataView(await read(p,Math.min(size,p+16)));let len=head.getUint32(0),type=text(head,4);if(len===1)len=Number(head.getBigUint64(8));else if(len===0)len=size-p;if(len<8)break;if(type==='moov')return new DataView(await read(p,p+len));p+=len;}return null;}
function videoTrack(view){const moov={body:8,end:view.byteLength};for(const trak of boxes(view,moov.body,moov.end).filter(b=>b.type==='trak')){const hdlr=path(view,trak,['mdia','hdlr']);if(hdlr&&text(view,hdlr.body+8)==='vide')return trak;}return null;}
function table(view,box,fields,signedLast){if(!box)return null;const version=view.getUint8(box.body),n=view.getUint32(box.body+4),out=[];let p=box.body+8;for(let i=0;i<n;i++){const row=[];for(let f=0;f<fields;f++){row.push(f===fields-1&&signedLast&&version===1?view.getInt32(p):view.getUint32(p));p+=4;}out.push(row);}return out;}
function keyframeTimesFromMoov(view){
 const trak=videoTrack(view);if(!trak)throw Error('No video track found.');
 const mdhd=path(view,trak,['mdia','mdhd']),v=view.getUint8(mdhd.body),scale=view.getUint32(mdhd.body+(v===1?20:12));
 const stbl=path(view,trak,['mdia','minf','stbl']);
 const stts=table(view,child(view,stbl,'stts'),2),ctts=table(view,child(view,stbl,'ctts'),2,true),stss=table(view,child(view,stbl,'stss'),1);
 // First edit's media time shifts presentation to zero (common in phone recordings).
 let mediaTime=0;const elst=path(view,trak,['edts','elst']);if(elst){const ev=view.getUint8(elst.body),n=view.getUint32(elst.body+4);let p=elst.body+8;for(let i=0;i<n;i++){const mt=ev===1?Number(view.getBigInt64(p+8)):view.getInt32(p+4);if(mt>=0){mediaTime=mt;break;}p+=ev===1?20:12;}}
 const dts=[];let t=0;for(const [count,delta] of stts)for(let i=0;i<count;i++){dts.push(t);t+=delta;}
 const offset=new Array(dts.length).fill(0);if(ctts){let i=0;for(const [count,off] of ctts)for(let k=0;k<count&&i<offset.length;k++)offset[i++]=off;}
 const sync=stss?stss.map(r=>r[0]-1):dts.map((_,i)=>i);
 return {timescale:scale,samples:dts.length,keyframes:sync.filter(i=>i<dts.length).map(i=>Math.max(0,(dts[i]+offset[i]-mediaTime)/scale)).sort((a,b)=>a-b)};
}
// read(start,end) -> Promise<ArrayBuffer>; size = file length in bytes.
async function keyframeTimes(size,read){const moov=await findMoov(size,read);if(!moov)throw Error('No MP4 index (moov box) found.');return keyframeTimesFromMoov(moov);}
const fromFile=file=>keyframeTimes(file.size,(a,b)=>file.slice(a,b).arrayBuffer());
const api={keyframeTimes,fromFile};if(typeof module!=='undefined')module.exports=api;root.Mp4Index=api;
})(typeof window==='undefined'?globalThis:window);
