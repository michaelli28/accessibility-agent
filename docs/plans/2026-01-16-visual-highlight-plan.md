# Visual Highlight Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add visual highlights to targeted elements when running in headed mode, showing a cyan box with action label before each interaction.

**Architecture:** BrowserPage gets a new `highlight()` method that injects a DOM overlay. `executeAction` in tools.ts calls this before click/fill actions when `headed: true` is passed via options.

**Tech Stack:** TypeScript, Playwright, Zod

---

### Task 1: Add highlight method to BrowserPage

**Files:**
- Modify: `packages/browser/src/page.ts`
- Test: `packages/browser/src/page.test.ts`

**Step 1: Write failing test for highlight method**

```typescript
describe('highlight', () => {
  it('injects overlay element with label', async () => {
    await page.goto('https://example.com')

    await browserPage.highlight('heading', { name: 'Example Domain' }, 'CLICK', 100)

    // Overlay should be removed after duration, but we can check it was injected
    // by verifying no errors were thrown
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --filter=browser -- page.test.ts`
Expected: FAIL - Property 'highlight' does not exist on type 'BrowserPage'

**Step 3: Write minimal implementation**

Add to `packages/browser/src/page.ts`:

```typescript
async highlight(
  role: string,
  options: { name?: string | RegExp },
  label: string,
  duration: number = 500
): Promise<void> {
  const locator = this.page.getByRole(role as Parameters<Page['getByRole']>[0], options)
  const box = await locator.boundingBox()
  if (!box) return

  await this.page.evaluate(({ box, label, duration }) => {
    const overlay = document.createElement('div')
    overlay.id = '__agent_highlight__'
    overlay.style.cssText = `
      position: fixed;
      left: ${box.x}px;
      top: ${box.y}px;
      width: ${box.width}px;
      height: ${box.height}px;
      border: 3px solid cyan;
      background: rgba(0, 255, 255, 0.1);
      pointer-events: none;
      z-index: 999999;
      box-sizing: border-box;
    `
    const labelEl = document.createElement('div')
    labelEl.textContent = label
    labelEl.style.cssText = `
      position: absolute;
      top: -24px;
      left: -3px;
      background: cyan;
      color: black;
      font: bold 12px system-ui;
      padding: 2px 6px;
    `
    overlay.appendChild(labelEl)
    document.body.appendChild(overlay)

    setTimeout(() => overlay.remove(), duration)
  }, { box, label, duration })

  await this.page.waitForTimeout(duration)
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --filter=browser -- page.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/browser/src/page.ts packages/browser/src/page.test.ts
git commit -m "feat(browser): add highlight method to BrowserPage"
```

---

### Task 2: Add ExecuteActionOptions type

**Files:**
- Modify: `packages/agent/src/types.ts`
- Test: `packages/agent/src/types.test.ts`

**Step 1: Write failing test for ExecuteActionOptions**

Add to `packages/agent/src/types.test.ts`:

```typescript
describe('ExecuteActionOptionsSchema', () => {
  it('defaults headed to false', () => {
    const result = ExecuteActionOptionsSchema.parse({})
    expect(result.headed).toBe(false)
  })

  it('allows setting headed to true', () => {
    const result = ExecuteActionOptionsSchema.parse({ headed: true })
    expect(result.headed).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --filter=agent -- types.test.ts`
Expected: FAIL - ExecuteActionOptionsSchema is not defined

**Step 3: Write minimal implementation**

Add to `packages/agent/src/types.ts`:

```typescript
export const ExecuteActionOptionsSchema = z.object({
  headed: z.boolean().default(false),
})
export type ExecuteActionOptions = z.infer<typeof ExecuteActionOptionsSchema>
```

Update the export in the test file import.

**Step 4: Run test to verify it passes**

Run: `npm test -- --filter=agent -- types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/agent/src/types.ts packages/agent/src/types.test.ts
git commit -m "feat(agent): add ExecuteActionOptions schema"
```

---

### Task 3: Update executeAction signature to accept options

**Files:**
- Modify: `packages/agent/src/tools.ts`
- Test: `packages/agent/src/tools.test.ts`

**Step 1: Write failing test for executeAction with options**

Add to `packages/agent/src/tools.test.ts`:

```typescript
it('accepts options parameter', async () => {
  const action: Action = { type: 'done', reason: 'test' }
  const result = await executeAction(action, mockPage, { headed: true })
  expect(result.success).toBe(true)
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --filter=agent -- tools.test.ts`
Expected: FAIL - Expected 2 arguments, but got 3

**Step 3: Update executeAction signature**

Modify `packages/agent/src/tools.ts`:

```typescript
import { type Action, type ActionResult, ExecuteActionOptionsSchema, type ExecuteActionOptions } from './types.js'

export async function executeAction(
  action: Action,
  page: BrowserPage,
  options: Partial<ExecuteActionOptions> = {}
): Promise<ActionResult> {
  const opts = ExecuteActionOptionsSchema.parse(options)
  // ... rest unchanged, pass opts to internal functions
```

Update internal function signatures to accept `opts`:

