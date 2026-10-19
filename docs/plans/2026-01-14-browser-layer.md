# Browser Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a clean, well-tested Playwright wrapper focused on accessibility testing needs.

**Architecture:** Thin wrapper around Playwright exposing only what the accessibility layer needs. Three main classes: BrowserClient (manages browser lifecycle), Page (navigation and queries), plus type definitions. No accessibility logic here.

**Tech Stack:** TypeScript (strict), Playwright, Vitest, Zod

---

## Task 1: Package Setup

**Files:**
- Create: `packages/browser/package.json`
- Create: `packages/browser/tsconfig.json`
- Create: `packages/browser/vitest.config.ts`
- Create: `packages/browser/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@at-agent/browser",
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
    "playwright": "^1.57.0",
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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
})
```

**Step 4: Create placeholder index.ts**

```typescript
// @at-agent/browser - Playwright wrapper for accessibility testing
export {}
```

**Step 5: Install dependencies**

Run: `cd ./packages/browser && npm install`
Expected: Dependencies installed successfully

**Step 6: Verify setup**

Run: `cd ./packages/browser && npm test`
Expected: "No test files found" or similar (no tests yet)

**Step 7: Commit**

```bash
git add packages/browser
git commit -m "feat(browser): initialize package with TypeScript and Vitest"
```

---

## Task 2: Define Core Types

**Files:**
- Create: `packages/browser/src/types.ts`
- Create: `packages/browser/src/types.test.ts`

**Step 1: Write the type definitions**

```typescript
// packages/browser/src/types.ts
import { z } from 'zod'

// Browser launch options
export const BrowserOptionsSchema = z.object({
  headless: z.boolean().default(true),
  slowMo: z.number().optional(),
})
export type BrowserOptions = z.infer<typeof BrowserOptionsSchema>

// Element location info
export const ElementLocationSchema = z.object({
  selector: z.string(),
  boundingBox: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }).nullable(),
})
export type ElementLocation = z.infer<typeof ElementLocationSchema>

// Element data returned from queries
export const ElementDataSchema = z.object({
  tagName: z.string(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  value: z.string().nullable(),
  checked: z.boolean().nullable(),
  disabled: z.boolean(),
  location: ElementLocationSchema,
})
export type ElementData = z.infer<typeof ElementDataSchema>

// Accessibility tree node
export const AccessibilityNodeSchema: z.ZodType<AccessibilityNode> = z.lazy(() =>
  z.object({
    role: z.string(),
    name: z.string().nullable(),
    value: z.string().nullable(),
    description: z.string().nullable(),
    children: z.array(AccessibilityNodeSchema),
  })
)
export interface AccessibilityNode {
  role: string
  name: string | null
  value: string | null
  description: string | null
  children: AccessibilityNode[]
}

// Screenshot options
export const ScreenshotOptionsSchema = z.object({
  fullPage: z.boolean().default(false),
  type: z.enum(['png', 'jpeg']).default('png'),
})
export type ScreenshotOptions = z.infer<typeof ScreenshotOptionsSchema>
```

**Step 2: Write test to verify schemas work**

