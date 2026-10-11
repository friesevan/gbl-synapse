'use strict';
const path = require('node:path');
const { BattlePool } = require('../pool.cjs');
const { BattleRunner } = require('../runner.cjs');
const { preparePredictor } = require('./interaction.cjs');

async function predictParallel(inputs, models, references, { workers = 12 } = {}) {
  if (!inputs.length) return [];
  if (!Number.isInteger(workers) || workers < 1 || !models.length) throw Error('Invalid inference configuration');
  if (workers === 1) return inputs.map(preparePredictor(models, references));
  const input = models[0].input;
  const matrix = new Float64Array(new SharedArrayBuffer(inputs.length * input * 8));
  inputs.forEach((x, i) => {
    if (x.length !== input) throw Error('Wrong-dimensional inference features');
    matrix.set(x, i * input);
  });
  const size = Math.min(workers, inputs.length);
  const serialized = models.map(n => n.toJSON());
  const jobs = Array.from({ length: size }, (_, i) => [{
    buffer: matrix.buffer, input, models: serialized, references,
    start: Math.floor(i * inputs.length / size), end: Math.floor((i + 1) * inputs.length / size)
  }]);
  const pool = new BattlePool(size, () => new BattleRunner({ workerFile: path.join(__dirname, 'predict-worker.cjs') }));
  try { return (await pool.map(jobs)).flat(); }
  finally { await pool.close(); }
}
module.exports = { predictParallel };
