import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Page } from 'playwright'
import { BrowserClient, type BrowserPage } from '@at-agent/browser'
import { collectFocusFacts, crawlDOM, getInteractivitySignals, isElementVisible } from './dom-crawler.js'
import type { DOMElement, FocusFacts } from './types.js'

const HTML = `<!doctype html><html lang="en"><head><title>crawl</title></head><body>
<button id="b">Go</button>
<a id="link" href="#x" class="nav-link">Link</a>
<div id="btn-div" class="btn" style="cursor:pointer">Add</div>
<div id="plain" style="cursor:pointer">Plain</div>
<div id="tabneg" tabindex="-1">Neg</div>
<div id="junk" tabindex="abc" role="button" aria-expanded="false">Junk</div>
<button id="gone" style="display:none">Gone</button>
<script>
document.getElementById('btn-div').addEventListener('click', function () {})
document.getElementById('plain').addEventListener('click', function () {})
</script>
</body></html>`

const idOf = (e: DOMElement): string => e.attributes['id'] ?? e.localName

describe('dom-crawler (baseline port)', () => {
  let client: BrowserClient
  let browserPage: BrowserPage
  let page: Page
  let elements: DOMElement[]

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    browserPage = await client.newPage()
    page = browserPage.playwrightPage
    await page.setContent(HTML)
    const crawl = await crawlDOM(page, 'http://fixture.test/')
    elements = crawl.elements
    expect(crawl.errors).toEqual([])
  })

  afterAll(async () => {
    await browserPage.close()
    await client.close()
  })

  const find = (id: string): DOMElement => {
    const found = elements.find((e) => idOf(e) === id)
    if (!found) throw new Error(`not enumerated: ${id}`)
    return found
  }

  it('enumerates selector matches in selector order, then listener finds, deduplicated by backendNodeId', () => {
    expect(elements.map(idOf)).toEqual(['b', 'gone', 'link', 'junk', 'tabneg', 'btn-div', 'plain'])
    expect(elements.every((e) => e.pageUrl === 'http://fixture.test/')).toBe(true)
  })

  it('finds a plain div by its script listener (F9)', () => {
    expect(elements.map(idOf)).toContain('plain')
  })

  it('records raw attributes and a null box for an unrendered element', () => {
    expect(find('junk').attributes).toMatchObject({
      tabindex: 'abc',
      role: 'button',
      'aria-expanded': 'false',
    })
    expect(find('gone').boundingBox).toBeNull()
    expect(find('b').boundingBox?.width).toBeGreaterThan(0)
    expect(find('b').nodeName).toBe('BUTTON')
    expect(find('b').localName).toBe('button')
  })

  it('detects a script click listener and reads cursor:pointer (F9)', async () => {
    const { signals, errors } = await getInteractivitySignals(page, find('btn-div'))
    expect(errors).toEqual([])
    expect(signals.hasClickHandler).toBe(true)
    expect(signals.hasCursorPointer).toBe(true)
    expect(signals.classNameHints).toEqual(['btn'])
    expect(signals.isSemanticInteractive).toBe(false)
  })

  it('parses tabindex from the attribute, turning junk into 0', async () => {
    const { signals: neg } = await getInteractivitySignals(page, find('tabneg'))
    expect(neg.hasTabindex).toBe(true)
    expect(neg.tabindexValue).toBe(-1)
    const { signals: junk } = await getInteractivitySignals(page, find('junk'))
    expect(junk.tabindexValue).toBe(0)
    expect(junk.hasRoleAttribute).toBe(true)
    expect(junk.roleValue).toBe('button')
    expect(junk.hasAriaExpanded).toBe(true)
  })

  it('marks native controls as semantic interactive', async () => {
    const { signals } = await getInteractivitySignals(page, find('b'))
    expect(signals.isSemanticInteractive).toBe(true)
    expect(signals.hasClickHandler).toBe(false)
    expect(signals.hasCursorPointer).toBe(false)
  })

  it('records a signal read that fails instead of swallowing it (F9)', async () => {
    const { signals, errors } = await getInteractivitySignals(page, { ...find('b'), backendNodeId: 99999999 })
    expect(errors.map((e) => [e.stage, e.backendNodeId])).toEqual([
      ['cursor', 99999999],
      ['listeners', 99999999],
    ])
    expect(signals.isSemanticInteractive).toBe(true)
  })

  it('isElementVisible reports a display:none element as not visible (F1)', async () => {
    expect(await isElementVisible(page, find('gone'))).toBe(false)
    expect(await isElementVisible(page, find('b'))).toBe(true)
  })
})

