// User API route table (everything except passcode auth), shared by the Node server (server/app.js) and the
// browser-only demo (demo/src/browser-server.js), so both run exactly the same service calls and lock rules.
// Handlers get { req, res, body }; `req` needs only socket.remoteAddress and headers['user-agent'].
import { AppError } from './service.js';
import { evaluateGates } from './golive.js';
import { verifyAudit } from './audit.js';
import { buildSnapshot } from './bot.js';
import { applyInbox } from './sync-inbox.js';

export function createRoutes({ store, service, config }) {
  const needMock = () => { if (service.provider.id !== 'mock') throw new AppError(400, 'unsupported', 'Mock provider only'); };
  const routes = {
    'GET /api/state': async () => service.view(),
    'POST /api/link/token': async ({ body }) => service.createLinkToken(body.role),
    'POST /api/link/sandbox-public-token': async () => {
      if (typeof service.provider.sandboxPublicToken !== 'function') throw new AppError(400, 'unsupported', 'Only for plaid-sandbox');
      return { publicToken: await service.provider.sandboxPublicToken() };
    },
    'POST /api/link/exchange': async ({ body }) => service.exchangePublicToken({ publicToken: body.publicToken, metadata: body.metadata }),
    'POST /api/items/unlink': async ({ body }) => service.unlinkItem(body.itemId),
    'POST /api/accounts/roles': async ({ body }) => service.assignRoles(body),
    'POST /api/goal': async ({ body }) => service.setGoal(body),
    'POST /api/schedule': async ({ body }) => service.setSchedule(body),
    'POST /api/schedule/preview': async ({ body }) => service.preview(body),
    'POST /api/authorization/text': async ({ body }) => service.authorizationText(body.signerName),
    'POST /api/benefit-ack': async ({ body }) => service.acknowledgeBenefit(body),
    'POST /api/authorization': async ({ body, req }) => service.authorize({ ...body, ip: req.socket.remoteAddress, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) }),
    'POST /api/authorization/revoke': async () => service.revokeAuthorization(),
    'POST /api/schedule/pause': async () => service.pause('user'),
    'POST /api/schedule/resume': async () => service.resume(),
    'POST /api/schedule/cancel': async ({ body }) => { if (body.confirm !== true) throw new AppError(400, 'confirm_required', 'Confirm cancelling the schedule.'); return service.cancelSchedule(); },
    'POST /api/scheduler/run': async () => { await service.tickAll(); return service.view(); },
    'POST /api/transfers/cancel': async ({ body }) => service.cancelTransfer(body.pullId),
    // vault / rollover / hardship
    'POST /api/vault/reveal-code': async () => service.revealUnlockCode(),
    'POST /api/vault/regenerate-code': async ({ body }) => { if (body.confirm !== true) throw new AppError(400, 'confirm_required', 'Confirm replacing the code.'); return service.regenerateUnlockCode(); },
    'POST /api/vault/withdraw': async ({ body }) => service.withdraw(body),
    'POST /api/rollover/preview': async ({ body }) => service.rolloverPreview(body),
    'POST /api/rollover/execute': async ({ body }) => service.rolloverExecute(body),
    'POST /api/hardship/request': async ({ body }) => service.requestHardship(body),
    'POST /api/hardship/cancel': async () => service.cancelHardship(),
    'POST /api/hardship/complete': async ({ body }) => service.completeHardship(body),
    // emergency stop (pause + revoke bot keys; never unlocks)
    'POST /api/emergency/stop': async ({ body }) => service.emergencyStop(body),
    // settings, bot keys, approvals, notifications
    'GET /api/settings': async () => ({ settings: service.settings, overrides: store.state.settings }),
    'POST /api/settings': async ({ body }) => {
      if (Object.keys(body || {}).some((k) => k === 'mock' || k.startsWith('mock.'))) service.sealed.guardShortcut('mock_balance');
      return service.updateSettings(body);
    },
    'POST /api/bot-keys': async ({ body }) => service.createBotKey(body),
    'POST /api/bot-keys/revoke': async ({ body }) => service.revokeBotKey(body.id),
    'GET /api/approvals': async () => ({ approvals: store.state.approvals }),
    'POST /api/approvals/approve': async ({ body }) => service.approve(body.id, body),
    'POST /api/approvals/reject': async ({ body }) => service.reject(body.id),
    'POST /api/notifications/dismiss': async ({ body }) => { const n = store.state.notifications.find((x) => x.id === body.id); if (n) n.dismissedAt = new Date().toISOString(); return { ok: true }; },
    'GET /api/golive': async () => ({ realMoneyEnabled: false, gates: evaluateGates(store.state) }),
    'GET /api/audit/verify': async () => verifyAudit(store.state.audit),
    // sandbox tools
    'POST /api/sandbox/simulate': async ({ body }) => { service.sealed.guardShortcut('simulate'); return service.simulate(body.pullId, body.event, body.returnCode); },
    'POST /api/sandbox/clock/advance': async ({ body }) => { if (!config.demoClock) throw new AppError(403, 'disabled', 'Demo clock disabled'); service.sealed.guardShortcut('demo_clock'); await service.advanceClock(body.days); return service.view(); },
    'POST /api/sandbox/mock-balance': async ({ body }) => { needMock(); service.sealed.guardShortcut('mock_balance'); return service.updateSettings({ 'mock.fundingBalanceCents': body.cents }); },
    'POST /api/sandbox/reset': async () => {
      if (service.blind.on) throw new AppError(423, 'blind_on', 'Turn off Go Blind first. A reset would otherwise remove it without the passcode.');
      service.sealed.guardWipe('sandbox_reset');
      const keep = { userAuth: store.state.userAuth, sessions: store.state.sessions };
      store.reset(); Object.assign(store.state, keep); service.bootstrap(); service.audit('sandbox_reset', {}, 'user'); return service.view();
    },
    // Go Blind (hide all amounts). On: one tap + confirm. Off: passcode, rate-limited; impossible while "stay blind until goal" holds.
    'GET /api/blind': async () => service.blindView(),
    'POST /api/blind/on': async ({ body }) => service.blindOn(body, { by: 'user' }),
    'POST /api/blind/off': async ({ body }) => service.blindOff(body),
    'POST /api/real-transfers/activate': async ({ body }) => service.activateRealTransfers(body),
    // Seal my login (server/sealed.js). Reveal only after the unlock condition; no passcode, override or bot path.
    'GET /api/sealed-logins': async () => service.sealed.overview(),
    'GET /api/sealed-logins/draft': async () => service.sealed.getDraft(),
    'POST /api/sealed-logins/draft': async ({ body }) => service.sealed.createDraft(body),
    'POST /api/sealed-logins/draft/discard': async () => service.sealed.discardDraft(),
    'POST /api/sealed-logins/seal': async ({ body }) => service.sealed.seal(body),
    'POST /api/sealed-logins/reseal/draft': async ({ body }) => service.sealed.createResealDraft(body),
    'POST /api/sealed-logins/reseal': async ({ body }) => service.sealed.reseal(body),
    'POST /api/sealed-logins/label': async ({ body }) => service.sealed.updateLabel(body),
    'POST /api/sealed-logins/unlock': async ({ body }) => service.sealed.updateUnlock(body),
    'POST /api/sealed-logins/reveal': async ({ body }) => service.sealed.reveal(body, { by: 'user' }),
    'POST /api/sealed-logins/delete': async ({ body }) => service.sealed.delete(body),
    'POST /api/lost-card': async ({ body }) => service.sealed.setLostCardStep(body),
    // Did you know? cards + speed-up (raise-only deposit change; needs a new ACH authorization)
    'GET /api/cards': async () => service.cardsView(service.blindRedactUser()),
    'POST /api/cards/seen': async () => service.markCardsSeen(),
    'POST /api/schedule/raise': async ({ body }) => service.raiseDeposit(body),
    // Monthly move (Varo -> Step instant -> Current): the bot asks, you approve in the Inbox, the assistant does the steps and records them.
    'GET /api/monthly-moves': async () => ({ monthlyMoves: service.moves.list.map((m) => service.moves.view(m)) }),
    'POST /api/monthly-moves/complete': async ({ body }) => service.moves.complete({ id: body.id, confirmation: body.confirmation, simulate: true }, 'user (simulated)'),
    // Assistant sync (static demo): the app gets the snapshot here, encrypts it in the browser and pushes it to the relay;
    // the assistant's decrypted messages come back through /api/sync/inbox (only safe types; proposals need your approval).
    'POST /api/sync/snapshot': async () => { service.s.sync.lastPushAt = new Date().toISOString(); return { snapshot: buildSnapshot(service) }; },
    'POST /api/sync/inbox': async ({ body }) => applyInbox(service, body),
  };
  // These return login values (the draft before sealing, the reveal after unlock). They contain no amounts, and
  // Go Blind's money-text scrubber must not mangle a password such as "Ab12.50xy", so they skip redaction.
  const NO_REDACT = new Set(['GET /api/sealed-logins/draft', 'POST /api/sealed-logins/draft', 'POST /api/sealed-logins/reseal/draft', 'POST /api/sealed-logins/reveal']);
  // Go Blind: every response is redacted on the way out, and error messages too, so amounts never reach the UI.
  for (const [name, fn] of Object.entries(routes)) {
    routes[name] = async (ctx) => {
      try { const out = await fn(ctx); return NO_REDACT.has(name) ? out : service.redactForUser(out); } catch (e) { if (e && typeof e.message === 'string') e.message = service.redactErrorText(e.message); throw e; }
    };
  }
  return routes;
}
