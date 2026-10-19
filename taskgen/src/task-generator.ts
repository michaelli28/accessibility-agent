/**
 * Task Generator - Generates journey-based accessibility testing tasks.
 *
 * All tasks are journeys that simulate real user behavior while ensuring
 * comprehensive coverage of the site's accessibility.
 */

import {
  SiteElementGraph,
  PageElementGraph,
  ElementNode,
  AccessibilityTask,
  TraversalPath,
  TaskExecutionResult,
  SimpleTask,
  DualCrawlResult,
} from './types';
import { CoverageAlgorithm } from './coverage';
import {
  JOURNEY_TEMPLATES,
  buildTaskFromTemplate,
  generateTaskId,
  TemplateContext,
} from './templates';
import { GapTaskGenerator } from './gap-task-generator';

// ==================== Task Generator ====================

export class TaskGenerator {
  private coverageAlgo: CoverageAlgorithm;
  private gapTaskGenerator: GapTaskGenerator;

  constructor() {
    this.coverageAlgo = new CoverageAlgorithm();
    this.gapTaskGenerator = new GapTaskGenerator();
  }

  /**
   * Generate all journey tasks for a site graph.
   */
  generateAllTasks(graph: SiteElementGraph, includeJourneys: boolean = true): AccessibilityTask[] {
    const tasks: AccessibilityTask[] = [];

    // 1. Generate page exploration journeys for each page
    const pageJourneys = this.generatePageExplorationJourneys(graph);
    tasks.push(...pageJourneys);

    // 2. Generate feature-specific journeys (login, search, forms, etc.)
    const featureJourneys = this.generateFeatureJourneys(graph);
    tasks.push(...featureJourneys);

    // 3. Generate cross-page navigation journeys
    const navJourneys = this.generateNavigationJourneys(graph);
    tasks.push(...navJourneys);

    // 4. Prioritize and return tasks
    return this.prioritizeTasks(tasks);
  }

  /**
   * Generate page exploration journeys - one comprehensive journey per important page.
   */
  generatePageExplorationJourneys(graph: SiteElementGraph): AccessibilityTask[] {
    const tasks: AccessibilityTask[] = [];
    const pages = Array.from(graph.pages.entries());

    // Sort pages by importance (element count as proxy for content richness)
    pages.sort((a, b) => b[1].elementCount - a[1].elementCount);

    // Generate exploration journey for top pages
    const maxPages = Math.min(pages.length, 10);
    for (let i = 0; i < maxPages; i++) {
      const [pageUrl, page] = pages[i];

      const context: TemplateContext = {
        pageUrl,
        pageTitle: page.title,
        elements: Array.from(page.elements.values()),
        headingCount: page.headings.length,
        landmarkCount: page.landmarks.length,
        linkCount: page.links.length,
        buttonCount: page.buttons.length,
        formFieldCount: page.formFields.length,
        landmarkNames: this.getLandmarkNames(page),
        headingNames: this.getHeadingNames(page),
      };

      // Page structure exploration (covers landmarks, headings, interactive elements)
      tasks.push(
        buildTaskFromTemplate(
          JOURNEY_TEMPLATES.explorePageStructure,
          context,
          [...page.landmarks, ...page.headings.slice(0, 10)],
          9 - i * 0.5 // Higher priority for first pages
        )
      );

      // Content page exploration for pages with lots of content
      if (page.headings.length > 3 && page.links.length > 10) {
        tasks.push(
          buildTaskFromTemplate(
            JOURNEY_TEMPLATES.exploreContentPage,
            context,
            [...page.headings, ...page.links.slice(0, 10)],
            7 - i * 0.3
          )
        );
      }

      // Form interaction for pages with forms
      if (page.formFields.length > 0) {
        context.formName = this.detectFormName(
          page.formFields.map(id => page.elements.get(id)!).filter(Boolean)
        );
        tasks.push(
          buildTaskFromTemplate(
            JOURNEY_TEMPLATES.interactWithForm,
            context,
            page.formFields,
            8
          )
        );
      }
    }

    return tasks;
  }

