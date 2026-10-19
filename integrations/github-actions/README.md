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
