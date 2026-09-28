// Lock & Deploy savings-vault prototype front end. No secrets live here: the browser only ever sees
// link tokens / public tokens (short-lived), account names + last-4 masks, and (once) the unlock code.
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
let S = null; // latest /api/state
let AUTH = null; // { setup, loggedIn }
let shownCode = null; // unlock code shown once (kept only in memory for this screen)
let shownKey = null;  // new bot key shown once

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => c === null ? 'Hidden' : `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (c) => c === null ? 'Hidden' : `$${Math.round(Number(c || 0) / 100).toLocaleString('en-US')}`;
const pretty = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const short = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
const acctLabel = (a) => (a ? `${a.name} ••${a.mask}` : '—');
const pct = (n) => Math.max(0, Math.min(100, Math.round(n * 100)));
// Go Blind: the server already nulls every amount while it is on; the UI shows neutral text instead.
const BLIND = () => !!S?.blind?.redacted;
const HIDDEN_TXT = 'Hidden · Go Blind on';
const hiddenCard = (title, body = '') => `<div class="card card--blind" data-testid="blind-hidden"><div class="row-between"><h2>${esc(title)}</h2><span class="pill pill--blind">${HIDDEN_TXT}</span></div>${body ? `<p class="small muted" data-mt>${body}</p>` : ''}</div>`;

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
  if (BLIND()) return hiddenCard('Settled vs pending', 'Settled, pending and to-go amounts are hidden. Deposits keep running on schedule; only <strong>settled</strong> deposits count toward the lock.');
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
  if (S.benefitsAlert) out.push(`<div class="banner banner--warn" role="alert" data-testid="benefits-alert"><span class="banner__icon">!</span><span class="banner__body"><strong>Benefits guard${S.benefitsAlert.level === 'over' ? ': over the limit' : ''}</strong><br><span class="small">${esc(S.benefitsAlert.message)}</span></span></div>`);
  if (S.pendingApprovals) out.push(`<a class="banner" href="#/inbox" data-testid="approval-banner"><span class="banner__icon">${S.pendingApprovals}</span><span class="banner__body"><strong>Your bot is waiting for approval</strong><br><span class="small muted">Nothing happens until you approve it in the Inbox.</span></span></a>`);
  for (const n of S.notifications) out.push(`<div class="banner" data-testid="notification"><span class="banner__icon">${n.type === 'goal_reached' ? '✓' : n.type.startsWith('milestone') ? '★' : '!'}</span><span class="banner__body"><strong>${esc(n.title)}</strong><br><span class="small muted">${esc(n.body || '')}</span></span><button class="x" data-action="dismiss" data-id="${esc(n.id)}" aria-label="Dismiss">×</button></div>`);
  return out.join('');
}
function homeCards() {
  const cd = S.cards, sl = S.sealedLogins || [];
  const latest = cd?.unlocked?.[0], speed = cd?.speedUp?.cards?.[0];
  return `${celebrate()}${!sl.length ? '<a class="banner" href="#/setup" data-testid="setup-banner"><span class="banner__icon">1</span><span class="banner__body"><strong>Guided setup</strong><br><span class="small muted">Seal my login → unlock date → lost card → dashboard</span></span></a>' : ''}
  ${sl.length ? `<a class="card card--sealed row-between" href="#/seal" data-testid="home-sealed"><span>🔒 <strong>${esc(sl[0].label)}</strong> <span class="small muted">${sl[0].status === 'unlocked' ? 'ready to open' : 'sealed'}</span></span>${sl[0].status === 'sealed' && sl[0].unlockAtMs ? countdown(sl[0].unlockAtMs) : ''}</a>` : ''}
  ${latest || speed ? `<div class="section-title">Did you know?</div>${latest ? tipCard(latest) : ''}${speed ? tipCard(speed) : ''}<a class="btn btn--ghost btn--block" href="#/cards" data-testid="home-cards-link">All cards (${cd.unlocked.length})</a>` : ''}`;
}
function viewHome() {
  const g = S.goal, t = S.totals, s = S.schedule, blind = BLIND();
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
  <section class="card hero ${blind ? 'hero--blind' : ''}">
    <div class="hero__visual">${ring(blind ? 0 : g ? t.vaultCents / g.targetCents : 0)}<div class="hero__lock">${LOCK_SVG(unlocked)}</div></div>
    <div class="eyebrow">${esc(g ? g.name : 'No goal yet')}${g && g.cycle > 1 ? ` · cycle ${g.cycle}` : ''}</div>
    <div class="hero__amount ${blind ? 'hero__amount--blind' : ''}" data-testid="locked-amount">${blind ? HIDDEN_TXT : money(t.vaultCents)}</div>
    <div class="muted small">${blind ? 'Amounts stay hidden until the goal is reached' : `settled of ${g ? money0(g.targetCents) : '—'}`}</div>
    ${g ? `<span class="pill ${unlocked ? 'pill--unlocked' : 'pill--locked'}" data-testid="lock-pill">${unlocked ? 'Unlocked · goal reached' : g.status === 'closed' ? 'Closed' : blind ? `${g.hardLock ? 'Hard Lock' : 'Locked'} · opens when the goal is reached` : g.hardLock ? `Hard Lock · opens at ${money0(g.targetCents)} settled` : `Locked · opens at ${money0(g.targetCents)} settled`}</span>` : ''}
  </section>
  <div class="stats">
    ${blind ? `<div class="stat"><div class="stat__label">Deposits</div><div class="stat__value" data-testid="blind-deposit-status">${s ? chip(s.status) : '—'}</div></div>
    <div class="stat"><div class="stat__label">Amounts</div><div class="stat__value small">Hidden</div></div>` : `<div class="stat"><div class="stat__label">Settled</div><div class="stat__value" data-testid="settled-amount">${money(t.vaultCents)}</div></div>
    <div class="stat"><div class="stat__label">Pending</div><div class="stat__value" data-testid="pending-amount">${money(t.pendingCents)}</div></div>`}
    <div class="stat"><div class="stat__label">Next deposit</div><div class="stat__value" data-testid="next-deposit">${s?.status === 'active' && S.nextPulls[0] ? short(S.nextPulls[0]) : s ? chip(s.status) : '—'}</div></div>
  </div>
  ${blind && s && ['active', 'paused'].includes(s.status) ? `<div class="card"><div class="row-between"><span class="small">Automatic deposits ${chip(s.status)}</span>${s.status === 'active' ? '<button class="btn btn--sm" data-action="pause" data-testid="home-pause">Pause</button>' : '<button class="btn btn--sm btn--gold" data-action="resume" data-testid="home-resume">Resume</button>'}</div></div>` : ''}
  ${blindCard()}
  ${g ? pendingVsSettled() : ''}
  ${blind ? '' : g?.milestones?.length ? `<div class="card"><h2>Milestones</h2>${g.milestones.map((m) => `<div class="row-between small"><span>${m.reachedOn ? '★' : '☆'} ${esc(m.label)}</span><span class="muted">${m.reachedOn ? `reached ${short(m.reachedOn)}` : `${money0(Math.max(0, m.targetCents - t.vaultCents))} to go`}</span></div>`).join('')}<div class="row-between small"><span>🔒 Goal ${money0(g.targetCents)} (unlock)</span><span class="muted">${unlocked ? `reached ${short(g.reachedOn)}` : `${money0(g.remainingCents)} to go`}</span></div></div>` : ''}
  ${S.overBenefitLimit && !blind ? `<div class="card card--warn"><strong class="warn">Benefit limit heads-up.</strong> <span class="small">This goal is above the SSI $2,000 resource limit for an individual. See the Authorize step and consider an ABLE account.</span></div>` : ''}
  ${homeCards()}
  ${setupDone ? '' : `<div class="section-title">Setup</div>
  <div class="card"><ol class="steps">${steps.map(([label, done, href], i) => `<li><span class="dot ${done ? 'dot--done' : ''}">${done ? '✓' : i + 1}</span><a href="${href}">${esc(label)}</a></li>`).join('')}</ol></div>`}
  <div class="card small muted">Provider: <strong class="gold">${esc(S.provider.label)}</strong>. The app stores only provider tokens (encrypted) and IDs, plus account names and last-4 digits. Bank linking never uses your bank username or password, and the app never touches bank login or account recovery. (Seal my login is separate: a login you choose to seal is stored encrypted and only shown after its unlock condition.) Real money is <strong>hard-disabled</strong>.</div>`;
}

