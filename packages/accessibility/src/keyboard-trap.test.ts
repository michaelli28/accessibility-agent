import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, it, expect } from 'vitest'
import {
  TabWalkResultSchema,
  collapseStops,
  groupStops,
  type EscapeProbe,
  type FocusRead,
  type TabWalkResult,
  type TabWalkStep,
} from './tab-walk.js'
import { endOfPage, judgeKeyboardTrap } from './keyboard-trap.js'

// Dev material only (never bench/corpus/test or bench/results/*/test-*): the committed recorded walks.
const RECORDS = join(dirname(fileURLToPath(import.meta.url)), '../../../bench/results/cd3b122')

// bench/ sits outside this package's tsconfig rootDir, and `tsc` compiles src/**/*.test.ts, so a
// static import of the frozen baseline would break `npm run build -w @at-agent/accessibility`.
// The specifier is built at runtime so TypeScript never pulls bench/ into this program.
type ReplayLegacy = (steps: ReadonlyArray<{ index: number; immediate: FocusRead }>) => {
  trap: { firstTrappedPress: number | null }
}

async function loadReplayLegacy(): Promise<ReplayLegacy> {
  const href = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../../bench/legacy.ts')).href
  const mod = (await import(href)) as { replayLegacy: ReplayLegacy }
  return mod.replayLegacy
}

// The records predate two schema fields that the trap judge never reads: DeepFocus.classAttr and
// TabWalkStep.indicator. Backfilling them with null is what makes the recording parse; it cannot move
// a verdict, because no clause of the judge looks at either field.
function backfill(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(backfill)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = backfill(v)
  if ('backendNodeId' in out && 'tag' in out && 'isBody' in out && !('classAttr' in out)) out.classAttr = null
  if ('index' in out && 'immediate' in out && 'settled' in out && !('indicator' in out)) out.indicator = null
  return out
}

function recorded(set: 'dev-fixtures' | 'dev-variants', page: string): TabWalkResult {
  const raw = JSON.parse(gunzipSync(readFileSync(join(RECORDS, set, 'raw', `${page}.json.gz`))).toString('utf8'))
  return TabWalkResultSchema.parse(backfill(raw.walk))
}

const EMPTY_READ: FocusRead = {
  backendNodeId: null,
  tag: null,
  id: null,
  className: null,
  ariaLabel: null,
  nameAttr: null,
  nameProp: null,
  text: null,
  isBody: false,
  hasFocus: false,
  url: 'http://localhost/p',
  container: null,
  deep: null,
  deepUnavailable: null,
  part: null,
}

function elementRead(backendNodeId: number, tag = 'a', id: string | null = null): FocusRead {
  return {
    ...EMPTY_READ,
    backendNodeId,
    tag,
    id,
    hasFocus: true,
    deep: { backendNodeId, tag, id, isBody: false, classAttr: null },
  }
}

function bodyRead(hasFocus: boolean): FocusRead {
  return {
    ...EMPTY_READ,
    backendNodeId: 9,
    tag: 'body',
    id: null,
    isBody: true,
    hasFocus,
    deep: {
      backendNodeId: 9,
      tag: 'body',
      id: null,
      isBody: true,
      classAttr: null,
    },
  }
}

function synthStep(index: number, settled: FocusRead, over: Partial<TabWalkStep> = {}): TabWalkStep {
  return {
    index,
    key: 'Tab',
    immediate: settled,
    settled,
    focusStyle: null,
    documentReplaced: false,
    wrapped: false,
    focusLost: false,
    indicator: null,
    ...over,
  }
}

// Escape and every Shift+Tab stay inside `region`: a probe that got nowhere.
function confinedProbe(region: number[]): EscapeProbe {
  const last = elementRead(region[region.length - 1])
  return {
    probeKey: 'Shift+Tab',
    seenBackendNodeIds: region,
    before: last,
    escape: { after: last, documentReplaced: false, urlChanged: false, unseenElement: false, wrapped: false },
    maxPresses: 5,
    steps: [1, 2, 3, 4, 5].map((index) => ({
      index,
      key: 'Shift+Tab' as const,
      // Shift+Tab walks the region backwards from its last member, wrapping inside it.
      settled: elementRead(region[(((region.length - 1 - index) % region.length) + region.length) % region.length]),
      documentReplaced: false,
      unseenElement: false,
      wrapped: false,
    })),
    reachedAt: null,
  }
}

function synthWalk(steps: TabWalkStep[], over: Partial<TabWalkResult> = {}): TabWalkResult {
  return {
    direction: 'forward',
    focusableCount: 3,
    fIncomplete: false,
    fIncompleteCauses: { crossOriginFrames: 0, closedShadowRoots: 0 },
    defaultPresses: steps.length,
    presses: steps.length,
    settleMs: 150,
    launchFacts: { browserVersion: null, executableBasename: null },
    initial: bodyRead(true),
    idle: null,
    focusableCountEnd: null,
    steps,
    suspectedTrap: steps.some((s) => s.wrapped) ? false : true,
    escapeProbe: null,
    error: null,
    ...over,
  }
}

