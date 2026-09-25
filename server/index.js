// Entry point. Loads .env, runs the production guard, then starts the local server.
import { buildConfig, loadDotEnv, ProductionGuardError } from './config.js';
import { PlaidNotConfiguredError } from './providers/plaidSandbox.js';
import { createApp } from './app.js';

const env = { ...loadDotEnv(), ...process.env };

try {
  const config = buildConfig(env); // throws ProductionGuardError on any production-looking config
  const app = await createApp(config);
  app.server.listen(config.port, config.host, () => {
    console.log(`Lock & Deploy bank prototype: http://${config.host}:${config.port}`);
    console.log(`Provider: ${config.provider} (sandbox only). Real money: DISABLED.`);
    if (!config.loopbackOnly) console.warn('WARNING: listening beyond localhost. This prototype has no login; keep it on a trusted network.');
  });
  app.startScheduler();
  const shutdown = () => app.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
} catch (err) {
  if (err instanceof ProductionGuardError || err instanceof PlaidNotConfiguredError) {
    console.error(`\nRefusing to start.\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
