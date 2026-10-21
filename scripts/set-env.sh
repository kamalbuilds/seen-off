#!/usr/bin/env bash
# set-env.sh KEY [VALUE]: writes KEY=VALUE into ring/.env (replacing the line, keeping the file's mode). VALUE comes from stdin when omitted, so a secret never sits in argv or the terminal.
set -euo pipefail
f="$(dirname "$0")/../.env"
k="$1"; v="${2:-$(cat)}"
touch "$f"
grep -v "^${k}=" "$f" > "$f.tmp" || true
printf '%s=%s\n' "$k" "$v" >> "$f.tmp"
cat "$f.tmp" > "$f"; rm -f "$f.tmp"
