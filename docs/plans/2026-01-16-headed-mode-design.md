# Headed Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--headed` flag to flow command to show visible browser window during agent execution.

**Architecture:** Option flows CLI → Agent → BrowserClient. Each layer adds `headed` to its options schema and passes it down.

**Tech Stack:** TypeScript, Zod schemas, Commander CLI, Vitest

---

### Task 1: Add `headed` option to AgentOptionsSchema

**Files:**
- Modify: `packages/agent/src/types.ts:42-47`
- Modify: `packages/agent/src/types.test.ts:108-139`

**Step 1: Write failing test for headed default**

Add to `packages/agent/src/types.test.ts` inside the `AgentOptionsSchema` describe block:

```typescript
it('defaults headed to false', () => {
  const options = { startUrl: 'https://example.com' }
  const result = AgentOptionsSchema.parse(options)
  expect(result.headed).toBe(false)
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:packages -- --filter @at-agent/agent -- run src/types.test.ts`
Expected: FAIL - Property 'headed' does not exist

**Step 3: Add headed to schema**

In `packages/agent/src/types.ts`, change AgentOptionsSchema:

```typescript
export const AgentOptionsSchema = z.object({
  startUrl: z.string().url(),
  maxSteps: z.number().positive().default(20),
  model: z.string().default('gpt-5'),
  headed: z.boolean().default(false),
})
```

**Step 4: Run test to verify it passes**

Run: `npm run test:packages -- --filter @at-agent/agent -- run src/types.test.ts`
Expected: PASS

**Step 5: Write test for headed override**

Add another test:

```typescript
it('allows setting headed to true', () => {
  const options = { startUrl: 'https://example.com', headed: true }
  const result = AgentOptionsSchema.parse(options)
  expect(result.headed).toBe(true)
})
```

**Step 6: Run test to verify it passes**

Run: `npm run test:packages -- --filter @at-agent/agent -- run src/types.test.ts`
Expected: PASS (schema already supports boolean)

**Step 7: Commit**

```bash
git add packages/agent/src/types.ts packages/agent/src/types.test.ts
git commit -m "feat(agent): add headed option to AgentOptionsSchema"
```

---

### Task 2: Pass headed option to BrowserClient

**Files:**
- Modify: `packages/agent/src/agent.ts:28`
- Test: `packages/agent/src/agent.test.ts` (create if needed)

**Step 1: Write failing test**

Create `packages/agent/src/agent.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Agent } from './agent.js'

// Mock dependencies
vi.mock('@at-agent/browser', () => ({
  BrowserClient: vi.fn().mockImplementation(() => ({
    launch: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getAccessibilityTree: vi.fn().mockResolvedValue({ role: 'document', name: null, value: null, description: null, children: [] }),
    }),
  })),
  BrowserPage: vi.fn(),
}))

vi.mock('./openai.js', () => ({
  createOpenAIClient: vi.fn().mockReturnValue({}),
  generateAction: vi.fn().mockResolvedValue({
    type: 'done',
    reason: 'Goal achieved',
  }),
}))

vi.mock('./tools.js', () => ({
  executeAction: vi.fn().mockResolvedValue({
    success: true,
    observation: 'Done',
  }),
}))

import { BrowserClient } from '@at-agent/browser'

describe('Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes headed option to BrowserClient', async () => {
    const agent = new Agent('test-api-key')
    await agent.run('test goal', { startUrl: 'https://example.com', headed: true })

    expect(BrowserClient).toHaveBeenCalledWith({ headless: false })
  })

  it('defaults to headless mode', async () => {
    const agent = new Agent('test-api-key')
    await agent.run('test goal', { startUrl: 'https://example.com' })

    expect(BrowserClient).toHaveBeenCalledWith({ headless: true })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:packages -- --filter @at-agent/agent -- run src/agent.test.ts`
Expected: FAIL - BrowserClient called with {} not { headless: false }

**Step 3: Update agent.ts to pass headed option**

In `packages/agent/src/agent.ts`, change line 28:

```typescript
const browser = new BrowserClient({ headless: !opts.headed })
```

**Step 4: Run test to verify it passes**

Run: `npm run test:packages -- --filter @at-agent/agent -- run src/agent.test.ts`
Expected: PASS

