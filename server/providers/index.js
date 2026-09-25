// Provider registry. A provider is a BankProvider subclass (see BankProvider.js) with `sandbox === true`.
// To add one: registerProvider('my-sandbox', async (ctx) => new MySandboxProvider(ctx)) and add the name to the
// allow-list in server/config.js (assertSandboxOnly) in a reviewed commit. Non-sandbox providers are refused below.
import { MockProvider } from './mock.js';
import { PlaidSandboxProvider } from './plaidSandbox.js';

const registry = new Map();
export function registerProvider(name, factory) { registry.set(name, factory); }
export function listProviders() { return [...registry.keys()]; }

registerProvider('mock', async ({ store, today, fundingBalanceCents }) => new MockProvider({ store, today, fundingBalanceCents }));
registerProvider('plaid-sandbox', async ({ config, store, plaidClient }) => PlaidSandboxProvider.create({ config, store, client: plaidClient }));

export async function createProvider(ctx) {
  const factory = registry.get(ctx.config.provider);
  if (!factory) throw new Error(`Unknown provider ${ctx.config.provider}`);
  const p = await factory(ctx);
  if (p.sandbox !== true) throw new Error('[production-guard] provider is not sandbox');
  return p;
}
