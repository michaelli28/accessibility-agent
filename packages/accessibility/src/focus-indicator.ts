import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { CDPSession, Page } from 'playwright'
import { countChangedPixels, decodePng, type RgbaImage } from './png.js'
import {
  focusIdentity,
  DeepUnavailableSchema,
  IndicatorTargetSchema,
  LINE_GROUPS,
  TRANSFORM_PROPERTIES,
  errorMessage,
  unwrap,
  type FocusRead,
  type LineGroup,
  type StepIndicator,
  type StyleChange,
  type TabWalkResult,
} from './tab-walk.js'
import { failOnCrash } from './renderer-crash.js'

// WCAG 2.4.7 Focus Visible from a Tab walk. Absent needs two agreeing negatives: no qualifying CSS difference
// (element, ::before/::after, 3 ancestors, 2 siblings; see judge) AND whole-viewport shots of the element
// unfocused, focused and unfocused again with no changed pixel. Anything short of that is present or undetermined.
// Known misses (never false absents): an outline in the page's background colour, or any change drawn in a
// colour nobody can see, is present by CSS; a change far from the element can make an unrelated element present.
// Known false absents: an indicator first drawn later than settleMs after focus; a script ring that its blur
// handling never removes, when no other element took it before the shots (all states show the same ring).

export const FocusIndicatorOptionsSchema = z.object({
  // Components screenshotted per page, one element each; other elements needing pixels are screenshot-cap.
  maxScreenshotComponents: z.number().int().nonnegative().default(25),
  // Wait after blurring or focusing before the first shot of a state: covers rings drawn by timers.
  settleMs: z.number().int().min(300).default(300),
  // Wait before the second shot of the same state; the two must match or the comparison is unstable.
  recheckMs: z.number().int().nonnegative().default(100),
  // One colour policy for both evidence paths: a pixel, or a colour-only CSS change, counts when some channel
  // moves by at least this much (0-255).
  pixelThreshold: z.number().int().min(1).max(255).default(10),
  // Changed pixels needed for present; fewer, but some, is screenshot-faint.
  minChangedPixels: z.number().int().positive().default(4),
})
export type FocusIndicatorOptions = z.input<typeof FocusIndicatorOptionsSchema>

export const IndicatorVerdictSchema = z.enum(['present', 'absent', 'undetermined'])
export type IndicatorVerdict = z.infer<typeof IndicatorVerdictSchema>

export const IndicatorUndeterminedReasonSchema = z.enum([
  'never-unfocused',
  'removed',
  'document-replaced',
  'read-failed',
  // Focus sat behind a cross-origin frame or closed shadow root: no style could be read.
  'deep-unavailable',
  // No CSS difference and no screenshot evidence given (judgeFocusIndicator without screenshots).
  'not-confirmed',
  'screenshot-cap',
  // The shots could not be taken, or focus, scroll or viewport did not hold between them.
  'screenshot-failed',
  // The two shots of one state differ: something changes without focus.
  'screenshot-unstable',
  // Some pixels changed with focus, but fewer than minChangedPixels.
  'screenshot-faint',
  // Focus started or stopped an infinite animation, which the shots hold at its first frame, and no pixel changed.
  'focus-animation',
])
export type IndicatorUndeterminedReason = z.infer<typeof IndicatorUndeterminedReasonSchema>

export const IndicatorEvidenceSchema = z.enum(['css', 'screenshot'])
export type IndicatorEvidence = z.infer<typeof IndicatorEvidenceSchema>

export const IndicatorDifferenceSchema = z.object({
  target: IndicatorTargetSchema,
  // Computed property (kebab-case), or content when a ::before/::after box exists in one state only.
  property: z.string(),
  focused: z.string(),
  unfocused: z.string(),
})
export type IndicatorDifference = z.infer<typeof IndicatorDifferenceSchema>

