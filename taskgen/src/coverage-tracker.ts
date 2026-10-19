/**
 * Coverage Tracker - Tracks element coverage during agent execution.
 *
 * This module:
 * 1. Processes agent traces to extract visited elements
 * 2. Matches screen reader observations to element graph nodes
 * 3. Computes coverage metrics
 * 4. Identifies gaps for adaptive task generation
 */

import {
  SiteElementGraph,
  PageElementGraph,
  ElementNode,
  CoverageMetrics,
  TypeCoverage,
  TaskExecutionResult,
  Violation,
  AccessibilityTask,
} from './types';

// ==================== Agent Trace Types ====================

/**
 * Agent trace from execution (matches agent/src/types.ts).
 */
export interface AgentTrace {
  goal: string;
  success: boolean;
  steps: AgentStep[];
  error?: string;
  reason?: string;
}

export interface AgentStep {
  stepNumber: number;
  observation: PerceptualSnapshot;
  thought: string;
  action: UserAction;
  result: ActionResult;
}

export interface PerceptualSnapshot {
  text: string;
  cursorBox?: { x: number; y: number; width: number; height: number } | null;
  pageTitle?: string;
  pageUrl?: string;
}

export interface UserAction {
  type: 'KEY_PRESS' | 'CLICK' | 'TYPE';
  key?: string;
  text?: string;
}

export interface ActionResult {
  success: boolean;
  message?: string;
  snapshot: PerceptualSnapshot;
}

// ==================== Coverage Tracker ====================

export class CoverageTracker {
  private graph: SiteElementGraph;
  private visitedElements: Set<string>;
  private taskResults: Map<string, TaskExecutionResult>;
  private elementViolations: Map<string, Violation[]>;

  constructor(graph: SiteElementGraph) {
    this.graph = graph;
    this.visitedElements = new Set();
    this.taskResults = new Map();
    this.elementViolations = new Map();
  }

  /**
   * Process agent trace to update coverage.
   */
  processAgentTrace(taskId: string, trace: AgentTrace, task: AccessibilityTask): TaskExecutionResult {
    // Extract visited elements from trace
    const visitedInTrace = this.matchObservationsToElements(trace);

    // Mark elements as visited
    for (const elementId of visitedInTrace) {
      this.visitedElements.add(elementId);

      // Update element in graph
      for (const page of this.graph.pages.values()) {
        const element = page.elements.get(elementId);
        if (element) {
          element.visited = true;
          element.visitedBy.push(taskId);
        }
      }
    }

    // Determine missed targets
    const missedTargets = task.targetElements.filter(
      (elementId) => !visitedInTrace.includes(elementId)
    );

    // Extract step results
    const stepResults = trace.steps.map((step, index) => ({
      stepNumber: step.stepNumber,
      completed: step.result.success,
      observation: step.observation.text,
    }));

    // Create execution result
    const result: TaskExecutionResult = {
      taskId,
      success: trace.success,
      visitedElements: visitedInTrace,
      newViolations: [], // Populated by external evaluator
      missedTargets,
      stepResults,
      executedAt: new Date(),
      durationMs: 0, // Would need timing from external source
    };

    this.taskResults.set(taskId, result);

    return result;
  }

  /**
   * Add violations discovered during execution.
   */
  addViolations(violations: Violation[]): void {
    for (const violation of violations) {
      if (violation.elementId) {
        const existing = this.elementViolations.get(violation.elementId) || [];
        existing.push(violation);
        this.elementViolations.set(violation.elementId, existing);

        // Update element in graph
        for (const page of this.graph.pages.values()) {
          const element = page.elements.get(violation.elementId);
          if (element) {
            element.wcagEvaluated = true;
            if (!element.violations.includes(violation.ruleId)) {
              element.violations.push(violation.ruleId);
            }
          }
        }
      }
    }
  }

