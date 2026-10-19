import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright'
import { z } from 'zod'
import { failOnCrash } from '../renderer-crash.js'
import { runTabWalk, TabWalkOptionsSchema } from '../tab-walk.js'
import { convertToElementGraph, getAccessibilityTree } from './ax-tree.js'
import {
  anyDetached,
  collectFocusFacts,
  collectInteractivitySignals,
  crawlDOM,
  findHiddenCandidates,
} from './dom-crawler.js'
import { buildBridgeMap, detectGaps } from './gap-detector.js'
import { groupReach, keyboardEvidence, NO_WALK, walkFailed } from './keyboard.js'
import type {
  CrawlError,
  DOMElement,
  DualCrawlResult,
  FocusFacts,
  KeyboardEvidence,
  KeyboardUnassessedReason,
} from './types.js'

const NAVIGATION_TIMEOUT_MS = 60000
// Same fixed settle time taskgen uses to let dynamic content load.
const SETTLE_MS = 3000
// Window property marking the crawled document; a reload or a navigation leaves a window without it.
const CRAWL_MARKER = '__atAgentGapCrawl'

export const GapDetectionOptionsSchema = z.object({
  // Tab walk after the crawl, on the same load (true = runTabWalk defaults). Without it not_focusable is never emitted.
  tabWalk: z.union([z.boolean(), TabWalkOptionsSchema]).optional(),
})
export type GapDetectionOptions = z.input<typeof GapDetectionOptionsSchema>

// Port of taskgen ElementCrawler.crawlPageWithGapDetection on a caller-owned page (taskgen opened its own context).
export async function crawlPageWithGapDetection(
  page: Page,
  url: string,
  options: GapDetectionOptions = {},
): Promise<DualCrawlResult> {
  return failOnCrash(page, () => crawlAndWalk(page, url, options))
}

async function crawlAndWalk(page: Page, url: string, options: GapDetectionOptions): Promise<DualCrawlResult> {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  })
  await page.waitForTimeout(SETTLE_MS)

  // Checked after the walk (acc-gaps#1), so the walk counts only if it ran on the window crawled here. A navigation
  // during the write leaves the new window unmarked, so the check refuses the walk; a closed page still throws. Only
  // an explicit false or a throw caught in the page is the page refusing the mark (a wrapper may return nothing); a
  // promise the page returns is awaited, so a reload while it is pending still reads as a navigation.
  const token = randomUUID()
  const written = await page
    .evaluate(
      ([k, v]) => {
        try {
          return Reflect.set(window, k, v)
        } catch {
          return false
        }
      },
      [CRAWL_MARKER, token],
    )
    .catch((err: unknown) => {
      if (page.isClosed()) throw err
      return null
    })

  const crawl = await crawlDOM(page, url)
  const domElements = crawl.elements
  // Read after the enumeration, so every candidate existed when the tree was read (acc-gaps#6). One removed since has
  // no box, and findHiddenCandidates drops it instead of it reading as missing from the tree.
  const axNodes = await getAccessibilityTree(page)
  const accessibilityTree = convertToElementGraph(axNodes, url, await page.title())
  const visibility = await findHiddenCandidates(page, domElements)
  // A zero-area element may still be a Tab stop (G1b), so it is read like the rest until the walk has run.
  const unrendered = new Set(visibility.hidden.filter((h) => h.reason !== 'zero-area').map((h) => h.backendNodeId))
  const crawled = domElements.filter((e) => !unrendered.has(e.backendNodeId))
  const { signals, errors: signalErrors } = await collectInteractivitySignals(page, crawled)
  const { facts: crawledFocus, errors: focusErrors } = await collectFocusFacts(page, crawled)
  // G1c: a container's keydown handler serves its members whatever the container's own box, so an unrendered
  // (display:contents) container a member names is read too, and a hidden one keeps its facts below.
  const widgetIds = new Set(
    [...crawledFocus.values()].flatMap((f) => (f.compositeWidget === null ? [] : [f.compositeWidget])),
  )
  const unrenderedWidgets = domElements.filter((e) => unrendered.has(e.backendNodeId) && widgetIds.has(e.backendNodeId))
  const { facts: widgetFocus, errors: widgetErrors } = await collectFocusFacts(page, unrenderedWidgets)

  // After the crawl: the walk moves focus and may open or navigate, which must not change what was crawled.
  const walked = await walkKeyboard(page, options.tabWalk)
  // A crawled node removed before its box was read has none, so the no-box ones are checked with the rendered ones.
  const noBox = new Set(visibility.hidden.filter((h) => h.reason === 'no-box').map((h) => h.backendNodeId))
  const checked = [...crawled, ...domElements.filter((e) => noBox.has(e.backendNodeId))]
  const keyboard = await checkWalkedDocument(page, {
    keyboard: walked.keyboard,
    token: written === false ? null : token,
    crawled: checked,
  })

  // G1c: a zero-area element stays a candidate only as a Tab stop. A complete walk decides by where Tab went alone;
  // after none, or an incomplete one, the DOM's focusability rules read before it count too.
  const reached = new Set(keyboard.reachedBackendNodeIds)
  const walkDecides = keyboard.notFocusableAssessed
  const tabStop = (id: number): boolean => reached.has(id) || (!walkDecides && crawledFocus.get(id)?.focusable === true)
  const hidden = visibility.hidden.filter((h) => !(h.reason === 'zero-area' && tabStop(h.backendNodeId)))
  const hiddenIds = new Set(hidden.map((h) => h.backendNodeId))
  const candidates = domElements.filter((e) => !hiddenIds.has(e.backendNodeId))
  // A hidden container is no Tab stop, so its keydown handler fires only for its own members: it keeps its facts as a
  // widget, never as a member of an outer one.
  const focus = new Map(
    [...crawledFocus, ...widgetFocus].flatMap(([id, f]): Array<[number, FocusFacts]> =>
      !hiddenIds.has(id) ? [[id, f]] : widgetIds.has(id) ? [[id, { ...f, compositeWidget: null }]] : [],
    ),
  )

  const bridgeMap = buildBridgeMap(accessibilityTree)
  const gaps = detectGaps(candidates, accessibilityTree, signals, { keyboard, focus })

  return {
    pageUrl: url,
    accessibilityTree,
    domElements,
    hidden,
    gaps,
    bridgeMap,
    keyboard,
    reachedByGroup: groupReach(keyboard.reachedBackendNodeIds, focus),
    errors: [...crawl.errors, ...visibility.errors, ...signalErrors, ...focusErrors, ...widgetErrors, ...walked.errors],
  }
}

