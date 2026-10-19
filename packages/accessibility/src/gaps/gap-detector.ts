import type { Impact } from '../types.js'
import { groupReach, NO_WALK } from './keyboard.js'
import type {
  AccessibilityGap,
  AccessibilityGapType,
  DOMElement,
  FocusFacts,
  InteractivitySignals,
  KeyboardEvidence,
  PageElementGraph,
} from './types.js'

// Port of taskgen/src/gap-detector.ts (GapDetector) as functions.

// The gap types a Tab walk gates: the F3 guard below emits them only when keyboard.notFocusableAssessed,
// so on a page without an assessed walk their absence is "never looked", not "looked and found nothing".
// The bench report reads this to keep those two apart (bench/report.ts).
export const WALK_GATED_GAP_TYPES = ['not_focusable'] as const

export const GAP_WCAG_MAPPING: Record<AccessibilityGapType, string[]> = {
  missing_from_a11y_tree: ['4.1.2'],
  no_accessible_name: ['4.1.2', '1.1.1'],
  wrong_role: ['4.1.2'],
  not_focusable: ['2.1.1', '2.4.7'],
  hidden_but_interactive: ['4.1.2'],
}

const GAP_SEVERITY_MAPPING: Record<AccessibilityGapType, Impact> = {
  missing_from_a11y_tree: 'critical',
  not_focusable: 'critical',
  no_accessible_name: 'serious',
  wrong_role: 'serious',
  hidden_but_interactive: 'moderate',
}

const GAP_FIX_SUGGESTIONS: Record<AccessibilityGapType, string> = {
  missing_from_a11y_tree:
    'Add appropriate ARIA role and ensure element is not hidden from assistive technology. Consider using semantic HTML (e.g., <button> instead of <div>).',
  no_accessible_name: 'Add an accessible name via aria-label, aria-labelledby, or visible text content.',
  wrong_role: "Change the role to match the element's function, or use semantic HTML elements.",
  not_focusable:
    'Add tabindex="0" to make the element keyboard focusable, and ensure it can be activated with Enter/Space.',
  hidden_but_interactive: 'Remove aria-hidden="true" or ensure the element is not interactive if it should be hidden.',
}

// Chromium ignores these nodes because the element is not rendered or not visible (F1).
const HIDDEN_AX_REASONS = ['notRendered', 'notVisible']
// Roles that carry no semantics; ARIA prohibits naming a generic, so a missing name is not its defect (F2).
const NO_ROLE_ROLES = ['generic', 'group', 'none']

const INTERACTIVE_ROLES = [
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'combobox',
  'listbox',
  'textbox',
  'searchbox',
  'treeitem',
  'gridcell',
]

// backendNodeId -> ElementNode.id; a later AX node sharing a backend id overwrites the earlier one.
export function buildBridgeMap(accessibilityTree: PageElementGraph): Map<number, string> {
  const bridgeMap = new Map<number, string>()
  for (const [elementId, element] of accessibilityTree.elements) {
    if (element.backendDOMNodeId !== undefined) {
      bridgeMap.set(element.backendDOMNodeId, elementId)
    }
  }
  return bridgeMap
}

export type DetectGapsOptions = {
  // From a Tab walk of the same load; without it not_focusable is never emitted (F3).
  keyboard?: KeyboardEvidence
  // Per candidate, read before the walk: disabled controls and arrow-key group members are not not_focusable (G1b).
  focus?: ReadonlyMap<number, FocusFacts>
}

type ClassifyContext = {
  accessibilityTree: PageElementGraph
  bridgeMap: Map<number, string>
  keyboard: KeyboardEvidence
  focus: ReadonlyMap<number, FocusFacts>
  // Focused by Tab, or reached through a group, widget or aria-activedescendant Tab entered (G1b, G1c).
  reached: ReadonlySet<number>
}

export function detectGaps(
  domElements: readonly DOMElement[],
  accessibilityTree: PageElementGraph,
  signals: ReadonlyMap<number, InteractivitySignals>,
  options: DetectGapsOptions = {},
): AccessibilityGap[] {
  const keyboard = options.keyboard ?? NO_WALK
  const focus = options.focus ?? new Map<number, FocusFacts>()
  const byGroup = groupReach(keyboard.reachedBackendNodeIds, focus).map((r) => r.backendNodeId)
  const ctx: ClassifyContext = {
    accessibilityTree,
    bridgeMap: buildBridgeMap(accessibilityTree),
    keyboard,
    focus,
    reached: new Set([...keyboard.reachedBackendNodeIds, ...byGroup]),
  }
  const gaps: AccessibilityGap[] = []

  for (const domElement of domElements) {
    const elementSignals = signals.get(domElement.backendNodeId)
    if (!elementSignals) continue
    if (!isLikelyInteractive(elementSignals)) continue

    const gap = classifyGap(domElement, elementSignals, ctx)
    if (gap) gaps.push(gap)
  }

  return gaps
}

// Hand-set weights and threshold 2 from taskgen, never calibrated (F9 left them unchanged).
export function isLikelyInteractive(signals: InteractivitySignals): boolean {
  let score = 0

  if (signals.hasClickHandler) score += 2
  if (signals.isSemanticInteractive) score += 2
  if (signals.hasRoleAttribute && isInteractiveRole(signals.roleValue)) score += 2

  if (signals.hasCursorPointer) score += 1
  if (signals.hasTabindex && signals.tabindexValue !== -1) score += 1
  if (signals.hasAriaExpanded) score += 1

  if (signals.classNameHints.length > 0) score += 0.5

  return score >= 2
}

function isInteractiveRole(role: string | null): boolean {
  if (!role) return false
  return INTERACTIVE_ROLES.includes(role.toLowerCase())
}

