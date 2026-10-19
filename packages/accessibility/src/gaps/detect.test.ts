import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BrowserClient, type BrowserPage } from '@at-agent/browser'
import { crawlPageWithGapDetection } from './detect.js'
import type { AccessibilityGap, DualCrawlResult } from './types.js'
import type { GapDetectionOptions } from './detect.js'

const URL_ = 'http://fixture.test/gaps.html'

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gap fixture</title></head><body><main>
<h1>Gap fixture</h1>
<div data-bench-id="div-onclick" onclick="void 0">Add to cart</div>
<div data-bench-id="role-button-onclick" role="button" onclick="void 0">Buy now</div>
<button data-bench-id="icon-button" type="button"><svg aria-hidden="true" width="16" height="16"></svg></button>
<div data-bench-id="generic-labelled" aria-label="Close banner" onclick="void 0">x</div>
<form><input data-bench-id="input-hidden" type="hidden" name="csrf" value="t"></form>
<div data-bench-id="listener-plain">Wishlist</div>
<button data-bench-id="real-button" type="button" onclick="void 0">Checkout</button>
</main>
<script>document.querySelector('[data-bench-id="listener-plain"]').addEventListener('click', function () {})</script>
</body></html>`

const benchId = (g: AccessibilityGap): string => g.domElement.attributes['data-bench-id'] ?? g.domElement.localName

describe('crawlPageWithGapDetection (baseline port)', () => {
  let client: BrowserClient
  let page: BrowserPage
  let result: DualCrawlResult

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    page = await client.newPage()
    await page.playwrightPage.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: HTML }))
    result = await crawlPageWithGapDetection(page.playwrightPage, URL_)
  })

  afterAll(async () => {
    await page.close()
    await client.close()
  })

  const gapFor = (id: string): AccessibilityGap | undefined => result.gaps.find((g) => benchId(g) === id)

  it('returns the dual-crawl result for the requested url', () => {
    expect(result.pageUrl).toBe(URL_)
    expect(result.accessibilityTree.title).toBe('Gap fixture')
    expect([...result.accessibilityTree.elements.keys()].every((k) => k.startsWith(`${URL_}#node-`))).toBe(true)
    expect(result.bridgeMap.size).toBeGreaterThan(0)
    expect(result.domElements.length).toBeGreaterThan(0)
  })

  it('flags an unnamed div with an inline handler as wrong_role: Chromium exposes it as a generic node (F2)', () => {
    expect(gapFor('div-onclick')).toMatchObject({
      gapType: 'wrong_role',
      severity: 'serious',
      wcagViolations: ['4.1.2'],
      evidence: 'DIV element has click handlers but generic role "generic"',
    })
  })

  it('without a Tab walk, never flags not_focusable and says why (F3)', () => {
    expect(gapFor('role-button-onclick')).toBeUndefined()
    expect(result.keyboard).toEqual({
      walkRan: false,
      notFocusableAssessed: false,
      unassessedReasons: ['walk-not-run'],
      walkError: null,
      reachedBackendNodeIds: [],
    })
  })

  it('flags an icon button without a name', () => {
    expect(gapFor('icon-button')?.gapType).toBe('no_accessible_name')
  })

  it('flags a named generic with a handler as wrong_role', () => {
    expect(gapFor('generic-labelled')?.gapType).toBe('wrong_role')
  })

  it('drops a type=hidden input instead of flagging it (F1)', () => {
    expect(gapFor('input-hidden')).toBeUndefined()
    const input = result.domElements.find((e) => e.attributes['data-bench-id'] === 'input-hidden')
    expect(result.hidden).toContainEqual({ backendNodeId: input?.backendNodeId, reason: 'hidden-input' })
  })

  it('finds and flags a plain div whose handler comes from addEventListener (F9)', () => {
    expect(gapFor('listener-plain')?.gapType).toBe('wrong_role')
  })

  it('does not flag an accessible button', () => {
    expect(gapFor('real-button')).toBeUndefined()
    expect(result.gaps).toHaveLength(4)
  })
})

