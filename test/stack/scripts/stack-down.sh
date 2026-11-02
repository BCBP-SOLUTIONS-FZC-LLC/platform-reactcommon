#!/usr/bin/env bash
# pnpm run stack-down: stops the stack and removes its containers, network and volumes, plus the Lambda
# runtime containers floci started on the stack network (they are not compose-managed). Keeps .state
# (the certificate and builds) and the images; `--purge` also removes .state and the locally built images.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENV_FILE="$ROOT/.state/stack.env"
[ -f "$ENV_FILE" ] || ENV_FILE=/dev/null
lambdas=$(docker ps -aq --filter label=io.floci.service=lambda --filter network=reactcommon-e2e)
[ -n "$lambdas" ] && docker rm -f $lambdas >/dev/null
GO_PRIVATE_TOKEN= docker compose -f "$ROOT/docker-compose.yml" --env-file "$ENV_FILE" down -v --remove-orphans
lambdas=$(docker ps -aq --filter label=io.floci.service=lambda --filter network=reactcommon-e2e)
[ -n "$lambdas" ] && docker rm -f $lambdas >/dev/null
docker network rm reactcommon-e2e >/dev/null 2>&1 || true
if [ "${1:-}" = "--purge" ]; then
  docker image rm reactcommon-e2e/iam-org-membership:local reactcommon-e2e/iam-authz-enrichment:local reactcommon-e2e/go-probe:local 2>/dev/null || true
  rm -rf "$ROOT/.state"
fi
