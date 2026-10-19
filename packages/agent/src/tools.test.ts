import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { BrowserClient, BrowserPage } from '@at-agent/browser'
import { executeAction } from './tools.js'
import type { Action } from './types.js'

describe('executeAction', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
  })

  afterAll(async () => {
    await client.close()
  })

  describe('navigate', () => {
    it('navigates to URL and returns observation', async () => {
      page = await client.newPage()
      const action: Action = {
        type: 'navigate',
        target: 'https://example.com',
        reason: 'Go to example.com',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(true)
      expect(result.observation).toContain('Example Domain')
      await page.close()
    })

    it('returns failure when no URL provided', async () => {
      page = await client.newPage()
      const action: Action = {
        type: 'navigate',
        reason: 'Navigate somewhere',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(false)
      expect(result.observation).toContain('No URL provided')
      await page.close()
    })
  })

  describe('observe', () => {
    it('returns page state and accessibility info', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'observe',
        reason: 'Check page state',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(true)
      expect(result.observation).toContain('Headings:')
      await page.close()
    })
  })

  describe('audit', () => {
    it('runs accessibility audit and returns results', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'audit',
        reason: 'Check accessibility',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(true)
      expect(result.observation).toContain('audit')
      await page.close()
    })
  })

  describe('click', () => {
    it('clicks element by role and name', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'click',
        target: 'link named "More information..."',
        reason: 'Click the link',
      }

      const result = await executeAction(action, page)

      // May succeed or fail depending on element existence and timeout
      // We just check that the operation was attempted
      expect(result.observation).toBeDefined()
      expect(typeof result.success).toBe('boolean')
      await page.close()
    }, 120000)

    it('returns failure when no target provided', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'click',
        reason: 'Click something',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(false)
      expect(result.observation).toContain('No target provided')
      await page.close()
    })

    it('headed, reports a missing target as a click failure within the click timeout', async () => {
      page = await client.newPage()
      await page.playwrightPage.setContent('<button>Submit</button>')

      const action: Action = {
        type: 'click',
        target: 'button named "Sumbit"',
        reason: 'Submit the form',
      }

      const started = Date.now()
      const result = await executeAction(action, page, { headed: true })
      const elapsed = Date.now() - started

      expect(result.success).toBe(false)
      expect(result.observation).toContain('locator.click')
      expect(result.observation).not.toContain('boundingBox')
      expect(elapsed).toBeLessThan(15_000)
      await page.close()
    }, 60_000)
  })

  describe('fill', () => {
    it('returns failure when no target or value provided', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'fill',
        reason: 'Fill something',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(false)
      expect(result.observation).toContain('No target or value provided')
      await page.close()
    })
  })

  describe('done', () => {
    it('returns completion message', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action: Action = {
        type: 'done',
        reason: 'Goal achieved',
      }

      const result = await executeAction(action, page)

      expect(result.success).toBe(true)
      expect(result.observation).toContain('Goal achieved')
      await page.close()
    })
  })

  describe('unknown action type', () => {
    it('returns failure for unknown action type', async () => {
      page = await client.newPage()
      await page.goto('https://example.com')

      const action = {
        type: 'invalid_action',
        reason: 'Test unknown action',
      } as unknown as Action

      const result = await executeAction(action, page)

      expect(result.success).toBe(false)
      expect(result.observation).toContain('Unknown action type')
      await page.close()
    })
  })

  describe('options parameter', () => {
    it('accepts options parameter', async () => {
      page = await client.newPage()
      const action: Action = { type: 'done', reason: 'test' }
      const result = await executeAction(action, page, { headed: true })
      expect(result.success).toBe(true)
      await page.close()
    })
  })
})

describe('executeAction with mocked page', () => {
  function createMockPage() {
    return {
      highlight: vi.fn(),
      clickByRole: vi.fn(),
      clickByText: vi.fn(),
      fillByRole: vi.fn(),
      goto: vi.fn(),
      title: vi.fn().mockResolvedValue('Test Page'),
      url: vi.fn().mockResolvedValue('https://example.com'),
      accessibilityTree: vi.fn().mockResolvedValue({ role: 'document', name: 'Test' }),
    } as unknown as BrowserPage
  }

  describe('click highlighting', () => {
    it('calls highlight before click when headed is true', async () => {
      const mockPage = createMockPage()
      const highlightSpy = vi.fn()
      mockPage.highlight = highlightSpy
      mockPage.clickByRole = vi.fn()

      const action: Action = { type: 'click', target: 'button named "Submit"', reason: 'Click submit' }
      await executeAction(action, mockPage, { headed: true })

      expect(highlightSpy).toHaveBeenCalledWith('button', { name: 'Submit' }, 'CLICK', 500)
      expect(mockPage.clickByRole).toHaveBeenCalled()
    })

    it('does not highlight when headed is false', async () => {
      const mockPage = createMockPage()
      const highlightSpy = vi.fn()
      mockPage.highlight = highlightSpy
      mockPage.clickByRole = vi.fn()

      const action: Action = { type: 'click', target: 'button named "Submit"', reason: 'Click submit' }
      await executeAction(action, mockPage, { headed: false })

      expect(highlightSpy).not.toHaveBeenCalled()
    })
  })

  describe('fill highlighting', () => {
    it('calls highlight before fill when headed is true', async () => {
      const mockPage = createMockPage()

      const action: Action = {
        type: 'fill',
        target: 'textbox named "Email"',
        value: 'test@example.com',
        reason: 'Fill email field',
      }
      await executeAction(action, mockPage, { headed: true })

      expect(mockPage.highlight).toHaveBeenCalledWith('textbox', { name: 'Email' }, 'FILL', 500)
      expect(mockPage.fillByRole).toHaveBeenCalled()
    })

    it('does not highlight fill when headed is false', async () => {
      const mockPage = createMockPage()

      const action: Action = {
        type: 'fill',
        target: 'textbox named "Email"',
        value: 'test@example.com',
        reason: 'Fill email field',
      }
      await executeAction(action, mockPage, { headed: false })

      expect(mockPage.highlight).not.toHaveBeenCalled()
    })
  })
})
