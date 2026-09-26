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
const usage = () => { console.error('Usage: node bot-cli.js status|goals|transfers|schedule|approvals|activity|propose-goal|prepare-rollover|pause|blind-on|request <type>\nSee the header of bot-cli.js for flags.'); process.exit(2); };

async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ httpStatus: res.status, ...data }, null, 2));
  process.exit(res.ok ? 0 : 1);
}

if (!cmd || cmd === 'help' || cmd === '--help') usage();
if (!KEY) { console.error('Set LDB_BOT_KEY (create one in the app: More > Bot > New key).'); process.exit(2); }
const f = flags(rest);
const reads = { status: '/bot/v1/status', goals: '/bot/v1/goals', transfers: '/bot/v1/transfers', schedule: '/bot/v1/schedule', approvals: '/bot/v1/approvals', activity: '/bot/v1/activity' };
if (reads[cmd]) await call('GET', reads[cmd]);
else if (cmd === 'propose-goal') {
  const body = { targetCents: cents(f.target), name: f.name, releaseDate: f.release, milestonesCents: f.milestones ? String(f.milestones).split(',').map((x) => cents(x)) : undefined, reason: f.reason };
  await call('POST', '/bot/v1/goals/propose', JSON.parse(JSON.stringify(body)));
} else if (cmd === 'prepare-rollover') {
  const body = { mode: f.mode || (f.withdraw && Number(f.withdraw) > 0 ? 'partial' : 'raise'), withdrawCents: cents(f.withdraw || 0), newTargetCents: cents(f['new-target']), fullAction: f['full-action'] };
  await call('POST', '/bot/v1/rollovers/prepare', JSON.parse(JSON.stringify(body)));
} else if (cmd === 'pause') await call('POST', '/bot/v1/schedule/pause', {});
else if (cmd === 'blind-on') await call('POST', '/bot/v1/blind/on', {});
else if (cmd === 'request') {
  const type = f._[0]; if (!type) usage();
  const payload = f.json ? JSON.parse(f.json) : f.amount ? { amountCents: cents(f.amount) } : {};
  await call('POST', '/bot/v1/requests', { type, payload, reason: f.reason });
} else usage();