// ---------------- Go Blind ----------------
function blindCard() {
  const b = S.blind; if (!b) return '';
  const g = S.goal, saving = g?.status === 'saving';
  if (!b.on) return `<section class="card card--blind" data-testid="blind-card">
    <div class="row-between"><h2>Go Blind</h2><span class="chip">off</span></div>
    <p class="small muted">Hide every dollar amount (balances, deposits, progress, history) so you are not tempted to check. Deposits, Pause/Resume, the Inbox and Emergency stop keep working. Turning it off needs your ${b.passcodeKind === 'blind_passcode' ? 'Go Blind passcode' : 'app passcode'}.</p>
    <button class="btn btn--gold btn--block" data-action="blind-on-open" data-testid="blind-on-open">Go Blind</button></section>`;
  const locked = b.lockedUntil ? `<p class="small bad" data-mt data-testid="blind-lockout">Too many wrong passcodes. Try again after ${esc(new Date(b.lockedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}.</p>` : '';
  return `<section class="card card--blind" data-testid="blind-card">
    <div class="row-between"><h2>Go Blind</h2><span class="pill pill--blind" data-testid="blind-status">On</span></div>
    <p class="small">${b.redacted ? 'All amounts are hidden, from you and from the bot.' : 'Goal reached: amounts are shown again for the unlock, withdrawal and rollover.'} ${b.enabledAt ? `On since ${esc(new Date(b.enabledAt).toLocaleDateString())}${b.enabledBy === 'bot' ? ' (turned on by your bot)' : ''}.` : ''}</p>
    ${b.stayUntilGoal ? '<p class="small warn" data-mt data-testid="blind-stay-note">You chose <strong>stay blind until goal</strong>. Go Blind turns off only when the vault unlocks. There is no passcode override.</p>'
      : `<button class="btn btn--block" data-mt data-action="blind-off-open" data-testid="blind-off-open" ${b.lockedUntil ? 'disabled' : ''}>Turn off Go Blind (passcode)</button>${locked}
      ${saving ? '<button class="btn btn--sm btn--ghost btn--block" data-mt data-action="blind-add-stay" data-testid="blind-add-stay">Also stay blind until goal (cannot be undone)</button>' : ''}`}
  </section>`;
}
function openBlindOn() {
  const b = S.blind, root = $('#modal-root'), saving = S.goal?.status === 'saving', setup = b.needsPasscodeSetup;
  root.innerHTML = `<div class="overlay" role="dialog" aria-modal="true" aria-label="Go Blind"><form class="sheet" id="blind-on-form" data-testid="blind-on-modal">
    <div class="sheet__head"><span class="sheet__brand">Go Blind</span><button class="x" type="button" data-close aria-label="Close">×</button></div>
    <h2>Hide all amounts?</h2>
    <p class="small muted">Balances, deposit amounts, progress and history amounts are replaced with "Hidden". You still see the lock, goal name, deposit status and dates, Pause/Resume, the Inbox and Emergency stop, and you'll see when the goal is reached.</p>
    ${setup ? `<label class="field"><span>Choose a Go Blind passcode (4 to 12 digits)</span><input type="password" name="passcode" inputmode="numeric" pattern="[0-9]{4,12}" minlength="4" maxlength="12" autocomplete="new-password" required data-testid="blind-new-passcode"></label>
    <label class="field"><span>Repeat it</span><input type="password" name="passcode2" inputmode="numeric" pattern="[0-9]{4,12}" maxlength="12" autocomplete="new-password" required data-testid="blind-new-passcode2"></label>
    <p class="small muted" data-testid="blind-demo-note">Demo: stored only in this browser as a salted hash (PBKDF2). Clearing this site's data resets the demo, including this passcode and Go Blind.</p>`
    : `<p class="small muted">To turn it off later you'll need your ${b.passcodeKind === 'blind_passcode' ? 'Go Blind passcode' : 'app passcode'}.</p>`}
    <label class="toggle-row"><span><strong>Stay blind until goal</strong><br><span class="small muted">${saving ? 'Go Blind cannot be turned off at all until the vault unlocks, not even with the passcode.' : 'Only available while a goal is saving.'}</span></span><input type="checkbox" name="stay" ${saving ? '' : 'disabled'} data-testid="blind-stay"></label>
    <button class="btn btn--gold btn--block" data-mt type="submit" data-testid="blind-on-confirm">Yes, hide all amounts</button>
  </form></div>`;
  const f = $('#blind-on-form', root); $('[data-close]', root).onclick = () => { root.innerHTML = ''; };
  f.onsubmit = async (e) => {
    e.preventDefault(); const d = new FormData(f);
    if (setup && d.get('passcode') !== d.get('passcode2')) return toast('The two passcodes do not match.', true);
    const r = await act(() => api('/api/blind/on', { confirm: true, stayUntilGoal: d.get('stay') === 'on', passcode: setup ? d.get('passcode') : undefined }), 'Go Blind is on. Amounts are hidden.');
    if (r) root.innerHTML = '';
  };
}
function openBlindOff() {
  const b = S.blind, root = $('#modal-root'), demo = b.passcodeKind === 'blind_passcode';
  root.innerHTML = `<div class="overlay" role="dialog" aria-modal="true" aria-label="Turn off Go Blind"><form class="sheet" id="blind-off-form" data-testid="blind-off-modal">
    <div class="sheet__head"><span class="sheet__brand">Turn off Go Blind</span><button class="x" type="button" data-close aria-label="Close">×</button></div>
    <p class="small muted">Enter your ${demo ? 'Go Blind passcode' : 'app passcode'} to show amounts again. After 5 wrong tries it locks for 15 minutes.</p>
    <label class="field"><span>${demo ? 'Go Blind passcode' : 'App passcode'}</span><input type="password" name="passcode" ${demo ? 'inputmode="numeric"' : ''} autocomplete="current-password" required data-testid="blind-off-passcode"></label>
    <p class="small muted" id="blind-off-msg" data-testid="blind-off-msg">${b.triesLeft < 5 ? `${b.triesLeft} tries left.` : ''}</p>
    <button class="btn btn--block" type="submit" data-testid="blind-off-confirm">Show amounts</button>
  </form></div>`;
  const f = $('#blind-off-form', root); $('[data-close]', root).onclick = () => { root.innerHTML = ''; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/blind/off', { passcode: new FormData(f).get('passcode') }); root.innerHTML = ''; toast('Go Blind is off.'); await refresh(); } catch (err) {
      $('#blind-off-msg', root).innerHTML = `<span class="bad">${esc(err.message)}</span>`; f.passcode.value = '';
      if (err.status === 429 || err.status === 423) { root.innerHTML = ''; toast(err.message, true); await refresh(); }
    }
  };
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
function viewPlanBlind() {
  const g = S.goal, s = S.schedule;
  return `<h1>Plan</h1>
  <div class="card card--blind" data-testid="plan-blind"><div class="row-between"><h2>${esc(g?.name || 'Goal')}</h2>${g?.hardLock ? '<span class="badge-lock">🔒 Hard Lock</span>' : ''}</div>
    <p class="small muted" data-mt>Goal and deposit editing is hidden while Go Blind is on (every field is an amount). The lock keeps working exactly as set.</p><span class="pill pill--blind">${HIDDEN_TXT}</span></div>
  ${s ? `<div class="card"><h2>Automatic deposits</h2><p class="small">Status ${chip(s.status)}</p>${s.status === 'active' && S.nextPulls.length ? `<div class="small muted" data-mt>Next: <span class="preview-dates">${S.nextPulls.map((d) => `<span class="chip chip--date">${short(d)}</span>`).join('')}</span></div>` : ''}</div>` : ''}
  ${blindCard()}`;
}
function viewPlan() {
  if (BLIND()) return viewPlanBlind();
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
    ${s.status === 'paused' ? `<p class="small warn" data-mt data-testid="paused-note">Paused: no new deposits will be created. ${BLIND() ? 'What you saved' : `Your ${money(S.totals.vaultCents)} saved`} stays locked; pausing never unlocks anything.${pending ? ` ${pending} pending transfer${pending > 1 ? 's are' : ' is'} still in flight. Cancel ${pending > 1 ? 'them' : 'it'} below if you want.` : ''} Resuming skips missed dates (no catch-up).</p>` : ''}
    ${s.status === 'active' && S.nextPulls.length ? `<div class="small muted" data-mt>Next: <span class="preview-dates">${S.nextPulls.map((d) => `<span class="chip chip--date">${short(d)}</span>`).join('')}</span></div>` : ''}
    ${['active', 'paused'].includes(s.status) ? '<details class="tools"><summary>Cancel the whole schedule</summary><p class="small muted" data-mt>Ends all future deposits and the ACH authorization. Saved money and the lock stay exactly as they are.</p><button class="btn btn--sm btn--danger" data-action="cancel-schedule">Cancel schedule</button></details>' : ''}`;
  const periods = (s?.periods || []).filter((p) => ['deferred', 'skipped'].includes(p.status));
  return `
  <h1>Transfers</h1>
  <div class="card">${control}</div>
  ${BLIND() ? hiddenCard('Settled · pending · returned', 'Totals are hidden. Each deposit below still shows its date and status.') : `<div class="stats">
    <div class="stat"><div class="stat__label">Settled</div><div class="stat__value">${money(S.totals.vaultCents)}</div></div>
    <div class="stat"><div class="stat__label">Pending</div><div class="stat__value">${money(S.totals.pendingCents)}</div></div>
    <div class="stat"><div class="stat__label">Returned</div><div class="stat__value">${money(S.totals.returnedCents)}</div></div>
  </div>`}
  ${periods.length ? `<div class="section-title">Overdraft protection</div><div class="card">${periods.map((p) => `<div class="log-item"><div class="row-between"><span>${short(p.date)} deposit</span>${chip(p.status)}</div><div class="small muted">${esc(p.reasons.at(-1)?.reason || '')}${p.status === 'deferred' ? ` Retrying ${short(p.nextAttemptOn)}.` : ''}</div></div>`).join('')}</div>` : ''}
  <div class="section-title">Deposits</div>
  <div class="card" data-testid="transfer-list">${S.transfers.length ? S.transfers.map((t) => `
    <div class="tr" data-testid="transfer">
      <div class="row-between"><span class="tr__amt">${BLIND() ? 'Deposit · <span class="muted">Hidden</span>' : money(t.amountCents)}</span>${chip(t.status)}</div>
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
    ${S.provider.id === 'mock' && !BLIND() ? `<label class="field" data-mt><span>Mock funding balance ($) for overdraft tests</span><input type="number" id="mock-balance" value="${esc(S.settings.mock.fundingBalanceCents / 100)}" min="0" step="1"></label><button class="btn btn--sm btn--ghost btn--block" data-action="mock-balance">Set mock balance</button>` : ''}
    <button class="btn btn--sm btn--ghost btn--block" data-mt data-action="run">Run engine now</button>
  </div>` : ''}`;
}

