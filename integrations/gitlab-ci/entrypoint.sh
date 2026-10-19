#!/bin/bash
set -e

# AT Agent GitLab CI Entrypoint Script
# This script runs accessibility tests and outputs results in various formats

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}==========================================${NC}"
echo -e "${BLUE}  AT Agent - Accessibility Testing${NC}"
echo -e "${BLUE}==========================================${NC}"

# Default values
PROVIDER="${PROVIDER:-openai}"
HEADLESS="${HEADLESS:-true}"
CONTINUE_ON_FAILURE="${CONTINUE_ON_FAILURE:-true}"
OUTPUT_DIR="${OUTPUT_DIR:-/output}"
OUTPUT_FORMAT="${OUTPUT_FORMAT:-json}"
DISCOVERY_MODE="${DISCOVERY_MODE:-off}"

# Check for API key
if [ -z "$OPENAI_API_KEY" ] && [ -z "$GEMINI_API_KEY" ]; then
    echo -e "${RED}ERROR: Either OPENAI_API_KEY or GEMINI_API_KEY is required${NC}"
    exit 1
fi

# Handle discovery mode
if [ "$DISCOVERY_MODE" != "off" ]; then
    echo -e "${BLUE}==========================================${NC}"
    echo -e "${BLUE}  Running Auto-Discovery${NC}"
    echo -e "${BLUE}==========================================${NC}"

    # Validate discovery requirements
    if [ -z "$BASE_URL" ]; then
        echo -e "${RED}ERROR: BASE_URL is required when DISCOVERY_MODE is enabled${NC}"
        exit 1
    fi

    if [ -z "$OPENAI_API_KEY" ]; then
        echo -e "${RED}ERROR: OPENAI_API_KEY is required for auto-discovery${NC}"
        exit 1
    fi

    echo "Base URL: $BASE_URL"
    [ -n "$DISCOVERY_FOCUS" ] && echo "Focus areas: $DISCOVERY_FOCUS"
    [ -n "$DISCOVERY_PROMPT" ] && echo "Custom prompt: ${DISCOVERY_PROMPT:0:50}..."
    [ -n "$DISCOVERY_MAX_TESTS" ] && echo "Max tests: $DISCOVERY_MAX_TESTS"
    echo ""

    # Install discovery agent dependencies
    echo -e "${BLUE}Installing discovery agent dependencies...${NC}"
    pip install -r /at-agent/discovery-agent/requirements.txt

    # Build discovery command
    DISCOVERY_OUTPUT="/tmp/discovered-tests-$$.json"
    DISCOVERY_ARGS="--root-dir ${CI_PROJECT_DIR:-.} --base-url $BASE_URL --output $DISCOVERY_OUTPUT"

    if [ "$DISCOVERY_MODE" = "guided" ] && [ -n "$DISCOVERY_FOCUS" ]; then
        DISCOVERY_ARGS="$DISCOVERY_ARGS --focus $DISCOVERY_FOCUS"
    fi

    if [ -n "$DISCOVERY_PROMPT" ]; then
        DISCOVERY_ARGS="$DISCOVERY_ARGS --prompt \"$DISCOVERY_PROMPT\""
    fi

    if [ -n "$DISCOVERY_MAX_TESTS" ]; then
        DISCOVERY_ARGS="$DISCOVERY_ARGS --max-tests $DISCOVERY_MAX_TESTS"
    fi

    if [ -n "$DISCOVERY_EXCLUDE" ]; then
        DISCOVERY_ARGS="$DISCOVERY_ARGS --exclude $DISCOVERY_EXCLUDE"
    fi

    DISCOVERY_ARGS="$DISCOVERY_ARGS --verbose"

    # Run discovery agent
    echo -e "${BLUE}Running discovery agent...${NC}"
    eval "python /at-agent/discovery-agent/discover.py $DISCOVERY_ARGS"

    # Verify output
    if [ ! -f "$DISCOVERY_OUTPUT" ]; then
        echo -e "${RED}ERROR: Discovery agent did not generate test file${NC}"
        exit 1
    fi

    TEST_COUNT=$(jq length "$DISCOVERY_OUTPUT")
    if [ "$TEST_COUNT" -eq 0 ]; then
        echo -e "${RED}ERROR: Discovery agent generated no tests${NC}"
        exit 1
    fi

    echo -e "${GREEN}Discovery complete: $TEST_COUNT tests generated${NC}"
    echo ""

    # Use discovered tests as config
    TEST_CONFIG="$DISCOVERY_OUTPUT"
    DISCOVERED_TESTS_PATH="$DISCOVERY_OUTPUT"