export const ViewSchema = z.object({
  width: z.number(),
  height: z.number(),
  scrollX: z.number(),
  scrollY: z.number(),
})
export type View = z.infer<typeof ViewSchema>

export const ScreenshotEvidenceSchema = z.object({
  // compared: all six shots taken; capped: over the per-page cap; failed: error says why.
  status: z.enum(['compared', 'capped', 'failed']),
  // Viewport size and window scroll (CSS px) that every shot of the element shared.
  view: ViewSchema.nullable(),
  // Pixels that change on focusing or on blurring again, whichever is more.
  changedPixels: z.number().int().nonnegative().nullable(),
  // Pixels that differ between the two shots of one state (unfocused: the worse of its two pairs).
  unstablePixels: z
    .object({
      unfocused: z.number().int().nonnegative(),
      focused: z.number().int().nonnegative(),
    })
    .nullable(),
  // An infinite animation ran in one state only.
  focusAnimation: z.boolean().nullable(),
  error: z.string().nullable(),
})
export type ScreenshotEvidence = z.infer<typeof ScreenshotEvidenceSchema>

export const ElementIndicatorSchema = z.object({
  // focusIdentity of the element's settled reads.
  backendNodeId: z.number().int(),
  tag: z.string(),
  id: z.string().nullable(),
  indicator: IndicatorVerdictSchema,
  reason: IndicatorUndeterminedReasonSchema.nullable(),
  evidence: IndicatorEvidenceSchema.nullable(),
  // Why the style could not be read; a cross-origin element does not block a page pass.
  deepUnavailable: DeepUnavailableSchema.nullable(),
  // Walk steps that settled on this element.
  steps: z.array(z.number().int().positive()),
  // Visits with a captured unfocused read.
  comparedVisits: z.number().int().nonnegative(),
  // First visit showing a counted difference; differences come from it. Null unless evidence is css.
  evidenceStep: z.number().int().positive().nullable(),
  differences: z.array(IndicatorDifferenceSchema),
  // Set when the element needed pixels: taken, capped or failed.
  screenshot: ScreenshotEvidenceSchema.nullable(),
})
export type ElementIndicator = z.infer<typeof ElementIndicatorSchema>

export const IndicatorCountsSchema = z.object({
  present: z.number().int().nonnegative(),
  absent: z.number().int().nonnegative(),
  undetermined: z.number().int().nonnegative(),
})
export type IndicatorCounts = z.infer<typeof IndicatorCountsSchema>

export const IndicatorComponentSchema = z.object({
  // nodeName + sorted class set, e.g. a.btn.primary
  key: z.string(),
  nodeName: z.string(),
  classes: z.array(z.string()),
  counts: IndicatorCountsSchema,
  elements: z.array(ElementIndicatorSchema),
})
export type IndicatorComponent = z.infer<typeof IndicatorComponentSchema>

export const FocusIndicatorResultSchema = z.object({
  // fail: an element is absent; pass: every element is present and the walk had no error, not counting
  // undetermined elements behind cross-origin frames; otherwise undetermined.
  verdict: z.enum(['pass', 'fail', 'undetermined']),
  counts: IndicatorCountsSchema,
  // Undetermined elements behind cross-origin frames: in counts, ignored by the verdict.
  crossOriginUndetermined: z.number().int().nonnegative(),
  components: z.array(IndicatorComponentSchema),
})
export type FocusIndicatorResult = z.infer<typeof FocusIndicatorResultSchema>

type Options = z.infer<typeof FocusIndicatorOptionsSchema>
type Visit = { step: number; read: FocusRead; indicator: StepIndicator | null }
type Values = Record<string, string>
type ShotState = 'unfocused' | 'focused'