// Walks written as press ids: WRAP is a press that wrapped to the unfocused body, any other id a real stop.
// Their reads have part null, as in a walk that reads no parts, so each press is its own stop.
const WRAP = 0

const repeat = (id: number, n: number): number[] => Array<number>(n).fill(id)

// `n` presses around `lap`, starting `offset` presses into it.
const around = (lap: readonly number[], n: number, offset = 0): number[] =>
  Array.from({ length: n }, (_, i) => lap[(i + offset) % lap.length])

const fresh = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i)

// A full-length walk with F counted stops, as runTabWalk records it.
function fullWalk(focusableCount: number, ids: readonly number[], escapeProbe: EscapeProbe | null): TabWalkResult {
  const steps = ids.map((id, i) =>
    id === WRAP ? synthStep(i + 1, bodyRead(false), { wrapped: true }) : synthStep(i + 1, elementRead(id)),
  )
  return synthWalk(steps, { focusableCount, focusableCountEnd: focusableCount, escapeProbe })
}

// The probe runTabWalk runs after `ids`: its seen set is the last F+1 stops; Escape stays on the last stop
// unless `escape` says otherwise; Shift+Tab then follows `path` (WRAP = a wrap) and stops at the first unseen
// element or wrap.
function probeAfter(
  ids: readonly number[],
  focusableCount: number,
  path: readonly number[],
  escape: Partial<EscapeProbe['escape']> = {},
): EscapeProbe {
  const seen = [...new Set(ids.slice(-(focusableCount + 1)).filter((id) => id !== WRAP))]
  const last = elementRead(ids[ids.length - 1])
  const stayed = { after: last, documentReplaced: false, urlChanged: false, unseenElement: false, wrapped: false }
  const steps: EscapeProbe['steps'] = []
  let reachedAt: number | null = null
  for (const [i, id] of path.entries()) {
    const unseenElement = id !== WRAP && !seen.includes(id)
    steps.push({
      index: i + 1,
      key: 'Shift+Tab',
      settled: id === WRAP ? bodyRead(false) : elementRead(id),
      documentReplaced: false,
      unseenElement,
      wrapped: id === WRAP,
    })
    if (unseenElement || id === WRAP) {
      reachedAt = i + 1
      break
    }
  }
  return {
    probeKey: 'Shift+Tab',
    seenBackendNodeIds: seen,
    before: last,
    escape: { ...stayed, ...escape },
    maxPresses: focusableCount + 2,
    steps,
    reachedAt,
  }
}

// A probe that got nowhere, or none when the last F+1 stops wrapped (runTabWalk's gate): the worst case for a
// clean walk that reaches the probe.
function stuckProbe(ids: readonly number[], focusableCount: number): EscapeProbe | null {
  if (ids.slice(-(focusableCount + 1)).includes(WRAP)) return null
  return probeAfter(ids, focusableCount, repeat(ids[ids.length - 1], focusableCount + 2))
}

// A press on element `id` whose focused part inside the element's browser-built inner tree is `part`.
function partStep(index: number, id: number, part: number | null, over: Partial<TabWalkStep> = {}): TabWalkStep {
  return synthStep(index, { ...elementRead(id), part }, over)
}

// Presses on one element, one per part.
const onParts = (id: number, parts: readonly (number | null)[], from = 1): TabWalkStep[] =>
  parts.map((part, i) => partStep(from + i, id, part))

const stopLengths = (steps: readonly TabWalkStep[]): number[] => groupStops(steps).map((stop) => stop.length)

