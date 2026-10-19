/**
 * Gap Detector - Compares DOM elements against the accessibility tree
 * to identify accessibility gaps.
 *
 * A "gap" is an element that:
 * - Looks interactive in the DOM (has click handlers, cursor:pointer, etc.)
 * - But is NOT properly exposed in the accessibility tree
 *
 * This is the core of the dual-crawl architecture for finding real accessibility bugs.
 */

import {
  DOMElement,
  InteractivitySignals,
  AccessibilityGap,
  AccessibilityGapType,
  PageElementGraph,
  ElementNode,
} from './types';

// ==================== Gap Classification ====================

/**
 * WCAG criteria associated with each gap type.
 */
const GAP_WCAG_MAPPING: Record<AccessibilityGapType, string[]> = {
  missing_from_a11y_tree: ['4.1.2'],     // Name, Role, Value
  no_accessible_name: ['4.1.2', '1.1.1'], // Name, Role, Value + Non-text Content
  wrong_role: ['4.1.2'],                  // Name, Role, Value
  not_focusable: ['2.1.1', '2.4.7'],      // Keyboard + Focus Visible
  hidden_but_interactive: ['4.1.2'],      // Name, Role, Value
};

/**
 * Severity levels for each gap type.
 */
const GAP_SEVERITY_MAPPING: Record<AccessibilityGapType, 'critical' | 'serious' | 'moderate' | 'minor'> = {
  missing_from_a11y_tree: 'critical',
  not_focusable: 'critical',
  no_accessible_name: 'serious',
  wrong_role: 'serious',
  hidden_but_interactive: 'moderate',
};

/**
 * Suggested fixes for each gap type.
 */
const GAP_FIX_SUGGESTIONS: Record<AccessibilityGapType, string> = {
  missing_from_a11y_tree: 'Add appropriate ARIA role and ensure element is not hidden from assistive technology. Consider using semantic HTML (e.g., <button> instead of <div>).',
  no_accessible_name: 'Add an accessible name via aria-label, aria-labelledby, or visible text content.',
  wrong_role: 'Change the role to match the element\'s function, or use semantic HTML elements.',
  not_focusable: 'Add tabindex="0" to make the element keyboard focusable, and ensure it can be activated with Enter/Space.',
  hidden_but_interactive: 'Remove aria-hidden="true" or ensure the element is not interactive if it should be hidden.',
};

// ==================== Gap Detector Class ====================

export class GapDetector {
  /**
   * Build a bridge map from backendNodeId to ElementNode.id.
   * This allows us to check if a DOM element exists in the accessibility tree.
   */
  buildBridgeMap(accessibilityTree: PageElementGraph): Map<number, string> {
    const bridgeMap = new Map<number, string>();

    for (const [elementId, element] of accessibilityTree.elements) {
      if (element.backendDOMNodeId !== undefined) {
        bridgeMap.set(element.backendDOMNodeId, elementId);
      }
    }

    return bridgeMap;
  }

  /**
   * Detect accessibility gaps by comparing DOM elements against the accessibility tree.
   */
  detectGaps(
    domElements: DOMElement[],
    accessibilityTree: PageElementGraph,
    signals: Map<number, InteractivitySignals>
  ): AccessibilityGap[] {
    const gaps: AccessibilityGap[] = [];
    const bridgeMap = this.buildBridgeMap(accessibilityTree);

    for (const domElement of domElements) {
      const elementSignals = signals.get(domElement.backendNodeId);
      if (!elementSignals) continue;

      // Check if this element is "sufficiently interactive" to warrant a gap check
      if (!this.isLikelyInteractive(elementSignals)) continue;

      // Check for various gap types
      const gap = this.classifyGap(domElement, elementSignals, accessibilityTree, bridgeMap);

      if (gap) {
        gaps.push(gap);
      }
    }

    return gaps;
  }

  /**
   * Determine if an element is likely interactive based on its signals.
   * We use a scoring system to avoid false positives.
   */
  private isLikelyInteractive(signals: InteractivitySignals): boolean {
    let score = 0;

    // Strong signals (each worth 2 points)
    if (signals.hasClickHandler) score += 2;
    if (signals.isSemanticInteractive) score += 2;
    if (signals.hasRoleAttribute && this.isInteractiveRole(signals.roleValue)) score += 2;

    // Medium signals (each worth 1 point)
    if (signals.hasCursorPointer) score += 1;
    if (signals.hasTabindex && signals.tabindexValue !== -1) score += 1;
    if (signals.hasAriaExpanded) score += 1;

    // Weak signals (each worth 0.5 points)
    if (signals.classNameHints.length > 0) score += 0.5;

    // Require at least 2 points to consider interactive
    return score >= 2;
  }

  /**
   * Check if a role value indicates an interactive element.
   */
  private isInteractiveRole(role: string | null): boolean {
    if (!role) return false;

    const interactiveRoles = [
      'button', 'link', 'checkbox', 'radio', 'switch', 'tab',
      'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
      'slider', 'spinbutton', 'combobox', 'listbox', 'textbox',
      'searchbox', 'treeitem', 'gridcell',
    ];

    return interactiveRoles.includes(role.toLowerCase());
  }

