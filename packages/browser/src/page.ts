import type { Page, Locator } from 'playwright'
import { ScreenshotOptionsSchema, type ElementData, type ScreenshotOptions, type AccessibilityNode } from './types.js'

export class BrowserPage {
  constructor(private readonly page: Page) {}

  get playwrightPage(): Page {
    return this.page
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  async url(): Promise<string> {
    return this.page.url()
  }

  async title(): Promise<string> {
    return this.page.title()
  }

  async getByRole(role: string, options?: { name?: string | RegExp }): Promise<ElementData[]> {
    const locator = this.page.getByRole(role as Parameters<Page['getByRole']>[0], options)
    return this.locatorToElementData(locator, role)
  }

  async getByText(text: string | RegExp, options?: { exact?: boolean }): Promise<ElementData[]> {
    const locator = this.page.getByText(text, options)
    return this.locatorToElementData(locator)
  }

  private async locatorToElementData(locator: Locator, role?: string): Promise<ElementData[]> {
    const count = await locator.count()
    const elements: ElementData[] = []

    for (let i = 0; i < count; i++) {
      const el = locator.nth(i)
      const box = await el.boundingBox()

      elements.push({
        tagName: await el.evaluate((node) => (node as Element).tagName.toLowerCase()),
        role: (await el.getAttribute('role')) ?? role ?? null,
        name: await el.evaluate((node) => {
          return (node as Element).getAttribute('aria-label') ?? (node as Element).textContent?.trim() ?? null
        }),
        value: await el.inputValue().catch(() => null),
        checked: await el.isChecked().catch(() => null),
        disabled: await el.isDisabled(),
        location: {
          selector: `${await el.evaluate((n) => (n as Element).tagName.toLowerCase())}`,
          boundingBox: box,
        },
      })
    }

    return elements
  }

  async screenshot(options: Partial<ScreenshotOptions> = {}): Promise<Buffer> {
    const opts = ScreenshotOptionsSchema.parse(options)
    return this.page.screenshot({
      fullPage: opts.fullPage,
      type: opts.type,
    })
  }

  async accessibilityTree(): Promise<AccessibilityNode> {
    const yamlSnapshot = await this.page.locator('body').ariaSnapshot()
    const children = this.parseAriaSnapshot(yamlSnapshot)
    return {
      role: 'WebArea',
      name: await this.title(),
      value: null,
      description: null,
      children,
    }
  }

  private parseAriaSnapshot(yaml: string): AccessibilityNode[] {
    const lines = yaml.split('\n')
    const result: AccessibilityNode[] = []
    const stack: { indent: number; node: AccessibilityNode }[] = []

    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('/')) continue

      const indent = line.search(/\S/)
      const content = line.trim()

      if (!content.startsWith('-')) continue

      const node = this.parseAriaLine(content.slice(1).trim())

      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }

      if (stack.length === 0) {
        result.push(node)
      } else {
        stack[stack.length - 1].node.children.push(node)
      }

      stack.push({ indent, node })
    }

    return result
  }

  private parseAriaLine(content: string): AccessibilityNode {
    // Parse lines like: heading "Example Domain" [level=1]
    // or: paragraph: some text here
    // or: link "Learn more":
    const roleMatch = content.match(/^(\w+)/)
    const role = roleMatch?.[1] ?? 'none'

    let name: string | null = null
    const quotedMatch = content.match(/"([^"]*)"/)
    if (quotedMatch) {
      name = quotedMatch[1]
    } else {
      // Check for unquoted text after colon (paragraph: text here)
      const colonMatch = content.match(/^\w+:\s*(.+?)(?:\s*$|\s*\[)/)
      if (colonMatch && colonMatch[1]) {
        name = colonMatch[1].trim()
      }
    }

    const levelMatch = content.match(/\[level=(\d+)\]/)
    const level = levelMatch ? Number(levelMatch[1]) : undefined

    return {
      role,
      name,
      value: null,
      description: null,
      ...(level === undefined ? {} : { level }),
      children: [],
    }
  }

  async clickByRole(role: string, options?: { name?: string | RegExp; timeout?: number }): Promise<void> {
    const { timeout, ...locatorOptions } = options ?? {}
    const locator = this.page.getByRole(role as Parameters<Page['getByRole']>[0], locatorOptions)
    await locator.click({ timeout })
  }

  async clickByText(text: string | RegExp): Promise<void> {
    const locator = this.page.getByText(text)
    await locator.click()
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.page.fill(selector, value)
  }

  async fillByRole(role: string, value: string, options?: { name?: string | RegExp }): Promise<void> {
    const locator = this.page.getByRole(role as Parameters<Page['getByRole']>[0], options)
    await locator.fill(value)
  }

  async close(): Promise<void> {
    await this.page.close()
  }

  async highlight(
    role: string,
    options: { name?: string | RegExp },
    label: string,
    duration: number = 500,
  ): Promise<void> {
    const locator = this.page.getByRole(role as Parameters<Page['getByRole']>[0], options)
    // Decoration only: skip unless exactly one element matches now, so the caller's action fails on
    // its own timeout and error. boundingBox() would wait the 30 s Playwright default for it.
    if ((await locator.count()) !== 1) return
    const box = await locator.boundingBox()
    if (!box) return

    await this.page.evaluate(
      ({ box, label, duration }) => {
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
      },
      { box, label, duration },
    )

    await this.page.waitForTimeout(duration)
  }
}