describe('groupStops and collapseStops (hand-built walks)', () => {
  it('a repeated part starts a new stop: a swallowed Tab on a date input', () => {
    expect(stopLengths(onParts(11, [101, 102, 102, 103]))).toEqual([2, 2])
  })

  it('a repeated null starts a new stop: a button pressed twice is two stops', () => {
    expect(stopLengths(onParts(11, [null, null]))).toEqual([1, 1])
  })

  it('a first null after parts continues the stop: backward audio 47, 39, 4, 25, null is one stop', () => {
    expect(stopLengths(onParts(11, [47, 39, 4, 25, null]))).toEqual([5])
  })

  it('another element starts a new stop', () => {
    expect(stopLengths([partStep(1, 11, 101), partStep(2, 12, 102)])).toEqual([1, 1])
  })

  it('a wrap never joins a stop', () => {
    const wrap = (index: number): TabWalkStep => synthStep(index, bodyRead(false), { wrapped: true })
    expect(stopLengths([partStep(1, 11, 101), wrap(2), wrap(3), partStep(4, 11, 102)])).toEqual([1, 1, 1, 1])
  })

  it('a replaced document starts a new stop', () => {
    expect(stopLengths([partStep(1, 11, 101), partStep(2, 11, 102, { documentReplaced: true })])).toEqual([1, 1])
  })

  it('a stop holds at most 10 presses', () => {
    expect(stopLengths(onParts(11, fresh(101, 12)))).toEqual([10, 2])
  })

  it('collapseStops keeps the first press of each stop, and collapsing twice gives the same walk', () => {
    // [101, 102] and [102, 103] are two stops on one element: once collapsed, only the null part keeps them apart.
    const raw = synthWalk([...onParts(11, [101, 102, 102, 103]), ...onParts(12, fresh(201, 11), 5)])
    const once = collapseStops(raw)
    expect(once.steps.map((step) => step.index)).toEqual([1, 3, 5, 15])
    expect(once.steps.every((step) => step.settled.part === null)).toBe(true)
    expect(collapseStops(once)).toEqual(once)
  })

  it('endOfPage reads a raw walk in stops: two datetime-local inputs, F=2, 20 stops in 98 presses', () => {
    const start = fresh(101, 7)
    const end = fresh(201, 7)
    const steps: TabWalkStep[] = []
    const press = (id: number, part: number): void => void steps.push(partStep(steps.length + 1, id, part))
    for (let lap = 0; lap < 6; lap++) {
      for (const part of start) press(11, part)
      for (const part of end) press(12, part)
      steps.push(synthStep(steps.length + 1, bodyRead(false), { wrapped: true }))
    }
    for (const part of start) press(11, part)
    press(12, end[0])
    const raw = synthWalk(steps, { focusableCount: 2, focusableCountEnd: 2 })
    expect(raw.steps).toHaveLength(98)
    expect(collapseStops(raw).steps).toHaveLength(20)
    // Its last 3 presses sit on the two inputs, with no wrap; its last 3 stops hold one, and the end of the page is
    // reported at the first wrap, press 15.
    expect(endOfPage(raw)).toEqual({ signal: 'body-unfocused', atPress: 15 })
    expect(endOfPage(raw)).toEqual(endOfPage(collapseStops(raw)))
  })
})