  /**
   * Extract visited elements from trace observations.
   * Matches screen reader output to element graph nodes.
   */
  private matchObservationsToElements(trace: AgentTrace): string[] {
    const visited: string[] = [];
    const seenNames = new Set<string>();

    for (const step of trace.steps) {
      const observationText = step.observation.text;
      const pageUrl = step.observation.pageUrl || '';

      // Find matching elements based on observation text
      const matches = this.findMatchingElements(observationText, pageUrl);

      for (const elementId of matches) {
        if (!seenNames.has(elementId)) {
          seenNames.add(elementId);
          visited.push(elementId);
        }
      }
    }

    return visited;
  }

  /**
   * Find elements that match the observation text.
   */
  private findMatchingElements(observationText: string, pageUrl: string): string[] {
    const matches: string[] = [];
    const lowerObs = observationText.toLowerCase();

    // Try to find page by URL
    let targetPages: PageElementGraph[] = [];
    if (pageUrl) {
      const page = this.graph.pages.get(pageUrl);
      if (page) {
        targetPages = [page];
      }
    }

    // Fall back to all pages
    if (targetPages.length === 0) {
      targetPages = Array.from(this.graph.pages.values());
    }

    for (const page of targetPages) {
      for (const element of page.elements.values()) {
        // Check if element name appears in observation
        if (element.name && lowerObs.includes(element.name.toLowerCase())) {
          matches.push(element.id);
          continue;
        }

        // Check if role + partial name appears
        if (element.role && lowerObs.includes(element.role.toLowerCase())) {
          // More fuzzy matching for roles
          const rolePatterns = this.getRolePatterns(element.role);
          for (const pattern of rolePatterns) {
            if (lowerObs.includes(pattern)) {
              matches.push(element.id);
              break;
            }
          }
        }

        // Check heading level
        if (element.typeFlags.headingLevel) {
          const headingPattern = `heading level ${element.typeFlags.headingLevel}`;
          if (lowerObs.includes(headingPattern)) {
            if (element.name && lowerObs.includes(element.name.toLowerCase())) {
              matches.push(element.id);
            }
          }
        }

        // Check landmark role
        if (element.typeFlags.landmarkRole) {
          const landmarkPattern = `${element.typeFlags.landmarkRole} landmark`;
          if (lowerObs.includes(landmarkPattern) || lowerObs.includes(element.typeFlags.landmarkRole)) {
            matches.push(element.id);
          }
        }
      }
    }

    return [...new Set(matches)]; // Deduplicate
  }

  /**
   * Get common patterns for a role in screen reader output.
   */
  private getRolePatterns(role: string): string[] {
    const patterns: Record<string, string[]> = {
      button: ['button', 'btn'],
      link: ['link', 'clickable'],
      textbox: ['textbox', 'edit', 'text field', 'input'],
      checkbox: ['checkbox', 'check box'],
      radio: ['radio', 'radio button'],
      combobox: ['combo box', 'combobox', 'dropdown', 'select'],
      heading: ['heading'],
      list: ['list'],
      listitem: ['list item', 'bullet'],
      table: ['table'],
      row: ['row'],
      cell: ['cell'],
      navigation: ['navigation', 'nav'],
      main: ['main'],
      banner: ['banner', 'header'],
      contentinfo: ['contentinfo', 'footer'],
      form: ['form'],
      search: ['search'],
    };

    return patterns[role] || [role];
  }

