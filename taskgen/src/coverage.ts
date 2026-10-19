/**
 * Coverage Algorithm - Computes spanning forest for complete element coverage.
 *
 * The key insight is that screen reader navigation creates a directed graph where:
 * - Nodes are elements
 * - Edges are keyboard actions (ArrowDown, Tab, h, d, etc.)
 *
 * To ensure full coverage, we compute a spanning forest - a set of trees that
 * together visit every node in the graph at least once.
 */

import {
  SiteElementGraph,
  PageElementGraph,
  ElementNode,
  SpanningTree,
  TraversalPath,
  CoverageMetrics,
  TypeCoverage,
  AccessibilityTask,
  NavigationKey,
} from './types';

// ==================== Coverage Algorithm ====================

export class CoverageAlgorithm {
  /**
   * Compute a spanning forest that covers all elements.
   * A spanning forest is a set of trees that together span all nodes.
   * Each tree represents a sequence of keyboard actions starting from an entry point.
   */
  computeSpanningForest(graph: SiteElementGraph): SpanningTree[] {
    const trees: SpanningTree[] = [];
    const visited = new Set<string>();

    // Sort pages by importance (more elements = more important for now)
    const sortedPages = this.sortPagesByImportance(graph);

    for (const pageUrl of sortedPages) {
      const page = graph.pages.get(pageUrl);
      if (!page) continue;

      // Find unvisited entry points on this page
      const entryPoints = this.findEntryPoints(page, visited);

      for (const entryId of entryPoints) {
        if (visited.has(entryId)) continue;

        // BFS from this entry point
        const tree = this.bfsTraversal(page, entryId, visited);
        if (tree.edges.length > 0 || !visited.has(entryId)) {
          trees.push(tree);
        }
      }
    }

    // Handle any remaining unvisited elements (isolated or unreachable)
    for (const page of graph.pages.values()) {
      for (const elementId of page.elements.keys()) {
        if (!visited.has(elementId)) {
          visited.add(elementId);
          trees.push({
            rootElementId: elementId,
            rootPageUrl: page.pageUrl,
            edges: [],
          });
        }
      }
    }

    return trees;
  }

  /**
   * Sort pages by importance for traversal order.
   * Higher importance pages are processed first.
   */
  private sortPagesByImportance(graph: SiteElementGraph): string[] {
    return Array.from(graph.pages.entries())
      .sort((a, b) => {
        // Prioritize by interactive element count
        return b[1].interactiveCount - a[1].interactiveCount;
      })
      .map(([url]) => url);
  }

  /**
   * Find good entry points on a page (landmarks, headings, or first element).
   */
  private findEntryPoints(page: PageElementGraph, visited: Set<string>): string[] {
    const entryPoints: string[] = [];

    // Start with landmarks (main, navigation, etc.)
    for (const landmarkId of page.landmarks) {
      if (!visited.has(landmarkId)) {
        entryPoints.push(landmarkId);
      }
    }

    // If no unvisited landmarks, try first heading
    if (entryPoints.length === 0) {
      for (const headingId of page.headings) {
        if (!visited.has(headingId)) {
          entryPoints.push(headingId);
          break;
        }
      }
    }

    // If still nothing, use root elements
    if (entryPoints.length === 0) {
      for (const rootId of page.rootElementIds) {
        if (!visited.has(rootId)) {
          entryPoints.push(rootId);
          break;
        }
      }
    }

    // Last resort: any unvisited element
    if (entryPoints.length === 0) {
      for (const elementId of page.elements.keys()) {
        if (!visited.has(elementId)) {
          entryPoints.push(elementId);
          break;
        }
      }
    }

    return entryPoints;
  }

  /**
   * BFS traversal from an entry point, building a spanning tree.
   */
  private bfsTraversal(
    page: PageElementGraph,
    startId: string,
    globalVisited: Set<string>
  ): SpanningTree {
    const tree: SpanningTree = {
      rootElementId: startId,
      rootPageUrl: page.pageUrl,
      edges: [],
    };

    const queue: Array<{ currentId: string; parentId: string | null; action: NavigationKey | null }> = [
      { currentId: startId, parentId: null, action: null },
    ];

    const localVisited = new Set<string>();

    while (queue.length > 0) {
      const { currentId, parentId, action } = queue.shift()!;

      if (localVisited.has(currentId) || globalVisited.has(currentId)) {
        continue;
      }

      localVisited.add(currentId);
      globalVisited.add(currentId);

      if (parentId && action) {
        tree.edges.push({ from: parentId, to: currentId, action });
      }

      const element = page.elements.get(currentId);
      if (!element) continue;

      // Add all navigation edges to queue (prefer certain actions)
      const sortedEdges = this.sortEdgesByPriority(element.navigationEdges);

      for (const edge of sortedEdges) {
        if (!edge.crossPage && !localVisited.has(edge.targetId) && !globalVisited.has(edge.targetId)) {
          queue.push({
            currentId: edge.targetId,
            parentId: currentId,
            action: edge.action,
          });
        }
      }
    }

    return tree;
  }

