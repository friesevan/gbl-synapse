'use strict';
// Grouped holdouts for the surrogate audit (audit-model.cjs). Read-only diagnostics on frozen data.
//
// A fixture is one candidate team playing one opponent team. Two identities group the fixtures:
//  - candidate identity: the canonical team key (lead + sorted bench of variant indices), as in the search;
//  - opponent identity: the canonical lead + sorted bench of the opponent's species ids.
// Three designs hold identities out by a stable hash (digest(key) mod 5 === fold):
//  - candidate: held-out candidates are never fitted; their opponents may have been seen. This is the
//    search's own diagnostic (held-out candidate identities).
//  - opponent:  held-out opponent teams are never fitted; every candidate may have been seen against other
//    opponents. It tests generalisation to unseen opponent compositions (new metas, new observed teams).
//  - block:     both at once. Fitting uses fixtures where neither side is held out; scoring uses only the
//    fixtures where both sides are held out; fixtures with exactly one side held out are dropped from both.
const { digest, teamKey } = require('./common.cjs');
const { spearman, calibrationSummary } = require('./calibration.cjs');

const GROUPINGS = ['candidate', 'opponent', 'block'];
const FOLDS = 5;
const opponentKey = ids => { if (!Array.isArray(ids) || !ids.length) throw Error('Opponent team needs at least one member'); return [ids[0], ...ids.slice(1).sort()].join(','); };
const inFold = (key, fold) => parseInt(digest(key).slice(0, 8), 16) % FOLDS === fold;
function split(rows, { grouping = 'candidate', fold = 0 } = {}) {
  if (!GROUPINGS.includes(grouping)) throw Error('grouping must be one of ' + GROUPINGS.join(', '));
  if (!Number.isInteger(fold) || fold < 0 || fold >= FOLDS) throw Error('fold must be 0–4');
  const candidate = row => inFold(teamKey(row.team), fold), opponent = row => inFold(opponentKey(row.opponent), fold);
  const training = [], test = [];
  let dropped = 0;
  for (const row of rows) {
    if (grouping === 'candidate') (candidate(row) ? test : training).push(row);
    else if (grouping === 'opponent') (opponent(row) ? test : training).push(row);
    else { const c = candidate(row), o = opponent(row); if (c && o) test.push(row); else if (!c && !o) training.push(row); else dropped++; }
  }
  return { training, test, dropped };
}
// Distinct identities of each kind among the rows, for the report.
function groupCounts(rows) {
  const candidates = new Set(), opponents = new Set();
  for (const row of rows) { candidates.add(teamKey(row.team)); opponents.add(opponentKey(row.opponent)); }
  return { candidates: candidates.size, opponents: opponents.size };
}

