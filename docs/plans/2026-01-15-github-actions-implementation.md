# GitHub Actions Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build two composite GitHub Actions (audit and flow) that wrap the at-agent CLI for CI/CD accessibility testing.

**Architecture:** Shell scripts handle the logic (testable locally), thin action.yml files define inputs/outputs and call the scripts. A shared summary generation script produces GitHub Job Summaries.

**Tech Stack:** Bash scripts, GitHub Actions YAML, jq for JSON parsing

---

## Prerequisites

Before starting, ensure you're in the integrations worktree:
```bash
cd .
```

The CLI is already built and available at `packages/cli/`.

---

### Task 1: Create Directory Structure

**Files:**
- Create: `integrations/github-actions/audit/`
- Create: `integrations/github-actions/flow/`
- Create: `integrations/github-actions/scripts/`

**Step 1: Create directories**

```bash
mkdir -p integrations/github-actions/audit
mkdir -p integrations/github-actions/flow
mkdir -p integrations/github-actions/scripts
```

**Step 2: Verify structure**

Run: `ls -la integrations/github-actions/`
Expected: audit/, flow/, scripts/ directories exist

**Step 3: Commit**

```bash
git add integrations/
git commit -m "chore: create github-actions directory structure"
```

---

### Task 2: Audit Action - run.sh Script (Core Logic)

**Files:**
- Create: `integrations/github-actions/audit/run.sh`

**Step 1: Write the test script**

Create a test script to verify run.sh behavior:

```bash
# integrations/github-actions/audit/run.test.sh
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_PASSED=0
TEST_FAILED=0

# Helper to run test
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
    ((TEST_PASSED++))
  else
    echo "  ✗ FAIL (expected exit $expected_exit, got $actual_exit)"
    ((TEST_FAILED++))
  fi
}

# Test: Missing URL fails
run_test "missing URL fails" 1 bash "$SCRIPT_DIR/run.sh"

# Test: Invalid fail-on value fails
INPUT_URL="https://example.com" INPUT_FAIL_ON="invalid" \
  run_test "invalid fail-on fails" 1 bash "$SCRIPT_DIR/run.sh"

# Test: Valid inputs accepted (will fail at CLI step, but validates inputs)
INPUT_URL="https://example.com" INPUT_FAIL_ON="serious" INPUT_DRY_RUN="true" \
  run_test "valid inputs accepted" 0 bash "$SCRIPT_DIR/run.sh"

echo ""
echo "Results: $TEST_PASSED passed, $TEST_FAILED failed"
[ "$TEST_FAILED" -eq 0 ]
```

**Step 2: Run test to verify it fails**

