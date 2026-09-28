// "Seal my login": the app keeps the login of a separate savings account (for example "Current Savings") sealed
// until an unlock condition is met: a date, the vault goal, or both (whichever is later).
//
// Zero gray area, by design:
//   - No early reveal of any kind: no passcode (app or Go Blind), no override, no admin path, and the bot can
//     never reveal, create, delete or reseal. Every refused attempt is written to the audit log.
//   - The unlock condition is tighten-only after sealing: the date can only move later, a goal can be added,
//     nothing can be removed. Lowering the goal a sealed login waits for is refused.
//   - While locked, a sealed login can't be deleted, the sandbox reset / demo "Start over" are refused, and (for
//     goal-bound seals) the sandbox time-travel and simulate tools are refused, so none of them is a back door.
//   - "Reseal" (the bank forced a password change) stores a NEW password; the old one is never shown.
//
// Honest limits (see docs/SEALED_LOGIN.md): the key has to live somewhere the app can reach (server: env or a
// secrets file; browser demo: this device), so a technical person with that access could decrypt. And the bank
// can always reset the login after identity verification. The real lock is the bank's own rules + a trusted person.
//
// Secrets (username, password, recovery email, phone, notes, security answers) live only inside one AES-256-GCM
// blob per login, with the login id as additional authenticated data. They are never in views, audit entries,
// notifications or bot responses. Only the draft (before sealing) and the reveal (after unlock) return them.
import crypto from 'node:crypto';
import { AppError } from './errors.js';

export const SEAL_PHRASE = 'SEAL MY LOGIN';
export const RESEAL_PHRASE = 'RESEAL MY LOGIN';
export const MAX_SEALED_LOGINS = 5;
export const DRAFT_TTL_MS = 2 * 60 * 60_000;
export const UNLOCK_RULES = ['date', 'goal', 'date_and_goal'];
export const DEFAULT_LABEL = 'Current Savings';
export const DEFAULT_SYMBOLS = '!@#$%&*-_+=?';
export const PASSWORD_DEFAULTS = { length: 20, symbols: DEFAULT_SYMBOLS, symbolCount: 2, avoidAmbiguous: true };
export const SECRET_FIELDS = ['username', 'password', 'recoveryEmail', 'phone', 'notes', 'questions'];
export const LOST_CARD_STEPS = [
  { id: 'report_lost', label: 'Report the Current card lost or stolen (in the Current app, or with Current support using the contact info in the app or on current.com)' },
  { id: 'remove_wallet', label: 'Remove the Current card from Apple Wallet / Apple Pay (and any other phone wallet)' },
  { id: 'destroy_card', label: 'Cut or break the physical Current card and throw it away' },
  { id: 'delete_app', label: 'Delete the Current app from your phone (after sealing)' },
  { id: 'no_new_card', label: 'Only request a new Current card after the unlock date' },
];
const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const SETS = {
  upper: ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'ABCDEFGHJKLMNPQRSTUVWXYZ'],   // [all, without I/O]
  lower: ['abcdefghijklmnopqrstuvwxyz', 'abcdefghijkmnopqrstuvwxyz'],  // without l
  digits: ['0123456789', '23456789'],                                   // without 0/1
};
// ~280 short, common words: 4 of them make a security answer (~32 bits) that is easy to read out to a bank rep.
const WORDS = [...new Set(('acorn actor adapt agent alarm album alley amber anchor angle ankle apple apron arena armor arrow aspen atlas attic autumn '
  + 'badge bagel baker bamboo banjo barn basil basket beach beacon bench berry bison blade blanket blossom bonus bottle boulder bread '
  + 'brick bridge brook broom bucket buffalo bugle bundle butter button cabin cable cactus camera candle canoe canyon carbon cargo carpet '
  + 'castle cedar cellar cement cereal chalk cherry chess chimney cider circus clay cliff clock cloud clover cobalt cocoa comet copper '
  + 'coral cotton cougar couch crane crater crayon cricket crystal cup curtain cushion dagger daisy dancer delta denim desert dial diary '
  + 'dinner dolphin donkey dragon drum eagle easel echo elbow ember engine falcon feather fence ferry fiddle field fig flag flute forest '
  + 'fossil fountain fox frost galaxy garden garlic gazelle geyser ginger glacier globe goose granite grape gravel guitar hammer harbor '
  + 'harvest hazel helmet heron hickory hill honey hornet island ivory jacket jaguar jasmine jelly jungle kayak kettle kitten ladder '
  + 'lagoon lantern laser lemon lentil lily linen lizard lobster locket lotus magnet mango maple marble meadow melon meteor mint mirror '
  + 'mitten monkey moss motor muffin mural nectar needle nickel noodle oasis ocean olive onion orbit orchid otter oven owl paddle '
  + 'palace panda paper parrot pasta peach peanut pebble pencil pepper piano pickle pillow pilot pine planet plum pocket pony poppy '
  + 'prairie pretzel pumpkin puzzle quartz quill rabbit radar radish raven reef ribbon river robin rocket saddle salmon sandal satin '
  + 'scarf shadow shell sierra silver ski sparrow spider spoon spruce squid stable summit sunset swan tablet teapot temple thunder tiger '
  + 'timber toast tomato topaz tractor trumpet tulip tundra turtle umbrella valley velvet violin walnut walrus willow window winter '
  + 'wizard yarn zebra zephyr').split(' '))];

