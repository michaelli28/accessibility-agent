import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BrowserClient } from './client.js'
import { BrowserPage } from './page.js'

// example.com dropped its <h1> in 2026-10 and asks not to be used for testing; tests that need
// the heading load this fixed copy of the old page instead.
const EXAMPLE_DOMAIN =
  '<title>Example Domain</title><h1>Example Domain</h1>' +
  '<p>This domain is for use in illustrative examples in documents.</p>' +
  '<a href="https://www.iana.org/domains/example">Learn more</a>'

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
      const links = await page.getByRole('link', { name: 'Learn more' })
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

    it('finds elements by text', async () => {
      page = await client.newPage()
      await page.playwrightPage.setContent(EXAMPLE_DOMAIN)
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
  })

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
      await page.playwrightPage.setContent(EXAMPLE_DOMAIN)
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

  describe('interactions', () => {
    it('clicks element by role', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')
      // Click the "Learn more" link
      await page.clickByRole('link', { name: 'Learn more' })
      // Should navigate to IANA
      expect(await page.url()).toContain('iana.org')
      await page.close()
    })

    it('throws when element not found', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')
      await expect(
        page.clickByRole('button', { name: 'nonexistent', timeout: 1000 })
      ).rejects.toThrow()
      await page.close()
    })
  })

  describe('highlight', () => {
    it('injects overlay element with label', async () => {
      page = await client.newPage()
      await page.playwrightPage.setContent(EXAMPLE_DOMAIN)

      const highlightPromise = page.highlight('heading', { name: 'Example Domain' }, 'CLICK', 500)

      await page.playwrightPage.waitForSelector('#__agent_highlight__')

      const overlay = await page.playwrightPage.$('#__agent_highlight__')
      expect(overlay).not.toBeNull()

      const labelText = await page.playwrightPage.$eval('#__agent_highlight__ > div', el => el.textContent)
      expect(labelText).toBe('CLICK')

      await highlightPromise
      await page.close()
    })

    it('returns at once on a target the page lacks, leaving the failure to the action', async () => {
      page = await client.newPage()
      await page.playwrightPage.setContent('<button>Submit</button>')

      const outcome = await Promise.race([
        page.highlight('button', { name: 'Sumbit' }, 'CLICK', 0).then(
          () => 'returned',
          (error: Error) => `threw: ${error.message}`,
        ),
        new Promise((resolve) => setTimeout(() => resolve('still waiting after 2 s'), 2000)),
      ])

      expect(outcome).toBe('returned')
      await page.close()
    })
  })

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
})
