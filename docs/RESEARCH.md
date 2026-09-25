# Research: linking bank accounts + moving money by ACH for a personal savings-lock app

Checked **September 25, 2026** against official docs/terms (URLs inline). Not legal, tax, or financial advice. Where something could not be confirmed, it says so.

**The use case:** one person (Lance) wants to link **two of his own** bank accounts, pull money on a schedule from the funding account, deposit it into his savings account, and treat it as locked until a release date. He is not a business and is not offering this to anyone else.

---

## TL;DR

1. **Linking accounts (read-only)** is easy and cheap for an individual developer. Plaid's Sandbox is free with no approval, and its new **Trial plan** is free for up to 10 real Items (Auth, Balance, Transactions and more). Teller's development environment is free for 100 real enrollments.
2. **Moving money through an API for personal use** is the blocker. Every ACH money-movement API I checked is contracted to **businesses**, and the two most obvious ones rule this use out explicitly:
   - **Plaid Transfer:** "does not support peer to peer transfers or transfers between two accounts held by the same person." It is also Custom-plan only, with a 12-month minimum and a business application.
   - **Stripe:** the Services Agreement bans using the Services "for personal, family, or household purposes." Payments may only be used for "bona fide commercial transactions … with Customers."
3. **Recommendation:** build in Plaid Sandbox (done: `plaid-sandbox` adapter, with the offline `mock` as the default). For **real** money, the realistic path today is the bank's own scheduled transfer, into an account that is hard to spend from (a CD, a separate bank with no debit card, or an ABLE account because of SSI). The app then acts as the planner and tracker. A free Plaid Trial plan could later show real balances read-only, with no money movement. Fees and eligibility for every live-ACH option are in [Provider for live ACH](#provider-for-live-ach-cheapest-legitimate-path-checked-september-25-2026) at the end.

---

## Plaid

| | |
|---|---|
| **Link** | Client-side widget. The user signs in to the bank inside Link, and the app gets a `public_token` that it exchanges server-side for an `access_token`. The app never sees credentials. https://plaid.com/docs/transfer/creating-transfers/ |
| **Auth** | Returns verified account + routing numbers (sometimes tokenized) so you can move money with *your own* processor. Billed once per Item. https://support.plaid.com/hc/en-us/articles/16149566477591-How-is-Plaid-Auth-billed |
| **Transfer** | Plaid's own ACH/RTP/FedNow money movement. The model is a consumer account ↔ **your business checking account** through a *Plaid Ledger*: debits flow into the Ledger, and credits pay out from it. https://plaid.com/docs/transfer/creating-transfers/ |
| **Same-person transfers** | **Not supported:** "Plaid Transfer does not support peer to peer transfers or transfers between two accounts held by the same person. For these use cases, see Auth." (same page, "Peer-to-peer transfers") |
| **Who can get Transfer** | You need a Production Request, the Transfer Application, and Transfer document collection. The application collects "Business entity and individual information", "Description of business", ACH history and projections, a "control person" for privately held companies, and possibly SSN/EIN documents. Plaid classifies you as an **Originator** or a **Platform**. https://plaid.com/docs/transfer/application/ |
| **Transfer pricing** | "Transfer is available only via a Custom plan with a 12-month minimum contract and is not available via Pay-as-you-go." Per-transfer, per-Item, and per-authorization fees; pricing is on request (same page). Pricing page: Transfer "Not included" in Pay as You Go. https://plaid.com/pricing/ |
| **Pre-approval limits** | Until the Implementation Checklist is approved: max $1 per transfer, $10/day, $100/month. https://plaid.com/docs/transfer/creating-transfers/ |
| **Sandbox** | Free, unlimited, mock data, **no approval**, "All developers". https://support.plaid.com/hc/en-us/articles/16110110883479 . Transfer is enabled in Sandbox by default for new teams. Simulation endpoints (`/sandbox/transfer/simulate`, ledger simulations, `fire_webhook`), magic amounts ($11.11 settles, $33.33 returns R01, and so on), and a test clock for recurring transfers. https://plaid.com/docs/transfer/sandbox/ |
| **Trial plan (new)** | Free, **real** data, 10 Production Items, "auto-approved for most developers", for US/CA teams created on or after **April 15, 2026**. Includes Auth, Balance, Transactions, Identity and more. It does **not** include Transfer. https://support.plaid.com/hc/en-us/articles/16194695660311-Can-I-use-Plaid-for-free . Plaid's billing doc calls Trial and Pay-as-you-go "most appropriate for hobbyist use". https://plaid.com/docs/account/billing/ |
| **Individual?** | Sandbox: yes. Trial: very likely (the "hobbyist" wording), but I did not confirm that someone with no company can complete it. Full Production requires "company + use-case info". Transfer: effectively no for this use case (business application, and same-person transfers are excluded). |
| **Fit** | **Best sandbox** for exercising the real flow (Link → authorization → transfer → status events). **Not a legitimate production path** for moving money between his own accounts. A Trial plan is a good fit for **read-only** balance tracking. |

