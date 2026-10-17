'use strict';
// Paired statistics for teams that played the same opponent fixtures (rematch.cjs).
// Every function resamples whole fixtures, so the correlation between teams that faced the same opponent is kept.
const { random } = require('../utils.cjs');

function checkRows(rows) {
 const n = rows[0]?.scores?.length;
 if (rows.length < 2 || !n) throw Error('Paired comparison needs at least two teams with scores');
 for (const row of rows) if (row.scores.length !== n || row.scores.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw Error('Paired comparison needs the same number of finite scores in [0, 1] for every team');
 return n;
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];

// Every pair (i < j): the observed mean difference, the unadjusted paired-bootstrap interval for that pair alone,
// and a simultaneous band that holds for all pairs at once.
//
// The simultaneous band is the max-t style bootstrap: the radius r is the 95th percentile, over bootstrap resamples, of
// the largest |resampled difference - observed difference| across all pairs. Then [delta - r, delta + r] covers every
// pair's true difference together with about 95% probability, so picking the best-looking pair afterwards does not
// manufacture a "significant" result. It is wider than the single-pair interval, and widens with the number of teams.
function pairwiseBands(rows, { seed = 1, samples = 5000, level = .95 } = {}) {
 const n = checkRows(rows);
 if (!Number.isInteger(samples) || samples < 100) throw Error('Bootstrap requires at least 100 samples');
 const k = rows.length, pairs = [], means = rows.map(r => mean(r.scores));
 for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) pairs.push({ a: i, b: j, delta: means[i] - means[j] });
 const r = random(seed), sums = new Float64Array(k), single = pairs.map(() => new Float64Array(samples)), worst = new Float64Array(samples);
 for (let s = 0; s < samples; s++) {
  sums.fill(0);
  for (let f = 0; f < n; f++) { const index = Math.floor(r() * n); for (let t = 0; t < k; t++) sums[t] += rows[t].scores[index]; }
  let max = 0;
  pairs.forEach((p, q) => { const d = (sums[p.a] - sums[p.b]) / n; single[q][s] = d; const dev = Math.abs(d - p.delta); if (dev > max) max = dev; });
  worst[s] = max;
 }
 const radius = n > 1 ? quantile(Array.from(worst).sort((x, y) => x - y), level) : 2, tail = (1 - level) / 2;
 return {
  fixtures: n, teams: k, level, samples, radius, method: 'paired opponent-fixture bootstrap; simultaneous band over all ' + pairs.length + ' pairs',
  pairs: pairs.map((p, q) => {
   const sorted = Array.from(single[q]).sort((x, y) => x - y), interval = n > 1 ? [quantile(sorted, tail), quantile(sorted, 1 - tail)] : [-1, 1];
   const simultaneous = [Math.max(-1, p.delta - radius), Math.min(1, p.delta + radius)];
   return { a: rows[p.a].id, b: rows[p.b].id, delta: p.delta, interval95: interval, simultaneous95: simultaneous, verdict: simultaneous[0] > 0 ? 'a-better' : simultaneous[1] < 0 ? 'b-better' : 'unresolved', alone: interval[0] > 0 ? 'a-better' : interval[1] < 0 ? 'b-better' : 'unresolved' };
  }),
 };
}

// The usual 'how big a difference can this panel resolve' number: the half-width of a 95% band for the mean of n
// fixtures whose paired differences have standard deviation sd (normal approximation).
const resolvable = (sd, n, z = 1.96) => z * sd / Math.sqrt(n);

module.exports = { pairwiseBands, resolvable };
