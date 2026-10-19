# GitHub Actions Integration Design

## Overview

Two composite GitHub Actions that wrap the at-agent CLI for CI/CD accessibility testing:
- **audit** - Run accessibility audit on a URL
- **flow** - Run AI-guided accessibility flow test

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Action structure | Separate actions | Clearer intent, easier to maintain |
| Action type | Composite | Simple, transparent, thin wrapper around CLI |
| Failure threshold | Single `fail-on` input | Simple mental model, covers most use cases |
| Job summary | Always generate | Low effort, high UX value |
| CLI installation | npm from GitHub | Works before npm publish, easy to switch later |
| API key handling | Input with env var fallback | Flexible for different user preferences |

## Structure

```
integrations/
└── github-actions/
    ├── audit/
    │   ├── action.yml       # Composite action definition
    │   └── run.sh           # Main script (testable locally)
    ├── flow/
    │   ├── action.yml
    │   └── run.sh
    ├── scripts/
    │   └── generate-summary.sh  # Shared summary generation
    └── README.md            # Usage documentation
```

## Usage

```yaml
# Audit action
- uses: your-org/at-agent/integrations/github-actions/audit@main
  with:
    url: https://example.com
    fail-on: serious

# Flow action
- uses: your-org/at-agent/integrations/github-actions/flow@main
  with:
    url: https://example.com
    goal: "complete checkout as guest user"
    api-key: ${{ secrets.OPENAI_API_KEY }}
```

## Audit Action

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | Yes | - | URL to audit |
| `fail-on` | No | `serious` | Minimum impact level to fail: `critical`, `serious`, `moderate`, `minor`, or `none` |
| `tags` | No | - | Space-separated WCAG tags (e.g., `wcag2a wcag2aa`) |
| `node-version` | No | `20` | Node.js version to use |

### Outputs

| Output | Description |
|--------|-------------|
| `violations` | Total violation count |
| `critical` | Critical violation count |
| `serious` | Serious violation count |
| `json` | Full JSON results |

### Behavior

1. Sets up Node.js via `actions/setup-node`
2. Installs CLI via `npm install github:your-org/at-agent#packages/cli`
3. Runs `at-agent audit <url> --json [--tags ...]`
4. Parses JSON output, sets outputs
5. Generates Job Summary with violation table
6. Exits non-zero if violations meet or exceed `fail-on` threshold

## Flow Action

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | Yes | - | Starting URL for the flow |
| `goal` | Yes | - | Goal for the agent to achieve |
| `api-key` | No | - | OpenAI API key (falls back to `OPENAI_API_KEY` env var) |
| `max-steps` | No | `20` | Maximum steps before stopping |
| `node-version` | No | `20` | Node.js version to use |

### Outputs

| Output | Description |
|--------|-------------|
| `success` | Whether the goal was achieved (`true`/`false`) |
| `steps` | Number of steps taken |
| `violations` | Violations found during flow |
| `json` | Full JSON results |

### Behavior

1. Sets up Node.js via `actions/setup-node`
2. Installs CLI via `npm install github:your-org/at-agent#packages/cli`
3. Sets `OPENAI_API_KEY` from input or existing env var
4. Runs `at-agent flow <url> --goal "<goal>" --json [--max-steps ...]`
5. Parses JSON output, sets outputs
6. Generates Job Summary with steps taken and violations found
7. Exits non-zero if goal was not achieved

## Job Summaries

### Audit Summary

```markdown
## Accessibility Audit Results

**URL:** https://example.com
**Status:** ❌ Failed (2 serious violations)

### Violations by Impact

| Impact | Count |
|--------|-------|
| 🔴 Critical | 0 |
| 🟠 Serious | 2 |
| 🟡 Moderate | 5 |
| 🔵 Minor | 1 |

### Top Violations

| Rule | Impact | Count | Help |
|------|--------|-------|------|
| color-contrast | Serious | 2 | [Elements must have sufficient color contrast](https://dequeuniversity.com/...) |
| image-alt | Moderate | 3 | [Images must have alternate text](https://dequeuniversity.com/...) |
```

### Flow Summary

```markdown
## Accessibility Flow Test

**URL:** https://example.com
**Goal:** Complete checkout as guest user
**Status:** ✅ Passed (12 steps)

### Steps Taken

1. Clicked "Shop Now" button
2. Selected first product
3. Added to cart
...

### Violations Found: 3

| Rule | Impact | Location |
|------|--------|----------|
| button-name | Serious | Checkout button |
```

## Testing Strategy

### Script Extraction

Composite actions call shell scripts that do the actual work. Scripts are testable locally.

### Local Testing

```bash
INPUT_URL="https://example.com" INPUT_FAIL_ON="serious" ./run.sh
```

### Integration Testing

A test workflow in `.github/workflows/test-actions.yml` runs both actions against a known test site.

### Test Site

Use existing `test-sites/` directory or a public site with known accessibility issues.

## Implementation Order

1. Audit action `run.sh` script
2. Audit action `action.yml`
3. Audit summary generation
4. Flow action `run.sh` script
5. Flow action `action.yml`
6. Flow summary generation
7. Integration test workflow
8. README documentation