const LINE_OF = new Map<string, LineGroup>([
  ...LINE_GROUPS.flatMap((g) => [g.style, g.width, g.color].map((p): [string, LineGroup] => [p, g])),
  ['outline-offset', LINE_GROUPS[0]],
])
// Outline and physical border sides: what a box paints around itself.
const BOX_LINES = LINE_GROUPS.slice(0, 5)
const IDENTITY_TRANSFORMS = new Set([
  'none',
  'matrix(1, 0, 0, 1, 0, 0)',
  'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)',
])
// Computed colours in the legacy form; other colour functions are not parsed and always count.
const RGB = /rgba?\([^)]*\)/g
// Reason when visits failed differently: the most specific cause wins.
const REASON_ORDER = ['removed', 'document-replaced', 'read-failed'] as const
const SHOT_GROUP = 'at-agent-focus-indicator'
// Top window's record of the infinite animations seen in each state of the element being shot.
const ANIMATION_STORE_KEY = '__atAgentFocusIndicatorAnimations'
const CAPPED: ScreenshotEvidence = {
  status: 'capped',
  view: null,
  changedPixels: null,
  unstablePixels: null,
  focusAnimation: null,
  error: null,
}
const StateSchema = ViewSchema.extend({ focus: z.string() })

// Blurs whatever holds focus in the top document, deepest element first.
const BLUR_ALL_FN = `function (top) {
  const chain = []
  for (let a = top.activeElement; a && a !== a.ownerDocument.body; ) {
    chain.push(a)
    a = a.shadowRoot ? a.shadowRoot.activeElement : a.contentDocument ? a.contentDocument.activeElement : null
  }
  for (const a of chain.reverse()) a.blur()
}`
// Leaves nothing focused, then scrolls the element to the middle of the viewport once.
const PREPARE_FN = `function (key) {
  const win = this.ownerDocument.defaultView.top
  delete win[key]
  ;(${BLUR_ALL_FN})(win.document)
  this.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
}`
// Script focus after a keyboard walk matches :focus-visible as Tab focus does; it must not scroll. The Tab keydown
// before it is for page script that draws a ring only when focus follows a keydown (flying-focus); being untrusted,
// it moves nothing, and focusing the element once more (Shift+Tab, Tab) would re-run its blur timers instead.
const FOCUS_FN = `function () {
  const doc = this.ownerDocument
  const init = { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true, composed: true }
  ;(doc.body || doc.documentElement).dispatchEvent(new KeyboardEvent('keydown', init))
  this.focus({ preventScroll: true, focusVisible: true })
}`
const BLUR_FN = `function () {
  ;(${BLUR_ALL_FN})(this.ownerDocument.defaultView.top.document)
}`
const STATE_FN = `function () {
  const win = this.ownerDocument.defaultView.top
  const active = win.document.activeElement
  const focus = this.matches(':focus')
    ? this.matches(':focus-visible') ? 'the element' : 'the element without :focus-visible'
    : !active || active === win.document.body ? 'nothing' : active.localName + (active.id ? '#' + active.id : '')
  return { focus, width: win.innerWidth, height: win.innerHeight, scrollX: win.scrollX, scrollY: win.scrollY }
}`
// Before a shot: finishes finite animations and holds infinite ones at their first frame, recording them under
// the state (top document, same-origin frames, shadow trees). Holding is playbackRate 0 plus a seek, undone by
// THAW_FN: pause(), play() and cancel() would detach a CSS animation from its rule for good.
const FREEZE_FN = `function (key, state) {
  const win = this.ownerDocument.defaultView.top
  if (!win[key]) {
    const record = { unfocused: new Set(), focused: new Set(), held: [] }
    Object.defineProperty(win, key, { value: record, configurable: true })
  }
  const record = win[key]
  const visit = (w) => {
    let doc = null
    try { doc = w.document } catch { return }
    for (const a of doc.getAnimations()) {
      if (!a.effect) continue
      if (Number.isFinite(a.effect.getComputedTiming().endTime)) {
        try { a.finish() } catch {}
        continue
      }
      record[state].add(a)
      record.held.push([a, a.currentTime, a.playbackRate])
      a.playbackRate = 0
      a.currentTime = 0
    }
    for (let i = 0; i < w.frames.length; i++) visit(w.frames[i])
  }
  visit(win)
}`
const THAW_FN = `function (key) {
  const record = this.ownerDocument.defaultView.top[key]
  for (const [a, time, rate] of record ? record.held.splice(0) : []) {
    try {
      a.playbackRate = rate
      if (time !== null) a.currentTime = time
    } catch {}
  }
}`
// Whether an infinite animation ran in one state only.
const ANIMATION_CHANGED_FN = `function (key) {
  const record = this.ownerDocument.defaultView.top[key]
  if (!record) return true
  const only = (a, b) => [...a].some((x) => !b.has(x))
  return only(record.unfocused, record.focused) || only(record.focused, record.unfocused)
}`

