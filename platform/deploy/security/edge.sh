#!/usr/bin/env bash
# Put an HTTPS load balancer with Cloud Armor in front of the Cloud Run service, then
# refuse direct run.app traffic (security review, CFG-2). Run once, in Cloud Shell, as a
# project owner. It is safe to run again: each step skips what already exists.
#
# Why: a request sent straight to *.run.app can write its own X-Forwarded-For, and the
# platform trusts two proxy hops for the client address (IP allow-list, sign-in limits,
# audit trail). Behind the load balancer only Google's front end writes that header.
#
# Two passes, so the service is never unreachable while the certificate is issued:
#
#   1. PROJECT=city-sacco-prod REGION=europe-west1 DOMAIN=app.example.org bash edge.sh
#      Builds everything and prints the address. Point the domain's A record at it (DNS
#      only, not proxied) and wait until the certificate is ACTIVE:
#      gcloud compute ssl-certificates describe sacco-cert --global --format='value(managed.status)'
#   2. The same command with LOCK_INGRESS=yes in front. Only then does the service refuse
#      traffic that does not come through the load balancer (the run.app and web.app
#      addresses stop working).
#
# Keep TRUST_PROXY=2 (client, then the load balancer). The console and portal are served
# by the service itself (/console, /portal), so Firebase Hosting is no longer needed.
set -euo pipefail
: "${PROJECT:?set PROJECT}" "${REGION:?set REGION}" "${DOMAIN:?set DOMAIN}"
SERVICE=${SERVICE:-sacco-platform}
gcloud config set project "$PROJECT" >/dev/null
have() { "$@" >/dev/null 2>&1; }

# 1. A serverless network endpoint group for the service, and a backend service.
have gcloud compute network-endpoint-groups describe sacco-neg --region "$REGION" ||
  gcloud compute network-endpoint-groups create sacco-neg --region "$REGION" --network-endpoint-type serverless --cloud-run-service "$SERVICE"
have gcloud compute backend-services describe sacco-backend --global ||
  gcloud compute backend-services create sacco-backend --global --load-balancing-scheme EXTERNAL_MANAGED --protocol HTTPS --enable-logging
gcloud compute backend-services describe sacco-backend --global --format='value(backends)' 2>/dev/null | grep -q sacco-neg ||
  gcloud compute backend-services add-backend sacco-backend --global --network-endpoint-group sacco-neg --network-endpoint-group-region "$REGION" || true

# 2. Cloud Armor: OWASP rule sets in preview first (they log, they do not block), a
#    sign-in rate limit per address, and a general rate limit. Move the preview rules
#    to enforcing after a week of clean logs: gcloud compute security-policies rules update 1000 --security-policy sacco-armor --no-preview
have gcloud compute security-policies describe sacco-armor ||
  gcloud compute security-policies create sacco-armor --description "SACCO platform edge (security review CFG-2)"
rule() { have gcloud compute security-policies rules describe "$1" --security-policy sacco-armor || gcloud compute security-policies rules create "$1" --security-policy sacco-armor "${@:2}"; }
rule 1000 --expression "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})" --action deny-403 --preview
rule 1001 --expression "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})" --action deny-403 --preview
rule 1002 --expression "evaluatePreconfiguredWaf('lfi-v33-stable', {'sensitivity': 1})" --action deny-403 --preview
rule 1003 --expression "evaluatePreconfiguredWaf('rce-v33-stable', {'sensitivity': 1})" --action deny-403 --preview
rule 2000 --expression "request.path.matches('/api/(portal/)?auth/.*')" --action rate-based-ban \
  --rate-limit-threshold-count 60 --rate-limit-threshold-interval-sec 60 --ban-duration-sec 900 --conform-action allow --exceed-action deny-429 --enforce-on-key IP
rule 2100 --src-ip-ranges '*' --action throttle --rate-limit-threshold-count 1200 --rate-limit-threshold-interval-sec 60 \
  --conform-action allow --exceed-action deny-429 --enforce-on-key IP
gcloud compute backend-services update sacco-backend --global --security-policy sacco-armor

# 3. URL map, managed certificate, HTTPS proxy and a global address.
have gcloud compute url-maps describe sacco-lb --global || gcloud compute url-maps create sacco-lb --global --default-service sacco-backend
have gcloud compute ssl-certificates describe sacco-cert --global || gcloud compute ssl-certificates create sacco-cert --domains "$DOMAIN" --global
have gcloud compute ssl-policies describe sacco-tls --global || gcloud compute ssl-policies create sacco-tls --profile MODERN --min-tls-version 1.2 --global
have gcloud compute target-https-proxies describe sacco-https --global ||
  gcloud compute target-https-proxies create sacco-https --global --url-map sacco-lb --ssl-certificates sacco-cert --ssl-policy sacco-tls
have gcloud compute addresses describe sacco-ip --global || gcloud compute addresses create sacco-ip --global
have gcloud compute forwarding-rules describe sacco-https-rule --global ||
  gcloud compute forwarding-rules create sacco-https-rule --global --load-balancing-scheme EXTERNAL_MANAGED --address sacco-ip --target-https-proxy sacco-https --ports 443

IP=$(gcloud compute addresses describe sacco-ip --global --format='value(address)')
CERT=$(gcloud compute ssl-certificates describe sacco-cert --global --format='value(managed.status)')

# 4. Only the load balancer reaches the service (second pass, once the certificate is active).
if [ "${LOCK_INGRESS:-}" = yes ]; then
  [ "$CERT" = ACTIVE ] || { echo "The certificate is $CERT, not ACTIVE: ingress left open. Check the A record and try later." >&2; exit 1; }
  gcloud run services update "$SERVICE" --region "$REGION" --ingress internal-and-cloud-load-balancing
  echo "Done: https://$DOMAIN is the only way in."
else
  echo "Point $DOMAIN (A record, DNS only) at: $IP"
  echo "Certificate: $CERT. When it is ACTIVE, run again with LOCK_INGRESS=yes."
fi
