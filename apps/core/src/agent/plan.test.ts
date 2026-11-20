import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPlan, newPlan, openSteps, planGateMessage } from './plan.ts';

test('newPlan validates size and starts open', () => {
  assert.throws(() => newPlan([]));
  assert.throws(() => newPlan(Array.from({ length: 9 }, (_, i) => ({ text: `s${i}` }))));
  const p = newPlan([{ text: ' a ', files: ['x.ts'] }, { text: 'b' }]);
  assert.deepEqual(p, [{ text: 'a', files: ['x.ts'], status: 'open' }, { text: 'b', status: 'open' }]);
});

test('gate lists open steps and clears when all are closed', () => {
  assert.equal(planGateMessage(undefined), null);
  const p = newPlan([{ text: 'read' }, { text: 'edit' }, { text: 'test' }]);
  p[0].status = 'done';
  assert.deepEqual(openSteps(p), [2, 3]);
  assert.equal(planGateMessage(p), '[Monarch plan] Steps 2, 3 are still open: 2. edit; 3. test. Finish them or mark skipped with a reason (plan_step).');
  p[1].status = 'done';
  assert.match(planGateMessage(p)!, /^\[Monarch plan\] Step 3 is still open/);
  p[2].status = 'skipped';
  p[2].note = 'no tests in repo';
  assert.equal(planGateMessage(p), null);
  assert.equal(formatPlan(p).split('\n')[2], '[-] 3. test — no tests in repo');
});