  /**
   * Generate feature-specific journeys based on detected site features.
   */
  generateFeatureJourneys(graph: SiteElementGraph): AccessibilityTask[] {
    const tasks: AccessibilityTask[] = [];
    const baseUrl = graph.baseUrl;
    const baseContext: TemplateContext = {
      pageUrl: baseUrl,
      pageTitle: '',
      elements: [],
    };

    // Login journey
    if (this.detectFeature(graph, ['login', 'sign in', 'signin', 'log in'])) {
      tasks.push(
        buildTaskFromTemplate(JOURNEY_TEMPLATES.login, baseContext, [], 10)
      );
    }

    // Registration journey
    if (this.detectFeature(graph, ['register', 'sign up', 'signup', 'create account'])) {
      tasks.push(
        buildTaskFromTemplate(JOURNEY_TEMPLATES.registration, baseContext, [], 9)
      );
    }

    // Search journey
    if (this.detectFeature(graph, ['search'])) {
      tasks.push(
        buildTaskFromTemplate(
          JOURNEY_TEMPLATES.search,
          { ...baseContext, searchQuery: 'test' },
          [],
          9
        )
      );
    }

    // Contact form journey
    if (this.detectFeature(graph, ['contact', 'contact us', 'get in touch'])) {
      tasks.push(
        buildTaskFromTemplate(JOURNEY_TEMPLATES.contactForm, baseContext, [], 8)
      );
    }

    // E-commerce journeys
    if (this.detectFeature(graph, ['add to cart', 'buy now', 'shop', 'products', 'cart'])) {
      tasks.push(
        buildTaskFromTemplate(JOURNEY_TEMPLATES.addToCart, baseContext, [], 9)
      );
      tasks.push(
        buildTaskFromTemplate(JOURNEY_TEMPLATES.checkout, baseContext, [], 8)
      );
    }

    // Interactive components journey (if page seems to have complex UI)
    if (this.detectFeature(graph, ['tab', 'accordion', 'modal', 'dropdown', 'menu'])) {
      tasks.push(
        buildTaskFromTemplate(JOURNEY_TEMPLATES.testInteractiveComponents, baseContext, [], 7)
      );
    }

    // Media content journey
    if (this.detectFeature(graph, ['video', 'audio', 'play', 'player', 'watch'])) {
      tasks.push(
        buildTaskFromTemplate(JOURNEY_TEMPLATES.testMediaContent, baseContext, [], 6)
      );
    }

    return tasks;
  }

  /**
   * Generate navigation journeys to test cross-page navigation.
   */
  generateNavigationJourneys(graph: SiteElementGraph): AccessibilityTask[] {
    const tasks: AccessibilityTask[] = [];
    const baseUrl = graph.baseUrl;
    const pages = Array.from(graph.pages.keys());

    // Navigation exploration from homepage
    tasks.push(
      buildTaskFromTemplate(
        JOURNEY_TEMPLATES.exploreNavigation,
        { pageUrl: baseUrl, pageTitle: '', elements: [] },
        [],
        8
      )
    );

    // Footer exploration
    tasks.push(
      buildTaskFromTemplate(
        JOURNEY_TEMPLATES.exploreFooter,
        { pageUrl: baseUrl, pageTitle: '', elements: [] },
        [],
        6
      )
    );

    // Cross-page navigation journeys to important pages
    const targetPages = pages.slice(1, 4); // Top 3 internal pages
    for (const targetUrl of targetPages) {
      tasks.push(
        buildTaskFromTemplate(
          JOURNEY_TEMPLATES.navigateBetweenPages,
          { pageUrl: baseUrl, pageTitle: '', elements: [], targetUrl },
          [],
          5
        )
      );
    }

    return tasks;
  }

  /**
   * Generate adaptive tasks based on execution results.
   */
  generateAdaptiveTasks(
    graph: SiteElementGraph,
    executionResults: TaskExecutionResult[]
  ): AccessibilityTask[] {
    const tasks: AccessibilityTask[] = [];

    // Collect visited elements from all results
    const visitedElements = new Set<string>();
    for (const result of executionResults) {
      for (const elementId of result.visitedElements) {
        visitedElements.add(elementId);
      }
    }

    // Find elements that were targeted but not visited (missed targets)
    const missedElements: ElementNode[] = [];
    for (const result of executionResults) {
      for (const missedId of result.missedTargets) {
        for (const page of graph.pages.values()) {
          const element = page.elements.get(missedId);
          if (element && !visitedElements.has(missedId)) {
            missedElements.push(element);
          }
        }
      }
    }

    // Group missed elements by page
    const missedByPage = new Map<string, ElementNode[]>();
    for (const element of missedElements) {
      const existing = missedByPage.get(element.pageUrl) || [];
      existing.push(element);
      missedByPage.set(element.pageUrl, existing);
    }

    // Generate targeted journeys for missed elements
    for (const [pageUrl, elements] of missedByPage) {
      const elementNames = elements
        .slice(0, 5)
        .map((e) => e.name || e.role)
        .join(', ');

      const task: AccessibilityTask = {
        id: generateTaskId(),
        type: 'journey',
        url: pageUrl,
        goal: [
          `1. Navigate to ${pageUrl}.`,
          `2. Navigate to main content area.`,
          `3. Navigate to and locate these specific elements: ${elementNames}.`,
          `4. For each element, verify its accessible name and keyboard operability.`,
          `5. Report success with: (a) which elements were found, (b) any accessibility issues discovered, (c) any elements that couldn't be reached via keyboard.`,
        ].join(' '),
        steps: [],
        targetElements: elements.map((e) => e.id),
        requiredActions: [],
        expectedCoverage: elements.length,
        wcagCriteria: ['4.1.2', '2.1.1'],
        elementTypes: [...new Set(elements.map((e) => e.role))],
        priority: 10,
        dependencies: [],
        attempts: 0,
      };

      tasks.push(task);
    }

    return tasks;
  }

