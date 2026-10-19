import { Page, Locator } from 'playwright';
import { AccessibilityProvider } from './AccessibilityProvider';
import { AriaSnapshotParser } from './AriaSnapshotParser';
import { AXNode, NavigableAXNode, Rect } from './types';

/**
 * Playwright-based accessibility provider for Firefox and WebKit.
 * Uses ariaSnapshot() for tree retrieval and Playwright locators for interaction.
 */
export class PlaywrightAccessibilityProvider implements AccessibilityProvider {
    private parser: AriaSnapshotParser;

    constructor(private page: Page) {
        this.parser = new AriaSnapshotParser();
    }

    supportsBackendNodeId(): boolean {
        return false;
    }

    getPage(): Page {
        return this.page;
    }

    async getAccessibilityTree(): Promise<AXNode[]> {
        try {
            const yaml = await this.page.locator('body').ariaSnapshot();
            if (!yaml || yaml.trim() === '') {
                console.warn('[PlaywrightProvider] ariaSnapshot returned empty string');
                return [];
            }
            const nodes = this.parser.parse(yaml);
            console.log(`[PlaywrightProvider] Parsed ${nodes.length} nodes from ariaSnapshot`);
            if (nodes.length === 0) {
                console.warn('[PlaywrightProvider] Parser returned 0 nodes from non-empty YAML');
                console.warn('[PlaywrightProvider] YAML preview:', yaml.substring(0, 300));
            }
            return nodes;
        } catch (error) {
            console.error('[PlaywrightProvider] ariaSnapshot FAILED:', error);
            throw new Error(`ariaSnapshot failed: ${error}`);
        }
    }

    async focusElement(node: NavigableAXNode): Promise<void> {
        const locator = this.buildLocator(node);
        if (!locator) {
            throw new Error('Cannot build locator for node');
        }
        try {
            await locator.focus();
        } catch (e) {
            // Ignore if not focusable
        }
    }

    async clickElement(node: NavigableAXNode): Promise<void> {
        const locator = this.buildLocator(node);
        if (!locator) {
            throw new Error('Cannot build locator for node');
        }
        await locator.scrollIntoViewIfNeeded();
        await locator.click();
    }

    async scrollIntoView(node: NavigableAXNode): Promise<void> {
        const locator = this.buildLocator(node);
        if (!locator) return;
        try {
            await locator.scrollIntoViewIfNeeded();
        } catch (e) {
            // Ignore scroll failures
        }
    }

    async getBoundingBox(node: NavigableAXNode): Promise<Rect | null> {
        const locator = this.buildLocator(node);
        if (!locator) return null;
        try {
            const box = await locator.boundingBox();
            if (!box) return null;
            return {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height
            };
        } catch (e) {
            return null;
        }
    }

    async getAttribute(node: NavigableAXNode, attr: string): Promise<string | null> {
        const locator = this.buildLocator(node);
        if (!locator) return null;
        try {
            return await locator.getAttribute(attr);
        } catch (e) {
            return null;
        }
    }

    async getInnerText(node: NavigableAXNode): Promise<string | null> {
        const locator = this.buildLocator(node);
        if (!locator) return null;
        try {
            return await locator.innerText();
        } catch (e) {
            return null;
        }
    }

    async setValue(node: NavigableAXNode, value: string): Promise<void> {
        const locator = this.buildLocator(node);
        if (!locator) {
            throw new Error('Cannot build locator for node');
        }
        await locator.fill(value);
    }

    async dispatchKeyToElement(node: NavigableAXNode, key: string, type: 'keydown' | 'keyup' | 'keypress'): Promise<void> {
        const locator = this.buildLocator(node);
        if (!locator) return;
        try {
            // Playwright doesn't have direct key dispatch, use evaluate
            await locator.evaluate((el, { key, type }) => {
                el.dispatchEvent(new KeyboardEvent(type, {
                    key,
                    bubbles: true,
                    cancelable: true
                }));
            }, { key, type });
        } catch (e) {
            // Ignore dispatch failures
        }
    }

    async getFocusedNodeId(): Promise<number | null> {
        // Playwright provider doesn't use backend node IDs
        return null;
    }

    async getNodeIdByDomId(domId: string): Promise<number | null> {
        // Playwright provider doesn't use backend node IDs
        return null;
    }

    /**
     * Build a Playwright locator from a NavigableAXNode.
     * Uses either locatorPath or falls back to role+name matching.
     */
    private buildLocator(node: NavigableAXNode): Locator | null {
        // Strategy 1: Use locatorPath if available
        if (node.locatorPath && node.locatorPath.length > 0) {
            return this.buildLocatorFromPath(node.locatorPath);
        }

        // Strategy 2: Use computed role and name
        const role = node.computedRole;
        const name = node.computedName;

        if (role) {
            try {
                if (name) {
                    return this.page.getByRole(role as any, { name, exact: false });
                } else {
                    return this.page.getByRole(role as any);
                }
            } catch (e) {
                // Invalid role for getByRole
            }
        }

        // Strategy 3: Use text content if available
        if (name) {
            return this.page.getByText(name, { exact: false });
        }

        return null;
    }

    /**
     * Build a Playwright locator from a locator path array.
     * Path format: ['main', 'list', 'listitem:2', 'link']
     * The :N suffix indicates the nth element of that role.
     */
    private buildLocatorFromPath(path: string[]): Locator | null {
        if (path.length === 0) return null;

        let locator: Locator = this.page.locator('body');

        for (const segment of path) {
            const [role, indexStr] = segment.split(':');
            const index = indexStr ? parseInt(indexStr, 10) : 0;

            try {
                // Get all elements with this role within current locator
                const roleLocator = locator.getByRole(role as any);
                locator = roleLocator.nth(index);
            } catch (e) {
                // Role might not be valid for getByRole, try as selector
                locator = locator.locator(`[role="${role}"]`).nth(index);
            }
        }

        return locator;
    }
}
