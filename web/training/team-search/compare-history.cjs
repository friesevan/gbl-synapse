#!/usr/bin/env node
'use strict';
// Compare two runs' history.jsonl at matched battle counts: did the search itself get better at the same cost?
//
//   node training/team-search/compare-history.cjs RUN_A RUN_B [--labels old,new] [--points 4] [--at 50000,100000]
//        [--window 40] [--block 5] [--json OUT.json]
//
// RUN_A is the reference (old) run, RUN_B the candidate (new). Every difference is B - A. A run is a directory
// containing history.jsonl, or the file itself. The comparison reads only the round summaries: it says whether the search
// proposed better teams, predicted held-out teams better, and labelled more teams per battle at equal cumulative battles.
// It does not say whether the final teams differ; the paired re-simulation in rematch.cjs does that.
const fs = require('node:fs'), path = require('node:path');

// Effect sizes below which a "significant" difference is still called no difference, and the criteria's direction.
const CRITERIA = [
 { id: 'neural-proposal-quality', title: 'Neural proposal quality (mean score of neural picks)', better: 'higher', min: .01, format: 'pct', test: 'z' },
 { id: 'heldout-team-error', title: 'Held-out team error vs constant (1 - MSE/constant)', better: 'higher', min: .02, format: 'pct', test: 'z' },
 { id: 'best-training-score', title: 'Best training score (selection-biased, indicative)', better: 'higher', min: .015, format: 'pct', test: 'threshold' },
 { id: 'teams-labelled', title: 'Teams labelled', better: 'higher', min: .10, format: 'count', test: 'relative' },
 { id: 'battles-per-labelled-team', title: 'Battles per labelled team (derived)', better: 'lower', min: .10, format: 'number', test: 'relative', derived: true },
];
const CONTEXT = [
 { id: 'neural-minus-random', title: 'Neural minus random proposals, same fixtures' },
 { id: 'random-proposal-quality', title: 'Random proposals (control)' },
 { id: 'uncertainty-proposal-quality', title: 'Uncertainty picks' },
];

function readHistory(source) {
 const file = fs.existsSync(source) && fs.statSync(source).isDirectory() ? path.join(source, 'history.jsonl') : source;
 if (!fs.existsSync(file)) throw Error('history.jsonl not found: ' + source);
 const rows = [];
 fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
  if (!line.trim()) return;
  let row; try { row = JSON.parse(line); } catch { throw Error(file + ' line ' + (i + 1) + ' is not JSON'); }
  if (!Number.isFinite(row.battles) || !(row.battles >= 0)) throw Error(file + ' line ' + (i + 1) + ' has no battle count');
  rows.push(row);
 });
 if (!rows.length) throw Error('Empty history: ' + file);
 for (let i = 1; i < rows.length; i++) if (rows[i].battles < rows[i - 1].battles) throw Error(file + ' battle counts must not decrease (line ' + (i + 1) + ')');
 return rows;
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

// Mean of a per-round series with a standard error from batch means: consecutive rounds are correlated (the model
// improves, opponents repeat), so the spread of block means, not of single rounds, is the honest noise. The newest
// rounds are kept when the window does not divide evenly.
function blockStats(values, block) {
 if (!values.length) return { n: 0, mean: null, se: null, blocks: 0 };
 const blocks = Math.floor(values.length / block), recent = values.slice(values.length - blocks * block), means = [];
 for (let b = 0; b < blocks; b++) means.push(mean(recent.slice(b * block, (b + 1) * block)));
 return { n: values.length, mean: mean(values), se: blocks >= 2 ? sd(means) / Math.sqrt(blocks) : null, blocks };
}

const source = (row, name) => row.proposalScores?.find(p => p.source === name && Number.isFinite(p.meanScore) && p.teams > 0);
// Per-round series restricted to rounds that finished by `budget` battles, newest `window` rounds only.
function series(rows, budget, window, pick) {
 const values = rows.filter(r => r.battles <= budget).map(pick).filter(Number.isFinite);
 return values.slice(Math.max(0, values.length - window));
}

function metricsAt(rows, budget, { window = 40, block = 5 } = {}) {
 const upTo = rows.filter(r => r.battles <= budget), last = upTo.at(-1) || null;
 const neural = blockStats(series(rows, budget, window, r => source(r, 'neural')?.meanScore), block);
 const random = blockStats(series(rows, budget, window, r => source(r, 'random')?.meanScore), block);
 const uncertainty = blockStats(series(rows, budget, window, r => source(r, 'uncertainty')?.meanScore), block);
 const gap = blockStats(series(rows, budget, window, r => source(r, 'neural') && source(r, 'random') ? source(r, 'neural').meanScore - source(r, 'random').meanScore : NaN), block);
 const gain = blockStats(series(rows, budget, window, r => r.diagnostics?.constantMSE > 0 && Number.isFinite(r.diagnostics?.neuralMSE) ? 1 - r.diagnostics.neuralMSE / r.diagnostics.constantMSE : NaN), block);
 const battles = last?.battles ?? null, teams = last?.teams ?? null;
 return {
  budget, rounds: upTo.length, battles, elapsedSeconds: last?.elapsedSeconds ?? null,
  'neural-proposal-quality': neural, 'heldout-team-error': gain, 'neural-minus-random': gap, 'random-proposal-quality': random, 'uncertainty-proposal-quality': uncertainty,
  'best-training-score': { n: upTo.length, mean: Number.isFinite(last?.bestTraining) ? last.bestTraining : null, se: null, blocks: 0 },
  'teams-labelled': { n: upTo.length, mean: teams, se: null, blocks: 0 },
  'battles-per-labelled-team': { n: upTo.length, mean: battles != null && teams > 0 ? battles / teams : null, se: null, blocks: 0 },
 };
}

