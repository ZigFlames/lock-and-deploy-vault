// Browser-only "server" for the static demo. It runs the SAME code as the Node prototype:
//   server/service.js (engine, Hard Lock + loosening rules, vault, rollover, hardship, approvals, emergency stop),
//   server/rules (goal cap + overdraft buffer), server/bot.js (bot API: scopes, forbidden requests, activity log),
//   server/routes.js (the user API route table), server/providers/mock.js (mock bank) and server/audit.js.
// Only the storage (localStorage instead of data/db.json) and the transport (an in-page function instead of HTTP)
// differ. Fictional money only: there is no network provider in this bundle and REAL_MONEY_ENABLED stays false.
import { emptyState, migrate } from '../../server/store.js';
import { Service, AppError } from '../../server/service.js';
import { createRoutes } from '../../server/routes.js';
import { createBotApi } from '../../server/bot.js';
import { createNotifier } from '../../server/notifiers/index.js';
import { MockProvider } from '../../server/providers/mock.js';
import { REAL_MONEY_ENABLED } from '../../server/config.js';

const NS = 'ldb-vault-demo';
const K = { state: `${NS}:state`, key: `${NS}:token-key`, bot: `${NS}:sim-bot-key` };
if (REAL_MONEY_ENABLED !== false) throw new Error('production guard: REAL_MONEY_ENABLED must be false');

