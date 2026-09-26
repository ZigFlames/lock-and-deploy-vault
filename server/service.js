// Core app logic: linking, roles, goal (Hard Lock), schedule, authorization, the automatic savings engine,
// vault unlock code, Roll Over & Relock, hardship release (opt-in, non-Hard-Lock goals only), emergency stop,
// bot keys + approvals. All money movement is sandbox/simulated; see assertSandboxMoneyMovement().
//
// Concurrency: the HTTP layer, the in-process timer and `npm run tick` call these methods inside
// store.withLock(), which serializes access across requests AND processes. Methods here never lock.
import { newId, encrypt, decrypt } from './crypto.js';
import { addDays, isValidDate, prettyDate, isBusinessDay, nextBusinessDay } from './dates.js';
import { pullDates, nextPullDates, validateSchedule, describeSchedule } from './schedule.js';
import { buildAuthorizationText, BENEFIT_ACK_VERSION, BENEFIT_WARNING } from './authorization.js';
import { REAL_MONEY_ENABLED } from './config.js';
import { effectiveSettings, validatePatch, applyPatch, BOT_FORBIDDEN_SETTINGS } from './settings.js';
import { appendAudit, verifyAudit } from './audit.js';
import { runRules, listRules } from './rules/index.js';
import { newUnlockCode, normalizeCode, scryptHash, scryptVerify, sha256hex, randomToken } from './secrets.js';
import { evaluateGates, unmetGates } from './golive.js';
import { redactDeep, redactText, emptyBlind, BLIND_MAX_FAILURES, BLIND_LOCKOUT_MS, BENEFITS_MESSAGES } from './blind.js';

// Security-relevant events always listed on the Log screen, never pushed out by routine pull/bot noise.
const KEY_AUDIT = /^(blind_|benefits_|authorization_|emergency_stop|lock_loosening|hardship_|goal_|vault_|unlock_code_|rollover_|settings_|real_transfer|withdrawal_|bot_key_|bot_forbidden|passcode_|login_failed|benefit_warning|approval_(approved|rejected))/;

export class AppError extends Error { constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; } }
const SSI_LIMIT_CENTS = 200000;
const IN_FLIGHT = ['pending', 'posted'];
const DISPUTE_CODES = ['R05', 'R07', 'R10', 'R11', 'R29']; // unauthorized / revoked: stop and review
export const HARDSHIP_PHRASE = 'I UNDERSTAND THIS BREAKS MY LOCK';
export const BOT_SCOPES = ['read', 'propose', 'pause', 'request'];
const localToday = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the box's time zone
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clampInt = (v) => Math.round(Number(v));

export class Service {
  constructor({ store, key, config, notifier = null }) {
    this.store = store; this.key = key; this.config = config; this.provider = null; this.notifier = notifier;
    this.actor = 'system';
    this.nowMs = () => Date.now(); // wall clock for rate limits (tests can override)
    // Who can turn Go Blind OFF. Server: the app passcode (scrypt). The browser demo swaps in its own
    // "Go Blind passcode" (PBKDF2 via WebCrypto) with needsSetup/setup.
    this.blindAuth = {
      kind: 'app_passcode',
      needsSetup: () => false,
      setup: null,
      verify: async (passcode) => !!this.s.userAuth && scryptVerify(String(passcode || ''), this.s.userAuth.passcodeHash),
    };
  }
  get s() { return this.store.state; }
  get settings() { return effectiveSettings(this.s.settings); }
  today() { return addDays(this.config.simDate || localToday(), this.s.clock?.offsetDays || 0); }
  audit(type, detail = {}, actor = this.actor) { return appendAudit(this.s.audit, { actor, type, detail, clockDate: this.today() }); }
  notify(type, title, body) { if (this.notifier) this.notifier.notify({ type, title, body, clockDate: this.today() }); }
  save() { this.store.save(); }
  account(id) { return this.s.accounts.find((a) => a.id === id); }
  accessTokenFor(accountId) {
    const a = this.account(accountId); const item = a && this.s.items.find((i) => i.id === a.itemId);
    if (!item) throw new AppError(400, 'no_account', 'Account not linked');
    return decrypt(this.key, item.accessTokenEnc);
  }
  assertSandboxMoneyMovement() {
    if (REAL_MONEY_ENABLED !== false || this.provider?.sandbox !== true) throw new AppError(403, 'production_guard', 'Refusing to create transfers outside sandbox.');
  }

  /** Idempotent housekeeping run at the start of every locked operation. */
  bootstrap() {
    if (this.s.__legacyAudit) {
      for (const e of this.s.__legacyAudit) appendAudit(this.s.audit, { actor: 'system', type: e.type, detail: { ...e.detail, legacyAt: e.at }, clockDate: e.clockDate });
      delete this.s.__legacyAudit;
      this.audit('state_migrated', { to: 2 }, 'system');
    }
    if (!this.s.goal || this.s.goal.__legacy) {
      const legacy = this.s.goal?.__legacy ? this.s.goal : null;
      this.s.goal = this.newGoal(legacy ? { name: legacy.name, targetCents: legacy.targetCents, releaseDate: legacy.releaseDate } : {});
      this.audit('goal_created', { name: this.s.goal.name, targetCents: this.s.goal.targetCents, hardLock: this.s.goal.hardLock, source: legacy ? 'migrated' : 'defaults' }, 'system');
    }
    this.expireApprovals();
  }

  // ---------- Linking ----------
  async createLinkToken(role) { return this.provider.createLinkToken({ userId: 'lance-local-user', role }); }

  async exchangePublicToken({ publicToken, metadata }) {
    if (!publicToken) throw new AppError(400, 'missing_public_token', 'public_token is required');
    const r = await this.provider.exchangePublicToken({ publicToken, metadata });
    const item = { id: newId('item'), provider: this.provider.id, institutionName: r.institutionName, providerItemId: r.providerItemId, accessTokenEnc: encrypt(this.key, r.accessToken), createdAt: new Date().toISOString() };
    const accts = await this.provider.listAccounts({ accessToken: r.accessToken });
    this.s.items.push(item);
    const added = accts.map((a) => ({ id: newId('acct'), itemId: item.id, providerAccountId: a.providerAccountId, name: a.name, mask: a.mask, subtype: a.subtype, institutionName: a.institutionName || item.institutionName }));
    this.s.accounts.push(...added);
    this.audit('bank_linked', { institution: item.institutionName, accounts: added.map((a) => `${a.name} ••${a.mask}`) });
    return { item: { id: item.id, institutionName: item.institutionName }, accounts: added };
  }

  async unlinkItem(itemId) {
    const item = this.s.items.find((i) => i.id === itemId);
    if (!item) throw new AppError(404, 'not_found', 'No such linked bank');
    const ids = this.s.accounts.filter((a) => a.itemId === itemId).map((a) => a.id);
    if (ids.includes(this.s.roles.fundingAccountId) || ids.includes(this.s.roles.destinationAccountId)) {
      if (this.s.schedule && ['active', 'paused'].includes(this.s.schedule.status)) throw new AppError(409, 'in_use', 'Revoke the authorization before unlinking an account in use.');
      this.s.roles = { fundingAccountId: null, destinationAccountId: null };
    }
    this.s.items = this.s.items.filter((i) => i.id !== itemId);
    this.s.accounts = this.s.accounts.filter((a) => a.itemId !== itemId);
    this.audit('bank_unlinked', { institution: item.institutionName });
  }

  assignRoles({ fundingAccountId, destinationAccountId }) {
    const f = this.account(fundingAccountId), d = this.account(destinationAccountId);
    if (!f || !d) throw new AppError(400, 'bad_account', 'Pick a funding account and a savings account from your linked accounts.');
    if (f.id === d.id) throw new AppError(400, 'same_account', 'Funding and savings must be different accounts.');
    const changed = this.s.roles.fundingAccountId !== f.id || this.s.roles.destinationAccountId !== d.id;
    this.s.roles = { fundingAccountId: f.id, destinationAccountId: d.id };
    if (changed) { this.invalidateAuthorization('accounts_changed'); this.audit('accounts_assigned', { funding: `${f.name} ••${f.mask}`, savings: `${d.name} ••${d.mask}` }); }
    return { reauthorizationRequired: changed };
  }