// ---------------- Vault ----------------
function viewVault() {
  const g = S.goal, t = S.totals, v = S.vault, blind = BLIND();
  if (!g) return '<h1>Vault</h1><p class="muted">No goal.</p>';
  const unlocked = g.status === 'unlocked';
  const h = S.hardship;
  return `
  <h1>Vault</h1>
  <section class="card hero">
    <div class="hero__lock hero__lock--inline">${LOCK_SVG(unlocked, 56)}</div>
    <div class="eyebrow" data-mt>${esc(g.name)}</div>
    <div class="hero__amount ${blind ? 'hero__amount--blind' : ''}" data-testid="vault-amount">${blind ? HIDDEN_TXT : money(t.vaultCents)}</div>
    <div class="muted small">${blind ? 'Balance hidden · deposits keep running' : `settled in the vault${t.pendingCents ? ` · ${money(t.pendingCents)} pending (not counted)` : ''}`}</div>
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
    <p class="small">${g.hardLock ? 'There is no early unlock in this app: no override code, no admin bypass, and the AI bot cannot unlock it either.' : 'This goal was created without Hard Lock.'} The vault opens only when <strong>settled</strong> deposits reach ${blind ? 'the goal' : `<strong>${money0(g.targetCents)}</strong>`}${g.unlockRule === 'goal_and_date' ? ` and ${pretty(g.releaseDate)} has passed` : ''}. ${blind ? 'Amount to go is hidden (Go Blind).' : `${money0(g.remainingCents)} to go.`}</p>
    <p class="small muted">Emergency stop and pause only stop <em>future</em> deposits. They never release money. <a href="#/bank">About your bank account</a>.</p></div></div>
  </section>
  ${g.hardship.enabled ? `
  <section class="card card--warn" data-testid="hardship-card">
    <h2>Hardship release</h2>
    ${h?.status === 'cooling_off' ? `<p class="small">Requested ${pretty(h.requestedOn)} for ${money(h.amountCents)}. Cooling-off until <strong>${pretty(h.availableOn)}</strong>.</p>
      <button class="btn btn--block" data-action="hardship-cancel">Cancel the request (keep everything locked)</button>
      ${S.today >= h.availableOn ? `<form id="hardship-complete" data-mt><label class="field"><span>Type: ${esc(S.hardshipPhrase)}</span><input type="text" name="typed" autocomplete="off"></label><label class="check"><input type="checkbox" name="confirm"><span class="small">Release ${money(h.amountCents)} now.</span></label><button class="btn btn--danger btn--block" data-mt type="submit">Complete hardship release</button></form>` : ''}`
    : blind ? '<p class="small muted">Hardship release needs amounts. Turn off Go Blind first (not possible while "stay blind until goal" holds).</p>'
    : `<p class="small">Chosen when this goal was created: an early release with a ${esc(g.hardship.coolingOffDays)}-day cooling-off period. Everything is logged and you can cancel during the wait.</p>
      <form id="hardship-form"><label class="field"><span>Amount ($)</span><input type="number" name="amount" min="1" step="1" max="${esc(t.vaultCents / 100)}"></label>
      <label class="field"><span>Type: ${esc(S.hardshipPhrase)}</span><input type="text" name="typed" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="confirm"><span class="small">Start the ${esc(g.hardship.coolingOffDays)}-day cooling-off.</span></label>
      <button class="btn btn--block" data-mt type="submit">Request hardship release</button></form>`}
  </section>` : ''}
  <a class="btn btn--ghost btn--block" href="#/rollover">Preview Roll Over &amp; Relock</a>` : ''}
  ${(S.sealedLogins || []).length ? `<div class="section-title">Sealed logins</div><div class="card">${S.sealedLogins.map((r) => `<a class="row-between small" href="#/seal"><span>${r.status === 'unlocked' ? '🔓' : '🔒'} ${esc(r.label)}</span><span class="muted">${r.status === 'unlocked' ? 'ready to open' : esc(RULE_TEXT[r.unlockRule])}</span></a>`).join('')}</div>` : ''}
  ${blind && (S.cycles.length || S.withdrawals.length) ? `<div class="section-title">History</div>${hiddenCard('History', `${S.cycles.length} past cycle(s): amounts hidden.`)}` : S.cycles.length || S.withdrawals.length ? `<div class="section-title">History</div><div class="card"><table class="mini">
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
  if (BLIND()) return `<h1>Roll Over &amp; Relock</h1>${hiddenCard('Rollover preview', 'The rollover preview is all amounts, so it is hidden while Go Blind is on. When the goal is reached the vault unlocks, amounts show again, and the wizard opens here.')}`;
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
const SIM_BOT_LABELS = () => [
  ['status', 'Read status'], ['propose_raise', BLIND() ? 'Propose a higher goal' : 'Propose +$500 goal'], ['request_resume', 'Ask to resume deposits'], ['pause', 'Pause deposits'],
  ['prepare_rollover', BLIND() ? 'Prepare a rollover' : 'Prepare rollover 1000 → 4000'], ['blind_on', 'Turn Go Blind on'], ['try_unlock', 'Try to unlock (refused)'], ['try_lower', 'Try to lower goal (refused)'],
  ['try_disable_hard_lock', 'Try to turn off Hard Lock (refused)'], ['try_production', 'Try production mode (refused)'], ['try_delete_audit', 'Try to delete audit (refused)'],
  ['try_blind_off', 'Try to turn Go Blind off (refused)'], ['try_reveal_amounts', 'Try to read hidden amounts (refused)'],
  ['sealed_status', 'See sealed logins'], ['try_reveal_login', 'Try to reveal sealed login (refused)'], ['try_delete_login', 'Try to delete sealed login (refused)'],
  ['cards', 'Read Did-you-know cards'], ['propose_speed_up', 'Propose a faster deposit'],
  ['propose_monthly_move', 'Propose monthly move (Varo → Step → Current)'], ['read_monthly_moves', 'Read monthly moves + decisions'], ['complete_monthly_move', 'Record next move step (simulated)'],
];
function simBotSummary(r) {
  const b = r.body || {};
  if (b.sealedLogins && !b.goal) return esc(b.sealedLogins.length ? b.sealedLogins.map((x) => `${x.label}: ${x.status} since ${new Date(x.sealedAt).toLocaleDateString()}`).join(' · ') + ' (no contents)' : 'No sealed logins.');
  if (b.monthlyMoves) return esc(b.monthlyMoves.length ? b.monthlyMoves.slice(0, 3).map((m) => `${m.month}: ${m.status}${m.nextLeg ? `, next ${m.nextLeg}` : ''}`).join(' · ') : 'No monthly moves yet.') + (b.blindMode ? ' <span class="chip chip--blind" data-testid="sim-bot-blindmode">blindMode: true</span>' : '');
  if (b.move) return esc(`${b.move.summary} — ${b.move.status}${b.move.nextLeg ? ` (next: ${b.move.legs.find((l) => l.id === b.move.nextLeg)?.label})` : ''}`) + (b.blindMode ? ' <span class="chip chip--blind" data-testid="sim-bot-blindmode">blindMode: true</span>' : '');
  if (b.cards) return esc(`${b.cards.unlocked.length} card(s) unlocked${b.cards.unlocked[0] ? `, latest "${b.cards.unlocked[0].title}"` : ''}${b.cards.speedUp?.cards?.[0] ? ` · ${b.cards.speedUp.cards[0].tip}` : ''}`) + (b.blindMode ? ' <span class="chip chip--blind" data-testid="sim-bot-blindmode">blindMode: true</span>' : '');
  const text = b.message || b.approval?.summary || (b.goal && b.balances ? (b.blindMode ? `Goal "${b.goal.name}" · ${b.goal.status} · goal reached: ${b.goalReached ? 'yes' : 'no'} · deposits ${b.schedule?.status || 'none'} · amounts hidden` : `Goal ${money0(b.goal.targetCents)} · settled ${money(b.balances?.settledLockedCents)}`) : '') || b.note || b.error || 'OK';
  return `${esc(text)}${b.blindMode ? ' <span class="chip chip--blind" data-testid="sim-bot-blindmode">blindMode: true</span>' : ''}`;
}
function viewSimBot() {
  return `<section class="card card--gold" data-testid="sim-bot">
    <h2>Simulated bot (Grok)</h2>
    <p class="small muted">Tap to make the bot call the real bot API with its own key. Proposals land in your Inbox; forbidden requests are refused and logged.${BLIND() || S.blind?.on ? ' Go Blind is on: every bot response has amounts removed (<code>blindMode: true</code>). The bot can turn Go Blind on but never off.' : ''}</p>
    <div class="sim-bot-grid">${SIM_BOT_LABELS().map(([a, l]) => `<button class="btn btn--sm ${a.startsWith('try_') ? 'btn--danger' : ''}" data-action="simbot" data-bot="${a}" data-testid="simbot-${a}">${esc(l)}</button>`).join('')}</div>
    <button class="btn btn--sm btn--ghost btn--block" data-mt data-action="simbot" data-bot="new_key" data-testid="simbot-new_key">${S.simBot?.hasKey ? 'Give the bot a fresh key' : 'Give the bot a key'}</button>
    ${simBotLast ? `<div class="sim-bot-out" data-testid="sim-bot-out"><span class="chip chip--s${esc(simBotLast.httpStatus)}">${esc(simBotLast.httpStatus)}</span> <code>${esc(simBotLast.action)}</code><div class="small muted">${simBotSummary(simBotLast)}</div></div>` : ''}
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
  const hid = (label) => `<label class="field"><span>${label.replace(' ($)', '')}</span><input type="text" value="Hidden" readonly aria-readonly="true" class="input--hidden"></label>`;
  const numC = (name, label, val, attrs = '') => (BLIND() ? hid(label) : num(name, label, val, attrs));
  const tog = (name, label, val, sub = '') => `<label class="toggle-row"><span>${label}${sub ? `<br><span class="small muted">${sub}</span>` : ''}</span><input type="checkbox" name="${name}" ${val ? 'checked' : ''}></label>`;
  return `
  <h1>Settings</h1>
  <p class="small muted">Defaults for new goals and the engine. Changing settings never loosens a goal that is already locked.${BLIND() ? ' Amount fields are hidden while Go Blind is on and are left unchanged when you save.' : ''}</p>
  <form class="card" id="settings-form" data-testid="settings-form">
    <h2>New goals</h2>
    <div class="grid2">${numC('goal.targetCents', 'Default goal ($)', s.goal.targetCents / 100, 'min="1" step="1"')}${num('goal.lockDays', 'Lock period (days)', s.goal.lockDays, 'min="1" max="3650"')}</div>
    ${BLIND() ? hid('Default milestones ($)') : `<label class="field"><span>Default milestones ($)</span><input type="text" name="goal.milestonesCents" value="${esc(s.goal.milestonesCents.map((c) => c / 100).join(', '))}"></label>`}
    ${tog('hardLock.defaultOn', 'Hard Lock on for new goals', s.hardLock.defaultOn, 'Recommended. No early release path at all.')}
    ${num('hardship.coolingOffDaysDefault', 'Hardship cooling-off default (days, only for non-Hard-Lock goals)', s.hardship.coolingOffDaysDefault, 'min="7" max="365"')}
    <h2 data-mt>Deposits &amp; overdraft protection</h2>
    <div class="grid2">${numC('contribution.amountCents', 'Default deposit ($)', s.contribution.amountCents / 100, 'min="1" step="0.01"')}${numC('safety.bufferCents', 'Safety buffer ($)', s.safety.bufferCents / 100, 'min="0" step="1"')}</div>
    <label class="field"><span>If the balance is too low</span><select name="safety.onInsufficientFunds"><option value="defer" ${s.safety.onInsufficientFunds === 'defer' ? 'selected' : ''}>Defer and retry next business day</option><option value="skip" ${s.safety.onInsufficientFunds === 'skip' ? 'selected' : ''}>Skip that deposit</option></select></label>
    <div class="grid2">${num('safety.deferMaxBusinessDays', 'Retry for (business days)', s.safety.deferMaxBusinessDays, 'min="0" max="10"')}${num('safety.pauseAfterReturns', 'Pause after N returns', s.safety.pauseAfterReturns, 'min="1" max="10"')}</div>
    <h2 data-mt>Unlock code &amp; rollover</h2>
    <div class="grid2">${num('unlock.codeExpiryDays', 'Code expires after (days)', s.unlock.codeExpiryDays, 'min="1" max="365"')}${num('unlock.maxAttempts', 'Wrong tries allowed', s.unlock.maxAttempts, 'min="1" max="20"')}</div>
    <div class="grid2">${numC('rollover.defaultWithdrawCents', 'Rollover: default withdraw ($)', s.rollover.defaultWithdrawCents / 100, 'min="0" step="1"')}${numC('rollover.defaultNewTargetCents', 'Rollover: default new goal ($)', s.rollover.defaultNewTargetCents / 100, 'min="1" step="1"')}</div>
    <h2 data-mt>Benefits guard</h2>
    ${tog('benefits.receivesSSI', 'I receive SSI', s.benefits?.receivesSSI, 'Shows a warning (with no numbers, so it works in Go Blind too) when settled savings get close to or over the SSI resource limit.')}
    <div class="grid2">${numC('benefits.resourceLimitCents', 'Resource limit ($)', (s.benefits?.resourceLimitCents ?? 200000) / 100, 'min="0" step="1"')}${num('benefits.warnAtPercent', 'Warn at (percent of the limit)', s.benefits?.warnAtPercent ?? 80, 'min="50" max="100"')}</div>
    <h2 data-mt>Notifications</h2>
    ${tog('notifications.inApp', 'In-app banners', s.notifications.inApp)}${tog('notifications.console', 'Server log', s.notifications.console)}${tog('notifications.webhook', 'Webhook (NOTIFY_WEBHOOK_URL in .env)', s.notifications.webhook, 'Never includes unlock codes. Push/email/SMS can be added as notifier plugins.')}
    <h2 data-mt>Bot</h2>
    <div class="grid2">${num('bot.rateLimitPerMinute', 'Calls per minute per key', s.bot.rateLimitPerMinute, 'min="1" max="600"')}${num('bot.approvalExpiryDays', 'Requests expire after (days)', s.bot.approvalExpiryDays, 'min="1" max="30"')}</div>
    <button class="btn btn--gold btn--block" data-mt type="submit">Save settings</button>
  </form>
  <div class="section-title">Go Blind</div>
  ${blindCard()}
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
      <li><strong>If you get SSI:</strong> an ABLE account can hold savings without counting toward the SSI resource limit${BLIND() ? '' : ' ($2,000; ABLE balances up to $100,000 are excluded)'}. Check with SSA or a benefits counselor.</li>
    </ol>
  </section>
  ${logged ? '' : '<a class="btn btn--block" href="#/">Back</a>'}`;
}

