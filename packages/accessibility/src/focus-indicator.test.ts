import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { Page } from 'playwright'
import { BrowserClient, BrowserPage } from '@at-agent/browser'
import { RENDERER_CRASHED } from './renderer-crash.js'
import {
  runTabWalk,
  type FocusRead,
  type StepIndicator,
  type StyleChange,
  type TabWalkResult,
  type TabWalkStep,
} from './tab-walk.js'
import {
  checkFocusIndicator,
  judgeFocusIndicator,
  FocusIndicatorOptionsSchema,
  FocusIndicatorResultSchema,
  type ElementIndicator,
  type FocusIndicatorOptions,
  type FocusIndicatorResult,
  type ScreenshotEvidence,
} from './focus-indicator.js'

const FAST = 20
// Dev material only (never bench/corpus/test): the static dev-corpus bases.
const DEV_BASES = join(dirname(fileURLToPath(import.meta.url)), '../../../bench/corpus/dev/base')

const doc = (title: string, style: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${style}</style></head><body>\n${body}\n</body></html>`

function elements(result: FocusIndicatorResult): ElementIndicator[] {
  return result.components.flatMap((c) => c.elements)
}

function element(result: FocusIndicatorResult, id: string): ElementIndicator {
  const found = elements(result).find((e) => e.id === id)
  if (!found) throw new Error(`no finding for #${id}`)
  return found
}

const keys = (e: ElementIndicator): string[] => e.differences.map((d) => `${d.target}:${d.property}`)

// Reviewer fixtures (verify-p2a/G4): visible indicators outside the first attempt's 20 compared properties.
const OUTLINE_OFF = 'a, button { outline: none !important }'
const LINKS = '<a id="a1" class="u" href="#1">One</a> <a id="a2" class="u" href="#2">Two</a>'
const UNDERLINE = `.u { position: relative; display: inline-block; margin: 8px }
.u::after { content: ''; position: absolute; left: 0; bottom: -2px; width: 100%; height: 2px; background-color: rgb(0, 0, 255) }`
const REVEALED: [string, string, string, string][] = [
  [
    'Y1 ::after underline revealed by transform scaleX(0 -> 1)',
    `${UNDERLINE} .u::after { transform: scaleX(0) } .u:focus::after { transform: scaleX(1) }`,
    LINKS,
    'after:transform',
  ],
  [
    'Y2 ::after underline revealed by opacity (0 -> 1)',
    `${UNDERLINE} .u::after { opacity: 0 } .u:focus::after { opacity: 1 }`,
    LINKS,
    'after:opacity',
  ],
  [
    'Y3 ::after underline revealed by width (0 -> 100%)',
    `${UNDERLINE} .u::after { width: 0 } .u:focus::after { width: 100% }`,
    LINKS,
    'after:width',
  ],
  ['Y4 font-weight bold on focus', '.u:focus { font-weight: 700 }', LINKS, 'element:font-weight'],
  [
    'Y5 button grows: transform scale(1.15) on focus',
    'button:focus { transform: scale(1.15) }',
    '<button id="a1" type="button">One</button> <button id="a2" type="button">Two</button>',
    'element:transform',
  ],
  [
    'Y6 gradient underline via background-size (0 -> 100%)',
    `.u { text-decoration: none; background-image: linear-gradient(rgb(0,0,255), rgb(0,0,255)); background-repeat: no-repeat;
  background-position: 0 100%; background-size: 0% 2px } .u:focus { background-size: 100% 2px }`,
    LINKS,
    'element:background-size',
  ],
  [
    'Y7 ::after revealed by visibility',
    `${UNDERLINE} .u::after { visibility: hidden } .u:focus::after { visibility: visible }`,
    LINKS,
    'after:visibility',
  ],
]

const CARD = `.card { border: 2px solid #ddd; padding: 8px; margin: 4px }
.card:focus-within { border-color: rgb(0, 95, 204) }
.card a:focus { outline: none }`

// Reviewer fixtures (verify-p2a2/G4b mine.mts, mine2.mts): visible indicators the CSS diff cannot see.
const RING = `button { outline: none; position: relative; margin: 6px }
button .r { position: absolute; inset: -4px; border: 2px solid rgb(0, 0, 255); display: none } button.f .r { display: block }`
const ringButtons = (p: string, add: string, remove: string): string =>
  `<button id="${p}1" type="button"><span class="r"></span>One</button> <button id="${p}2" type="button"><span class="r"></span>Two</button>
<script>for (const b of document.querySelectorAll('button')) {
  b.addEventListener('focus', () => { ${add} }); b.addEventListener('blur', () => { ${remove} }) }</script>`
const DEEP_CARD = `.card { border: 2px solid #ddd; padding: 16px; margin: 8px; width: 260px } .card a { outline: none }
.card:focus-within { border-color: rgb(0, 95, 204); box-shadow: 0 0 0 3px rgba(0, 95, 204, .5) }`
const deepCard = (id: string): string =>
  `<article class="card"><div class="body"><header><h3><a id="${id}" href="#${id}">Card</a></h3></header><p>Text text text</p></div></article>`
const FLYING_RING = `a { outline: none; margin: 10px; display: inline-block }
#ring { position: absolute; border: 2px solid rgb(0, 0, 255); pointer-events: none; display: none }`
// Moves the ring onto whatever takes focus and never hides it.
const FLYING_SCRIPT = `<div id="ring"></div><script>const ring = document.getElementById('ring')
document.addEventListener('focusin', (e) => { const r = e.target.getBoundingClientRect(); Object.assign(ring.style, { display: 'block',
  left: (r.left + scrollX - 4) + 'px', top: (r.top + scrollY - 4) + 'px', width: (r.width + 4) + 'px', height: (r.height + 4) + 'px' }) })</script>`
// A :focus-within animation on the card four levels up, starting from the given box-shadow.
const GLOW = (from: string): string => `.card { border: 2px solid #ddd; padding: 16px; margin: 8px; width: 260px }
.card a { outline: none } .card:focus-within { animation: glow 1s infinite alternate }
@keyframes glow { from { box-shadow: ${from} } to { box-shadow: 0 0 0 6px rgb(0, 95, 204) } }`
const CHILD_COLOUR = (cls: string): string =>
  `.${cls} { outline: none; text-decoration: none } .${cls} .t { color: rgb(85, 85, 85) } .${cls}:focus .t { color: rgb(204, 0, 0) }`

// The 20 ms walk outruns the 50/100 ms timers of A3/A4, so it leaves their rings on blurred buttons; blurring the
// element again in the check runs the page's blur handler, which clears the ring, and shows the change.
const PIXEL_ONLY: [string, string, string, string][] = [
  [
    'A3 child ring added 50 ms after focus',
    RING,
    ringButtons('a3', `setTimeout(() => b.classList.add('f'), 50)`, `b.classList.remove('f')`),
    'a31',
  ],
  [
    'A4 child ring added 100 ms after focus',
    RING,
    ringButtons('a4', `setTimeout(() => b.classList.add('f'), 100)`, `b.classList.remove('f')`),
    'a41',
  ],
  [
    'N11 child ring removed 250 ms after blur',
    RING,
    ringButtons('db', `b.classList.add('f')`, `setTimeout(() => b.classList.remove('f'), 250)`),
    'db1',
  ],
  ['N8 :focus-within ring on the card four levels up', DEEP_CARD, deepCard('d1') + deepCard('d2'), 'd1'],
  [
    'N9 child bar 14 px left of the link',
    `nav { padding-left: 30px } nav a { position: relative; display: block; outline: none; margin: 6px 0 }
nav a .bar { position: absolute; left: -14px; top: 0; bottom: 0; width: 4px; background: rgb(0, 0, 255); opacity: 0 }
nav a:focus .bar { opacity: 1 }`,
    '<nav><a id="sb1" href="#1"><span class="bar"></span>Overview</a><a id="sb2" href="#2"><span class="bar"></span>Settings</a></nav>',
    'sb1',
  ],
  [
    'N7c icon beside the link wrapper, 12 px away, coloured via :focus-within',
    `a { outline: none } .ic { display: inline-block; width: 12px; height: 12px; background: rgb(200, 200, 200); margin-left: 12px }
.w:focus-within + .ic { background: rgb(0, 0, 255) }`,
    `<p><span class="w"><a id="w1" href="#1">Docs</a></span><span class="ic"></span></p>
<p><span class="w"><a id="w2" href="#2">API</a></span><span class="ic"></span></p>`,
    'w1',
  ],
  // The unfocused shots come first, while the ring still sits where focus was before.
  [
    'N10b script ring that follows focus and is never hidden',
    FLYING_RING,
    `<a id="g1" href="#1">One</a> <a id="g2" href="#2">Two</a>${FLYING_SCRIPT}`,
    'g1',
  ],
]