## Stripe

| | |
|---|---|
| **Financial Connections** | Token-based account linking (account/routing tokens, balances, ownership, transactions). Terms: "At least 14 days before User intends to collect Connections Data for the first time, User must submit its intended purpose … and the user interface it will use to obtain Express Consents … Upon Stripe's written approval…" (Stripe Financial Connections Terms §2.1, last modified April 20, 2026). https://stripe.com/legal/ssa-services-terms |
| **ACH Direct Debit (PaymentIntents/SetupIntents)** | Pulls money from a customer's bank into **your Stripe balance** (standard settlement T+4). Then "we make payouts to your bank account according to your set payout schedule." Mandate required. https://docs.stripe.com/payments/ach-direct-debit |
| **Treasury / Financial Accounts** | "Treasury for platforms is available only to platforms with B2B use cases. Stripe doesn't offer financial accounts to consumers." US availability is a private preview through sales. https://docs.stripe.com/treasury/connect/requirements |
| **Connect / payouts** | Built for platforms paying *other businesses/sellers*. Using Connect to route his own money back to himself doesn't fix the problems below. |
| **Can an individual open an account?** | Yes, as a **sole proprietor** using an SSN (the "Individual" business type). https://support.stripe.com/questions/signing-up-for-stripe-as-a-sole-proprietor-without-employer-id-number . But the Financial Services Terms §2.1 say: "User must be a business (including sole proprietor), governmental or public sector entity, or non-profit organization." https://stripe.com/legal/ssa-services-terms |
| **Test mode** | Free and technically usable (test keys `sk_test_…`, test institutions in Financial Connections). https://docs.stripe.com/financial-connections/testing |

### Stripe verdict: **No. Stripe's terms do not allow this use.**

Quoted terms:
- **Stripe Services Agreement, General Terms** (last modified November 18, 2025), https://stripe.com/legal/ssa
  - §1.1: "User must use the Services solely for User's Business Purposes…"
  - §1.2(a): "User must not, and must not enable or allow any third party to: **(i) use the Services for personal, family, or household purposes**; … (viii) act as service bureau or pass-through agent for the Services with no added value to Customers; or (ix) use the Services to conduct a Prohibited or Restricted Business…"
- **Stripe Payments Terms** (last modified April 24, 2026) §10: "User must only use the Payment Methods and Stripe Payments Services for **bona fide commercial transactions** … with Customers." https://stripe.com/legal/ssa-services-terms
- **Prohibited & Restricted Businesses** (updated 2026-09-22), https://stripe.com/legal/restricted-businesses
  - Prohibited: "**Peer-to-peer money transmission**".
  - Restricted (sales approval): "**Money transmitters**, remittances, currency exchange services and other money service businesses", "**Bank account funding**", "Other financial services".
  - Prohibited uses: "Processing where there is **no bona fide good or service sold**, or donation accepted".

Pulling money from Lance's own checking into his own Stripe balance and paying it out to his own savings is a personal/household use with no customer and no good or service. It falls under 1.2(a)(i) and Payments §10 whatever the money-transmission analysis says. Doing it in live mode risks account restriction or closure. Stripe Checkout or payment-page workarounds are the same activity, so they were not used.