describe('judgeKeyboardTrap', () => {
  // 1
  it('clean page: the wrap is the end of the page, not a cycle', () => {
    const walk = recorded('dev-fixtures', 'three-links')
    const result = judgeKeyboardTrap([walk])
    expect(result.verdict).toBe('pass')
    expect(result.keyboardTrap).toBe(false)
    expect(result.trapEscapable).toBeNull()
    expect(result.directions[0].endOfPage).toEqual({
      signal: 'body-unfocused',
      atPress: 4,
    })
    expect(endOfPage(walk)).toEqual({ signal: 'body-unfocused', atPress: 4 })
  })

  // 2
  it('the false alarm is gone while the frozen baseline still reproduces it', async () => {
    const replayLegacy = await loadReplayLegacy()
    const walk = recorded('dev-fixtures', 'three-links')
    // The frozen pre-fix checker on the very same recorded walk.
    expect(replayLegacy(walk.steps).trap.firstTrappedPress).toBe(20)
    expect(judgeKeyboardTrap([walk]).verdict).toBe('pass')
  })

  // 3 — its six presses are the first six of a script loop over every stop, so no judge can pass this walk and
  // fail that loop: with no wrap, a complete count is not the end of the page, and the walk is short.
  it('truncated walk that never wrapped: every counted stop visited is not the end of the page', () => {
    const ids = [11, 12, 13, 11, 12, 13]
    const walk = synthWalk(
      ids.map((id, i) => synthStep(i + 1, elementRead(id))),
      {
        focusableCount: 3,
        defaultPresses: 25,
        presses: 6,
        suspectedTrap: true,
      },
    )
    const result = judgeKeyboardTrap([walk])
    expect(result.verdict).toBe('undetermined')
    expect(result.reason).toBe('short-walk')
    expect(result.keyboardTrap).toBe(false)
    expect(result.directions[0].endOfPage).toBeNull()
  })

  // A trap the walk meets only after it has visited every counted stop: stuck on the last stop, cycling
  // on the last two (a dialog appended to <body> that does not take focus), or closing after one lap of
  // the page. The count is complete, which used to pass the page before the release probe that had
  // already failed was read. Every recorded M5 trap catches focus earlier, so no recorded walk is one.
  it('a Tab-swallow trap on the last stop is a trap, not the end of the page', () => {
    const ids = [11, 12, 13, ...Array<number>(22).fill(13)]
    const walk = synthWalk(
      ids.map((id, i) => synthStep(i + 1, elementRead(id))),
      { focusableCount: 3, suspectedTrap: true, escapeProbe: confinedProbe([13]) },
    )
    const result = judgeKeyboardTrap([walk])
    expect(result.verdict).toBe('fail')
    expect(result.directions[0].release).toBe('none')
    expect(result.directions[0].stuckOn?.backendNodeId).toBe(13)
  })

  it('a cyclic trap on the last two stops is a trap', () => {
    const ids = [11, 12, 13, 14, ...Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 13 : 14))]
    const walk = synthWalk(
      ids.map((id, i) => synthStep(i + 1, elementRead(id))),
      { focusableCount: 4, suspectedTrap: true, escapeProbe: confinedProbe([13, 14]) },
    )
    const result = judgeKeyboardTrap([walk])
    expect(result.verdict).toBe('fail')
    expect(result.directions[0].region).toEqual([13, 14])
  })

  it('a trap that closes after one lap of the page is a trap', () => {
    const lap = [11, 12, 13].map((id, i) => synthStep(i + 1, elementRead(id)))
    const wrap = synthStep(4, bodyRead(false), { wrapped: true })
    const stuck = [11, 12, ...Array<number>(19).fill(13)].map((id, i) => synthStep(i + 5, elementRead(id)))
    const walk = synthWalk([...lap, wrap, ...stuck], {
      focusableCount: 3,
      suspectedTrap: true,
      escapeProbe: confinedProbe([13]),
    })
    expect(judgeKeyboardTrap([walk]).verdict).toBe('fail')
  })

  // The case the count exists for. Unactivated new headless skips body on odd wraps
  // (bench/probes/wrap/RESULT.md:16), so a clean walk's last F+1 presses can hold no wrap and its
  // release probe may get nowhere; the count ends the page. A rule that deferred to the probe here, or
  // waited for the first stop's node to come back, would invent a trap.
  it('a clean page whose last F+1 presses hold no wrap still ends at all stops visited', () => {
    const cycle = [11, 12, 13, 11, 12, 13, 0]
    const steps = Array.from({ length: 25 }, (_, i) => {
      const id = cycle[i % cycle.length]
      return id === 0
        ? synthStep(i + 1, bodyRead(false), { wrapped: true })
        : synthStep(i + 1, elementRead(id))
    })
    const walk = synthWalk(steps, { focusableCount: 3, suspectedTrap: false, escapeProbe: confinedProbe([11, 12, 13]) })
    const result = judgeKeyboardTrap([walk])
    expect(result.verdict).toBe('pass')
    expect(result.directions[0].endOfPage).toEqual({ signal: 'all-stops-visited', atPress: 3 })
  })

  it('a clean page whose first stop is re-rendered mid-walk still ends at all stops visited', () => {
    // The same unactivated new-headless cycle, with 11 re-rendered as 21 after its first visit: the first
    // stop's node never comes back, but the last F+1 presses still reach every stop.
    const cycle = [11, 12, 13, 11, 12, 13, 0]
    const steps = Array.from({ length: 25 }, (_, i) => {
      const id = cycle[i % cycle.length]
      if (id === 0) return synthStep(i + 1, bodyRead(false), { wrapped: true })
      return synthStep(i + 1, elementRead(id === 11 && i > 0 ? 21 : id))
    })
    const walk = synthWalk(steps, { focusableCount: 3, suspectedTrap: false, escapeProbe: confinedProbe([21, 12, 13]) })
    const result = judgeKeyboardTrap([walk])
    expect(result.verdict).toBe('pass')
    expect(result.directions[0].endOfPage).toEqual({ signal: 'all-stops-visited', atPress: 3 })
  })

  // 4
  it('M5 Tab-swallow is a trap: Escape and Shift+Tab both fail', () => {
    const walk = recorded('dev-variants', 'three-links__M5__link-1')
    const result = judgeKeyboardTrap([walk])
    expect(result.verdict).toBe('fail')
    expect(result.keyboardTrap).toBe(true)
    expect(result.trapEscapable).toBe(false)
    expect(result.directions[0].release).toBe('none')
    expect(result.directions[0].confined).toBe(true)
    expect(result.directions[0].stuckOn?.backendNodeId).toBe(13)
    expect(result.directions[0].region).toEqual([13])
    expect(result.directions[0].focusableCount).toBe(3)
  })

  // 5
  it('a cyclic trap is not end-of-page: the M5 record returns to its first element on press 2', () => {
    const singleId = [
      'three-links__M5__link-1',
      'navbar__M5__brand',
      'identical-links__M5__read-more-01',
      'js-handlers__M5__custom-button',
    ]
    for (const page of singleId) {
      const walk = recorded('dev-variants', page)
      // The premise the deleted rule would have tripped on: press 2 is already back on press 1's element.
      expect(walk.steps[1].settled.deep?.backendNodeId).toBe(walk.steps[0].settled.deep?.backendNodeId)
      expect(endOfPage(walk)).toBeNull()
      expect(judgeKeyboardTrap([walk]).verdict).toBe('fail')
      expect(judgeKeyboardTrap([walk]).directions[0].endOfPage).toBeNull()
    }
  })

  // 6
  it('a correct modal is confined but escapable', () => {
    const walk = recorded('dev-fixtures', 'modal')
    const result = judgeKeyboardTrap([walk])
    expect(result.verdict).toBe('pass')
    expect(result.keyboardTrap).toBe(true)
    expect(result.trapEscapable).toBe(true)
    expect(result.directions[0].release).toBe('escape-key')
    expect(result.directions[0].region).toHaveLength(4)
    expect(result.directions[0].focusableCount).toBe(8)
  })

  // 7
  it('a region smaller than F is recorded, never a verdict input', () => {
    const navbar = recorded('dev-fixtures', 'navbar')
    const navbarResult = judgeKeyboardTrap([navbar])
    expect(navbar.focusableCount).toBe(12)
    expect(navbarResult.verdict).toBe('pass')
    expect(navbarResult.directions[0].endOfPage?.signal).toBe('body-unfocused')
    expect(navbarResult.directions[0].region.length).toBeLessThan(navbar.focusableCount)

    const modal = recorded('dev-fixtures', 'modal')
    const modalResult = judgeKeyboardTrap([modal])
    expect(modalResult.verdict).toBe('pass')
    expect(modalResult.directions[0].release).toBe('escape-key')
    expect(modalResult.directions[0].region.length).toBeLessThan(modal.focusableCount)
  })

  // 8
  it('undetermined never reads as a pass', () => {
    const stuck = (n: number) => Array.from({ length: n }, (_, i) => synthStep(i + 1, elementRead(11)))

    const walkError = synthWalk(stuck(3), {
      suspectedTrap: null,
      error: { phase: 'walk', index: 4, message: 'page closed' },
    })
    const incomplete = synthWalk(stuck(25), {
      fIncomplete: true,
      defaultPresses: 25,
    })
    const changed = synthWalk(stuck(25), {
      focusableCountEnd: 5,
      defaultPresses: 25,
    })
    const short = synthWalk(stuck(3), { defaultPresses: 25 })
    const noProbe = synthWalk(stuck(25), { defaultPresses: 25 })

    const cases: ReadonlyArray<[TabWalkResult, string]> = [
      [walkError, 'walk-error'],
      [changed, 'focusables-changed'],
      [incomplete, 'focusables-incomplete'],
      [short, 'short-walk'],
      [noProbe, 'no-release-probe'],
    ]
    for (const [walk, reason] of cases) {
      const result = judgeKeyboardTrap([walk])
      expect(result.verdict).toBe('undetermined')
      expect(result.reason).toBe(reason)
      expect(result.keyboardTrap).toBe(false)
      expect(result.trapEscapable).toBeNull()
    }
  })

  // 9
  it('identities are never compared across a document replacement', () => {
    // Press 3 replaces the document and the new document re-mints 11 and 12: without segmentation the
    // walk reads as a revisit of presses 1-2.
    const steps = [
      synthStep(1, elementRead(11)),
      synthStep(2, elementRead(12)),
      synthStep(3, elementRead(11), { documentReplaced: true }),
      synthStep(4, elementRead(12)),
      synthStep(5, elementRead(13)),
    ]
    const replaced = synthWalk(steps, {
      focusableCount: 3,
      defaultPresses: 5,
      presses: 5,
    })
    const replacedResult = judgeKeyboardTrap([replaced])
    expect(replacedResult.verdict).toBe('undetermined')
    expect(replacedResult.reason).toBe('document-replaced')
    expect(replacedResult.directions[0].documentReplacements).toEqual([3])

    const wrappedSteps = [...steps.slice(0, 4), synthStep(5, bodyRead(false), { wrapped: true })]
    const wrapped = synthWalk(wrappedSteps, {
      focusableCount: 3,
      defaultPresses: 5,
      presses: 5,
    })
    const wrappedResult = judgeKeyboardTrap([wrapped])
    expect(wrappedResult.verdict).toBe('pass')
    expect(wrappedResult.directions[0].endOfPage?.signal).toBe('body-unfocused')
  })

  // 10
  it('fail on one direction is a page fail; pass on one direction is recorded as single-direction', () => {
    const clean = recorded('dev-fixtures', 'three-links')
    const trapped = recorded('dev-variants', 'three-links__M5__link-1')

    expect(judgeKeyboardTrap([trapped]).verdict).toBe('fail')

    const forwardOnly = judgeKeyboardTrap([clean])
    expect(forwardOnly.verdict).toBe('pass')
    expect(forwardOnly.singleDirection).toBe(true)
    expect(forwardOnly.directionsWalked).toEqual(['forward'])

    const both = judgeKeyboardTrap([clean, { ...trapped, direction: 'backward' }])
    expect(both.verdict).toBe('fail')
    expect(both.singleDirection).toBe(false)
    expect(both.directionsWalked).toEqual(['forward', 'backward'])
  })
})

