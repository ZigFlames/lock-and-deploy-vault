import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

export const TEST_PASSCODE = 'correct-horse-battery';

/** Start the app on a random port with a temp data dir. `call` is logged in as the user (session cookie). */
export async function startApp(envOverrides = {}, opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ldb-test-'));
  const config = buildConfig({ PROVIDER: 'mock', DATA_DIR: dataDir, PORT: '0', SCHEDULER_INTERVAL_SECONDS: '3600', ...envOverrides });
  const quiet = { warn() {}, error() {}, log() {} };
  const app = await createApp(config, { log: quiet, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const raw = async (p, body, headers = {}, method) => {
    const init = body === undefined && !method ? { headers } : { method: method || 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) };
    const res = await fetch(base + p, init);
    const data = await res.json().catch(() => null);
    return { status: res.status, data, headers: res.headers };
  };
  const call = async (p, body, headers = {}) => {
    const r = await raw(p, body, { ...(cookie ? { Cookie: cookie } : {}), ...headers });
    const sc = r.headers.get('set-cookie');
    if (sc && /ldb_session=[^;]+/.test(sc)) cookie = sc.match(/ldb_session=[^;]*/)[0];
    return { status: r.status, data: r.data };
  };
  if (opts.login !== false) {
    const st = (await call('/api/auth/status')).data;
    const r = st.setup ? await call('/api/auth/login', { passcode: TEST_PASSCODE }) : await call('/api/auth/setup', { passcode: TEST_PASSCODE });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
  }
  const bot = (key) => async (p, body, method) => raw(p, body, { Authorization: `Bearer ${key}` }, method);
  const close = async () => { await app.stop(); if (!opts.dataDir && !opts.keepDir) fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { app, base, call, raw, bot, dataDir, close };
}

/** Link both mock banks, assign 4821 -> 9034, set the default goal and a schedule, acknowledge + authorize. */
export async function setupActive(call, { amountCents = 50000, schedule, goal } = {}) {
  await call('/api/link/exchange', { publicToken: 'mock-public-mock_goldcoast-abc12345' });
  await call('/api/link/exchange', { publicToken: 'mock-public-mock_harbor-def67890' });
  let st = (await call('/api/state')).data;
  const funding = st.accounts.find((a) => a.mask === '4821');
  const savings = st.accounts.find((a) => a.mask === '9034');
  await call('/api/accounts/roles', { fundingAccountId: funding.id, destinationAccountId: savings.id });
  if (goal) { const r = await call('/api/goal', goal); if (r.status !== 200) throw new Error(JSON.stringify(r.data)); }
  const r1 = await call('/api/schedule', schedule || { amountCents, frequency: 'weekly', anchorDate: st.today });
  if (r1.status !== 200) throw new Error(JSON.stringify(r1.data));
  await call('/api/benefit-ack', { accepted: true, version: st.benefitWarning.version });
  const text = (await call('/api/authorization/text', { signerName: 'Lance Test' })).data;
  const r = await call('/api/authorization', { accepted: true, textHash: text.textHash, signerName: 'Lance Test' });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  st = (await call('/api/state')).data;
  return { st, funding, savings };
}

/** Advance the demo clock until pred(state) or the day limit. */
export async function advanceUntil(call, pred, maxDays = 400, step = 1) {
  let st = (await call('/api/state')).data;
  for (let d = 0; d < maxDays && !pred(st); d += step) { await call('/api/sandbox/clock/advance', { days: step }); st = (await call('/api/state')).data; }
  return st;
}