// A collapsed dropdown, hidden inputs and a visibility:hidden off-canvas menu, as on the dev navbar base.
const HIDDEN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hidden candidates</title></head><body>
<nav aria-label="Main">
<div class="dropdown"><button data-bench-id="dd-toggle" type="button" aria-expanded="false">Products</button>
<ul class="dropdown-menu" style="display:none"><li><a class="dropdown-item" data-bench-id="dd-item" href="#laptops">Laptops</a></li></ul></div>
<form><input data-bench-id="csrf" type="hidden" name="csrf" value="t"></form>
<button data-bench-id="zero-size" type="button" style="width:0;height:0;padding:0;border:0;overflow:hidden" onclick="void 0">Z</button>
<button data-bench-id="hidden-attr" type="button" hidden onclick="void 0">Retry</button>
<div data-bench-id="visible-onclick" onclick="void 0">Add to cart</div>
</nav>
<div class="offcanvas" data-bench-id="offcanvas" role="dialog" aria-label="Account" tabindex="-1" style="visibility:hidden;position:fixed;top:0;left:0;width:200px">
<button class="btn-close" data-bench-id="offcanvas-close" type="button" aria-label="Close"></button>
<a data-bench-id="offcanvas-link" href="#profile">Profile</a>
</div>
<script>
document.querySelector('[data-bench-id="offcanvas"]').addEventListener('keydown', function () {})
document.querySelector('[data-bench-id="offcanvas-close"]').addEventListener('click', function () {})
</script>
</body></html>`

describe('crawlPageWithGapDetection drops hidden candidates (F1)', () => {
  let client: BrowserClient
  let page: BrowserPage
  let result: DualCrawlResult

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    page = await client.newPage()
    await page.playwrightPage.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: HIDDEN_HTML }))
    result = await crawlPageWithGapDetection(page.playwrightPage, URL_)
  })

  afterAll(async () => {
    await page.close()
    await client.close()
  })

  it('flags only the visible clickable div', () => {
    expect(result.gaps.map(benchId)).toEqual(['visible-onclick'])
  })

  it('records why each hidden candidate was dropped', () => {
    const idOf = new Map(result.domElements.map((e) => [e.backendNodeId, e.attributes['data-bench-id'] ?? e.localName]))
    const dropped = Object.fromEntries(result.hidden.map((h) => [idOf.get(h.backendNodeId), h.reason]))
    // zero-size is a zero-area button that still takes focus, so it stays a candidate (G1b).
    expect(dropped).toEqual({
      ul: 'no-box',
      'dd-item': 'no-box',
      csrf: 'hidden-input',
      'hidden-attr': 'no-box',
      offcanvas: 'css-hidden',
      'offcanvas-close': 'css-hidden',
      'offcanvas-link': 'css-hidden',
    })
  })
})

const F2_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Roles and aria-hidden</title></head><body><main>
<div data-bench-id="div-onclick" onclick="void 0">Add to cart</div>
<div data-bench-id="group-onclick" role="group" onclick="void 0">Filters</div>
<div data-bench-id="named-generic" aria-label="Close banner" onclick="void 0">x</div>
<a data-bench-id="aria-hidden-link" href="#about" aria-hidden="true">About</a>
<div aria-hidden="true"><button data-bench-id="in-hidden-subtree" type="button">Close</button></div>
<div data-bench-id="presentation-onclick" role="presentation" onclick="void 0">Dismiss</div>
<button data-bench-id="icon-button" type="button"><svg aria-hidden="true" width="16" height="16"></svg></button>
<button data-bench-id="real-button" type="button" onclick="void 0">Checkout</button>
</main></body></html>`

describe('crawlPageWithGapDetection classifies generic roles and aria-hidden (F2)', () => {
  let client: BrowserClient
  let page: BrowserPage
  let result: DualCrawlResult

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    page = await client.newPage()
    await page.playwrightPage.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: F2_HTML }))
    result = await crawlPageWithGapDetection(page.playwrightPage, URL_)
  })

  afterAll(async () => {
    await page.close()
    await client.close()
  })

  it('gives each defect its own gap type', () => {
    expect(Object.fromEntries(result.gaps.map((g) => [benchId(g), g.gapType]))).toEqual({
      'div-onclick': 'wrong_role',
      'group-onclick': 'wrong_role',
      'named-generic': 'wrong_role',
      'aria-hidden-link': 'hidden_but_interactive',
      'in-hidden-subtree': 'hidden_but_interactive',
      'presentation-onclick': 'missing_from_a11y_tree',
      'icon-button': 'no_accessible_name',
    })
  })
})

const WALK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Keyboard reachability</title></head><body><main>
<div data-bench-id="no-tabindex" role="button" onclick="void 0">Buy now</div>
<div data-bench-id="junk-tabindex" role="button" tabindex="abc" onclick="void 0">Save</div>
<div data-bench-id="neg-tabindex" role="button" tabindex="-1" onclick="void 0">Compare</div>
<div data-bench-id="ok-tabindex" role="button" tabindex="0" onclick="void 0">Apply</div>
<a data-bench-id="hidden-reachable" href="#a" aria-hidden="true">About</a>
<a data-bench-id="hidden-unreachable" href="#b" aria-hidden="true" tabindex="-1">Duplicate card link</a>
<button data-bench-id="real-button" type="button" onclick="void 0">Checkout</button>
</main></body></html>`

const TRAP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trap</title></head><body><main>
<a data-bench-id="first" href="#a">First</a>
<input data-bench-id="trap" aria-label="Trap">
<div data-bench-id="no-tabindex" role="button" onclick="void 0">Buy now</div>
<a data-bench-id="after-trap" href="#b">After</a>
</main>
<script>document.querySelector('[data-bench-id="trap"]').addEventListener('keydown', function (e) { if (e.key === 'Tab') e.preventDefault() })</script>
</body></html>`