// acc-walk#1's residuals: four traps whose last F+1 presses reach F distinct identities without leaving the page,
// which the count used to take for the end of it. A: the page's only stop. B: a script loop over every counted
// stop. C: a region padded with Tab stops F does not count (keyboard-focusable scrollers). D: a stop re-rendered on
// every press. Each walk has the shape of its chrome-headless-shell walk; tab-walk.test.ts runs the pages.
describe('judgeKeyboardTrap: a complete count is the end of the page only after a recent wrap', () => {
  it("A: a Tab-swallow trap on the page's only stop is a trap", () => {
    const ids = repeat(11, 15)
    const result = judgeKeyboardTrap([fullWalk(1, ids, probeAfter(ids, 1, repeat(11, 3)))])
    expect(result.verdict).toBe('fail')
    expect(result.directions[0].endOfPage).toBeNull()
    expect(result.directions[0].release).toBe('none')
    expect(result.directions[0].stuckOn?.backendNodeId).toBe(11)
  })

  it('A: the only stop trapping after one lap is a trap', () => {
    const ids = [11, WRAP, ...repeat(11, 13)]
    expect(judgeKeyboardTrap([fullWalk(1, ids, probeAfter(ids, 1, repeat(11, 3)))]).verdict).toBe('fail')
  })

  // Shift+Tab walks the loop backwards (l3 l2 l1 l3 l2 from l1).
  it('B: a script loop over every counted stop is a trap', () => {
    const ids = around([11, 12, 13], 25)
    const result = judgeKeyboardTrap([fullWalk(3, ids, probeAfter(ids, 3, [13, 12, 11, 13, 12]))])
    expect(result.verdict).toBe('fail')
    expect(result.directions[0].release).toBe('none')
  })

  it('B: a loop over every stop that arms after one lap is a trap', () => {
    const ids = [11, 12, 13, WRAP, ...around([11, 12, 13], 21)]
    expect(judgeKeyboardTrap([fullWalk(3, ids, probeAfter(ids, 3, [12, 11, 13, 12, 11]))]).verdict).toBe('fail')
  })

  // Two links, then a dialog whose button and two scrollers loop: F counts the links and the button.
  it('C: a trap region padded with stops F does not count, reaching exactly F, is a trap', () => {
    const fromLoad = [11, 12, ...around([13, 31, 32], 23)]
    const afterOneLap = [11, 12, 13, 31, 32, WRAP, 11, 12, ...around([13, 31, 32], 17)]
    for (const ids of [fromLoad, afterOneLap]) {
      const result = judgeKeyboardTrap([fullWalk(3, ids, probeAfter(ids, 3, [13, 32, 31, 13, 32]))])
      expect(result.verdict).toBe('fail')
      expect([...result.directions[0].region].sort((a, b) => a - b)).toEqual([13, 31, 32])
    }
  })

  it('C: a padded region larger than F whose probe gets nowhere is a trap', () => {
    const ids = [11, ...around([13, 31, 32], 19)]
    const result = judgeKeyboardTrap([fullWalk(2, ids, probeAfter(ids, 2, [32, 31, 13, 32]))])
    expect(result.verdict).toBe('fail')
    expect(result.directions[0].region).toHaveLength(3)
    expect(result.directions[0].release).toBe('none')
  })

  // The probe's seen set is the last F+1 stops, so in a region of F+2 stops one member lies outside it and
  // reads as unseen: the release came from the seen window, not from the page.
  it('a region of F+2 stops whose probe reaches the member outside the last F+1 stops is refused', () => {
    const ids = [11, ...around([13, 31, 32, 33], 19)]
    const result = judgeKeyboardTrap([fullWalk(2, ids, probeAfter(ids, 2, [31, 13, 33]))])
    expect(result.verdict).toBe('undetermined')
    expect(result.reason).toBe('focusables-exceeded')
    expect(result.keyboardTrap).toBe(false)
  })

  // More than F, not F: 12 scrollers then a datetime-local (F = 1) whose parts the walk does not read, so each of
  // its presses is a stop. The walk finds 13 elements, but its last F+1 stops reach one, the input, and the third
  // Shift+Tab leaves the input for the last scroller, a node the probe has not seen.
  it('a walk whose last F+1 stops reach exactly F elements keeps its release read through node identity', () => {
    const ids = [...fresh(100, 12), ...repeat(11, 3)]
    const result = judgeKeyboardTrap([fullWalk(1, ids, probeAfter(ids, 1, [11, 11, 111]))])
    expect(result.verdict).toBe('pass')
    expect(result.directions[0].region).toEqual([11])
    expect(result.directions[0].release).toBe('opposite-key')
  })

  // Every press lands on a new node. F=3: two links and the button; F=1: the button alone.
  const rerenderedEveryPress: ReadonlyArray<[number, number[]]> = [
    [3, [11, 12, ...fresh(100, 23)]],
    [1, fresh(100, 15)],
  ]

  // The probe's first Shift+Tab lands on a new node too.
  it('D: a stop re-rendered on every press is refused, never passed', () => {
    for (const [focusableCount, ids] of rerenderedEveryPress) {
      const result = judgeKeyboardTrap([fullWalk(focusableCount, ids, probeAfter(ids, focusableCount, [200]))])
      expect(result.verdict, `F=${focusableCount}`).toBe('undetermined')
      expect(result.reason, `F=${focusableCount}`).toBe('focusables-exceeded')
    }
  })

  // Clause 9's half of the refusal: a page that re-renders the stop on Escape as well lands Escape on a node the
  // probe has not seen, which is no more a release than an unseen Shift+Tab. The Shift+Tabs stay on the last stop,
  // so the refusal can only come from clause 9.
  it('D: an Escape that lands on a new node is refused, never a release', () => {
    for (const [focusableCount, ids] of rerenderedEveryPress) {
      const stayed = repeat(ids[ids.length - 1], focusableCount + 2)
      const probe = probeAfter(ids, focusableCount, stayed, { after: elementRead(200), unseenElement: true })
      const result = judgeKeyboardTrap([fullWalk(focusableCount, ids, probe)])
      expect(result.verdict, `F=${focusableCount}`).toBe('undetermined')
      expect(result.reason, `F=${focusableCount}`).toBe('focusables-exceeded')
    }
  })

  // Chromium Tabs through the fields of a date or time input on one element (chrome-headless-shell 143:
  // datetime-local 7 presses, date 4, month 3). A walk that does not read their parts counts each press as a stop,
  // so a clean lap can take more than F+1 stops. The wrap window is measured in the laps the walk saw, not in F.
  // A walk that reads parts makes each input one stop (tab-walk.test.ts: a lone one ends body-unfocused).
  it('a lone datetime-local read without parts (seven stops on one element) still ends at all stops visited', () => {
    const ids = [...repeat(11, 7), WRAP, ...repeat(11, 7)]
    const result = judgeKeyboardTrap([fullWalk(1, ids, probeAfter(ids, 1, repeat(11, 3)))])
    expect(result.verdict).toBe('pass')
    expect(result.directions[0].endOfPage?.signal).toBe('all-stops-visited')
  })

  it('date, link, month read without parts (4 + 1 + 3 stops a lap) still ends at all stops visited', () => {
    const ids = around([...repeat(11, 4), 12, ...repeat(13, 3), WRAP], 25)
    const result = judgeKeyboardTrap([fullWalk(3, ids, probeAfter(ids, 3, [13, 12, 11, 11, 11]))])
    expect(result.verdict).toBe('pass')
    expect(result.directions[0].endOfPage?.signal).toBe('all-stops-visited')
  })

  // Two laps, not one: headed Chromium mixes wraps that show body with wraps that skip it
  // (bench/probes/wrap/RESULT.md:17), so a walk that saw body on every wrap so far can go two laps without it.
  // F=3 with 4-press laps: the window is 9, so up to 8 presses after the last wrap still end the page.
  it('the recent-wrap window is 2·max(F, L)+1 presses, two of the longest laps measured', () => {
    for (let after = 5; after <= 9; after++) {
      const ids = [...around([11, 12, 13, WRAP], 16), ...around([11, 12, 13], after)]
      const signal = endOfPage(fullWalk(3, ids, null))?.signal ?? null
      expect(signal, `${after} presses after the last wrap`).toBe(after <= 8 ? 'all-stops-visited' : null)
    }
    // Five laps, then one that skips body, end the 25-press walk: a clean page, even when its probe gets nowhere.
    const ids = [...around([11, 12, 13, WRAP], 20), 11, 12, 13, 11, 12]
    expect(judgeKeyboardTrap([fullWalk(3, ids, stuckProbe(ids, 3))]).verdict).toBe('pass')
  })

  // Pins the lenient 2F+1 floor as shipped; the source gives no reason for F in it. Laps are 2 presses here, so a
  // loop over every stop armed 5 or 6 presses before the end passes, where 2L+1 would send it to the probe and fail
  // it like 'B: a loop over every stop that arms after one lap is a trap'.
  it('the recent-wrap window never drops below 2F+1 presses when every measured lap is shorter than F', () => {
    for (let after = 4; after <= 7; after++) {
      const ids = [...around([11, WRAP], 25 - after, after + 1), ...around([11, 12, 13], after)]
      const signal = endOfPage(fullWalk(3, ids, null))?.signal ?? null
      expect(signal, `${after} presses after the last wrap`).toBe(after <= 6 ? 'all-stops-visited' : null)
      const verdict = judgeKeyboardTrap([fullWalk(3, ids, stuckProbe(ids, 3))]).verdict
      expect(verdict, `${after} presses after the last wrap`).toBe(after <= 6 ? 'pass' : 'fail')
    }
  })

  // Unactivated new headless skips body on every other wrap (bench/probes/wrap/RESULT.md:16), so some end
  // phases hold no wrap in their last F+1 presses. Each phase gets a probe that got nowhere, the worst case.
  it('every end phase of the unactivated F=3 cycle passes, with or without its first stop re-rendered', () => {
    for (let offset = 0; offset < 7; offset++) {
      const plain = around([11, 12, 13, 11, 12, 13, WRAP], 25, offset)
      const rerendered = plain.map((id, i) => (id === 11 && i > 0 ? 21 : id))
      for (const ids of [plain, rerendered]) {
        expect(judgeKeyboardTrap([fullWalk(3, ids, stuckProbe(ids, 3))]).verdict, `phase ${offset}`).toBe('pass')
      }
    }
  })

  it('a clean one-stop page passes in every end phase of the unactivated and headed-irregular cycles', () => {
    for (const cycle of [
      [11, 11, WRAP],
      [11, 11, WRAP, 11, WRAP, 11, 11, WRAP],
    ]) {
      for (let offset = 0; offset < cycle.length; offset++) {
        const ids = around(cycle, 15, offset)
        const verdict = judgeKeyboardTrap([fullWalk(1, ids, stuckProbe(ids, 1))]).verdict
        expect(verdict, `${cycle.join(' ')} phase ${offset}`).toBe('pass')
      }
    }
  })

  // chrome-headless-shell stops on scrollers F does not count, so the tail can hold more stops than F.
  it('a shell walk over two stops F does not count passes in every end phase, never failed or refused', () => {
    for (let offset = 0; offset < 6; offset++) {
      const ids = around([11, 12, 13, 31, 32, WRAP], 25, offset)
      expect(judgeKeyboardTrap([fullWalk(3, ids, stuckProbe(ids, 3))]).verdict, `phase ${offset}`).toBe('pass')
    }
  })

  it('F=0: one uncounted stop that swallows Tab and Shift+Tab is a trap', () => {
    const ids = repeat(31, 10)
    expect(judgeKeyboardTrap([fullWalk(0, ids, probeAfter(ids, 0, repeat(31, 2)))]).verdict).toBe('fail')
  })

  // More stops than F, but neither release below is read through node identity.
  it('F=0 with two uncounted scrollers: a probe that reaches a wrap is a release', () => {
    const ids = around([31, 32, WRAP], 10)
    const result = judgeKeyboardTrap([fullWalk(0, ids, probeAfter(ids, 0, [WRAP]))])
    expect(result.verdict).toBe('pass')
    expect(result.directions[0].release).toBe('opposite-key')
  })

  it('a padded region larger than F whose Escape replaces the document is released by Escape', () => {
    const ids = [11, ...around([13, 31, 32], 19)]
    const probe = probeAfter(ids, 2, [41], { after: bodyRead(true), documentReplaced: true })
    const result = judgeKeyboardTrap([fullWalk(2, ids, probe)])
    expect(result.verdict).toBe('pass')
    expect(result.directions[0].release).toBe('escape-key')
  })

  // The Shift+Tabs stay in the region, so only Escape can release.
  it('a padded region larger than F whose Escape wraps is released by Escape', () => {
    const ids = [11, ...around([13, 31, 32], 19)]
    const probe = probeAfter(ids, 2, [32, 31, 13, 32], { after: bodyRead(false), wrapped: true })
    const result = judgeKeyboardTrap([fullWalk(2, ids, probe)])
    expect(result.verdict).toBe('pass')
    expect(result.directions[0].release).toBe('escape-key')
  })

  // The refusal's cost, pinned. F counted and U uncounted one-press stops first wrap at press F+U+1, so with
  // U >= 4F+10 the 5(F+1)+5-press walk never wraps, and its release is read through identity with more stops
  // than F. One stop fewer and the walk's last press is the wrap.
  it('a clean page with 4F+10 or more stops F does not count never wraps in the walk and is refused', () => {
    for (const focusableCount of [1, 3]) {
      const presses = 5 * (focusableCount + 1) + 5
      const cases: ReadonlyArray<[number, 'undetermined' | 'pass']> = [
        [4 * focusableCount + 10, 'undetermined'],
        [4 * focusableCount + 9, 'pass'],
      ]
      for (const [uncounted, verdict] of cases) {
        const ids = around([...fresh(100, focusableCount + uncounted), WRAP], presses)
        const last = ids[ids.length - 1]
        // Shift+Tab steps back one stop a press; the first stop before the last F+1 presses is unseen.
        const probe = ids.slice(-(focusableCount + 1)).includes(WRAP)
          ? null
          : probeAfter(
              ids,
              focusableCount,
              Array.from({ length: focusableCount + 2 }, (_, i) => last - 1 - i),
            )
        const result = judgeKeyboardTrap([fullWalk(focusableCount, ids, probe)])
        expect(result.verdict, `F=${focusableCount} U=${uncounted}`).toBe(verdict)
        if (verdict === 'undetermined') expect(result.reason).toBe('focusables-exceeded')
      }
    }
  })
})
