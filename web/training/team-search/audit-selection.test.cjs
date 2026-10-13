'use strict';
// The retrospective (audit-selection.cjs) on a small synthetic checkpoint with known answers.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { random } = require('../utils.cjs');
const { teamKey } = require('./common.cjs');
const { summarize, compareFinalists } = require('./evaluation.cjs');
const { auditSelection, print, riskScore } = require('./audit-selection.cjs');

const T = i => [i, 10 + i, 20 + i];
const stream = (p, n, seed) => { const r = random(seed); return Array.from({ length: n }, () => r() < p ? 1 : 0); };

// Teams 0..5 played these numbers of fixtures (win rate in the second list); rounds are assigned in order of play.
const plan = [[0, 8, .80], [1, 70, .62], [2, 300, .60], [3, 12, .95], [4, 64, .58], [5, 40, .75]];
function synthetic({ validations = null } = {}) {
 const observations = [], records = [];
 plan.forEach(([i, n, p], t) => {
  const scores = stream(p, n, 100 + i);
  scores.forEach((score, k) => observations.push({ team: T(i), opponent: ['a' + k, 'b', 'c'], seed: k, score, round: Math.floor(k / 40) + t % 2 }));
  records.push({ team: T(i), reward: scores.reduce((a, b) => a + b, 0), games: n, fixtures: n });
 });
 const ranked = records.map(r => ({ ...r, selectionScore: riskScore(r) })).sort((a, b) => b.selectionScore - a.selectionScore);
 const screened = ranked.slice(0, 4).map(r => ({ team: r.team, score: r.reward / r.games }));
 const finalists = validations || [stream(.70, 128, 1), stream(.72, 128, 2), stream(.45, 128, 3)];
 const rows = finalists.map((s, k) => summarize(s, { team: screened[k].team, fixtureSeed: 900, paired: false }));
 const state = { config: { screenTeams: 4, seed: 1, validationSeed: 902 }, records, observations, screenResults: screened, validations: rows, history: [], finalPanel: { requestedFixtures: 128, completedFixtures: 128 } };
 state.finalistComparisons = compareFinalists(rows[0], rows.slice(1), { seed: 3, samples: 1000 });
 return { state, ranked };
}

test('fixtures at screening, the screening set under the rule and the training leader come out as computed by hand', () => {
 const { state, ranked } = synthetic();
 const result = auditSelection(state, { minLead: 64, samples: 300 }), s = result.selection;
 assert.equal(s.teams, 6);assert.deepEqual(s.fixturesPerTeam, { min: 8, median: 52, max: 300 });
 assert.equal(s.teamsBelowThreshold, 3, 'teams 0, 3 and 5 have fewer than 64 fixtures');
 assert.equal(s.recomputedScreeningSetMatchesRun, true, 'the plain ranking reproduces the screened set');
 const thinInTop = ranked.slice(0, 4).filter(r => r.fixtures < 64).map(r => teamKey(r.team));
 assert.ok(thinInTop.length > 0, 'the scenario puts thin teams in the screening set');
 assert.equal(s.screeningSetChangedByRule, true);assert.deepEqual(s.droppedFromScreening.map(d => teamKey(d.team)).sort(), thinInTop.sort());
 assert.equal(s.screened.belowThreshold, thinInTop.length);
 // Only 3 teams (1, 2 and 4) reach 64 fixtures, so only they are screened under the rule: the thin ones drop out and any team that reaches the threshold comes in.
 assert.equal(4 - s.droppedFromScreening.length + s.addedToScreening.length, 3);assert.ok(s.addedToScreening.every(a => a.fixtures >= 64));
 assert.deepEqual(result.finalists.map(f => f.fixturesAtScreening), result.finalists.map(f => state.records.find(r => teamKey(r.team) === teamKey(f.team)).fixtures));
 assert.deepEqual(result.finalists.map(f => f.belowThreshold), result.finalists.map(f => f.fixturesAtScreening < 64));
 assert.ok(result.finalists.every(f => f.rankWithRule === null || f.rankWithRule <= 3));
 // Threshold 0: nothing changes.
 const off = auditSelection(state, { minLead: 0, samples: 300 });assert.equal(off.selection.screeningSetChangedByRule, false);assert.equal(off.selection.teamsBelowThreshold, 0);assert.equal(off.selection.finalistsDropped, 0);
 assert.equal(teamKey(s.leaderByScore.team), teamKey(ranked[0].team));
 assert.ok(s.leaderWithRule.fixtures >= 64, 'with the rule the leader has enough fixtures');
});

