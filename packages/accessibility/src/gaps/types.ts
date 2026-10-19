import { z } from 'zod'
import { ImpactSchema } from '../types.js'

// Ported from taskgen/src/types.ts: only the shapes the dual-crawl gap path produces or reads.

export const ACCESSIBILITY_GAP_TYPES = [
  'missing_from_a11y_tree',
  'no_accessible_name',
  'wrong_role',
  'not_focusable',
  'hidden_but_interactive',
] as const
export const AccessibilityGapTypeSchema = z.enum(ACCESSIBILITY_GAP_TYPES)
export type AccessibilityGapType = z.infer<typeof AccessibilityGapTypeSchema>

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})
export type BoundingBox = z.infer<typeof BoundingBoxSchema>

// A DOM element found by CDP DOM.* queries; backendNodeId bridges it to the AX tree.
export const DOMElementSchema = z.object({
  nodeId: z.number(),
  backendNodeId: z.number(),
  nodeName: z.string(),
  localName: z.string(),
  attributes: z.record(z.string()),
  boundingBox: BoundingBoxSchema.nullable().optional(),
  pageUrl: z.string(),
})
export type DOMElement = z.infer<typeof DOMElementSchema>

export const InteractivitySignalsSchema = z.object({
  hasClickHandler: z.boolean(),
  hasCursorPointer: z.boolean(),
  isSemanticInteractive: z.boolean(),
  hasTabindex: z.boolean(),
  tabindexValue: z.number().nullable(),
  hasRoleAttribute: z.boolean(),
  roleValue: z.string().nullable(),
  hasAriaExpanded: z.boolean(),
  classNameHints: z.array(z.string()),
})
export type InteractivitySignals = z.infer<typeof InteractivitySignalsSchema>

export const AccessibilityGapSchema = z.object({
  domElement: DOMElementSchema,
  signals: InteractivitySignalsSchema,
  gapType: AccessibilityGapTypeSchema,
  severity: ImpactSchema,
  wcagViolations: z.array(z.string()),
  suggestedFix: z.string().optional(),
  evidence: z.string(),
})
export type AccessibilityGap = z.infer<typeof AccessibilityGapSchema>

export const ElementTypeFlagsSchema = z.object({
  isLandmark: z.boolean(),
  landmarkRole: z.string().nullable(),
  isButton: z.boolean(),
  isFormField: z.boolean(),
  isTable: z.boolean(),
  isLink: z.boolean(),
  isList: z.boolean(),
  headingLevel: z.number().nullable(),
  isInteractive: z.boolean(),
  isNavigational: z.boolean(),
})
export type ElementTypeFlags = z.infer<typeof ElementTypeFlagsSchema>

// taskgen's ElementNode minus its task-coverage fields (navigationEdges, visited*, violations) and its
// parent/children links, which the gap path never reads.
export const ElementNodeSchema = z.object({
  id: z.string(),
  pageUrl: z.string(),
  xpath: z.string(),
  role: z.string(),
  name: z.string(),
  description: z.string().optional(),
  value: z.string().optional(),
  backendDOMNodeId: z.number().optional(),
  // Chromium's AX ignored flag and ignoredReasons names (e.g. notRendered, ariaHiddenElement).
  ignored: z.boolean(),
  ignoredReasons: z.array(z.string()),
  typeFlags: ElementTypeFlagsSchema,
})
export type ElementNode = z.infer<typeof ElementNodeSchema>

export const PageElementGraphSchema = z.object({
  pageUrl: z.string(),
  title: z.string(),
  elements: z.map(z.string(), ElementNodeSchema),
  crawledAt: z.date(),
  elementCount: z.number(),
})
export type PageElementGraph = z.infer<typeof PageElementGraphSchema>

// Why a candidate was dropped before classification: it is not rendered or not visible (F1).
export const HIDDEN_REASONS = ['hidden-input', 'no-box', 'zero-area', 'css-hidden'] as const
export const HiddenReasonSchema = z.enum(HIDDEN_REASONS)
export type HiddenReason = z.infer<typeof HiddenReasonSchema>

export const HiddenCandidateSchema = z.object({
  backendNodeId: z.number(),
  reason: HiddenReasonSchema,
})
export type HiddenCandidate = z.infer<typeof HiddenCandidateSchema>

export const CRAWL_STAGES = [
  'discover-react',
  'discover-listeners',
  'discover',
  'visibility',
  'cursor',
  'listeners',
  'react-props',
  'focus-facts',
  'tab-walk',
] as const
export const CrawlStageSchema = z.enum(CRAWL_STAGES)
export type CrawlStage = z.infer<typeof CrawlStageSchema>

// A CDP read that failed during the crawl; recorded instead of swallowed.
export const CrawlErrorSchema = z.object({
  stage: CrawlStageSchema,
  backendNodeId: z.number().nullable(),
  message: z.string(),
})
export type CrawlError = z.infer<typeof CrawlErrorSchema>

