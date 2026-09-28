// "Did you know?" cards (one per settled $100, sticky, blind-safe) and live speed-up projections + raise-only flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, setupActive, advanceUntil } from './helpers.js';
import { CARDS, renderCard, speedUpCards, sooner } from '../server/tips.js';
import { pullDates } from '../server/schedule.js';
import { addDays } from '../server/dates.js';

const SIM = { SIM_DATE: '2026-10-05' };
const ALL = ['read', 'propose', 'pause', 'request'];
const MONEY = /\$|\d[\d,]*\.\d{2}|\b\d{1,3}(,\d{3})+\b/;

test('40 cards in three tiers; general info only; SSI cards carry the reminder; blind rendering has no numbers', () => {
  assert.equal(CARDS.length, 40);
  assert.deepEqual([...new Set(CARDS.map((c) => c.tier))].sort(), ['basics', 'building', 'next']);
  for (const id of ['pay-yourself-first', 'cash-advance-fees', 'emergency-fund', 'consistency']) assert.ok(CARDS.some((c) => c.id === id), id);
  for (const c of CARDS) {
    const b = renderCard(c, { blind: true });
    assert.equal(b.heading, 'New milestone unlocked'); assert.equal(b.n, undefined); assert.equal(b.atCents, undefined);
    assert.ok(!MONEY.test(JSON.stringify(b)), `blind card ${c.id} has no $ or amounts`);
    assert.ok(!/\d+(\.\d+)?\s?%/.test(b.tip), `${c.id}: no made-up percentages`);
  }
  assert.equal(sooner(0), 'about the same time'); assert.match(sooner(95), /3 months sooner/);
});

test('speed-up math from the real plan: months sooner, long-range down payment, SSI reminder, blind wording', () => {
  const s = { amountCents: 10000, frequency: 'monthly', dayOfMonth: 3, anchorDate: '2026-10-03', status: 'active' };
  const from = '2026-10-01';
  const datesFrom = (n) => pullDates(s, from, addDays(from, n * 32 + 62)).slice(0, n);
  const goal = { status: 'saving', targetCents: 300000 };
  const r = speedUpCards({ goal, totals: { vaultCents: 20000, pendingCents: 0 }, schedule: s, datesFrom });
  const [x2, x3, house] = r.cards;
  assert.equal(x2.currentFinishOn, datesFrom(28).at(-1)); assert.equal(x2.finishOn, datesFrom(14).at(-1));
  assert.ok(x2.soonerDays > 360 && x3.soonerDays > x2.soonerDays);
  assert.match(x2.tip, /\$100 to \$200\/month/); assert.match(x3.title, /\$300/);
  assert.deepEqual(x2.action, { kind: 'raise_deposit', multiplier: 2, label: 'Raise to $200/month', note: x2.action.note });
  assert.ok(x2.ssiReminder && /2,000/.test(x2.ssiReminder) && /ABLE/.test(x2.ssiReminder), 'goal past $2,000 -> SSI reminder');
  assert.equal(house.id, 'pace-house'); assert.match(house.tip, /\$10,000/); assert.ok(house.ssiReminder);
  const small = speedUpCards({ goal: { status: 'saving', targetCents: 150000 }, totals: { vaultCents: 0, pendingCents: 0 }, schedule: s, datesFrom });
  assert.equal(small.cards[0].ssiReminder, null, 'no reminder below the limit');
  const b = speedUpCards({ goal, totals: { vaultCents: 20000, pendingCents: 0 }, schedule: s, datesFrom, blind: true });
  const text = JSON.stringify(b.cards.map(({ title, tip, action, ssiReminder }) => ({ title, tip, label: action?.label, ssiReminder })));
  assert.ok(!MONEY.test(text), `blind speed-up has no amounts: ${text.match(MONEY)?.[0]}`);
  assert.match(b.cards[0].tip, /^Double your deposit/); assert.match(b.cards[1].tip, /^Triple your deposit/); assert.ok(b.cards[0].ssiReminder);
  assert.deepEqual(speedUpCards({ goal: null, totals: {}, schedule: s, datesFrom }).cards, []);
});

test('cards unlock per SETTLED $100 only, stay unlocked, blind hides numbers; raise-only flow; bot speed-up needs approval', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  await setupActive(h.call, { amountCents: 15000 });
  let st = (await h.call('/api/state')).data;
  assert.equal(st.cards.unlocked.length, 0);
  st = await advanceUntil(h.call, (x) => x.totals.pendingCents > 0, 20);
  assert.equal(st.cards.unlocked.length, Math.floor(st.totals.vaultCents / 10000), 'pending never counts');
  st = await advanceUntil(h.call, (x) => x.totals.vaultCents >= 30000, 60);
  const n = st.cards.unlocked.length; assert.equal(n, Math.floor(st.totals.vaultCents / 10000)); assert.ok(n >= 3);
  assert.ok(st.cards.unseen >= 1); assert.equal(st.cards.unlocked[0].heading.startsWith('Card'), true);
  assert.ok(st.audit.some((a) => a.type === 'tip_card_unlocked'));
  assert.equal((await h.call('/api/cards/seen', {})).status, 200);
  assert.equal((await h.call('/api/state')).data.cards.unseen, 0);
  // bot
  const key = (await h.call('/api/bot-keys', { name: 'Grok', scopes: ALL })).data.key; const bot = h.bot(key);
  assert.equal((await bot('/bot/v1/speed-up/propose', { multiplier: 5 })).status, 400);
  const p = await bot('/bot/v1/speed-up/propose', { multiplier: 2, reason: 'finish sooner' });
  assert.equal(p.status, 202); assert.equal(p.data.approval.type, 'schedule_change'); assert.equal(p.data.approval.payload.amountCents, 30000);
  assert.equal((await h.call('/api/state')).data.schedule.amountCents, 15000, 'nothing changes until the user approves');
  // raise-only user flow
  assert.equal((await h.call('/api/schedule/raise', { amountCents: 10000 })).status, 400, 'lower refused');
  assert.equal((await h.call('/api/schedule/raise', { multiplier: 4 })).status, 400);
  const r = await h.call('/api/schedule/raise', { multiplier: 3 });
  assert.equal(r.status, 200); assert.equal(r.data.next, '#/authorize');
  st = (await h.call('/api/state')).data;
  assert.equal(st.schedule.amountCents, 45000); assert.equal(st.schedule.status, 'needs_authorization', 'new ACH authorization required');
  assert.ok(st.audit.some((a) => a.type === 'deposit_raised'));
  // blind
  assert.equal((await h.call('/api/blind/on', { confirm: true })).status, 200);
  const c = (await h.call('/api/cards')).data;
  assert.equal(c.unlocked.length, n, 'cards stay unlocked');
  assert.ok(!MONEY.test(JSON.stringify(c.unlocked.map(({ heading, title, tip, cheer }) => ({ heading, title, tip, cheer })))));
  assert.ok(c.unlocked.every((u) => u.n === undefined || u.n === null));
  const bc = (await bot('/bot/v1/cards')).data;
  assert.equal(bc.blindMode, true); assert.ok(!/\$\d/.test(JSON.stringify(bc)));
});