function judge(criterion, a, b) {
 if (!Number.isFinite(a.mean) || !Number.isFinite(b.mean)) return { delta: null, z: null, verdict: 'undetermined', reason: 'missing in one run' };
 const delta = b.mean - a.mean, good = criterion.better === 'higher' ? delta : -delta;
 if (criterion.test === 'relative') {
  const rel = a.mean ? delta / a.mean : null, goodRel = criterion.better === 'higher' ? rel : -rel;
  return { delta, relative: rel, z: null, verdict: goodRel >= criterion.min ? 'improvement' : goodRel <= -criterion.min ? 'regression' : 'no difference', reason: 'relative change vs ' + Math.round(criterion.min * 100) + '% threshold' };
 }
 if (criterion.test === 'threshold') return { delta, z: null, verdict: good >= criterion.min ? 'improvement' : good <= -criterion.min ? 'regression' : 'no difference', reason: 'threshold only: this score is the maximum over many teams with unequal samples' };
 if (!(a.se > 0) && !(b.se > 0)) return { delta, z: null, verdict: 'undetermined', reason: 'fewer than two blocks of rounds in a run; need more history' };
 const se = Math.sqrt((a.se || 0) ** 2 + (b.se || 0) ** 2), z = delta / se;
 const verdict = Math.abs(z) < 2 || Math.abs(delta) < criterion.min ? 'no difference' : good > 0 ? 'improvement' : 'regression';
 return { delta, z, verdict, reason: Math.abs(z) >= 2 && Math.abs(delta) < criterion.min ? 'significant but under the ' + criterion.min * 100 + '-point effect floor' : 'z from block means over the recent window' };
}

// Evenly spaced matched budgets up to the smaller run, or the explicit --at values (clamped and de-duplicated).
function budgets(a, b, { points = 4, at = [] } = {}) {
 const shared = Math.min(a.at(-1).battles, b.at(-1).battles);
 if (!(shared > 0)) throw Error('One run has no battles');
 const list = at.length ? at.map(x => Math.min(x, shared)) : Array.from({ length: points }, (_, k) => Math.round(shared * (k + 1) / points));
 return { shared, list: [...new Set(list)].sort((x, y) => x - y) };
}

function compareHistories(a, b, { points = 4, at = [], window = 40, block = 5, labels = ['A', 'B'] } = {}) {
 if (!Number.isInteger(window) || window < 2 || !Number.isInteger(block) || block < 1 || block > window) throw Error('window must be at least 2 and block between 1 and the window');
 const { shared, list } = budgets(a, b, { points, at }), table = [];
 for (const budget of list) {
  const ma = metricsAt(a, budget, { window, block }), mb = metricsAt(b, budget, { window, block });
  table.push({ budget, a: { rounds: ma.rounds, battles: ma.battles }, b: { rounds: mb.rounds, battles: mb.battles }, criteria: CRITERIA.map(c => ({ id: c.id, title: c.title, derived: !!c.derived, a: ma[c.id].mean, b: mb[c.id].mean, seA: ma[c.id].se, seB: mb[c.id].se, ...judge(c, ma[c.id], mb[c.id]) })), context: CONTEXT.map(c => ({ id: c.id, title: c.title, a: ma[c.id].mean, b: mb[c.id].mean, delta: Number.isFinite(ma[c.id].mean) && Number.isFinite(mb[c.id].mean) ? mb[c.id].mean - ma[c.id].mean : null })) });
 }
 const final = table.at(-1), counted = final.criteria.filter(c => !c.derived), count = v => counted.filter(c => c.verdict === v).length;
 const tally = { improvement: count('improvement'), regression: count('regression'), 'no difference': count('no difference'), undetermined: count('undetermined') };
 const overall = tally.improvement && tally.regression ? 'mixed' : tally.improvement ? 'improvement' : tally.regression ? 'regression' : tally.undetermined === counted.length ? 'undetermined' : 'no difference';
 // Earlier matched budgets that point the other way make a verdict less trustworthy; say how many agree.
 const agreement = Object.fromEntries(CRITERIA.map(c => [c.id, table.filter(t => t.criteria.find(x => x.id === c.id).verdict === final.criteria.find(x => x.id === c.id).verdict).length + '/' + table.length]));
 return { labels, shared, window, block, points: table.length, table, final: { budget: final.budget, tally, overall, byCriterion: Object.fromEntries(final.criteria.map(c => [c.id, c.verdict])), agreement } };
}

