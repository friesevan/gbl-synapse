#!/usr/bin/env node
// Folds reviewer answers (read from the artifact's `answers` collection into ANSWERS_DIR) into
// learned priors (learned.json, used by refit.cjs and export-questions.cjs) and into the benchmark
// labels as verified fields. Usage: node fold-answers.cjs ANSWERS_DIR
const fs=require('node:fs'),path=require('node:path'),Q=require('../../includes/meta/questions.js');
const dir=process.argv[2],answers=new Map();
for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.json'))){const d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));const a=d.data||d;answers.set(a.qid,a);}
const learned=Q.learnedFromAnswers([],answers);fs.writeFileSync(path.join(__dirname,'learned.json'),JSON.stringify(learned,null,1));
let applied=0;
for(const a of answers.values()){if(a.value===null||a.value===undefined)continue;const m=/^claude-test:([^:]+)\.mp4:(\d+):(?:(my|opponent):([^:]+):)?(\w+)$/.exec(a.qid);// Hand-written checks: "N:ending-check" (how the battle ended) and "N:lead-check" (the opponent's lead).
 const c=/^claude-test:([^:]+)\.mp4:(\d+):(ending|lead)-check$/.exec(a.qid);if(c){const f=[path.join(__dirname,'labels','youtube',c[1]+'.json'),path.join(__dirname,'labels',c[1]+'.json')].find(x=>fs.existsSync(x));if(f){const L=JSON.parse(fs.readFileSync(f,'utf8')),b=L.battles.find(b=>b.n===Number(c[2])+1);if(b){if(c[3]==='ending'){const [r,e]=String(a.value).split(':');b.result=r;if(e)b.ending=e;else delete b.ending;delete b.endingUncertain;}else{const name=b.opp.find(n=>n.toLowerCase()===String(a.value));if(name){b.opp=[name,...b.opp.filter(n=>n!==name)];b.oppLead=name;}}b.verified=b.verified||{};b.verified[c[3]]={value:a.value,answeredAt:a.answeredAt};fs.writeFileSync(f,JSON.stringify(L,null,1));applied++;}}continue;}
 if(!m)continue;
 const [,rec,bi,side,key,kind]=m,file=[path.join(__dirname,'labels',rec+'.json'),path.join(__dirname,'labels','youtube',rec+'.json')].find(f=>fs.existsSync(f));if(!file)continue;const labels=JSON.parse(fs.readFileSync(file,'utf8'));if(!labels.battles)continue;const b=labels.battles[Number(bi)];if(!b)continue;
 b.verified=b.verified||{};const k=side?`${side}:${key}:${kind}`:kind;b.verified[k]={value:a.value,answeredAt:a.answeredAt};if(kind==='result'){const [result,ending]=String(a.value).split(':');b.result=result;b.ending=ending||'normal';}
 fs.writeFileSync(file,JSON.stringify(labels,null,1));applied++;}
console.log(`${answers.size} answers · ${applied} written to labels · learned: ${JSON.stringify(learned)}`);
