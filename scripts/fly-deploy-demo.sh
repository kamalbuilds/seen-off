#!/usr/bin/env bash
# Deploys the public read-only replay demo (fly.demo.toml). The Bedrock key goes over stdin as the app's only secret.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$(sed -n 's/^app = "\(.*\)"/\1/p' fly.demo.toml)"
fly status -a "$APP" >/dev/null 2>&1 || fly apps create "$APP"
if [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ]; then
  printf 'AWS_BEARER_TOKEN_BEDROCK=%s\n' "$AWS_BEARER_TOKEN_BEDROCK" | fly secrets import -a "$APP" --stage >/dev/null
  echo "bedrock key staged"
fi
fly deploy -c fly.demo.toml -a "$APP" --ha=false
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$APP.fly.dev/health" || true)"
  [ "$code" = 200 ] && break
  sleep 5
done
[ "$code" = 200 ] || { echo "health check failed: HTTP $code" >&2; exit 1; }
echo "Deployed: https://$APP.fly.dev"
