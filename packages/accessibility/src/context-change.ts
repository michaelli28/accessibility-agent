import { z } from 'zod'
import {
  DeepFocusSchema,
  TabKeySchema,
  focusStop,
  groupStops,
  isRealElement as isRealStop,
  type DeepFocus,
  type TabWalkResult,
} from './tab-walk.js'

// WCAG 3.2.1 verdict over a scripted Tab walk. Replaces the pre-fix DynamicEvaluator rule, which
// fired on the agent's OWN navigate action and could never see the real failure.
// Two faults are reported: the page changes context when focus arrives (URL change), and F55 —
// focus removed as soon as it arrives, which is how all 4 W3C BAD pages fail 3.2.1.
// Anything the walk cannot attribute to the keypress is REFUSED (recorded as unattributed), never
// reported: a 15-60s walk otherwise blames the page for any timer or redirect that lands in it.

export const ContextChangeKindSchema = z.enum(['url-changed', 'focus-removed'])
export type ContextChangeKind = z.infer<typeof ContextChangeKindSchema>

export const UnattributedReasonSchema = z.enum([
  'url-changed-after-settle',
  'focus-removed-after-settle',
  'document-replaced-no-url-change',
  'no-preceding-stop',
])
export type UnattributedReason = z.infer<typeof UnattributedReasonSchema>

export const ContextChangeUndeterminedReasonSchema = z.enum([
  'walk-error',
  'short-walk',
  'page-navigates-without-input',
])
export type ContextChangeUndeterminedReason = z.infer<typeof ContextChangeUndeterminedReasonSchema>

export const ContextChangeFindingSchema = z
  .object({
    kind: ContextChangeKindSchema,
    wcagCriterion: z.literal('3.2.1'),
    severity: z.literal('serious'),
    pressIndex: z.number().int().positive(),
    key: TabKeySchema,
    // Always null on focus-removed, whose immediate read is body. Usually null on url-changed: the element is gone by
    // the time the read lands.
    arrivedOn: DeepFocusSchema.nullable(),
    precedingStop: DeepFocusSchema.nullable(),
    fromUrl: z.string(),
    toUrl: z.string(),
    documentReplaced: z.boolean(),
  })
  .strict()
export type ContextChangeFinding = z.infer<typeof ContextChangeFindingSchema>

export const UnattributedPressSchema = z
  .object({
    pressIndex: z.number().int().positive(),
    reason: UnattributedReasonSchema,
  })
  .strict()
export type UnattributedPress = z.infer<typeof UnattributedPressSchema>

export const ContextChangeResultSchema = z
  .object({
    wcagCriterion: z.literal('3.2.1'),
    verdict: z.enum(['pass', 'fail', 'undetermined']),
    reason: ContextChangeUndeterminedReasonSchema.nullable(),
    // Recorded only: the rule is per-press and never reads F.
    fIncomplete: z.boolean(),
    findings: z.array(ContextChangeFindingSchema),
    unattributed: z.array(UnattributedPressSchema),
  })
  .strict()
export type ContextChangeResult = z.infer<typeof ContextChangeResultSchema>

// A fragment-only change is NOT a change of context: a scroll-spy page calling
// history.replaceState(null, '', '#s3') would otherwise produce a finding on every single press.
function contextUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    // Not a parseable URL (about:blank variants, data:, a truncated record): compare it verbatim.
    return url
  }
}

