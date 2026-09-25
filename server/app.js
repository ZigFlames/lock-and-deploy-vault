// HTTP layer: static files + user JSON API (/api, passcode session) + bot API (/bot/v1, bearer keys).
// No framework; one dependency (plaid) loaded only in plaid-sandbox mode.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { loadKey } from './crypto.js';
import { Service, AppError } from './service.js';
import { createProvider } from './providers/index.js';
import { ProviderError } from './providers/BankProvider.js';
import { createNotifier } from './notifiers/index.js';
import { createBotApi } from './bot.js';
import { scryptHash, scryptVerify, sha256hex, randomToken } from './secrets.js';
import { createRoutes } from './routes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const cspFor = (provider) => (provider === 'plaid-sandbox' ? [
  "default-src 'self'", "script-src 'self' https://cdn.plaid.com", "frame-src https://cdn.plaid.com https://*.plaid.com",
  "connect-src 'self' https://sandbox.plaid.com https://*.plaid.com", "img-src 'self' data: https://*.plaid.com", "style-src 'self' 'unsafe-inline'",
] : ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "img-src 'self' data:", "style-src 'self'"])
  .concat(["base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]).join('; ');

const SESSION_COOKIE = 'ldb_session';
const SESSION_DAYS = 30;
const PUBLIC_ROUTES = new Set(['GET /api/auth/status', 'POST /api/auth/setup', 'POST /api/auth/login', 'POST /api/auth/logout']);

export async function createApp(config, { plaidClient, log = console, env = process.env } = {}) {
  const store = new Store(config.dataDir);
  const { key } = loadKey(config.tokenKey, config.dataDir, log);
  const service = new Service({ store, key, config });
  service.notifier = createNotifier({ store, env: { NOTIFY_WEBHOOK_URL: config.notify?.webhookUrl, NOTIFY_WEBHOOK_SECRET: config.notify?.webhookSecret }, log, enabled: () => service.settings.notifications });
  service.provider = await createProvider({ config, store, today: () => service.today(), plaidClient, fundingBalanceCents: () => service.settings.mock.fundingBalanceCents });
  const bot = createBotApi({ service, store });
  const loginFailures = [];

  /** Every state access goes through here: cross-process lock, fresh state, bootstrap, actor, save. */
  const locked = (actor, fn) => store.withLock(async () => { service.actor = actor; service.bootstrap(); try { return await fn(); } finally { service.actor = 'system'; } });

  const sessionOf = (req) => {
    const m = /(?:^|;\s*)ldb_session=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || '');
    if (!m) return null;
    const h = sha256hex(m[1]);
    return store.state.sessions.find((x) => x.idHash === h && x.expiresAt > Date.now()) || null;
  };
  const newSession = (res) => {
    const token = randomToken(32);
    store.state.sessions = store.state.sessions.filter((x) => x.expiresAt > Date.now()).slice(-9);
    store.state.sessions.push({ idHash: sha256hex(token), createdAt: new Date().toISOString(), expiresAt: Date.now() + SESSION_DAYS * 86400_000 });
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
  };

  const routes = {
    // --- user auth (local passcode; the bot never gets this) ---
    'GET /api/auth/status': async ({ req }) => ({ setup: !!store.state.userAuth, loggedIn: !!sessionOf(req) }),
    'POST /api/auth/setup': async ({ body, res }) => {
      if (store.state.userAuth) throw new AppError(409, 'already_setup', 'A passcode is already set. Log in instead.');
      if (typeof body.passcode !== 'string' || body.passcode.length < 8) throw new AppError(400, 'weak_passcode', 'Choose a passcode of at least 8 characters.');
      store.state.userAuth = { passcodeHash: scryptHash(body.passcode), createdAt: new Date().toISOString() };
      service.audit('passcode_set', {}, 'user');
      newSession(res);
      return { ok: true };
    },
    'POST /api/auth/login': async ({ body, res }) => {
      const now = Date.now();
      while (loginFailures.length && now - loginFailures[0] > 15 * 60_000) loginFailures.shift();
      if (loginFailures.length >= 5) throw new AppError(429, 'rate_limited', 'Too many wrong passcodes. Try again in 15 minutes.');
      if (!store.state.userAuth || !scryptVerify(String(body.passcode || ''), store.state.userAuth.passcodeHash)) {
        loginFailures.push(now); service.audit('login_failed', {}, 'anonymous');
        throw new AppError(401, 'bad_passcode', 'Wrong passcode.');
      }
      newSession(res); service.audit('login', {}, 'user');
      return { ok: true };
    },
    'POST /api/auth/logout': async ({ req, res }) => {
      const s = sessionOf(req);
      if (s) store.state.sessions = store.state.sessions.filter((x) => x !== s);
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return { ok: true };
    },

    // Everything else is shared with the browser-only demo (demo/src/browser-server.js).
    ...createRoutes({ store, service, config }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (url.pathname.startsWith('/bot/')) {
        const out = await store.withLock(async () => { service.bootstrap(); return bot.handle({ method: req.method, pathname: url.pathname, headers: req.headers, ip: req.socket.remoteAddress, readJson: async () => JSON.parse((await readBody(req)) || '{}') }); });
        return json(res, out.status, out.body);
      }
      if (url.pathname.startsWith('/api/webhooks/')) return await handleWebhook(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        const name = `${req.method} ${url.pathname}`;
        const route = routes[name];
        if (!route) return json(res, 404, { error: 'not_found' });
        let body = {};
        if (req.method === 'POST') {
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'bad_origin', message: 'Cross-origin request refused' });
          if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json_required' });
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
          if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
        }
        if (/^Bearer\s+ldbk_/i.test(req.headers.authorization || '')) return json(res, 403, { error: 'bot_key_not_accepted', message: 'Bot keys only work on /bot/v1. The user API needs the user\'s own session.' });
        const out = await locked('user', async () => {
          if (!PUBLIC_ROUTES.has(name) && !sessionOf(req)) throw new AppError(401, store.state.userAuth ? 'login_required' : 'setup_required', 'Log in with your passcode.');
          return route({ req, res, body });
        });
        return json(res, 200, out ?? { ok: true });
      }
      return serveStatic(url.pathname, res, cspFor(config.provider));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 500);
      if (status >= 500) log.error?.(err);
      return json(res, status, { error: err.code || 'error', message: err.message, ...(err.extra || {}) });
    }
  });

  async function handleWebhook(req, res, url) {
    const provider = url.pathname.split('/').pop();
    if (req.method !== 'POST' || provider !== service.provider.id) return json(res, 404, { error: 'not_found' });
    const rawBody = await readBody(req);
    await locked('provider', async () => {
      const r = await service.provider.handleWebhook({ headers: req.headers, rawBody });
      await service.applyUpdates(r.updates || []);
      service.audit('webhook_received', { provider, updates: (r.updates || []).length });
    });
    return json(res, 200, { ok: true });
  }

  /** One unattended engine pass (timer and `npm run tick`). */
  const tick = ({ advanceDays = 0 } = {}) => locked('system', async () => {
    if (advanceDays > 0) await service.advanceClock(advanceDays); else await service.tickAll();
    const t = service.totals();
    return { today: service.today(), schedule: store.state.schedule?.status || null, goal: store.state.goal?.status, transfers: store.state.transfers.length, vaultCents: t.vaultCents, pendingCents: t.pendingCents };
  });

  let timer = null;
  const startScheduler = () => {
    const run = () => tick().catch((e) => log.error?.('[scheduler]', e.message));
    run();
    timer = setInterval(run, Math.max(5, config.schedulerIntervalSec) * 1000);
  };
  const stop = () => new Promise((r) => { clearInterval(timer); server.close(() => r()); });
  return { server, service, store, bot, tick, locked, startScheduler, stop };
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function serveStatic(pathname, res, csp) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': csp });
  fs.createReadStream(file).pipe(res);
}
export { ProviderError };
