'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { trainingBudget } = require('./budget.cjs');
test('evaluation reserve grows for slow simulations while retaining the minimum 20% reserve', () => {
  const base = { start: 0, deadline: 7200000, now: 600000, screenTeams: 10, screenOpponents: 500,
    validationTeams: 5, validationOpponents: 1000, baselineCount: 5 };
  assert.equal(trainingBudget({ ...base, newBattles: 100 }).deadline, 5760000);
  const slow = trainingBudget({ ...base, newBattles: 6000 });
  assert.equal(slow.estimatedEvaluationSeconds, 3000);
  assert.equal(slow.deadline, 3450000);
  assert.equal(trainingBudget({ ...base, newBattles: 30000 }).deadline, 5760000);
  assert.equal(trainingBudget({ ...base, newBattles: 512 }).deadline, 0);
});
