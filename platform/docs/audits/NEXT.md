# What is next

The shared task list for the platform: what remains between the code as it stands and real members' money. Anyone working on the platform, person or coding agent, reads this first, marks an item done (`[x]`, with the date and the commit or the person) and adds what they find. Keep each item to one line where possible; the detail lives in the document it points to.

Last reviewed: October 2026.

## 1. Staging deployment (test data only)

The runbook is `docs/deploy.md`; the numbers are its sections.

- [ ] Push `main` to GitHub, so the deploy workflow has every commit.
- [ ] Section 1: create the Firebase and Google Cloud project, and put its ID in `platform/.firebaserc` (it still says `REPLACE_WITH_FIREBASE_PROJECT_ID`).
- [ ] Section 2: one-time Cloud Shell setup: the database, service accounts, Secret Manager secrets, and GitHub sign-in through Workload Identity.
- [ ] Section 3: the GitHub repository variables listed at the top of `.github/workflows/deploy.yml`.
- [ ] Section 4: first deploy; `/health` answers on the web address.
- [ ] Section 5: one test SACCO with the `tenant-create` job; sign in to the console and the portal.
- [ ] Section 6: the scheduled jobs (end of day, token pruning, notifications).

## 2. Production hardening (on staging first)

From `docs/audits/security-assessment-2026-10.md`, "What remains".

- [ ] A domain for the platform, and `deploy/security/edge.sh`: first pass, point the domain at the address, then `LOCK_INGRESS=yes` once the certificate is active.
- [ ] `deploy/security/alerts.sh`, with an address someone watches.
- [ ] The non-owner database role (`db-roles.sql`, `APP_DB_USER`) and the audit archive (`audit-archive.sh`, then `LOCK=yes`).
- [ ] `deploy/security/pin-digests.sh`, and commit its change.
- [ ] Production settings: `PASSWORD_BREACH_CHECK=on`; `PORTAL_ACTIVATION_REQUIRES_PHONE_ON_FILE=true` once phones are recorded; `ADMIN_API` off.
- [ ] Optional: the front ends from a bucket (`docs/deploy.md`, "The front ends from a bucket").
- [ ] Independent penetration test of staging (`docs/pentest-scope.md`), its findings fixed and retested.
- [ ] `docs/incident-response.md`: fill in the contacts and rehearse it once.

## 3. Before real members' money

- [ ] **Regulatory figures**, entered by someone with the current regulations open: provisioning rates, statutory reserve percentage, prudential minimums, and the real SASRA return templates. The system ships them unset on purpose (README, "Numbers this system refuses to invent").
- [ ] **M-Pesa integration** (README, "Not done yet", item 2): paybill and till confirmations into savings and loan repayments (C2B), a payment prompt on the member's phone, and disbursements and withdrawals to a phone (B2C). Audit it against the reference platform's payment integrations first.
- [ ] **Four eyes on for every SACCO**: `npm run cli controls:four-eyes -- --all`, once each has two staff who can approve.
- [ ] **Daily limits** set for tellers and API consumers.
- [ ] **Data migration** of each SACCO's existing book (members, accounts, balances, loans with schedules, the ledger), reconciled to the old system's trial balance.
- [ ] **A parallel run**: at least one month-end closed in both systems with matching balances, before switching over.
- [ ] **Kenya Data Protection Act**: registration with the Office of the Data Protection Commissioner, and a data processing agreement with each SACCO (the platform operator is their processor).

## 4. ARCAFIM pilot (build plan in the project: `claude/arcafim-pilot-build-plan.md`)

- [x] The tagger: `layer/`, with the draft taxonomy, redaction, keyword and Claude classifiers, the City SACCO adapter, the webhook and the back-book run.
- [ ] Equity Bank's adaptation taxonomy and reporting template, to replace the draft (`layer/config/arcafim-taxonomy.json`).
- [ ] Choose the model (`ARCAFIM_MODEL`) and put the Anthropic API key in Secret Manager; until then the keyword classifier tags.
- [ ] Deploy the layer as its own Cloud Run service for the first pilot SACCO (`layer/README.md`, "Setting it up for a SACCO").
- [ ] The review app: a tab on the loan page where credit staff confirm or correct the tag (measures the 90% accuracy target).
- [ ] In the platform: member county as data, and a rule refusing approval of an ARCAFIM-product loan until it is tagged eligible.
- [ ] The monthly impact reporter, in Equity's and IFAD's template.
- [ ] Which core banking systems the three pilot SACCOs use; an adapter for each that is not this platform.
- [ ] Climate-aware scoring (shadow mode) and member advisory (months 4 to 6).

## 5. Product gaps (README, "Not done yet")

- [ ] Dividends before provisioning: enforce the order, or warn.
- [ ] Early settlement of fixed-term loans: an option to recover more than accrued interest.
- [ ] Top-up rules and fees.
- [ ] Tiered deposit rates and fixed deposits with maturity, if a pilot SACCO needs them.

## Done

Move items here with the date and the commit, newest first.

- [x] 2026-10: front ends deployed apart from the API (`c23c45b`); `npm audit` gates the deploy (`3e6257e`).
- [x] 2026-10: security review and follow-up: every code finding fixed (`docs/audits/security-assessment-2026-10.md`).
