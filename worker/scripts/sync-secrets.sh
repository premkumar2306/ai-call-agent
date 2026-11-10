#!/usr/bin/env bash
# Pushes secrets from the repo-root .env to where they're actually read:
#   Cloudflare (wrangler secret)  — what the running Worker uses
#   GitHub Actions (gh secret)    — what the deploy / synthetic-call workflows use
#
# Usage (from worker/):  ./scripts/sync-secrets.sh                    # dry run: lists what would be set
#                        ./scripts/sync-secrets.sh --apply            # sets missing ones
#                        ./scripts/sync-secrets.sh --apply --overwrite # also replaces existing ones
# Only keys listed below are synced, and only when .env has a non-empty value.
# Secrets that already exist are left alone unless --overwrite: .env may hold
# dev values, and replacing production's CUSTOMER_HASH_SALT re-keys every
# customer, TOKEN_SECRET logs everyone out.
# Values are piped straight from .env; nothing is printed.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=../.env
APPLY=${1:-}
OVERWRITE=${2:-}
# Fail closed: if the current secrets can't be listed we can't tell what
# would be overwritten. (Wrangler needs Node 22+: `nvm use 24`.)
CF_LIST=$(npx wrangler secret list 2>&1) || { echo "wrangler secret list failed:"; echo "$CF_LIST" | head -3; exit 1; }
EXISTING_CF=$(grep -o '"name": *"[^"]*"' <<<"$CF_LIST" | sed 's/.*"\([^"]*\)"$/\1/')
GH_LIST=$(gh secret list 2>&1) || { echo "gh secret list failed:"; echo "$GH_LIST" | head -3; exit 1; }
EXISTING_GH=$(cut -f1 <<<"$GH_LIST")

# Read by the Worker at runtime.
WORKER_KEYS=(
  ANTHROPIC_API_KEY DEEPGRAM_API_KEY CARTESIA_API_KEY CARTESIA_VOICE_ID
  TOKEN_SECRET CUSTOMER_HASH_SALT ADMIN_SECRET TWILIO_AUTH_TOKEN
  CALENDAR_TOKEN_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
  RESEND_API_KEY TWILIO_ACCOUNT_SID TWILIO_SMS_FROM
  EXOTEL_WEBHOOK_SECRET PLIVO_AUTH_TOKEN PLIVO_WEBHOOK_URL
)
# Read by GitHub Actions workflows.
GITHUB_KEYS=(
  CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN SYNTHETIC_FROM_NUMBER SYNTHETIC_TO_NUMBER SYNTHETIC_ADMIN_KEY
  ANTHROPIC_API_KEY DEEPGRAM_API_KEY   # the Claude-played callers in svt/
)

value() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
# The admin key lives in .env as AVERY_SECRET; the synthetic-call workflow wants it as SYNTHETIC_ADMIN_KEY.
alias_of() { case $1 in SYNTHETIC_ADMIN_KEY) echo AVERY_SECRET ;; *) echo "$1" ;; esac; }

sync() {
  local where=$1; shift
  for k in "$@"; do
    v=$(value "$k" || true); [ -n "$v" ] || v=$(value "$(alias_of "$k")" || true)
    if [ -z "$v" ]; then echo "  skip  $k (not in .env)"; continue; fi
    existing=$EXISTING_GH; [ "$where" = cloudflare ] && existing=$EXISTING_CF
    if grep -qx "$k" <<<"$existing" && [ "$OVERWRITE" != "--overwrite" ]; then echo "  keep  $k (already set in $where)"; continue; fi
    if [ "$APPLY" != "--apply" ]; then echo "  would set $k → $where"; continue; fi
    if [ "$where" = cloudflare ]; then printf '%s' "$v" | npx wrangler secret put "$k" >/dev/null
    else printf '%s' "$v" | gh secret set "$k" >/dev/null; fi
    echo "  set   $k → $where"
  done
}

echo "Cloudflare Worker secrets:"; sync cloudflare "${WORKER_KEYS[@]}"
echo "GitHub Actions secrets:";    sync github "${GITHUB_KEYS[@]}"
[ "$APPLY" = "--apply" ] || echo "Dry run. Re-run with --apply to set them."
