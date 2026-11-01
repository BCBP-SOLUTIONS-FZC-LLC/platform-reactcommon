#!/usr/bin/env bash
# The web deploy of examples/cloudfront/README.md, against floci (AWS emulator) — run by the compose
# service `web-deploy` (the floci compat image, used for its aws CLI) once floci is healthy:
#
#   1. S3: remotes first (/remotes/tenders/<version>/…, never overwritten), then /remotes/manifest.json
#      (with SRI), then the shell (hashed /assets first, /config/runtime.json, index.html last), then
#      /version.json last. Source maps are never uploaded (README "Deploy order").
#   2. Secrets Manager: the CloudFront → /csp-report origin secret (x-origin-verify).
#   3. Lambda: the /csp-report handler with a function URL (AuthType NONE).
#   4. CloudFront: response headers policy (generated from csp.mjs for this IdP origin), the spa-rewrite
#      CloudFront Function (published), WAF web ACL with rate rules, and the distribution with the
#      behaviors of the README / design doc "CloudFront behaviors", in precedence order.
#   5. Writes what the edge shim needs to /state/cloudfront (the distribution config as floci holds it,
#      the function code as published, the response headers policy).
#
# Inputs (mounted): /work (test/stack/.state: web builds, lambda zip, generated policy), /state (same dir).
set -euo pipefail

export AWS_DEFAULT_REGION=ap-south-1 AWS_REGION=ap-south-1
export AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://floci:4566}
BUCKET=web-origin
WORK=/work
OUT=/work/cloudfront
REMOTE_VERSION=${REMOTE_VERSION:?}
SET_CACHE_CONTROL=${DEPLOY_SET_CACHE_CONTROL:-true}
IMMUTABLE='public, max-age=31536000, immutable'
NO_CACHE='no-cache'
log() { echo "[deploy-web] $*"; }

cc() { # --cache-control flag, unless reproducing the README-literal upload (no metadata)
  if [ "$SET_CACHE_CONTROL" = "true" ]; then printf -- '--cache-control\n%s\n' "$1"; fi
}
cp_dir() { # src dst cache-control
  local args=(); while IFS= read -r a; do args+=("$a"); done < <(cc "$3")
  aws s3 cp --recursive --only-show-errors "$1" "s3://$BUCKET/$2" --exclude '*.map' "${args[@]}"
}
cp_file() { # src key content-type cache-control
  local args=(); while IFS= read -r a; do args+=("$a"); done < <(cc "$4")
  aws s3 cp --only-show-errors "$1" "s3://$BUCKET/$2" --content-type "$3" "${args[@]}"
}

# ── 1. S3 ─────────────────────────────────────────────────────────────────────────────────────
aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint=ap-south-1 >/dev/null 2>&1 || true
if aws s3api head-object --bucket "$BUCKET" --key "remotes/tenders/$REMOTE_VERSION/remoteEntry.js" >/dev/null 2>&1; then
  log "remotes/tenders/$REMOTE_VERSION already uploaded: versions are never overwritten"
else
  cp_dir "$WORK/web/remote" "remotes/tenders/$REMOTE_VERSION" "$IMMUTABLE"
fi
cp_file "$WORK/web/manifest.json" remotes/manifest.json application/json "$NO_CACHE"
cp_dir "$WORK/web/shell/assets" assets "$IMMUTABLE"
cp_file "$WORK/web/runtime.json" config/runtime.json application/json "$NO_CACHE"
cp_file "$WORK/web/shell/index.html" index.html 'text/html; charset=utf-8' "$NO_CACHE"
cp_file "$WORK/web/version.json" version.json application/json "$NO_CACHE"
log "s3://$BUCKET: $(aws s3 ls --recursive "s3://$BUCKET" | wc -l) objects"

# ── 2. Secrets Manager ────────────────────────────────────────────────────────────────────────
SECRET_ID=platform/csp-report/origin-verify
SECRET=$(cat "$WORK/origin-verify.secret")
if aws secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "$SECRET" >/dev/null
else
  aws secretsmanager create-secret --name "$SECRET_ID" --secret-string "$SECRET" >/dev/null
fi
# What IaC does at deploy: resolve the secret into both the origin header and the Lambda environment.
RESOLVED=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text)

