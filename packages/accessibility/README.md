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