describe('isElementVisible (F1)', () => {
  let client: BrowserClient
  let browserPage: BrowserPage
  let page: Page
  let elements: DOMElement[]

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    browserPage = await client.newPage()
    page = browserPage.playwrightPage
    await page.setContent(`<!doctype html><html lang="en"><head><title>vis</title></head><body>
<button id="shown">Shown</button>
<button id="vis-hidden" style="visibility:hidden">Hidden</button>
<div style="visibility:hidden"><a id="vis-hidden-child" href="#x">Child</a></div>
<input id="hidden-input" type="hidden" value="t">
<button id="zero" style="width:0;height:0;padding:0;border:0;overflow:hidden">Z</button>
<button id="zero-disabled" disabled style="width:0;height:0;padding:0;border:0;overflow:hidden">Z</button>
<div id="zero-div" class="btn" style="width:0;height:0;overflow:hidden">Z</div>
<div id="zero-tab0" tabindex="0" style="width:0;height:0;overflow:hidden">Z</div>
<div hidden><button id="hidden-attr-child">H</button></div>
<button id="transparent" style="opacity:0">Still rendered</button>
</body></html>`)
    elements = (await crawlDOM(page, 'http://fixture.test/')).elements
  })

  afterAll(async () => {
    await browserPage.close()
    await client.close()
  })

  it('is false for visibility:hidden (own or inherited), type=hidden, unrendered and zero-area elements', async () => {
    const visible: Record<string, boolean> = {}
    for (const element of elements) visible[idOf(element)] = await isElementVisible(page, element)
    expect(visible).toEqual({
      shown: true,
      'vis-hidden': false,
      'vis-hidden-child': false,
      'hidden-input': false,
      // G1c: zero area is a rendering fact; whether a zero-area Tab stop stays a candidate is decided in detect.ts.
      zero: false,
      'zero-disabled': false,
      'zero-div': false,
      'zero-tab0': false,
      'hidden-attr-child': false,
      transparent: true,
    })
  })
})

const FOCUS_FACTS_HTML = `<!doctype html><html lang="en"><head><title>focus facts</title></head><body>
<form id="f1">
<input type="radio" name="size" id="f1-s"><input type="radio" name="size" id="f1-m"><input type="radio" name="color" id="f1-red">
<input type="radio" id="f1-noname">
</form>
<form id="f2"><input type="radio" name="size" id="f2-s"></form>
<input type="radio" name="size" id="doc-s"><input type="radio" name="size" id="doc-m">
<input type="radio" name="size" form="f1" id="f1-remote">
<button id="disabled-btn" disabled>D</button>
<fieldset disabled><legend>L</legend><button id="fs-btn">In fieldset</button><input id="fs-input"></fieldset>
<div inert><button id="inert-btn">Inert</button><div><a id="inert-deep" href="#x">Deep</a></div></div>
<div role="tablist" id="tablist"><div role="tab" id="tab-1" tabindex="0">A</div><div role="tab" id="tab-2" tabindex="-1">B</div></div>
<div role="toolbar menu" id="toolbar"><span><button id="tool-1">Bold</button></span>
<div role="menu" id="nested-menu"><div role="menuitem" id="nested-item" tabindex="-1">Cut</div></div></div>
<div role="radiogroup" id="rg"><div role="radio" id="aria-radio" tabindex="0">One</div></div>
<button id="plain">Plain</button>
<div id="host"></div>
<a id="a-nohref" onclick="void 0">No href</a><a id="a-nohref-tab" tabindex="0">No href, tabindex</a><a id="a-href" href="#y">Href</a>
<div id="div-tabneg" tabindex="-1">Neg</div><button id="vis-hidden-btn" style="visibility:hidden">V</button>
<div role="listbox" id="ad-listbox" tabindex="0" aria-activedescendant="ad-o1"><div role="option" id="ad-o1">A</div></div>
<input id="combo" role="combobox" aria-controls="combo-lb" aria-activedescendant="" aria-expanded="true">
<ul role="listbox" id="combo-lb"><li role="option" id="combo-o1">B</li></ul>
<div role="toolbar" id="keyed-toolbar"><button id="keyed-tool">K</button></div>
<div role="menu" id="plain-menu"><div role="menuitem" id="keyed-item" tabindex="-1">I</div><div role="menuitem" id="react-item" tabindex="-1">R</div></div>
<button id="keyed-plain">Not in a widget</button>
<x-tabs id="x-tabs"><div role="tab" id="slotted-tab" tabindex="-1">S</div></x-tabs>
<script>
document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
  '<div role="listbox" id="shadow-listbox"><div role="option" id="shadow-option" tabindex="0">S</div></div>'
var keydown = function (id) { document.getElementById(id).addEventListener('keydown', function () {}) }
keydown('keyed-toolbar')
keydown('keyed-item')
keydown('keyed-plain')
document.getElementById('react-item').__reactProps$t = { onKeyDown: function () {} }
customElements.define('x-tabs', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<div role="tablist" id="shadow-tablist"><slot></slot></div>' }
})
</script>
</body></html>`

