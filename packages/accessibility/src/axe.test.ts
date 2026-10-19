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