  // ---------- Goal (Hard Lock) ----------
  newGoal(input = {}, cycle = (this.s.cycles?.length || 0) + 1) {
    const st = this.settings;
    const hardLock = input.hardLock ?? st.hardLock.defaultOn;
    const hs = input.hardship || {};
    const g = {
      id: newId('goal'), cycle, name: String(input.name ?? st.goal.name).trim(), targetCents: input.targetCents ?? st.goal.targetCents,
      releaseDate: input.releaseDate ?? addDays(this.today(), st.goal.lockDays), unlockRule: input.unlockRule ?? st.goal.unlockRule,
      hardLock, hardship: { enabled: !hardLock && hs.enabled === true, coolingOffDays: hs.coolingOffDays ?? st.hardship.coolingOffDaysDefault },
      milestones: [], status: 'saving', createdAt: new Date().toISOString(), createdOn: this.today(), lockedAt: null, reachedAt: null, reachedOn: null, withdrawnSinceUnlockCents: 0,
    };
    g.milestones = this.buildMilestones(input.milestonesCents ?? st.goal.milestonesCents, g.targetCents, []);
    return g;
  }
  buildMilestones(list, targetCents, existing) {
    const uniq = [...new Set((list || []).map(clampInt))].filter((c) => Number.isInteger(c) && c > 0 && c < targetCents).sort((a, b) => a - b).slice(0, 10);
    return uniq.map((c) => existing.find((m) => m.targetCents === c) || { id: newId('ms'), label: `${money(c)} milestone`, targetCents: c, reachedAt: null });
  }
  isLocked(g = this.s.goal) { return !!(g && g.status === 'saving' && g.lockedAt); }

  /**
   * Create/edit the active goal. While the goal is LOCKED (authorized and saving), anything that loosens the
   * lock is refused with 423: lowering the target, turning Hard Lock off, adding a hardship release,
   * shortening the cooling-off period, moving the release date earlier, or dropping the date requirement.
   * Raising the target, adding time, adding milestones, renaming, and turning Hard Lock on are allowed.
   */
  setGoal(input = {}) {
    const g = this.s.goal;
    if (g && g.status !== 'saving') throw new AppError(409, 'use_rollover', 'This goal is complete. Use Roll Over & Relock (or close it) to start the next goal.');
    const next = {
      name: input.name !== undefined ? String(input.name).trim() : g.name,
      targetCents: input.targetCents !== undefined ? input.targetCents : g.targetCents,
      releaseDate: input.releaseDate !== undefined ? input.releaseDate : g.releaseDate,
      unlockRule: input.unlockRule !== undefined ? input.unlockRule : g.unlockRule,
      hardLock: input.hardLock !== undefined ? input.hardLock : g.hardLock,
      hardship: { enabled: input.hardship?.enabled !== undefined ? input.hardship.enabled : g.hardship.enabled,
        coolingOffDays: input.hardship?.coolingOffDays !== undefined ? clampInt(input.hardship.coolingOffDays) : g.hardship.coolingOffDays },
      milestonesCents: input.milestonesCents !== undefined ? input.milestonesCents : g.milestones.map((m) => m.targetCents),
    };
    if (!next.name || next.name.length > 60) throw new AppError(400, 'bad_goal', 'Give the goal a name (max 60 chars).');
    if (!Number.isInteger(next.targetCents) || next.targetCents < 100 || next.targetCents > 10000000) throw new AppError(400, 'bad_goal', 'Target must be between $1 and $100,000.');
    if (!isValidDate(next.releaseDate) || next.releaseDate <= this.today()) throw new AppError(400, 'bad_goal', 'Release date must be a future date.');
    if (!['goal', 'goal_and_date'].includes(next.unlockRule)) throw new AppError(400, 'bad_goal', 'Unknown unlock rule.');
    if (typeof next.hardLock !== 'boolean' || typeof next.hardship.enabled !== 'boolean') throw new AppError(400, 'bad_goal', 'hardLock / hardship.enabled must be true or false.');
    if (next.hardLock) next.hardship.enabled = false; // Hard Lock: no early release exists at all
    const minCool = this.settings.hardship.minCoolingOffDays;
    if (next.hardship.enabled && !(Number.isInteger(next.hardship.coolingOffDays) && next.hardship.coolingOffDays >= minCool && next.hardship.coolingOffDays <= 365)) {
      throw new AppError(400, 'bad_goal', `Hardship cooling-off must be ${minCool}-365 days.`);
    }
    if (this.isLocked(g)) {
      const loosen = [];
      if (next.targetCents < g.targetCents) loosen.push('lower the target');
      if (next.releaseDate < g.releaseDate) loosen.push('move the release date earlier');
      if (g.hardLock && next.hardLock === false) loosen.push('turn off Hard Lock');
      if (!g.hardship.enabled && next.hardship.enabled) loosen.push('add a hardship release');
      if (g.hardship.enabled && next.hardship.enabled && next.hardship.coolingOffDays < g.hardship.coolingOffDays) loosen.push('shorten the cooling-off period');
      if (g.unlockRule === 'goal_and_date' && next.unlockRule === 'goal') loosen.push('drop the release-date requirement');
      if (loosen.length) {
        this.audit('lock_loosening_refused', { attempted: loosen });
        throw new AppError(423, 'lock_loosening_blocked', `Locked goal: you can't ${loosen.join(', ')} while saving. You can raise the goal or add time.`, { attempted: loosen });
      }
    }
    const before = { name: g.name, targetCents: g.targetCents, releaseDate: g.releaseDate, unlockRule: g.unlockRule, hardLock: g.hardLock, hardship: { ...g.hardship }, milestones: g.milestones.map((m) => m.targetCents) };
    Object.assign(g, { name: next.name, targetCents: next.targetCents, releaseDate: next.releaseDate, unlockRule: next.unlockRule, hardLock: next.hardLock, hardship: next.hardship });
    g.milestones = this.buildMilestones(next.milestonesCents, g.targetCents, g.milestones);
    const after = { name: g.name, targetCents: g.targetCents, releaseDate: g.releaseDate, unlockRule: g.unlockRule, hardLock: g.hardLock, hardship: { ...g.hardship }, milestones: g.milestones.map((m) => m.targetCents) };
    if (JSON.stringify(before) !== JSON.stringify(after)) this.audit('goal_updated', { before, after, locked: this.isLocked(g) });
    this.checkMilestones();
    return g;
  }

  // ---------- Schedule ----------
  setSchedule(input) {
    const s = {
      amountCents: Math.round(Number(input.amountCents)), frequency: input.frequency, anchorDate: input.anchorDate || null,
      dayOfMonth: input.dayOfMonth != null ? Number(input.dayOfMonth) : null, benefitType: input.benefitType || null,
      benefitDay: input.benefitDay != null ? Number(input.benefitDay) : null, offsetDays: input.offsetDays != null ? Number(input.offsetDays) : null,
    };
    const errs = validateSchedule(s);
    if (errs.length) throw new AppError(400, 'bad_schedule', errs.join(' '));
    const prev = this.s.schedule;
    const same = prev && ['amountCents', 'frequency', 'anchorDate', 'dayOfMonth', 'benefitType', 'benefitDay', 'offsetDays'].every((k) => prev[k] === s[k]);
    if (same) return { reauthorizationRequired: false };
    this.s.schedule = { id: newId('sched'), ...s, status: 'needs_authorization', cursor: null, returnCount: 0, createdAt: new Date().toISOString() };
    this.invalidateAuthorization('schedule_changed');
    this.audit('schedule_saved', { description: describeSchedule(s) });
    return { reauthorizationRequired: true };
  }

  preview(input) {
    const s = { ...input, amountCents: Math.round(Number(input.amountCents)), dayOfMonth: input.dayOfMonth != null ? Number(input.dayOfMonth) : null,
      benefitDay: input.benefitDay != null ? Number(input.benefitDay) : null, offsetDays: input.offsetDays != null ? Number(input.offsetDays) : null };
    const errors = validateSchedule(s);
    if (errors.length) return { errors, dates: [] };
    const all = pullDates(s, this.today(), addDays(this.today(), 3650));
    const g = this.s.goal; const t = this.totals();
    const need = g ? Math.max(0, g.targetCents - t.vaultCents - t.pendingCents) : 0;
    const n = Math.ceil(need / s.amountCents);
    return { errors: [], dates: all.slice(0, 4), description: describeSchedule(s), projectedFinish: g ? (n > 0 ? all[n - 1] || null : this.today()) : null, pullsNeeded: g ? n : null };
  }

  invalidateAuthorization(reason) {
    const a = this.s.authorization;
    if (a && a.status === 'active') { a.status = 'superseded'; a.endedAt = new Date().toISOString(); a.endReason = reason; this.audit('authorization_superseded', { reason }); }
    if (this.s.schedule && ['active', 'paused', 'revoked'].includes(this.s.schedule.status)) this.s.schedule.status = 'needs_authorization';
  }