// Scores one frozen ensemble on held-out fixtures.
//  rows       [{key, y, members: [probability per ensemble member]}]; one per held-out fixture
//  reference  Map key -> {mean, uncertainty}: the search's team estimate (mean over a reference opponent panel)
//  constant   the constant predictor (mean training score)
//  minTeamFixtures  teams scored at team level need at least this many held-out fixtures
// Per-fixture numbers use every row. Team numbers use teams with enough fixtures:
//  teamMSE             reference estimate against the observed mean (the search's own diagnostic)
//  conditionalTeamMSE  the mean of the fixture predictions on the very opponents the team faced; the fair
//                      comparison when only some opponents are held out
//  constantTeamMSE     the constant predictor against the observed mean
//  noiseFloorTeamMSE   mean sampling variance of the observed means (sample variance / n): the part of the team MSE
//                      that no model could remove
// Calibration is the spread-versus-residual read-out (calibration.cjs) for both team estimates.
function evaluate({ rows, reference, constant, minTeamFixtures = 1 }) {
  if (!rows.length) throw Error('Need held-out fixtures');
  const members = rows[0].members.length, clamp = p => Math.min(1 - 1e-12, Math.max(1e-12, p));
  let pairMSE = 0, constantPairMSE = 0, logLoss = 0, constantLogLoss = 0, fixtureSD = 0;
  const teams = new Map();
  for (const row of rows) {
    const p = row.members.reduce((s, v) => s + v, 0) / members, sd = Math.sqrt(row.members.reduce((s, v) => s + (v - p) ** 2, 0) / members);
    pairMSE += (p - row.y) ** 2; constantPairMSE += (constant - row.y) ** 2; fixtureSD += sd;
    logLoss -= row.y * Math.log(clamp(p)) + (1 - row.y) * Math.log(clamp(1 - p));
    constantLogLoss -= row.y * Math.log(clamp(constant)) + (1 - row.y) * Math.log(clamp(1 - constant));
    let t = teams.get(row.key);
    if (!t) teams.set(row.key, t = { key: row.key, n: 0, sum: 0, sumSquares: 0, member: new Array(members).fill(0) });
    t.n++; t.sum += row.y; t.sumSquares += row.y * row.y; for (let m = 0; m < members; m++) t.member[m] += row.members[m];
  }
  const n = rows.length, scored = [...teams.values()].filter(t => t.n >= minTeamFixtures).map(t => {
    const observed = t.sum / t.n, memberMeans = t.member.map(v => v / t.n), conditional = memberMeans.reduce((s, v) => s + v, 0) / members;
    const ref = reference.get(t.key);
    if (!ref) throw Error('Missing reference estimate for ' + t.key);
    return { key: t.key, fixtures: t.n, observed, conditional, conditionalSpread: Math.sqrt(memberMeans.reduce((s, v) => s + (v - conditional) ** 2, 0) / members), reference: ref.mean, referenceSpread: ref.uncertainty, noise: t.n > 1 ? Math.max(0, (t.sumSquares - t.sum * t.sum / t.n) / (t.n - 1)) / t.n : null };
  });
  const mean = f => scored.length ? scored.reduce((s, t) => s + f(t), 0) / scored.length : null, noisy = scored.filter(t => t.noise !== null);
  // Removing each team's sampling variance from its squared error leaves the part a model could still reduce; the share of the between-team
  // variance of the true means (constant error minus noise) that the model explains is comparable across holdouts whose teams have different numbers of fixtures.
  const explained = f => { const constantSignal = noisy.reduce((s, t) => s + (constant - t.observed) ** 2 - t.noise, 0); return noisy.length && constantSignal > 0 ? 1 - noisy.reduce((s, t) => s + f(t) ** 2 - t.noise, 0) / constantSignal : null; };
  return {
    heldoutFixtures: n, pairMSE: pairMSE / n, constantPairMSE: constantPairMSE / n, logLoss: logLoss / n, constantLogLoss: constantLogLoss / n, meanFixtureSD: fixtureSD / n,
    teams: scored.length, minTeamFixtures,
    teamMSE: mean(t => (t.reference - t.observed) ** 2), conditionalTeamMSE: mean(t => (t.conditional - t.observed) ** 2), constantTeamMSE: mean(t => (constant - t.observed) ** 2),
    noiseFloorTeamMSE: noisy.length ? noisy.reduce((s, t) => s + t.noise, 0) / noisy.length : null, noiseTeams: noisy.length,
    explainedVariance: explained(t => t.reference - t.observed), conditionalExplainedVariance: explained(t => t.conditional - t.observed),
    rankCorrelation: spearman(scored.map(t => t.reference), scored.map(t => t.observed)), conditionalRankCorrelation: spearman(scored.map(t => t.conditional), scored.map(t => t.observed)),
    meanEnsembleSD: mean(t => t.referenceSpread), meanConditionalSD: mean(t => t.conditionalSpread),
    calibration: calibrationSummary(scored.map(t => ({ key: t.key, predicted: t.reference, spread: t.referenceSpread, observed: t.observed, fixtures: t.fixtures }))),
    conditionalCalibration: calibrationSummary(scored.map(t => ({ key: t.key, predicted: t.conditional, spread: t.conditionalSpread, observed: t.observed, fixtures: t.fixtures }))),
    // The same read-out when each team's sampling noise is added to its spread (in quadrature): does spread plus label noise account for the error?
    noiseAwareCalibration: calibrationSummary(noisy.map(t => ({ key: t.key, predicted: t.reference, spread: Math.sqrt(t.referenceSpread ** 2 + t.noise), observed: t.observed, fixtures: t.fixtures })))
  };
}

