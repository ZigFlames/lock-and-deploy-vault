// One unattended pass of the savings engine: sync statuses, create due deposits, check milestones.
//   npm run tick                      -> run once for "today" (SIM_DATE + demo offset, or the real date)
//   npm run tick -- --advance 30      -> advance the sandbox demo clock 30 days, one tick per day
// Safe to run from cron/systemd alongside the server: both take DATA_DIR/db.lock, and every deposit has a
// per-schedule+period idempotency key, so concurrent or repeated runs never create duplicates.
import { buildConfig, loadDotEnv, ProductionGuardError } from '../server/config.js';
import { createApp } from '../server/app.js';

const args = process.argv.slice(2);
const i = args.indexOf('--advance');
const advanceDays = i >= 0 ? Math.max(1, Number(args[i + 1]) || 1) : 0;
try {
  const config = buildConfig({ ...loadDotEnv(), ...process.env });
  if (advanceDays && !config.demoClock) throw new Error('--advance needs DEMO_CLOCK=1 (sandbox demo clock)');
  const app = await createApp(config, { log: { log: (...a) => console.error(...a), warn: (...a) => console.error(...a), error: (...a) => console.error(...a) } });
  const out = await app.tick({ advanceDays });
  console.log(JSON.stringify({ ok: true, pid: process.pid, ...out }));
} catch (err) {
  if (err instanceof ProductionGuardError) { console.error(`Refusing to run.\n${err.message}`); process.exit(1); }
  console.error(err.message); process.exit(1);
}