const STATIC_DEV_BASES = [
  'form.html',
  'good-operable.html',
  'identical-links.html',
  'js-handlers.html',
  'modal.html',
  'navbar.html',
  'three-links.html',
]

// Served through page.route so other.test is a real cross-origin frame.
const ROUTES_XO = {
  'focus.test/xo.html': doc(
    'Cross-origin',
    '',
    `<p><a id="light" href="#light">Light</a></p>
<iframe id="xo" src="http://other.test/frame.html"></iframe>
<p><a id="after" href="#after">After</a></p>`,
  ),
  'other.test/frame.html': doc('Frame', '', '<a id="c0" href="#c0">C0</a><a id="c1" href="#c1">C1</a>'),
}

const NO_SHOT_CHANGE = {
  status: 'compared',
  changedPixels: 0,
  unstablePixels: { unfocused: 0, focused: 0 },
  focusAnimation: false,
  error: null,
}

describe('checkFocusIndicator on a real walk (headless shell)', () => {
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

  async function run(pw: Page, options?: FocusIndicatorOptions): Promise<FocusIndicatorResult> {
    const walk = await runTabWalk(pw, { settleMs: FAST })
    expect(walk.error).toBeNull()
    const result = await checkFocusIndicator(pw, walk, options)
    expect(() => FocusIndicatorResultSchema.parse(result)).not.toThrow()
    return result
  }

  // The screenshot routine's focus and state calls run on the check's own CDP session, which a crashed renderer never
  // answers; without a crash abort they wait forever.
  it(
    'rejects with the crash when the renderer dies as the check moves focus, instead of hanging',
    { timeout: 15_000 },
    async () => {
      const page = await client.newPage()
      pages.push(page)
      const pw = page.playwrightPage
      await pw.setContent(
        doc('Crash', 'input:focus { outline: none }', '<input id="t1" aria-label="A"> <input id="t2" aria-label="B">'),
        { waitUntil: 'load' },
      )
      const walk = await runTabWalk(pw, { settleMs: FAST })
      const session = await pw.context().newCDPSession(pw)
      // Page.crash is never answered: the renderer that would reply is the one it kills.
      await pw.exposeFunction('crashRenderer', () => void session.send('Page.crash').catch(() => undefined))
      await pw.evaluate(() => {
        const crash = (): void => (window as unknown as { crashRenderer: () => void }).crashRenderer()
        document.addEventListener('focusin', crash, { once: true })
      })
      await expect(checkFocusIndicator(pw, walk)).rejects.toThrow(RENDERER_CRASHED)
    },
  )

  async function check(html: string, options?: FocusIndicatorOptions): Promise<FocusIndicatorResult> {
    const page = await client.newPage()
    pages.push(page)
    await page.playwrightPage.setContent(html, { waitUntil: 'load' })
    return run(page.playwrightPage, options)
  }

  async function serve(routes: Record<string, string>, path: string): Promise<FocusIndicatorResult> {
    const page = await client.newPage()
    pages.push(page)
    const pw = page.playwrightPage
    await pw.route(/^http:\/\/(focus|other)\.test\//, (route) => {
      const url = new URL(route.request().url())
      const body = routes[url.host + url.pathname]
      return body === undefined
        ? route.fulfill({ status: 404, body: '' })
        : route.fulfill({ contentType: 'text/html', body })
    })
    await pw.goto(`http://focus.test${path}`, { waitUntil: 'load' })
    return run(pw)
  }

  it('default browser focus ring -> present from the CSS diff, page pass', async () => {
    const result = await check(
      doc('Default ring', '', '<a id="x" href="#x">X</a> <button id="y" type="button">Y</button>'),
    )

    expect(element(result, 'x')).toMatchObject({
      indicator: 'present',
      evidence: 'css',
      screenshot: null,
    })
    expect(element(result, 'y')).toMatchObject({
      indicator: 'present',
      evidence: 'css',
    })
    expect(element(result, 'x').differences).toContainEqual({
      target: 'element',
      property: 'outline-style',
      focused: 'auto',
      unfocused: 'none',
    })
    expect(result.verdict).toBe('pass')
    expect(result.counts).toEqual({ present: 2, absent: 0, undetermined: 0 })
    expect(result.crossOriginUndetermined).toBe(0)
  })

  it('outline:none + box-shadow on :focus -> present', async () => {
    const result = await check(
      doc(
        'Box shadow',
        'a:focus { outline: none; box-shadow: 0 0 0 3px rgb(0, 0, 255) }',
        '<a id="x" href="#x">X</a> <a id="y" href="#y">Y</a>',
      ),
    )

    expect(keys(element(result, 'x'))).toEqual(['element:box-shadow'])
    expect(result.verdict).toBe('pass')
  })

  it(':focus-visible custom outline -> present', async () => {
    const result = await check(
      doc(
        'Focus visible',
        'a:focus { outline: none } a:focus-visible { outline: 3px solid rgb(255, 165, 0) }',
        '<a id="x" href="#x">X</a> <a id="y" href="#y">Y</a>',
      ),
    )

    expect(element(result, 'x').differences).toContainEqual({
      target: 'element',
      property: 'outline-color',
      focused: 'rgb(255, 165, 0)',
      unfocused: 'rgb(0, 0, 238)',
    })
    expect(result.verdict).toBe('pass')
  })

  it('::after underline on :focus -> present (restyled and focus-only pseudo-elements)', async () => {
    const result = await check(
      doc(
        'After underline',
        `a { outline: none }
.u::after { content: ''; display: block; height: 2px; background-color: transparent }
.u:focus::after { background-color: rgb(0, 0, 255) }
#u2:focus::after { content: ''; display: block; border-bottom: 2px solid rgb(0, 0, 255) }`,
        '<a id="u1" class="u" href="#1">One</a> <a id="u2" href="#2">Two</a>',
      ),
    )

    expect(element(result, 'u1').differences).toEqual([
      {
        target: 'after',
        property: 'background-color',
        focused: 'rgb(0, 0, 255)',
        unfocused: 'rgba(0, 0, 0, 0)',
      },
    ])
    // The block ::after also makes the body taller, so height changes on the ancestors come with it.
    expect(element(result, 'u2').differences).toContainEqual({
      target: 'after',
      property: 'content',
      focused: '""',
      unfocused: 'none',
    })
    expect(result.verdict).toBe('pass')
  })

  it('background-color change only -> present', async () => {
    const result = await check(
      doc(
        'Background only',
        'a:focus { outline: none; background-color: rgb(255, 255, 0) }',
        '<a id="x" href="#x">X</a> <a id="y" href="#y">Y</a>',
      ),
    )

    expect(element(result, 'x').differences).toEqual([
      {
        target: 'element',
        property: 'background-color',
        focused: 'rgb(255, 255, 0)',
        unfocused: 'rgba(0, 0, 0, 0)',
      },
    ])
    expect(result.verdict).toBe('pass')
  })

  it('element whose blur handler removes it -> undetermined (removed), page undetermined', async () => {
    const result = await check(
      doc(
        'Removed',
        '',
        `<a id="r0" href="#r0">R0</a>
<a id="gone" href="#g" onfocus="this.addEventListener('blur', () => this.remove(), { once: true })">Gone</a>
<a id="r2" href="#r2">R2</a>`,
      ),
    )

    expect(element(result, 'gone')).toMatchObject({
      indicator: 'undetermined',
      reason: 'removed',
      comparedVisits: 0,
      differences: [],
      screenshot: null,
    })
    expect(element(result, 'r0').indicator).toBe('present')
    expect(result.verdict).toBe('undetermined')
    expect(result.counts).toEqual({ present: 2, absent: 0, undetermined: 1 })
  })

  it('focus trapped on one element -> undetermined (never unfocused), page undetermined', async () => {
    const page = await client.newPage()
    pages.push(page)
    const pw = page.playwrightPage
    await pw.setContent(
      doc(
        'Trap',
        '',
        `<a id="t1" href="#one">One</a>
<input id="trap" type="text" aria-label="Trap">
<a id="t3" href="#three">Three</a>
<script>document.getElementById('trap').addEventListener('keydown', (e) => { if (e.key === 'Tab') e.preventDefault() })</script>`,
      ),
      { waitUntil: 'load' },
    )
    const walk = await runTabWalk(pw, { settleMs: FAST })
    const result = await checkFocusIndicator(pw, walk)

    expect(walk.suspectedTrap).toBe(true)
    expect(element(result, 'trap')).toMatchObject({
      indicator: 'undetermined',
      reason: 'never-unfocused',
    })
    expect(element(result, 't1').indicator).toBe('present')
    expect(elements(result).map((e) => e.id)).not.toContain('t3')
    expect(result.verdict).toBe('undetermined')
  })

  describe('fix 1: full computed style of the element, its pseudo-elements, 3 ancestors and 2 siblings', () => {
    it.each(REVEALED)('%s -> present from the CSS diff, page pass', async (_, css, body, key) => {
      const result = await check(doc('Revealed', `${OUTLINE_OFF} ${css}`, body))

      for (const id of ['a1', 'a2']) {
        expect(element(result, id)).toMatchObject({
          indicator: 'present',
          evidence: 'css',
        })
        expect(keys(element(result, id))).toContain(key)
      }
      expect(result.verdict).toBe('pass')
    })

    it('F3a card border via :focus-within on the direct parent -> present, page pass', async () => {
      const result = await check(
        doc(
          'F3a',
          CARD,
          '<div class="card"><a id="c1" href="#c1">Card one</a></div><div class="card"><a id="c2" href="#c2">Card two</a></div>',
        ),
      )

      expect(element(result, 'c1')).toMatchObject({
        indicator: 'present',
        evidence: 'css',
      })
      expect(keys(element(result, 'c1'))).toContain('parent:border-top-color')
      expect(result.verdict).toBe('pass')
    })

    it('F3b card border via :focus-within on the grandparent -> present, page pass', async () => {
      const result = await check(
        doc(
          'F3b',
          CARD,
          `<article class="card"><h3><a id="g1" href="#g1">Card one</a></h3><p>Text</p></article>
<article class="card"><h3><a id="g2" href="#g2">Card two</a></h3><p>Text</p></article>`,
        ),
      )

      for (const id of ['g1', 'g2']) {
        expect(element(result, id)).toMatchObject({
          indicator: 'present',
          evidence: 'css',
        })
        expect(keys(element(result, id))).toContain('grandparent:border-top-color')
        expect(element(result, id).differences.every((d) => d.target === 'grandparent')).toBe(true)
      }
      expect(result.verdict).toBe('pass')
    })

    it('X5 ring drawn by the next sibling (input:focus + span) -> present, page pass', async () => {
      const result = await check(
        doc(
          'X5',
          `input { outline: none } .ring { display:inline-block; width: 10px; height: 10px }
input:focus + .ring { background-color: rgb(0, 0, 255) }`,
          '<input id="s1" aria-label="S1"><span class="ring"></span> <input id="s2" aria-label="S2"><span class="ring"></span>',
        ),
      )

      for (const id of ['s1', 's2']) {
        expect(element(result, id).indicator).toBe('present')
        expect(keys(element(result, id))).toEqual(['next-sibling:background-color'])
      }
      expect(result.verdict).toBe('pass')
    })

    it("a neighbour's own focus ring in the unfocused read is not the element's indicator", async () => {
      const result = await check(
        doc(
          'F2',
          'a.bare:focus, a.bare:focus-visible { outline: none }',
          '<a id="l1" class="bare" href="#one">One</a><button id="ok" type="button">OK</button>',
        ),
      )

      expect(element(result, 'l1')).toMatchObject({
        indicator: 'absent',
        differences: [],
      })
      expect(element(result, 'ok').indicator).toBe('present')
      expect(result.verdict).toBe('fail')
    })

    it("a previous sibling's ring still fading out when the element is read is not the element's indicator", async () => {
      const result = await check(
        doc(
          'Transition tail',
          `a.slow { transition: box-shadow 2s linear } a.slow:focus { outline: none; box-shadow: 0 0 0 3px rgb(0, 0, 255) }
a.bare:focus { outline: none }`,
          '<a id="p" class="slow" href="#p">P</a> <a id="q" class="bare" href="#q">Q</a>',
        ),
      )

      expect(element(result, 'p').differences).toEqual([
        {
          target: 'element',
          property: 'box-shadow',
          focused: 'rgb(0, 0, 255) 0px 0px 0px 3px',
          unfocused: 'none',
        },
      ])
      expect(element(result, 'q')).toMatchObject({
        indicator: 'absent',
        differences: [],
      })
      expect(result.verdict).toBe('fail')
    })
  })

  describe('fix 2: the unfocused read waits until neither :focus nor :focus-within matches', () => {
    it('X3 focusable region styled by :focus-within, next Tab goes into its child -> present, page pass', async () => {
      const result = await check(
        doc(
          'X3',
          `.region:focus-within { outline: 3px solid rgb(0, 0, 255) }
.region a:focus { outline: 2px solid rgb(255, 0, 0) }`,
          `<div id="reg" class="region" tabindex="0">Scroll region <a id="inner" href="#in">Inner link</a></div>
<a id="out" href="#out">Outside</a>`,
        ),
      )

      expect(element(result, 'reg')).toMatchObject({
        indicator: 'present',
        evidence: 'css',
      })
      expect(element(result, 'reg').comparedVisits).toBeGreaterThan(0)
      expect(keys(element(result, 'reg'))).toContain('element:outline-style')
      expect(result.verdict).toBe('pass')
    })
  })

  describe('fix 3: box-shadow layers that draw nothing are not an indicator', () => {
    it('X1 Tailwind focus:outline-none focus:ring-0 input -> absent, page fail', async () => {
      const result = await check(
        doc(
          'X1',
          `input { border: 1px solid rgb(204, 204, 204); padding: 4px }
input:focus { outline: 2px solid transparent; outline-offset: 2px;
  box-shadow: 0 0 #0000, 0 0 0 0px rgb(59 130 246 / 0.5), 0 0 #0000 }`,
          '<input id="t1" aria-label="A"> <input id="t2" aria-label="B">',
        ),
      )

      expect(element(result, 't1')).toMatchObject({
        indicator: 'absent',
        evidence: 'screenshot',
        differences: [],
        screenshot: NO_SHOT_CHANGE,
      })
      expect(result.verdict).toBe('fail')
    })

    it('X2 transparent box-shadow with outline:none -> absent, page fail', async () => {
      const result = await check(
        doc(
          'X2',
          'a:focus { outline: none; box-shadow: 0 0 0 3px transparent }',
          '<a id="x1" href="#1">One</a> <a id="x2" href="#2">Two</a>',
        ),
      )

      expect(element(result, 'x1')).toMatchObject({
        indicator: 'absent',
        evidence: 'screenshot',
        differences: [],
        screenshot: NO_SHOT_CHANGE,
      })
      expect(result.verdict).toBe('fail')
    })
  })

  describe('fix 4: a change unrelated to focus is not an indicator', () => {
    it('X4 outline:none links with an infinite colour animation -> absent, page fail', async () => {
      const result = await check(
        doc(
          'X4',
          `@keyframes pulse { 0% { color: rgb(0, 0, 0) } 100% { color: rgb(255, 0, 0) } }
a { animation: pulse 0.37s infinite alternate linear } a:focus { outline: none }`,
          '<a id="an1" href="#1">One</a> <a id="an2" href="#2">Two</a>',
        ),
      )

      // The animation runs in both states, so the shots stop it and it is not a focus change.
      expect(element(result, 'an1')).toMatchObject({
        indicator: 'absent',
        evidence: 'screenshot',
        differences: [],
        screenshot: NO_SHOT_CHANGE,
      })
      // an1's animation, seen as an2's previous sibling, is not an2's indicator either.
      expect(element(result, 'an2')).toMatchObject({
        evidence: null,
        differences: [],
      })
      expect(result.verdict).toBe('fail')
    })
  })

  describe('fix 5: absent needs no CSS difference and no changed pixel in whole-viewport shots', () => {
    it('outline:none and nothing else -> absent, page fail; all four shots share one viewport and scroll', async () => {
      const result = await check(doc('Absent', 'a:focus { outline: none }', '<p><a id="x" href="#x">X</a></p>'))

      expect(element(result, 'x')).toMatchObject({
        indicator: 'absent',
        reason: null,
        evidence: 'screenshot',
        differences: [],
        screenshot: {
          ...NO_SHOT_CHANGE,
          view: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
        },
      })
      expect(result.verdict).toBe('fail')
    })

    it.each(PIXEL_ONLY)('%s -> present from the whole-viewport shots, nothing absent', async (_, css, body, id) => {
      const result = await check(doc('Pixels', css, body))

      expect(element(result, id)).toMatchObject({
        indicator: 'present',
        reason: null,
        evidence: 'screenshot',
        differences: [],
        screenshot: {
          status: 'compared',
          unstablePixels: { unfocused: 0, focused: 0 },
          error: null,
        },
      })
      expect(element(result, id).screenshot?.changedPixels).toBeGreaterThanOrEqual(4)
      expect(result.counts.absent).toBe(0)
      expect(result.verdict).not.toBe('fail')
    })

    it('C4b a single card with its ring four levels up, beside a default-ring button -> page pass', async () => {
      const result = await check(
        doc('C4b', DEEP_CARD, `${deepCard('c43')}<button id="other" type="button">Other</button>`),
      )

      expect(element(result, 'c43')).toMatchObject({
        indicator: 'present',
        evidence: 'screenshot',
      })
      expect(element(result, 'other')).toMatchObject({
        indicator: 'present',
        evidence: 'css',
      })
      expect(result.verdict).toBe('pass')
    })

    it('indicator drawn by a script-positioned overlay elsewhere in the DOM -> present from pixels', async () => {
      const result = await check(
        doc(
          'Overlay',
          'a { outline: none } #ring { position: absolute; border: 2px solid rgb(0, 0, 255); pointer-events: none; display: none }',
          `<p><a id="o1" class="one" href="#1">One</a></p><p><a id="o2" class="two" href="#2">Two</a></p>
<div id="ring"></div>
<script>
const ring = document.getElementById('ring')
document.addEventListener('focusin', (e) => {
  const r = e.target.getBoundingClientRect()
  Object.assign(ring.style, { display: 'block', left: (r.left + scrollX - 4) + 'px', top: (r.top + scrollY - 4) + 'px',
    width: (r.width + 4) + 'px', height: (r.height + 4) + 'px' })
})
document.addEventListener('focusout', () => { ring.style.display = 'none' })
</script>`,
        ),
      )

      for (const id of ['o1', 'o2']) {
        const e = element(result, id)
        expect(e).toMatchObject({
          indicator: 'present',
          evidence: 'screenshot',
          differences: [],
          screenshot: {
            status: 'compared',
            unstablePixels: { unfocused: 0, focused: 0 },
          },
        })
        expect(e.screenshot?.changedPixels).toBeGreaterThan(0)
      }
      expect(result.verdict).toBe('pass')
    })

    it('an overlay ring drawn only when focus follows a Tab keydown -> present from pixels, not absent', async () => {
      const html = doc(
        'Keydown ring',
        FLYING_RING,
        `<p><a id="k1" class="one" href="#1">One</a></p><p><a id="k2" class="two" href="#2">Two</a></p>
<div id="ring"></div>
<script>
const ring = document.getElementById('ring')
let tabAt = 0
document.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabAt = Date.now() }, true)
document.addEventListener('focusin', (e) => {
  if (Date.now() - tabAt > 100) return
  const r = e.target.getBoundingClientRect()
  Object.assign(ring.style, { display: 'block', left: (r.left + scrollX - 4) + 'px', top: (r.top + scrollY - 4) + 'px',
    width: (r.width + 4) + 'px', height: (r.height + 4) + 'px' })
})
document.addEventListener('focusout', () => { ring.style.display = 'none' })
</script>`,
      )
      // A keyboard user sees the ring (checked on a page of its own: the script's globals cannot load twice).
      const probe = await client.newPage()
      pages.push(probe)
      await probe.playwrightPage.setContent(html, { waitUntil: 'load' })
      await probe.playwrightPage.keyboard.press('Tab')
      expect(await probe.playwrightPage.evaluate(() => document.getElementById('ring')?.style.display)).toBe('block')

      const result = await check(html)
      for (const id of ['k1', 'k2']) {
        expect(element(result, id)).toMatchObject({ indicator: 'present', evidence: 'screenshot' })
      }
      expect(result.verdict).toBe('pass')
    })

    it('screenshots elements inside a same-origin frame, an open shadow root and below the fold', async () => {
      const frame = '<style>a:focus { outline: none }</style><a id="f0" href="#f0">F0</a>'
      const result = await check(
        doc(
          'Boundaries',
          'a.far:focus { outline: none }',
          `<p><a id="light" href="#light">Light</a></p>
<iframe id="frame" srcdoc="${frame.replaceAll('"', '&quot;')}"></iframe>
<div id="host"></div>
<div style="height: 2000px"></div>
<p><a id="far" class="far" href="#far">Far</a></p>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
  '<style>a:focus { outline: none }</style><a id="s0" class="shadow" href="#s0">S0</a>'</script>`,
        ),
      )

      expect(element(result, 'light')).toMatchObject({
        indicator: 'present',
        evidence: 'css',
      })
      for (const id of ['f0', 's0', 'far']) {
        expect(element(result, id)).toMatchObject({
          indicator: 'absent',
          evidence: 'screenshot',
          screenshot: NO_SHOT_CHANGE,
        })
      }
      // The far link was scrolled into view once, and every shot of it kept that scroll.
      expect(element(result, 'far').screenshot?.view?.scrollY).toBeGreaterThan(1000)
      expect(result.verdict).toBe('fail')
    })

    it('one screenshot per component, capped per page; the rest are undetermined (screenshot-cap)', async () => {
      const result = await check(
        doc(
          'Cap',
          'a:focus, button:focus { outline: none }',
          `<a id="x1" class="x" href="#1">One</a> <a id="x2" class="x" href="#2">Two</a>
<button id="y1" class="y" type="button">Three</button>`,
        ),
        { maxScreenshotComponents: 1 },
      )

      expect(element(result, 'x1')).toMatchObject({
        indicator: 'absent',
        evidence: 'screenshot',
      })
      for (const id of ['x2', 'y1']) {
        expect(element(result, id)).toMatchObject({
          indicator: 'undetermined',
          reason: 'screenshot-cap',
          evidence: null,
          screenshot: { status: 'capped' },
        })
      }
      expect(result.counts).toEqual({ present: 0, absent: 1, undetermined: 2 })
      expect(result.verdict).toBe('fail')
    })

    it('pixels that change on their own -> undetermined (screenshot-unstable)', async () => {
      const result = await check(
        doc(
          'Unstable',
          'a.blink { outline: none }',
          `<a id="blink" class="blink" href="#b">Blink</a> <a id="ok" href="#ok">OK</a>
<script>
const blink = document.getElementById('blink')
// Red ramps 1 per 2 ms: shots 22-490 ms apart always differ by more than the pixel threshold.
setInterval(() => { blink.style.backgroundColor = 'rgb(' + (Math.floor(performance.now() / 2) % 256) + ', 0, 0)' }, 5)
</script>`,
        ),
      )

      expect(element(result, 'blink')).toMatchObject({
        indicator: 'undetermined',
        reason: 'screenshot-unstable',
      })
      expect(element(result, 'blink').screenshot?.unstablePixels?.unfocused).toBeGreaterThan(0)
      expect(element(result, 'ok').indicator).toBe('present')
      expect(result.verdict).toBe('undetermined')
    })

    it('focus that comes back to the element when it is blurred -> undetermined (screenshot-failed), not absent', async () => {
      const result = await check(
        doc(
          'Refocus',
          CHILD_COLOUR('back'),
          `<a id="back" class="back" href="#1"><span class="t">Back</span></a> <a id="l2" href="#2">Two</a> <a id="l3" href="#3">Three</a>
<script>const back = document.getElementById('back')
back.addEventListener('blur', (e) => { if (!e.relatedTarget) setTimeout(() => back.focus(), 0) })</script>`,
        ),
      )

      expect(element(result, 'back')).toMatchObject({
        indicator: 'undetermined',
        reason: 'screenshot-failed',
        screenshot: { status: 'failed' },
      })
      expect(element(result, 'back').screenshot?.error).toMatch(/unfocused/)
      expect(result.verdict).toBe('undetermined')
    })

    it('an element that drops focus 200 ms after taking it -> undetermined (screenshot-failed), not absent', async () => {
      const result = await check(
        doc(
          'Drop',
          CHILD_COLOUR('drop'),
          `<a id="drop" class="drop" href="#1"><span class="t">Drop</span></a> <a id="m2" href="#2">Two</a>
<script>const drop = document.getElementById('drop')
drop.addEventListener('focus', () => setTimeout(() => { if (document.activeElement === drop) drop.blur() }, 200))</script>`,
        ),
      )

      expect(element(result, 'drop')).toMatchObject({
        indicator: 'undetermined',
        reason: 'screenshot-failed',
      })
      expect(element(result, 'drop').screenshot?.error).toMatch(/focused/)
    })

    it('a page that scrolls when the element takes focus -> undetermined (screenshot-failed)', async () => {
      const result = await check(
        doc(
          'Scroll on focus',
          CHILD_COLOUR('jump'),
          `<div style="height: 1200px"></div><a id="jump" class="jump" href="#1"><span class="t">Jump</span></a>
<div style="height: 1200px"></div><a id="k2" href="#2">Two</a>
<script>document.getElementById('jump').addEventListener('focus', () => scrollBy(0, 40))</script>`,
        ),
      )

      expect(element(result, 'jump')).toMatchObject({
        indicator: 'undetermined',
        reason: 'screenshot-failed',
      })
      expect(element(result, 'jump').screenshot?.error).toMatch(/scroll/)
    })

    it('an infinite glow that focus starts four levels up -> present: each shot holds it at its first frame', async () => {
      const result = await check(
        doc(
          'Glow',
          GLOW('0 0 0 3px rgb(0, 95, 204)'),
          `${deepCard('p1')}<button id="other" type="button">Other</button>`,
        ),
      )

      expect(element(result, 'p1')).toMatchObject({
        indicator: 'present',
        evidence: 'screenshot',
        screenshot: { status: 'compared', unstablePixels: { unfocused: 0, focused: 0 }, focusAnimation: true },
      })
      expect(result.verdict).toBe('pass')
    })

    it('an infinite pulse that focus starts, blank at its first frame -> undetermined (focus-animation), not absent', async () => {
      const result = await check(
        doc(
          'Pulse',
          GLOW('0 0 0 0 rgba(0, 95, 204, 0)'),
          `${deepCard('p1')}<button id="other" type="button">Other</button>`,
        ),
      )

      expect(element(result, 'p1')).toMatchObject({
        indicator: 'undetermined',
        reason: 'focus-animation',
        evidence: null,
        screenshot: { status: 'compared', changedPixels: 0, focusAnimation: true },
      })
      expect(result.verdict).toBe('undetermined')
    })
  })

  describe('one colour policy for the CSS diff and the pixels (threshold 10 per channel)', () => {
    it('N1a text colour one step bluer on focus -> absent by both paths, page fail', async () => {
      const result = await check(
        doc(
          'N1a',
          'nav a { color: rgb(0, 0, 200); outline: none } nav a:focus { color: rgb(0, 0, 201) }',
          '<nav><a id="n1" href="#1">Home</a> <a id="n2" href="#2">About</a> <a id="n3" href="#3">Contact</a></nav>',
        ),
      )

      expect(element(result, 'n1')).toMatchObject({
        indicator: 'absent',
        evidence: 'screenshot',
        differences: [],
        screenshot: NO_SHOT_CHANGE,
      })
      expect(result.verdict).toBe('fail')
    })

    it('text colour ten steps bluer on focus -> present from the CSS diff', async () => {
      const result = await check(
        doc(
          'Ten steps',
          'a { color: rgb(0, 0, 200); outline: none } a:focus { color: rgb(0, 0, 210) }',
          '<a id="t1" href="#1">One</a> <a id="t2" href="#2">Two</a>',
        ),
      )

      expect(element(result, 't1')).toMatchObject({
        indicator: 'present',
        evidence: 'css',
      })
      expect(keys(element(result, 't1'))).toContain('element:color')
      expect(result.verdict).toBe('pass')
    })
  })

  describe('known limitations: misses, and the one false absent a settle cannot cover', () => {
    it('N2a outline in the page background colour -> present by CSS (a miss)', async () => {
      const result = await check(
        doc(
          'N2a',
          'body { background: rgb(255, 255, 255) } button { outline: none } button:focus { outline: 2px solid rgb(255, 255, 255); outline-offset: 2px }',
          '<button id="sb1" type="button">Save</button>',
        ),
      )

      expect(element(result, 'sb1')).toMatchObject({
        indicator: 'present',
        evidence: 'css',
      })
    })

    it('a script ring left on the only element when it blurs -> absent: both states show the same ring', async () => {
      const result = await check(doc('Stuck ring', FLYING_RING, `<a id="solo" href="#1">Solo</a>${FLYING_SCRIPT}`))

      expect(element(result, 'solo')).toMatchObject({
        indicator: 'absent',
        evidence: 'screenshot',
        screenshot: NO_SHOT_CHANGE,
      })
    })

    it('a ring drawn 1 s after focus -> absent with the default 300 ms settle, present with a 1400 ms one', async () => {
      const html = doc(
        'Late ring',
        RING,
        ringButtons(
          'late',
          `b.dataset.t = setTimeout(() => b.classList.add('f'), 1000)`,
          `clearTimeout(Number(b.dataset.t)); b.classList.remove('f')`,
        ),
      )

      expect(element(await check(html), 'late1')).toMatchObject({
        indicator: 'absent',
        evidence: 'screenshot',
      })
      expect(element(await check(html, { settleMs: 1400 }), 'late1')).toMatchObject({
        indicator: 'present',
        evidence: 'screenshot',
      })
    })
  })

  describe('dev corpus bases', () => {
    it.each(STATIC_DEV_BASES)('%s -> every element present from the CSS diff, page pass', async (file) => {
      const result = await check(readFileSync(join(DEV_BASES, file), 'utf8'))

      expect(result.counts.absent).toBe(0)
      expect(elements(result).every((e) => e.evidence === 'css' && e.screenshot === null)).toBe(true)
      expect(result.verdict).toBe('pass')
    })
  })

  describe('fix 6: page verdict', () => {
    it('a cross-origin frame stays undetermined but does not block a pass; its count is reported', async () => {
      const result = await serve(ROUTES_XO, '/xo.html')

      expect(element(result, 'xo')).toMatchObject({
        indicator: 'undetermined',
        reason: 'deep-unavailable',
        deepUnavailable: 'cross-origin',
      })
      expect(element(result, 'light').indicator).toBe('present')
      expect(element(result, 'after').indicator).toBe('present')
      expect(result.counts).toEqual({ present: 2, absent: 0, undetermined: 1 })
      expect(result.crossOriginUndetermined).toBe(1)
      expect(result.verdict).toBe('pass')
    })
  })
})

