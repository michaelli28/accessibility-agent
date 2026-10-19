import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Agent } from './agent.js'
import * as openai from './openai.js'
import * as tools from './tools.js'
import type { KeyboardTrapResult, ContextChangeResult } from '@at-agent/accessibility'

// Mock OpenAI module
vi.mock('./openai.js', () => ({
  createOpenAIClient: vi.fn(),
  generateAction: vi.fn(),
}))

// Mock browser module
vi.mock('@at-agent/browser', () => ({
  BrowserClient: vi.fn().mockImplementation(() => ({
    launch: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  })),
  BrowserPage: vi.fn(),
}))

import { BrowserClient } from '@at-agent/browser'

// Mock tools module
vi.mock('./tools.js', () => ({
  executeAction: vi.fn(),
}))

// Judgement fixtures: the agent stores what the tools layer returns verbatim, so these only have
// to be well-formed KeyboardTrapResult / ContextChangeResult values.
function trapResult(verdict: 'pass' | 'fail' | 'undetermined'): KeyboardTrapResult {
  return {
    wcagCriterion: '2.1.2',
    verdict,
    reason: null,
    keyboardTrap: verdict === 'fail',
    trapEscapable: verdict === 'fail' ? false : null,
    singleDirection: true,
    directionsWalked: ['forward'],
    launch: { browserVersion: null, executableBasename: 'chrome-headless-shell' },
    directions: [],
  }
}

function contextChangeResult(verdict: 'pass' | 'fail' | 'undetermined'): ContextChangeResult {
  return {
    wcagCriterion: '3.2.1',
    verdict,
    reason: null,
    fIncomplete: false,
    findings: [],
    unattributed: [],
  }
}

