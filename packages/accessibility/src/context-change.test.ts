import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { BrowserClient, BrowserPage } from '@at-agent/browser'
import { judgeContextChange } from './context-change.js'
import { runTabWalk, TabWalkResultSchema, type FocusRead, type TabWalkResult, type TabWalkStep } from './tab-walk.js'

// Walks recorded at cd3b122, committed once bench/.gitignore re-included them. Each file's `.walk` key
// is a TabWalkResult as the recorder wrote it then. Read-only on disk: these records ARE the measurement, never edit one.
const RESULTS = fileURLToPath(new URL('../../../bench/results/cd3b122/', import.meta.url))

function loadWalk(set: 'dev-fixtures' | 'dev-variants', page: string): TabWalkResult {
  const raw = gunzipSync(readFileSync(`${RESULTS}${set}/raw/${page}.json.gz`)).toString('utf8')
  const record = JSON.parse(raw) as { walk: unknown }
  return TabWalkResultSchema.parse(record.walk)
}

const BASE_PAGES = [
  'form',
  'good-operable',
  'identical-links',
  'js-handlers',
  'modal',
  'navbar',
  'react-div-button',
  'three-links',
] as const

const M5_VARIANTS = [
  'form__M5__email-input',
  'good-operable__M5__nav-about',
  'identical-links__M5__read-more-01',
  'js-handlers__M5__custom-button',
  'navbar__M5__brand',
  'three-links__M5__link-1',
] as const

// Press index of the seeded navigation on each M6 variant, read off the recorded walk: the step
// whose immediate read already carries ?changed=1.
const M6_VARIANTS = [
  { page: 'three-links__M6__link-1', pressIndex: 1 },
  { page: 'navbar__M6__brand', pressIndex: 1 },
  { page: 'identical-links__M6__read-more-01', pressIndex: 1 },
  { page: 'js-handlers__M6__custom-button', pressIndex: 1 },
  { page: 'form__M6__email-input', pressIndex: 2 },
  { page: 'good-operable__M6__nav-about', pressIndex: 5 },
] as const

const BASE_URL = 'http://walk.test/page.html'

function bodyRead(url: string, hasFocus: boolean, backendNodeId = 9): FocusRead {
  return {
    backendNodeId,
    tag: 'body',
    id: null,
    className: null,
    ariaLabel: null,
    nameAttr: null,
    nameProp: null,
    text: null,
    isBody: true,
    hasFocus,
    url,
    container: null,
    deep: {
      backendNodeId,
      tag: 'body',
      id: null,
      isBody: true,
      classAttr: null,
    },
    deepUnavailable: null,
    part: null,
  }
}

function elementRead(backendNodeId: number, url: string, tag = 'a'): FocusRead {
  return {
    backendNodeId,
    tag,
    id: `e${backendNodeId}`,
    className: null,
    ariaLabel: null,
    nameAttr: null,
    nameProp: null,
    text: null,
    isBody: false,
    hasFocus: true,
    url,
    container: null,
    deep: {
      backendNodeId,
      tag,
      id: `e${backendNodeId}`,
      isBody: false,
      classAttr: null,
    },
    deepUnavailable: null,
    part: null,
  }
}