// Hand-built walks for rules a fixture cannot isolate cheaply.
function change(
  target: StyleChange['target'],
  focused: Record<string, string> | null,
  unfocused: Record<string, string> | null,
): StyleChange {
  return { target, focused, unfocused }
}

function captured(changes: StyleChange[], drift: string[] | null = []): StepIndicator {
  return {
    unfocusedStatus: 'captured',
    unfocusedAt: 1,
    unfocusedError: null,
    changes,
    unfocusedDrift: drift,
  }
}

function pending(status: StepIndicator['unfocusedStatus']): StepIndicator {
  return { ...captured([]), unfocusedStatus: status, unfocusedDrift: null }
}

type Node = {
  backendNodeId: number
  tag?: string
  id?: string
  classAttr?: string | null
}

function read(node: Node | 'body' | 'frame-body' | 'cross-origin' | 'closed-shadow'): FocusRead {
  const base = {
    className: null,
    ariaLabel: null,
    nameAttr: null,
    nameProp: null,
    text: null,
    hasFocus: true,
    url: 'http://fixture.test/',
    deepUnavailable: null,
    part: null,
  }
  if (node === 'body') {
    const deep = {
      backendNodeId: 1,
      tag: 'body',
      id: null,
      isBody: true,
      classAttr: null,
    }
    return {
      ...base,
      backendNodeId: 1,
      tag: 'body',
      id: null,
      isBody: true,
      container: null,
      deep,
    }
  }
  if (node === 'frame-body') {
    const deep = {
      backendNodeId: 90,
      tag: 'body',
      id: null,
      isBody: true,
      classAttr: null,
    }
    return {
      ...base,
      backendNodeId: 9,
      tag: 'iframe',
      id: 'fr',
      isBody: false,
      container: 'iframe',
      deep,
    }
  }
  if (node === 'cross-origin' || node === 'closed-shadow') {
    const frame = node === 'cross-origin'
    return {
      ...base,
      backendNodeId: frame ? 8 : 7,
      tag: frame ? 'iframe' : 'div',
      id: frame ? 'xo' : 'closed',
      className: 'embed',
      isBody: false,
      container: frame ? 'iframe' : 'shadow-host',
      deep: null,
      deepUnavailable: frame ? 'cross-origin' : 'closed-shadow-root',
    }
  }
  const tag = node.tag ?? 'a'
  const id = node.id ?? null
  const deep = {
    backendNodeId: node.backendNodeId,
    tag,
    id,
    isBody: false,
    classAttr: node.classAttr ?? null,
  }
  return {
    ...base,
    backendNodeId: node.backendNodeId,
    tag,
    id,
    isBody: false,
    container: null,
    deep,
  }
}

