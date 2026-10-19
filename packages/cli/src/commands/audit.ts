import { BrowserClient } from '@at-agent/browser'
import { Auditor, type AuditResult } from '@at-agent/accessibility'
import { formatAuditSummary, formatViolation, formatJSON } from '../output.js'
import type { AuditSummary } from '@at-agent/accessibility'

export interface AuditCommandOptions {
  url: string
  json?: boolean
  tags?: string[]
}

export interface AuditCommandResult {
  success: boolean
  auditResult?: AuditResult
  summary?: AuditSummary
  output?: string
  error?: string
}

export async function runAudit(options: AuditCommandOptions): Promise<AuditCommandResult> {
  const browser = new BrowserClient()

  try {
    await browser.launch()
    const page = await browser.newPage()

    try {
      await page.goto(options.url)

      const auditor = new Auditor()
      const auditResult = await auditor.audit(page, {
        tags: options.tags,
      })
      const summary = auditor.getSummary(auditResult)

      if (options.json) {
        return {
          success: true,
          auditResult,
          summary,
          output: formatJSON({ auditResult, summary }),
        }
      }

      // Format text output
      const lines = [formatAuditSummary(summary)]

      if (auditResult.violations.length > 0) {
        lines.push('', 'Violations:', '')
        for (const violation of auditResult.violations) {
          lines.push(formatViolation(violation), '')
        }
      }

      return {
        success: true,
        auditResult,
        summary,
        output: lines.join('\n'),
      }
    } finally {
      await page.close()
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  } finally {
    await browser.close()
  }
}
