import test from 'node:test';
import assert from 'node:assert/strict';
import { pullDates, nextPullDates, benefitDate } from '../server/schedule.js';
import { isBusinessDay, fedHolidays } from '../server/dates.js';

test('federal holidays 2026', () => {
  const h = fedHolidays(2026);
  for (const d of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']) assert.ok(h.has(d), d);
  assert.ok(!isBusinessDay('2026-10-12'));
  assert.ok(isBusinessDay('2026-07-03'), 'Fed does not observe Saturday holidays on Friday');
  assert.ok(fedHolidays(2027).has('2027-07-05'), 'Sunday July 4 2027 observed Monday');
});

test('SSI arrives on the 1st, or the prior business day', () => {
  assert.equal(benefitDate(2026, 9, { benefitType: 'ssi' }), '2026-10-01');
  assert.equal(benefitDate(2026, 10, { benefitType: 'ssi' }), '2026-10-30'); // Nov 1 2026 is a Sunday
  assert.equal(benefitDate(2027, 0, { benefitType: 'ssi' }), '2026-12-31'); // Jan 1 holiday
});

test('day after SSI arrives, moved to a business day', () => {
  assert.deepEqual(nextPullDates({ frequency: 'benefit', benefitType: 'ssi', offsetDays: 1 }, '2026-09-25', 4), ['2026-10-02', '2026-11-02', '2026-12-02', '2027-01-04']);
});

test('SSDI 3rd Wednesday + 1', () => {
  assert.deepEqual(nextPullDates({ frequency: 'benefit', benefitType: 'ssdi_wed3', offsetDays: 1 }, '2026-10-01', 2), ['2026-10-22', '2026-11-19']);
});

test('monthly day 31 clamps to month end and skips weekends', () => {
  assert.deepEqual(nextPullDates({ frequency: 'monthly', dayOfMonth: 31 }, '2026-09-01', 3), ['2026-09-30', '2026-11-02', '2026-11-30']);
});

test('weekly skips Columbus Day to Tuesday', () => {
  assert.deepEqual(pullDates({ frequency: 'weekly', anchorDate: '2026-09-28' }, '2026-10-01', '2026-10-20'), ['2026-10-05', '2026-10-13', '2026-10-19']);
});