const CLOSED_SHADOW_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Closed shadow</title></head><body><main>
<div id="host"></div>
<div data-bench-id="no-tabindex" role="button" onclick="void 0">Buy now</div>
</main>
<script>document.getElementById('host').attachShadow({ mode: 'closed' }).innerHTML = '<button>Inside</button>'</script>
</body></html>`

describe('crawlPageWithGapDetection with a Tab walk on the same load (F3)', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    page = await client.newPage()
  })

  afterAll(async () => {
    await page.close()
    await client.close()
  })

  async function detectWith(html: string, tabWalk: GapDetectionOptions['tabWalk']): Promise<DualCrawlResult> {
    await page.playwrightPage.unrouteAll()
    await page.playwrightPage.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: html }))
    return crawlPageWithGapDetection(page.playwrightPage, URL_, { tabWalk })
  }

  const byId = (r: DualCrawlResult): Record<string, string> =>
    Object.fromEntries(r.gaps.map((g) => [benchId(g), g.gapType]))

  it('decides focusability from where Tab really goes, not from the tabindex attribute', async () => {
    const result = await detectWith(WALK_HTML, { settleMs: 20 })
    expect(result.keyboard).toMatchObject({ walkRan: true, notFocusableAssessed: true, unassessedReasons: [] })
    expect(byId(result)).toEqual({
      'no-tabindex': 'not_focusable',
      'junk-tabindex': 'not_focusable',
      'neg-tabindex': 'not_focusable',
      'hidden-reachable': 'hidden_but_interactive',
    })
    const reached = new Set(result.keyboard.reachedBackendNodeIds)
    const okButton = result.domElements.find((e) => e.attributes['data-bench-id'] === 'ok-tabindex')
    expect(reached.has(okButton?.backendNodeId ?? -1)).toBe(true)
  })

  it('does not flag not_focusable when the walk never wraps (a trap), and says why', async () => {
    const result = await detectWith(TRAP_HTML, { settleMs: 20 })
    expect(result.keyboard).toMatchObject({
      walkRan: true,
      notFocusableAssessed: false,
      unassessedReasons: ['no-wrap'],
    })
    expect(byId(result)).toEqual({})
  })

  it('does not flag not_focusable when a closed shadow root may hide Tab stops', async () => {
    const result = await detectWith(CLOSED_SHADOW_HTML, { settleMs: 20 })
    expect(result.keyboard.unassessedReasons).toEqual(['focusables-incomplete'])
    expect(byId(result)).toEqual({})
  })

  it('records a walk that could not run instead of failing the detection', async () => {
    const result = await detectWith(WALK_HTML, { presses: 1 })
    expect(result.keyboard).toMatchObject({
      walkRan: false,
      notFocusableAssessed: false,
      unassessedReasons: ['walk-failed'],
    })
    expect(result.keyboard.walkError).toMatch(/presses 1 is below the default/)
    expect(result.errors).toContainEqual(expect.objectContaining({ stage: 'tab-walk', backendNodeId: null }))
    expect(byId(result)['hidden-reachable']).toBe('hidden_but_interactive')
  })

  it('runs the walk with defaults when tabWalk is true', async () => {
    const result = await detectWith(TRAP_HTML, true)
    expect(result.keyboard.walkRan).toBe(true)
  })
})

// The Stage-A reviewer's edge probes (scratchpad verify-p2a/G1/edge-probes.mts), each with the verdict a careful tester
// would give, plus the neighbouring cases each fix must not break.
const bodyPage = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Probe</title></head><body>${body}</body></html>`
const probePage = (body: string): string => bodyPage(`<main>${body}</main>`)

const DISABLED_HTML = probePage(`<a href="#top" data-bench-id="first">Top</a>
<label>Email <input data-bench-id="email"></label>
<button type="submit" data-bench-id="disabled-submit" disabled onclick="void 0">Submit</button>
<fieldset disabled><legend>Card</legend><button type="button" data-bench-id="fs-button" onclick="void 0">Apply</button>
<input data-bench-id="fs-input" aria-label="Code" style="cursor:pointer"></fieldset>
<div role="button" data-bench-id="enabled-no-tabindex" onclick="void 0">Buy now</div>
<a href="#end" data-bench-id="last">End</a>`)

const GROUPS_HTML = probePage(`<fieldset><legend>Size</legend>
<label><input type="radio" name="size" value="s" data-bench-id="radio-s" checked style="cursor:pointer"> Small</label>
<label><input type="radio" name="size" value="m" data-bench-id="radio-m" style="cursor:pointer"> Medium</label>
<label><input type="radio" name="size" value="l" data-bench-id="radio-l" style="cursor:pointer"> Large</label>
</fieldset>
<div role="tablist" aria-label="Details" data-bench-id="tablist" onkeydown="void 0"><div role="tab" tabindex="0" data-bench-id="tab-1" onclick="void 0">Description</div>
<div role="tab" tabindex="-1" data-bench-id="tab-2" onclick="void 0">Reviews</div></div>
<ul role="menu" aria-label="Actions"><li role="menuitem" data-bench-id="menu-cut" onclick="void 0">Cut</li></ul>
<a href="#end" data-bench-id="last">End</a>`)

const NAVIGATES_HTML = probePage(`<a href="#a" data-bench-id="first">First</a>
<a href="/next.html" data-bench-id="nav-on-focus" onfocus="location.href='/next.html'">Go</a>
<a href="#b" data-bench-id="hidden-link" aria-hidden="true">Hidden but focusable</a>`)

