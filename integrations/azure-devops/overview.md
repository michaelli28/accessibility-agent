# AT Agent - Accessibility Testing

AT Agent is an AI-powered accessibility testing tool that uses a virtual screen reader to navigate and test your web applications. This extension allows you to run accessibility tests directly in your Azure Pipelines.

## Features

- **AI-Powered Testing**: Uses advanced AI models (OpenAI GPT-4 or Google Gemini) to intelligently navigate your application
- **Virtual Screen Reader**: Tests are performed using a virtual screen reader, simulating how real users with assistive technology interact with your site
- **Goal-Based Testing**: Define accessibility goals in plain English (e.g., "Navigate to the login page and submit the form")
- **Live Dashboard Integration**: Optional integration with AT Agent Dashboard for real-time test progress and historical results
- **Detailed Reports**: Get step-by-step reports of what the agent did and any accessibility issues found

## Prerequisites

1. **Node.js 20+**: The AT Agent requires Node.js 20 or later
2. **AT Agent Installation**: The AT Agent must be installed on your build agent or checked out as part of your pipeline
3. **LLM API Key**: Either an OpenAI API key or Google Gemini API key

## Usage

### Basic Usage

```yaml
steps:
- task: NodeTool@0
  inputs:
    versionSpec: '20.x'
  displayName: 'Install Node.js'

- script: |
    git clone https://github.com/your-org/at-agent.git $(Agent.BuildDirectory)/at-agent
    cd $(Agent.BuildDirectory)/at-agent
    npm install
  displayName: 'Install AT Agent'

- task: accessibility-agent@1
  inputs:
    testConfig: 'accessibility-tests.json'
    provider: 'openai'
    openaiApiKey: $(OPENAI_API_KEY)
    agentPath: '$(Agent.BuildDirectory)/at-agent'
  displayName: 'Run Accessibility Tests'
```

### With Dashboard Integration

```yaml
- task: accessibility-agent@1
  inputs:
    testConfig: 'accessibility-tests.json'
    provider: 'openai'
    openaiApiKey: $(OPENAI_API_KEY)
    agentPath: '$(Agent.BuildDirectory)/at-agent'
    dashboardUrl: 'https://your-dashboard.example.com'
    dashboardApiKey: $(DASHBOARD_API_KEY)
  displayName: 'Run Accessibility Tests'
```

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

Or use a simple text format (`tests.txt`):

```
https://example.com|Navigate to the main content and verify all headings are properly structured
https://example.com/login|Fill out the login form and submit it using only keyboard navigation
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `testConfig` | Yes | - | Path to the test configuration file (JSON or text format) |
| `provider` | No | `openai` | LLM provider to use (`openai` or `gemini`) |
| `openaiApiKey` | Conditional | - | OpenAI API key (required if provider is `openai`) |
| `geminiApiKey` | Conditional | - | Gemini API key (required if provider is `gemini`) |
| `headless` | No | `true` | Run browser in headless mode |
| `continueOnFailure` | No | `true` | Continue running tests even if one fails |
| `dashboardUrl` | No | - | Dashboard URL for live tracking and results |
| `dashboardApiKey` | No | - | Dashboard API key for authentication |
| `agentPath` | Yes | - | Path to the AT Agent installation directory |

## Outputs

| Output | Description |
|--------|-------------|
| `totalTests` | Total number of tests run |
| `passedTests` | Number of tests that passed |
| `failedTests` | Number of tests that failed |
| `passRate` | Percentage of tests that passed |
| `dashboardUrl` | URL to view results on the dashboard (if configured) |
| `resultsJson` | JSON string containing full test results |

## Support

For issues and feature requests, please visit our [GitHub repository](https://github.com/your-org/at-agent/issues).