  /**
   * Classify the type of accessibility gap for a DOM element.
   */
  private classifyGap(
    domElement: DOMElement,
    signals: InteractivitySignals,
    accessibilityTree: PageElementGraph,
    bridgeMap: Map<number, string>
  ): AccessibilityGap | null {
    // Check if element exists in accessibility tree
    const axElementId = bridgeMap.get(domElement.backendNodeId);

    if (!axElementId) {
      // Element is not in the accessibility tree at all
      return this.createGap(
        domElement,
        signals,
        'missing_from_a11y_tree',
        `${domElement.nodeName} element with interactivity signals is not exposed in the accessibility tree`
      );
    }

    // Element exists in accessibility tree - check for other issues
    const axElement = accessibilityTree.elements.get(axElementId);
    if (!axElement) return null;

    // Check for missing accessible name
    if (!axElement.name || axElement.name.trim() === '') {
      if (signals.hasClickHandler || signals.isSemanticInteractive) {
        return this.createGap(
          domElement,
          signals,
          'no_accessible_name',
          `Interactive ${domElement.nodeName} element has no accessible name`
        );
      }
    }

    // Check for wrong/generic role
    if (axElement.role === 'generic' || axElement.role === 'group') {
      if (signals.hasClickHandler || this.isInteractiveRole(signals.roleValue)) {
        return this.createGap(
          domElement,
          signals,
          'wrong_role',
          `${domElement.nodeName} element has click handlers but generic role "${axElement.role}"`
        );
      }
    }

    // Check for not focusable - element has click handlers or cursor:pointer
    // but is not keyboard accessible (not semantic interactive AND no positive tabindex)
    const isKeyboardAccessible = signals.isSemanticInteractive ||
      (signals.hasTabindex && signals.tabindexValue !== null && signals.tabindexValue >= 0);

    if (!isKeyboardAccessible && (signals.hasClickHandler || signals.hasCursorPointer)) {
      // Element appears interactive but can't be reached via keyboard
      const reason = signals.tabindexValue === -1
        ? 'tabindex="-1" makes it unfocusable'
        : 'has no tabindex and is not a native interactive element';
      return this.createGap(
        domElement,
        signals,
        'not_focusable',
        `${domElement.nodeName} element has ${signals.hasClickHandler ? 'click handlers' : 'cursor:pointer'} but ${reason}`
      );
    }

    // Check for hidden but interactive
    if (domElement.attributes['aria-hidden'] === 'true' && signals.hasClickHandler) {
      return this.createGap(
        domElement,
        signals,
        'hidden_but_interactive',
        `${domElement.nodeName} element has aria-hidden="true" but also has click handlers`
      );
    }

    return null;
  }

  /**
   * Create an AccessibilityGap object with all metadata.
   */
  private createGap(
    domElement: DOMElement,
    signals: InteractivitySignals,
    gapType: AccessibilityGapType,
    evidence: string
  ): AccessibilityGap {
    return {
      domElement,
      signals,
      gapType,
      severity: GAP_SEVERITY_MAPPING[gapType],
      wcagViolations: GAP_WCAG_MAPPING[gapType],
      suggestedFix: GAP_FIX_SUGGESTIONS[gapType],
      evidence,
    };
  }

  /**
   * Get a human-readable description of an element for task generation.
   */
  getElementDescription(domElement: DOMElement): string {
    const parts: string[] = [];

    // Tag name
    parts.push(`<${domElement.localName}>`);

    // ID if present
    if (domElement.attributes['id']) {
      parts.push(`with id="${domElement.attributes['id']}"`);
    }

    // Class if present (abbreviated)
    if (domElement.attributes['class']) {
      const classes = domElement.attributes['class'].split(' ').slice(0, 3).join(' ');
      parts.push(`class="${classes}"`);
    }

    // Text content hint from aria-label or title
    if (domElement.attributes['aria-label']) {
      parts.push(`labeled "${domElement.attributes['aria-label']}"`);
    } else if (domElement.attributes['title']) {
      parts.push(`titled "${domElement.attributes['title']}"`);
    }

    return parts.join(' ');
  }

  /**
   * Calculate aggregate statistics for a list of gaps.
   */
  calculateGapStatistics(gaps: AccessibilityGap[]): {
    total: number;
    byType: Record<AccessibilityGapType, number>;
    bySeverity: Record<string, number>;
    wcagCriteria: string[];
  } {
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const wcagSet = new Set<string>();

    for (const gap of gaps) {
      // Count by type
      byType[gap.gapType] = (byType[gap.gapType] || 0) + 1;

      // Count by severity
      bySeverity[gap.severity] = (bySeverity[gap.severity] || 0) + 1;

      // Collect WCAG criteria
      for (const criterion of gap.wcagViolations) {
        wcagSet.add(criterion);
      }
    }

    return {
      total: gaps.length,
      byType: byType as Record<AccessibilityGapType, number>,
      bySeverity,
      wcagCriteria: Array.from(wcagSet),
    };
  }
}