function step(index: number, settled: FocusRead, over: Partial<TabWalkStep> = {}): TabWalkStep {
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

function makeWalk(steps: TabWalkStep[], over: Partial<TabWalkResult> = {}): TabWalkResult {
  return {
    direction: 'forward',
    focusableCount: 3,
    fIncomplete: false,
    fIncompleteCauses: { crossOriginFrames: 0, closedShadowRoots: 0 },
    defaultPresses: Math.max(steps.length, 1),
    presses: Math.max(steps.length, 1),
    settleMs: 150,
    launchFacts: { browserVersion: null, executableBasename: null },
    initial: bodyRead(BASE_URL, true),
    idle: null,
    focusableCountEnd: null,
    steps,
    suspectedTrap: false,
    escapeProbe: null,
    error: null,
    ...over,
  }
}

describe('judgeContextChange', () => {
  it('M6 first-stop navigation: exactly one finding, no element named', () => {
    const walk = loadWalk('dev-variants', 'three-links__M6__link-1')
    const result = judgeContextChange(walk)

    expect(result.wcagCriterion).toBe('3.2.1')
    expect(result.verdict).toBe('fail')
    expect(result.reason).toBeNull()
    expect(result.unattributed).toEqual([])
    expect(result.findings).toHaveLength(1)

    const finding = result.findings[0]
    expect(finding.kind).toBe('url-changed')
    expect(finding.wcagCriterion).toBe('3.2.1')
    expect(finding.severity).toBe('serious')
    expect(finding.pressIndex).toBe(1)
    expect(finding.key).toBe('Tab')
    // The culprit is the first tab stop: the immediate read has tag null, so nothing is invented.
    expect(finding.arrivedOn).toBeNull()
    expect(finding.precedingStop).toBeNull()
    expect(finding.fromUrl).toBe(walk.initial.url)
    expect(finding.toUrl.endsWith('?changed=1')).toBe(true)
    expect(finding.documentReplaced).toBe(true)
  })

  it('M6 second-stop navigation names the preceding stop', () => {
    const walk = loadWalk('dev-variants', 'form__M6__email-input')
    const result = judgeContextChange(walk)

    expect(result.verdict).toBe('fail')
    expect(result.findings).toHaveLength(1)

    const finding = result.findings[0]
    expect(finding.kind).toBe('url-changed')
    expect(finding.pressIndex).toBe(2)
    expect(finding.precedingStop).toEqual({
      backendNodeId: 18,
      tag: 'input',
      id: 'name',
      isBody: false,
      classAttr: null,
    })
    expect(finding.fromUrl).toBe(walk.steps[0].settled.url)
    expect(finding.toUrl.endsWith('?changed=1')).toBe(true)
    // Presses 3-8 walk the replaced document. Nothing more is emitted there.
    expect(result.findings.filter((f) => f.pressIndex >= 3 && f.pressIndex <= 8)).toEqual([])
    expect(result.unattributed).toEqual([])
  })

  it('all six M6 variants: exactly one url-changed finding each', () => {
    for (const { page, pressIndex } of M6_VARIANTS) {
      const result = judgeContextChange(loadWalk('dev-variants', page))
      const shape = result.findings.map((f) => `${f.kind}@${f.pressIndex}`)
      expect(shape, page).toEqual([`url-changed@${pressIndex}`])
      expect(result.verdict, page).toBe('fail')
      expect(result.unattributed, page).toEqual([])
    }
  })

  it('clean pages and M5 traps produce nothing', () => {
    for (const page of BASE_PAGES) {
      const result = judgeContextChange(loadWalk('dev-fixtures', page))
      expect(result.findings, page).toEqual([])
      expect(result.unattributed, page).toEqual([])
      expect(result.verdict, page).toBe('pass')
      expect(result.reason, page).toBeNull()
    }
    for (const page of M5_VARIANTS) {
      const result = judgeContextChange(loadWalk('dev-variants', page))
      expect(result.findings, page).toEqual([])
      expect(result.unattributed, page).toEqual([])
      expect(result.verdict, page).toBe('pass')
    }
  })

  it('F55: a drop after a real stop is a 3.2.1 failure', () => {
    const walk = makeWalk([
      step(1, elementRead(11, BASE_URL)),
      step(2, elementRead(12, BASE_URL)),
      step(3, bodyRead(BASE_URL, true), { focusLost: true }),
      step(4, elementRead(11, BASE_URL)),
    ])
    const result = judgeContextChange(walk)

    expect(result.verdict).toBe('fail')
    expect(result.unattributed).toEqual([])
    expect(result.findings).toHaveLength(1)

    const finding = result.findings[0]
    expect(finding.kind).toBe('focus-removed')
    expect(finding.wcagCriterion).toBe('3.2.1')
    expect(finding.pressIndex).toBe(3)
    expect(finding.precedingStop).toEqual({
      backendNodeId: 12,
      tag: 'a',
      id: 'e12',
      isBody: false,
      classAttr: null,
    })
    expect(finding.arrivedOn).toBeNull()
    expect(finding.documentReplaced).toBe(false)
    expect(finding.fromUrl).toBe(BASE_URL)
    expect(finding.toUrl).toBe(BASE_URL)
  })

  it('a drop first seen at the settled read is refused, not reported', () => {
    // The immediate read, about 1 ms after the press, still names the stop, and focus is gone only at the settled read
    // 150 ms later. A page timer and a deferred focus handler look the same there, so the press is refused like A'.
    const result = judgeContextChange(
      makeWalk([
        step(1, elementRead(11, BASE_URL)),
        step(2, elementRead(12, BASE_URL)),
        step(3, bodyRead(BASE_URL, true), { immediate: elementRead(13, BASE_URL), focusLost: true }),
        step(4, elementRead(11, BASE_URL)),
      ]),
    )

    expect(result.findings).toEqual([])
    expect(result.unattributed).toEqual([{ pressIndex: 3, reason: 'focus-removed-after-settle' }])
    expect(result.verdict).toBe('pass')
  })

  it('a wrap is never a context change', () => {
    const steps: TabWalkStep[] = []
    for (let i = 1; i <= 8; i++) {
      steps.push(
        i % 4 === 0
          ? step(i, bodyRead(BASE_URL, false), { wrapped: true })
          : step(i, elementRead(10 + (i % 4), BASE_URL)),
      )
    }
    const result = judgeContextChange(makeWalk(steps))

    expect(result.findings).toEqual([])
    expect(result.unattributed).toEqual([])
    expect(result.verdict).toBe('pass')
  })

  it('refused, not reported: the three unattributed classes', () => {
    const noPrecedingStop = judgeContextChange(
      makeWalk([
        step(1, bodyRead(BASE_URL, true)),
        step(2, elementRead(11, BASE_URL)),
        step(3, elementRead(12, BASE_URL)),
      ]),
    )
    expect(noPrecedingStop.findings).toEqual([])
    expect(noPrecedingStop.unattributed).toEqual([{ pressIndex: 1, reason: 'no-preceding-stop' }])
    expect(noPrecedingStop.verdict).toBe('pass')

    const replacedNoUrlChange = judgeContextChange(
      makeWalk([
        step(1, elementRead(11, BASE_URL)),
        step(2, elementRead(21, BASE_URL), { documentReplaced: true }),
        step(3, elementRead(22, BASE_URL)),
      ]),
    )
    expect(replacedNoUrlChange.findings).toEqual([])
    expect(replacedNoUrlChange.unattributed).toEqual([{ pressIndex: 2, reason: 'document-replaced-no-url-change' }])

    const afterSettle = judgeContextChange(
      makeWalk([
        step(1, elementRead(11, BASE_URL)),
        step(2, elementRead(12, `${BASE_URL}?changed=1`), {
          immediate: elementRead(12, BASE_URL),
        }),
        step(3, elementRead(13, `${BASE_URL}?changed=1`)),
      ]),
    )
    expect(afterSettle.findings).toEqual([])
    expect(afterSettle.unattributed).toEqual([{ pressIndex: 2, reason: 'url-changed-after-settle' }])
  })

  it('fragment-only URL changes are not context changes', () => {
    const steps = [1, 2, 3, 4].map((i) => step(i, elementRead(10 + i, `${BASE_URL}#section-${i}`)))
    const result = judgeContextChange(makeWalk(steps))

    expect(result.findings).toEqual([])
    expect(result.unattributed).toEqual([])
    expect(result.verdict).toBe('pass')
  })

  it('a page that navigates with no input cannot attribute anything to focus', () => {
    const walk = makeWalk([step(1, elementRead(11, BASE_URL)), step(2, elementRead(12, BASE_URL))], {
      idle: {
        after: bodyRead(`${BASE_URL}?redirected=1`, true),
        documentReplaced: false,
        urlChanged: true,
      },
    })
    const result = judgeContextChange(walk)

    expect(result.verdict).toBe('undetermined')
    expect(result.reason).toBe('page-navigates-without-input')
    expect(result.findings).toEqual([])
  })

  it('a fragment-only change in the idle window is not navigation', () => {
    // A scroll-spy rewrites #slide-N while the page idles. Every other URL comparison here strips the fragment, so the
    // causality control does too, and a real F55 drop seen at the immediate read is reported.
    const slide = (n: number): string => `${BASE_URL}#slide-${n}`
    const walk = makeWalk(
      [
        step(1, elementRead(11, slide(2))),
        step(2, elementRead(12, slide(2))),
        step(3, bodyRead(slide(3), true), { focusLost: true }),
        step(4, elementRead(11, slide(3))),
      ],
      { idle: { after: bodyRead(slide(2), true), documentReplaced: false, urlChanged: true } },
    )
    const result = judgeContextChange(walk)

    expect(result.verdict).toBe('fail')
    expect(result.reason).toBeNull()
    expect(result.findings.map((f) => `${f.kind}@${f.pressIndex}`)).toEqual(['focus-removed@3'])
  })

  it('a fragment ticker that drops focus inside the settle stays refused', () => {
    // A timer setting location.hash = '#sN' is a fragment navigation, and it clears focus: the idle baseline sees the
    // fragment move and every drop lands in the settle. A tick in the ~1 ms before an immediate read would still be
    // reported, failing about 1 walk in 5, so a walk showing both signs keeps the pre-fix undetermined.
    const at = (n: number): string => `${BASE_URL}#s${n}`
    const walk = makeWalk(
      [
        step(1, elementRead(11, at(1))),
        step(2, bodyRead(at(2), true), { immediate: elementRead(11, at(1)), focusLost: true }),
        step(3, bodyRead(at(3), true), { immediate: elementRead(11, at(2)), focusLost: true }),
        step(4, bodyRead(at(1), true), { immediate: elementRead(11, at(3)), focusLost: true }),
      ],
      { idle: { after: bodyRead(at(1), true), documentReplaced: false, urlChanged: true } },
    )
    const result = judgeContextChange(walk)

    expect(result.verdict).toBe('undetermined')
    expect(result.reason).toBe('page-navigates-without-input')
    expect(result.findings).toEqual([])
    expect(result.unattributed.map((u) => `${u.reason}@${u.pressIndex}`)).toEqual([
      'focus-removed-after-settle@2',
      'focus-removed-after-settle@3',
      'focus-removed-after-settle@4',
    ])
  })

  it('the causality control outranks a finding a load-time navigation manufactures', () => {
    // walk.initial is read BEFORE the idle settle, so a page that navigates on its own leaves
    // press 1 comparing against a URL the page has already left: clause A fires and invents a
    // focus-caused change. The idle baseline is the only evidence that tells the two apart, so it
    // has to outrank the finding it manufactures — otherwise the control is unreachable on exactly
    // the page it exists for.
    const moved = `${BASE_URL}?redirected=1`
    const walk = makeWalk([step(1, elementRead(11, moved)), step(2, elementRead(12, moved))], {
      idle: { after: bodyRead(moved, true), documentReplaced: false, urlChanged: true },
    })
    const result = judgeContextChange(walk)

    expect(result.verdict).toBe('undetermined')
    expect(result.reason).toBe('page-navigates-without-input')
    // Recorded, never silent: the press that looked like a context change stays on the result.
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].pressIndex).toBe(1)
  })

  it('short-walk counts stops, not presses: two fields of one date input are one stop', () => {
    // 3 presses, but 2 of the 3 stops owed: Tab crosses two of a date input's fields while the input keeps focus.
    // The walker ends a walk short with no error only under a lowered budget (allowFewerPresses), hence presses: 2.
    const field = (part: number): FocusRead => ({ ...elementRead(11, BASE_URL, 'input'), part })
    const walk = makeWalk([step(1, field(101)), step(2, field(102)), step(3, elementRead(12, BASE_URL))], {
      defaultPresses: 3,
      presses: 2,
    })
    const result = judgeContextChange(walk)

    expect(result.verdict).toBe('undetermined')
    expect(result.reason).toBe('short-walk')
  })
})

