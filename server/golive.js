// Go-live gate. Real money needs ALL of these; the code evaluates every one as unmet in this prototype, and
// REAL_MONEY_ENABLED is a hard-coded false on top. Meeting a gate is a human/legal process, not a setting:
// there is intentionally no API that marks a gate as met.
export const GATES = [
  { id: 'provider_approval', label: 'Written production approval from a money-movement provider for this exact use case (personal transfers between the owner\'s own accounts)', why: 'Plaid Transfer excludes transfers between two accounts held by the same person; Dwolla/Moov/Increase/Column require a business, KYB and a contract.' },
  { id: 'security_review', label: 'Independent security review (auth, secrets, bot API, token encryption, hosting)', why: 'Not performed. Prototype runs on localhost with a local passcode.' },
  { id: 'authorization_records', label: 'ACH authorization records retained per Nacha rules (2 years after revocation) with a provider-approved authorization flow', why: 'Records exist in local JSON only; no retention/backup policy or provider sign-off.' },
  { id: 'account_recovery_untouched', label: 'Verified that neither app nor bot can reach bank login, password reset or account recovery', why: 'True by design (token-only linking), but must be re-verified by the security review against the production provider.' },
  { id: 'ssi_able_review', label: 'SSI/Medicaid resource-limit review with SSA or a benefits counselor (ABLE account considered)', why: 'A $3,000 balance exceeds the SSI $2,000 individual resource limit.' },
  { id: 'real_money_code_flag', label: 'REAL_MONEY_ENABLED changed in code after all gates above (code change + review, never an env var)', why: 'REAL_MONEY_ENABLED is hard-coded false.' },
];

/** Every gate is unmet. `state` is accepted so future checks can inspect records, but nothing here can pass. */
export function evaluateGates(_state) {
  return GATES.map((g) => ({ ...g, met: false }));
}
export const unmetGates = (state) => evaluateGates(state).filter((g) => !g.met);