const ZERO_AREA_HTML = probePage(`<a href="#a" data-bench-id="first">First</a>
<a href="/product" data-bench-id="img-link"><img src="data:," alt=""></a>
<div data-bench-id="zero-div" style="width:0;height:0;overflow:hidden" onclick="void 0">Z</div>
<button data-bench-id="zero-disabled" disabled style="width:0;height:0;padding:0;border:0;overflow:hidden" onclick="void 0">Z</button>
<a href="#r" data-bench-id="redirect" onfocus="document.querySelector('[data-bench-id=zero-focused]').focus()">Skip</a>
<div data-bench-id="zero-focused" tabindex="-1" style="width:0;height:0;overflow:hidden" onclick="void 0">Z</div>
<a href="#end" data-bench-id="last">End</a>`)

const NEXT_HTML = probePage('<p>Next page</p>')

describe('crawlPageWithGapDetection on the reviewer edge probes, with a Tab walk (G1b)', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    page = await client.newPage()
  })

  afterAll(async () => {
    await page.close()
    await client.close()
  })

  async function detectProbe(html: string): Promise<DualCrawlResult> {
    await page.playwrightPage.unrouteAll()
    await page.playwrightPage.route('http://fixture.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: route.request().url().endsWith('/next.html') ? NEXT_HTML : html,
      }),
    )
    return crawlPageWithGapDetection(page.playwrightPage, URL_, { tabWalk: { settleMs: 50 } })
  }

  const byId = (r: DualCrawlResult): Record<string, string> =>
    Object.fromEntries(r.gaps.map((g) => [benchId(g), g.gapType]))
  const idsOf = (r: DualCrawlResult): Map<number, string> =>
    new Map(r.domElements.map((e) => [e.backendNodeId, e.attributes['data-bench-id'] ?? e.localName]))

  it('does not flag natively disabled controls, in a disabled fieldset or not, as not_focusable', async () => {
    const result = await detectProbe(DISABLED_HTML)
    expect(result.keyboard.notFocusableAssessed).toBe(true)
    expect(byId(result)).toEqual({ 'enabled-no-tabindex': 'not_focusable' })
  })

  it('counts radios and roving tabs reached by arrows from the member Tab focused, and records the rule', async () => {
    const result = await detectProbe(GROUPS_HTML)
    expect(result.keyboard.notFocusableAssessed).toBe(true)
    expect(byId(result)).toEqual({ 'menu-cut': 'not_focusable' })
    const ids = idsOf(result)
    expect(result.reachedByGroup.map((r) => [ids.get(r.backendNodeId), r.rule])).toEqual([
      ['radio-m', 'radio-group'],
      ['radio-l', 'radio-group'],
      ['tab-2', 'composite-widget'],
      ['tablist', 'widget-container'],
    ])
  })

  it('flags an aria-hidden focusable link after a walk that a focus-triggered navigation cut short', async () => {
    const result = await detectProbe(NAVIGATES_HTML)
    expect(result.keyboard.unassessedReasons).toContain('document-replaced')
    expect(byId(result)).toEqual({ 'hidden-link': 'hidden_but_interactive' })
  })

  it('keeps zero-area elements that take focus or that Tab reached; still drops those that cannot', async () => {
    const result = await detectProbe(ZERO_AREA_HTML)
    expect(result.keyboard.notFocusableAssessed).toBe(true)
    const gaps = byId(result)
    expect(gaps['img-link']).toBe('no_accessible_name')
    expect(gaps['zero-focused']).toBe('wrong_role')
    const ids = idsOf(result)
    expect(Object.fromEntries(result.hidden.map((h) => [ids.get(h.backendNodeId), h.reason]))).toEqual({
      'zero-div': 'zero-area',
      'zero-disabled': 'zero-area',
    })
  })
})

// The G1b reviewer's probes (scratchpad verify-p2a2/G1b/own-probes.mts), several widgets per page: roving widgets
// whose container carries the arrow-key listener, one without key handling, aria-activedescendant widgets and tabs
// slotted into a shadow tablist.
const ARROWS = `<script>
document.querySelectorAll('[data-roving]').forEach(function (w) {
  w.addEventListener('keydown', function (e) {
    var items = [].slice.call(w.querySelectorAll('[data-item]'))
    var i = items.indexOf(document.activeElement)
    var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (i < 0 || !d) return
    e.preventDefault()
    var next = items[(i + d + items.length) % items.length]
    items[i].tabIndex = -1
    next.tabIndex = 0
    next.focus()
  })
})
</script>`

