/**
 * DOM Crawler - Crawls the DOM tree to find potentially interactive elements
 * that may be missing from the accessibility tree.
 *
 * This module uses CDP DOM.* commands to:
 * 1. Find all potentially interactive elements in the DOM
 * 2. Detect interactivity signals (click handlers, cursor:pointer, etc.)
 * 3. Return elements with backendNodeId for bridging to the accessibility tree
 */

import { Page, CDPSession } from 'playwright';
import { DOMElement, InteractivitySignals } from './types';

// ==================== Interactive Element Selectors ====================

/**
 * Semantic HTML elements that are natively interactive.
 */
const SEMANTIC_INTERACTIVE_SELECTORS = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'details',
  'summary',
  '[contenteditable="true"]',
  'audio[controls]',
  'video[controls]',
];

/**
 * Pseudo-interactive elements that may have been made interactive via JS/ARIA.
 */
const PSEUDO_INTERACTIVE_SELECTORS = [
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tablist"]',
  '[role="tree"]',
  '[role="treeitem"]',
  '[role="grid"]',
  '[role="gridcell"]',
  '[tabindex]',
  '[onclick]',
  '[onkeydown]',
  '[onkeyup]',
  '[onmousedown]',
  '[onmouseup]',
  // Framework-specific click handlers
  '[ng-click]',      // AngularJS
  '[@click]',        // Vue.js (may not work in querySelector)
  '[v-on\\:click]',  // Vue.js alternative
  '[(click)]',       // Angular (may not work in querySelector)
];

/**
 * Class name patterns that often indicate interactive elements.
 */
const INTERACTIVE_CLASS_PATTERNS = [
  'btn',
  'button',
  'clickable',
  'interactive',
  'action',
  'trigger',
  'toggle',
  'dropdown',
  'link',
  'nav-link',
  'menu-item',
  'tab',
];

// ==================== DOM Crawler Class ====================

export class DOMCrawler {
  private cdpSession: CDPSession | null = null;