// Screenshots elements the walk's CSS cannot confirm, then judges. After any screenshot, leaves nothing focused.
export async function checkFocusIndicator(
  page: Page,
  walk: TabWalkResult,
  options: FocusIndicatorOptions = {},
): Promise<FocusIndicatorResult> {
  return failOnCrash(page, () => screenshotAndJudge(page, walk, options))
}

async function screenshotAndJudge(
  page: Page,
  walk: TabWalkResult,
  options: FocusIndicatorOptions,
): Promise<FocusIndicatorResult> {
  const opts = FocusIndicatorOptionsSchema.parse(options)
  const unconfirmed = judgeFocusIndicator(walk, new Map(), opts)
    .components.map((c) => c.elements.filter((e) => e.reason === 'not-confirmed').map((e) => e.backendNodeId))
    .filter((ids) => ids.length > 0)
  const shots = new Map<number, ScreenshotEvidence>()
  const chosen = unconfirmed.slice(0, opts.maxScreenshotComponents).map((ids) => ids[0])
  if (chosen.length > 0) {
    const session = await page.context().newCDPSession(page)
    try {
      await session.send('DOM.getDocument', { depth: 0 })
      for (const id of chosen) shots.set(id, await screenshotElement(page, session, id, opts))
    } finally {
      await session
        .send('Runtime.evaluate', {
          expression: `(${BLUR_ALL_FN})(document); delete window[${JSON.stringify(ANIMATION_STORE_KEY)}]`,
        })
        .catch(() => undefined)
      await session.detach().catch(() => undefined)
    }
  }
  for (const id of unconfirmed.flat()) if (!shots.has(id)) shots.set(id, CAPPED)
  return judgeFocusIndicator(walk, shots, opts)
}

// Pure: the walk plus screenshot evidence by backendNodeId (see checkFocusIndicator).
export function judgeFocusIndicator(
  walk: TabWalkResult,
  screenshots: ReadonlyMap<number, ScreenshotEvidence> = new Map(),
  options: FocusIndicatorOptions = {},
): FocusIndicatorResult {
  const opts = FocusIndicatorOptionsSchema.parse(options)
  const visits = new Map<number, Visit[]>()
  for (const step of walk.steps) {
    const identity = focusIdentity(step.settled)
    if (identity === null || !isFocusedElement(step.settled)) continue
    const visit = {
      step: step.index,
      read: step.settled,
      indicator: step.indicator,
    }
    visits.set(identity, [...(visits.get(identity) ?? []), visit])
  }

  const components = new Map<string, IndicatorComponent>()
  for (const [identity, elementVisits] of visits) {
    const { tag, id, classAttr } = describe(elementVisits[0].read)
    const classes = [...new Set((classAttr ?? '').split(/\s+/).filter(Boolean))].sort()
    const key = tag + classes.map((c) => `.${c}`).join('')
    const finding = judge({ backendNodeId: identity, tag, id }, elementVisits, screenshots.get(identity) ?? null, opts)
    const component = components.get(key) ?? {
      key,
      nodeName: tag,
      classes,
      counts: emptyCounts(),
      elements: [],
    }
    components.set(key, {
      ...component,
      counts: addCount(component.counts, finding.indicator),
      elements: [...component.elements, finding],
    })
  }

  const list = [...components.values()]
  const findings = list.flatMap((c) => c.elements)
  const counts = findings.reduce((sum, f) => addCount(sum, f.indicator), emptyCounts())
  const blocking = findings.filter((f) => !(f.indicator === 'undetermined' && f.deepUnavailable === 'cross-origin'))
  const verdict =
    counts.absent > 0
      ? 'fail'
      : blocking.length > 0 && blocking.every((f) => f.indicator === 'present') && walk.error === null
        ? 'pass'
        : 'undetermined'
  return {
    verdict,
    counts,
    crossOriginUndetermined: findings.length - blocking.length,
    components: list,
  }
}

