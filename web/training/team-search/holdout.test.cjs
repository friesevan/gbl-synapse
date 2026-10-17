'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./holdout.cjs'), { teamKey } = require('./common.cjs');

const SPECIES = ['azumarill', 'bastiodon', 'corviknight', 'dewgong', 'empoleon', 'furret', 'gliscor', 'hypno', 'iron', 'jellicent', 'kingler', 'lanturn', 'medicham', 'noctowl', 'obstagoon', 'registeel'];
// A grid of fixtures: every candidate meets every opponent once, with the bench of both sides in both orders.
function grid(candidates = 40, opponents = 16) {
  const rows = [];
  for (let c = 0; c < candidates; c++) for (let o = 0; o < opponents; o++) {
    const lead = SPECIES[o % SPECIES.length], bench = [SPECIES[(o + 3) % SPECIES.length], SPECIES[(o + 7) % SPECIES.length]];
    rows.push({ team: [c, c + 100, c + 200], opponent: [lead, ...(c % 2 ? bench : bench.slice().reverse())], score: ((c * 7 + o * 3) % 3) / 2 });
    rows.push({ team: [c, c + 200, c + 100], opponent: [lead, ...bench], score: 0.5 });
  }
  return rows;
}

test('an opponent identity is its lead plus its sorted bench', () => {
  assert.equal(H.opponentKey(['a', 'c', 'b']), H.opponentKey(['a', 'b', 'c']));
  assert.notEqual(H.opponentKey(['a', 'b', 'c']), H.opponentKey(['b', 'a', 'c']), 'a different lead is a different opponent');
  assert.equal(H.opponentKey(['a', 'c', 'b']), 'a,b,c');
  assert.throws(() => H.opponentKey([]), /at least one member/);
});

test('candidate holdout keeps every lead/bench-equivalent candidate in one partition', () => {
  const rows = grid();
  for (let fold = 0; fold < 5; fold++) {
    const { training, test: heldout, dropped } = H.split(rows, { grouping: 'candidate', fold });
    assert.equal(dropped, 0);assert.equal(training.length + heldout.length, rows.length);assert.ok(training.length && heldout.length);
    const trainKeys = new Set(training.map(r => teamKey(r.team))), testKeys = new Set(heldout.map(r => teamKey(r.team)));
    for (const k of trainKeys) assert.equal(testKeys.has(k), false);
  }
});

test('opponent holdout keeps every opponent identity in one partition and leaves candidates in both', () => {
  const rows = grid();
  for (let fold = 0; fold < 5; fold++) {
    const { training, test: heldout, dropped } = H.split(rows, { grouping: 'opponent', fold });
    assert.equal(dropped, 0);assert.equal(training.length + heldout.length, rows.length);
    const trainOpp = new Set(training.map(r => H.opponentKey(r.opponent))), testOpp = new Set(heldout.map(r => H.opponentKey(r.opponent)));
    for (const k of trainOpp) assert.equal(testOpp.has(k), false, 'opponent ' + k + ' is in both partitions');
    if (heldout.length) {
      // Candidates are not grouped: they appear on both sides.
      const trainTeams = new Set(training.map(r => teamKey(r.team)));
      assert.ok(heldout.some(r => trainTeams.has(teamKey(r.team))));
    }
  }
  // A bench in the other order is the same opponent.
  const a = { team: [1, 2, 3], opponent: ['x', 'p', 'q'], score: 0 }, b = { team: [1, 2, 3], opponent: ['x', 'q', 'p'], score: 1 };
  for (let fold = 0; fold < 5; fold++) { const s = H.split([a, b], { grouping: 'opponent', fold }); assert.ok(s.training.length === 2 || s.test.length === 2); }
});

