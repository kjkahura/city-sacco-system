#!/usr/bin/env bash
# Log-based alerts for the signals the platform writes (security review, CFG-7). Run once in
# Cloud Shell; safe to run again.
#
#   PROJECT=city-sacco-prod ALERT_EMAIL=ops@example.org bash deploy/security/alerts.sh
#
# Each alert emails ALERT_EMAIL. Under Kenya's Data Protection Act a personal data breach is
# reported to the Data Commissioner within 72 hours (docs/incident-response.md): these alerts
# are how a breach is noticed in time.
set -euo pipefail
: "${PROJECT:?set PROJECT}" "${ALERT_EMAIL:?set ALERT_EMAIL}"
SERVICE=${SERVICE:-sacco-platform}
gcloud config set project "$PROJECT" >/dev/null
have() { "$@" >/dev/null 2>&1; }

CHANNEL=$(gcloud beta monitoring channels list --filter="labels.email_address=\"$ALERT_EMAIL\"" --format='value(name)' | head -1)
[ -n "$CHANNEL" ] || CHANNEL=$(gcloud beta monitoring channels create --display-name "SACCO security" --type email \
  --channel-labels "email_address=$ALERT_EMAIL" --format='value(name)')

RUN="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\""
metric() { # name, description, filter
  have gcloud logging metrics describe "$1" || gcloud logging metrics create "$1" --description "$2" --log-filter "$3"
}
metric sacco_audit_write_failed 'An audit row could not be written' "$RUN AND textPayload:\"[audit-write-failed]\""
metric sacco_server_error 'A request ended in a server error' "$RUN AND textPayload:\"[error]\""
metric sacco_backup_problem 'A backup or offsite copy failed or was refused' "$RUN AND textPayload:\"[backup]\""
metric sacco_unauthorised 'Requests refused for authentication (401)' "resource.type=\"cloud_run_revision\" AND httpRequest.status=401"
metric sacco_rate_limited 'Requests refused for rate (429)' "resource.type=\"cloud_run_revision\" AND httpRequest.status=429"
metric sacco_admin_request 'A request to the /admin control plane' "resource.type=\"cloud_run_revision\" AND httpRequest.requestUrl:\"/admin/\""

policy() { # name, metric, threshold, window seconds
  gcloud alpha monitoring policies list --filter="displayName=\"$1\"" --format='value(name)' 2>/dev/null | grep -q . && return 0
  cat > /tmp/policy.json <<JSON
{ "displayName": "$1", "combiner": "OR", "notificationChannels": ["$CHANNEL"],
  "conditions": [{ "displayName": "$1", "conditionThreshold": {
    "filter": "metric.type=\"logging.googleapis.com/user/$2\" AND resource.type=\"cloud_run_revision\"",
    "comparison": "COMPARISON_GT", "thresholdValue": $3, "duration": "0s",
    "aggregations": [{ "alignmentPeriod": "$4s", "perSeriesAligner": "ALIGN_SUM" }] } }] }
JSON
  gcloud alpha monitoring policies create --policy-from-file /tmp/policy.json
}
policy 'Audit rows lost' sacco_audit_write_failed 0 300
policy 'Server errors' sacco_server_error 10 300
policy 'Backup problem' sacco_backup_problem 0 3600
policy 'Sign-in failures spike' sacco_unauthorised 200 300
policy 'Rate limiting spike' sacco_rate_limited 200 300
policy 'Control plane used' sacco_admin_request 0 300
echo "Alerts set to $ALERT_EMAIL"
