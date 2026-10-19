import { describe, it, expect, vi, beforeEach } from 'vitest'
import { crawlPageWithGapDetection } from '@at-agent/accessibility'
import { runGaps, GapsCommandOptions } from './gaps.js'

// Mock the browser and accessibility packages
vi.mock('@at-agent/browser', () => ({
  BrowserClient: vi.fn().mockImplementation(() => ({
    launch: vi.fn(),
    close: vi.fn(),
    newPage: vi.fn().mockResolvedValue({
      playwrightPage: { marker: 'playwright-page' },
      close: vi.fn(),
    }),
  })),
}))

vi.mock('@at-agent/accessibility', () => ({
  crawlPageWithGapDetection: vi.fn().mockResolvedValue({
    pageUrl: 'https://example.com',
    accessibilityTree: { elements: new Map() },
    domElements: [],
    hidden: [],
    bridgeMap: new Map(),
    errors: [],
    keyboard: {
      walkRan: true,
      notFocusableAssessed: true,
      unassessedReasons: [],
      walkError: null,
      reachedBackendNodeIds: [7],
    },
    gaps: [
      {
        domElement: {
          nodeId: 1,
          backendNodeId: 2,
          nodeName: 'DIV',
          localName: 'div',
          attributes: { class: 'btn' },
          boundingBox: null,
          pageUrl: 'https://example.com',
        },
        signals: {
          hasClickHandler: true,
          hasCursorPointer: false,
          isSemanticInteractive: false,
          hasTabindex: false,
          tabindexValue: null,
          hasRoleAttribute: false,
          roleValue: null,
          hasAriaExpanded: false,
          classNameHints: ['btn'],
        },
        gapType: 'missing_from_a11y_tree',
        severity: 'critical',
        wcagViolations: ['4.1.2'],
        suggestedFix: 'Use a button.',
        evidence: 'DIV element with interactivity signals is not exposed in the accessibility tree',
      },
    ],
  }),
  summarizeGaps: vi.fn().mockReturnValue({
    total: 1,
    byType: {
      missing_from_a11y_tree: 1,
      no_accessible_name: 0,
      wrong_role: 0,
      not_focusable: 0,
      hidden_but_interactive: 0,
    },
    bySeverity: { critical: 1, serious: 0, moderate: 0, minor: 0 },
  }),
  getElementDescription: vi.fn().mockReturnValue('<div> class="btn"'),
}))

describe('runGaps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs gap detection on the url and returns gaps with a summary', async () => {
    const options: GapsCommandOptions = {
      url: 'https://example.com',
      json: false,
    }

    const result = await runGaps(options)

    expect(result.success).toBe(true)
    expect(crawlPageWithGapDetection).toHaveBeenCalledWith({ marker: 'playwright-page' }, 'https://example.com', {
      tabWalk: true,
    })
    expect(result.gaps).toHaveLength(1)
    expect(result.summary?.bySeverity.critical).toBe(1)
  })

  it('returns JSON output with url, summary and gaps when requested', async () => {
    const options: GapsCommandOptions = {
      url: 'https://example.com',
      json: true,
    }

    const result = await runGaps(options)

    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output!)
    expect(parsed.url).toBe('https://example.com')
    expect(parsed.summary.total).toBe(1)
    expect(parsed.gaps[0].gapType).toBe('missing_from_a11y_tree')
  })

  it('lists each gap with severity, element and evidence in text output', async () => {
    const result = await runGaps({ url: 'https://example.com' })

    expect(result.output).toContain('1 gaps found')
    expect(result.output).toContain('[CRITICAL] missing_from_a11y_tree')
    expect(result.output).toContain('<div> class="btn"')
    expect(result.output).toContain('DIV element with interactivity signals is not exposed in the accessibility tree')
  })

  it('says in text and JSON output when not_focusable was not assessed, and why (F3)', async () => {
    const detected = await crawlPageWithGapDetection(
      {} as Parameters<typeof crawlPageWithGapDetection>[0],
      'https://example.com',
    )
    const unassessed = {
      ...detected,
      keyboard: {
        walkRan: true,
        notFocusableAssessed: false,
        unassessedReasons: ['no-wrap' as const],
        walkError: null,
        reachedBackendNodeIds: [],
      },
    }
    vi.mocked(crawlPageWithGapDetection).mockResolvedValueOnce(unassessed).mockResolvedValueOnce(unassessed)

    const text = await runGaps({ url: 'https://example.com' })
    expect(text.output).toContain('not_focusable not assessed: no-wrap')

    const json = await runGaps({ url: 'https://example.com', json: true })
    expect(JSON.parse(json.output!).keyboard).toEqual({
      notFocusableAssessed: false,
      unassessedReasons: ['no-wrap'],
      walkError: null,
    })
  })

  // A failed read loses signals, for one element or, in a discover-* stage, for every handler-only
  // element, so gaps can silently be missing or wrong.
  it('reports failed page reads in text and JSON output', async () => {
    const detected = await crawlPageWithGapDetection(
      {} as Parameters<typeof crawlPageWithGapDetection>[0],
      'https://example.com',
    )
    const partial = {
      ...detected,
      errors: [
        { stage: 'listeners' as const, backendNodeId: 5, message: 'No node with given id found' },
        { stage: 'listeners' as const, backendNodeId: 6, message: 'No node with given id found' },
        { stage: 'cursor' as const, backendNodeId: 7, message: 'Target closed' },
        { stage: 'tab-walk' as const, backendNodeId: null, message: 'walk failed' },
      ],
      // A recorded tab-walk error always comes with not_focusable unassessed (gaps/detect.ts).
      keyboard: {
        ...detected.keyboard,
        notFocusableAssessed: false,
        unassessedReasons: ['walk-error' as const],
        walkError: 'walk failed',
      },
    }
    vi.mocked(crawlPageWithGapDetection).mockResolvedValueOnce(partial).mockResolvedValueOnce(partial)

    const text = await runGaps({ url: 'https://example.com' })
    expect(text.output).toContain('3 page reads failed (listeners ×2, cursor ×1); some gaps may be missing or wrong')
    // The tab-walk failure is reported once, by the not_focusable line; JSON keeps every error.
    expect(text.output).toContain('not_focusable not assessed: walk-error (walk failed)')

    const json = await runGaps({ url: 'https://example.com', json: true })
    expect(JSON.parse(json.output!).errors).toEqual(partial.errors)
  })

  it('names a single failed read in the singular', async () => {
    const detected = await crawlPageWithGapDetection(
      {} as Parameters<typeof crawlPageWithGapDetection>[0],
      'https://example.com',
    )
    vi.mocked(crawlPageWithGapDetection).mockResolvedValueOnce({
      ...detected,
      errors: [{ stage: 'cursor' as const, backendNodeId: 7, message: 'Target closed' }],
    })

    const text = await runGaps({ url: 'https://example.com' })
    expect(text.output).toContain('Incomplete: 1 page read failed (cursor ×1)')
  })

  it('returns the error when detection fails', async () => {
    vi.mocked(crawlPageWithGapDetection).mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))

    const result = await runGaps({ url: 'http://127.0.0.1:9' })

    expect(result.success).toBe(false)
    expect(result.error).toBe('net::ERR_CONNECTION_REFUSED')
  })
})
