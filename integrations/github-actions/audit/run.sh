#!/bin/bash
set -euo pipefail

# Inputs (from GitHub Actions or environment)
URL="${INPUT_URL:-}"
FAIL_ON="${INPUT_FAIL_ON:-serious}"
TAGS="${INPUT_TAGS:-}"
DRY_RUN="${INPUT_DRY_RUN:-false}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"

# Validate required inputs
if [ -z "$URL" ]; then
  echo "::error::URL is required"
  exit 1
fi

# Validate fail-on value
case "$FAIL_ON" in
  critical|serious|moderate|minor|none) ;;
  *)
    echo "::error::Invalid fail-on value: $FAIL_ON. Must be: critical, serious, moderate, minor, or none"
    exit 1
    ;;
esac

# Dry run mode for testing
if [ "$DRY_RUN" = "true" ]; then
  echo "Dry run: would audit $URL with fail-on=$FAIL_ON"
  exit 0
fi

# Build CLI args
CLI_ARGS=("audit" "$URL" "--json")
if [ -n "$TAGS" ]; then
  CLI_ARGS+=("--tags" "$TAGS")
fi

# Run audit
echo "Running: at-agent ${CLI_ARGS[*]}"
RESULT=$(npx at-agent "${CLI_ARGS[@]}" 2>&1) || true

# Parse results
VIOLATIONS=$(echo "$RESULT" | jq -r '.summary.totalViolations // 0')
CRITICAL=$(echo "$RESULT" | jq -r '.summary.byImpact.critical // 0')
SERIOUS=$(echo "$RESULT" | jq -r '.summary.byImpact.serious // 0')
MODERATE=$(echo "$RESULT" | jq -r '.summary.byImpact.moderate // 0')
MINOR=$(echo "$RESULT" | jq -r '.summary.byImpact.minor // 0')

# Set outputs
echo "violations=$VIOLATIONS" >> "$GITHUB_OUTPUT"
echo "critical=$CRITICAL" >> "$GITHUB_OUTPUT"
echo "serious=$SERIOUS" >> "$GITHUB_OUTPUT"
echo "json<<EOF" >> "$GITHUB_OUTPUT"
echo "$RESULT" >> "$GITHUB_OUTPUT"
echo "EOF" >> "$GITHUB_OUTPUT"

# Determine exit code based on fail-on threshold
should_fail() {
  case "$FAIL_ON" in
    critical) [ "$CRITICAL" -gt 0 ] ;;
    serious)  [ "$CRITICAL" -gt 0 ] || [ "$SERIOUS" -gt 0 ] ;;
    moderate) [ "$CRITICAL" -gt 0 ] || [ "$SERIOUS" -gt 0 ] || [ "$MODERATE" -gt 0 ] ;;
    minor)    [ "$VIOLATIONS" -gt 0 ] ;;
    none)     false ;;
  esac
}

if should_fail; then
  echo "::error::Accessibility violations found exceeding threshold ($FAIL_ON)"
  exit 1
fi

echo "Audit passed with $VIOLATIONS total violations (threshold: $FAIL_ON)"
