/**
 * AXTreeCache - Caches the accessibility tree for efficient navigation.
 *
 * Simplified: Only handles caching of the AX tree. Dynamic content detection
 * is handled exclusively by the MutationObserver in playwrightClient.ts.
 */

import { BrowserClient } from './playwrightClient';
import { NavigableAXNode, CachedAXTree } from './types';
import { AXTreeNavigator } from './AXTreeNavigator';

/**
 * Options for the AX tree cache.
 */
export interface AXTreeCacheOptions {
    /** Maximum age of cache before refresh (ms). Default: 60000 */
    maxAge?: number;
}

const DEFAULT_OPTIONS: Required<AXTreeCacheOptions> = {
    maxAge: 60000, // 60 seconds - only refresh on explicit actions, not time-based
};

/**
 * AXTreeCache manages caching of the accessibility tree.
 */
export class AXTreeCache {
    private client: BrowserClient;
    private options: Required<AXTreeCacheOptions>;
    private navigator: AXTreeNavigator;
    private cache: CachedAXTree | null = null;

    constructor(client: BrowserClient, navigator: AXTreeNavigator, options: AXTreeCacheOptions = {}) {
        this.client = client;
        this.navigator = navigator;
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Gets the cached tree, refreshing if stale.
     */
    async getTree(): Promise<CachedAXTree | null> {
        if (this.cache && !this.isStale()) {
            return this.cache;
        }

        return await this.refresh();
    }

    /**
     * Forces a refresh of the AX tree.
     */
    async refresh(): Promise<CachedAXTree | null> {
        try {
            const flatNodes = await this.client.getFullAXTree();
            const url = await this.client.getCurrentUrl();

            // Build navigable tree
            const root = this.navigator.buildNavigableTree(flatNodes);

            // Cache the result
            this.cache = {
                root,
                flatNodes: root ? this.collectFlatNodes(root) : [],
                interestingNodes: this.navigator.getAllInterestingNodes(),
                timestamp: Date.now(),
                url,
            };

            // Resolve aria-controls relationships for expanded elements
            await this.resolveAriaControlsRelationships();

            return this.cache;
        } catch (error) {
            console.error('[AXTreeCache] Failed to refresh tree:', error);
            if (!this.cache) {
                // No fallback cache - this is a real error, propagate it
                throw error;
            }
            // Has fallback - use stale cache but warn
            console.warn('[AXTreeCache] Using stale cache due to refresh error');
            return this.cache;
        }
    }

    /**
     * Resolves aria-controls relationships for elements that can expand/control other content.
     * This links controller nodes to their controlled content (e.g., dropdown button → listbox).
     * Critical for navigating into expanded dropdowns.
     */
    private async resolveAriaControlsRelationships(): Promise<void> {
        if (!this.cache) return;

        // Find elements that might control other content:
        // - Elements that are currently expanded (most important - these have active content)
        // - Elements with hasPopup property
        // - Comboboxes and listboxes (common dropdown patterns)
        for (const node of this.cache.interestingNodes) {
            // Check if node can be queried for attributes (has either backendDOMNodeId or locatorPath)
            if (!(node.backendDOMNodeId || node.locatorPath)) continue;

            // Prioritize currently expanded elements - they have active dropdown content
            const shouldCheck = node.states.expanded === true ||
                node.states.hasPopup ||
                node.computedRole === 'combobox' ||
                node.computedRole === 'listbox' ||
                (node.computedRole === 'button' && node.states.expanded !== undefined);

            if (!shouldCheck) continue;

            try {
                const ariaControls = await this.client.getNodeAttribute(node, 'aria-controls');
                if (ariaControls && ariaControls !== 'null' && ariaControls.trim()) {
                    // aria-controls can be space-separated IDs
                    const controlledIds = ariaControls.split(/\s+/).filter(id => id);

                    for (const domId of controlledIds) {
                        const backendNodeId = await this.client.getBackendNodeIdByDomId(domId);
                        if (backendNodeId) {
                            const controlledNode = this.findByBackendNodeId(backendNodeId);
                            if (controlledNode) {
                                // Link the relationships
                                if (!node.controlledNodes) node.controlledNodes = [];
                                // Avoid duplicates
                                if (!node.controlledNodes.includes(controlledNode)) {
                                    node.controlledNodes.push(controlledNode);
                                    controlledNode.controllerNode = node;
                                }
                            }
                        }
                    }
                }

                // Also check aria-owns for parent-child relationships (used by some comboboxes)
                const ariaOwns = await this.client.getNodeAttribute(node, 'aria-owns');
                if (ariaOwns && ariaOwns !== 'null' && ariaOwns.trim()) {
                    const ownedIds = ariaOwns.split(/\s+/).filter(id => id);

                    for (const domId of ownedIds) {
                        const backendNodeId = await this.client.getBackendNodeIdByDomId(domId);
                        if (backendNodeId) {
                            const ownedNode = this.findByBackendNodeId(backendNodeId);
                            if (ownedNode) {
                                if (!node.controlledNodes) node.controlledNodes = [];
                                if (!node.controlledNodes.includes(ownedNode)) {
                                    node.controlledNodes.push(ownedNode);
                                    ownedNode.controllerNode = node;
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // Ignore errors for individual nodes - element might have been removed
            }
        }
    }

    /**
     * Invalidates the cache, forcing next getTree() to refresh.
     */
    invalidate(): void {
        this.cache = null;
    }

    /**
     * Checks if the cache is stale.
     */
    isStale(): boolean {
        if (!this.cache) return true;
        return Date.now() - this.cache.timestamp > this.options.maxAge;
    }

    /**
     * Gets the cache age in milliseconds.
     */
    getCacheAge(): number {
        if (!this.cache) return Infinity;
        return Date.now() - this.cache.timestamp;
    }

    /**
     * Collects all nodes into a flat array via DFS.
     */
    private collectFlatNodes(root: NavigableAXNode): NavigableAXNode[] {
        const nodes: NavigableAXNode[] = [];

        const traverse = (node: NavigableAXNode) => {
            nodes.push(node);
            for (const child of node.children) {
                traverse(child);
            }
        };

        traverse(root);
        return nodes;
    }

    // =========================================================================
    // Utility Methods
    // =========================================================================

    /**
     * Finds a node by its backend DOM node ID.
     */
    findByBackendNodeId(backendNodeId: number): NavigableAXNode | null {
        if (!this.cache) return null;

        return this.cache.flatNodes.find(n => n.backendDOMNodeId === backendNodeId) || null;
    }

    /**
     * Finds a node by its AX node ID.
     */
    findByNodeId(nodeId: string): NavigableAXNode | null {
        if (!this.cache) return null;

        return this.cache.flatNodes.find(n => n.nodeId === nodeId) || null;
    }

    /**
     * Finds a node by its locator path (for Firefox/WebKit support).
     */
    findByLocatorPath(path: string[]): NavigableAXNode | null {
        if (!this.cache || !path || path.length === 0) return null;

        const pathStr = path.join('/');
        return this.cache.flatNodes.find(n =>
            n.locatorPath && n.locatorPath.join('/') === pathStr
        ) || null;
    }

    /**
     * Finds a node by any available identifier (backendNodeId, nodeId, or locatorPath).
     */
    findByIdentifier(node: NavigableAXNode): NavigableAXNode | null {
        if (!this.cache) return null;

        // Try backendDOMNodeId first (most reliable for CDP)
        if (node.backendDOMNodeId !== undefined) {
            const found = this.findByBackendNodeId(node.backendDOMNodeId);
            if (found) return found;
        }

        // Try nodeId
        if (node.nodeId) {
            const found = this.findByNodeId(node.nodeId);
            if (found) return found;
        }

        // Try locatorPath (for Firefox/WebKit)
        if (node.locatorPath) {
            const found = this.findByLocatorPath(node.locatorPath);
            if (found) return found;
        }

        return null;
    }

    /**
     * Gets cache statistics.
     */
    getStats(): { totalNodes: number; interestingNodes: number; cacheAge: number } {
        return {
            totalNodes: this.cache?.flatNodes.length || 0,
            interestingNodes: this.cache?.interestingNodes.length || 0,
            cacheAge: this.getCacheAge(),
        };
    }

    /**
     * Cleans up resources.
     */
    dispose(): void {
        this.cache = null;
    }
}