/** Uniform random integer in [0, n) from crypto.randomBytes (rejection sampling, no modulo bias). */
export function randomInt(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new RangeError('bad range');
  const limit = Math.floor(2 ** 32 / n) * n;
  for (;;) { const x = crypto.randomBytes(4).readUInt32BE(0); if (x < limit) return x % n; }
}
const pickFrom = (s) => s[randomInt(s.length)];
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** Validate + normalize password options. Banks differ, so length, symbol set, symbol count and look-alikes are configurable. */
export function passwordOptions(input = {}) {
  const o = { ...PASSWORD_DEFAULTS, ...Object.fromEntries(Object.entries(input || {}).filter(([, v]) => v !== undefined && v !== null)) };
  const errors = [];
  o.length = Number(o.length); o.symbolCount = Number(o.symbolCount); o.avoidAmbiguous = o.avoidAmbiguous !== false;
  o.symbols = [...new Set(String(o.symbols ?? ''))].join('');
  if (!Number.isInteger(o.length) || o.length < 12 || o.length > 64) errors.push('Length must be 12 to 64 characters.');
  if (o.symbols.length > 32 || [...o.symbols].some((c) => !PUNCT.includes(c))) errors.push(`Symbols must come from: ${PUNCT}`);
  if (!o.symbols.length) o.symbolCount = 0;
  if (!Number.isInteger(o.symbolCount) || o.symbolCount < 0 || o.symbolCount > 6 || (Number.isInteger(o.length) && o.symbolCount > o.length - 6)) errors.push('Symbol count must be 0 to 6.');
  if (errors.length) throw new AppError(400, 'bad_password_options', errors.join(' '));
  return o;
}

/**
 * Crypto-random, bank-friendly password: starts with a letter, at least 1 upper, 1 lower and 2 digits, exactly
 * `symbolCount` symbols from `symbols`, the rest letters/digits. Positions shuffled with an unbiased Fisher-Yates.
 */
export function generatePassword(input = {}) {
  const o = passwordOptions(input);
  const k = o.avoidAmbiguous ? 1 : 0;
  const U = SETS.upper[k], L = SETS.lower[k], D = SETS.digits[k], AN = U + L + D;
  const chars = [pickFrom(U), pickFrom(L), pickFrom(D), pickFrom(D)];
  for (let i = 0; i < o.symbolCount; i++) chars.push(pickFrom(o.symbols));
  while (chars.length < o.length) chars.push(pickFrom(AN));
  shuffle(chars);
  if (!/[A-Za-z]/.test(chars[0])) { const j = chars.findIndex((c) => /[A-Za-z]/.test(c)); [chars[0], chars[j]] = [chars[j], chars[0]]; }
  return chars.join('');
}
/** Rough strength of a generated password (bits), for display only. */
export function passwordBits(o) {
  const k = o.avoidAmbiguous ? 1 : 0;
  const an = SETS.upper[k].length + SETS.lower[k].length + SETS.digits[k].length;
  return Math.floor((o.length - o.symbolCount) * Math.log2(an) + o.symbolCount * Math.log2(Math.max(1, o.symbols.length)));
}
/** Random security-question answer: 4 common words (~32 bits). Easy to read out, meaningless to guess. */
export const generateAnswer = () => Array.from({ length: 4 }, () => pickFrom(WORDS)).join(' ');
export const WORD_COUNT = WORDS.length;

