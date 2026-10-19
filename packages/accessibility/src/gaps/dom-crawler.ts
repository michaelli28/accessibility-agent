import type { CDPSession, Page } from 'playwright'
import { z } from 'zod'
import type {
  CrawlError,
  CrawlStage,
  DOMElement,
  FocusFacts,
  HiddenCandidate,
  HiddenReason,
  InteractivitySignals,
} from './types.js'

// Port of taskgen/src/dom-crawler.ts (DOMCrawler) as functions, plus listener and React discovery (F9).

const SEMANTIC_INTERACTIVE_SELECTORS = [
  'button',
  'a[href]',
  // Also matches type=hidden and unrendered inputs; findHiddenCandidates drops those before classification.
  'input',
  'select',
  'textarea',
  'details',
  'summary',
  '[contenteditable="true"]',
  'audio[controls]',
  'video[controls]',
]

const PSEUDO_INTERACTIVE_SELECTORS = [
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tablist"]',
  '[role="tree"]',
  '[role="treeitem"]',
  '[role="grid"]',
  '[role="gridcell"]',
  '[tabindex]',
  '[onclick]',
  '[onkeydown]',
  '[onkeyup]',
  '[onmousedown]',
  '[onmouseup]',
  '[ng-click]',
  // Invalid CSS: querySelectorAll throws and the selector is skipped, as in taskgen.
  '[@click]',
  '[v-on\\:click]',
  '[(click)]',
]

const INTERACTIVE_CLASS_PATTERNS = [
  'btn',
  'button',
  'clickable',
  'interactive',
  'action',
  'trigger',
  'toggle',
  'dropdown',
  'link',
  'nav-link',
  'menu-item',
  'tab',
]

// Not details: it is a group, and its summary is the control.
const SEMANTIC_TAGS = ['button', 'a', 'input', 'select', 'textarea', 'summary']
// Pointer events added (F9): Radix/shadcn-style components activate on pointerdown.
const LISTENER_TYPES = [
  'click',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
  'keydown',
  'keyup',
  'touchstart',
  'touchend',
]

const OBJECT_GROUP = 'at-agent-gaps'

// Every element in the document and its open shadow roots whose React props hold any on[A-Z]* function, and every
// React root container (it carries React's delegated listeners for the whole app).
const REACT_SCAN_FN = `function () {
  var handlers = []
  var containers = []
  var visit = function (root) {
    root.querySelectorAll('*').forEach(function (el) {
      Object.keys(el).forEach(function (key) {
        if (key.indexOf('__reactContainer$') === 0) containers.push(el)
        if (key.indexOf('__reactProps$') !== 0) return
        var props = el[key]
        var handler = props && Object.keys(props).some(function (p) {
          return /^on[A-Z]/.test(p) && typeof props[p] === 'function'
        })
        if (handler) handlers.push(el)
      })
      if (el.shadowRoot) visit(el.shadowRoot)
    })
  }
  visit(document)
  return { handlers: handlers, containers: containers }
}`

// Listener discovery pierces frames; the AX tree covers the top document only, and html/body hold delegated listeners.
const DISCOVERABLE_FN = `function () {
  return window === window.top && this.localName !== 'html' && this.localName !== 'body'
}`

// For a React element its props are the source of truth: React leaves the no-op el.onclick it planted after onClick
// is removed. Only activation handlers count, as with the listener types (onMouseEnter or onLoad is not a click).
const REACT_FACTS_FN = `function () {
  var key = Object.keys(this).filter(function (k) { return k.indexOf('__reactProps$') === 0 })[0]
  var props = key === undefined ? null : this[key]
  var activation = /^on(Click|MouseDown|MouseUp|PointerDown|PointerUp|KeyDown|KeyUp|TouchStart|TouchEnd)(Capture)?$/
  return {
    hasProps: props !== null && typeof props === 'object',
    activation: !!props && Object.keys(props).some(function (p) {
      return activation.test(p) && typeof props[p] === 'function'
    }),
    onclickProperty: typeof this.onclick === 'function',
    delegationHost: Object.keys(this).some(function (k) { return k.indexOf('_reactListening') === 0 }),
  }
}`

