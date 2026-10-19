import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AuditSummary } from '@at-agent/accessibility'
import { createProgram } from '../cli.js'
import { runAudit } from './audit.js'
import { runFlow } from './flow.js'

vi.mock('./audit.js', () => ({ runAudit: vi.fn() }))
vi.mock('./flow.js', () => ({ runFlow: vi.fn() }))

async function exitCodeOf(args: string[]): Promise<number> {
  await createProgram().parseAsync(args, { from: 'user' })
  return Number(process.exitCode ?? 0)
}

function auditSummary(critical: number): AuditSummary {
  return { byImpact: { critical, serious: 0, moderate: 0, minor: 0 } } as AuditSummary
}

describe('audit and flow exit codes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Same reason as gaps-exit.test.ts: process.exit drops stdout still buffered for a pipe.
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit truncates piped stdout; set process.exitCode instead')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('audit exits 1 on a critical violation, after printing its output', async () => {
    vi.mocked(runAudit).mockResolvedValueOnce({ success: true, summary: auditSummary(1), output: '{}' })
    expect(await exitCodeOf(['audit', 'https://example.com'])).toBe(1)
    expect(console.log).toHaveBeenCalledWith('{}')
  })

  it('audit exits 0 on a clean page', async () => {
    vi.mocked(runAudit).mockResolvedValueOnce({ success: true, summary: auditSummary(0) })
    expect(await exitCodeOf(['audit', 'https://example.com'])).toBe(0)
  })

  it('audit exits 1 and prints the error when it fails', async () => {
    vi.mocked(runAudit).mockResolvedValueOnce({ success: false, error: 'boom' })
    expect(await exitCodeOf(['audit', 'https://example.com'])).toBe(1)
    expect(console.error).toHaveBeenCalledWith('Error: boom')
  })

  it('flow exits 1 and prints the error when it fails', async () => {
    vi.mocked(runFlow).mockResolvedValueOnce({ success: false, error: 'boom', output: '{}' })
    expect(await exitCodeOf(['flow', 'https://example.com', '--goal', 'g'])).toBe(1)
    expect(console.log).toHaveBeenCalledWith('{}')
    expect(console.error).toHaveBeenCalledWith('Error: boom')
  })

  it('flow exits 0 when the goal is reached', async () => {
    vi.mocked(runFlow).mockResolvedValueOnce({ success: true })
    expect(await exitCodeOf(['flow', 'https://example.com', '--goal', 'g'])).toBe(0)
  })
})
