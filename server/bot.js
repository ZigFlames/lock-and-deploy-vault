// Bot API (/bot/v1/*) for an AI assistant. Separate from the user API (/api/*), which bot keys can't use.
//
// Auth: `Authorization: Bearer ldbk_<id>.<secret>`. Keys are random (256-bit secret), shown once, stored as
// SHA-256, scoped (read | propose | pause | request), revocable, and rate-limited per key (token bucket,
// settings.bot.rateLimitPerMinute) plus a per-IP limit on failed authentication.
// Every call (including refused ones) is written to state.botActivity AND the hash-chained audit log, both
// visible in the app. There are no DELETE/PUT/PATCH routes: a bot can't remove or edit anything.
//
// What a bot can do directly: read status/goals/transfers/schedule/approvals, and pause future deposits.
// Everything sensitive becomes a PENDING APPROVAL that only runs after the user approves it in the app
// (with explicit confirmation, and the unlock code for anything that withdraws).
// What a bot can never do (enforced here AND by the user API requiring a session): see tokens/credentials,
// unlock or bypass the lock, request a hardship release, loosen a locked goal, disable emergency controls,
// switch to production, delete/hide audit entries or transactions.
// Go Blind: while it is on, EVERY bot response has amounts nulled and money text replaced (blindMode: true).
// A bot may turn Go Blind ON (safe direction) but can never turn it off or read the hidden amounts.
import { AppError } from './service.js';
import { sha256hex, safeEqualHex } from './secrets.js';
import { validatePatch, BOT_FORBIDDEN_SETTINGS } from './settings.js';

export const FORBIDDEN_REQUEST_TYPES = ['unlock', 'early_unlock', 'bypass_lock', 'hardship_release', 'disable_hard_lock', 'lower_goal',
  'switch_production', 'enable_real_money', 'disable_emergency', 'disable_emergency_stop', 'delete_audit', 'edit_audit', 'hide_transaction',
  'delete_transaction', 'read_tokens', 'read_credentials', 'create_bot_key', 'raise_rate_limit_self',
  'blind_off', 'disable_blind', 'turn_off_blind', 'remove_stay_blind', 'reveal_amounts', 'show_amounts', 'read_hidden_amounts'];
export const REQUEST_TYPES = ['resume_schedule', 'schedule_change', 'change_funding_account', 'revoke_authorization', 'grant_authorization', 'settings_change', 'withdrawal'];

