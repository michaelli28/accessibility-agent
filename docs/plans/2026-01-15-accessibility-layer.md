# Accessibility Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an accessibility scanning layer that uses the browser package to detect WCAG violations.

**Architecture:** The Auditor class coordinates scans using axe-core for baseline checks and custom rules for additional coverage. Results are returned as structured Violation objects. Screen reader simulation provides an alternative view of page accessibility.

**Tech Stack:** TypeScript (strict), axe-core, @at-agent/browser, Vitest, Zod

---

## Task 1: Package Setup

**Files:**
- Create: `packages/accessibility/package.json`
- Create: `packages/accessibility/tsconfig.json`
- Create: `packages/accessibility/vitest.config.ts`
- Create: `packages/accessibility/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@at-agent/accessibility",
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
    "axe-core": "^4.11.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.19.25",
    "playwright": "^1.57.0",
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
    "lib": ["ES2022", "DOM"],
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
    testTimeout: 30000,
  },
})
```

**Step 4: Create placeholder index.ts**

```typescript
// @at-agent/accessibility - Accessibility scanning and WCAG validation
export {}
```

**Step 5: Install dependencies**

Run: `cd ./packages/accessibility && npm install`
Expected: Dependencies installed successfully

**Step 6: Verify setup**

Run: `cd ./packages/accessibility && npm test`
Expected: "No test files found" or similar

**Step 7: Commit**

```bash
git add packages/accessibility
git commit -m "feat(accessibility): initialize package"
```

---

## Task 2: Define Core Types

**Files:**
- Create: `packages/accessibility/src/types.ts`
- Create: `packages/accessibility/src/types.test.ts`

**Step 1: Write type definitions**

```typescript
// packages/accessibility/src/types.ts
import { z } from 'zod'

// Violation impact levels (matches axe-core)
export const ImpactSchema = z.enum(['critical', 'serious', 'moderate', 'minor'])
export type Impact = z.infer<typeof ImpactSchema>

// A single node that violated a rule
export const ViolationNodeSchema = z.object({
  html: z.string(),
  target: z.array(z.string()),
  failureSummary: z.string().nullable(),
})
export type ViolationNode = z.infer<typeof ViolationNodeSchema>

// A WCAG violation
export const ViolationSchema = z.object({
  id: z.string(),
  impact: ImpactSchema,
  description: z.string(),
  help: z.string(),
  helpUrl: z.string(),
  wcagTags: z.array(z.string()),
  nodes: z.array(ViolationNodeSchema),
})
export type Violation = z.infer<typeof ViolationSchema>

// A rule that passed
export const PassedRuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  nodeCount: z.number(),
})
export type PassedRule = z.infer<typeof PassedRuleSchema>

// Complete audit result
export const AuditResultSchema = z.object({
  url: z.string(),
  timestamp: z.string(),
  violations: z.array(ViolationSchema),
  passes: z.array(PassedRuleSchema),
  incomplete: z.array(z.object({
    id: z.string(),
    description: z.string(),
  })),
})
export type AuditResult = z.infer<typeof AuditResultSchema>

// Audit options
export const AuditOptionsSchema = z.object({
  rules: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
})
export type AuditOptions = z.infer<typeof AuditOptionsSchema>
```

**Step 2: Write tests for schemas**

```typescript
// packages/accessibility/src/types.test.ts
import { describe, it, expect } from 'vitest'
import {
  ImpactSchema,
  ViolationSchema,
  AuditResultSchema,
} from './types.js'

describe('ImpactSchema', () => {
  it('accepts valid impact levels', () => {
    expect(ImpactSchema.parse('critical')).toBe('critical')
    expect(ImpactSchema.parse('serious')).toBe('serious')
    expect(ImpactSchema.parse('moderate')).toBe('moderate')
    expect(ImpactSchema.parse('minor')).toBe('minor')
  })

  it('rejects invalid impact', () => {
    expect(() => ImpactSchema.parse('high')).toThrow()
  })
})

describe('ViolationSchema', () => {
  it('validates a complete violation', () => {
    const violation = {
      id: 'image-alt',
      impact: 'critical',
      description: 'Images must have alternate text',
      help: 'Ensure images have alt attributes',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.0/image-alt',
      wcagTags: ['wcag2a', 'wcag111'],
      nodes: [{
        html: '<img src="photo.jpg">',
        target: ['img'],
        failureSummary: 'Fix any of: Element does not have an alt attribute',
      }],
    }
    const result = ViolationSchema.parse(violation)
    expect(result.id).toBe('image-alt')
    expect(result.nodes).toHaveLength(1)
  })
})

describe('AuditResultSchema', () => {
  it('validates a complete audit result', () => {
    const result = {
      url: 'https://example.com',
      timestamp: '2024-01-15T00:00:00Z',
      violations: [],
      passes: [{ id: 'color-contrast', description: 'Elements have sufficient color contrast', nodeCount: 5 }],
      incomplete: [],
    }
    const parsed = AuditResultSchema.parse(result)
    expect(parsed.url).toBe('https://example.com')
    expect(parsed.passes).toHaveLength(1)
  })
})
```

