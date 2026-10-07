# Deploying the platform: GitHub, Google Cloud, Firebase and Cloudflare

This runbook is for going live. It covers what runs where, the one-time setup, the first deploy, the first SACCO, scheduled jobs, the custom domain on Cloudflare, rollback and the limits of this setup.

## What runs where

| Part | Where | Why |
|---|---|---|
| Source and CI/CD | GitHub (`kjkahura/city-sacco-system`), `.github/workflows/deploy.yml` | Every push to `main` that touches `platform/` runs the tests, then deploys. |
| API, console and portal | Google Cloud Run service `sacco-platform`, region `europe-west1` | The Express server as a container (`platform/Dockerfile`). It scales to zero when idle. |
| Database | Cloud SQL for PostgreSQL 16, instance `sacco-db`, `europe-west1` | Schema per SACCO, as in development. Cloud Run reaches it through the Cloud SQL socket; it has no public access. |
| Secrets | Secret Manager | The database password and the JWT secret. Nothing secret is stored in GitHub or in the image. |
| Web address, CDN and TLS | Firebase Hosting (`PROJECT_ID.web.app`) | `platform/firebase.json` sends every request to the Cloud Run service. |
| Scheduled work | Cloud Run jobs started by Cloud Scheduler | The end of day (22:00 Nairobi) and token pruning (03:00 Nairobi). The in-process scheduler stays off. |
| Custom domain (later) | Cloudflare DNS | It points the domain at Firebase Hosting (below). |

`europe-west1` (Belgium) is one of the regions Firebase recommends for pairing Hosting with Cloud Run. Google has no region in Kenya.

## Before you start

- **Accounts:** a Google account that will own the project, and admin rights on the GitHub repository.
- **Billing:**
  - the Blaze (pay-as-you-go) plan is needed for Cloud Run and Cloud SQL;
  - set a budget alert when you add billing;
  - the main cost is Cloud SQL. The smallest shared-core instance is listed at about US$8 a month before storage, but it is not meant for production. The dedicated 1 vCPU, 3.75 GB instance used below costs more; check the Cloud SQL pricing page for today's figure.
- **Data protection:** member personal data will be stored in Belgium. Check the Data Protection Act 2019 rules on transfers out of Kenya, and anything SASRA asks of the SACCO, before real member data goes in. This is not legal advice. Until then, use test data.

## 1. Create the Firebase project

In the Firebase console:

1. Add a project, for example `city-sacco-prod`. Note the project ID.
2. Upgrade it to the Blaze plan and set a budget alert.
3. Open Hosting and click Get started. The default site `PROJECT_ID.web.app` is created.

In the repository, replace `REPLACE_WITH_FIREBASE_PROJECT_ID` in `platform/.firebaserc` with the project ID and commit.

## 2. One-time Google Cloud setup (Cloud Shell)

Open Cloud Shell from the Google Cloud console with the project selected, and run the commands below in order. They create no passwords that you have to type or see: the database password and the JWT secret are generated and go straight into Secret Manager.

