# Accessibility Testing Agent Jenkins Plugin

An AI-powered Jenkins plugin that runs accessibility tests on web applications using screen reader simulation.

## Features

- **AI-Driven Testing**: Uses LLM (OpenAI or Google Gemini) to intelligently navigate and test web pages
- **Screen Reader Simulation**: Simulates how screen reader users experience your website
- **Visual Dashboard**: Rich dashboard showing test results, violations, and trends
- **Pipeline Support**: Full integration with Jenkins Pipeline (`accessibilityAgent` step)
- **Configurable Goals**: Define custom accessibility test goals for each URL

## Installation

1. Build the plugin:
   ```bash
   mvn clean package
   ```

2. Install the `.hpi` file from `target/` into Jenkins via **Manage Jenkins > Plugins > Advanced > Deploy Plugin**

3. Configure the plugin in **Manage Jenkins > System** under "Accessibility Agent Configuration":
   - Set the path to your at-agent installation
   - Configure your LLM provider (OpenAI or Gemini)
   - Add your API key as a Jenkins credential

## Usage

### Pipeline (Recommended)

```groovy
pipeline {
    agent any

    stages {
        stage('Accessibility Tests') {
            steps {
                accessibilityAgent(
                    testConfigFile: 'accessibility-tests.json',
                    continueOnFailure: true,
                    failBuildOnTestFailure: true
                )
            }
        }
    }
}
```

### Freestyle Job

1. Add a build step "Run Accessibility Agent Tests"
2. Specify your test configuration file path

## Test Configuration File

Create a JSON file with your tests:

```json
[
  {
    "url": "https://example.com",
    "goal": "Navigate to the main content and verify heading structure"
  },
  {
    "url": "https://example.com/login",
    "goal": "Verify the login form is accessible with proper labels"
  }
]
```

Or use a simple text format (pipe-delimited):

```
# Comments start with #
https://example.com|Navigate to the main content and verify heading structure
https://example.com/login|Verify the login form is accessible with proper labels
```

## Global Configuration

| Setting | Description |
|---------|-------------|
| Agent Installation Path | Full path to the at-agent directory |
| Node.js Path | Path to Node.js executable (default: `node`) |
| LLM Provider | OpenAI or Google Gemini |
| API Key | Credential containing your LLM API key |
| Headless Browser | Run browser without GUI (recommended for CI) |

## Build Step Options

| Option | Description | Default |
|--------|-------------|---------|
| testConfigFile | Path to test configuration file | Required |
| continueOnFailure | Continue running tests after a failure | true |
| failBuildOnTestFailure | Mark build as failed if any test fails | true |

## Dashboard

After running tests, click "Accessibility Test Results" in the build sidebar to view:

- Overall pass/fail status
- Individual test results with expandable details
- Agent navigation steps
- Detected accessibility violations

The "Accessibility Trends" link on the project page shows historical data across builds.

## Requirements

- Jenkins 2.516+
- Node.js 18+
- The at-agent package installed and accessible

## Development

```bash
# Build
mvn clean package

# Run locally for testing
mvn hpi:run

# Run tests
mvn test
```

## LICENSE

Licensed under MIT, see [LICENSE](LICENSE.md)