describe('Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default mock for executeAction
    const mockExecuteAction = vi.mocked(tools.executeAction)
    mockExecuteAction.mockResolvedValue({
      success: true,
      observation: 'Action completed',
    })
  })

  describe('constructor', () => {
    it('creates agent with API key', () => {
      const agent = new Agent('test-api-key')
      expect(agent).toBeDefined()
    })
  })

  describe('run', () => {
    it('executes goal and returns result', async () => {
      // Mock generateAction to return navigate, observe, audit, then done
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction
        .mockResolvedValueOnce({
          type: 'navigate',
          target: 'https://example.com',
          reason: 'Navigate to target',
        })
        .mockResolvedValueOnce({
          type: 'observe',
          reason: 'Check page state',
        })
        .mockResolvedValueOnce({
          type: 'audit',
          reason: 'Run accessibility check',
        })
        .mockResolvedValueOnce({
          type: 'done',
          reason: 'Audit complete',
        })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Audit example.com for accessibility', {
        startUrl: 'https://example.com',
        maxSteps: 10,
      })

      expect(result.success).toBe(true)
      expect(result.steps.length).toBe(4)
      expect(result.goal).toBe('Audit example.com for accessibility')
    }, 60000)

    it('stops after maxSteps', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      // Always return observe (never done)
      mockGenerateAction.mockResolvedValue({
        type: 'observe',
        reason: 'Keep observing',
      })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Never-ending goal', {
        startUrl: 'https://example.com',
        maxSteps: 3,
      })

      expect(result.success).toBe(false)
      expect(result.steps.length).toBe(3)
      expect(result.summary).toContain('max steps')
    }, 60000)

    it('collects violations from audit steps', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction
        .mockResolvedValueOnce({
          type: 'navigate',
          target: 'https://example.com',
          reason: 'Navigate',
        })
        .mockResolvedValueOnce({
          type: 'audit',
          reason: 'Check accessibility',
        })
        .mockResolvedValueOnce({
          type: 'done',
          reason: 'Complete',
        })

      // Mock executeAction to return violations on audit step
      const mockExecuteAction = vi.mocked(tools.executeAction)
      mockExecuteAction
        .mockResolvedValueOnce({
          success: true,
          observation: 'Navigated to page',
        })
        .mockResolvedValueOnce({
          success: true,
          observation: 'Audit complete',
          violations: [
            {
              id: 'test-violation',
              impact: 'serious',
              description: 'Test violation',
              help: 'Fix this',
              helpUrl: 'https://example.com/help',
              wcagTags: ['wcag2aa'],
              nodes: [],
            },
          ],
        })
        .mockResolvedValueOnce({
          success: true,
          observation: 'Done',
        })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Audit the page', {
        startUrl: 'https://example.com',
      })

      expect(result.violations).toBeDefined()
      expect(Array.isArray(result.violations)).toBe(true)
      expect(result.violations.length).toBe(1)
      expect(result.violations[0].id).toBe('test-violation')
    }, 60000)
  })

  describe('stop', () => {
    it('stops running agent', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  type: 'observe',
                  reason: 'Slow action',
                }),
              1000,
            ),
          ),
      )

      const agent = new Agent('test-api-key')
      const runPromise = agent.run('Long running goal', {
        startUrl: 'https://example.com',
        maxSteps: 100,
      })

      // Stop after short delay
      setTimeout(() => agent.stop(), 100)

      const result = await runPromise
      expect(result.success).toBe(false)
      expect(result.summary).toContain('stopped')
    }, 60000)
  })

  describe('headed option', () => {
    it('passes headed option to BrowserClient', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction.mockResolvedValue({
        type: 'done',
        reason: 'Goal achieved',
      })

      const agent = new Agent('test-api-key')
      await agent.run('test goal', { startUrl: 'https://example.com', headed: true })

      expect(BrowserClient).toHaveBeenCalledWith({ headless: false })
    })

    it('defaults to headless mode', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction.mockResolvedValue({
        type: 'done',
        reason: 'Goal achieved',
      })

      const agent = new Agent('test-api-key')
      await agent.run('test goal', { startUrl: 'https://example.com' })

      expect(BrowserClient).toHaveBeenCalledWith({ headless: true })
    })

    it('passes headed option to executeAction', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction.mockResolvedValue({
        type: 'done',
        reason: 'Goal achieved',
      })

      const agent = new Agent('test-api-key')
      await agent.run('test goal', { startUrl: 'https://example.com', headed: true })

      expect(tools.executeAction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({ headed: true }),
      )
    })
  })

  describe('keyboard checks', () => {
    // Test 40: the judge takes a page, not a replayed string list, so nothing but `headed` may
    // cross the tools boundary; and one record is kept per PRESS, not per action.
    it('no trapContext crosses the tools boundary; presses accumulate per press', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction
        .mockResolvedValueOnce({ type: 'tab', value: '2', reason: 'Tab twice' })
        .mockResolvedValueOnce({ type: 'tab', value: '2', reason: 'Tab twice again' })
        .mockResolvedValueOnce({ type: 'checkKeyboard', reason: 'Check the keyboard' })
        .mockResolvedValueOnce({ type: 'done', reason: 'Complete' })

      const mockExecuteAction = vi.mocked(tools.executeAction)
      mockExecuteAction
        .mockResolvedValueOnce({
          success: true,
          observation: 'Tab x2: a#one -> a#two',
          presses: [
            { index: 1, key: 'Tab', element: 'a#one', timestamp: 1 },
            { index: 2, key: 'Tab', element: 'a#two', timestamp: 2 },
          ],
        })
        .mockResolvedValueOnce({
          success: true,
          observation: 'Tab x2: a#three -> a#four',
          presses: [
            { index: 1, key: 'Tab', element: 'a#three', timestamp: 3 },
            { index: 2, key: 'Tab', element: 'a#four', timestamp: 4 },
          ],
        })
        .mockResolvedValueOnce({
          success: true,
          observation: 'Keyboard check complete',
          keyboard: trapResult('pass'),
          contextChange: contextChangeResult('pass'),
        })
        .mockResolvedValueOnce({ success: true, observation: 'Done' })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Walk the page', { startUrl: 'https://example.com' })

      const checkCall = mockExecuteAction.mock.calls.find((call) => call[0].type === 'checkKeyboard')
      expect(checkCall).toBeDefined()
      expect(checkCall![2]).toEqual({ headed: false })

      expect(result.tabPresses).toHaveLength(4)
      expect(result.tabPresses!.map((p) => p.element)).toEqual(['a#one', 'a#two', 'a#three', 'a#four'])
      expect((result as Record<string, unknown>).focusHistory).toBeUndefined()
      expect((result as Record<string, unknown>).trapDetected).toBeUndefined()
    }, 60000)

    // Rewrite of the old ten-tabs-then-checkTrap latch test. A latch was defensible for a boolean;
    // on a three-valued verdict it would make one `undetermined` permanently non-pass.
    it('stores the keyboard verdict with last-wins, no latch', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction
        .mockResolvedValueOnce({ type: 'checkKeyboard', reason: 'First check' })
        .mockResolvedValueOnce({ type: 'checkKeyboard', reason: 'Second check' })
        .mockResolvedValueOnce({ type: 'done', reason: 'Complete' })

      const mockExecuteAction = vi.mocked(tools.executeAction)
      mockExecuteAction
        .mockResolvedValueOnce({
          success: true,
          observation: 'Keyboard check complete',
          keyboard: trapResult('fail'),
          contextChange: contextChangeResult('fail'),
        })
        .mockResolvedValueOnce({
          success: true,
          observation: 'Keyboard check complete',
          keyboard: trapResult('pass'),
          contextChange: contextChangeResult('pass'),
        })
        .mockResolvedValueOnce({ success: true, observation: 'Done' })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Check twice', { startUrl: 'https://example.com' })

      expect(result.keyboard).not.toBeNull()
      expect(result.keyboard!.verdict).toBe('pass')
      expect(result.contextChange!.verdict).toBe('pass')
    }, 60000)

    it('leaves both judgements null when no keyboard check ran', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction.mockResolvedValue({ type: 'done', reason: 'Goal achieved' })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Do nothing', { startUrl: 'https://example.com' })

      expect(result.keyboard).toBeNull()
      expect(result.contextChange).toBeNull()
    }, 60000)

    it('resets tab presses between runs', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      const mockExecuteAction = vi.mocked(tools.executeAction)

      mockGenerateAction
        .mockResolvedValueOnce({ type: 'tab', reason: 'Tab' })
        .mockResolvedValueOnce({ type: 'done', reason: 'Done' })

      mockExecuteAction
        .mockResolvedValueOnce({
          success: true,
          observation: 'Focused on: button#first-run',
          presses: [{ index: 1, key: 'Tab', element: 'button#first-run', timestamp: 1 }],
        })
        .mockResolvedValueOnce({ success: true, observation: 'Done' })

      const agent = new Agent('test-api-key')
      const result1 = await agent.run('First run', { startUrl: 'https://example.com' })

      expect(result1.tabPresses).toHaveLength(1)
      expect(result1.tabPresses![0].element).toBe('button#first-run')

      vi.clearAllMocks()

      mockGenerateAction
        .mockResolvedValueOnce({ type: 'tab', reason: 'Tab' })
        .mockResolvedValueOnce({ type: 'done', reason: 'Done' })

      mockExecuteAction
        .mockResolvedValueOnce({
          success: true,
          observation: 'Focused on: button#second-run',
          presses: [{ index: 1, key: 'Tab', element: 'button#second-run', timestamp: 2 }],
        })
        .mockResolvedValueOnce({ success: true, observation: 'Done' })

      const result2 = await agent.run('Second run', { startUrl: 'https://example.com' })

      expect(result2.tabPresses).toHaveLength(1)
      expect(result2.tabPresses![0].element).toBe('button#second-run')
    }, 60000)
  })

  describe('the retired dynamic evaluator', () => {
    // Test 38. This is the inversion of the test that certified the bug: the old rule recorded the
    // AGENT's own navigate as an interaction event and then reported it as the page changing
    // context on focus. Deleting recordInteractionEvent deletes the producer.
    it("the agent's own navigate is no longer a 3.2.1", async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction
        .mockResolvedValueOnce({ type: 'tab', reason: 'Tab to link' })
        .mockResolvedValueOnce({
          type: 'navigate',
          target: 'https://example.com/other',
          reason: 'Navigate away',
        })
        .mockResolvedValueOnce({ type: 'done', reason: 'Complete' })

      const mockExecuteAction = vi.mocked(tools.executeAction)
      mockExecuteAction
        .mockResolvedValueOnce({
          success: true,
          observation: 'Focused on: a#auto-nav',
          presses: [{ index: 1, key: 'Tab', element: 'a#auto-nav', timestamp: 1 }],
        })
        .mockResolvedValueOnce({ success: true, observation: 'Navigated to other page' })
        .mockResolvedValueOnce({ success: true, observation: 'Done' })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Test context change detection', {
        startUrl: 'https://example.com',
      })

      expect(result.success).toBe(true)
      expect('dynamicViolations' in result).toBe(false)
      expect(result.contextChange).toBeNull()
    }, 60000)

    // Test 39. The 2.4.3 focus-order rule is retired, not repaired: on a real page a repeated
    // focus identity is wrap-around (bench/COVERAGE.md).
    it('no 2.4.3 survives', async () => {
      const mockGenerateAction = vi.mocked(openai.generateAction)
      mockGenerateAction
        .mockResolvedValueOnce({ type: 'tab', reason: 'Tab 1' })
        .mockResolvedValueOnce({ type: 'tab', reason: 'Tab 2' })
        .mockResolvedValueOnce({ type: 'tab', reason: 'Tab 3' })
        .mockResolvedValueOnce({ type: 'tab', reason: 'Tab 4 - back to first' })
        .mockResolvedValueOnce({ type: 'done', reason: 'Complete' })

      const mockExecuteAction = vi.mocked(tools.executeAction)
      for (const [i, element] of ['button#A', 'button#B', 'button#C', 'button#A'].entries()) {
        mockExecuteAction.mockResolvedValueOnce({
          success: true,
          observation: `Focused on: ${element}`,
          presses: [{ index: 1, key: 'Tab', element, timestamp: i + 1 }],
        })
      }
      mockExecuteAction.mockResolvedValueOnce({ success: true, observation: 'Done' })

      const agent = new Agent('test-api-key')
      const result = await agent.run('Test focus cycling detection', {
        startUrl: 'https://example.com',
      })

      expect(result.success).toBe(true)
      expect('dynamicViolations' in result).toBe(false)
      expect(result.tabPresses).toHaveLength(4)
    }, 60000)
  })
})