function step(index: number, settled: FocusRead, indicator: StepIndicator | null): TabWalkStep {
  return {
    index,
    key: 'Tab',
    immediate: settled,
    settled,
    focusStyle: null,
    documentReplaced: false,
    wrapped: false,
    focusLost: false,
    indicator,
  }
}

function walkOf(steps: TabWalkStep[], error: TabWalkResult['error'] = null): TabWalkResult {
  return {
    direction: 'forward',
    focusableCount: 2,
    fIncomplete: false,
    fIncompleteCauses: { crossOriginFrames: 0, closedShadowRoots: 0 },
    defaultPresses: 20,
    presses: steps.length,
    settleMs: 0,
    launchFacts: { browserVersion: null, executableBasename: null },
    initial: read('body'),
    idle: null,
    focusableCountEnd: null,
    steps,
    suspectedTrap: error ? null : false,
    escapeProbe: null,
    error,
  }
}

function shot(evidence: Partial<ScreenshotEvidence>): ScreenshotEvidence {
  return {
    status: 'compared',
    view: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    changedPixels: 0,
    unstablePixels: { unfocused: 0, focused: 0 },
    focusAnimation: false,
    error: null,
    ...evidence,
  }
}

const NOT_COMPARED = {
  view: null,
  changedPixels: null,
  unstablePixels: null,
  focusAnimation: null,
}