export function judgeContextChange(walk: TabWalkResult): ContextChangeResult {
  const findings: ContextChangeFinding[] = []
  const unattributed: UnattributedPress[] = []
  // The last real tab stop of the CURRENT segment. A document replacement re-mints every
  // backendNodeId (bench/probes/wrap/RESULT.md), so a stop from the old document can never name an
  // element in the new one — the tracker resets AFTER the replacing step, whose own finding is
  // still allowed to name the stop the press started from.
  let lastRealStop: DeepFocus | null = isRealStop(walk.initial) ? focusStop(walk.initial) : null

  for (const [i, step] of walk.steps.entries()) {
    // Never immediate vs settled INSIDE one step: that comparison cannot tell a focus handler from
    // a timer. The baseline is where the page was before this press.
    const previousUrl = i === 0 ? walk.initial.url : walk.steps[i - 1].settled.url
    const before = contextUrl(previousUrl)
    const settledMoved = contextUrl(step.settled.url) !== before
    const immediateMoved = contextUrl(step.immediate.url) !== before
    const arrivedOn = isRealStop(step.immediate) ? focusStop(step.immediate) : null
    const finding = (kind: ContextChangeKind): ContextChangeFinding => ({
      kind,
      wcagCriterion: '3.2.1',
      severity: 'serious',
      pressIndex: step.index,
      key: step.key,
      arrivedOn,
      precedingStop: lastRealStop,
      fromUrl: previousUrl,
      toUrl: step.settled.url,
      documentReplaced: step.documentReplaced,
    })

    if (settledMoved && immediateMoved) {
      // A: the URL had already moved when the press returned. Attributable to the keypress.
      findings.push(finding('url-changed'))
    } else if (settledMoved) {
      // A': it arrived during the settle. A timer or a deferred redirect cannot be ruled out.
      unattributed.push({
        pressIndex: step.index,
        reason: 'url-changed-after-settle',
      })
    } else if (step.documentReplaced) {
      // B: 2 of 406 headed presses replaced the document spontaneously with the URL unchanged
      // (bench/probes/wrap/RESULT.md). A documentReplaced-only rule invents violations at that rate.
      unattributed.push({
        pressIndex: step.index,
        reason: 'document-replaced-no-url-change',
      })
    } else if (step.settled.isBody && step.settled.hasFocus) {
      // isBody && hasFocus is focus DROPPED; a wrap past the last stop is isBody && !hasFocus.
      if (step.focusLost && step.immediate.isBody && step.immediate.hasFocus) {
        // C: F55 — focus thrown away the moment it arrived: after a real stop in this segment, or on a focus event
        // since the previous read, usually this press's own (precedingStop is then null). Like A, the drop must
        // already show at the immediate read.
        findings.push(finding('focus-removed'))
      } else if (step.focusLost) {
        // C': it dropped during the settle, like A'. A page timer cannot be told from a deferred focus handler, so any
        // F55 removal first seen after the immediate read is refused too, whatever deferred it (a timer, a CSS
        // animation, chained rAF): a cost, stated in bench/COVERAGE.md.
        unattributed.push({
          pressIndex: step.index,
          reason: 'focus-removed-after-settle',
        })
      } else {
        // D: no earlier read in this document, and no focus event the walk heard since the previous read, showed focus
        // on an element. Indistinguishable from "the first stop is simply unreachable", which belongs to the 2.1.1 gap
        // path. Recorded, never reported.
        unattributed.push({
          pressIndex: step.index,
          reason: 'no-preceding-stop',
        })
      }
    }

    if (step.documentReplaced) lastRealStop = null
    if (isRealStop(step.settled)) lastRealStop = focusStop(step.settled)
  }

  // The causality control, and the only reason that outranks a finding. `walk.initial` is read
  // BEFORE the idle settle, so a page that navigates with no keypress leaves press 1 comparing
  // against a URL the page has already left — clause A then manufactures a focus-caused change on
  // exactly the page this control exists for. Nothing in such a walk is attributable to focus.
  // A fragment-only idle change is no navigation (contextUrl), unless the walk also refused a drop that landed in the
  // settle: a timer setting location.hash clears focus by itself, and a tick in the ~1 ms before an immediate read
  // would still be reported, so such a walk stays refused.
  const movedWithoutInput =
    walk.idle !== null &&
    (contextUrl(walk.idle.after.url) !== contextUrl(walk.initial.url) ||
      walk.idle.documentReplaced ||
      (walk.idle.urlChanged && unattributed.some((u) => u.reason === 'focus-removed-after-settle')))

  // In stops, as the walk's budget and the 2.1.2 judge count them.
  const shortWalk = groupStops(walk.steps).length < walk.defaultPresses
  const reason: ContextChangeUndeterminedReason | null =
    walk.error !== null
      ? 'walk-error'
      : shortWalk
        ? 'short-walk'
        : movedWithoutInput
          ? 'page-navigates-without-input'
          : null

  return {
    wcagCriterion: '3.2.1',
    verdict: movedWithoutInput
      ? 'undetermined'
      : findings.length > 0
        ? 'fail'
        : reason !== null
          ? 'undetermined'
          : 'pass',
    reason: movedWithoutInput ? 'page-navigates-without-input' : findings.length > 0 ? null : reason,
    fIncomplete: walk.fIncomplete,
    findings,
    unattributed,
  }
}