else
    # Validate TEST_CONFIG when not using discovery
    if [ -z "$TEST_CONFIG" ]; then
        echo -e "${RED}ERROR: Either TEST_CONFIG or DISCOVERY_MODE with BASE_URL must be provided${NC}"
        exit 1
    fi
fi

# Validate provider matches API key
if [ "$PROVIDER" = "openai" ] && [ -z "$OPENAI_API_KEY" ]; then
    echo -e "${RED}ERROR: OPENAI_API_KEY is required when PROVIDER=openai${NC}"
    exit 1
fi

if [ "$PROVIDER" = "gemini" ] && [ -z "$GEMINI_API_KEY" ]; then
    echo -e "${RED}ERROR: GEMINI_API_KEY is required when PROVIDER=gemini${NC}"
    exit 1
fi

echo -e "${BLUE}Configuration:${NC}"
echo "  Test Config: $TEST_CONFIG"
echo "  Provider: $PROVIDER"
echo "  Headless: $HEADLESS"
echo "  Continue on Failure: $CONTINUE_ON_FAILURE"
echo "  Output Directory: $OUTPUT_DIR"
echo ""

# Check if test config file exists
if [ ! -f "$TEST_CONFIG" ]; then
    echo -e "${RED}ERROR: Test configuration file not found: $TEST_CONFIG${NC}"
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Parse test configuration
if [[ "$TEST_CONFIG" == *.json ]]; then
    # JSON format
    TESTS=$(cat "$TEST_CONFIG")
    TEST_COUNT=$(echo "$TESTS" | jq length)
else
    # Text format: url|goal per line
    TEST_COUNT=$(grep -v '^#' "$TEST_CONFIG" | grep -v '^$' | wc -l)
fi

echo -e "${BLUE}Tests to run: $TEST_COUNT${NC}"
echo ""

# Initialize results
RESULTS="[]"
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
START_TIME=$(date +%s%3N)

