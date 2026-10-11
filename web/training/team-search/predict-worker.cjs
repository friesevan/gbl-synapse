'use strict';
const { parentPort } = require('node:worker_threads');
const { Network, preparePredictor } = require('./interaction.cjs');
parentPort.on('message', ([request]) => {
  try {
    const models = request.models.map(Network.fromJSON);
    const predict = preparePredictor(models, request.references);
    const result = [];
    for (let i = request.start; i < request.end; i++) {
      const x = new Float64Array(request.buffer, i * request.input * 8, request.input);
      result.push(predict(x));
    }
    parentPort.postMessage({ result, heapBytes: process.memoryUsage().heapUsed });
  } catch (error) { parentPort.postMessage({ error: error.stack }); }
});
