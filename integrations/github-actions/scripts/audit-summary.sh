#!/bin/bash
set -euo pipefail

# Inputs
URL="${AUDIT_URL:-unknown}"
FAIL_ON="${FAIL_ON:-serious}"
JSON="${AUDIT_JSON:-{}}"

# Parse counts (CLI outputs summary.totalViolations, not summary.total)
TOTAL=$(echo "$JSON" | jq -r '.summary.totalViolations // 0')
CRITICAL=$(echo "$JSON" | jq -r '.summary.byImpact.critical // 0')
SERIOUS=$(echo "$JSON" | jq -r '.summary.byImpact.serious // 0')
MODERATE=$(echo "$JSON" | jq -r '.summary.byImpact.moderate // 0')
MINOR=$(echo "$JSON" | jq -r '.summary.byImpact.minor // 0')

# Determine status
if [ "$CRITICAL" -gt 0 ] || [ "$SERIOUS" -gt 0 ]; then
  STATUS="❌ Failed"
  if [ "$CRITICAL" -gt 0 ]; then
    STATUS_DETAIL="$CRITICAL critical violations"
  else
    STATUS_DETAIL="$SERIOUS serious violations"
  fi
else
  STATUS="✅ Passed"
  STATUS_DETAIL="$TOTAL total violations"
fi

# Write summary
cat >> "$GITHUB_STEP_SUMMARY" << EOF
## Accessibility Audit Results

**URL:** $URL
**Status:** $STATUS ($STATUS_DETAIL)
**Threshold:** $FAIL_ON

### Violations by Impact

| Impact | Count |
|--------|-------|
| 🔴 Critical | $CRITICAL |
| 🟠 Serious | $SERIOUS |
| 🟡 Moderate | $MODERATE |
| 🔵 Minor | $MINOR |

EOF

# Add top violations table if any exist (CLI uses auditResult.violations with .id not .rule)
VIOLATION_COUNT=$(echo "$JSON" | jq -r '.auditResult.violations | length')
if [ "$VIOLATION_COUNT" -gt 0 ]; then
  cat >> "$GITHUB_STEP_SUMMARY" << EOF
### Top Violations

| Rule | Impact | Count | Help |
|------|--------|-------|------|
EOF

  echo "$JSON" | jq -r '.auditResult.violations[:5][] | "| \(.id) | \(.impact) | \(.nodes | length) | \(.help) |"' >> "$GITHUB_STEP_SUMMARY"
fi