// acc-gaps#1: the walk describes the crawled nodes only if it ran on them. It did not when the crawled window was
// replaced (its marker is gone), or when crawled nodes it never reached have left the document (a same-window
// re-mount, a toast the page removed). A window the page refused to mark (no token) cannot be checked, so it is
// refused too. A replacement the walk saw is already listed; a closed page keeps its walk-error, and one that closes
// during this check throws. Nothing is read before the walk, so a change during the crawl is caught here too.
async function checkWalkedDocument(
  page: Page,
  walk: { keyboard: KeyboardEvidence; token: string | null; crawled: readonly DOMElement[] },
): Promise<KeyboardEvidence> {
  const { keyboard } = walk
  if (!keyboard.walkRan || keyboard.unassessedReasons.includes('document-replaced') || page.isClosed()) return keyboard
  const reached = new Set(keyboard.reachedBackendNodeIds)
  const unreached = walk.crawled.filter((e) => !reached.has(e.backendNodeId))
  const reason: KeyboardUnassessedReason | null =
    walk.token === null
      ? 'crawl-mark-failed'
      : !(await crawlMarked(page, walk.token))
        ? 'document-replaced'
        : (await anyDetached(page, unreached))
          ? 'crawled-nodes-detached'
          : null
  if (reason === null) return keyboard
  return { ...keyboard, notFocusableAssessed: false, unassessedReasons: [...keyboard.unassessedReasons, reason] }
}

// A read that fails on an open page means a navigation destroyed its context; on a closed page it proves nothing.
async function crawlMarked(page: Page, token: string): Promise<boolean> {
  return page
    .evaluate(([k, v]) => Reflect.get(window, k) === v, [CRAWL_MARKER, token])
    .catch((err: unknown) => {
      if (page.isClosed()) throw err
      return false
    })
}

async function walkKeyboard(
  page: Page,
  tabWalk: GapDetectionOptions['tabWalk'],
): Promise<{ keyboard: KeyboardEvidence; errors: CrawlError[] }> {
  if (!tabWalk) return { keyboard: NO_WALK, errors: [] }
  try {
    // The escape probe only grades traps; its extra Escape and Shift+Tab presses add nothing here.
    const walk = await runTabWalk(page, { escapeProbe: false, ...(tabWalk === true ? {} : tabWalk) })
    const errors: CrawlError[] = walk.error
      ? [{ stage: 'tab-walk', backendNodeId: null, message: walk.error.message }]
      : []
    return { keyboard: keyboardEvidence(walk), errors }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]
    return { keyboard: walkFailed(message), errors: [{ stage: 'tab-walk', backendNodeId: null, message }] }
  }
}