```sh
PROJECT=city-sacco-prod          # your project ID
REGION=europe-west1
REPO_GH=kjkahura/city-sacco-system
gcloud config set project "$PROJECT"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com iamcredentials.googleapis.com \
  firebasehosting.googleapis.com

# Images
gcloud artifacts repositories create sacco --repository-format=docker --location="$REGION"

# Database: PostgreSQL 16, daily backups at 23:00 UTC, point-in-time recovery, a standby in a
# second zone (high availability, see "The database" below) and Query Insights
gcloud sql instances create sacco-db --database-version=POSTGRES_16 --region="$REGION" \
  --edition=ENTERPRISE --tier=db-custom-1-3840 --storage-auto-increase \
  --backup-start-time=23:00 --enable-point-in-time-recovery \
  --availability-type=REGIONAL --insights-config-query-insights-enabled
gcloud sql databases create sacco --instance=sacco-db

# Secrets, generated here
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create sacco-db-password --data-file=-
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create sacco-jwt-secret --data-file=-
# The key webhook passwords and signing secrets are encrypted with. Keep it: a new one makes stored secrets unreadable.
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create sacco-secrets-key --data-file=-
gcloud sql users create sacco --instance=sacco-db \
  --password="$(gcloud secrets versions access latest --secret=sacco-db-password)"

# The service account the app runs as
gcloud iam service-accounts create sacco-runtime --display-name="SACCO platform runtime"
RUNTIME=sacco-runtime@$PROJECT.iam.gserviceaccount.com
for role in roles/cloudsql.client roles/secretmanager.secretAccessor roles/run.invoker; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME" --role="$role"
done

# The service account GitHub deploys as
gcloud iam service-accounts create sacco-deployer --display-name="GitHub deploy"
DEPLOYER=sacco-deployer@$PROJECT.iam.gserviceaccount.com
for role in roles/run.admin roles/artifactregistry.writer roles/firebasehosting.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOYER" --role="$role"
done
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" \
  --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser

# GitHub signs in without a key (Workload Identity Federation), from this repository only
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub"
gcloud iam workload-identity-pools providers create-oidc github --location=global \
  --workload-identity-pool=github --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$REPO_GH'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO_GH"

# The values GitHub needs (step 3)
echo "GCP_PROJECT_ID=$PROJECT"
echo "GCP_REGION=$REGION"
echo "CLOUD_SQL_INSTANCE=$(gcloud sql instances describe sacco-db --format='value(connectionName)')"
echo "WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github"
echo "DEPLOY_SERVICE_ACCOUNT=$DEPLOYER"
echo "RUNTIME_SERVICE_ACCOUNT=$RUNTIME"
```

If an organization policy refuses public access to Cloud Run (`allUsers`), the Firebase Hosting rewrite cannot reach the service. The project then needs that policy relaxed for this service.

## 3. GitHub settings

In the repository, open Settings > Secrets and variables > Actions > Variables and add the six values the last commands printed. They are not secrets: none of them grants access on its own.

Then open Settings > Environments and create `production`. Add yourself as a required reviewer if every deploy should wait for your approval.

## 4. First deploy

Push to `main`, or run the workflow from the Actions tab (Test and deploy > Run workflow). The workflow runs these steps in order:

1. **Tests:** all the suites that `npm test` covers, against PostgreSQL 16 and Redis.
2. **Image:** builds it and pushes it to Artifact Registry.
3. **Migrations:** runs them as the `sacco-migrate` job.
4. **Service:** deploys the Cloud Run service.
5. **Scheduled jobs:** updates `sacco-eod`, `sacco-tokens` and `sacco-notify`.
6. **Hosting:** deploys Firebase Hosting.
7. **Check:** requests `/health` on `PROJECT_ID.web.app`.

The console is then at `https://PROJECT_ID.web.app/console/` and the member portal at `/portal/`.

## 5. The first SACCO

Create the SACCO's first administrator from Cloud Shell. The password is typed at a hidden prompt and kept in Secret Manager, not on the command line:

```sh
read -rs -p "First admin password: " P && printf '%s' "$P" | gcloud secrets create sacco-first-admin-password --data-file=- && unset P
IMAGE=$(gcloud run services describe sacco-platform --region="$REGION" --format='value(spec.template.spec.containers[0].image)')
gcloud run jobs create sacco-tenant-create --image "$IMAGE" --region "$REGION" \
  --service-account "$RUNTIME" --set-cloudsql-instances "$(gcloud sql instances describe sacco-db --format='value(connectionName)')" \
  --set-env-vars "NODE_ENV=production,PGHOST=/cloudsql/$(gcloud sql instances describe sacco-db --format='value(connectionName)'),PGUSER=sacco,PGDATABASE=sacco" \
  --set-secrets "PGPASSWORD=sacco-db-password:latest,JWT_SECRET=sacco-jwt-secret:latest,TENANT_ADMIN_PASSWORD=sacco-first-admin-password:latest" \
  --command node --args="bin/cli.js,tenant:create,--slug,citysacco,--name,City SACCO,--admin-email,admin@example.com"
gcloud run jobs execute sacco-tenant-create --region "$REGION" --wait
```