const A: Node = { backendNodeId: 10, id: 'a' }
const B: Node = { backendNodeId: 11, id: 'b' }
const OUTLINE_NONE = {
  'outline-style': 'none',
  'outline-width': '0px',
  'outline-color': 'rgb(0, 0, 0)',
}
const NO_BORDER_TOP = {
  'border-top-style': 'none',
  'border-top-width': '0px',
  'border-top-color': 'rgb(0, 0, 0)',
}
const UNPAINTED = {
  'background-color': 'rgba(0, 0, 0, 0)',
  'background-image': 'none',
  'box-shadow': 'none',
  ...OUTLINE_NONE,
  ...NO_BORDER_TOP,
  'border-right-style': 'none',
  'border-right-width': '0px',
  'border-right-color': 'rgb(0, 0, 0)',
  'border-bottom-style': 'none',
  'border-bottom-width': '0px',
  'border-bottom-color': 'rgb(0, 0, 0)',
  'border-left-style': 'none',
  'border-left-width': '0px',
  'border-left-color': 'rgb(0, 0, 0)',
}
const SOLID_OUTLINE = { 'outline-style': 'solid', 'outline-width': '2px' }
const one = (
  target: StyleChange['target'],
  focused: Record<string, string>,
  unfocused: Record<string, string>,
  options?: FocusIndicatorOptions,
) => checkOne([change(target, focused, unfocused)], options)

