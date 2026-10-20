import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDaily, validName } from '../../src/tasks.js';

test('nextDaily: later today, else tomorrow', () => {
  const now = new Date(2026, 9, 19, 8, 0, 0);
  assert.equal(new Date(nextDaily('09:30', now)).getTime(), new Date(2026, 9, 19, 9, 30).getTime());
  assert.equal(new Date(nextDaily('07:30', now)).getTime(), new Date(2026, 9, 20, 7, 30).getTime());
  assert.equal(new Date(nextDaily('08:00', now)).getTime(), new Date(2026, 9, 20, 8, 0).getTime());
});

test('saved task names work as /name shortcuts', () => {
  assert.ok(validName('morning-jobs'));
  assert.ok(validName('武汉全栈'));
  assert.ok(!validName('two words'));
  assert.ok(!validName(''));
  assert.ok(!validName('x'.repeat(41)));
});
