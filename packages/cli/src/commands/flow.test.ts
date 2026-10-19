import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runFlow, FlowCommandOptions } from './flow.js'

// Mock the agent package
vi.mock('@at-agent/agent', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({
      success: true,
      goal: 'Test the page',
      steps: [
        {
          stepNumber: 1,
          action: { type: 'navigate', target: 'https://example.com', reason: 'Go to site' },
          result: { success: true, observation: 'Page loaded' },
          timestamp: '2024-01-15T00:00:00Z',
        },
      ],
      violations: [],
      summary: 'Goal achieved',
    }),
    stop: vi.fn(),
  })),
}))

describe('runFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Set up API key for tests
    process.env.OPENAI_API_KEY = 'test-api-key'
  })

  it('runs flow and returns result', async () => {
    const options: FlowCommandOptions = {
      url: 'https://example.com',
      goal: 'Test the login form',
      json: false,
    }

    const result = await runFlow(options)

    expect(result.success).toBe(true)
    expect(result.agentResult).toBeDefined()
  })

  it('returns JSON output when requested', async () => {
    const options: FlowCommandOptions = {
      url: 'https://example.com',
      goal: 'Test the page',
      json: true,
    }

    const result = await runFlow(options)

    expect(result.success).toBe(true)
    expect(result.output).toBeDefined()
    expect(() => JSON.parse(result.output!)).not.toThrow()
  })

  it('requires API key', async () => {
    delete process.env.OPENAI_API_KEY

    const options: FlowCommandOptions = {
      url: 'https://example.com',
      goal: 'Test',
      json: false,
    }

    const result = await runFlow(options)

    expect(result.success).toBe(false)
    expect(result.error).toContain('OPENAI_API_KEY')
  })

  it('passes headed option to agent', async () => {
    const { Agent } = await import('@at-agent/agent')
    const mockAgent = vi.mocked(Agent)

    const options: FlowCommandOptions = {
      url: 'https://example.com',
      goal: 'Test the page',
      headed: true,
    }

    await runFlow(options)

    const runCall = mockAgent.mock.results[0].value.run
    expect(runCall).toHaveBeenCalledWith('Test the page', expect.objectContaining({
      startUrl: 'https://example.com',
      headed: true,
    }))
  })
})
