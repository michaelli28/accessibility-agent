import { describe, it, expect } from 'vitest'
import { formatViolation, formatAuditSummary, formatAgentResult } from './output.js'
import type { Violation } from '@at-agent/accessibility'
import type { AgentResult } from '@at-agent/agent'

describe('formatViolation', () => {
  it('formats a violation for terminal display', () => {
    const violation: Violation = {
      id: 'image-alt',
      impact: 'critical',
      description: 'Images must have alternate text',
      help: 'Ensure images have alt attributes',
      helpUrl: 'https://example.com/rules/image-alt',
      wcagTags: ['wcag2a', 'wcag111'],
      nodes: [{
        html: '<img src="photo.jpg">',
        target: ['img'],
        failureSummary: 'Element does not have an alt attribute',
      }],
    }

    const output = formatViolation(violation)

    expect(output).toContain('image-alt')
    expect(output).toContain('CRITICAL')
    expect(output).toContain('Ensure images have alt attributes')
  })
})

describe('formatAuditSummary', () => {
  it('formats audit summary with counts', () => {
    const summary = {
      totalViolations: 5,
      totalPasses: 20,
      byImpact: { critical: 1, serious: 2, moderate: 1, minor: 1 },
    }

    const output = formatAuditSummary(summary)

    expect(output).toContain('5 violations')
    expect(output).toContain('Critical: 1')
    expect(output).toContain('20 rules passed')
  })
})

describe('formatAgentResult', () => {
  it('formats successful agent result', () => {
    const result: AgentResult = {
      success: true,
      goal: 'Test the login form',
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
      keyboard: null,
      contextChange: null,
    }

    const output = formatAgentResult(result)

    expect(output).toContain('Success')
    expect(output).toContain('1 step')
    expect(output).toContain('Goal achieved')
  })

  it('formats failed agent result', () => {
    const result: AgentResult = {
      success: false,
      goal: 'Test the login form',
      steps: [],
      violations: [],
      summary: 'Could not find login form',
      keyboard: null,
      contextChange: null,
    }

    const output = formatAgentResult(result)

    expect(output).toContain('Failed')
    expect(output).toContain('Could not find login form')
  })

  // The verdicts used to reach --json only: a trap page printed 'Violations: 0' and nothing else.
  it('prints the keyboard verdicts when the agent ran checkKeyboard', () => {
    const result: AgentResult = {
      success: true,
      goal: 'Check the page',
      steps: [],
      violations: [],
      summary: 'Done',
      keyboard: { verdict: 'fail', reason: null } as NonNullable<AgentResult['keyboard']>,
      contextChange: { verdict: 'undetermined', reason: 'walk-error' } as NonNullable<AgentResult['contextChange']>,
    }

    const output = formatAgentResult(result)

    expect(output).toContain('Keyboard trap (WCAG 2.1.2): fail')
    expect(output).toContain('Change of context on focus (WCAG 3.2.1): undetermined (walk-error)')
  })

  it('prints no keyboard lines when checkKeyboard never ran', () => {
    const result: AgentResult = {
      success: true,
      goal: 'Check the page',
      steps: [],
      violations: [],
      summary: 'Done',
      keyboard: null,
      contextChange: null,
    }

    expect(formatAgentResult(result)).not.toContain('WCAG')
  })
})
