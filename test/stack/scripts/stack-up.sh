#!/usr/bin/env bash
# pnpm run stack-up: render .state, build the images (IAM services need a GitHub token for their private Go
# modules: taken from `gh auth token` into the environment and handed to BuildKit as a secret, never
# written to a file or printed), start the stack and wait until the distribution is deployed.
# Usage: stack-up.sh [--skip-build]   (--skip-build reuses .state/web from the last run)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"

node "$HERE/prepare.mjs" "$@"
COMPOSE=(docker compose -f "$ROOT/docker-compose.yml" --env-file "$ROOT/.state/stack.env")

if [ -z "${GO_PRIVATE_TOKEN:-}" ]; then
  GO_PRIVATE_TOKEN="$(gh auth token 2>/dev/null || true)"
  [ -n "$GO_PRIVATE_TOKEN" ] || { echo "stack-up: set GO_PRIVATE_TOKEN or log in with gh (private Go modules)"; exit 1; }
fi
export GO_PRIVATE_TOKEN
"${COMPOSE[@]}" build
unset GO_PRIVATE_TOKEN

# Collector output and edge logs start empty on every stack-up.
rm -f "$ROOT/.state/otel/"*.jsonl "$ROOT/.state/logs/"*.jsonl "$ROOT/.state/cloudfront/distribution.json"
GO_PRIVATE_TOKEN= "${COMPOSE[@]}" up -d --wait --wait-timeout 600 \
  floci otel-collector keycloak valkey postgres pgbouncer org-membership authz-enrichment go-probe envoy
GO_PRIVATE_TOKEN= "${COMPOSE[@]}" up --no-deps org-membership-seed web-deploy
GO_PRIVATE_TOKEN= "${COMPOSE[@]}" up -d --wait --wait-timeout 120 edge

# Ready when the shell, the gateway and the IdP answer through the viewer entry.
port=$(grep '^STACK_HTTPS_PORT=' "$ROOT/.state/stack.env" | cut -d"'" -f2)
for i in $(seq 1 60); do
  if curl -skf --resolve "app.localtest.me:$port:127.0.0.1" "https://app.localtest.me:$port/" -o /dev/null \
    && curl -skf --resolve "app.localtest.me:$port:127.0.0.1" "https://app.localtest.me:$port/api/v1/public/tenants/resolve?identifier=acme" -o /dev/null \
    && curl -skf --resolve "auth.localtest.me:$port:127.0.0.1" "https://auth.localtest.me:$port/realms/tenant-acme/.well-known/openid-configuration" -o /dev/null; then
    echo "stack-up: ready (https://app.localtest.me$( [ "$port" = 443 ] || echo ":$port"))"
    exit 0
  fi
  sleep 2
done
echo "stack-up: the stack did not become ready"; "${COMPOSE[@]}" ps; exit 1