const WIDGETS_HTML = probePage(`<a href="#a" data-bench-id="first">First</a>
<div role="tablist" aria-label="Details" data-roving data-bench-id="tablist">
<div role="tab" data-item tabindex="0" aria-selected="true" data-bench-id="tab-1" onclick="void 0">Description</div>
<div role="tab" data-item tabindex="-1" aria-selected="false" data-bench-id="tab-2" onclick="void 0">Reviews</div>
</div><div role="tabpanel"><a href="#more" data-bench-id="panel-link">More</a></div>
<ul role="menu" aria-label="Actions" data-roving data-bench-id="menu">
<li role="menuitem" data-item tabindex="0" data-bench-id="mi-cut" onclick="void 0">Cut</li>
<li role="menuitem" data-item tabindex="-1" data-bench-id="mi-copy" onclick="void 0">Copy</li>
</ul>
<div role="toolbar" aria-label="Format" data-roving data-bench-id="toolbar">
<button data-item tabindex="0" data-bench-id="tb-bold" onclick="void 0">Bold</button>
<button data-item tabindex="-1" data-bench-id="tb-italic" onclick="void 0">Italic</button>
</div>
<button tabindex="-1" data-bench-id="outside-neg" onclick="void 0">Outside</button>
<div role="grid" aria-label="Orders" data-roving data-bench-id="grid">
<div role="row"><div role="gridcell" data-item tabindex="0" data-bench-id="gc-1" onclick="void 0">A1</div>
<div role="gridcell" data-item tabindex="-1" data-bench-id="gc-2" onclick="void 0">A2</div></div>
</div>
<div role="toolbar" aria-label="No arrows">
<button tabindex="0" data-bench-id="na-bold" onclick="void 0">Bold</button>
<button tabindex="-1" data-bench-id="na-italic" onclick="void 0">Italic</button>
</div>
<div role="tablist" aria-label="Broken">
<div role="tab" tabindex="-1" data-bench-id="bt-1" onclick="void 0">One</div>
<div role="tab" tabindex="-1" data-bench-id="bt-2" onclick="void 0">Two</div>
</div>
<div role="listbox" tabindex="0" aria-label="Fruit" aria-activedescendant="lb-o1" data-bench-id="listbox">
<div role="option" id="lb-o1" aria-selected="true" data-bench-id="lb-opt-1" onclick="void 0">Apple</div>
<div role="option" id="lb-o2" data-bench-id="lb-opt-2" onclick="void 0">Pear</div>
</div>
<input role="combobox" aria-label="City" aria-controls="cities" aria-expanded="true" aria-activedescendant="" data-bench-id="combo">
<ul role="listbox" id="cities" aria-label="Cities" data-bench-id="cities">
<li role="option" id="city-o1" data-bench-id="city-1" onclick="void 0">Oslo</li>
<li role="option" id="city-o2" data-bench-id="city-2" onclick="void 0">Rome</li>
</ul>
<x-tabs><div role="tab" tabindex="0" data-bench-id="st-1" onclick="void 0">One</div><div role="tab" tabindex="-1" data-bench-id="st-2" onclick="void 0">Two</div></x-tabs>
<a href="#end" data-bench-id="last">End</a>
<script>
customElements.define('x-tabs', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<div role="tablist" aria-label="T"><slot></slot></div>' }
})
document.querySelectorAll('x-tabs [role=tab]').forEach(function (t) { t.addEventListener('keydown', function () {}) })
</script>${ARROWS}`)

// Zero-area candidates: decorative ones Tab never reaches, one inside an inert region, a link around a broken image
// (a real Tab stop), and a link Tab passes straight through (its focus handler moves focus on).
const ZERO_HTML = probePage(`<a href="#a" data-bench-id="first">First</a>
<span data-bench-id="deco-span" onclick="void 0" style="display:inline-block;width:0;height:0;overflow:hidden">x</span>
<i data-bench-id="deco-icon" class="icon" onclick="void 0"></i>
<div data-bench-id="deco-tabneg" tabindex="-1" onclick="void 0" style="width:0;height:0;overflow:hidden">x</div>
<a data-bench-id="deco-a-nohref" onclick="void 0"></a>
<button data-bench-id="deco-btn-disabled" disabled onclick="void 0" style="width:0;height:0;padding:0;border:0;overflow:hidden">x</button>
<div inert><a href="#y" data-bench-id="inert-zero-link" onclick="void 0" style="display:inline-block;width:0;height:0;overflow:hidden">x</a></div>
<a href="/p" data-bench-id="img-link"><img src="data:," alt=""></a>
<a href="#s" data-bench-id="zero-skip" style="display:inline-block;width:0;height:0;overflow:hidden" onfocus="document.querySelector('[data-bench-id=last]').focus()"></a>
<a href="#end" data-bench-id="last">End</a>`)