  /**
   * Sort edges by priority (prefer simpler navigation actions).
   */
  private sortEdgesByPriority(edges: Array<{ targetId: string; action: NavigationKey; crossPage: boolean }>): typeof edges {
    const priority: Record<string, number> = {
      ArrowDown: 1,
      Tab: 2,
      h: 3,
      d: 4,
      b: 5,
      f: 6,
      k: 7,
      Enter: 10,
      ArrowUp: 11,
    };

    return [...edges].sort((a, b) => {
      const pa = priority[a.action] ?? 100;
      const pb = priority[b.action] ?? 100;
      return pa - pb;
    });
  }

  /**
   * Generate traversal paths that cover all elements with minimal overlap.
   * Each path represents a logical sequence of actions from an entry point.
   */
  generateTraversalPaths(graph: SiteElementGraph): TraversalPath[] {
    const forest = this.computeSpanningForest(graph);
    const paths: TraversalPath[] = [];

    for (const tree of forest) {
      if (tree.edges.length === 0) {
        // Single element tree
        paths.push({
          entryUrl: tree.rootPageUrl,
          elements: [tree.rootElementId],
          actions: [],
          estimatedSteps: 1,
        });
        continue;
      }

      // Convert tree edges to a path (DFS order)
      const elements: string[] = [tree.rootElementId];
      const actions: NavigationKey[] = [];

      for (const edge of tree.edges) {
        elements.push(edge.to);
        actions.push(edge.action);
      }

      paths.push({
        entryUrl: tree.rootPageUrl,
        elements,
        actions,
        estimatedSteps: elements.length,
      });
    }

    return paths;
  }

  /**
   * Find elements that are not covered by any traversal path.
   * These need special attention (edge cases, hidden elements, etc.)
   */
  findUncoveredElements(graph: SiteElementGraph, paths: TraversalPath[]): ElementNode[] {
    const covered = new Set<string>();

    for (const path of paths) {
      for (const elementId of path.elements) {
        covered.add(elementId);
      }
    }

    const uncovered: ElementNode[] = [];

    for (const page of graph.pages.values()) {
      for (const element of page.elements.values()) {
        if (!covered.has(element.id)) {
          uncovered.push(element);
        }
      }
    }

    return uncovered;
  }

  /**
   * Compute coverage metrics for a given task set.
   */
  computeCoverageMetrics(graph: SiteElementGraph, coveredElementIds: Set<string>): CoverageMetrics {
    const totalElements = graph.totalElements;
    const coveredElements = coveredElementIds.size;

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
    for (const page of graph.pages.values()) {
      for (const element of page.elements.values()) {
        const types = this.getElementTypes(element);

        for (const type of types) {
          const metrics = elementsByType.get(type);
          if (metrics) {
            metrics.total++;
            if (coveredElementIds.has(element.id)) {
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
    for (const page of graph.pages.values()) {
      for (const element of page.elements.values()) {
        if (element.typeFlags.isInteractive && !coveredElementIds.has(element.id)) {
          uncoveredCritical.push(element.id);
        }
      }
    }

    return {
      totalElements,
      coveredElements,
      coveragePercent: totalElements > 0 ? (coveredElements / totalElements) * 100 : 100,
      elementsByType,
      uncoveredCritical,
      wcagCriteriaChecked: [], // Populated during execution
    };
  }

  /**
   * Get element type categories for an element.
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
   * Estimate how many tasks are needed for target coverage.
   */
  estimateTaskCount(graph: SiteElementGraph, targetCoverage: number): number {
    const paths = this.generateTraversalPaths(graph);

    // Each path roughly corresponds to one task
    // Adjust based on complexity
    let estimatedTasks = paths.length;

    // Add journey tasks (roughly 1 per 5 pages)
    estimatedTasks += Math.ceil(graph.pageCount / 5);

    // Adjust for target coverage (more tasks if higher coverage needed)
    if (targetCoverage > 90) {
      estimatedTasks = Math.ceil(estimatedTasks * 1.2);
    }

    return estimatedTasks;
  }
}
