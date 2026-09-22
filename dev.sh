#!/usr/bin/env bash
set -e

# ── Avery Platform Local Dev ──────────────────────────────────────────────────
# Runs worker + web together and tails their logs.
# Usage:
#   ./dev.sh            — worker + web
#   ./dev.sh worker     — worker only
#   ./dev.sh web        — web only

ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-default}"
PIDS=()

cleanup() {
  echo ""
  echo "▶ stopping…"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

start() {
  local name="$1" dir="$2" cmd="$3"
  ( cd "$ROOT/$dir" && exec $cmd ) 2>&1 | sed -u "s/^/[$name] /" &
  PIDS+=("$!")
}

start_worker() { echo "▶ worker  → http://localhost:8787"; start worker worker "npm run dev"; }
start_web()    { echo "▶ web     → http://localhost:5173"; start web web "npm run dev"; }

case "$TARGET" in
  worker)  start_worker ;;
  web)     start_web ;;
  default) start_worker; start_web ;;
  *)
    echo "Usage: ./dev.sh [worker|web]"
    exit 1
    ;;
esac

echo ""
echo "✓ running — ctrl-c to stop"
wait
