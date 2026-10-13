#!/usr/bin/env node
'use strict';
// Retrospective on a finished run (read-only): what the selection protocol (selection.cjs, confirmation.cjs) would have
// changed. For the finalists: how many fixtures each had when it entered screening, whether a minimum-evidence rule
// (--min-lead, default 64) would have changed the screening set, and which finalist comparisons would have triggered a
// sealed confirmation panel (the actual ones, and every finalist taken as the primary in turn).
//
//   node training/team-search/audit-selection.cjs RUN_DIR [--min-lead 64] [--samples 5000] [--seed 1] [--json OUT.json]
//
// Only checkpoint.json is read. No battle is simulated and nothing in the run directory is written.
const fs = require('node:fs'), path = require('node:path');
const { teamKey } = require('./common.cjs');
const { orderRecords, leadPool, isThin } = require('./selection.cjs');
const { compareFinalists } = require('./evaluation.cjs');
const { pairwiseBands, resolvable } = require('./paired-stats.cjs');
const { challengers } = require('./confirmation.cjs');

// search.cjs riskScore: the fixture mean shrunk toward 0.5 with eight pseudo-fixtures, minus 1.28 posterior standard deviations.
const riskScore = r => { const n = r.fixtures || r.games, mean = (r.reward / r.games * n + 4) / (n + 8); return mean - 1.28 * Math.sqrt(mean * (1 - mean) / (n + 9)); };
const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))]; };

