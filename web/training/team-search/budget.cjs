'use strict';
function trainingBudget({ start, deadline, now, newBattles, screenTeams, screenOpponents,
  validationTeams, validationOpponents, baselineCount, battlesPerFixture=2, confirmationOpponents=0, confirmationTeams=2 }) {
  const fixed = start + (deadline - start) * .8;
  if (newBattles < 512 || now <= start) return { deadline: fixed, estimatedEvaluationSeconds: null };
  const rate = newBattles / ((now - start) / 1000);
  // The sealed confirmation panel (confirmation.cjs) is reserved for the usual case of one challenger beside the primary.
  const battles = (screenTeams * screenOpponents + (validationTeams + baselineCount) * validationOpponents + confirmationTeams * confirmationOpponents) * battlesPerFixture;
  const estimate = battles / rate;
  // A conservative margin protects final comparisons when simulation slows.
  return { deadline: Math.max(start, Math.min(fixed, deadline - estimate * 1250)),
    estimatedEvaluationSeconds: estimate };
}
module.exports = { trainingBudget };