Sign in at `/console/` with the SACCO `citysacco`, that email and that password, and change the password when asked. Then delete the job and the secret:

```sh
gcloud run jobs delete sacco-tenant-create --region "$REGION" --quiet
gcloud secrets delete sacco-first-admin-password --quiet
```

For each further SACCO, run the same job with its own slug, name and email.

## 6. Scheduled jobs

```sh
for s in "sacco-eod|0 22 * * *" "sacco-tokens|0 3 * * *" "sacco-notify|* * * * *"; do
  job="${s%%|*}"; cron="${s#*|}"
  gcloud scheduler jobs create http "$job" --location="$REGION" --schedule="$cron" --time-zone="Africa/Nairobi" \
    --http-method=POST --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$job:run" \
    --oauth-service-account-email="$RUNTIME"
done
```

The end of day is idempotent per business date, so a retried run does no harm. Each SACCO's own end-of-day settings (automatic or manual) still apply.

`sacco-notify` runs every minute and delivers webhooks: it turns new events into messages and sends what is due, including retries. The service also sends a request's webhooks straight after the request, but Cloud Run slows a container's CPU once it has answered and stops idle containers, so the job is what guarantees delivery. Runs that overlap do not send a message twice.

The same job sends emails through each SACCO's own mail server. Cloud Run allows outbound connections on ports 465 and 587, which are the only ones the platform uses for mail; Google Cloud blocks port 25. No new secret is needed: each SACCO's SMTP password is stored sealed with `sacco-secrets-key`.

The job sends SMS through each SACCO's gateway too. Gateways post delivery reports to `/hooks/sms/<tenant>/<token>` on the service. Set `PUBLIC_BASE_URL` (for example `https://app.example.com`) so the address shown to administrators uses the public host. Apps use it too: the API address in an app's signed request comes from `PUBLIC_BASE_URL` only, and is left out when it is not set.

The job also runs queued sandbox operations (create, reset, clone and delete). A clone of a large SACCO can take longer than a minute; runs that overlap do not start the same operation twice, and `npm run cli sandbox:run` runs them by hand. Sandboxes are left out of the nightly backup and offsite copies.

The same job publishes events to the streaming templates' topics, so a stream reader sees an event within about a minute of the change, or at once when the request's own pass runs. Event streams are long requests: each ends after 55 seconds (`STREAM_MAX_SECONDS`), inside the service's 60-second timeout and Firebase Hosting's limit, and the reader reconnects from its cursor. To allow longer streams, raise the Cloud Run timeout and `STREAM_MAX_SECONDS` together, and have readers use the `run.app` address. A stream does not hold one of the tenant's request slots while it waits, but it does hold a connection on the instance.

## 7. The custom domain on Cloudflare (when you have one)