test('block holdout fits on fixtures where neither side is held out, scores where both are, and drops the mixed ones', () => {
  const rows = grid(80, 16);
  let scored = 0;
  for (let fold = 0; fold < 5; fold++) {
    const block = H.split(rows, { grouping: 'block', fold }), cand = H.split(rows, { grouping: 'candidate', fold }), opp = H.split(rows, { grouping: 'opponent', fold });
    assert.equal(block.training.length + block.test.length + block.dropped, rows.length);
    const heldCand = new Set(cand.test.map(r => teamKey(r.team))), heldOpp = new Set(opp.test.map(r => H.opponentKey(r.opponent)));
    for (const r of block.test) { assert.ok(heldCand.has(teamKey(r.team))); assert.ok(heldOpp.has(H.opponentKey(r.opponent))); }
    for (const r of block.training) { assert.equal(heldCand.has(teamKey(r.team)), false); assert.equal(heldOpp.has(H.opponentKey(r.opponent)), false); }
    // No identity of either kind is on both sides.
    const trainCand = new Set(block.training.map(r => teamKey(r.team))), trainOpp = new Set(block.training.map(r => H.opponentKey(r.opponent)));
    for (const r of block.test) { assert.equal(trainCand.has(teamKey(r.team)), false); assert.equal(trainOpp.has(H.opponentKey(r.opponent)), false); }
    assert.equal(block.test.length, rows.filter(r => heldCand.has(teamKey(r.team)) && heldOpp.has(H.opponentKey(r.opponent))).length);
    assert.ok(block.training.length < cand.training.length && block.training.length < opp.training.length, 'the block design fits on less data');
    scored += block.test.length;
  }
  assert.ok(scored > 0);
});

test('every identity is held out in exactly one of the five folds, for both kinds', () => {
  const rows = grid(60, 16), foldOf = (grouping, key) => { const f = []; for (let fold = 0; fold < 5; fold++) if (H.split(rows, { grouping, fold }).test.some(r => (grouping === 'candidate' ? teamKey(r.team) : H.opponentKey(r.opponent)) === key)) f.push(fold); return f; };
  for (const [grouping, key] of [['candidate', teamKey(rows[0].team)], ['candidate', teamKey(rows[100].team)], ['opponent', H.opponentKey(rows[0].opponent)], ['opponent', H.opponentKey(rows[3].opponent)]]) assert.equal(foldOf(grouping, key).length, 1, grouping + ' ' + key);
});

test('invalid groupings and folds are rejected', () => {
  assert.throws(() => H.split([], { grouping: 'both' }), /grouping must be/);
  for (const fold of [-1, 5, 1.5, NaN]) assert.throws(() => H.split([], { fold }), /fold must be/);
  assert.deepEqual(H.split([], {}), { training: [], test: [], dropped: 0 });
  assert.deepEqual(H.groupCounts(grid(4, 3)), { candidates: 4, opponents: 3 });
});

// Fixture rows for evaluate(): members are the ensemble's per-member probabilities.
const row = (key, y, ...members) => ({ key, y, members });

