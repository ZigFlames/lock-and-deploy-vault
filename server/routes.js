// User API route table (everything except passcode auth), shared by the Node server (server/app.js) and the
// browser-only demo (demo/src/browser-server.js), so both run exactly the same service calls and lock rules.
// Handlers get { req, res, body }; `req` needs only socket.remoteAddress and headers['user-agent'].
import { AppError } from './service.js';
import { evaluateGates } from './golive.js';
import { verifyAudit } from './audit.js';

export function createRoutes({ store, service, config }) {
  const needMock = () => { if (service.provider.id !== 'mock') throw new AppError(400, 'unsupported', 'Mock provider only'); };
  return {
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
    'POST /api/settings': async ({ body }) => service.updateSettings(body),
    'POST /api/bot-keys': async ({ body }) => service.createBotKey(body),
    'POST /api/bot-keys/revoke': async ({ body }) => service.revokeBotKey(body.id),
    'GET /api/approvals': async () => ({ approvals: store.state.approvals }),
    'POST /api/approvals/approve': async ({ body }) => service.approve(body.id, body),
    'POST /api/approvals/reject': async ({ body }) => service.reject(body.id),
    'POST /api/notifications/dismiss': async ({ body }) => { const n = store.state.notifications.find((x) => x.id === body.id); if (n) n.dismissedAt = new Date().toISOString(); return { ok: true }; },
    'GET /api/golive': async () => ({ realMoneyEnabled: false, gates: evaluateGates(store.state) }),
    'GET /api/audit/verify': async () => verifyAudit(store.state.audit),
    // sandbox tools
    'POST /api/sandbox/simulate': async ({ body }) => service.simulate(body.pullId, body.event, body.returnCode),
    'POST /api/sandbox/clock/advance': async ({ body }) => { if (!config.demoClock) throw new AppError(403, 'disabled', 'Demo clock disabled'); await service.advanceClock(body.days); return service.view(); },
    'POST /api/sandbox/mock-balance': async ({ body }) => { needMock(); return service.updateSettings({ 'mock.fundingBalanceCents': body.cents }); },
    'POST /api/sandbox/reset': async () => {
      const keep = { userAuth: store.state.userAuth, sessions: store.state.sessions };
      store.reset(); Object.assign(store.state, keep); service.bootstrap(); service.audit('sandbox_reset', {}, 'user'); return service.view();
    },
    'POST /api/real-transfers/activate': async ({ body }) => service.activateRealTransfers(body),
  };
}