describe('crawlPageWithGapDetection on the G1b reviewer probes (G1c)', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    page = await client.newPage()
  })

  afterAll(async () => {
    await page.close()
    await client.close()
  })

  async function detectProbe(html: string, tabWalk: GapDetectionOptions['tabWalk']): Promise<DualCrawlResult> {
    await page.playwrightPage.unrouteAll()
    await page.playwrightPage.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: html }))
    return crawlPageWithGapDetection(page.playwrightPage, URL_, { tabWalk })
  }

  const byId = (r: DualCrawlResult): Record<string, string> =>
    Object.fromEntries(r.gaps.map((g) => [benchId(g), g.gapType]))
  const idsOf = (r: DualCrawlResult): Map<number, string> =>
    new Map(r.domElements.map((e) => [e.backendNodeId, e.attributes['data-bench-id'] ?? e.localName]))
  const hiddenOf = (r: DualCrawlResult): Record<string, string> => {
    const ids = idsOf(r)
    return Object.fromEntries(r.hidden.map((h) => [ids.get(h.backendNodeId), h.reason]))
  }

  it('flags only the truly unreachable members: containers (N1), key handling (N2), activedescendant (N3), slots (N4)', async () => {
    const result = await detectProbe(WIDGETS_HTML, { settleMs: 50 })
    expect(result.keyboard.notFocusableAssessed).toBe(true)
    expect(byId(result)).toEqual({
      'outside-neg': 'not_focusable',
      'na-italic': 'not_focusable',
      'bt-1': 'not_focusable',
      'bt-2': 'not_focusable',
    })
    const ids = idsOf(result)
    expect(Object.fromEntries(result.reachedByGroup.map((r) => [ids.get(r.backendNodeId), r.rule]))).toEqual({
      'tab-2': 'composite-widget',
      'mi-copy': 'composite-widget',
      'tb-italic': 'composite-widget',
      'gc-2': 'composite-widget',
      'st-2': 'composite-widget',
      'lb-opt-1': 'active-descendant',
      'lb-opt-2': 'active-descendant',
      'city-1': 'active-descendant',
      'city-2': 'active-descendant',
      tablist: 'widget-container',
      menu: 'widget-container',
      toolbar: 'widget-container',
      grid: 'widget-container',
      cities: 'widget-container',
    })
  })

  it('B1: after a complete walk, keeps a zero-area element only if Tab reached it', async () => {
    const result = await detectProbe(ZERO_HTML, { settleMs: 50 })
    expect(result.keyboard.notFocusableAssessed).toBe(true)
    expect(byId(result)).toEqual({ 'img-link': 'no_accessible_name' })
    expect(hiddenOf(result)).toEqual({
      'deco-span': 'zero-area',
      'deco-icon': 'zero-area',
      'deco-tabneg': 'zero-area',
      'deco-a-nohref': 'zero-area',
      'deco-btn-disabled': 'zero-area',
      'inert-zero-link': 'zero-area',
      'zero-skip': 'zero-area',
    })
  })

  it('B1: without a walk, keeps a zero-area element only if it is really a Tab stop', async () => {
    const result = await detectProbe(ZERO_HTML, false)
    expect(byId(result)).toEqual({ 'img-link': 'no_accessible_name', 'zero-skip': 'no_accessible_name' })
    expect(hiddenOf(result)).toEqual({
      'deco-span': 'zero-area',
      'deco-icon': 'zero-area',
      'deco-tabneg': 'zero-area',
      'deco-a-nohref': 'zero-area',
      'deco-btn-disabled': 'zero-area',
      'inert-zero-link': 'zero-area',
    })
  })
})

// Content a page switched off, which Chromium leaves out of the accessibility tree: an inert region, the page behind a
// <dialog> opened with showModal(), either one also aria-hidden, and CSS interactivity: inert (F2).
const INERT_HTML = probePage(`<a href="#a" data-bench-id="first">First</a>
<div inert data-bench-id="slide-2"><h2>Slide 2</h2><button type="button" data-bench-id="inert-btn" onclick="void 0">Buy</button>
<a href="#s2" data-bench-id="inert-link">Read more</a></div>
<button type="button" inert data-bench-id="inert-self" onclick="void 0">Self</button>
<a href="#end" data-bench-id="last">End</a>`)

const MODAL_HTML = bodyPage(`<main><a href="#a" data-bench-id="bg-link">Background link</a>
<button type="button" data-bench-id="bg-btn" onclick="void 0">Background</button></main>
<dialog data-bench-id="dlg" aria-label="Age gate"><form method="dialog"><button data-bench-id="dlg-close">I am 18</button></form></dialog>
<script>document.querySelector('dialog').showModal()</script>`)

const MODAL_ARIA_HIDDEN_HTML = bodyPage(`<main aria-hidden="true"><a href="#a" data-bench-id="bg-link">Shop</a>
<button type="button" data-bench-id="bg-btn" onclick="void 0">Join</button></main>
<dialog aria-label="Cookies"><form method="dialog"><button data-bench-id="accept">Accept</button></form></dialog>
<script>document.querySelector('dialog').showModal()</script>`)

const INERT_ARIA_HIDDEN_HTML = bodyPage(`<a href="#a" data-bench-id="first">First</a>
<div inert aria-hidden="true" data-bench-id="slide-2"><button type="button" data-bench-id="slide-btn" onclick="void 0">Buy</button></div>
<a href="#z" data-bench-id="last">Last</a>`)

const CSS_INERT_HTML = bodyPage(`<a href="#a" data-bench-id="first">First</a>
<div style="interactivity: inert" data-bench-id="css-inert"><button type="button" onclick="void 0" data-bench-id="ci-btn">Buy</button>
<a href="#x" data-bench-id="ci-link">More</a></div>
<a href="#z" data-bench-id="last">Last</a>`)

// Chromium prunes every aria-hidden element that cannot take focus, switched off or not: these mouse-only controls
// are hidden from assistive technology and stay critical.
const ARIA_HIDDEN_ONLY_HTML = bodyPage(`<a href="#a" data-bench-id="first">First</a>
<div aria-hidden="true" onclick="void 0" data-bench-id="self-div">Close</div>
<div aria-hidden="true"><span onclick="void 0" data-bench-id="sub-span">More</span></div>
<a href="#z" data-bench-id="last">Last</a>`)

