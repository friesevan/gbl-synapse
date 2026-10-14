'use strict';
// Does the ensemble's spread say anything about its error? Pure statistics, no I/O.
//
// A "row" is one held-out team: the ensemble's team-mean prediction, its spread (the ensemble standard
// deviation of that prediction) and the observed mean score. Two read-outs relate spread to error:
//  - k_q: the smallest scalar k with |observed - predicted| <= k * spread for a share q of the teams.
//    A calibrated Gaussian spread would give k80 = 1.28 and k90 = 1.64; a much larger k says the spread
//    understates the error by that factor.
//  - Spearman correlation of spread with the absolute residual: whether a larger spread ranks the
//    teams whose predictions miss by more, whatever the scale.
// The residual includes the sampling noise of the observed mean (a team with 8 fixtures has a standard
// error near 0.16), so a k far above 1 is expected even for a perfect model. `wellMeasured` repeats the
// read-out for the teams with many fixtures, where that noise is smaller.
function ranks(values) {
  const order = values.map((value, i) => ({ value, i })).sort((a, b) => a.value - b.value), result = new Array(values.length);
  for (let start = 0; start < order.length;) {
    let end = start + 1;
    while (end < order.length && order[end].value === order[start].value) end++;
    for (let i = start; i < end; i++) result[order[i].i] = (start + end - 1) / 2;
    start = end;
  }
  return result;
}
// Spearman rank correlation with average ranks for ties; null when undefined (fewer than two values or a constant side).
function spearman(a, b) {
  if (a.length !== b.length) throw Error('Correlated series must have equal length');
  if (a.length < 2) return null;
  const aa = ranks(a), bb = ranks(b), am = aa.reduce((s, v) => s + v, 0) / aa.length, bm = bb.reduce((s, v) => s + v, 0) / bb.length;
  let dot = 0, av = 0, bv = 0;
  for (let i = 0; i < a.length; i++) { const x = aa[i] - am, y = bb[i] - bm; dot += x * y; av += x * x; bv += y * y; }
  return av * bv ? dot / Math.sqrt(av * bv) : null;
}
// |residual| / spread; a team whose members all agree (spread 0) is covered only by an exact prediction.
const ratio = (residual, spread) => spread > 0 ? residual / spread : residual <= 1e-12 ? 0 : Infinity;
// Smallest k covering at least a share q of the (ascending) ratios; null when that k is infinite.
function coverageMultiplier(sortedRatios, q) {
  if (!sortedRatios.length) return null;
  const k = sortedRatios[Math.min(sortedRatios.length, Math.max(1, Math.ceil(q * sortedRatios.length - 1e-9))) - 1];
  return Number.isFinite(k) ? k : null;
}
const share = (ratios, k) => ratios.filter(r => r <= k).length;
const median = values => { if (!values.length) return null; const s = values.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// rows: [{predicted, spread, observed, key?}]. Returns null below minTeams rows.
//  teams        number of held-out teams
//  k80, k90     smallest multiplier covering 80% / 90% of the teams (null if infinite)
//  coverage80/90  out-of-sample coverage of +-k * spread: k is estimated on one half of the teams (alternating
//               in key order) and applied to the other half, then the two halves are pooled. Near the nominal
//               share when the spread-to-error scale is stable across teams; null below 20 teams.
//  coverage1    share of teams inside +-1 * spread
//  spearman     Spearman correlation of spread with |residual| (null if undefined)
//  medianSpread, medianAbsResidual  the two scales being compared
function uncertaintyCalibration(rows, { minTeams = 10 } = {}) {
  const valid = rows.filter(r => Number.isFinite(r.predicted) && Number.isFinite(r.spread) && r.spread >= 0 && Number.isFinite(r.observed));
  if (valid.length < minTeams) return null;
  const items = valid.map((r, index) => ({ residual: Math.abs(r.observed - r.predicted), spread: r.spread, ratio: ratio(Math.abs(r.observed - r.predicted), r.spread), key: r.key === undefined ? null : String(r.key), index }));
  const sortedRatios = items.map(i => i.ratio).sort((a, b) => a - b);
  const k80 = coverageMultiplier(sortedRatios, .8), k90 = coverageMultiplier(sortedRatios, .9);
  // Out-of-sample coverage by two-fold cross-fitting.
  const ordered = items.slice().sort((a, b) => (a.key !== null && b.key !== null ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : 0) || a.index - b.index);
  const halves = [ordered.filter((_, i) => i % 2 === 0), ordered.filter((_, i) => i % 2 === 1)];
  const crossed = q => {
    if (items.length < 20) return null;
    const k = halves.map(h => coverageMultiplier(h.map(i => i.ratio).sort((a, b) => a - b), q));
    if (k.some(x => x === null)) return null;
    return (share(halves[1].map(i => i.ratio), k[0]) + share(halves[0].map(i => i.ratio), k[1])) / items.length;
  };
  return {
    teams: items.length, k80, k90, coverage80: crossed(.8), coverage90: crossed(.9), coverage1: share(sortedRatios, 1) / items.length,
    spearman: spearman(items.map(i => i.spread), items.map(i => i.residual)), medianSpread: median(items.map(i => i.spread)), medianAbsResidual: median(items.map(i => i.residual))
  };
}
// The all-teams read-out plus the same read-out for teams with at least `minFixtures` fixtures (row.fixtures).
function calibrationSummary(rows, { minFixtures = 64, minTeams = 10 } = {}) {
  const all = uncertaintyCalibration(rows, { minTeams });
  if (!all) return null;
  const well = uncertaintyCalibration(rows.filter(r => r.fixtures >= minFixtures), { minTeams });
  return { ...all, wellMeasured: well ? { minFixtures, ...well } : null };
}
module.exports = { ranks, spearman, ratio, coverageMultiplier, uncertaintyCalibration, calibrationSummary };
