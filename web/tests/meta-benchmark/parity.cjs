#!/usr/bin/env node
// Speed-change parity check: runs run-node.cjs from a base commit and from this checkout on the same
// video stretches and requires identical JSON outputs (timings, metrics and decoding settings excluded).
//   node parity.cjs [--base REF] [--only id,id] [--env K=V ...] [--base-env K=V ...]
// REF (default HEAD) is unpacked with git archive into a temporary directory; game data is shared.
// Each job reuses the saved result's crop, league and game data (WORK_DIR/results/<id>.json, as
// reextract-labelled.cjs does). Videos: VIDEO_DIR (default ~/Desktop/Projects/PoGo Recorder/src/relabel-cache);
// a job whose id contains "." is a file under ~/Desktop/Projects/PoGo Recorder/src (no crop).
// Prints one line per job with both timings; exit code 1 if any output differs.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync,execFileSync}=require('node:child_process');
const args=process.argv.slice(2),opt=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;},multi=k=>args.flatMap((a,i)=>a===k?[args[i+1]]:[]);
const SRC=path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src'),VIDEOS=process.env.VIDEO_DIR||path.join(SRC,'relabel-cache'),WORK=process.env.WORK_DIR||path.join(SRC,'yt-harvest');
// Different layouts and resolutions: 1080p / 720p / 1440-wide YouTube crops, small 296- and 340-wide
// phone crops, a short screen, and an owner recording (HEVC 886×1920, no crop). 4 minutes each.
const JOBS=[['bB0ZrWjwdZw',0,240],['2NuWI-UdR7w',0,240],['2ZYYPbouhUc',40,280],['Re8jxiPGHxo',240,480],['ptxHuMJ5XuE',4170,4410],['PbzVRPgmBQY',30,270],['10min.mp4',0,240]];
const only=opt('--only')?.split(','),jobs=JOBS.filter(j=>!only||only.includes(j[0])),ref=opt('--base')||'HEAD';
const web=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'parity-')),base=path.join(tmp,'base');fs.mkdirSync(base);
const tar=execFileSync('git',['-C',web,'archive',ref,'--','includes/meta','tests/meta-benchmark'],{maxBuffer:1<<28});execFileSync('tar',['-x','-C',base],{input:tar});
fs.symlinkSync(path.join(web,'includes/pro'),path.join(base,'includes/pro'));
const kv=list=>Object.fromEntries(list.map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
function run(root,[id,start,end],extra,tag){const file=id.includes('.')?path.join(SRC,id):path.join(VIDEOS,id+'.mp4'),saved=path.join(WORK,'results',id+'.json'),old=!id.includes('.')&&fs.existsSync(saved)?JSON.parse(fs.readFileSync(saved,'utf8')):{};
 const env={...process.env,FFMPEG_THREADS:'1',START:String(start),END:String(end),LEAGUE:String(old.learningContext?.league||1500),...extra};delete env.CROP;delete env.RANGES;
 if(old.crop)env.CROP=old.crop.join(',');const gm=old.learningContext?.gamemaster;if(gm&&fs.existsSync(gm))env.GAMEMASTER=gm;else delete env.GAMEMASTER;
 const out=path.join(tmp,`${tag}-${id}-${start}.json`),r=spawnSync('nice',['-n','10','node',path.join(root,'tests/meta-benchmark/run-node.cjs'),file,out],{env,encoding:'utf8'});
 if(r.status!==0)throw Error(`${tag} ${id}: ${r.stderr.slice(-400)}`);return JSON.parse(fs.readFileSync(out,'utf8'));}
// Battle ids are random UUIDs, generated per run.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const strip=j=>{const c={...j};for(const k of ['seconds','realtime','metrics','decoding'])delete c[k];return c;};
function diff(a,b,p='',out=[]){if(out.length>5)return out;if(typeof a!==typeof b||Array.isArray(a)!==Array.isArray(b)){out.push(p+': type');return out;}
 if(a&&typeof a==='object'){for(const k of new Set([...Object.keys(a),...Object.keys(b||{})]))diff(a[k],b?.[k],p+'.'+k,out);return out;}if(a!==b&&!(/\.id$/.test(p)&&UUID.test(a)&&UUID.test(b)))out.push(`${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);return out;}
const line=j=>{const m=j.metrics.ms;return `${j.seconds.toFixed(1)} s (${j.realtime}×; decode wait ${(m.decodeWait/1000).toFixed(1)}, bars ${(m.bars/1000).toFixed(1)}, HUD ${(m.hud/1000).toFixed(1)}, OCR ${(m.ocr/1000).toFixed(1)})`;};
let bad=0;
for(const job of jobs){const a=run(base,job,kv(multi('--base-env')),'base'),b=run(web,job,kv(multi('--env')),'new'),d=diff(strip(a),strip(b));if(d.length)bad++;
 console.log(`${job[0]} ${job[1]}-${job[2]}: ${a.battles.length} battles · ${d.length?'DIFFERENT':'identical'}\n  base ${line(a)}\n  new  ${line(b)}${d.length?'\n  '+d.join('\n  '):''}`);}
fs.rmSync(tmp,{recursive:true,force:true});process.exit(bad?1:0);