function auditSelection(state, { minLead = 64, seed = 1, samples = 5000 } = {}) {
 if (!Array.isArray(state.records) || !state.records.length) throw Error('The checkpoint has no training records');
 const screenTeams = state.config.screenTeams, key = teamKey;
 // Fixture counts as the search saw them: observations per team (records carry the same number in `fixtures`).
 const counts = new Map();for (const o of state.observations || []) counts.set(key(o.team), (counts.get(key(o.team)) || 0) + 1);
 const rows = state.records.map(r => { const fixtures = counts.get(key(r.team)) ?? r.fixtures ?? r.games, row = { team: r.team, reward: r.reward, games: r.games, fixtures }; return { ...row, score: r.reward / r.games, selectionScore: riskScore(row) }; });
 const plain = orderRecords(rows, 0), ruled = leadPool(orderRecords(rows, minLead), minLead);
 const rank = (list, team) => { const i = list.findIndex(r => key(r.team) === key(team)); return i < 0 ? null : i + 1; };
 const actualScreen = (state.screenResults || []).map(r => key(r.team)), plainTop = plain.slice(0, screenTeams).map(r => key(r.team)), ruledTop = ruled.slice(0, screenTeams).map(r => key(r.team));
 const same = (a, b) => a.length === b.length && a.every(k => b.includes(k));
 const finalists = (state.validations || []).map((v, i) => {
  const record = rows.find(r => key(r.team) === key(v.team)), screen = (state.screenResults || []).find(s => key(s.team) === key(v.team));
  return { team: v.team, primary: i === 0, fixturesAtScreening: record?.fixtures ?? null, belowThreshold: record ? isThin(record, minLead) : null, trainingScore: record?.score ?? null, selectionScore: record?.selectionScore ?? null, rankByScore: rank(plain, v.team), rankWithRule: rank(ruled, v.team), inScreeningSetWithRule: ruledTop.includes(key(v.team)), screeningScore: screen?.score ?? null, finalScore: v.score };
 });
 const fixtureCounts = rows.map(r => r.fixtures), screenedRows = actualScreen.map(k => rows.find(r => key(r.team) === k)).filter(Boolean);
 const selection = {
  minLead, teams: rows.length, teamsBelowThreshold: rows.filter(r => isThin(r, minLead)).length, teamsAtOrAboveThreshold: rows.filter(r => !isThin(r, minLead)).length,
  fixturesPerTeam: { min: Math.min(...fixtureCounts), median: median(fixtureCounts), max: Math.max(...fixtureCounts) },
  recomputedScreeningSetMatchesRun: same(actualScreen, plainTop),
  screened: { teams: screenedRows.length, belowThreshold: screenedRows.filter(r => isThin(r, minLead)).length, fixtures: screenedRows.map(r => r.fixtures).sort((a, b) => a - b) },
  screeningSetChangedByRule: !same(actualScreen, ruledTop),
  droppedFromScreening: actualScreen.filter(k => !ruledTop.includes(k)).map(k => ({ team: rows.find(r => key(r.team) === k).team, fixtures: rows.find(r => key(r.team) === k).fixtures, rankByScore: rank(plain, rows.find(r => key(r.team) === k).team) })),
  addedToScreening: ruledTop.filter(k => !actualScreen.includes(k)).map(k => ({ team: rows.find(r => key(r.team) === k).team, fixtures: rows.find(r => key(r.team) === k).fixtures, rankByScore: rank(plain, rows.find(r => key(r.team) === k).team) })),
  finalistsDropped: finalists.filter(f => !f.inScreeningSetWithRule).length,
  leaderByScore: { team: plain[0].team, fixtures: plain[0].fixtures }, leaderWithRule: { team: ruled[0].team, fixtures: ruled[0].fixtures },
 };
 // The training leader (and so the retest incumbent) after every round, rebuilt from the observations' round tags with the same
 // ranking, with and without the rule: how often a team with thin evidence led, and whether the rule would have changed the leader.
 const byRound = new Map();for (const o of state.observations || []) { if (!Number.isInteger(o.round)) continue;if (!byRound.has(o.round)) byRound.set(o.round, []);byRound.get(o.round).push(o); }
 const running = new Map(), history = state.history || [], trajectory = { rounds: 0, leaderBelowThreshold: 0, leaderChangedByRule: 0, distinctLeaders: 0, distinctLeadersWithRule: 0, matchesHistory: 0, comparedWithHistory: 0, firstRoundWithEligibleTeam: null, scores: { plain: [], ruled: [] } };
 const leaders = new Set(), ruledLeaders = new Set(), ruleRank = r => isThin(r, minLead) ? 1 : 0;
 for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
  for (const o of byRound.get(round)) { const k = key(o.team), r = running.get(k) || { team: o.team, reward: 0, games: 0, fixtures: 0 };r.reward += o.score;r.games++;r.fixtures++;running.set(k, r); }
  let top = null, topRuled = null, eligible = false;
  for (const r of running.values()) {
   const row = { ...r, selectionScore: riskScore(r) }, better = (a, b, withRule) => !b || (withRule && ruleRank(a) !== ruleRank(b) ? ruleRank(a) < ruleRank(b) : a.selectionScore !== b.selectionScore ? a.selectionScore > b.selectionScore : a.games !== b.games ? a.games > b.games : key(a.team) < key(b.team));
   if (better(row, top, false)) top = row;if (better(row, topRuled, true)) topRuled = row;if (!isThin(row, minLead)) eligible = true;
  }
  trajectory.rounds++;trajectory.scores.plain.push(top.reward / top.games);trajectory.scores.ruled.push(topRuled.reward / topRuled.games);
  if (isThin(top, minLead)) trajectory.leaderBelowThreshold++;
  if (key(top.team) !== key(topRuled.team)) trajectory.leaderChangedByRule++;
  leaders.add(key(top.team));ruledLeaders.add(key(topRuled.team));
  if (eligible && trajectory.firstRoundWithEligibleTeam === null) trajectory.firstRoundWithEligibleTeam = round;
  const recorded = history.find(h => h.round === round + 1);if (recorded) { trajectory.comparedWithHistory++;if (Math.abs(recorded.bestTraining - top.reward / top.games) < 1e-9) trajectory.matchesHistory++; }
 }
 trajectory.distinctLeaders = leaders.size;trajectory.distinctLeadersWithRule = ruledLeaders.size;
 const validations = state.validations || [], confirmation = { finalFixtures: validations[0]?.pairs?.length ?? null, actualTriggers: null, asPrimary: [], pairs: null, resolvable: null };
 if (validations.length >= 2) {
  confirmation.actualTriggers = challengers(state).map(c => ({ team: c.team, evidence: c.evidence }));
  confirmation.actualComparisons = state.finalistComparisons ? state.finalistComparisons.comparisons.map(c => ({ team: c.team, delta: c.delta, interval95: c.interval95, distinguishable: c.distinguishable })) : null;
  confirmation.asPrimary = validations.map((v, i) => {
   const others = validations.filter((_, j) => j !== i), comparison = compareFinalists(v, others, { seed: seed + 800002, samples }), better = comparison.comparisons.filter(c => c.distinguishable === 'challenger-better');
   return { team: v.team, actualPrimary: i === 0, comparisons: comparison.comparisons.length, challengerBetter: better.length, primaryBetter: comparison.comparisons.filter(c => c.distinguishable === 'primary-better').length, unresolved: comparison.comparisons.filter(c => c.distinguishable === 'unresolved').length, wouldTrigger: better.length > 0, challengers: better.map(c => ({ team: c.team, delta: c.delta, interval95: c.interval95 })) };
  });
  const bands = pairwiseBands(validations.map(v => ({ id: key(v.team), scores: v.pairs })), { seed: seed + 800002, samples });
  confirmation.pairs = { count: bands.pairs.length, radius: bands.radius, resolved: bands.pairs.filter(p => p.verdict !== 'unresolved').map(p => ({ a: validations.find(v => key(v.team) === p.a).team, b: validations.find(v => key(v.team) === p.b).team, delta: p.delta, simultaneous95: p.simultaneous95, verdict: p.verdict })) };
  // What a panel of N fixtures can resolve, from the paired per-fixture differences of this run (normal approximation, one comparison).
  const sds = [];for (let i = 0; i < validations.length; i++) for (let j = i + 1; j < validations.length; j++) { const d = validations[i].pairs.map((v, k) => v - validations[j].pairs[k]), m = d.reduce((a, b) => a + b, 0) / d.length; sds.push(Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length - 1))); }
  confirmation.resolvable = { medianSd: median(sds), q90Sd: quantile(sds, .9), halfWidthAt: Object.fromEntries([64, 128, 256, 512, 1024].map(n => [n, resolvable(median(sds), n)])) };
 }
 return { run: state.config.seed, validationSeed: state.config.validationSeed, screenTeams, selection, trajectory, finalists, confirmation };
}