// Why not_focusable was not assessed on this load (F3).
export const KEYBOARD_UNASSESSED_REASONS = [
  'walk-not-run',
  // runTabWalk threw before walking (e.g. invalid options).
  'walk-failed',
  // The walk stopped on an error part-way.
  'walk-error',
  // A cross-origin frame or closed shadow root may hide Tab stops.
  'focusables-incomplete',
  // Focus never wrapped past the end of the page (a trap), so some stops may never have been tried.
  'no-wrap',
  // The document was replaced after the crawl began (by a keypress, or by the page itself before or during the
  // walk), so the walk's reads are not of the crawled DOM.
  'document-replaced',
  // Crawled nodes the walk never reached left the document between the crawl and the walk's end (a same-window
  // re-mount or document.open(), a toast the page removed), so where Tab went says nothing about them.
  'crawled-nodes-detached',
  // The page's own script refused the crawled window's mark (the write threw or returned false), so which document
  // the walk ran on is unknown.
  'crawl-mark-failed',
] as const
export const KeyboardUnassessedReasonSchema = z.enum(KEYBOARD_UNASSESSED_REASONS)
export type KeyboardUnassessedReason = z.infer<typeof KeyboardUnassessedReasonSchema>

export const KeyboardEvidenceSchema = z.object({
  // A Tab walk ran on the same load after the crawl (it may still have stopped on an error).
  walkRan: z.boolean(),
  // not_focusable is emitted only when true; unassessedReasons says why not otherwise.
  notFocusableAssessed: z.boolean(),
  unassessedReasons: z.array(KeyboardUnassessedReasonSchema),
  walkError: z.string().nullable(),
  // focusIdentity of every read the walk took after a Tab press (immediate and settled).
  reachedBackendNodeIds: z.array(z.number()),
})
export type KeyboardEvidence = z.infer<typeof KeyboardEvidenceSchema>

// Read with the crawl, before the walk (G1b): whether a candidate is meant to be unfocusable, and the arrow-key group
// it belongs to. WCAG 2.1.1 lets one Tab stop serve a radio group or a composite widget; arrows reach the rest.
export const FocusFactsSchema = z.object({
  // Natively disabled (:disabled, so also inside a disabled fieldset), inert (an inert subtree or CSS
  // interactivity: inert), or outside an open modal <dialog>.
  disabled: z.boolean(),
  // A Tab stop by the DOM's own rules: tabIndex >= 0, enabled, not inert, visible, and not an a/area without href
  // or tabindex. Decides zero-area candidates when no complete walk does (G1c).
  focusable: z.boolean(),
  // A named radio's group: its form owner (or tree root, when formless) and its name.
  radioGroup: z.string().nullable(),
  // backendNodeId of the nearest flat-tree ancestor whose role is a composite widget role (tablist, menu, grid...).
  compositeWidget: z.number().nullable(),
  // Own keydown listener or React onKeyDown prop: the widget's arrow-key evidence. Read only for composite widgets
  // and their members, false for the rest (G1c).
  keydownHandler: z.boolean(),
  // backendNodeId of the element carrying aria-activedescendant for the nearest composite widget: the widget itself,
  // or an element whose aria-controls or aria-owns names it (a combobox) (G1c).
  activeDescendantHost: z.number().nullable(),
})
export type FocusFacts = z.infer<typeof FocusFactsSchema>

export const GROUP_REACH_RULES = ['radio-group', 'composite-widget', 'active-descendant', 'widget-container'] as const
export const GroupReachRuleSchema = z.enum(GROUP_REACH_RULES)
export type GroupReachRule = z.infer<typeof GroupReachRuleSchema>

// A candidate Tab never focused that the keyboard still reaches: by arrow keys from a group member Tab focused, as
// the aria-activedescendant of an element Tab focused, or as a widget container focus was inside.
export const GroupReachSchema = z.object({
  backendNodeId: z.number(),
  rule: GroupReachRuleSchema,
})
export type GroupReach = z.infer<typeof GroupReachSchema>

export const DualCrawlResultSchema = z.object({
  pageUrl: z.string(),
  accessibilityTree: PageElementGraphSchema,
  // Every enumerated candidate, hidden ones included; only the visible ones are classified.
  domElements: z.array(DOMElementSchema),
  hidden: z.array(HiddenCandidateSchema),
  gaps: z.array(AccessibilityGapSchema),
  bridgeMap: z.map(z.number(), z.string()),
  keyboard: KeyboardEvidenceSchema,
  // Counted as keyboard-reachable for not_focusable and hidden_but_interactive, with the rule that made them so.
  reachedByGroup: z.array(GroupReachSchema),
  errors: z.array(CrawlErrorSchema),
})
export type DualCrawlResult = z.infer<typeof DualCrawlResultSchema>
