// acc-gaps#1 and #6: the crawl, the accessibility-tree read and the Tab walk must describe one document. Each race is
// made deterministic by wrapping the CDP sessions the detector opens and changing the page at one chosen call.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { RENDERER_CRASHED } from '../renderer-crash.js'
import { crawlPageWithGapDetection, type GapDetectionOptions } from './detect.js'
import type { AccessibilityGap, DualCrawlResult } from './types.js'

const URL_ = 'http://fixture.test/timing.html'
const probePage = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Timing</title></head><body>${body}</body></html>`

// Every control is keyboard-reachable and exposed: a clean load has no gap.
const CONTROLS =
  probePage(`<main><a href="#a" data-bench-id="home">Home</a> <a href="#b" data-bench-id="about">About</a>
<button type="button" data-bench-id="buy" onclick="void 0">Buy</button>
<div role="button" tabindex="0" data-bench-id="cart" onclick="void 0">Cart</div></main>`)
// The same controls plus a real defect: a role=button div Tab never reaches, which a clean load flags not_focusable.
const WITH_DEFECT = CONTROLS.replace(
  '</main>',
  '\n<div role="button" data-bench-id="defect" onclick="void 0">Checkout</div></main>',
)

// A correct modal (bench/corpus/dev/base/modal.html, reduced): the page behind it is aria-hidden, Tab loops inside it.
// extra goes into the aria-hidden page, script after the modal's own.
const modal = (extra = '', script = ''): string =>
  probePage(`<div id="page" aria-hidden="true"><h1>Account</h1>
<button type="button" data-bench-id="trigger">Edit profile</button> <a href="#help" data-bench-id="help-link">Help</a>${extra}</div>
<div role="dialog" id="dialog" aria-label="Edit profile"><label>Name <input data-bench-id="name"></label>
<button type="button" data-bench-id="save">Save</button></div>
<script>
var dialog = document.getElementById('dialog')
var items = function () { return dialog.querySelectorAll('input, button') }
document.addEventListener('keydown', function (e) {
  var all = items()
  if (e.key === 'Tab' && !e.shiftKey && document.activeElement === all[all.length - 1]) { e.preventDefault(); all[0].focus() }
})
document.addEventListener('focusin', function (e) { if (!dialog.contains(e.target)) items()[0].focus() })
items()[0].focus()
</script>${script}`)
const MODAL = modal()
// A notice with an Undo link in the aria-hidden page, which the page removes by itself on the third keydown.
const MODAL_TOAST = modal(
  '<div id="toast" role="status">Saved. <a href="#undo" data-bench-id="undo">Undo</a></div>',
  `<script>
var presses = 0
document.addEventListener('keydown', function () { if (++presses === 3) document.getElementById('toast').remove() })
</script>`,
)

// Navigates from inside the detector's crawl-mark write: it takes over Reflect.set for that key, reloads, and returns
// a promise that never settles, so the write can only end with the reload destroying its context.
const RELOADS_IN_CRAWL_MARK = CONTROLS.replace(
  '</main>',
  `</main><script>
var set = Reflect.set
Reflect.set = function (target, key) {
  if (key !== '__atAgentGapCrawl') return set.apply(Reflect, arguments)
  sessionStorage.setItem('reloadedInCrawlMark', '1')
  location.reload()
  return new Promise(function () {})
}
</script>`,
)

// The page's own script refuses the detector's crawl-mark write, with no navigation. The page counts its loads so a
// test can show it was never replaced.
const refusesCrawlMark = (write: string): string =>
  CONTROLS.replace(
    '</main>',
    `</main><script>
sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads')) + 1))
var set = Reflect.set
Reflect.set = function (target, key) {
  if (key !== '__atAgentGapCrawl') return set.apply(Reflect, arguments)
  ${write}
}
</script>`,
  )

// The tab walk's own marker write (tab-walk.ts injectMarker); only its first call, at walk start, fires a hook.
const WALK_MARKER_WRITE = 'window["__atAgentTabWalk"] ='

type CdpParams = Record<string, unknown>
type Hook = {
  when: 'before' | 'after'
  match: (method: string, params: CdpParams) => boolean
  act: (page: Page) => Promise<void>
}

const isWalkMarkerWrite = (method: string, params: CdpParams): boolean =>
  method === 'Runtime.evaluate' && String(params.expression).startsWith(WALK_MARKER_WRITE)
const isAxRead = (method: string): boolean => method === 'Accessibility.getFullAXTree'
// findHiddenCandidates' first box read; the crawl's own box reads pass a nodeId.
const isBoxRead = (method: string, params: CdpParams): boolean =>
  method === 'DOM.getBoxModel' && 'backendNodeId' in params
const reload = async (page: Page): Promise<void> => {
  await page.reload({ waitUntil: 'domcontentloaded' })
}
// Same window and marker, every node new: what a client-side re-mount does.
const remount = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const main = document.querySelector('main')
    if (main) main.innerHTML = main.innerHTML
  })
}

describe('crawlPageWithGapDetection when the page changes between its reads', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
  })

  // One context per run: a hook may reload or close it.
  async function detect(
    html: string,
    hook: Hook | null,
    tabWalk: GapDetectionOptions['tabWalk'] = { settleMs: 50 },
  ): Promise<{ run: Promise<DualCrawlResult>; fired: () => boolean; page: Page; context: BrowserContext }> {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: html }))
    let fired = false
    if (hook) {
      const open = context.newCDPSession.bind(context)
      context.newCDPSession = async (target) => {
        const session = await open(target)
        const send = session.send.bind(session) as (method: string, params?: CdpParams) => Promise<unknown>
        Object.assign(session, {
          send: async (method: string, params: CdpParams = {}) => {
            const hit = !fired && hook.match(method, params)
            if (hit && hook.when === 'before') {
              fired = true
              await hook.act(page)
            }
            const result = await send(method, params)
            if (hit && hook.when === 'after') {
              fired = true
              await hook.act(page)
            }
            return result
          },
        })
        return session
      }
    }
    const run = crawlPageWithGapDetection(page, URL_, { tabWalk })
    // Settle the run before the caller closes the context, whichever way it ends.
    run.catch(() => undefined)
    return { run, fired: () => fired, page, context }
  }

  const benchId = (g: AccessibilityGap): string => g.domElement.attributes['data-bench-id'] ?? g.domElement.localName
  const gapsOf = (r: DualCrawlResult): Record<string, string> =>
    Object.fromEntries(r.gaps.map((g) => [benchId(g), g.gapType]))

  describe('acc-gaps#1: the walk ran on a different document than the crawl', () => {
    for (const [name, when, act, reason] of [
      ['replaced just before the walk marks it', 'before', reload, 'document-replaced'],
      ['replaced just after the walk marks it (its idle baseline sees it)', 'after', reload, 'document-replaced'],
      ['re-mounted in the same window just before the walk marks it', 'before', remount, 'crawled-nodes-detached'],
    ] as const) {
      it(`refuses not_focusable when the document is ${name}`, async () => {
        const d = await detect(CONTROLS, { when, match: isWalkMarkerWrite, act })
        try {
          const r = await d.run
          expect(d.fired()).toBe(true)
          expect(r.keyboard.notFocusableAssessed).toBe(false)
          expect(r.keyboard.unassessedReasons).toEqual([reason])
          expect(gapsOf(r)).toEqual({})
        } finally {
          await d.context.close()
        }
      })
    }

    // A re-mount right after the crawl leaves every crawled node without a box, so none is a candidate: unless the
    // walk is refused, the page's real defect scores as an assessed pass.
    it('refuses not_focusable when the page re-mounts before the crawled boxes are read', async () => {
      const clean = await detect(WITH_DEFECT, null)
      try {
        const r = await clean.run
        expect(r.keyboard.notFocusableAssessed).toBe(true)
        expect(gapsOf(r)).toEqual({ defect: 'not_focusable' })
      } finally {
        await clean.context.close()
      }
      const d = await detect(WITH_DEFECT, { when: 'before', match: isBoxRead, act: remount })
      try {
        const r = await d.run
        expect(d.fired()).toBe(true)
        expect(r.hidden.map((h) => h.reason)).toEqual(r.domElements.map(() => 'no-box'))
        expect(r.keyboard.notFocusableAssessed).toBe(false)
        expect(r.keyboard.unassessedReasons).toEqual(['crawled-nodes-detached'])
        expect(gapsOf(r)).toEqual({})
      } finally {
        await d.context.close()
      }
    })

    // Documented cost, pinned: a refused walk falls back to the no-walk aria-hidden rule (as after M6's navigation).
    it('flags the aria-hidden page behind a modal once a replaced document refuses the walk that cleared it', async () => {
      const clean = await detect(MODAL, null)
      try {
        const r = await clean.run
        expect(r.keyboard.unassessedReasons).toEqual(['no-wrap'])
        expect(gapsOf(r)).toEqual({})
      } finally {
        await clean.context.close()
      }
      const d = await detect(MODAL, { when: 'before', match: isWalkMarkerWrite, act: reload })
      try {
        const r = await d.run
        expect(d.fired()).toBe(true)
        expect(r.keyboard.unassessedReasons).toEqual(['no-wrap', 'document-replaced'])
        expect(gapsOf(r)).toEqual({ trigger: 'hidden_but_interactive', 'help-link': 'hidden_but_interactive' })
      } finally {
        await d.context.close()
      }
    })

    // The same cost with no replacement: the page's own script removes a crawled node the walk never reached.
    it('flags the aria-hidden page behind a modal once the page drops an unreached toast during the walk', async () => {
      const d = await detect(MODAL_TOAST, null)
      try {
        const r = await d.run
        expect(r.keyboard.unassessedReasons).toEqual(['no-wrap', 'crawled-nodes-detached'])
        expect(gapsOf(r)).toEqual({
          trigger: 'hidden_but_interactive',
          'help-link': 'hidden_but_interactive',
          undo: 'hidden_but_interactive',
        })
      } finally {
        await d.context.close()
      }
    })

    it('never reads a page closed mid-walk as a replaced document', async () => {
      let reads = 0
      // Every focus read starts with this evaluate: initial, idle, then two per press; the fifth is press 2's.
      const d = await detect(CONTROLS, {
        when: 'before',
        match: (m, p) => m === 'Runtime.evaluate' && p.expression === 'document.activeElement' && ++reads === 5,
        act: (page) => page.context().close(),
      })
      const r = await d.run
      expect(d.fired()).toBe(true)
      expect(d.page.isClosed()).toBe(true)
      expect(r.keyboard).toMatchObject({ walkRan: true, unassessedReasons: ['walk-error'] })
    })

    // The crawled window is marked before the crawl. A navigation that destroys the write's context leaves the new
    // window unmarked, so the walk is refused instead of the detector throwing.
    it('refuses not_focusable when the page navigates during the crawl-mark write', async () => {
      const d = await detect(RELOADS_IN_CRAWL_MARK, null)
      try {
        const r = await d.run
        expect(await d.page.evaluate(() => sessionStorage.getItem('reloadedInCrawlMark'))).toBe('1')
        expect(r.keyboard.notFocusableAssessed).toBe(false)
        expect(r.keyboard.unassessedReasons).toEqual(['document-replaced'])
        expect(gapsOf(r)).toEqual({})
      } finally {
        await d.context.close()
      }
    })

    for (const [how, write] of [
      ['throws', "throw new Error('no marks here')"],
      ['returns false', 'return false'],
    ] as const) {
      it(`does not call the document replaced when the page's crawl-mark write ${how}`, async () => {
        const d = await detect(refusesCrawlMark(write), null)
        try {
          const r = await d.run
          expect(await d.page.evaluate(() => sessionStorage.getItem('loads'))).toBe('1')
          expect(r.keyboard.notFocusableAssessed).toBe(false)
          expect(r.keyboard.unassessedReasons).toEqual(['crawl-mark-failed'])
          expect(gapsOf(r)).toEqual({})
        } finally {
          await d.context.close()
        }
      })
    }

    // Only an explicit false is a refusal: a wrapper that writes the mark but returns nothing still marks the window.
    it('keeps not_focusable assessed when the page wraps Reflect.set without returning its result', async () => {
      const d = await detect(refusesCrawlMark('set.apply(Reflect, arguments)'), null)
      try {
        const r = await d.run
        expect(await d.page.evaluate(() => typeof Reflect.get(window, '__atAgentGapCrawl'))).toBe('string')
        expect(r.keyboard.unassessedReasons).toEqual([])
        expect(r.keyboard.notFocusableAssessed).toBe(true)
      } finally {
        await d.context.close()
      }
    })
  })

  describe('acc-gaps#6: the accessibility tree and the crawl read different DOMs', () => {
    it('never reports a control inserted mid-crawl as missing from the accessibility tree', async () => {
      const d = await detect(
        CONTROLS,
        {
          when: 'after',
          // The crawl's first element read (selector "button"); the switch matches a later selector.
          match: (m) => m === 'DOM.describeNode',
          act: (page) =>
            page.evaluate(() => {
              const s = document.createElement('div')
              s.setAttribute('role', 'switch')
              s.setAttribute('aria-checked', 'false')
              s.setAttribute('tabindex', '0')
              s.setAttribute('onclick', 'void 0')
              s.setAttribute('data-bench-id', 'late')
              s.textContent = 'Late option'
              document.querySelector('main')?.append(s)
            }),
        },
        false,
      )
      try {
        const r = await d.run
        expect(d.fired()).toBe(true)
        expect(r.domElements.map((e) => e.attributes['data-bench-id'])).toContain('late')
        expect(gapsOf(r)).toEqual({})
      } finally {
        await d.context.close()
      }
    })

    // Nothing throws: the crawled nodes are gone before their boxes are read, and the walk runs on another window.
    it('flags nothing and refuses the walk when the document is replaced just after the tree read', async () => {
      const d = await detect(CONTROLS, { when: 'after', match: isAxRead, act: reload })
      try {
        const r = await d.run
        expect(d.fired()).toBe(true)
        expect(gapsOf(r)).toEqual({})
        expect(r.keyboard).toMatchObject({ notFocusableAssessed: false, unassessedReasons: ['document-replaced'] })
      } finally {
        await d.context.close()
      }
    })

    // The same-window twin: the marker survives, so only the crawled nodes gone before their box read refuse the walk.
    it('flags nothing and refuses the walk when the page re-mounts just after the tree read', async () => {
      const d = await detect(WITH_DEFECT, { when: 'after', match: isAxRead, act: remount })
      try {
        const r = await d.run
        expect(d.fired()).toBe(true)
        expect(gapsOf(r)).toEqual({})
        expect(r.keyboard).toMatchObject({ notFocusableAssessed: false, unassessedReasons: ['crawled-nodes-detached'] })
      } finally {
        await d.context.close()
      }
    })

    // Guard for the new order's own window (crawl, then tree read): a control removed in between has no box.
    it('does not report a crawled control removed just before the tree read', async () => {
      const d = await detect(
        CONTROLS,
        {
          when: 'before',
          match: isAxRead,
          act: (page) => page.evaluate(() => document.querySelector('[data-bench-id="about"]')?.remove()),
        },
        false,
      )
      try {
        const r = await d.run
        expect(d.fired()).toBe(true)
        expect(gapsOf(r)).toEqual({})
      } finally {
        await d.context.close()
      }
    })
  })

  // A crashed renderer answers no command on the detector's own CDP sessions, so without a crash abort each of these
  // waits forever (probe: DOM.enable, Accessibility.getFullAXTree and the walk's Runtime.evaluate all hang).
  describe('a renderer crash fails the detection instead of hanging it', () => {
    const crash = async (page: Page): Promise<void> => {
      const session = await page.context().newCDPSession(page)
      // Never answered: the renderer that would reply is the one it kills.
      void session.send('Page.crash').catch(() => undefined)
      await page.waitForEvent('crash')
    }
    for (const [stage, match] of [
      ['before the crawl', (m: string) => m === 'DOM.enable'],
      ['before the accessibility-tree read', isAxRead],
      ['as the Tab walk starts', isWalkMarkerWrite],
    ] as const) {
      it(`rejects with the crash ${stage}`, { timeout: 15_000 }, async () => {
        const d = await detect(CONTROLS, { when: 'before', match, act: crash })
        try {
          await expect(d.run).rejects.toThrow(RENDERER_CRASHED)
          expect(d.fired()).toBe(true)
        } finally {
          await d.context.close()
        }
      })
    }

    it('leaves no crash listener on a page that does not crash', async () => {
      const d = await detect(CONTROLS, null)
      try {
        await d.run
        // Playwright keeps a crash listener of its own, so compare with a page the detector never ran on.
        const listeners = (p: Page): number => (p as unknown as NodeJS.EventEmitter).listenerCount('crash')
        expect(listeners(d.page)).toBe(listeners(await d.context.newPage()))
      } finally {
        await d.context.close()
      }
    })
  })
})
