/**
 * Gap Task Generator - Generates tasks specifically targeting accessibility gaps.
 *
 * Gap tasks are designed to verify that:
 * 1. Inaccessible elements are actually problematic for screen reader users
 * 2. The agent can locate and attempt to interact with these elements
 * 3. Proper remediation guidance is provided
 */

import {
  AccessibilityGap,
  AccessibilityGapType,
  AccessibilityTask,
  DualCrawlResult,
  TaskStep,
} from './types';
import { GapDetector } from './gap-detector';

// ==================== Task Templates ====================

interface GapTaskTemplate {
  generateGoal: (gap: AccessibilityGap, elementDesc: string) => string;
  generateSteps: (gap: AccessibilityGap, elementDesc: string) => TaskStep[];
  priority: number;
}

const GAP_TASK_TEMPLATES: Record<AccessibilityGapType, GapTaskTemplate> = {
  missing_from_a11y_tree: {
    generateGoal: (gap, elementDesc) => [
      `1. Navigate to ${gap.domElement.pageUrl}.`,
      `2. Locate the element: ${elementDesc}.`,
      `3. Attempt to interact with this element using keyboard only (Tab to focus, Enter/Space to activate).`,
      `4. Observe what the screen reader announces when attempting to reach this element.`,
      `5. Report: (a) whether the element could be focused with keyboard, (b) what the screen reader announced, (c) whether the element's action was triggered.`,
    ].join(' '),
    generateSteps: (gap, elementDesc) => [
      { stepNumber: 1, action: 'navigate_click', target: gap.domElement.pageUrl },
      { stepNumber: 2, action: 'navigate', target: elementDesc, key: 'Tab' },
      { stepNumber: 3, action: 'activate', target: elementDesc },
      { stepNumber: 4, action: 'report', expectedOutcome: 'Keyboard accessibility and screen reader announcement' },
    ],
    priority: 10,
  },

  no_accessible_name: {
    generateGoal: (gap, elementDesc) => [
      `1. Navigate to ${gap.domElement.pageUrl}.`,
      `2. Use keyboard navigation to locate: ${elementDesc}.`,
      `3. When focused, listen to what the screen reader announces.`,
      `4. Report: (a) whether the element was announced, (b) if so, what was announced, (c) whether the announcement conveyed the element's purpose.`,
    ].join(' '),
    generateSteps: (gap, elementDesc) => [
      { stepNumber: 1, action: 'navigate_click', target: gap.domElement.pageUrl },
      { stepNumber: 2, action: 'navigate', target: elementDesc, key: 'Tab' },
      { stepNumber: 3, action: 'report', expectedOutcome: 'Screen reader announcement and clarity' },
    ],
    priority: 8,
  },

  wrong_role: {
    generateGoal: (gap, elementDesc) => [
      `1. Navigate to ${gap.domElement.pageUrl}.`,
      `2. Use screen reader quick navigation to find buttons (B key) or other interactive elements.`,
      `3. Check if the element ${elementDesc} appears in quick navigation.`,
      `4. Tab to the element and listen to the role announced.`,
      `5. Report: (a) whether the element appeared in quick navigation, (b) what role was announced, (c) whether the role matched the element's visual appearance.`,
    ].join(' '),
    generateSteps: (gap, elementDesc) => [
      { stepNumber: 1, action: 'navigate_click', target: gap.domElement.pageUrl },
      { stepNumber: 2, action: 'traverse', key: 'b' },
      { stepNumber: 3, action: 'navigate', target: elementDesc, key: 'Tab' },
      { stepNumber: 4, action: 'report', expectedOutcome: 'Role announcement accuracy' },
    ],
    priority: 7,
  },

  not_focusable: {
    generateGoal: (gap, elementDesc) => [
      `1. Navigate to ${gap.domElement.pageUrl}.`,
      `2. Tab through all focusable elements on the page.`,
      `3. Attempt to reach the element: ${elementDesc}.`,
      `4. If unreachable via Tab, try using arrow keys or other navigation methods.`,
      `5. Report: (a) whether the element could be reached via keyboard, (b) if not, which elements were focusable nearby, (c) whether there's a keyboard alternative.`,
    ].join(' '),
    generateSteps: (gap, elementDesc) => [
      { stepNumber: 1, action: 'navigate_click', target: gap.domElement.pageUrl },
      { stepNumber: 2, action: 'traverse', key: 'Tab' },
      { stepNumber: 3, action: 'navigate', target: elementDesc },
      { stepNumber: 4, action: 'report', expectedOutcome: 'Keyboard reachability' },
    ],
    priority: 10,
  },

  hidden_but_interactive: {
    generateGoal: (gap, elementDesc) => [
      `1. Navigate to ${gap.domElement.pageUrl}.`,
      `2. Tab through the page to find focusable elements.`,
      `3. Check if the element ${elementDesc} can be focused despite being marked as hidden.`,
      `4. If found, try to activate it and observe the result.`,
      `5. Report: (a) whether the hidden element was focusable, (b) if activated what happened, (c) whether this creates a confusing experience.`,
    ].join(' '),
    generateSteps: (gap, elementDesc) => [
      { stepNumber: 1, action: 'navigate_click', target: gap.domElement.pageUrl },
      { stepNumber: 2, action: 'traverse', key: 'Tab' },
      { stepNumber: 3, action: 'navigate', target: elementDesc },
      { stepNumber: 4, action: 'activate', target: elementDesc },
      { stepNumber: 5, action: 'report', expectedOutcome: 'Hidden element interaction' },
    ],
    priority: 6,
  },
};

