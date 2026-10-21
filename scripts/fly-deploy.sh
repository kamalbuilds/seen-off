#!/usr/bin/env bash
# Deploys this server to Fly.io (app and region from fly.toml) and prints the Ring Developer Portal URLs.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="$(sed -n 's/^app = "\(.*\)"/\1/p' fly.toml)"
REGION="$(sed -n 's/^primary_region = "\(.*\)"/\1/p' fly.toml)"
URL="https://$APP.fly.dev"

fly auth whoami >/dev/null 2>&1 || { echo "fly: not logged in. Run: fly auth login" >&2; exit 3; }

fly status -a "$APP" >/dev/null 2>&1 || fly apps create "$APP"
fly volumes list -a "$APP" 2>/dev/null | grep -qw data || fly volumes create data -a "$APP" -r "$REGION" -s 1 -y

# Every non-empty .env value becomes a Fly secret, except ones that differ on the server. Values go over stdin, never argv or logs.
node -e '
const { parseEnv } = require("node:util");
const e = parseEnv(require("fs").readFileSync(".env", "utf8"));
const skip = new Set(["WHEP_PYTHON", "OUTBOX_PUBLIC_URL", "RING_REDIRECT_URI", "PORT"]);
for (const k of ["AWS_BEARER_TOKEN_BEDROCK"]) if (!e[k] && process.env[k]) e[k] = process.env[k];
for (const [k, v] of Object.entries(e)) if (v && !skip.has(k)) process.stdout.write(`${k}=${v}\n`);
process.stdout.write(`OUTBOX_PUBLIC_URL=${process.argv[1]}\n`);
' "$URL" | fly secrets import -a "$APP" --stage >/dev/null
echo "secrets staged"

grep -q '^OUTBOX_PUBLIC_URL=' .env \
  && sed -i.bak "s#^OUTBOX_PUBLIC_URL=.*#OUTBOX_PUBLIC_URL=$URL#" .env && rm -f .env.bak \
  || echo "OUTBOX_PUBLIC_URL=$URL" >> .env

fly deploy -a "$APP" --ha=false

for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$URL/health" || true)"
  [ "$code" = 200 ] && break
  sleep 5
done
[ "$code" = 200 ] || { echo "health check failed: HTTP $code at $URL/health" >&2; exit 1; }

cat <<EOF
Deployed: $URL (health 200)
Ring Developer Portal, Account linking:
  Account Link URL:    $URL/ring/link
  Token Exchange URL:  $URL/ring/oauth/token
  App Homepage URL:    $URL/
  Webhook URL:         $URL/ring/webhook
EOF
