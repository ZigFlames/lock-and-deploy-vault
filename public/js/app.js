// Lock & Deploy savings-vault prototype front end. No secrets live here: the browser only ever sees
// link tokens / public tokens (short-lived), account names + last-4 masks, and (once) the unlock code.
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
let S = null; // latest /api/state
let AUTH = null; // { setup, loggedIn }
let shownCode = null; // unlock code shown once (kept only in memory for this screen)
let shownKey = null;  // new bot key shown once

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (c) => `$${Math.round(Number(c || 0) / 100).toLocaleString('en-US')}`;
const pretty = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const short = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
const acctLabel = (a) => (a ? `${a.name} ••${a.mask}` : '—');
const pct = (n) => Math.max(0, Math.min(100, Math.round(n * 100)));

async function api(path, body) {
  const res = await (window.LDB_TRANSPORT || fetch)(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { code: data.error, status: res.status, data });
  return data;
}
function toast(msg, bad = false) {
  const t = document.createElement('div'); t.className = `toast${bad ? ' toast--bad' : ''}`; t.textContent = msg;
  $('#toast-root').appendChild(t); setTimeout(() => t.remove(), 3800);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); await refresh(); return r; } catch (e) { toast(e.message, true); if (e.status === 401) await refresh(); return null; }
}
async function refresh() {
  try { S = await api('/api/state'); AUTH = { setup: true, loggedIn: true }; } catch (e) {
    if (e.status !== 401) throw e;
    S = null; AUTH = await api('/api/auth/status');
  }
  render();
}

const LOCK_SVG = (open, size = 64) => `<svg class="lock" width="${size}" height="${Math.round(size * 1.19)}" viewBox="0 0 72 86" aria-hidden="true">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9CD6C"/><stop offset="1" stop-color="#B8922A"/></linearGradient></defs>
  <path d="M18 40 V26 a18 18 0 0 1 36 0 V40" fill="none" stroke="url(#lg)" stroke-width="8" stroke-linecap="round" ${open ? 'transform="translate(0 -12) rotate(-12 54 40)"' : ''}/>
  <rect x="6" y="36" width="60" height="46" rx="12" fill="url(#lg)"/><circle cx="36" cy="56" r="6" fill="#0A0A0B"/><rect x="33" y="58" width="6" height="12" rx="3" fill="#0A0A0B"/></svg>`;