// Every element carrying an id, open shadow roots included, described as crawlDOM would (containers are not candidates).
const ELEMENTS_BY_ID_FN = `function () {
  var out = []
  var visit = function (root) {
    root.querySelectorAll('[id]').forEach(function (el) {
      out.push(el)
      if (el.shadowRoot) visit(el.shadowRoot)
    })
  }
  visit(document)
  return out
}`

async function elementsById(page: Page): Promise<Map<string, DOMElement>> {
  const byId = new Map<string, DOMElement>()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.getDocument', { depth: 0 })
  const { result } = await cdp.send('Runtime.evaluate', { expression: `(${ELEMENTS_BY_ID_FN})()` })
  const { result: entries } = await cdp.send('Runtime.getProperties', {
    objectId: result.objectId ?? '',
    ownProperties: true,
  })
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name) || !entry.value?.objectId) continue
    const { node } = await cdp.send('DOM.describeNode', { objectId: entry.value.objectId })
    const attributes: Record<string, string> = {}
    for (let i = 0; i < (node.attributes ?? []).length; i += 2)
      attributes[node.attributes![i]] = node.attributes![i + 1]
    byId.set(attributes['id'], {
      nodeId: 0,
      backendNodeId: node.backendNodeId,
      nodeName: node.nodeName,
      localName: node.localName,
      attributes,
      boundingBox: null,
      pageUrl: 'http://fixture.test/',
    })
  }
  await cdp.detach()
  return byId
}