```typescript
// packages/browser/src/types.test.ts
import { describe, it, expect } from 'vitest'
import {
  BrowserOptionsSchema,
  ElementDataSchema,
  AccessibilityNodeSchema,
  ScreenshotOptionsSchema,
} from './types.js'

describe('BrowserOptionsSchema', () => {
  it('applies defaults for empty object', () => {
    const result = BrowserOptionsSchema.parse({})
    expect(result).toEqual({ headless: true })
  })

  it('accepts valid options', () => {
    const result = BrowserOptionsSchema.parse({ headless: false, slowMo: 100 })
    expect(result).toEqual({ headless: false, slowMo: 100 })
  })

  it('rejects invalid headless value', () => {
    expect(() => BrowserOptionsSchema.parse({ headless: 'yes' })).toThrow()
  })
})

describe('ElementDataSchema', () => {
  it('validates complete element data', () => {
    const element = {
      tagName: 'button',
      role: 'button',
      name: 'Submit',
      value: null,
      checked: null,
      disabled: false,
      location: {
        selector: 'button.submit',
        boundingBox: { x: 10, y: 20, width: 100, height: 40 },
      },
    }
    const result = ElementDataSchema.parse(element)
    expect(result.tagName).toBe('button')
    expect(result.role).toBe('button')
  })
})

describe('AccessibilityNodeSchema', () => {
  it('validates nested accessibility tree', () => {
    const tree = {
      role: 'WebArea',
      name: 'Test Page',
      value: null,
      description: null,
      children: [
        {
          role: 'heading',
          name: 'Welcome',
          value: null,
          description: null,
          children: [],
        },
      ],
    }
    const result = AccessibilityNodeSchema.parse(tree)
    expect(result.role).toBe('WebArea')
    expect(result.children).toHaveLength(1)
    expect(result.children[0].role).toBe('heading')
  })
})

describe('ScreenshotOptionsSchema', () => {
  it('applies defaults', () => {
    const result = ScreenshotOptionsSchema.parse({})
    expect(result).toEqual({ fullPage: false, type: 'png' })
  })
})
```

**Step 3: Run tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 4: Export types from index**

```typescript
// packages/browser/src/index.ts
export {
  BrowserOptionsSchema,
  type BrowserOptions,
  ElementLocationSchema,
  type ElementLocation,
  ElementDataSchema,
  type ElementData,
  AccessibilityNodeSchema,
  type AccessibilityNode,
  ScreenshotOptionsSchema,
  type ScreenshotOptions,
} from './types.js'
```

**Step 5: Commit**

```bash
git add packages/browser/src
git commit -m "feat(browser): add core type definitions with Zod schemas"
```

---

## Task 3: BrowserClient - Launch and Close

**Files:**
- Create: `packages/browser/src/client.ts`
- Create: `packages/browser/src/client.test.ts`

**Step 1: Write failing test for launch**

```typescript
// packages/browser/src/client.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { BrowserClient } from './client.js'

describe('BrowserClient', () => {
  let client: BrowserClient | null = null

  afterEach(async () => {
    if (client) {
      await client.close()
      client = null
    }
  })

  describe('launch', () => {
    it('launches browser successfully', async () => {
      client = new BrowserClient()
      await client.launch()
      expect(client.isLaunched()).toBe(true)
    })

    it('launches with custom options', async () => {
      client = new BrowserClient({ headless: true })
      await client.launch()
      expect(client.isLaunched()).toBe(true)
    })

    it('throws if launched twice', async () => {
      client = new BrowserClient()
      await client.launch()
      await expect(client.launch()).rejects.toThrow('Browser already launched')
    })
  })

  describe('close', () => {
    it('closes browser successfully', async () => {
      client = new BrowserClient()
      await client.launch()
      await client.close()
      expect(client.isLaunched()).toBe(false)
      client = null // prevent afterEach from double-closing
    })

    it('is safe to call close when not launched', async () => {
      client = new BrowserClient()
      await expect(client.close()).resolves.not.toThrow()
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd ./packages/browser && npm test`
Expected: FAIL - Cannot find module './client.js'

**Step 3: Write minimal implementation**

```typescript
// packages/browser/src/client.ts
import { chromium, Browser } from 'playwright'
import { BrowserOptionsSchema, type BrowserOptions } from './types.js'

export class BrowserClient {
  private browser: Browser | null = null
  private readonly options: BrowserOptions

  constructor(options: Partial<BrowserOptions> = {}) {
    this.options = BrowserOptionsSchema.parse(options)
  }

  async launch(): Promise<void> {
    if (this.browser) {
      throw new Error('Browser already launched')
    }
    this.browser = await chromium.launch({
      headless: this.options.headless,
      slowMo: this.options.slowMo,
    })
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }

  isLaunched(): boolean {
    return this.browser !== null
  }
}
```