// A body (the page's, or a frame's own stop) is not a focused element; a read behind a boundary is
// one whose style cannot be seen.
function isFocusedElement(read: FocusRead): boolean {
  return read.deepUnavailable !== null || (read.deep !== null && !read.deep.isBody)
}

function describe(read: FocusRead): {
  tag: string
  id: string | null
  classAttr: string | null
} {
  if (read.deep)
    return {
      tag: read.deep.tag,
      id: read.deep.id,
      classAttr: read.deep.classAttr,
    }
  return { tag: read.tag ?? 'unknown', id: read.id, classAttr: read.className }
}

// A CSS difference counts when it draws something, shows on a strict majority of the element's compared visits
// and never drifts between two unfocused reads of any visit (so an animation is not an indicator); an ancestor or
// sibling that held focus at a drift read (target:*) never counts.
function judge(
  element: Pick<ElementIndicator, 'backendNodeId' | 'tag' | 'id'>,
  visits: Visit[],
  shot: ScreenshotEvidence | null,
  opts: Options,
): ElementIndicator {
  const base = {
    ...element,
    deepUnavailable: visits[0].read.deepUnavailable,
    steps: visits.map((v) => v.step),
  }
  const compared = visits.flatMap((v) =>
    v.indicator?.unfocusedStatus === 'captured'
      ? [
          {
            step: v.step,
            diffs: v.indicator.changes.flatMap((c) => visibleDifferences(c, opts.pixelThreshold)),
            drift: v.indicator.unfocusedDrift,
          },
        ]
      : [],
  )
  const drifting = new Set(compared.flatMap((c) => c.drift ?? []))
  const tally = new Map<string, number>()
  for (const c of compared) {
    for (const key of new Set(c.diffs.map(keyOf))) tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const drifts = (key: string): boolean => drifting.has(key) || drifting.has(`${key.split(':')[0]}:*`)
  const counted = new Set([...tally].filter(([key, n]) => n * 2 > compared.length && !drifts(key)).map(([key]) => key))
  const evidence = compared.find((c) => c.diffs.some((d) => counted.has(keyOf(d))))
  const blank = {
    comparedVisits: compared.length,
    evidenceStep: null,
    differences: [],
    screenshot: null,
  }
  if (evidence) {
    return {
      ...base,
      ...blank,
      indicator: 'present',
      reason: null,
      evidence: 'css',
      evidenceStep: evidence.step,
      differences: evidence.diffs.filter((d) => counted.has(keyOf(d))),
    }
  }
  if (compared.length === 0) {
    return {
      ...base,
      ...blank,
      indicator: 'undetermined',
      reason: undeterminedReason(visits),
      evidence: null,
    }
  }
  return {
    ...base,
    ...blank,
    ...fromScreenshot(shot, opts),
    screenshot: shot,
  }
}

function fromScreenshot(
  shot: ScreenshotEvidence | null,
  opts: Options,
): Pick<ElementIndicator, 'indicator' | 'reason' | 'evidence'> {
  const undetermined = (reason: IndicatorUndeterminedReason) => ({
    indicator: 'undetermined' as const,
    reason,
    evidence: null,
  })
  const seen = (indicator: 'present' | 'absent') => ({
    indicator,
    reason: null,
    evidence: 'screenshot' as const,
  })
  if (shot === null) return undetermined('not-confirmed')
  if (shot.status === 'capped') return undetermined('screenshot-cap')
  const { changedPixels: changed, unstablePixels: unstable } = shot
  if (shot.status === 'failed' || changed === null || unstable === null) return undetermined('screenshot-failed')
  if (unstable.unfocused > 0 || unstable.focused > 0) return undetermined('screenshot-unstable')
  if (changed >= opts.minChangedPixels) return seen('present')
  if (changed > 0) return undetermined('screenshot-faint')
  if (shot.focusAnimation !== false) return undetermined('focus-animation')
  return seen('absent')
}

function undeterminedReason(visits: Visit[]): IndicatorUndeterminedReason {
  const statuses = visits.flatMap((v) => (v.indicator ? [v.indicator.unfocusedStatus] : []))
  if (statuses.length === 0) return 'deep-unavailable'
  return REASON_ORDER.find((reason) => statuses.includes(reason)) ?? 'never-unfocused'
}

const keyOf = (d: IndicatorDifference): string => `${d.target}:${d.property}`

// The recorded differences that draw something visibly.
function visibleDifferences(change: StyleChange, threshold: number): IndicatorDifference[] {
  const { target, focused, unfocused } = change
  if (focused === null || unfocused === null) {
    const box = focused ?? unfocused
    if (box === null || !boxPaints(box)) return []
    return [
      {
        target,
        property: 'content',
        focused: focused?.content ?? 'none',
        unfocused: unfocused?.content ?? 'none',
      },
    ]
  }
  return Object.keys(focused).flatMap((property) => {
    const [f, u] = [focused[property], unfocused[property]]
    if (u === undefined || f === u || !draws(property, focused, unfocused)) return []
    const painted = (v: string): string => (property === 'box-shadow' ? drawingShadows(v) : v)
    if (colourShiftBelow(painted(f), painted(u), threshold)) return []
    return [{ target, property, focused: f, unfocused: u }]
  })
}

function draws(property: string, f: Values, u: Values): boolean {
  const either = (test: (values: Values) => boolean): boolean => test(f) || test(u)
  const line = LINE_OF.get(property)
  if (line) return either((v) => lineDrawn(line, v))
  if (property === 'box-shadow') return drawingShadows(f[property]) !== drawingShadows(u[property])
  if (property === 'transform') return !(IDENTITY_TRANSFORMS.has(f[property]) && IDENTITY_TRANSFORMS.has(u[property]))
  if (/-radius$|^corner-/.test(property)) return either(paints)
  if (/^text-decoration|^text-underline-/.test(property) && property !== 'text-decoration-line') {
    return either((v) => v['text-decoration-line'] !== 'none')
  }
  if (/^text-emphasis-/.test(property) && property !== 'text-emphasis-style') {
    return either((v) => v['text-emphasis-style'] !== 'none')
  }
  if (property === '-webkit-text-stroke-color') return either((v) => parseFloat(v['-webkit-text-stroke-width']) > 0)
  if (property === 'transform-origin') return either((v) => TRANSFORM_PROPERTIES.some((p) => v[p] !== 'none'))
  if (property === 'perspective-origin') return either((v) => v.perspective !== 'none')
  return !(isTransparent(f[property]) && isTransparent(u[property]))
}

function lineDrawn(line: LineGroup, v: Values): boolean {
  const style = v[line.style]
  return (
    style !== undefined &&
    style !== 'none' &&
    style !== 'hidden' &&
    parseFloat(v[line.width]) > 0 &&
    !isTransparent(v[line.color] ?? 'transparent')
  )
}

// Whether a box paints anything around or behind its content.
function paints(v: Values): boolean {
  return (
    !isTransparent(v['background-color'] ?? 'transparent') ||
    (v['background-image'] ?? 'none') !== 'none' ||
    drawingShadows(v['box-shadow'] ?? 'none') !== 'none' ||
    BOX_LINES.some((line) => lineDrawn(line, v))
  )
}

// A generated box paints when it has text or an image, or a painted box.
function boxPaints(v: Values): boolean {
  const content = v.content ?? 'none'
  return !['""', "''", 'none', 'normal'].includes(content) || paints(v)
}

// The box-shadow layers that draw something, in order; a layer with a transparent colour, or with
// zero offsets, blur and spread, draws nothing (Tailwind's ring-0 and its placeholder layers).
function drawingShadows(value: string): string {
  if (value === 'none') return 'none'
  const layers = splitTopLevel(value).filter((layer) => {
    const color = layer.match(/^(?:[a-z-]+\([^)]*\)|[a-z]+)/i)?.[0] ?? ''
    const lengths = (layer.slice(color.length).match(/-?[\d.]+px/g) ?? []).map(parseFloat)
    return !isTransparent(color) && lengths.some((n) => n !== 0)
  })
  return layers.length > 0 ? layers.join(', ') : 'none'
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth--
    else if (value[i] === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  return [...parts, value.slice(start).trim()]
}

// Computed colours serialize as rgb()/rgba() (or color()/oklch() with "/ alpha"); alpha 0 draws nothing.
function isTransparent(color: string | undefined): boolean {
  if (color === undefined) return false
  return (
    color === 'transparent' || /^rgba\((?:[^,]+,){3}\s*0(?:\.0+)?\)$/.test(color) || /\/\s*0(?:\.0+)?\)$/.test(color)
  )
}

