import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { BrowserPage } from '@at-agent/browser'
import { runTabWalk } from '@at-agent/accessibility'
import { executeAction } from './tools.js'
import { ActionSchema, ActionTypeSchema, type Action } from './types.js'

// A pass-through spy, so one test can stand in a walk whose escape probe failed part-way.
vi.mock('@at-agent/accessibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@at-agent/accessibility')>()
  return { ...actual, runTabWalk: vi.fn(actual.runTabWalk) }
})

// Keyboard capability of the agent loop: the `tab` action records one press per key press, and
// `checkKeyboard` answers WCAG 2.1.2 / 3.2.1 by driving a real Tab walk in the browser.
// The retired `checkTrap` replayed a list of strings and never touched the page, so it could not
// press Escape or Shift+Tab; its tests pinned the wrap-around false positive and are gone.

function createMockPage() {
  return {
    playwrightPage: {
      keyboard: {
        press: vi.fn(),
      },
      evaluate: vi.fn(),
    },
    goto: vi.fn(),
    title: vi.fn().mockResolvedValue('Test Page'),
    url: vi.fn().mockResolvedValue('https://example.com'),
    accessibilityTree: vi.fn().mockResolvedValue({ role: 'document', name: 'Test' }),
  } as unknown as BrowserPage
}

describe('tab action', () => {
  it('executes tab action and records the press', async () => {
    const mockPage = createMockPage()
    const evaluateMock = mockPage.playwrightPage.evaluate as ReturnType<typeof vi.fn>
    evaluateMock.mockResolvedValue('button#submit')

    const action: Action = {
      type: 'tab',
      reason: 'Navigate to next focusable element',
    }

    const result = await executeAction(action, mockPage)

    expect(result.success).toBe(true)
    expect(result.observation).toContain('Focused on')
    expect(result.presses).toHaveLength(1)
    expect(result.presses?.[0].element).toBe('button#submit')
    expect(mockPage.playwrightPage.keyboard.press).toHaveBeenCalledWith('Tab')
  })

  it('executes shift+tab action when target is "previous"', async () => {
    const mockPage = createMockPage()
    const evaluateMock = mockPage.playwrightPage.evaluate as ReturnType<typeof vi.fn>
    evaluateMock.mockResolvedValue('input#email')

    const action: Action = {
      type: 'tab',
      target: 'previous',
      reason: 'Navigate to previous focusable element',
    }

    const result = await executeAction(action, mockPage)

    expect(result.success).toBe(true)
    expect(mockPage.playwrightPage.keyboard.press).toHaveBeenCalledWith('Shift+Tab')
    expect(result.presses?.[0].key).toBe('Shift+Tab')
  })

  // Test 35. The retired shape pressed N times and read focus ONCE, at the end: on a three-stop
  // page a 4-press action reported a single element and the legacy detector read that as a
  // 1-cycle trap (bench/probes/wrap/RESULT.md:345, fixtures A, D and E).
  it('every Tab press is recorded', async () => {
    const mockPage = createMockPage()
    const evaluateMock = mockPage.playwrightPage.evaluate as ReturnType<typeof vi.fn>
    evaluateMock.mockResolvedValueOnce('a#one').mockResolvedValueOnce('a#two').mockResolvedValueOnce('a#three')

    const action: Action = {
      type: 'tab',
      value: '3',
      reason: 'Tab 3 times',
    }

    const result = await executeAction(action, mockPage)

    expect(result.success).toBe(true)
    expect(mockPage.playwrightPage.keyboard.press).toHaveBeenCalledTimes(3)
    expect(evaluateMock).toHaveBeenCalledTimes(3)
    expect(result.presses).toHaveLength(3)
    expect(result.presses?.map((p) => p.element)).toEqual(['a#one', 'a#two', 'a#three'])
    expect(result.presses?.map((p) => p.index)).toEqual([1, 2, 3])
    expect(result.observation).toContain('a#one')
    expect(result.observation).toContain('a#two')
    expect(result.observation).toContain('a#three')
  })

  it('returns failure when keyboard action fails', async () => {
    const mockPage = createMockPage()
    const pressMock = mockPage.playwrightPage.keyboard.press as ReturnType<typeof vi.fn>
    pressMock.mockRejectedValue(new Error('Keyboard error'))

    const action: Action = {
      type: 'tab',
      reason: 'Tab forward',
    }

    const result = await executeAction(action, mockPage)

    expect(result.success).toBe(false)
    expect(result.observation).toContain('Tab failed')
  })

  // The system prompt calls tab's value a "press count", so a model may send it as a JSON number;
  // a string-only schema threw in generateAction and ended the whole run.
  it('accepts a numeric press count from the model, and a zero-padded one', async () => {
    expect(ActionSchema.parse({ type: 'tab', value: 3, reason: 'Tab 3 times' }).value).toBe('3')

    const mockPage = createMockPage()
    const evaluateMock = mockPage.playwrightPage.evaluate as ReturnType<typeof vi.fn>
    evaluateMock.mockResolvedValue('a#one')
    const result = await executeAction({ type: 'tab', value: '02', reason: 'Tab twice' }, mockPage)
    expect(result.success).toBe(true)
    expect(mockPage.playwrightPage.keyboard.press).toHaveBeenCalledTimes(2)
  })

  it('refuses a press count that is not a whole number of at least 1, without pressing', async () => {
    for (const value of ['three', '0', '-2', '1.5']) {
      const mockPage = createMockPage()
      const result = await executeAction({ type: 'tab', value, reason: 'Tab' }, mockPage)
      expect(result.success, value).toBe(false)
      expect(result.observation, value).toContain('press count')
      expect(mockPage.playwrightPage.keyboard.press, value).not.toHaveBeenCalled()
    }
  })

  it('keeps the presses already recorded when a later read fails', async () => {
    const mockPage = createMockPage()
    const evaluateMock = mockPage.playwrightPage.evaluate as ReturnType<typeof vi.fn>
    evaluateMock.mockResolvedValueOnce('a#one').mockRejectedValueOnce(new Error('Execution context was destroyed'))

    const result = await executeAction({ type: 'tab', value: '3', reason: 'Tab 3 times' }, mockPage)

    expect(result.success).toBe(false)
    expect(result.observation).toContain('Execution context was destroyed')
    expect(result.presses?.map((p) => p.element)).toEqual(['a#one'])
  })
})

