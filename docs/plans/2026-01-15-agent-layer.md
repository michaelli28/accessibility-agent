# Agent Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an AI agent that uses browser and accessibility layers to autonomously test web applications for accessibility issues.

**Architecture:** The Agent class coordinates goals, observations, and actions through an OpenAI-powered planner. Tools are pure functions that wrap browser/accessibility operations. State is immutable and flows through a step-based execution model.

**Tech Stack:** TypeScript (strict), OpenAI SDK, @at-agent/browser, @at-agent/accessibility, Vitest, Zod

---

## Task 1: Package Setup

**Files:**
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/agent/vitest.config.ts`
- Create: `packages/agent/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@at-agent/agent",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@at-agent/browser": "workspace:*",
    "@at-agent/accessibility": "workspace:*",
    "openai": "^4.77.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.19.25",
    "typescript": "^5.9.3",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60000,
  },
})
```

**Step 4: Create placeholder index.ts**

```typescript
// @at-agent/agent - AI-powered accessibility testing agent
export {}
```

**Step 5: Install dependencies**

Run: `cd packages/agent && npm install`

**Step 6: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): initialize package"
```

---

## Task 2: Define Core Types

**Files:**
- Create: `packages/agent/src/types.ts`
- Create: `packages/agent/src/types.test.ts`

**Step 1: Write type definitions**

```typescript
// packages/agent/src/types.ts
import { z } from 'zod'
import type { Violation } from '@at-agent/accessibility'

// Action types the agent can perform
export const ActionTypeSchema = z.enum([
  'navigate',
  'click',
  'fill',
  'audit',
  'observe',
  'done'
])
export type ActionType = z.infer<typeof ActionTypeSchema>

// An action the agent wants to perform
export const ActionSchema = z.object({
  type: ActionTypeSchema,
  target: z.string().optional(),
  value: z.string().optional(),
  reason: z.string(),
})
export type Action = z.infer<typeof ActionSchema>

// Result of executing an action
export const ActionResultSchema = z.object({
  success: z.boolean(),
  observation: z.string(),
  violations: z.array(z.custom<Violation>()).optional(),
})
export type ActionResult = z.infer<typeof ActionResultSchema>

// A single step in agent execution
export const StepSchema = z.object({
  stepNumber: z.number(),
  action: ActionSchema,
  result: ActionResultSchema,
  timestamp: z.string(),
})
export type Step = z.infer<typeof StepSchema>

// Agent configuration options
export const AgentOptionsSchema = z.object({
  startUrl: z.string().url(),
  maxSteps: z.number().positive().default(20),
  model: z.string().default('gpt-4o'),
})
export type AgentOptions = z.infer<typeof AgentOptionsSchema>

// Final result of agent execution
export const AgentResultSchema = z.object({
  success: z.boolean(),
  goal: z.string(),
  steps: z.array(StepSchema),
  violations: z.array(z.custom<Violation>()),
  summary: z.string(),
})
export type AgentResult = z.infer<typeof AgentResultSchema>
```

**Step 2: Write tests**