function checkOne(changes: StyleChange[], options?: FocusIndicatorOptions): ElementIndicator {
  return element(judgeFocusIndicator(walkOf([step(1, read(A), captured(changes))]), new Map(), options), 'a')
}

describe('judgeFocusIndicator rules (hand-built walks)', () => {
  it.each([
    [
      'outline colour/offset change while no outline is drawn',
      change(
        'element',
        {
          ...OUTLINE_NONE,
          'outline-color': 'rgb(255, 0, 0)',
          'outline-offset': '2px',
        },
        { ...OUTLINE_NONE, 'outline-offset': '0px' },
      ),
    ],
    [
      'outline that is fully transparent',
      change(
        'element',
        {
          'outline-style': 'solid',
          'outline-width': '2px',
          'outline-color': 'rgba(0, 0, 0, 0)',
        },
        OUTLINE_NONE,
      ),
    ],
    [
      'border colour change on a side with no border',
      change('element', { ...NO_BORDER_TOP, 'border-top-color': 'rgb(255, 0, 0)' }, NO_BORDER_TOP),
    ],
    [
      'text-decoration colour change with no decoration line',
      change(
        'element',
        {
          'text-decoration-color': 'rgb(255, 0, 0)',
          'text-decoration-line': 'none',
        },
        {
          'text-decoration-color': 'rgb(0, 0, 0)',
          'text-decoration-line': 'none',
        },
      ),
    ],
    [
      'border radius on a box that paints nothing',
      change(
        'element',
        { ...UNPAINTED, 'border-top-left-radius': '4px' },
        { ...UNPAINTED, 'border-top-left-radius': '0px' },
      ),
    ],
    [
      'background colour between two transparent colours',
      change('element', { 'background-color': 'rgba(255, 0, 0, 0)' }, { 'background-color': 'rgba(0, 0, 0, 0)' }),
    ],
    [
      'transform between none and the identity matrix',
      change('element', { transform: 'matrix(1, 0, 0, 1, 0, 0)' }, { transform: 'none' }),
    ],
    ['an empty ::after box that paints nothing appears', change('after', { ...UNPAINTED, content: '""' }, null)],
  ])('%s -> no qualifying difference; needs a screenshot', (_, c) => {
    const a = checkOne([c])

    expect(a).toMatchObject({
      indicator: 'undetermined',
      reason: 'not-confirmed',
      differences: [],
      evidence: null,
    })
  })

  it('a border side that appears on focus -> present', () => {
    const a = one(
      'element',
      {
        'border-bottom-style': 'solid',
        'border-bottom-width': '2px',
        'border-bottom-color': 'rgb(0, 0, 0)',
      },
      {
        'border-bottom-style': 'none',
        'border-bottom-width': '0px',
        'border-bottom-color': 'rgb(0, 0, 0)',
      },
    )

    expect(a.indicator).toBe('present')
    expect(keys(a)).toEqual(['element:border-bottom-style', 'element:border-bottom-width'])
  })

  it('an ::after box with text appears -> present', () => {
    expect(checkOne([change('after', { ...UNPAINTED, content: '"→"' }, null)])).toMatchObject({
      indicator: 'present',
      differences: [
        {
          target: 'after',
          property: 'content',
          focused: '"→"',
          unfocused: 'none',
        },
      ],
    })
  })

  describe('one colour policy: a colour-only change counts when a channel can move by pixelThreshold', () => {
    it.each([
      ['text colour one step', { color: 'rgb(0, 0, 201)' }, { color: 'rgb(0, 0, 200)' }],
      ['text colour nine steps', { color: 'rgb(0, 0, 209)' }, { color: 'rgb(0, 0, 200)' }],
      [
        'a drawn outline one step redder',
        { ...SOLID_OUTLINE, 'outline-color': 'rgb(1, 0, 0)' },
        { ...SOLID_OUTLINE, 'outline-color': 'rgb(0, 0, 0)' },
      ],
      [
        'a box-shadow ring one step bluer',
        { 'box-shadow': 'rgb(0, 0, 201) 0px 0px 0px 3px' },
        { 'box-shadow': 'rgb(0, 0, 200) 0px 0px 0px 3px' },
      ],
      [
        'background alpha 0.5 -> 0.52',
        { 'background-color': 'rgba(0, 0, 255, 0.52)' },
        { 'background-color': 'rgba(0, 0, 255, 0.5)' },
      ],
      [
        'a gradient one step bluer',
        {
          'background-image': 'linear-gradient(rgb(0, 0, 201), rgb(0, 0, 201))',
        },
        {
          'background-image': 'linear-gradient(rgb(0, 0, 200), rgb(0, 0, 200))',
        },
      ],
    ])('%s -> not a difference; needs a screenshot', (_, focused, unfocused) => {
      expect(one('element', focused, unfocused)).toMatchObject({
        indicator: 'undetermined',
        reason: 'not-confirmed',
        differences: [],
      })
    })

    it.each([
      ['text colour ten steps', { color: 'rgb(0, 0, 210)' }, { color: 'rgb(0, 0, 200)' }, 'element:color'],
      [
        'a ring one step bluer that also grows',
        { 'box-shadow': 'rgb(0, 0, 201) 0px 0px 0px 4px' },
        { 'box-shadow': 'rgb(0, 0, 200) 0px 0px 0px 3px' },
        'element:box-shadow',
      ],
      [
        'a 10% black wash over a transparent background',
        { 'background-color': 'rgba(0, 0, 0, 0.1)' },
        { 'background-color': 'rgba(0, 0, 0, 0)' },
        'element:background-color',
      ],
      [
        'a colour space the policy does not parse',
        { color: 'oklch(0.5 0.1 201)' },
        { color: 'oklch(0.5 0.1 200)' },
        'element:color',
      ],
    ])('%s -> a difference', (_, focused, unfocused, key) => {
      expect(keys(one('element', focused, unfocused))).toEqual([key])
    })

    it('uses the same threshold as the pixels: 20 steps count at 10, not at 30', () => {
      const [focused, unfocused] = [{ color: 'rgb(0, 0, 220)' }, { color: 'rgb(0, 0, 200)' }]

      expect(one('element', focused, unfocused).indicator).toBe('present')
      expect(one('element', focused, unfocused, { pixelThreshold: 30 }).reason).toBe('not-confirmed')
    })
  })

  describe('fix 3: box-shadow layers', () => {
    it.each([
      [
        'Tailwind ring-0: every layer has zero offsets, blur and spread',
        'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(59, 130, 246, 0.5) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px',
      ],
      ['a transparent spread ring', 'rgba(0, 0, 0, 0) 0px 0px 0px 3px'],
      ['a transparent colour() ring', 'color(srgb 0 0 1 / 0) 0px 0px 0px 3px'],
      ['an inset layer that draws nothing', 'rgb(0, 0, 255) 0px 0px 0px 0px inset'],
    ])('%s -> not a difference', (_, shadow) => {
      expect(one('element', { 'box-shadow': shadow }, { 'box-shadow': 'none' }).reason).toBe('not-confirmed')
    })

    it.each([
      ['a visible spread ring', 'rgb(0, 0, 255) 0px 0px 0px 2px', 'none'],
      [
        'one drawing layer among invisible ones',
        'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(59, 130, 246, 0.5) 0px 0px 0px 3px',
        'none',
      ],
      ['an offset shadow', 'rgb(0, 0, 0) 2px 2px 0px 0px', 'none'],
      ['a ring that changes colour', 'rgb(255, 0, 0) 0px 0px 0px 2px', 'rgb(0, 0, 255) 0px 0px 0px 2px'],
    ])('%s -> a difference', (_, focused, unfocused) => {
      expect(keys(one('element', { 'box-shadow': focused }, { 'box-shadow': unfocused }))).toEqual([
        'element:box-shadow',
      ])
    })

    it('the same drawing layers with different invisible layers -> not a difference', () => {
      const a = one(
        'element',
        {
          'box-shadow': 'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(0, 0, 0) 0px 1px 2px 0px',
        },
        { 'box-shadow': 'rgb(0, 0, 0) 0px 1px 2px 0px' },
      )

      expect(a.reason).toBe('not-confirmed')
    })
  })

  describe('fix 4: majority of compared visits, and not drift between two unfocused reads', () => {
    const color = (value: string): StyleChange[] => [change('element', { color: value }, { color: 'rgb(0, 0, 0)' })]
    const none: StyleChange[] = []

    it('a difference on 1 of 3 compared visits does not count', () => {
      const result = judgeFocusIndicator(
        walkOf([
          step(1, read(A), captured(color('rgb(100, 0, 0)'))),
          step(2, read(A), captured(none)),
          step(3, read(A), captured(none)),
        ]),
      )

      expect(element(result, 'a')).toMatchObject({
        reason: 'not-confirmed',
        comparedVisits: 3,
        differences: [],
      })
    })

    it('a difference on 2 of 3 compared visits counts; evidence is the first such visit', () => {
      const result = judgeFocusIndicator(
        walkOf([
          step(1, read(A), captured(none)),
          step(2, read(B), captured(color('rgb(90, 0, 0)'))),
          step(3, read(A), captured(color('rgb(120, 0, 0)'))),
          step(4, read(A), captured(color('rgb(130, 0, 0)'))),
        ]),
      )

      expect(element(result, 'a')).toMatchObject({
        indicator: 'present',
        evidence: 'css',
        steps: [1, 3, 4],
        comparedVisits: 3,
        evidenceStep: 3,
        differences: [
          {
            target: 'element',
            property: 'color',
            focused: 'rgb(120, 0, 0)',
            unfocused: 'rgb(0, 0, 0)',
          },
        ],
      })
    })

    it('a difference that also drifts between two unfocused reads does not count', () => {
      const result = judgeFocusIndicator(
        walkOf([
          step(1, read(A), captured(color('rgb(100, 0, 0)'), [])),
          step(2, read(A), captured(color('rgb(120, 0, 0)'), ['element:color'])),
          step(3, read(A), captured(color('rgb(130, 0, 0)'), null)),
        ]),
      )

      expect(element(result, 'a')).toMatchObject({
        reason: 'not-confirmed',
        differences: [],
      })
    })

    it('drift on one property leaves the others counting', () => {
      const changes = [
        change(
          'element',
          { color: 'rgb(100, 0, 0)', 'font-weight': '700' },
          { color: 'rgb(0, 0, 0)', 'font-weight': '400' },
        ),
      ]
      const result = judgeFocusIndicator(walkOf([step(1, read(A), captured(changes, ['element:color']))]))

      expect(keys(element(result, 'a'))).toEqual(['element:font-weight'])
    })

    it('a context element that could not be re-read unfocused (target:*) does not count', () => {
      const sibling = [change('previous-sibling', { color: 'rgb(100, 0, 0)' }, { color: 'rgb(0, 0, 0)' })]
      const result = judgeFocusIndicator(
        walkOf([
          step(1, read(A), captured(sibling, ['previous-sibling:*'])),
          step(2, read(A), captured(sibling, [])),
          step(3, read(A), captured(sibling, [])),
        ]),
      )

      expect(element(result, 'a')).toMatchObject({
        reason: 'not-confirmed',
        differences: [],
      })
    })
  })

  describe('fix 5: whole-viewport shots decide elements without a CSS difference', () => {
    const noDiff = walkOf([step(1, read(A), captured([])), step(2, read(B), captured([]))])

    it.each([
      [
        'changed pixels -> present',
        shot({ changedPixels: 40 }),
        { indicator: 'present', reason: null, evidence: 'screenshot' },
      ],
      [
        'changed pixels while focus also starts an animation -> present',
        shot({ changedPixels: 40, focusAnimation: true }),
        { indicator: 'present', reason: null, evidence: 'screenshot' },
      ],
      ['no changed pixel -> absent', shot({}), { indicator: 'absent', reason: null, evidence: 'screenshot' }],
      [
        'fewer changed pixels than minChangedPixels -> undetermined (screenshot-faint)',
        shot({ changedPixels: 3 }),
        {
          indicator: 'undetermined',
          reason: 'screenshot-faint',
          evidence: null,
        },
      ],
      [
        'the two unfocused shots differ -> undetermined (screenshot-unstable)',
        shot({
          changedPixels: 40,
          unstablePixels: { unfocused: 12, focused: 0 },
        }),
        {
          indicator: 'undetermined',
          reason: 'screenshot-unstable',
          evidence: null,
        },
      ],
      [
        'the two focused shots differ -> undetermined (screenshot-unstable)',
        shot({ unstablePixels: { unfocused: 0, focused: 1 } }),
        {
          indicator: 'undetermined',
          reason: 'screenshot-unstable',
          evidence: null,
        },
      ],
      [
        'no changed pixel, but focus starts or stops an infinite animation -> undetermined (focus-animation)',
        shot({ focusAnimation: true }),
        {
          indicator: 'undetermined',
          reason: 'focus-animation',
          evidence: null,
        },
      ],
      [
        'capped -> undetermined',
        shot({ status: 'capped', ...NOT_COMPARED }),
        { indicator: 'undetermined', reason: 'screenshot-cap', evidence: null },
      ],
      [
        'failed -> undetermined',
        shot({ status: 'failed', ...NOT_COMPARED, error: 'not rendered' }),
        {
          indicator: 'undetermined',
          reason: 'screenshot-failed',
          evidence: null,
        },
      ],
    ])('%s', (_, evidence, expected) => {
      const result = judgeFocusIndicator(noDiff, new Map([[10, evidence]]))

      expect(element(result, 'a')).toMatchObject({
        ...expected,
        screenshot: evidence,
      })
      expect(element(result, 'b')).toMatchObject({
        indicator: 'undetermined',
        reason: 'not-confirmed',
        screenshot: null,
      })
    })

    it('a CSS difference wins over the screenshot evidence', () => {
      const walk = walkOf([
        step(1, read(A), captured([change('element', { color: 'rgb(100, 0, 0)' }, { color: 'rgb(0, 0, 0)' })])),
      ])

      expect(element(judgeFocusIndicator(walk, new Map([[10, shot({})]])), 'a')).toMatchObject({
        indicator: 'present',
        evidence: 'css',
      })
    })
  })

  it('options: the settle before each shot is at least 300 ms, 300 by default, with a 100 ms recheck', () => {
    expect(FocusIndicatorOptionsSchema.parse({})).toMatchObject({
      settleMs: 300,
      recheckMs: 100,
      pixelThreshold: 10,
    })
    expect(FocusIndicatorOptionsSchema.parse({ settleMs: 900 }).settleMs).toBe(900)
    expect(() => FocusIndicatorOptionsSchema.parse({ settleMs: 299 })).toThrow()
  })

  it('undetermined reasons: never unfocused, removed, document replaced, read failed, deep unavailable', () => {
    const result = judgeFocusIndicator(
      walkOf([
        step(1, read({ backendNodeId: 20, id: 'still' }), pending('still-focused')),
        step(2, read({ backendNodeId: 20, id: 'still' }), pending('not-read')),
        step(3, read({ backendNodeId: 21, id: 'removed' }), pending('removed')),
        step(4, read({ backendNodeId: 22, id: 'replaced' }), pending('document-replaced')),
        step(5, read({ backendNodeId: 23, id: 'failed' }), {
          ...pending('read-failed'),
          unfocusedError: 'boom',
        }),
        step(6, read('cross-origin'), null),
        step(7, read('closed-shadow'), null),
      ]),
    )

    expect(elements(result).map((e) => [e.id, e.indicator, e.reason, e.deepUnavailable])).toEqual([
      ['still', 'undetermined', 'never-unfocused', null],
      ['removed', 'undetermined', 'removed', null],
      ['replaced', 'undetermined', 'document-replaced', null],
      ['failed', 'undetermined', 'read-failed', null],
      ['xo', 'undetermined', 'deep-unavailable', 'cross-origin'],
      ['closed', 'undetermined', 'deep-unavailable', 'closed-shadow-root'],
    ])
    expect(result.components.map((c) => c.key)).toEqual(['a', 'iframe.embed', 'div.embed'])
  })

  it('body, frame-body and empty reads are not focused elements', () => {
    const result = judgeFocusIndicator(
      walkOf([step(1, read('body'), null), step(2, read('frame-body'), null), step(3, read(A), captured([]))]),
    )

    expect(elements(result).map((e) => e.id)).toEqual(['a'])
  })

  describe('fix 6: page verdict', () => {
    const present = step(
      2,
      read(B),
      captured([change('element', { color: 'rgb(90, 0, 0)' }, { color: 'rgb(0, 0, 0)' })]),
    )
    const absentWalk = [step(1, read(A), captured([])), present]
    const absent = new Map([[10, shot({})]])
    const error = { phase: 'walk' as const, index: 3, message: 'boom' }

    it('fail on any absent, even after a walk error', () => {
      expect(judgeFocusIndicator(walkOf(absentWalk), absent).verdict).toBe('fail')
      expect(judgeFocusIndicator(walkOf(absentWalk, error), absent).verdict).toBe('fail')
    })

    it('no absent without screenshot confirmation', () => {
      expect(judgeFocusIndicator(walkOf(absentWalk))).toMatchObject({
        verdict: 'undetermined',
        counts: { present: 1, absent: 0, undetermined: 1 },
      })
    })

    it('pass when every element is present; undetermined after a walk error or without elements', () => {
      expect(judgeFocusIndicator(walkOf([present])).verdict).toBe('pass')
      expect(judgeFocusIndicator(walkOf([present], error)).verdict).toBe('undetermined')
      expect(judgeFocusIndicator(walkOf([])).verdict).toBe('undetermined')
      expect(judgeFocusIndicator(walkOf([step(1, read('body'), null)])).verdict).toBe('undetermined')
    })

    it('cross-origin frames are counted but do not block a pass; closed shadow roots still do', () => {
      const xo = judgeFocusIndicator(walkOf([present, step(3, read('cross-origin'), null)]))
      expect(xo).toMatchObject({
        verdict: 'pass',
        crossOriginUndetermined: 1,
        counts: { undetermined: 1 },
      })

      const onlyXo = judgeFocusIndicator(walkOf([step(1, read('cross-origin'), null)]))
      expect(onlyXo).toMatchObject({
        verdict: 'undetermined',
        crossOriginUndetermined: 1,
      })

      const closed = judgeFocusIndicator(walkOf([present, step(3, read('closed-shadow'), null)]))
      expect(closed).toMatchObject({
        verdict: 'undetermined',
        crossOriginUndetermined: 0,
      })
    })
  })
})
