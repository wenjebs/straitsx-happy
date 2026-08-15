#!/usr/bin/env bash
# Drives one Happy activity from goal to purchase, headlessly.
#
# The same sequence the UI walks, so it is the fastest way to exercise the Closer without clicking
# through five screens. Prints the activity id and the callback events as they land.
#
#   ./scripts/drive-purchase.sh "a 1TB NVMe SSD"
set -euo pipefail

API="${API:-http://127.0.0.1:8787}"
GOAL="${1:-a 1TB NVMe SSD for my desktop}"

# Reads one top-level key. A plain lookup rather than eval: this parses a network response, and
# eval on anything derived from one is a shell away from arbitrary code.
jqr() { python3 -c "import json,sys;print(json.load(sys.stdin).get(sys.argv[1],''))" "$1"; }

echo "→ creating activity: $GOAL"
ACT=$(curl -s -X POST "$API/v1/activities" -H 'content-type: application/json' \
  -d "{\"goal\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$GOAL")}")
ID=$(echo "$ACT" | jqr id)
echo "  activity $ID  stage=$(echo "$ACT" | jqr stage)"

echo "→ approving wishlist"
curl -s -X POST "$API/v1/activities/$ID/wishlist/approve" -H 'content-type: application/json' -d '{}' >/dev/null

# Clarifications are per item and the ids come from the wishlist, so answer whatever is pending.
for _ in 1 2 3 4 5; do
  SNAP=$(curl -s "$API/v1/activities/$ID")
  STAGE=$(echo "$SNAP" | jqr stage)
  [ "$STAGE" = "curate" ] || break
  ITEM=$(echo "$SNAP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for i in d.get('wishlist',[]):
    q=i.get('clarification')
    if q and not q.get('answer'):
        print(i['id'], (q.get('options') or ['yes'])[0], sep='|'); break
")
  [ -n "$ITEM" ] || break
  IID="${ITEM%%|*}"; OPT="${ITEM##*|}"
  echo "  answering $IID -> $OPT"
  curl -s -X POST "$API/v1/activities/$ID/clarifications/$IID" \
    -H 'content-type: application/json' \
    -d "{\"option\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$OPT")}" >/dev/null
done

echo "→ dispatching search"
curl -s -X POST "$API/v1/activities/$ID/dispatch" -H 'content-type: application/json' -d '{}' >/dev/null

echo -n "  waiting for shortlist"
for _ in $(seq 1 90); do
  STAGE=$(curl -s "$API/v1/activities/$ID" | jqr stage)
  [ "$STAGE" = "shortlist" ] && break
  echo -n "."; sleep 1
done
echo " stage=$STAGE"
[ "$STAGE" = "shortlist" ] || { echo "never reached shortlist"; exit 1; }

curl -s "$API/v1/activities/$ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('shortlist',[]):
    l=p['listing']; print(f\"  {l['price']:>9}  {l['title'][:40]:<42} {l.get('url','')}\")
"

echo "→ purchasing"
curl -s -X POST "$API/v1/activities/$ID/purchase" -H 'content-type: application/json' \
  -d "{\"idempotencyKey\":\"drive-$(date +%s)\"}" >/dev/null

echo "→ watching execution (ctrl-c to stop)"
for _ in $(seq 1 120); do
  curl -s "$API/v1/activities/$ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=[(r['itemId'],r['step'],r['state']) for r in d.get('execution',[])]
print('  ', d['stage'], rows)
"
  S=$(curl -s "$API/v1/activities/$ID" | jqr stage)
  [ "$S" = "exec" ] || break
  sleep 2
done
echo "activity $ID"
