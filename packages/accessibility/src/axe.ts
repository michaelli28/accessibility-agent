import type { BrowserPage } from '@at-agent/browser'
import type { Page } from 'playwright'
import type { AxeResults, Result, NodeResult } from 'axe-core'
import type { Violation, PassedRule } from './types.js'

// Axe-core source will be injected into the page
import axeCore from 'axe-core'

export interface AxeResult {
  violations: Violation[]
  passes: PassedRule[]
  incomplete: Array<{ id: string; description: string }>
}

// Type for accessing internal playwright page from BrowserPage
interface BrowserPageInternal {
  page: Page
}

export async function runAxe(
  page: BrowserPage,
  options?: { rules?: string[]; tags?: string[] }
): Promise<AxeResult> {
  // Get the underlying Playwright page to inject axe
  // BrowserPage wraps a Playwright Page internally
  const playwrightPage = (page as unknown as BrowserPageInternal).page

  // Inject axe-core
  await playwrightPage.evaluate(axeCore.source)

  // Run axe
  const axeOptions: Record<string, unknown> = {}
  if (options?.rules) {
    axeOptions.runOnly = { type: 'rule', values: options.rules }
  }
  if (options?.tags) {
    axeOptions.runOnly = { type: 'tag', values: options.tags }
  }

  const results: AxeResults = await playwrightPage.evaluate(
    (opts: Record<string, unknown>) => {
      return (window as unknown as { axe: { run: (context: Document | Element, opts: unknown) => Promise<AxeResults> } }).axe.run(document, opts)
    },
    axeOptions
  )

  return {
    violations: results.violations.map((v: Result) => ({
      id: v.id,
      impact: v.impact as Violation['impact'],
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      wcagTags: v.tags.filter((t: string) => t.startsWith('wcag')),
      nodes: v.nodes.map((n: NodeResult) => ({
        html: n.html,
        target: n.target as string[],
        failureSummary: n.failureSummary ?? null,
      })),
    })),
    passes: results.passes.map((p: Result) => ({
      id: p.id,
      description: p.description,
      nodeCount: p.nodes.length,
    })),
    incomplete: results.incomplete.map((i: Result) => ({
      id: i.id,
      description: i.description,
    })),
  }
}
