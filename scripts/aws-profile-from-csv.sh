#!/usr/bin/env bash
# Configure a named AWS CLI profile from a console-downloaded access-key CSV.
#
# Exists so the secret never has to be pasted into a terminal an agent can read. It goes
# straight from the CSV into ~/.aws/credentials; nothing sensitive reaches stdout.
#
#   ./scripts/aws-profile-from-csv.sh ~/Downloads/happy-agentcore_accessKeys.csv happy ap-southeast-1
#
# Writes ONLY the named profile's block. [default] is left alone — on this machine it is a
# Scaleway profile other tooling depends on.
set -euo pipefail

CSV="${1:?usage: $0 <csv> [profile] [region]}"
PROFILE="${2:-happy}"
REGION="${3:-ap-southeast-1}"

[ -f "$CSV" ] || { echo "no such file: $CSV" >&2; exit 1; }

# Locate the columns by header name — the console has shipped at least two layouts (two-column,
# and a five-column one with user name and console link).
read_col() {
  awk -F',' -v want="$1" '
    NR==1 {
      for (i=1; i<=NF; i++) {
        h=$i; gsub(/^[ "\r]+|[ "\r]+$/, "", h)
        if (tolower(h) == tolower(want)) col=i
      }
      if (!col) { exit 3 }
      next
    }
    NR==2 { v=$col; gsub(/^[ "\r]+|[ "\r]+$/, "", v); print v; exit }
  ' "$CSV"
}

KEY_ID="$(read_col "Access key ID")" || { echo "could not find an 'Access key ID' column in $CSV" >&2; exit 1; }
SECRET="$(read_col "Secret access key")" || { echo "could not find a 'Secret access key' column in $CSV" >&2; exit 1; }

[ -n "$KEY_ID" ] && [ -n "$SECRET" ] || { echo "csv parsed but a field was empty" >&2; exit 1; }

aws configure set region "$REGION" --profile "$PROFILE"
aws configure set output json --profile "$PROFILE"
aws configure set aws_access_key_id "$KEY_ID" --profile "$PROFILE"
aws configure set aws_secret_access_key "$SECRET" --profile "$PROFILE"

echo "profile [$PROFILE] written, region $REGION, key ${KEY_ID:0:8}…"
echo
aws sts get-caller-identity --profile "$PROFILE"