// visibility:hidden/collapse (own or inherited), content-visibility:hidden and display:none all fail this.
const CHECK_VISIBILITY_FN = 'function () { return this.checkVisibility({ checkVisibilityCSS: true }) }'

// Roles whose members arrow keys move between, so one Tab stop serves the whole widget (G1b).
const COMPOSITE_ROLES = ['radiogroup', 'tablist', 'menu', 'menubar', 'listbox', 'grid', 'treegrid', 'tree', 'toolbar']

// Ancestors are walked along the flat tree: a slotted element's slot first, then across open shadow roots (G1c). The
// role attribute's first token is taken as the role.
const WIDGET_OF_JS = `
  var up = function (el) { return el.assignedSlot || el.parentElement || (el.parentNode && el.parentNode.host) || null }
  var isWidget = function (el) {
    var role = (el.getAttribute('role') || '').trim().split(/\\s+/)[0].toLowerCase()
    return ${JSON.stringify(COMPOSITE_ROLES)}.indexOf(role) !== -1
  }
  var widgetOf = function (el) {
    for (var a = up(el); a; a = up(a)) if (isWidget(a)) return a
    return null
  }`

// By value; the group anchors are then read as nodes only for the few candidates that have one. Chromium reports
// tabIndex 0 for an a without href and inside inert, neither of which takes focus (G1c).
const FOCUS_FLAGS_FN = `function () {${WIDGET_OF_JS}
  // An open modal <dialog> makes everything outside it inert (HTML "blocked by a modal dialog"); Chromium names that
  // reason only when aria-hidden does not mask it, so it is read here. A modal in a shadow root is not seen (F2).
  // CSS interactivity: inert is the attribute's CSS form, and inherited, so it is read on the element itself.
  var inert = getComputedStyle(this).interactivity === 'inert'
  var inModal = false
  for (var a = this; a; a = up(a)) {
    if (a.hasAttribute('inert')) { inert = true; break }
    if (a.localName === 'dialog' && a.matches(':modal')) { inModal = true; break }
  }
  if (!inModal && document.querySelector('dialog:modal') !== null) inert = true
  var disabled = this.matches(':disabled') || inert
  var hrefless = (this.localName === 'a' || this.localName === 'area') &&
    !this.hasAttribute('href') && !this.hasAttribute('tabindex')
  var radio = this.localName === 'input' && this.type === 'radio' && this.name !== ''
  var key = Object.keys(this).filter(function (k) { return k.indexOf('__reactProps$') === 0 })[0]
  var props = key === undefined ? null : this[key]
  return {
    disabled: disabled,
    focusable: this.tabIndex >= 0 && !disabled && !hrefless && this.checkVisibility({ checkVisibilityCSS: true }),
    radioName: radio ? this.name : null,
    inWidget: widgetOf(this) !== null,
    isWidget: isWidget(this),
    reactKeydown: !!props && (typeof props.onKeyDown === 'function' || typeof props.onKeyDownCapture === 'function'),
  }
}`

// The element whose aria-activedescendant manages the nearest widget: the widget itself, or one naming it by id in
// aria-controls or aria-owns (a combobox), in the same tree (G1c).
const ACTIVE_DESCENDANT_HOST_FN = `function () {${WIDGET_OF_JS}
  var w = widgetOf(this)
  if (!w) return null
  if (w.hasAttribute('aria-activedescendant')) return w
  if (!w.id) return null
  var hosts = w.getRootNode().querySelectorAll('[aria-activedescendant]')
  for (var i = 0; i < hosts.length; i++) {
    var refs = ((hosts[i].getAttribute('aria-controls') || '') + ' ' + (hosts[i].getAttribute('aria-owns') || ''))
      .split(/\\s+/)
    if (refs.indexOf(w.id) !== -1) return hosts[i]
  }
  return null
}`

// A radio group is the radios sharing a name and a form owner, or a tree root when they have no form (HTML spec).
const RADIO_OWNER_FN = 'function () { return this.form || this.getRootNode() }'

const WIDGET_FN = `function () {${WIDGET_OF_JS}
  return widgetOf(this)
}`

const FocusFlagsSchema = z.object({
  disabled: z.boolean(),
  focusable: z.boolean(),
  radioName: z.string().nullable(),
  inWidget: z.boolean(),
  isWidget: z.boolean(),
  reactKeydown: z.boolean(),
})