// One colour policy for both evidence paths: values that differ only in rgb()/rgba() colours count only when
// some colour can move a painted pixel by threshold or more on some channel, as the screenshot counts pixels.
function colourShiftBelow(f: string, u: string, threshold: number): boolean {
  const [fc, uc] = [rgbaOf(f), rgbaOf(u)]
  if (fc === null || uc === null || fc.length === 0 || fc.length !== uc.length) return false
  if (f.replace(RGB, '') !== u.replace(RGB, '')) return false
  return fc.every((c, i) => pixelShift(c, uc[i]) < threshold)
}

function rgbaOf(value: string): number[][] | null {
  const colours = (value.match(RGB) ?? []).map((c) => {
    const [r, g, b, a = 1] = c
      .slice(c.indexOf('(') + 1, -1)
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number)
    return [r, g, b, a]
  })
  return colours.every((c) => c.every(Number.isFinite)) ? colours : null
}

// Largest channel change of the colour composited over a backdrop; linear in the backdrop, so black and white
// bound it.
function pixelShift([r1, g1, b1, a1]: number[], [r2, g2, b2, a2]: number[]): number {
  const shifts = [
    [r1, r2],
    [g1, g2],
    [b1, b2],
  ].flatMap(([c1, c2]) => {
    const onBlack = c1 * a1 - c2 * a2
    return [Math.abs(onBlack), Math.abs(onBlack + 255 * (a2 - a1))]
  })
  return Math.max(...shifts)
}