// Mean and sample standard deviation over repeats (null sd for a single repeat).
const mean = xs => xs.reduce((s, v) => s + v, 0) / xs.length;
const sd = xs => xs.length < 2 ? null : Math.sqrt(xs.reduce((s, v) => s + (v - mean(xs)) ** 2, 0) / (xs.length - 1));
// Metrics where larger is better; every other summarised metric is a loss.
const HIGHER_IS_BETTER = new Set(['rankCorrelation', 'conditionalRankCorrelation', 'explainedVariance', 'conditionalExplainedVariance']);
const COMPARED_METRICS = ['pairMSE', 'logLoss', 'teamMSE', 'conditionalTeamMSE', 'rankCorrelation', 'conditionalRankCorrelation', 'explainedVariance', 'conditionalExplainedVariance'];
const SUMMARY_METRICS = [...COMPARED_METRICS, 'explainedVariance', 'conditionalExplainedVariance', 'meanEnsembleSD', 'meanFixtureSD', 'constantPairMSE', 'constantLogLoss', 'constantTeamMSE', 'noiseFloorTeamMSE', 'teams', 'heldoutFixtures'];
// Per (grouping, variant): mean and sd over repeats; per grouping, each variant against the baseline variant on the same repeats
// (same sample, same seeds), with the paired differences. A variant "clears the noise" on a metric when every repeat favours it and the
// mean improvement exceeds both the sd of the paired differences and the baseline's own sd across repeats.
function summarize(results, { baseline = 'base', metrics = SUMMARY_METRICS, compared = COMPARED_METRICS } = {}) {
  const key = r => r.grouping + '\u0000' + r.variant, groups = new Map();
  for (const r of results) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const out = [];
  for (const [, rows] of groups) {
    rows.sort((a, b) => a.repeat - b.repeat);
    const entry = { grouping: rows[0].grouping, variant: rows[0].variant, repeats: rows.length, metrics: {}, versusBaseline: null };
    for (const m of metrics) { const values = rows.map(r => r[m]).filter(Number.isFinite); entry.metrics[m] = values.length ? { mean: mean(values), sd: sd(values), values } : null; }
    const base = (groups.get(rows[0].grouping + '\u0000' + baseline) || []).sort((a, b) => a.repeat - b.repeat);
    if (rows[0].variant !== baseline && base.length) {
      entry.versusBaseline = {};
      for (const m of compared) {
        const pairs = rows.map(r => ({ r, b: base.find(x => x.repeat === r.repeat) })).filter(p => p.b && Number.isFinite(p.r[m]) && Number.isFinite(p.b[m]));
        if (!pairs.length) continue;
        const sign = HIGHER_IS_BETTER.has(m) ? 1 : -1, improvement = pairs.map(p => sign * (p.r[m] - p.b[m])), baseValues = pairs.map(p => p.b[m]), baseSD = sd(baseValues), pairedSD = sd(improvement);
        const m1 = mean(improvement), consistent = improvement.every(x => x > 0), worse = improvement.every(x => x < 0);
        entry.versusBaseline[m] = { meanImprovement: m1, relativeImprovement: Math.abs(mean(baseValues)) > 0 ? m1 / Math.abs(mean(baseValues)) : null, pairedSD, baselineSD: baseSD, improvements: improvement, repeats: pairs.length,
          clearsNoise: pairs.length >= 3 && consistent && pairedSD !== null && baseSD !== null && m1 > Math.max(pairedSD, baseSD), clearlyWorse: pairs.length >= 3 && worse && pairedSD !== null && baseSD !== null && -m1 > Math.max(pairedSD, baseSD) };
      }
    }
    out.push(entry);
  }
  return out;
}
module.exports = { GROUPINGS, opponentKey, split, groupCounts, evaluate, summarize, mean, sd, HIGHER_IS_BETTER, SUMMARY_METRICS, COMPARED_METRICS };
