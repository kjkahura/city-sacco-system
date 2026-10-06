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
# Keep TRUST_PROXY=2 (client, then the load balancer). Firebase Hosting is no longer needed.
#
# The front ends, deployed apart from the API: with FRONTEND_BUCKET=<a new bucket name> the
# script also makes that bucket, lets the deploy job's service account publish to it, and,
# once the deploy job has published the console and portal there (repository variable
# FRONTEND_BUCKET), sends /console/* and /portal/* to the bucket and everything else to the
# service. Run it again after the first publish to switch the routing over. The headers the
# bucket's files carry are the ones src/lib/frontendHeaders.js sets; test/frontends.test.js
# checks the copies below against it.
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

# 3b. The front ends from a bucket (optional, FRONTEND_BUCKET).
CONSOLE_CSP="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
PORTAL_CSP="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
if [ -n "${FRONTEND_BUCKET:-}" ]; then
  DEPLOYER=${DEPLOYER:-sacco-deployer@$PROJECT.iam.gserviceaccount.com}
  if ! have gcloud storage buckets describe "gs://$FRONTEND_BUCKET"; then
    gcloud storage buckets create "gs://$FRONTEND_BUCKET" --location "$REGION" --uniform-bucket-level-access
  fi
  # A directory address (/console/) is answered with its index.html.
  gcloud storage buckets update "gs://$FRONTEND_BUCKET" --web-main-page-suffix index.html
  # The files are the public front ends and carry no secrets; the load balancer reads them anonymously
  # (anyone may also list and read them at storage.googleapis.com, without these headers and on another origin).
  if ! gcloud storage buckets add-iam-policy-binding "gs://$FRONTEND_BUCKET" --member allUsers --role roles/storage.objectViewer >/dev/null; then
    echo "The bucket cannot be made public: the organisation enforces public access prevention" >&2
    echo "(constraints/storage.publicAccessPrevention). Ask the organisation's administrator for an exception for" >&2
    echo "this project, or leave FRONTEND_BUCKET unset and keep the front ends on the service." >&2
    exit 1
  fi
  gcloud storage buckets add-iam-policy-binding "gs://$FRONTEND_BUCKET" --member "serviceAccount:$DEPLOYER" --role roles/storage.objectAdmin >/dev/null
  bucket() { # name, CSP
    local verb=create
    have gcloud compute backend-buckets describe "$1" && verb=update
    gcloud compute backend-buckets "$verb" "$1" --gcs-bucket-name "$FRONTEND_BUCKET" \
      --custom-response-header "Content-Security-Policy: $2" \
      --custom-response-header "X-Content-Type-Options: nosniff" \
      --custom-response-header "Referrer-Policy: same-origin" \
      --custom-response-header "Strict-Transport-Security: max-age=31536000; includeSubDomains"
  }
  bucket sacco-console "$CONSOLE_CSP"
  bucket sacco-portal "$PORTAL_CSP"
  if gcloud storage ls "gs://$FRONTEND_BUCKET/console/index.html" >/dev/null 2>&1 &&
     gcloud storage ls "gs://$FRONTEND_BUCKET/portal/index.html" >/dev/null 2>&1; then
    API="https://www.googleapis.com/compute/v1/projects/$PROJECT/global"
    cat > /tmp/sacco-lb.yaml <<YAML
name: sacco-lb
defaultService: $API/backendServices/sacco-backend
hostRules:
- hosts: ['*']
  pathMatcher: main
pathMatchers:
- name: main
  defaultService: $API/backendServices/sacco-backend
  routeRules:
  - priority: 1
    matchRules: [{fullPathMatch: /}, {fullPathMatch: /console}]
    urlRedirect: {pathRedirect: /console/, redirectResponseCode: FOUND}
  - priority: 2
    matchRules: [{fullPathMatch: /portal}]
    urlRedirect: {pathRedirect: /portal/, redirectResponseCode: FOUND}
  - priority: 3
    matchRules: [{prefixMatch: /console/}]
    service: $API/backendBuckets/sacco-console
  - priority: 4
    matchRules: [{prefixMatch: /portal/}]
    service: $API/backendBuckets/sacco-portal
YAML
    gcloud compute url-maps import sacco-lb --global --source /tmp/sacco-lb.yaml --quiet
    echo "Front ends: /console/ and /portal/ now come from gs://$FRONTEND_BUCKET."
  else
    echo "Front ends: gs://$FRONTEND_BUCKET is ready but empty. Set the repository variable FRONTEND_BUCKET=$FRONTEND_BUCKET,"
    echo "run the deploy workflow once, then run this script again to route /console/ and /portal/ to the bucket."
  fi
fi

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