**Step 3: Run tests**

Run: `cd ./packages/accessibility && npm test`
Expected: All tests pass

**Step 4: Export from index**

```typescript
// packages/accessibility/src/index.ts
export {
  ImpactSchema,
  type Impact,
  ViolationNodeSchema,
  type ViolationNode,
  ViolationSchema,
  type Violation,
  PassedRuleSchema,
  type PassedRule,
  AuditResultSchema,
  type AuditResult,
  AuditOptionsSchema,
  type AuditOptions,
} from './types.js'
```

**Step 5: Commit**

```bash
git add packages/accessibility/src
git commit -m "feat(accessibility): add core type definitions"
```

---

## Task 3: Axe-Core Integration

**Files:**
- Create: `packages/accessibility/src/axe.ts`
- Create: `packages/accessibility/src/axe.test.ts`

**Step 1: Write failing test**

```typescript
// packages/accessibility/src/axe.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BrowserClient, BrowserPage } from '@at-agent/browser'
import { runAxe } from './axe.js'

describe('runAxe', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
  })

  afterAll(async () => {
    await client.close()
  })

  it('returns violations for page with issues', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    const result = await runAxe(page)

    expect(result.violations).toBeDefined()
    expect(result.passes).toBeDefined()
    expect(Array.isArray(result.violations)).toBe(true)
    await page.close()
  })

  it('returns passes for accessible elements', async () => {
    page = await client.newPage()
    await page.goto('https://example.com')
    const result = await runAxe(page)

    expect(result.passes.length).toBeGreaterThan(0)
    await page.close()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL - Cannot find module './axe.js'

**Step 3: Implement runAxe**

```typescript
// packages/accessibility/src/axe.ts
import type { BrowserPage } from '@at-agent/browser'
import type { Violation, PassedRule, AuditResult } from './types.js'

// Axe-core source will be injected into the page
import axeCore from 'axe-core'

export interface AxeResult {
  violations: Violation[]
  passes: PassedRule[]
  incomplete: Array<{ id: string; description: string }>
}

export async function runAxe(
  page: BrowserPage,
  options?: { rules?: string[]; tags?: string[] }
): Promise<AxeResult> {
  // Get the underlying Playwright page to inject axe
  const playwrightPage = (page as any).page

  // Inject axe-core
  await playwrightPage.evaluate(axeCore.source)

  // Run axe
  const axeOptions: Record<string, unknown> = {}
  if (options?.rules) {
    axeOptions.runOnly = { type: 'rule', values: options.rules }
  }
  if (options?.tags) {
    axeOptions.runOnly = { type: 'tag', values: options.tags }
  }

  const results = await playwrightPage.evaluate(
    (opts: Record<string, unknown>) => {
      return (window as any).axe.run(document, opts)
    },
    axeOptions
  )

  return {
    violations: results.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      wcagTags: v.tags.filter((t: string) => t.startsWith('wcag')),
      nodes: v.nodes.map((n: any) => ({
        html: n.html,
        target: n.target,
        failureSummary: n.failureSummary ?? null,
      })),
    })),
    passes: results.passes.map((p: any) => ({
      id: p.id,
      description: p.description,
      nodeCount: p.nodes.length,
    })),
    incomplete: results.incomplete.map((i: any) => ({
      id: i.id,
      description: i.description,
    })),
  }
}
```

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/accessibility/src/axe.ts packages/accessibility/src/axe.test.ts
git commit -m "feat(accessibility): add axe-core integration"
```

---

## Task 4: Auditor Class

