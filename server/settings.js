// Config-driven settings. Defaults live in config/default-settings.json; the user's overrides are stored in
// state.settings and validated here. Settings are DEFAULTS for new goals/cycles: changing them never loosens
// a goal that is already locked (see Service.setGoal for the loosening rules).
// Deliberately NOT settings: provider / production mode (env + code only), emergency stop, the audit log.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'default-settings.json');
export const DEFAULT_SETTINGS = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const int = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const oneOf = (...xs) => (v) => xs.includes(v);
const bool = (v) => typeof v === 'boolean';
const cents = (min, max) => int(min, max);

// Every settable key with its validator. Anything not listed here is rejected.
export const SCHEMA = {
  'goal.name': (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 60,
  'goal.targetCents': cents(100, 10_000_000),
  'goal.lockDays': int(1, 3650),
  'goal.unlockRule': oneOf('goal', 'goal_and_date'),
  'goal.milestonesCents': (v) => Array.isArray(v) && v.length <= 10 && v.every(cents(100, 10_000_000)),
  'hardLock.defaultOn': bool,
  'hardship.coolingOffDaysDefault': int(7, 365),
  'hardship.minCoolingOffDays': int(7, 365),
  'contribution.amountCents': cents(100, 500_000),
  'contribution.frequency': oneOf('benefit', 'monthly', 'biweekly', 'weekly'),
  'contribution.benefitType': oneOf('ssi', 'ssdi_3rd', 'ssdi_wed2', 'ssdi_wed3', 'ssdi_wed4', 'custom'),
  'contribution.offsetDays': int(0, 10),
  'safety.bufferCents': cents(0, 1_000_000),
  'safety.onInsufficientFunds': oneOf('defer', 'skip'),
  'safety.deferMaxBusinessDays': int(0, 10),
  'safety.requireBalanceCheck': bool,
  'safety.pauseAfterReturns': int(1, 10),
  'unlock.codeExpiryDays': int(1, 365),
  'unlock.maxAttempts': int(1, 20),
  'rollover.defaultWithdrawCents': cents(0, 10_000_000),
  'rollover.defaultNewTargetCents': cents(100, 10_000_000),
  'rollover.fullWithdrawal': oneOf('close', 'restart'),
  'notifications.console': bool,
  'notifications.inApp': bool,
  'notifications.webhook': bool,
  'bot.rateLimitPerMinute': int(1, 600),
  'bot.approvalExpiryDays': int(1, 30),
  'mock.fundingBalanceCents': cents(0, 100_000_000),
};

// Keys an AI bot may never change, not even through an approval request.
export const BOT_FORBIDDEN_SETTINGS = ['hardLock.defaultOn', 'hardship.coolingOffDaysDefault', 'hardship.minCoolingOffDays', 'unlock.maxAttempts', 'unlock.codeExpiryDays', 'bot.rateLimitPerMinute'];

const get = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
function set(o, k, v) { const ps = k.split('.'); let c = o; for (const p of ps.slice(0, -1)) c = c[p] = c[p] && typeof c[p] === 'object' ? c[p] : {}; c[ps.at(-1)] = v; }

export function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key)); else out[key] = v;
  }
  return out;
}

export function effectiveSettings(overrides = {}) {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(flatten(overrides))) if (SCHEMA[k]) set(out, k, v);
  return out;
}

/** Validate a (nested or dotted) patch. Returns { patch: dotted, errors }. */
export function validatePatch(patch) {
  const flat = flatten(patch);
  const errors = [];
  for (const [k, v] of Object.entries(flat)) {
    if (!SCHEMA[k]) errors.push(`Unknown or non-settable key: ${k}`);
    else if (!SCHEMA[k](v)) errors.push(`Invalid value for ${k}`);
  }
  return { patch: flat, errors };
}

export function applyPatch(overrides, flatPatch) {
  const out = structuredClone(overrides || {});
  for (const [k, v] of Object.entries(flatPatch)) set(out, k, v);
  return out;
}
export { get as getPath };