**Step 5: Run all agent tests**

Run: `npm run test:packages -- --filter @at-agent/agent`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/agent/src/agent.ts packages/agent/src/agent.test.ts
git commit -m "feat(agent): pass headed option to BrowserClient"
```

---

### Task 3: Add headed to FlowCommandOptions

**Files:**
- Modify: `packages/cli/src/commands/flow.ts:4-10`
- Modify: `packages/cli/src/commands/flow.test.ts`

**Step 1: Write failing test**

Add to `packages/cli/src/commands/flow.test.ts`:

```typescript
it('passes headed option to agent', async () => {
  const { Agent } = await import('@at-agent/agent')
  const mockAgent = vi.mocked(Agent)

  const options: FlowCommandOptions = {
    url: 'https://example.com',
    goal: 'Test the page',
    headed: true,
  }

  await runFlow(options)

  const runCall = mockAgent.mock.results[0].value.run
  expect(runCall).toHaveBeenCalledWith('Test the page', expect.objectContaining({
    startUrl: 'https://example.com',
    headed: true,
  }))
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:packages -- --filter @at-agent/cli -- run src/commands/flow.test.ts`
Expected: FAIL - headed not passed to agent

**Step 3: Add headed to FlowCommandOptions and pass to agent**

In `packages/cli/src/commands/flow.ts`:

```typescript
export interface FlowCommandOptions {
  url: string
  goal: string
  json?: boolean
  maxSteps?: number
  apiKey?: string
  headed?: boolean
}
```

And update the agent.run call (around line 31):

```typescript
const agentResult = await agent.run(options.goal, {
  startUrl: options.url,
  maxSteps: options.maxSteps ?? 20,
  headed: options.headed,
})
```

**Step 4: Run test to verify it passes**

Run: `npm run test:packages -- --filter @at-agent/cli -- run src/commands/flow.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/cli/src/commands/flow.ts packages/cli/src/commands/flow.test.ts
git commit -m "feat(cli): add headed option to flow command"
```

---

### Task 4: Add --headed CLI flag

**Files:**
- Modify: `packages/cli/src/cli.ts:36-60`
- Modify: `packages/cli/src/cli.test.ts`

**Step 1: Write failing test**

Add to `packages/cli/src/cli.test.ts`:

```typescript
it('flow command accepts --headed flag', () => {
  const program = createProgram()
  const flowCommand = program.commands.find(cmd => cmd.name() === 'flow')

  expect(flowCommand).toBeDefined()
  const headedOption = flowCommand?.options.find(opt => opt.long === '--headed')
  expect(headedOption).toBeDefined()
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:packages -- --filter @at-agent/cli -- run src/cli.test.ts`
Expected: FAIL - --headed option not found

**Step 3: Add --headed option to flow command**

In `packages/cli/src/cli.ts`, add the option after line 42:

```typescript
.option('--headed', 'Show browser window')
```

And update the action handler type and call (around line 43-50):

```typescript
.action(async (url: string, options: { goal: string; json?: boolean; maxSteps?: number; apiKey?: string; headed?: boolean }) => {
  const result = await runFlow({
    url,
    goal: options.goal,
    json: options.json,
    maxSteps: options.maxSteps,
    apiKey: options.apiKey,
    headed: options.headed,
  })
```

**Step 4: Run test to verify it passes**

Run: `npm run test:packages -- --filter @at-agent/cli -- run src/cli.test.ts`
Expected: PASS

**Step 5: Run all tests**

Run: `npm run test:packages`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/cli/src/cli.ts packages/cli/src/cli.test.ts
git commit -m "feat(cli): add --headed flag to flow command"
```

---

### Task 5: Manual verification

**Step 1: Build packages**

Run: `npm run build:packages`
Expected: Build succeeds

**Step 2: Test headed mode manually**

Run: `OPENAI_API_KEY=your-key npm run at-agent -- flow https://example.com --goal "find the main heading" --headed`
Expected: Browser window opens and is visible during execution

**Step 3: Test headless still works**

Run: `OPENAI_API_KEY=your-key npm run at-agent -- flow https://example.com --goal "find the main heading"`
Expected: No browser window visible, runs headless

**Step 4: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore: headed mode implementation complete"
```
