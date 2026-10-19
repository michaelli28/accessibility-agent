import { z } from 'zod'
import {
  collapseStops,
  DeepFocusSchema,
  LaunchFactsSchema,
  focusIdentity,
  focusStop,
  isRealElement as isReal,
  type TabWalkResult,
  type TabWalkStep,
} from './tab-walk.js'

// WCAG 2.1.2 verdict over one or more scripted Tab walks. Replaces the pre-fix KeyboardTrapDetector,
// whose pure-periodicity test flagged every page that wraps (bench/probes/wrap/RESULT.md).
// A trap is confinement that no key escapes: focus never reaches the end of the page AND neither
// Escape nor the opposite Tab key gets out. Repetition alone is never evidence.

export const TrapVerdictSchema = z.enum(['pass', 'fail', 'undetermined'])
export type TrapVerdict = z.infer<typeof TrapVerdictSchema>

export const TrapReleaseSchema = z.enum(['escape-key', 'opposite-key', 'none', 'not-probed'])
export type TrapRelease = z.infer<typeof TrapReleaseSchema>

// Two signals: in new-headless the first wrap skips body entirely, so a body read in the last F+1
// stops alone misses it, and the count covers that, but only after a recent wrap, because a loop over
// every stop completes the count too (endOfPage). A cyclic trap also revisits its first element, so
// "returned to the first element" is NOT a signal (it passes 4 of 6 M5 fixtures).
export const EndOfPageSignalSchema = z.enum(['body-unfocused', 'all-stops-visited'])
export type EndOfPageSignal = z.infer<typeof EndOfPageSignalSchema>

export const TrapUndeterminedReasonSchema = z.enum([
  'walk-error',
  'focusables-changed',
  'focusables-incomplete',
  'focusables-exceeded',
  'document-replaced',
  'short-walk',
  'focus-unreadable',
  'no-release-probe',
])
export type TrapUndeterminedReason = z.infer<typeof TrapUndeterminedReasonSchema>

export const EndOfPageSchema = z
  .object({
    signal: EndOfPageSignalSchema,
    atPress: z.number().int().positive(),
  })
  .strict()
export type EndOfPage = z.infer<typeof EndOfPageSchema>

export const TrapDirectionSchema = z
  .object({
    direction: z.enum(['forward', 'backward']),
    verdict: TrapVerdictSchema,
    reason: TrapUndeterminedReasonSchema.nullable(),
    confined: z.boolean(),
    endOfPage: EndOfPageSchema.nullable(),
    release: TrapReleaseSchema,
    region: z.array(z.number().int()),
    focusableCount: z.number().int().nonnegative(),
    stuckOn: DeepFocusSchema.nullable(),
    // Recorded, never a release signal: a URL change is not evidence that focus moved.
    escapeUrlChanged: z.boolean(),
    documentReplacements: z.array(z.number().int().positive()),
  })
  .strict()
export type TrapDirection = z.infer<typeof TrapDirectionSchema>

export const KeyboardTrapResultSchema = z
  .object({
    wcagCriterion: z.literal('2.1.2'),
    verdict: TrapVerdictSchema,
    reason: TrapUndeterminedReasonSchema.nullable(),
    // Confinement and escapability are a PAIR: 2.1.2 fails only when confined AND inescapable, so a
    // correct modal reports keyboardTrap true with trapEscapable true rather than collapsing to one bool.
    keyboardTrap: z.boolean(),
    trapEscapable: z.boolean().nullable(),
    singleDirection: z.boolean(),
    directionsWalked: z.array(z.enum(['forward', 'backward'])),
    launch: LaunchFactsSchema,
    directions: z.array(TrapDirectionSchema),
  })
  .strict()
export type KeyboardTrapResult = z.infer<typeof KeyboardTrapResultSchema>

// A step that replaced the document BEGINS a new segment: every backendNodeId is re-minted on
// replacement (bench/probes/wrap/RESULT.md:77), so an identity from before it names nothing after it.
function lastSegment(steps: readonly TabWalkStep[]): readonly TabWalkStep[] {
  let start = 0
  for (let i = 0; i < steps.length; i++) if (steps[i].documentReplaced) start = i
  return steps.slice(start)
}

// The last F+1 stops: one full cycle plus the wrap. A whole-walk test cannot see a trap that opens
// after the page has already wrapped once.
function tailOf(segment: readonly TabWalkStep[], focusableCount: number): readonly TabWalkStep[] {
  return segment.slice(-Math.min(focusableCount + 1, segment.length))
}

