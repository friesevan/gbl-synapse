'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ranks, spearman, ratio, coverageMultiplier, uncertaintyCalibration, calibrationSummary } = require('./calibration.cjs');
const { random } = require('../utils.cjs');

test('rank correlation handles ties, reversals and undefined constant rankings', () => {
  assert.deepEqual(ranks([5, 1, 1, 9]), [2, 0.5, 0.5, 3]);
  assert.equal(spearman([1, 2, 2, 4], [1, 3, 3, 8]), 1);
  assert.equal(spearman([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
  assert.equal(spearman([1], [2]), null);
  assert.throws(() => spearman([1, 2], [1]), /equal length/);
  // Monotone but nonlinear is still a perfect rank correlation.
  assert.equal(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 1000]), 1);
});

test('the coverage multiplier is the smallest k covering at least the requested share', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => (i + 1) / 10); // 0.1 ... 10
  assert.equal(coverageMultiplier(sorted, 0.8), 8);
  assert.equal(coverageMultiplier(sorted, 0.9), 9);
  assert.equal(coverageMultiplier(sorted, 1), 10);
  assert.equal(coverageMultiplier([1, 2, 3, 4, 5], 0.8), 4);
  assert.equal(coverageMultiplier([1, 2, 3, 4, 5], 0.81), 5);
  assert.equal(coverageMultiplier([], 0.8), null);
  assert.equal(coverageMultiplier([1, 2, Infinity], 0.9), null, 'an infinite multiplier is reported as null');
  assert.equal(ratio(0.2, 0.1), 2);
  assert.equal(ratio(0, 0), 0);
  assert.equal(ratio(0.1, 0), Infinity);
});

test('k80, k90, coverage and the rank correlation are exact on a constructed example', () => {
  // 100 teams, constant spread 0.01, absolute residuals 0.001 ... 0.1 (ratios 0.1 ... 10).
  const rows = Array.from({ length: 100 }, (_, i) => ({ key: 't' + String(i).padStart(3, '0'), predicted: 0.5, spread: 0.01, observed: 0.5 + (i % 2 ? 1 : -1) * (i + 1) / 1000, fixtures: 8 }));
  const c = uncertaintyCalibration(rows);
  assert.equal(c.teams, 100);
  assert.ok(Math.abs(c.k80 - 8) < 1e-9 && Math.abs(c.k90 - 9) < 1e-9, 'k80 ' + c.k80 + ' k90 ' + c.k90);
  assert.ok(c.coverage1 === 0.1 || c.coverage1 === 0.09, 'ten teams sit at about one spread (floating-point rounding decides the tenth): ' + c.coverage1);
  assert.equal(c.spearman, null, 'a constant spread cannot rank anything');
  assert.ok(Math.abs(c.medianSpread - 0.01) < 1e-12 && Math.abs(c.medianAbsResidual - 0.0505) < 1e-12);
  // Cross-fitting: the multiplier from one half applied to the other half stays near the nominal share.
  assert.ok(c.coverage80 >= 0.75 && c.coverage80 <= 0.85, 'coverage80 ' + c.coverage80);
  assert.ok(c.coverage90 >= 0.85 && c.coverage90 <= 0.95, 'coverage90 ' + c.coverage90);
  // Spread proportional to the residual ranks it perfectly; spread inversely related ranks it perfectly the other way.
  const same = rows.map(r => ({ ...r, spread: Math.abs(r.observed - r.predicted) * 2 })), opposite = rows.map(r => ({ ...r, spread: 1 / Math.abs(r.observed - r.predicted) }));
  assert.equal(uncertaintyCalibration(same).spearman, 1);
  assert.equal(uncertaintyCalibration(opposite).spearman, -1);
  assert.ok(Math.abs(uncertaintyCalibration(same).k80 - 0.5) < 1e-9, 'every team sits at exactly half a spread');
  assert.equal(uncertaintyCalibration(same).coverage1, 1);
});

