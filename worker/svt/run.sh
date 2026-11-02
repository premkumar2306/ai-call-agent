#!/usr/bin/env bash
# Synthetic voice tests (SVT): Claude-played callers phone the production
# voice agent over the same media stream a real call uses, one call per
# persona, and report what each caller waited per turn.
#
# Usage (from worker/):  ./svt/run.sh            # every persona
#                        ./svt/run.sh 3 5        # just these personas
# Needs ADMIN_KEY, ANTHROPIC_API_KEY and DEEPGRAM_API_KEY — taken from the
# environment (GitHub Actions) or else the repo-root .env (ADMIN_KEY from
# AVERY_SECRET). Needs macOS `say` and ffmpeg, so CI runs on a macOS runner.
#
# Every run cancels the previous run's test bookings (and their calendar
# events), so the booking persona goes last and its appointment stays
# visible in the business's calendar until the next run.
# Exits non-zero if any call left the caller without a reply, or the median
# wait across all calls is over SVT_MAX_MEDIAN_MS (default 2500).
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=${SVT_OUT:-svt/results}
mkdir -p "$OUT"

env_get() { [ -f ../.env ] && grep -E "^$1=" ../.env | tail -1 | cut -d= -f2- | tr -d "\"'"; }
export ADMIN_KEY=${ADMIN_KEY:-$(env_get AVERY_SECRET)}
export ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-$(env_get ANTHROPIC_API_KEY)}
export DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-$(env_get DEEPGRAM_API_KEY)}
for k in ADMIN_KEY ANTHROPIC_API_KEY DEEPGRAM_API_KEY; do
  [ -n "${!k}" ] || { echo "$k is not set"; exit 2; }
done

# Persona 3 books an appointment; keep it last (see above).
PERSONAS=("$@"); [ ${#PERSONAS[@]} -gt 0 ] || PERSONAS=(0 1 2 4 5 6 7 3)

failed=0; waits=()
SUMMARY="| persona | median wait | worst wait | result |\n|---|---|---|---|\n"
for p in "${PERSONAS[@]}"; do
  log="$OUT/persona-$p.txt"
  echo "── persona $p ──"
  # 7-minute cap per call (perl: macOS has no `timeout`).
  perl -e 'alarm shift; exec @ARGV' 420 node svt/latency-test.mjs --persona "$p" > "$log" 2>&1; status=$?
  grep -E "^Persona:|^  [0-9]+\. CALLER|^     \(|^median|^FAILED" "$log"
  median=$(sed -nE 's/^median e2e ([0-9]+) ms, worst ([0-9]+) ms/\1/p' "$log")
  worst=$(sed -nE 's/^median e2e ([0-9]+) ms, worst ([0-9]+) ms/\2/p' "$log")
  # Every caller wait, for the overall median.
  waits+=($(sed -nE 's/^     \(([0-9]+) ms\).*/\1/p' "$log"))
  result=pass; [ $status -eq 0 ] || { result="FAIL ($status)"; failed=1; }
  SUMMARY+="| $p | ${median:-—} ms | ${worst:-—} ms | $result |\n"
done

overall=—
if [ ${#waits[@]} -gt 0 ]; then
  sorted=($(printf '%s\n' "${waits[@]}" | sort -n))
  overall=${sorted[$(( ${#sorted[@]} / 2 ))]}
  [ "$overall" -le "${SVT_MAX_MEDIAN_MS:-2500}" ] || { echo "Median wait $overall ms is over ${SVT_MAX_MEDIAN_MS:-2500} ms"; failed=1; }
fi
SUMMARY+="\nOverall median wait: **${overall} ms** over ${#waits[@]} turns."
printf "\n$SUMMARY\n" | tee "$OUT/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf "## Synthetic voice tests\n\n$SUMMARY\n" >> "$GITHUB_STEP_SUMMARY"
exit $failed
