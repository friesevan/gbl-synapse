'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Network, reference } = require('./interaction.cjs');
const { predictParallel } = require('./predict.cjs');
test('parallel proposal inference exactly preserves serial scores and order', async () => {
  const models = [new Network(3, 4, 5), new Network(3, 6, 7)];
  const inputs = Array.from({ length: 17 }, (_, i) => [i / 17, .2, 1 - i / 17]);
  const refs = reference(models, inputs.slice(0, 5));
  const serial = await predictParallel(inputs, models, refs, { workers: 1 });
  const parallel = await predictParallel(inputs, models, refs, { workers: 4 });
  assert.deepEqual(parallel, serial);
  assert.deepEqual(await predictParallel([], models, refs), []);
});
