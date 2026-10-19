import type { Violation, AuditSummary } from '@at-agent/accessibility'
import type { AgentResult } from '@at-agent/agent'

export function formatViolation(violation: Violation): string {
  const lines = [
    `[${violation.impact.toUpperCase()}] ${violation.id}`,
    `  ${violation.help}`,
    `  WCAG: ${violation.wcagTags.join(', ')}`,
    `  Affected: ${violation.nodes.length} element(s)`,
  ]

  for (const node of violation.nodes.slice(0, 3)) {
    lines.push(`    - ${node.target.join(' > ')}`)
    if (node.failureSummary) {
      lines.push(`      ${node.failureSummary}`)
    }
  }

  if (violation.nodes.length > 3) {
    lines.push(`    ... and ${violation.nodes.length - 3} more`)
  }

  return lines.join('\n')
}

export function formatAuditSummary(summary: AuditSummary): string {
  return [
    `Accessibility Audit Results`,
    `---------------------------`,
    `${summary.totalViolations} violations found`,
    `  Critical: ${summary.byImpact.critical}`,
    `  Serious: ${summary.byImpact.serious}`,
    `  Moderate: ${summary.byImpact.moderate}`,
    `  Minor: ${summary.byImpact.minor}`,
    `${summary.totalPasses} rules passed`,
  ].join('\n')
}

export function formatAgentResult(result: AgentResult): string {
  const status = result.success ? 'Success' : 'Failed'
  const stepCount = result.steps.length
  const violationCount = result.violations.length

  const lines = [
    `Agent Result: ${status}`,
    `---------------------------`,
    `Goal: ${result.goal}`,
    `Steps: ${stepCount} step${stepCount !== 1 ? 's' : ''}`,
    `Violations: ${violationCount}`,
  ]

  // Only when the agent ran checkKeyboard; axe's count above never includes these.
  if (result.keyboard) {
    lines.push(`Keyboard trap (WCAG 2.1.2): ${withReason(result.keyboard)}`)
  }
  if (result.contextChange) {
    lines.push(`Change of context on focus (WCAG 3.2.1): ${withReason(result.contextChange)}`)
  }

  lines.push(``, `Summary: ${result.summary}`)

  if (result.steps.length > 0) {
    lines.push(``, `Steps taken:`)
    for (const step of result.steps) {
      lines.push(`  ${step.stepNumber}. ${step.action.type}: ${step.action.reason}`)
    }
  }

  return lines.join('\n')
}

function withReason(result: { verdict: string; reason: string | null }): string {
  return result.reason === null ? result.verdict : `${result.verdict} (${result.reason})`
}

export function formatJSON<T>(data: T): string {
  return JSON.stringify(data, null, 2)
}
