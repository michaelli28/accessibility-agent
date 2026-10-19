# AT Agent GitLab CI Integration

Run AI-powered accessibility tests in your GitLab CI/CD pipelines.

## Quick Start

### Option 1: Using the Docker Image (Recommended)

Add to your `.gitlab-ci.yml`:

```yaml
accessibility-tests:
  stage: test
  image: your-registry/at-agent:latest
  variables:
    TEST_CONFIG: "accessibility-tests.json"
    OPENAI_API_KEY: $OPENAI_API_KEY
  script:
    - /entrypoint.sh
  artifacts:
    when: always
    reports:
      junit: /output/accessibility-results.xml
```

### Option 2: Using the Remote Template

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/your-org/at-agent/main/gitlab-ci/.gitlab-ci-template.yml'

accessibility-tests:
  extends: .at-agent-test
  variables:
    TEST_CONFIG: "accessibility-tests.json"
    OPENAI_API_KEY: $OPENAI_API_KEY
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TEST_CONFIG` | Yes | - | Path to test configuration file |
| `OPENAI_API_KEY` | Conditional | - | OpenAI API key (required if PROVIDER=openai) |
| `GEMINI_API_KEY` | Conditional | - | Gemini API key (required if PROVIDER=gemini) |
| `PROVIDER` | No | `openai` | LLM provider to use |
| `HEADLESS` | No | `true` | Run browser in headless mode |
| `CONTINUE_ON_FAILURE` | No | `true` | Continue testing after a failure |
| `DASHBOARD_URL` | No | - | AT Agent Dashboard URL |
| `DASHBOARD_API_KEY` | No | - | Dashboard API key |
| `OUTPUT_DIR` | No | `/output` | Directory for output files |

### Setting Up CI/CD Variables

1. Go to your GitLab project
2. Navigate to Settings > CI/CD > Variables
3. Add the following variables:
   - `OPENAI_API_KEY` (masked, protected)
   - `DASHBOARD_API_KEY` (masked, protected) - if using dashboard

### Test Configuration File

Create a JSON file with your test cases:

```json
[
  {
    "url": "https://example.com",
    "goal": "Navigate to the main content and verify all headings are properly structured"
  },
  {
    "url": "https://example.com/login",
    "goal": "Fill out the login form and submit it using only keyboard navigation"
  }
]
```

Or use a simple text format:

```
https://example.com|Navigate to the main content and verify headings
https://example.com/login|Fill out and submit the login form
```

## Features

### JUnit Test Reports

The integration automatically generates JUnit XML reports that GitLab can parse:

```yaml
artifacts:
  reports:
    junit: /output/accessibility-results.xml
```

This enables:
- Test results in merge request widgets
- Test history tracking
- Failed test notifications

### Dashboard Integration

Enable real-time tracking and result storage:

```yaml
variables:
  DASHBOARD_URL: "https://your-dashboard.example.com"
  DASHBOARD_API_KEY: $DASHBOARD_API_KEY
```

Benefits:
- Live progress tracking during pipeline execution
- Historical test results and trends
- Cross-project accessibility metrics

### Merge Request Integration

Run accessibility tests on merge requests:

```yaml
accessibility-tests:
  extends: .at-agent-test
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

### Scheduled Audits

Run comprehensive accessibility audits on a schedule:

```yaml
scheduled-audit:
  extends: .at-agent-test
  variables:
    TEST_CONFIG: "full-audit.json"
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
```

## Building the Docker Image

To build the Docker image for your own registry:

```bash
cd /path/to/at-agent
docker build -f gitlab-ci/Dockerfile -t your-registry/at-agent:latest .
docker push your-registry/at-agent:latest
```

### Using GitLab Container Registry

```bash
docker build -f gitlab-ci/Dockerfile -t registry.gitlab.com/your-group/at-agent:latest .
docker push registry.gitlab.com/your-group/at-agent:latest
```

Then reference it in your pipeline:

```yaml
image: registry.gitlab.com/your-group/at-agent:latest
```

## Troubleshooting

### Browser Issues

If you encounter browser-related errors:

1. Ensure `HEADLESS=true` is set
2. The Docker image includes Playwright with Chromium pre-installed
3. For self-hosted runners, install Playwright dependencies:
   ```bash
   npx playwright install --with-deps chromium
   ```

### API Key Issues

- Verify your API key is correctly set in CI/CD variables
- Ensure the variable is not protected if running on non-protected branches
- Check that the provider matches your API key (openai/gemini)

### Timeout Issues

For long-running tests, you may need to adjust GitLab's job timeout:

```yaml
accessibility-tests:
  timeout: 30 minutes
```

## Examples

See the `examples/` directory for complete pipeline examples:

- `examples/.gitlab-ci.yml` - Comprehensive example with multiple job types

## License

MIT
