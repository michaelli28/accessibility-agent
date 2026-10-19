# Visual Highlight Design for Headed Mode

**Goal:** Add visual highlights to targeted elements when running in headed mode, showing a box with action label before each interaction.

**Decisions:**
- Style: Cyan border + semi-transparent background + action label above element
- Duration: 500ms before action executes
- Color: Single color (cyan) for all actions
- Activation: Automatic when `--headed` flag is used

---

## Architecture

```
CLI (--headed) → Agent (headed: true) → executeAction (highlight before action)
```

Option flows through existing chain. Highlighting occurs in `tools.ts` before click/fill actions by calling a new `BrowserPage.highlight()` method.

---

## Implementation

### Task 1: Add highlight method to BrowserPage

**File:** `packages/browser/src/page.ts`

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

### Task 2: Update executeAction signature

**File:** `packages/agent/src/tools.ts`

Add options parameter:

```typescript
export async function executeAction(
  action: Action,
  page: BrowserPage,
  options?: { headed?: boolean }
): Promise<ActionResult>
```

Pass options to `executeClick` and `executeFill`.

### Task 3: Add highlighting to executeClick

**File:** `packages/agent/src/tools.ts`

Before clicking, if headed mode:

```typescript
if (options?.headed) {
  await page.highlight(role, { name }, 'CLICK')
}
```

### Task 4: Add highlighting to executeFill

**File:** `packages/agent/src/tools.ts`

Before filling, if headed mode:

```typescript
if (options?.headed) {
  await page.highlight(role, { name }, 'FILL')
}
```

### Task 5: Pass headed option from Agent

**File:** `packages/agent/src/agent.ts`

Update the executeAction call:

```typescript
const result = await executeAction(action, page, { headed: opts.headed })
```

---

## Action Labels

| Action | Label |
|--------|-------|
| click | CLICK |
| fill | FILL |
| navigate | (no highlight) |
| audit | (no highlight) |
| observe | (no highlight) |
| done | (no highlight) |
