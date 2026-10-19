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
