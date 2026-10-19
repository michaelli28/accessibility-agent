/**
 * Type definitions for the automatic accessibility task generation system.
 *
 * This module defines the core data structures for:
 * - Element-level graphs (extending page-level graphs from pagefinder)
 * - Spanning forest representation for coverage
 * - Task definitions with structured step-by-step goals
 * - Coverage tracking
 */

// ==================== Navigation Keys ====================

/**
 * Keyboard actions available for screen reader navigation.
 * Maps to the agent's available tools.
 */
export type NavigationKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'Enter'
  | 'Space'
  | 'Tab'
  | 'Shift+Tab'
  | 'Escape'
  | 'h'        // Next heading
  | 'Shift+h'  // Previous heading
  | 'd'        // Next landmark
  | 'Shift+d'  // Previous landmark
  | 'b'        // Next button
  | 'f'        // Next form field
  | 't'        // Next table
  | 'k'        // Next link
  | 'l'        // Next list
  | '1' | '2' | '3' | '4' | '5' | '6';  // Heading levels

// ==================== DOM Crawling Types ====================

/**
 * Raw DOM element from CDP DOM.* commands.
 * Used to find potentially interactive elements that may not be in the accessibility tree.
 */
export interface DOMElement {
  nodeId: number;                    // CDP DOM nodeId
  backendNodeId: number;             // Backend node ID for bridging to a11y tree
  nodeName: string;                  // Tag name (e.g., 'DIV', 'BUTTON')
  localName: string;                 // Lowercase tag name
  attributes: Record<string, string>; // Element attributes
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  pageUrl: string;                   // Which page this element is on
}

/**
 * Signals that indicate an element may be interactive.
 * Used to detect elements that LOOK interactive but may not be accessible.
 */
export interface InteractivitySignals {
  hasClickHandler: boolean;          // onclick, addEventListener('click'), ng-click, @click
  hasCursorPointer: boolean;         // cursor: pointer in computed styles
  isSemanticInteractive: boolean;    // <button>, <a href>, <input>, etc.
  hasTabindex: boolean;              // tabindex attribute present
  tabindexValue: number | null;      // Actual tabindex value (-1, 0, positive)
  hasRoleAttribute: boolean;         // role="button" etc.
  roleValue: string | null;          // Actual role value
  hasAriaExpanded: boolean;          // Often indicates interactive widget
  classNameHints: string[];          // Classes suggesting interactivity (btn, button, clickable)
}

/**
 * Types of accessibility gaps that can be detected.
 */
export type AccessibilityGapType =
  | 'missing_from_a11y_tree'        // Element not in accessibility tree at all
  | 'no_accessible_name'            // In tree but has no name
  | 'wrong_role'                    // Has generic role but should be interactive
  | 'not_focusable'                 // Should be keyboard accessible but isn't
  | 'hidden_but_interactive';       // aria-hidden/display:none but has handlers

/**
 * A detected accessibility gap - an element that should be accessible but isn't.
 */
export interface AccessibilityGap {
  domElement: DOMElement;
  signals: InteractivitySignals;
  gapType: AccessibilityGapType;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  wcagViolations: string[];          // Relevant WCAG criteria (e.g., '4.1.2', '2.1.1')
  suggestedFix?: string;             // Recommended remediation
  evidence: string;                  // Human-readable description of the gap
}

/**
 * Result of dual crawl (DOM + accessibility tree comparison).
 */
export interface DualCrawlResult {
  pageUrl: string;
  accessibilityTree: PageElementGraph;  // Existing a11y tree crawl
  domElements: DOMElement[];            // All potentially interactive DOM elements
  gaps: AccessibilityGap[];             // Detected accessibility gaps
  bridgeMap: Map<number, string>;       // backendNodeId -> ElementNode.id mapping
}

/**
 * Summary report of all gaps found across the site.
 */
export interface GapReport {
  totalGaps: number;
  gapsByType: Record<AccessibilityGapType, number>;
  gapsBySeverity: Record<string, number>;
  criticalGaps: AccessibilityGap[];
  pageBreakdown: Map<string, AccessibilityGap[]>;
}

// ==================== Element Types ====================