const KEY_RE = /^ldbk_([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

function transferView(t) {
  return { id: t.id, date: t.date, amountCents: t.amountCents, status: t.status, history: t.history.map(({ status, clockDate }) => ({ status, clockDate })),
    failure: t.failureReason ? { code: t.failureReason.achReturnCode || null, description: t.failureReason.description || null } : null,
    funding: `${t.funding.name} ••${t.funding.mask}`, destination: `${t.destination.name} ••${t.destination.mask}`, creditLeg: t.credit?.status || null };
}
function goalView(service) {
  const g = service.goalView(); if (!g) return null;
  return { ...pick(g, ['id', 'cycle', 'name', 'targetCents', 'releaseDate', 'unlockRule', 'hardLock', 'status', 'lockedAt', 'reachedOn', 'remainingCents', 'progressSettled', 'draft']),
      hardshipEnabled: g.hardship.enabled, milestones: g.milestones.map(({ label, targetCents, reachedOn }) => ({ label, targetCents, reachedOn: reachedOn || null })) };
}
function scheduleView(service) {
  const s = service.scheduleView(); if (!s) return null;
  return { ...pick(s, ['id', 'amountCents', 'frequency', 'benefitType', 'offsetDays', 'dayOfMonth', 'anchorDate', 'status', 'pausedReason', 'completedReason', 'description', 'nextPulls']),
    recentPeriods: s.periods.map(({ date, status, attempts, reasons }) => ({ date, status, attempts, lastReason: reasons.at(-1)?.reason || null })),
    authorization: service.s.authorization ? { status: service.s.authorization.status, acceptedAt: service.s.authorization.acceptedAt } : null };
}
const approvalView = (a) => pick(a, ['id', 'type', 'payload', 'summary', 'status', 'createdOn', 'expiresOn', 'requiresUnlockCode', 'decidedAt', 'error']);

export function createBotApi({ service, store }) {
  const buckets = new Map();     // keyId -> { tokens, at }
  const failures = new Map();    // ip -> [timestamps]

  const R = {
    'GET /bot/v1/status': { scope: 'read', fn: () => {
      const t = service.totals();
      return { today: service.today(), sandbox: true, realMoneyEnabled: false, goal: goalView(service),
        balances: { settledLockedCents: t.vaultCents, pendingCents: t.pendingCents, returnedCents: t.returnedCents, withdrawnCents: t.withdrawalsCents },
        schedule: scheduleView(service), pendingApprovals: service.s.approvals.filter((a) => a.status === 'pending').length,
        goalReached: service.s.goal?.status === 'unlocked', blindMode: service.blindRedactBot(), benefitsAlert: service.benefitsAlert()?.level || null,
        note: 'Balances: only SETTLED deposits count toward the lock. Pending is shown separately.' };
    } },
    'GET /bot/v1/goals': { scope: 'read', fn: () => ({ active: goalView(service), cycles: service.s.cycles.map((c) => pick(c, ['cycle', 'name', 'targetCents', 'reachedOn', 'closedOn', 'mode', 'withdrawCents', 'remainingCents', 'nextTargetCents'])) }) },
    'GET /bot/v1/transfers': { scope: 'read', fn: () => ({ transfers: service.s.transfers.slice(0, 100).map(transferView), withdrawals: service.s.withdrawals.map((w) => pick(w, ['id', 'kind', 'amountCents', 'clockDate', 'cycle', 'simulated'])) }) },
    'GET /bot/v1/schedule': { scope: 'read', fn: () => ({ schedule: scheduleView(service) }) },
    'GET /bot/v1/approvals': { scope: 'read', fn: () => ({ approvals: service.s.approvals.slice(0, 50).map(approvalView) }) },
    'GET /bot/v1/activity': { scope: 'read', fn: ({ key }) => ({ activity: service.s.botActivity.filter((a) => a.keyId === key.id).slice(-50).reverse() }) },

    'POST /bot/v1/goals/propose': { scope: 'propose', fn: ({ body, key }) => {
      const g = service.s.goal;
      if (!g || g.status !== 'saving') throw new AppError(409, 'use_rollover', 'The goal is complete; use /bot/v1/rollovers/prepare.');
      const bad = Object.keys(body).filter((k) => !['name', 'targetCents', 'releaseDate', 'milestonesCents', 'reason'].includes(k));
      if (bad.length) throw new AppError(403, 'forbidden_for_bot', `Bots can't propose changes to: ${bad.join(', ')} (lock mechanics are user-only).`);
      const payload = pick(body, ['name', 'targetCents', 'releaseDate', 'milestonesCents']);
      if (!Object.keys(payload).length) throw new AppError(400, 'empty', 'Nothing to propose.');
      if (service.isLocked(g) && ((payload.targetCents !== undefined && payload.targetCents < g.targetCents) || (payload.releaseDate !== undefined && payload.releaseDate < g.releaseDate))) {
        service.audit('lock_loosening_refused', { attempted: 'bot proposal', payload });
        throw new AppError(403, 'lock_loosening_blocked', 'A locked goal can only be raised or extended.');
      }
      const summary = `Change goal: ${payload.targetCents !== undefined ? `target ${money(g.targetCents)} → ${money(payload.targetCents)}` : ''}${payload.name ? ` name "${payload.name}"` : ''}${payload.releaseDate ? ` release ${payload.releaseDate}` : ''}${payload.milestonesCents ? ` milestones ${payload.milestonesCents.map(money).join(', ')}` : ''}${body.reason ? ` (bot: ${String(body.reason).slice(0, 140)})` : ''}`;
      return { httpStatus: 202, body: { approval: approvalView(service.createApproval({ type: 'goal_change', payload, summary, key })), next: 'Waiting for the user to approve in the app (Inbox).' } };
    } },
    'POST /bot/v1/rollovers/prepare': { scope: 'propose', fn: ({ body, key }) => {
      const mode = body.mode || 'partial';
      const payload = { mode, withdrawCents: body.withdrawCents ?? 0, newTargetCents: body.newTargetCents, ...(body.milestonesCents ? { milestonesCents: body.milestonesCents } : {}), ...(body.fullAction ? { fullAction: body.fullAction } : {}) };
      const g = service.s.goal;
      if (g?.status === 'saving' && mode !== 'raise') throw new AppError(423, 'vault_locked', 'The vault is locked until the settled balance reaches the goal. Only a raise can be prepared now.');
      const preview = service.rolloverPreview(payload);
      if (preview.errors.length && !(mode === 'full')) throw new AppError(400, 'bad_rollover', preview.errors.join(' '), { preview });
      const summary = mode === 'raise' ? `Raise goal to ${money(preview.newTargetCents)} without withdrawing`
        : mode === 'full' ? `Withdraw all ${money(preview.withdrawCents)} and ${payload.fullAction || service.settings.rollover.fullWithdrawal} the goal`
        : `Roll over: withdraw ${money(preview.withdrawCents)}, keep ${money(preview.remainingCents)} locked, new goal ${money(preview.newTargetCents)} (${money(preview.additionalNeededCents)} more)`;
      return { httpStatus: 202, body: { preview, approval: approvalView(service.createApproval({ type: 'rollover', payload, summary, key })), next: preview.requiresUnlockCode ? 'The user must approve in the app and enter the unlock code.' : 'The user must approve in the app.' } };
    } },
    'POST /bot/v1/schedule/pause': { scope: 'pause', fn: () => ({ ...service.pause('bot'), note: 'Future deposits paused. Saved money and the lock are unchanged. Only the user can resume (or approve a resume request).' }) },
    'POST /bot/v1/blind/on': { scope: 'pause', fn: async ({ body }) => ({ blind: await service.blindOn({ confirm: true, stayUntilGoal: !!body.stayUntilGoal }, { by: 'bot' }), note: 'Go Blind is on: amounts are hidden from the user and from you. Only the user can turn it off, with the passcode.' }) },
    'POST /bot/v1/blind/off': { scope: 'read', fn: ({ key }) => {
      service.audit('bot_forbidden_request', { type: 'blind_off', keyId: key.id });
      throw new AppError(403, 'forbidden_for_bot', 'Only the user can turn Go Blind off, with the passcode. Bots never can.');
    } },
    'POST /bot/v1/requests': { scope: 'request', fn: ({ body, key }) => {
      const type = String(body.type || '');
      if (FORBIDDEN_REQUEST_TYPES.includes(type)) {
        service.audit('bot_forbidden_request', { type, keyId: key.id });
        throw new AppError(403, 'forbidden_for_bot', `"${type}" is never available to a bot.`);
      }
      if (!REQUEST_TYPES.includes(type)) throw new AppError(400, 'bad_type', `type must be one of: ${REQUEST_TYPES.join(', ')}`);
      const p = body.payload || {};
      let payload = {}, summary = '';
      if (type === 'withdrawal') {
        if (service.s.goal?.status !== 'unlocked') throw new AppError(423, 'vault_locked', 'Withdrawals are locked until the settled balance reaches the goal. There is no override.');
        if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new AppError(400, 'bad_amount', 'payload.amountCents required');
        payload = { amountCents: p.amountCents }; summary = `Withdraw ${money(p.amountCents)} from the unlocked vault`;
      } else if (type === 'schedule_change') {
        payload = pick(p, ['amountCents', 'frequency', 'benefitType', 'benefitDay', 'offsetDays', 'dayOfMonth', 'anchorDate']);
        summary = `Change schedule${payload.amountCents ? ` to ${money(payload.amountCents)}` : ''}${payload.frequency ? ` ${payload.frequency}` : ''} (needs a new ACH authorization)`;
      } else if (type === 'change_funding_account') {
        const a = service.account(p.fundingAccountId);
        if (!a) throw new AppError(400, 'bad_account', 'Unknown account id');
        payload = { fundingAccountId: a.id }; summary = `Pull from ${a.name} ••${a.mask} instead (needs a new ACH authorization)`;
      } else if (type === 'settings_change') {
        payload = p; summary = `Change settings: ${Object.keys(p).join(', ')}`;
        const { patch, errors } = validatePatch(p);
        const forbidden = Object.keys(patch).filter((k) => BOT_FORBIDDEN_SETTINGS.includes(k));
        if (forbidden.length) { service.audit('bot_forbidden_request', { type, keys: forbidden, keyId: key.id }); throw new AppError(403, 'forbidden_for_bot', `Bots can't change: ${forbidden.join(', ')}`); }
        if (errors.length) throw new AppError(400, 'bad_settings', errors.join(' '));
        payload = patch;
      } else {
        summary = { resume_schedule: 'Resume future deposits', revoke_authorization: 'Revoke the ACH authorization (stops all future deposits)', grant_authorization: 'Re-authorize the ACH schedule (you will sign it yourself)' }[type];
      }
      if (body.reason) summary += ` (bot: ${String(body.reason).slice(0, 140)})`;
      return { httpStatus: 202, body: { approval: approvalView(service.createApproval({ type, payload, summary, key })), next: 'Waiting for the user to approve in the app (Inbox).' } };
    } },
  };

  function tooManyFailures(ip) {
    const now = Date.now();
    const list = (failures.get(ip) || []).filter((t) => now - t < 60_000);
    failures.set(ip, list);
    return list.length >= 10;
  }
  function takeToken(key) {
    const cap = service.settings.bot.rateLimitPerMinute;
    const now = Date.now();
    const b = buckets.get(key.id) || { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 60_000) * cap); b.at = now;
    if (b.tokens < 1) { buckets.set(key.id, b); return false; }
    b.tokens -= 1; buckets.set(key.id, b); return true;
  }

  /** Returns { status, body }. Runs inside store.withLock (called by app.js). */
  async function handle({ method, pathname, headers, ip, readJson }) {
    if (tooManyFailures(ip)) return { status: 429, body: { error: 'rate_limited', message: 'Too many failed bot authentications. Wait a minute.' } };
    const m = KEY_RE.exec(String(headers.authorization || '').replace(/^Bearer\s+/i, '').trim());
    const key = m && service.s.botKeys.find((k) => k.id === m[1]);
    const log = (status, extra = {}) => {
      const entry = { id: `ba_${service.s.botActivity.length + 1}`, at: new Date().toISOString(), clockDate: service.today(), keyId: key?.id || null, keyName: key?.name || null, method, path: pathname, status, ...extra };
      service.s.botActivity.push(entry);
      if (service.s.botActivity.length > 2000) service.s.botActivity = service.s.botActivity.slice(-2000);
      service.audit('bot_call', { keyId: entry.keyId, method, path: pathname, status, ...(extra.error ? { error: extra.error } : {}) }, key ? `bot:${key.id}` : 'bot:unauthenticated');
    };
    if (!m || !key || key.revokedAt || !safeEqualHex(sha256hex(m[2]), key.secretHash)) {
      failures.get(ip)?.push(Date.now()) ?? failures.set(ip, [Date.now()]);
      log(401, { error: key?.revokedAt ? 'revoked_key' : 'bad_key' });
      return { status: 401, body: { error: 'unauthorized', message: key?.revokedAt ? 'This bot key was revoked.' : 'Missing or invalid bot key.' } };
    }
    if (!takeToken(key)) { log(429, { error: 'rate_limited' }); return { status: 429, body: { error: 'rate_limited', message: `Limit is ${service.settings.bot.rateLimitPerMinute} calls/minute per key.` } }; }
    key.lastUsedAt = new Date().toISOString();
    if (!['GET', 'POST'].includes(method)) { log(405, { error: 'method_not_allowed' }); return { status: 405, body: { error: 'method_not_allowed', message: 'The bot API has no delete/edit operations. Audit entries and transactions cannot be removed.' } }; }
    const route = R[`${method} ${pathname}`];
    if (!route) { log(404, { error: 'not_found' }); return { status: 404, body: { error: 'not_found' } }; }
    if (!key.scopes.includes(route.scope)) { log(403, { error: 'insufficient_scope' }); return { status: 403, body: { error: 'insufficient_scope', message: `This key lacks the "${route.scope}" scope.` } }; }
    let body = {};
    if (method === 'POST') {
      if (!/^application\/json/.test(headers['content-type'] || '')) { log(415, { error: 'json_required' }); return { status: 415, body: { error: 'json_required' } }; }
      try { body = await readJson(); } catch { log(400, { error: 'bad_json' }); return { status: 400, body: { error: 'bad_json' } }; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    }
    const prevActor = service.actor;
    service.actor = `bot:${key.id}`;
    try {
      const out = await route.fn({ body, key });
      const status = out?.httpStatus || 200;
      const resBody = out?.httpStatus ? out.body : out;
      log(status, { summary: resBody?.approval ? `approval ${resBody.approval.type} ${resBody.approval.id}` : undefined });
      return { status, body: service.redactForBot(resBody) };
    } catch (e) {
      const status = e.status || 500;
      log(status, { error: e.code || 'error' });
      return { status, body: service.redactForBot({ error: e.code || 'error', message: e.message, ...(e.extra || {}) }) };
    } finally { service.actor = prevActor; }
  }

  return { handle, routes: Object.keys(R) };
}