// Test 36.
describe('checkKeyboard action', () => {
  it('checkKeyboard exists and is walk-driven', async () => {
    expect(ActionTypeSchema.parse('checkKeyboard')).toBe('checkKeyboard')
    expect(() => ActionTypeSchema.parse('checkTrap')).toThrow()
    const action = ActionSchema.parse({ type: 'checkKeyboard', reason: 'x' })
    expect(action.type).toBe('checkKeyboard')

    // runTabWalk registers its crash listener, then calls page.context().newCDPSession(page); a page whose
    // context throws proves the action reached the walk path rather than the unknown-action branch.
    const contextMock = vi.fn(() => {
      throw new Error('no browser in this test')
    })
    const mockPage = {
      playwrightPage: { context: contextMock, once: vi.fn(), off: vi.fn() },
    } as unknown as BrowserPage

    const result = await executeAction(action, mockPage)

    expect(contextMock).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
    expect(result.observation).toContain('Keyboard check failed')
    expect(result.observation).not.toContain('Unknown action type')
  })
})

// Test 37. Chromium: run outside the sandbox.
// Fixtures copied from packages/accessibility/src/tab-walk.test.ts:28-63.
const TAB_SWALLOW_TRAP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trap</title></head><body>
<p><a id="t1" href="#one">One</a></p>
<p><input id="trap" type="text" aria-label="Trap"></p>
<p><a id="t3" href="#three">Three</a></p>
<script>
document.getElementById('trap').addEventListener('keydown', (e) => { if (e.key === 'Tab') e.preventDefault() })
</script>
</body></html>`

const MODAL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Modal</title></head><body>
<p><a id="before" href="#b">Before</a></p>
<p><button id="open" type="button">Open dialog</button></p>
<div id="dlg" role="dialog" aria-modal="true" aria-label="Dialog">
  <button id="ok" type="button">OK</button>
  <button id="cancel" type="button">Cancel</button>
</div>
<script>
const dlg = document.getElementById('dlg')
const opener = document.getElementById('open')
const items = () => [...dlg.querySelectorAll('button')]
document.addEventListener('keydown', (e) => {
  if (dlg.hidden) return
  if (e.key === 'Tab') {
    e.preventDefault()
    const list = items()
    const i = list.indexOf(document.activeElement)
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i + 1) % list.length
    list[next].focus()
  } else if (e.key === 'Escape') {
    dlg.hidden = true
    opener.focus()
  }
})
items()[0].focus()
</script>
</body></html>`

const LINKS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Links</title></head><body>
<p><a id="l1" href="#one">One</a></p>
<p><a id="l2" href="#two">Two</a></p>
</body></html>`

describe('checkKeyboard against a real page', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  async function checkKeyboardOn(html: string) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.setContent(html)
    const result = await executeAction({ type: 'checkKeyboard', reason: 'check' }, new BrowserPage(page))
    await context.close()
    return result
  }

  it('checkKeyboard on a real trap and on a correct modal', async () => {
    const trapped = await checkKeyboardOn(TAB_SWALLOW_TRAP)
    expect(trapped.success).toBe(true)
    expect(trapped.keyboard?.verdict).toBe('fail')
    expect(trapped.keyboard?.keyboardTrap).toBe(true)
    expect(trapped.keyboard?.trapEscapable).toBe(false)
    expect(trapped.observation).toContain('2.1.2')
    expect(trapped.observation).toContain('Escape')
    expect(trapped.observation).toContain('Shift+Tab')

    const modal = await checkKeyboardOn(MODAL)
    expect(modal.success).toBe(true)
    expect(modal.keyboard?.verdict).toBe('pass')
    expect(modal.keyboard?.keyboardTrap).toBe(true)
    expect(modal.keyboard?.trapEscapable).toBe(true)
  }, 180_000)

  it('says Escape and Shift+Tab were pressed only when the walk pressed them', async () => {
    const wrapping = await checkKeyboardOn(LINKS)
    expect(wrapping.keyboard?.verdict).toBe('pass')
    expect(wrapping.observation).toContain('did not press Escape or Shift+Tab')
    expect(wrapping.observation).not.toContain('pressed Escape')

    const trapped = await checkKeyboardOn(TAB_SWALLOW_TRAP)
    expect(trapped.observation).toContain('then pressed Escape and Shift+Tab')
  }, 180_000)

  it('says Escape and Shift+Tab may have been pressed when that part of the walk failed', async () => {
    const actual = await vi.importActual<typeof import('@at-agent/accessibility')>('@at-agent/accessibility')
    vi.mocked(runTabWalk).mockImplementationOnce(async (page, options) => ({
      ...(await actual.runTabWalk(page, options)),
      escapeProbe: null,
      error: { phase: 'escapeProbe', index: 1, message: 'Execution context was destroyed' },
    }))

    const failed = await checkKeyboardOn(TAB_SWALLOW_TRAP)
    expect(failed.success).toBe(true)
    expect(failed.keyboard?.verdict).toBe('undetermined')
    expect(failed.observation).toContain('may have pressed Escape and Shift+Tab')
  }, 180_000)
})
