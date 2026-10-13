'use strict';
// Minimum evidence before leading (selection.cjs): the ordering, the pool that may lead or be screened, the recorded
// description and the option checks. The wiring into the real search loop is in search-selection.test.cjs.
const test = require('node:test'), assert = require('node:assert/strict');
const { fixturesOf, isThin, leadRank, leadPool, describeLead, orderRecords, validateOptions } = require('./selection.cjs');

// A record as scoreRecords builds it: selectionScore is the cautious score, fixtures the evidence behind it.
const row = (id, fixtures, selectionScore, games = fixtures) => ({ team: [id, 100 + id, 200 + id], fixtures, games, selectionScore, score: selectionScore });
const rows = [row(1, 8, .70), row(2, 64, .55), row(3, 200, .60), row(4, 63, .80), row(5, 64, .50), row(6, 12, .65)];

test('threshold 0 leaves the order exactly as the cautious selection score gives it', () => {
 const plain = orderRecords(rows, 0).map(r => r.team[0]);
 assert.deepEqual(plain, [4, 1, 6, 3, 2, 5]);
 assert.deepEqual(rows.slice().sort((a, b) => b.selectionScore - a.selectionScore).map(r => r.team[0]), plain);
 assert.equal(leadRank(0)(rows[0]), 0);
 assert.deepEqual(leadPool(orderRecords(rows, 0), 0), orderRecords(rows, 0), 'the same list, not a filtered copy');
 assert.equal(describeLead(orderRecords(rows, 0), 0, 3), null, 'nothing to record when the rule is off');
});

test('teams with fewer than N fixtures rank after every team with N or more, whatever their score', () => {
 const ordered = orderRecords(rows, 64).map(r => r.team[0]);
 // 64 fixtures is enough ("fewer than N" is the test); within each group the cautious score decides.
 assert.deepEqual(ordered, [3, 2, 5, 4, 1, 6]);
 const high = orderRecords(rows, 65);
 assert.deepEqual(high.map(r => r.team[0]), [3, 4, 1, 6, 2, 5], 'only team 3 reaches 65; the others keep the cautious order among themselves');
 // The highest cautious score of all (team 4, 63 fixtures) never leads at N = 64.
 assert.equal(orderRecords(rows, 64)[0].team[0], 3);
 // Equal score and equal evidence: the team key breaks the tie, as in scoreRecords.
 const tie = orderRecords([row(9, 80, .5), row(8, 80, .5)], 64).map(r => r.team[0]);
 assert.deepEqual(tie, [8, 9]);
 // The input list is not reordered in place.
 assert.deepEqual(rows.map(r => r.team[0]), [1, 2, 3, 4, 5, 6]);
});

test('fixtures come from the record: `fixtures`, else `games` (legacy records), else zero', () => {
 assert.equal(fixturesOf({ fixtures: 9, games: 18 }), 9);
 assert.equal(fixturesOf({ games: 18 }), 18);
 assert.equal(fixturesOf({}), 0);
 assert.equal(isThin({ games: 63 }, 64), true);
 assert.equal(isThin({ games: 64 }, 64), false);
 assert.equal(isThin({ games: 1 }, 0), false);
});

test('the lead pool excludes thin teams, and falls back to the whole ranking only when no team has enough evidence', () => {
 const ordered = orderRecords(rows, 64);
 assert.deepEqual(leadPool(ordered, 64).map(r => r.team[0]), [3, 2, 5], 'a thin team is neither leader, incumbent nor screening candidate');
 assert.deepEqual(leadPool(ordered, 64).slice(0, 2).map(r => r.team[0]), [3, 2]);
 const none = orderRecords(rows, 1000);
 assert.deepEqual(leadPool(none, 1000), none, 'a run too short to reach the threshold still completes, ranked as before');
 const info = describeLead(none, 1000, 4);
 assert.equal(info.fallback, true);assert.equal(info.teamsAtOrAboveThreshold, 0);assert.equal(info.screeningCandidatesBelowThreshold, 4);
 const ok = describeLead(ordered, 64, 5);
 assert.deepEqual(ok, { minLeadFixtures: 64, teams: 6, teamsAtOrAboveThreshold: 3, teamsBelowThreshold: 3, fallback: false, screeningCandidates: 3, screeningCandidatesBelowThreshold: 0, leaderFixtures: 200 });
 // Fewer eligible teams than screening slots: only the eligible ones are screened.
 assert.equal(ok.screeningCandidates, 3);
 assert.equal(describeLead(orderRecords(rows, 1), 1, 2).screeningCandidates, 2);
});

test('options are validated before any battle', () => {
 const base = { minLeadFixtures: 0, confirmationOpponents: 256, validationOpponents: 512, validationOpponentsMax: 512 };
 assert.doesNotThrow(() => validateOptions(base));
 assert.doesNotThrow(() => validateOptions({ ...base, minLeadFixtures: 64, confirmationOpponents: 0, validationOpponentsMax: 1024 }));
 for (const [changes, message] of [[{ minLeadFixtures: -1 }, /min-lead-fixtures/], [{ minLeadFixtures: 1.5 }, /min-lead-fixtures/], [{ minLeadFixtures: NaN }, /min-lead-fixtures/],
  [{ confirmationOpponents: -4 }, /confirmation-opponents/], [{ confirmationOpponents: 2.5 }, /confirmation-opponents/], [{ confirmationOpponents: 9000 }, /confirmation-opponents/],
  [{ validationOpponentsMax: 256 }, /validation-opponents-max/], [{ validationOpponentsMax: 20000 }, /validation-opponents-max/], [{ validationOpponentsMax: 600.5 }, /validation-opponents-max/]])
  assert.throws(() => validateOptions({ ...base, ...changes }), message, JSON.stringify(changes));
});
