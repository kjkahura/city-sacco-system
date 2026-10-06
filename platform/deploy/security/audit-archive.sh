#!/usr/bin/env bash
# A write-once copy of the audit trail (security review, CFG-8): a bucket whose retention policy
# keeps every object for RETENTION_DAYS, and a daily job that copies yesterday's audit trail there.
#
#   PROJECT=city-sacco-prod REGION=europe-west1 BUCKET=city-sacco-audit RETENTION_DAYS=2555 bash deploy/security/audit-archive.sh
#   ... and once the copies look right: LOCK=yes (locking cannot be undone; the bucket then cannot
#   be deleted, nor the policy shortened, until every object has aged out).
set -euo pipefail
: "${PROJECT:?}" "${REGION:?}" "${BUCKET:?}"
RETENTION_DAYS=${RETENTION_DAYS:-2555}   # seven years
IMAGE=$(gcloud run services describe sacco-platform --region "$REGION" --format='value(spec.template.spec.containers[0].image)')
RUNTIME_SA=$(gcloud run services describe sacco-platform --region "$REGION" --format='value(spec.template.spec.serviceAccountName)')
gcloud config set project "$PROJECT" >/dev/null
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$BUCKET" --retention-period "${RETENTION_DAYS}d"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$RUNTIME_SA" --role roles/storage.objectCreator >/dev/null
[ "${LOCK:-}" = yes ] && gcloud storage buckets update "gs://$BUCKET" --lock-retention-period
# The job uses the same settings as the other jobs (the owner role) plus where to send the copy.
ENV=$(gcloud run jobs describe sacco-notify --region "$REGION" --format=json | python3 -c 'import json,sys; c=json.load(sys.stdin)["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]; print(",".join(e["name"]+"="+e["value"] for e in c.get("env",[]) if "value" in e))')
gcloud run jobs deploy sacco-audit-export --image "$IMAGE" --region "$REGION" --service-account "$RUNTIME_SA" \
  --set-cloudsql-instances "$(gcloud run jobs describe sacco-notify --region "$REGION" --format='value(spec.template.metadata.annotations."run.googleapis.com/cloudsql-instances")')" \
  --set-env-vars "$ENV,AUDIT_ARCHIVE=gcs:$BUCKET" \
  --set-secrets "PGPASSWORD=sacco-db-password:latest,JWT_SECRET=sacco-jwt-secret:latest,SECRETS_KEY=sacco-secrets-key:latest" \
  --command node --args="bin/cli.js,audit:export" --max-retries 1 --task-timeout 30m --quiet
SA_SCHED=${SCHEDULER_SA:-$RUNTIME_SA}
gcloud scheduler jobs describe sacco-audit-export --location "$REGION" >/dev/null 2>&1 ||
  gcloud scheduler jobs create http sacco-audit-export --location "$REGION" --schedule "30 1 * * *" --time-zone "Africa/Nairobi" \
    --http-method POST --uri "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/sacco-audit-export:run" \
    --oauth-service-account-email "$SA_SCHED"
echo "Audit trail copied daily to gs://$BUCKET (retention ${RETENTION_DAYS} days${LOCK:+, locked})"