**Files:**
- Create: `packages/accessibility/src/auditor.ts`
- Create: `packages/accessibility/src/auditor.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/accessibility/src/auditor.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BrowserClient, BrowserPage } from '@at-agent/browser'
import { Auditor } from './auditor.js'

describe('Auditor', () => {
  let client: BrowserClient
  let page: BrowserPage
  let auditor: Auditor

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    auditor = new Auditor()
  })

  afterAll(async () => {
    await client.close()
  })

  describe('audit', () => {
    it('returns complete audit result', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const result = await auditor.audit(page)

      expect(result.url).toBe('https://example.com/')
      expect(result.timestamp).toBeDefined()
      expect(result.violations).toBeDefined()
      expect(result.passes).toBeDefined()
      await page.close()
    })

    it('filters by WCAG tags', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const result = await auditor.audit(page, { tags: ['wcag2a'] })

      // All violations should be wcag2a related
      for (const v of result.violations) {
        expect(v.wcagTags.some(t => t.includes('wcag2a') || t.includes('wcag21a'))).toBe(true)
      }
      await page.close()
    })
  })

  describe('getSummary', () => {
    it('returns violation counts by impact', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const result = await auditor.audit(page)
      const summary = auditor.getSummary(result)

      expect(summary.totalViolations).toBe(result.violations.length)
      expect(summary.byImpact).toBeDefined()
      expect(typeof summary.byImpact.critical).toBe('number')
      await page.close()
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL - Cannot find module './auditor.js'

**Step 3: Implement Auditor**

```typescript
// packages/accessibility/src/auditor.ts
import type { BrowserPage } from '@at-agent/browser'
import { runAxe } from './axe.js'
import type { AuditResult, AuditOptions, Impact } from './types.js'

export interface AuditSummary {
  totalViolations: number
  totalPasses: number
  byImpact: Record<Impact, number>
}

export class Auditor {
  async audit(page: BrowserPage, options?: AuditOptions): Promise<AuditResult> {
    const axeResult = await runAxe(page, options)

    return {
      url: await page.url(),
      timestamp: new Date().toISOString(),
      violations: axeResult.violations,
      passes: axeResult.passes,
      incomplete: axeResult.incomplete,
    }
  }

  getSummary(result: AuditResult): AuditSummary {
    const byImpact: Record<Impact, number> = {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    }

    for (const v of result.violations) {
      byImpact[v.impact]++
    }

    return {
      totalViolations: result.violations.length,
      totalPasses: result.passes.length,
      byImpact,
    }
  }
}
```

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/accessibility/src/auditor.ts packages/accessibility/src/auditor.test.ts
git commit -m "feat(accessibility): add Auditor class"
```

---

## Task 5: Screen Reader Simulation

**Files:**
- Create: `packages/accessibility/src/screen-reader.ts`
- Create: `packages/accessibility/src/screen-reader.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/accessibility/src/screen-reader.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BrowserClient, BrowserPage } from '@at-agent/browser'
import { ScreenReaderSimulator } from './screen-reader.js'

describe('ScreenReaderSimulator', () => {
  let client: BrowserClient
  let page: BrowserPage
  let simulator: ScreenReaderSimulator

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
  })

  afterAll(async () => {
    await client.close()
  })

  describe('readPage', () => {
    it('returns page content in reading order', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')
      simulator = new ScreenReaderSimulator(page)

      const content = await simulator.readPage()

      expect(content.length).toBeGreaterThan(0)
      // Should include the heading
      expect(content.some(item => item.role === 'heading')).toBe(true)
      await page.close()
    })
  })

  describe('getHeadings', () => {
    it('returns all headings with levels', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')
      simulator = new ScreenReaderSimulator(page)

      const headings = await simulator.getHeadings()

      expect(headings.length).toBeGreaterThan(0)
      expect(headings[0].level).toBeDefined()
      expect(headings[0].text).toContain('Example')
      await page.close()
    })
  })

  describe('getLandmarks', () => {
    it('returns page landmarks', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')
      simulator = new ScreenReaderSimulator(page)

      const landmarks = await simulator.getLandmarks()

      // Even simple pages have implicit landmarks
      expect(Array.isArray(landmarks)).toBe(true)
      await page.close()
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL - Cannot find module './screen-reader.js'

**Step 3: Implement ScreenReaderSimulator**

```typescript
// packages/accessibility/src/screen-reader.ts
import type { BrowserPage, AccessibilityNode } from '@at-agent/browser'

export interface ReadableItem {
  role: string
  name: string | null
  value: string | null
  level?: number
}

export interface Heading {
  level: number
  text: string
}

export interface Landmark {
  role: string
  name: string | null
}

export class ScreenReaderSimulator {
  constructor(private readonly page: BrowserPage) {}

  async readPage(): Promise<ReadableItem[]> {
    const tree = await this.page.accessibilityTree()
    return this.flattenTree(tree)
  }

  async getHeadings(): Promise<Heading[]> {
    const tree = await this.page.accessibilityTree()
    return this.extractHeadings(tree)
  }

  async getLandmarks(): Promise<Landmark[]> {
    const tree = await this.page.accessibilityTree()
    return this.extractLandmarks(tree)
  }

  private flattenTree(node: AccessibilityNode): ReadableItem[] {
    const items: ReadableItem[] = []

    // Include this node if it has meaningful content
    if (this.isReadable(node)) {
      items.push({
        role: node.role,
        name: node.name,
        value: node.value,
      })
    }

    // Recurse into children
    for (const child of node.children) {
      items.push(...this.flattenTree(child))
    }

    return items
  }

