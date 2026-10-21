#!/usr/bin/env bash
# Deploys this server to Railway under the railway-multi profile (default: personal) and prints the Ring Developer Portal URLs.
# Env values are read from .env and sent over stdin; none is printed. Sign in first with `railway-multi add personal` if whoami fails.
set -euo pipefail
cd "$(dirname "$0")/.."
P="${RAILWAY_PROFILE:-personal}"
SERVICE="${RAILWAY_SERVICE:-outbox}"
rw() { railway-multi "$P" "$@"; }

railway-multi whoami "$P" >/dev/null 2>&1 || { echo "Railway profile '$P' is not signed in. Run: railway-multi add $P" >&2; exit 3; }
rw status >/dev/null 2>&1 || rw init --name outbox-ring
rw service status >/dev/null 2>&1 || rw add --service "$SERVICE"
rw volume list 2>/dev/null | grep -q "/app/data" || rw volume add --mount-path /app/data

# Every non-empty .env value goes to the service except the ones that differ on the server. Names only are printed.
node -e '
const { parseEnv } = require("node:util");
const e = parseEnv(require("fs").readFileSync(".env", "utf8"));
const skip = new Set(["WHEP_PYTHON", "OUTBOX_PUBLIC_URL", "RING_REDIRECT_URI", "PORT"]);
for (const [k, v] of Object.entries(e)) if (v && !skip.has(k)) console.log(k);
' | while read -r key; do
  node -e 'process.stdout.write(require("node:util").parseEnv(require("fs").readFileSync(".env", "utf8"))[process.argv[1]])' "$key" \
    | rw variable set "$key" --stdin --skip-deploys >/dev/null
  echo "set $key"
done
rw variable set PORT=8080 --skip-deploys >/dev/null

DOMAIN="$(rw domain --port 8080 2>&1 | grep -Eo '[a-z0-9-]+\.up\.railway\.app' | head -1 || true)"
[ -n "$DOMAIN" ] || DOMAIN="$(rw domain list 2>&1 | grep -Eo '[a-z0-9-]+\.up\.railway\.app' | head -1)"
[ -n "$DOMAIN" ] || { echo "no Railway domain found" >&2; exit 4; }
URL="https://$DOMAIN"
rw variable set "OUTBOX_PUBLIC_URL=$URL" --skip-deploys >/dev/null
scripts/set-env.sh OUTBOX_PUBLIC_URL "$URL"

rw up --ci
for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/health")" = 200 ] && break
  [ "$i" = 60 ] && { echo "$URL/health did not return 200 within 5 minutes" >&2; exit 5; }
  sleep 5
done
OUTBOX_PUBLIC_URL="$URL" node scripts/ring-setup.ts
