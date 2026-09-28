#!/usr/bin/env node
// Lock & Deploy bot CLI: lets an AI assistant on this machine operate the Bot API by shell.
// Needs LDB_BOT_KEY (created by the user in the app: More > Bot > New key; shown once). Optional LDB_URL.
//
//   node bot-cli.js status
//   node bot-cli.js goals
//   node bot-cli.js transfers
//   node bot-cli.js schedule
//   node bot-cli.js approvals
//   node bot-cli.js activity
//   node bot-cli.js propose-goal --target 3500 [--name "Mattress"] [--release 2027-12-31] [--milestones 1000,2000] [--reason "..."]
//   node bot-cli.js prepare-rollover --withdraw 1000 --new-target 4000 [--mode partial|full|raise] [--full-action close|restart]
//   node bot-cli.js pause
//   node bot-cli.js blind-on          (turn Go Blind ON; bots can never turn it off)
//   node bot-cli.js request <type> [--amount 50] [--json '{"...":...}'] [--reason "..."]
//   node bot-cli.js snapshot          (everything in one read: status, approvals, decisions, monthly moves)
//   node bot-cli.js sealed-logins     (label / status only)      node bot-cli.js reveal-sealed   (always refused, logged)
//   node bot-cli.js cards             node bot-cli.js speed-up --multiplier 2|3 [--reason "..."]
//   node bot-cli.js monthly-moves
//   node bot-cli.js propose-move [--amount 100] [--date 2026-10-02] [--reason "..."]   (Varo -> Step instant -> Current)
//   node bot-cli.js complete-move --id mv_... --confirmation "ABC123" [--leg varo_to_step|step_to_current|arrival_confirmed] [--step-balance 0]
//        (one step at a time, in order, only after the user approved it AND you did that step)
//
// Static phone demo (no server): encrypted sync through a relay. Needs the user's sync code (LDB_SYNC_CODE or --code)
// and the relay (LDB_SYNC_RELAY or --relay). No bot key needed.
//   node bot-cli.js sync-code                                  (make a code, for testing)
//   node bot-cli.js sync-read                                  (decrypt the app's latest snapshot)
//   node bot-cli.js sync-decrypt --file snapshot.json          (decrypt a downloaded snapshot)
//   node bot-cli.js sync-send propose_monthly_move [--amount 100] [--date 2026-10-02] [--reason "..."]
//   node bot-cli.js sync-send complete_monthly_move --move-id mv_... --confirmation "ABC123" [--leg ...] [--step-balance 0]
//   node bot-cli.js sync-send propose_speed_up --multiplier 2      node bot-cli.js sync-send pause
//
// Dollar flags are dollars (converted to cents). Output is JSON. Exit code 0 on 2xx, 1 otherwise.
const BASE = (process.env.LDB_URL || 'http://127.0.0.1:5180').replace(/\/$/, '');
const KEY = process.env.LDB_BOT_KEY || '';
const [cmd, ...rest] = process.argv.slice(2);

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; out[k] = v; } else out._.push(args[i]);
  }
  return out;
}
const cents = (d) => (d === undefined ? undefined : Math.round(Number(d) * 100));
const usage = () => { console.error('Usage: node bot-cli.js status|snapshot|goals|transfers|schedule|approvals|activity|cards|sealed-logins|monthly-moves|propose-goal|prepare-rollover|pause|blind-on|speed-up|propose-move|complete-move|request <type>|sync-code|sync-read|sync-decrypt|sync-send <type>\nSee the header of bot-cli.js for flags.'); process.exit(2); };