// Distinct identities of the real (non-body, readable) stops, in the order they were first reached.
function identitiesOf(steps: readonly TabWalkStep[]): number[] {
  const out: number[] = []
  for (const step of steps) {
    if (!isReal(step.settled)) continue
    const identity = focusIdentity(step.settled)
    if (identity === null || out.includes(identity)) continue
    out.push(identity)
  }
  return out
}

// The most stops from one wrap to the next that the segment measured, its start counting as a wrap;
// 0 when it never wrapped.
function longestLap(segment: readonly TabWalkStep[]): number {
  let lap = 0
  let lastWrap = 0
  for (const [i, step] of segment.entries()) {
    if (!step.wrapped) continue
    lap = Math.max(lap, i + 1 - lastWrap)
    lastWrap = i + 1
  }
  return lap
}

// Did the walk reach the end of the page? Two signals, and NEVER "focus returned to the
// first element it visited" — every cyclic trap does that, and it silently passes 4 of the 6 M5
// fixtures (bench/results/cd3b122/dev-variants). It reads one step per stop (collapseStops), so a raw walk and the
// judge's collapsed one get the same answer.
export function endOfPage(raw: TabWalkResult): EndOfPage | null {
  const walk = collapseStops(raw)
  const segment = lastSegment(walk.steps)
  const tail = tailOf(segment, walk.focusableCount)
  const firstWrap = segment.find((step) => step.wrapped)
  // Gated on a wrap in the TAIL, but reported at the segment's first wrap: that is when the end of
  // the page was first observed.
  if (tail.some((step) => step.wrapped) && firstWrap !== undefined) {
    return { signal: 'body-unfocused', atPress: firstWrap.index }
  }
  // F was counted on the document the walk started in, so it only describes segment 0. F === 0 leaves
  // nothing to have visited, and would otherwise report an end-of-page at a press that never happened.
  if (walk.focusableCount === 0 || walk.steps.some((step) => step.documentReplaced)) return null
  // Completing the count only means the walk ARRIVED on every stop, and a trap met after that (on the
  // last stop, among the last few, or closing after a lap) completes it too. The last F+1 stops must
  // still reach F distinct stops, which a trap confined to fewer than F cannot do.
  if (identitiesOf(tail).length < walk.focusableCount) return null
  // A trap confined to F or more completes that too: the page's only stop, a script loop over every stop,
  // a region padded with stops F does not count. Only a recent wrap tells the page's own lap from a loop.
  // Unactivated new headless shows body on every other wrap (bench/probes/wrap/RESULT.md:16), so the window is
  // two of the longest laps the walk measured, at least 2F+1.
  const lapWindow = 2 * Math.max(walk.focusableCount, longestLap(segment)) + 1
  if (!segment.slice(-lapWindow).some((step) => step.wrapped)) return null
  const seen = new Set<number>()
  for (const step of segment) {
    if (!isReal(step.settled)) continue
    const identity = focusIdentity(step.settled)
    if (identity === null) continue
    seen.add(identity)
    if (seen.size >= walk.focusableCount) return { signal: 'all-stops-visited', atPress: step.index }
  }
  return null
}

