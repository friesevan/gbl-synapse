#!/usr/bin/env node
'use strict';
const E = require('./evidence.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { fixtures, teamKey, validTeam, atomic } = require('./common.cjs');

// Finished pilot tests can become training evidence for a NEW experiment.
// Its final test must use a fresh seed; never fit on a current experiment's test.
function absorb(state, pool) {
  if (state.config.poolHash !== pool.hash) throw Error('Checkpoint/pool mismatch');
  const factor = E.factor(state);
  const rows = [...(state.screenResults || []), ...(state.validations || []), ...(state.baselineResults || [])];
  if (!rows.length) throw Error('No completed evaluation fixtures to absorb');
  if (state.runtime?.phase && !['finished', 'stopped', 'failed'].includes(state.runtime.phase)) {
    throw Error('Use a finished or stopped experiment snapshot');
  }
  const output = structuredClone(state);
  const key = o => [E.identity(state,o.team), E.identity(state,o.opponent), o.seed].join('|');
  const observations = new Map(output.observations.map(o => [key(o), o]));
  const seeds = new Set(state.evaluationEvidence?.fixtureSeeds || []);
  let added = 0, duplicates = 0;
  for (const row of rows) {
    if (!validTeam(row.team, pool.variants) || !row.pairs?.length || row.games !== row.pairs.length * factor ||
        !Number.isInteger(row.fixtureSeed) || row.pairs.some(y => !Number.isFinite(y) || y < 0 || y > 1)) {
      throw Error('Invalid completed evaluation row');
    }
    seeds.add(row.fixtureSeed);
    const panel = E.modern(state) ? state.fixturePanels?.[row.fixtureSeed] : fixtures(pool.species, row.pairs.length, row.fixtureSeed);
    if(!panel || panel.length < row.pairs.length) throw Error('Modern evaluation requires the original sealed fixture panel');
    const cases = panel.slice(0,row.pairs.length);
    cases.forEach((c, i) => {
      const o = { team: row.team, opponent: c.team.map(p => p.speciesId), score: row.pairs[i],
        seed: c.seed, round: state.round, source: 'earlier-pilot-' + row.kind };
      const existing = observations.get(key(o));
      if (existing) {
        if (existing.score !== o.score) throw Error('Conflicting evaluation fixture');
        duplicates++;
      } else { observations.set(key(o), o); added++; }
    });
  }
  output.observations = [...observations.values()];
  const records = new Map();
  for (const o of output.observations) {
    const k = E.identity(state,o.team), r = records.get(k) || { team: o.team, reward: 0, games: 0 };
    r.reward += o.score * factor; r.games += factor; records.set(k, r);
  }
  output.records = [...records.values()];
  output.battles = output.observations.length * factor;
  output.models = []; output.pending = null; output.history = []; output.runtime = null;
  output.validations = []; output.screenResults = []; output.finalistTeams = [];
  output.baselineResults = []; output.comparisons = {};
  output.evaluationEvidence = { fixtureSeeds: [...seeds], addedFixtures: added, duplicates,
    requiresFreshValidationSeed: true, note: 'Earlier pilot evaluation is now training data; use a new final test.' };
  return output;
}
if (require.main === module) {
  const [checkpoint, poolFile, out] = process.argv.slice(2);
  if (!out || path.resolve(checkpoint) === path.resolve(out)) throw Error('Pass CHECKPOINT POOL NEW_OUTPUT');
  const result = absorb(JSON.parse(fs.readFileSync(checkpoint)), JSON.parse(fs.readFileSync(poolFile)));
  atomic(out, result); console.log(JSON.stringify(result.evaluationEvidence));
}
module.exports = { absorb };
