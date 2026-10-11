'use strict';
function trainingBudget({ start, deadline, now, newBattles, screenTeams, screenOpponents,
  validationTeams, validationOpponents, baselineCount, battlesPerFixture=2 }) {
  const fixed = start + (deadline - start) * .8;
  if (newBattles < 512 || now <= start) return { deadline: fixed, estimatedEvaluationSeconds: null };
  const rate = newBattles / ((now - start) / 1000);
  const battles = (screenTeams * screenOpponents + (validationTeams + baselineCount) * validationOpponents) * battlesPerFixture;
  const estimate = battles / rate;
  // A conservative margin protects final comparisons when simulation slows.
  return { deadline: Math.max(start, Math.min(fixed, deadline - estimate * 1250)),
    estimatedEvaluationSeconds: estimate };
}
module.exports = { trainingBudget };