1. **Add the domain in Firebase:** Hosting > Add custom domain, for example `app.example.com`. Firebase shows the DNS records it needs.
2. **Add the records in Cloudflare:** in the Cloudflare dashboard, open DNS for the zone and add those records. Set the proxy status to DNS only (grey cloud). Firebase has to see its own records to issue the certificate.
3. **Wait for the certificate:** Firebase shows the domain as Connected once the certificate is issued. This can take up to a day.
4. **Choose whether to proxy:**
   - **DNS only (simplest):** keep the records grey, and Firebase serves the domain and renews its certificate itself.
   - **Proxied (Cloudflare's WAF and caching in front):** switch the records to proxied (orange) and set SSL/TLS to Full (strict). If Firebase later reports that it cannot renew the certificate, switch back to DNS only until it is renewed.

The console asks for the SACCO at sign-in, so one domain serves every SACCO. A subdomain per SACCO would mean adding each subdomain in Firebase, because Firebase Hosting takes no wildcard domain.

## Security settings

The security review of October 2026 (`docs/audits/security-assessment-2026-10.md`) added these settings. Nothing changes for a deployment that sets none of them, except where noted.

- **`ADMIN_API`**: the `/admin` control plane is off unless this is `on`. When on, also set:
  - `ADMIN_JWT_SECRET`: 48 random bytes in Secret Manager, never the same as `JWT_SECRET`;
  - `ADMIN_ALLOWED_IPS` (optional): a comma-separated list of operator addresses.

  Make a token with `npm run cli admin:token --email you@example.org`; it lasts at most an hour.
- **`PORTAL_ACTIVATION_REQUIRES_PHONE_ON_FILE=true`**: members with no phone on record activate the portal at a branch. Turn it on once phones are recorded.
- **`REQUEST_STATEMENT_TIMEOUT_MS`**: the limit on one database statement during a request (default 55000). Jobs are not limited.
- **Production now refuses to start** without a `JWT_SECRET` of at least 32 bytes, and refuses to seal or open secrets without a `SECRETS_KEY` of at least 32 bytes. The secrets created in section 2 already meet both.
- **Offsite backups** are never shipped unencrypted: without `BACKUP_ENCRYPTION_KEY`, the offsite copy is skipped and the run says so.
- **`NEW_TENANT_FOUR_EYES=off`**: a new SACCO starts with four eyes on loans (who applies does not approve, who approves does not disburse); this setting starts it without. Existing SACCOs keep their setting; `npm run cli controls:four-eyes -- --slug <slug>` (or `--all`, or `--off`) changes it.
- **`PASSWORD_BREACH_CHECK=on`**: new passwords are checked against the breached-passwords service (api.pwnedpasswords.com) by k-anonymity, so only the first five characters of the password's SHA-1 leave the platform. If the service cannot be reached the password is accepted.
- **`AUDIT_ARCHIVE`**: where `npm run cli audit:export` sends each day's audit trail (`gcs:<bucket>`, `dir:<path>` or `cmd:<command>`). `deploy/security/audit-archive.sh` makes the bucket with a retention policy and the daily job.
- **`APP_DB_USER`** (a repository variable): the service connects as this role, which does not own the tables (`deploy/security/db-roles.sql` makes it, with the password in Secret Manager as `sacco-app-db-password`). Migrations and jobs stay with the owner. Unset, the service runs as before. With it set:
  - new SACCOs are made with `npm run cli tenant:create` (a job), since the `/admin` control plane cannot create schemas;
  - sandbox work runs only in the jobs (the deploy job sets `SANDBOX_AFTER_REQUEST=off`);
  - the service may add to the audit trail, prune old requests and anonymize change-log rows, which the audit triggers allow, and nothing else.
- **Sessions:** each staff and member request is checked against a live session, so signing out, changing a password or PIN, or suspending a user ends the session within five seconds (at once on the instance that handled it) rather than when the access token expires, up to 15 minutes later. A PIN change keeps the member's current device signed in and signs out the others.
- **Scripts for the Google Cloud project** (`deploy/security/`), each run once from Cloud Shell and safe to run again:
  - `edge.sh`: an HTTPS load balancer with Cloud Armor in front of the service, so the client address the platform sees cannot be set by the caller. Run it once, point the domain at the address it prints, and when the certificate is active run it again with `LOCK_INGRESS=yes` to set ingress to "internal and Cloud Load Balancing";
  - `alerts.sh`: log-based metrics and email alerts on `[audit-write-failed]`, `[error]` and `[backup]` lines, 401 and 429 spikes and control-plane requests;
  - `audit-archive.sh`: the write-once audit bucket and its daily job (`LOCK=yes` locks the retention, which cannot be undone);
  - `db-roles.sql`: the non-owner `sacco_app` role;
  - `pin-digests.sh`: pins the workflow's actions and the base image by digest; review the diff and commit it.
- **When something goes wrong:** `docs/incident-response.md`, including the 72-hour notice to the Data Commissioner. `docs/pentest-scope.md` is the brief for an independent penetration test.

## The front ends from a bucket

The console and portal can be served by the load balancer from a Cloud Storage bucket, so they are released apart from the API (README, "The front ends, deployed apart from the API"). This needs the load balancer from `deploy/security/edge.sh` first.

1. **Make the bucket:** run `edge.sh` again with `FRONTEND_BUCKET=<a new, globally unique bucket name>` added to the usual settings. It makes the bucket, lets the deploy service account publish to it, and makes the two backend buckets with the console's and portal's headers. It leaves the routing alone while the bucket is empty.
2. **Publish:** in GitHub, set the repository variables (not environment variables) `FRONTEND_BUCKET` (the same name) and `SITE_URL` (`https://` and your domain), then run the "Test and deploy" workflow. The `frontends` job publishes `public/` to `console/` and `portal/` to `portal/` in the bucket. With `SITE_URL` set, the workflow checks that address and stops deploying Firebase Hosting.
3. **Route:** run `edge.sh` once more with `FRONTEND_BUCKET`. It now finds the files and sends `/console/*` and `/portal/*` to the bucket, and `/`, `/console` and `/portal` to `/console/` and `/portal/`. Then set the repository variable `FRONTENDS_ROUTED=yes`; until then every push also redeploys the API, so nothing waits on a bucket nobody is served from.
4. **Check:** open `https://<domain>/console/`. The browser's developer tools should show the `Content-Security-Policy` header on the page, and signing in should work as before.
5. **Optional:** set the repository variable `SERVE_FRONTENDS=off`. From the next API deploy, the service no longer serves the front ends itself.

From then on, a push that changes only `platform/public` or `platform/portal`, compared with the commit the running service was built from, publishes the front ends and does not redeploy the API. When a push changes both, the front ends are published after the API is deployed.

Things to know:
- **The bucket is public:** anyone can list and read it at `storage.googleapis.com`. It holds only the front ends' own files, which carry no secrets; a page opened there runs on Google's origin with no headers of ours and no access to anyone's sign-in.
- **Organisation policy:** if the organisation enforces public access prevention, `edge.sh` stops with a message; the organisation's administrator can grant this project an exception.
- **Cloud Armor:** the rules protect the API only. Requests to the static files are not rate limited.

To go back, run `gcloud compute url-maps import` with a map that has only `defaultService: .../backendServices/sacco-backend`, or delete the route rules in the console under Load balancing > `sacco-lb` > Routing rules. If you set `SERVE_FRONTENDS=off`, unset it and run the deploy workflow first, so the service serves the front ends again; also unset `FRONTENDS_ROUTED`.

## Rollback

- **Code:**
  - in Cloud Run > `sacco-platform` > Revisions, send 100% of traffic to the previous revision;
  - the same from Cloud Shell: `gcloud run services update-traffic sacco-platform --region europe-west1 --to-revisions REVISION=100`.
- **Database:**
  - migrations only move forward;
  - to undo one, restore the instance to a point in time before the deploy (Cloud SQL > Backups > point-in-time recovery). This restores every SACCO's data to that time, so it is the last resort.

## The database

The design behind these steps (consistency, locking, the replica, payments) is in `docs/data-architecture.md`.

### High availability and failover

- **What it is:** with `--availability-type=REGIONAL` (section 2), Cloud SQL keeps a standby in a second zone of the region and fails over to it on its own when the primary's zone fails. The address does not change, so the platform needs no new setting. Google's documentation gives about sixty seconds without the database during a failover.
- **Cost:** the standby is billed like the primary, so the instance costs about twice as much.
- **An instance created without it:** `gcloud sql instances patch sacco-db --availability-type=REGIONAL`. This restarts the instance (usually a few minutes; longer with a large disk), so do it out of hours.
- **What the platform does during a failover:**
  - open connections are closed; requests in flight fail with a database error and their transactions are rolled back, so nothing is half posted;
  - new requests reconnect through the same address once the standby is up;
  - a client that sent `Idempotency-Key` can repeat a POST safely.
- **Rehearse it on staging** before real money, and write the result in `docs/incident-response.md`:
  1. keep a few requests running (sign in to the console and open a report, or run `node test/load/postings.js` against staging, below);
  2. `gcloud sql instances failover sacco-db`;
  3. note how long requests fail, and check `/health` comes back without a restart of the service;
  4. run `npm run cli ledger:verify -- --slug <a test SACCO>` to confirm the books still agree.

### Scaling the database

- **Connections:** every instance of the service opens up to `PGPOOL_MAX` connections (10 in the deploy workflow), and each job running at the same time opens its own. `npm run cli db:connections -- --instances N --pool-max 10 --jobs 3` reads the instance's `max_connections`, shows what is open, and says whether N instances and the jobs fit under 80% of it. Run it before raising `--max-instances`.
- **A connection pooler** when they do not fit:
  - Cloud SQL managed connection pooling (Enterprise Plus edition only) or PgBouncer, in transaction mode;
  - the platform works with transaction mode: every setting it makes is `SET LOCAL` and ends with the transaction;
  - three places hold a session advisory lock across transactions (the scheduler, migrations, sandbox jobs), which transaction mode does not allow. Set `PG_DIRECT_HOST` (and `PG_DIRECT_PORT`) to the instance itself, not the pooler, and those use a small pool of their own (`PGPOOL_DIRECT_MAX`, default 3).
- **A read replica for reports:**
  1. `gcloud sql instances create sacco-db-replica --master-instance-name=sacco-db --region="$REGION" --database-flags=hot_standby_feedback=on`. Without the flag a long report on the replica can be cancelled while the replica applies the primary's changes (the platform then reads that report from the primary). With it the primary keeps old row versions a little longer for the replica's sake, so watch `db:bloat`;
  2. set the repository variable `CLOUD_SQL_REPLICA` to its connection name (`PROJECT:REGION:sacco-db-replica`) and deploy. The service then reads reports, the trial balance and the dashboard indicators from the replica (`PG_REPLICA_HOST`).
  - Postings, balances and everything a posting reads stay on the primary. The data extract also stays on the primary: its cursor needs the primary's view of transactions still open.
  - A report from the replica answers with `Data-As-At` and `Data-Source: replica`; the console shows "Includes changes up to ..." above it, and exports carry a "Data as at" line. Google describes a replica as reflecting the primary in almost real time.
  - Reports read the primary when the replica cannot be reached (it is then skipped for 30 seconds), is more than `REPLICA_MAX_LAG_SECONDS` (default 60) behind, or cancels a report's query.
- **Retries on conflicts:** a request that PostgreSQL ends to break a deadlock (or a serialization conflict) is run again up to twice before the caller gets `409 CONFLICT_TRY_AGAIN`. The repository variable `CONFLICT_RETRIES` changes the count; `0` turns it off.
- **Migrations that rebuild a key:** tenant migration 052 rebuilds the primary key of the two daily rollup tables, which locks them while the index is built. On a SACCO with a large ledger, deploy it outside business hours; a migration that cannot get its lock within 5 seconds fails for that SACCO, the migration job reports it and the deploy stops before the new service starts; run the deploy again when the SACCO is quiet.
- **Moving a SACCO to another instance** is not built yet; the path is in `docs/data-architecture.md`, "Outgrowing one instance".

### Watching the database

- **Query Insights** is on from section 2. On an instance created without it: `gcloud sql instances patch sacco-db --insights-config-query-insights-enabled` (older maintenance versions restart the instance). It shows the slowest statements in the console under Cloud SQL > Query insights.
- **The heaviest statements from the command line:** run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` once as the `postgres` user, then `npm run cli db:top-queries`.
- **Before adding an index:** run the statement with `EXPLAIN (ANALYZE, BUFFERS)` on staging with realistic data, and add an index (a covering one with `INCLUDE` where the plan shows a heap lookup per row) only when the plan shows the need. Write the measurement in the migration's comment.
- **Dead rows:** `npm run cli db:bloat` lists the tables updated many times a day (balances, the daily rollups, sessions, the outbox) in every SACCO, with their dead rows and last autovacuum, and marks with `LOOK` those over 10,000 dead rows and 20% of the table. Check it monthly at first. If a table stays marked, lower its fillfactor or tighten its autovacuum in a new migration, with the reading that justified it.

### Load testing

`node test/load/postings.js --workers 16 --seconds 30` (or `npm run load:postings -- --workers 16`) runs concurrent cash deposits into different members' accounts in a throwaway SACCO (`loadtest`) it creates and removes, and prints postings per second, latency and the share of time spent waiting on locks. It touches no other SACCO; the database must already be migrated. Point `PG*` at staging to measure there, never at production. Measured on a 2-core test machine in October 2026, before and after the daily rollup was spread over slots (tenant migration 052):

| Workers | Postings a second | 95th percentile | Time waiting on locks |
| --- | --- | --- | --- |
| 8, one rollup row | 138 | 159 ms | 88% |
| 8, sixteen slots | 207 | 58 ms | 4% |
| 16, one rollup row | 139 | 378 ms | 87% |
| 16, sixteen slots | 209 | 102 ms | under 1% |

### Choosing the region

- **Latency:** the service and the database are in `europe-west1` (Belgium). Every request from Kenya crosses to Europe and back, which adds a delay each staff member feels on every screen.
- **Closer:** `africa-south1` (Johannesburg) offers both Cloud Run and Cloud SQL. Measure from Nairobi before moving: create a small test service in each region and time requests from a SACCO's own connection.
- **The law:** the Data Protection (General) Regulations, 2021, regulation 26, require processing in Kenya (or at least one serving copy in a Kenyan data centre) only for listed purposes of strategic interest to the state: civil registration and identity, elections, public finances administered by state organs, systems designated as protected computer systems under section 20 of the Computer Misuse and Cybercrime Act, education, and primary and secondary health care. A SACCO's member records are not on the list, unless its system is designated a protected computer system. Transfers out of Kenya still need one of the Act's grounds (appropriate safeguards, an adequacy decision, necessity, or consent). Confirm this with counsel during the ODPC registration (`docs/audits/NEXT.md`, section 3).
- **Moving** the region is a new project setup (section 2 with another `REGION`), a restore of the database, and a change of the repository variable `GCP_REGION`.

## Limits of this setup

- **Request time:** Firebase Hosting ends any request after 60 seconds. Long work (imports, the end of day) already runs in the background or as a job. A very large synchronous export could hit the limit.
- **One instance:** the service runs at most one instance (`--max-instances 1`), because without Redis the rate limits are counted in memory per instance. To run more:
  - add a Redis instance (Memorystore, reached through a VPC connector) and set `REDIS_URL`;
  - check the connections fit (`npm run cli db:connections -- --instances N`, "Scaling the database");
  - then raise `--max-instances`.
- **Cold starts:** with `--min-instances 0` the first request after an idle spell waits for the container to start (a few seconds). Set `--min-instances 1` to avoid that, at the cost of an always-on instance.
- **Backups:**
  - Cloud SQL's daily backups and point-in-time recovery cover the whole database;
  - the platform's own per-SACCO encrypted dumps (`backup:run`) need `pg_dump` 16, which the image does not include, and an offsite destination. They are not set up here.
- **Client address:** `TRUST_PROXY=2` trusts two proxy hops (Firebase Hosting's CDN and Google's front end). After the first deploy, sign in and check that the audit trail (Access > audit trail) shows your own IP address. If it shows a Google address, the hop count needs changing.
- **Cookies:** Firebase Hosting passes only a cookie named `__session` to Cloud Run. The platform uses no cookies (tokens are in memory and `sessionStorage`), so nothing is lost.