// Inline on purpose: no dev-corpus page sets focusLostOnArrival, so the F55 clause has no recorded
// fixture. The second of four links blurs itself the moment focus arrives.
const BLUR_ON_FOCUS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blur on focus</title></head><body>
<h1>F55: the second link throws focus away</h1>
<p><a id="k1" href="#one">One</a></p>
<p><a id="k2" href="#two" onfocus="this.blur()">Two</a></p>
<p><a id="k3" href="#three">Three</a></p>
<p><a id="k4" href="#four">Four</a></p>
</body></html>`

// The second link blurs itself 60 ms after focus arrives: after the immediate read, inside the 150 ms settle.
const DEFERRED_BLUR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Deferred blur</title></head><body>
<h1>A deferred F55: the second link throws focus away 60 ms late</h1>
<p><a id="k1" href="#one">One</a></p>
<p><a id="k2" href="#two" onfocus="var e = this; setTimeout(function () { e.blur() }, 60)">Two</a></p>
<p><a id="k3" href="#three">Three</a></p>
<p><a id="k4" href="#four">Four</a></p>
</body></html>`

// BLUR_ON_FOCUS plus a scroll-spy that rewrites only the URL fragment every 100 ms, so the idle baseline sees the URL
// change with no input. replaceState moves no focus: every drop is the second link's own.
const SCROLL_SPY_BLUR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scroll-spy</title></head><body>
<h1>F55 on a page whose fragment ticks</h1>
<p><a id="k1" href="#one">One</a></p>
<p><a id="k2" href="#two" onfocus="this.blur()">Two</a></p>
<p><a id="k3" href="#three">Three</a></p>
<p><a id="k4" href="#four">Four</a></p>
<script>var n = 0; setInterval(function () { n++; history.replaceState(null, '', '#tick-' + n) }, 100)</script>
</body></html>`

// The page's only Tab stop blurs itself in its focus handler (dev one-button__M7), so no read ever rests on it.
const ONLY_STOP_BLUR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Only stop blurs</title></head><body>
<p><button id="only" onfocus="this.blur()">Only</button></p>
</body></html>`