export type DOMCrawl = { elements: DOMElement[]; errors: CrawlError[] }

export async function crawlDOM(page: Page, pageUrl: string): Promise<DOMCrawl> {
  const cdp = await page.context().newCDPSession(page)

  try {
    await cdp.send('DOM.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })

    const domElements: DOMElement[] = []

    for (const selector of [...SEMANTIC_INTERACTIVE_SELECTORS, ...PSEUDO_INTERACTIVE_SELECTORS]) {
      try {
        const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
          nodeId: root.nodeId,
          selector,
        })
        for (const nodeId of nodeIds) {
          const element = await getElementDetails(cdp, nodeId, pageUrl)
          if (element && !domElements.some((e) => e.backendNodeId === element.backendNodeId)) {
            domElements.push(element)
          }
        }
      } catch {
        continue
      }
    }

    const classBasedElements = await findElementsWithInteractiveClasses(cdp, root.nodeId, pageUrl)
    for (const element of classBasedElements) {
      if (!domElements.some((e) => e.backendNodeId === element.backendNodeId)) {
        domElements.push(element)
      }
    }

    // F9: a plain div with an addEventListener or React handler matches no selector; find it by its handlers.
    const errors: CrawlError[] = []
    const react = await attempt('discover-react', errors, () => scanReact(cdp))
    const listened = await attempt('discover-listeners', errors, () =>
      findListenerElements(cdp, root.nodeId, new Set(react?.containers ?? [])),
    )
    const known = new Set(domElements.map((e) => e.backendNodeId))
    const found = [...new Set([...(listened ?? []), ...(react?.handlers ?? [])])].filter((id) => !known.has(id))
    const pushed =
      found.length === 0
        ? []
        : await attempt('discover', errors, async () => {
            const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: found })
            return nodeIds
          })
    for (const nodeId of pushed ?? []) {
      const element = nodeId ? await getElementDetails(cdp, nodeId, pageUrl) : null
      if (element) domElements.push(element)
    }

    return { elements: domElements, errors }
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined)
    await cdp.detach()
  }
}

async function getElementDetails(cdp: CDPSession, nodeId: number, pageUrl: string): Promise<DOMElement | null> {
  try {
    const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: 0 })
    if (!node || node.nodeType !== 1) return null

    const attributes: Record<string, string> = {}
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        attributes[node.attributes[i]] = node.attributes[i + 1]
      }
    }

    let boundingBox: DOMElement['boundingBox'] = null
    try {
      const { model } = await cdp.send('DOM.getBoxModel', { nodeId })
      if (model && model.content) {
        const [x1, y1, x2, , , y3] = model.content
        boundingBox = { x: x1, y: y1, width: x2 - x1, height: y3 - y1 }
      }
    } catch {
      // An unrendered node has no box model; findHiddenCandidates drops it as no-box.
    }

    return {
      nodeId,
      backendNodeId: node.backendNodeId,
      nodeName: node.nodeName,
      localName: node.localName,
      attributes,
      boundingBox,
      pageUrl,
    }
  } catch {
    return null
  }
}

async function findElementsWithInteractiveClasses(
  cdp: CDPSession,
  rootNodeId: number,
  pageUrl: string,
): Promise<DOMElement[]> {
  const elements: DOMElement[] = []

  for (const pattern of INTERACTIVE_CLASS_PATTERNS) {
    try {
      const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
        nodeId: rootNodeId,
        selector: `[class*="${pattern}"]`,
      })
      for (const nodeId of nodeIds) {
        const element = await getElementDetails(cdp, nodeId, pageUrl)
        if (element) elements.push(element)
      }
    } catch {
      continue
    }
  }

  return elements
}