  /**
   * Prioritize and sort tasks for optimal execution order.
   */
  prioritizeTasks(tasks: AccessibilityTask[]): AccessibilityTask[] {
    return tasks.sort((a, b) => {
      // Higher priority first
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }

      // Then by expected coverage (more coverage first)
      if (b.expectedCoverage !== a.expectedCoverage) {
        return b.expectedCoverage - a.expectedCoverage;
      }

      return 0;
    });
  }

  /**
   * Convert tasks to simple format for agent execution.
   */
  toSimpleTasks(tasks: AccessibilityTask[]): SimpleTask[] {
    return tasks.map((task) => ({
      url: task.url,
      goal: task.goal,
    }));
  }

  /**
   * Get landmark names from a page for context.
   */
  private getLandmarkNames(page: PageElementGraph): string {
    const landmarks = page.landmarks
      .map(id => page.elements.get(id))
      .filter(Boolean)
      .map(el => el!.typeFlags.landmarkRole || 'region');

    return [...new Set(landmarks)].join(', ');
  }

  /**
   * Get heading names from a page for context.
   */
  private getHeadingNames(page: PageElementGraph): string {
    return page.headings
      .slice(0, 5)
      .map(id => page.elements.get(id))
      .filter(Boolean)
      .map(el => `h${el!.typeFlags.headingLevel}: ${el!.name || 'unnamed'}`)
      .join(', ');
  }

  /**
   * Detect form name from form elements.
   */
  private detectFormName(elements: ElementNode[]): string {
    for (const element of elements) {
      const name = element.name?.toLowerCase() || '';
      if (name.includes('login') || name.includes('sign in')) return 'login form';
      if (name.includes('register') || name.includes('sign up')) return 'registration form';
      if (name.includes('search')) return 'search form';
      if (name.includes('contact')) return 'contact form';
      if (name.includes('checkout')) return 'checkout form';
      if (name.includes('payment')) return 'payment form';
      if (name.includes('subscribe')) return 'subscription form';
      if (name.includes('newsletter')) return 'newsletter form';
    }
    return 'the form';
  }

  /**
   * Detect if a site has a specific feature based on element names.
   */
  private detectFeature(graph: SiteElementGraph, keywords: string[]): boolean {
    for (const page of graph.pages.values()) {
      for (const element of page.elements.values()) {
        const name = element.name?.toLowerCase() || '';
        const role = element.role?.toLowerCase() || '';
        for (const keyword of keywords) {
          if (name.includes(keyword.toLowerCase()) || role.includes(keyword.toLowerCase())) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // ==================== Gap Task Generation ====================

  /**
   * Generate tasks for accessibility gaps detected by dual crawl.
   */
  generateGapTasks(dualCrawlResult: DualCrawlResult): AccessibilityTask[] {
    return this.gapTaskGenerator.generateGapTasks(dualCrawlResult);
  }

  /**
   * Generate all tasks including gap detection tasks.
   * This combines regular journey tasks with gap-focused tasks.
   */
  generateAllTasksWithGaps(
    graph: SiteElementGraph,
    dualCrawlResults: Map<string, DualCrawlResult>,
    includeJourneys: boolean = true
  ): AccessibilityTask[] {
    // Generate regular journey tasks
    const journeyTasks = this.generateAllTasks(graph, includeJourneys);

    // Generate gap tasks for each page
    const gapTasks: AccessibilityTask[] = [];
    for (const [pageUrl, dualResult] of dualCrawlResults) {
      if (dualResult.gaps.length > 0) {
        const pageTasks = this.generateGapTasks(dualResult);
        gapTasks.push(...pageTasks);
      }
    }

    // Combine and prioritize: gap tasks get higher base priority
    const allTasks = [...gapTasks, ...journeyTasks];
    return this.prioritizeTasks(allTasks);
  }

  /**
   * Generate a page summary task for all gaps on a page.
   */
  generatePageGapSummaryTask(
    pageUrl: string,
    dualCrawlResult: DualCrawlResult
  ): AccessibilityTask | null {
    if (dualCrawlResult.gaps.length === 0) {
      return null;
    }

    return this.gapTaskGenerator.generatePageSummaryTask(pageUrl, dualCrawlResult.gaps);
  }
}
