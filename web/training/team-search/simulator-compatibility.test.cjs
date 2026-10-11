'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const common=require('./common.cjs');
test('parity-verified simulator snapshots retain historical IDs and unverified edits invalidate them',()=>{
 const verified=require('../simulator-compatibility.json');
 for(const version of ['v1','v2','v4']){
  const source=common.sourceMechanicsHash({version});
  assert.ok(verified.sources[version][source],'Register only after frozen-original and replay parity checks');
  assert.equal(common.mechanicsHash({version}),verified.sources[version][source]);
 }
 // Simulate a new mechanics edit without changing files on disk. It must not
 // inherit the verified ID, including when loading a historical report.
 const fakeFS={...fs,readFileSync(file,...args){const source=fs.readFileSync(file,...args);return String(file).endsWith('/Battle.js')?source+'\n// unverified mechanics edit':source;}};
 const module={exports:{}};
 const load=vm.runInNewContext('(function(require,module,__dirname){'+fs.readFileSync(require.resolve('./common.cjs'),'utf8')+'\n})');
 load(name=>name==='node:fs'?fakeFS:require(name),module,__dirname);
 for(const version of ['v1','v2','v4']){
  assert.notEqual(module.exports.mechanicsHash({version}),common.mechanicsHash({version}));
  assert.equal(module.exports.mechanicsHash({version}),module.exports.sourceMechanicsHash({version}));
 }
});
