# Extending Lock & Deploy

Three registries let you add behaviour without touching the engine. All of them keep the sandbox guard: nothing here can enable real money.

## Notifiers (`server/notifiers/index.js`)
A notifier is `{ name, send(event) }`, where `event = { type, title, body, at, clockDate, data }`. Built in: `console`, `inApp` (Home banner + Inbox), `webhook` (POST to `NOTIFY_WEBHOOK_URL`, HMAC-SHA256 in `X-LDB-Signature` when `NOTIFY_WEBHOOK_SECRET` is set).

```js
import { registerNotifier } from './server/notifiers/index.js';
registerNotifier('ntfy', ({ env, log }) => ({
  name: 'ntfy',
  send: async (e) => {
    await fetch(env.NTFY_URL, { method: 'POST', body: `${e.title}: ${e.body}` }).catch((err) => log.warn(err.message));
  },
}));
```
Then add `"ntfy": true` under `notifications` in `config/default-settings.json` and a validator line in `server/settings.js` (`'notifications.ntfy': bool`). Event types: `milestone`, `milestone_reversed`, `goal_reached`, `goal_closed`, `rollover`, `deposit_returned`, `deposit_skipped`, `deposits_paused`, `approval_requested`, `emergency_stop`, `hardship_requested`, `hardship_released`. **Never put unlock codes, tokens, passcodes or account numbers in a notification.** Web push, email and SMS would plug in here; none is built.

## Rules (`server/rules/index.js`)
Rules run before every pull, in order. Each gets a context (`goal`, `totals`, `schedule`, `transfers`, `settings`, `amountCents`, `date`, `today`, `getBalance()`) and returns one of:
- `{ action: 'proceed', amountCents }` (may lower the amount),
- `{ action: 'defer', reason }` (retry next business day, up to `safety.deferMaxBusinessDays`),
- `{ action: 'skip', reason }` (this period is skipped for good),
- `{ action: 'hold', reason }` (nothing to do now).

```js
import { registerRule } from './server/rules/index.js';
// Never pull more than $300 in one calendar month.
registerRule('monthlyCap', async (ctx) => {
  const month = ctx.date.slice(0, 7);
  const used = ctx.transfers.filter((t) => t.date.startsWith(month) && t.status !== 'cancelled').reduce((a, t) => a + t.amountCents, 0);
  const left = 30000 - used;
  return left <= 0 ? { action: 'skip', reason: 'Monthly cap reached' } : { action: 'proceed', amountCents: Math.min(ctx.amountCents, left) };
}, { before: 'balanceBuffer' });
```
The trace of every rule decision is saved on the period row (Transfers → overdraft protection).

## Providers (`server/providers/`)
Subclass `BankProvider` (see the method list in `BankProvider.js`: `createLinkToken`, `exchangePublicToken`, `listAccounts`, `getBalance`, `createTransferAuthorization`, `createTransfer`, `getTransfers`, `cancelTransfer`, `simulate`, `tick`, `handleWebhook`). Statuses must be normalized to `pending | posted | settled | returned | failed | cancelled`.

```js
import { registerProvider } from './server/providers/index.js';
registerProvider('moov-sandbox', async ({ config, store }) => new MoovSandboxProvider({ config, store }));
```
Requirements (enforced):
- `provider.sandbox === true`, or `createProvider` refuses it.
- Add the name to the provider allow-list in `assertSandboxOnly()` (`server/config.js`) in a reviewed commit, and hard-code the provider's **sandbox** host the way the Plaid adapter does.
- Accept and pass through the idempotency key on `createTransfer`.

Real-money providers are out of scope until every go-live gate in `server/golive.js` is met.

## Settings
Add a key to `config/default-settings.json` and a validator to `SCHEMA` in `server/settings.js`. Unknown keys are rejected. If the key could weaken the lock, add it to `BOT_FORBIDDEN_SETTINGS` and make sure it only applies to new goals.