// ---------------- More + Log ----------------
function viewMore() {
  return `<h1>More</h1><nav class="card more-list">
    <a href="#/setup" data-testid="more-setup">Guided setup <small>seal · unlock date · lost card · dashboard</small></a>
    <a href="#/seal" data-testid="more-seal">Seal my login <small>${(S.sealedLogins || []).length ? `${S.sealedLogins.filter((r) => r.status === 'sealed').length} sealed` : 'none yet'}</small></a>
    <a href="#/lostcard">Lost-card steps <small>${S.lostCard ? `${S.lostCard.steps.filter((x) => x.done).length}/${S.lostCard.steps.length}` : ''}</small></a>
    <a href="#/cards" data-testid="more-cards">Did you know? cards <small>${S.cards?.unlocked.length || 0} unlocked</small></a>
    <a href="#/moves" data-testid="more-moves">Monthly move <small>Varo → Step → Current · ${(S.monthlyMoves || []).filter((m) => ['approved', 'in_progress'].includes(m.status)).length} to do</small></a>
    <a href="#/sync" data-testid="more-sync">Assistant sync <small>${S.simulation ? (localStorage.getItem('ldb-sync-code') ? 'sync code set' : 'not set up') : 'bot API'}</small></a>
    <a href="#/accounts">Accounts <small>${S.accounts.length} linked</small></a>
    <a href="#/plan">Plan <small>goal, Hard Lock, schedule</small></a>
    <a href="#/authorize">Authorize <small>${esc(S.authorization?.status || 'none')}</small></a>
    <a href="#/rollover">Roll Over &amp; Relock</a>
    <a href="#/bot">AI bot <small>keys &amp; activity</small></a>
    <a href="#/settings">Settings <small>${S.blind?.on ? 'Go Blind on' : 'incl. Go Blind'}</small></a>
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


// ---------------- Seal my login + Unlock date + Lost card + Setup wizard ----------------
// Login values live only in this module's memory while their screen is open (the draft before sealing, or the reveal
// after unlock). They are wiped when you seal or leave the screen. The server never sends them anywhere else.
const RULE_TEXT = { date: 'On the date', goal: 'When the goal is hit', date_and_goal: 'Date AND goal (whichever is later)' };
const FIELD_TEXT = { username: 'Username / email', password: 'Password', recoveryEmail: 'Recovery email', phone: 'Phone on the account', notes: 'Notes' };
const newSealState = () => ({ mode: null, step: 1, draft: null, targetId: null, form: { label: 'Current Savings', passwordMode: 'generate', questions: [{ question: '', generate: true }] }, checks: {}, unlock: { unlockRule: 'date', unlockDate: '' }, wasOpen: false });
let SEAL = newSealState();
let REVEALED = {}; // id -> values (after unlock only)
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
function fmtCountdown(ms) {
  if (ms <= 0) return 'Unlock date reached';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}
const countdown = (ms, id = '') => (ms ? `<span class="countdown" data-countdown="${esc(ms)}" ${id ? `data-testid="${id}"` : ''}>${esc(fmtCountdown(ms - Date.now()))}</span>` : '');
setInterval(() => document.querySelectorAll('[data-countdown]').forEach((el) => { el.textContent = fmtCountdown(Number(el.dataset.countdown) - Date.now()); }), 1000);
async function copyText(text, secret) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.className = 'offscreen'; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } finally { t.remove(); }
  }
  toast(secret ? 'Copied. The clipboard is cleared in 60 seconds (best effort).' : 'Copied');
  if (secret) setTimeout(() => { navigator.clipboard?.writeText('').catch(() => {}); }, 60_000);
}
function wipeSeal() { SEAL = newSealState(); REVEALED = {}; }
const earliestUnlock = () => (S.sealedLogins || []).filter((r) => r.unlockDate).map((r) => r.unlockDate).sort().at(-1) || null;

function valueRows(values, testPrefix = 'val') {
  const rows = [];
  for (const f of ['username', 'password', 'recoveryEmail', 'phone']) if (values[f]) rows.push([f, FIELD_TEXT[f], values[f]]);
  (values.questions || []).forEach((q, i) => { if (q.answer) rows.push([`q${i}`, q.question || `Security answer ${i + 1}`, q.answer]); });
  if (values.notes) rows.push(['notes', FIELD_TEXT.notes, values.notes]);
  return rows.map(([k, label, v]) => `<div class="copy-row"><div class="copy-row__main"><div class="small muted">${esc(label)}</div><div class="secret ${k === 'password' ? 'secret--pw' : ''}" data-testid="${testPrefix}-${esc(k)}">${esc(v)}</div></div>
    <button type="button" class="btn btn--sm" data-action="copy" data-copy="${esc(v)}" data-secret="1" data-testid="copy-${esc(k)}">Copy</button></div>`).join('');
}
function unlockFields(u, { forReseal = false } = {}) {
  const goalOk = S.goal?.status === 'saving';
  return `<div class="seg seg--3" role="radiogroup" data-testid="unlock-rule">
      ${['date', 'goal', 'date_and_goal'].map((r) => `<label class="${u.unlockRule === r ? 'on' : ''}"><input type="radio" name="unlockRule" value="${r}" ${u.unlockRule === r ? 'checked' : ''} ${r !== 'date' && !goalOk ? 'disabled' : ''} data-testid="rule-${r}">${esc(RULE_TEXT[r])}</label>`).join('')}
    </div>
    <label class="field" data-rule-date ${u.unlockRule === 'goal' ? 'hidden' : ''}><span>Unlock date</span><input type="date" name="unlockDate" value="${esc(u.unlockDate)}" min="${esc(plusDays(1))}" data-testid="unlock-date"></label>
    <div class="countdown-box" data-rule-date ${u.unlockRule === 'goal' ? 'hidden' : ''}><div class="small muted">Opens in</div><div class="countdown countdown--big" id="unlock-preview" data-testid="unlock-preview">${u.unlockDate ? esc(fmtCountdown(new Date(`${u.unlockDate}T00:00:00`) - Date.now())) : 'Pick a date'}</div></div>
    <p class="small muted" data-mt>${goalOk ? `Goal: <strong>${esc(S.goal.name)}</strong>. "When the goal is hit" means the settled balance reaches it (same rule as the Hard Lock).` : 'Goal-based unlocks need a goal that is still saving (set one up in Plan).'} ${forReseal ? '' : 'After sealing, the date can only be pushed <strong>later</strong>, never earlier, and a goal can be added but not removed.'} The date uses ${S.simulation ? 'this device\'s clock' : 'the server\'s clock'} at midnight.</p>`;
}
function viewSealWizard(ctx) {
  const w = SEAL, reseal = w.mode === 'reseal';
  const target = reseal ? (S.sealedLogins || []).find((r) => r.id === w.targetId) : null;
  const steps = reseal ? ['New password', 'Change it at the bank', ...(w.wasOpen ? ['New unlock date'] : []), 'Reseal'] : ['Login details', 'Enter it at the bank', 'Unlock date', 'Seal'];
  const head = `<ol class="stepper" data-testid="seal-stepper">${steps.map((s, i) => `<li class="${i + 1 === w.step ? 'on' : i + 1 < w.step ? 'done' : ''}">${esc(s)}</li>`).join('')}</ol>`;
  const f = w.form;
  if (w.step === 1) {
    return `${head}<form class="card" id="seal-form-1" data-testid="seal-step-1">
      <h2>${reseal ? `Reseal "${esc(target?.label || '')}" with a new password` : 'Seal my login'}</h2>
      <p class="small muted">${reseal ? 'Use this when the bank makes you change the password. You get a NEW password; the old one is never shown. Leave the other fields blank to keep what is sealed.' : 'Your savings login goes in here once, and then the app seals it until your unlock date. Use fake data to try it.'}</p>
      ${reseal ? '' : `<label class="field"><span>Account label (not secret)</span><input type="text" name="label" value="${esc(f.label)}" maxlength="40" required data-testid="seal-label"></label>
      <label class="field"><span>Login username or email</span><input type="text" name="username" value="${esc(f.username || '')}" autocomplete="off" autocapitalize="off" spellcheck="false" data-testid="seal-username"></label>`}
      <div class="seg" role="radiogroup"><label class="${f.passwordMode === 'generate' ? 'on' : ''}"><input type="radio" name="passwordMode" value="generate" ${f.passwordMode === 'generate' ? 'checked' : ''} data-testid="pw-generate">Generate a strong password</label>
        <label class="${f.passwordMode === 'enter' ? 'on' : ''}"><input type="radio" name="passwordMode" value="enter" ${f.passwordMode === 'enter' ? 'checked' : ''} data-testid="pw-enter">Enter ${reseal ? 'the new' : 'my existing'} password</label></div>
      <label class="field" data-pw="enter" ${f.passwordMode === 'enter' ? '' : 'hidden'}><span>Password</span><input type="password" name="password" autocomplete="off" data-testid="seal-password"></label>
      <details class="tools" data-pw="generate" ${f.passwordMode === 'generate' ? '' : 'hidden'}><summary>Password rules (banks differ)</summary>
        <div class="grid2" data-mt><label class="field"><span>Length (12-64)</span><input type="number" name="length" min="12" max="64" value="${esc(f.length || 20)}" data-testid="pw-length"></label>
        <label class="field"><span>How many symbols (0-6)</span><input type="number" name="symbolCount" min="0" max="6" value="${esc(f.symbolCount ?? 2)}"></label></div>
        <label class="field"><span>Allowed symbols</span><input type="text" name="symbols" value="${esc(f.symbols ?? '!@#$%&*-_+=?')}" autocomplete="off" spellcheck="false" data-testid="pw-symbols"></label>
        <label class="check"><input type="checkbox" name="avoidAmbiguous" ${f.avoidAmbiguous === false ? '' : 'checked'}><span class="small">Skip look-alike characters (0/O, 1/l/I)</span></label>
      </details>
      <label class="field"><span>${reseal ? 'New recovery email (optional)' : 'Recovery email (optional)'}</span><input type="email" name="recoveryEmail" value="${esc(f.recoveryEmail || '')}" autocomplete="off" data-testid="seal-recovery"></label>
      <label class="field"><span>${reseal ? 'New phone number (optional)' : 'Phone number on the account (optional, e.g. a prepaid burner kept by someone you trust)'}</span><input type="tel" name="phone" value="${esc(f.phone || '')}" autocomplete="off" data-testid="seal-phone"></label>
      ${reseal ? `<label class="field"><span>New username (optional)</span><input type="text" name="username" autocomplete="off" autocapitalize="off"></label>
        <label class="check"><input type="checkbox" name="regenerateAnswers"><span class="small">Also make new random security answers (for the same questions)</span></label>`
      : `<label class="field"><span>Notes (optional: security question answers, PIN hints)</span><textarea name="notes" rows="2" maxlength="1000" data-testid="seal-notes">${esc(f.notes || '')}</textarea></label>
      <div class="small muted">Security question (optional)</div>
      ${f.questions.map((q, i) => `<div class="q-row"><input type="text" name="q${i}" value="${esc(q.question || '')}" placeholder="e.g. Name of your first pet" data-testid="seal-q${i}">
        <label class="check"><input type="checkbox" name="qgen${i}" ${q.generate ? 'checked' : ''} data-testid="seal-qgen${i}"><span class="small">Random answer</span></label>
        <input type="text" name="qa${i}" value="${esc(q.answer || '')}" placeholder="Your answer" ${q.generate ? 'hidden' : ''}></div>`).join('')}`}
      <div class="btn-row" data-mt><button class="btn btn--gold btn--block" type="submit" data-testid="seal-next-1">${f.passwordMode === 'generate' ? 'Generate & show my login' : 'Show my login'}</button></div>
      ${ctx === 'seal' ? '<button class="btn btn--ghost btn--block" type="button" data-action="seal-cancel">Cancel</button>' : ''}
    </form>`;
  }
  const d = w.draft;
  if (w.step === 2) {
    const boxes = reseal ? [['changedAtBank', 'I changed the password at the bank to exactly this'], ['confirmedLogin', 'I logged out and logged back in once with it, and it worked'], ['notSaved', 'I did not save it in my browser, phone or a password manager']]
      : [['enteredAtBank', 'I entered these at the bank (signup or password change) exactly as shown'], ['confirmedLogin', 'I logged out and logged back in once with them, and it worked'], ['notSaved', 'I did not save the password in my browser, phone or a password manager']];
    return `${head}<section class="card card--gold" data-testid="seal-step-2">
      <h2>Type this at the bank now</h2>
      <p class="small">Shown <strong>once</strong>. After you seal it, the app will not show it again until the unlock ${reseal ? 'condition' : 'date'}.${d.passwordInfo ? ` Password: ${esc(d.passwordInfo.length)} characters, about ${esc(d.passwordInfo.bits)} bits.` : ''}</p>
      ${valueRows(d.values)}
      ${reseal && d.keep?.length ? `<p class="small muted">Kept sealed (not shown): ${esc(d.keep.map((k) => FIELD_TEXT[k] || 'security answers').join(', '))}.</p>` : ''}
      <p class="small warn">If your browser offers to save the password, choose <strong>Never</strong>. Test the login once: log out and back in at the bank.</p>
      <form id="seal-checks" data-mt>${boxes.map(([k, l]) => `<label class="check"><input type="checkbox" name="${k}" ${w.checks[k] ? 'checked' : ''} data-testid="check-${k}"><span class="small">${esc(l)}</span></label>`).join('')}
        <button class="btn btn--gold btn--block" data-mt type="submit" data-testid="seal-next-2" ${boxes.every(([k]) => w.checks[k]) ? '' : 'disabled'}>Next</button></form>
      <button class="btn btn--ghost btn--block" data-mt data-action="seal-back" data-testid="seal-regenerate">The bank rejected it: change the rules and make a new one</button>
    </section>`;
  }
  const unlockStep = reseal ? (w.wasOpen ? 3 : 0) : 3;
  if (w.step === unlockStep) {
    return `${head}<form class="card" id="seal-unlock" data-testid="seal-step-unlock"><h2>${reseal ? 'New unlock date' : 'When should it unlock?'}</h2>
      <p class="small muted">${reseal ? 'This login had already opened, so resealing starts a new lock.' : 'Pick the unlock date. The login stays sealed until then. No passcode, no override, and the bot can never open it.'}</p>
      ${unlockFields(w.unlock, { forReseal: reseal })}
      <button class="btn btn--gold btn--block" data-mt type="submit" data-testid="seal-next-3">Next</button></form>`;
  }
  const phrase = reseal ? 'RESEAL MY LOGIN' : 'SEAL MY LOGIN';
  const u = reseal && !w.wasOpen ? { unlockRule: target?.unlockRule, unlockDate: target?.unlockDate } : w.unlock;
  const atMs = u.unlockDate ? new Date(`${u.unlockDate}T00:00:00`).getTime() : null;
  return `${head}<form class="card danger-card" id="seal-final" data-testid="seal-step-final">
    <h2>${reseal ? 'Reseal' : 'Seal'} "${esc(d.label)}"</h2>
    <ul class="facts small"><li>Unlocks: <strong>${esc(RULE_TEXT[u.unlockRule] || '')}</strong>${u.unlockDate ? ` · ${esc(pretty(u.unlockDate))}` : ''}${u.unlockRule !== 'date' && S.goal ? ` · goal "${esc(S.goal.name)}"` : ''}</li>
      ${atMs ? `<li>Opens in ${countdown(atMs, 'final-countdown')}</li>` : ''}
      <li>After this, the values disappear. No passcode (not even Go Blind's), no override, no support path in this app, and the bot can't open, change or delete it.</li>
      <li>The date can only move later. Deleting is refused while it is sealed.</li>
      <li>Honest limit: your bank can still reset the login if you prove who you are. The real lock is the bank's own rules and a trusted person. <a href="#/lostcard">Lost-card steps</a> help.</li></ul>
    <label class="field"><span>Type <strong>${esc(phrase)}</strong></span><input type="text" name="typed" autocomplete="off" autocapitalize="characters" data-testid="seal-typed"></label>
    <button class="btn btn--danger btn--block" type="submit" data-testid="seal-confirm">${reseal ? 'Reseal it' : 'Seal it'}</button></form>`;
}
function sealedCard(r) {
  const open = r.status === 'unlocked', vals = REVEALED[r.id];
  const cond = [r.unlockDate ? `${r.dateMet ? '✓' : '○'} date ${pretty(r.unlockDate)}` : '', r.unlockRule !== 'date' ? `${r.goalMet ? '✓' : '○'} goal${r.goalName ? ` "${esc(r.goalName)}"` : ''} reached` : ''].filter(Boolean).join(' · ');
  return `<section class="card ${open ? 'card--gold' : 'card--sealed'}" data-testid="sealed-card" data-id="${esc(r.id)}">
    <div class="row-between"><h2>${open ? '🔓' : '🔒'} ${esc(r.label)}</h2><span class="pill ${open ? 'pill--unlocked' : 'pill--locked'}" data-testid="sealed-status">${open ? 'Ready to open' : 'Sealed'}</span></div>
    <p class="small">${esc(RULE_TEXT[r.unlockRule])} · ${cond}</p>
    ${!open && r.unlockAtMs ? `<div class="countdown-box"><div class="small muted">Opens in</div><div class="countdown countdown--big" data-countdown="${esc(r.unlockAtMs)}" data-testid="sealed-countdown">${esc(fmtCountdown(r.unlockAtMs - Date.now()))}</div></div>` : ''}
    <p class="small muted">Sealed ${esc(new Date(r.sealedAt).toLocaleDateString())}${r.resealCount ? ` · resealed ${r.resealCount}×` : ''} · holds: ${esc(r.fields.map((f) => (FIELD_TEXT[f] || 'security answers').toLowerCase()).join(', '))}. Password ${r.passwordSource === 'entered' ? 'entered by you' : 'generated by the app'}.</p>
    ${vals ? `<div data-testid="revealed">${valueRows(vals, 'rev')}</div><p class="small muted">Shown because the unlock condition is met. Hidden again when you leave this screen.</p>` : ''}
    <div class="btn-row" data-mt>
      ${open ? (vals ? '' : `<button class="btn btn--sm btn--gold" data-action="seal-reveal" data-id="${esc(r.id)}" data-testid="sealed-open">Open login</button>`)
        : `<button class="btn btn--sm" data-action="seal-reveal" data-id="${esc(r.id)}" data-testid="sealed-try-open">Open login (locked)</button>`}
      <button class="btn btn--sm" data-action="seal-reseal" data-id="${esc(r.id)}" data-testid="sealed-reseal">Reseal with new password</button>
      <button class="btn btn--sm btn--danger" data-action="seal-delete" data-id="${esc(r.id)}" data-testid="sealed-delete">Delete</button>
    </div>
    <details class="tools"><summary>Push the unlock later · rename</summary>
      <form class="stack" data-unlock-form="${esc(r.id)}" data-mt>
        ${r.unlockRule !== 'goal' ? `<label class="field"><span>New unlock date (later only)</span><input type="date" name="unlockDate" value="${esc(r.unlockDate)}" min="${esc(r.unlockDate)}" data-testid="push-date"></label>` : ''}
        ${r.unlockRule !== 'date_and_goal' ? `<label class="check"><input type="checkbox" name="both" ${S.goal?.status === 'saving' ? '' : 'disabled'}><span class="small">Require ${r.unlockRule === 'date' ? 'the goal too' : 'a date too'} (whichever is later)</span></label>${r.unlockRule === 'goal' ? `<label class="field"><span>Date</span><input type="date" name="unlockDate" min="${esc(plusDays(1))}"></label>` : ''}` : ''}
        <button class="btn btn--sm" type="submit" data-testid="push-save">Save (tighten only)</button></form>
      <form class="row" data-label-form="${esc(r.id)}" data-mt><input type="text" name="label" value="${esc(r.label)}" maxlength="40" class="grow"><button class="btn btn--sm" type="submit">Rename</button></form>
    </details>
  </section>`;
}
function viewSeal() {
  const list = S.sealedLogins || [];
  if (SEAL.mode) return `<h1>${SEAL.mode === 'reseal' ? 'Reseal login' : 'Seal my login'}</h1>${viewSealWizard('seal')}`;
  return `<h1>Seal my login</h1>
  <div class="card small muted">The login of your separate savings account (for example <strong>Current Savings</strong>) is sealed on ${S.simulation ? 'this device' : 'the server'} with AES-256-GCM until its unlock date and/or goal. Nobody can open it early in this app: not you, not a passcode, not the bot. <a href="#/lostcard">Lost-card checklist</a> · <a href="#/setup">Guided setup</a></div>
  ${list.map(sealedCard).join('')}
  ${list.length < 5 ? '<button class="btn btn--gold btn--block" data-action="seal-start" data-testid="seal-start">Seal a login</button>' : ''}
  <p class="small muted" data-mt>Honest limits: ${S.simulation ? 'in this browser demo the key lives on this device, so a technical person with the device could decrypt; changing the phone\'s clock could also fool the date. Clearing site data erases it (without revealing it).' : 'whoever can read the server\'s key and data file could decrypt.'} Your bank can always reset the login after checking your identity. See docs/SEALED_LOGIN.md.</p>`;
}
const LOST_STEPS_HELP = {
  report_lost: 'Report your <strong>Current</strong> debit card (and any virtual card) as lost or stolen, in the Current app\'s card settings or with Current support. Use the phone number or contact options shown in the Current app or on current.com. If they offer a replacement card, decline it or ask for it later.',
  remove_wallet: 'iPhone: open <strong>Wallet</strong> → tap the Current card → tap ⋯ (More) → <strong>Card Details</strong> → <strong>Remove Card</strong>. Or <strong>Settings → Wallet &amp; Apple Pay</strong> → the card → <strong>Remove Card</strong>. Also check an Apple Watch and any other phone wallet.',
  destroy_card: 'Cut the physical card through the chip and the number (or snap it), and throw the pieces away in different places.',
  delete_app: 'After sealing: press and hold the Current app icon → <strong>Remove App</strong> → <strong>Delete App</strong>. Don\'t reinstall it until your unlock date.',
  no_new_card: 'Only request a new card after your unlock date.',
};
function viewLostCard(ctx) {
  const lc = S.lostCard || { steps: [] };
  const until = earliestUnlock();
  return `${ctx === 'setup' ? '' : '<h1>Lost-card steps</h1>'}<section class="card" data-testid="lost-card">
    <h2>Cut off the card too</h2>
    <p class="small muted">A sealed password doesn't help if the card still works. Do these once. Your ticks are saved and logged.</p>
    ${lc.steps.map((st) => `<label class="lost-step ${st.done ? 'lost-step--done' : ''}"><input type="checkbox" data-lost="${esc(st.id)}" ${st.done ? 'checked' : ''} data-testid="lost-${esc(st.id)}">
      <span><strong>${esc(st.label)}</strong><br><span class="small muted">${LOST_STEPS_HELP[st.id] || ''}${st.id === 'no_new_card' && until ? ` Your unlock date: <strong>${esc(pretty(until))}</strong>.` : ''}</span></span></label>`).join('')}
    <p class="small ${lc.allDone ? 'ok' : 'muted'}" data-testid="lost-status">${lc.allDone ? 'All done. Nice work.' : `${lc.steps.filter((x) => x.done).length} of ${lc.steps.length} done.`}</p>
    <p class="small muted">Honest limit: Current can still send a new card or restore access after checking your identity. The steps add friction; they aren't a legal lock.</p>
  </section>`;
}
const SAMPLE = { amountCents: 10000, frequency: 'benefit', benefitType: 'ssi', offsetDays: 1 };
function setupStage() {
  if (!(S.sealedLogins || []).length) return SEAL.step >= 3 ? 2 : 1;
  if (!S.lostCard?.allDone && !SETUP_SKIP_LOST) return 3;
  return 4;
}
let SETUP_SKIP_LOST = false;
function viewSetup() {
  const stage = setupStage();
  if (stage <= 2 && !SEAL.mode) SEAL.mode = 'new';
  const names = ['Seal my login', 'Unlock date', 'Lost card', 'Dashboard'];
  const bar = `<ol class="stepper stepper--big" data-testid="setup-stepper">${names.map((n, i) => `<li class="${i + 1 === stage ? 'on' : i + 1 < stage ? 'done' : ''}">${i + 1}. ${esc(n)}</li>`).join('')}</ol>`;
  let body;
  if (stage <= 2) body = viewSealWizard('setup');
  else if (stage === 3) body = `${viewLostCard('setup')}<button class="btn btn--block" data-action="setup-lost-next" data-testid="setup-lost-next">${S.lostCard?.allDone ? 'Next: dashboard' : 'I\'ll finish these later: next'}</button>`;
  else {
    const auth = S.authorization?.status === 'active';
    body = `<section class="card" data-testid="setup-dashboard"><h2>Lock &amp; Deploy dashboard</h2>
      <p class="small muted">Automatic deposits into the savings, goal tracking, Go Blind and the SSI warning. ${S.provider.id === 'mock' ? 'Try it with sample data: two fictional banks, <strong>$100/month</strong> the day after SSI arrives, goal Mattress $3,000, SSI guard on.' : ''}</p>
      ${S.schedule ? `<p class="small ok">Deposits set: ${esc(S.schedule.description || '')}</p>` : S.provider.id === 'mock' ? '<button class="btn btn--gold btn--block" data-action="setup-sample" data-testid="setup-sample">Load sample data ($100/month)</button>' : '<a class="btn btn--block" href="#/accounts">Link accounts</a>'}
      ${S.schedule && !auth ? `<div data-mt><label class="field"><span>Your full name (signs the sandbox ACH authorization)</span><input type="text" id="setup-signer" value="Sample User" data-testid="setup-signer"></label>
        <label class="check"><input type="checkbox" id="setup-auth-box" data-testid="setup-auth-box"><span class="small">I authorize these recurring sandbox debits (no real money). The goal locks when I authorize.</span></label>
        <button class="btn btn--gold btn--block" data-mt data-action="setup-authorize" data-testid="setup-authorize">Authorize &amp; start deposits</button></div>` : ''}
      ${auth ? `<p class="small ok" data-testid="setup-done">All set: deposits are on and the goal is locked.</p>
        <div class="btn-row"><a class="btn btn--gold" href="#/" data-testid="setup-open-dashboard">Open dashboard</a>${S.blind?.on ? '' : '<button class="btn" data-action="blind-on-open" data-testid="setup-go-blind">Go Blind (optional)</button>'}<a class="btn" href="#/cards">Did you know? cards</a></div>` : ''}
    </section>`;
  }
  return `<h1>Guided setup</h1>${bar}${body}`;
}

// ---------------- Did you know? cards ----------------
function tipCard(c, { big = false } = {}) {
  return `<article class="tipcard tipcard--${esc(c.tier || c.kind)} ${big ? 'tipcard--big' : ''}" data-testid="tip-card">
    <div class="tipcard__head">${esc(c.heading || 'Did you know?')}</div>
    <h3>${esc(c.title)}</h3><p class="small">${esc(c.tip)}</p>
    ${c.cheer ? `<p class="small gold">${esc(c.cheer)}</p>` : ''}
    ${c.ssiReminder ? `<p class="small warn" data-testid="ssi-reminder">${esc(c.ssiReminder)}</p>` : ''}
    ${c.action ? `<button class="btn btn--sm btn--gold" data-action="raise" data-mult="${esc(c.action.multiplier)}" data-testid="raise-x${esc(c.action.multiplier)}">${esc(c.action.label)}</button><p class="small muted" data-mt>${esc(c.action.note)}</p>` : ''}
    <p class="tiny muted">${esc(c.note || 'General information, not financial advice.')}</p></article>`;
}
function viewCards() {
  const cd = S.cards || { unlocked: [], speedUp: { cards: [] } };
  return `${celebrate()}<h1>Did you know?</h1>
  <p class="small muted">${cd.blind ? 'Every settled milestone' : 'Every settled $100'} you save unlocks a new card (pending money doesn't count). Tips get more advanced as you go. General information, not financial advice.</p>
  ${cd.speedUp?.cards?.length ? `<div class="section-title">Speed up (from your real plan)</div>${cd.speedUp.cards.map((c) => tipCard(c)).join('')}` : ''}
  ${!cd.blind && cd.next ? `<div class="card small" data-testid="next-card">Next card at ${money0(cd.next.atCents)} settled · ${money0(cd.next.toGoCents)} to go.</div>` : ''}
  <div class="section-title">Your collection</div>
  ${cd.unlocked.length ? cd.unlocked.map((c) => tipCard(c)).join('') : `<div class="card small muted">No cards yet. Your first one unlocks with your first settled ${cd.blind ? 'milestone' : '$100'}.</div>`}
  ${cd.blind ? '<p class="small muted">Go Blind is on: cards show no amounts or card numbers.</p>' : ''}`;
}
// Celebration: an inline card with a short confetti burst at the top of Home / Cards (not a blocking modal).
function celebrate() {
  const cd = S?.cards; if (!cd?.unseen) return '';
  const c = cd.unlocked.find((x) => !x.seen) || cd.unlocked[0];
  return `<section class="celebrate" role="status" aria-label="New card unlocked" data-testid="celebrate">
    <div class="confetti" aria-hidden="true">${Array.from({ length: 18 }, (_, i) => `<i class="c c${i % 9}"></i>`).join('')}</div>
    <div class="celebrate__body"><div class="burst" aria-hidden="true">★</div><h2>${cd.unseen > 1 ? `${cd.blind ? 'New milestones' : `${cd.unseen} new cards`} unlocked` : 'New milestone unlocked'}</h2>
    ${tipCard(c, { big: true })}
    <button class="btn btn--gold btn--block" data-mt data-action="cards-seen" data-testid="celebrate-ok">Nice!</button></div></section>`;
}
function readSealForm1(f) {
  const d = new FormData(f), w = SEAL.form;
  Object.assign(w, { label: d.get('label') ?? w.label, username: d.get('username') || '', passwordMode: d.get('passwordMode') || 'generate', recoveryEmail: d.get('recoveryEmail') || '', phone: d.get('phone') || '', notes: d.get('notes') || '',
    length: Number(d.get('length') || 20), symbolCount: Number(d.get('symbolCount') ?? 2), symbols: d.get('symbols') ?? '!@#$%&*-_+=?', avoidAmbiguous: d.get('avoidAmbiguous') === 'on', regenerateAnswers: d.get('regenerateAnswers') === 'on' });
  w.questions = w.questions.map((q, i) => ({ question: d.get(`q${i}`) || '', generate: d.get(`qgen${i}`) === 'on', answer: d.get(`qa${i}`) || '' }));
  return { password: d.get('password') || '' };
}
function wireSealWizard(ctx) {
  const w = SEAL;
  if (!w.draft && S.sealedLoginDraft && !w.resuming) { // page reloaded mid-flow: the draft is still on the server (2 hours)
    w.resuming = true;
    api('/api/sealed-logins/draft').then((r) => { Object.assign(SEAL, { mode: r.draft.kind === 'reseal' ? 'reseal' : 'new', targetId: r.draft.targetId, draft: r.draft, step: 2 }); render(); }).catch(() => {});
  }
  const f1 = $('#seal-form-1');
  if (f1) {
    const sync = () => { const m = new FormData(f1).get('passwordMode'); f1.querySelectorAll('[data-pw]').forEach((el) => { el.hidden = el.dataset.pw !== m; }); f1.querySelectorAll('.seg label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
      w.form.questions.forEach((_, i) => { const g = f1[`qgen${i}`], a = f1[`qa${i}`]; if (g && a) a.hidden = g.checked; }); };
    f1.addEventListener('change', sync);
    f1.onsubmit = async (e) => {
      e.preventDefault();
      const { password } = readSealForm1(f1); const x = w.form;
      const passwordOptions = { length: x.length, symbolCount: x.symbolCount, symbols: x.symbols, avoidAmbiguous: x.avoidAmbiguous };
      const body = w.mode === 'reseal'
        ? { id: w.targetId, passwordMode: x.passwordMode, password, passwordOptions, replace: { username: x.username, recoveryEmail: x.recoveryEmail, phone: x.phone }, regenerateAnswers: x.regenerateAnswers }
        : { label: x.label, username: x.username, passwordMode: x.passwordMode, password, passwordOptions, recoveryEmail: x.recoveryEmail, phone: x.phone, notes: x.notes, questions: x.questions };
      try { const r = await api(w.mode === 'reseal' ? '/api/sealed-logins/reseal/draft' : '/api/sealed-logins/draft', body); w.draft = r.draft; w.step = 2; w.checks = {}; render(); window.scrollTo(0, 0); } catch (err) { toast(err.message, true); }
    };
  }
  const fc = $('#seal-checks');
  if (fc) {
    fc.onchange = () => { for (const el of fc.querySelectorAll('input[type=checkbox]')) w.checks[el.name] = el.checked; fc.querySelector('button').disabled = ![...fc.querySelectorAll('input[type=checkbox]')].every((el) => el.checked); };
    fc.onsubmit = (e) => { e.preventDefault(); w.step = 3; render(); window.scrollTo(0, 0); };
  }
  const fu = $('#seal-unlock');
  if (fu) {
    const upd = () => { const d = new FormData(fu); const rule = d.get('unlockRule'), date = d.get('unlockDate');
      fu.querySelectorAll('[data-rule-date]').forEach((el) => { el.hidden = rule === 'goal'; }); fu.querySelectorAll('.seg label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
      $('#unlock-preview').textContent = date ? fmtCountdown(new Date(`${date}T00:00:00`) - Date.now()) : 'Pick a date'; w.unlock = { unlockRule: rule, unlockDate: date || '' }; };
    fu.addEventListener('input', upd); fu.addEventListener('change', upd);
    fu.onsubmit = (e) => { e.preventDefault(); upd(); if (w.unlock.unlockRule !== 'goal' && !w.unlock.unlockDate) return toast('Pick an unlock date.', true); w.step += 1; render(); window.scrollTo(0, 0); };
  }
  const ff = $('#seal-final');
  if (ff) ff.onsubmit = async (e) => {
    e.preventDefault();
    const typed = new FormData(ff).get('typed');
    const reseal = w.mode === 'reseal';
    const body = reseal ? { draftId: w.draft.id, typed, changedAtBank: !!w.checks.changedAtBank, confirmedLogin: !!w.checks.confirmedLogin, ...(w.wasOpen ? w.unlock : {}) }
      : { draftId: w.draft.id, typed, enteredAtBank: !!w.checks.enteredAtBank, confirmedLogin: !!w.checks.confirmedLogin, ...w.unlock };
    try {
      await api(reseal ? '/api/sealed-logins/reseal' : '/api/sealed-logins/seal', body);
      navigator.clipboard?.writeText('').catch(() => {});
      wipeSeal(); toast(reseal ? 'Resealed. The new password is sealed.' : 'Sealed. It stays sealed until the unlock condition is met.');
      if (ctx !== 'setup') location.hash = '#/seal';
      await refresh(); window.scrollTo(0, 0);
    } catch (err) { toast(err.message, true); }
  };
}
function wireSeal() {
  wireSealWizard('seal');
  document.querySelectorAll('form[data-unlock-form]').forEach((f) => { f.onsubmit = (e) => {
    e.preventDefault(); const id = f.dataset.unlockForm, r = S.sealedLogins.find((x) => x.id === id), d = new FormData(f);
    const unlockRule = d.get('both') === 'on' ? 'date_and_goal' : r.unlockRule;
    act(() => api('/api/sealed-logins/unlock', { id, unlockRule, unlockDate: d.get('unlockDate') || r.unlockDate || undefined }), 'Unlock updated (tighten only)');
  }; });
  document.querySelectorAll('form[data-label-form]').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); act(() => api('/api/sealed-logins/label', { id: f.dataset.labelForm, label: new FormData(f).get('label') }), 'Label saved'); }; });
}
function wireLostCard() {
  document.querySelectorAll('[data-lost]').forEach((el) => { el.onchange = () => act(() => api('/api/lost-card', { item: el.dataset.lost, done: el.checked })); });
}
function wireSetup() { wireSealWizard('setup'); wireLostCard(); }
async function loadSample() {
  const st0 = S;
  if (!st0.accounts.some((x) => x.mask === '4821')) await api('/api/link/exchange', { publicToken: 'mock-public-mock_goldcoast-5a3f1e01' });
  if (!st0.accounts.some((x) => x.mask === '9034')) await api('/api/link/exchange', { publicToken: 'mock-public-mock_harbor-7b2c9d02' });
  const st = await api('/api/state');
  const fund = st.accounts.find((x) => x.mask === '4821'), dest = st.accounts.find((x) => x.mask === '9034');
  if (!fund || !dest) throw new Error('Sample banks could not be linked. Link any two accounts on the Accounts screen instead.');
  await api('/api/accounts/roles', { fundingAccountId: fund.id, destinationAccountId: dest.id });
  if (st.goal?.status === 'saving' && !st.goal.lockedAt && !st.blind?.redacted) await api('/api/goal', { name: 'Mattress', targetCents: Math.max(300000, st.goal.targetCents || 0) });
  await api('/api/schedule', SAMPLE);
  await api('/api/benefit-ack', { accepted: true, version: st.benefitWarning.version });
  await api('/api/settings', { benefits: { receivesSSI: true } });
}

// ---------------- Monthly move + assistant sync ----------------
const MOVE_STATUS = { awaiting_approval: 'waiting for your approval', approved: 'approved: assistant will do it', in_progress: 'in progress', done: 'done', rejected: 'rejected', expired: 'expired', cancelled: 'cancelled' };
function viewMoves() {
  const mv = S.monthlyMoves || [], blind = !!S.blind?.redacted;
  const zero = blind ? 'zero' : '$0';
  return `<h1>Monthly move</h1>
  <div class="card small" data-testid="moves-explain"><strong>Three banks, one monthly move.</strong>
    <ol class="legs-help"><li><strong>Varo</strong>: your SSI lands here; spending money.</li><li><strong>Step</strong>: a bridge only. Its balance stays at ${zero}.</li><li><strong>Current</strong>: sealed, locked savings. Your assistant handles it on current.com (desktop web). You never open it.</li></ol>
    Each month your assistant asks to move money. You tap <strong>Approve</strong> in the Inbox. Then your assistant does three steps itself and records each one here:
    <ol class="legs-help"><li>Varo → Step (instant)</li><li>Step → Current (may take 1-3 business days, but it leaves Step right away)</li><li>Assistant confirms arrival in Current</li></ol>
    <strong>This app never moves that money.</strong></div>
  <div class="banner banner--warn" data-testid="step-zero-reminder"><span class="banner__icon">0</span><span class="banner__body"><strong>Step balance should be ${zero}</strong><br><span class="small">Step is only a bridge. After step 2 nothing should be left in Step. If something is, it should go on to Current.</span></span></div>
  ${S.pendingApprovals ? `<a class="btn btn--gold btn--block" href="#/inbox" data-testid="moves-inbox">Open Inbox (${S.pendingApprovals} waiting)</a>` : ''}
  <div class="section-title">Moves</div>
  <div data-testid="moves-list">${mv.length ? mv.map((m) => `<article class="card move move--${esc(m.status)}" data-testid="move-card">
    <div class="row-between"><span class="chip">Varo → Step → Current</span><span class="chip ${m.status === 'done' ? 'chip--ok' : ''}" data-testid="move-status">${esc(MOVE_STATUS[m.status] || m.status)}</span></div>
    <p data-mt><strong>${esc(m.summary)}</strong></p>
    <ol class="legs" data-testid="move-legs">${(m.legs || []).map((l, i) => `<li class="leg leg--${esc(l.status)} ${m.nextLeg === l.id ? 'leg--next' : ''}"><span class="leg__n">${l.status === 'done' ? '✓' : i + 1}</span><span><strong>${esc(l.label)}</strong>${l.status === 'done' ? `<br><span class="small ok">Confirmation <code>${esc(l.confirmation)}</code>${l.simulated ? ' (simulated)' : ''}</span>` : m.nextLeg === l.id ? '<br><span class="small gold">Next</span>' : ''}</span></li>`).join('')}</ol>
    ${m.stepBalanceZero === false ? `<p class="small warn" data-testid="step-not-zero">Step still shows a balance after step 2. It should be ${zero}: move the rest on to Current.</p>` : m.stepBalanceZero ? `<p class="small ok">Step balance back to ${zero}.</p>` : ''}
    <p class="small muted">${esc(pretty(m.date))} · asked by ${esc(m.requestedBy)}${m.decidedAt ? ` · decided ${esc(new Date(m.decidedAt).toLocaleString())}` : ''}</p>
    ${['approved', 'in_progress'].includes(m.status) ? `<button class="btn btn--sm" data-action="move-sim" data-id="${esc(m.id)}" data-testid="move-sim">Simulate completion (prototype)</button><p class="tiny muted">In real life your assistant does each step at the banks, then records the bank's confirmation here.</p>` : ''}
  </article>`).join('') : `<div class="card small muted">No monthly moves yet. ${S.simulation ? 'Try it: More → Bot → "Propose monthly move" (the simulated assistant asks), then approve it in the Inbox.' : 'Your assistant asks with POST /bot/v1/monthly-moves/propose.'}</div>`}</div>
  <p class="small muted">Prototype with fake data. Sandbox only: no real money moves.</p>`;
}

const SYNC_K = { code: 'ldb-sync-code', relay: 'ldb-sync-relay', last: 'ldb-sync-last' };
let syncShowCode = false;
const b64u = (buf) => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
function parseSyncCodeB(code) {
  const [p, channel, k] = String(code || '').trim().split('.');
  if (p !== 'ldbsync1' || !/^[A-Za-z0-9_-]{22}$/.test(channel || '') || !/^[A-Za-z0-9_-]{43}$/.test(k || '')) throw new Error('No valid sync code on this device. Create one first.');
  return { channel, key: unb64u(k) };
}
async function sealSyncB(obj, { channel, key }, slot) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`ldb-sync:v1:${channel}:${slot}`) }, k, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, alg: 'A256GCM', channel, slot, seq: Date.now(), at: new Date().toISOString(), iv: b64u(iv), ct: b64u(ct) };
}
async function openSyncB(env, { channel, key }, slot) {
  if (!env || env.v !== 1 || env.channel !== channel || env.slot !== slot) throw new Error('Assistant message is not for this sync code.');
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(env.iv), additionalData: new TextEncoder().encode(`ldb-sync:v1:${channel}:${slot}`) }, k, unb64u(env.ct)))); }
  catch { throw new Error('Could not decrypt the assistant\'s message (wrong sync code or changed data). Nothing was applied.'); }
}
const relayBase = () => (localStorage.getItem(SYNC_K.relay) || '').replace(/\/+$/, '').replace(/\/sync\/v1$/, '');
async function syncNow() {
  const code = parseSyncCodeB(localStorage.getItem(SYNC_K.code)); const base = relayBase();
  if (!base) throw new Error('Add a relay address first, or use "Download encrypted snapshot".');
  const push = async () => { const { snapshot } = await api('/api/sync/snapshot', {}); const env = await sealSyncB(snapshot, code, 'app');
    const r = await fetch(`${base}/sync/v1/${code.channel}/app`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) });
    if (!r.ok) throw new Error(`Relay refused the snapshot (HTTP ${r.status}).`); };
  await push();
  let applied = [];
  const g = await fetch(`${base}/sync/v1/${code.channel}/bot`, { cache: 'no-store' });
  if (g.ok) { const payload = await openSyncB(await g.json(), code, 'bot'); applied = (await api('/api/sync/inbox', payload)).results || []; }
  else if (g.status !== 404) throw new Error(`Relay error reading assistant messages (HTTP ${g.status}).`);
  if (applied.some((x) => x.status === 'applied')) await push(); // so the assistant sees the new pending approvals
  const last = { at: new Date().toISOString(), applied: applied.filter((x) => x.status === 'applied').length, refused: applied.filter((x) => ['refused', 'failed'].includes(x.status)).length };
  localStorage.setItem(SYNC_K.last, JSON.stringify(last));
  return last;
}
async function downloadSnapshot() {
  const code = parseSyncCodeB(localStorage.getItem(SYNC_K.code));
  const { snapshot } = await api('/api/sync/snapshot', {});
  const env = await sealSyncB(snapshot, code, 'app');
  const url = URL.createObjectURL(new Blob([JSON.stringify(env, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `lock-and-deploy-snapshot-${S.today}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function viewSync() {
  const code = localStorage.getItem(SYNC_K.code), last = (() => { try { return JSON.parse(localStorage.getItem(SYNC_K.last) || 'null'); } catch { return null; } })();
  const design = `<section class="card small" data-testid="sync-design"><h2>How your assistant reads this app</h2>
    <p><strong>Server version (recommended for real use):</strong> the app runs on a small server; your assistant reads it directly with a bot key (<code>GET /bot/v1/snapshot</code>). It can ask for things, but only you can approve them.</p>
    <p><strong>This phone demo (no server):</strong> your data lives only in this browser. To share it, the app makes a secret <strong>sync code</strong> you give your assistant once. "Sync now" locks a read-only snapshot (plan, approvals, your decisions, monthly moves; never passwords; amounts hidden while Go Blind is on) with that code (AES-256-GCM) and drops it at a small <strong>relay</strong>. The relay only ever sees scrambled data. Your assistant unlocks it with the code, and can leave requests the same way (for example this month's instant move). The app turns them into normal approvals in your Inbox.</p>
    <p class="muted">No relay yet? "Download encrypted snapshot" saves the same locked file for your assistant. Anyone with the sync code can read the snapshot, so treat it like a password.</p></section>`;
  if (!S.simulation) return `<h1>Assistant sync</h1>${design}<div class="card small">This is the server version: create a bot key on the <a href="#/bot">Bot</a> screen and your assistant reads <code>/bot/v1/snapshot</code> and <code>/bot/v1/monthly-moves</code>. No sync code needed.</div>`;
  return `<h1>Assistant sync</h1>${design}
  <section class="card" data-testid="sync-code-card"><h2>Sync code</h2>
    ${code ? `<p class="small ok">A sync code is saved on this device (ends in …${esc(code.slice(-4))}).</p>
      ${syncShowCode ? `<div class="copy-row"><div class="copy-row__main"><div class="secret" data-testid="sync-code">${esc(code)}</div></div><button class="btn btn--sm" data-action="copy" data-copy="${esc(code)}" data-secret="1" data-testid="copy-sync-code">Copy</button></div>` : ''}
      <div class="btn-row"><button class="btn btn--sm" data-action="sync-show" data-testid="sync-show">${syncShowCode ? 'Hide code' : 'Show code to give my assistant'}</button><button class="btn btn--sm btn--ghost" data-action="sync-forget" data-testid="sync-forget">Forget code</button></div>`
      : '<p class="small muted">None yet.</p><button class="btn btn--gold" data-action="sync-create" data-testid="sync-create">Create sync code</button>'}
  </section>
  <section class="card"><h2>Relay</h2>
    <form id="sync-relay-form" class="row-between"><input class="grow" name="relay" type="url" inputmode="url" placeholder="http://127.0.0.1:5190" value="${esc(relayBase())}" data-testid="sync-relay"><button class="btn btn--sm" data-testid="sync-relay-save">Save</button></form>
    <p class="tiny muted">The server prototype includes a relay (start it with SYNC_RELAY=on). It is not hosted for you; see docs/ASSISTANT_SYNC.md.</p>
  </section>
  <div class="btn-row"><button class="btn btn--gold" data-action="sync-now" data-testid="sync-now" ${code ? '' : 'disabled'}>Sync now</button><button class="btn" data-action="sync-download" data-testid="sync-download" ${code ? '' : 'disabled'}>Download encrypted snapshot</button></div>
  <p class="small muted" data-testid="sync-status">${last ? `Last sync ${esc(new Date(last.at).toLocaleString())}: ${last.applied} assistant request(s) applied${last.refused ? `, ${last.refused} refused` : ''}.` : 'Not synced yet.'}${S.sync?.lastPushAt ? ` Last snapshot ${esc(new Date(S.sync.lastPushAt).toLocaleString())}.` : ''}</p>`;
}
function wireSync() {
  const f = $('#sync-relay-form');
  if (f) f.onsubmit = (e) => { e.preventDefault(); const v = new FormData(f).get('relay').trim(); if (v && !/^https?:\/\//.test(v)) return toast('Relay address must start with https:// (or http:// for this computer).', true); localStorage.setItem(SYNC_K.relay, v); toast(v ? 'Relay saved' : 'Relay removed'); render(); };
}

// ---------------- Wiring ----------------
const views = { home: viewHome, accounts: viewAccounts, plan: viewPlan, authorize: viewAuthorize, transfers: viewTransfers, log: viewLog,
  vault: viewVault, rollover: viewRollover, inbox: viewInbox, bot: viewBot, settings: viewSettings, bank: viewBank, emergency: viewBank, more: viewMore,
  seal: viewSeal, setup: viewSetup, lostcard: () => viewLostCard('page'), cards: viewCards, moves: viewMoves, sync: viewSync };
const TAB_OF = { accounts: 'more', plan: 'more', authorize: 'more', rollover: 'vault', bot: 'more', settings: 'more', bank: 'more', emergency: 'more', log: 'more', seal: 'more', setup: 'more', lostcard: 'more', cards: 'home', moves: 'inbox', sync: 'more' };
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
  ({ plan: wirePlan, accounts: wireAccounts, authorize: wireAuthorize, rollover: wireRollover, vault: wireVault, inbox: wireInbox, bot: wireBot, settings: wireSettings, seal: wireSeal, setup: wireSetup, lostcard: wireLostCard, sync: wireSync })[r]?.();
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
  if (!sf) return;
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
  const f = $('#rollover-form'); if (!f || !f.mode) return;
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
  if (a === 'blind-on-open') openBlindOn();
  if (a === 'blind-off-open') openBlindOff();
  if (a === 'blind-add-stay') { if (confirm('Stay blind until the goal is reached? After this, Go Blind cannot be turned off at all until the vault unlocks, not even with the passcode.')) act(() => api('/api/blind/on', { confirm: true, stayUntilGoal: true }), 'Staying blind until the goal is reached.'); }
  if (a === 'simbot') { const r = await act(() => api('/api/demo/bot', { action: el.dataset.bot })); if (r) { simBotLast = r; render(); } }
  if (a === 'copy') copyText(el.dataset.copy, el.dataset.secret === '1');
  if (a === 'seal-start') { wipeSeal(); SEAL.mode = 'new'; render(); window.scrollTo(0, 0); }
  if (a === 'seal-cancel') { if (SEAL.draft) await api('/api/sealed-logins/draft/discard', {}).catch(() => {}); wipeSeal(); await refresh(); }
  if (a === 'seal-back') { SEAL.step = 1; SEAL.draft = null; SEAL.checks = {}; render(); window.scrollTo(0, 0); }
  if (a === 'seal-reveal') { const r = await act(() => api('/api/sealed-logins/reveal', { id: el.dataset.id })); if (r) { REVEALED[el.dataset.id] = r.values; render(); } }
  if (a === 'seal-reseal') { const r = S.sealedLogins.find((x) => x.id === el.dataset.id); wipeSeal(); Object.assign(SEAL, { mode: 'reseal', targetId: r.id, wasOpen: r.status === 'unlocked' }); SEAL.form.label = r.label; if (route() !== 'seal') location.hash = '#/seal'; else render(); window.scrollTo(0, 0); }
  if (a === 'seal-delete') { if (confirm('Delete this sealed login? (Refused while it is still sealed.)')) act(() => api('/api/sealed-logins/delete', { id: el.dataset.id, confirm: true }), 'Sealed login deleted'); }
  if (a === 'setup-lost-next') { SETUP_SKIP_LOST = true; render(); window.scrollTo(0, 0); }
  if (a === 'setup-sample') { el.disabled = true; await act(loadSample, 'Sample data loaded: $100/month, day after SSI'); }
  if (a === 'setup-authorize') {
    const name = $('#setup-signer').value.trim();
    if (!$('#setup-auth-box').checked) return toast('Tick the authorization box.', true);
    await act(async () => { const t = await api('/api/authorization/text', { signerName: name }); return api('/api/authorization', { accepted: true, textHash: t.textHash, signerName: name }); }, 'Authorized. Deposits are on and the goal is locked.');
  }
  if (a === 'raise') { if (confirm('Raise your automatic deposit? You will sign a new authorization next. This button can only raise it.')) { const r = await act(() => api('/api/schedule/raise', { multiplier: Number(el.dataset.mult) }), 'Deposit raised. Sign the new authorization.'); if (r) location.hash = '#/authorize'; } }
  if (a === 'cards-seen') await act(() => api('/api/cards/seen', {}));
  if (a === 'move-sim') await act(() => api('/api/monthly-moves/complete', { id: el.dataset.id }), 'All three steps recorded (simulated)');
  if (a === 'sync-create') { const c = `ldbsync1.${b64u(crypto.getRandomValues(new Uint8Array(16)))}.${b64u(crypto.getRandomValues(new Uint8Array(32)))}`; localStorage.setItem(SYNC_K.code, c); syncShowCode = true; render(); toast('Sync code created. Give it to your assistant once, like a password.'); }
  if (a === 'sync-show') { syncShowCode = !syncShowCode; render(); }
  if (a === 'sync-forget') { if (confirm('Forget the sync code on this device? Your assistant will no longer be able to read new snapshots.')) { localStorage.removeItem(SYNC_K.code); localStorage.removeItem(SYNC_K.last); syncShowCode = false; render(); } }
  if (a === 'sync-now') { el.disabled = true; const r = await act(syncNow); if (r) toast(`Synced. ${r.applied} assistant request(s) applied${r.refused ? `, ${r.refused} refused` : ''}.`); el.disabled = false; }
  if (a === 'sync-download') await act(downloadSnapshot, 'Encrypted snapshot downloaded');
  if (a === 'demo-wipe') { if (confirm('Erase all demo data in this browser and start over?')) { const r = await act(() => api('/api/demo/wipe', {}), 'Demo reset'); if (r) Object.values(SYNC_K).forEach((k) => localStorage.removeItem(k)); location.hash = '#/'; } }
});
// Fresh state on every screen change, so requests the bot made in the meantime show up.
window.addEventListener('hashchange', () => { if (route() !== 'vault') shownCode = null; if (route() !== 'sync') syncShowCode = false; if (route() !== 'bot') shownKey = null; if (!['seal', 'setup'].includes(route())) wipeSeal(); else REVEALED = {}; refresh().catch(() => render()); });
// Light poll for new bot requests: only updates the Inbox badge, never re-renders under your fingers.
setInterval(async () => {
  if (document.hidden || !S) return;
  try { const n = await api('/api/state'); const b = $('#inbox-badge'); b.hidden = !n.pendingApprovals; b.textContent = n.pendingApprovals || ''; } catch { /* locked or offline */ }
}, 20000);
refresh().catch((e) => { app.innerHTML = `<div class="card bad">${esc(e.message)}</div>`; });