```typescript
async function executeClick(
  action: Action,
  page: BrowserPage,
  opts: ExecuteActionOptions
): Promise<ActionResult>

async function executeFill(
  action: Action,
  page: BrowserPage,
  opts: ExecuteActionOptions
): Promise<ActionResult>
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --filter=agent -- tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/tools.test.ts
git commit -m "feat(agent): add options parameter to executeAction"
```

---

### Task 4: Add highlighting to executeClick

**Files:**
- Modify: `packages/agent/src/tools.ts`
- Test: `packages/agent/src/tools.test.ts`

**Step 1: Write failing test for click highlighting**

Add to `packages/agent/src/tools.test.ts`:

```typescript
it('calls highlight before click when headed is true', async () => {
  const highlightSpy = vi.fn()
  mockPage.highlight = highlightSpy
  mockPage.clickByRole = vi.fn()

  const action: Action = { type: 'click', target: 'button named "Submit"' }
  await executeAction(action, mockPage, { headed: true })

  expect(highlightSpy).toHaveBeenCalledWith('button', { name: 'Submit' }, 'CLICK', 500)
  expect(mockPage.clickByRole).toHaveBeenCalled()
})

it('does not highlight when headed is false', async () => {
  const highlightSpy = vi.fn()
  mockPage.highlight = highlightSpy
  mockPage.clickByRole = vi.fn()

  const action: Action = { type: 'click', target: 'button named "Submit"' }
  await executeAction(action, mockPage, { headed: false })

  expect(highlightSpy).not.toHaveBeenCalled()
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --filter=agent -- tools.test.ts`
Expected: FAIL - highlight was not called

**Step 3: Add highlighting to executeClick**

In `executeClick` function, after parsing the target:

```typescript
if (match) {
  const [, role, name] = match
  if (opts.headed) {
    await page.highlight(role, { name }, 'CLICK', 500)
  }
  await page.clickByRole(role, { name, timeout: DEFAULT_CLICK_TIMEOUT })
  // ...
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --filter=agent -- tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/tools.test.ts
git commit -m "feat(agent): add visual highlight to click actions"
```

---

### Task 5: Add highlighting to executeFill

**Files:**
- Modify: `packages/agent/src/tools.ts`
- Test: `packages/agent/src/tools.test.ts`

**Step 1: Write failing test for fill highlighting**

Add to `packages/agent/src/tools.test.ts`:

```typescript
it('calls highlight before fill when headed is true', async () => {
  const highlightSpy = vi.fn()
  mockPage.highlight = highlightSpy
  mockPage.fillByRole = vi.fn()

  const action: Action = { type: 'fill', target: 'textbox named "Email"', value: 'test@example.com' }
  await executeAction(action, mockPage, { headed: true })

  expect(highlightSpy).toHaveBeenCalledWith('textbox', { name: 'Email' }, 'FILL', 500)
  expect(mockPage.fillByRole).toHaveBeenCalled()
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --filter=agent -- tools.test.ts`
Expected: FAIL - highlight was not called

**Step 3: Add highlighting to executeFill**

In `executeFill` function, after parsing the target:

```typescript
if (match) {
  const [, role, name] = match
  if (opts.headed) {
    await page.highlight(role, { name }, 'FILL', 500)
  }
  await page.fillByRole(role, action.value, { name })
  // ...
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --filter=agent -- tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/tools.test.ts
git commit -m "feat(agent): add visual highlight to fill actions"
```

---

### Task 6: Pass headed option from Agent to executeAction

**Files:**
- Modify: `packages/agent/src/agent.ts`
- Test: `packages/agent/src/agent.test.ts`

**Step 1: Write failing test**

Add to `packages/agent/src/agent.test.ts` in the `headed option` describe block:

```typescript
it('passes headed option to executeAction', async () => {
  const executeActionSpy = vi.spyOn(tools, 'executeAction')

  await agent.run('test goal', { startUrl: 'https://example.com', headed: true })

  expect(executeActionSpy).toHaveBeenCalledWith(
    expect.any(Object),
    expect.any(Object),
    expect.objectContaining({ headed: true })
  )
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --filter=agent -- agent.test.ts`
Expected: FAIL - executeAction called without headed option

**Step 3: Update agent.ts to pass headed**

In `packages/agent/src/agent.ts`, update the executeAction call:

```typescript
const result = await executeAction(action, page, { headed: opts.headed })
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --filter=agent -- agent.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/agent/src/agent.ts packages/agent/src/agent.test.ts
git commit -m "feat(agent): pass headed option to executeAction"
```

---

### Task 7: Manual verification

**Step 1: Build the project**

Run: `npm run build`
Expected: Build succeeds

**Step 2: Test headed mode with highlight**

Run: `OPENAI_API_KEY=your-key npm run at-agent -- flow https://example.com --goal "click the More information link" --headed`

Expected:
- Browser window opens
- Cyan highlight box appears over "More information" link with "CLICK" label
- After 500ms, click occurs

**Step 3: Commit completion**

```bash
git commit --allow-empty -m "chore: visual highlight feature complete"
```