// A modal <dialog> inside a shadow root: document.querySelector does not see it, so the page behind it stays flagged.
const SHADOW_MODAL_HTML = bodyPage(`<a href="#a" data-bench-id="bg-link">Background</a><button type="button" onclick="void 0" data-bench-id="bg-btn">Join</button><x-host></x-host>
<script>
var root = document.querySelector('x-host').attachShadow({ mode: 'open' })
root.innerHTML = '<dialog aria-label="Web component"><button>OK</button></dialog>'
root.querySelector('dialog').showModal()
</script>`)

describe('crawlPageWithGapDetection on content the page switched off (F2)', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    page = await client.newPage()
  })

  afterAll(async () => {
    await page.close()
    await client.close()
  })

  async function detectProbe(html: string, tabWalk: GapDetectionOptions['tabWalk']): Promise<DualCrawlResult> {
    await page.playwrightPage.unrouteAll()
    await page.playwrightPage.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: html }))
    return crawlPageWithGapDetection(page.playwrightPage, URL_, { tabWalk })
  }

  const byId = (r: DualCrawlResult): Record<string, string> =>
    Object.fromEntries(r.gaps.map((g) => [benchId(g), g.gapType]))

  const SWITCHED_OFF: Record<string, string> = {
    'an inert region and an inert button': INERT_HTML,
    'the page behind a <dialog> opened with showModal()': MODAL_HTML,
    'an aria-hidden page behind a modal <dialog>': MODAL_ARIA_HIDDEN_HTML,
    'an inert, aria-hidden slide': INERT_ARIA_HIDDEN_HTML,
    'content under CSS interactivity: inert': CSS_INERT_HTML,
  }
  for (const [name, html] of Object.entries(SWITCHED_OFF)) {
    it(`flags nothing in ${name}, with a walk and without`, async () => {
      for (const tabWalk of [{ settleMs: 50 }, false]) {
        const result = await detectProbe(html, tabWalk)
        expect(result.errors).toEqual([])
        expect(byId(result), `walk ${tabWalk !== false}`).toEqual({})
      }
    })
  }

  it('keeps an aria-hidden mouse-only control missing_from_a11y_tree: the page did not switch it off', async () => {
    const result = await detectProbe(ARIA_HIDDEN_ONLY_HTML, { settleMs: 50 })
    expect(result.keyboard.notFocusableAssessed).toBe(true)
    expect(byId(result)).toEqual({ 'self-div': 'missing_from_a11y_tree', 'sub-span': 'missing_from_a11y_tree' })
  })

  it('still flags the page behind a modal <dialog> in a shadow root (a known miss, pinned both ways)', async () => {
    const result = await detectProbe(SHADOW_MODAL_HTML, { settleMs: 50 })
    expect(result.errors).toEqual([])
    expect(byId(result)).toEqual({ 'bg-link': 'missing_from_a11y_tree', 'bg-btn': 'missing_from_a11y_tree' })
  })
})

// A <details> is a group named by nothing; its <summary> is the control and carries the name (F2).
const DETAILS_HTML = probePage(`<details data-bench-id="faq"><summary data-bench-id="faq-summary">Shipping</summary><p>3 days</p></details>
<details open data-bench-id="faq-open"><summary data-bench-id="faq-open-summary">Returns</summary><p>30 days</p></details>
<details data-bench-id="faq-pointer" style="cursor:pointer"><summary data-bench-id="faq-pointer-summary">Sizes</summary><p>S-XL</p></details>`)

describe('crawlPageWithGapDetection on <details> disclosures (F2)', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    page = await client.newPage()
  })

  afterAll(async () => {
    await page.close()
    await client.close()
  })

  it('flags no <details>, closed, open or cursor:pointer, as a control without a name', async () => {
    await page.playwrightPage.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: DETAILS_HTML }))
    const result = await crawlPageWithGapDetection(page.playwrightPage, URL_, { tabWalk: { settleMs: 50 } })
    expect(result.keyboard.notFocusableAssessed).toBe(true)
    expect(Object.fromEntries(result.gaps.map((g) => [benchId(g), g.gapType]))).toEqual({})
  })
})

// Roving tablists whose container has no box: floated tabs leave it zero-area, display:contents gives it none. Its
// keydown listener serves its members either way. plain-tablist handles no arrow keys; none-tablist is display:none.
const ROVING_HIDDEN_HTML = probePage(`<a href="#a" data-bench-id="first">First</a>
<div role="tablist" aria-label="Floated" data-roving data-bench-id="float-tablist">
<div role="tab" data-item tabindex="0" style="float:left" data-bench-id="float-1" onclick="void 0">One</div>
<div role="tab" data-item tabindex="-1" style="float:left" data-bench-id="float-2" onclick="void 0">Two</div>
</div><div style="clear:both"></div>
<div role="tablist" aria-label="Contents" data-roving data-bench-id="contents-tablist" style="display:contents">
<div role="tab" data-item tabindex="0" data-bench-id="contents-1" onclick="void 0">Three</div>
<div role="tab" data-item tabindex="-1" data-bench-id="contents-2" onclick="void 0">Four</div>
</div>
<div role="tablist" aria-label="No arrows" data-bench-id="plain-tablist" style="display:contents">
<div role="tab" tabindex="0" data-bench-id="plain-1" onclick="void 0">Five</div>
<div role="tab" tabindex="-1" data-bench-id="plain-2" onclick="void 0">Six</div>
</div>
<div role="tablist" aria-label="Hidden" data-roving data-bench-id="none-tablist" style="display:none">
<div role="tab" data-item tabindex="0" data-bench-id="none-1" onclick="void 0">Seven</div>
</div>
<a href="#end" data-bench-id="last">End</a>${ARROWS}`)