```typescript
// packages/agent/src/types.test.ts
import { describe, it, expect } from 'vitest'
import {
  ActionTypeSchema,
  ActionSchema,
  AgentOptionsSchema,
  StepSchema,
} from './types.js'

describe('ActionTypeSchema', () => {
  it('accepts valid action types', () => {
    expect(ActionTypeSchema.parse('navigate')).toBe('navigate')
    expect(ActionTypeSchema.parse('click')).toBe('click')
    expect(ActionTypeSchema.parse('fill')).toBe('fill')
    expect(ActionTypeSchema.parse('audit')).toBe('audit')
    expect(ActionTypeSchema.parse('observe')).toBe('observe')
    expect(ActionTypeSchema.parse('done')).toBe('done')
  })

  it('rejects invalid action types', () => {
    expect(() => ActionTypeSchema.parse('invalid')).toThrow()
  })
})

describe('ActionSchema', () => {
  it('validates action with target', () => {
    const action = {
      type: 'click',
      target: 'button[name="Submit"]',
      reason: 'Submit the form',
    }
    const result = ActionSchema.parse(action)
    expect(result.type).toBe('click')
    expect(result.target).toBe('button[name="Submit"]')
  })

  it('validates action without target', () => {
    const action = {
      type: 'observe',
      reason: 'Check current page state',
    }
    const result = ActionSchema.parse(action)
    expect(result.type).toBe('observe')
    expect(result.target).toBeUndefined()
  })
})

describe('AgentOptionsSchema', () => {
  it('applies defaults', () => {
    const options = { startUrl: 'https://example.com' }
    const result = AgentOptionsSchema.parse(options)
    expect(result.maxSteps).toBe(20)
    expect(result.model).toBe('gpt-4o')
  })

  it('rejects invalid URL', () => {
    expect(() => AgentOptionsSchema.parse({ startUrl: 'not-a-url' })).toThrow()
  })
})

describe('StepSchema', () => {
  it('validates a complete step', () => {
    const step = {
      stepNumber: 1,
      action: {
        type: 'navigate',
        target: 'https://example.com',
        reason: 'Go to homepage',
      },
      result: {
        success: true,
        observation: 'Page loaded successfully',
      },
      timestamp: '2024-01-15T00:00:00Z',
    }
    const result = StepSchema.parse(step)
    expect(result.stepNumber).toBe(1)
    expect(result.action.type).toBe('navigate')
  })
})
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Export from index**

```typescript
// packages/agent/src/index.ts
export {
  ActionTypeSchema,
  type ActionType,
  ActionSchema,
  type Action,
  ActionResultSchema,
  type ActionResult,
  StepSchema,
  type Step,
  AgentOptionsSchema,
  type AgentOptions,
  AgentResultSchema,
  type AgentResult,
} from './types.js'
```

**Step 5: Commit**

```bash
git add packages/agent/src
git commit -m "feat(agent): add core type definitions"
```

---

## Task 3: OpenAI Client Wrapper

**Files:**
- Create: `packages/agent/src/openai.ts`
- Create: `packages/agent/src/openai.test.ts`

**Step 1: Write failing test**

```typescript
// packages/agent/src/openai.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createOpenAIClient, generateAction } from './openai.js'
import type { Action } from './types.js'

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  })),
}))

describe('createOpenAIClient', () => {
  it('creates client with API key', () => {
    const client = createOpenAIClient('test-key')
    expect(client).toBeDefined()
  })
})

describe('generateAction', () => {
  it('returns parsed action from model response', async () => {
    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            type: 'click',
            target: 'button',
            reason: 'Click the button',
          }),
        },
      }],
    }

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockResponse),
        },
      },
    }

    const action = await generateAction(
      mockClient as any,
      'gpt-4o',
      'Click the submit button',
      'Page has a form with submit button',
      []
    )

    expect(action.type).toBe('click')
    expect(action.target).toBe('button')
  })

  it('handles model returning done action', async () => {
    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            type: 'done',
            reason: 'Goal achieved',
          }),
        },
      }],
    }

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockResponse),
        },
      },
    }

    const action = await generateAction(
      mockClient as any,
      'gpt-4o',
      'Test the page',
      'All tests passed',
      []
    )

    expect(action.type).toBe('done')
  })
})
```

**Step 2: Implement OpenAI wrapper**

```typescript
// packages/agent/src/openai.ts
import OpenAI from 'openai'
import { ActionSchema, type Action, type Step } from './types.js'

export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey })
}

const SYSTEM_PROMPT = `You are an accessibility testing agent. Your goal is to navigate web pages and test them for accessibility issues.

You can perform these actions:
- navigate: Go to a URL (target = URL)
- click: Click an element (target = role/text description like "button named Submit")
- fill: Fill a form field (target = field description, value = text to enter)
- audit: Run accessibility audit on current page
- observe: Get current page state and accessibility tree
- done: Goal is complete or cannot be achieved

Respond with a JSON object containing:
{
  "type": "action_type",
  "target": "optional target",
  "value": "optional value for fill",
  "reason": "why this action"
}

Think step by step. After navigating, observe the page. Run audits to find issues. Report done when goal is achieved or blocked.`

export async function generateAction(
  client: OpenAI,
  model: string,
  goal: string,
  observation: string,
  history: Step[]
): Promise<Action> {
  const historyText = history
    .map((s) => `Step ${s.stepNumber}: ${s.action.type} - ${s.result.observation}`)
    .join('\n')

  const userPrompt = `Goal: ${goal}

Previous steps:
${historyText || 'None'}

Current observation:
${observation}

What action should I take next?`

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  })

  const content = response.choices[0]?.message?.content
  if (!content) {
    throw new Error('No response from model')
  }

  const parsed = JSON.parse(content)
  return ActionSchema.parse(parsed)
}
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/agent/src/openai.ts packages/agent/src/openai.test.ts
git commit -m "feat(agent): add OpenAI client wrapper"
```

---

## Task 4: Tool Functions

**Files:**
- Create: `packages/agent/src/tools.ts`
- Create: `packages/agent/src/tools.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/agent/src/tools.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { BrowserClient, BrowserPage } from '@at-agent/browser'
import { executeAction } from './tools.js'
import type { Action } from './types.js'