const pct = x => Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : '—', pp = x => (100 * x).toFixed(1);
function print(result, pool = null) {
 const name = t => pool ? t.map(i => pool.variants[i].speciesName).join(' / ') : t.join(',');
 const s = result.selection, c = result.confirmation, out = [];
 out.push('Teams trained: ' + s.teams + '; fixtures per team min ' + s.fixturesPerTeam.min + ', median ' + s.fixturesPerTeam.median + ', max ' + s.fixturesPerTeam.max + '; below ' + s.minLead + ' fixtures: ' + s.teamsBelowThreshold + ' (' + pct(s.teamsBelowThreshold / s.teams) + ')');
 out.push('Recomputed screening set (top ' + result.screenTeams + ' by cautious selection score) ' + (s.recomputedScreeningSetMatchesRun ? 'matches' : 'DOES NOT MATCH') + ' the 24 teams the run screened.');
 out.push('Screened teams below ' + s.minLead + ' fixtures: ' + s.screened.belowThreshold + ' of ' + s.screened.teams + '; fixtures of the screened teams: ' + s.screened.fixtures.join(', '));
 out.push('The rule would ' + (s.screeningSetChangedByRule ? 'change' : 'not change') + ' the screening set' + (s.screeningSetChangedByRule ? ': ' + s.droppedFromScreening.length + ' dropped (' + s.droppedFromScreening.map(d => name(d.team) + ' [' + d.fixtures + ' fixtures, rank ' + d.rankByScore + ']').join('; ') + '), ' + s.addedToScreening.length + ' added' : '') + '; finalists dropped: ' + s.finalistsDropped + '.');
 out.push('Training leader: ' + name(s.leaderByScore.team) + ' (' + s.leaderByScore.fixtures + ' fixtures)' + (JSON.stringify(s.leaderByScore.team) === JSON.stringify(s.leaderWithRule.team) ? '; the rule does not change it.' : '; with the rule: ' + name(s.leaderWithRule.team) + ' (' + s.leaderWithRule.fixtures + ' fixtures).'));
 const t = result.trajectory;
 out.push('Training leader after each of ' + t.rounds + ' rounds (rebuilt from the observations; ' + t.matchesHistory + ' of ' + t.comparedWithHistory + ' recorded leaders agree with history.jsonl): ' + t.distinctLeaders + ' distinct leaders; the leader had fewer than ' + s.minLead + ' fixtures in ' + t.leaderBelowThreshold + ' rounds; the rule would change the leader in ' + t.leaderChangedByRule + ' rounds (' + t.distinctLeadersWithRule + ' distinct leaders with it); first round with a team at ' + s.minLead + ' fixtures: ' + t.firstRoundWithEligibleTeam + '.');
 out.push('', 'Finalists:');
 for (const f of result.finalists) out.push('  ' + (f.primary ? '* ' : '  ') + name(f.team) + ': ' + f.fixturesAtScreening + ' fixtures at screening' + (f.belowThreshold ? ' (BELOW ' + s.minLead + ')' : '') + ', training ' + pct(f.trainingScore) + ', rank ' + f.rankByScore + (f.rankWithRule !== f.rankByScore ? ' -> ' + (f.rankWithRule === null ? 'excluded' : f.rankWithRule) + ' with the rule' : '') + ', screening ' + pct(f.screeningScore) + ', final ' + pct(f.finalScore));
 if (c.asPrimary.length) {
  out.push('', 'Confirmation trigger on the ' + c.finalFixtures + '-fixture final panel:');
  out.push('  actual primary: ' + (c.actualTriggers.length ? c.actualTriggers.length + ' challenger(s) clearly above it: ' + c.actualTriggers.map(t => name(t.team)).join('; ') : 'no challenger clearly above it; the confirmation panel would NOT have run.'));
  out.push('  each finalist taken as the primary in turn (simultaneous band over the other ' + (c.asPrimary.length - 1) + '): would trigger ' + c.asPrimary.filter(a => a.wouldTrigger).length + ' of ' + c.asPrimary.length + (c.asPrimary.some(a => a.wouldTrigger) ? ' (' + c.asPrimary.filter(a => a.wouldTrigger).map(a => name(a.team) + ': ' + a.challengerBetter + ' challenger(s)').join('; ') + ')' : ''));
  out.push('  all ' + c.pairs.count + ' finalist pairs under one simultaneous band (radius ' + pp(c.pairs.radius) + ' points): ' + (c.pairs.resolved.length ? c.pairs.resolved.length + ' resolved: ' + c.pairs.resolved.map(p => name(p.a) + ' vs ' + name(p.b) + ' ' + pp(p.delta) + ' pp').join('; ') : 'none resolved'));
  out.push('  paired difference sd (median over pairs) ' + c.resolvable.medianSd.toFixed(3) + '; one-comparison half-width at 256 fixtures ' + pp(c.resolvable.halfWidthAt[256]) + ' points, at 512 ' + pp(c.resolvable.halfWidthAt[512]) + ', at 1024 ' + pp(c.resolvable.halfWidthAt[1024]));
 }
 return out.join('\n');
}

if (require.main === module) {
 const args = process.argv.slice(2), dir = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a));
 const flag = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
 if (!dir) throw Error('node training/team-search/audit-selection.cjs RUN_DIR [--min-lead 64] [--samples 5000] [--seed 1] [--json OUT.json]');
 const state = JSON.parse(fs.readFileSync(path.join(path.resolve(dir), 'checkpoint.json'), 'utf8')), poolFile = path.join(path.resolve(dir), 'pool.json');
 const result = auditSelection(state, { minLead: Number(flag('min-lead', 64)), samples: Number(flag('samples', 5000)), seed: Number(flag('seed', 1)) });
 console.log(print(result, fs.existsSync(poolFile) ? JSON.parse(fs.readFileSync(poolFile, 'utf8')) : null));
 if (flag('json')) { fs.writeFileSync(path.resolve(flag('json')), JSON.stringify(result, null, 1)); console.log('Saved ' + path.resolve(flag('json'))); }
}
module.exports = { auditSelection, print, riskScore };