const clean = (v, max, name) => {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (s.length > max) throw new AppError(400, 'bad_login_details', `${name} is too long (max ${max}).`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s)) throw new AppError(400, 'bad_login_details', `${name} has control characters.`);
  return s;
};
export function cleanLabel(v) {
  const s = clean(v, 40, 'Label');
  if (!s) throw new AppError(400, 'bad_label', 'Give the account a label, for example "Current Savings".');
  return s;
}
function cleanQuestions(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 5) throw new AppError(400, 'bad_login_details', 'Up to 5 security questions.');
  return list.map((q, i) => {
    const question = clean(q?.question, 120, `Question ${i + 1}`);
    const answer = q?.generate === true ? generateAnswer() : clean(q?.answer, 120, `Answer ${i + 1}`);
    return { question, answer, generated: q?.generate === true };
  }).filter((q) => q.question || q.answer);
}
/** Secret values as they go into the sealed blob. */
export function cleanSecrets(body = {}) {
  const out = {
    username: clean(body.username, 120, 'Username / email'),
    recoveryEmail: clean(body.recoveryEmail, 120, 'Recovery email'),
    phone: clean(body.phone, 24, 'Phone number'),
    notes: clean(body.notes, 1000, 'Notes'),
    questions: cleanQuestions(body.questions),
  };
  if (out.recoveryEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.recoveryEmail)) throw new AppError(400, 'bad_login_details', 'Recovery email does not look like an email address.');
  if (out.phone && !/^[+\d][\d\s().-]{5,23}$/.test(out.phone)) throw new AppError(400, 'bad_login_details', 'Phone number: digits, spaces, +, -, ( ) only.');
  return out;
}
export function cleanEnteredPassword(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (!s || s.length > 128 || /[\u0000-\u001F\u007F]/.test(s)) throw new AppError(400, 'bad_password', 'Enter the password (1 to 128 characters, no line breaks).');
  return s;
}

// ---------- AES-256-GCM "sl1" format, shared by Node (server) and WebCrypto (browser demo) ----------
// sl1.<iv base64>.<ciphertext||tag base64>, AAD = "ldb-sealed-login:v1:<login id>".
export const aadFor = (id) => `ldb-sealed-login:v1:${id}`;
export function nodeSealCipher(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Sealed-login key must be 32 bytes.');
  return {
    kind: 'aes-256-gcm (node)',
    async encrypt(plaintext, aad) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final(), c.getAuthTag()]);
      return `sl1.${iv.toString('base64')}.${ct.toString('base64')}`;
    },
    async decrypt(blob, aad) {
      const [v, iv, data] = String(blob).split('.');
      if (v !== 'sl1' || !iv || !data) throw new Error('Unknown sealed-login ciphertext');
      const buf = Buffer.from(data, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(buf.subarray(buf.length - 16));
      return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
    },
  };
}

export const emptyLostCard = () => ({ items: {}, updatedAt: null });

/** All sealed-login rules. One instance per Service (service.sealed). Methods run inside the store lock. */
export class SealedLogins {
  constructor(service) { this.svc = service; }
  get s() { return this.svc.s; }
  get list() { if (!Array.isArray(this.s.sealedLogins)) this.s.sealedLogins = []; return this.s.sealedLogins; }
  get cipher() {
    const c = this.svc.sealCipher;
    if (!c) throw new AppError(503, 'seal_unavailable', 'Sealed logins need an encryption key (SEALED_LOGIN_KEY or SEALED_LOGIN_KEY_FILE).');
    return c;
  }
  audit(type, detail) { return this.svc.audit(type, detail); }