# ── 3. Lambda (/csp-report) ───────────────────────────────────────────────────────────────────
FN=csp-report
aws lambda delete-function --function-name "$FN" >/dev/null 2>&1 || true
aws lambda create-function --function-name "$FN" --runtime nodejs22.x --handler index.handler \
  --role arn:aws:iam::000000000000:role/csp-report --timeout 10 --memory-size 128 \
  --zip-file "fileb://$WORK/lambda/csp-report.zip" \
  --environment "Variables={ORIGIN_VERIFY_SECRET=$RESOLVED,COLLECTOR_LOGS_URL=http://otel-collector:4319/v1/logs,SERVICE_NAMESPACE=portal,DEPLOYMENT_ENVIRONMENT=staging}" >/dev/null
for _ in $(seq 1 30); do
  [ "$(aws lambda get-function --function-name "$FN" --query Configuration.State --output text)" = "Active" ] && break
  sleep 1
done
LAMBDA_URL=$(aws lambda create-function-url-config --function-name "$FN" --auth-type NONE --query FunctionUrl --output text)
LAMBDA_HOST=$(echo "$LAMBDA_URL" | sed -E 's#^https?://([^/:]+).*#\1#')
log "lambda $FN: $LAMBDA_URL"

# The same handler behind a one-line wrapper that calls handler(event) — the suggested fix for the report's
# "Lambda passes (event, context)" issue. Not wired to CloudFront; the e2e suite posts to it directly.
FIXED=csp-report-fixed
aws lambda delete-function --function-name "$FIXED" >/dev/null 2>&1 || true
aws lambda create-function --function-name "$FIXED" --runtime nodejs22.x --handler fixed.handler \
  --role arn:aws:iam::000000000000:role/csp-report --timeout 10 --memory-size 128 \
  --zip-file "fileb://$WORK/lambda/csp-report-fixed.zip" \
  --environment "Variables={ORIGIN_VERIFY_SECRET=$RESOLVED,COLLECTOR_LOGS_URL=http://otel-collector:4319/v1/logs,SERVICE_NAMESPACE=portal,DEPLOYMENT_ENVIRONMENT=staging}" >/dev/null
for _ in $(seq 1 30); do
  [ "$(aws lambda get-function --function-name "$FIXED" --query Configuration.State --output text)" = "Active" ] && break
  sleep 1
done
FIXED_URL=$(aws lambda create-function-url-config --function-name "$FIXED" --auth-type NONE --query FunctionUrl --output text)
echo "{\"cspReportFixedHost\": \"$(echo "$FIXED_URL" | sed -E 's#^https?://([^/:]+).*#\1#')\"}" > "$OUT/lambda-fixed.json"
log "lambda $FIXED: $FIXED_URL"

# ── 4. CloudFront ─────────────────────────────────────────────────────────────────────────────
# Re-runs (same floci): reuse the policy of that name, updated to this config.
RHP_NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Name"])' "$OUT/response-headers-policy.json")
RHP_ID=$(aws cloudfront list-response-headers-policies --type custom --output json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin).get("ResponseHeadersPolicyList",{}).get("Items",[]) or []
print(next((i["ResponseHeadersPolicy"]["Id"] for i in d if i["ResponseHeadersPolicy"]["ResponseHeadersPolicyConfig"]["Name"]==sys.argv[1]),""))' "$RHP_NAME" || true)
if [ -z "$RHP_ID" ]; then
  RHP_ID=$(aws cloudfront create-response-headers-policy \
    --response-headers-policy-config "file://$OUT/response-headers-policy.json" --query ResponseHeadersPolicy.Id --output text)
else
  RHP_ETAG=$(aws cloudfront get-response-headers-policy --id "$RHP_ID" --query ETag --output text)
  aws cloudfront update-response-headers-policy --id "$RHP_ID" --if-match "$RHP_ETAG" \
    --response-headers-policy-config "file://$OUT/response-headers-policy.json" >/dev/null
fi
aws cloudfront create-function --name spa-rewrite-e2e \
  --function-config 'Comment=SPA rewrite (examples/cloudfront/spa-rewrite.js),Runtime=cloudfront-js-2.0' \
  --function-code "fileb://$OUT/spa-rewrite.js" >/dev/null 2>&1 || true
