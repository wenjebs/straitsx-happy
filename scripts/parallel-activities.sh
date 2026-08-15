#!/usr/bin/env bash
# Runs several shopping activities at once, all the way to purchase.
#
# Each activity is an independent PurchaseRun with its own attempt, its own card and its own
# browser, so N activities means N browsers running concurrently. Within one activity the money
# state machine is still deliberately sequential — one card in flight at a time — because that is
# the part where a callback matched to the wrong attempt would credit a card to the wrong item.
#
#   ./scripts/parallel-activities.sh          # the built-in list
#   ./scripts/parallel-activities.sh "a guitar capo" "a dog chew toy"
set -uo pipefail

API="${API:-http://127.0.0.1:8787}"

GOALS=("$@")
if [ ${#GOALS[@]} -eq 0 ]; then
  GOALS=(
    "a gentle facial cleanser for oily skin"
    "a chew toy for my puppy"
    "a guitar capo for my acoustic"
    "cable tidy straps for my desk"
    "a floor cleaner for my flat"
    "wired in-ear earphones"
  )
fi

echo "launching ${#GOALS[@]} activities in parallel"
echo

pids=()
for goal in "${GOALS[@]}"; do
  ( "$(dirname "$0")/drive-purchase.sh" "$goal" buy >"/tmp/happy-activity-$$-${#pids[@]}.log" 2>&1 ) &
  pids+=($!)
  # A small stagger keeps six planner calls from hitting the same rate limit in the same instant.
  sleep 1
done

echo "waiting for ${#pids[@]} runs..."
for pid in "${pids[@]}"; do wait "$pid"; done

echo
for f in /tmp/happy-activity-$$-*.log; do
  echo "─── $f"
  grep -E "creating activity|WANTED|GOT |activity act_" "$f" | head -12
  echo
done
