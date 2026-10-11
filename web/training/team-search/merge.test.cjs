'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {merge}=require('./merge.cjs');
test('merging deduplicates seeded fixture evidence and rejects nondeterministic duplicates',()=>{
 const o={team:[0,1,2],opponent:['a','b','c'],seed:1,score:.5},a={config:{poolHash:'same'},round:1,observations:[o]},b={...a,round:2,observations:[o,{...o,seed:2,score:1}]};const s=merge([a,b]);assert.equal(s.observations.length,2);assert.equal(s.records[0].games,4);assert.equal(s.records[0].reward,3);assert.equal(s.merged.deduplicatedFixtures,1);assert.equal(s.round,2);assert.throws(()=>merge([a,{...b,observations:[{...o,score:0}]}]),/inconsistent/);
});

test('merge rejects different simulator mechanics',()=>{const a={config:{poolHash:'p',mechanicsHash:'a'},observations:[{team:[0,1,2],opponent:['x','y','z'],seed:1,score:.5}],round:1},b={...a,config:{poolHash:'p',mechanicsHash:'b'}};assert.throws(()=>merge([a,b]),/mechanics/);});

test('a merged warm start skips fixture rounds already partly labeled',()=>{const o={team:[0,1,2],opponent:['a','b','c'],seed:1,score:.5,round:7};const a={config:{poolHash:'p'},round:7,pending:{completed:['0,1,2']},observations:[o]};const b={...a,round:6,observations:[{...o,seed:2,round:5}]};assert.equal(merge([a,b]).round,8);});
