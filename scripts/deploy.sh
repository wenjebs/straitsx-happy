#!/usr/bin/env bash
# Push main and deploy it to AWS, then wait and prove the stack is serving.
#
#   ./scripts/deploy.sh            deploy dev
#   ./scripts/deploy.sh prod       deploy prod
#
# Terraform decides what the deployed stack runs: dev gets the mock card and mock closer via
# ALLOW_MOCK_MONEY, prod stays disabled until a real card/closer URL is configured.
set -euo pipefail

ENVIRONMENT="${1:-dev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> checks"
pnpm --filter @happy/backend exec tsc --noEmit
pnpm --filter @happy/backend exec vitest run

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "!! uncommitted changes — commit them first, the deploy builds what is on origin/main" >&2
  git status --short
  exit 1
fi

echo "==> pushing main"
git pull --rebase
git push

echo "==> deploying $ENVIRONMENT"
gh workflow run "Deploy to AWS" -f environment="$ENVIRONMENT"
sleep 8
RUN_ID="$(gh run list --workflow "Deploy to AWS" --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "    run $RUN_ID — https://github.com/wenjebs/straitsx-happy/actions/runs/$RUN_ID"
gh run watch "$RUN_ID" --exit-status

APP_URL="$(gh run view "$RUN_ID" --log 2>/dev/null | grep -o 'https://[a-z0-9]*\.cloudfront\.net' | head -1)"
if [ -n "$APP_URL" ]; then
  echo "==> $APP_URL"
  curl -fsS "$APP_URL/v1/health"
  echo
fi