test('evaluation computes fixture and team metrics, the constant baseline and the noise floor', () => {
  const rows = [row('A', 1, 0.8, 0.6), row('A', 0, 0.4, 0.2), row('A', 1, 0.7, 0.9), row('B', 0, 0.2, 0.4), row('B', 0.5, 0.5, 0.5)];
  const reference = new Map([['A', { mean: 0.6, uncertainty: 0.05 }], ['B', { mean: 0.3, uncertainty: 0.02 }]]);
  const r = H.evaluate({ rows, reference, constant: 0.5, minTeamFixtures: 1 });
  const p = [0.7, 0.3, 0.8, 0.3, 0.5], y = [1, 0, 1, 0, 0.5];
  const pairMSE = p.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / 5, constantPairMSE = y.reduce((s, v) => s + (0.5 - v) ** 2, 0) / 5;
  assert.ok(Math.abs(r.pairMSE - pairMSE) < 1e-12);assert.ok(Math.abs(r.constantPairMSE - constantPairMSE) < 1e-12);
  const logLoss = -(Math.log(0.7) + Math.log(0.7) + Math.log(0.8) + Math.log(0.7) + (0.5 * Math.log(0.5) + 0.5 * Math.log(0.5))) / 5;
  assert.ok(Math.abs(r.logLoss - logLoss) < 1e-12);
  assert.ok(Math.abs(r.constantLogLoss - Math.log(2)) < 1e-12, 'the constant 0.5 costs ln 2 per fixture whatever the label');
  // Members differ by 0.1, 0.1, 0.1, 0.1, 0: the fixture SD is half the difference.
  assert.ok(Math.abs(r.meanFixtureSD - (0.1 + 0.1 + 0.1 + 0.1 + 0) / 5) < 1e-12);
  // Team A: observed mean 2/3, conditional mean (0.7+0.3+0.8)/3 = 0.6; team B: observed 0.25, conditional 0.4, reference 0.3.
  assert.equal(r.teams, 2);
  assert.ok(Math.abs(r.teamMSE - (((0.6 - 2 / 3) ** 2 + (0.3 - 0.25) ** 2) / 2)) < 1e-12);
  assert.ok(Math.abs(r.conditionalTeamMSE - (((0.6 - 2 / 3) ** 2 + (0.4 - 0.25) ** 2) / 2)) < 1e-12);
  assert.ok(Math.abs(r.constantTeamMSE - (((0.5 - 2 / 3) ** 2 + (0.5 - 0.25) ** 2) / 2)) < 1e-12);
  // Noise floor: sample variance / n for each team. A: scores 1,0,1 -> var 1/3, /3 = 1/9. B: 0,0.5 -> var 0.125, /2 = 0.0625.
  assert.ok(Math.abs(r.noiseFloorTeamMSE - (1 / 9 + 0.0625) / 2) < 1e-12);
  assert.equal(r.noiseTeams, 2);
  assert.ok(Math.abs(r.meanEnsembleSD - 0.035) < 1e-12);
  // Conditional spread: member means for A are (0.8+0.4+0.7)/3 and (0.6+0.2+0.9)/3, for B (0.2+0.5)/2 and (0.4+0.5)/2.
  const sdA = Math.abs((0.8 + 0.4 + 0.7) / 3 - (0.6 + 0.2 + 0.9) / 3) / 2, sdB = Math.abs((0.2 + 0.5) / 2 - (0.4 + 0.5) / 2) / 2;
  assert.ok(Math.abs(r.meanConditionalSD - (sdA + sdB) / 2) < 1e-12);
  assert.equal(r.rankCorrelation, 1, 'A has the higher estimate and the higher observed mean');
  assert.equal(r.conditionalRankCorrelation, 1);
  assert.equal(r.calibration, null, 'two teams are too few for a calibration read-out');
});

test('teams with too few held-out fixtures are left out of the team metrics but not the fixture metrics', () => {
  const rows = [row('A', 1, 0.6), row('A', 0, 0.4), row('A', 1, 0.7), row('B', 1, 0.9)];
  const reference = new Map([['A', { mean: 0.6, uncertainty: 0.01 }], ['B', { mean: 0.9, uncertainty: 0.01 }]]);
  const all = H.evaluate({ rows, reference, constant: 0.5, minTeamFixtures: 1 }), few = H.evaluate({ rows, reference, constant: 0.5, minTeamFixtures: 3 });
  assert.equal(all.teams, 2);assert.equal(few.teams, 1);assert.equal(few.heldoutFixtures, 4);assert.equal(few.pairMSE, all.pairMSE);
  assert.equal(all.noiseTeams, 1, 'a single fixture has no sample variance');
  const none = H.evaluate({ rows, reference, constant: 0.5, minTeamFixtures: 9 });
  assert.equal(none.teams, 0);assert.equal(none.teamMSE, null);assert.equal(none.rankCorrelation, null);assert.equal(none.noiseFloorTeamMSE, null);
  assert.throws(() => H.evaluate({ rows: [], reference, constant: 0.5 }), /held-out fixtures/);
  assert.throws(() => H.evaluate({ rows: [row('Z', 1, 0.5)], reference, constant: 0.5 }), /Missing reference estimate/);
});