  // ---------- time + unlock condition ----------
  // Wall clock (server time on the server, device time in the browser demo). Deliberately NOT the sandbox demo clock.
  nowMs() { return this.svc.nowMs(); }
  wallToday() { return new Date(this.nowMs()).toLocaleDateString('en-CA'); }
  unlockAtMs(date) { return date ? new Date(`${date}T00:00:00`).getTime() : null; } // local midnight at the start of the unlock date
  dateMet(r) { return !!r.unlockDate && this.nowMs() >= this.unlockAtMs(r.unlockDate); }
  /** Goal part: the goal that was active when the rule was set has been reached (settled balance >= goal, same engine rule). */
  goalMet(r) {
    if (!r.goalId) return false;
    const g = this.s.goal;
    if (g?.id === r.goalId && ['unlocked', 'closed'].includes(g.status)) return true;
    return (this.s.cycles || []).some((c) => c.goalId === r.goalId && c.reachedOn);
  }
  conditionMet(r) {
    if (r.unlockRule === 'date') return this.dateMet(r);
    if (r.unlockRule === 'goal') return this.goalMet(r);
    if (r.unlockRule === 'date_and_goal') return this.dateMet(r) && this.goalMet(r);
    return false;
  }
  locked() { return this.list.filter((r) => !this.conditionMet(r)); }
  goalBoundLocked() { return this.locked().filter((r) => r.unlockRule !== 'date'); }
  find(id) {
    const r = this.list.find((x) => x.id === id);
    if (!r) throw new AppError(404, 'not_found', 'No such sealed login.');
    return r;
  }