**Is it "money transmission"?** Not legal advice. FinCEN defines money transmission as accepting value "from one person" and transmitting it "to another location or person" (31 CFR 1010.100(ff)(5), https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1010/subpart-A/section-1010.100). Someone moving *only his own* money is generally not acting as a money transmitter *for others*. The answer changes completely if the app ever serves other people: then the app sits in the flow of their funds, and it needs a licensed/bank partner plus counsel. For Stripe, the question doesn't matter because the contract bars the use anyway.

## Dwolla
- **What:** ACH/RTP/FedNow money-movement API with "Customers" created by your **Dwolla Master Account**. Personal verified Customers exist, but they are *your* end users, created programmatically by "your CIP verified Dwolla Master Account". https://developers.dwolla.com/docs/customer-types
- **Linking:** Open Banking services or Plaid processor tokens.
- **Sandbox:** free with an email. https://developers.dwolla.com/docs/testing , https://accounts-sandbox.dwolla.com/sign-up
- **Production:** business onboarding (business verification, controller, beneficial owners). Pricing is custom: "purpose-built for platforms and enterprises running high volumes of bank payments." https://www.dwolla.com/pricing
- **Fit:** poor for an individual. Workable only as a business.

## Moov
- **What:** money movement (ACH, RTP, cards, wallets). Supports Plaid processor tokens.
- **Sandbox:** every account gets a test account; ACH in test mode completes in about an hour; return codes can be simulated. https://docs.moov.io/guides/get-started/test-mode/
- **Production:** "contact Moov to start the verification and underwriting process." KYC/KYB, underwriting for `collect-funds` (processing and bank statements), and a pricing plan. https://docs.moov.io/guides/get-started/production-mode/
- **Fit:** business only.

## Increase
- **What:** banking API (accounts, ACH origination, wires, RTP) with partner banks.
- **Sandbox:** "Every API and dashboard feature is available in Sandbox," with simulation APIs. https://increase.com/documentation/sandbox
- **Production:** program onboarding reviewed by the bank partner (compliance program, financials, infosec, operational resilience). https://increase.com/documentation/customized-compliance
- **Fit:** fintech/business. Overkill for one person.

## Teller
- **What:** bank-account API (real-time data). **Payments (beta): Zelle only**. "The payments resource allows you to send payments to yourself or a 3rd party on behalf of the end-user from their account." The bank may require MFA per payee or payment. https://teller.io/docs/api/account/payments
- **Environments:** Sandbox is free. **Development is free, uses real bank data, and allows 100 enrollments.** Production requires KYB (company URL, beneficial owners, business documents). https://teller.io/docs/guides/environments
- **Fit:** interesting, but unverified for this use. Development mode plus Zelle-to-self could move his own money without ACH debits. However, the API is beta, only some banks support it, MFA prompts and Zelle limits apply, and I did not confirm that Teller's terms allow ongoing personal use of the development environment. Worth a question to Teller before relying on it.