test('explained variance removes label noise: a model that predicts the true means perfectly explains about all of the signal', () => {
  const { random } = require('../utils.cjs'), r = random(11), truth = Array.from({ length: 300 }, () => 0.2 + 0.6 * r());
  const rows = [], reference = new Map();
  truth.forEach((p, i) => { reference.set('t' + i, { mean: p, uncertainty: 0.01 }); for (let f = 0; f < 16; f++) rows.push(row('t' + i, r() < p ? 1 : 0, p, p)); });
  const perfect = H.evaluate({ rows, reference, constant: 0.5 });
  assert.ok(perfect.teamMSE > 0.5 * perfect.noiseFloorTeamMSE, 'the raw error is mostly label noise: ' + perfect.teamMSE + ' vs ' + perfect.noiseFloorTeamMSE);
  assert.ok(Math.abs(perfect.teamMSE - perfect.noiseFloorTeamMSE) < 0.35 * perfect.noiseFloorTeamMSE);
  assert.ok(perfect.explainedVariance > 0.9 && perfect.explainedVariance < 1.1, 'explained ' + perfect.explainedVariance);
  // Predicting the constant explains none of it.
  const flat = new Map(truth.map((_, i) => ['t' + i, { mean: 0.5, uncertainty: 0.01 }]));
  const none = H.evaluate({ rows: rows.map(x => ({ ...x, members: [0.5, 0.5] })), reference: flat, constant: 0.5 });
  assert.ok(Math.abs(none.explainedVariance) < 1e-9 && Math.abs(none.conditionalExplainedVariance) < 1e-9);
  // The noise-aware calibration widens the spread by the label noise, so its multiplier is smaller than the plain one.
  assert.ok(perfect.noiseAwareCalibration.k90 < perfect.calibration.k90);
  assert.ok(perfect.noiseAwareCalibration.k90 > 1 && perfect.noiseAwareCalibration.k90 < 2.4, 'k90 ' + perfect.noiseAwareCalibration.k90);
});

test('summaries pair variants with the baseline on the same repeats and apply the noise rule', () => {
  const make = (variant, repeat, g, offset) => ({ grouping: g, variant, repeat, pairMSE: 0.17 + repeat * 0.001 + offset, logLoss: 0.5 + offset, teamMSE: 0.02 + repeat * 0.0005 + offset, conditionalTeamMSE: 0.02 + offset, rankCorrelation: 0.6 - offset, conditionalRankCorrelation: 0.6 - offset, meanEnsembleSD: 0.04, meanFixtureSD: 0.06 });
  const results = [];
  for (const g of ['candidate', 'opponent']) for (let repeat = 0; repeat < 3; repeat++) {
    results.push(make('base', repeat, g, 0), make('good', repeat, g, -0.01), make('same', repeat, g, repeat === 1 ? 0.0001 : -0.0001), make('bad', repeat, g, 0.01));
  }
  const summary = H.summarize(results), find = (g, v) => summary.find(e => e.grouping === g && e.variant === v);
  assert.equal(summary.length, 8);
  assert.equal(find('candidate', 'base').versusBaseline, null);
  const good = find('candidate', 'good').versusBaseline;
  assert.ok(Math.abs(good.teamMSE.meanImprovement - 0.01) < 1e-12);assert.ok(good.teamMSE.relativeImprovement > 0.3);assert.equal(good.teamMSE.clearsNoise, true);assert.equal(good.teamMSE.clearlyWorse, false);
  assert.ok(Math.abs(good.rankCorrelation.meanImprovement - 0.01) < 1e-12, 'a higher correlation counts as an improvement');
  const bad = find('opponent', 'bad').versusBaseline;
  assert.ok(bad.teamMSE.meanImprovement < 0);assert.equal(bad.teamMSE.clearsNoise, false);assert.equal(bad.teamMSE.clearlyWorse, true);assert.equal(bad.rankCorrelation.meanImprovement < 0, true);
  const same = find('opponent', 'same').versusBaseline;
  assert.equal(same.teamMSE.clearsNoise, false);assert.equal(same.teamMSE.clearlyWorse, false);
  assert.equal(find('candidate', 'base').metrics.pairMSE.values.length, 3);
  assert.ok(find('candidate', 'base').metrics.pairMSE.sd > 0);
  // Two repeats are not enough to claim anything.
  const two = H.summarize(results.filter(r => r.repeat < 2)), twoGood = two.find(e => e.variant === 'good' && e.grouping === 'candidate').versusBaseline;
  assert.equal(twoGood.teamMSE.clearsNoise, false);
  // A missing baseline leaves the comparison empty rather than failing.
  assert.equal(H.summarize(results.filter(r => r.variant !== 'base')).every(e => e.versusBaseline === null), true);
});