  // ---------- Authorization & benefit acknowledgement ----------
  readiness() {
    const missing = [];
    if (!this.s.roles.fundingAccountId || !this.s.roles.destinationAccountId) missing.push('accounts');
    if (!this.s.goal || this.s.goal.status === 'closed') missing.push('goal');
    if (!this.s.schedule) missing.push('schedule');
    return missing;
  }
  authorizationText(signerName) {
    const missing = this.readiness();
    if (missing.length) throw new AppError(409, 'not_ready', `Set up first: ${missing.join(', ')}`);
    const firstDate = nextPullDates(this.s.schedule, this.today(), 1)[0];
    return { ...buildAuthorizationText({ signerName, funding: this.account(this.s.roles.fundingAccountId), destination: this.account(this.s.roles.destinationAccountId), schedule: this.s.schedule, goal: this.s.goal, firstDate }), firstDate };
  }
  benefitWarning() { return { version: BENEFIT_ACK_VERSION, limitCents: SSI_LIMIT_CENTS, paragraphs: BENEFIT_WARNING }; }
  acknowledgeBenefit({ accepted, version }) {
    if (accepted !== true || version !== BENEFIT_ACK_VERSION) throw new AppError(400, 'ack_required', 'Read and acknowledge the benefit-limit warning.');
    this.s.benefitAck = { version, acceptedAt: new Date().toISOString() };
    this.audit('benefit_warning_acknowledged', { version });
  }

  authorize({ accepted, textHash, signerName, ip, userAgent }) {
    if (accepted !== true) throw new AppError(400, 'not_accepted', 'Check the authorization box to continue.');
    if (!signerName || String(signerName).trim().length < 2) throw new AppError(400, 'no_name', 'Type your full name.');
    if (!this.s.benefitAck || this.s.benefitAck.version !== BENEFIT_ACK_VERSION) throw new AppError(409, 'ack_required', 'Acknowledge the benefit-limit warning first.');
    const t = this.authorizationText(String(signerName).trim());
    if (t.textHash !== textHash) throw new AppError(409, 'text_changed', 'The authorization text changed. Review it again.');
    const f = this.account(this.s.roles.fundingAccountId), d = this.account(this.s.roles.destinationAccountId);
    if (this.s.authorization) this.s.authorizationHistory.push(this.s.authorization);
    this.s.authorization = {
      id: newId('achauth'), status: 'active', version: t.version, text: t.text, textHash: t.textHash,
      signerName: String(signerName).trim(), acceptedAt: new Date().toISOString(), clockDate: this.today(), ip, userAgent,
      snapshot: { scheduleId: this.s.schedule.id, amountCents: this.s.schedule.amountCents, description: describeSchedule(this.s.schedule),
        funding: { id: f.id, name: f.name, mask: f.mask }, destination: { id: d.id, name: d.name, mask: d.mask }, goal: { name: this.s.goal.name, targetCents: this.s.goal.targetCents } },
    };
    const g = this.s.goal;
    if (g.status === 'saving') {
      this.s.schedule.status = 'active';
      if (!g.lockedAt) { g.lockedAt = new Date().toISOString(); this.audit('goal_locked', { name: g.name, targetCents: g.targetCents, hardLock: g.hardLock, hardship: g.hardship }); }
    } else this.s.schedule.status = 'completed';
    this.s.schedule.activatedAt = new Date().toISOString();
    this.s.schedule.cursor = addDays(this.today(), -1);
    this.s.schedule.returnCount = 0;
    this.audit('authorization_accepted', { id: this.s.authorization.id, textHash: t.textHash, ip, userAgent });
    this.audit('schedule_activated', { firstDate: t.firstDate });
    return this.s.authorization;
  }

  revokeAuthorization() {
    const a = this.s.authorization;
    if (!a || a.status !== 'active') throw new AppError(409, 'no_active_auth', 'No active authorization.');
    a.status = 'revoked'; a.endedAt = new Date().toISOString(); a.endReason = 'revoked_by_user';
    if (this.s.schedule) this.s.schedule.status = 'revoked';
    const pending = this.s.transfers.filter((t) => t.status === 'pending').length;
    this.audit('authorization_revoked', { pendingTransfersLeftAsIs: pending, vaultUnchanged: true });
    return { pending };
  }

  // ---------- Pause / resume (future pulls only) ----------
  pause(reason = 'user') {
    const s = this.s.schedule;
    if (!s || s.status !== 'active') throw new AppError(409, 'not_active', 'Schedule is not active.');
    s.status = 'paused'; s.pausedAt = new Date().toISOString(); s.pausedReason = reason;
    const pending = this.s.transfers.filter((t) => t.status === 'pending').length;
    this.audit('schedule_paused', { reason, note: 'Future pulls stopped. Saved and in-flight funds untouched; the lock is unchanged.', pendingTransfers: pending });
    return { pending, status: 'paused' };
  }
  resume() {
    const s = this.s.schedule;
    if (!s || s.status !== 'paused') throw new AppError(409, 'not_paused', 'Schedule is not paused.');
    if (this.s.authorization?.status !== 'active') throw new AppError(409, 'no_active_auth', 'Authorization is not active; authorize again.');
    s.status = this.s.goal?.status === 'saving' ? 'active' : 'completed'; s.resumedAt = new Date().toISOString(); s.returnCount = 0;
    s.cursor = addDays(this.today(), -1); // skip dates missed while paused: no catch-up debits
    this.audit('schedule_resumed', { note: 'Missed dates skipped (no catch-up).' });
    return { status: s.status };
  }
  cancelSchedule() {
    const s = this.s.schedule;
    if (!s || ['cancelled'].includes(s.status)) throw new AppError(409, 'no_schedule', 'No schedule to cancel.');
    s.status = 'cancelled'; s.cancelledAt = new Date().toISOString();
    if (this.s.authorization?.status === 'active') { this.s.authorization.status = 'revoked'; this.s.authorization.endedAt = new Date().toISOString(); this.s.authorization.endReason = 'schedule_cancelled'; }
    this.audit('schedule_cancelled', { note: 'All future pulls cancelled and authorization ended. Saved money and the lock are unchanged.' });
    return { status: 'cancelled' };
  }

  // ---------- Totals ----------
  totals() {
    const sum = (list, f) => list.filter(f).reduce((n, t) => n + t.amountCents, 0);
    const settled = sum(this.s.transfers, (t) => t.status === 'settled');
    const pending = sum(this.s.transfers, (t) => IN_FLIGHT.includes(t.status));
    const returned = sum(this.s.transfers, (t) => t.status === 'returned');
    const withdrawn = sum(this.s.withdrawals, () => true);
    const vault = settled - withdrawn;
    // lockedCents / inFlightCents kept as aliases for phase-1 clients.
    return { settledDepositsCents: settled, withdrawalsCents: withdrawn, vaultCents: vault, pendingCents: pending, returnedCents: returned, lockedCents: vault, inFlightCents: pending };
  }