function ring(p) {
  const r = 76, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(1, p)));
  return `<svg class="ring" width="168" height="168" viewBox="0 0 168 168" aria-hidden="true">
    <circle cx="84" cy="84" r="${r}" fill="none" stroke="#26262B" stroke-width="10"/>
    <circle cx="84" cy="84" r="${r}" fill="none" stroke="#D4AF37" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
}
const chip = (status) => `<span class="chip chip--${esc(status)}">${esc(String(status).replace(/_/g, ' '))}</span>`;

// ---------------- Auth ----------------
function viewAuth() {
  const setup = !AUTH.setup;
  return `<section class="card auth-card">
    ${LOCK_SVG(false, 56)}
    <h1>${setup ? 'Set your app passcode' : 'Unlock the app'}</h1>
    <p class="small muted">${setup ? 'This passcode protects the app on this computer (it is not your bank password, and the AI bot never gets it). At least 8 characters.' : 'Enter your app passcode. This opens the app, not the vault.'}</p>
    <form id="auth-form"><label class="field"><span>Passcode</span><input type="password" name="passcode" minlength="8" autocomplete="${setup ? 'new-password' : 'current-password'}" required data-testid="passcode"></label>
    <button class="btn btn--gold btn--block" type="submit" data-testid="auth-submit">${setup ? 'Save passcode' : 'Open app'}</button></form>
    <p class="small muted" data-mt><a href="#/bank">About your bank account &amp; emergency info</a></p>
  </section>`;
}

// ---------------- Home ----------------
function pendingVsSettled() {
  const g = S.goal, t = S.totals;
  const target = g?.targetCents || 1;
  const sP = pct(t.vaultCents / target), pP = Math.min(100 - sP, pct(t.pendingCents / target));
  return `<div class="card pvs" data-testid="pending-vs-settled">
    <div class="row-between"><h2>Settled vs pending</h2><span class="small muted">goal ${money0(target)}</span></div>
    <div class="pvs__bar" role="img" aria-label="${money(t.vaultCents)} settled, ${money(t.pendingCents)} pending"><span class="pvs__settled w-${sP}"></span><span class="pvs__pending w-${pP}"></span></div>
    <div class="pvs__legend"><span><i class="sw sw--settled"></i>Settled ${money(t.vaultCents)}</span><span><i class="sw sw--pending"></i>Pending ${money(t.pendingCents)}</span><span><i class="sw sw--left"></i>To go ${money(Math.max(0, target - t.vaultCents - t.pendingCents))}</span></div>
    <p class="small muted" data-mt>Only <strong>settled</strong> deposits count toward the lock. Pending money is on its way and can still be returned by the bank.${t.returnedCents ? ` Returned so far: ${money(t.returnedCents)} (never counted).` : ''}</p>
  </div>`;
}
function banners() {
  const out = [];
  if (S.pendingApprovals) out.push(`<a class="banner" href="#/inbox" data-testid="approval-banner"><span class="banner__icon">${S.pendingApprovals}</span><span class="banner__body"><strong>Your bot is waiting for approval</strong><br><span class="small muted">Nothing happens until you approve it in the Inbox.</span></span></a>`);
  for (const n of S.notifications) out.push(`<div class="banner" data-testid="notification"><span class="banner__icon">${n.type === 'goal_reached' ? '✓' : n.type.startsWith('milestone') ? '★' : '!'}</span><span class="banner__body"><strong>${esc(n.title)}</strong><br><span class="small muted">${esc(n.body || '')}</span></span><button class="x" data-action="dismiss" data-id="${esc(n.id)}" aria-label="Dismiss">×</button></div>`);
  return out.join('');
}
function viewHome() {
  const g = S.goal, t = S.totals, s = S.schedule;
  const unlocked = g?.status === 'unlocked';
  const funding = S.accounts.find((a) => a.id === S.roles.fundingAccountId);
  const dest = S.accounts.find((a) => a.id === S.roles.destinationAccountId);
  const steps = [
    ['Link your two bank accounts', S.accounts.length >= 2, '#/accounts'],
    ['Pick funding + savings accounts', !!(funding && dest), '#/accounts'],
    ['Confirm goal, Hard Lock and schedule', !!s, '#/plan'],
    ['Benefit-limit check', !!S.benefitAck, '#/authorize'],
    ['Authorize the automatic deposits', S.authorization?.status === 'active', '#/authorize'],
  ];
  const setupDone = steps.every((x) => x[1]);
  return `
  ${banners()}
  <section class="card hero">
    <div class="hero__visual">${ring(g ? t.vaultCents / g.targetCents : 0)}<div class="hero__lock">${LOCK_SVG(unlocked)}</div></div>
    <div class="eyebrow">${esc(g ? g.name : 'No goal yet')}${g && g.cycle > 1 ? ` · cycle ${g.cycle}` : ''}</div>
    <div class="hero__amount" data-testid="locked-amount">${money(t.vaultCents)}</div>
    <div class="muted small">settled of ${g ? money0(g.targetCents) : '—'}</div>
    ${g ? `<span class="pill ${unlocked ? 'pill--unlocked' : 'pill--locked'}" data-testid="lock-pill">${unlocked ? 'Unlocked · goal reached' : g.status === 'closed' ? 'Closed' : g.hardLock ? `Hard Lock · opens at ${money0(g.targetCents)} settled` : `Locked · opens at ${money0(g.targetCents)} settled`}</span>` : ''}
  </section>
  <div class="stats">
    <div class="stat"><div class="stat__label">Settled</div><div class="stat__value" data-testid="settled-amount">${money(t.vaultCents)}</div></div>
    <div class="stat"><div class="stat__label">Pending</div><div class="stat__value" data-testid="pending-amount">${money(t.pendingCents)}</div></div>
    <div class="stat"><div class="stat__label">Next deposit</div><div class="stat__value">${s?.status === 'active' && S.nextPulls[0] ? short(S.nextPulls[0]) : s ? chip(s.status) : '—'}</div></div>
  </div>
  ${g ? pendingVsSettled() : ''}
  ${g?.milestones?.length ? `<div class="card"><h2>Milestones</h2>${g.milestones.map((m) => `<div class="row-between small"><span>${m.reachedOn ? '★' : '☆'} ${esc(m.label)}</span><span class="muted">${m.reachedOn ? `reached ${short(m.reachedOn)}` : `${money0(Math.max(0, m.targetCents - t.vaultCents))} to go`}</span></div>`).join('')}<div class="row-between small"><span>🔒 Goal ${money0(g.targetCents)} (unlock)</span><span class="muted">${unlocked ? `reached ${short(g.reachedOn)}` : `${money0(g.remainingCents)} to go`}</span></div></div>` : ''}
  ${S.overBenefitLimit ? `<div class="card card--warn"><strong class="warn">Benefit limit heads-up.</strong> <span class="small">This goal is above the SSI $2,000 resource limit for an individual. See the Authorize step and consider an ABLE account.</span></div>` : ''}
  ${setupDone ? '' : `<div class="section-title">Setup</div>
  <div class="card"><ol class="steps">${steps.map(([label, done, href], i) => `<li><span class="dot ${done ? 'dot--done' : ''}">${done ? '✓' : i + 1}</span><a href="${href}">${esc(label)}</a></li>`).join('')}</ol></div>`}
  <div class="card small muted">Provider: <strong class="gold">${esc(S.provider.label)}</strong>. The app stores only provider tokens (encrypted) and IDs, plus account names and last-4 digits. It never sees bank usernames or passwords and never touches bank login or account recovery. Real money is <strong>hard-disabled</strong>.</div>`;
}

function viewAccounts() {
  const byItem = S.items.map((it) => ({ it, accts: S.accounts.filter((a) => a.itemId === it.id) }));
  return `
  <h1>Accounts</h1>
  <div class="card">
    <h2>Link a bank</h2>
    <p class="small muted">Linking uses a token flow (${esc(S.provider.label)}). You sign in inside the provider's window; this app gets a one-time token, never your username or password.</p>
    <button class="btn btn--gold btn--block" data-action="link" data-testid="link-bank">Link a bank account</button>
    ${S.provider.id === 'plaid-sandbox' ? '<button class="btn btn--ghost btn--block" data-action="plaid-skip" data-mt>Sandbox: skip Link (First Platypus Bank)</button>' : ''}
  </div>
  ${S.accounts.length ? `
  <div class="section-title">Linked accounts · choose roles</div>
  <form class="card" id="roles-form">
    ${byItem.map(({ it, accts }) => `
      <div class="row-between"><strong>${esc(it.institutionName)}</strong><button type="button" class="btn btn--sm btn--ghost" data-action="unlink" data-id="${esc(it.id)}">Unlink</button></div>
      ${accts.map((a) => `
      <div class="acct">
        <div class="acct__icon">${esc(a.subtype === 'savings' ? 'S' : 'C')}</div>
        <div class="acct__main"><div class="acct__name">${esc(a.name)}</div><div class="small muted">${esc(a.subtype)} ••${esc(a.mask)}</div></div>
        <div class="role-pick">
          <label class="${S.roles.fundingAccountId === a.id ? 'on' : ''}"><input type="radio" name="funding" value="${esc(a.id)}" ${S.roles.fundingAccountId === a.id ? 'checked' : ''} data-testid="fund-${esc(a.mask)}">Pull from</label>
          <label class="${S.roles.destinationAccountId === a.id ? 'on' : ''}"><input type="radio" name="dest" value="${esc(a.id)}" ${S.roles.destinationAccountId === a.id ? 'checked' : ''} data-testid="dest-${esc(a.mask)}">Save to</label>
        </div>
      </div>`).join('')}`).join('<hr class="sep">')}
    <button class="btn btn--gold btn--block" type="submit" data-testid="save-roles">Save accounts</button>
    <p class="small muted" data-mt>"Pull from" = funding account (debited on schedule). "Save to" = your savings account. Changing either needs a new authorization.</p>
  </form>` : '<p class="muted small">No banks linked yet.</p>'}`;
}


// ---------------- Plan (goal + Hard Lock + schedule) ----------------
function viewPlan() {
  const g = S.goal;
  const s = S.schedule || { amountCents: S.settings.contribution.amountCents, frequency: S.settings.contribution.frequency, benefitType: S.settings.contribution.benefitType, offsetDays: S.settings.contribution.offsetDays, dayOfMonth: 2, anchorDate: S.today, benefitDay: 1 };
  const sel = (v, cur) => (v === cur ? 'selected' : '');
  const locked = g && g.status === 'saving' && !g.draft;
  const done = g && g.status !== 'saving';
  return `
  <h1>Plan</h1>
  ${done ? `<div class="card card--gold"><p>This goal is ${esc(g.status)}. Start the next one with <a href="#/rollover">Roll Over &amp; Relock</a>.</p></div>` : `
  <form class="card" id="goal-form">
    <div class="row-between"><h2>Goal</h2>${g.hardLock ? '<span class="badge-lock">🔒 Hard Lock</span>' : ''}</div>
    ${locked ? `<p class="small warn" data-testid="locked-note">Locked since ${esc(new Date(g.lockedAt).toLocaleDateString())}. You can raise the goal or add time. Lowering the target, shortening the lock or turning off Hard Lock is blocked until the goal is reached.</p>` : '<p class="small muted">Draft: everything can be changed until you authorize deposits. After that, the lock can only get stronger.</p>'}
    <label class="field"><span>What are you saving for?</span><input type="text" name="name" value="${esc(g.name)}" maxlength="60" required></label>
    <div class="grid2">
      <label class="field"><span>Target ($)</span><input type="number" name="target" min="${locked ? esc(g.targetCents / 100) : 1}" step="1" value="${esc(g.targetCents / 100)}" required data-testid="goal-target"></label>
      <label class="field"><span>Lock at least until</span><input type="date" name="releaseDate" value="${esc(g.releaseDate)}" min="${esc(locked ? g.releaseDate : S.today)}" required data-testid="release-date"></label>
    </div>
    <label class="field"><span>Unlock rule</span><select name="unlockRule">
      <option value="goal" ${sel('goal', g.unlockRule)} ${locked && g.unlockRule === 'goal_and_date' ? 'disabled' : ''}>When the settled balance reaches the goal</option>
      <option value="goal_and_date" ${sel('goal_and_date', g.unlockRule)}>Goal reached AND the date above has passed (stricter)</option></select></label>
    <label class="field"><span>Milestones along the way ($, comma-separated)</span><input type="text" name="milestones" value="${esc(g.milestones.map((m) => m.targetCents / 100).join(', '))}" placeholder="1500, 2500"></label>
    <div class="toggle-row"><span><strong>Hard Lock</strong><br><span class="small muted">No early unlock of any kind in the app. Only settled deposits reaching the goal open the vault.</span></span><input type="checkbox" name="hardLock" ${g.hardLock ? 'checked' : ''} ${locked && g.hardLock ? 'disabled' : ''} data-testid="hardlock-toggle"></div>
    <div data-hardship ${g.hardLock ? 'hidden' : ''}>
      <div class="toggle-row"><span><strong>Hardship release</strong> (optional)<br><span class="small muted">Early release with a long cooling-off period, typed confirmation, cancellable during the wait. Can only be chosen now, never added later.</span></span><input type="checkbox" name="hardshipEnabled" ${g.hardship.enabled ? 'checked' : ''} ${locked ? 'disabled' : ''}></div>
      <label class="field"><span>Cooling-off days (min ${esc(S.settings.hardship.minCoolingOffDays)})</span><input type="number" name="coolingOffDays" min="${esc(locked ? g.hardship.coolingOffDays : S.settings.hardship.minCoolingOffDays)}" max="365" value="${esc(g.hardship.coolingOffDays)}" ${locked && !g.hardship.enabled ? 'disabled' : ''}></label>
    </div>
    <button class="btn btn--block" type="submit" data-testid="save-goal">${locked ? 'Save (raise / extend only)' : 'Save goal'}</button>
  </form>`}
  <form class="card" id="schedule-form">
    <h2>Automatic deposits</h2>
    <p class="small muted">Funding account: <strong>${esc(acctLabel(S.accounts.find((a) => a.id === S.roles.fundingAccountId)))}</strong> → savings: <strong>${esc(acctLabel(S.accounts.find((a) => a.id === S.roles.destinationAccountId)))}</strong></p>
    <label class="field"><span>Amount per deposit ($)</span><input type="number" name="amount" min="1" step="0.01" value="${esc((s.amountCents / 100).toFixed(2))}" required data-testid="amount"></label>
    <label class="field"><span>How often</span>
      <select name="frequency" data-testid="frequency">
        <option value="benefit" ${sel('benefit', s.frequency)}>After my benefit payment arrives</option>
        <option value="monthly" ${sel('monthly', s.frequency)}>Monthly on a set day</option>
        <option value="biweekly" ${sel('biweekly', s.frequency)}>Every 2 weeks</option>
        <option value="weekly" ${sel('weekly', s.frequency)}>Every week</option>
      </select></label>
    <div data-when="benefit">
      <label class="field"><span>When does the benefit arrive?</span>
        <select name="benefitType">
          <option value="ssi" ${sel('ssi', s.benefitType)}>SSI: 1st of month (earlier if weekend/holiday)</option>
          <option value="ssdi_3rd" ${sel('ssdi_3rd', s.benefitType)}>SS/SSDI: 3rd of month</option>
          <option value="ssdi_wed2" ${sel('ssdi_wed2', s.benefitType)}>SS/SSDI: 2nd Wednesday</option>
          <option value="ssdi_wed3" ${sel('ssdi_wed3', s.benefitType)}>SS/SSDI: 3rd Wednesday</option>
          <option value="ssdi_wed4" ${sel('ssdi_wed4', s.benefitType)}>SS/SSDI: 4th Wednesday</option>
          <option value="custom" ${sel('custom', s.benefitType)}>Other: fixed day of month</option>
        </select></label>
      <div class="grid2">
        <label class="field" data-when-benefit="custom"><span>Benefit day (1-31)</span><input type="number" name="benefitDay" min="1" max="31" value="${esc(s.benefitDay || 1)}"></label>
        <label class="field"><span>Days after it arrives</span><input type="number" name="offsetDays" min="0" max="10" value="${esc(s.offsetDays ?? 1)}" data-testid="offset"></label>
      </div>
    </div>
    <label class="field" data-when="monthly"><span>Day of month (1-31)</span><input type="number" name="dayOfMonth" min="1" max="31" value="${esc(s.dayOfMonth || 2)}"></label>
    <label class="field" data-when="weekly biweekly"><span>Start date</span><input type="date" name="anchorDate" value="${esc(s.anchorDate || S.today)}"></label>
    <div class="card card--gold" id="preview" data-testid="preview"><span class="muted small">Preview…</span></div>
    <button class="btn btn--gold btn--block" type="submit" data-testid="save-schedule">Save schedule & review authorization</button>
    <p class="small muted" data-mt>Dates on weekends or bank holidays move to the next business day. Before every deposit the balance is checked against your ${money(S.settings.safety.bufferCents)} safety buffer. Nothing is pulled until you authorize.</p>
  </form>`;
}

// ---------------- Transfers ----------------
function viewTransfers() {
  const s = S.schedule;
  const pending = S.transfers.filter((t) => t.status === 'pending').length;
  const control = !s ? '<p class="muted">No schedule yet. <a href="#/plan">Set one up</a>.</p>' : `
    <div class="status-big"><div><div class="small muted">Automatic deposits</div><strong data-testid="schedule-status">${chip(s.status)}</strong></div>
      ${s.status === 'active' ? '<button class="btn btn--sm" data-action="pause" data-testid="pause-btn">Pause future deposits</button>' : ''}
      ${s.status === 'paused' ? '<button class="btn btn--sm btn--gold" data-action="resume" data-testid="resume-btn">Resume</button>' : ''}
      ${['needs_authorization', 'revoked'].includes(s.status) ? '<a class="btn btn--sm btn--gold" href="#/authorize">Authorize</a>' : ''}
    </div>
    <p class="small muted" data-mt>${esc(s.description)}${s.completedReason === 'goal_reached' ? ' · stopped: goal reached' : ''}${s.pausedReason && s.status === 'paused' ? ` · paused by ${esc(s.pausedReason.replace(/_/g, ' '))}` : ''}</p>
    ${s.status === 'paused' ? `<p class="small warn" data-mt data-testid="paused-note">Paused: no new deposits will be created. Your ${money(S.totals.vaultCents)} saved stays locked; pausing never unlocks anything.${pending ? ` ${pending} pending transfer${pending > 1 ? 's are' : ' is'} still in flight. Cancel ${pending > 1 ? 'them' : 'it'} below if you want.` : ''} Resuming skips missed dates (no catch-up).</p>` : ''}
    ${s.status === 'active' && S.nextPulls.length ? `<div class="small muted" data-mt>Next: <span class="preview-dates">${S.nextPulls.map((d) => `<span class="chip chip--date">${short(d)}</span>`).join('')}</span></div>` : ''}
    ${['active', 'paused'].includes(s.status) ? '<details class="tools"><summary>Cancel the whole schedule</summary><p class="small muted" data-mt>Ends all future deposits and the ACH authorization. Saved money and the lock stay exactly as they are.</p><button class="btn btn--sm btn--danger" data-action="cancel-schedule">Cancel schedule</button></details>' : ''}`;
  const periods = (s?.periods || []).filter((p) => ['deferred', 'skipped'].includes(p.status));
  return `
  <h1>Transfers</h1>
  <div class="card">${control}</div>
  <div class="stats">
    <div class="stat"><div class="stat__label">Settled</div><div class="stat__value">${money(S.totals.vaultCents)}</div></div>
    <div class="stat"><div class="stat__label">Pending</div><div class="stat__value">${money(S.totals.pendingCents)}</div></div>
    <div class="stat"><div class="stat__label">Returned</div><div class="stat__value">${money(S.totals.returnedCents)}</div></div>
  </div>
  ${periods.length ? `<div class="section-title">Overdraft protection</div><div class="card">${periods.map((p) => `<div class="log-item"><div class="row-between"><span>${short(p.date)} deposit</span>${chip(p.status)}</div><div class="small muted">${esc(p.reasons.at(-1)?.reason || '')}${p.status === 'deferred' ? ` Retrying ${short(p.nextAttemptOn)}.` : ''}</div></div>`).join('')}</div>` : ''}
  <div class="section-title">Deposits</div>
  <div class="card" data-testid="transfer-list">${S.transfers.length ? S.transfers.map((t) => `
    <div class="tr" data-testid="transfer">
      <div class="row-between"><span class="tr__amt">${money(t.amountCents)}</span>${chip(t.status)}</div>
      <div class="small muted">${short(t.date)} · ${esc(t.funding.name)} ••${esc(t.funding.mask)} → ${esc(t.destination.name)} ••${esc(t.destination.mask)}</div>
      ${timeline(t)}
      ${t.failureReason ? `<div class="small bad">${esc(t.failureReason.achReturnCode ? `${t.failureReason.achReturnCode}: ` : '')}${esc(t.failureReason.description || '')}</div>` : ''}
      ${t.credit ? `<div class="small muted">Credit leg to savings: ${chip(t.credit.status)}</div>` : ''}
      <div class="btn-row" data-mt>
        ${t.status === 'pending' ? `<button class="btn btn--sm btn--danger" data-action="cancel" data-id="${esc(t.id)}" data-testid="cancel-btn">Cancel this pending transfer</button>` : ''}
      </div>
      ${['pending', 'posted', 'settled'].includes(t.status) ? `<details class="tools"><summary>Sandbox: simulate</summary><div class="btn-row" data-mt>
        ${t.status === 'pending' ? `<button class="btn btn--sm" data-action="sim" data-event="posted" data-id="${esc(t.id)}">Posted</button>` : ''}
        ${t.status !== 'settled' ? `<button class="btn btn--sm" data-action="sim" data-event="settled" data-id="${esc(t.id)}">Settled</button>` : ''}
        ${t.status !== 'pending' ? `<button class="btn btn--sm btn--danger" data-action="sim" data-event="returned" data-id="${esc(t.id)}">Return (R01)</button>` : ''}
      </div></details>` : ''}
    </div>`).join('') : '<p class="muted small">No deposits yet. Once the schedule is active, deposits appear here on their dates.</p>'}</div>
  ${S.demoClock ? `
  <div class="section-title">Sandbox demo clock</div>
  <div class="card">
    <p class="small muted">App date: <strong class="gold" data-testid="app-date">${pretty(S.today)}</strong>${S.clockOffsetDays ? ` (+${S.clockOffsetDays} days)` : ''}. Advancing runs the engine day by day, exactly like the unattended timer / <code>npm run tick</code>.</p>
    <div class="btn-row"><button class="btn btn--sm" data-action="clock" data-days="1" data-testid="clock-1">+1 day</button><button class="btn btn--sm" data-action="clock" data-days="7" data-testid="clock-7">+7 days</button><button class="btn btn--sm" data-action="clock" data-days="30" data-testid="clock-30">+30 days</button></div>
    ${S.provider.id === 'mock' ? `<label class="field" data-mt><span>Mock funding balance ($) for overdraft tests</span><input type="number" id="mock-balance" value="${esc(S.settings.mock.fundingBalanceCents / 100)}" min="0" step="1"></label><button class="btn btn--sm btn--ghost btn--block" data-action="mock-balance">Set mock balance</button>` : ''}
    <button class="btn btn--sm btn--ghost btn--block" data-mt data-action="run">Run engine now</button>
  </div>` : ''}`;
}

// ---------------- Vault ----------------
function viewVault() {
  const g = S.goal, t = S.totals, v = S.vault;
  if (!g) return '<h1>Vault</h1><p class="muted">No goal.</p>';
  const unlocked = g.status === 'unlocked';
  const h = S.hardship;
  return `
  <h1>Vault</h1>
  <section class="card hero">
    <div class="hero__lock hero__lock--inline">${LOCK_SVG(unlocked, 56)}</div>
    <div class="eyebrow" data-mt>${esc(g.name)}</div>
    <div class="hero__amount">${money(t.vaultCents)}</div>
    <div class="muted small">settled in the vault${t.pendingCents ? ` · ${money(t.pendingCents)} pending (not counted)` : ''}</div>
    <span class="pill ${unlocked ? 'pill--unlocked' : 'pill--locked'}" data-testid="vault-status">${unlocked ? 'Unlocked' : g.status === 'closed' ? 'Closed' : 'Locked'}</span>
  </section>
  ${unlocked ? `
  <section class="card card--gold" data-testid="unlock-card">
    <h2>Goal reached: ${money0(g.targetCents)} settled on ${pretty(g.reachedOn)}</h2>
    ${shownCode ? `<p class="small">Your one-time unlock code. Write it down now: it will not be shown again. Only a hash is stored.</p><div class="code-box" data-testid="unlock-code">${esc(shownCode.code)}</div><p class="small muted">Expires ${pretty(shownCode.expiresOn)} · single use · needed for any withdrawal or a rollover that withdraws.</p>`
    : v.codeWaitingToBeShown ? `<p class="small">A one-time unlock code was generated when your settled balance reached the goal. It can be shown exactly once.</p><button class="btn btn--gold btn--block" data-action="reveal-code" data-testid="reveal-code">Show my unlock code (once)</button>`
    : `<p class="small muted">Code ${v.codeUsed ? 'used' : v.codeExpired ? 'expired' : `issued ${pretty(v.codeIssuedOn)}, expires ${pretty(v.codeExpiresOn)}`}. Lost it? Generate a new one; the old one stops working.</p><button class="btn btn--block" data-action="regen-code">Generate a new unlock code</button>`}
  </section>
  <form class="card" id="withdraw-form">
    <h2>Withdraw (simulated)</h2>
    <p class="small muted">Sandbox: this records a withdrawal in the ledger only. To keep saving, use <a href="#/rollover">Roll Over &amp; Relock</a> instead.</p>
    <div class="grid2"><label class="field"><span>Amount ($)</span><input type="number" name="amount" min="0.01" step="0.01" max="${esc(t.vaultCents / 100)}" required></label>
    <label class="field"><span>Unlock code</span><input type="text" name="code" autocomplete="off" placeholder="XXXX-XXXX-XXXX" required></label></div>
    <label class="check"><input type="checkbox" name="confirm" required><span class="small">I confirm this withdrawal.</span></label>
    <button class="btn btn--block" data-mt type="submit">Record withdrawal</button>
  </form>
  <a class="btn btn--gold btn--block" href="#/rollover" data-testid="go-rollover">Roll Over &amp; Relock</a>` : g.status === 'saving' ? `
  <section class="card">
    <div class="lockline">${LOCK_SVG(false, 26)}<div><h2>${g.hardLock ? 'Hard Lock is on' : 'Locked'}</h2>
    <p class="small">${g.hardLock ? 'There is no early unlock in this app: no override code, no admin bypass, and the AI bot cannot unlock it either.' : 'This goal was created without Hard Lock.'} The vault opens only when <strong>settled</strong> deposits reach <strong>${money0(g.targetCents)}</strong>${g.unlockRule === 'goal_and_date' ? ` and ${pretty(g.releaseDate)} has passed` : ''}. ${money0(g.remainingCents)} to go.</p>
    <p class="small muted">Emergency stop and pause only stop <em>future</em> deposits. They never release money. <a href="#/bank">About your bank account</a>.</p></div></div>
  </section>
  ${g.hardship.enabled ? `
  <section class="card card--warn" data-testid="hardship-card">
    <h2>Hardship release</h2>
    ${h?.status === 'cooling_off' ? `<p class="small">Requested ${pretty(h.requestedOn)} for ${money(h.amountCents)}. Cooling-off until <strong>${pretty(h.availableOn)}</strong>.</p>
      <button class="btn btn--block" data-action="hardship-cancel">Cancel the request (keep everything locked)</button>
      ${S.today >= h.availableOn ? `<form id="hardship-complete" data-mt><label class="field"><span>Type: ${esc(S.hardshipPhrase)}</span><input type="text" name="typed" autocomplete="off"></label><label class="check"><input type="checkbox" name="confirm"><span class="small">Release ${money(h.amountCents)} now.</span></label><button class="btn btn--danger btn--block" data-mt type="submit">Complete hardship release</button></form>` : ''}`
    : `<p class="small">Chosen when this goal was created: an early release with a ${esc(g.hardship.coolingOffDays)}-day cooling-off period. Everything is logged and you can cancel during the wait.</p>
      <form id="hardship-form"><label class="field"><span>Amount ($)</span><input type="number" name="amount" min="1" step="1" max="${esc(t.vaultCents / 100)}"></label>
      <label class="field"><span>Type: ${esc(S.hardshipPhrase)}</span><input type="text" name="typed" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="confirm"><span class="small">Start the ${esc(g.hardship.coolingOffDays)}-day cooling-off.</span></label>
      <button class="btn btn--block" data-mt type="submit">Request hardship release</button></form>`}
  </section>` : ''}
  <a class="btn btn--ghost btn--block" href="#/rollover">Preview Roll Over &amp; Relock</a>` : ''}
  ${S.cycles.length || S.withdrawals.length ? `<div class="section-title">History</div><div class="card"><table class="mini">
    ${S.cycles.map((c) => `<tr><td>Cycle ${c.cycle}: ${esc(c.name)} ${money0(c.targetCents)} · ${esc(c.mode)}</td><td>${c.withdrawCents ? `−${money0(c.withdrawCents)}` : ''} → ${c.nextTargetCents ? money0(c.nextTargetCents) : 'closed'}</td></tr>`).join('')}
    ${S.withdrawals.map((w) => `<tr><td>${short(w.clockDate)} ${esc(w.kind.replace(/_/g, ' '))} (simulated)</td><td>−${money(w.amountCents)}</td></tr>`).join('')}</table></div>` : ''}`;
}

// ---------------- Roll Over & Relock ----------------
function rolloverCalc({ mode, vault, withdraw, target }) {
  const w = mode === 'full' ? vault : mode === 'raise' ? 0 : withdraw;
  const remaining = vault - w;
  return { w, remaining, additional: mode === 'full' && !target ? null : target - remaining };
}
function viewRollover() {
  const g = S.goal, t = S.totals, st = S.settings.rollover;
  const unlocked = g?.status === 'unlocked';
  const vault = unlocked ? t.vaultCents : (g?.targetCents || 300000);
  return `
  <h1>Roll Over &amp; Relock</h1>
  <p class="small muted">${unlocked ? 'Your goal is reached. Take some out (or none), set a new goal, and lock it again: deposits continue automatically.' : `Preview: what happens when you reach ${money0(vault)}. The wizard unlocks when the settled balance hits your goal.`}</p>
  <form class="card" id="rollover-form" data-testid="rollover-wizard">
    <div class="seg" role="radiogroup">
      <label class="on"><input type="radio" name="mode" value="partial" checked>Withdraw some</label>
      <label><input type="radio" name="mode" value="raise">Raise only</label>
      <label><input type="radio" name="mode" value="full">Withdraw all</label>
    </div>
    <div class="grid2">
      <label class="field" data-mode="partial"><span>Withdraw ($)</span><input type="number" name="withdraw" min="0" step="1" value="${esc(st.defaultWithdrawCents / 100)}" data-testid="rollover-withdraw"></label>
      <label class="field" data-mode="partial raise full-restart"><span>New goal ($)</span><input type="number" name="target" min="1" step="1" value="${esc(st.defaultNewTargetCents / 100)}" data-testid="rollover-target"></label>
    </div>
    <label class="field" data-mode="full"><span>After withdrawing everything</span><select name="fullAction"><option value="close" ${st.fullWithdrawal === 'close' ? 'selected' : ''}>Close the goal (stop deposits)</option><option value="restart" ${st.fullWithdrawal === 'restart' ? 'selected' : ''}>Start over from $0 toward the new goal</option></select></label>
    <label class="field" data-mode="partial raise full-restart"><span>Milestones for the new goal ($, optional)</span><input type="text" name="milestones" placeholder="e.g. 3000, 3500"></label>
    <div class="flow" id="rollover-flow"></div>
    <dl class="calc" id="rollover-calc" data-testid="rollover-calc"></dl>
    <p class="small muted" id="rollover-note" data-mt></p>
    ${unlocked ? `<label class="field" data-mt data-needs-code><span>Unlock code</span><input type="text" name="code" autocomplete="off" placeholder="XXXX-XXXX-XXXX"></label>
    <label class="check"><input type="checkbox" name="confirm"><span class="small">I authorize this rollover: record the withdrawal, set the new goal and lock it again.</span></label>
    <button class="btn btn--gold btn--block" data-mt type="submit" data-testid="rollover-submit">Roll over &amp; relock</button>` : '<button class="btn btn--block" type="button" disabled data-mt>Available when your goal is reached</button>'}
  </form>`;
}

// ---------------- Inbox (approvals) ----------------
function viewInbox() {
  const pending = S.approvals.filter((a) => a.status === 'pending');
  const done = S.approvals.filter((a) => a.status !== 'pending');
  return `
  <h1>Approvals</h1>
  <p class="small muted">Your AI bot can only <em>ask</em> for sensitive changes. Nothing below happens unless you approve it here.</p>
  <div class="card" data-testid="approvals-inbox">${pending.length ? pending.map((a) => `
    <form class="apr" data-approval="${esc(a.id)}">
      <div class="row-between"><span class="apr__type">${esc(a.type.replace(/_/g, ' '))}</span>${chip(a.status)}</div>
      <p data-mt>${esc(a.summary)}</p>
      <p class="small muted">From ${esc(a.requestedBy.name)} · ${pretty(a.createdOn)} · expires ${pretty(a.expiresOn)}</p>
      ${a.requiresUnlockCode ? '<label class="field"><span>Unlock code (required: this withdraws money)</span><input type="text" name="code" autocomplete="off" placeholder="XXXX-XXXX-XXXX"></label>' : ''}
      <label class="check"><input type="checkbox" name="confirm"><span class="small">I reviewed this and approve it.</span></label>
      <div class="btn-row" data-mt><button class="btn btn--sm btn--gold" type="submit" data-testid="approve-btn">Approve</button><button class="btn btn--sm btn--danger" type="button" data-action="reject" data-id="${esc(a.id)}">Reject</button></div>
    </form>`).join('') : '<p class="muted small">Nothing waiting.</p>'}</div>
  ${done.length ? `<div class="section-title">Decided</div><div class="card">${done.map((a) => `<div class="apr"><div class="row-between"><span class="apr__type">${esc(a.type.replace(/_/g, ' '))}</span>${chip(a.status)}</div><p class="small" data-mt>${esc(a.summary)}</p>${a.error ? `<p class="small bad">${esc(a.error.message)}</p>` : ''}</div>`).join('')}</div>` : ''}`;
}

// ---------------- Bot ----------------
let simBotLast = null; // last simulated-bot response (demo only)
const SIM_BOT_LABELS = [
  ['status', 'Read status'], ['propose_raise', 'Propose +$500 goal'], ['request_resume', 'Ask to resume deposits'], ['pause', 'Pause deposits'],
  ['prepare_rollover', 'Prepare rollover 1000 → 4000'], ['try_unlock', 'Try to unlock (refused)'], ['try_lower', 'Try to lower goal (refused)'],
  ['try_disable_hard_lock', 'Try to turn off Hard Lock (refused)'], ['try_production', 'Try production mode (refused)'], ['try_delete_audit', 'Try to delete audit (refused)'],
];
function viewSimBot() {
  return `<section class="card card--gold" data-testid="sim-bot">
    <h2>Simulated bot (Grok)</h2>
    <p class="small muted">Tap to make the bot call the real bot API with its own key. Proposals land in your Inbox; forbidden requests are refused and logged.</p>
    <div class="sim-bot-grid">${SIM_BOT_LABELS.map(([a, l]) => `<button class="btn btn--sm ${a.startsWith('try_') ? 'btn--danger' : ''}" data-action="simbot" data-bot="${a}" data-testid="simbot-${a}">${esc(l)}</button>`).join('')}</div>
    <button class="btn btn--sm btn--ghost btn--block" data-mt data-action="simbot" data-bot="new_key" data-testid="simbot-new_key">${S.simBot?.hasKey ? 'Give the bot a fresh key' : 'Give the bot a key'}</button>
    ${simBotLast ? `<div class="sim-bot-out" data-testid="sim-bot-out"><span class="chip chip--s${esc(simBotLast.httpStatus)}">${esc(simBotLast.httpStatus)}</span> <code>${esc(simBotLast.action)}</code><div class="small muted">${esc(simBotLast.body?.message || simBotLast.body?.approval?.summary || simBotLast.body?.note || (simBotLast.body?.goal ? `Goal ${money0(simBotLast.body.goal.targetCents)} · settled ${money(simBotLast.body.balances?.settledLockedCents)}` : '') || simBotLast.body?.error || 'OK')}</div></div>` : ''}
  </section>`;
}
function viewBot() {
  const keys = S.botKeys;
  return `
  <h1>AI bot</h1>
  <div class="card small muted">Architecture: <strong class="gold">You → Bot → App → Bank</strong>. The bot talks to <code>/bot/v1</code> with its own key. It never sees bank passwords or provider tokens, can't unlock the vault, and every call it makes is listed below.</div>
  ${S.simulation ? viewSimBot() : ''}
  <form class="card" id="botkey-form">
    <h2>New bot key</h2>
    <label class="field"><span>Name</span><input type="text" name="name" value="Grok" maxlength="40"></label>
    <div class="small muted">Scopes</div>
    ${[['read', 'Read balances, goals, transfers, schedule'], ['propose', 'Propose goal changes / prepare rollovers (you approve)'], ['pause', 'Pause future deposits (always safe)'], ['request', 'Ask for sensitive actions (you approve)']].map(([k, l]) => `<label class="toggle-row"><span><strong>${k}</strong> <span class="small muted">${l}</span></span><input type="checkbox" name="scope" value="${k}" ${k !== 'request' ? 'checked' : ''}></label>`).join('')}
    <button class="btn btn--gold btn--block" data-mt type="submit" data-testid="create-key">Create key</button>
    ${shownKey ? `<p class="small" data-mt>Copy this key into the bot's environment as <code>LDB_BOT_KEY</code>. It is shown once; only a hash is stored.</p><div class="key-box" data-testid="new-key">${esc(shownKey.key)}</div>` : ''}
  </form>
  ${keys.length ? `<div class="section-title">Keys</div><div class="card">${keys.map((k) => `<div class="log-item"><div class="row-between"><strong>${esc(k.name)}</strong>${k.revokedAt ? chip('revoked') : `<button class="btn btn--sm btn--danger" data-action="revoke-key" data-id="${esc(k.id)}">Revoke</button>`}</div><div class="small muted">ldbk_${esc(k.id)}… · ${esc(k.scopes.join(', '))} · last used ${k.lastUsedAt ? esc(new Date(k.lastUsedAt).toLocaleString()) : 'never'}</div></div>`).join('')}</div>` : ''}
  <div class="section-title">Bot activity log</div>
  <div class="card" data-testid="bot-activity">${S.botActivity.length ? S.botActivity.map((a) => `<div class="act"><span class="chip chip--s${esc(a.status)}">${esc(a.status)}</span><code>${esc(a.method)} ${esc(a.path)}</code><span class="muted">${esc(new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span><span></span><span class="small muted">${esc(a.keyName || 'unknown key')}${a.error ? ` · ${esc(a.error)}` : ''}${a.summary ? ` · ${esc(a.summary)}` : ''}</span><span></span></div>`).join('') : '<p class="muted small">No bot calls yet.</p>'}</div>
  <div class="card small muted">CLI: <code>LDB_BOT_KEY=… node bot-cli.js status</code> · spec: <code>docs/bot-api.openapi.json</code></div>`;
}

// ---------------- Settings ----------------
function viewSettings() {
  const s = S.settings;
  const num = (name, label, val, attrs = '') => `<label class="field"><span>${label}</span><input type="number" name="${name}" value="${esc(val)}" ${attrs}></label>`;
  const tog = (name, label, val, sub = '') => `<label class="toggle-row"><span>${label}${sub ? `<br><span class="small muted">${sub}</span>` : ''}</span><input type="checkbox" name="${name}" ${val ? 'checked' : ''}></label>`;
  return `
  <h1>Settings</h1>
  <p class="small muted">Defaults for new goals and the engine. Changing settings never loosens a goal that is already locked.</p>
  <form class="card" id="settings-form" data-testid="settings-form">
    <h2>New goals</h2>
    <div class="grid2">${num('goal.targetCents', 'Default goal ($)', s.goal.targetCents / 100, 'min="1" step="1"')}${num('goal.lockDays', 'Lock period (days)', s.goal.lockDays, 'min="1" max="3650"')}</div>
    <label class="field"><span>Default milestones ($)</span><input type="text" name="goal.milestonesCents" value="${esc(s.goal.milestonesCents.map((c) => c / 100).join(', '))}"></label>
    ${tog('hardLock.defaultOn', 'Hard Lock on for new goals', s.hardLock.defaultOn, 'Recommended. No early release path at all.')}
    ${num('hardship.coolingOffDaysDefault', 'Hardship cooling-off default (days, only for non-Hard-Lock goals)', s.hardship.coolingOffDaysDefault, 'min="7" max="365"')}
    <h2 data-mt>Deposits &amp; overdraft protection</h2>
    <div class="grid2">${num('contribution.amountCents', 'Default deposit ($)', s.contribution.amountCents / 100, 'min="1" step="0.01"')}${num('safety.bufferCents', 'Safety buffer ($)', s.safety.bufferCents / 100, 'min="0" step="1"')}</div>
    <label class="field"><span>If the balance is too low</span><select name="safety.onInsufficientFunds"><option value="defer" ${s.safety.onInsufficientFunds === 'defer' ? 'selected' : ''}>Defer and retry next business day</option><option value="skip" ${s.safety.onInsufficientFunds === 'skip' ? 'selected' : ''}>Skip that deposit</option></select></label>
    <div class="grid2">${num('safety.deferMaxBusinessDays', 'Retry for (business days)', s.safety.deferMaxBusinessDays, 'min="0" max="10"')}${num('safety.pauseAfterReturns', 'Pause after N returns', s.safety.pauseAfterReturns, 'min="1" max="10"')}</div>
    <h2 data-mt>Unlock code &amp; rollover</h2>
    <div class="grid2">${num('unlock.codeExpiryDays', 'Code expires after (days)', s.unlock.codeExpiryDays, 'min="1" max="365"')}${num('unlock.maxAttempts', 'Wrong tries allowed', s.unlock.maxAttempts, 'min="1" max="20"')}</div>
    <div class="grid2">${num('rollover.defaultWithdrawCents', 'Rollover: default withdraw ($)', s.rollover.defaultWithdrawCents / 100, 'min="0" step="1"')}${num('rollover.defaultNewTargetCents', 'Rollover: default new goal ($)', s.rollover.defaultNewTargetCents / 100, 'min="1" step="1"')}</div>
    <h2 data-mt>Notifications</h2>
    ${tog('notifications.inApp', 'In-app banners', s.notifications.inApp)}${tog('notifications.console', 'Server log', s.notifications.console)}${tog('notifications.webhook', 'Webhook (NOTIFY_WEBHOOK_URL in .env)', s.notifications.webhook, 'Never includes unlock codes. Push/email/SMS can be added as notifier plugins.')}
    <h2 data-mt>Bot</h2>
    <div class="grid2">${num('bot.rateLimitPerMinute', 'Calls per minute per key', s.bot.rateLimitPerMinute, 'min="1" max="600"')}${num('bot.approvalExpiryDays', 'Requests expire after (days)', s.bot.approvalExpiryDays, 'min="1" max="30"')}</div>
    <button class="btn btn--gold btn--block" data-mt type="submit">Save settings</button>
  </form>
  <div class="section-title">Go-live gate (all unmet)</div>
  <div class="card" data-testid="golive">${S.goLiveGates.map((g) => `<div class="gate"><span class="gate__x">✕</span><span><strong>${esc(g.label)}</strong><br><span class="muted small">${esc(g.why)}</span></span></div>`).join('')}</div>
  <div class="card small muted">Extension points: notifiers (<code>server/notifiers</code>), bank providers (<code>server/providers</code>), pre-deposit rules (<code>server/rules</code>: ${esc(S.rules.join(', '))}). See <code>docs/EXTENDING.md</code>.</div>`;
}

// ---------------- Emergency stop + your bank account ----------------
function viewBank() {
  const logged = !!S;
  return `
  <h1>Emergency stop &amp; your bank</h1>
  ${logged ? `<section class="card danger-card" data-testid="emergency-stop-card">
    <h2>Emergency stop</h2>
    <p class="small"><strong>Pauses all future deposits and revokes every bot key.</strong> It does <strong>not</strong> unlock the vault, release money, or change your goal. Use it if something looks wrong with the schedule or the bot.</p>
    <label class="check"><input type="checkbox" id="stop-confirm"><span class="small">Pause deposits and revoke all bot keys now.</span></label>
    <button class="btn btn--danger btn--block" data-mt data-action="emergency-stop" data-testid="emergency-stop">Emergency stop (does not unlock)</button>
  </section>` : ''}
  <section class="card" data-testid="bank-disclosure">
    <h2>Your bank account: the facts</h2>
    <ul class="facts">
      <li>Lock &amp; Deploy is a savings <em>discipline</em> tool. It does not hold your money and does not control your bank account; your money stays at your bank.</li>
      <li>The app can't legally or technically stop your bank from giving you, the account owner, your own money (online banking, a branch, or the bank's phone line).</li>
      <li>The app and the bot never see your bank password and never touch your bank's login, password reset or account recovery. Password problems go through your bank's normal recovery process.</li>
      <li>That's why the in-app Hard Lock works best with a lock you also build at the bank (below).</li>
    </ul>
  </section>
  <section class="card card--gold" data-testid="stronger-lock">
    <h2>Make the lock stronger at the bank</h2>
    <ol class="stronger">
      <li><strong>Separate bank.</strong> Keep the savings account at a different bank from your everyday checking, so it isn't one tap away.</li>
      <li><strong>No debit card</strong> on the savings account (ask the bank not to issue one, or cut it up).</li>
      <li><strong>Don't install that bank's app</strong> on your phone. Fewer ways in = fewer impulse withdrawals.</li>
      <li><strong>Bank-enforced penalties or delays:</strong> a CD (early-withdrawal penalty) or a withdrawal-hold account such as Fort Knox-style savings (you schedule withdrawals in advance).</li>
      <li><strong>Sealed envelope:</strong> optionally give the savings bank's login to a trusted person in a sealed envelope, and don't keep a copy.</li>
      <li><strong>If you get SSI:</strong> an ABLE account can hold savings without counting toward the $2,000 SSI limit (up to $100,000). Check with SSA or a benefits counselor.</li>
    </ol>
  </section>
  ${logged ? '' : '<a class="btn btn--block" href="#/">Back</a>'}`;
}

// ---------------- More + Log ----------------
function viewMore() {
  return `<h1>More</h1><nav class="card more-list">
    <a href="#/accounts">Accounts <small>${S.accounts.length} linked</small></a>
    <a href="#/plan">Plan <small>goal, Hard Lock, schedule</small></a>
    <a href="#/authorize">Authorize <small>${esc(S.authorization?.status || 'none')}</small></a>
    <a href="#/rollover">Roll Over &amp; Relock</a>
    <a href="#/bot">AI bot <small>keys &amp; activity</small></a>
    <a href="#/settings">Settings</a>
    <a href="#/bank" data-testid="more-emergency">Emergency stop &amp; your bank</a>
    <a href="#/log">Log <small>audit trail</small></a>
  </nav>${S.simulation ? '<button class="btn btn--ghost btn--block" data-action="demo-wipe" data-testid="demo-wipe">Start over (erase this browser\'s demo data)</button>' : '<button class="btn btn--ghost btn--block" data-action="logout">Lock the app (log out)</button>'}`;
}
function viewLog() {
  const a = S.authorization;
  return `
  <h1>Log</h1>
  <div class="card">
    <h2>Authorization</h2>
    ${a ? `<p class="small">Status: ${chip(a.status)} · accepted ${esc(new Date(a.acceptedAt).toLocaleString())} by ${esc(a.signerName)}</p>
      <p class="small muted">Hash <code>${esc(a.textHash)}</code><br>IP ${esc(a.ip)} · ${esc((a.userAgent || '').slice(0, 60))}…</p>
      ${a.status === 'active' ? '<button class="btn btn--sm btn--danger" data-action="revoke" data-testid="revoke-btn">Revoke authorization</button>' : ''}` : '<p class="muted small">None yet.</p>'}
  </div>
  <div class="card">
    <h2>Real money</h2>
    <p class="small muted">Real transfers are hard-disabled in code and every go-live gate is unmet (see Settings). This button exists to show the guard: it asks for the benefit acknowledgement in the same step and the server still refuses.</p>
    <label class="check"><input type="checkbox" id="real-ack"><span class="small">I have re-read the SSI/benefit-limit warning.</span></label>
    <button class="btn btn--block" data-mt data-action="real" data-testid="real-btn">Activate real transfers</button>
  </div>
  <div class="section-title">Key events (lock, authorization, emergency, hardship, unlock)</div>
  <div class="card" data-testid="audit-key">${(S.auditKey || []).map((e) => `<div class="log-item"><div class="row-between"><code>${esc(e.type)}</code><span class="muted small">${esc(short(e.clockDate))}</span></div><div class="muted small">${esc(e.actor)} · ${esc(JSON.stringify(e.detail).slice(0, 160))}</div></div>`).join('') || '<p class="muted small">None yet.</p>'}</div>
  <div class="section-title">Audit trail <span class="${S.auditIntegrity.ok ? 'ok' : 'bad'}">${S.auditIntegrity.ok ? `· chain intact (${S.auditCount})` : '· CHAIN BROKEN'}</span></div>
  <div class="card">${S.audit.map((e) => `<div class="log-item"><div class="row-between"><code>${esc(e.type)}</code><span class="muted small">${esc(short(e.clockDate))} · ${esc(new Date(e.at).toLocaleTimeString())}</span></div><div class="muted small">${esc(e.actor)} · ${esc(JSON.stringify(e.detail))}</div></div>`).join('') || '<p class="muted small">Empty.</p>'}</div>
  <button class="btn btn--ghost btn--block" data-action="reset">Reset sandbox data</button>`;
}

function viewAuthorize() {
  const w = S.benefitWarning;
  if (S.readiness.length) return `<h1>Authorize</h1><div class="card"><p>Finish setup first: <strong>${esc(S.readiness.join(', '))}</strong>.</p><a class="btn btn--block" href="${S.readiness.includes('accounts') ? '#/accounts' : '#/plan'}">Go</a></div>`;
  const active = S.authorization?.status === 'active';
  return `
  <h1>Authorize</h1>
  <section class="card card--warn" data-testid="benefit-warning">
    <h2 class="warn">Before you turn on transfers: benefit limits</h2>
    ${w.paragraphs.map((p) => `<p class="small">${esc(p)}</p>`).join('')}
    ${S.benefitAck ? `<p class="small ok">Acknowledged ${esc(new Date(S.benefitAck.acceptedAt).toLocaleString())}</p>` : `
    <label class="check"><input type="checkbox" id="ack-box" data-testid="ack-box"><span class="small">I've read this. I understand saving above $2,000 could affect SSI/Medicaid and I'll check with SSA or a benefits counselor.</span></label>
    <button class="btn btn--block" data-mt data-action="ack" data-testid="ack-btn" disabled>Acknowledge</button>`}
  </section>
  <section class="card">
    <h2>ACH debit authorization</h2>
    ${active ? `<p class="ok">Active since ${esc(new Date(S.authorization.acceptedAt).toLocaleString())}.</p><p class="small muted">Text hash <code>${esc(S.authorization.textHash.slice(0, 16))}…</code>. Change the plan or accounts to require a new authorization.</p>` : `
    <label class="field"><span>Your full legal name</span><input type="text" id="signer" value="" placeholder="First Last" autocomplete="name" data-testid="signer"></label>
    <div class="auth-text" id="auth-text" data-testid="auth-text">Type your name to load the authorization text…</div>
    <label class="check" data-mt><input type="checkbox" id="auth-box" data-testid="auth-box"><span class="small">I authorize these recurring ACH debits (sandbox: no real money). I understand the goal locks when I authorize.</span></label>
    <button class="btn btn--gold btn--block" data-mt data-action="authorize" data-testid="authorize-btn" disabled>Authorize, lock goal & start deposits</button>
    <p class="small muted" data-mt>We record the exact text, its hash, the time, your IP and browser. ${S.benefitAck ? '' : 'Acknowledge the benefit warning first.'}</p>`}
  </section>`;
}

function timeline(t) {
  const order = ['pending', 'posted', 'settled'];
  const bad = ['returned', 'failed'].includes(t.status);
  const reached = t.status === 'returned' ? 3 : t.status === 'failed' ? 1 : t.status === 'cancelled' ? 0 : order.indexOf(t.status) + 1;
  return `<div class="timeline">${[0, 1, 2].map((i) => `<span class="${i < reached ? (bad && i === reached - 1 ? 'bad' : 'on') : ''}"></span>`).join('')}</div>
  <div class="timeline-labels"><span>Pending</span><span>Posted</span><span>${t.status === 'returned' ? 'Returned' : 'Settled'}</span></div>`;
}

// ---------------- Link flows ----------------
function openMockLink() {
  const banks = S.provider.banks || [];
  const root = $('#modal-root');
  const close = () => { root.innerHTML = ''; };
  const step = (html) => { root.innerHTML = `<div class="overlay" role="dialog" aria-modal="true" aria-label="Link a bank"><div class="sheet" data-testid="link-modal"><div class="sheet__head"><span class="sheet__brand">Mock Link · sandbox</span><button class="x" data-close aria-label="Close">×</button></div>${html}</div></div>`; $('[data-close]', root).onclick = close; };
  step(`<h2>Lock &amp; Deploy uses a secure link to connect your bank</h2>
    <ul class="plain"><li>You sign in with your bank, not with this app.</li><li>This app receives only a token, account names and the last 4 digits.</li><li>Your username and password are never shared or stored.</li></ul>
    <p class="small muted">This is an offline mock of a Plaid-Link-style flow. No real bank is contacted.</p>
    <button class="btn btn--gold btn--block" data-next data-testid="link-continue">Continue</button>`);
  $('[data-next]', root).onclick = () => {
    step(`<h2>Select your bank</h2>${banks.map((b) => `<button class="bank-btn" data-bank="${esc(b.id)}" data-testid="bank-${esc(b.id)}"><span class="acct__icon">${esc(b.name[0])}</span><span><strong>${esc(b.name)}</strong><br><span class="small muted">Fictional sandbox bank</span></span></button>`).join('')}`);
    root.querySelectorAll('[data-bank]').forEach((btn) => { btn.onclick = () => {
      const b = banks.find((x) => x.id === btn.dataset.bank);
      step(`<h2>Sign in to ${esc(b.name)}</h2>
        <p class="small muted">Sandbox bank: there are no credentials to type. In a real flow this screen belongs to the provider/bank, and nothing typed here would reach Lock &amp; Deploy.</p>
        <button class="btn btn--gold btn--block" data-signin data-testid="link-signin">Continue as sandbox user</button>`);
      $('[data-signin]', root).onclick = () => {
        step(`<h2>Accounts found</h2>${b.accounts.map((a) => `<div class="acct"><div class="acct__icon">${esc(a.subtype === 'savings' ? 'S' : 'C')}</div><div class="acct__main"><div class="acct__name">${esc(a.name)}</div><div class="small muted">${esc(a.subtype)} ••${esc(a.mask)}</div></div></div>`).join('')}
          <button class="btn btn--gold btn--block" data-share data-testid="link-share">Share these accounts</button>`);
        $('[data-share]', root).onclick = async () => {
          const publicToken = `mock-public-${b.id}-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
          close();
          await act(() => api('/api/link/exchange', { publicToken }), `${b.name} linked`);
        };
      };
    }; });
  };
}