// One pierced listing of every listener under the document; each carries its node's backendNodeId.
async function findListenerElements(
  cdp: CDPSession,
  rootNodeId: number,
  reactContainers: ReadonlySet<number>,
): Promise<number[]> {
  const { object } = await cdp.send('DOM.resolveNode', {
    nodeId: rootNodeId,
    objectGroup: OBJECT_GROUP,
  })
  if (!object.objectId) throw new Error('document resolved to no object')
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
    objectId: object.objectId,
    depth: -1,
    pierce: true,
  })
  const ids = new Set<number>()
  for (const listener of listeners) {
    if (listener.backendNodeId !== undefined && LISTENER_TYPES.includes(listener.type)) ids.add(listener.backendNodeId)
  }

  const found: number[] = []
  for (const backendNodeId of ids) {
    if (reactContainers.has(backendNodeId)) continue
    const { node } = await cdp.send('DOM.describeNode', { backendNodeId })
    if (node.nodeType !== 1) continue
    if ((await callOnNode(cdp, backendNodeId, DISCOVERABLE_FN)) === true) found.push(backendNodeId)
  }
  return found
}

async function scanReact(cdp: CDPSession): Promise<{ handlers: number[]; containers: number[] }> {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: `(${REACT_SCAN_FN})()`,
    objectGroup: OBJECT_GROUP,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.text)
  if (!result.objectId) throw new Error('React scan returned no object')
  return {
    handlers: await elementIds(cdp, await property(cdp, result.objectId, 'handlers')),
    containers: await elementIds(cdp, await property(cdp, result.objectId, 'containers')),
  }
}

async function property(cdp: CDPSession, objectId: string, name: string): Promise<string> {
  const { result } = await cdp.send('Runtime.getProperties', {
    objectId,
    ownProperties: true,
  })
  const value = result.find((p) => p.name === name)?.value?.objectId
  if (!value) throw new Error(`React scan result has no ${name}`)
  return value
}

// backendNodeIds of the elements held by an in-page array.
async function elementIds(cdp: CDPSession, arrayObjectId: string): Promise<number[]> {
  const { result } = await cdp.send('Runtime.getProperties', {
    objectId: arrayObjectId,
    ownProperties: true,
  })
  const ids: number[] = []
  for (const entry of result) {
    const objectId = entry.value?.objectId
    if (!/^\d+$/.test(entry.name) || !objectId) continue
    ids.push((await cdp.send('DOM.describeNode', { objectId })).node.backendNodeId)
  }
  return ids
}

// backendNodeId of the node a function returns when called on an element, or null when it returns none.
async function nodeFrom(cdp: CDPSession, backendNodeId: number, functionDeclaration: string): Promise<number | null> {
  const { object } = await cdp.send('DOM.resolveNode', {
    backendNodeId,
    objectGroup: OBJECT_GROUP,
  })
  if (!object.objectId) throw new Error('node resolved to no object')
  const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.text)
  if (!result.objectId) return null
  return (await cdp.send('DOM.describeNode', { objectId: result.objectId })).node.backendNodeId
}

async function callOnNode(cdp: CDPSession, backendNodeId: number, functionDeclaration: string): Promise<unknown> {
  const { object } = await cdp.send('DOM.resolveNode', {
    backendNodeId,
    objectGroup: OBJECT_GROUP,
  })
  if (!object.objectId) throw new Error('node resolved to no object')
  const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration,
    returnByValue: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.text)
  return result.value
}

// Runs one read; a failure is recorded under its stage and yields null instead of aborting the crawl.
async function attempt<T>(
  stage: CrawlStage,
  errors: CrawlError[],
  read: () => Promise<T>,
  backendNodeId: number | null = null,
): Promise<T | null> {
  try {
    return await read()
  } catch (err) {
    errors.push({ stage, backendNodeId, message: errorMessage(err) })
    return null
  }
}

const ReactFactsSchema = z.object({
  hasProps: z.boolean(),
  activation: z.boolean(),
  onclickProperty: z.boolean(),
  delegationHost: z.boolean(),
})

export type SignalsRead = {
  signals: InteractivitySignals
  errors: CrawlError[]
}

