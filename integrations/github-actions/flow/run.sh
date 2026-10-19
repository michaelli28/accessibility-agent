#!/bin/bash
set -euo pipefail

# Inputs
URL="${INPUT_URL:-}"
GOAL="${INPUT_GOAL:-}"
API_KEY="${INPUT_API_KEY:-${OPENAI_API_KEY:-}}"
MAX_STEPS="${INPUT_MAX_STEPS:-20}"
DRY_RUN="${INPUT_DRY_RUN:-false}"

# GitHub output file (default to /dev/null for local testing)
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"

# Validate required inputs
if [ -z "$URL" ]; then
  echo "::error::URL is required"
  exit 1
fi

if [ -z "$GOAL" ]; then
  echo "::error::Goal is required"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "::error::API key is required. Set api-key input or OPENAI_API_KEY environment variable"
  exit 1
fi

# Dry run mode for testing
if [ "$DRY_RUN" = "true" ]; then
  echo "Dry run: would run flow on $URL with goal '$GOAL'"
  exit 0
fi

# Export API key for CLI
export OPENAI_API_KEY="$API_KEY"

# Run flow using array for arguments (avoid injection)
CLI_ARGS=("flow" "$URL" "--goal" "$GOAL" "--max-steps" "$MAX_STEPS" "--json")
echo "Running: at-agent ${CLI_ARGS[*]}"
RESULT=$(npx at-agent "${CLI_ARGS[@]}" 2>&1) || true

# Parse results
SUCCESS=$(echo "$RESULT" | jq -r '.success // false')
STEPS=$(echo "$RESULT" | jq -r '.steps | length')
VIOLATIONS=$(echo "$RESULT" | jq -r '.violations | length')

# Set outputs
echo "success=$SUCCESS" >> "$GITHUB_OUTPUT"
echo "steps=$STEPS" >> "$GITHUB_OUTPUT"
echo "violations=$VIOLATIONS" >> "$GITHUB_OUTPUT"
echo "json<<EOF" >> "$GITHUB_OUTPUT"
echo "$RESULT" >> "$GITHUB_OUTPUT"
echo "EOF" >> "$GITHUB_OUTPUT"

# Exit based on success
if [ "$SUCCESS" != "true" ]; then
  echo "::error::Flow test failed - goal not achieved"
  exit 1
fi

echo "Flow test passed in $STEPS steps"