// The escape probe's Shift+Tab steps are NEVER independent evidence: Escape is pressed first
// (runEscapeProbe in tab-walk.ts), so they describe the post-Escape document, not the trapped one. Only the
// conjunction — no end of page, Escape did not release, the opposite key did not release — is a trap.
function judgeWalk(walk: TabWalkResult): TrapDirection {
  const segment = lastSegment(walk.steps)
  const tail = tailOf(segment, walk.focusableCount)
  const region = identitiesOf(tail)
  const facts = {
    direction: walk.direction,
    region,
    focusableCount: walk.focusableCount,
    // Recorded so a reader can see it; a URL change is not evidence that focus moved.
    escapeUrlChanged: walk.escapeProbe?.escape.urlChanged ?? false,
    documentReplacements: walk.steps.filter((step) => step.documentReplaced).map((step) => step.index),
  }
  const undetermined = (reason: TrapUndeterminedReason): TrapDirection => ({
    ...facts,
    verdict: 'undetermined',
    reason,
    confined: false,
    endOfPage: null,
    release: 'not-probed',
    stuckOn: null,
  })
  const released = (release: TrapRelease): TrapDirection => ({
    ...facts,
    verdict: 'pass',
    reason: null,
    confined: true,
    endOfPage: null,
    release,
    stuckOn: null,
  })

  // 0
  if (walk.error !== null || walk.suspectedTrap === null) return undetermined('walk-error')
  const reachedEnd = endOfPage(walk)
  // 1
  if (reachedEnd !== null && reachedEnd.signal === 'body-unfocused') {
    return {
      ...facts,
      verdict: 'pass',
      reason: null,
      confined: false,
      endOfPage: reachedEnd,
      release: 'not-probed',
      stuckOn: null,
    }
  }
  // 2 — the page added or removed tab stops during the walk, so every F-based test below is unsafe.
  if (walk.focusableCountEnd !== null && walk.focusableCountEnd !== walk.focusableCount) {
    return undetermined('focusables-changed')
  }
  // 3
  if (walk.fIncomplete) return undetermined('focusables-incomplete')
  // 4 — endOfPage only emits this signal for a segment-0 walk with F > 0.
  if (reachedEnd !== null) {
    return {
      ...facts,
      verdict: 'pass',
      reason: null,
      confined: false,
      endOfPage: reachedEnd,
      release: 'not-probed',
      stuckOn: null,
    }
  }
  // 5 — F was counted on a document that no longer exists.
  if (facts.documentReplacements.length > 0) return undetermined('document-replaced')
  // 6
  if (walk.steps.length < walk.defaultPresses) return undetermined('short-walk')
  // 7
  if (region.length === 0) return undetermined('focus-unreadable')
  // 8
  const probe = walk.escapeProbe
  if (probe === null) return undetermined('no-release-probe')
  // "Unseen" is a release read through node identity. More distinct stops in the last F+1 stops than
  // F counts means F misses stops (a keyboard-focusable scroller) or the page re-creates nodes as focus
  // moves; either way a new node is no evidence of a new place, so such a release is refused. A wrap or a
  // replaced document is not read through identity and stays a release; a probe that got nowhere still fails.
  const exceeded = region.length > walk.focusableCount
  // 9
  if (probe.escape.wrapped || probe.escape.documentReplaced) return released('escape-key')
  if (probe.escape.unseenElement) return exceeded ? undetermined('focusables-exceeded') : released('escape-key')
  // 10
  if (probe.reachedAt !== null) {
    const byWrap = probe.steps[probe.reachedAt - 1]?.wrapped === true
    return exceeded && !byWrap ? undetermined('focusables-exceeded') : released('opposite-key')
  }
  // 11 — clause 7 guarantees the tail holds at least one real stop.
  const stuck = [...tail].reverse().find((step) => isReal(step.settled))
  return {
    ...facts,
    verdict: 'fail',
    reason: null,
    confined: true,
    endOfPage: null,
    release: 'none',
    stuckOn: stuck === undefined ? null : focusStop(stuck.settled),
  }
}

// A region smaller than F never decides a verdict by itself: F legitimately over-counts (the recorded
// navbar walk has F=12 and reaches 8 real stops, the modal F=8 and reaches 4). It only holds back the
// all-stops-visited end of page (endOfPage), which sends a wrapless tail to the release probe. A region
// larger than F refuses a release read through node identity (clauses 9-10). Each walk is judged in stops
// (collapseStops): a date, time or media control that takes several presses is one step.
export function judgeKeyboardTrap(walks: readonly TabWalkResult[]): KeyboardTrapResult {
  const directions = walks.map((walk) => judgeWalk(collapseStops(walk)))
  const passes = directions.filter((direction) => direction.verdict === 'pass')
  const verdict: TrapVerdict = directions.some((direction) => direction.verdict === 'fail')
    ? 'fail'
    : passes.length > 0
      ? 'pass'
      : 'undetermined'
  const firstReason = directions.find((direction) => direction.reason !== null)?.reason ?? 'walk-error'
  const keyboardTrap = directions.some((direction) => direction.confined)
  return {
    wcagCriterion: '2.1.2',
    verdict,
    reason: verdict === 'undetermined' ? firstReason : null,
    keyboardTrap,
    // null exactly when nothing was confined; false as soon as one confined direction released on no key.
    trapEscapable: keyboardTrap
      ? !directions.some((direction) => direction.confined && direction.release === 'none')
      : null,
    // A pass carried by a single direction is a recorded caveat, not an undetermined: a backward-armed
    // trap is out of scope (bench/COVERAGE.md).
    singleDirection: verdict === 'pass' && passes.length === 1,
    directionsWalked: walks.map((walk) => walk.direction),
    launch: walks[0]?.launchFacts ?? {
      browserVersion: null,
      executableBasename: null,
    },
    directions,
  }
}
