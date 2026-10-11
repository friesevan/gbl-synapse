#!/usr/bin/env node
// Fast-move and regional-form dataset: joins every confirmed human answer (feedback.json answers plus
// archived legacy labels in the work directory's labels/) to the saved extraction evidence in
// results/<video>.json. No video is decoded. Local data only; nothing here is committed or uploaded.
//   node movefit-data.cjs [WORK_DIR] [OUT.json]     (default WORK_DIR: ~/Desktop/Projects/PoGo Recorder/src/yt-harvest)
// Game data: the run's learningContext.gamemaster, else PvPoke's file cached for the upload/recording
// date (~/.cache/gbl-synapse/gamemaster/YYYY-MM-DD.json, nearest earlier cached date), else current.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const WORK=process.env.WORK_DIR||path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src/yt-harvest');
const GM_CACHE=process.env.GM_CACHE||path.join(os.homedir(),'.cache/gbl-synapse/gamemaster');
const REGISTRY=path.join(__dirname,'sources/registry.json');
const readJson=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return d;}};
const videoOf=a=>a.video?.id||String(a.recording||'').replace(/\.mp4$/,'')||String(a.qid||'').split(':')[1]?.replace(/\.mp4$/,'');
const KINDS=new Set(['fastMove','form','shadow']);
// Your own phone recordings are not in the YouTube registry; their file dates (March 2025) stand in.
const RECORDING_DATES={'10min':'20250305',hour:'20250305','hour-gl':'20250326',video:'20250305'};
function parseQid(qid){const m=/^[\w-]+:(.+?)\.mp4:(\d+):(my|opponent):([^:]+):(\w+)$/.exec(qid||'');return m&&{video:m[1],battle:Number(m[2]),side:m[3],key:m[4]};}
// Human labels only: reviewer answers (never model resolutions) and archived legacy labels.
function loadLabels(work=WORK,{kinds=KINDS}={}){const fb=readJson(path.join(work,'feedback.json'),{}),out=new Map();
 const add=(a,source)=>{if(!a||!kinds.has(a.kind)||a.value===null||a.value===undefined||a.source==='model'||a.modelResolved)return;const q=parseQid(a.qid)||{};
  const rec={qid:a.qid,kind:a.kind,value:a.value,video:videoOf(a)||q.video,battle:Number(a.battle??q.battle),side:a.side||q.side,key:a.key||q.key,allBattles:!!a.allBattles,species:a.species,modelTop:a.modelTop,modelP:a.modelP,purple:a.purple,channel:a.video?.channel||null,uploadDate:a.video?.uploadDate||null,source};
  if(!rec.video||!Number.isFinite(rec.battle)||!rec.side||!rec.key)return;if(!out.has(a.qid)||source==='feedback')out.set(a.qid,rec);};
 for(const a of Object.values(fb.answers||{}))add(a,'feedback');
 const dir=path.join(work,'labels');for(const f of fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')):[])for(const a of Object.values(readJson(path.join(dir,f),{}).verified||{}))if(!out.has(a.qid))add(a,'legacy');
 return [...out.values()];}
function registry(){const r=readJson(REGISTRY,[]);return new Map((Array.isArray(r)?r:r.videos||[]).map(v=>[v.id,v]));}
// Cached PvPoke game data for a date: the file keyed on the 1st/16th on or before it, else the nearest
// earlier cached file, else the nearest later one.
function gamemasterFor(date,cache=GM_CACHE){const d=String(date||'').replace(/-/g,'');if(!/^\d{8}$/.test(d)||!fs.existsSync(cache))return null;const iso=`${d.slice(0,4)}-${d.slice(4,6)}-${Number(d.slice(6))>=16?'16':'01'}`;
 const files=fs.readdirSync(cache).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();if(!files.length)return null;const earlier=files.filter(f=>f.slice(0,10)<=iso);return path.join(cache,earlier.length?earlier[earlier.length-1]:files[0]);}
// League CP of one battle from its nameplate CPs (the harvester's league guess can be a cup or wrong).
function leagueFromCPs(b,fallback=1500){const cps=[...(b.my||[]),...(b.opponent||[])].map(p=>Number(p.cp)).filter(c=>c>0&&c<9000);if(!cps.length)return fallback;const top=Math.max(...cps);return top<=500?500:top<=1500?1500:top<=2500?2500:10000;}
function runContext(videoId,work=WORK,reg=registry()){const file=path.join(work,'results',videoId+'.json');if(!fs.existsSync(file))return null;const raw=readJson(file,null);if(!raw||!Array.isArray(raw.full))return null;
 const c=raw.learningContext||{},r=reg.get(videoId)||{},date=c.uploadDate||r.uploadDate||RECORDING_DATES[videoId];
 const gm=c.gamemaster&&fs.existsSync(c.gamemaster)?c.gamemaster:gamemasterFor(date);
 return {videoId,file,raw,gamemaster:gm,date,league:c.league||{great:1500,ultra:2500,master:10000,little:500}[r.leagueId]||null,channel:r.channel||null};}
// Per-channel counts of your side's confirmed fast moves (the creator's team repeats across videos).
function channelLearned(labels,channelOf){const out={};for(const l of labels){if(l.kind!=='fastMove'||l.side!=='my'||l.value==null)continue;const ch=l.channel||channelOf?.(l.video);if(!ch)continue;const sp=String(l.species).replace(/_shadow$/,'');
 const m=((out[ch]=out[ch]||{moves:{}}).moves[sp]=out[ch].moves[sp]||{});m[l.value]=(m[l.value]||0)+1;}return out;}
module.exports={channelLearned,loadLabels,runContext,gamemasterFor,leagueFromCPs,registry,parseQid,videoOf,WORK,GM_CACHE};
if(require.main===module){const work=process.argv[2]||WORK,labels=loadLabels(work),reg=registry(),ctx=new Map();let missing=0;const by={};
 for(const l of labels){if(!ctx.has(l.video))ctx.set(l.video,runContext(l.video,work,reg));const c=ctx.get(l.video),b=c?.raw.full[l.battle],m=b?.[l.side]?.find(p=>p.key===l.key);const k=l.kind+(m?'':' (unmatched)');by[k]=(by[k]||0)+1;if(!m)missing++;}
 console.log(JSON.stringify(by),'videos',ctx.size,'no gamemaster',[...ctx.values()].filter(c=>c&&!c.gamemaster).map(c=>c.videoId).join(' ')||'none');
 if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(labels));}