async function syncCmd(c, o) {
  const { newSyncCode, parseSyncCode, sealSync, openSync } = await import('./server/sync.js');
  if (c === 'sync-code') return console.log(newSyncCode());
  const code = parseSyncCode(o.code || process.env.LDB_SYNC_CODE);
  const relay = String(o.relay || process.env.LDB_SYNC_RELAY || '').replace(/\/+$/, '').replace(/\/sync\/v1$/, '');
  const fs = await import('node:fs');
  if (c === 'sync-decrypt') return console.log(JSON.stringify(openSync(JSON.parse(fs.readFileSync(o.file, 'utf8')), code, 'app'), null, 2));
  if (!relay) { console.error('Set LDB_SYNC_RELAY or --relay (e.g. http://127.0.0.1:5190).'); process.exit(2); }
  const url = (slot) => `${relay}/sync/v1/${code.channel}/${slot}`;
  if (c === 'sync-read') {
    const r = await fetch(url('app'), { cache: 'no-store' });
    if (!r.ok) { console.error(`No snapshot yet (HTTP ${r.status}). Ask the user to tap Sync now.`); process.exit(1); }
    return console.log(JSON.stringify(openSync(await r.json(), code, 'app'), null, 2));
  }
  if (c === 'sync-send') {
    const type = o._[0]; if (!type) usage();
    const prev = await fetch(url('bot'), { cache: 'no-store' });
    const box = prev.ok ? openSync(await prev.json(), code, 'bot') : { messages: [] };
    const { randomBytes } = await import('node:crypto');
    const msg = JSON.parse(JSON.stringify({ id: `m_${randomBytes(8).toString('hex')}`, type, at: new Date().toISOString(), amountCents: cents(o.amount), date: o.date, from: o.from, to: o.to,
      moveId: o['move-id'], leg: o.leg, stepBalanceCents: cents(o['step-balance']), via: o.via, confirmation: o.confirmation, multiplier: o.multiplier ? Number(o.multiplier) : undefined, reason: o.reason }));
    box.messages = [...(box.messages || []).slice(-19), msg];
    const r = await fetch(url('bot'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealSync(box, code, 'bot')) });
    console.log(JSON.stringify({ httpStatus: r.status, queued: msg, note: 'The app applies it the next time the user taps Sync now. Proposals still need the user\'s approval.' }, null, 2));
    return process.exit(r.ok ? 0 : 1);
  }
  usage();
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ httpStatus: res.status, ...data }, null, 2));
  process.exit(res.ok ? 0 : 1);
}

if (!cmd || cmd === 'help' || cmd === '--help') usage();
if (cmd.startsWith('sync-')) { await syncCmd(cmd, flags(rest)); process.exit(0); }
if (!KEY) { console.error('Set LDB_BOT_KEY (create one in the app: More > Bot > New key).'); process.exit(2); }
const f = flags(rest);
const reads = { snapshot: '/bot/v1/snapshot', 'sealed-logins': '/bot/v1/sealed-logins', cards: '/bot/v1/cards', 'monthly-moves': '/bot/v1/monthly-moves', status: '/bot/v1/status', goals: '/bot/v1/goals', transfers: '/bot/v1/transfers', schedule: '/bot/v1/schedule', approvals: '/bot/v1/approvals', activity: '/bot/v1/activity' };
if (reads[cmd]) await call('GET', reads[cmd]);
else if (cmd === 'propose-goal') {
  const body = { targetCents: cents(f.target), name: f.name, releaseDate: f.release, milestonesCents: f.milestones ? String(f.milestones).split(',').map((x) => cents(x)) : undefined, reason: f.reason };
  await call('POST', '/bot/v1/goals/propose', JSON.parse(JSON.stringify(body)));
} else if (cmd === 'prepare-rollover') {
  const body = { mode: f.mode || (f.withdraw && Number(f.withdraw) > 0 ? 'partial' : 'raise'), withdrawCents: cents(f.withdraw || 0), newTargetCents: cents(f['new-target']), fullAction: f['full-action'] };
  await call('POST', '/bot/v1/rollovers/prepare', JSON.parse(JSON.stringify(body)));
} else if (cmd === 'pause') await call('POST', '/bot/v1/schedule/pause', {});
else if (cmd === 'blind-on') await call('POST', '/bot/v1/blind/on', {});
else if (cmd === 'reveal-sealed') await call('POST', '/bot/v1/sealed-logins/reveal', {});
else if (cmd === 'speed-up') await call('POST', '/bot/v1/speed-up/propose', { multiplier: Number(f.multiplier || 2), reason: f.reason });
else if (cmd === 'propose-move') await call('POST', '/bot/v1/monthly-moves/propose', JSON.parse(JSON.stringify({ amountCents: cents(f.amount), date: f.date, from: f.from, via: f.via, to: f.to, reason: f.reason })));
else if (cmd === 'complete-move') await call('POST', '/bot/v1/monthly-moves/complete', JSON.parse(JSON.stringify({ id: f.id, leg: f.leg, confirmation: f.confirmation, stepBalanceCents: cents(f['step-balance']) })));
else if (cmd === 'request') {
  const type = f._[0]; if (!type) usage();
  const payload = f.json ? JSON.parse(f.json) : f.amount ? { amountCents: cents(f.amount) } : {};
  await call('POST', '/bot/v1/requests', { type, payload, reason: f.reason });
} else usage();