// After a walk, an aria-hidden control counts only if the keyboard reached it: one never reached is hidden from keyboard
// and assistive technology alike (e.g. page content behind a modal). Only a complete walk, or one stopped by a trap
// (the modal case), can show that; after any other incomplete walk, or none, the static rule decides (G1b).
function hiddenFromKeyboardToo(domElement: DOMElement, ctx: ClassifyContext): boolean {
  const { walkRan, unassessedReasons } = ctx.keyboard
  const walkCovers = walkRan && unassessedReasons.every((r) => r === 'no-wrap')
  return walkCovers && !ctx.reached.has(domElement.backendNodeId)
}

function classifyGap(
  domElement: DOMElement,
  signals: InteractivitySignals,
  ctx: ClassifyContext,
): AccessibilityGap | null {
  const { accessibilityTree, bridgeMap } = ctx
  const axElementId = bridgeMap.get(domElement.backendNodeId)
  // F2: disabled or inert (which covers everything outside an open modal <dialog>) and left unexposed: the page switched
  // it off for mouse, keyboard and assistive technology alike, so it is not a candidate. An exposed one is still judged.
  const exposed = axElementId !== undefined && accessibilityTree.elements.get(axElementId)?.ignored === false
  if (!exposed && ctx.focus.get(domElement.backendNodeId)?.disabled) return null

  if (!axElementId) {
    return createGap(
      domElement,
      signals,
      'missing_from_a11y_tree',
      `${domElement.nodeName} element with interactivity signals is not exposed in the accessibility tree`,
    )
  }

  const axElement = accessibilityTree.elements.get(axElementId)
  if (!axElement) return null
  if (axElement.ignoredReasons.some((r) => HIDDEN_AX_REASONS.includes(r))) return null

  if (axElement.ignored) {
    const ariaHidden = axElement.ignoredReasons.some((r) => r === 'ariaHiddenElement' || r === 'ariaHiddenSubtree')
    if (ariaHidden && hiddenFromKeyboardToo(domElement, ctx)) return null
    if (axElement.ignoredReasons.includes('ariaHiddenElement')) {
      return createGap(
        domElement,
        signals,
        'hidden_but_interactive',
        `${domElement.nodeName} element has aria-hidden="true" but is interactive`,
      )
    }
    if (axElement.ignoredReasons.includes('ariaHiddenSubtree')) {
      return createGap(
        domElement,
        signals,
        'hidden_but_interactive',
        `${domElement.nodeName} element is inside an aria-hidden="true" subtree but is interactive`,
      )
    }
    return createGap(
      domElement,
      signals,
      'missing_from_a11y_tree',
      `${domElement.nodeName} element with interactivity signals is not exposed in the accessibility tree`,
    )
  }

  if (NO_ROLE_ROLES.includes(axElement.role)) {
    if (signals.hasClickHandler || isInteractiveRole(signals.roleValue)) {
      return createGap(
        domElement,
        signals,
        'wrong_role',
        `${domElement.nodeName} element has click handlers but generic role "${axElement.role}"`,
      )
    }
  }

  if (!axElement.name || axElement.name.trim() === '') {
    if (signals.hasClickHandler || signals.isSemanticInteractive) {
      return createGap(
        domElement,
        signals,
        'no_accessible_name',
        `Interactive ${domElement.nodeName} element has no accessible name`,
      )
    }
  }

  // F3: keyboard access comes from where Tab really went, never from the tag or the tabindex attribute. A disabled
  // control is meant to be unfocusable (G1b).
  if (
    ctx.keyboard.notFocusableAssessed &&
    !ctx.reached.has(domElement.backendNodeId) &&
    !ctx.focus.get(domElement.backendNodeId)?.disabled &&
    (signals.hasClickHandler || signals.hasCursorPointer)
  ) {
    return createGap(
      domElement,
      signals,
      'not_focusable',
      `${domElement.nodeName} element has ${signals.hasClickHandler ? 'click handlers' : 'cursor:pointer'} but a complete Tab walk never focused it`,
    )
  }

  // Chromium still exposes an aria-hidden element that has focus; the ignored case is handled above.
  if (
    domElement.attributes['aria-hidden'] === 'true' &&
    signals.hasClickHandler &&
    !hiddenFromKeyboardToo(domElement, ctx)
  ) {
    return createGap(
      domElement,
      signals,
      'hidden_but_interactive',
      `${domElement.nodeName} element has aria-hidden="true" but also has click handlers`,
    )
  }

  return null
}

function createGap(
  domElement: DOMElement,
  signals: InteractivitySignals,
  gapType: AccessibilityGapType,
  evidence: string,
): AccessibilityGap {
  return {
    domElement,
    signals,
    gapType,
    severity: GAP_SEVERITY_MAPPING[gapType],
    wcagViolations: GAP_WCAG_MAPPING[gapType],
    suggestedFix: GAP_FIX_SUGGESTIONS[gapType],
    evidence,
  }
}

export function getElementDescription(domElement: DOMElement): string {
  const parts: string[] = [`<${domElement.localName}>`]

  if (domElement.attributes['id']) {
    parts.push(`with id="${domElement.attributes['id']}"`)
  }

  if (domElement.attributes['class']) {
    const classes = domElement.attributes['class'].split(' ').slice(0, 3).join(' ')
    parts.push(`class="${classes}"`)
  }

  if (domElement.attributes['aria-label']) {
    parts.push(`labeled "${domElement.attributes['aria-label']}"`)
  } else if (domElement.attributes['title']) {
    parts.push(`titled "${domElement.attributes['title']}"`)
  }

  return parts.join(' ')
}