// The same stop blurs 60 ms after focus arrives (dev one-button__M8): after the immediate read, inside the settle.
const ONLY_STOP_DEFERRED_BLUR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Only stop blurs late</title></head><body>
<p><button id="only" onfocus="var e = this; setTimeout(function () { e.blur() }, 60)">Only</button></p>
</body></html>`

describe('judgeContextChange on a live page', () => {
  let client: BrowserClient
  const pages: BrowserPage[] = []

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
  })

  afterEach(async () => {
    await Promise.all(pages.splice(0).map((p) => p.close()))
  })

  afterAll(async () => {
    await client.close()
  })

  it('F55 live: blur-on-focus on the second of four links', async () => {
    const page = await client.newPage()
    pages.push(page)
    await page.playwrightPage.setContent(BLUR_ON_FOCUS, { waitUntil: 'load' })

    const walk = await runTabWalk(page.playwrightPage, { settleMs: 20 })
    // The settle refusal's premise, on walk facts alone: a synchronous blur has already dropped focus when the press
    // returns. If Chromium ever defers it past the immediate read, clause C refuses every F55 drop; this names why.
    const lost = walk.steps.filter((s) => s.focusLost)
    expect(lost.length).toBeGreaterThanOrEqual(5)
    expect(lost.filter((s) => !(s.immediate.isBody && s.immediate.hasFocus)).map((s) => s.index)).toEqual([])
    const result = judgeContextChange(walk)

    expect(result.verdict).toBe('fail')
    expect(result.findings.every((f) => f.kind === 'focus-removed')).toBe(true)
    expect(result.findings.length).toBeGreaterThanOrEqual(5)
    const named = new Set(result.findings.map((f) => f.precedingStop?.id ?? null))
    expect([...named]).toEqual(['k1'])
  })

  it('a blur deferred past the immediate read is refused, not reported', async () => {
    const page = await client.newPage()
    pages.push(page)
    await page.playwrightPage.setContent(DEFERRED_BLUR, { waitUntil: 'load' })

    // The default 150 ms settle: a 20 ms settle would take the settled read before the 60 ms blur.
    const walk = await runTabWalk(page.playwrightPage)
    const result = judgeContextChange(walk)

    expect(result.findings).toEqual([])
    expect(result.unattributed.length).toBeGreaterThanOrEqual(5)
    expect(result.unattributed.filter((u) => u.reason !== 'focus-removed-after-settle')).toEqual([])
    expect(result.verdict).toBe('pass')
  })

  it('F55 live: the only Tab stop blurs on arrival, and every drop is reported', async () => {
    const page = await client.newPage()
    pages.push(page)
    await page.playwrightPage.setContent(ONLY_STOP_BLUR, { waitUntil: 'load' })

    const walk = await runTabWalk(page.playwrightPage, { settleMs: 20 })
    const drops = walk.steps.filter((s) => s.settled.isBody && s.settled.hasFocus).map((s) => s.index)
    expect(drops.length).toBeGreaterThanOrEqual(5)
    const result = judgeContextChange(walk)

    expect(result.verdict).toBe('fail')
    expect(result.findings.map((f) => f.pressIndex)).toEqual(drops)
    expect(result.findings.every((f) => f.kind === 'focus-removed' && f.precedingStop === null)).toBe(true)
    expect(result.unattributed).toEqual([])
  })

  it('the only Tab stop blurring 60 ms late is refused on every drop, the first press included', async () => {
    const page = await client.newPage()
    pages.push(page)
    await page.playwrightPage.setContent(ONLY_STOP_DEFERRED_BLUR, { waitUntil: 'load' })

    const walk = await runTabWalk(page.playwrightPage)
    const result = judgeContextChange(walk)

    expect(result.findings).toEqual([])
    expect(result.unattributed.length).toBeGreaterThanOrEqual(5)
    expect(result.unattributed.filter((u) => u.reason !== 'focus-removed-after-settle')).toEqual([])
    expect(result.verdict).toBe('pass')
  })

  it('a scroll-spy fragment timer does not void a real F55 failure', async () => {
    const page = await client.newPage()
    pages.push(page)
    await page.playwrightPage.setContent(SCROLL_SPY_BLUR, { waitUntil: 'load' })

    // The default settle, so the 100 ms timer lands inside the idle baseline.
    const walk = await runTabWalk(page.playwrightPage)
    expect(walk.idle?.urlChanged).toBe(true)
    const result = judgeContextChange(walk)

    expect(result.reason).toBeNull()
    expect(result.verdict).toBe('fail')
    expect(result.findings.every((f) => f.kind === 'focus-removed')).toBe(true)
    expect(result.findings.length).toBeGreaterThanOrEqual(5)
  })
})