  /**
   * Get current coverage metrics.
   */
  getCoverageMetrics(): CoverageMetrics {
    const totalElements = this.graph.totalElements;
    const coveredElements = this.visitedElements.size;

    // Compute per-type coverage
    const elementsByType = new Map<string, TypeCoverage>();
    const typeCategories = ['heading', 'landmark', 'button', 'formField', 'link', 'table', 'list'];

    for (const category of typeCategories) {
      elementsByType.set(category, {
        total: 0,
        covered: 0,
        percent: 0,
        uncoveredIds: [],
      });
    }

    // Count elements by type
    for (const page of this.graph.pages.values()) {
      for (const element of page.elements.values()) {
        const types = this.getElementTypes(element);

        for (const type of types) {
          const metrics = elementsByType.get(type);
          if (metrics) {
            metrics.total++;
            if (this.visitedElements.has(element.id)) {
              metrics.covered++;
            } else {
              metrics.uncoveredIds.push(element.id);
            }
          }
        }
      }
    }

    // Calculate percentages
    for (const metrics of elementsByType.values()) {
      metrics.percent = metrics.total > 0 ? (metrics.covered / metrics.total) * 100 : 100;
    }

    // Find uncovered critical (interactive) elements
    const uncoveredCritical: string[] = [];
    for (const page of this.graph.pages.values()) {
      for (const element of page.elements.values()) {
        if (element.typeFlags.isInteractive && !this.visitedElements.has(element.id)) {
          uncoveredCritical.push(element.id);
        }
      }
    }

    // Collect WCAG criteria checked
    const wcagCriteriaChecked = new Set<string>();
    for (const result of this.taskResults.values()) {
      for (const violation of result.newViolations) {
        wcagCriteriaChecked.add(violation.ruleId);
      }
    }

    return {
      totalElements,
      coveredElements,
      coveragePercent: totalElements > 0 ? (coveredElements / totalElements) * 100 : 100,
      elementsByType,
      uncoveredCritical,
      wcagCriteriaChecked: Array.from(wcagCriteriaChecked),
    };
  }

  /**
   * Get element type categories.
   */
  private getElementTypes(element: ElementNode): string[] {
    const types: string[] = [];

    if (element.typeFlags.headingLevel) types.push('heading');
    if (element.typeFlags.isLandmark) types.push('landmark');
    if (element.typeFlags.isButton) types.push('button');
    if (element.typeFlags.isFormField) types.push('formField');
    if (element.typeFlags.isLink) types.push('link');
    if (element.typeFlags.isTable) types.push('table');
    if (element.typeFlags.isList) types.push('list');

    return types;
  }

  /**
   * Get list of uncovered elements that need tasks.
   */
  getUncoveredElements(): ElementNode[] {
    const uncovered: ElementNode[] = [];

    for (const page of this.graph.pages.values()) {
      for (const element of page.elements.values()) {
        if (!this.visitedElements.has(element.id)) {
          uncovered.push(element);
        }
      }
    }

    return uncovered;
  }

  /**
   * Get uncovered interactive elements (priority).
   */
  getUncoveredInteractiveElements(): ElementNode[] {
    return this.getUncoveredElements().filter((e) => e.typeFlags.isInteractive);
  }

  /**
   * Get elements that have violations.
   */
  getViolationElements(): Map<string, Violation[]> {
    return this.elementViolations;
  }

  /**
   * Get all violations.
   */
  getAllViolations(): Violation[] {
    const violations: Violation[] = [];
    for (const v of this.elementViolations.values()) {
      violations.push(...v);
    }
    return violations;
  }

  /**
   * Check if we've achieved target coverage threshold.
   */
  hasAchievedCoverage(threshold: number): boolean {
    const metrics = this.getCoverageMetrics();
    return metrics.coveragePercent >= threshold;
  }

  /**
   * Get visited element IDs.
   */
  getVisitedElementIds(): Set<string> {
    return new Set(this.visitedElements);
  }

  /**
   * Get task results.
   */
  getTaskResults(): Map<string, TaskExecutionResult> {
    return this.taskResults;
  }

  /**
   * Reset coverage tracking (for re-testing).
   */
  reset(): void {
    this.visitedElements.clear();
    this.taskResults.clear();
    this.elementViolations.clear();

    // Reset elements in graph
    for (const page of this.graph.pages.values()) {
      for (const element of page.elements.values()) {
        element.visited = false;
        element.visitedBy = [];
        element.wcagEvaluated = false;
        element.violations = [];
      }
    }
  }
}
