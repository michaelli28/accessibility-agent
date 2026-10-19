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