/**
 * Flags indicating the type/category of an element.
 * Mirrors ElementTypeFlags from NavigationTree.ts
 */
export interface ElementTypeFlags {
  isLandmark: boolean;
  landmarkRole: string | null;  // banner, main, navigation, search, complementary, contentinfo, form, region
  isButton: boolean;
  isFormField: boolean;
  isTable: boolean;
  isLink: boolean;
  isList: boolean;
  headingLevel: number | null;  // 1-6 for H1-H6
  isInteractive: boolean;       // Can be activated (button, link, etc.)
  isNavigational: boolean;      // Links to other pages
}

/**
 * A navigation edge representing a keyboard action that moves from one element to another.
 */
export interface NavigationEdge {
  targetId: string;             // Element ID this action leads to
  action: NavigationKey;        // Keyboard action
  crossPage: boolean;           // Does this navigate to another page?
  targetPageUrl?: string;       // If cross-page, which page
}

/**
 * Represents a single element in the accessibility tree.
 */
export interface ElementNode {
  id: string;                   // Unique ID: pageUrl#xpath
  pageUrl: string;              // Which page this element is on
  xpath: string;                // XPath-like identifier within page

  // Accessibility properties (from CDP AXNode)
  role: string;                 // ARIA role (button, link, heading, etc.)
  name: string;                 // Accessible name
  description?: string;         // Accessible description
  value?: string;               // Current value (for inputs)

  // Bridge to DOM tree for gap detection
  backendDOMNodeId?: number;    // CDP backend node ID for bridging to DOM

  // Type flags
  typeFlags: ElementTypeFlags;

  // Graph relationships
  children: string[];           // Child element IDs
  parent: string | null;        // Parent element ID

  // Navigation edges (which keyboard actions lead where)
  navigationEdges: NavigationEdge[];

  // Coverage tracking
  visited: boolean;
  visitedBy: string[];          // Task IDs that visited this element
  wcagEvaluated: boolean;       // Has this element been checked?
  violations: string[];         // WCAG violation IDs found
}

// ==================== Page Graph ====================

/**
 * Outbound link from one page to another.
 */
export interface OutboundLink {
  elementId: string;            // Element ID of the link
  targetUrl: string;            // URL the link points to
  linkText: string;             // Accessible name of the link
}

/**
 * Element-level graph for a single page.
 */
export interface PageElementGraph {
  pageUrl: string;
  title: string;
  elements: Map<string, ElementNode>;
  rootElementIds: string[];     // Top-level landmarks/elements

  // Quick-access indices by type
  headings: string[];
  landmarks: string[];
  buttons: string[];
  formFields: string[];
  links: string[];
  tables: string[];
  lists: string[];

  // Cross-page links discovered
  outboundLinks: OutboundLink[];

  // Metadata
  crawledAt: Date;
  elementCount: number;
  interactiveCount: number;
}

// ==================== Site Graph ====================

/**
 * Page transition representing navigation from one page to another.
 */
export interface PageTransition {
  fromPage: string;
  fromElement: string;
  toPage: string;
  action: 'click' | 'submit' | 'href';
}

/**
 * A single tree in the spanning forest.
 */
export interface SpanningTree {
  rootElementId: string;
  rootPageUrl: string;
  edges: {
    from: string;
    to: string;
    action: NavigationKey;
  }[];
}

/**
 * Complete element-level graph for an entire site.
 */
export interface SiteElementGraph {
  baseUrl: string;
  pages: Map<string, PageElementGraph>;

  // Cross-page navigation graph
  pageTransitions: PageTransition[];

  // Global element counts
  totalElements: number;
  interactiveElements: number;
  landmarkElements: number;

  // Computed spanning forest for coverage
  spanningForest: SpanningTree[];

  // Metadata
  crawledAt: Date;
  pageCount: number;
}

// ==================== Traversal ====================

/**
 * A path through elements representing a sequence of keyboard actions.
 */
export interface TraversalPath {
  entryUrl: string;
  elements: string[];           // Ordered list of element IDs
  actions: NavigationKey[];     // Actions to get from each element to next
  estimatedSteps: number;
}

// ==================== Tasks ====================