async function openPlaidLink() {
  if (!window.Plaid) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = S.provider.linkScript; s.onload = res; s.onerror = () => rej(new Error('Could not load Plaid Link')); document.head.appendChild(s); });
  const { linkToken } = await api('/api/link/token', { role: 'any' });
  const handler = window.Plaid.create({
    token: linkToken,
    onSuccess: (public_token, metadata) => act(() => api('/api/link/exchange', { publicToken: public_token, metadata: { institution: metadata.institution } }), 'Bank linked'),
    onExit: (err) => { if (err) toast(err.display_message || err.error_message || 'Link closed', true); },
  });
  handler.open();
}


// ---------------- Wiring ----------------
const views = { home: viewHome, accounts: viewAccounts, plan: viewPlan, authorize: viewAuthorize, transfers: viewTransfers, log: viewLog,
  vault: viewVault, rollover: viewRollover, inbox: viewInbox, bot: viewBot, settings: viewSettings, bank: viewBank, emergency: viewBank, more: viewMore };
const TAB_OF = { accounts: 'more', plan: 'more', authorize: 'more', rollover: 'vault', bot: 'more', settings: 'more', bank: 'more', emergency: 'more', log: 'more' };
function route() { return (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0]; }

function render() {
  let r = views[route()] ? route() : 'home';
  const tabbar = $('#tabbar');
  if (!S) {
    tabbar.hidden = true;
    app.innerHTML = r === 'bank' || r === 'emergency' ? viewBank() : viewAuth();
    const f = $('#auth-form');
    if (f) f.onsubmit = (e) => { e.preventDefault(); const passcode = new FormData(f).get('passcode'); act(() => api(AUTH.setup ? '/api/auth/login' : '/api/auth/setup', { passcode })); };
    return;
  }
  tabbar.hidden = false;
  app.innerHTML = views[r]();
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (TAB_OF[r] || r)));
  const badge = $('#inbox-badge'); badge.hidden = !S.pendingApprovals; badge.textContent = S.pendingApprovals || '';
  $('#mode-badge').textContent = S.simulation ? 'Simulation · fictional money' : S.provider.id === 'mock' ? 'Sandbox · mock' : 'Plaid sandbox';
  if (S.simulation) $('#sandbox-banner').textContent = 'Simulation · fictional money. Everything runs and stays in this browser.';
  ({ plan: wirePlan, accounts: wireAccounts, authorize: wireAuthorize, rollover: wireRollover, vault: wireVault, inbox: wireInbox, bot: wireBot, settings: wireSettings })[r]?.();
}

