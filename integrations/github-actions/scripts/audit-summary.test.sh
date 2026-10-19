#!/bin/bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Create mock GITHUB_STEP_SUMMARY
export GITHUB_STEP_SUMMARY=$(mktemp)

# Test with sample data matching CLI output format
export AUDIT_URL="https://example.com"
export FAIL_ON="serious"
export AUDIT_JSON='{"summary":{"totalViolations":8,"byImpact":{"critical":0,"serious":2,"moderate":5,"minor":1}},"auditResult":{"violations":[{"id":"color-contrast","impact":"serious","nodes":[{},{}],"help":"Elements must have sufficient color contrast"},{"id":"image-alt","impact":"moderate","nodes":[{},{},{}],"help":"Images must have alternate text"}]}}'

bash "$SCRIPT_DIR/audit-summary.sh"

# Check output contains expected elements
if grep -q "Accessibility Audit Results" "$GITHUB_STEP_SUMMARY" && \
   grep -q "https://example.com" "$GITHUB_STEP_SUMMARY" && \
   grep -q "color-contrast" "$GITHUB_STEP_SUMMARY"; then
  echo "✓ Summary generated correctly"
  rm "$GITHUB_STEP_SUMMARY"
  exit 0
else
  echo "✗ Summary missing expected content"
  cat "$GITHUB_STEP_SUMMARY"
  rm "$GITHUB_STEP_SUMMARY"
  exit 1
fi