Run: `chmod +x integrations/github-actions/audit/run.test.sh && bash integrations/github-actions/audit/run.test.sh`
Expected: FAIL (run.sh doesn't exist)

**Step 3: Write minimal run.sh**

```bash
# integrations/github-actions/audit/run.sh
#!/bin/bash
set -euo pipefail

# Inputs (from GitHub Actions or environment)
URL="${INPUT_URL:-}"
FAIL_ON="${INPUT_FAIL_ON:-serious}"
TAGS="${INPUT_TAGS:-}"
DRY_RUN="${INPUT_DRY_RUN:-false}"

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
CLI_ARGS="audit $URL --json"
if [ -n "$TAGS" ]; then
  CLI_ARGS="$CLI_ARGS --tags $TAGS"
fi

# Run audit
echo "Running: at-agent $CLI_ARGS"
RESULT=$(npx at-agent $CLI_ARGS 2>&1) || true

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
```

**Step 4: Run test to verify it passes**

Run: `chmod +x integrations/github-actions/audit/run.sh && bash integrations/github-actions/audit/run.test.sh`
Expected: 3 passed, 0 failed

**Step 5: Commit**

```bash
git add integrations/github-actions/audit/
git commit -m "feat(actions): add audit run.sh with input validation"
```

---

### Task 3: Audit Action - action.yml

**Files:**
- Create: `integrations/github-actions/audit/action.yml`

**Step 1: Write action.yml**

```yaml
# integrations/github-actions/audit/action.yml
name: 'Accessibility Audit'
description: 'Run accessibility audit on a URL using at-agent'
author: 'at-agent'

branding:
  icon: 'check-circle'
  color: 'blue'

inputs:
  url:
    description: 'URL to audit'
    required: true
  fail-on:
    description: 'Minimum impact level to fail: critical, serious, moderate, minor, or none'
    required: false
    default: 'serious'
  tags:
    description: 'Space-separated WCAG tags (e.g., wcag2a wcag2aa)'
    required: false
  node-version:
    description: 'Node.js version to use'
    required: false
    default: '20'

outputs:
  violations:
    description: 'Total violation count'
    value: ${{ steps.audit.outputs.violations }}
  critical:
    description: 'Critical violation count'
    value: ${{ steps.audit.outputs.critical }}
  serious:
    description: 'Serious violation count'
    value: ${{ steps.audit.outputs.serious }}
  json:
    description: 'Full JSON results'
    value: ${{ steps.audit.outputs.json }}

runs:
  using: 'composite'
  steps:
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}

    - name: Install at-agent CLI
      shell: bash
      run: npm install github:${{ github.repository }}#packages/cli

    - name: Run audit
      id: audit
      shell: bash
      env:
        INPUT_URL: ${{ inputs.url }}
        INPUT_FAIL_ON: ${{ inputs.fail-on }}
        INPUT_TAGS: ${{ inputs.tags }}
      run: bash ${{ github.action_path }}/run.sh

    - name: Generate summary
      if: always()
      shell: bash
      env:
        AUDIT_JSON: ${{ steps.audit.outputs.json }}
        AUDIT_URL: ${{ inputs.url }}
        FAIL_ON: ${{ inputs.fail-on }}
      run: bash ${{ github.action_path }}/../scripts/audit-summary.sh
```

**Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('integrations/github-actions/audit/action.yml'))"`
Expected: No output (valid YAML)

**Step 3: Commit**

```bash
git add integrations/github-actions/audit/action.yml
git commit -m "feat(actions): add audit action.yml definition"
```

---

### Task 4: Audit Summary Script

**Files:**
- Create: `integrations/github-actions/scripts/audit-summary.sh`

**Step 1: Write test for summary script**

```bash
# integrations/github-actions/scripts/audit-summary.test.sh
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Create mock GITHUB_STEP_SUMMARY
export GITHUB_STEP_SUMMARY=$(mktemp)

# Test with sample data
export AUDIT_URL="https://example.com"
export FAIL_ON="serious"
export AUDIT_JSON='{
  "summary": {
    "total": 8,
    "byImpact": {"critical": 0, "serious": 2, "moderate": 5, "minor": 1}
  },
  "violations": [
    {"rule": "color-contrast", "impact": "serious", "nodes": [{}, {}], "help": "Elements must have sufficient color contrast"},
    {"rule": "image-alt", "impact": "moderate", "nodes": [{}, {}, {}], "help": "Images must have alternate text"}
  ]
}'

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
```

**Step 2: Run test to verify it fails**