// ==================== Gap Task Generator Class ====================

export class GapTaskGenerator {
  private gapDetector: GapDetector;
  private taskIdCounter: number = 0;

  constructor() {
    this.gapDetector = new GapDetector();
  }

  /**
   * Generate tasks for all detected accessibility gaps.
   */
  generateGapTasks(dualCrawlResult: DualCrawlResult): AccessibilityTask[] {
    const tasks: AccessibilityTask[] = [];

    // Group gaps by type for more efficient task generation
    const gapsByType = this.groupGapsByType(dualCrawlResult.gaps);

    // Generate individual tasks for critical gaps
    for (const gap of dualCrawlResult.gaps) {
      if (gap.severity === 'critical' || gap.severity === 'serious') {
        const task = this.generateSingleGapTask(gap);
        tasks.push(task);
      }
    }

    // Generate grouped tasks for moderate/minor gaps
    for (const [gapType, gaps] of gapsByType) {
      const moderateGaps = gaps.filter(g => g.severity === 'moderate' || g.severity === 'minor');
      if (moderateGaps.length > 0) {
        const groupedTask = this.generateGroupedGapTask(moderateGaps, gapType);
        tasks.push(groupedTask);
      }
    }

    return this.prioritizeTasks(tasks);
  }

  /**
   * Generate a task for a single accessibility gap.
   */
  private generateSingleGapTask(gap: AccessibilityGap): AccessibilityTask {
    const template = GAP_TASK_TEMPLATES[gap.gapType];
    const elementDesc = this.gapDetector.getElementDescription(gap.domElement);

    const task: AccessibilityTask = {
      id: `gap-${++this.taskIdCounter}-${gap.gapType}`,
      type: 'gap',
      url: gap.domElement.pageUrl,
      goal: template.generateGoal(gap, elementDesc),
      steps: template.generateSteps(gap, elementDesc),
      targetElements: [],
      requiredActions: ['Tab', 'Enter', 'Space'],
      expectedCoverage: 1,
      wcagCriteria: gap.wcagViolations,
      elementTypes: [gap.domElement.localName],
      priority: template.priority,
      dependencies: [],
      attempts: 0,
    };

    return task;
  }

