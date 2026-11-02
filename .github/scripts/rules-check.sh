#!/usr/bin/env bash
# promtool syntax check and alert unit tests for monitoring/prometheus (pnpm run rules-check), as
# platform-events' `make rules-check`. Registry and proposed-group compliance is
# test/unit/monitoring's job; this is promtool only.
set -euo pipefail

PROMETHEUS_IMAGE="${PROMETHEUS_IMAGE:-prom/prometheus:v3.5.0@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996}"
dir="$(cd "$(dirname "$0")/../../monitoring/prometheus" && pwd)"

# Globs are expanded here: the image's promtool runs without a shell.
cd "$dir"
rules=(*.rules.yml)
tests=(*.rules.test.yml)
docker run --rm -v "$dir":/rules:ro -w /rules --entrypoint promtool "$PROMETHEUS_IMAGE" check rules "${rules[@]}"
docker run --rm -v "$dir":/rules:ro -w /rules --entrypoint promtool "$PROMETHEUS_IMAGE" test rules "${tests[@]}"
