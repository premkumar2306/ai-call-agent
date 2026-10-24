#!/usr/bin/env bash
set -euo pipefail

# ── Avery Platform Deploy ─────────────────────────────────────────────────────
# Usage:
#   ./deploy.sh          — deploy both worker + web
#   ./deploy.sh worker   — deploy worker only
#   ./deploy.sh web      — deploy web only
#   ./deploy.sh migrate  — run DB migrations only

TARGET="${1:-all}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

deploy_worker() {
  echo ""
  echo "▶ Worker"
  cd "$ROOT/worker"
  echo "  type-check + tests…"
  npm run check
  echo "  deploying…"
  npm run deploy
  cd - > /dev/null
}

deploy_web() {
  echo ""
  echo "▶ Web"
  cd "$ROOT/web"
  echo "  building…"
  npm run build
  echo "  deploying to Pages…"
  npm run deploy
  cd - > /dev/null
}

run_migrate() {
  echo ""
  echo "▶ DB Migrations"
  cd "$ROOT/worker"
  npm run db:migrate
  cd - > /dev/null
}

case "$TARGET" in
  worker)  deploy_worker ;;
  web)     deploy_web ;;
  migrate) run_migrate ;;
  all)
    run_migrate
    deploy_worker
    deploy_web
    echo ""
    echo "✓ Done — migrations, worker + web deployed"
    ;;
  *)
    echo "Usage: ./deploy.sh [worker|web|migrate|all]"
    exit 1
    ;;
esac
