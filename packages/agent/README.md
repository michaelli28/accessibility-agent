# @at-agent/agent

AI-powered accessibility testing agent for automated web accessibility evaluation.

## Installation

```bash
npm install @at-agent/agent
```

## Usage

```typescript
import { Agent } from '@at-agent/agent'

const agent = new Agent(process.env.OPENAI_API_KEY)

const result = await agent.run(
  'Navigate to the login page and test the form for accessibility',
  {
    startUrl: 'https://example.com',
    maxSteps: 20,
  }
)

console.log(`Success: ${result.success}`)
console.log(`Steps taken: ${result.steps.length}`)
console.log(`Violations found: ${result.violations.length}`)

for (const violation of result.violations) {
  console.log(`- [${violation.impact}] ${violation.id}: ${violation.help}`)
}
```

## API

### Agent

```typescript
const agent = new Agent(apiKey: string)
```

#### Methods

- `run(goal: string, options: AgentOptions): Promise<AgentResult>` - Execute a goal
- `stop(): void` - Stop a running agent

### AgentOptions

```typescript
interface AgentOptions {
  startUrl: string      // URL to start from
  maxSteps?: number     // Maximum steps (default: 20)
  model?: string        // OpenAI model (default: 'gpt-5')
}
```

### AgentResult

```typescript
interface AgentResult {
  success: boolean      // Whether goal was achieved
  goal: string          // The original goal
  steps: Step[]         // All steps taken
  violations: Violation[] // Accessibility violations found
  summary: string       // Summary of result
}
```

## Actions

The agent can perform these actions:

- **navigate** - Go to a URL
- **click** - Click an element by role/name
- **fill** - Fill a form field
- **audit** - Run accessibility audit
- **observe** - Get current page state
- **done** - Mark goal as complete
