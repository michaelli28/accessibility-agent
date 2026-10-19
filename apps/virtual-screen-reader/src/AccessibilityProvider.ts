import { Page } from 'playwright';
import { AXNode, NavigableAXNode, Rect } from './types';

/**
 * Browser type for provider selection.
 * 'chrome' uses the installed Chrome browser via channel option.
 * 'chromium' uses Playwright's bundled Chromium.
 */
export type BrowserType = 'chrome' | 'chromium' | 'firefox' | 'webkit';

/**
 * Abstract interface for accessibility tree operations.
 * Allows different implementations for CDP (Chrome) and Playwright (Firefox/WebKit).
 */
export interface AccessibilityProvider {
    /**
     * Get the full accessibility tree as a flat array of nodes.
     */
    getAccessibilityTree(): Promise<AXNode[]>;

    /**
     * Focus an element in the DOM.
     */
    focusElement(node: NavigableAXNode): Promise<void>;

    /**
     * Click an element.
     */
    clickElement(node: NavigableAXNode): Promise<void>;

    /**
     * Scroll an element into view.
     */
    scrollIntoView(node: NavigableAXNode): Promise<void>;

    /**
     * Get the bounding box of an element.
     */
    getBoundingBox(node: NavigableAXNode): Promise<Rect | null>;

    /**
     * Get an attribute value from an element.
     */
    getAttribute(node: NavigableAXNode, attr: string): Promise<string | null>;

    /**
     * Get the inner text of an element.
     */
    getInnerText(node: NavigableAXNode): Promise<string | null>;

    /**
     * Set the value of an input element.
     */
    setValue(node: NavigableAXNode, value: string): Promise<void>;

    /**
     * Dispatch a keyboard event to a specific element.
     */
    dispatchKeyToElement(node: NavigableAXNode, key: string, type: 'keydown' | 'keyup' | 'keypress'): Promise<void>;

    /**
     * Get the backend node ID of the currently focused element (if available).
     * Returns null if no element is focused or if not supported by provider.
     */
    getFocusedNodeId(): Promise<number | null>;

    /**
     * Find a node by its DOM ID attribute.
     * Returns the backend node ID or null if not found.
     */
    getNodeIdByDomId(domId: string): Promise<number | null>;

    /**
     * Check if this provider supports backend node IDs.
     * CDP provider returns true, Playwright provider returns false.
     */
    supportsBackendNodeId(): boolean;

    /**
     * Get the Playwright page instance.
     */
    getPage(): Page;
}

/**
 * Element identifier - can be either a CDP backend node ID or a Playwright locator path.
 */
export type ElementIdentifier =
    | { type: 'backendNodeId'; id: number }
    | { type: 'locatorPath'; path: string[] };

/**
 * Gets the appropriate element identifier from a NavigableAXNode.
 */
export function getElementIdentifier(node: NavigableAXNode): ElementIdentifier | null {
    if (node.backendDOMNodeId !== undefined) {
        return { type: 'backendNodeId', id: node.backendDOMNodeId };
    }
    if (node.locatorPath) {
        return { type: 'locatorPath', path: node.locatorPath };
    }
    return null;
}
