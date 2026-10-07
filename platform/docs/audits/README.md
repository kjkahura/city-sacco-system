# Audits and build logs

Each section of the platform is audited before it is built against the documentation of the reference platform, the published core banking system whose features and API conventions the platform follows. The audit lists defects, compares coverage and proposes a build with decisions to take. The build log records what was decided, built and fixed, the test count and what was left out. Later audits read these files to check earlier decisions.

The same files are kept in the claude.ai project "CoreBanking Service" under `claude/`. When a section is audited or built, its files are added here in the same commit as the code.

| Order | Section | Commit | Files |
|---|---|---|---|
| 1 | Data and Reporting > Data Management | b737bc5 | [build log](build-log-data-management.md) |
| 2 | Data and Reporting > Data Importing | e164d90 | [build log](build-log-data-importing.md) |
| 3 | Data and Reporting > Reporting | 31f6924 | [build log](build-log-reporting.md) |
| 4 | Report templates, menu items, tasks, tills and permissions | 065b1a7 | [build log](build-log-workspace.md) |
| 5 | Users and Access Control | 6cea8e9 | [audit](audit-users-access-control.md), [build log](build-log-users-access-control.md) |
| 6 | Clients and Groups | 58111a2 | [audit](audit-clients-and-groups.md), [build log](build-log-clients-and-groups.md) |
| 7 | Open items from earlier sections, and the loan-engine audit | 4468536 | [audit](audit-loan-engine-open-items.md), [build log](build-log-open-items.md) |
| 8 | Lines of credit and solidarity group loans (the loan-engine audit's build) | e9591ba | [build log](build-log-credit-arrangements-and-solidarity-loans.md) |
| 9 | Deposits > Deposit Products | 485b3a0 | [audit](audit-deposit-products.md), [build log](build-log-deposit-products.md) |
| 10 | Deposits > Deposit Accounts, offset loans, and the credit arrangement search and schedule | 5be771e, with the Managing Deposit Accounts follow-up in 35e048e | [audit](audit-deposit-accounts.md), [build log](build-log-deposit-accounts.md) |
| 11 | Deposits > Working with Deposit Accounts | audit 35e048e, build 9c72928 | [audit](audit-working-with-deposit-accounts.md), [build log](build-log-working-with-deposit-accounts.md) |
| 12 | Deposits > overdraft terms and the reference platform's deposits API | 0541bf4 | [audit](audit-deposits-api-and-overdrafts.md), [build log](build-log-deposits-api-and-overdrafts.md) |
| 13 | Accounting (setup docs and APIs) | audit 4c9962d, build 6bd401d | [audit](audit-accounting.md), [build log](build-log-accounting.md) |
| 14 | Auditing (the audit trail and tracking activities) | audit d8a0050, build 5da21e7 | [audit](audit-auditing.md), [build log](build-log-auditing.md) |
| 15 | Code refactoring (no change in behaviour) | the four "Refactor:" commits | [build log](build-log-refactoring.md) |
| 16 | Custom Fields | audit 0b0985f, build in the "Custom fields, after the reference platform" commit | [audit](audit-custom-fields.md), [build log](build-log-custom-fields.md) |
| 17 | Console navigation (menus and Administration) | design spec and plan in docs/superpowers, build in the three "Console:" commits | [build log](build-log-console-navigation.md) |
| 18 | Webhooks | audit in the "Webhooks audit" commit, build in the "Webhooks" commit | [audit](audit-webhooks.md), [build log](build-log-webhooks.md) |
| 19 | Events Streaming | audit in the "Events Streaming audit" commit, build in the "Events Streaming" commit | [audit](audit-events-streaming.md), [build log](build-log-events-streaming.md) |
| 20 | Email | audit in the "Email audit" commit, build in the "Email" commit | [audit](audit-email.md), [build log](build-log-email.md) |
| 21 | SMS | audit in the "SMS audit" commit, build in the "SMS" commit | [audit](audit-sms.md), [build log](build-log-sms.md) |
| 22 | Getting Started and Sandbox | audit in the "Getting Started and Sandbox audit" commit, build in the "Getting Started and Sandbox" commit | [audit](audit-getting-started-and-sandbox.md), [build log](build-log-getting-started-and-sandbox.md) |
| 23 | Apps | audit in the "Apps audit" commit, build in the "Apps" commit | [audit](audit-apps.md), [build log](build-log-apps.md) |
| 24 | Security assessment (OWASP Top 10:2025, API Top 10:2023, ASVS 5.0, STRIDE) | review and fixes in the "Security review" commit, the remaining fixes in the "Security hardening follow-up" commit | [assessment](security-assessment-2026-10.md) |
| 25 | Transaction Channels | audit in the "Transaction Channels audit" commit, build in the "Transaction Channels" commit | [audit](audit-transaction-channels.md), [build log](build-log-transaction-channels.md) |

The open work, from deployment to real members' money, is tracked in [NEXT.md](NEXT.md).

Before section 5, the audit findings were recorded inside the build logs, with no separate audit file.
