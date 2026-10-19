import { BrowserClient } from '@at-agent/browser'
import {
  crawlPageWithGapDetection,
  getElementDescription,
  summarizeGaps,
  type AccessibilityGap,
  type DualCrawlResult,
  type GapSummary,
} from '@at-agent/accessibility'
import { formatJSON } from '../output.js'

export interface GapsCommandOptions {
  url: string
  json?: boolean
}

export interface GapsCommandResult {
  success: boolean
  gaps?: AccessibilityGap[]
  summary?: GapSummary
  output?: string
  error?: string
}

export async function runGaps(options: GapsCommandOptions): Promise<GapsCommandResult> {
  const browser = new BrowserClient()

  try {
    await browser.launch()
    const page = await browser.newPage()

    try {
      // The detector navigates itself (domcontentloaded + fixed settle), so no page.goto here.
      // The Tab walk on the same load is the only source of not_focusable.
      const result = await crawlPageWithGapDetection(page.playwrightPage, options.url, {
        tabWalk: true,
      })
      const summary = summarizeGaps(result.gaps)
      const { notFocusableAssessed, unassessedReasons, walkError } = result.keyboard

      if (options.json) {
        return {
          success: true,
          gaps: result.gaps,
          summary,
          output: formatJSON({
            url: result.pageUrl,
            summary,
            keyboard: { notFocusableAssessed, unassessedReasons, walkError },
            errors: result.errors,
            gaps: result.gaps,
          }),
        }
      }

      return {
        success: true,
        gaps: result.gaps,
        summary,
        output: formatGapReport(summary, result.gaps, result.keyboard, result.errors),
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

function formatGapReport(
  summary: GapSummary,
  gaps: readonly AccessibilityGap[],
  keyboard: DualCrawlResult['keyboard'],
  errors: DualCrawlResult['errors'],
): string {
  const lines = [
    `Accessibility Gap Detection Results`,
    `-----------------------------------`,
    `${summary.total} gaps found`,
    `  Critical: ${summary.bySeverity.critical}`,
    `  Serious: ${summary.bySeverity.serious}`,
    `  Moderate: ${summary.bySeverity.moderate}`,
    `  Minor: ${summary.bySeverity.minor}`,
  ]

  // A zero not_focusable count means nothing unless the Tab walk could assess it.
  if (!keyboard.notFocusableAssessed) {
    const why = keyboard.unassessedReasons.join(', ')
    lines.push(`not_focusable not assessed: ${why}${keyboard.walkError ? ` (${keyboard.walkError})` : ''}`)
  }

  // A failed read loses signals, for one element or, in a discover-* stage, for every handler-only
  // element: a lost listener or cursor hides a gap, a lost visibility or focus fact can invent one.
  // tab-walk is reported above, by the not_focusable line.
  const unreported = errors.filter((error) => error.stage !== 'tab-walk')
  if (unreported.length > 0) {
    const byStage = new Map<string, number>()
    for (const error of unreported) byStage.set(error.stage, (byStage.get(error.stage) ?? 0) + 1)
    const stages = [...byStage].map(([stage, n]) => `${stage} \u00d7${n}`).join(', ')
    const reads = unreported.length === 1 ? 'page read' : 'page reads'
    lines.push(`Incomplete: ${unreported.length} ${reads} failed (${stages}); some gaps may be missing or wrong`)
  }

  if (gaps.length > 0) {
    lines.push('', 'Gaps:', '')
    for (const gap of gaps) {
      lines.push(
        `[${gap.severity.toUpperCase()}] ${gap.gapType}`,
        `  ${getElementDescription(gap.domElement)}`,
        `  ${gap.evidence}`,
        `  WCAG: ${gap.wcagViolations.join(', ')}`,
        '',
      )
    }
  }

  return lines.join('\n')
}