describe('collectFocusFacts (G1b)', () => {
  let client: BrowserClient
  let browserPage: BrowserPage
  let page: Page
  let byId: Map<string, DOMElement>
  let facts: Map<number, FocusFacts>

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    browserPage = await client.newPage()
    page = browserPage.playwrightPage
    await page.setContent(FOCUS_FACTS_HTML)
    byId = await elementsById(page)
    const collected = await collectFocusFacts(page, [...byId.values()])
    expect(collected.errors).toEqual([])
    facts = collected.facts
  })

  afterAll(async () => {
    await browserPage.close()
    await client.close()
  })

  const factsOf = (id: string): FocusFacts | undefined => facts.get(byId.get(id)?.backendNodeId ?? -1)

  it('groups radios by form owner (or tree root) and name; an unnamed radio has no group', () => {
    const group = (id: string) => factsOf(id)?.radioGroup
    expect(group('f1-s')).toEqual(expect.any(String))
    expect(group('f1-s')).toBe(group('f1-m'))
    expect(group('f1-s')).toBe(group('f1-remote'))
    expect(group('f1-red')).not.toBe(group('f1-s'))
    expect(group('f2-s')).not.toBe(group('f1-s'))
    expect(group('doc-s')).toBe(group('doc-m'))
    expect(group('doc-s')).not.toBe(group('f1-s'))
    expect(group('f1-noname')).toBeNull()
    expect(group('plain')).toBeNull()
    expect(group('aria-radio')).toBeNull()
  })

  it('marks natively disabled controls, controls in a disabled fieldset and anything inside an inert subtree', () => {
    const ids = ['disabled-btn', 'fs-btn', 'fs-input', 'inert-btn', 'inert-deep', 'plain', 'f1-s']
    expect(Object.fromEntries(ids.map((id) => [id, factsOf(id)?.disabled]))).toEqual({
      'disabled-btn': true,
      'fs-btn': true,
      'fs-input': true,
      'inert-btn': true,
      'inert-deep': true,
      plain: false,
      'f1-s': false,
    })
  })

  it('names the nearest composite-role ancestor by its first role token, across open shadow roots', () => {
    const widget = (id: string) => factsOf(id)?.compositeWidget
    const backend = (id: string) => byId.get(id)?.backendNodeId
    expect(widget('tab-1')).toBe(backend('tablist'))
    expect(widget('tab-2')).toBe(backend('tablist'))
    expect(widget('tool-1')).toBe(backend('toolbar'))
    expect(widget('nested-item')).toBe(backend('nested-menu'))
    expect(widget('nested-menu')).toBe(backend('toolbar'))
    expect(widget('aria-radio')).toBe(backend('rg'))
    expect(widget('shadow-option')).toBe(backend('shadow-listbox'))
    expect(widget('tablist')).toBeNull()
    expect(widget('plain')).toBeNull()
  })

  it('B1: reads real focusability; href-less a without tabindex, inert, disabled, tabindex=-1 and invisible are not', () => {
    const ids = ['plain', 'a-href', 'a-nohref-tab', 'tab-1', 'a-nohref', 'inert-deep', 'inert-btn', 'disabled-btn']
    const more = ['fs-btn', 'div-tabneg', 'vis-hidden-btn']
    expect(Object.fromEntries([...ids, ...more].map((id) => [id, factsOf(id)?.focusable]))).toEqual({
      plain: true,
      'a-href': true,
      'a-nohref-tab': true,
      'tab-1': true,
      'a-nohref': false,
      'inert-deep': false,
      'inert-btn': false,
      'disabled-btn': false,
      'fs-btn': false,
      'div-tabneg': false,
      'vis-hidden-btn': false,
    })
  })

  it('N2: reads an own keydown listener or React onKeyDown prop, for composite widgets and their members only', () => {
    const ids = ['keyed-toolbar', 'keyed-tool', 'keyed-item', 'react-item', 'plain-menu', 'keyed-plain']
    expect(Object.fromEntries(ids.map((id) => [id, factsOf(id)?.keydownHandler]))).toEqual({
      'keyed-toolbar': true,
      'keyed-tool': false,
      'keyed-item': true,
      'react-item': true,
      'plain-menu': false,
      'keyed-plain': false,
    })
  })

  it('N3: names the element carrying aria-activedescendant for the widget: the widget itself or a combobox naming it', () => {
    const host = (id: string) => factsOf(id)?.activeDescendantHost
    const backend = (id: string) => byId.get(id)?.backendNodeId
    expect(host('ad-o1')).toBe(backend('ad-listbox'))
    expect(host('combo-o1')).toBe(backend('combo'))
    expect(host('tab-2')).toBeNull()
    expect(host('plain')).toBeNull()
  })

  it('N4: follows the flat tree, so a tab slotted into a shadow tablist belongs to it', () => {
    expect(factsOf('slotted-tab')?.compositeWidget).toBe(byId.get('shadow-tablist')?.backendNodeId)
  })
})