const fmt = { pct: v => Number.isFinite(v) ? (100 * v).toFixed(1) + '%' : '—', count: v => Number.isFinite(v) ? String(Math.round(v)) : '—', number: v => Number.isFinite(v) ? v.toFixed(1) : '—' };
const fmtDelta = (format, d) => !Number.isFinite(d) ? '—' : format === 'pct' ? (d >= 0 ? '+' : '') + (100 * d).toFixed(1) + ' pp' : (d >= 0 ? '+' : '') + (format === 'count' ? Math.round(d) : d.toFixed(1));
function formatReport(result) {
 const [la, lb] = result.labels, lines = ['Matched-battle history comparison · A = ' + la + ' (reference), B = ' + lb + ' (candidate) · differences are B - A', 'Shared range: ' + result.shared.toLocaleString() + ' cumulative battles · window ' + result.window + ' rounds, block ' + result.block + ' rounds', ''];
 for (const t of result.table) {
  lines.push('At ' + t.budget.toLocaleString() + ' battles (A: ' + t.a.rounds + ' rounds, B: ' + t.b.rounds + ' rounds)');
  const rows = [['criterion', 'A', 'B', 'B - A', 'z', 'verdict']];
  for (const c of t.criteria) { const f = CRITERIA.find(x => x.id === c.id).format; rows.push([c.title, fmt[f](c.a), fmt[f](c.b), fmtDelta(f, c.delta), Number.isFinite(c.z) ? c.z.toFixed(1) : '', c.verdict]); }
  for (const c of t.context) rows.push([c.title + ' (context)', fmt.pct(c.a), fmt.pct(c.b), fmtDelta('pct', c.delta), '', '']);
  const w = rows[0].map((_, j) => Math.max(...rows.map(r => String(r[j]).length)));
  for (const r of rows) lines.push('  ' + r.map((v, j) => j === 0 ? String(v).padEnd(w[j]) : String(v).padStart(w[j])).join('  ').trimEnd());
  lines.push('');
 }
 const f = result.final;
 lines.push('Verdict at ' + f.budget.toLocaleString() + ' battles: ' + f.overall.toUpperCase() + ' (' + ['improvement', 'regression', 'no difference', 'undetermined'].filter(k => f.tally[k]).map(k => f.tally[k] + ' ' + k).join(', ') + ')');
 for (const c of CRITERIA) lines.push('  ' + c.title + ': ' + f.byCriterion[c.id] + (f.agreement[c.id].split('/')[0] === f.agreement[c.id].split('/')[1] ? '' : ' (same verdict at ' + f.agreement[c.id] + ' matched budgets)'));
 lines.push('', 'z uses within-run noise only (block means over the recent window); with one run per arm, seed-to-seed variation is not measured, so repeat with a second seed before claiming a gain that is not large.', 'This compares the search process at equal cost. It cannot say that one run\'s final teams are better: re-simulate them together with rematch.cjs.');
 return lines.join('\n');
}

function parseArgs(argv) {
 const opts = { labels: '', points: 4, at: '', window: 40, block: 5, json: '' }, runs = [];
 for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help') { opts.help = true; continue; }
  if (!a.startsWith('--')) { runs.push(a); continue; }
  const key = a.slice(2);
  if (!(key in opts) || argv[i + 1] === undefined) throw Error('Unknown argument ' + a);
  opts[key] = typeof opts[key] === 'number' ? Number(argv[++i]) : argv[++i];
 }
 return { opts, runs };
}

function main(argv) {
 const { opts, runs } = parseArgs(argv);
 if (opts.help) { console.log('node training/team-search/compare-history.cjs RUN_A RUN_B [--labels old,new] [--points 4] [--at N,N,...] [--window 40] [--block 5] [--json OUT.json]'); return; }
 if (runs.length !== 2) throw Error('Give exactly two runs: the reference (A) and the candidate (B)');
 const labels = opts.labels ? opts.labels.split(',') : runs.map(r => path.basename(path.resolve(r)).replace(/\.jsonl$/, ''));
 if (labels.length !== 2) throw Error('--labels takes two comma-separated names');
 const at = opts.at ? opts.at.split(',').map(Number) : [];
 if (at.some(x => !(x > 0))) throw Error('--at takes positive battle counts');
 const result = compareHistories(readHistory(runs[0]), readHistory(runs[1]), { points: opts.points, at, window: opts.window, block: opts.block, labels });
 console.log(formatReport(result));
 if (opts.json) { fs.writeFileSync(opts.json, JSON.stringify({ format: 'pvp-team-history-comparison', schemaVersion: 1, createdAt: new Date().toISOString(), runs, ...result }, null, 1)); console.log('Saved ' + opts.json); }
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error(e.message || e); process.exitCode = 1; } }
module.exports = { readHistory, blockStats, metricsAt, judge, budgets, compareHistories, formatReport, parseArgs, CRITERIA };
