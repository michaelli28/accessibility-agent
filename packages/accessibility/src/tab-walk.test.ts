import { readdirSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi, type MockInstance } from 'vitest'
import type { CDPSession, Page } from 'playwright'
import { BrowserClient, BrowserPage } from '@at-agent/browser'
import { RENDERER_CRASHED } from './renderer-crash.js'
import {
  runTabWalk,
  TabWalkResultSchema,
  focusIdentity,
  groupStops,
  type FocusRead,
  type StyleChange,
  type TabWalkStep,
} from './tab-walk.js'
import { judgeKeyboardTrap, type KeyboardTrapResult } from './keyboard-trap.js'

// Fixtures A, D, E are copied from bench/probes/wrap/fixtures (shell-mode sequences in bench/probes/wrap/RESULT.md).
const FIXTURE_A = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture A</title></head><body>
<h1>Fixture A: three links with ids</h1>
<p><a id="a1" data-p="a1" href="#one">One</a></p>
<p><a id="a2" data-p="a2" href="#two">Two</a></p>
<p><a id="a3" data-p="a3" href="#three">Three</a></p>
</body></html>`

const FIXTURE_D = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture D</title></head><body>
<h1>Fixture D: three identical Read more links, no ids</h1>
<p>Story one. <a data-p="r1" href="#more">Read more</a></p>
<p>Story two. <a data-p="r2" href="#more">Read more</a></p>
<p>Story three. <a data-p="r3" href="#more">Read more</a></p>
</body></html>`

const FIXTURE_E = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture E</title></head><body>
<h1>Fixture E: F55 blur-on-focus</h1>
<p><a id="e1" data-p="e1" href="#before">Before</a></p>
<p><a href="#" id="blurme" data-p="blurme" onfocus="this.blur()">Blur me</a></p>
<p><a id="e3" data-p="e3" href="#after">After</a></p>
</body></html>`

const TAB_SWALLOW_TRAP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trap</title></head><body>
<p><a id="t1" href="#one">One</a></p>
<p><input id="trap" type="text" aria-label="Trap"></p>
<p><a id="t3" href="#three">Three</a></p>
<script>
document.getElementById('trap').addEventListener('keydown', (e) => { if (e.key === 'Tab') e.preventDefault() })
</script>
</body></html>`

const MODAL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Modal</title></head><body>
<p><a id="before" href="#b">Before</a></p>
<p><button id="open" type="button">Open dialog</button></p>
<div id="dlg" role="dialog" aria-modal="true" aria-label="Dialog">
  <button id="ok" type="button">OK</button>
  <button id="cancel" type="button">Cancel</button>
</div>
<script>
const dlg = document.getElementById('dlg')
const opener = document.getElementById('open')
const items = () => [...dlg.querySelectorAll('button')]
document.addEventListener('keydown', (e) => {
  if (dlg.hidden) return
  if (e.key === 'Tab') {
    e.preventDefault()
    const list = items()
    const i = list.indexOf(document.activeElement)
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i + 1) % list.length
    list[next].focus()
  } else if (e.key === 'Escape') {
    dlg.hidden = true
    opener.focus()
  }
})
items()[0].focus()
</script>
</body></html>`

const NO_FOCUSABLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Empty</title></head><body>
<h1>Nothing to focus</h1><p>Plain text only.</p>
<a>anchor without href</a><button disabled>Disabled</button><input type="hidden" name="h">
<button style="display:none">Hidden</button>
</body></html>`

const LEGACY_FIELDS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fields</title></head><body>
<button id="close" class="x  y" aria-label="Close" type="button">X</button>
<input name="q" class="field" type="text">
</body></html>`

const doc = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>\n${body}\n</body></html>`

const links = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `<a id="${prefix}${i}" href="#${prefix}${i}">${prefix}${i}</a>`).join('')

const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

// srcdoc is an attribute value, so the inner document's quotes and ampersands must be escaped.
const srcdoc = (html: string): string => html.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

// The verifier's F-undercount cases: one light-DOM link plus 20 links behind an open shadow root or a same-origin frame.
const SHADOW_20 = doc(
  'Shadow 20',
  `<p><a id="light" href="#light">Light</a></p>
<div id="host"></div>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(links('s', 20))}</script>`,
)

const FRAME_20 = doc(
  'Frame 20',
  `<p><a id="light" href="#light">Light</a></p>
<iframe id="frame" srcdoc="${srcdoc(links('f', 20))}"></iframe>`,
)

const SHADOW_TRAP = doc(
  'Shadow trap',
  `<p><a id="light" href="#light">Light</a></p>
<div id="host"></div>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'open' })
root.innerHTML = '<a id="s1" href="#s1">S1</a><input id="trap" type="text" aria-label="Trap"><a id="s3" href="#s3">S3</a>'
root.getElementById('trap').addEventListener('keydown', (e) => { if (e.key === 'Tab') e.preventDefault() })
</script>`,
)

// Wraps three times, then press 10 opens a dialog that swallows every Tab. The whole-walk
// suspectedTrap flag cannot see this trap; only the tail of the walk can.
const LATE_TRAP = doc(
  'Late trap',
  `<p><a id="w1" href="#1">One</a></p>
<p><a id="w2" href="#2">Two</a></p>
<div id="dlg" hidden><input id="trap" type="text" aria-label="Trap"></div>
<script>
const dlg = document.getElementById('dlg')
let n = 0
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return
  n++
  if (n === 10) { dlg.hidden = false; document.getElementById('trap').focus() }
  if (!dlg.hidden) e.preventDefault()
})
</script>`,
)

// Focus starts on the first link and its own Tab handler drops focus to the body, so press 1 is a
// focusLost with no earlier step behind it: only `initial` can say focus was ever on an element.
const AUTOFOCUS_DROP = doc(
  'Autofocus drop',
  `<p><a id="first" href="#1">First</a></p>
<p><a id="second" href="#2">Second</a></p>
<script>
const first = document.getElementById('first')
first.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); first.blur() } })
first.focus()
</script>`,
)

// The page's only Tab stop blurs itself in its focus handler (dev one-button__M7): no read ever rests on an element.
const ONLY_STOP_BLUR = doc('Only stop blurs', `<p><button id="only" onfocus="this.blur()">Only</button></p>`)

// The body is itself a Tab stop, then a blur-on-arrival button: every read is body, only the button's are drops.
const BODY_STOP_THEN_BLUR = doc(
  'Body stop then blur',
  `<p><button id="only" onfocus="this.blur()">Only</button></p><script>document.body.tabIndex = 0</script>`,
)

// The blur-on-arrival stop on a page whose window.addEventListener throws: the walk cannot see the arrival.
const BLUR_REFUSES_LISTENER = doc(
  'Blur refuses listener',
  `<p><button id="only" onfocus="this.blur()">Only</button></p>
<script>window.addEventListener = function () { throw new Error('refused') }</script>`,
)

// An ordinary page whose every addEventListener and removeEventListener throws.
const TWO_BUTTONS_REFUSE_LISTENERS = doc(
  'Two buttons refuse listeners',
  `<p><button id="b1">One</button> <button id="b2">Two</button></p>
<script>
EventTarget.prototype.addEventListener = function () { throw new Error('refused') }
EventTarget.prototype.removeEventListener = function () { throw new Error('refused') }
</script>`,
)

// Two consecutive blur-on-focus stops: the step behind the second drop is itself a body read.
const DOUBLE_DROP = doc(
  'Double drop',
  `<p><a id="d1" href="#1">One</a></p>
<p><a id="d2" href="#2" onfocus="this.blur()">Two</a></p>
<p><a id="d3" href="#3" onfocus="this.blur()">Three</a></p>`,
)

// Ten tab stops appear a second into the walk: F counted at the start no longer describes the page.
const LATE_FOCUSABLES = doc(
  'Late focusables',
  `<p><a id="l0" href="#l0">L0</a></p>
<div id="more"></div>
<script>setTimeout(() => { document.getElementById('more').innerHTML = ${JSON.stringify(links('m', 10))} }, 1000)</script>`,
)

// MODAL moved into one open shadow root: opener, dialog and Escape target all share the host, so
// only deep identity can tell the opener from the dialog buttons.
const SHADOW_MODAL = doc(
  'Shadow modal',
  `<p><a id="light" href="#light">Light</a></p>
<div id="host"></div>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'open' })
root.innerHTML = '<button id="open" type="button">Open</button><div id="dlg" role="dialog" aria-modal="true" aria-label="Dialog"><button id="ok" type="button">OK</button><button id="cancel" type="button">Cancel</button></div>'
const dlg = root.getElementById('dlg')
const opener = root.getElementById('open')
const items = () => [...dlg.querySelectorAll('button')]
root.addEventListener('keydown', (e) => {
  if (dlg.hidden) return
  if (e.key === 'Tab') {
    e.preventDefault()
    const list = items()
    const i = list.indexOf(root.activeElement)
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i + 1) % list.length
    list[next].focus()
  } else if (e.key === 'Escape') {
    dlg.hidden = true
    opener.focus()
  }
})
items()[0].focus()
</script>`,
)

const CLOSED_SHADOW = doc(
  'Closed shadow',
  `<p><a id="light" href="#light">Light</a></p>
<div id="closed"></div>
<div id="hidden-closed" style="display:none"></div>
<script>
document.getElementById('closed').attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(links('k', 3))}
document.getElementById('hidden-closed').attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(links('h', 3))}
</script>`,
)

// Headless shell stops once on a frame with nothing focusable, skips a tabindex=-1 frame with its
// content, and leaves focus on the frame's body after an F55 blur inside it.
const FRAME_STOPS = doc(
  'Frame stops',
  `<p><a id="light" href="#light">Light</a></p>
<iframe id="empty" srcdoc="<p>Nothing to focus</p>"></iframe>
<iframe id="skipped" tabindex="-1" srcdoc="${srcdoc(links('n', 2))}"></iframe>
<iframe id="blur" srcdoc="${srcdoc('<a id="b0" href="#b0" onfocus="this.blur()">B0</a><a id="b1" href="#b1">B1</a>')}"></iframe>`,
)

// Keys are host + path; served through page.route so other.test is a real cross-origin frame.
const CROSS_ORIGIN_ROUTES = {
  'tabwalk.test/xo.html': doc(
    'Cross-origin',
    `<p><a id="light" href="#light">Light</a></p>
<iframe id="xo" src="http://other.test/frame.html"></iframe>
<iframe id="xo-hidden" style="display:none" src="http://other.test/frame.html"></iframe>
<p><a id="after" href="#after">After</a></p>`,
  ),
  'other.test/frame.html': doc('Frame', links('c', 2)),
}

const OBJECT_ROUTES = {
  'tabwalk.test/object.html': doc(
    'Object',
    `<p><a id="light" href="#light">Light</a></p>
<object id="obj" type="text/html" data="/embedded.html" width="300" height="80"></object>`,
  ),
  'tabwalk.test/embedded.html': doc('Embedded', links('o', 2)),
}

const NESTED_ROUTES = {
  'tabwalk.test/nested.html': doc(
    'Nested',
    `<div id="host"></div>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<a id="s0" href="#s0">S0</a><iframe id="inner-frame" src="/inner.html"></iframe>'</script>`,
  ),
  'tabwalk.test/inner.html': doc(
    'Inner',
    `<a id="f0" href="#f0">F0</a><div id="inner-host"></div>
<script>document.getElementById('inner-host').attachShadow({ mode: 'open' }).innerHTML = '<a id="n0" href="#n0">N0</a>'</script>`,
  ),
}