// Content the page switched off: a <dialog> opened with showModal() makes everything outside it inert (aria-hidden or
// not), and CSS interactivity: inert does what the inert attribute does (F2).
const SWITCHED_OFF_HTML = `<!doctype html><html lang="en"><head><title>switched off</title></head><body>
<main aria-hidden="true"><a id="bg-hidden" href="#a">Shop</a></main>
<button id="bg">Join</button>
<dialog id="dlg" aria-label="Age gate"><button id="in-dialog">Confirm</button>
<div inert><button id="in-dialog-inert">Later</button></div>
<div style="interactivity: inert"><button id="in-dialog-css-inert">Skip</button></div></dialog>
<script>document.getElementById('dlg').showModal()</script>
</body></html>`

describe('collectFocusFacts on content the page switched off (F2)', () => {
  let client: BrowserClient
  let browserPage: BrowserPage
  let page: Page
  let byId: Map<string, DOMElement>
  let facts: Map<number, FocusFacts>

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    browserPage = await client.newPage()
    page = browserPage.playwrightPage
    await page.setContent(SWITCHED_OFF_HTML)
    byId = await elementsById(page)
    const collected = await collectFocusFacts(page, [...byId.values()])
    expect(collected.errors).toEqual([])
    facts = collected.facts
  })

  afterAll(async () => {
    await browserPage.close()
    await client.close()
  })

  const factsOf = (id: string): FocusFacts | undefined => facts.get(byId.get(id)?.backendNodeId ?? -1)

  it('marks everything outside an open modal <dialog>, and CSS interactivity: inert, as disabled', () => {
    const ids = ['in-dialog', 'in-dialog-inert', 'in-dialog-css-inert', 'bg', 'bg-hidden']
    expect(Object.fromEntries(ids.map((id) => [id, factsOf(id)?.disabled]))).toEqual({
      'in-dialog': false,
      'in-dialog-inert': true,
      'in-dialog-css-inert': true,
      bg: true,
      'bg-hidden': true,
    })
    expect([factsOf('in-dialog')?.focusable, factsOf('bg')?.focusable]).toEqual([true, false])
  })
})

// React's internals are simulated here (the real-React stale case runs in bench/gaps-dev.test.ts): __reactProps$ holds
// the current handler props, __reactContainer$ marks the root, and React plants a no-op el.onclick for onClick.
const DISCOVERY_HTML = `<!doctype html><html lang="en"><head><title>discovery</title></head><body>
<div id="ptr-down">Pointer down</div>
<div id="root"><div id="react-live">Live</div><div id="react-stale">Stale</div><div id="react-mousedown">Mouse down</div>
<div id="react-hover">Hover</div><div id="react-listener">Listener</div><div id="react-plain">Plain</div></div>
<div id="no-handler">Nothing</div>
<iframe srcdoc="<div id='in-frame'>In frame</div><script>document.getElementById('in-frame').addEventListener('click', function () {})<\/script>"></iframe>
<script>
var noop = function () {}
var byId = function (id) { return document.getElementById(id) }
byId('ptr-down').addEventListener('pointerdown', noop)
byId('root').__reactContainer$t = {}
byId('root').addEventListener('click', noop)
byId('root').addEventListener('keydown', noop)
byId('react-live').__reactProps$t = { onClick: noop, children: 'Live' }
byId('react-live').onclick = function () {}
byId('react-stale').__reactProps$t = { children: 'Stale' }
byId('react-stale').onclick = function () {}
byId('react-mousedown').__reactProps$t = { onMouseDown: noop }
byId('react-hover').__reactProps$t = { onMouseEnter: noop }
byId('react-listener').__reactProps$t = { children: 'Listener' }
byId('react-listener').addEventListener('click', noop)
byId('react-plain').__reactProps$t = { children: 'Plain' }
document.body.addEventListener('click', noop)
document.documentElement.addEventListener('keydown', noop)
document.addEventListener('click', noop)
window.addEventListener('click', noop)
</script>
</body></html>`