Run: `chmod +x integrations/github-actions/scripts/audit-summary.test.sh && bash integrations/github-actions/scripts/audit-summary.test.sh`
Expected: FAIL (audit-summary.sh doesn't exist)

**Step 3: Write audit-summary.sh**

```bash
# integrations/github-actions/scripts/audit-summary.sh
#!/bin/bash
set -euo pipefail

# Inputs
URL="${AUDIT_URL:-unknown}"
FAIL_ON="${FAIL_ON:-serious}"
JSON="${AUDIT_JSON:-{}}"

# Parse counts
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

# Add top violations table if any exist
VIOLATION_COUNT=$(echo "$JSON" | jq -r '.violations | length')
if [ "$VIOLATION_COUNT" -gt 0 ]; then
  cat >> "$GITHUB_STEP_SUMMARY" << EOF
### Top Violations

| Rule | Impact | Count | Help |
|------|--------|-------|------|
EOF

  echo "$JSON" | jq -r '.violations[:5][] | "| \(.rule) | \(.impact) | \(.nodes | length) | \(.help) |"' >> "$GITHUB_STEP_SUMMARY"
fi
```

**Step 4: Run test to verify it passes**

Run: `chmod +x integrations/github-actions/scripts/audit-summary.sh && bash integrations/github-actions/scripts/audit-summary.test.sh`
Expected: ✓ Summary generated correctly

**Step 5: Commit**

```bash
git add integrations/github-actions/scripts/
git commit -m "feat(actions): add audit summary generation script"
```

---

### Task 5: Flow Action - run.sh Script

**Files:**
- Create: `integrations/github-actions/flow/run.sh`
- Create: `integrations/github-actions/flow/run.test.sh`

**Step 1: Write test script**

```bash
# integrations/github-actions/flow/run.test.sh
#!/bin/bash
set -e

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
    ((TEST_PASSED++))
  else
    echo "  ✗ FAIL (expected exit $expected_exit, got $actual_exit)"
    ((TEST_FAILED++))
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
```

**Step 2: Run test to verify it fails**

Run: `chmod +x integrations/github-actions/flow/run.test.sh && bash integrations/github-actions/flow/run.test.sh`
Expected: FAIL (run.sh doesn't exist)

**Step 3: Write run.sh**

```bash
# integrations/github-actions/flow/run.sh
#!/bin/bash
set -euo pipefail

# Inputs
URL="${INPUT_URL:-}"
GOAL="${INPUT_GOAL:-}"
API_KEY="${INPUT_API_KEY:-${OPENAI_API_KEY:-}}"
MAX_STEPS="${INPUT_MAX_STEPS:-20}"
DRY_RUN="${INPUT_DRY_RUN:-false}"

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

# Run flow
echo "Running: at-agent flow $URL --goal \"$GOAL\" --max-steps $MAX_STEPS --json"
RESULT=$(npx at-agent flow "$URL" --goal "$GOAL" --max-steps "$MAX_STEPS" --json 2>&1) || true

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
```

**Step 4: Run test to verify it passes**

Run: `chmod +x integrations/github-actions/flow/run.sh && bash integrations/github-actions/flow/run.test.sh`
Expected: 5 passed, 0 failed

**Step 5: Commit**

```bash
git add integrations/github-actions/flow/
git commit -m "feat(actions): add flow run.sh with input validation"
```

---

### Task 6: Flow Action - action.yml

**Files:**
- Create: `integrations/github-actions/flow/action.yml`

**Step 1: Write action.yml**

```yaml
# integrations/github-actions/flow/action.yml
name: 'Accessibility Flow Test'
description: 'Run AI-guided accessibility flow test using at-agent'
author: 'at-agent'

branding:
  icon: 'navigation'
  color: 'purple'

inputs:
  url:
    description: 'Starting URL for the flow'
    required: true
  goal:
    description: 'Goal for the agent to achieve'
    required: true
  api-key:
    description: 'OpenAI API key (falls back to OPENAI_API_KEY env var)'
    required: false
  max-steps:
    description: 'Maximum steps before stopping'
    required: false
    default: '20'
  node-version:
    description: 'Node.js version to use'
    required: false
    default: '20'

outputs:
  success:
    description: 'Whether the goal was achieved'
    value: ${{ steps.flow.outputs.success }}
  steps:
    description: 'Number of steps taken'
    value: ${{ steps.flow.outputs.steps }}
  violations:
    description: 'Number of violations found'
    value: ${{ steps.flow.outputs.violations }}
  json:
    description: 'Full JSON results'
    value: ${{ steps.flow.outputs.json }}

runs:
  using: 'composite'
  steps:
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}

    - name: Install at-agent CLI
      shell: bash
      run: npm install github:${{ github.repository }}#packages/cli

    - name: Run flow test
      id: flow
      shell: bash
      env:
        INPUT_URL: ${{ inputs.url }}
        INPUT_GOAL: ${{ inputs.goal }}
        INPUT_API_KEY: ${{ inputs.api-key }}
        INPUT_MAX_STEPS: ${{ inputs.max-steps }}
      run: bash ${{ github.action_path }}/run.sh

    - name: Generate summary
      if: always()
      shell: bash
      env:
        FLOW_JSON: ${{ steps.flow.outputs.json }}
        FLOW_URL: ${{ inputs.url }}
        FLOW_GOAL: ${{ inputs.goal }}
      run: bash ${{ github.action_path }}/../scripts/flow-summary.sh
```

**Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('integrations/github-actions/flow/action.yml'))"`
Expected: No output (valid YAML)

**Step 3: Commit**

```bash
git add integrations/github-actions/flow/action.yml
git commit -m "feat(actions): add flow action.yml definition"
```

---

### Task 7: Flow Summary Script

**Files:**
- Create: `integrations/github-actions/scripts/flow-summary.sh`

**Step 1: Write test for summary script**

```bash
# integrations/github-actions/scripts/flow-summary.test.sh
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export GITHUB_STEP_SUMMARY=$(mktemp)
export FLOW_URL="https://example.com"
export FLOW_GOAL="Complete checkout as guest"
export FLOW_JSON='{
  "success": true,
  "steps": [
    {"action": "click", "target": "Shop Now button"},
    {"action": "click", "target": "Add to cart"},
    {"action": "click", "target": "Checkout"}
  ],
  "violations": [
    {"rule": "button-name", "impact": "serious", "location": "Checkout button"}
  ]
}'

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
```

**Step 2: Run test to verify it fails**

Run: `chmod +x integrations/github-actions/scripts/flow-summary.test.sh && bash integrations/github-actions/scripts/flow-summary.test.sh`
Expected: FAIL (flow-summary.sh doesn't exist)

**Step 3: Write flow-summary.sh**

```bash
# integrations/github-actions/scripts/flow-summary.sh
#!/bin/bash
set -euo pipefail

# Inputs
URL="${FLOW_URL:-unknown}"
GOAL="${FLOW_GOAL:-unknown}"
JSON="${FLOW_JSON:-{}}"

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
```

**Step 4: Run test to verify it passes**

Run: `chmod +x integrations/github-actions/scripts/flow-summary.sh && bash integrations/github-actions/scripts/flow-summary.test.sh`
Expected: ✓ Summary generated correctly

**Step 5: Commit**

```bash
git add integrations/github-actions/scripts/flow-summary.sh integrations/github-actions/scripts/flow-summary.test.sh
git commit -m "feat(actions): add flow summary generation script"
```

---

### Task 8: README Documentation

**Files:**
- Create: `integrations/github-actions/README.md`

**Step 1: Write README**

```markdown
# at-agent GitHub Actions

Accessibility testing actions for GitHub CI/CD workflows.

## Actions

### Audit Action

Run an accessibility audit on a URL.

```yaml
- uses: your-org/at-agent/integrations/github-actions/audit@main
  with:
    url: https://example.com
    fail-on: serious  # critical, serious, moderate, minor, or none
    tags: wcag2a wcag2aa  # optional WCAG tags
```

#### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | Yes | - | URL to audit |
| `fail-on` | No | `serious` | Minimum impact level to fail |
| `tags` | No | - | Space-separated WCAG tags |
| `node-version` | No | `20` | Node.js version |

#### Outputs

| Output | Description |
|--------|-------------|
| `violations` | Total violation count |
| `critical` | Critical violation count |
| `serious` | Serious violation count |
| `json` | Full JSON results |

### Flow Action

Run an AI-guided accessibility flow test.

```yaml
- uses: your-org/at-agent/integrations/github-actions/flow@main
  with:
    url: https://example.com
    goal: "Complete checkout as guest user"
    api-key: ${{ secrets.OPENAI_API_KEY }}
```

#### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | Yes | - | Starting URL |
| `goal` | Yes | - | Goal for the agent |
| `api-key` | No | - | OpenAI API key (or use `OPENAI_API_KEY` env) |
| `max-steps` | No | `20` | Maximum steps |
| `node-version` | No | `20` | Node.js version |

#### Outputs

| Output | Description |
|--------|-------------|
| `success` | Whether goal was achieved |
| `steps` | Number of steps taken |
| `violations` | Number of violations found |
| `json` | Full JSON results |

## Examples

### Basic Audit on PR

```yaml
name: Accessibility
on: pull_request

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: your-org/at-agent/integrations/github-actions/audit@main
        with:
          url: https://staging.example.com
          fail-on: serious
```

### Flow Test with Secrets

```yaml
name: Accessibility Flow
on:
  push:
    branches: [main]

jobs:
  flow:
    runs-on: ubuntu-latest
    steps:
      - uses: your-org/at-agent/integrations/github-actions/flow@main
        with:
          url: https://staging.example.com
          goal: "Register a new user account"
          api-key: ${{ secrets.OPENAI_API_KEY }}
```

### Using Outputs

```yaml
- uses: your-org/at-agent/integrations/github-actions/audit@main
  id: audit
  with:
    url: https://example.com

- run: |
    echo "Found ${{ steps.audit.outputs.violations }} violations"
    echo "Critical: ${{ steps.audit.outputs.critical }}"
```
```

**Step 2: Commit**

```bash
git add integrations/github-actions/README.md
git commit -m "docs(actions): add README with usage examples"
```

---

### Task 9: Integration Test Workflow

**Files:**
- Create: `.github/workflows/test-actions.yml`

**Step 1: Write test workflow**

```yaml
# .github/workflows/test-actions.yml
name: Test GitHub Actions

on:
  push:
    paths:
      - 'integrations/github-actions/**'
      - '.github/workflows/test-actions.yml'
  pull_request:
    paths:
      - 'integrations/github-actions/**'

jobs:
  test-audit-scripts:
    name: Test Audit Scripts
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run audit script tests
        run: bash integrations/github-actions/audit/run.test.sh

      - name: Run audit summary tests
        run: bash integrations/github-actions/scripts/audit-summary.test.sh

  test-flow-scripts:
    name: Test Flow Scripts
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run flow script tests
        run: bash integrations/github-actions/flow/run.test.sh

      - name: Run flow summary tests
        run: bash integrations/github-actions/scripts/flow-summary.test.sh

  test-audit-action:
    name: Test Audit Action (Live)
    runs-on: ubuntu-latest
    # Only run on main to avoid unnecessary API calls
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - uses: ./integrations/github-actions/audit
        id: audit
        with:
          url: https://www.w3.org/WAI/demos/bad/before/home.html
          fail-on: none  # Don't fail, just test

      - name: Check outputs
        run: |
          echo "Violations: ${{ steps.audit.outputs.violations }}"
          [ -n "${{ steps.audit.outputs.violations }}" ]
```

**Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/test-actions.yml'))"`
Expected: No output (valid YAML)

**Step 3: Commit**

```bash
git add .github/workflows/test-actions.yml
git commit -m "ci: add workflow to test GitHub Actions"
```

---

### Task 10: Final Verification

**Step 1: Run all local tests**

```bash
# From worktree root
bash integrations/github-actions/audit/run.test.sh
bash integrations/github-actions/scripts/audit-summary.test.sh
bash integrations/github-actions/flow/run.test.sh
bash integrations/github-actions/scripts/flow-summary.test.sh
```

Expected: All tests pass

**Step 2: Verify file structure**

```bash
find integrations/github-actions -type f | sort
```

Expected:
```
integrations/github-actions/README.md
integrations/github-actions/audit/action.yml
integrations/github-actions/audit/run.sh
integrations/github-actions/audit/run.test.sh
integrations/github-actions/flow/action.yml
integrations/github-actions/flow/run.sh
integrations/github-actions/flow/run.test.sh
integrations/github-actions/scripts/audit-summary.sh
integrations/github-actions/scripts/audit-summary.test.sh
integrations/github-actions/scripts/flow-summary.sh
integrations/github-actions/scripts/flow-summary.test.sh
```

**Step 3: Push branch**

```bash
git push -u origin rebuild/integrations-layer
```
