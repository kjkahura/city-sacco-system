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

# Database: PostgreSQL 16, daily backups at 23:00 UTC, point-in-time recovery
gcloud sql instances create sacco-db --database-version=POSTGRES_16 --region="$REGION" \
  --edition=ENTERPRISE --tier=db-custom-1-3840 --storage-auto-increase \
  --backup-start-time=23:00 --enable-point-in-time-recovery
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

The job sends SMS through each SACCO's gateway too. Gateways post delivery reports to `/hooks/sms/<tenant>/<token>` on the service. Set `PUBLIC_BASE_URL` (for example `https://app.example.com`) so the address shown to administrators uses the public host.

The same job publishes events to the streaming templates' topics, so a stream reader sees an event within about a minute of the change, or at once when the request's own pass runs. Event streams are long requests: each ends after 55 seconds (`STREAM_MAX_SECONDS`), inside the service's 60-second timeout and Firebase Hosting's limit, and the reader reconnects from its cursor. To allow longer streams, raise the Cloud Run timeout and `STREAM_MAX_SECONDS` together, and have readers use the `run.app` address. A stream does not hold one of the tenant's request slots while it waits, but it does hold a connection on the instance.

## 7. The custom domain on Cloudflare (when you have one)

1. **Add the domain in Firebase:** Hosting > Add custom domain, for example `app.example.com`. Firebase shows the DNS records it needs.
2. **Add the records in Cloudflare:** in the Cloudflare dashboard, open DNS for the zone and add those records. Set the proxy status to DNS only (grey cloud). Firebase has to see its own records to issue the certificate.
3. **Wait for the certificate:** Firebase shows the domain as Connected once the certificate is issued. This can take up to a day.
4. **Choose whether to proxy:**
   - **DNS only (simplest):** keep the records grey, and Firebase serves the domain and renews its certificate itself.
   - **Proxied (Cloudflare's WAF and caching in front):** switch the records to proxied (orange) and set SSL/TLS to Full (strict). If Firebase later reports that it cannot renew the certificate, switch back to DNS only until it is renewed.

The console asks for the SACCO at sign-in, so one domain serves every SACCO. A subdomain per SACCO would mean adding each subdomain in Firebase, because Firebase Hosting takes no wildcard domain.

## Rollback

- **Code:**
  - in Cloud Run > `sacco-platform` > Revisions, send 100% of traffic to the previous revision;
  - the same from Cloud Shell: `gcloud run services update-traffic sacco-platform --region europe-west1 --to-revisions REVISION=100`.
- **Database:**
  - migrations only move forward;
  - to undo one, restore the instance to a point in time before the deploy (Cloud SQL > Backups > point-in-time recovery). This restores every SACCO's data to that time, so it is the last resort.

## Limits of this setup

- **Request time:** Firebase Hosting ends any request after 60 seconds. Long work (imports, the end of day) already runs in the background or as a job. A very large synchronous export could hit the limit.
- **One instance:** the service runs at most one instance (`--max-instances 1`), because without Redis the rate limits are counted in memory per instance. To run more:
  - add a Redis instance (Memorystore, reached through a VPC connector) and set `REDIS_URL`;
  - then raise `--max-instances`.
- **Cold starts:** with `--min-instances 0` the first request after an idle spell waits for the container to start (a few seconds). Set `--min-instances 1` to avoid that, at the cost of an always-on instance.
- **Backups:**
  - Cloud SQL's daily backups and point-in-time recovery cover the whole database;
  - the platform's own per-SACCO encrypted dumps (`backup:run`) need `pg_dump` 16, which the image does not include, and an offsite destination. They are not set up here.
- **Client address:** `TRUST_PROXY=2` trusts two proxy hops (Firebase Hosting's CDN and Google's front end). After the first deploy, sign in and check that the audit trail (Access > audit trail) shows your own IP address. If it shows a Google address, the hop count needs changing.
- **Cookies:** Firebase Hosting passes only a cookie named `__session` to Cloud Run. The platform uses no cookies (tokens are in memory and `sessionStorage`), so nothing is lost.
