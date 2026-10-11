'use strict';
// The Meta Extractor's team-training export (includes/meta/core.js trainingExport) is a usage file.
// Synthetic battles only: build an export and load it through loadUsage.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('../../includes/meta/core.js');const {loadUsage,createMeta}=require('./meta.cjs');
const species=['melmetal','cramorant','jumpluff','quagsire_shadow'].map((id,i)=>({speciesId:id,dex:i+1,weight:1,scoutByType:Array(18).fill(.5)}));
const battle=(ids,extra={})=>({reviewed:true,leadConfirmed:true,context:{collectedAt:'2026-10-09',rank:'2000-2500'},opponent:ids.map(id=>({id})),...extra});
test('Meta Extractor team-training export loads as a usage file',()=>{
 const sample=[battle(['melmetal','cramorant','jumpluff']),battle(['melmetal','jumpluff','cramorant'],{context:{collectedAt:'2026-09-09',rank:'2000-2500'}}),battle(['quagsire_shadow','melmetal','jumpluff']),
  battle(['jumpluff','melmetal','cramorant'],{leadConfirmed:false}),battle(['melmetal','cramorant']),battle(['melmetal','cramorant','jumpluff'],{context:{example:true,collectedAt:'2026-10-09'}})];
 const exported=C.trainingExport(sample,{cp:1500,cup:'all',rank:'2000-2500'});
 assert.equal(exported.collectedAt,'2026-10-09'); assert.equal(exported.teams.length,3);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-meta-export-')),file=path.join(dir,'observed-meta-teams.json');
 try {
  fs.writeFileSync(file,JSON.stringify(exported));
  const usage=loadUsage(file,species,{halfLifeDays:30,asOf:'2026-10-09'});
  assert.equal(usage.total,3); assert.equal(usage.rows.length,2); assert.equal(usage.weightedCount,1+.5+1);
  assert.deepEqual(usage.rows.map(r=>[r.team.map(p=>p.speciesId).join('|'),r.rawCount]),[['melmetal|cramorant|jumpluff',2],['quagsire_shadow|jumpluff|melmetal',1]]);
  assert.equal(createMeta(species,{mode:'observed',usageFile:file}).description.observedCount,3);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
