# Incident response and breach notification

This is what to do when something may have gone wrong: a suspected intrusion, leaked credentials, data sent to the wrong place, or an alert from `deploy/security/alerts.sh`. It was written with the October 2026 security review (`docs/audits/security-assessment-2026-10.md`).

The clock that matters is Kenya's Data Protection Act, 2019. A data controller reports a personal data breach to the Data Commissioner within 72 hours of becoming aware of it, and tells the affected members within a reasonably practicable period, unless the breach is unlikely to put them at risk. A processor tells the controller within 48 hours. Each SACCO is the controller of its members' data; the platform operator is its processor.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Incident lead | The platform operator on duty | Runs the response, keeps the log, decides when it is over |
| SACCO contact | Each affected SACCO's administrator or data protection officer | Decides, as controller, on notifying the Data Commissioner and members |
| Technical responder | Whoever can change the deployment | Contains, collects evidence, restores |
| Communications | The SACCO's management | Speaks to members and, where it applies, to SASRA |

## The first hour

1. **Open a log.** Note the time you became aware; the 72 hours run from then. Write down every action, with its time and who did it.
2. **Decide the severity:**
   - **Critical:** members' money moved without authority, or personal data out of the platform's control.
   - **High:** an attacker with a staff, API or admin credential, but no proof yet of data taken.
   - **Medium:** a failed attempt that reached past a control.
   - **Low:** noise.
3. **Contain without destroying evidence:**
   - **A staff account:** suspend the user in Access (this ends their sessions at once) and reset their password and second factor.
   - **An API key:** set its consumer INACTIVE or delete the key in Access > API Consumers.
   - **The control plane:** unset `ADMIN_API`; it is then answered 404.
   - **The signing keys, if they may be known:**
     - rotate `JWT_SECRET` in Secret Manager and redeploy, which signs everyone out;
     - rotate `ADMIN_JWT_SECRET`;
     - for `SECRETS_KEY`, re-enter every webhook, email, SMS and app secret after rotating.
   - **An address:** block it in the SACCO's IP allow-list, or in Cloud Armor (`sacco-armor`).
   - **A webhook, email or SMS channel sending to the wrong place:** switch it off in Administration.
4. **Tell the SACCO contact** of every SACCO that may be affected, within the 48 hours a processor has; sooner is better.

## Evidence

Collect before changing anything that would overwrite it:
- **The request log** (`audit_events`) and **change log** (`audit_log`) of the affected SACCOs, from Administration > Access > Audit Trail or the database. The daily copies sent by `cli audit:export` are in the archive bucket and cannot have been altered.
- **The platform log** (`platform.audit_log`): control-plane requests, sandbox operations, key and user changes.
- **Cloud Run, Cloud Armor and load balancer logs** in Cloud Logging, for the period.
- **The sign-in history** of the users involved (Access > Users > Sign-in history).
- **A backup** of the affected SACCO taken now (`cli backup:run --slug ...`), kept apart.

## Assess

Answer, in writing:
- What happened, when, and how it was found.
- Which SACCOs, which members, and which data (names, IDs, phone numbers, balances, transactions).
- Whether money moved: list the transactions and whether they can be reversed.
- Whether the data was encrypted where it was taken (backups are; the live database is not readable without access to it).
- Whether the cause is closed.

## Notify (the controller decides; the operator supplies the facts)

- **The Data Commissioner (ODPC):**
  - within 72 hours of awareness, unless the breach is unlikely to result in a risk to members;
  - section 43 of the Act lists what the notice gives: the nature of the breach, the categories and numbers of people and records, the likely consequences, the measures taken or proposed, and a contact;
  - send what is known within the 72 hours, and the rest as it is learned.
- **Members:**
  - within a reasonably practicable period, in plain language;
  - say what happened, what it means for them, and what to do (for example, watch for calls asking for a PIN).
- **SASRA:** report as its prudential and ICT guidance requires for a deposit-taking SACCO.
- **The police:** where money was stolen or a crime is suspected.

## Recover

- **Reverse** unauthorised transactions through the platform (reversals keep the record).
- **Restore** only from a backup taken before the incident, into a separate schema first (`cli backup:verify` restores a dump into a scratch schema; `cli backup:load --file <export.zip> --schema <name>` loads a tenant export), and compare it with the live book before switching.
- **Re-enable** access for the affected users and keys one by one, with new credentials.

## Close

- **A review within two weeks:** what failed, what held, and what changes. Add a check to `test/hardening.test.js` for each code change.
- **Keep the log, the evidence and the notices** with the SACCO's records.

## Contacts to fill in

| Who | Contact |
| --- | --- |
| Platform incident lead | |
| Technical responder | |
| Each SACCO's data protection contact | |
| Office of the Data Protection Commissioner | complaints and breach notification channel as published by the ODPC |
| SASRA | |
