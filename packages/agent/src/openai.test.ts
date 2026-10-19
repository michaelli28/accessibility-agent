import { describe, it, expect, vi } from 'vitest'
import { createOpenAIClient, generateAction, SYSTEM_PROMPT } from './openai.js'
import type { Step } from './types.js'

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  })),
}))

describe('createOpenAIClient', () => {
  it('creates client with API key', () => {
    const client = createOpenAIClient('test-key')
    expect(client).toBeDefined()
  })
})

describe('generateAction', () => {
  it('returns parsed action from model response', async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: 'click',
              target: 'button',
              reason: 'Click the button',
            }),
          },
        },
      ],
    }

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockResponse),
        },
      },
    }

    const action = await generateAction(
      mockClient as any,
      'gpt-4o',
      'Click the submit button',
      'Page has a form with submit button',
      [],
    )

    expect(action.type).toBe('click')
    expect(action.target).toBe('button')
  })

  it('handles model returning done action', async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: 'done',
              reason: 'Goal achieved',
            }),
          },
        },
      ],
    }

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockResponse),
        },
      },
    }

    const action = await generateAction(mockClient as any, 'gpt-4o', 'Test the page', 'All tests passed', [])

    expect(action.type).toBe('done')
  })

  it('throws error when model returns no content', async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: null,
          },
        },
      ],
    }

    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockResponse),
        },
      },
    }

    await expect(generateAction(mockClient as any, 'gpt-4o', 'Test', 'Observation', [])).rejects.toThrow(
      'No response from model',
    )
  })

  it('includes history in prompt', async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: 'audit',
              reason: 'Run audit after navigation',
            }),
          },
        },
      ],
    }

    const createMock = vi.fn().mockResolvedValue(mockResponse)
    const mockClient = {
      chat: {
        completions: {
          create: createMock,
        },
      },
    }

    const history: Step[] = [
      {
        stepNumber: 1,
        action: { type: 'navigate', target: 'https://example.com', reason: 'Go to page' },
        result: { success: true, observation: 'Page loaded' },
        timestamp: '2024-01-15T00:00:00Z',
      },
    ]

    await generateAction(mockClient as any, 'gpt-4o', 'Test the page', 'Page is ready', history)

    // Verify the create call included history in the messages
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Step 1: navigate'),
          }),
        ]),
      }),
    )
  })
})

// Test 41. The action table is the only place the model learns an action exists, so without these
// two rows the whole keyboard path is unreachable from the live loop.
describe('SYSTEM_PROMPT', () => {
  it('tells the model the keyboard actions exist', () => {
    expect(SYSTEM_PROMPT).toContain('| tab |')
    expect(SYSTEM_PROMPT).toContain('| checkKeyboard |')
    expect(SYSTEM_PROMPT).not.toContain('checkTrap')
  })
})