# Start live tracking if dashboard is configured
LIVE_TEST_RUN_ID=""
if [ -n "$DASHBOARD_URL" ] && [ -n "$DASHBOARD_API_KEY" ]; then
    echo -e "${BLUE}[Live] Starting live tracking...${NC}"

    # Build tests array for live start
    if [[ "$TEST_CONFIG" == *.json ]]; then
        TESTS_PAYLOAD=$(cat "$TEST_CONFIG")
    else
        TESTS_PAYLOAD="["
        FIRST=true
        while IFS='|' read -r url goal || [ -n "$url" ]; do
            [[ "$url" =~ ^#.*$ ]] && continue
            [[ -z "$url" ]] && continue
            if [ "$FIRST" = true ]; then
                FIRST=false
            else
                TESTS_PAYLOAD+=","
            fi
            TESTS_PAYLOAD+="{\"url\":\"$url\",\"goal\":\"$goal\"}"
        done < "$TEST_CONFIG"
        TESTS_PAYLOAD+="]"
    fi

    # Get GitLab CI variables
    BRANCH="${CI_COMMIT_REF_NAME:-}"
    COMMIT="${CI_COMMIT_SHA:-}"
    BUILD_URL="${CI_PIPELINE_URL:-}"
    JOB_NAME="${CI_PROJECT_PATH:-}/${CI_JOB_NAME:-}"

    LIVE_PAYLOAD=$(jq -n \
        --arg platform "gitlab-ci" \
        --arg jobName "$JOB_NAME" \
        --arg buildNumber "${CI_PIPELINE_ID:-}" \
        --arg buildUrl "$BUILD_URL" \
        --arg branch "$BRANCH" \
        --arg commit "$COMMIT" \
        --argjson totalTests "$TEST_COUNT" \
        --argjson tests "$TESTS_PAYLOAD" \
        '{platform: $platform, jobName: $jobName, buildNumber: $buildNumber, buildUrl: $buildUrl, branch: $branch, commit: $commit, totalTests: $totalTests, tests: $tests}')

    LIVE_RESPONSE=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $DASHBOARD_API_KEY" \
        -d "$LIVE_PAYLOAD" \
        "${DASHBOARD_URL%/}/api/live/start" || echo '{"error": "failed"}')

    LIVE_TEST_RUN_ID=$(echo "$LIVE_RESPONSE" | jq -r '.testRunId // empty')

    if [ -n "$LIVE_TEST_RUN_ID" ]; then
        echo -e "${GREEN}[Live] Test run started: $LIVE_TEST_RUN_ID${NC}"
        echo -e "${BLUE}[Live] View progress at: ${DASHBOARD_URL%/}/runs/$LIVE_TEST_RUN_ID${NC}"
    else
        echo -e "${YELLOW}[Live] Warning: Could not start live tracking${NC}"
    fi
    echo ""
fi

# Function to run a single test
run_test() {
    local url="$1"
    local goal="$2"
    local index="$3"

    echo "-------------------------------------------"
    echo -e "${BLUE}Test $((index + 1))/$TEST_COUNT${NC}"
    echo "URL: $url"
    echo "Goal: $goal"
    echo "-------------------------------------------"

    # Set up environment for live tracking
    local EXTRA_ARGS=""
    if [ -n "$LIVE_TEST_RUN_ID" ]; then
        export TEST_RUN_ID="$LIVE_TEST_RUN_ID"
        export TEST_INDEX="$index"
        EXTRA_ARGS="--live"
    fi

    # Run the test
    local TEST_START=$(date +%s%3N)
    local OUTPUT
    OUTPUT=$(cd /at-agent && npm run start:agent-cli -- "$url" "$goal" "$PROVIDER" --json $EXTRA_ARGS 2>&1) || true
    local TEST_END=$(date +%s%3N)
    local DURATION=$((TEST_END - TEST_START))

    # Extract JSON from output
    local JSON_RESULT
    JSON_RESULT=$(echo "$OUTPUT" | grep -o '{"url".*}' | head -1 || echo '{}')

    # Parse result
    local SUCCESS
    SUCCESS=$(echo "$JSON_RESULT" | jq -r '.success // false')
    local REASON
    REASON=$(echo "$JSON_RESULT" | jq -r '.reason // empty')
    local ERROR
    ERROR=$(echo "$JSON_RESULT" | jq -r '.error // empty')

    # Build result object
    local RESULT
    RESULT=$(echo "$JSON_RESULT" | jq --arg duration "$DURATION" '. + {duration: ($duration | tonumber)}')

    # Add to results array
    RESULTS=$(echo "$RESULTS" | jq --argjson result "$RESULT" '. + [$result]')

    TOTAL_TESTS=$((TOTAL_TESTS + 1))

    # Notify dashboard of test completion
    if [ -n "$LIVE_TEST_RUN_ID" ] && [ -n "$DASHBOARD_URL" ] && [ -n "$DASHBOARD_API_KEY" ]; then
        curl -s -X POST \
            -H "Content-Type: application/json" \
            -H "X-API-Key: $DASHBOARD_API_KEY" \
            -d "{\"testRunId\":\"$LIVE_TEST_RUN_ID\",\"testIndex\":$index,\"success\":$SUCCESS,\"url\":\"$url\",\"goal\":\"$goal\"}" \
            "${DASHBOARD_URL%/}/api/live/test-complete" > /dev/null 2>&1 || true
    fi

    if [ "$SUCCESS" = "true" ]; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
        echo -e "${GREEN}PASSED${NC}: ${REASON:-Test completed successfully}"
    else
        FAILED_TESTS=$((FAILED_TESTS + 1))
        echo -e "${RED}FAILED${NC}: ${ERROR:-${REASON:-Test did not pass}}"

        if [ "$CONTINUE_ON_FAILURE" != "true" ]; then
            echo -e "${RED}Stopping due to test failure (CONTINUE_ON_FAILURE=false)${NC}"
            return 1
        fi
    fi

    echo ""
    return 0
}

# Run all tests
TEST_INDEX=0
if [[ "$TEST_CONFIG" == *.json ]]; then
    # JSON format
    while IFS= read -r test; do
        url=$(echo "$test" | jq -r '.url')
        goal=$(echo "$test" | jq -r '.goal')
        run_test "$url" "$goal" "$TEST_INDEX" || break
        TEST_INDEX=$((TEST_INDEX + 1))
    done < <(cat "$TEST_CONFIG" | jq -c '.[]')
else
    # Text format
    while IFS='|' read -r url goal || [ -n "$url" ]; do
        [[ "$url" =~ ^#.*$ ]] && continue
        [[ -z "$url" ]] && continue
        url=$(echo "$url" | xargs)
        goal=$(echo "$goal" | xargs)
        run_test "$url" "$goal" "$TEST_INDEX" || break
        TEST_INDEX=$((TEST_INDEX + 1))
    done < "$TEST_CONFIG"
fi

END_TIME=$(date +%s%3N)
TOTAL_DURATION=$((END_TIME - START_TIME))

# Complete live run
if [ -n "$LIVE_TEST_RUN_ID" ] && [ -n "$DASHBOARD_URL" ] && [ -n "$DASHBOARD_API_KEY" ]; then
    echo -e "${BLUE}[Live] Completing test run...${NC}"

    COMPLETE_PAYLOAD=$(jq -n \
        --arg testRunId "$LIVE_TEST_RUN_ID" \
        --argjson results "$RESULTS" \
        --argjson totalDuration "$TOTAL_DURATION" \
        '{testRunId: $testRunId, results: $results, totalDuration: $totalDuration}')

    curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $DASHBOARD_API_KEY" \
        -d "$COMPLETE_PAYLOAD" \
        "${DASHBOARD_URL%/}/api/live/complete" > /dev/null 2>&1 || true

    echo -e "${GREEN}[Live] Test run completed${NC}"
    echo -e "${BLUE}[Live] View results at: ${DASHBOARD_URL%/}/runs/$LIVE_TEST_RUN_ID${NC}"
fi

# Calculate pass rate
if [ "$TOTAL_TESTS" -gt 0 ]; then
    PASS_RATE=$(echo "scale=1; $PASSED_TESTS * 100 / $TOTAL_TESTS" | bc)
else
    PASS_RATE="0.0"
fi

# Print summary
echo ""
echo -e "${BLUE}==========================================${NC}"
echo -e "${BLUE}  Test Summary${NC}"
echo -e "${BLUE}==========================================${NC}"
echo "Total: $TOTAL_TESTS"
echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
echo -e "Failed: ${RED}$FAILED_TESTS${NC}"
echo "Pass Rate: $PASS_RATE%"
echo "Duration: $(echo "scale=1; $TOTAL_DURATION / 1000" | bc)s"
echo -e "${BLUE}==========================================${NC}"

# Write JSON results
echo "$RESULTS" > "$OUTPUT_DIR/accessibility-results.json"
echo -e "${BLUE}Results written to: $OUTPUT_DIR/accessibility-results.json${NC}"

# Generate JUnit XML report for GitLab test reporting
JUNIT_FILE="$OUTPUT_DIR/accessibility-results.xml"
cat > "$JUNIT_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Accessibility Tests" tests="$TOTAL_TESTS" failures="$FAILED_TESTS" time="$(echo "scale=3; $TOTAL_DURATION / 1000" | bc)">
  <testsuite name="AT Agent" tests="$TOTAL_TESTS" failures="$FAILED_TESTS" time="$(echo "scale=3; $TOTAL_DURATION / 1000" | bc)">
EOF

echo "$RESULTS" | jq -c '.[]' | while read -r result; do
    url=$(echo "$result" | jq -r '.url')
    goal=$(echo "$result" | jq -r '.goal')
    success=$(echo "$result" | jq -r '.success')
    duration=$(echo "$result" | jq -r '.duration // 0')
    reason=$(echo "$result" | jq -r '.reason // empty')
    error=$(echo "$result" | jq -r '.error // empty')

    # Escape XML special characters
    goal_escaped=$(echo "$goal" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')
    url_escaped=$(echo "$url" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')

    echo "    <testcase name=\"$goal_escaped\" classname=\"$url_escaped\" time=\"$(echo "scale=3; $duration / 1000" | bc)\">" >> "$JUNIT_FILE"

    if [ "$success" != "true" ]; then
        error_msg="${error:-${reason:-Test failed}}"
        error_escaped=$(echo "$error_msg" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')
        echo "      <failure message=\"$error_escaped\">$error_escaped</failure>" >> "$JUNIT_FILE"
    fi

    echo "    </testcase>" >> "$JUNIT_FILE"
done

cat >> "$JUNIT_FILE" << EOF
  </testsuite>
</testsuites>
EOF

echo -e "${BLUE}JUnit report written to: $JUNIT_FILE${NC}"

# Exit with appropriate code
if [ "$FAILED_TESTS" -gt 0 ]; then
    exit 1
else
    exit 0
fi
