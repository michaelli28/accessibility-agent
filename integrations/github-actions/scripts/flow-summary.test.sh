#!/bin/bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export GITHUB_STEP_SUMMARY=$(mktemp)
export FLOW_URL="https://example.com"
export FLOW_GOAL="Complete checkout as guest"
export FLOW_JSON='{"success":true,"steps":[{"action":"click","target":"Shop Now button"},{"action":"click","target":"Add to cart"},{"action":"click","target":"Checkout"}],"violations":[{"rule":"button-name","impact":"serious","location":"Checkout button"}]}'

bash "$SCRIPT_DIR/flow-summary.sh"

if grep -q "Accessibility Flow Test" "$GITHUB_STEP_SUMMARY" && \
   grep -q "Complete checkout as guest" "$GITHUB_STEP_SUMMARY" && \
   grep -q "Shop Now button" "$GITHUB_STEP_SUMMARY"; then
  echo "✓ Summary generated correctly"
  rm "$GITHUB_STEP_SUMMARY"
  exit 0
else
  echo "✗ Summary missing expected content"
  cat "$GITHUB_STEP_SUMMARY"
  rm "$GITHUB_STEP_SUMMARY"
  exit 1
fi