// Copied verbatim from packages/agent/src/tools.ts executeTab (~lines 221-240); keep in sync.
const TOOLS_TS_FOCUS_EXPR = `
      (() => {
        const el = document.activeElement;
        if (!el || el === document.body) {
          return 'body';
        }

        const tag = el.tagName.toLowerCase();
        const id = el.id ? '#' + el.id : '';
        const className = el.className && typeof el.className === 'string'
          ? '.' + el.className.split(' ').filter(Boolean).join('.')
          : '';
        const name = el.getAttribute('aria-label')
          || el.name
          || (el.textContent || '').slice(0, 30).trim()
          || '';

        return tag + id + className + (name ? ' "' + name + '"' : '');
      })()
    `

const LEGACY_CASES = doc(
  'Legacy',
  `<button data-case="long" type="button">
    A label that runs well past the thirty character slice</button>
<input data-case="name" name="query" type="text">
<button data-case="aria" aria-label="Close dialog" type="button">X</button>
<a data-case="class" class="  nav  item active " href="#c">Classy</a>
<a data-case="id" id="home" href="#h">Home</a>
<div data-case="zero" tabindex="0">Zero name</div>
<script>document.querySelector('[data-case=zero]').name = 0</script>`,
)

// Focus-indicator facts (WCAG 2.4.7 check, focus-indicator.ts).
const INDICATOR_FIELDS = doc(
  'Indicator fields',
  `<style>
#plain:focus { outline: none }
.wrap:focus-within { background-color: rgb(255, 255, 0) }
#pseudo::after { content: ''; display: inline-block; width: 4px; height: 4px }
#pseudo:focus::after { border-bottom: 2px solid rgb(0, 0, 255) }
#late:focus::before { content: '>' }
</style>
<p><a id="plain" href="#p">Plain</a></p>
<div class="wrap"><input id="field" aria-label="Field"></div>
<p><a id="pseudo" class="u  line" href="#u">Pseudo</a></p>
<p><a id="late" href="#l">Late</a></p>`,
)

// Deep elements: a shadow root's top-level link (its parent is the host) and a same-origin frame's link.
const INDICATOR_DEEP = doc(
  'Indicator deep',
  `<p><a id="light" href="#light">Light</a></p>
<div id="host" style="background-color: rgb(9, 9, 9)"></div>
<iframe id="frame" srcdoc="${srcdoc('<style>a:focus { outline: 5px dotted rgb(4, 5, 6) }</style><a id="f0" href="#f0">F0</a>')}"></iframe>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<style>a:focus { outline: 4px dashed rgb(1, 2, 3) }</style><a id="s0" href="#s0">S0</a>'</script>`,
)

const REMOVED_ON_BLUR = doc(
  'Removed on blur',
  `<p><a id="r0" href="#r0">R0</a></p>
<p><a id="gone" href="#g" onfocus="this.addEventListener('blur', () => this.remove(), { once: true })">Gone</a></p>
<p><a id="r2" href="#r2">R2</a></p>`,
)

// When focus moves on to the button, the link's next sibling holds focus in the link's unfocused read.
const NEIGHBOURS = doc(
  'Neighbours',
  `<style>a.bare:focus { outline: none }</style>
<p><a id="l1" class="bare" href="#one">One</a><button id="ok" type="button">OK</button></p>`,
)

// Reviewer X3/B2: the press after the region goes into the region's own child.
const FOCUS_WITHIN_REGION = doc(
  'Region',
  `<style>.region:focus-within { outline: 3px solid rgb(0, 0, 255) }
.region a:focus { outline: 2px solid rgb(255, 0, 0) }</style>
<div id="reg" class="region" tabindex="0">Scroll region <a id="inner" href="#in">Inner link</a></div>
<p><a id="out" href="#out">Outside</a></p>`,
)

// Reviewer X4/N2: a colour animation unrelated to focus.
const ANIMATED = doc(
  'Animated',
  `<style>@keyframes pulse { 0% { color: rgb(0, 0, 0) } 100% { color: rgb(255, 0, 0) } }
a { animation: pulse 0.2s infinite alternate linear } a:focus { outline: none }</style>
<p><a id="an1" href="#1">One</a> <a id="an2" href="#2">Two</a></p>`,
)

// A 2 s ring transition: an unfinished read would catch it midway, on p and on q's previous sibling.
const SLOW_RING = doc(
  'Slow ring',
  `<style>a.slow { transition: box-shadow 2s linear } a.slow:focus { outline: none; box-shadow: 0 0 0 3px rgb(0, 0, 255) }
a.bare:focus { outline: none }</style>
<p><a id="p" class="slow" href="#p">P</a> <a id="q" class="bare" href="#q">Q</a></p>`,
)

// 2.1.2 (acc-walk#1's residuals): traps whose last F+1 presses reach F distinct stops without leaving the page,
// the Tab stops F does not count, and the date and time inputs that bound the fix. A scroller is a
// keyboard-focusable box with no focusable child: Chromium stops on it, and FOCUSABLE_SELECTOR does not count it.
const LOREM = 'Lorem ipsum dolor sit amet. '.repeat(20)
const scroller = (id: string): string =>
  `<div id="${id}" style="width:200px;height:40px;overflow:auto;border:1px solid">${LOREM}</div>`
const scrollers = (n: number, prefix = 's'): string =>
  Array.from({ length: n }, (_, i) => scroller(`${prefix}${i}`)).join('')

// Tab on the last of `loopIds` focuses the first; Shift+Tab on the first focuses the last.
const tabLoop = (loopIds: string[]): string => `<script>
const loop = ${JSON.stringify(loopIds)}.map((id) => document.getElementById(id))
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return
  const i = loop.indexOf(document.activeElement)
  if (!e.shiftKey && i === loop.length - 1) { e.preventDefault(); loop[0].focus() }
  if (e.shiftKey && i === 0) { e.preventDefault(); loop[loop.length - 1].focus() }
})
</script>`

const THREE_LINKS = '<a id="l1" href="#1">1</a> <a id="l2" href="#2">2</a> <a id="l3" href="#3">3</a>'

const ONLY_STOP_TRAP = doc(
  'Only stop trap',
  `<button id="only" type="button">Only</button>
<script>document.getElementById('only').addEventListener('keydown', (e) => { if (e.key === 'Tab') e.preventDefault() })</script>`,
)

const LOOP_EVERY_STOP = doc('Loop every stop', `${THREE_LINKS}\n${tabLoop(['l1', 'l2', 'l3'])}`)

// F counts l1, l2 and OK; the loop is OK and the two scrollers, so it reaches exactly F.
const PADDED_LOOP = doc(
  'Padded loop',
  `<a id="l1" href="#1">1</a> <a id="l2" href="#2">2</a>
<div role="dialog" aria-label="Dialog"><button id="ok" type="button">OK</button>${scroller('s1')}${scroller('s2')}</div>
${tabLoop(['ok', 's1', 's2'])}`,
)

// Tab and Shift+Tab on the button replace it with a copy and focus the copy: a new node on every press.
const RERENDER_EVERY_PRESS = doc(
  'Re-render every press',
  `${THREE_LINKS} <button id="re" type="button">Re</button>
<script>
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.target.id !== 're') return
  e.preventDefault()
  const copy = e.target.cloneNode(true)
  e.target.replaceWith(copy)
  copy.focus()
})
</script>`,
)

const EDITING_HOSTS = doc(
  'Editing hosts',
  `<a id="l1" href="#1">1</a>
<div id="ce-bare" contenteditable>bare</div>
<div id="ce-plain" contenteditable="plaintext-only">plain</div>
<div id="ce-plain-upper" contenteditable="PLAINTEXT-ONLY">plain upper</div>
<div id="ce-upper" contenteditable="TRUE">upper</div>
<div id="ce-true" contenteditable="true">true</div>
<div id="ce-false" contenteditable="false">false</div>`,
)

// A 1x1 GIF, so each image map has a rendered image without a network fetch.
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const img = (usemap: string, style = ''): string =>
  `<img src="${GIF}" width="50" height="50" alt="${usemap}" usemap="#${usemap}" style="${style}">`
const areas = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `<area id="${prefix}${i}" shape="rect" coords="0,0,9,9" href="#${prefix}${i}" alt="${prefix}${i}">`).join('')

// Each map pins one part of the area rule in COUNT_FOCUSABLE_FN (tab-walk.ts).
const IMAGE_MAPS = doc(
  'Image maps',
  `<a id="l1" href="#1">1</a>
${img('shown')}<map name="shown">${areas('s', 2)}</map>
<div style="display:none"><map name="boxless">${areas('b', 1)}</map></div>${img('boxless')}
${img('hidden', 'display:none')}<map name="hidden">${areas('h', 2)}</map>
<img src="${GIF}" width="50" height="50" alt="plain"><map name="orphan">${areas('o', 2)}</map>
${img('byid')}<map id="byid">${areas('i', 1)}</map>
${img('first', 'display:none')}${img('first')}<map name="first">${areas('f', 1)}</map>
<iframe srcdoc="${srcdoc(`${img('framed')}<map name="framed">${areas('fa', 2)}</map>`)}"></iframe>`,
)

const LINK_AND_14_AREAS = doc('A link and 14 areas', `<a id="l1" href="#1">1</a>${img('m')}<map name="m">${areas('a', 14)}</map>`)

const TWO_SCROLLERS = doc('Two scrollers', `${THREE_LINKS}${scroller('s1')}${scroller('s2')}`)

const LONE_DATETIME = doc('Lone datetime', '<label>Meeting time <input id="when" type="datetime-local"></label>')

const TWO_DATETIMES = doc(
  'Two datetimes',
  '<label>Start <input id="start" type="datetime-local"></label> <label>End <input id="end" type="datetime-local"></label>',
)

const DATE_LOOP = doc(
  'Date loop',
  `<a id="l1" href="#1">1</a>
<div role="dialog" aria-label="Dialog"><label>Date <input id="d" type="date"></label> <button id="save" type="button">Save</button></div>
${tabLoop(['d', 'save'])}`,
)

const PICKUP_TIME = '<label>Pick-up time <input id="when" type="datetime-local"></label>'

const SCROLLERS_THEN_DATETIME = doc('Scrollers then datetime', `${scrollers(8)}\n${PICKUP_TIME}`)

const SCROLLERS_DATETIME_SCROLLER = doc(
  'Scrollers, datetime, scroller',
  `${scrollers(7)}\n${PICKUP_TIME}${scroller('t0')}`,
)

// A silent clip: Tab stops on five of an <audio controls>'s controls, all on the one element.
const WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

const LINK_SCROLLERS_AUDIO = doc(
  'Link, scrollers, audio',
  `<a id="l1" href="#1">1</a>${scrollers(10)}
<audio id="au" controls src="${WAV}"></audio>`,
)

// Round 4: more pages with a Tab stop that takes several presses, which a walk budgeted in presses judges wrongly,
// the guards it judges rightly, and the widest such controls on Chromium 143.

// A loop over every stop, armed after the first lap: the date input is the last stop before the wrap, and its
// fourth Tab (from its picker button) goes back to the first link.
const DATE_LAST_IN_LOOP = doc(
  'Date last in a loop',
  `<a id="l1" href="#1">1</a><a id="l2" href="#2">2</a><label>Date <input id="d" type="date"></label>
<script>
const l1 = document.getElementById('l1')
const d = document.getElementById('d')
let laps = 0
let presses = 0
l1.addEventListener('focus', () => { laps++ })
d.addEventListener('focus', () => { presses = 0 })
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || laps < 2) return
  if (!e.shiftKey && document.activeElement === d && ++presses === 4) { e.preventDefault(); l1.focus() }
  if (e.shiftKey && document.activeElement === l1) { e.preventDefault(); d.focus() }
})
</script>`,
)

const LONE_AUDIO = doc('Lone audio', `<audio id="au" controls src="${WAV}"></audio>`)