/** Same contract as server/store.js Store (state, load, save, reset, withLock), backed by localStorage. */
class LocalStore {
  constructor() { this.queue = Promise.resolve(); this.load(); }
  load() {
    const raw = localStorage.getItem(K.state);
    this.state = raw ? migrate(JSON.parse(raw)) : emptyState();
  }
  save() { localStorage.setItem(K.state, JSON.stringify(this.state)); }
  reset() { this.state = emptyState(); this.save(); }
  withLock(fn) {
    const run = async () => { this.load(); try { return await fn(this.state); } finally { this.save(); } };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

function tokenKey() {
  let b64 = localStorage.getItem(K.key);
  if (!b64) { const k = new Uint8Array(32); crypto.getRandomValues(k); b64 = Buffer.from(k).toString('base64'); localStorage.setItem(K.key, b64); }
  return Buffer.from(b64, 'base64');
}

const config = { provider: 'mock', demoClock: true, simDate: null, schedulerIntervalSec: 60, notify: {} };
const quietLog = { log: (...a) => console.info(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };
const store = new LocalStore();
const service = new Service({ store, key: tokenKey(), config });
service.notifier = createNotifier({ store, env: {}, log: quietLog, enabled: () => ({ ...service.settings.notifications, webhook: false }) });
service.provider = new MockProvider({ store, today: () => service.today(), fundingBalanceCents: () => service.settings.mock.fundingBalanceCents });
const bot = createBotApi({ service, store });
const locked = (actor, fn) => store.withLock(async () => { service.actor = actor; service.bootstrap(); try { return await fn(); } finally { service.actor = 'system'; } });
const fakeReq = () => ({ socket: { remoteAddress: 'this browser (demo)' }, headers: { 'user-agent': navigator.userAgent } });

// ---- Simulated AI bot: a real bot key, used through the real bot API (bot.handle), never shown in the UI ----
const botCall = (method, path, body) => store.withLock(async () => {
  service.bootstrap();
  const key = localStorage.getItem(K.bot) || '';
  return bot.handle({ method, pathname: path, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ip: 'sim-bot', readJson: async () => body || {} });
});
const SIM_BOT = {
  status: () => botCall('GET', '/bot/v1/status'),
  propose_raise: () => botCall('POST', '/bot/v1/goals/propose', { targetCents: (store.state.goal?.targetCents || 300000) + 50000, reason: 'You are ahead of schedule; aim $500 higher.' }),
  request_resume: () => botCall('POST', '/bot/v1/requests', { type: 'resume_schedule', reason: 'Balance looks healthy again.' }),
  pause: () => botCall('POST', '/bot/v1/schedule/pause', { reason: 'Funding balance looks low.' }),
  prepare_rollover: () => botCall('POST', '/bot/v1/rollovers/prepare', { mode: 'partial', withdrawCents: 100000, newTargetCents: 400000, reason: 'Take $1,000 for the mattress, relock the rest toward $4,000.' }),
  try_unlock: () => botCall('POST', '/bot/v1/requests', { type: 'unlock', reason: 'Please unlock early.' }),
  try_lower: () => botCall('POST', '/bot/v1/goals/propose', { targetCents: Math.max(100, (store.state.goal?.targetCents || 300000) - 100000), reason: 'Lower the goal.' }),
  try_disable_hard_lock: () => botCall('POST', '/bot/v1/requests', { type: 'disable_hard_lock' }),
  try_production: () => botCall('POST', '/bot/v1/requests', { type: 'switch_production' }),
  try_delete_audit: () => botCall('DELETE', '/bot/v1/audit'),
};

const extraRoutes = {
  // Auth: the demo has no passcode; state never leaves this browser.
  'GET /api/auth/status': async () => ({ setup: true, loggedIn: true }),
  'POST /api/auth/setup': async () => ({ ok: true }),
  'POST /api/auth/login': async () => ({ ok: true }),
  'POST /api/auth/logout': async () => ({ ok: true }),
  'POST /api/demo/bot': async ({ body }) => {
    if (body.action === 'new_key') {
      // The USER gives the simulated bot a key (same as More > Bot > New key); it is stored for the sim bot only.
      const r = service.createBotKey({ name: 'Grok (simulated)', scopes: ['read', 'propose', 'pause', 'request'] });
      localStorage.setItem(K.bot, r.key);
      return { action: 'new_key', httpStatus: 201, body: { id: r.id, scopes: r.scopes, note: 'Key handed to the simulated bot. Not shown.' } };
    }
    return { deferred: body.action };
  },
  'POST /api/demo/wipe': async () => { localStorage.removeItem(K.state); localStorage.removeItem(K.bot); store.load(); service.bootstrap(); return { ok: true }; },
};
const routes = { ...createRoutes({ store, service, config }), ...extraRoutes };
const baseState = routes['GET /api/state'];
routes['GET /api/state'] = async (ctx) => ({ ...(await baseState(ctx)), simulation: true, simBot: { hasKey: !!localStorage.getItem(K.bot), actions: Object.keys(SIM_BOT) } });

async function dispatch(method, pathname, body) {
  const name = `${method} ${pathname}`;
  const route = routes[name];
  if (!route) return [404, { error: 'not_found' }];
  try {
    let out = await locked('user', () => route({ req: fakeReq(), res: { setHeader() {} }, body: body || {} }));
    if (out && out.deferred) {
      // Sim-bot calls take the store lock themselves (like /bot/v1 on the server), so run them outside the user lock.
      const fn = SIM_BOT[out.deferred];
      if (!fn) return [400, { error: 'bad_action' }];
      if (!localStorage.getItem(K.bot) && !store.state.botKeys.length) await locked('user', async () => extraRoutes['POST /api/demo/bot']({ body: { action: 'new_key' } }));
      const r = await fn();
      out = { action: out.deferred, httpStatus: r.status, body: r.body };
    }
    return [200, out ?? { ok: true }];
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return [status, { error: err.code || 'error', message: err.message, ...(err.extra || {}) }];
  }
}

/** Drop-in for fetch() used by public/js/app.js (window.LDB_TRANSPORT). */
window.LDB_TRANSPORT = async (url, init = {}) => {
  const u = new URL(url, location.href);
  const path = u.pathname.replace(/^.*?(\/(api|bot)\/)/, '$1');
  if (!/^\/(api|bot)\//.test(path)) return fetch(url, init);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  const [status, out] = await dispatch(method, path, body);
  return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
};

// Unattended engine, as on the server: one pass now, then every 60 s while the page is open.
const tick = () => locked('system', () => service.tickAll()).catch((e) => console.warn('[engine]', e.message));
window.LDB_READY = tick();
setInterval(() => { if (!document.hidden) tick(); }, 60_000);
window.LDB_DEMO = { store, service, AppError };