async function readSignals(cdp: CDPSession, element: DOMElement): Promise<SignalsRead> {
  const id = element.backendNodeId
  const errors: CrawlError[] = []
  const attrs = element.attributes
  const hasClickAttribute = !!(
    attrs['onclick'] ||
    attrs['onkeydown'] ||
    attrs['onmousedown'] ||
    attrs['ng-click'] ||
    attrs['v-on:click']
  )

  const hasTabindex = attrs['tabindex'] !== undefined
  // Kept as a scoring signal only; keyboard reachability comes from the Tab walk (F3).
  const tabindexValue = hasTabindex ? parseInt(attrs['tabindex'], 10) || 0 : null

  const className = attrs['class'] || ''
  const classNameHints = INTERACTIVE_CLASS_PATTERNS.filter((pattern) => className.toLowerCase().includes(pattern))

  const hasCursorPointer =
    (await attempt(
      'cursor',
      errors,
      async () => {
        const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [id] })
        if (!nodeIds[0]) throw new Error('node could not be pushed to the frontend')
        const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] })
        return computedStyle.some((p) => p.name === 'cursor' && p.value === 'pointer')
      },
      id,
    )) ?? false

  const listenerTypes = await attempt(
    'listeners',
    errors,
    async () => {
      const { object } = await cdp.send('DOM.resolveNode', {
        backendNodeId: id,
        objectGroup: OBJECT_GROUP,
      })
      if (!object.objectId) throw new Error('node resolved to no object')
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
        objectId: object.objectId,
      })
      return listeners.map((l) => l.type).filter((t) => LISTENER_TYPES.includes(t))
    },
    id,
  )
  // A node that could not be resolved for its listeners cannot be read for props either.
  const react =
    listenerTypes === null
      ? null
      : await attempt(
          'react-props',
          errors,
          async () => ReactFactsSchema.parse(await callOnNode(cdp, id, REACT_FACTS_FN)),
          id,
        )

  // The one click listener that is React's no-op el.onclick does not count once props exist (F9). React 17+ marks
  // each root and portal container it delegates events from with _reactListening<random>: those listeners are React's.
  const ownListeners = react?.delegationHost
    ? []
    : react?.hasProps && react.onclickProperty
      ? withoutOne(listenerTypes ?? [], 'click')
      : (listenerTypes ?? [])

  return {
    signals: {
      hasClickHandler: hasClickAttribute || ownListeners.length > 0 || (react?.activation ?? false),
      hasCursorPointer,
      isSemanticInteractive: SEMANTIC_TAGS.includes(element.localName.toLowerCase()),
      hasTabindex,
      tabindexValue,
      hasRoleAttribute: !!attrs['role'],
      roleValue: attrs['role'] ? attrs['role'] : null,
      hasAriaExpanded: attrs['aria-expanded'] !== undefined,
      classNameHints,
    },
    errors,
  }
}

function withoutOne(types: readonly string[], type: string): string[] {
  const index = types.indexOf(type)
  return index === -1 ? [...types] : [...types.slice(0, index), ...types.slice(index + 1)]
}

async function openDomSession(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  // Node pushes and backendNodeId lookups fail until the document has been requested in this session (F9).
  await cdp.send('DOM.getDocument', { depth: 0 })
  return cdp
}

async function closeDomSession(cdp: CDPSession): Promise<void> {
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP })
  await cdp.detach()
}

export async function getInteractivitySignals(page: Page, element: DOMElement): Promise<SignalsRead> {
  const cdp = await openDomSession(page)
  try {
    return await readSignals(cdp, element)
  } finally {
    await closeDomSession(cdp)
  }
}

export type SignalsCollection = {
  signals: Map<number, InteractivitySignals>
  errors: CrawlError[]
}

// One session for every candidate; each failed read is recorded with its stage.
export async function collectInteractivitySignals(
  page: Page,
  elements: readonly DOMElement[],
): Promise<SignalsCollection> {
  const cdp = await openDomSession(page)
  try {
    const signals = new Map<number, InteractivitySignals>()
    const errors: CrawlError[] = []
    for (const element of elements) {
      const read = await readSignals(cdp, element)
      signals.set(element.backendNodeId, read.signals)
      errors.push(...read.errors)
    }
    return { signals, errors }
  } finally {
    await closeDomSession(cdp)
  }
}

async function hasKeydownListener(cdp: CDPSession, backendNodeId: number): Promise<boolean> {
  const { object } = await cdp.send('DOM.resolveNode', {
    backendNodeId,
    objectGroup: OBJECT_GROUP,
  })
  if (!object.objectId) throw new Error('node resolved to no object')
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: object.objectId })
  return listeners.some((l) => l.type === 'keydown')
}