test('the training leader is rebuilt round by round from the observations, with and without the rule', () => {
 const { state } = synthetic();
 // History in the form search.cjs writes it: bestTraining after every round.
 const first = auditSelection(state, { minLead: 64, samples: 200 }).trajectory;
 assert.equal(first.rounds, new Set(state.observations.map(o => o.round)).size);
 assert.equal(first.scores.plain.length, first.rounds);assert.equal(first.scores.ruled.length, first.rounds);
 assert.equal(first.comparedWithHistory, 0, 'no history recorded in this synthetic run');
 state.history = first.scores.plain.map((bestTraining, i) => ({ round: i + 1, bestTraining }));
 const again = auditSelection(state, { minLead: 64, samples: 200 }).trajectory;
 assert.equal(again.comparedWithHistory, first.rounds);assert.equal(again.matchesHistory, first.rounds, 'the rebuilt leader scores agree with the recorded ones');
 assert.ok(again.leaderChangedByRule >= 1, 'a thin team led at some point and the rule changes the leader then');
 assert.ok(again.leaderBelowThreshold >= again.leaderChangedByRule);
 assert.ok(again.distinctLeaders >= 1);
 assert.deepEqual(auditSelection(state, { minLead: 0, samples: 200 }).trajectory.scores.ruled, again.scores.plain, 'no threshold, no difference');
});

test('which finalist comparisons would have triggered a confirmation panel, for the actual primary and for each finalist as primary', () => {
 // The actual primary is clearly below the second finalist: a confirmation would run.
 const trigger = synthetic({ validations: [stream(.40, 256, 1), stream(.80, 256, 2), stream(.41, 256, 3)] }), result = auditSelection(trigger.state, { minLead: 64, samples: 500 }), c = result.confirmation;
 assert.equal(c.finalFixtures, 256);assert.equal(c.actualTriggers.length, 1);assert.deepEqual(c.actualTriggers[0].team, trigger.state.validations[1].team);
 assert.equal(c.asPrimary.length, 3);assert.equal(c.asPrimary[0].actualPrimary, true);assert.equal(c.asPrimary[0].wouldTrigger, true);assert.equal(c.asPrimary[0].challengerBetter, 1);
 assert.equal(c.asPrimary[1].wouldTrigger, false, 'the best finalist as primary has no challenger above it');
 assert.equal(c.pairs.count, 3);assert.ok(c.pairs.resolved.some(p => p.verdict !== 'unresolved'));assert.ok(c.resolvable.halfWidthAt[512] < c.resolvable.halfWidthAt[256]);
 // Nothing separable: no trigger, whoever the primary is.
 const quiet = synthetic({ validations: [stream(.60, 64, 1), stream(.61, 64, 2), stream(.59, 64, 3)] }), q = auditSelection(quiet.state, { minLead: 64, samples: 500 }).confirmation;
 assert.deepEqual(q.actualTriggers, []);assert.ok(q.asPrimary.every(a => !a.wouldTrigger));assert.deepEqual(q.pairs.resolved, []);
 // The printed report names the answer.
 assert.match(print(result), /actual primary: 1 challenger\(s\) clearly above it/);assert.match(print(auditSelection(quiet.state, { minLead: 64, samples: 200 })), /the confirmation panel would NOT have run/);
});

test('the command line reads a run directory and writes only the JSON it is asked for', () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-audit-selection-')), { state } = synthetic();
 try {
  fs.writeFileSync(path.join(directory, 'checkpoint.json'), JSON.stringify(state));
  const before = fs.readdirSync(directory), out = path.join(directory, 'audit.json');
  const run = spawnSync(process.execPath, [path.join(__dirname, 'audit-selection.cjs'), directory, '--min-lead', '64', '--samples', '200', '--json', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);assert.match(run.stdout, /Teams trained: 6/);assert.match(run.stdout, /Confirmation trigger on the 128-fixture final panel/);
  assert.deepEqual(fs.readdirSync(directory).sort(), [...before, 'audit.json'].sort());
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).selection.minLead, 64);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'audit-selection.cjs')], { encoding: 'utf8' }).status, 1, 'a run directory is required');
 } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