  private isReadable(node: AccessibilityNode): boolean {
    // Include nodes that have names or are interactive
    const meaningfulRoles = [
      'heading', 'link', 'button', 'textbox', 'checkbox',
      'radio', 'combobox', 'listitem', 'img', 'figure',
      'paragraph', 'text'
    ]
    return (
      meaningfulRoles.includes(node.role) ||
      (node.name !== null && node.name.trim() !== '')
    )
  }

  private extractHeadings(node: AccessibilityNode, headings: Heading[] = []): Heading[] {
    if (node.role === 'heading' && node.name) {
      // Extract level from role if available, default to 2
      const level = this.getHeadingLevel(node)
      headings.push({ level, text: node.name })
    }

    for (const child of node.children) {
      this.extractHeadings(child, headings)
    }

    return headings
  }

  private getHeadingLevel(node: AccessibilityNode): number {
    // Try to determine heading level from the node
    // Default to 1 for main headings
    return 1
  }

  private extractLandmarks(node: AccessibilityNode, landmarks: Landmark[] = []): Landmark[] {
    const landmarkRoles = [
      'banner', 'navigation', 'main', 'complementary',
      'contentinfo', 'search', 'form', 'region'
    ]

    if (landmarkRoles.includes(node.role)) {
      landmarks.push({ role: node.role, name: node.name })
    }

    for (const child of node.children) {
      this.extractLandmarks(child, landmarks)
    }

    return landmarks
  }
}
```

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/accessibility/src/screen-reader.ts packages/accessibility/src/screen-reader.test.ts
git commit -m "feat(accessibility): add screen reader simulation"
```

---

## Task 6: Export Public API

**Files:**
- Modify: `packages/accessibility/src/index.ts`

**Step 1: Update exports**

```typescript
// packages/accessibility/src/index.ts
export {
  ImpactSchema,
  type Impact,
  ViolationNodeSchema,
  type ViolationNode,
  ViolationSchema,
  type Violation,
  PassedRuleSchema,
  type PassedRule,
  AuditResultSchema,
  type AuditResult,
  AuditOptionsSchema,
  type AuditOptions,
} from './types.js'

export { runAxe, type AxeResult } from './axe.js'
export { Auditor, type AuditSummary } from './auditor.js'
export { ScreenReaderSimulator, type ReadableItem, type Heading, type Landmark } from './screen-reader.js'
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/accessibility/src/index.ts
git commit -m "feat(accessibility): export public API"
```

---

## Task 7: Documentation and Final Verification

**Files:**
- Create: `packages/accessibility/README.md`

**Step 1: Create README**

```markdown
# @at-agent/accessibility

Accessibility scanning and WCAG validation for the at-agent framework.

## Installation

```bash
npm install @at-agent/accessibility
```

## Usage

```typescript
import { BrowserClient } from '@at-agent/browser'
import { Auditor, ScreenReaderSimulator } from '@at-agent/accessibility'

const client = new BrowserClient()
await client.launch()

const page = await client.newPage()
await page.goto('https://example.com')

// Run accessibility audit
const auditor = new Auditor()
const result = await auditor.audit(page)

console.log(`Found ${result.violations.length} violations`)
for (const v of result.violations) {
  console.log(`- [${v.impact}] ${v.id}: ${v.help}`)
}

// Get summary
const summary = auditor.getSummary(result)
console.log(`Critical: ${summary.byImpact.critical}`)

// Screen reader simulation
const simulator = new ScreenReaderSimulator(page)
const headings = await simulator.getHeadings()
const landmarks = await simulator.getLandmarks()

await page.close()
await client.close()
```

## API

### Auditor

- `audit(page, options?)` - Run accessibility audit on a page
- `getSummary(result)` - Get violation counts by impact

### ScreenReaderSimulator

- `readPage()` - Get page content in reading order
- `getHeadings()` - Get all headings with levels
- `getLandmarks()` - Get page landmarks

### Types

- `Violation` - A WCAG violation with nodes
- `AuditResult` - Complete audit result
- `Impact` - 'critical' | 'serious' | 'moderate' | 'minor'
```

**Step 2: Final test run**

Run: `npm test && npm run build`
Expected: All tests pass, build succeeds

**Step 3: Commit**

```bash
git add packages/accessibility/README.md
git commit -m "docs(accessibility): add README"
```

**Step 4: Push branch**

```bash
git push -u origin rebuild/accessibility-layer
```

---

## Summary

After completing all tasks:

- `packages/accessibility/` - New accessibility scanning package
- Axe-core integration for baseline WCAG checks
- Auditor class coordinating scans
- Screen reader simulation
- Clean TypeScript with Zod schemas
- Ready for Agent Layer to use

**Next phase:** Build `packages/agent/` using browser and accessibility layers.
