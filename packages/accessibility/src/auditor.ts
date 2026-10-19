import type { BrowserPage } from '@at-agent/browser'
import { runAxe } from './axe.js'
import type { AuditResult, AuditOptions, Impact } from './types.js'

export interface AuditSummary {
  totalViolations: number
  totalPasses: number
  byImpact: Record<Impact, number>
}

export class Auditor {
  async audit(page: BrowserPage, options?: AuditOptions): Promise<AuditResult> {
    const axeResult = await runAxe(page, options)

    return {
      url: await page.url(),
      timestamp: new Date().toISOString(),
      violations: axeResult.violations,
      passes: axeResult.passes,
      incomplete: axeResult.incomplete,
    }
  }

  getSummary(result: AuditResult): AuditSummary {
    const byImpact: Record<Impact, number> = {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    }

    for (const v of result.violations) {
      byImpact[v.impact]++
    }

    return {
      totalViolations: result.violations.length,
      totalPasses: result.passes.length,
      byImpact,
    }
  }
}