ETAG=$(aws cloudfront describe-function --name spa-rewrite-e2e --query ETag --output text)
aws cloudfront update-function --name spa-rewrite-e2e --if-match "$ETAG" \
  --function-config 'Comment=SPA rewrite (examples/cloudfront/spa-rewrite.js),Runtime=cloudfront-js-2.0' \
  --function-code "fileb://$OUT/spa-rewrite.js" >/dev/null 2>&1 || true
ETAG=$(aws cloudfront describe-function --name spa-rewrite-e2e --query ETag --output text)
FN_ARN=$(aws cloudfront publish-function --name spa-rewrite-e2e --if-match "$ETAG" --query FunctionSummary.FunctionMetadata.FunctionARN --output text)
aws cloudfront get-function --name spa-rewrite-e2e --stage LIVE "$OUT/spa-rewrite.live.js" >/dev/null

# WAF (CLOUDFRONT scope lives in us-east-1): rate rules on /otel/* and /csp-report (README behaviors).
python3 - > /tmp/waf.json <<'PY'
import json, base64
def rule(name, prio, path, limit):
    return {"Name": name, "Priority": prio, "Action": {"Block": {}},
            "VisibilityConfig": {"SampledRequestsEnabled": True, "CloudWatchMetricsEnabled": True, "MetricName": name},
            "Statement": {"RateBasedStatement": {"Limit": limit, "EvaluationWindowSec": 60, "AggregateKeyType": "IP",
              "ScopeDownStatement": {"ByteMatchStatement": {"SearchString": base64.b64encode(path.encode()).decode(), "FieldToMatch": {"UriPath": {}},
                "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "STARTS_WITH"}}}}}
print(json.dumps({"Name": "platform-web-e2e", "Scope": "CLOUDFRONT", "DefaultAction": {"Allow": {}},
  "VisibilityConfig": {"SampledRequestsEnabled": True, "CloudWatchMetricsEnabled": True, "MetricName": "platform-web-e2e"},
  "Rules": [rule("otel-rate", 1, "/otel/", 100), rule("csp-report-rate", 2, "/csp-report", 100)]}))
PY
WAF_ARN=$(aws wafv2 list-web-acls --region us-east-1 --scope CLOUDFRONT --query "WebACLs[?Name=='platform-web-e2e'].ARN | [0]" --output text 2>/dev/null || true)
[ "$WAF_ARN" = "None" ] && WAF_ARN=""
[ -n "$WAF_ARN" ] || WAF_ARN=$(aws wafv2 create-web-acl --region us-east-1 --scope CLOUDFRONT --cli-input-json file:///tmp/waf.json --query Summary.ARN --output text || echo "")
log "waf: ${WAF_ARN:-<create-web-acl failed>}"

CALLER_REF="e2e-$(date +%s)"
export BUCKET LAMBDA_HOST RESOLVED RHP_ID FN_ARN WAF_ARN CALLER_REF
python3 - <<'PY' > /tmp/dist.json
import json, os
E = os.environ
CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"   # managed policies
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
ALL = {"Quantity": 7, "Items": ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"], "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}}
GET = {"Quantity": 2, "Items": ["GET", "HEAD"], "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}}
def custom(oid, host, port, headers=None):
    o = {"Id": oid, "DomainName": host, "OriginPath": "",
         "CustomOriginConfig": {"HTTPPort": port, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only",
                                "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
                                "OriginReadTimeout": 30, "OriginKeepaliveTimeout": 5},
         "CustomHeaders": {"Quantity": len(headers or []), "Items": headers or []}, "OriginAccessControlId": ""}
    return o
def behavior(path, origin, cache, methods=GET, rhp=True, orp=None, fn=False):
    b = {"TargetOriginId": origin, "ViewerProtocolPolicy": "redirect-to-https", "AllowedMethods": methods,
         "Compress": True, "CachePolicyId": cache, "SmoothStreaming": False, "FieldLevelEncryptionId": "",
         "TrustedSigners": {"Enabled": False, "Quantity": 0}, "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
         "LambdaFunctionAssociations": {"Quantity": 0},
         "FunctionAssociations": {"Quantity": 1, "Items": [{"FunctionARN": E["FN_ARN"], "EventType": "viewer-request"}]} if fn else {"Quantity": 0}}
    if path: b["PathPattern"] = path
    if rhp: b["ResponseHeadersPolicyId"] = E["RHP_ID"]
    if orp: b["OriginRequestPolicyId"] = orp
    return b
origins = [
    {"Id": "s3-web", "DomainName": f'{E["BUCKET"]}.s3.ap-south-1.amazonaws.com', "OriginPath": "",
     "S3OriginConfig": {"OriginAccessIdentity": ""}, "CustomHeaders": {"Quantity": 0}, "OriginAccessControlId": ""},
    custom("api-gateway", "envoy", 10000),
    custom("otel-collector", "otel-collector", 4318),
    custom("csp-report", E["LAMBDA_HOST"], 4566, [{"HeaderName": "x-origin-verify", "HeaderValue": E["RESOLVED"]}]),
]
behaviors = [
    behavior("/api/*", "api-gateway", CACHING_DISABLED, ALL, rhp=False, orp=ALL_VIEWER_EXCEPT_HOST),
    behavior("/otel/*", "otel-collector", CACHING_DISABLED, ALL),
    behavior("/csp-report", "csp-report", CACHING_DISABLED, ALL),
    behavior("/config/runtime.json", "s3-web", CACHING_DISABLED),
    behavior("/version.json", "s3-web", CACHING_DISABLED),
    behavior("/remotes/manifest.json", "s3-web", CACHING_DISABLED),
    behavior("/remotes/*", "s3-web", CACHING_OPTIMIZED),
    behavior("/assets/*", "s3-web", CACHING_OPTIMIZED),
]
cfg = {"CallerReference": E["CALLER_REF"], "Comment": "platform web (reactcommon e2e)", "Enabled": True,
       "Aliases": {"Quantity": 1, "Items": ["app.localtest.me"]}, "DefaultRootObject": "index.html",
       "Origins": {"Quantity": len(origins), "Items": origins},
       "DefaultCacheBehavior": behavior(None, "s3-web", CACHING_DISABLED, fn=True),
       "CacheBehaviors": {"Quantity": len(behaviors), "Items": behaviors},
       "CustomErrorResponses": {"Quantity": 0}, "PriceClass": "PriceClass_All", "HttpVersion": "http2and3",
       "IsIPV6Enabled": True, "WebACLId": E.get("WAF_ARN", "")}
print(json.dumps(cfg))
PY
EXISTING=$(aws cloudfront list-distributions --output json | python3 -c '
import json,sys
items=(json.load(sys.stdin).get("DistributionList") or {}).get("Items") or []
print(next((d["Id"] for d in items if "app.localtest.me" in ((d.get("Aliases") or {}).get("Items") or [])),""))')
if [ -z "$EXISTING" ]; then
  DIST_ID=$(aws cloudfront create-distribution --distribution-config file:///tmp/dist.json --query Distribution.Id --output text)
else
  # Re-deploy: update in place (CallerReference must stay the original one).
  DIST_ID=$EXISTING
  aws cloudfront get-distribution-config --id "$DIST_ID" --output json > /tmp/current.json
  ETAG=$(python3 -c 'import json; print(json.load(open("/tmp/current.json"))["ETag"])')
  python3 -c '
import json
cur=json.load(open("/tmp/current.json"))["DistributionConfig"]; new=json.load(open("/tmp/dist.json"))
new["CallerReference"]=cur["CallerReference"]; json.dump(new, open("/tmp/dist.json","w"))'
  aws cloudfront update-distribution --id "$DIST_ID" --if-match "$ETAG" --distribution-config file:///tmp/dist.json >/dev/null
fi
log "distribution $DIST_ID"

# ── 5. State for the edge shim ────────────────────────────────────────────────────────────────
aws cloudfront get-distribution --id "$DIST_ID" --output json > "$OUT/distribution.tmp.json"
aws cloudfront get-response-headers-policy --id "$RHP_ID" --output json > "$OUT/response-headers-policy.live.json"
WAF_LIVE=""
[ -n "$WAF_ARN" ] && WAF_LIVE=$(aws wafv2 get-web-acl --region us-east-1 --scope CLOUDFRONT --name platform-web-e2e --id "$(echo "$WAF_ARN" | awk -F/ '{print $NF}')" --output json 2>/dev/null || echo "")
echo "${WAF_LIVE:-{\}}" > "$OUT/waf.live.json"
mv "$OUT/distribution.tmp.json" "$OUT/distribution.json"
log "done: distribution $DIST_ID ($(python3 -c 'import json; print(json.load(open("'"$OUT"'/distribution.json"))["Distribution"]["DomainName"])'))"