describe('executeAction', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
  })

  afterAll(async () => {
    await client.close()
  })

  describe('navigate', () => {
    it('navigates to URL and returns observation', async () => {
      page = await client.newPage()
      const action: Action = {
        type: 'navigate',
        target: 'https://example.com',
        reason: 'Go to example.com',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(true)
      expect(result.observation).toContain('Example Domain')
      await page.close()
    })
  })

  describe('observe', () => {
    it('returns page state and accessibility info', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'observe',
        reason: 'Check page state',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(true)
      expect(result.observation).toContain('heading')
      await page.close()
    })
  })

  describe('audit', () => {
    it('runs accessibility audit and returns results', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'audit',
        reason: 'Check accessibility',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(true)
      expect(result.observation).toContain('audit')
      await page.close()
    })
  })

  describe('click', () => {
    it('clicks element by role and name', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'click',
        target: 'link named "More information"',
        reason: 'Click the link',
      }

      const result = await executeAction(action, page)

      // May succeed or fail depending on element existence
      expect(result.observation).toBeDefined()
      await page.close()
    })
  })

  describe('done', () => {
    it('returns completion message', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'done',
        reason: 'Goal achieved',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(true)
      expect(result.observation).toContain('Goal achieved')
      await page.close()
    })
  })
})
```

**Step 2: Implement tools**

```typescript
// packages/agent/src/tools.ts
import type { BrowserPage } from '@at-agent/browser'
import { Auditor, ScreenReaderSimulator } from '@at-agent/accessibility'
import type { Action, ActionResult } from './types.js'

export async function executeAction(
  action: Action,
  page: BrowserPage
): Promise<ActionResult> {
  switch (action.type) {
    case 'navigate':
      return executeNavigate(action, page)
    case 'click':
      return executeClick(action, page)
    case 'fill':
      return executeFill(action, page)
    case 'audit':
      return executeAudit(page)
    case 'observe':
      return executeObserve(page)
    case 'done':
      return executeDone(action)
    default:
      return {
        success: false,
        observation: `Unknown action type: ${action.type}`,
      }
  }
}