describe('discovery by listeners and React props (F9)', () => {
  let client: BrowserClient
  let browserPage: BrowserPage
  let page: Page
  let elements: DOMElement[]

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    browserPage = await client.newPage()
    page = browserPage.playwrightPage
    await page.setContent(DISCOVERY_HTML)
    await page.waitForFunction("document.querySelector('iframe').contentDocument.getElementById('in-frame') !== null")
    const crawl = await crawlDOM(page, 'http://fixture.test/')
    expect(crawl.errors).toEqual([])
    elements = crawl.elements
  })

  afterAll(async () => {
    await browserPage.close()
    await client.close()
  })

  it('finds activation listeners and React handler props; skips html, body, the React root and other frames', () => {
    expect(elements.map(idOf).sort()).toEqual(
      ['ptr-down', 'react-hover', 'react-listener', 'react-live', 'react-mousedown', 'react-stale'].sort(),
    )
  })

  it("takes a React element's handlers from its props, not from the no-op onclick React leaves behind", async () => {
    const handler: Record<string, boolean> = {}
    for (const element of elements) {
      const { signals, errors } = await getInteractivitySignals(page, element)
      expect(errors).toEqual([])
      handler[idOf(element)] = signals.hasClickHandler
    }
    expect(handler).toEqual({
      'ptr-down': true,
      'react-live': true,
      'react-stale': false,
      'react-mousedown': true,
      'react-hover': false,
      'react-listener': true,
    })
  })
})

// React 17+ marks every root and portal container it delegates events from with _reactListening<random> and adds its
// own listeners there; a portal host is otherwise a plain div. #root-class is a root, #own an ordinary control (F9).
const DELEGATION_HTML = `<!doctype html><html lang="en"><head><title>delegation</title></head><body>
<header><div id="portal"></div><div id="portal-class" class="page-actions"></div></header>
<div id="root-class" class="app-actions"></div>
<div id="own">Own</div>
<script>
var noop = function () {}
var hosts = ['portal', 'portal-class', 'root-class']
hosts.forEach(function (id) {
  var el = document.getElementById(id)
  el._reactListeningq7x2 = true
  el.addEventListener('click', noop)
  el.addEventListener('keydown', noop)
  el.addEventListener('pointerdown', noop)
})
document.getElementById('root-class').__reactContainer$t = {}
document.getElementById('own').addEventListener('click', noop)
</script>
</body></html>`

describe('React delegation hosts (F9)', () => {
  let client: BrowserClient
  let browserPage: BrowserPage
  let page: Page
  let elements: DOMElement[]

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    browserPage = await client.newPage()
    page = browserPage.playwrightPage
    await page.setContent(DELEGATION_HTML)
    const crawl = await crawlDOM(page, 'http://fixture.test/')
    expect(crawl.errors).toEqual([])
    elements = crawl.elements
  })

  afterAll(async () => {
    await browserPage.close()
    await client.close()
  })

  it("does not count the listeners React delegates from a root or portal container as the container's own", async () => {
    const handler: Record<string, boolean> = {}
    for (const element of elements) {
      const { signals, errors } = await getInteractivitySignals(page, element)
      expect(errors).toEqual([])
      handler[idOf(element)] = signals.hasClickHandler
    }
    expect(handler).toEqual({ portal: false, 'portal-class': false, 'root-class': false, own: true })
  })
})

describe('isSemanticInteractive for a <details> disclosure', () => {
  let client: BrowserClient
  let browserPage: BrowserPage
  let page: Page
  let elements: DOMElement[]

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
    browserPage = await client.newPage()
    page = browserPage.playwrightPage
    await page.setContent(
      '<!doctype html><html lang="en"><head><title>details</title></head><body>' +
        '<details id="details"><summary id="summary">Shipping</summary><p>3 days</p></details></body></html>',
    )
    elements = (await crawlDOM(page, 'http://fixture.test/')).elements
  })

  afterAll(async () => {
    await browserPage.close()
    await client.close()
  })

  it('is false for the <details> (a group) and true for its <summary> (the control)', async () => {
    const semantic: Record<string, boolean> = {}
    for (const element of elements) {
      semantic[idOf(element)] = (await getInteractivitySignals(page, element)).signals.isSemanticInteractive
    }
    expect(semantic).toEqual({ details: false, summary: true })
  })
})
