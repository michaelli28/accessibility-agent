# @at-agent/cli

Command-line interface for AI-powered accessibility testing.

## Installation

```bash
npm install -g @at-agent/cli
```

## Usage

### Audit Command

Run an accessibility audit on a URL:

```bash
at-agent audit https://example.com
at-agent audit https://example.com --json
at-agent audit https://example.com --tags wcag2a wcag2aa
```

### Flow Command

Run AI-guided accessibility flow testing:

```bash
export OPENAI_API_KEY=your-key
at-agent flow https://example.com --goal "Test the login form"
at-agent flow https://example.com --goal "Complete checkout" --max-steps 30
at-agent flow https://example.com --goal "Test navigation" --json
```

## Options

### Global

- `--version` - Show version
- `--help` - Show help

### Audit

- `--json` - Output results as JSON
- `--tags <tags...>` - WCAG tags to check (e.g., wcag2a wcag2aa)

### Flow

- `--goal <goal>` - (Required) Goal for the agent
- `--json` - Output results as JSON
- `--max-steps <n>` - Maximum steps (default: 20)
- `--api-key <key>` - OpenAI API key (or use OPENAI_API_KEY env var)

## Exit Codes

- `0` - Success (no critical/serious violations)
- `1` - Failure (errors or critical/serious violations found)
