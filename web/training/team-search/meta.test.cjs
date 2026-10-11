'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMeta}=require('./meta.cjs');const {teamKey,features}=require('./common.cjs');
const species=['melmetal','cramorant','jumpluff','quagsire'].map((id,i)=>({speciesId:id,dex:i+1,weight:4-i,features:[i/4],moveset:['TACKLE'],scoutByType:Array(18).fill(.2+i/5)}));
test('team identity and neural features ignore bench ordering while preserving lead',()=>{assert.equal(teamKey([0,1,2]),teamKey([0,2,1]));assert.notEqual(teamKey([0,1,2]),teamKey([1,0,2]));assert.deepEqual(features([0,1,2],species),features([0,2,1],species));});
test('hybrid samples reproducibly include coherent and independent teams',()=>{const m=createMeta(species),a=m.fixtures(100,27);assert.deepEqual(a,m.fixtures(100,27));assert.equal(new Set(a.map(x=>x.component)).size,2);a.forEach(x=>assert.equal(new Set(x.team.map(p=>p.dex)).size,3));});
test('observed usage keeps lead and frequency, and rejects unknown teams instead of silently biasing data',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-meta-')),file=path.join(dir,'usage.json');
 try{fs.writeFileSync(file,JSON.stringify({source:'test',cp:1500,cup:'all',teams:[{members:['melmetal','cramorant','jumpluff'],count:100},{members:['jumpluff','quagsire','melmetal'],count:1}]}));const m=createMeta(species,{mode:'observed',usageFile:file}),a=m.fixtures(100,57);assert.ok(a.filter(x=>x.team[0].speciesId==='melmetal').length>90);assert.equal(m.description.observedCount,101);
  fs.writeFileSync(file,JSON.stringify({source:'test',cp:1500,cup:'all',teams:[{members:['missing','cramorant','jumpluff'],count:1}]}));assert.throws(()=>createMeta(species,{usageFile:file}),/outside prepared pool/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('recent observations change frequencies and stale counts cannot dominate the hybrid prior',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-meta-')),file=path.join(dir,'usage.json');
 try {
  fs.writeFileSync(file,JSON.stringify({source:'test',cp:1500,cup:'all',teams:[
   {members:['melmetal','cramorant','jumpluff'],count:100,collectedAt:'2026-10-01'},
   {members:['jumpluff','quagsire','melmetal'],count:100,collectedAt:'2026-10-10'}
  ]}));
  const m=createMeta(species,{mode:'observed',usageFile:file,halfLifeDays:3,asOf:'2026-10-10'});
  assert.equal(m.description.observedCount,200); assert.equal(m.description.weightedObservations,112.5);
  const fixtures=m.fixtures(10000,723);
  assert.ok(fixtures.filter(f=>f.team[0].speciesId==='jumpluff').length>8700);
  const hybrid=createMeta(species,{usageFile:file,halfLifeDays:3,asOf:'2026-10-10'});
  assert.equal(hybrid.description.observedShare,112.5/612.5);
  assert.throws(()=>createMeta(species,{usageFile:file,halfLifeDays:3}),/usage-as-of/);
  assert.throws(()=>createMeta(species,{usageFile:file,halfLifeDays:3,asOf:'2026-09-30'}),/later/);
  assert.throws(()=>createMeta(species,{usageFile:file,halfLifeDays:3,asOf:'2026-02-30'}),/valid ISO/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('reversed bench observations combine; distinct leads remain distinct',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-meta-')),file=path.join(dir,'usage.json');
 try {fs.writeFileSync(file,JSON.stringify({source:'test',cp:1500,cup:'all',teams:[
  {members:['melmetal','cramorant','jumpluff'],count:5},
  {members:['melmetal','jumpluff','cramorant'],count:8},
  {members:['jumpluff','melmetal','cramorant'],count:2}
 ]})); const usage=require('./meta.cjs').loadUsage(file,species); assert.equal(usage.rows.length,2); assert.equal(usage.rows[0].count,13); assert.equal(usage.total,15); assert.equal(usage.effectiveObservations,15);
 }finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('meta rejects invalid probabilities and never samples zero-weight members',()=>{
 assert.throws(()=>createMeta(species.map((p,i)=>({...p,weight:i?1:NaN}))),/finite/);
 assert.throws(()=>createMeta(species.map((p,i)=>({...p,weight:i?1:-1}))),/finite/);
 const zero=species.map((p,i)=>({...p,weight:i?1:0}));
 createMeta(zero).fixtures(500,34).forEach(f=>assert.ok(f.team.every(p=>p.speciesId!=='melmetal')));
 assert.throws(()=>createMeta(species).fixtures(1.5,1),/count/);
 assert.throws(()=>createMeta(species).fixtures(1,-1),/seed/);
});