// Six whole-viewport shots at one scroll position: two unfocused (nothing focused), two focused, two unfocused
// again, each pair recheckMs apart after a settleMs wait. Each shot shows infinite animations at their first
// frame; one that only focus starts or stops may draw nothing there, so it is recorded (focusAnimation).
async function screenshotElement(
  page: Page,
  session: CDPSession,
  backendNodeId: number,
  opts: Options,
): Promise<ScreenshotEvidence> {
  const failed = (error: string): ScreenshotEvidence => ({
    ...CAPPED,
    status: 'failed',
    error,
  })
  try {
    const { object } = await session.send('DOM.resolveNode', {
      backendNodeId,
      objectGroup: SHOT_GROUP,
    })
    const objectId = object.objectId
    if (!objectId) return failed('element not found')
    const call = async (fn: string, args: unknown[] = []): Promise<unknown> =>
      unwrap(
        await session.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: fn,
          arguments: args.map((arg) => ({ value: arg })),
          returnByValue: true,
        }),
      )
    await call(PREPARE_FN, [ANIMATION_STORE_KEY])
    await sleep(opts.settleMs)
    // The scroll and viewport the page settled on after the one scroll; every shot must keep them.
    const view = ViewSchema.parse(await call(STATE_FN))
    const box = boxOf((await session.send('DOM.getContentQuads', { objectId })).quads)
    if (!box || !inside(box, view)) return failed('element box is not fully inside the viewport')

    const want = { unfocused: 'nothing', focused: 'the element' }
    // Focus, scroll and viewport must hold from before the first shot of a state until after its second.
    const hold = async (state: ShotState): Promise<void> => {
      const { focus, ...now } = StateSchema.parse(await call(STATE_FN))
      if (focus !== want[state]) throw new Error(`the ${state} state did not hold: focus is on ${focus}`)
      if (Object.entries(now).some(([k, v]) => view[k as keyof View] !== v)) {
        throw new Error('the page scrolled or the viewport changed between shots')
      }
    }
    // Two shots recheckMs apart; the caller has already waited settleMs.
    const shootState = async (state: ShotState): Promise<[RgbaImage, RgbaImage]> => {
      const shots: RgbaImage[] = []
      for (const wait of [0, opts.recheckMs]) {
        await sleep(wait)
        await hold(state)
        try {
          await call(FREEZE_FN, [ANIMATION_STORE_KEY, state])
          shots.push(decodePng(await page.screenshot({ caret: 'hide', scale: 'css', type: 'png' })))
        } finally {
          await call(THAW_FN, [ANIMATION_STORE_KEY])
        }
      }
      await hold(state)
      return [shots[0], shots[1]]
    }

    const [u1, u2] = await shootState('unfocused')
    await call(FOCUS_FN)
    await sleep(opts.settleMs)
    const [f1, f2] = await shootState('focused')
    // Blurring runs the page's own blur handling, which clears a ring the walk left on the element.
    await call(BLUR_FN)
    await sleep(opts.settleMs)
    const [u3, u4] = await shootState('unfocused')
    // countChangedPixels counts channel differences above its threshold; the policy counts from pixelThreshold.
    const diff = (a: RgbaImage, b: RgbaImage): number => countChangedPixels(a, b, opts.pixelThreshold - 1)
    return {
      status: 'compared',
      view,
      changedPixels: Math.max(diff(u2, f1), diff(f2, u3)),
      unstablePixels: {
        unfocused: Math.max(diff(u1, u2), diff(u3, u4)),
        focused: diff(f1, f2),
      },
      focusAnimation: (await call(ANIMATION_CHANGED_FN, [ANIMATION_STORE_KEY])) === true,
      error: null,
    }
  } catch (err) {
    return failed(errorMessage(err))
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup: SHOT_GROUP }).catch(() => undefined)
  }
}

type Box = { left: number; top: number; right: number; bottom: number }

// Union of the element's quads, in top-viewport CSS px.
function boxOf(quads: number[][]): Box | null {
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]])
  const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]])
  if (xs.length === 0) return null
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  }
}

// Shots see only the viewport: a box cut by its edge could hide the indicator. 1 px covers subpixel rounding.
function inside(box: Box, view: View): boolean {
  return box.left >= -1 && box.top >= -1 && box.right <= view.width + 1 && box.bottom <= view.height + 1
}

function addCount(counts: IndicatorCounts, verdict: IndicatorVerdict): IndicatorCounts {
  return { ...counts, [verdict]: counts[verdict] + 1 }
}

function emptyCounts(): IndicatorCounts {
  return { present: 0, absent: 0, undetermined: 0 }
}
