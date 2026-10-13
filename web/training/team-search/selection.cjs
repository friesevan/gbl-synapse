'use strict';
// Minimum evidence before leading (--min-lead-fixtures) and the option checks of the selection protocol
// (--confirmation-opponents, --validation-opponents-max; confirmation.cjs implements those two).
//
// A training record with a handful of fixtures can carry the highest cautious selection score on luck alone. With a
// threshold N > 0, a team that has played fewer than N fixtures ranks after every team that has, whatever its score;
// within each group the order is the cautious selection score as before. Because the ordering is the single
// `scoreRecords` ranking of search.cjs, the same rule governs the training leader, the retest incumbent
// (propose.cjs known[0], the rotating contenders and the local neighbourhoods) and the screening candidates.
// N = 0 (the default) changes nothing.

const fixturesOf = row => row.fixtures || row.games || 0;
const isThin = (row, minFixtures) => minFixtures > 0 && fixturesOf(row) < minFixtures;
// 1 for a team below the threshold, 0 otherwise: the first key of the comparator in search.cjs scoreRecords.
const leadRank = minFixtures => row => isThin(row, minFixtures) ? 1 : 0;

// Teams allowed to lead or to be screened: those at or above the threshold. When no team has reached it (a run too
// short to expand any team that far) the whole ordered list is returned, so a short run still completes; the fallback
// is recorded by describeLead and printed.
function leadPool(ordered, minFixtures) {
 if (!(minFixtures > 0)) return ordered;
 const eligible = ordered.filter(row => !isThin(row, minFixtures));
 return eligible.length ? eligible : ordered;
}

// What the screening set looked like under the rule (recorded in the checkpoint and shown in the report).
function describeLead(ordered, minFixtures, screenTeams) {
 if (!(minFixtures > 0)) return null;
 const above = ordered.filter(row => !isThin(row, minFixtures)).length, pool = leadPool(ordered, minFixtures), taken = pool.slice(0, screenTeams);
 return {
  minLeadFixtures: minFixtures, teams: ordered.length, teamsAtOrAboveThreshold: above, teamsBelowThreshold: ordered.length - above,
  fallback: above === 0 && ordered.length > 0, screeningCandidates: taken.length, screeningCandidatesBelowThreshold: taken.filter(row => isThin(row, minFixtures)).length,
  leaderFixtures: pool[0] ? fixturesOf(pool[0]) : null,
 };
}

// The retrospective (audit-selection.cjs) and the tests apply the rule to plain record lists with the same comparator.
function orderRecords(rows, minFixtures, { key = row => row.team.join(',') } = {}) {
 const rank = leadRank(minFixtures);
 return rows.slice().sort((a, b) => rank(a) - rank(b) || b.selectionScore - a.selectionScore || b.games - a.games || key(a).localeCompare(key(b)));
}

function validateOptions({ minLeadFixtures, confirmationOpponents, validationOpponents, validationOpponentsMax }) {
 if (!Number.isInteger(minLeadFixtures) || minLeadFixtures < 0 || minLeadFixtures > 100000) throw Error('min-lead-fixtures must be an integer from 0 (off) to 100000');
 if (!Number.isInteger(confirmationOpponents) || confirmationOpponents < 0 || confirmationOpponents > 8192) throw Error('confirmation-opponents must be an integer from 0 (off) to 8192');
 if (!Number.isInteger(validationOpponentsMax) || validationOpponentsMax < validationOpponents || validationOpponentsMax > 16384) throw Error('validation-opponents-max must be an integer from validation-opponents (off) to 16384');
}

module.exports = { fixturesOf, isThin, leadRank, leadPool, describeLead, orderRecords, validateOptions };
