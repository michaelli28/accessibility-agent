/**
 * Element Crawler - Extends pagefinder to discover elements on each page.
 *
 * This module:
 * 1. Uses pagefinder (via subprocess) to discover all pages
 * 2. For each page, extracts the accessibility tree via CDP
 * 3. Discovers navigation edges by analyzing element relationships
 * 4. Builds a complete SiteElementGraph
 */

import { chromium, Browser, Page, CDPSession } from 'playwright';
import { spawn } from 'child_process';
import * as path from 'path';
import {
  ElementNode,
  ElementTypeFlags,
  NavigationEdge,
  NavigationKey,
  PageElementGraph,
  SiteElementGraph,
  OutboundLink,
  PageTransition,
  DualCrawlResult,
  DOMElement,
  InteractivitySignals,
} from './types';
import { DOMCrawler } from './dom-crawler';
import { GapDetector } from './gap-detector';

// ==================== CDP Types ====================

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  value?: { value: string };
  properties?: Array<{ name: string; value: { value: any } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

// ==================== Pagefinder Bridge ====================

interface PagefinderResult {
  pages: string[];
  pagerank: Map<string, number>;
  titles: Map<string, string>;
  snippets: Map<string, string>;
}

/**
 * Call pagefinder to discover all pages on a site.
 * Falls back to Playwright-based discovery if pagefinder is unavailable.
 */
async function runPagefinder(entryUrl: string, maxDepth: number = 2): Promise<PagefinderResult> {
  return new Promise((resolve) => {
    const pagefinderPath = path.resolve(__dirname, '../../pagefinder');

    // Try python3 first, then python
    const pythonCommands = ['python3', 'python'];
    let currentIndex = 0;

    const tryPython = (pythonCmd: string) => {
      const proc = spawn(pythonCmd, ['-m', 'pagefinder.main', entryUrl, '--max-depth', String(maxDepth)], {
        cwd: pagefinderPath,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          currentIndex++;
          if (currentIndex < pythonCommands.length) {
            // Try next python command
            tryPython(pythonCommands[currentIndex]);
          } else {
            // No python available, fall back to entry URL only
            console.warn('[ElementCrawler] Python not found, using Playwright-only discovery');
            resolve({
              pages: [entryUrl],
              pagerank: new Map([[entryUrl, 1.0]]),
              titles: new Map(),
              snippets: new Map(),
            });
          }
        } else {
          console.warn(`[ElementCrawler] Pagefinder error: ${err.message}`);
          resolve({
            pages: [entryUrl],
            pagerank: new Map([[entryUrl, 1.0]]),
            titles: new Map(),
            snippets: new Map(),
          });
        }
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          // If pagefinder fails, fall back to just the entry URL
          console.warn(`[ElementCrawler] Pagefinder exited with code ${code}`);
          resolve({
            pages: [entryUrl],
            pagerank: new Map([[entryUrl, 1.0]]),
            titles: new Map(),
            snippets: new Map(),
          });
          return;
        }

        // Parse pagefinder output
        const urlPattern = /\[crawl\].*url=(\S+)/g;
        const pages: string[] = [entryUrl];
        let match;
        while ((match = urlPattern.exec(stdout)) !== null) {
          if (!pages.includes(match[1])) {
            pages.push(match[1]);
          }
        }

        resolve({
          pages,
          pagerank: new Map(pages.map((url, i) => [url, 1.0 / (i + 1)])),
          titles: new Map(),
          snippets: new Map(),
        });
      });
    };

    tryPython(pythonCommands[currentIndex]);
  });
}

// ==================== Element Crawler ====================

export class ElementCrawler {
  private browser: Browser | null = null;
  private headless: boolean;
  private maxPages: number;
  private maxDepth: number;

  constructor(options: { headless?: boolean; maxPages?: number; maxDepth?: number } = {}) {
    this.headless = options.headless ?? true;
    this.maxPages = options.maxPages ?? 50;
    this.maxDepth = options.maxDepth ?? 2;
  }