  /** Validate a new unlock setting (at sealing time, or when a reseal happens after the old one opened). */
  freshUnlock({ unlockRule = 'date', unlockDate } = {}) {
    if (!UNLOCK_RULES.includes(unlockRule)) throw new AppError(400, 'bad_unlock', `Unlock rule must be one of: ${UNLOCK_RULES.join(', ')}.`);
    const out = { unlockRule, unlockDate: null, goalId: null, goalName: null, goalTargetCentsAtSeal: null };
    if (unlockRule !== 'goal') out.unlockDate = this.checkDate(unlockDate);
    if (unlockRule !== 'date') Object.assign(out, this.bindGoal());
    return out;
  }
  checkDate(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) || Number.isNaN(new Date(`${d}T00:00:00`).getTime())) throw new AppError(400, 'bad_unlock', 'Pick an unlock date.');
    const today = this.wallToday();
    if (d <= today) throw new AppError(400, 'bad_unlock', 'The unlock date has to be in the future (tomorrow or later).');
    const max = new Date(this.nowMs()); max.setFullYear(max.getFullYear() + 10);
    if (d > max.toLocaleDateString('en-CA')) throw new AppError(400, 'bad_unlock', 'The unlock date can be at most 10 years away.');
    return d;
  }
  bindGoal() {
    const g = this.s.goal;
    if (!g || g.status !== 'saving') throw new AppError(409, 'no_saving_goal', 'A goal-based unlock needs a goal that is still saving. Set up the goal first, or unlock on a date.');
    return { goalId: g.id, goalName: g.name, goalTargetCentsAtSeal: g.targetCents };
  }

  /** Tighten-only change: the date only moves later, a goal can be added, nothing can be removed. */
  tightenUnlock(r, { unlockRule = r.unlockRule, unlockDate } = {}) {
    const loosen = [];
    const allowed = { date: ['date', 'date_and_goal'], goal: ['goal', 'date_and_goal'], date_and_goal: ['date_and_goal'] };
    if (!UNLOCK_RULES.includes(unlockRule)) throw new AppError(400, 'bad_unlock', `Unlock rule must be one of: ${UNLOCK_RULES.join(', ')}.`);
    if (!allowed[r.unlockRule].includes(unlockRule)) loosen.push(`change the unlock rule from "${r.unlockRule}" to "${unlockRule}"`);
    const next = { unlockRule, unlockDate: r.unlockDate, goalId: r.goalId, goalName: r.goalName, goalTargetCentsAtSeal: r.goalTargetCentsAtSeal };
    if (unlockRule !== 'goal' && !loosen.length) {
      const d = unlockDate ?? r.unlockDate;
      if (r.unlockDate && d < r.unlockDate) loosen.push('move the unlock date earlier');
      else next.unlockDate = d === r.unlockDate ? d : this.checkDate(d);
    }
    if (loosen.length) {
      this.audit('lock_loosening_refused', { attempted: loosen, sealedLogin: r.label });
      throw new AppError(423, 'lock_loosening_blocked', `Sealed login: you can't ${loosen.join(', ')}. The unlock date can only move later.`, { attempted: loosen });
    }
    if (unlockRule !== 'date' && !r.goalId) Object.assign(next, this.bindGoal());
    return next;
  }

  // ---------- guards used by other routes ----------
  /** Sandbox reset / demo "Start over": refused while any sealed login is still locked. */
  guardWipe(tool) {
    const n = this.locked().length;
    if (!n) return;
    this.audit('sealed_login_shortcut_refused', { tool, locked: n });
    throw new AppError(423, 'sealed_login_locked', `A sealed login is still locked. ${tool === 'demo_wipe' ? '"Start over"' : 'Reset'} is refused until it unlocks, so it can't be used to get around the seal. (Clearing this site's data in the browser erases it without revealing it.)`);
  }
  /** Time-travel / simulate tools: refused while a goal-bound sealed login is locked (fictional money must not open it). */
  guardShortcut(tool) {
    const n = this.goalBoundLocked().length;
    if (!n) return;
    this.audit('sealed_login_shortcut_refused', { tool, locked: n });
    throw new AppError(423, 'sealed_login_locked', 'A sealed login is waiting for your goal, so the sandbox time-travel and simulate tools are off until it unlocks. Deposits keep running on their real dates.');
  }
  /** Lowering the goal a sealed login waits for is refused (even while that goal is still a draft). */
  guardGoalChange(g, next) {
    const waiting = this.locked().filter((r) => r.goalId === g.id && r.unlockRule !== 'date');
    if (!waiting.length || next.targetCents >= Math.max(...waiting.map((r) => r.goalTargetCentsAtSeal || 0))) return;
    this.audit('lock_loosening_refused', { attempted: ['lower the goal a sealed login is waiting for'], sealedLogins: waiting.map((r) => r.label) });
    throw new AppError(423, 'lock_loosening_blocked', 'A sealed login is waiting for this goal, so the target can\'t be lowered. You can raise it.');
  }

  /** Housekeeping (bootstrap): note when a sealed login becomes ready to open. */
  markReady() {
    for (const r of this.list) {
      const met = this.conditionMet(r);
      if (met && !r.readyAt) {
        r.readyAt = new Date(this.nowMs()).toISOString();
        this.audit('sealed_login_ready', { id: r.id, label: r.label, unlockRule: r.unlockRule });
        this.svc.notify('sealed_login_ready', `Sealed login ready: ${r.label}`, 'Its unlock condition is met. Open it in More > Seal my login.');
      } else if (!met && r.readyAt) r.readyAt = null; // e.g. a returned deposit put the goal back below target
    }
  }

  // ---------- views (never contain secrets or ciphertext) ----------
  view(r) {
    const met = this.conditionMet(r);
    return { id: r.id, label: r.label, status: met ? 'unlocked' : 'sealed', sealedAt: r.sealedAt, resealedAt: r.resealedAt || null, resealCount: r.resealCount || 0,
      unlockRule: r.unlockRule, unlockDate: r.unlockDate, unlockAtMs: this.unlockAtMs(r.unlockDate), goalName: r.goalName || null,
      dateMet: r.unlockDate ? this.dateMet(r) : null, goalMet: r.goalId ? this.goalMet(r) : null, fields: r.fields, passwordSource: r.passwordSource,
      openedAt: r.openedAt || null, openCount: r.openCount || 0, canOpen: met };
  }
  botView(r) { return { label: r.label, status: this.conditionMet(r) ? 'unlocked' : 'sealed', sealedAt: r.sealedAt }; }
  draftMeta() {
    const d = this.activeDraft();
    return d ? { id: d.id, kind: d.kind, targetId: d.targetId, label: d.label, expiresAt: new Date(d.expiresAtMs).toISOString() } : null;
  }
  lostCardView() {
    const lc = this.s.lostCard || emptyLostCard();
    return { steps: LOST_CARD_STEPS.map((x) => ({ ...x, done: !!lc.items?.[x.id]?.done, at: lc.items?.[x.id]?.at || null })), updatedAt: lc.updatedAt,
      allDone: LOST_CARD_STEPS.every((x) => lc.items?.[x.id]?.done) };
  }
  overview() {
    return { logins: this.list.map((r) => this.view(r)), draft: this.draftMeta(), lostCard: this.lostCardView(), max: MAX_SEALED_LOGINS,
      sealPhrase: SEAL_PHRASE, resealPhrase: RESEAL_PHRASE, defaults: { label: DEFAULT_LABEL, password: PASSWORD_DEFAULTS, unlockRule: 'date' },
      goal: this.s.goal ? { name: this.s.goal.name, status: this.s.goal.status } : null, today: this.wallToday(), nowMs: this.nowMs(), cipher: this.svc.sealCipher?.kind || null };
  }

  // ---------- drafts (before sealing: values are shown so you can type them at the bank) ----------
  activeDraft() {
    const d = this.s.sealedLoginDraft;
    if (d && d.expiresAtMs <= this.nowMs()) { this.s.sealedLoginDraft = null; this.audit('sealed_login_draft_expired', { kind: d.kind, label: d.label }); return null; }
    return d || null;
  }
  async draftValues(d) { return JSON.parse(await this.cipher.decrypt(d.blob, aadFor(d.id))); }
  async draftOut(d) {
    const v = await this.draftValues(d);
    return { draft: { ...this.draftMeta(), values: v.values, keep: d.keep || [], passwordSource: d.passwordSource, passwordInfo: d.passwordInfo || null } };
  }
  async getDraft() {
    const d = this.activeDraft();
    if (!d) throw new AppError(404, 'no_draft', 'No login waiting to be sealed.');
    return this.draftOut(d);
  }
  makePassword(body) {
    if (body.passwordMode === 'enter') return { password: cleanEnteredPassword(body.password), passwordSource: 'entered', passwordInfo: null };
    const o = passwordOptions(body.passwordOptions);
    return { password: generatePassword(o), passwordSource: 'generated', passwordInfo: { length: o.length, symbolCount: o.symbolCount, symbols: o.symbols, avoidAmbiguous: o.avoidAmbiguous, bits: passwordBits(o) } };
  }
  async storeDraft(fields) {
    const id = `sld_${crypto.randomBytes(8).toString('hex')}`;
    const { values, ...rest } = fields;
    const d = { id, ...rest, createdAt: new Date(this.nowMs()).toISOString(), expiresAtMs: this.nowMs() + DRAFT_TTL_MS };
    d.blob = await this.cipher.encrypt(JSON.stringify({ values }), aadFor(id));
    this.s.sealedLoginDraft = d;
    return d;
  }
  /** Step 1: generate (or enter) the login. Returns the values ONCE so they can be typed at the bank. */
  async createDraft(body = {}) {
    if (this.list.length >= MAX_SEALED_LOGINS) throw new AppError(409, 'too_many', `Up to ${MAX_SEALED_LOGINS} sealed logins.`);
    const label = cleanLabel(body.label ?? DEFAULT_LABEL);
    const secrets = cleanSecrets(body);
    const pw = this.makePassword(body);
    const values = { ...secrets, password: pw.password };
    const d = await this.storeDraft({ kind: 'new', targetId: null, label, values, passwordSource: pw.passwordSource, passwordInfo: pw.passwordInfo, keep: [] });
    this.audit('sealed_login_draft_created', { kind: 'new', label, passwordSource: pw.passwordSource, ...(pw.passwordInfo ? { length: pw.passwordInfo.length } : {}), questions: secrets.questions.length });
    return this.draftOut(d);
  }
  discardDraft() {
    const d = this.activeDraft();
    if (d) { this.s.sealedLoginDraft = null; this.audit('sealed_login_draft_discarded', { kind: d.kind, label: d.label }); }
    return { ok: true };
  }
  checkConfirm(body, phrase, boxes) {
    if (String(body.typed || '').trim().toUpperCase() !== phrase) throw new AppError(400, 'typed_confirmation_required', `Type exactly: ${phrase}`);
    const missing = boxes.filter((b) => body[b] !== true);
    if (missing.length) throw new AppError(400, 'checklist_incomplete', 'Tick the checklist first: enter the login at the bank and test that you can log in with it.', { missing });
  }
  /** Step 3: seal. After this the values are never shown again until the unlock condition is met. */
  async seal(body = {}) {
    const d = this.activeDraft();
    if (!d || d.kind !== 'new' || (body.draftId && body.draftId !== d.id)) throw new AppError(409, 'no_draft', 'Generate or enter the login first (the draft may have expired after 2 hours).');
    this.checkConfirm(body, SEAL_PHRASE, ['enteredAtBank', 'confirmedLogin']);
    if (this.list.length >= MAX_SEALED_LOGINS) throw new AppError(409, 'too_many', `Up to ${MAX_SEALED_LOGINS} sealed logins.`);
    const unlock = this.freshUnlock(body);
    const { values } = await this.draftValues(d);
    const id = `sl_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date(this.nowMs()).toISOString();
    const r = { id, label: d.label, ...unlock, passwordSource: d.passwordSource, fields: SECRET_FIELDS.filter((f) => (f === 'questions' ? values.questions?.length : values[f])),
      cipher: this.cipher.kind, blob: await this.cipher.encrypt(JSON.stringify(values), aadFor(id)), sealedAt: now, createdAt: now, resealedAt: null, resealCount: 0, openedAt: null, openCount: 0, readyAt: null };
    this.list.push(r);
    this.s.sealedLoginDraft = null;
    this.audit('sealed_login_sealed', { id, label: r.label, unlockRule: r.unlockRule, unlockDate: r.unlockDate, goal: r.goalName, passwordSource: r.passwordSource, fields: r.fields });
    return { sealed: this.view(r) };
  }

  // ---------- reseal (the bank forced a password change) ----------
  async createResealDraft(body = {}) {
    const r = this.find(body.id);
    const old = JSON.parse(await this.cipher.decrypt(r.blob, aadFor(r.id))); // stays on the server; never returned
    const pw = this.makePassword(body);
    if (pw.password === old.password) throw new AppError(400, 'same_password', 'That is the password already sealed. The bank needs a new one.');
    const rep = body.replace || {};
    const changed = cleanSecrets({ username: rep.username, recoveryEmail: rep.recoveryEmail, phone: rep.phone, notes: rep.notes });
    const values = { password: pw.password };
    for (const f of ['username', 'recoveryEmail', 'phone', 'notes']) if (changed[f]) values[f] = changed[f];
    if (body.regenerateAnswers === true && old.questions?.length) values.questions = old.questions.map((q) => ({ question: q.question, answer: generateAnswer(), generated: true }));
    const keep = SECRET_FIELDS.filter((f) => values[f] === undefined && (f === 'questions' ? old.questions?.length : old[f]));
    const d = await this.storeDraft({ kind: 'reseal', targetId: r.id, label: r.label, values, passwordSource: pw.passwordSource, passwordInfo: pw.passwordInfo, keep });
    this.audit('sealed_login_reseal_draft_created', { id: r.id, label: r.label, passwordSource: pw.passwordSource, replaced: Object.keys(values).filter((f) => f !== 'password'), kept: keep });
    return this.draftOut(d);
  }
  async reseal(body = {}) {
    const d = this.activeDraft();
    if (!d || d.kind !== 'reseal' || (body.draftId && body.draftId !== d.id)) throw new AppError(409, 'no_draft', 'Start the reseal first (the draft may have expired after 2 hours).');
    this.checkConfirm(body, RESEAL_PHRASE, ['changedAtBank', 'confirmedLogin']);
    const r = this.find(d.targetId);
    const wasOpen = this.conditionMet(r);
    let unlock = null;
    if (wasOpen) {
      // It had already opened: a reseal starts a new lock, so it needs a new unlock setting that is locked right now.
      unlock = this.freshUnlock(body);
    } else if (body.unlockRule || body.unlockDate) unlock = this.tightenUnlock(r, body);
    const old = JSON.parse(await this.cipher.decrypt(r.blob, aadFor(r.id)));
    const { values } = await this.draftValues(d);
    const merged = { ...old, ...values };
    r.blob = await this.cipher.encrypt(JSON.stringify(merged), aadFor(r.id));
    r.cipher = this.cipher.kind;
    r.fields = SECRET_FIELDS.filter((f) => (f === 'questions' ? merged.questions?.length : merged[f]));
    r.passwordSource = d.passwordSource; r.resealedAt = new Date(this.nowMs()).toISOString(); r.resealCount = (r.resealCount || 0) + 1; r.readyAt = null;
    if (unlock) Object.assign(r, unlock);
    this.s.sealedLoginDraft = null;
    this.audit('sealed_login_resealed', { id: r.id, label: r.label, passwordSource: r.passwordSource, resealCount: r.resealCount, unlockRule: r.unlockRule, unlockDate: r.unlockDate, newLock: wasOpen });
    return { sealed: this.view(r) };
  }

  // ---------- non-secret edits ----------
  updateLabel({ id, label }) {
    const r = this.find(id);
    const next = cleanLabel(label);
    if (next !== r.label) { this.audit('sealed_login_label_updated', { id, from: r.label, to: next }); r.label = next; }
    return { sealed: this.view(r) };
  }
  updateUnlock(body = {}) {
    const r = this.find(body.id);
    const before = { unlockRule: r.unlockRule, unlockDate: r.unlockDate };
    const next = this.tightenUnlock(r, body);
    Object.assign(r, next);
    if (JSON.stringify(before) !== JSON.stringify({ unlockRule: r.unlockRule, unlockDate: r.unlockDate })) this.audit('sealed_login_unlock_tightened', { id: r.id, label: r.label, before, after: { unlockRule: r.unlockRule, unlockDate: r.unlockDate, goal: r.goalName } });
    return { sealed: this.view(r) };
  }

  // ---------- reveal / delete ----------
  lockedMessage(r) {
    const parts = [];
    if (r.unlockRule !== 'goal' && !this.dateMet(r)) parts.push(`the unlock date (${r.unlockDate})`);
    if (r.unlockRule !== 'date' && !this.goalMet(r)) parts.push(`your goal${r.goalName ? ` "${r.goalName}"` : ''} being reached (settled balance)`);
    return `Sealed until ${parts.join(' and ')}. There is no passcode, override or early reveal.`;
  }
  /** User: reveal after the unlock condition is met. Before that: always 423, logged. Passcodes are ignored on purpose. */
  async reveal(body = {}, { by = 'user' } = {}) {
    const r = this.find(body.id);
    if (!this.conditionMet(r)) {
      this.audit('sealed_login_reveal_refused', { id: r.id, label: r.label, by, reason: 'still_sealed', passcodeOffered: body.passcode !== undefined || body.unlockCode !== undefined });
      throw new AppError(423, 'sealed_until_unlock', `${this.lockedMessage(r)} This attempt was logged.`);
    }
    const values = JSON.parse(await this.cipher.decrypt(r.blob, aadFor(r.id)));
    r.openedAt = new Date(this.nowMs()).toISOString(); r.openCount = (r.openCount || 0) + 1;
    this.audit('sealed_login_revealed', { id: r.id, label: r.label, unlockRule: r.unlockRule, openCount: r.openCount });
    return { sealed: this.view(r), values };
  }
  delete({ id, confirm } = {}) {
    const r = this.find(id);
    if (!this.conditionMet(r)) {
      this.audit('sealed_login_delete_refused', { id: r.id, label: r.label, reason: 'still_sealed' });
      throw new AppError(423, 'sealed_until_unlock', `Deleting is refused while the login is sealed (it would not reveal anything, but it stays for the record). ${this.lockedMessage(r)}`);
    }
    if (confirm !== true) throw new AppError(400, 'confirm_required', 'Confirm deleting the sealed login.');
    this.s.sealedLogins = this.list.filter((x) => x !== r);
    this.audit('sealed_login_deleted', { id: r.id, label: r.label });
    return { ok: true };
  }

  // ---------- lost-card checklist ----------
  setLostCardStep({ item, done } = {}) {
    if (!LOST_CARD_STEPS.some((x) => x.id === item)) throw new AppError(400, 'bad_item', 'Unknown checklist item.');
    if (!this.s.lostCard || typeof this.s.lostCard !== 'object') this.s.lostCard = emptyLostCard();
    const now = new Date(this.nowMs()).toISOString();
    const was = !!this.s.lostCard.items[item]?.done;
    this.s.lostCard.items[item] = { done: done === true, at: now };
    this.s.lostCard.updatedAt = now;
    if (was !== (done === true)) this.audit('lost_card_step', { item, done: done === true });
    return this.lostCardView();
  }
}