  /**
   * Generate a task that covers multiple gaps of the same type.
   */
  private generateGroupedGapTask(gaps: AccessibilityGap[], gapType: AccessibilityGapType): AccessibilityTask {
    const template = GAP_TASK_TEMPLATES[gapType];
    const pageUrl = gaps[0].domElement.pageUrl;

    // List the elements to check
    const elementDescs = gaps.slice(0, 5).map(g => this.gapDetector.getElementDescription(g.domElement));
    const elementList = elementDescs.map((desc, i) => `${i + 1}. ${desc}`).join('; ');

    const goal = [
      `1. Navigate to ${pageUrl}.`,
      `2. Check the following elements for accessibility issues:`,
      `   ${elementList}`,
      `3. For each element, attempt keyboard interaction and observe screen reader announcements.`,
      `4. Report: which elements had issues and what the specific problems were.`,
    ].join(' ');

    const task: AccessibilityTask = {
      id: `gap-grouped-${++this.taskIdCounter}-${gapType}`,
      type: 'gap',
      url: pageUrl,
      goal,
      steps: [
        { stepNumber: 1, action: 'navigate_click', target: pageUrl },
        { stepNumber: 2, action: 'traverse', key: 'Tab' },
        { stepNumber: 3, action: 'report', expectedOutcome: 'Accessibility issues found' },
      ],
      targetElements: [],
      requiredActions: ['Tab', 'Enter', 'Space'],
      expectedCoverage: gaps.length,
      wcagCriteria: Array.from(new Set(gaps.flatMap(g => g.wcagViolations))),
      elementTypes: Array.from(new Set(gaps.map(g => g.domElement.localName))),
      priority: Math.max(...gaps.map(g => GAP_TASK_TEMPLATES[g.gapType].priority)) - 2,
      dependencies: [],
      attempts: 0,
    };

    return task;
  }

  /**
   * Group gaps by their type.
   */
  private groupGapsByType(gaps: AccessibilityGap[]): Map<AccessibilityGapType, AccessibilityGap[]> {
    const grouped = new Map<AccessibilityGapType, AccessibilityGap[]>();

    for (const gap of gaps) {
      const existing = grouped.get(gap.gapType) || [];
      existing.push(gap);
      grouped.set(gap.gapType, existing);
    }

    return grouped;
  }

  /**
   * Group gaps by page URL.
   */
  groupGapsByPage(gaps: AccessibilityGap[]): Map<string, AccessibilityGap[]> {
    const grouped = new Map<string, AccessibilityGap[]>();

    for (const gap of gaps) {
      const pageUrl = gap.domElement.pageUrl;
      const existing = grouped.get(pageUrl) || [];
      existing.push(gap);
      grouped.set(pageUrl, existing);
    }

    return grouped;
  }

  /**
   * Prioritize tasks by severity and importance.
   */
  private prioritizeTasks(tasks: AccessibilityTask[]): AccessibilityTask[] {
    return tasks.sort((a, b) => {
      // Higher priority first
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      // More WCAG criteria first
      return b.wcagCriteria.length - a.wcagCriteria.length;
    });
  }

  /**
   * Generate a summary task that covers all gaps on a page.
   */
  generatePageSummaryTask(pageUrl: string, gaps: AccessibilityGap[]): AccessibilityTask {
    const stats = this.gapDetector.calculateGapStatistics(gaps);

    const goal = [
      `1. Navigate to ${pageUrl}.`,
      `2. This page has ${stats.total} accessibility gaps detected:`,
      `   - ${stats.byType['missing_from_a11y_tree'] || 0} elements missing from accessibility tree`,
      `   - ${stats.byType['no_accessible_name'] || 0} elements without accessible names`,
      `   - ${stats.byType['wrong_role'] || 0} elements with incorrect roles`,
      `   - ${stats.byType['not_focusable'] || 0} elements not keyboard focusable`,
      `3. Navigate through the page using only keyboard.`,
      `4. Identify which interactive-looking elements cannot be reached or operated.`,
      `5. Report: overall keyboard accessibility of the page and critical issues found.`,
    ].join(' ');

    return {
      id: `gap-summary-${++this.taskIdCounter}`,
      type: 'gap',
      url: pageUrl,
      goal,
      steps: [
        { stepNumber: 1, action: 'navigate_click', target: pageUrl },
        { stepNumber: 2, action: 'traverse', key: 'Tab' },
        { stepNumber: 3, action: 'report', expectedOutcome: 'Overall page accessibility' },
      ],
      targetElements: [],
      requiredActions: ['Tab', 'Enter', 'Space', 'ArrowDown', 'ArrowUp'],
      expectedCoverage: gaps.length,
      wcagCriteria: stats.wcagCriteria,
      elementTypes: Array.from(new Set(gaps.map(g => g.domElement.localName))),
      priority: 5,
      dependencies: [],
      attempts: 0,
    };
  }
}