  /**
   * Crawl the DOM to find all potentially interactive elements.
   */
  async crawlDOM(page: Page, pageUrl: string): Promise<DOMElement[]> {
    this.cdpSession = await page.context().newCDPSession(page);

    try {
      // Enable DOM domain
      await this.cdpSession.send('DOM.enable');

      // Get the document root
      const { root } = await this.cdpSession.send('DOM.getDocument', { depth: 0 });

      // Build the combined selector
      const allSelectors = [
        ...SEMANTIC_INTERACTIVE_SELECTORS,
        ...PSEUDO_INTERACTIVE_SELECTORS,
      ];

      // Find all potentially interactive elements
      const domElements: DOMElement[] = [];

      for (const selector of allSelectors) {
        try {
          const { nodeIds } = await this.cdpSession.send('DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector,
          });

          for (const nodeId of nodeIds) {
            const element = await this.getElementDetails(nodeId, pageUrl);
            if (element) {
              // Check if we already have this element (by backendNodeId)
              const exists = domElements.some(e => e.backendNodeId === element.backendNodeId);
              if (!exists) {
                domElements.push(element);
              }
            }
          }
        } catch {
          // Some selectors may be invalid, skip them
          continue;
        }
      }

      // Also find elements with interactive-looking class names
      const classBasedElements = await this.findElementsWithInteractiveClasses(root.nodeId, pageUrl);
      for (const element of classBasedElements) {
        const exists = domElements.some(e => e.backendNodeId === element.backendNodeId);
        if (!exists) {
          domElements.push(element);
        }
      }

      return domElements;
    } finally {
      await this.cdpSession.detach();
      this.cdpSession = null;
    }
  }

  /**
   * Get detailed information about a DOM element.
   */
  private async getElementDetails(nodeId: number, pageUrl: string): Promise<DOMElement | null> {
    if (!this.cdpSession) return null;

    try {
      // Describe the node to get backendNodeId and attributes
      const { node } = await this.cdpSession.send('DOM.describeNode', {
        nodeId,
        depth: 0,
      });

      if (!node || node.nodeType !== 1) return null; // Only element nodes

      // Parse attributes into a map
      const attributes: Record<string, string> = {};
      if (node.attributes) {
        for (let i = 0; i < node.attributes.length; i += 2) {
          attributes[node.attributes[i]] = node.attributes[i + 1];
        }
      }

      // Try to get bounding box
      let boundingBox: DOMElement['boundingBox'] = null;
      try {
        const { model } = await this.cdpSession.send('DOM.getBoxModel', { nodeId });
        if (model && model.content) {
          const [x1, y1, x2, , , y3] = model.content;
          boundingBox = {
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y3 - y1,
          };
        }
      } catch {
        // Element may not be visible
      }

      return {
        nodeId,
        backendNodeId: node.backendNodeId,
        nodeName: node.nodeName,
        localName: node.localName,
        attributes,
        boundingBox,
        pageUrl,
      };
    } catch {
      return null;
    }
  }

  /**
   * Find elements with class names that suggest interactivity.
   */
  private async findElementsWithInteractiveClasses(
    rootNodeId: number,
    pageUrl: string
  ): Promise<DOMElement[]> {
    if (!this.cdpSession) return [];

    const elements: DOMElement[] = [];

    for (const pattern of INTERACTIVE_CLASS_PATTERNS) {
      try {
        // Use attribute contains selector for class matching
        const { nodeIds } = await this.cdpSession.send('DOM.querySelectorAll', {
          nodeId: rootNodeId,
          selector: `[class*="${pattern}"]`,
        });

        for (const nodeId of nodeIds) {
          const element = await this.getElementDetails(nodeId, pageUrl);
          if (element) {
            elements.push(element);
          }
        }
      } catch {
        continue;
      }
    }

    return elements;
  }

  /**
   * Get interactivity signals for a DOM element.
   * This determines how "interactive" an element appears to be.
   */
  async getInteractivitySignals(
    page: Page,
    element: DOMElement
  ): Promise<InteractivitySignals> {
    const cdp = await page.context().newCDPSession(page);

    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');

      const signals: InteractivitySignals = {
        hasClickHandler: false,
        hasCursorPointer: false,
        isSemanticInteractive: false,
        hasTabindex: false,
        tabindexValue: null,
        hasRoleAttribute: false,
        roleValue: null,
        hasAriaExpanded: false,
        classNameHints: [],
      };

      // Check semantic interactivity
      const semanticTags = ['button', 'a', 'input', 'select', 'textarea', 'details', 'summary'];
      signals.isSemanticInteractive = semanticTags.includes(element.localName.toLowerCase());

      // Check for onclick attribute
      signals.hasClickHandler = !!(
        element.attributes['onclick'] ||
        element.attributes['onkeydown'] ||
        element.attributes['onmousedown'] ||
        element.attributes['ng-click'] ||
        element.attributes['v-on:click']
      );

      // Check tabindex
      if (element.attributes['tabindex'] !== undefined) {
        signals.hasTabindex = true;
        signals.tabindexValue = parseInt(element.attributes['tabindex'], 10) || 0;
      }

      // Check role
      if (element.attributes['role']) {
        signals.hasRoleAttribute = true;
        signals.roleValue = element.attributes['role'];
      }

      // Check aria-expanded
      signals.hasAriaExpanded = element.attributes['aria-expanded'] !== undefined;

      // Check class name hints
      const className = element.attributes['class'] || '';
      for (const pattern of INTERACTIVE_CLASS_PATTERNS) {
        if (className.toLowerCase().includes(pattern)) {
          signals.classNameHints.push(pattern);
        }
      }

      // Check computed cursor style
      try {
        // Resolve node to get nodeId from backendNodeId
        const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
          backendNodeIds: [element.backendNodeId],
        });

        if (nodeIds && nodeIds[0]) {
          const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', {
            nodeId: nodeIds[0],
          });

          const cursorProp = computedStyle.find((p: { name: string }) => p.name === 'cursor');
          if (cursorProp && cursorProp.value === 'pointer') {
            signals.hasCursorPointer = true;
          }
        }
      } catch {
        // CSS may not be available
      }

      // Check for event listeners (more reliable than attribute check)
      try {
        const { object } = await cdp.send('DOM.resolveNode', {
          backendNodeId: element.backendNodeId,
        });

        if (object?.objectId) {
          const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
            objectId: object.objectId,
          });

          const clickListeners = listeners.filter((l: { type: string }) =>
            ['click', 'mousedown', 'mouseup', 'keydown', 'keyup', 'touchstart', 'touchend'].includes(l.type)
          );

          if (clickListeners.length > 0) {
            signals.hasClickHandler = true;
          }
        }
      } catch {
        // Event listener API may not be available
      }

      return signals;
    } finally {
      await cdp.detach();
    }
  }

  /**
   * Check if an element is visible (not hidden via CSS).
   */
  async isElementVisible(page: Page, element: DOMElement): Promise<boolean> {
    const cdp = await page.context().newCDPSession(page);

    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');

      // Resolve the node
      const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [element.backendNodeId],
      });

      if (!nodeIds || !nodeIds[0]) return false;

      const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', {
        nodeId: nodeIds[0],
      });

      // Check visibility-related properties
      const display = computedStyle.find((p: { name: string }) => p.name === 'display');
      const visibility = computedStyle.find((p: { name: string }) => p.name === 'visibility');
      const opacity = computedStyle.find((p: { name: string }) => p.name === 'opacity');

      if (display?.value === 'none') return false;
      if (visibility?.value === 'hidden') return false;
      if (opacity?.value === '0') return false;

      // Check if element has size
      if (element.boundingBox) {
        if (element.boundingBox.width === 0 || element.boundingBox.height === 0) {
          return false;
        }
      }

      return true;
    } catch {
      return true; // Assume visible if we can't check
    } finally {
      await cdp.detach();
    }
  }
}