async function executeNavigate(
  action: Action,
  page: BrowserPage
): Promise<ActionResult> {
  try {
    if (!action.target) {
      return { success: false, observation: 'No URL provided' }
    }
    await page.goto(action.target)
    const title = await page.title()
    return {
      success: true,
      observation: `Navigated to ${action.target}. Page title: "${title}"`,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Navigation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

async function executeClick(
  action: Action,
  page: BrowserPage
): Promise<ActionResult> {
  try {
    if (!action.target) {
      return { success: false, observation: 'No target provided' }
    }

    // Parse target like "button named Submit" or "link named More information"
    const match = action.target.match(/(\w+)\s+named\s+"([^"]+)"/i)
    if (match) {
      const [, role, name] = match
      await page.clickByRole(role, { name })
      return {
        success: true,
        observation: `Clicked ${role} named "${name}"`,
      }
    }

    // Try clicking by text
    await page.clickByText(action.target)
    return {
      success: true,
      observation: `Clicked element with text "${action.target}"`,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Click failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

async function executeFill(
  action: Action,
  page: BrowserPage
): Promise<ActionResult> {
  try {
    if (!action.target || !action.value) {
      return { success: false, observation: 'No target or value provided' }
    }

    // Parse target like "textbox named Email"
    const match = action.target.match(/(\w+)\s+named\s+"([^"]+)"/i)
    if (match) {
      const [, role, name] = match
      await page.fillByRole(role, action.value, { name })
      return {
        success: true,
        observation: `Filled ${role} named "${name}" with "${action.value}"`,
      }
    }

    return {
      success: false,
      observation: `Could not parse target: ${action.target}`,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Fill failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

async function executeAudit(page: BrowserPage): Promise<ActionResult> {
  try {
    const auditor = new Auditor()
    const result = await auditor.audit(page)
    const summary = auditor.getSummary(result)

    const observation = [
      `Accessibility audit complete:`,
      `- ${summary.totalViolations} violations found`,
      `- Critical: ${summary.byImpact.critical}`,
      `- Serious: ${summary.byImpact.serious}`,
      `- Moderate: ${summary.byImpact.moderate}`,
      `- Minor: ${summary.byImpact.minor}`,
      `- ${summary.totalPasses} rules passed`,
    ].join('\n')

    return {
      success: true,
      observation,
      violations: result.violations,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Audit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

async function executeObserve(page: BrowserPage): Promise<ActionResult> {
  try {
    const url = await page.url()
    const title = await page.title()
    const tree = await page.accessibilityTree()

    // Summarize accessibility tree
    const simulator = new ScreenReaderSimulator(page)
    const headings = await simulator.getHeadings()
    const landmarks = await simulator.getLandmarks()

    const observation = [
      `Current page: ${url}`,
      `Title: "${title}"`,
      `Headings: ${headings.map((h) => `"${h.text}"`).join(', ') || 'None'}`,
      `Landmarks: ${landmarks.map((l) => l.role).join(', ') || 'None'}`,
      `Accessibility tree root: ${tree.role} "${tree.name}"`,
    ].join('\n')

    return {
      success: true,
      observation,
    }
  } catch (error) {
    return {
      success: false,
      observation: `Observe failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

function executeDone(action: Action): ActionResult {
  return {
    success: true,
    observation: `Agent finished: ${action.reason}`,
  }
}
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/tools.test.ts
git commit -m "feat(agent): add action execution tools"
```

---

## Task 5: Agent Class

**Files:**
- Create: `packages/agent/src/agent.ts`
- Create: `packages/agent/src/agent.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/agent/src/agent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Agent } from './agent.js'
import * as openai from './openai.js'

// Mock OpenAI module
vi.mock('./openai.js', () => ({
  createOpenAIClient: vi.fn(),
  generateAction: vi.fn(),
}))

describe('Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('creates agent with API key', () => {
      const agent = new Agent('test-api-key')
      expect(agent).toBeDefined()
    })
  })

  describe('run', () => {
    it('executes goal and returns result', async () => {
      // Mock generateAction to return navigate, observe, audit, then done
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction
        .mockResolvedValueOnce({
          type: 'navigate',
          target: 'https://example.com',
          reason: 'Navigate to target',
        })
        .mockResolvedValueOnce({
          type: 'observe',
          reason: 'Check page state',
        })
        .mockResolvedValueOnce({
          type: 'audit',
          reason: 'Run accessibility check',
        })
        .mockResolvedValueOnce({
          type: 'done',
          reason: 'Audit complete',
        })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Audit example.com for accessibility', {
        startUrl: 'https://example.com',
        maxSteps: 10,
      })

      expect(result.success).toBe(true)
      expect(result.steps.length).toBe(4)
      expect(result.goal).toBe('Audit example.com for accessibility')
    }, 60000)

    it('stops after maxSteps', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      // Always return observe (never done)
      mockGenerateAction.mockResolvedValue({
        type: 'observe',
        reason: 'Keep observing',
      })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Never-ending goal', {
        startUrl: 'https://example.com',
        maxSteps: 3,
      })

      expect(result.success).toBe(false)
      expect(result.steps.length).toBe(3)
      expect(result.summary).toContain('max steps')
    }, 60000)

    it('collects violations from audit steps', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction
        .mockResolvedValueOnce({
          type: 'navigate',
          target: 'https://example.com',
          reason: 'Navigate',
        })
        .mockResolvedValueOnce({
          type: 'audit',
          reason: 'Check accessibility',
        })
        .mockResolvedValueOnce({
          type: 'done',
          reason: 'Complete',
        })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Audit the page', {
        startUrl: 'https://example.com',
      })

      expect(result.violations).toBeDefined()
      expect(Array.isArray(result.violations)).toBe(true)
    }, 60000)
  })

  describe('stop', () => {
    it('stops running agent', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          type: 'observe',
          reason: 'Slow action',
        }), 1000))
      )

      const agent = new Agent('test-api-key')
      const runPromise = agent.run('Long running goal', {
        startUrl: 'https://example.com',
        maxSteps: 100,
      })

      // Stop after short delay
      setTimeout(() => agent.stop(), 100)

      const result = await runPromise
      expect(result.success).toBe(false)
      expect(result.summary).toContain('stopped')
    }, 60000)
  })
})
```

**Step 2: Implement Agent class**

```typescript
// packages/agent/src/agent.ts
import { BrowserClient, BrowserPage } from '@at-agent/browser'
import type { Violation } from '@at-agent/accessibility'
import { createOpenAIClient, generateAction } from './openai.js'
import { executeAction } from './tools.js'
import {
  AgentOptionsSchema,
  type AgentOptions,
  type AgentResult,
  type Step,
} from './types.js'
import type OpenAI from 'openai'

export class Agent {
  private client: OpenAI
  private stopped = false

  constructor(apiKey: string) {
    this.client = createOpenAIClient(apiKey)
  }

  async run(
    goal: string,
    options: Partial<AgentOptions> & { startUrl: string }
  ): Promise<AgentResult> {
    const opts = AgentOptionsSchema.parse(options)
    this.stopped = false

    const browser = new BrowserClient()
    await browser.launch()

    const steps: Step[] = []
    const violations: Violation[] = []
    let page: BrowserPage | null = null

    try {
      page = await browser.newPage()
      let observation = `Starting at ${opts.startUrl}. Goal: ${goal}`

      for (let stepNumber = 1; stepNumber <= opts.maxSteps; stepNumber++) {
        if (this.stopped) {
          return this.createResult(goal, steps, violations, false, 'Agent stopped by user')
        }

        const action = await generateAction(
          this.client,
          opts.model,
          goal,
          observation,
          steps
        )

        // Navigate to start URL on first step if action is not navigate
        if (stepNumber === 1 && action.type !== 'navigate') {
          await page.goto(opts.startUrl)
        }

        const result = await executeAction(action, page)

        const step: Step = {
          stepNumber,
          action,
          result,
          timestamp: new Date().toISOString(),
        }
        steps.push(step)

        // Collect violations from audit steps
        if (result.violations) {
          violations.push(...result.violations)
        }

        observation = result.observation

        // Check if done
        if (action.type === 'done') {
          return this.createResult(goal, steps, violations, true, action.reason)
        }
      }

      // Reached max steps
      return this.createResult(
        goal,
        steps,
        violations,
        false,
        `Reached max steps (${opts.maxSteps}) without completing goal`
      )
    } finally {
      if (page) {
        await page.close()
      }
      await browser.close()
    }
  }

  stop(): void {
    this.stopped = true
  }

  private createResult(
    goal: string,
    steps: Step[],
    violations: Violation[],
    success: boolean,
    summary: string
  ): AgentResult {
    return {
      success,
      goal,
      steps,
      violations,
      summary,
    }
  }
}
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/agent/src/agent.ts packages/agent/src/agent.test.ts
git commit -m "feat(agent): add Agent class"
```

---

## Task 6: Export Public API

**Files:**
- Modify: `packages/agent/src/index.ts`

**Step 1: Update exports**

```typescript
// packages/agent/src/index.ts
export {
  ActionTypeSchema,
  type ActionType,
  ActionSchema,
  type Action,
  ActionResultSchema,
  type ActionResult,
  StepSchema,
  type Step,
  AgentOptionsSchema,
  type AgentOptions,
  AgentResultSchema,
  type AgentResult,
} from './types.js'

export { createOpenAIClient, generateAction } from './openai.js'
export { executeAction } from './tools.js'
export { Agent } from './agent.js'
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/agent/src/index.ts
git commit -m "feat(agent): export public API"
```

---

## Task 7: Documentation and Final Verification

**Files:**
- Create: `packages/agent/README.md`

**Step 1: Create README**

```markdown
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
  model?: string        // OpenAI model (default: 'gpt-4o')
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
```

**Step 2: Final test run**

Run: `npm test && npm run build`
Expected: All tests pass, build succeeds

**Step 3: Commit**

```bash
git add packages/agent/README.md
git commit -m "docs(agent): add README"
```

**Step 4: Push branch**

```bash
git push -u origin rebuild/agent-layer
```

---

## Summary

After completing all tasks:

- `packages/agent/` - New AI agent package
- OpenAI SDK integration for action generation
- Tool functions wrapping browser/accessibility operations
- Agent class coordinating goal execution
- Clean TypeScript with Zod schemas
- Ready for Application Layer to use

**Next phase:** Build `packages/cli/` using browser, accessibility, and agent layers.
