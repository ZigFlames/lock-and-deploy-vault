// Pluggable milestone/event notifiers. A notifier is { name, send(event) }; event = { type, title, body, at, data }.
// Built in: console (server log), inApp (banner stored in state.notifications), webhook (optional POST to
// NOTIFY_WEBHOOK_URL, HMAC-signed when NOTIFY_WEBHOOK_SECRET is set).
// Future channels (web push, email, SMS) plug in via registerNotifier(name, factory) without touching the engine.
// Notifications NEVER contain unlock codes, tokens or account numbers.
import crypto from 'node:crypto';

const registry = new Map();
export function registerNotifier(name, factory) { registry.set(name, factory); }
export function listNotifiers() { return [...registry.keys()]; }

registerNotifier('console', ({ log }) => ({
  name: 'console',
  send: (e) => log.log?.(`[notify] ${e.type}: ${e.title}${e.body ? ` - ${e.body}` : ''}`),
}));

registerNotifier('inApp', ({ store }) => ({
  name: 'inApp',
  send: (e) => {
    const s = store.state;
    s.notifications.unshift({ id: `ntf_${crypto.randomBytes(6).toString('hex')}`, type: e.type, title: e.title, body: e.body, at: e.at, clockDate: e.clockDate, dismissedAt: null });
    s.notifications = s.notifications.slice(0, 100);
  },
}));

registerNotifier('webhook', ({ env, log }) => ({
  name: 'webhook',
  send: async (e) => {
    const url = env.NOTIFY_WEBHOOK_URL;
    if (!url) return;
    const body = JSON.stringify({ type: e.type, title: e.title, body: e.body, at: e.at });
    const headers = { 'Content-Type': 'application/json' };
    if (env.NOTIFY_WEBHOOK_SECRET) headers['X-LDB-Signature'] = crypto.createHmac('sha256', env.NOTIFY_WEBHOOK_SECRET).update(body).digest('hex');
    try { await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) }); } catch (err) { log.warn?.(`[notify] webhook failed: ${err.message}`); }
  },
}));

/** Build the dispatcher. `enabled()` returns the current settings.notifications map. */
export function createNotifier({ store, env = {}, log = console, enabled, extra = [] }) {
  const channels = new Map([...registry].map(([name, f]) => [name, f({ store, env, log })]));
  for (const n of extra) channels.set(n.name, n);
  return {
    channels,
    /** Channels are invoked synchronously in order (so the in-app banner lands in the same locked write);
     *  async channels (webhook) finish in the background and never block or fail the engine. */
    notify(event) {
      const on = enabled();
      const e = { at: new Date().toISOString(), ...event };
      const pending = [];
      for (const [name, ch] of channels) {
        const isExtra = !!extra.find((x) => x.name === name);
        if (!(on[name] === true || (on[name] === undefined && isExtra))) continue;
        try { const r = ch.send(e); if (r && typeof r.then === 'function') pending.push(r.catch((err) => log.warn?.(`[notify] ${name}: ${err.message}`))); } catch (err) { log.warn?.(`[notify] ${name}: ${err.message}`); }
      }
      return Promise.all(pending);
    },
  };
}