**Step 4: Run tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/browser/src/client.ts packages/browser/src/client.test.ts
git commit -m "feat(browser): add BrowserClient with launch/close"
```

---

## Task 4: BrowserClient - Create Page

**Files:**
- Modify: `packages/browser/src/client.ts`
- Modify: `packages/browser/src/client.test.ts`
- Create: `packages/browser/src/page.ts`

**Step 1: Write failing test for newPage**

Add to `packages/browser/src/client.test.ts`:

```typescript
import { BrowserPage } from './page.js'

// Add inside describe('BrowserClient')
describe('newPage', () => {
  it('creates a new page', async () => {
    client = new BrowserClient()
    await client.launch()
    const page = await client.newPage()
    expect(page).toBeInstanceOf(BrowserPage)
  })

  it('throws if browser not launched', async () => {
    client = new BrowserClient()
    await expect(client.newPage()).rejects.toThrow('Browser not launched')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd ./packages/browser && npm test`
Expected: FAIL - Cannot find module './page.js'

**Step 3: Create minimal page class**

```typescript
// packages/browser/src/page.ts
import type { Page } from 'playwright'

export class BrowserPage {
  constructor(private readonly page: Page) {}

  async close(): Promise<void> {
    await this.page.close()
  }
}
```

**Step 4: Add newPage to BrowserClient**

Add to `packages/browser/src/client.ts`:

```typescript
import { BrowserPage } from './page.js'

// Add method to BrowserClient class
async newPage(): Promise<BrowserPage> {
  if (!this.browser) {
    throw new Error('Browser not launched')
  }
  const page = await this.browser.newPage()
  return new BrowserPage(page)
}
```

**Step 5: Run tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/browser/src
git commit -m "feat(browser): add newPage to BrowserClient"
```

---

## Task 5: BrowserPage - Navigation

**Files:**
- Modify: `packages/browser/src/page.ts`
- Create: `packages/browser/src/page.test.ts`

**Step 1: Write failing tests for goto and url**

```typescript
// packages/browser/src/page.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BrowserClient } from './client.js'
import { BrowserPage } from './page.js'

describe('BrowserPage', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
  })

  afterAll(async () => {
    await client.close()
  })

  describe('navigation', () => {
    it('navigates to URL', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')
      expect(await page.url()).toBe('https://example.com/')
      await page.close()
    })

    it('throws on invalid URL', async () => {
      page = await client.newPage()
      await expect(page.goto('not-a-url')).rejects.toThrow()
      await page.close()
    })

    it('waits for page load', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')
      const title = await page.title()
      expect(title).toBe('Example Domain')
      await page.close()
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd ./packages/browser && npm test`
Expected: FAIL - page.goto is not a function

**Step 3: Implement navigation methods**

Update `packages/browser/src/page.ts`:

```typescript
// packages/browser/src/page.ts
import type { Page } from 'playwright'

export class BrowserPage {
  constructor(private readonly page: Page) {}

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  async url(): Promise<string> {
    return this.page.url()
  }

  async title(): Promise<string> {
    return this.page.title()
  }

  async close(): Promise<void> {
    await this.page.close()
  }
}
```

**Step 4: Run tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/browser/src/page.ts packages/browser/src/page.test.ts
git commit -m "feat(browser): add navigation methods to BrowserPage"
```

---

## Task 6: BrowserPage - Query by Role

**Files:**
- Modify: `packages/browser/src/page.ts`
- Modify: `packages/browser/src/page.test.ts`

**Step 1: Write failing test for getByRole**

Add to `packages/browser/src/page.test.ts`:

```typescript
describe('queries', () => {
  it('finds elements by role', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    const links = await page.getByRole('link')
    expect(links.length).toBeGreaterThan(0)
    expect(links[0].role).toBe('link')
    await page.close()
  })

  it('finds elements by role and name', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    const links = await page.getByRole('link', { name: 'More information' })
    expect(links.length).toBe(1)
    await page.close()
  })

  it('returns empty array when no matches', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    const buttons = await page.getByRole('button')
    expect(buttons).toEqual([])
    await page.close()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd ./packages/browser && npm test`
Expected: FAIL - page.getByRole is not a function

**Step 3: Implement getByRole**

Update `packages/browser/src/page.ts`:

```typescript
// packages/browser/src/page.ts
import type { Page, Locator } from 'playwright'
import type { ElementData } from './types.js'

export class BrowserPage {
  constructor(private readonly page: Page) {}

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  async url(): Promise<string> {
    return this.page.url()
  }

  async title(): Promise<string> {
    return this.page.title()
  }

  async getByRole(
    role: string,
    options?: { name?: string | RegExp }
  ): Promise<ElementData[]> {
    const locator = this.page.getByRole(role as any, options)
    return this.locatorToElementData(locator)
  }

  private async locatorToElementData(locator: Locator): Promise<ElementData[]> {
    const count = await locator.count()
    const elements: ElementData[] = []

    for (let i = 0; i < count; i++) {
      const el = locator.nth(i)
      const box = await el.boundingBox()

      elements.push({
        tagName: await el.evaluate((node) => node.tagName.toLowerCase()),
        role: await el.getAttribute('role') ?? await el.evaluate((node) => {
          // Get computed role from accessibility tree
          return (node as any).ariaRoleDescription ?? null
        }),
        name: await el.evaluate((node) => {
          return node.getAttribute('aria-label') ?? node.textContent?.trim() ?? null
        }),
        value: await el.inputValue().catch(() => null),
        checked: await el.isChecked().catch(() => null),
        disabled: await el.isDisabled(),
        location: {
          selector: `${await el.evaluate((n) => n.tagName.toLowerCase())}`,
          boundingBox: box,
        },
      })
    }

    return elements
  }

  async close(): Promise<void> {
    await this.page.close()
  }
}
```

**Step 4: Run tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/browser/src/page.ts packages/browser/src/page.test.ts
git commit -m "feat(browser): add getByRole query method"
```

---

## Task 7: BrowserPage - Query by Text

**Files:**
- Modify: `packages/browser/src/page.ts`
- Modify: `packages/browser/src/page.test.ts`

**Step 1: Write failing test for getByText**

Add to `packages/browser/src/page.test.ts` in the queries describe block:

```typescript
it('finds elements by text', async () => {
  page = await client.newPage()
  await page.goto('https://example.com')
  const elements = await page.getByText('Example Domain')
  expect(elements.length).toBeGreaterThan(0)
  await page.close()
})

it('finds elements by partial text', async () => {
  page = await client.newPage()
  await page.goto('https://example.com')
  const elements = await page.getByText('Example', { exact: false })
  expect(elements.length).toBeGreaterThan(0)
  await page.close()
})
```

**Step 2: Run test to verify it fails**

Run: `cd ./packages/browser && npm test`
Expected: FAIL - page.getByText is not a function

**Step 3: Implement getByText**

Add to `packages/browser/src/page.ts`:

```typescript
async getByText(
  text: string | RegExp,
  options?: { exact?: boolean }
): Promise<ElementData[]> {
  const locator = this.page.getByText(text, options)
  return this.locatorToElementData(locator)
}
```

**Step 4: Run tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/browser/src/page.ts packages/browser/src/page.test.ts
git commit -m "feat(browser): add getByText query method"
```

---

## Task 8: BrowserPage - Screenshot

**Files:**
- Modify: `packages/browser/src/page.ts`
- Modify: `packages/browser/src/page.test.ts`

**Step 1: Write failing test for screenshot**

Add to `packages/browser/src/page.test.ts`:

```typescript
describe('screenshot', () => {
  it('captures screenshot as buffer', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    const buffer = await page.screenshot()
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.length).toBeGreaterThan(0)
    // PNG magic bytes
    expect(buffer[0]).toBe(0x89)
    expect(buffer[1]).toBe(0x50) // P
    expect(buffer[2]).toBe(0x4e) // N
    expect(buffer[3]).toBe(0x47) // G
    await page.close()
  })

  it('captures full page screenshot', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    const partial = await page.screenshot()
    const full = await page.screenshot({ fullPage: true })
    expect(full.length).toBeGreaterThanOrEqual(partial.length)
    await page.close()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd ./packages/browser && npm test`
Expected: FAIL - page.screenshot is not a function (or wrong return type)

**Step 3: Implement screenshot**

Add to `packages/browser/src/page.ts`:

```typescript
import { ScreenshotOptionsSchema, type ScreenshotOptions } from './types.js'

// Add method to BrowserPage class
async screenshot(options: Partial<ScreenshotOptions> = {}): Promise<Buffer> {
  const opts = ScreenshotOptionsSchema.parse(options)
  return this.page.screenshot({
    fullPage: opts.fullPage,
    type: opts.type,
  })
}
```

**Step 4: Run tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/browser/src/page.ts packages/browser/src/page.test.ts
git commit -m "feat(browser): add screenshot capture"
```

---

## Task 9: BrowserPage - Accessibility Tree

**Files:**
- Modify: `packages/browser/src/page.ts`
- Modify: `packages/browser/src/page.test.ts`

**Step 1: Write failing test for accessibilityTree**

Add to `packages/browser/src/page.test.ts`:

```typescript
describe('accessibility', () => {
  it('returns accessibility tree', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    const tree = await page.accessibilityTree()
    expect(tree.role).toBe('WebArea')
    expect(tree.children.length).toBeGreaterThan(0)
    await page.close()
  })

  it('tree contains heading', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    const tree = await page.accessibilityTree()

    const findHeading = (node: any): any => {
      if (node.role === 'heading') return node
      for (const child of node.children || []) {
        const found = findHeading(child)
        if (found) return found
      }
      return null
    }

    const heading = findHeading(tree)
    expect(heading).not.toBeNull()
    expect(heading.name).toContain('Example')
    await page.close()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd ./packages/browser && npm test`
Expected: FAIL - page.accessibilityTree is not a function

**Step 3: Implement accessibilityTree**

Add to `packages/browser/src/page.ts`:

```typescript
import type { AccessibilityNode } from './types.js'

// Add method to BrowserPage class
async accessibilityTree(): Promise<AccessibilityNode> {
  const snapshot = await this.page.accessibility.snapshot()
  return this.convertAccessibilityNode(snapshot)
}

private convertAccessibilityNode(node: any): AccessibilityNode {
  return {
    role: node?.role ?? 'none',
    name: node?.name ?? null,
    value: node?.value ?? null,
    description: node?.description ?? null,
    children: (node?.children ?? []).map((child: any) =>
      this.convertAccessibilityNode(child)
    ),
  }
}
```

**Step 4: Run tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/browser/src/page.ts packages/browser/src/page.test.ts
git commit -m "feat(browser): add accessibility tree extraction"
```

---

## Task 10: BrowserPage - Element Interactions

**Files:**
- Modify: `packages/browser/src/page.ts`
- Modify: `packages/browser/src/page.test.ts`

**Step 1: Write failing tests for click and type**

Add to `packages/browser/src/page.test.ts`:

```typescript
describe('interactions', () => {
  it('clicks element by role', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    // Click the "More information" link
    await page.clickByRole('link', { name: 'More information' })
    // Should navigate to IANA
    expect(await page.url()).toContain('iana.org')
    await page.close()
  })

  it('throws when element not found', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    await expect(
      page.clickByRole('button', { name: 'nonexistent' })
    ).rejects.toThrow()
    await page.close()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd ./packages/browser && npm test`
Expected: FAIL - page.clickByRole is not a function

**Step 3: Implement interaction methods**

Add to `packages/browser/src/page.ts`:

```typescript
// Add methods to BrowserPage class
async clickByRole(
  role: string,
  options?: { name?: string | RegExp }
): Promise<void> {
  const locator = this.page.getByRole(role as any, options)
  await locator.click()
}

async clickByText(text: string | RegExp): Promise<void> {
  const locator = this.page.getByText(text)
  await locator.click()
}

async fill(selector: string, value: string): Promise<void> {
  await this.page.fill(selector, value)
}

async fillByRole(
  role: string,
  value: string,
  options?: { name?: string | RegExp }
): Promise<void> {
  const locator = this.page.getByRole(role as any, options)
  await locator.fill(value)
}
```

**Step 4: Run tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/browser/src/page.ts packages/browser/src/page.test.ts
git commit -m "feat(browser): add element interaction methods"
```

---

## Task 11: Export Public API

**Files:**
- Modify: `packages/browser/src/index.ts`

**Step 1: Update exports**

```typescript
// packages/browser/src/index.ts
export {
  BrowserOptionsSchema,
  type BrowserOptions,
  ElementLocationSchema,
  type ElementLocation,
  ElementDataSchema,
  type ElementData,
  AccessibilityNodeSchema,
  type AccessibilityNode,
  ScreenshotOptionsSchema,
  type ScreenshotOptions,
} from './types.js'

export { BrowserClient } from './client.js'
export { BrowserPage } from './page.js'
```

**Step 2: Verify build**

Run: `cd ./packages/browser && npm run build`
Expected: Build succeeds with no errors

**Step 3: Run all tests**

Run: `cd ./packages/browser && npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/browser/src/index.ts
git commit -m "feat(browser): export public API"
```

---

## Task 12: Documentation and Final Verification

**Files:**
- Create: `packages/browser/README.md`

**Step 1: Create README**

```markdown
# @at-agent/browser

Playwright wrapper for accessibility testing.

## Installation

```bash
npm install @at-agent/browser
```

## Usage

```typescript
import { BrowserClient } from '@at-agent/browser'

const client = new BrowserClient({ headless: true })
await client.launch()

const page = await client.newPage()
await page.goto('https://example.com')

// Query elements
const links = await page.getByRole('link')
const headings = await page.getByText('Welcome')

// Get accessibility tree
const tree = await page.accessibilityTree()

// Take screenshot
const screenshot = await page.screenshot({ fullPage: true })

// Interact
await page.clickByRole('button', { name: 'Submit' })
await page.fillByRole('textbox', 'hello@example.com', { name: 'Email' })

await page.close()
await client.close()
```

## API

### BrowserClient

- `new BrowserClient(options?)` - Create client
- `launch()` - Launch browser
- `close()` - Close browser
- `newPage()` - Create new page

### BrowserPage

- `goto(url)` - Navigate to URL
- `url()` - Get current URL
- `title()` - Get page title
- `getByRole(role, options?)` - Query elements by ARIA role
- `getByText(text, options?)` - Query elements by text content
- `accessibilityTree()` - Get full accessibility tree
- `screenshot(options?)` - Capture screenshot
- `clickByRole(role, options?)` - Click element by role
- `clickByText(text)` - Click element by text
- `fill(selector, value)` - Fill input by selector
- `fillByRole(role, value, options?)` - Fill input by role
- `close()` - Close page
```

**Step 2: Final test run**

Run: `cd ./packages/browser && npm test && npm run build`
Expected: All tests pass, build succeeds

**Step 3: Commit**

```bash
git add packages/browser/README.md
git commit -m "docs(browser): add README with usage examples"
```

**Step 4: Push branch**

```bash
git push -u origin rebuild/browser-layer
```

---

## Summary

After completing all tasks, you will have:

- `packages/browser/` - New browser automation package
- ~80% test coverage on core functionality
- Clean API: `BrowserClient` and `BrowserPage`
- Type-safe with Zod schemas
- Ready for Accessibility Layer to build on top

**Next phase:** Build `packages/accessibility/` using this browser layer.