  // ---------- Automatic savings engine ----------
  businessDaysAfter(from, to) { let n = 0; for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isBusinessDay(d)) n++; return n; }

  async runScheduler() {
    const s = this.s.schedule, g = this.s.goal;
    if (!s || s.status !== 'active' || this.s.authorization?.status !== 'active' || !g || g.status !== 'saving') return [];
    this.assertSandboxMoneyMovement();
    const today = this.today();
    const from = addDays(s.cursor || addDays(today, -1), 1);
    if (from <= today) {
      for (const date of pullDates(s, from, today)) {
        const key = `${s.id}:${date}`;
        if (!this.s.periods[key]) this.s.periods[key] = { key, scheduleId: s.id, date, status: 'due', attempts: 0, reasons: [], transferId: null, registeredOn: today };
      }
      s.cursor = today;
    }
    const due = Object.values(this.s.periods)
      .filter((p) => p.scheduleId === s.id && (p.status === 'due' || p.status === 'creating' || (p.status === 'deferred' && p.nextAttemptOn <= today)))
      .sort((a, b) => a.date.localeCompare(b.date));
    const created = [];
    const st = this.settings;
    for (const p of due) {
      if (this.s.schedule.status !== 'active' || this.s.goal.status !== 'saving') break;
      const existing = this.s.transfers.find((t) => t.idempotencyKey === p.key);
      if (existing) { p.status = existing.status === 'failed' ? 'failed' : 'created'; p.transferId = existing.id; continue; }
      p.attempts++;
      const f = this.account(this.s.roles.fundingAccountId);
      const r = await runRules({ goal: g, totals: this.totals(), amountCents: s.amountCents, settings: st, date: p.date, today, schedule: s, transfers: this.s.transfers,
        getBalance: () => this.provider.getBalance({ accessToken: this.accessTokenFor(f.id), accountId: f.providerAccountId }) });
      if (r.action === 'hold') { p.status = 'skipped'; p.reasons.push({ on: today, rule: r.rule, reason: r.reason }); this.audit('pull_skipped', { period: p.date, reason: r.reason }); continue; }
      if (r.action === 'defer' || r.action === 'skip') {
        const waited = this.businessDaysAfter(p.date, today);
        const giveUp = r.action === 'skip' || waited >= st.safety.deferMaxBusinessDays;
        p.reasons.push({ on: today, rule: r.rule, reason: r.reason });
        if (giveUp) {
          p.status = 'skipped';
          this.audit('pull_skipped', { period: p.date, reason: r.reason, afterDeferrals: p.attempts - 1 });
          await this.notify('deposit_skipped', `Deposit for ${prettyDate(p.date)} skipped`, `${r.reason} Nothing was pulled. The next scheduled deposit will try again.`);
        } else {
          p.status = 'deferred'; p.nextAttemptOn = nextBusinessDay(addDays(today, 1));
          this.audit('pull_deferred', { period: p.date, reason: r.reason, nextAttemptOn: p.nextAttemptOn });
        }
        continue;
      }
      p.status = 'creating'; // write-ahead: a crash here retries with the same idempotency keys
      this.save();
      const pull = await this.createPull(p.date, r.amountCents, p.key);
      p.status = pull.status === 'failed' ? 'failed' : 'created'; p.transferId = pull.id;
      created.push(pull);
    }
    return created;
  }

  async createPull(date, amountCents, idem = `${this.s.schedule.id}:${date}`) {
    this.assertSandboxMoneyMovement();
    const f = this.account(this.s.roles.fundingAccountId), d = this.account(this.s.roles.destinationAccountId);
    const existing = this.s.transfers.find((t) => t.idempotencyKey === idem);
    if (existing) return existing;
    const pull = { id: newId('pull'), idempotencyKey: idem, date, createdAt: new Date().toISOString(), createdOn: this.today(), amountCents, direction: 'debit', goalId: this.s.goal?.id,
      funding: { id: f.id, name: f.name, mask: f.mask }, destination: { id: d.id, name: d.name, mask: d.mask },
      status: 'pending', history: [], providerTransferId: null, providerAuthorizationId: null, failureReason: null, credit: null };
    const token = this.accessTokenFor(f.id);
    const auth = await this.provider.createTransferAuthorization({ accessToken: token, accountId: f.providerAccountId, amountCents, direction: 'debit', legalName: this.s.authorization.signerName, idempotencyKey: `auth:${idem}` });
    pull.providerAuthorizationId = auth.authorizationId;
    if (auth.decision !== 'approved') {
      pull.status = 'failed'; pull.failureReason = { description: `Authorization ${auth.decision}: ${auth.rationale || ''}` };
    } else {
      const tr = await this.provider.createTransfer({ accessToken: token, accountId: f.providerAccountId, authorizationId: auth.authorizationId, amountCents, direction: 'debit', description: 'TRANSFER', idempotencyKey: `tr:${idem}`, metadata: { pull_id: pull.id } });
      pull.providerTransferId = tr.providerTransferId; pull.status = tr.status;
    }
    pull.history.push({ status: pull.status, at: new Date().toISOString(), clockDate: this.today() });
    this.s.transfers.unshift(pull);
    this.audit('pull_created', { pullId: pull.id, date, amountCents, status: pull.status });
    return pull;
  }

  async applyUpdates(updates) {
    for (const u of updates) {
      const pull = this.s.transfers.find((t) => t.providerTransferId === u.providerTransferId);
      if (pull) {
        if (pull.status === u.status) continue;
        pull.status = u.status; pull.failureReason = u.failureReason || pull.failureReason;
        pull.history.push({ status: u.status, at: new Date().toISOString(), clockDate: this.today() });
        this.audit('pull_status', { pullId: pull.id, status: u.status, failure: u.failureReason?.achReturnCode || u.failureReason?.description });
        if (u.status === 'settled' && this.provider.model === 'ledger' && !pull.credit) await this.createCreditLeg(pull);
        if (u.status === 'returned') await this.handleReturn(pull);
        continue;
      }
      const leg = this.s.transfers.find((t) => t.credit?.providerTransferId === u.providerTransferId);
      if (leg && leg.credit.status !== u.status) { leg.credit.status = u.status; this.audit('credit_leg_status', { pullId: leg.id, status: u.status }); }
    }
    this.checkMilestones();
  }

  async handleReturn(pull) {
    const code = pull.failureReason?.achReturnCode || 'R01';
    const s = this.s.schedule;
    await this.notify('deposit_returned', `Deposit of ${money(pull.amountCents)} was returned (${code})`, 'Returned money never counts toward your locked balance. It will not be retried automatically.');
    if (!s || s.status !== 'active') return;
    s.returnCount = (s.returnCount || 0) + 1;
    if (DISPUTE_CODES.includes(code)) {
      this.pause(`return_${code}`);
      this.audit('authorization_review_needed', { code, note: 'Unauthorized/revoked return. Deposits paused until you review.' });
      await this.notify('deposits_paused', 'Deposits paused for review', `The bank returned a deposit as ${code} (unauthorized or revoked).`);
    } else if (s.returnCount >= this.settings.safety.pauseAfterReturns) {
      this.pause('too_many_returns');
      await this.notify('deposits_paused', 'Deposits paused', `${s.returnCount} deposits were returned. Check the funding account, then resume.`);
    }
  }

  /** Ledger model only: pay the settled debit out to the destination account. */
  async createCreditLeg(pull) {
    this.assertSandboxMoneyMovement();
    const d = this.account(pull.destination.id);
    const token = this.accessTokenFor(d.id);
    const idem = `credit:${pull.idempotencyKey}`;
    const auth = await this.provider.createTransferAuthorization({ accessToken: token, accountId: d.providerAccountId, amountCents: pull.amountCents, direction: 'credit', legalName: this.s.authorization?.signerName, idempotencyKey: `auth:${idem}` });
    if (auth.decision !== 'approved') { pull.credit = { status: 'failed', reason: auth.rationale }; return; }
    const tr = await this.provider.createTransfer({ accessToken: token, accountId: d.providerAccountId, authorizationId: auth.authorizationId, amountCents: pull.amountCents, direction: 'credit', description: 'TRANSFER', idempotencyKey: `tr:${idem}`, metadata: { pull_id: pull.id, leg: 'credit' } });
    pull.credit = { providerTransferId: tr.providerTransferId, status: tr.status };
    this.audit('credit_leg_created', { pullId: pull.id });
  }

  // ---------- Milestones + unlock (settled balance only) ----------
  checkMilestones() {
    const g = this.s.goal; if (!g) return;
    const t = this.totals();
    if (g.status === 'saving') {
      for (const m of g.milestones) {
        if (!m.reachedAt && t.vaultCents >= m.targetCents) {
          m.reachedAt = new Date().toISOString(); m.reachedOn = this.today();
          this.audit('milestone_reached', { label: m.label, targetCents: m.targetCents, settledCents: t.vaultCents });
          this.notify('milestone', `Milestone: ${money(m.targetCents)} settled`, `${money(t.vaultCents)} of ${money(g.targetCents)} for "${g.name}". Still locked.`);
        }
      }
      const dateOk = g.unlockRule === 'goal' || this.today() >= g.releaseDate;
      if (g.lockedAt && t.vaultCents >= g.targetCents && dateOk) this.unlockGoal(t);
    } else if (g.status === 'unlocked' && t.vaultCents + (g.withdrawnSinceUnlockCents || 0) < g.targetCents) {
      // A settled deposit was returned after the goal was reached: the goal is no longer met, so relock.
      g.status = 'saving'; g.reachedAt = null; g.reachedOn = null;
      this.s.vault = { code: null, revealBlob: null };
      if (this.s.schedule?.status === 'completed' && this.s.schedule.completedReason === 'goal_reached' && this.s.authorization?.status === 'active') {
        this.s.schedule.status = 'active'; this.s.schedule.cursor = addDays(this.today(), -1); this.s.schedule.completedReason = null;
      }
      this.audit('goal_unlock_reversed', { settledCents: t.vaultCents, targetCents: g.targetCents, reason: 'deposit returned after goal reached' });
      this.notify('milestone_reversed', 'Vault relocked', 'A deposit was returned, so the settled balance is below the goal again. The unlock code was cancelled.');
    }
  }

  unlockGoal(t) {
    const g = this.s.goal;
    g.status = 'unlocked'; g.reachedAt = new Date().toISOString(); g.reachedOn = this.today(); g.withdrawnSinceUnlockCents = 0;
    const code = this.issueUnlockCode();
    this.s.vault.revealBlob = encrypt(this.key, code); // deleted the first time the user views it
    const s = this.s.schedule;
    if (s && ['active', 'paused'].includes(s.status)) { s.status = 'completed'; s.completedReason = 'goal_reached'; }
    this.audit('goal_reached', { name: g.name, targetCents: g.targetCents, settledCents: t.vaultCents, cycle: g.cycle });
    this.audit('vault_unlocked', { rule: g.unlockRule, codeExpiresOn: this.s.vault.code.expiresOn });
    this.notify('goal_reached', `Goal reached: ${money(t.vaultCents)} settled`, `"${g.name}" is complete and your vault is unlocked. Open the app to see your one-time unlock code.`);
  }

  issueUnlockCode() {
    const code = newUnlockCode();
    this.s.vault.code = { hash: scryptHash(normalizeCode(code)), issuedAt: new Date().toISOString(), issuedOn: this.today(),
      expiresOn: addDays(this.today(), this.settings.unlock.codeExpiryDays), attempts: 0, usedAt: null, goalId: this.s.goal.id };
    return code;
  }

  /** User only. Returns the code generated at unlock time exactly once. */
  revealUnlockCode() {
    if (this.s.goal?.status !== 'unlocked') throw new AppError(423, 'vault_locked', 'Hard Lock: the vault opens only when the settled balance reaches the goal.');
    if (!this.s.vault.revealBlob) throw new AppError(410, 'already_shown', 'The unlock code was already shown once. Generate a new one if you lost it.');
    const code = decrypt(this.key, this.s.vault.revealBlob);
    this.s.vault.revealBlob = null;
    this.audit('unlock_code_revealed', { expiresOn: this.s.vault.code.expiresOn });
    return { code, expiresOn: this.s.vault.code.expiresOn };
  }
  /** User only. Replaces the code (old one stops working). Only possible after the goal-based unlock. */
  regenerateUnlockCode() {
    if (this.s.goal?.status !== 'unlocked') throw new AppError(423, 'vault_locked', 'Hard Lock: the vault opens only when the settled balance reaches the goal.');
    const code = this.issueUnlockCode();
    this.s.vault.revealBlob = null;
    this.audit('unlock_code_regenerated', { expiresOn: this.s.vault.code.expiresOn });
    return { code, expiresOn: this.s.vault.code.expiresOn };
  }
  verifyUnlockCode(code) {
    const v = this.s.vault.code;
    if (this.s.goal?.status !== 'unlocked') throw new AppError(423, 'vault_locked', 'Hard Lock: the vault opens only when the settled balance reaches the goal.');
    if (!v || v.goalId !== this.s.goal.id) throw new AppError(409, 'no_code', 'No unlock code has been issued.');
    if (v.usedAt) throw new AppError(410, 'code_used', 'That unlock code was already used. Generate a new one.');
    if (this.today() > v.expiresOn) throw new AppError(410, 'code_expired', 'The unlock code expired. Generate a new one.');
    if (v.attempts >= this.settings.unlock.maxAttempts) throw new AppError(429, 'code_locked', 'Too many wrong codes. Generate a new one.');
    if (!code || !scryptVerify(normalizeCode(code), v.hash)) {
      v.attempts++;
      this.audit('unlock_code_rejected', { attempts: v.attempts });
      throw new AppError(403, 'bad_code', 'Unlock code is incorrect.');
    }
    v.usedAt = new Date().toISOString();
    this.audit('unlock_code_accepted', {});
  }

  recordWithdrawal(amountCents, kind) {
    const w = { id: newId('wd'), kind, amountCents, at: new Date().toISOString(), clockDate: this.today(), goalId: this.s.goal.id, cycle: this.s.goal.cycle, simulated: true,
      note: 'Ledger record only (sandbox). A real withdrawal would be a transfer from your savings bank that you make at the bank.' };
    this.s.withdrawals.push(w);
    return w;
  }

  /** Withdrawal after unlock: needs the unlock code + explicit confirmation. While saving: 423, always. */
  withdraw({ amountCents, unlockCode, confirm }) {
    const g = this.s.goal;
    if (g?.status !== 'unlocked') { this.audit('withdrawal_refused', { reason: 'vault_locked', amountCents }); throw new AppError(423, 'vault_locked', 'Hard Lock: withdrawals are locked until the settled balance reaches the goal. There is no override.'); }
    if (confirm !== true) throw new AppError(400, 'confirm_required', 'Confirm the withdrawal explicitly.');
    const vault = this.totals().vaultCents;
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > vault) throw new AppError(400, 'bad_amount', `Amount must be between $0.01 and ${money(vault)}.`);
    this.verifyUnlockCode(unlockCode);
    const w = this.recordWithdrawal(amountCents, 'withdrawal');
    g.withdrawnSinceUnlockCents = (g.withdrawnSinceUnlockCents || 0) + amountCents;
    this.audit('withdrawal_recorded', { amountCents, simulated: true, vaultAfterCents: this.totals().vaultCents });
    return w;
  }

  // ---------- Roll Over & Relock ----------
  rolloverPreview({ withdrawCents = 0, newTargetCents, mode = 'partial', vaultCents } = {}) {
    const vault = vaultCents ?? this.totals().vaultCents;
    const withdraw = mode === 'full' ? vault : mode === 'raise' ? 0 : clampInt(withdrawCents);
    const remaining = vault - withdraw;
    const target = newTargetCents == null ? null : clampInt(newTargetCents);
    const additional = target == null ? null : target - remaining;
    const errors = [];
    if (!Number.isInteger(withdraw) || withdraw < 0 || withdraw > vault) errors.push(`Withdrawal must be between $0 and ${money(vault)}.`);
    if (mode === 'partial' && !(withdraw > 0 && withdraw < vault)) errors.push('Partial rollover: withdraw more than $0 and less than the whole vault.');
    if (mode !== 'full' && (target == null || additional <= 0)) errors.push('The new goal must be higher than what stays in the vault.');
    if (target != null && (target < 100 || target > 10000000)) errors.push('New goal must be between $1 and $100,000.');
    const amt = this.s.schedule?.amountCents;
    const pulls = additional > 0 && amt ? Math.ceil(additional / amt) : 0;
    const dates = pulls && this.s.schedule ? nextPullDates(this.s.schedule, this.today(), pulls) : [];
    return { mode, vaultCents: vault, withdrawCents: withdraw, remainingCents: remaining, newTargetCents: target, additionalNeededCents: additional,
      contributionCents: amt || null, pullsNeeded: pulls || null, projectedFinish: dates.at(-1) || null, requiresUnlockCode: withdraw > 0, errors };
  }

  rolloverExecute({ mode = 'partial', withdrawCents = 0, newTargetCents, milestonesCents, fullAction, name, releaseDate, unlockCode, confirm } = {}) {
    const g = this.s.goal;
    if (!['partial', 'full', 'raise'].includes(mode)) throw new AppError(400, 'bad_mode', 'mode must be partial, full or raise.');
    if (confirm !== true) throw new AppError(400, 'confirm_required', 'Confirm the rollover explicitly.');
    if (g?.status === 'saving') {
      if (mode !== 'raise') { this.audit('withdrawal_refused', { reason: 'vault_locked', via: 'rollover' }); throw new AppError(423, 'vault_locked', 'Hard Lock: nothing can be withdrawn until the settled balance reaches the goal.'); }
      this.setGoal({ targetCents: clampInt(newTargetCents), ...(milestonesCents ? { milestonesCents } : {}) });
      return { mode, goal: this.s.goal, note: 'Goal raised while saving; lock unchanged.' };
    }
    if (g?.status !== 'unlocked') throw new AppError(409, 'no_goal', 'No completed goal to roll over.');
    const action = fullAction || this.settings.rollover.fullWithdrawal;
    const target = mode === 'full' && action === 'close' ? null : clampInt(newTargetCents ?? (mode === 'full' ? g.targetCents : undefined));
    const p = this.rolloverPreview({ mode, withdrawCents, newTargetCents: target });
    if (p.errors.length) throw new AppError(400, 'bad_rollover', p.errors.join(' '), { preview: p });
    if (p.withdrawCents > 0) this.verifyUnlockCode(unlockCode);
    const w = p.withdrawCents > 0 ? this.recordWithdrawal(p.withdrawCents, mode === 'full' ? 'full_withdrawal' : 'rollover_withdrawal') : null;
    const cycle = { cycle: g.cycle, goalId: g.id, name: g.name, targetCents: g.targetCents, hardLock: g.hardLock, lockedAt: g.lockedAt, reachedOn: g.reachedOn,
      closedOn: this.today(), mode, withdrawCents: p.withdrawCents, remainingCents: p.remainingCents, nextTargetCents: target, milestones: g.milestones, withdrawalId: w?.id || null };
    this.s.cycles.push(cycle);
    this.s.vault = { code: null, revealBlob: null };
    if (mode === 'full' && action === 'close') {
      g.status = 'closed'; g.closedOn = this.today();
      if (this.s.schedule && !['cancelled', 'revoked'].includes(this.s.schedule.status)) { this.s.schedule.status = 'completed'; this.s.schedule.completedReason = 'goal_closed'; }
      this.audit('goal_closed', { cycle: g.cycle, withdrawCents: p.withdrawCents });
      this.notify('goal_closed', 'Goal closed', `Recorded a ${money(p.withdrawCents)} withdrawal. No more deposits are scheduled.`);
      return { preview: p, cycle, goal: g };
    }
    const next = this.newGoal({ name: name || g.name, targetCents: target, releaseDate: releaseDate && isValidDate(releaseDate) && releaseDate > this.today() ? releaseDate : addDays(this.today(), this.settings.goal.lockDays),
      unlockRule: g.unlockRule, hardLock: g.hardLock, hardship: g.hardship, milestonesCents: milestonesCents || [] }, g.cycle + 1);
    next.lockedAt = new Date().toISOString(); // relocked immediately
    this.s.goal = next;
    const s = this.s.schedule;
    let resumed = false;
    if (s && s.status === 'completed' && this.s.authorization?.status === 'active') { s.status = 'active'; s.completedReason = null; s.cursor = addDays(this.today(), -1); s.returnCount = 0; resumed = true; }
    this.audit('rollover_relocked', { fromCycle: g.cycle, toCycle: next.cycle, mode, withdrawCents: p.withdrawCents, remainingCents: p.remainingCents, newTargetCents: target, additionalNeededCents: p.additionalNeededCents, depositsResumed: resumed });
    this.notify('rollover', `Relocked: new goal ${money(target)}`, `${money(p.remainingCents)} stays locked; ${money(p.additionalNeededCents)} more to go.${resumed ? ' Deposits continue on schedule.' : ''}`);
    this.checkMilestones();
    return { preview: p, cycle, goal: next, depositsResumed: resumed };
  }

  // ---------- Hardship release (only for goals created WITHOUT Hard Lock) ----------
  requestHardship({ amountCents, typed, confirm }) {
    const g = this.s.goal;
    if (!g || g.status !== 'saving') throw new AppError(409, 'not_saving', 'Hardship release applies only to a goal that is still locked.');
    if (g.hardLock) { this.audit('hardship_refused', { reason: 'hard_lock' }); throw new AppError(403, 'hard_lock', 'Hard Lock is on: there is no early release in the app. The vault opens only when the settled balance reaches the goal.'); }
    if (!g.hardship.enabled) throw new AppError(403, 'hardship_not_enabled', 'This goal was created without a hardship release.');
    if (this.s.hardship?.status === 'cooling_off') throw new AppError(409, 'already_requested', 'A hardship release is already cooling off.');
    if (confirm !== true || typed !== HARDSHIP_PHRASE) throw new AppError(400, 'typed_confirmation_required', `Type exactly: ${HARDSHIP_PHRASE}`);
    const vault = this.totals().vaultCents;
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > vault) throw new AppError(400, 'bad_amount', `Amount must be between $0.01 and ${money(vault)}.`);
    this.s.hardship = { id: newId('hard'), status: 'cooling_off', goalId: g.id, amountCents, requestedAt: new Date().toISOString(), requestedOn: this.today(), availableOn: addDays(this.today(), g.hardship.coolingOffDays), coolingOffDays: g.hardship.coolingOffDays };
    this.audit('hardship_requested', { amountCents, availableOn: this.s.hardship.availableOn, coolingOffDays: g.hardship.coolingOffDays });
    this.notify('hardship_requested', 'Hardship release requested', `Cooling-off until ${prettyDate(this.s.hardship.availableOn)}. You can cancel any time before then.`);
    return this.s.hardship;
  }
  cancelHardship() {
    const h = this.s.hardship;
    if (!h || h.status !== 'cooling_off') throw new AppError(409, 'none', 'No hardship release is cooling off.');
    h.status = 'cancelled'; h.cancelledOn = this.today();
    this.audit('hardship_cancelled', { amountCents: h.amountCents });
    return h;
  }
  completeHardship({ typed, confirm }) {
    const h = this.s.hardship, g = this.s.goal;
    if (!h || h.status !== 'cooling_off' || h.goalId !== g?.id) throw new AppError(409, 'none', 'No hardship release is cooling off.');
    if (g.hardLock) throw new AppError(403, 'hard_lock', 'Hard Lock is on.');
    if (this.today() < h.availableOn) throw new AppError(423, 'cooling_off', `Cooling-off period runs until ${prettyDate(h.availableOn)}.`);
    if (confirm !== true || typed !== HARDSHIP_PHRASE) throw new AppError(400, 'typed_confirmation_required', `Type exactly: ${HARDSHIP_PHRASE}`);
    const amount = Math.min(h.amountCents, this.totals().vaultCents);
    const w = this.recordWithdrawal(amount, 'hardship_release');
    h.status = 'completed'; h.completedOn = this.today(); h.withdrawalId = w.id;
    this.audit('hardship_released', { amountCents: amount, simulated: true, goalStillLocked: true });
    this.notify('hardship_released', 'Hardship release recorded', `${money(amount)} recorded as withdrawn. The rest stays locked toward "${g.name}".`);
    return { hardship: h, withdrawal: w };
  }

  // ---------- Emergency stop (user only): pause + revoke bot keys. Never unlocks or releases money. ----------
  // ---------- Go Blind ----------
  get blind() { if (!this.s.blind || typeof this.s.blind !== 'object') this.s.blind = emptyBlind(); return this.s.blind; }
  /** "Stay blind until goal" is bound to the goal that was saving when it was chosen; it ends when that goal unlocks. */
  blindStayActive() {
    const b = this.blind, g = this.s.goal;
    return !!(b.on && b.stayUntilGoal && g && g.id === b.stayGoalId && g.status === 'saving');
  }
  /** UI redaction: on while blind, except after the goal is reached (the unlock + withdrawal/rollover flow shows amounts). */
  blindRedactUser() { return !!this.blind.on && this.s.goal?.status !== 'unlocked'; }
  /** Bot redaction: always while blind is on. */
  blindRedactBot() { return !!this.blind.on; }
  redactForUser(out) { return this.blindRedactUser() ? redactDeep(out, { skip: ['blind', 'benefitsAlert'] }) : out; }
  redactForBot(out) { return this.blindRedactBot() && out && typeof out === 'object' ? { ...redactDeep(out), blindMode: true } : out; }
  redactErrorText(msg) { return this.blindRedactUser() ? redactText(msg) : msg; }
  blindView() {
    const b = this.blind, now = this.nowMs();
    return { on: !!b.on, redacted: this.blindRedactUser(), stayUntilGoal: this.blindStayActive(), enabledAt: b.enabledAt, enabledBy: b.enabledBy,
      lockedUntil: b.lockedUntil && b.lockedUntil > now ? new Date(b.lockedUntil).toISOString() : null,
      triesLeft: BLIND_MAX_FAILURES - (b.failures || []).filter((t) => now - t < BLIND_LOCKOUT_MS).length,
      passcodeKind: this.blindAuth.kind, needsPasscodeSetup: !!this.blindAuth.needsSetup() };
  }
  /** Turn Go Blind on (one tap + confirm), or tighten it with "stay blind until goal". Never loosens. */
  async blindOn({ confirm, stayUntilGoal = false, passcode } = {}, { by = 'user' } = {}) {
    const b = this.blind, g = this.s.goal;
    if (confirm !== true) throw new AppError(400, 'confirm_required', 'Confirm turning on Go Blind.');
    if (by !== 'user' && stayUntilGoal) throw new AppError(403, 'forbidden_for_bot', 'Only you can choose "stay blind until goal" (it cannot be undone until the goal is reached).');
    if (b.on && b.stayUntilGoal && stayUntilGoal === false && this.blindStayActive()) {
      this.audit('lock_loosening_refused', { attempted: ['remove stay-blind-until-goal'] });
      throw new AppError(423, 'lock_loosening_blocked', '"Stay blind until goal" cannot be removed until the goal is reached.');
    }
    if (this.blindAuth.needsSetup()) {
      if (by !== 'user') throw new AppError(409, 'blind_passcode_needed', 'The user has to set a Go Blind passcode (in the app) before Go Blind can be turned on.');
      if (!/^\d{4,12}$/.test(String(passcode || ''))) throw new AppError(400, 'weak_passcode', 'Choose a Go Blind passcode of 4 to 12 digits.');
      await this.blindAuth.setup(String(passcode));
      this.audit('blind_passcode_set', { kind: this.blindAuth.kind });
    }
    const stay = !!stayUntilGoal && !!g && g.status === 'saving';
    if (b.on) {
      if (stay && !this.blindStayActive()) { b.stayUntilGoal = true; b.stayGoalId = g.id; this.audit('blind_stay_until_goal_added', { by, goal: g.name }); }
      return this.blindView();
    }
    Object.assign(b, { on: true, stayUntilGoal: stay, stayGoalId: stay ? g.id : null, enabledAt: new Date().toISOString(), enabledBy: by });
    this.audit('blind_on', { by, stayUntilGoal: stay, goal: g?.name || null });
    return this.blindView();
  }
  /** Turn Go Blind off: needs the passcode, is rate-limited (5 wrong tries -> 15-minute lockout), and is impossible while "stay blind until goal" holds. */
  async blindOff({ passcode } = {}) {
    const b = this.blind, now = this.nowMs();
    if (!b.on) return this.blindView();
    if (this.blindStayActive()) {
      this.audit('blind_off_refused', { reason: 'stay_until_goal' });
      throw new AppError(423, 'blind_until_goal', 'You chose "stay blind until goal". Go Blind turns off only when the vault unlocks. There is no passcode override.');
    }
    if (b.lockedUntil && now < b.lockedUntil) {
      this.audit('blind_off_refused', { reason: 'locked_out' });
      throw new AppError(429, 'blind_locked_out', `Too many wrong passcodes. Try again after ${new Date(b.lockedUntil).toLocaleTimeString()}.`, { lockedUntil: new Date(b.lockedUntil).toISOString() });
    }
    if (!(await this.blindAuth.verify(passcode))) {
      b.failures = (b.failures || []).filter((t) => now - t < BLIND_LOCKOUT_MS).concat(now);
      const n = b.failures.length;
      this.audit('blind_off_failed', { attempt: n });
      if (n >= BLIND_MAX_FAILURES) {
        b.lockedUntil = now + BLIND_LOCKOUT_MS; b.failures = [];
        this.audit('blind_off_lockout', { minutes: BLIND_LOCKOUT_MS / 60_000 });
        throw new AppError(429, 'blind_locked_out', 'Too many wrong passcodes. Go Blind stays on; try again in 15 minutes.', { lockedUntil: new Date(b.lockedUntil).toISOString() });
      }
      throw new AppError(401, 'bad_passcode', `Wrong passcode. ${BLIND_MAX_FAILURES - n} tries left before a 15-minute lockout.`, { triesLeft: BLIND_MAX_FAILURES - n });
    }
    Object.assign(b, { on: false, stayUntilGoal: false, stayGoalId: null, failures: [], lockedUntil: null });
    this.audit('blind_off', {});
    return this.blindView();
  }
  /** Benefits guard: a non-numeric alert that stays visible in Go Blind. Settled savings only. */
  benefitsAlert() {
    const b = this.settings.benefits;
    if (!b?.receivesSSI) return null;
    const v = this.totals().vaultCents;
    const level = v >= b.resourceLimitCents ? 'over' : v >= Math.floor(b.resourceLimitCents * b.warnAtPercent / 100) ? 'near' : null;
    return level ? { level, message: BENEFITS_MESSAGES[level] } : null;
  }

  emergencyStop({ confirm } = {}) {
    if (confirm !== true) throw new AppError(400, 'confirm_required', 'Confirm the emergency stop.');
    const s = this.s.schedule;
    let paused = false;
    if (s && s.status === 'active') { this.pause('emergency_stop'); paused = true; }
    const now = new Date().toISOString();
    const keys = this.s.botKeys.filter((k) => !k.revokedAt);
    for (const k of keys) { k.revokedAt = now; k.revokedReason = 'emergency_stop'; }
    const cancelled = this.s.approvals.filter((a) => a.status === 'pending');
    for (const a of cancelled) { a.status = 'cancelled'; a.decidedAt = now; a.decidedReason = 'emergency_stop'; }
    const t = this.totals();
    const out = { schedulePaused: paused, scheduleStatus: s?.status || null, botKeysRevoked: keys.length, approvalsCancelled: cancelled.length,
      vaultCents: t.vaultCents, goalStatus: this.s.goal?.status, lockUnchanged: true };
    this.audit('emergency_stop', out);
    this.notify('emergency_stop', 'Emergency stop', 'Future deposits paused and all bot keys revoked. Your saved money and the lock are unchanged.');
    return out;
  }

  // ---------- Settings ----------
  updateSettings(patch, { fromBot = false } = {}) {
    const { patch: flat, errors } = validatePatch(patch || {});
    if (fromBot) for (const k of Object.keys(flat)) if (BOT_FORBIDDEN_SETTINGS.includes(k)) errors.push(`${k} can only be changed by you in Settings.`);
    if (errors.length) throw new AppError(400, 'bad_settings', errors.join(' '));
    const before = this.settings;
    this.s.settings = applyPatch(this.s.settings, flat);
    this.audit('settings_updated', { changed: Object.fromEntries(Object.keys(flat).map((k) => [k, { from: k.split('.').reduce((a, p) => a?.[p], before), to: flat[k] }])), note: 'Defaults for new goals; a locked goal is never loosened by settings.' });
    return this.settings;
  }

  // ---------- Bot keys ----------
  createBotKey({ name, scopes }) {
    const sc = Array.isArray(scopes) && scopes.length ? scopes : ['read'];
    if (!sc.every((x) => BOT_SCOPES.includes(x))) throw new AppError(400, 'bad_scopes', `Scopes must be from: ${BOT_SCOPES.join(', ')}`);
    const nm = String(name || 'AI bot').trim().slice(0, 40);
    const id = newId('bk').slice(3);
    const secret = randomToken(32);
    this.s.botKeys.push({ id, name: nm, scopes: [...new Set(sc)], secretHash: sha256hex(secret), createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null });
    this.audit('bot_key_created', { id, name: nm, scopes: sc });
    return { id, name: nm, scopes: sc, key: `ldbk_${id}.${secret}`, note: 'Shown once. Only a hash is stored.' };
  }
  revokeBotKey(id) {
    const k = this.s.botKeys.find((x) => x.id === id);
    if (!k) throw new AppError(404, 'not_found', 'No such key');
    if (!k.revokedAt) { k.revokedAt = new Date().toISOString(); k.revokedReason = 'user'; this.audit('bot_key_revoked', { id, name: k.name }); }
    return { id, revokedAt: k.revokedAt };
  }
  botKeysView() { return this.s.botKeys.map(({ secretHash, ...k }) => k); }

  // ---------- Approvals (bot proposes, user decides) ----------
  createApproval({ type, payload, summary, key }) {
    const a = { id: newId('apr'), type, payload, summary, status: 'pending', createdAt: new Date().toISOString(), createdOn: this.today(),
      expiresOn: addDays(this.today(), this.settings.bot.approvalExpiryDays), requestedBy: { keyId: key.id, name: key.name },
      requiresUnlockCode: ['withdrawal', 'rollover'].includes(type) && (type === 'withdrawal' || (payload.mode !== 'raise')) };
    this.s.approvals.unshift(a);
    this.audit('approval_requested', { id: a.id, type, summary }, `bot:${key.id}`);
    this.notify('approval_requested', 'Your bot is asking for approval', summary);
    return a;
  }
  expireApprovals() {
    for (const a of this.s.approvals) if (a.status === 'pending' && this.today() > a.expiresOn) { a.status = 'expired'; a.decidedAt = new Date().toISOString(); this.audit('approval_expired', { id: a.id, type: a.type }, 'system'); }
  }
  async approve(id, { confirm, unlockCode } = {}) {
    const a = this.s.approvals.find((x) => x.id === id);
    if (!a) throw new AppError(404, 'not_found', 'No such approval request');
    if (a.status !== 'pending') throw new AppError(409, 'not_pending', `This request is ${a.status}.`);
    if (confirm !== true) throw new AppError(400, 'confirm_required', 'Tick the confirmation box to approve.');
    let result;
    try {
      result = await this.executeApproval(a, { unlockCode });
    } catch (e) {
      if (['bad_code', 'confirm_required', 'code_expired', 'code_used', 'code_locked'].includes(e.code)) throw e; // stays pending
      a.status = 'failed'; a.decidedAt = new Date().toISOString(); a.error = { code: e.code, message: e.message };
      this.audit('approval_failed', { id, type: a.type, error: e.code });
      throw e;
    }
    a.status = 'approved'; a.decidedAt = new Date().toISOString(); a.result = result?.next ? { next: result.next } : { ok: true };
    this.audit('approval_approved', { id, type: a.type });
    return { approval: a, result };
  }
  reject(id) {
    const a = this.s.approvals.find((x) => x.id === id);
    if (!a) throw new AppError(404, 'not_found', 'No such approval request');
    if (a.status !== 'pending') throw new AppError(409, 'not_pending', `This request is ${a.status}.`);
    a.status = 'rejected'; a.decidedAt = new Date().toISOString();
    this.audit('approval_rejected', { id, type: a.type });
    return a;
  }
  async executeApproval(a, { unlockCode }) {
    const p = a.payload || {};
    switch (a.type) {
      case 'goal_change': return this.setGoal(p);
      case 'rollover': return this.rolloverExecute({ ...p, unlockCode, confirm: true });
      case 'withdrawal': return this.withdraw({ amountCents: p.amountCents, unlockCode, confirm: true });
      case 'resume_schedule': return this.resume();
      case 'schedule_change': { const s = this.s.schedule || {}; this.setSchedule({ ...s, ...p }); return { next: '#/authorize' }; }
      case 'change_funding_account': this.assignRoles({ fundingAccountId: p.fundingAccountId, destinationAccountId: p.destinationAccountId || this.s.roles.destinationAccountId }); return { next: '#/authorize' };
      case 'revoke_authorization': return this.revokeAuthorization();
      case 'grant_authorization': return { next: '#/authorize' }; // the user signs the ACH authorization text themselves
      case 'settings_change': return this.updateSettings(p, { fromBot: true });
      default: throw new AppError(400, 'bad_type', `Unknown request type ${a.type}`);
    }
  }

  // ---------- Sync / tick ----------
  async sync() { await this.applyUpdates(await this.provider.tick(this.today())); }
  async tickAll() { this.bootstrap(); await this.sync(); await this.runScheduler(); await this.sync(); }

  async cancelTransfer(pullId) {
    const pull = this.s.transfers.find((t) => t.id === pullId);
    if (!pull) throw new AppError(404, 'not_found', 'No such transfer');
    if (pull.status !== 'pending') throw new AppError(409, 'not_cancellable', `Only pending transfers can be cancelled (this one is ${pull.status}).`);
    await this.provider.cancelTransfer(pull.providerTransferId);
    pull.status = 'cancelled'; pull.history.push({ status: 'cancelled', at: new Date().toISOString(), clockDate: this.today(), by: 'user' });
    this.audit('pull_cancelled_by_user', { pullId });
    return pull;
  }

  // ---------- Sandbox tools ----------
  async simulate(pullId, event, returnCode) {
    const pull = this.s.transfers.find((t) => t.id === pullId);
    if (!pull?.providerTransferId) throw new AppError(404, 'not_found', 'No such transfer');
    await this.provider.simulate(pull.providerTransferId, event, returnCode);
    await this.applyUpdates([{ providerTransferId: pull.providerTransferId, status: event === 'returned' ? 'returned' : event, failureReason: event === 'returned' ? { achReturnCode: returnCode || 'R01', description: 'Simulated return' } : null }]);
    return pull;
  }
  async advanceClock(days) {
    const n = Math.max(1, Math.min(400, Number(days) || 1));
    for (let i = 0; i < n; i++) { this.s.clock.offsetDays = (this.s.clock.offsetDays || 0) + 1; await this.tickAll(); }
    this.audit('demo_clock_advanced', { days: n, today: this.today() });
  }

  activateRealTransfers({ benefitAck }) {
    if (benefitAck !== true) throw new AppError(400, 'ack_required', 'The benefit-limit warning must be acknowledged in this same step before real transfers could ever be activated.');
    const unmet = unmetGates(this.s);
    this.audit('real_transfer_activation_refused', { reason: 'production hard-disabled', unmetGates: unmet.map((g) => g.id) });
    throw new AppError(403, 'production_disabled', `Real money movement is hard-disabled in this prototype. Unmet go-live gates: ${unmet.map((g) => g.id).join(', ')}.`, { unmetGates: unmet.map(({ id, label }) => ({ id, label })) });
  }

  // ---------- Views ----------
  scheduleView() {
    const s = this.s.schedule; if (!s) return null;
    const today = this.today();
    const next = ['active', 'paused', 'needs_authorization'].includes(s.status) ? nextPullDates(s, s.status === 'active' ? addDays(s.cursor || today, 1) : today, 4) : [];
    const periods = Object.values(this.s.periods).filter((p) => p.scheduleId === s.id).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 24);
    const { cursor, ...rest } = s;
    return { ...rest, description: describeSchedule(s), nextPulls: next, periods };
  }
  goalView() {
    const g = this.s.goal; if (!g) return null;
    const t = this.totals();
    return { ...g, locked: this.isLocked(g) || g.status === 'saving', draft: g.status === 'saving' && !g.lockedAt, progressSettled: Math.min(1, t.vaultCents / g.targetCents),
      remainingCents: Math.max(0, g.targetCents - t.vaultCents), releaseDatePretty: prettyDate(g.releaseDate) };
  }
  view() {
    return this.redactForUser(this.rawView());
  }
  rawView() {
    const today = this.today();
    const t = this.totals(); const g = this.s.goal; const s = this.s.schedule;
    const sv = this.scheduleView();
    const v = this.s.vault.code;
    return {
      today, provider: this.provider.clientConfig(), realMoneyEnabled: REAL_MONEY_ENABLED, demoClock: this.config.demoClock, clockOffsetDays: this.s.clock.offsetDays || 0,
      items: this.s.items.map(({ id, institutionName, provider, createdAt }) => ({ id, institutionName, provider, createdAt })),
      accounts: this.s.accounts.map(({ id, itemId, name, mask, subtype, institutionName }) => ({ id, itemId, name, mask, subtype, institutionName })),
      roles: this.s.roles, goal: this.goalView(), cycles: this.s.cycles, withdrawals: this.s.withdrawals,
      schedule: sv, nextPulls: sv?.nextPulls || [],
      authorization: this.s.authorization ? (({ text, ...rest }) => ({ ...rest, hasText: !!text }))(this.s.authorization) : null,
      benefitAck: this.s.benefitAck, benefitWarning: this.benefitWarning(),
      totals: t,
      locked: g ? g.status === 'saving' : false, releaseDatePretty: g ? prettyDate(g.releaseDate) : null,
      vault: { codeWaitingToBeShown: !!this.s.vault.revealBlob, codeIssuedOn: v?.issuedOn || null, codeExpiresOn: v?.expiresOn || null, codeUsed: !!v?.usedAt, codeExpired: v ? today > v.expiresOn : false },
      hardship: this.s.hardship, hardshipPhrase: HARDSHIP_PHRASE,
      overBenefitLimit: g ? g.targetCents > SSI_LIMIT_CENTS || t.vaultCents + t.pendingCents > SSI_LIMIT_CENTS : false,
      transfers: this.s.transfers,
      audit: this.s.audit.slice(-150).reverse(), auditKey: this.s.audit.filter((e) => KEY_AUDIT.test(e.type)).slice(-60).reverse(), auditIntegrity: verifyAudit(this.s.audit), auditCount: this.s.audit.length,
      readiness: this.readiness(), settings: this.settings, rules: listRules(),
      // While blind, progress milestones are hidden (they'd reveal progress); the goal-reached banner still shows.
      notifications: this.s.notifications.filter((n) => !n.dismissedAt && !(this.blindRedactUser() && n.type.startsWith('milestone'))).slice(0, 5),
      approvals: this.s.approvals.slice(0, 50), pendingApprovals: this.s.approvals.filter((a) => a.status === 'pending').length,
      botKeys: this.botKeysView(), botActivity: this.s.botActivity.slice(-100).reverse(),
      goLiveGates: evaluateGates(this.s),
      scheduleStatus: s?.status || null,
      blind: this.blindView(), benefitsAlert: this.benefitsAlert(),
    };
  }
}
