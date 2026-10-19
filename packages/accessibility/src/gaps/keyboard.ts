import { focusIdentity, type TabWalkResult } from '../tab-walk.js'
import type { FocusFacts, GroupReach, KeyboardEvidence, KeyboardUnassessedReason } from './types.js'

// Keyboard reachability for the gap detector, read from a Tab walk of the same load (F3).

export const NO_WALK: KeyboardEvidence = {
  walkRan: false,
  notFocusableAssessed: false,
  unassessedReasons: ['walk-not-run'],
  walkError: null,
  reachedBackendNodeIds: [],
}

export function walkFailed(message: string): KeyboardEvidence {
  return { ...NO_WALK, unassessedReasons: ['walk-failed'], walkError: message }
}

// An element is keyboard-reachable iff a read after a Tab press focused it (the deep element when resolved).
// Unreached means unfocusable only when the walk finished, wrapped, saw every stop and kept one document.
export function keyboardEvidence(walk: TabWalkResult): KeyboardEvidence {
  const reasons: KeyboardUnassessedReason[] = []
  if (walk.error) reasons.push('walk-error')
  if (walk.fIncomplete) reasons.push('focusables-incomplete')
  if (walk.suspectedTrap === true) reasons.push('no-wrap')
  // The idle baseline before the first press counts too: a replacement there leaves every press on another document.
  const replaced = walk.idle?.documentReplaced === true || walk.steps.some((s) => s.documentReplaced)
  if (replaced) reasons.push('document-replaced')

  const reached = new Set<number>()
  for (const step of walk.steps) {
    for (const read of [step.immediate, step.settled]) {
      const id = focusIdentity(read)
      if (id !== null) reached.add(id)
    }
  }

  return {
    walkRan: true,
    notFocusableAssessed: reasons.length === 0,
    unassessedReasons: reasons,
    walkError: walk.error?.message ?? null,
    reachedBackendNodeIds: [...reached],
  }
}

// G1b: a candidate Tab never focused is still keyboard-reachable when Tab focused another member of its radio group,
// or of its composite widget once a keydown on the container or a member shows arrow-key handling (G1c). A member of a
// widget managed by aria-activedescendant is reached with the element carrying it, and a widget container once focus
// was inside it (G1c). Arrow keys skip disabled members, so they never count.
export function groupReach(reached: readonly number[], facts: ReadonlyMap<number, FocusFacts>): GroupReach[] {
  const direct = new Set(reached)
  const radioGroups = new Set<string>()
  const entered = new Set<number>()
  // A widget is entered by reaching one of its members, or the container itself (a menubar with tabindex=0).
  const widgets = new Set<number>()
  for (const f of facts.values()) if (f.compositeWidget !== null) widgets.add(f.compositeWidget)
  for (const id of direct) {
    if (widgets.has(id)) entered.add(id)
    const f = facts.get(id)
    if (!f) continue
    if (f.radioGroup !== null) radioGroups.add(f.radioGroup)
    if (f.compositeWidget !== null) entered.add(f.compositeWidget)
  }
  const keyed = new Set<number>()
  for (const [id, f] of facts) {
    if (!f.keydownHandler) continue
    keyed.add(id)
    if (f.compositeWidget !== null) keyed.add(f.compositeWidget)
  }

  const out: GroupReach[] = []
  for (const [backendNodeId, f] of facts) {
    if (direct.has(backendNodeId) || f.disabled) continue
    const widget = f.compositeWidget
    if (f.radioGroup !== null && radioGroups.has(f.radioGroup)) {
      out.push({ backendNodeId, rule: 'radio-group' })
    } else if (widget !== null && entered.has(widget) && keyed.has(widget)) {
      out.push({ backendNodeId, rule: 'composite-widget' })
    } else if (f.activeDescendantHost !== null && direct.has(f.activeDescendantHost)) {
      out.push({ backendNodeId, rule: 'active-descendant' })
    }
  }

  // Every widget holding focus: each reached element's widget and the widgets around that one.
  const holding = new Set<number>()
  for (const id of [...direct, ...out.map((r) => r.backendNodeId)]) {
    let widget = facts.get(id)?.compositeWidget ?? null
    while (widget !== null && !holding.has(widget)) {
      holding.add(widget)
      widget = facts.get(widget)?.compositeWidget ?? null
    }
  }
  const recorded = new Set(out.map((r) => r.backendNodeId))
  for (const [backendNodeId, f] of facts) {
    if (!holding.has(backendNodeId) || direct.has(backendNodeId) || recorded.has(backendNodeId) || f.disabled) continue
    out.push({ backendNodeId, rule: 'widget-container' })
  }
  return out
}
