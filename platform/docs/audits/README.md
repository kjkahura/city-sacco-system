# Audits and build logs

Each section of the platform is audited against the reference platform's documentation before it is built. The audit lists defects, compares coverage and proposes a build with decisions to take. The build log records what was decided, built and fixed, the test count and what was left out. Later audits read these files to check earlier decisions.

The same files are kept in the claude.ai project "CoreBanking Service" under `claude/`. When a section is audited or built, its files are added here in the same commit as the code.

| Order | Section | Commit | Files |
|---|---|---|---|
| 1 | Data and Reporting > Data Management | 3941eae | [build log](build-log-data-management.md) |
| 2 | Data and Reporting > Data Importing | 431cc9f | [build log](build-log-data-importing.md) |
| 3 | Data and Reporting > Reporting | 0565bbe | [build log](build-log-reporting.md) |
| 4 | Report templates, menu items, tasks, tills and permissions | b620ab6 | [build log](build-log-workspace.md) |
| 5 | Users and Access Control | a88a0e9 | [audit](audit-users-access-control.md), [build log](build-log-users-access-control.md) |
| 6 | Clients and Groups | 5f2c7f4 | [audit](audit-clients-and-groups.md), [build log](build-log-clients-and-groups.md) |
| 7 | Open items from earlier sections, and the loan-engine audit | f6e92de | [audit](audit-loan-engine-open-items.md), [build log](build-log-open-items.md) |
| 8 | Lines of credit and solidarity group loans (the loan-engine audit's build) | the commit that adds these files | [build log](build-log-credit-arrangements-and-solidarity-loans.md) |

Before section 5, the audit findings were recorded inside the build logs, with no separate audit file.
