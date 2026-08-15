#!/usr/bin/env bash
# Stops every AgentCore browser session that is still running.
#
# A session bills until it is stopped and its TTL is half an hour, so an abandoned one is money
# leaking quietly. Run this after killing anything that holds browsers.
#
#   ./scripts/stop-agentcore.sh
set -uo pipefail

export AWS_PAGER=""
PROFILE="${AWS_PROFILE:-happy}"
REGION="${AWS_REGION:-ap-southeast-1}"
BROWSER="aws.browser.v1"

ids=$(aws bedrock-agentcore list-browser-sessions \
  --profile "$PROFILE" --region "$REGION" --browser-identifier "$BROWSER" \
  --max-results 50 \
  --query 'items[?status!=`TERMINATED`].sessionId' --output text 2>/dev/null)

if [ -z "$ids" ]; then
  echo "nothing running"
  exit 0
fi

n=0
for id in $ids; do
  aws bedrock-agentcore stop-browser-session --profile "$PROFILE" --region "$REGION" \
    --browser-identifier "$BROWSER" --session-id "$id" >/dev/null 2>&1 && n=$((n + 1))
done
echo "stopped $n session(s)"
