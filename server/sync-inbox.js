// Assistant -> app messages for the static demo's sync (see server/sync.js for the design). No Node-only imports here:
// this file is shared with the browser demo. Only these message types are accepted; proposals become normal pending
// approvals (nothing runs until the user taps Approve); everything else is refused and logged.
import { proposeSpeedUp } from './bot.js';

export const INBOX_TYPES = ['propose_monthly_move', 'complete_monthly_move', 'propose_speed_up', 'pause'];
const SYNC_KEY = { id: 'sync', name: 'Assistant (sync)' };
export function applyInbox(service, payload) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages.slice(0, 50) : [];
  const seen = service.s.sync.seen, results = [];
  const prev = service.actor; service.actor = 'bot:sync';
  try {
    for (const m of msgs) {
      const id = String(m?.id || '').slice(0, 64);
      if (!id || seen.includes(id)) { results.push({ id, status: 'skipped', reason: id ? 'already_applied' : 'no_id' }); continue; }
      seen.push(id); if (seen.length > 500) seen.splice(0, seen.length - 500);
      const type = String(m.type || '');
      try {
        if (!INBOX_TYPES.includes(type)) { service.audit('sync_message_refused', { id, type: type.slice(0, 40) }); results.push({ id, status: 'refused', reason: 'type_not_allowed' }); continue; }
        let out;
        if (type === 'propose_monthly_move') out = { approvalId: service.moves.propose({ amountCents: m.amountCents, date: m.date, from: m.from, via: m.via, to: m.to, reason: m.reason }, SYNC_KEY).approval.id };
        if (type === 'complete_monthly_move') out = { move: service.moves.complete({ id: m.moveId, leg: m.leg, confirmation: m.confirmation, stepBalanceCents: m.stepBalanceCents }, 'bot:sync').move.status };
        if (type === 'propose_speed_up') out = { approvalId: proposeSpeedUp(service, { multiplier: m.multiplier, reason: m.reason }, SYNC_KEY).id };
        if (type === 'pause') out = { schedule: service.pause('bot').status };
        service.audit('sync_message_applied', { id, type });
        results.push({ id, status: 'applied', ...out });
      } catch (e) { service.audit('sync_message_failed', { id, type, error: e.code || 'error' }); results.push({ id, status: 'failed', error: e.code || 'error', message: e.message }); }
    }
  } finally { service.actor = prev; }
  service.s.sync.lastPullAt = new Date().toISOString();
  return { results };
}