// A menubar with no arrow-key handling around a submenu with no box and its own keydown listener: the submenu's
// listener fires only for its own members, so it must not make the menubar's m2 reachable.
const nestedHtml = (submenuStyle: string): string =>
  probePage(`<a href="#a" data-bench-id="first">First</a>
<div role="menubar" aria-label="Main" data-bench-id="bar">
<div role="menuitem" tabindex="0" onclick="void 0" data-bench-id="m1">File</div>
<div role="menuitem" tabindex="-1" onclick="void 0" data-bench-id="m2">Edit</div>
<div role="menu" aria-label="File" data-bench-id="sub" style="${submenuStyle}">
<div role="menuitem" tabindex="-1" data-bench-id="s1">Undo</div>
</div>
</div>
<a href="#end" data-bench-id="last">End</a>
<script>document.querySelector('[data-bench-id=sub]').addEventListener('keydown', function () {})</script>`)

// The submenu's listener serving its own members: s2 is reached with the arrow keys from s1.
const NESTED_INNER_ROVING_HTML = probePage(`<a href="#a" data-bench-id="first">First</a>
<div role="menubar" aria-label="Main" data-bench-id="bar">
<div role="menuitem" tabindex="0" onclick="void 0" data-bench-id="m1">File</div>
<div role="menu" aria-label="Sizes" data-bench-id="sub" style="display:contents">
<div role="menuitemradio" tabindex="0" onclick="void 0" data-bench-id="s1">Small</div>
<div role="menuitemradio" tabindex="-1" onclick="void 0" data-bench-id="s2">Large</div>
</div>
</div>
<a href="#end" data-bench-id="last">End</a>
<script>document.querySelector('[data-bench-id=sub]').addEventListener('keydown', function () {})</script>`)

describe('crawlPageWithGapDetection on widget containers with no box (G1c)', () => {
  let client: BrowserClient
  let page: BrowserPage

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    page = await client.newPage()
  })

  afterAll(async () => {
    await page.close()
    await client.close()
  })

  async function detectProbe(html: string): Promise<DualCrawlResult> {
    await page.playwrightPage.unrouteAll()
    await page.playwrightPage.route(URL_, (route) => route.fulfill({ contentType: 'text/html', body: html }))
    return crawlPageWithGapDetection(page.playwrightPage, URL_, { tabWalk: { settleMs: 50 } })
  }

  const byId = (r: DualCrawlResult): Record<string, string> =>
    Object.fromEntries(r.gaps.map((g) => [benchId(g), g.gapType]))
  const groupOf = (r: DualCrawlResult): Record<string, string> => {
    const ids = new Map(r.domElements.map((e) => [e.backendNodeId, e.attributes['data-bench-id'] ?? e.localName]))
    return Object.fromEntries(r.reachedByGroup.map((g) => [ids.get(g.backendNodeId), g.rule]))
  }

  it('counts the members a zero-area or display:contents container moves between with arrow keys as reached', async () => {
    const result = await detectProbe(ROVING_HIDDEN_HTML)
    expect(result.keyboard.notFocusableAssessed).toBe(true)
    expect(byId(result)).toEqual({ 'plain-2': 'not_focusable' })
    expect(groupOf(result)).toMatchObject({ 'float-2': 'composite-widget', 'contents-2': 'composite-widget' })
    const ids = new Map(result.domElements.map((e) => [e.backendNodeId, e.attributes['data-bench-id']]))
    expect(Object.fromEntries(result.hidden.map((h) => [ids.get(h.backendNodeId), h.reason]))).toMatchObject({
      'float-tablist': 'zero-area',
      'contents-tablist': 'no-box',
    })
  })

  it("does not lend a submenu's keydown listener to the menubar around it, whatever hides the submenu", async () => {
    for (const style of ['height:0;overflow:hidden', 'display:contents']) {
      const result = await detectProbe(nestedHtml(style))
      expect(result.keyboard.notFocusableAssessed, style).toBe(true)
      expect(byId(result), style).toEqual({ m2: 'not_focusable' })
      expect(groupOf(result), style).not.toHaveProperty('m2')
    }
  })

  it("still counts a display:contents submenu's own members as reached through its keydown listener", async () => {
    const result = await detectProbe(NESTED_INNER_ROVING_HTML)
    expect(result.keyboard.notFocusableAssessed).toBe(true)
    expect(byId(result)).toEqual({})
    expect(groupOf(result)).toMatchObject({ s2: 'composite-widget' })
  })
})