const LONE_VIDEO = doc('Lone video', `<video id="v" controls width="320" height="180" src="${WAV}"></video>`)

// A common idiom: a text input that becomes a date and time input when it takes focus.
const TYPE_SWAP_DATETIMES = doc(
  'Type swap datetimes',
  `<label>Start <input id="start" type="text" onfocus="this.type='datetime-local'"></label>
<label>End <input id="end" type="text" onfocus="this.type='datetime-local'"></label>`,
)

const TWO_DATETIME_INPUTS = '<input id="start" type="datetime-local"> <input id="end" type="datetime-local">'

const SHADOW_DATETIMES = doc(
  'Shadow datetimes',
  `<div id="host"></div>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(TWO_DATETIME_INPUTS)}</script>`,
)

const FRAME_DATETIMES = doc(
  'Frame datetimes',
  `<a id="l1" href="#1">1</a>
<iframe id="frame" srcdoc="${srcdoc(TWO_DATETIME_INPUTS)}"></iframe>`,
)

const LINK_SCROLLERS_VIDEO = doc(
  'Link, scrollers, video',
  `<a id="l1" href="#1">1</a>${scrollers(10)}
<video id="v" controls width="320" height="180" src="${WAV}"></video>`,
)

// DATE_LOOP with the widest native control: a datetime-local input with milliseconds takes 9 presses.
const MS_DATETIME_LOOP = doc(
  'Millisecond datetime loop',
  `<a id="l1" href="#1">1</a>
<div role="dialog" aria-label="Dialog"><label>Time <input id="d" type="datetime-local" step="0.001"></label> <button id="save" type="button">Save</button></div>
${tabLoop(['d', 'save'])}`,
)

const linkScrollersAudioScrollers = (before: number, after: number): string =>
  doc(
    'Link, scrollers, audio, scrollers',
    `<a id="l1" href="#1">1</a>${scrollers(before)}
<audio id="au" controls src="${WAV}"></audio>${scrollers(after, 't')}`,
  )

// F = 2: in stops, the walk's last F+1 are [s15, audio, t0], 3 elements; its last F+1 presses are [audio, audio, t0].
const TWO_LINKS_SCROLLERS_AUDIO = doc(
  'Two links, scrollers, audio, scrollers',
  `<a id="l1" href="#1">1</a><a id="l2" href="#2">2</a>${scrollers(16)}
<audio id="au" controls src="${WAV}"></audio>${scrollers(4, 't')}`,
)

// A dialog loop from the first datetime-local input to the save button, over a second datetime-local input.
const DATETIMES_SAVE_LOOP = doc(
  'Datetimes and save loop',
  `<a id="l1" href="#1">1</a>
<div role="dialog" aria-label="Dialog"><input id="a" type="datetime-local"> <input id="b" type="datetime-local"> <button id="save" type="button">Save</button></div>
<a id="l2" href="#2">2</a>
${tabLoop(['a', 'save'])}`,
)

// The same loop, last on the page. The probe's seen set must be the walk's last F+1 stops: the last F+1 presses
// hold only part of the loop, so the other key reaching a stop they miss would read as a release.
const DATETIMES_SAVE_LOOP_LAST = doc(
  'Datetimes and save loop, last',
  `<a id="l1" href="#1">1</a>
<div role="dialog" aria-label="Dialog"><input id="a" type="datetime-local"> <input id="b" type="datetime-local"> <button id="save" type="button">Save</button></div>
${tabLoop(['a', 'save'])}`,
)

const SWALLOW_ON_DATE = doc(
  'Swallow on date',
  `<a id="l1" href="#1">1</a><input id="d" type="date"><a id="l2" href="#2">2</a>
<script>document.getElementById('d').addEventListener('keydown', (e) => { if (e.key === 'Tab') e.preventDefault() })</script>`,
)

// A dialog loop [save, date]: the date input's fields are walked natively, and its fourth Tab goes back to save.
const SAVE_DATE_LATE_LOOP = doc(
  'Save, date loop',
  `<a id="l1" href="#1">1</a>
<div role="dialog" aria-label="Dialog"><button id="save" type="button">Save</button> <label>Date <input id="d" type="date"></label></div>
<script>
const save = document.getElementById('save')
const d = document.getElementById('d')
let presses = 0
d.addEventListener('focus', () => { presses = 0 })
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return
  if (!e.shiftKey && document.activeElement === d && ++presses === 4) { e.preventDefault(); save.focus() }
  if (e.shiftKey && document.activeElement === save) { e.preventDefault(); d.focus() }
})
</script>`,
)

// Every fourth Tab on the date input (from its picker button) refocuses it at its first field; Shift+Tab is native.
const REFOCUS_AT_PICKER = doc(
  'Refocus at picker',
  `<a id="l1" href="#1">1</a><input id="d" type="date"><a id="l2" href="#2">2</a>
<script>
const d = document.getElementById('d')
let presses = 0
d.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && ++presses % 4 === 0) { e.preventDefault(); d.blur(); d.focus() }
})
</script>`,
)

// The same, and every Shift+Tab refocuses it too.
const REFOCUS_AT_PICKER_BOTH_KEYS = doc(
  'Refocus at picker, both keys',
  `<a id="l1" href="#1">1</a><input id="d" type="date"><a id="l2" href="#2">2</a>
<script>
const d = document.getElementById('d')
let presses = 0
d.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return
  if (e.shiftKey) { e.preventDefault(); d.blur(); d.focus(); return }
  if (++presses % 4 === 0) { e.preventDefault(); d.blur(); d.focus() }
})
</script>`,
)

// Every Tab and Shift+Tab is caught and moves focus round [x, date, y] by script, so no press walks the date's fields.
const MODAL_INTERCEPT_DATE = doc(
  'Modal intercept over a date',
  `<button id="x">x</button><input id="d" type="date"><button id="y">y</button>
<script>
const order = ['x', 'd', 'y'].map((id) => document.getElementById(id))
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return
  e.preventDefault()
  const i = order.indexOf(document.activeElement)
  order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length].focus()
})
</script>`,
)

// The calibration tripwire's controls, each between two links: on Chromium 143 the datetime-local input with
// milliseconds takes 9 presses and the captioned video 6.
const MS_DATETIME_BETWEEN_LINKS = doc(
  'Millisecond datetime between links',
  `<a id="l1" href="#1">1</a><label>Time <input id="when" type="datetime-local" step="0.001"></label><a id="l2" href="#2">2</a>`,
)

const CAPTIONED_VIDEO_BETWEEN_LINKS = doc(
  'Captioned video between links',
  `<a id="l1" href="#1">1</a>
<video id="v" controls width="320" height="180" src="${WAV}"><track kind="captions" srclang="en" label="English" src="data:text/vtt,WEBVTT" default></video>
<a id="l2" href="#2">2</a>`,
)

// The date first: the walk's 20th stop is then the link, so its last F+1 presses miss the wrap its last F+1 stops hold.
const DATE_THEN_LINK = doc('Date then link', '<label>Date <input id="d" type="date"></label><a id="l1" href="#1">1</a>')

// Every other forward Tab on the date input focuses a clone in its place, so Tab never leaves it; Shift+Tab is native.
const RERENDER_DATE_EVERY_OTHER_TAB = doc(
  'Re-render date every other Tab',
  `<a id="l1" href="#1">1</a><input class="x" type="date"><a id="l2" href="#2">2</a>
<script>
let n = 0
document.addEventListener('keydown', (e) => {
  const el = document.activeElement
  if (e.key !== 'Tab' || e.shiftKey || !el.classList.contains('x') || ++n % 2 === 0) return
  e.preventDefault()
  const clone = el.cloneNode(true)
  el.replaceWith(clone)
  clone.focus()
})
</script>`,
)

const DIRECTIONS = ['forward', 'backward'] as const
type Direction = (typeof DIRECTIONS)[number]

const OUTLINE_KEYS = ['outline-color', 'outline-offset', 'outline-style', 'outline-width']
// Unchanged properties a change record may carry: what the checker needs to tell whether a change draws anything.
const CONTEXT_KEYS = new Set([
  'outline-style',
  'outline-width',
  'outline-color',
  ...['top', 'right', 'bottom', 'left', 'block-start', 'block-end', 'inline-start', 'inline-end'].flatMap((side) =>
    ['style', 'width', 'color'].map((part) => `border-${side}-${part}`),
  ),
  'column-rule-style',
  'column-rule-width',
  'column-rule-color',
  'text-decoration-line',
  'text-emphasis-style',
  '-webkit-text-stroke-width',
  'transform',
  'rotate',
  'scale',
  'translate',
  'perspective',
  'background-color',
  'background-image',
  'box-shadow',
  'content',
])

// Every recorded property either changed or is context for a change.
function expectOnlyChangesAndContext(change: StyleChange): void {
  const focused = change.focused ?? {}
  const unfocused = change.unfocused ?? {}
  const unchanged = Object.keys(focused).filter((k) => k in unfocused && focused[k] === unfocused[k])
  expect(unchanged.filter((k) => !CONTEXT_KEYS.has(k))).toEqual([])
}

// Rebuilds TOOLS_TS_FOCUS_EXPR's string from a read's top-level fields (same rebuild as bench/legacy.ts).
function legacyIdentity(read: FocusRead): string {
  if (read.tag === null || read.isBody) return 'body'
  const id = read.id ? `#${read.id}` : ''
  const className = read.className ? `.${read.className.split(' ').filter(Boolean).join('.')}` : ''
  const name = read.ariaLabel || read.nameProp || (read.text ?? '').trim()
  return read.tag + id + className + (name ? ` "${name}"` : '')
}

// Short settle keeps the suite fast; headless shell showed 0 immediate/settled drift in 1,660 presses.
const FAST = 20

function label(read: FocusRead): string {
  if (read.isBody) return read.hasFocus ? 'body' : 'body!'
  return read.id ?? read.tag ?? 'null'
}

// Like label, but names the deep element when focus sits behind a container.
function deepLabel(read: FocusRead): string {
  if (read.isBody) return label(read)
  return read.deep?.id ?? label(read)
}

// Every read sits behind the same top-level container, and each resolves to its own deep element.
function expectBehindOneContainer(reads: FocusRead[], container: FocusRead['container']): void {
  const hostIds = new Set(reads.map((r) => r.backendNodeId))
  expect(hostIds.size).toBe(1)
  expect(reads.every((r) => r.container === container && r.deepUnavailable === null)).toBe(true)
  const deepIds = reads.map(focusIdentity)
  expect(new Set(deepIds).size).toBe(reads.length)
  expect(deepIds.some((id) => hostIds.has(id))).toBe(false)
}

// Lengths of the runs of consecutive presses on one element. A multi-press control between two links is one run per
// visit, so a walk budgeted in stops walks exactly `presses` runs there; a walk budgeted in presses walks fewer.
function runLengths(steps: readonly TabWalkStep[]): number[] {
  const runs: number[] = []
  steps.forEach((step, i) => {
    const continues = i > 0 && !step.wrapped && focusIdentity(step.settled) === focusIdentity(steps[i - 1].settled)
    if (continues) runs[runs.length - 1]++
    else runs.push(1)
  })
  return runs
}