async function readFocusFacts(cdp: CDPSession, backendNodeId: number): Promise<FocusFacts> {
  const flags = FocusFlagsSchema.parse(await callOnNode(cdp, backendNodeId, FOCUS_FLAGS_FN))
  const owner = flags.radioName === null ? null : await nodeFrom(cdp, backendNodeId, RADIO_OWNER_FN)
  // A listener read per element, so only where arrow-key evidence can matter.
  const grouped = flags.inWidget || flags.isWidget
  return {
    disabled: flags.disabled,
    focusable: flags.focusable,
    radioGroup: owner === null ? null : `${owner}:${flags.radioName}`,
    compositeWidget: flags.inWidget ? await nodeFrom(cdp, backendNodeId, WIDGET_FN) : null,
    keydownHandler: grouped && (flags.reactKeydown || (await hasKeydownListener(cdp, backendNodeId))),
    activeDescendantHost: flags.inWidget ? await nodeFrom(cdp, backendNodeId, ACTIVE_DESCENDANT_HOST_FN) : null,
  }
}

export type FocusFactsCollection = {
  facts: Map<number, FocusFacts>
  errors: CrawlError[]
}

// G1b: one session for every candidate; a candidate whose facts cannot be read gets none and the failure is recorded.
export async function collectFocusFacts(page: Page, elements: readonly DOMElement[]): Promise<FocusFactsCollection> {
  const cdp = await openDomSession(page)
  try {
    const facts = new Map<number, FocusFacts>()
    const errors: CrawlError[] = []
    for (const element of elements) {
      const id = element.backendNodeId
      const read = await attempt('focus-facts', errors, () => readFocusFacts(cdp, id), id)
      if (read) facts.set(id, read)
    }
    return { facts, errors }
  } finally {
    await closeDomSession(cdp)
  }
}

// F1: why a candidate is not rendered or not visible, or null when it is. Throws when the node cannot be read.
async function hiddenReason(cdp: CDPSession, element: DOMElement): Promise<HiddenReason | null> {
  if (element.localName === 'input' && element.attributes['type']?.toLowerCase() === 'hidden') return 'hidden-input'
  let area: number
  try {
    const { model } = await cdp.send('DOM.getBoxModel', {
      backendNodeId: element.backendNodeId,
    })
    area = model.width * model.height
  } catch {
    // Chromium computes no box model for an element that is not rendered.
    return 'no-box'
  }
  if (area === 0) return 'zero-area'
  return (await callOnNode(cdp, element.backendNodeId, CHECK_VISIBILITY_FN)) === true ? null : 'css-hidden'
}

export async function isElementVisible(page: Page, element: DOMElement): Promise<boolean> {
  const cdp = await openDomSession(page)
  try {
    return (await hiddenReason(cdp, element)) === null
  } finally {
    await closeDomSession(cdp)
  }
}

export type HiddenCandidates = {
  hidden: HiddenCandidate[]
  errors: CrawlError[]
}

// One session for the whole candidate list. A candidate whose visibility cannot be read is kept and recorded.
export async function findHiddenCandidates(page: Page, elements: readonly DOMElement[]): Promise<HiddenCandidates> {
  const cdp = await openDomSession(page)
  try {
    const hidden: HiddenCandidate[] = []
    const errors: CrawlError[] = []
    for (const element of elements) {
      const reason = await attempt('visibility', errors, () => hiddenReason(cdp, element), element.backendNodeId)
      if (reason) hidden.push({ backendNodeId: element.backendNodeId, reason })
    }
    return { hidden, errors }
  } finally {
    await closeDomSession(cdp)
  }
}

// acc-gaps#1: whether any of these crawled elements has left the document. One that no longer resolves was collected
// after it left. A closed page proves nothing, so its error propagates.
export async function anyDetached(page: Page, elements: readonly DOMElement[]): Promise<boolean> {
  if (elements.length === 0) return false
  const cdp = await openDomSession(page)
  try {
    for (const element of elements) {
      const connected = await callOnNode(cdp, element.backendNodeId, 'function () { return this.isConnected }').catch(
        (err: unknown) => {
          if (page.isClosed()) throw err
          return false
        },
      )
      if (connected !== true) return true
    }
    return false
  } finally {
    await closeDomSession(cdp)
  }
}

function errorMessage(err: unknown): string {
  // Playwright appends a multi-line call log; the first line carries the cause.
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]
}
