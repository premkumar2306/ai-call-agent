#!/usr/bin/env bash
# Synthetic voice tests (SVT): Claude-played callers phone the production
# voice agent over the same media stream a real call uses, one call per
# persona, and report what each caller waited per turn.
#
# Usage (from worker/):  ./svt/run.sh            # every persona
#                        ./svt/run.sh 3 5        # just these personas
#        SVT_SET=india ./svt/run.sh              # the Indian callers (demo clinic)
#        SVT_SET=india ./svt/run.sh 2            # just the Hindi switcher
#
# SVT_SET picks the persona set (svt/latency-test.mjs): `us` (default, the
# weekly run: advanced_vtech) or `india` (demo_clinic_india: Indian English,
# Hinglish, Hindi, an elderly slow speaker, a specific-doctor request and an
# emergency). The india set uses the macOS en_IN/hi_IN voices (Rishi, Veena,
# Lekha) when installed and says which fallback it used when not; its
# results go to svt/results/india.
# Needs ADMIN_KEY, ANTHROPIC_API_KEY and DEEPGRAM_API_KEY — taken from the
# environment (GitHub Actions) or else the repo-root .env (ADMIN_KEY from
# AVERY_SECRET). Needs macOS `say` and ffmpeg, so CI runs on a macOS runner.
#
# Calls run SVT_PARALLEL at a time (default 4). Each persona is its own test
# caller, and a call cancels only that persona's bookings (and calendar
# events) from the previous run, so its appointment stays visible in the
# business's calendar until the next run.
# Each call is graded by Claude against the caller's goal (wrong details,
# forgotten requests, false confirmations).
# Exits non-zero if any call left the caller without a reply or failed its
# grading, or the median wait across all calls is over SVT_MAX_MEDIAN_MS
# (default 2500).
set -uo pipefail
cd "$(dirname "$0")/.."
SET=${SVT_SET:-us}
case "$SET" in
  us)    OUT=${SVT_OUT:-svt/results};       ALL=$(seq 0 13) ;;
  india) OUT=${SVT_OUT:-svt/results/india}; ALL=$(seq 0 5) ;;
  *)     echo "SVT_SET must be us or india"; exit 2 ;;
esac
mkdir -p "$OUT"

env_get() { [ -f ../.env ] && grep -E "^$1=" ../.env | tail -1 | cut -d= -f2- | tr -d "\"'"; }
export ADMIN_KEY=${ADMIN_KEY:-$(env_get AVERY_SECRET)}
export ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-$(env_get ANTHROPIC_API_KEY)}
export DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-$(env_get DEEPGRAM_API_KEY)}
for k in ADMIN_KEY ANTHROPIC_API_KEY DEEPGRAM_API_KEY; do
  [ -n "${!k}" ] || { echo "$k is not set"; exit 2; }
done

# us: 8–13 are the multi-turn complex cases (changes of mind, corrections, two cars, …).
PERSONAS=("$@"); [ ${#PERSONAS[@]} -gt 0 ] || PERSONAS=($ALL)

for p in "${PERSONAS[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge "${SVT_PARALLEL:-4}" ]; do sleep 2; done
  echo "calling as persona $p"
  # 7-minute cap per call (perl: macOS has no `timeout`).
  ( perl -e 'alarm shift; exec @ARGV' 420 node svt/latency-test.mjs --set "$SET" --persona "$p" > "$OUT/persona-$p.txt" 2>&1
    echo $? > "$OUT/persona-$p.status" ) &
done
wait

failed=0; waits=()
SUMMARY="| persona | median wait | worst wait | result | issues |\n|---|---|---|---|---|\n"
for p in "${PERSONAS[@]}"; do
  log="$OUT/persona-$p.txt"; status=$(cat "$OUT/persona-$p.status" 2>/dev/null || echo 1)
  echo; echo "── persona $p ──"
  grep -E "^Voice:|^Persona:|^  [0-9]+\. CALLER|^     \(|^median|^FAILED|^VERDICT|^  - " "$log"
  median=$(sed -nE 's/^median e2e ([0-9]+) ms, worst ([0-9]+) ms/\1/p' "$log")
  worst=$(sed -nE 's/^median e2e ([0-9]+) ms, worst ([0-9]+) ms/\2/p' "$log")
  # Every caller wait, for the overall median.
  waits+=($(sed -nE 's/^     \(([0-9]+) ms\).*/\1/p' "$log"))
  result=pass; [ $status -eq 0 ] || { result="FAIL ($status)"; failed=1; }
  issues=$(sed -n '/^VERDICT/,$p' "$log" | sed -n 's/^  - //p' | paste -sd ';' - | tr '|' '/')
  SUMMARY+="| $p | ${median:-—} ms | ${worst:-—} ms | $result | ${issues:-} |\n"
done

overall=—
if [ ${#waits[@]} -gt 0 ]; then
  sorted=($(printf '%s\n' "${waits[@]}" | sort -n))
  overall=${sorted[$(( ${#sorted[@]} / 2 ))]}
  [ "$overall" -le "${SVT_MAX_MEDIAN_MS:-2500}" ] || { echo "Median wait $overall ms is over ${SVT_MAX_MEDIAN_MS:-2500} ms"; failed=1; }
fi
SUMMARY+="\nOverall median wait: **${overall} ms** over ${#waits[@]} turns."
printf "\n%b\n" "$SUMMARY" | tee "$OUT/summary.md"
TITLE="Synthetic voice tests"; [ "$SET" = us ] || TITLE+=" ($SET)"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf "## %s\n\n%b\n" "$TITLE" "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"
exit $failed