  /**
   * Initialize the browser.
   */
  async init(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.headless });
    }
  }

  /**
   * Clean up browser resources.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Crawl a website and build element-level graphs for all pages.
   */
  async crawlSite(entryUrl: string): Promise<SiteElementGraph> {
    await this.init();

    // Step 1: Discover pages using pagefinder or Playwright fallback
    console.log(`[ElementCrawler] Discovering pages from ${entryUrl}...`);
    let pagefinderResult = await runPagefinder(entryUrl, this.maxDepth);

    // If pagefinder only returned entry URL, use Playwright to discover more pages
    if (pagefinderResult.pages.length <= 1) {
      console.log(`[ElementCrawler] Using Playwright to discover additional pages...`);
      pagefinderResult = await this.discoverPagesWithPlaywright(entryUrl);
    }

    const pageUrls = pagefinderResult.pages.slice(0, this.maxPages);
    console.log(`[ElementCrawler] Found ${pageUrls.length} pages`);

    // Step 2: Crawl each page for elements
    const pages = new Map<string, PageElementGraph>();
    const pageTransitions: PageTransition[] = [];

    for (const url of pageUrls) {
      try {
        console.log(`[ElementCrawler] Crawling elements on ${url}...`);
        const pageGraph = await this.crawlPage(url);
        pages.set(url, pageGraph);

        // Collect page transitions
        for (const link of pageGraph.outboundLinks) {
          if (pageUrls.includes(link.targetUrl)) {
            pageTransitions.push({
              fromPage: url,
              fromElement: link.elementId,
              toPage: link.targetUrl,
              action: 'click',
            });
          }
        }
      } catch (error) {
        console.error(`[ElementCrawler] Error crawling ${url}:`, error);
      }
    }

    // Step 3: Compute totals
    let totalElements = 0;
    let interactiveElements = 0;
    let landmarkElements = 0;

    for (const page of pages.values()) {
      totalElements += page.elementCount;
      interactiveElements += page.interactiveCount;
      landmarkElements += page.landmarks.length;
    }

    const siteGraph: SiteElementGraph = {
      baseUrl: entryUrl,
      pages,
      pageTransitions,
      totalElements,
      interactiveElements,
      landmarkElements,
      spanningForest: [], // Computed later by CoverageAlgorithm
      crawledAt: new Date(),
      pageCount: pages.size,
    };

    return siteGraph;
  }

  /**
   * Discover pages using Playwright (fallback when pagefinder unavailable).
   */
  private async discoverPagesWithPlaywright(entryUrl: string): Promise<PagefinderResult> {
    await this.init();

    const discovered: string[] = [entryUrl];
    const visited = new Set<string>();
    const baseHost = new URL(entryUrl).host;

    const context = await this.browser!.newContext();
    const page = await context.newPage();

    try {
      // Visit entry page and extract links
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);

      const links = await page.$$eval('a[href]', (anchors, baseHostArg) => {
        const urls: string[] = [];
        const normalizedBase = (baseHostArg as string).replace(/^www\./, '');

        for (const anchor of anchors) {
          try {
            const href = (anchor as HTMLAnchorElement).href;
            if (!href) continue;

            const url = new URL(href);
            const normalizedUrlHost = url.host.replace(/^www\./, '');

            // Same domain (including subdomains) and http/https
            const isSameDomain = normalizedUrlHost === normalizedBase ||
                                 normalizedUrlHost.endsWith('.' + normalizedBase);

            if (isSameDomain && (url.protocol === 'http:' || url.protocol === 'https:')) {
              url.hash = '';
              const cleanUrl = url.href.replace(/\/$/, '');
              if (urls.indexOf(cleanUrl) === -1) {
                urls.push(cleanUrl);
              }
            }
          } catch {
            // Invalid URL, skip
          }
        }

        return urls;
      }, baseHost);

      // Add discovered links (limit to prevent explosion)
      for (const link of links.slice(0, 50)) {
        if (!discovered.includes(link)) {
          discovered.push(link);
        }
      }

      console.log(`[ElementCrawler] Playwright discovered ${discovered.length} pages`);
    } catch (error) {
      console.warn(`[ElementCrawler] Playwright discovery error:`, error);
    } finally {
      await context.close();
    }

    return {
      pages: discovered,
      pagerank: new Map(discovered.map((url, i) => [url, 1.0 / (i + 1)])),
      titles: new Map(),
      snippets: new Map(),
    };
  }

  /**
   * Crawl a single page and extract its accessibility tree.
   */
  async crawlPage(url: string): Promise<PageElementGraph> {
    await this.init();

    const context = await this.browser!.newContext();
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000); // Allow dynamic content to load

      // Get accessibility tree via CDP
      const axNodes = await this.getAccessibilityTree(page);

      // Convert to our element graph format
      const pageGraph = this.convertToElementGraph(axNodes, url, await page.title());

      // Discover navigation edges
      await this.discoverNavigationEdges(page, pageGraph);

      return pageGraph;
    } finally {
      await context.close();
    }
  }

  /**
   * Use CDP to get the full accessibility tree.
   */
  private async getAccessibilityTree(page: Page): Promise<AXNode[]> {
    const client: CDPSession = await page.context().newCDPSession(page);

    try {
      const { nodes } = await client.send('Accessibility.getFullAXTree');
      return nodes as AXNode[];
    } finally {
      await client.detach();
    }
  }

  /**
   * Convert AXNode tree to our ElementNode graph format.
   */
  private convertToElementGraph(axNodes: AXNode[], pageUrl: string, pageTitle: string): PageElementGraph {
    const elements = new Map<string, ElementNode>();
    const headings: string[] = [];
    const landmarks: string[] = [];
    const buttons: string[] = [];
    const formFields: string[] = [];
    const links: string[] = [];
    const tables: string[] = [];
    const lists: string[] = [];
    const outboundLinks: OutboundLink[] = [];
    const rootElementIds: string[] = [];

    // Build node map for parent lookup
    const nodeIdToElement = new Map<string, ElementNode>();
    const childToParent = new Map<string, string>();

    // First pass: create all elements
    for (const axNode of axNodes) {
      if (axNode.ignored) continue;

      const role = axNode.role?.value || 'generic';
      const name = axNode.name?.value || '';

      // Skip nodes without meaningful content
      if (role === 'generic' && !name) continue;

      // Generate element ID
      const xpath = this.generateXPathFromNodeId(axNode.nodeId);
      const elementId = `${pageUrl}#${xpath}`;

      // Determine type flags
      const typeFlags = this.computeTypeFlags(role, axNode.properties);

      const element: ElementNode = {
        id: elementId,
        pageUrl,
        xpath,
        role,
        name,
        description: axNode.description?.value,
        value: axNode.value?.value,
        backendDOMNodeId: axNode.backendDOMNodeId,  // Bridge to DOM tree for gap detection
        typeFlags,
        children: [],
        parent: null,
        navigationEdges: [],
        visited: false,
        visitedBy: [],
        wcagEvaluated: false,
        violations: [],
      };

      elements.set(elementId, element);
      nodeIdToElement.set(axNode.nodeId, element);

      // Track parent-child relationships
      if (axNode.childIds) {
        for (const childId of axNode.childIds) {
          childToParent.set(childId, axNode.nodeId);
        }
      }

      // Index by type
      if (typeFlags.headingLevel) headings.push(elementId);
      if (typeFlags.isLandmark) landmarks.push(elementId);
      if (typeFlags.isButton) buttons.push(elementId);
      if (typeFlags.isFormField) formFields.push(elementId);
      if (typeFlags.isLink) links.push(elementId);
      if (typeFlags.isTable) tables.push(elementId);
      if (typeFlags.isList) lists.push(elementId);

      // Track outbound links
      if (typeFlags.isLink && name) {
        // Extract href from properties if available
        const href = this.extractProperty(axNode.properties, 'url');
        if (href && this.isValidUrl(href)) {
          outboundLinks.push({
            elementId,
            targetUrl: this.normalizeUrl(href, pageUrl),
            linkText: name,
          });
        }
      }
    }

    // Second pass: establish parent-child relationships
    for (const axNode of axNodes) {
      const element = nodeIdToElement.get(axNode.nodeId);
      if (!element) continue;

      const parentNodeId = childToParent.get(axNode.nodeId);
      if (parentNodeId) {
        const parentElement = nodeIdToElement.get(parentNodeId);
        if (parentElement) {
          element.parent = parentElement.id;
          parentElement.children.push(element.id);
        }
      } else {
        // No parent means root element
        rootElementIds.push(element.id);
      }
    }

    // Compute interactive count
    let interactiveCount = 0;
    for (const element of elements.values()) {
      if (element.typeFlags.isInteractive) {
        interactiveCount++;
      }
    }

    return {
      pageUrl,
      title: pageTitle,
      elements,
      rootElementIds,
      headings,
      landmarks,
      buttons,
      formFields,
      links,
      tables,
      lists,
      outboundLinks,
      crawledAt: new Date(),
      elementCount: elements.size,
      interactiveCount,
    };
  }

  /**
   * Compute type flags for an element based on its role and properties.
   */
  private computeTypeFlags(role: string, properties?: Array<{ name: string; value: { value: any } }>): ElementTypeFlags {
    const landmarkRoles = ['banner', 'main', 'navigation', 'search', 'complementary', 'contentinfo', 'form', 'region'];
    const interactiveRoles = ['button', 'link', 'menuitem', 'checkbox', 'radio', 'textbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'switch', 'tab'];
    const formFieldRoles = ['textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'searchbox'];

    // Extract heading level
    let headingLevel: number | null = null;
    if (role === 'heading') {
      const levelProp = properties?.find((p) => p.name === 'level');
      headingLevel = levelProp ? Number(levelProp.value.value) : 1;
    }

    const isLandmark = landmarkRoles.includes(role);
    const isInteractive = interactiveRoles.includes(role);
    const isLink = role === 'link';

    return {
      isLandmark,
      landmarkRole: isLandmark ? role : null,
      isButton: role === 'button',
      isFormField: formFieldRoles.includes(role),
      isTable: role === 'table' || role === 'grid',
      isLink,
      isList: role === 'list',
      headingLevel,
      isInteractive,
      isNavigational: isLink,
    };
  }

  /**
   * Discover navigation edges by analyzing element order and relationships.
   */
  private async discoverNavigationEdges(page: Page, graph: PageElementGraph): Promise<void> {
    const elementIds = Array.from(graph.elements.keys());

    // Build sequential navigation edges (ArrowDown/ArrowUp)
    for (let i = 0; i < elementIds.length - 1; i++) {
      const current = graph.elements.get(elementIds[i])!;
      const next = graph.elements.get(elementIds[i + 1])!;

      current.navigationEdges.push({
        targetId: next.id,
        action: 'ArrowDown',
        crossPage: false,
      });

      next.navigationEdges.push({
        targetId: current.id,
        action: 'ArrowUp',
        crossPage: false,
      });
    }

    // Build heading navigation edges (h key)
    for (let i = 0; i < graph.headings.length - 1; i++) {
      const current = graph.elements.get(graph.headings[i])!;
      const next = graph.elements.get(graph.headings[i + 1])!;

      current.navigationEdges.push({
        targetId: next.id,
        action: 'h',
        crossPage: false,
      });
    }

    // Build landmark navigation edges (d key)
    for (let i = 0; i < graph.landmarks.length - 1; i++) {
      const current = graph.elements.get(graph.landmarks[i])!;
      const next = graph.elements.get(graph.landmarks[i + 1])!;

      current.navigationEdges.push({
        targetId: next.id,
        action: 'd',
        crossPage: false,
      });
    }

    // Build button navigation edges (b key)
    for (let i = 0; i < graph.buttons.length - 1; i++) {
      const current = graph.elements.get(graph.buttons[i])!;
      const next = graph.elements.get(graph.buttons[i + 1])!;

      current.navigationEdges.push({
        targetId: next.id,
        action: 'b',
        crossPage: false,
      });
    }

    // Build form field navigation edges (f key and Tab)
    for (let i = 0; i < graph.formFields.length - 1; i++) {
      const current = graph.elements.get(graph.formFields[i])!;
      const next = graph.elements.get(graph.formFields[i + 1])!;

      current.navigationEdges.push({
        targetId: next.id,
        action: 'f',
        crossPage: false,
      });

      current.navigationEdges.push({
        targetId: next.id,
        action: 'Tab',
        crossPage: false,
      });
    }

    // Build link navigation edges (k key)
    for (let i = 0; i < graph.links.length - 1; i++) {
      const current = graph.elements.get(graph.links[i])!;
      const next = graph.elements.get(graph.links[i + 1])!;

      current.navigationEdges.push({
        targetId: next.id,
        action: 'k',
        crossPage: false,
      });
    }

    // Build cross-page edges for links
    for (const link of graph.outboundLinks) {
      const element = graph.elements.get(link.elementId);
      if (element) {
        element.navigationEdges.push({
          targetId: link.targetUrl, // Will be resolved to element on target page
          action: 'Enter',
          crossPage: true,
          targetPageUrl: link.targetUrl,
        });
      }
    }
  }

  /**
   * Generate XPath-like identifier from CDP node ID.
   */
  private generateXPathFromNodeId(nodeId: string): string {
    // CDP node IDs are numeric, we use them as-is for now
    // In a real implementation, we'd resolve to actual XPath
    return `node-${nodeId}`;
  }

  /**
   * Extract a property value from the properties array.
   */
  private extractProperty(properties: Array<{ name: string; value: { value: any } }> | undefined, name: string): string | undefined {
    const prop = properties?.find((p) => p.name === name);
    return prop?.value.value;
  }

  /**
   * Check if a URL is valid.
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Normalize a URL relative to a base URL.
   */
  private normalizeUrl(url: string, baseUrl: string): string {
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
  }

  // ==================== Dual Crawl for Gap Detection ====================

  /**
   * Perform dual crawl: accessibility tree + DOM comparison for gap detection.
   * This method crawls both the accessibility tree and the DOM to find
   * elements that should be accessible but aren't.
   */
  async crawlPageWithGapDetection(url: string): Promise<DualCrawlResult> {
    await this.init();

    const context = await this.browser!.newContext();
    const page = await context.newPage();

    try {
      console.log(`[ElementCrawler] Dual crawl for gap detection: ${url}`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000); // Wait for dynamic content

      // Phase 1: Get accessibility tree (existing functionality)
      const axNodes = await this.getAccessibilityTree(page);
      const accessibilityTree = this.convertToElementGraph(axNodes, url, await page.title());

      // Phase 2: Crawl DOM for potentially interactive elements
      const domCrawler = new DOMCrawler();
      const domElements = await domCrawler.crawlDOM(page, url);

      console.log(`[ElementCrawler] Found ${domElements.length} potentially interactive DOM elements`);

      // Phase 3: Get interactivity signals for each DOM element
      const signals = new Map<number, InteractivitySignals>();
      for (const element of domElements) {
        try {
          const elementSignals = await domCrawler.getInteractivitySignals(page, element);
          signals.set(element.backendNodeId, elementSignals);
        } catch {
          // Skip elements where we can't get signals
        }
      }

      // Phase 4: Build bridge map and detect gaps
      const gapDetector = new GapDetector();
      const bridgeMap = gapDetector.buildBridgeMap(accessibilityTree);
      const gaps = gapDetector.detectGaps(domElements, accessibilityTree, signals);

      console.log(`[ElementCrawler] Detected ${gaps.length} accessibility gaps`);

      // Log gap summary
      if (gaps.length > 0) {
        const gapsByType: Record<string, number> = {};
        for (const gap of gaps) {
          gapsByType[gap.gapType] = (gapsByType[gap.gapType] || 0) + 1;
        }
        console.log('[ElementCrawler] Gaps by type:', gapsByType);
      }

      return {
        pageUrl: url,
        accessibilityTree,
        domElements,
        gaps,
        bridgeMap,
      };
    } finally {
      await context.close();
    }
  }

  /**
   * Perform dual crawl for all pages in the site.
   * Uses the instance's maxPages and maxDepth settings.
   */
  async crawlSiteWithGapDetection(
    entryUrl: string,
    maxPages?: number,
    maxDepth?: number
  ): Promise<{
    graph: SiteElementGraph;
    dualCrawlResults: Map<string, DualCrawlResult>;
  }> {
    // Temporarily override maxPages/maxDepth if provided
    const originalMaxPages = this.maxPages;
    const originalMaxDepth = this.maxDepth;
    if (maxPages !== undefined) this.maxPages = maxPages;
    if (maxDepth !== undefined) this.maxDepth = maxDepth;

    try {
      // First, do the regular site crawl
      const graph = await this.crawlSite(entryUrl);

      // Then, do dual crawl for each page
      const dualCrawlResults = new Map<string, DualCrawlResult>();

      for (const [pageUrl] of graph.pages) {
        try {
          const dualResult = await this.crawlPageWithGapDetection(pageUrl);
          dualCrawlResults.set(pageUrl, dualResult);
        } catch (error) {
          console.warn(`[ElementCrawler] Dual crawl failed for ${pageUrl}:`, error);
        }
      }

      return { graph, dualCrawlResults };
    } finally {
      // Restore original settings
      this.maxPages = originalMaxPages;
      this.maxDepth = originalMaxDepth;
    }
  }
}
