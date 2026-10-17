'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const H = require('./compare-history.cjs'), { random } = require('../utils.cjs');

// Synthetic history: one row per round, cumulative battles and teams, proposal scores for four sources, held-out MSE.
function history({ rounds = 120, battlesPerRound = 1000, teamsPerRound = 20, neural = .6, random: randomMean = .35, gain = .7, best = .75, noise = .03, seed = 1, drift = 0 } = {}) {
 const r = random(seed), jitter = () => (r() - .5) * 2 * noise;
 return Array.from({ length: rounds }, (_, i) => {
  const constant = .02, neuralMSE = constant * (1 - (gain + jitter() * .2));
  return { round: i + 1, battles: (i + 1) * battlesPerRound, teams: (i + 1) * teamsPerRound, bestTraining: best + jitter() * .1, elapsedSeconds: (i + 1) * 10,
   proposalScores: [{ source: 'neural', teams: 11, meanScore: neural + drift * i / rounds + jitter() }, { source: 'uncertainty', teams: 6, meanScore: .5 + jitter() }, { source: 'random', teams: 6, meanScore: randomMean + jitter() }, { source: 'retest', teams: 1, meanScore: .7 }],
   diagnostics: { neuralMSE, constantMSE: constant } };
 });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-history-'));
const verdicts = result => result.final.byCriterion;

test('identical histories show no difference on any criterion', () => {
 const a = history(), r = H.compareHistories(a, a.map(row => ({ ...row })), { labels: ['old', 'new'] });
 assert.equal(r.final.overall, 'no difference');
 assert.deepEqual(Object.values(verdicts(r)), ['no difference', 'no difference', 'no difference', 'no difference', 'no difference']);
 for (const t of r.table) for (const c of t.criteria) assert.ok(c.delta === 0 && (c.z === 0 || c.z === null));
 assert.equal(r.points, 4);assert.equal(r.shared, 120000);assert.deepEqual(r.table.map(t => t.budget), [30000, 60000, 90000, 120000]);
});

test('a clearly better candidate is an improvement and a clearly worse one a regression, by criterion', () => {
 const old = history({ seed: 1 }), better = history({ seed: 2, neural: .66, gain: .78, best: .8, teamsPerRound: 26 }), worse = history({ seed: 3, neural: .54, gain: .6, best: .7, teamsPerRound: 15 });
 const up = H.compareHistories(old, better), down = H.compareHistories(old, worse);
 assert.deepEqual(verdicts(up), { 'neural-proposal-quality': 'improvement', 'heldout-team-error': 'improvement', 'best-training-score': 'improvement', 'teams-labelled': 'improvement', 'battles-per-labelled-team': 'improvement' });
 assert.equal(up.final.overall, 'improvement');assert.deepEqual(up.final.tally, { improvement: 4, regression: 0, 'no difference': 0, undetermined: 0 });
 assert.deepEqual(verdicts(down), { 'neural-proposal-quality': 'regression', 'heldout-team-error': 'regression', 'best-training-score': 'regression', 'teams-labelled': 'regression', 'battles-per-labelled-team': 'regression' });
 assert.equal(down.final.overall, 'regression');
 const last = up.table.at(-1).criteria;assert.ok(last.find(c => c.id === 'neural-proposal-quality').z > 4);assert.ok(Math.abs(last.find(c => c.id === 'neural-proposal-quality').delta - .06) < .02);
 assert.ok(last.find(c => c.id === 'teams-labelled').relative > .29);
});

test('mixed results are called mixed; small differences inside the noise or under the effect floor are not differences', () => {
 const old = history({ seed: 1 }), mixed = history({ seed: 2, neural: .66, gain: .55 });
 const r = H.compareHistories(old, mixed);assert.equal(r.final.overall, 'mixed');assert.equal(verdicts(r)['neural-proposal-quality'], 'improvement');assert.equal(verdicts(r)['heldout-team-error'], 'regression');
 // A 0.4-point shift with a lot of round-to-round noise: not significant.
 const noisyA = history({ seed: 4, noise: .08 }), noisyB = history({ seed: 5, noise: .08, neural: .604 });assert.equal(verdicts(H.compareHistories(noisyA, noisyB))['neural-proposal-quality'], 'no difference');
 // Significant but tiny: a 0.6-point shift with almost no noise stays under the 1-point effect floor.
 const quietA = history({ seed: 6, noise: .002 }), quietB = history({ seed: 7, noise: .002, neural: .606 }), tiny = H.compareHistories(quietA, quietB).final, row = H.compareHistories(quietA, quietB).table.at(-1).criteria[0];
 assert.equal(tiny.byCriterion['neural-proposal-quality'], 'no difference');assert.ok(Math.abs(row.z) > 2);assert.match(row.reason, /effect floor/);
});

test('runs are matched at equal cumulative battles even when their rounds cost different amounts', () => {
 const a = history({ rounds: 100, battlesPerRound: 1000, neural: .6, seed: 1 }), b = history({ rounds: 300, battlesPerRound: 500, teamsPerRound: 10, neural: .6, seed: 2 });
 const r = H.compareHistories(a, b, { points: 2 });
 // B ends at 150,000 battles, A at 100,000: the shared range is 100,000.
 assert.equal(r.shared, 100000);assert.deepEqual(r.table.map(t => t.budget), [50000, 100000]);
 assert.deepEqual(r.table.map(t => [t.a.rounds, t.b.rounds]), [[50, 100], [100, 200]]);
 // Equal teams per battle (20 per 1000 vs 10 per 500): no difference in labelling cost.
 assert.equal(verdicts(r)['teams-labelled'], 'no difference');assert.equal(verdicts(r)['battles-per-labelled-team'], 'no difference');
 // --at is clamped to the shared range and de-duplicated.
 assert.deepEqual(H.compareHistories(a, b, { at: [20000, 100000, 900000] }).table.map(t => t.budget), [20000, 100000]);
 // Rounds that finished after the budget are not counted.
 const cut = H.metricsAt(a, 25500, {});assert.equal(cut.rounds, 25);assert.equal(cut.battles, 25000);
});

test('too little history is undetermined rather than guessed', () => {
 const short = history({ rounds: 6, seed: 1 }), other = history({ rounds: 6, seed: 2, neural: .7 });
 const r = H.compareHistories(short, other, { block: 5, window: 10 });
 assert.equal(verdicts(r)['neural-proposal-quality'], 'undetermined');assert.equal(verdicts(r)['heldout-team-error'], 'undetermined');
 // Count criteria still have a verdict; the tally excludes the derived criterion.
 assert.equal(r.final.tally.undetermined, 2);
 // A history without a neural proposal or diagnostics (an early or odd run) is undetermined, not an error.
 const bare = history({ rounds: 40 }).map(row => ({ round: row.round, battles: row.battles, teams: row.teams, bestTraining: row.bestTraining }));
 const r2 = H.compareHistories(bare, bare);assert.equal(verdicts(r2)['neural-proposal-quality'], 'undetermined');assert.equal(r2.final.overall, 'no difference');
 assert.throws(() => H.compareHistories(short, other, { window: 1 }), /window/);
});

test('block statistics use block means for the standard error and keep the newest rounds', () => {
 const s = H.blockStats([1, 1, 1, 1, 1, 3, 3, 3, 3, 3], 5);assert.equal(s.mean, 2);assert.equal(s.blocks, 2);assert.ok(Math.abs(s.se - 1) < 1e-12); // block means 1 and 3: sd sqrt(2), divided by sqrt(2 blocks)
 // A leading partial block is dropped, not the newest values.
 assert.equal(H.blockStats([9, 1, 1, 1, 1, 1, 3, 3, 3, 3, 3], 5).blocks, 2);
 assert.equal(H.blockStats([1, 2, 3], 5).se, null);assert.deepEqual(H.blockStats([], 5), { n: 0, mean: null, se: null, blocks: 0 });
});

test('history files are read strictly: missing, empty, malformed and shrinking battle counts are rejected', () => {
 const dir = tmp();
 try {
  assert.throws(() => H.readHistory(path.join(dir, 'nope')), /not found/);
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '');assert.throws(() => H.readHistory(dir), /Empty history/);
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"battles":1}\n{oops\n');assert.throws(() => H.readHistory(dir), /line 2 is not JSON/);
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"round":1}\n');assert.throws(() => H.readHistory(dir), /no battle count/);
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"battles":5}\n{"battles":3}\n');assert.throws(() => H.readHistory(dir), /must not decrease/);
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"battles":5}\n\n{"battles":8}\n');assert.deepEqual(H.readHistory(dir).map(r => r.battles), [5, 8]);
  assert.equal(H.readHistory(path.join(dir, 'history.jsonl')).length, 2);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the command line prints the matched tables and a verdict, and saves JSON', () => {
 const dir = tmp(), write = (name, rows) => { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, 'history.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return path.join(dir, name); };
 try {
  const a = write('old', history({ seed: 1 })), b = write('new', history({ seed: 2, neural: .66, gain: .78, best: .8, teamsPerRound: 26 })), json = path.join(dir, 'out.json');
  const run = spawnSync(process.execPath, [path.join(__dirname, 'compare-history.cjs'), a, b, '--labels', 'old,new', '--points', '2', '--json', json], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);assert.match(run.stdout, /A = old \(reference\), B = new \(candidate\)/);assert.match(run.stdout, /Verdict at 120,000 battles: IMPROVEMENT/);assert.match(run.stdout, /rematch\.cjs/);
  const saved = JSON.parse(fs.readFileSync(json, 'utf8'));assert.equal(saved.format, 'pvp-team-history-comparison');assert.equal(saved.final.overall, 'improvement');assert.equal(saved.table.length, 2);
  const bad = spawnSync(process.execPath, [path.join(__dirname, 'compare-history.cjs'), a], { encoding: 'utf8' });assert.notEqual(bad.status, 0);assert.match(bad.stderr, /exactly two runs/);
  assert.throws(() => H.parseArgs(['--nonsense', '1']), /Unknown argument/);assert.equal(H.parseArgs(['x', 'y', '--window', '20']).opts.window, 20);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