/**
 * Task type classification.
 */
export type TaskType = 'atomic' | 'journey' | 'coverage' | 'adaptive' | 'gap';

/**
 * A single step in a task goal.
 */
export interface TaskStep {
  stepNumber: number;
  action: 'navigate_click' | 'navigate' | 'type' | 'activate' | 'report' | 'traverse';
  target?: string;              // Element name/description
  text?: string;                // For type action
  key?: NavigationKey;          // For traverse action
  expectedOutcome?: string;     // For report action
}

/**
 * An accessibility testing task with structured step-by-step goals.
 */
export interface AccessibilityTask {
  id: string;
  type: TaskType;

  // Basic task info (compatible with existing agent format)
  url: string;
  goal: string;                 // Numbered step-by-step goal string

  // Structured steps (internal use)
  steps: TaskStep[];

  // Coverage tracking
  targetElements: string[];     // Element IDs this task should visit
  requiredActions: NavigationKey[]; // Suggested navigation pattern
  expectedCoverage: number;     // How many new elements this should cover

  // WCAG focus
  wcagCriteria: string[];       // Which WCAG criteria to check
  elementTypes: string[];       // What types of elements to focus on

  // Priority and ordering
  priority: number;             // Higher = more important
  dependencies: string[];       // Task IDs that must run first

  // Execution tracking
  attempts: number;
  lastResult?: 'success' | 'failed' | 'partial';
  coveredElements?: string[];   // Actually visited elements
  executedAt?: Date;
}

/**
 * Simple task format for export (compatible with existing agent).
 */
export interface SimpleTask {
  url: string;
  goal: string;
}

// ==================== Coverage ====================

/**
 * Coverage metrics for a specific element type.
 */
export interface TypeCoverage {
  total: number;
  covered: number;
  percent: number;
  uncoveredIds: string[];
}

/**
 * Overall coverage metrics.
 */
export interface CoverageMetrics {
  totalElements: number;
  coveredElements: number;
  coveragePercent: number;
  elementsByType: Map<string, TypeCoverage>;
  uncoveredCritical: string[];  // Interactive elements not covered
  wcagCriteriaChecked: string[];
}

// ==================== Execution Results ====================

/**
 * Result of executing a single task.
 */
export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  visitedElements: string[];
  newViolations: Violation[];
  missedTargets: string[];      // Elements task was supposed to visit but didn't
  stepResults: {
    stepNumber: number;
    completed: boolean;
    observation?: string;
  }[];
  executedAt: Date;
  durationMs: number;
}

/**
 * WCAG violation (mirrors evaluation/src/types.ts).
 */
export interface Violation {
  ruleId: string;               // e.g., 'WCAG-4.1.2'
  description: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  axNodeId?: string;
  elementId?: string;           // Our element ID mapping
  evidence?: string;
}

// ==================== Configuration ====================

/**
 * Configuration for task generation.
 */
export interface TaskGenConfig {
  entryUrl: string;
  maxPages: number;
  maxDepth: number;
  focusAreas?: string[];        // Optional focus on specific areas
  wcagLevel: 'A' | 'AA' | 'AAA';
  coverageThreshold: number;    // Target coverage percentage (0-100)
  includeJourneyTasks: boolean;
  includeAtomicTasks: boolean;
  enableGapDetection?: boolean; // Enable dual-crawl accessibility gap detection
  gapReportPath?: string;       // Output path for gap detection report
}

/**
 * Configuration for full pipeline with adaptive iteration.
 */
export interface FullPipelineConfig extends TaskGenConfig {
  maxAdaptiveRounds: number;    // How many adaptive iterations
  agentModel: string;           // Which LLM to use
  parallelTasks: number;        // Concurrent task execution
  outputPath: string;           // Where to write tasks
}

// ==================== Final Report ====================

/**
 * Final report after running the full pipeline.
 */
export interface FinalReport {
  config: TaskGenConfig;
  graph: SiteElementGraph;
  tasksGenerated: number;
  tasksExecuted: number;
  coverage: CoverageMetrics;
  violations: Violation[];
  adaptiveRounds: number;
  totalDurationMs: number;
  timestamp: Date;
}
