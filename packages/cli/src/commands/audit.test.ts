import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runAudit, AuditCommandOptions } from './audit.js'

// Mock the browser and accessibility packages
vi.mock('@at-agent/browser', () => ({
  BrowserClient: vi.fn().mockImplementation(() => ({
    launch: vi.fn(),
    close: vi.fn(),
    newPage: vi.fn().mockResolvedValue({
      goto: vi.fn(),
      close: vi.fn(),
    }),
  })),
}))

vi.mock('@at-agent/accessibility', () => ({
  Auditor: vi.fn().mockImplementation(() => ({
    audit: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      timestamp: '2024-01-15T00:00:00Z',
      violations: [],
      passes: [{ id: 'test-rule', description: 'Test', nodeCount: 1 }],
      incomplete: [],
    }),
    getSummary: vi.fn().mockReturnValue({
      totalViolations: 0,
      totalPasses: 1,
      byImpact: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    }),
  })),
}))

describe('runAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs audit and returns result', async () => {
    const options: AuditCommandOptions = {
      url: 'https://example.com',
      json: false,
    }

    const result = await runAudit(options)

    expect(result.success).toBe(true)
    expect(result.auditResult).toBeDefined()
    expect(result.summary).toBeDefined()
  })

  it('returns JSON output when requested', async () => {
    const options: AuditCommandOptions = {
      url: 'https://example.com',
      json: true,
    }

    const result = await runAudit(options)

    expect(result.success).toBe(true)
    expect(result.output).toBeDefined()
    expect(() => JSON.parse(result.output!)).not.toThrow()
  })
})