test('too few teams, non-finite rows and zero spread are handled without NaN', () => {
  const row = (i, spread = 0.02) => ({ key: 'k' + i, predicted: 0.5, spread, observed: 0.5 + (i + 1) / 100 });
  assert.equal(uncertaintyCalibration(Array.from({ length: 9 }, (_, i) => row(i))), null);
  assert.equal(uncertaintyCalibration(Array.from({ length: 9 }, (_, i) => row(i)), { minTeams: 5 }).teams, 9);
  const dirty = [...Array.from({ length: 12 }, (_, i) => row(i)), { key: 'x', predicted: NaN, spread: 0.1, observed: 0.5 }, { key: 'y', predicted: 0.5, spread: -1, observed: 0.5 }, { key: 'z', predicted: 0.5, spread: 0.1, observed: undefined }];
  assert.equal(uncertaintyCalibration(dirty).teams, 12, 'rows with a non-finite or negative value are dropped');
  // A team whose members all agree (spread 0) but whose prediction misses makes the multiplier infinite: reported as null, not Infinity or NaN.
  const flat = Array.from({ length: 12 }, (_, i) => row(i, i < 3 ? 0 : 0.02));
  const c = uncertaintyCalibration(flat);
  assert.equal(c.k90, null);
  assert.equal(JSON.parse(JSON.stringify(c)).k90, null);
  for (const value of Object.values(c)) assert.ok(value === null || Number.isFinite(value));
  // Fewer than 20 teams cannot be cross-fitted.
  assert.equal(uncertaintyCalibration(Array.from({ length: 15 }, (_, i) => row(i))).coverage80, null);
});

test('a Gaussian error with the stated spread gives k80 near 1.28, k90 near 1.64 and calibrated coverage', () => {
  const r = random(7), gaussian = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const rows = Array.from({ length: 6000 }, (_, i) => { const spread = 0.01 + 0.04 * r(); return { key: 't' + i, predicted: 0.5, spread, observed: 0.5 + spread * gaussian(), fixtures: 64 }; });
  const c = calibrationSummary(rows);
  assert.ok(Math.abs(c.k80 - 1.2816) < 0.08, 'k80 ' + c.k80);
  assert.ok(Math.abs(c.k90 - 1.6449) < 0.1, 'k90 ' + c.k90);
  assert.ok(Math.abs(c.coverage80 - 0.8) < 0.03 && Math.abs(c.coverage90 - 0.9) < 0.03);
  assert.ok(Math.abs(c.coverage1 - 0.6827) < 0.03, 'coverage1 ' + c.coverage1);
  assert.ok(c.spearman > 0.2, 'a larger spread goes with a larger residual: ' + c.spearman);
  assert.equal(c.wellMeasured.minFixtures, 64);
  assert.equal(c.wellMeasured.teams, 6000);
});

test('the well-measured read-out keeps only teams with enough fixtures and is null when too few remain', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ key: 'k' + i, predicted: 0.5, spread: 0.02, observed: 0.5 + (i % 2 ? 1 : -1) * (i + 1) / 200, fixtures: i < 25 ? 8 : 64 }));
  const c = calibrationSummary(rows);
  assert.equal(c.teams, 40);
  assert.equal(c.wellMeasured.teams, 15);
  assert.ok(c.wellMeasured.medianAbsResidual > c.medianAbsResidual, 'the 64-fixture teams are the later, larger residuals');
  assert.equal(calibrationSummary(rows, { minFixtures: 100 }).wellMeasured, null);
  assert.equal(calibrationSummary(rows.slice(0, 5)), null);
  // The caller's rows are not modified.
  assert.equal(rows[0].predicted, 0.5);
});

test('calibration is independent of the order the teams arrive in', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ key: 'k' + String(i).padStart(2, '0'), predicted: 0.4, spread: 0.01 + (i % 7) / 100, observed: 0.4 + ((i * 37) % 23 - 11) / 100 }));
  const a = uncertaintyCalibration(rows), b = uncertaintyCalibration(rows.slice().reverse());
  assert.deepEqual(a, b);
});
