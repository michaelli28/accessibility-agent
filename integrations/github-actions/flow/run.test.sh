#!/bin/bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_PASSED=0
TEST_FAILED=0

run_test() {
  local name="$1"
  local expected_exit="$2"
  shift 2

  echo "Testing: $name"
  set +e
  "$@" > /dev/null 2>&1
  local actual_exit=$?
  set -e

  if [ "$actual_exit" -eq "$expected_exit" ]; then
    echo "  ✓ PASS"
    ((TEST_PASSED++)) || true
  else
    echo "  ✗ FAIL (expected exit $expected_exit, got $actual_exit)"
    ((TEST_FAILED++)) || true
  fi
}

# Test: Missing URL fails
run_test "missing URL fails" 1 bash "$SCRIPT_DIR/run.sh"

# Test: Missing goal fails
INPUT_URL="https://example.com" \
  run_test "missing goal fails" 1 bash "$SCRIPT_DIR/run.sh"

# Test: Missing API key fails
INPUT_URL="https://example.com" INPUT_GOAL="test goal" \
  run_test "missing API key fails" 1 bash "$SCRIPT_DIR/run.sh"

# Test: Valid inputs accepted
INPUT_URL="https://example.com" INPUT_GOAL="test goal" INPUT_API_KEY="sk-test" INPUT_DRY_RUN="true" \
  run_test "valid inputs accepted" 0 bash "$SCRIPT_DIR/run.sh"

# Test: Env var fallback for API key
INPUT_URL="https://example.com" INPUT_GOAL="test goal" OPENAI_API_KEY="sk-env" INPUT_DRY_RUN="true" \
  run_test "env var API key fallback" 0 bash "$SCRIPT_DIR/run.sh"

echo ""
echo "Results: $TEST_PASSED passed, $TEST_FAILED failed"
[ "$TEST_FAILED" -eq 0 ]
