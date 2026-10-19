#!/bin/bash
set -euo pipefail

# Inputs
URL="${FLOW_URL:-unknown}"
GOAL="${FLOW_GOAL:-unknown}"
JSON="${FLOW_JSON:-"{}"}"

# Parse results
SUCCESS=$(echo "$JSON" | jq -r '.success // false')
STEP_COUNT=$(echo "$JSON" | jq -r '.steps | length')
VIOLATION_COUNT=$(echo "$JSON" | jq -r '.violations | length')

# Determine status
if [ "$SUCCESS" = "true" ]; then
  STATUS="✅ Passed"
else
  STATUS="❌ Failed"
fi

# Write summary
cat >> "$GITHUB_STEP_SUMMARY" << EOF
## Accessibility Flow Test

**URL:** $URL
**Goal:** $GOAL
**Status:** $STATUS ($STEP_COUNT steps)

### Steps Taken

EOF

# Add steps
echo "$JSON" | jq -r '.steps[:10][] | "1. \(.action): \(.target)"' | nl -w1 -s'. ' | sed 's/^[0-9]*\. //' >> "$GITHUB_STEP_SUMMARY"

if [ "$STEP_COUNT" -gt 10 ]; then
  echo "... and $((STEP_COUNT - 10)) more steps" >> "$GITHUB_STEP_SUMMARY"
fi

# Add violations if any
if [ "$VIOLATION_COUNT" -gt 0 ]; then
  cat >> "$GITHUB_STEP_SUMMARY" << EOF

### Violations Found: $VIOLATION_COUNT

| Rule | Impact | Location |
|------|--------|----------|
EOF
  echo "$JSON" | jq -r '.violations[] | "| \(.rule) | \(.impact) | \(.location // "unknown") |"' >> "$GITHUB_STEP_SUMMARY"
fi
