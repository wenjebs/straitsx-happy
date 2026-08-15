#!/usr/bin/env bash
# Drives one Happy activity from goal to shortlist, headlessly.
#
# The same sequence the UI walks, so it is the fastest way to check discovery without clicking
# through five screens. Prints the shortlist so a nonsense match is obvious immediately.
#
#   ./scripts/drive-purchase.sh "a starter skincare routine"
#   ./scripts/drive-purchase.sh "a starter skincare routine" buy    # also confirms the purchase
set -euo pipefail

API="${API:-http://127.0.0.1:8787}"
GOAL="${1:-a 1TB NVMe SSD for my desktop}"
BUY="${2:-}"

jqr() { python3 -c "import json,sys;print(json.load(sys.stdin).get(sys.argv[1],''))" "$1"; }
jstr() { python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$1"; }

echo "→ creating activity: $GOAL"
ID=$(curl -s -m 90 -X POST "$API/v1/activities" -H 'content-type: application/json' \
  -d "{\"goal\":$(jstr "$GOAL")}" | jqr id)
echo "  $ID"

# The planner runs asynchronously. Approving before it finishes approves an empty wishlist and the
# activity sits at stage=wishlist forever — which is exactly how this script failed the first time.
echo -n "  waiting for the planner"
for _ in $(seq 1 60); do
  N=$(curl -s -m 20 "$API/v1/activities/$ID" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('wishlist',[])))")
  [ "$N" -gt 0 ] && break
  echo -n "."; sleep 2
done
echo " $N items"

echo "→ approving wishlist"
curl -s -m 30 -X POST "$API/v1/activities/$ID/wishlist/approve" -H 'content-type: application/json' -d '{}' >/dev/null

# Answer whatever clarification is pending, until the stage moves on.
for _ in $(seq 1 12); do
  sleep 3
  SNAP=$(curl -s -m 20 "$API/v1/activities/$ID")
  STAGE=$(echo "$SNAP" | jqr stage)
  [ "$STAGE" = "curate" ] || break
  PAIR=$(echo "$SNAP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d.get('clarifications',[]):
    if not c.get('answer'):
        opts=c.get('options') or []
        name=opts[0]['name'] if opts and isinstance(opts[0],dict) else (opts[0] if opts else 'Not sure')
        print(c.get('itemId',''), name, sep='|'); break
")
  [ -n "$PAIR" ] || break
  echo "  clarify ${PAIR%%|*} -> ${PAIR##*|}"
  curl -s -m 30 -X POST "$API/v1/activities/$ID/clarifications/${PAIR%%|*}" \
    -H 'content-type: application/json' -d "{\"option\":$(jstr "${PAIR##*|}")}" >/dev/null
done

echo "→ dispatching search"
curl -s -m 30 -X POST "$API/v1/activities/$ID/dispatch" -H 'content-type: application/json' -d '{}' >/dev/null

echo -n "  waiting for shortlist"
for _ in $(seq 1 90); do
  STAGE=$(curl -s -m 20 "$API/v1/activities/$ID" | jqr stage)
  [ "$STAGE" = "shortlist" ] && break
  echo -n "."; sleep 1
done
echo " stage=$STAGE"

echo
curl -s -m 20 "$API/v1/activities/$ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
items={i['id']: i['name'] for i in d.get('wishlist',[])}
for p in d.get('shortlist',[]):
    l=p['listing']
    print(f\"  WANTED {items.get(p['itemId'], p['itemId'])[:44]:<46}\")
    print(f\"  GOT    {l['title'][:44]:<46} {l['price']:>9}  {l['seller']}\")
    print(f\"         {l.get('why','')[:70]}\")
    print(f\"         {l.get('url','')[:88]}\")
    print()
"

if [ "$BUY" = "buy" ]; then
  echo "→ purchasing"
  curl -s -m 30 -X POST "$API/v1/activities/$ID/purchase" -H 'content-type: application/json' \
    -d "{\"idempotencyKey\":\"drive-$(date +%s)\"}" >/dev/null
  echo "  watch the closer service log for the run"
fi

echo "activity $ID"