function wireAccounts() {
  const f = $('#roles-form');
  if (f) {
    f.addEventListener('change', () => f.querySelectorAll('.role-pick label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked)));
    f.onsubmit = (e) => { e.preventDefault(); const d = new FormData(f); act(() => api('/api/accounts/roles', { fundingAccountId: d.get('funding'), destinationAccountId: d.get('dest') }), 'Accounts saved'); };
  }
}
function scheduleFromForm(f) {
  const d = new FormData(f);
  return { amountCents: Math.round(Number(d.get('amount')) * 100), frequency: d.get('frequency'), benefitType: d.get('benefitType'), benefitDay: Number(d.get('benefitDay')), offsetDays: Number(d.get('offsetDays')), dayOfMonth: Number(d.get('dayOfMonth')), anchorDate: d.get('anchorDate') };
}
const dollarsList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => Math.round(Number(x) * 100)).filter((x) => x > 0);
function wirePlan() {
  const gf = $('#goal-form'), sf = $('#schedule-form');
  if (gf) {
    gf.hardLock.onchange = () => { $('[data-hardship]', gf).hidden = gf.hardLock.checked; };
    gf.onsubmit = (e) => {
      e.preventDefault(); const d = new FormData(gf);
      const body = { name: d.get('name'), targetCents: Math.round(Number(d.get('target')) * 100), releaseDate: d.get('releaseDate'), unlockRule: d.get('unlockRule'), milestonesCents: dollarsList(d.get('milestones')) };
      if (!gf.hardLock.disabled) body.hardLock = gf.hardLock.checked;
      if (!gf.hardLock.checked && !gf.hardshipEnabled.disabled) body.hardship = { enabled: gf.hardshipEnabled.checked, coolingOffDays: Number(gf.coolingOffDays.value) };
      else if (!gf.coolingOffDays.disabled && S.goal.hardship.enabled) body.hardship = { enabled: true, coolingOffDays: Number(gf.coolingOffDays.value) };
      act(() => api('/api/goal', body), 'Goal saved');
    };
  }
  const toggle = () => {
    const fq = sf.frequency.value, bt = sf.benefitType.value;
    sf.querySelectorAll('[data-when]').forEach((el) => { el.hidden = !el.dataset.when.split(' ').includes(fq); });
    sf.querySelectorAll('[data-when-benefit]').forEach((el) => { el.hidden = el.dataset.whenBenefit !== bt; });
  };
  let tmr;
  const preview = () => { clearTimeout(tmr); tmr = setTimeout(async () => {
    const p = await api('/api/schedule/preview', scheduleFromForm(sf)).catch((e) => ({ errors: [e.message] }));
    const box = $('#preview'); if (!box) return;
    box.innerHTML = p.errors?.length ? `<span class="bad small">${esc(p.errors.join(' '))}</span>` :
      `<div class="small">${esc(p.description)}</div><div class="preview-dates">${p.dates.map((d) => `<span class="chip chip--date">${short(d)}</span>`).join('')}</div>
       ${S.goal && p.projectedFinish ? `<div class="small muted" data-mt>${p.pullsNeeded} deposits to reach ${money0(S.goal.targetCents)} · about ${pretty(p.projectedFinish)}</div>` : ''}`;
  }, 150); };
  sf.addEventListener('input', () => { toggle(); preview(); });
  sf.addEventListener('change', () => { toggle(); preview(); });
  toggle(); preview();
  sf.onsubmit = async (e) => { e.preventDefault(); const ok = await act(() => api('/api/schedule', scheduleFromForm(sf)), 'Schedule saved. Review the authorization.'); if (ok !== null) location.hash = '#/authorize'; };
}

function wireAuthorize() {
  const ack = $('#ack-box');
  if (ack) ack.onchange = () => { $('[data-action=ack]').disabled = !ack.checked; };
  const signer = $('#signer');
  if (!signer) return;
  let current = null, tmr;
  const box = $('#auth-box'), btn = $('[data-action=authorize]');
  const update = () => { btn.disabled = !(box.checked && current && S.benefitAck); };
  signer.oninput = () => { clearTimeout(tmr); tmr = setTimeout(async () => {
    const name = signer.value.trim();
    if (name.length < 2) { current = null; $('#auth-text').textContent = 'Type your name to load the authorization text…'; return update(); }
    try { current = await api('/api/authorization/text', { signerName: name }); $('#auth-text').textContent = current.text; } catch (e) { toast(e.message, true); }
    update();
  }, 200); };
  box.onchange = update;
  btn.onclick = () => act(() => api('/api/authorization', { accepted: box.checked, textHash: current.textHash, signerName: signer.value.trim() }), 'Authorized. Automatic deposits are on and the goal is locked.').then((r) => { if (r) location.hash = '#/transfers'; });
}

function wireRollover() {
  const f = $('#rollover-form'); if (!f) return;
  const g = S.goal, unlocked = g?.status === 'unlocked';
  const vault = unlocked ? S.totals.vaultCents : (g?.targetCents || 300000);
  const update = () => {
    const mode = f.mode.value, fullAction = f.fullAction.value;
    f.querySelectorAll('.seg label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
    const key = mode === 'full' ? `full-${fullAction}` : mode;
    f.querySelectorAll('[data-mode]').forEach((el) => { el.hidden = !el.dataset.mode.split(' ').some((m) => m === key || m === mode); });
    const withdraw = Math.round(Number(f.withdraw.value || 0) * 100);
    const target = mode === 'full' && fullAction === 'close' ? null : Math.round(Number(f.target.value || 0) * 100);
    const c = rolloverCalc({ mode, vault, withdraw, target });
    const amt = S.schedule?.amountCents;
    const pulls = c.additional > 0 && amt ? Math.ceil(c.additional / amt) : 0;
    $('#rollover-flow').innerHTML = `<div class="flow__step"><strong>${money0(vault)}</strong><span>${unlocked ? 'in vault' : 'at goal'}</span></div><span class="flow__arrow">→</span>
      <div class="flow__step"><strong>−${money0(c.w)}</strong><span>taken out</span></div><span class="flow__arrow">→</span>
      <div class="flow__step"><strong>${money0(c.remaining)}</strong><span>stays locked</span></div><span class="flow__arrow">→</span>
      <div class="flow__step flow__step--gold"><strong>${target ? money0(target) : '—'}</strong><span>${target ? 'new goal' : 'closed'}</span></div>`;
    $('#rollover-calc').innerHTML = `<dt>${unlocked ? 'Settled in vault' : 'When you reach your goal'}</dt><dd>${money(vault)}</dd><dt>Withdraw (simulated)</dt><dd>−${money(c.w)}</dd><dt>Remaining, relocked</dt><dd>${money(c.remaining)}</dd>
      ${target ? `<dt>New goal</dt><dd>${money(target)}</dd><dt class="total">Additional needed</dt><dd class="total" data-testid="rollover-additional">${money(Math.max(0, c.additional))}</dd>` : '<dt class="total">Goal</dt><dd class="total">closed, deposits stop</dd>'}`;
    const bad = mode === 'partial' && (withdraw <= 0 || withdraw >= vault) ? 'Withdraw more than $0 and less than the whole vault.' : target && c.additional <= 0 ? 'The new goal must be higher than what stays locked.' : '';
    $('#rollover-note').innerHTML = bad ? `<span class="bad">${esc(bad)}</span>` : target ? `At ${money(amt || 0)} per deposit that's about ${pulls} more deposit${pulls === 1 ? '' : 's'}. The vault relocks immediately${g?.hardLock ? ' with Hard Lock' : ''} and deposits continue.` : 'Everything is withdrawn and no more deposits are made.';
    const needs = f.querySelector('[data-needs-code]'); if (needs) needs.hidden = c.w === 0;
  };
  f.addEventListener('input', update); f.addEventListener('change', update); update();
  f.onsubmit = (e) => {
    e.preventDefault(); const d = new FormData(f); const mode = d.get('mode');
    const body = { mode, withdrawCents: Math.round(Number(d.get('withdraw') || 0) * 100), newTargetCents: Math.round(Number(d.get('target') || 0) * 100), fullAction: d.get('fullAction'), milestonesCents: dollarsList(d.get('milestones')), unlockCode: d.get('code') || undefined, confirm: d.get('confirm') === 'on' };
    act(() => api('/api/rollover/execute', body), 'Rolled over and relocked').then((r) => { if (r) { shownCode = null; location.hash = '#/'; } });
  };
}

function wireVault() {
  const w = $('#withdraw-form');
  if (w) w.onsubmit = (e) => { e.preventDefault(); const d = new FormData(w); act(() => api('/api/vault/withdraw', { amountCents: Math.round(Number(d.get('amount')) * 100), unlockCode: d.get('code'), confirm: d.get('confirm') === 'on' }), 'Withdrawal recorded (simulated)'); };
  const hf = $('#hardship-form');
  if (hf) hf.onsubmit = (e) => { e.preventDefault(); const d = new FormData(hf); act(() => api('/api/hardship/request', { amountCents: Math.round(Number(d.get('amount')) * 100), typed: d.get('typed'), confirm: d.get('confirm') === 'on' }), 'Cooling-off started'); };
  const hc = $('#hardship-complete');
  if (hc) hc.onsubmit = (e) => { e.preventDefault(); const d = new FormData(hc); act(() => api('/api/hardship/complete', { typed: d.get('typed'), confirm: d.get('confirm') === 'on' }), 'Hardship release recorded'); };
}
function wireInbox() {
  document.querySelectorAll('form[data-approval]').forEach((f) => { f.onsubmit = (e) => {
    e.preventDefault(); const d = new FormData(f);
    act(() => api('/api/approvals/approve', { id: f.dataset.approval, confirm: d.get('confirm') === 'on', unlockCode: d.get('code') || undefined }), 'Approved').then((r) => { if (r?.result?.next) location.hash = r.result.next; });
  }; });
}
function wireBot() {
  const f = $('#botkey-form');
  f.onsubmit = async (e) => {
    e.preventDefault(); const d = new FormData(f);
    const r = await act(() => api('/api/bot-keys', { name: d.get('name'), scopes: d.getAll('scope') }), 'Key created. Copy it now.');
    if (r) { shownKey = r; render(); }
  };
}
function wireSettings() {
  const f = $('#settings-form');
  f.onsubmit = (e) => {
    e.preventDefault();
    const patch = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') patch[el.name] = el.checked;
      else if (el.name === 'goal.milestonesCents') patch[el.name] = dollarsList(el.value);
      else if (el.type === 'number') patch[el.name] = /Cents$/.test(el.name) ? Math.round(Number(el.value) * 100) : Math.round(Number(el.value));
      else patch[el.name] = el.value;
    }
    act(() => api('/api/settings', patch), 'Settings saved');
  };
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'link') { if (S.provider.id === 'mock') openMockLink(); else openPlaidLink().catch((err) => toast(err.message, true)); }
  if (a === 'plaid-skip') act(async () => { const { publicToken } = await api('/api/link/sandbox-public-token', {}); return api('/api/link/exchange', { publicToken }); }, 'Sandbox bank linked');
  if (a === 'unlink') act(() => api('/api/items/unlink', { itemId: el.dataset.id }), 'Unlinked');
  if (a === 'ack') act(() => api('/api/benefit-ack', { accepted: true, version: S.benefitWarning.version }), 'Acknowledged');
  if (a === 'pause') act(() => api('/api/schedule/pause', {}), 'Paused. Saved money untouched; still locked.');
  if (a === 'resume') act(() => api('/api/schedule/resume', {}), 'Resumed');
  if (a === 'cancel-schedule') { if (confirm('Cancel all future deposits and end the authorization? Saved money stays locked.')) act(() => api('/api/schedule/cancel', { confirm: true }), 'Schedule cancelled'); }
  if (a === 'cancel') { if (confirm('Cancel this pending transfer? Only this one transfer is cancelled; the schedule is not changed.')) act(() => api('/api/transfers/cancel', { pullId: el.dataset.id }), 'Transfer cancelled'); }
  if (a === 'sim') act(() => api('/api/sandbox/simulate', { pullId: el.dataset.id, event: el.dataset.event }), `Simulated: ${el.dataset.event}`);
  if (a === 'clock') act(() => api('/api/sandbox/clock/advance', { days: Number(el.dataset.days) }), `Advanced ${el.dataset.days} day(s)`);
  if (a === 'mock-balance') act(() => api('/api/sandbox/mock-balance', { cents: Math.round(Number($('#mock-balance').value) * 100) }), 'Mock balance set');
  if (a === 'run') act(() => api('/api/scheduler/run', {}), 'Engine ran');
  if (a === 'revoke') { if (confirm('Revoke the ACH authorization? Future deposits stop until you authorize again. Saved money stays locked.')) act(() => api('/api/authorization/revoke', {}), 'Authorization revoked'); }
  if (a === 'real') act(() => api('/api/real-transfers/activate', { benefitAck: $('#real-ack').checked }));
  if (a === 'reset') { if (confirm('Erase all sandbox data?')) act(() => api('/api/sandbox/reset', {}), 'Reset'); }
  if (a === 'dismiss') act(() => api('/api/notifications/dismiss', { id: el.dataset.id }));
  if (a === 'reveal-code') { const r = await act(() => api('/api/vault/reveal-code', {})); if (r) { shownCode = r; render(); } }
  if (a === 'regen-code') { if (confirm('Generate a new unlock code? The old one stops working.')) { const r = await act(() => api('/api/vault/regenerate-code', { confirm: true })); if (r) { shownCode = r; render(); } } }
  if (a === 'hardship-cancel') act(() => api('/api/hardship/cancel', {}), 'Hardship request cancelled. Everything stays locked.');
  if (a === 'reject') act(() => api('/api/approvals/reject', { id: el.dataset.id }), 'Rejected');
  if (a === 'revoke-key') act(() => api('/api/bot-keys/revoke', { id: el.dataset.id }), 'Key revoked');
  if (a === 'emergency-stop') { if (!$('#stop-confirm').checked) return toast('Tick the box to confirm.', true); act(() => api('/api/emergency/stop', { confirm: true }), 'Emergency stop: deposits paused, bot keys revoked. Vault unchanged.'); }
  if (a === 'logout') act(() => api('/api/auth/logout', {}), 'App locked');
  if (a === 'simbot') { const r = await act(() => api('/api/demo/bot', { action: el.dataset.bot })); if (r) { simBotLast = r; render(); } }
  if (a === 'demo-wipe') { if (confirm('Erase all demo data in this browser and start over?')) { await act(() => api('/api/demo/wipe', {}), 'Demo reset'); location.hash = '#/'; } }
});
// Fresh state on every screen change, so requests the bot made in the meantime show up.
window.addEventListener('hashchange', () => { if (route() !== 'vault') shownCode = null; if (route() !== 'bot') shownKey = null; refresh().catch(() => render()); });
// Light poll for new bot requests: only updates the Inbox badge, never re-renders under your fingers.
setInterval(async () => {
  if (document.hidden || !S) return;
  try { const n = await api('/api/state'); const b = $('#inbox-badge'); b.hidden = !n.pendingApprovals; b.textContent = n.pendingApprovals || ''; } catch { /* locked or offline */ }
}, 20000);
refresh().catch((e) => { app.innerHTML = `<div class="card bad">${esc(e.message)}</div>`; });