## Column, Unit, other BaaS (brief)
- **Column** (a nationally chartered bank with a developer API): sandbox keys are `test_…` and the `/simulate/*` routes are sandbox-only. https://docs.column.com/guides/getting-started/ . Live use goes through partner diligence (https://docs.column.com/guides/going-live/). Business only.
- **Unit:** BaaS with a sandbox and simulations (https://www.unit.co/docs/api/simulations-check-payments/). Production requires a signed BaaS agreement. I did not check Unit's current onboarding status in depth. Business only.
- **General pattern:** a free sandbox for anyone, then KYB, a contract, and compliance review for live money. None of them is set up for a single consumer moving his own money.

## Consumer-side alternatives (no code, real money today)
| Option | What it gives | Lock? | Notes |
|---|---|---|---|
| **His bank's recurring transfer** (internal checking → savings, or external to a linked account at another bank) | A real schedule, e.g. the 2nd of each month (the day after SSI) | No hard lock | Free at most banks. Putting savings at a *different* bank with no debit card adds friction. |
| **Certificate of deposit (CD)** | A real lock until maturity | Yes (early-withdrawal penalty) | Pick a term that ends at the release date. It is still a countable SSI resource. |
| **Fort Knox (Austin Capital Bank)** | Savings that can only withdraw to one linked checking account, with a mandatory 2-day withdrawal review | Friction, not a date lock | $10/month fee, waived at $1,000+. https://fortknox.bank/ |
| **ABLE account** | Tax-advantaged savings for people with disabilities | Program rules | SSA excludes up to $100,000 in an ABLE account from SSI resources. Eligibility expanded to onset before age 46 on January 1, 2026. https://www.ssa.gov/ssi/spotlights/spot-able.html . This is the key option if the $3,000 goal would push him over SSI's $2,000 limit. Check whether the purchase counts as a qualified disability expense. |

## Recommendation
- **Sandbox build (done):** the `mock` provider (default, offline) plus the `plaid-sandbox` adapter (Link, Transfer authorization/create/get/cancel, `/sandbox/transfer/simulate`, event sync, verified webhooks). I did **not** build a `stripe-test` adapter. Stripe test mode would work technically, but Stripe's terms forbid this use in live mode, so it would be practice against a dead end.
- **Going live, realistic assessment:**
  - *Personal use, real money:* no API provider found offers an individual a legitimate, contracted way to pull from one of his own accounts into another on a schedule. Plaid Transfer excludes it, Stripe forbids it, and Dwolla, Moov, Increase, Column and Unit need a business, KYB and contracts. Teller's Zelle beta is the only possible exception and is unverified. **Do it with the bank's scheduled transfer**, and use the app to plan and track. Optionally connect a free **Plaid Trial** plan for **read-only** balances so the "locked" number reflects real money.
  - *As a product for other people:* this becomes a regulated fintech program. It needs an entity, a sponsor bank/BaaS partner, KYC/CIP, Nacha authorizations and returns handling, Reg E error resolution, a money-transmission analysis with counsel, and ongoing monitoring (see `lock-and-deploy/docs/PHASE2_INTEGRATION.md`). Budget months, not days.
  - *SSI:* keep the benefit-limit warning in front of any real-money activation. A $3,000 goal in a normal savings account can exceed the $2,000 resource limit. An ABLE account may be the right destination account.

---

## Provider for live ACH: cheapest legitimate path (checked September 25, 2026)

The question: what is the cheapest *legitimate* way to make these deposits with real money, and who is allowed to use each option? Fees come from public pricing pages where they exist. "Custom" means you only get a price after a sales call and contract.

### Money-movement APIs (all need a business)
| Provider | Public ACH fees | Minimums / plan | Who can sign up | Allows this use (one person, own accounts)? |
|---|---|---|---|---|
| **Plaid Transfer** | Not public (Custom plan) | **12-month minimum contract**. Before the Implementation Checklist is approved: $1/transfer, $10/day, $100/month caps. https://plaid.com/docs/transfer/application/ , https://plaid.com/docs/transfer/creating-transfers/ | Businesses (Transfer Application, KYB, control person) | **No.** "does not support … transfers between two accounts held by the same person." |
| **Moov** | Same-day ACH **40¢**, next-day ACH credit **25¢**, notification of change 75¢. Third-party summaries list returns at about $5 and unauthorized returns at about $15 (not on Moov's page; unverified). https://moov.io/pricing/ | Standard plan: **$500/month minimum**, no setup fee | Businesses (KYB, underwriting, contract) | Not offered to consumers. Legitimate only if a business is the originator. |
| **Increase** | Next-day ACH origination **$0.50**, same-day **$2.00**, return **$5**, unauthorized return **$15**, late-return request $25. https://increase.com/fees | Monthly platform fees depend on the use case | Businesses/fintech programs (underwriting, KYC/KYB, agreement). Partner banks include First Internet Bank of Indiana and Grasshopper Bank | Not for consumers |
| **Column** | No public ACH rate card (term sheets) | Program reserve and financial statements | Businesses that pass bank-partner diligence (Column is a chartered bank) | Not for consumers |
| **Dwolla** | Custom pricing. https://www.dwolla.com/pricing | Custom | Businesses (KYB) | Not for consumers |
| **Teller** | Development tier is free: **100 live connections**, and "won't owe us a penny" if you never need more. Production: Verify $1.50/account, Balance $0.10/call, Transactions $0.30/enrollment/month, Identity $1.75/call. Zelle payments API is beta with no public price. https://teller.io/pricing | Production needs KYB | Development tier: developers. Production: businesses | Account **data** yes (development tier). Money movement only through the Zelle beta, which is unverified for this use |
| **Stripe ACH Direct Debit** | 0.8% capped at $5 (listed for reference only) | none | Sole proprietors can sign up | **No.** The terms ban "personal, family, or household purposes" and require bona fide commercial transactions |

### Consumer paths (no business needed)
| Option | Cost | What enforces the lock |
|---|---|---|
| **Your bank's own recurring transfer** (checking → savings at the same bank or an external linked account) | Usually free | Nothing by itself. Combine with the rows below |
| **CD (certificate of deposit)** | Free to open. Early withdrawal costs a penalty (often months of interest) | **The bank:** early-withdrawal penalty |
| **Withdrawal-hold savings (e.g. Fort Knox by Austin Capital Bank)** | $10/month, waived at $1,000+ balance. https://fortknox.bank/ | **The bank:** withdrawals go only to one linked account after a waiting period you have to schedule |
| **ABLE account** (if you get SSI) | About $0–$56/year depending on the state plan (ABLE National Resource Center 2026 fee chart). 2026 contribution limit $20,000 | Program rules. The first **$100,000** is excluded from SSI resources. Eligibility: disability onset before age **46** from January 1, 2026. https://www.ssa.gov/ssi/spotlights/spot-able.html |

### Conclusion
- **No provider lets one person legitimately run a self-to-self ACH app without a business, KYB and a signed contract.** Plaid explicitly excludes same-person transfers, and Stripe's terms forbid personal use.
- **Cheapest real path today costs $0:** set up the bank's own free recurring transfer, and let the bank do the locking (CD penalty, Fort Knox-style withdrawal hold, or an ABLE account for SSI). This app is then the monitor and planner (optionally with read-only balances through Plaid's Trial plan or Teller's free development tier).
- **If a business entity exists later**, the lowest public per-transfer prices are **Moov at 25¢ next-day** (with a $500/month minimum) and **Increase at 50¢ next-day** (plus a use-case-dependent monthly fee). At roughly 12 deposits a year, the minimums dominate the cost, so this only makes sense as a product for many users, and then the regulatory items in the go-live gates apply.

### Go-live gates (evaluated in code: `server/golive.js`, shown under Settings; all unmet)
Real money needs **every** gate. Meeting a gate is a human, legal or contract process, so there is deliberately no API or setting that marks a gate as met. `REAL_MONEY_ENABLED` stays a hard-coded `false` on top of the gates.

| Gate id | Requirement | Status |
|---|---|---|
| `provider_approval` | Written production approval from a money-movement provider for this exact use (personal transfers between the owner's own accounts) | Unmet. Plaid excludes it; the others need a business + KYB |
| `security_review` | Independent security review (auth, secrets, bot API, token encryption, hosting) | Unmet |
| `authorization_records` | ACH authorization records retained per Nacha rules (2 years after revocation) with a provider-approved flow | Unmet (local JSON only) |
| `account_recovery_untouched` | Verified that neither the app nor the bot can reach bank login, password reset or account recovery | True by design; must be re-verified by the review |
| `ssi_able_review` | SSI/Medicaid resource-limit review with SSA or a benefits counselor (ABLE account considered) | Unmet |
| `real_money_code_flag` | `REAL_MONEY_ENABLED` changed in code after all the gates above (reviewed code change, never an env var) | Unmet (hard-coded `false`) |
