#!/usr/bin/env bash
# Reports what each browser-test session is ACTUALLY showing, not just its URL.
#
# A URL is not evidence. Shopee serves its "Page Unavailable" wall at the product URL rather than
# redirecting, so a session can look landed while showing a block. This reads the title and body
# text and flags the usual wall wording.
#
#   ./scripts/check-merchants.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:4041}"

for id in $(curl -s --max-time 20 "$BASE/sessions" | python3 -c "
import json,sys
for s in sorted(json.load(sys.stdin)['sessions'], key=lambda x: x['id']): print(s['id'])
"); do
  curl -s --max-time 30 "$BASE/sessions/$id/page" | python3 -c "
import json,sys,re
d = json.load(sys.stdin)
if d.get('error'):
    print(f'$id  ERROR  {d[\"error\"][:70]}'); raise SystemExit
title = (d.get('title') or '')[:42]
text  = (d.get('text') or '')
blob  = d.get('url','') + ' ' + title + ' ' + text[:300]
bad   = re.search(r'unavailable|verify|denied|captcha|not a robot|something went wrong|blocked', blob, re.I)
print(f'$id  {\"BLOCKED\" if bad else \"OK     \"}  {title:42}  {text[:80]}')
"
done