describe('runTabWalk', () => {
  let client: BrowserClient
  const pages: BrowserPage[] = []

  beforeAll(async () => {
    client = new BrowserClient()
    await client.launch()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(pages.splice(0).map((p) => p.close()))
  })

  afterAll(async () => {
    await client.close()
  })

  async function open(html: string): Promise<BrowserPage> {
    const page = await client.newPage()
    pages.push(page)
    await page.playwrightPage.setContent(html, { waitUntil: 'load' })
    return page
  }

  async function serve(routes: Record<string, string>, path: string): Promise<BrowserPage> {
    const page = await client.newPage()
    pages.push(page)
    const pw = page.playwrightPage
    await pw.route(/^http:\/\/(tabwalk|other)\.test\//, (route) => {
      const url = new URL(route.request().url())
      const body = routes[url.host + url.pathname]
      return body === undefined
        ? route.fulfill({ status: 404, body: '' })
        : route.fulfill({ contentType: 'text/html', body })
    })
    await pw.goto(`http://tabwalk.test${path}`, { waitUntil: 'load' })
    return page
  }

  // Wraps the next CDP session the walk opens so a test can stub it before the walk uses it.
  function interceptNextSession(pw: Page, arm: (session: CDPSession) => void): CDPSession[] {
    const context = pw.context()
    const create = context.newCDPSession.bind(context)
    const opened: CDPSession[] = []
    vi.spyOn(context, 'newCDPSession').mockImplementationOnce(async (target) => {
      const session = await create(target)
      arm(session)
      opened.push(session)
      return session
    })
    return opened
  }

  // Resolves backendNodeIds through a fresh CDP session, independently of the walk's own reads, and
  // returns each node's id attribute: proves a deep id names that element in its own frame or root.
  async function resolveIds(pw: Page, backendNodeIds: (number | null)[]): Promise<(string | null)[]> {
    const session = await pw.context().newCDPSession(pw)
    try {
      await session.send('DOM.getDocument', { depth: 0 })
      const out: (string | null)[] = []
      for (const backendNodeId of backendNodeIds) {
        if (backendNodeId === null) {
          out.push(null)
          continue
        }
        const { object } = await session.send('DOM.resolveNode', {
          backendNodeId,
        })
        const res = await session.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: 'function () { return this.id || null }',
          returnByValue: true,
        })
        out.push(res.result.value as string | null)
      }
      return out
    } finally {
      await session.detach()
    }
  }

  it('fixture A: period F+1 with a wrapped marker on every wrap', async () => {
    const page = await open(FIXTURE_A)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(() => TabWalkResultSchema.parse(result)).not.toThrow()
    expect(result.focusableCount).toBe(3)
    expect(result.defaultPresses).toBe(25)
    expect(result.presses).toBe(25)
    expect(result.steps).toHaveLength(25)
    expect(result.steps.map((s) => s.index)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(result.steps.map((s) => label(s.settled))).toEqual(
      Array.from({ length: 25 }, (_, i) => ['a1', 'a2', 'a3', 'body!'][i % 4]),
    )
    expect(result.steps.filter((s) => s.wrapped).map((s) => s.index)).toEqual([4, 8, 12, 16, 20, 24])
    expect(result.steps.every((s) => s.key === 'Tab' && !s.focusLost && !s.documentReplaced)).toBe(true)
    expect(result.steps.every((s) => s.immediate.backendNodeId === s.settled.backendNodeId)).toBe(true)
    expect(result.steps[0].settled.backendNodeId).toBe(result.steps[4].settled.backendNodeId)
    expect(result.initial.isBody).toBe(true)
    expect(result.initial.hasFocus).toBe(true)
    expect(result.suspectedTrap).toBe(false)
    expect(result.escapeProbe).toBeNull()
    expect(result.error).toBeNull()
  })

  it('fixture D: identical id-less links get three distinct backendNodeIds', async () => {
    const page = await open(FIXTURE_D)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    const firstCycle = result.steps.slice(0, 3).map((s) => s.settled)
    expect(firstCycle.map((r) => [r.tag, r.id, r.text])).toEqual([
      ['a', null, 'Read more'],
      ['a', null, 'Read more'],
      ['a', null, 'Read more'],
    ])
    const ids = firstCycle.map((r) => r.backendNodeId)
    expect(ids.every((id) => typeof id === 'number')).toBe(true)
    expect(new Set(ids).size).toBe(3)
    expect(result.steps.slice(4, 7).map((s) => s.settled.backendNodeId)).toEqual(ids)
  })

  it('fixture E: blur-on-focus yields focusLost, then the next Tab lands on the third link', async () => {
    const page = await open(FIXTURE_E)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    const [s1, s2, s3, s4] = result.steps
    expect(label(s1.settled)).toBe('e1')
    expect(s1.focusLost).toBe(false)
    expect(label(s2.settled)).toBe('body')
    expect(s2.focusLost).toBe(true)
    expect(s2.wrapped).toBe(false)
    expect(label(s3.settled)).toBe('e3')
    expect(s4.wrapped).toBe(true)
    expect(s4.focusLost).toBe(false)
    expect(result.suspectedTrap).toBe(false)
  })

  it('Tab-swallowing element: no wrap, suspectedTrap, escape probe recorded without an exit', async () => {
    const page = await open(TAB_SWALLOW_TRAP)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(3)
    expect(result.steps).toHaveLength(25)
    expect(result.steps.some((s) => s.wrapped)).toBe(false)
    expect(result.steps.slice(1).every((s) => label(s.settled) === 'trap')).toBe(true)
    expect(result.suspectedTrap).toBe(true)

    const probe = result.escapeProbe
    expect(probe).not.toBeNull()
    if (!probe) return
    const trapId = result.steps[24].settled.backendNodeId
    expect(probe.probeKey).toBe('Shift+Tab')
    expect(probe.seenBackendNodeIds).toEqual([trapId])
    expect(probe.before.backendNodeId).toBe(trapId)
    expect(probe.escape.after.backendNodeId).toBe(trapId)
    expect(probe.escape.unseenElement).toBe(false)
    expect(probe.escape.wrapped).toBe(false)
    expect(probe.escape.urlChanged).toBe(false)
    expect(probe.escape.documentReplaced).toBe(false)
    expect(probe.maxPresses).toBe(5)
    expect(probe.steps).toHaveLength(5)
    expect(probe.steps.every((s) => s.key === 'Shift+Tab' && s.settled.backendNodeId === trapId)).toBe(true)
    expect(probe.reachedAt).toBeNull()
  })

  it('modal trapping focus by design: Escape returns focus to an unseen element', async () => {
    const page = await open(MODAL)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(4)
    expect(result.steps).toHaveLength(30)
    expect(label(result.initial)).toBe('ok')
    expect(new Set(result.steps.map((s) => label(s.settled)))).toEqual(new Set(['ok', 'cancel']))
    expect(result.suspectedTrap).toBe(true)

    const probe = result.escapeProbe
    expect(probe).not.toBeNull()
    if (!probe) return
    expect(label(probe.escape.after)).toBe('open')
    expect(probe.escape.unseenElement).toBe(true)
    expect(probe.escape.urlChanged).toBe(false)
    expect(label(probe.steps[0].settled)).toBe('before')
    expect(probe.steps[0].unseenElement).toBe(true)
    expect(probe.reachedAt).toBe(1)
    expect(probe.steps).toHaveLength(1)
  })

  it('page with no focusable elements: F=0, every read is body', async () => {
    const page = await open(NO_FOCUSABLE)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(0)
    expect(result.presses).toBe(10)
    expect(result.steps).toHaveLength(10)
    expect(result.steps.every((s) => s.settled.isBody && !s.focusLost)).toBe(true)
    expect(result.suspectedTrap).toBe(false)
  })

  it('backward walk uses Shift+Tab and visits links in reverse order', async () => {
    const page = await open(FIXTURE_A)
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      direction: 'backward',
    })

    expect(result.direction).toBe('backward')
    expect(result.steps).toHaveLength(25)
    expect(result.steps.every((s) => s.key === 'Shift+Tab')).toBe(true)
    const firstLinks = result.steps
      .map((s) => label(s.settled))
      .filter((l) => !l.startsWith('body'))
      .slice(0, 3)
    expect(firstLinks).toEqual(['a3', 'a2', 'a1'])
    expect(result.steps.filter((s) => s.wrapped).length).toBeGreaterThanOrEqual(5)
    expect(result.suspectedTrap).toBe(false)
  })

  it('records the raw fields the legacy tools.ts identity string is built from, plus focus style', async () => {
    const page = await open(LEGACY_FIELDS)
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 2,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    const [button, input] = result.steps.map((s) => s.settled)
    expect(button).toMatchObject({
      tag: 'button',
      id: 'close',
      className: 'x  y',
      ariaLabel: 'Close',
      text: 'X',
    })
    expect(input).toMatchObject({
      tag: 'input',
      id: null,
      className: 'field',
      nameAttr: 'q',
      nameProp: 'q',
      ariaLabel: null,
    })
    const style = result.steps[0].focusStyle
    expect(style).not.toBeNull()
    expect(Object.keys(style ?? {}).sort()).toEqual(['boxShadow', 'outlineColor', 'outlineStyle', 'outlineWidth'])
  })

  it('rejects presses below the default unless explicitly allowed', async () => {
    const page = await open(FIXTURE_A)
    await expect(runTabWalk(page.playwrightPage, { presses: 3 })).rejects.toThrow(/presses/)

    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 3,
      allowFewerPresses: true,
      escapeProbe: false,
    })
    expect(result.presses).toBe(3)
    expect(result.steps).toHaveLength(3)
    expect(result.suspectedTrap).toBe(true)
    expect(result.escapeProbe).toBeNull()
  })

  it('flags a document replacement and keeps walking on the new document', async () => {
    const page = await client.newPage()
    pages.push(page)
    const pw = page.playwrightPage
    const one = `<!doctype html><html><body><a id="go" href="#x" onfocus="location.href='/two.html'">Go</a></body></html>`
    const two = `<!doctype html><html><body><a id="t1" href="#t">T1</a></body></html>`
    await pw.route('http://tabwalk.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: new URL(route.request().url()).pathname === '/two.html' ? two : one,
      }),
    )
    await pw.goto('http://tabwalk.test/one.html', { waitUntil: 'load' })

    const result = await runTabWalk(pw, {
      settleMs: 300,
      presses: 6,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    expect(result.error).toBeNull()
    expect(result.steps.filter((s) => s.documentReplaced)).toHaveLength(1)
    expect(result.steps.at(-1)?.settled.url).toBe('http://tabwalk.test/two.html')
    expect(result.steps.some((s) => s.settled.id === 't1')).toBe(true)
  })

  it('opens one CDP session and detaches it after the walk', async () => {
    const page = await open(FIXTURE_A)
    const spy = vi.spyOn(page.playwrightPage.context(), 'newCDPSession')
    await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 2,
      allowFewerPresses: true,
    })

    expect(spy).toHaveBeenCalledTimes(1)
    const session: CDPSession = await spy.mock.results[0].value
    await expect(session.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow()
  })

  it('records a mid-walk error, returns partial result, and still detaches', async () => {
    const page = await open(FIXTURE_A)
    const pw = page.playwrightPage
    const spy = vi.spyOn(pw.context(), 'newCDPSession')
    vi.spyOn(pw.keyboard, 'press').mockRejectedValueOnce(new Error('boom'))

    const result = await runTabWalk(pw, { settleMs: FAST })

    expect(result.error).toEqual({ phase: 'walk', index: 1, message: 'boom' })
    expect(result.steps).toHaveLength(0)
    expect(result.suspectedTrap).toBeNull()
    expect(result.escapeProbe).toBeNull()
    const session: CDPSession = await spy.mock.results[0].value
    await expect(session.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow()
  })

  it('detaches the CDP session when setup throws', async () => {
    const page = await open(FIXTURE_A)
    const pw = page.playwrightPage
    const spies: { detach?: MockInstance<CDPSession['detach']> } = {}
    const opened = interceptNextSession(pw, (session) => {
      vi.spyOn(session, 'send').mockRejectedValueOnce(new Error('setup boom'))
      spies.detach = vi.spyOn(session, 'detach')
    })

    await expect(runTabWalk(pw, { settleMs: FAST })).rejects.toThrow('setup boom')

    expect(opened).toHaveLength(1)
    expect(spies.detach).toHaveBeenCalledTimes(1)
    await expect(opened[0].send('Runtime.evaluate', { expression: '1' })).rejects.toThrow()
  })

  it('records the error and still detaches when the page closes mid-walk', async () => {
    const page = await open(FIXTURE_A)
    const pw = page.playwrightPage
    const spies: { detach?: MockInstance<CDPSession['detach']> } = {}
    interceptNextSession(pw, (session) => {
      spies.detach = vi.spyOn(session, 'detach')
    })
    const press = pw.keyboard.press.bind(pw.keyboard)
    let count = 0
    vi.spyOn(pw.keyboard, 'press').mockImplementation(async (key, options) => {
      count++
      return count === 3 ? pw.close() : press(key, options)
    })

    const result = await runTabWalk(pw, { settleMs: FAST })

    expect(result.steps).toHaveLength(2)
    expect(result.error).toMatchObject({ phase: 'walk', index: 3 })
    expect(result.suspectedTrap).toBeNull()
    expect(spies.detach).toHaveBeenCalledTimes(1)
  })

  it('open shadow root: F counts shadow links, the walk wraps, deep reads name each link', async () => {
    const page = await open(SHADOW_20)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(() => TabWalkResultSchema.parse(result)).not.toThrow()
    expect(result.focusableCount).toBe(21)
    expect(result.fIncomplete).toBe(false)
    expect(result.presses).toBe(115)
    expect(result.steps.filter((s) => s.wrapped).map((s) => s.index)).toEqual([22, 44, 66, 88, 110])
    expect(result.suspectedTrap).toBe(false)
    expect(result.escapeProbe).toBeNull()

    const cycle = result.steps.slice(0, 22).map((s) => s.settled)
    expect(cycle.map(deepLabel)).toEqual(['light', ...ids('s', 20), 'body!'])
    expectBehindOneContainer(cycle.slice(1, 21), 'shadow-host')
    expect(await resolveIds(page.playwrightPage, cycle.slice(1, 21).map(focusIdentity))).toEqual(ids('s', 20))
    expect(cycle[0]).toMatchObject({ container: null, deepUnavailable: null })
    expect(cycle[0].deep?.backendNodeId).toBe(cycle[0].backendNodeId)
  })

  it('same-origin frame: F counts frame links, the walk wraps, deep reads name each link', async () => {
    const page = await open(FRAME_20)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(21)
    expect(result.fIncomplete).toBe(false)
    expect(result.presses).toBe(115)
    expect(result.steps.filter((s) => s.wrapped).map((s) => s.index)).toEqual([22, 44, 66, 88, 110])
    expect(result.suspectedTrap).toBe(false)

    const cycle = result.steps.slice(0, 22).map((s) => s.settled)
    expect(cycle.map(deepLabel)).toEqual(['light', ...ids('f', 20), 'body!'])
    expectBehindOneContainer(cycle.slice(1, 21), 'iframe')
    expect(await resolveIds(page.playwrightPage, cycle.slice(1, 21).map(focusIdentity))).toEqual(ids('f', 20))
  })

  it('modal inside a shadow root: Escape to the opener in the same root counts as an unseen element', async () => {
    const page = await open(SHADOW_MODAL)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(4)
    expect(deepLabel(result.initial)).toBe('ok')
    expect(new Set(result.steps.map((s) => deepLabel(s.settled)))).toEqual(new Set(['ok', 'cancel']))
    expect(result.suspectedTrap).toBe(true)

    const probe = result.escapeProbe
    expect(probe).not.toBeNull()
    if (!probe) return
    expect(await resolveIds(page.playwrightPage, probe.seenBackendNodeIds)).toEqual(
      expect.arrayContaining(['ok', 'cancel']),
    )
    expect(probe.seenBackendNodeIds).toHaveLength(2)
    expect(probe.escape.after.backendNodeId).toBe(probe.before.backendNodeId)
    expect(deepLabel(probe.escape.after)).toBe('open')
    expect(probe.escape.unseenElement).toBe(true)
    expect(label(probe.steps[0].settled)).toBe('light')
    expect(probe.reachedAt).toBe(1)
  })

  it('Tab-swallowing input inside a shadow root: still a suspected trap, escape probe finds no exit', async () => {
    const page = await open(SHADOW_TRAP)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(4)
    expect(result.steps).toHaveLength(30)
    expect(result.steps.some((s) => s.wrapped)).toBe(false)
    expect(result.steps.slice(2).every((s) => s.settled.deep?.id === 'trap')).toBe(true)
    expect(result.suspectedTrap).toBe(true)

    const probe = result.escapeProbe
    expect(probe).not.toBeNull()
    if (!probe) return
    const trap = result.steps[29].settled
    expect(trap.container).toBe('shadow-host')
    expect(focusIdentity(trap)).not.toBe(trap.backendNodeId)
    expect(probe.seenBackendNodeIds).toEqual([focusIdentity(trap)])
    expect(probe.escape.unseenElement).toBe(false)
    expect(probe.escape.wrapped).toBe(false)
    expect(probe.maxPresses).toBe(6)
    expect(probe.steps).toHaveLength(6)
    expect(probe.steps.every((s) => s.settled.deep?.id === 'trap' && !s.unseenElement && !s.wrapped)).toBe(true)
    expect(probe.reachedAt).toBeNull()
  })

  it('nested containers: the deep read follows shadow root -> frame -> shadow root', async () => {
    const page = await serve(NESTED_ROUTES, '/nested.html')
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(3)
    expect(result.fIncomplete).toBe(false)
    const cycle = result.steps.slice(0, 4).map((s) => s.settled)
    expect(cycle.map(deepLabel)).toEqual(['s0', 'f0', 'n0', 'body!'])
    expectBehindOneContainer(cycle.slice(0, 3), 'shadow-host')
    expect(await resolveIds(page.playwrightPage, cycle.slice(0, 3).map(focusIdentity))).toEqual(['s0', 'f0', 'n0'])
    expect(result.suspectedTrap).toBe(false)
  })

  it('same-origin object: F counts its document, deep reads name each link behind the object', async () => {
    const page = await serve(OBJECT_ROUTES, '/object.html')
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(3)
    expect(result.fIncomplete).toBe(false)
    const cycle = result.steps.slice(0, 4).map((s) => s.settled)
    expect(cycle.map(deepLabel)).toEqual(['light', 'o0', 'o1', 'body!'])
    expectBehindOneContainer(cycle.slice(1, 3), 'object')
    expect(await resolveIds(page.playwrightPage, cycle.slice(1, 3).map(focusIdentity))).toEqual(['o0', 'o1'])
    expect(result.suspectedTrap).toBe(false)
  })

  it('cross-origin frame: container recorded, deep null with a reason, F flagged incomplete', async () => {
    const page = await serve(CROSS_ORIGIN_ROUTES, '/xo.html')
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(3)
    expect(result.fIncomplete).toBe(true)
    expect(result.fIncompleteCauses).toEqual({
      crossOriginFrames: 1,
      closedShadowRoots: 0,
    })
    const cycle = result.steps.slice(0, 5).map((s) => s.settled)
    expect(cycle.map(deepLabel)).toEqual(['light', 'xo', 'xo', 'after', 'body!'])
    for (const read of cycle.slice(1, 3)) {
      expect(read).toMatchObject({
        container: 'iframe',
        deep: null,
        deepUnavailable: 'cross-origin',
      })
      expect(focusIdentity(read)).toBe(read.backendNodeId)
    }
    expect(result.suspectedTrap).toBe(false)
  })

  it('closed shadow root: deep null with a reason, F flagged incomplete, hidden hosts ignored', async () => {
    const page = await open(CLOSED_SHADOW)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(1)
    expect(result.fIncomplete).toBe(true)
    expect(result.fIncompleteCauses).toEqual({
      crossOriginFrames: 0,
      closedShadowRoots: 1,
    })
    const cycle = result.steps.slice(0, 5).map((s) => s.settled)
    expect(cycle.map(deepLabel)).toEqual(['light', 'closed', 'closed', 'closed', 'body!'])
    for (const read of cycle.slice(1, 4)) {
      expect(read).toMatchObject({
        container: 'shadow-host',
        deep: null,
        deepUnavailable: 'closed-shadow-root',
      })
    }
    expect(result.suspectedTrap).toBe(false)
  })

  it('frame stops: an empty frame is one stop, a tabindex=-1 frame is skipped, a blur inside a frame is not focusLost', async () => {
    const page = await open(FRAME_STOPS)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(4)
    expect(result.fIncomplete).toBe(false)
    const [light, empty, blurred, b1, wrap] = result.steps.slice(0, 5)
    expect(label(light.settled)).toBe('light')
    expect(empty.settled).toMatchObject({
      id: 'empty',
      container: 'iframe',
      deep: { tag: 'body', isBody: true },
    })
    expect(blurred.settled).toMatchObject({
      id: 'blur',
      container: 'iframe',
      deep: { tag: 'body', isBody: true },
    })
    expect([empty, blurred].every((s) => !s.focusLost && !s.wrapped)).toBe(true)
    expect(b1.settled.deep?.id).toBe('b1')
    expect(wrap.wrapped).toBe(true)
    expect(result.suspectedTrap).toBe(false)
  })

  it.each(['long', 'name', 'aria', 'class', 'id', 'zero', 'body'])(
    'legacy identity matches the tools.ts expression: %s',
    async (kase) => {
      const page = await open(LEGACY_CASES)
      const pw = page.playwrightPage
      if (kase !== 'body') await pw.evaluate(`document.querySelector('[data-case="${kase}"]').focus()`)
      const expected = await pw.evaluate<string>(TOOLS_TS_FOCUS_EXPR)

      const result = await runTabWalk(pw, {
        settleMs: 0,
        presses: 1,
        allowFewerPresses: true,
        escapeProbe: false,
      })

      expect(legacyIdentity(result.initial)).toBe(expected)
    },
  )

  it("records launch facts from the page's browser, or nulls when it has none", async () => {
    const page = await open(FIXTURE_A)
    const pw = page.playwrightPage
    const short = {
      settleMs: FAST,
      presses: 1,
      allowFewerPresses: true,
      escapeProbe: false,
    }

    const result = await runTabWalk(pw, short)
    expect(result.launchFacts.browserVersion).toBe(pw.context().browser()?.version())
    // BrowserClient launches headless, which Playwright serves with the headless-shell binary.
    expect(result.launchFacts.executableBasename).toMatch(/^chrome-headless-shell(\.exe)?$/)

    vi.spyOn(pw.context(), 'browser').mockReturnValue(null)
    const orphan = await runTabWalk(pw, short)
    expect(orphan.launchFacts).toEqual({
      browserVersion: null,
      executableBasename: null,
    })
  })

  it('indicator: records only the computed-style properties that change, with the values needed to judge them', async () => {
    const page = await open(INDICATOR_FIELDS)
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 6,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    expect(() => TabWalkResultSchema.parse(result)).not.toThrow()
    const [plain, field, pseudo, late, wrap] = result.steps
    expect([plain, field, pseudo, late].map((s) => deepLabel(s.settled))).toEqual(['plain', 'field', 'pseudo', 'late'])
    expect(wrap.wrapped).toBe(true)
    expect(wrap.indicator).toBeNull()
    for (const s of [plain, field, pseudo, late]) s.indicator?.changes.forEach(expectOnlyChangesAndContext)

    // The UA's a:focus-visible sets outline-offset; #plain:focus removes the outline, so only the offset changes.
    expect(plain.indicator).toMatchObject({
      unfocusedStatus: 'captured',
      unfocusedAt: 2,
      unfocusedError: null,
      unfocusedDrift: [],
    })
    expect(plain.indicator?.changes.map((c) => c.target)).toEqual(['element'])
    const [outline] = plain.indicator?.changes ?? []
    expect(Object.keys(outline.focused ?? {}).sort()).toEqual(OUTLINE_KEYS)
    expect(outline.focused).toMatchObject({
      'outline-style': 'none',
      'outline-offset': '1px',
    })
    expect(outline.unfocused).toMatchObject({
      'outline-style': 'none',
      'outline-offset': '0px',
    })
    expect(plain.settled.deep?.classAttr).toBeNull()

    expect(field.indicator?.changes.find((c) => c.target === 'parent')).toEqual({
      target: 'parent',
      focused: { 'background-color': 'rgb(255, 255, 0)' },
      unfocused: { 'background-color': 'rgba(0, 0, 0, 0)' },
    })

    expect(pseudo.settled.deep?.classAttr).toBe('u  line')
    const after = pseudo.indicator?.changes.find((c) => c.target === 'after')
    expect(after?.focused).toMatchObject({
      'border-bottom-style': 'solid',
      'border-bottom-width': '2px',
      'border-bottom-color': 'rgb(0, 0, 255)',
    })
    expect(after?.unfocused).toMatchObject({
      'border-bottom-style': 'none',
      'border-bottom-width': '0px',
    })
    // Read on the wrap press: the last element before a wrap still gets an unfocused read.
    expect(pseudo.indicator).toMatchObject({
      unfocusedStatus: 'captured',
      unfocusedAt: 4,
    })

    // A box that exists in one state only: the other state is null.
    const before = late.indicator?.changes.find((c) => c.target === 'before')
    expect(before?.focused?.content).toBe('">"')
    expect(before?.unfocused).toBeNull()
    expect(late.indicator).toMatchObject({
      unfocusedStatus: 'captured',
      unfocusedAt: 5,
    })
  })

  it("indicator: the walk's last focused element has no unfocused read", async () => {
    const page = await open(FIXTURE_A)
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 2,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    expect(result.steps.map((s) => s.indicator?.unfocusedStatus)).toEqual(['captured', 'not-read'])
    expect(result.steps[0].indicator?.unfocusedDrift).toBeNull()
    expect(result.steps[1].indicator).toEqual({
      unfocusedStatus: 'not-read',
      unfocusedAt: null,
      unfocusedError: null,
      changes: [],
      unfocusedDrift: null,
    })
  })

  it('indicator: focus that never leaves an element is still-focused, never an unfocused read', async () => {
    const page = await open(TAB_SWALLOW_TRAP)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    const statuses = result.steps.map((s) => s.indicator?.unfocusedStatus)
    expect(statuses[0]).toBe('captured')
    expect(statuses.slice(1, 24).every((s) => s === 'still-focused')).toBe(true)
    expect(statuses[24]).toBe('not-read')
    expect(result.steps[5].indicator).toMatchObject({
      changes: [],
      unfocusedAt: 7,
    })
  })

  it('indicator: an element containing the focus is read once focus leaves its subtree (reviewer B2)', async () => {
    const page = await open(FOCUS_WITHIN_REGION)
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 5,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    const [reg, inner, out, wrap] = result.steps
    expect([reg, inner, out].map((s) => deepLabel(s.settled))).toEqual(['reg', 'inner', 'out'])
    expect(wrap.wrapped).toBe(true)
    expect(reg.indicator).toMatchObject({
      unfocusedStatus: 'captured',
      unfocusedAt: 3,
    })
    expect(reg.indicator?.changes.find((c) => c.target === 'element')).toMatchObject({
      focused: { 'outline-style': 'solid', 'outline-color': 'rgb(0, 0, 255)' },
      unfocused: { 'outline-style': 'none' },
    })
    expect(inner.indicator).toMatchObject({
      unfocusedStatus: 'captured',
      unfocusedAt: 3,
    })
  })

  it('indicator: an ancestor or sibling that holds focus in the unfocused read is not compared', async () => {
    const page = await open(NEIGHBOURS)
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 4,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    const [l1, ok] = result.steps
    expect([l1, ok].map((s) => deepLabel(s.settled))).toEqual(['l1', 'ok'])
    expect(l1.indicator?.unfocusedStatus).toBe('captured')
    expect(l1.indicator?.changes.map((c) => c.target)).toEqual(['element'])
    expect(ok.indicator?.changes.map((c) => c.target)).toEqual(['element'])
  })

  it('indicator: CSS transitions on the compared elements are finished before each read', async () => {
    const page = await open(SLOW_RING)
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 4,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    const [p, q] = result.steps
    expect([p, q].map((s) => deepLabel(s.settled))).toEqual(['p', 'q'])
    expect(p.indicator?.changes).toEqual([
      {
        target: 'element',
        focused: expect.objectContaining({
          'box-shadow': 'rgb(0, 0, 255) 0px 0px 0px 3px',
        }),
        unfocused: expect.objectContaining({ 'box-shadow': 'none' }),
      },
    ])
    expect(q.indicator?.changes.map((c) => c.target)).toEqual(['element'])
    expect(p.indicator?.unfocusedDrift).toEqual([])
  })

  it('indicator: unfocused drift lists what changes between two unfocused reads (reviewer N2)', async () => {
    const animated = await open(ANIMATED)
    const walk = await runTabWalk(animated.playwrightPage, { settleMs: FAST })

    const drifts = walk.steps.flatMap((s) => (s.indicator?.unfocusedDrift ? [s.indicator.unfocusedDrift] : []))
    expect(drifts.length).toBeGreaterThan(0)
    expect(drifts.some((d) => d.includes('element:color'))).toBe(true)
    // an1 is an2's animated previous sibling and holds focus at an2's drift read: it cannot be re-read unfocused.
    const an2 = walk.steps.filter((s) => s.settled.deep?.id === 'an2' && s.indicator?.unfocusedDrift)
    expect(an2.length).toBeGreaterThan(0)
    expect(an2.every((s) => s.indicator?.unfocusedDrift?.includes('previous-sibling:*'))).toBe(true)

    const still = await open(FIXTURE_A)
    const plain = await runTabWalk(still.playwrightPage, { settleMs: FAST })
    const plainDrifts = plain.steps.flatMap((s) => (s.indicator?.unfocusedDrift ? [s.indicator.unfocusedDrift] : []))
    expect(plainDrifts.length).toBeGreaterThan(10)
    // A static page has no property drift. The link read unfocused on the wrap press compares body and
    // html, which hold focus again at its drift read: target:* only.
    expect(plainDrifts.flat().filter((key) => !key.endsWith(':*'))).toEqual([])
    const a3 = plain.steps.find((s) => s.settled.id === 'a3' && s.indicator?.unfocusedDrift)
    expect(a3?.indicator?.unfocusedDrift).toEqual(['grandparent:*', 'great-grandparent:*'])
  })

  it('indicator: an element removed when focus leaves it is recorded as removed', async () => {
    const page = await open(REMOVED_ON_BLUR)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.suspectedTrap).toBe(false)
    const gone = result.steps.filter((s) => s.settled.id === 'gone')
    expect(gone).toHaveLength(1)
    expect(gone[0].indicator).toMatchObject({
      unfocusedStatus: 'removed',
      changes: [],
      unfocusedAt: gone[0].index + 1,
    })
    expect(result.steps[0].indicator?.unfocusedStatus).toBe('captured')
  })

  it('indicator: a document replaced after focus leaves the element is recorded as document-replaced', async () => {
    const page = await client.newPage()
    pages.push(page)
    const pw = page.playwrightPage
    const one = `<!doctype html><html><body><a id="go" href="#x" onblur="location.href='/two.html'">Go</a><a id="stay" href="#s">Stay</a></body></html>`
    const two = `<!doctype html><html><body><a id="t1" href="#t">T1</a></body></html>`
    await pw.route('http://tabwalk.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: new URL(route.request().url()).pathname === '/two.html' ? two : one,
      }),
    )
    await pw.goto('http://tabwalk.test/one.html', { waitUntil: 'load' })

    const result = await runTabWalk(pw, {
      settleMs: 300,
      presses: 3,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    expect(result.error).toBeNull()
    expect(label(result.steps[0].settled)).toBe('go')
    expect(result.steps[1].documentReplaced).toBe(true)
    expect(result.steps[0].indicator).toMatchObject({
      unfocusedStatus: 'document-replaced',
      changes: [],
      unfocusedAt: 2,
    })
  })

  it('indicator: reads the deep element inside a shadow root and a frame; focusStyle stays the top-level element', async () => {
    const page = await open(INDICATOR_DEEP)
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 4,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    const [light, shadow, frame, wrap] = result.steps
    expect([light, shadow, frame].map((s) => deepLabel(s.settled))).toEqual(['light', 's0', 'f0'])
    expect(wrap.wrapped).toBe(true)

    expect(shadow.settled.container).toBe('shadow-host')
    expect(shadow.focusStyle?.outlineStyle).not.toBe('dashed')
    expect(shadow.indicator?.unfocusedStatus).toBe('captured')
    // The host is the shadow root's parent; its unchanged background is not recorded.
    expect(shadow.indicator?.changes.map((c) => c.target)).toEqual(['element'])
    expect(shadow.indicator?.changes[0]).toMatchObject({
      focused: {
        'outline-style': 'dashed',
        'outline-width': '4px',
        'outline-color': 'rgb(1, 2, 3)',
      },
      unfocused: { 'outline-style': 'none' },
    })

    expect(frame.settled.container).toBe('iframe')
    expect(frame.indicator?.unfocusedStatus).toBe('captured')
    expect(frame.indicator?.changes.find((c) => c.target === 'element')).toMatchObject({
      focused: { 'outline-style': 'dotted', 'outline-width': '5px' },
      unfocused: { 'outline-style': 'none' },
    })
  })

  it('indicator: null when the focused element is behind a boundary page JS cannot cross', async () => {
    const page = await serve(CROSS_ORIGIN_ROUTES, '/xo.html')
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    const cycle = result.steps.slice(0, 5)
    expect(cycle.map((s) => s.settled.deepUnavailable)).toEqual([null, 'cross-origin', 'cross-origin', null, null])
    expect(cycle.map((s) => s.indicator === null)).toEqual([false, true, true, false, true])
    expect(cycle[0].indicator?.unfocusedStatus).toBe('captured')
  })

  it('indicator: adds at most one in-page call per press', async () => {
    const calls: number[] = []
    for (const presses of [4, 12]) {
      const page = await open(FIXTURE_A)
      const pw = page.playwrightPage
      const spies: { send?: MockInstance<CDPSession['send']> } = {}
      interceptNextSession(pw, (session) => {
        spies.send = vi.spyOn(session, 'send')
      })
      await runTabWalk(pw, {
        settleMs: 0,
        presses,
        allowFewerPresses: true,
        escapeProbe: false,
      })
      const inPage = (spies.send?.mock.calls ?? []).filter(
        ([method]) => method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn',
      )
      calls.push(inPage.length)
    }

    // Without the indicator a press makes 4: an activeElement evaluate and a read call, immediate and settled.
    expect((calls[1] - calls[0]) / 8).toBeLessThanOrEqual(5)
  })

  it('indicator: a failing style read never breaks the walk; the step records read-failed', async () => {
    const page = await open(
      doc(
        'Hostile',
        `<p><a id="h1" href="#1">One</a></p><p><a id="h2" href="#2">Two</a></p>
<script>Element.prototype.getAnimations = () => { throw new Error('hostile page') }</script>`,
      ),
    )
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.error).toBeNull()
    expect(result.suspectedTrap).toBe(false)
    expect(result.steps.slice(0, 3).map((s) => deepLabel(s.settled))).toEqual(['h1', 'h2', 'body!'])
    const reads = result.steps.filter((s) => s.indicator !== null)
    expect(reads.length).toBeGreaterThan(0)
    for (const s of reads) {
      expect(s.indicator).toMatchObject({ unfocusedStatus: 'read-failed', changes: [], unfocusedAt: s.index })
      expect(s.indicator?.unfocusedError).toMatch(/hostile page/)
    }
  })

  it('indicator: leaves no element references in the page after the walk', async () => {
    const page = await open(FIXTURE_A)
    const pw = page.playwrightPage
    await runTabWalk(pw, {
      settleMs: FAST,
      presses: 3,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    const keys = await pw.evaluate(() => Object.getOwnPropertyNames(window).filter((k) => k.startsWith('__atAgent')))
    expect(keys).toEqual(['__atAgentTabWalk'])
  })

  it('probe gate: a page that wraps early and traps late is still probed', async () => {
    const page = await open(LATE_TRAP)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(2)
    expect(result.steps.filter((s) => s.wrapped).map((s) => s.index)).toEqual([3, 6, 9])
    // The whole-walk flag stays false (gaps/keyboard.ts reads it); the tail of the walk gates the probe.
    expect(result.suspectedTrap).toBe(false)
    expect(result.steps.slice(-3).every((s) => s.settled.id === 'trap')).toBe(true)

    const probe = result.escapeProbe
    expect(probe).not.toBeNull()
    if (!probe) return
    expect(probe.escape.unseenElement).toBe(false)
    expect(probe.escape.wrapped).toBe(false)
    expect(probe.reachedAt).toBeNull()
  })

  it('probe gate: a wrap in the last F+1 stops skips the probe, though the last F+1 presses miss it', async () => {
    const page = await open(DATE_THEN_LINK)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.focusableCount).toBe(2)
    expect(result.steps.slice(-3).map((s) => label(s.settled))).toEqual(['d', 'd', 'l1'])
    const lastStops = groupStops(result.steps).slice(-3)
    expect(lastStops.map(([first]) => label(first.settled))).toEqual(['body!', 'd', 'l1'])
    expect(result.suspectedTrap).toBe(false)
    expect(result.escapeProbe).toBeNull()
    expect(judgeKeyboardTrap([result]).verdict).toBe('pass')
  })

  // This browser's own error for a backendNodeId that names no node, so a changed message fails the tests below.
  async function notFoundError(pw: Page, method: 'DOM.resolveNode' | 'DOM.describeNode'): Promise<string> {
    const session = await pw.context().newCDPSession(pw)
    try {
      await session.send('DOM.getDocument', { depth: 0 })
      await session.send(method, { backendNodeId: 987654321 })
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    } finally {
      await session.detach()
    }
    throw new Error(`${method} found a node for a made-up backendNodeId`)
  }

  // Rejects every matching call of the walk's session, so withRetry cannot hide a rethrow.
  function failSend(
    pw: Page,
    reject: { fails: (method: string, params: object | undefined) => boolean; message: string },
  ): void {
    const { fails, message } = reject
    interceptNextSession(pw, (session) => {
      const send = session.send.bind(session)
      vi.spyOn(session, 'send').mockImplementation(async (method, params) => {
        if (fails(method, params)) throw new Error(message)
        return send(method, params)
      })
    })
  }

  it('part: a node DevTools no longer finds is part null, and the walk goes on', async () => {
    const page = await open(DATE_THEN_LINK)
    const pw = page.playwrightPage
    // On a top-level date input readPart's resolveNode is the walk's only one: no closed shadow root to count.
    const message = await notFoundError(pw, 'DOM.resolveNode')
    failSend(pw, { fails: (method) => method === 'DOM.resolveNode', message })
    const result = await runTabWalk(pw, {
      settleMs: FAST,
      presses: 3,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    expect(result.error).toBeNull()
    // A null part repeats the stop's null, so each press on the date is a stop of its own.
    expect(result.steps.map((s) => [label(s.settled), s.settled.part])).toEqual([
      ['d', null],
      ['d', null],
      ['d', null],
    ])
  })

  it('part: a deep node DevTools no longer finds (describeNode, open shadow root) is part null too', async () => {
    const page = await open(SHADOW_DATETIMES)
    const pw = page.playwrightPage
    // readPart describes the deep element by backendNodeId; no other call of the walk does.
    const byId = (method: string, params: object | undefined): boolean =>
      method === 'DOM.describeNode' && params !== undefined && 'backendNodeId' in params
    failSend(pw, { fails: byId, message: await notFoundError(pw, 'DOM.describeNode') })
    const result = await runTabWalk(pw, {
      settleMs: FAST,
      presses: 3,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    expect(result.error).toBeNull()
    expect(result.steps.map((s) => [deepLabel(s.settled), s.settled.part])).toEqual([
      ['start', null],
      ['start', null],
      ['start', null],
    ])
  })

  it('part: any other error reading the part fails the read, and the walk records it', async () => {
    const page = await open(DATE_THEN_LINK)
    failSend(page.playwrightPage, { fails: (method) => method === 'DOM.resolveNode', message: 'boom' })
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      presses: 3,
      allowFewerPresses: true,
      escapeProbe: false,
    })

    expect(result.error).toEqual({ phase: 'walk', index: 1, message: 'boom' })
    expect(result.steps).toHaveLength(0)
  })

  it('focusLost: a press-1 drop on an autofocused page is marked', async () => {
    const page = await open(AUTOFOCUS_DROP)
    const result = await runTabWalk(page.playwrightPage, {
      settleMs: FAST,
      escapeProbe: false,
    })

    expect(label(result.initial)).toBe('first')
    expect(label(result.steps[0].settled)).toBe('body')
    expect(result.steps[0].focusLost).toBe(true)
  })

  it('focusLost: a drop no read saw arrive is marked from the focus event its press fired', async () => {
    const page = await open(ONLY_STOP_BLUR)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    // The premise: every read is body, so lastRealSeen alone can never mark these drops.
    expect(result.steps.every((s) => s.immediate.isBody && s.settled.isBody)).toBe(true)
    const drops = result.steps.filter((s) => s.settled.hasFocus)
    expect(drops.length).toBeGreaterThanOrEqual(5)
    expect(drops.filter((s) => !s.focusLost).map((s) => s.index)).toEqual([])
  })

  it('focusLost: Tab landing on a body that is a Tab stop is no arrival, before or after a real one', async () => {
    const page = await open(BODY_STOP_THEN_BLUR)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    // b: body stop, L: the button's drop, w: wrap. Body and window focus events must not count, and each read resets.
    const shape = result.steps.map((s) => (s.wrapped ? 'w' : s.focusLost ? 'L' : 'b')).join('')
    expect(shape).toBe('bLwbLwbLwbLwbLwbLwbL')
  })

  it('arrival: removes its focus listener from the page after the walk', async () => {
    const page = await open(ONLY_STOP_BLUR)
    const pw = page.playwrightPage
    await runTabWalk(pw, { settleMs: FAST, presses: 3, allowFewerPresses: true })

    const session = await pw.context().newCDPSession(pw)
    const { result } = await session.send('Runtime.evaluate', { expression: 'window' })
    if (!result.objectId) throw new Error('no handle on window')
    const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: result.objectId })
    await session.detach()
    expect(listeners.filter((l) => l.type === 'focus')).toEqual([])
  })

  it('arrival: a page whose add/removeEventListener throw still gets a complete walk and teardown', async () => {
    const page = await open(TWO_BUTTONS_REFUSE_LISTENERS)
    const pw = page.playwrightPage
    const result = await runTabWalk(pw, { settleMs: FAST })

    expect(result.error).toBeNull()
    expect(result.steps).toHaveLength(result.presses)
    expect(result.steps.some((s) => s.wrapped)).toBe(true)
    // removeEventListener throwing too must not keep the teardown from deleting the walk's state.
    const keys = await pw.evaluate(() => Object.getOwnPropertyNames(window).filter((k) => k.startsWith('__atAgent')))
    expect(keys).toEqual(['__atAgentTabWalk'])
  })

  it('arrival: a drop whose focus event the page refuses to let the walk hear is not focusLost', async () => {
    const page = await open(BLUR_REFUSES_LISTENER)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.error).toBeNull()
    const drops = result.steps.filter((s) => s.settled.isBody && s.settled.hasFocus)
    expect(drops.length).toBeGreaterThanOrEqual(5)
    expect(drops.filter((s) => s.focusLost).map((s) => s.index)).toEqual([])
  })

  it('focusLost: a second consecutive drop is marked', async () => {
    const page = await open(DOUBLE_DROP)
    const result = await runTabWalk(page.playwrightPage, { settleMs: FAST })

    expect(result.steps.slice(0, 3).map((s) => label(s.settled))).toEqual(['d1', 'body', 'body'])
    expect(result.steps.slice(0, 3).map((s) => s.focusLost)).toEqual([false, true, true])
  })

  it('idle baseline and end-of-walk focusable count are recorded', async () => {
    const clean = await open(FIXTURE_A)
    const still = await runTabWalk(clean.playwrightPage, { settleMs: FAST })

    expect(still.idle).not.toBeNull()
    expect(still.idle?.urlChanged).toBe(false)
    expect(still.idle?.documentReplaced).toBe(false)
    expect(still.idle?.after.isBody).toBe(true)
    expect(still.focusableCountEnd).toBe(still.focusableCount)

    const growing = await open(LATE_FOCUSABLES)
    const grown = await runTabWalk(growing.playwrightPage, {
      settleMs: 120,
      escapeProbe: false,
    })

    expect(grown.idle?.urlChanged).toBe(false)
    expect(grown.focusableCount).toBe(1)
    expect(grown.focusableCountEnd).toBe(11)
  })

  describe('2.1.2: a complete count is the end of the page only after a recent wrap', () => {
    it('one Tab stop that swallows Tab: no wrap, the probe gets nowhere, judged fail', async () => {
      const page = await open(ONLY_STOP_TRAP)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })

      expect(walk.focusableCount).toBe(1)
      expect(walk.steps.some((s) => s.wrapped)).toBe(false)
      expect(walk.escapeProbe?.reachedAt).toBeNull()
      expect(judgeKeyboardTrap([walk]).verdict).toBe('fail')
    })

    it('a script loop over every stop: no wrap, the probe gets nowhere, judged fail', async () => {
      const page = await open(LOOP_EVERY_STOP)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })

      expect(walk.focusableCount).toBe(3)
      expect(walk.steps.some((s) => s.wrapped)).toBe(false)
      expect(walk.escapeProbe?.reachedAt).toBeNull()
      expect(judgeKeyboardTrap([walk]).verdict).toBe('fail')
    })

    it('a loop padded with two scrollers F does not count, reaching exactly F: judged fail', async () => {
      const page = await open(PADDED_LOOP)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })

      expect(walk.focusableCount).toBe(3)
      expect(walk.steps.some((s) => s.wrapped)).toBe(false)
      expect(new Set(walk.steps.slice(-3).map((s) => label(s.settled)))).toEqual(new Set(['ok', 's1', 's2']))
      const result = judgeKeyboardTrap([walk])
      expect(result.verdict).toBe('fail')
      expect(result.directions[0].region).toHaveLength(3)
    })

    it('a stop re-rendered on every press: each press and the first Shift+Tab land on a new node; undetermined', async () => {
      const page = await open(RERENDER_EVERY_PRESS)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })

      const tail = walk.steps.slice(-(walk.focusableCount + 1))
      expect(tail.every((s) => label(s.settled) === 're')).toBe(true)
      expect(new Set(tail.map((s) => focusIdentity(s.settled))).size).toBe(tail.length)
      expect(walk.escapeProbe?.reachedAt).toBe(1)
      expect(walk.escapeProbe?.steps[0].unseenElement).toBe(true)
      const result = judgeKeyboardTrap([walk])
      expect(result.verdict).toBe('undetermined')
      expect(result.reason).toBe('focusables-exceeded')
    })

    it('F counts contenteditable editing hosts in every spelling', async () => {
      const page = await open(EDITING_HOSTS)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })

      expect(new Set(walk.steps.map((s) => label(s.settled)))).toEqual(
        new Set(['l1', 'ce-bare', 'ce-plain', 'ce-plain-upper', 'ce-upper', 'ce-true', 'body!']),
      )
      expect(walk.focusableCount).toBe(6)
    })

    it('F counts an image-map area only while the first image naming its map is rendered', async () => {
      const page = await open(IMAGE_MAPS)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })

      expect(new Set(walk.steps.map((s) => deepLabel(s.settled)))).toEqual(
        new Set(['l1', 's0', 's1', 'b0', 'i0', 'fa0', 'fa1', 'body!']),
      )
      expect(walk.focusableCount).toBe(7)
    })

    it('a link and 14 image-map areas: F is 15, the walk wraps, judged pass', async () => {
      const page = await open(LINK_AND_14_AREAS)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })

      expect(walk.focusableCount).toBe(15)
      expect(walk.suspectedTrap).toBe(false)
      expect(judgeKeyboardTrap([walk]).verdict).toBe('pass')
    })

    // Pinned, not fixed: counting scrollers would re-implement Chromium's rule in page JS.
    it('a keyboard-focusable scroller is a Tab stop F does not count', async () => {
      const page = await open(TWO_SCROLLERS)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })

      expect(walk.focusableCount).toBe(3)
      expect(walk.steps.slice(0, 6).map((s) => label(s.settled))).toEqual(['l1', 'l2', 'l3', 's1', 's2', 'body!'])
      expect(judgeKeyboardTrap([walk]).verdict).toBe('pass')
    })

    it('a lone datetime-local input: Tab steps through its fields on one element, judged pass', async () => {
      const page = await open(LONE_DATETIME)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })

      expect(walk.focusableCount).toBe(1)
      const firstWrap = walk.steps.findIndex((s) => s.wrapped)
      expect(firstWrap).toBeGreaterThan(1)
      expect(walk.steps.slice(0, firstWrap).every((s) => label(s.settled) === 'when')).toBe(true)
      const result = judgeKeyboardTrap([walk])
      expect(result.verdict).toBe('pass')
      expect(result.directions[0].endOfPage?.signal).toBe('body-unfocused')
    })

    // Wrong before round 4: a date or time input takes several Tab presses on one element, and the walk and its
    // probe were budgeted in presses. They are budgeted in stops now.
    it('two datetime-local inputs, a clean page: judged pass', async () => {
      const page = await open(TWO_DATETIMES)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })
      expect(judgeKeyboardTrap([walk]).verdict).toBe('pass')
    })

    it('a dialog loop over a date input and a button, a trap: judged fail', async () => {
      const page = await open(DATE_LOOP)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })
      expect(judgeKeyboardTrap([walk]).verdict).toBe('fail')
    })

    // The recent-wrap rule introduced these three when the walk counted presses: the stops filled the 15-press
    // walk, which never wrapped, and the probe's Shift+Tabs stayed inside the input.
    it('eight scrollers then a datetime-local, a clean page: judged pass', async () => {
      const page = await open(SCROLLERS_THEN_DATETIME)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })
      expect(judgeKeyboardTrap([walk]).verdict).toBe('pass')
    })

    it('seven scrollers, a datetime-local, one scroller, a clean page: judged pass', async () => {
      const page = await open(SCROLLERS_DATETIME_SCROLLER)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })
      expect(judgeKeyboardTrap([walk]).verdict).toBe('pass')
    })

    // Media controls are Tab stops on one element too, so the class is wider than date and time inputs.
    it('a link, ten scrollers, then <audio controls>, a clean page: judged pass', async () => {
      const page = await open(LINK_SCROLLERS_AUDIO)
      const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST })
      expect(judgeKeyboardTrap([walk]).verdict).toBe('pass')
    })

    async function judged(html: string, direction: Direction = 'forward'): Promise<KeyboardTrapResult> {
      const page = await open(html)
      return judgeKeyboardTrap([await runTabWalk(page.playwrightPage, { settleMs: FAST, direction })])
    }

    // More verdicts that were wrong from the same cause, found in round 4.
    it('a loop over every stop with a date input last before the wrap, a trap: judged fail', async () => {
      expect((await judged(DATE_LAST_IN_LOOP)).verdict).toBe('fail')
    })

    it('a lone <audio controls>, F=0, a clean page: judged pass', async () => {
      expect((await judged(LONE_AUDIO)).verdict).toBe('pass')
    })

    it('a lone <video controls>, F=0, a clean page: judged pass', async () => {
      expect((await judged(LONE_VIDEO)).verdict).toBe('pass')
    })

    it('two text inputs that become datetime-local on focus, a clean page: judged pass', async () => {
      expect((await judged(TYPE_SWAP_DATETIMES)).verdict).toBe('pass')
    })

    it('two datetime-local inputs in an open shadow root, a clean page: judged pass', async () => {
      expect((await judged(SHADOW_DATETIMES)).verdict).toBe('pass')
    })

    it('two datetime-local inputs in a same-origin frame, a clean page: judged pass', async () => {
      expect((await judged(FRAME_DATETIMES)).verdict).toBe('pass')
    })

    it('a link, ten scrollers, then <video controls>, a clean page: judged pass', async () => {
      expect((await judged(LINK_SCROLLERS_VIDEO)).verdict).toBe('pass')
    })

    it('a dialog loop over a millisecond datetime-local and a button, a trap: judged fail', async () => {
      expect((await judged(MS_DATETIME_LOOP)).verdict).toBe('fail')
    })

    it('a link, eight scrollers, <audio controls>, three scrollers, a clean page: judged pass', async () => {
      expect((await judged(linkScrollersAudioScrollers(8, 3))).verdict).toBe('pass')
    })

    it('backward, a dialog loop over two datetime-local inputs and a button, a trap: judged fail', async () => {
      expect((await judged(DATETIMES_SAVE_LOOP, 'backward')).verdict).toBe('fail')
    })

    // The same trade with F = 2, where the judge must read the walk's stops: its last F+1 stops hold 3 elements,
    // more than F, but its last F+1 presses hold 2. A walk counted in presses ends inside the audio element and passes.
    it('trade, F=2: two links, sixteen scrollers, <audio controls>, four scrollers: undetermined', async () => {
      const result = await judged(TWO_LINKS_SCROLLERS_AUDIO)
      expect(result.verdict).toBe('undetermined')
      expect(result.reason).toBe('focusables-exceeded')
    })

    // The accepted trade: 18 stops F does not count (17 scrollers and the audio element), past 4F+10 = 14. It
    // passed in presses only because the walk ended inside the audio element and one Shift+Tab got out; counted in
    // stops it is refused, like the same page with a button in place of the audio.
    it('trade: a link, twelve scrollers, <audio controls>, five scrollers: undetermined, focusables-exceeded', async () => {
      const result = await judged(linkScrollersAudioScrollers(12, 5))
      expect(result.verdict).toBe('undetermined')
      expect(result.reason).toBe('focusables-exceeded')
    })

    // Round 2's refusal for re-created nodes, in stops (pass is right). A trap that re-creates its node still passes
    // (bench/COVERAGE.md, round-4 section).
    it('a date input replaced by a clone on every other Tab, Shift+Tab native: undetermined, focusables-exceeded', async () => {
      const result = await judged(RERENDER_DATE_EVERY_OTHER_TAB)
      expect(result.verdict).toBe('undetermined')
      expect(result.reason).toBe('focusables-exceeded')
      // The last F+1 = 4 stops are 4 clones, more than F = 3.
      expect(result.directions[0].focusableCount).toBe(3)
      expect(result.directions[0].region).toHaveLength(4)
    })

    // Right when the walk counted presses, and must stay right now that it counts stops.
    it('a date input that swallows Tab: judged fail', async () => {
      expect((await judged(SWALLOW_ON_DATE)).verdict).toBe('fail')
    })

    for (const direction of DIRECTIONS) {
      it(`a dialog loop [save, date] caught after the date's fields, ${direction}: judged fail`, async () => {
        expect((await judged(SAVE_DATE_LATE_LOOP, direction)).verdict).toBe('fail')
      })
    }

    it('a date input refocused at its first field, forward only: confined, Shift+Tab releases it, judged pass', async () => {
      const result = await judged(REFOCUS_AT_PICKER)
      expect(result.verdict).toBe('pass')
      expect(result.directions[0].confined).toBe(true)
    })

    it('a date input refocused on Tab and on Shift+Tab: judged fail', async () => {
      expect((await judged(REFOCUS_AT_PICKER_BOTH_KEYS)).verdict).toBe('fail')
    })

    it('every Tab moved by script round two buttons and a date input: judged fail', async () => {
      expect((await judged(MODAL_INTERCEPT_DATE)).verdict).toBe('fail')
    })

    for (const direction of DIRECTIONS) {
      it(`a dialog loop over two datetime-local inputs and a button, last on the page, ${direction}: judged fail`, async () => {
        expect((await judged(DATETIMES_SAVE_LOOP_LAST, direction)).verdict).toBe('fail')
      })
    }

    // Calibration tripwire: each control must stay one stop, in fewer presses than the 10 a stop may take. A
    // Chromium that adds parts to one fails here and names it.
    for (const [control, html] of [
      ['a datetime-local input with milliseconds', MS_DATETIME_BETWEEN_LINKS],
      ['<video controls> with a captions track', CAPTIONED_VIDEO_BETWEEN_LINKS],
    ] as const) {
      for (const direction of DIRECTIONS) {
        it(`tripwire: ${control}, ${direction}, is one stop of fewer than 10 presses`, async () => {
          const page = await open(html)
          const walk = await runTabWalk(page.playwrightPage, { settleMs: FAST, direction })
          const runs = runLengths(walk.steps)
          expect(Math.max(...runs), `${control}: presses on one stop`).toBeLessThan(10)
          expect(runs, `${control}: one run per stop`).toHaveLength(walk.presses)
        })
      }
    }
  })

  // A crashed renderer never answers the walk's CDP session, and a press in flight at the crash never settles.
  it('rejects with the crash when the renderer dies mid-walk, instead of hanging', { timeout: 15_000 }, async () => {
    const page = await open(FIXTURE_A)
    const pw = page.playwrightPage
    const session = await pw.context().newCDPSession(pw)
    // Page.crash is never answered: the renderer that would reply is the one it kills.
    await pw.exposeFunction('crashRenderer', () => void session.send('Page.crash').catch(() => undefined))
    await pw.evaluate(() => {
      const crash = (): void => (window as unknown as { crashRenderer: () => void }).crashRenderer()
      document.addEventListener('keydown', crash, { once: true })
    })
    await expect(runTabWalk(pw, { settleMs: 50 })).rejects.toThrow(RENDERER_CRASHED)
  })
})

// The recorded walks every judge suite is tested against. A new TabWalkResult field that does not
// default stops every committed record parsing and takes those fixtures away.
describe('committed dev walk records', () => {
  it('every committed dev walk still parses', () => {
    const counts: number[] = []
    for (const set of ['dev-fixtures', 'dev-variants']) {
      const dir = new URL(`../../../bench/results/cd3b122/${set}/raw/`, import.meta.url)
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.json.gz'))
        .sort()
      counts.push(files.length)
      for (const name of files) {
        const record: unknown = JSON.parse(gunzipSync(readFileSync(new URL(name, dir))).toString())
        expect(() => TabWalkResultSchema.parse((record as { walk: unknown }).walk), `${set}/${name}`).not.toThrow()
      }
    }
    expect(counts).toEqual([8, 27])
  })
})
