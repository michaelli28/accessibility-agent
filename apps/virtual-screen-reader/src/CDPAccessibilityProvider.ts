import { CDPSession, Page } from 'playwright';
import { AccessibilityProvider } from './AccessibilityProvider';
import { AXNode, NavigableAXNode, Rect } from './types';

/**
 * CDP-based accessibility provider for Chromium browsers.
 * Wraps Chrome DevTools Protocol calls for accessibility tree operations.
 */
export class CDPAccessibilityProvider implements AccessibilityProvider {
    constructor(
        private cdpSession: CDPSession,
        private page: Page
    ) {}

    supportsBackendNodeId(): boolean {
        return true;
    }

    getPage(): Page {
        return this.page;
    }

    async getAccessibilityTree(): Promise<AXNode[]> {
        const response = await this.cdpSession.send('Accessibility.getFullAXTree');
        return response.nodes as AXNode[];
    }

    async focusElement(node: NavigableAXNode): Promise<void> {
        if (node.backendDOMNodeId === undefined) {
            throw new Error('CDP provider requires backendDOMNodeId');
        }
        try {
            await this.cdpSession.send('DOM.focus', { backendNodeId: node.backendDOMNodeId });
        } catch (e) {
            // Ignore if not focusable
        }
    }

    async clickElement(node: NavigableAXNode): Promise<void> {
        if (node.backendDOMNodeId === undefined) {
            throw new Error('CDP provider requires backendDOMNodeId');
        }

        // First scroll into view
        await this.scrollIntoView(node);

        // Strategy 1: Programmatic click
        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId: node.backendDOMNodeId
            });
            if (object.objectId) {
                await this.cdpSession.send('Runtime.callFunctionOn', {
                    objectId: object.objectId,
                    functionDeclaration: `function() {
                        const event = new MouseEvent('click', {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        });
                        this.dispatchEvent(event);
                        if (this.tagName === 'A' || this.closest('a')) {
                            const link = this.tagName === 'A' ? this : this.closest('a');
                            if (link && link.href) {
                                link.click();
                            }
                        }
                    }`,
                    silent: true
                });
                await this.cdpSession.send('Runtime.releaseObject', { objectId: object.objectId });
                return;
            }
        } catch (e) {
            // Fall through to mouse click
        }

        // Strategy 2: Mouse click at coordinates
        const rect = await this.getBoundingBox(node);
        if (rect) {
            const centerX = rect.x + rect.width / 2;
            const centerY = rect.y + rect.height / 2;
            await this.page.mouse.click(centerX, centerY);
        }
    }

    async scrollIntoView(node: NavigableAXNode): Promise<void> {
        if (node.backendDOMNodeId === undefined) {
            throw new Error('CDP provider requires backendDOMNodeId');
        }

        try {
            await this.cdpSession.send('DOM.scrollIntoViewIfNeeded', {
                backendNodeId: node.backendDOMNodeId
            });
        } catch (error) {
            // Fallback: resolve to object and call scrollIntoView
            try {
                const { object } = await this.cdpSession.send('DOM.resolveNode', {
                    backendNodeId: node.backendDOMNodeId
                });
                if (object.objectId) {
                    await this.cdpSession.send('Runtime.callFunctionOn', {
                        objectId: object.objectId,
                        functionDeclaration: 'function() { this.scrollIntoView({ behavior: "instant", block: "center" }); }',
                        silent: true
                    });
                    await this.cdpSession.send('Runtime.releaseObject', { objectId: object.objectId });
                }
            } catch (e) {
                // Ignore scroll failures
            }
        }
    }

    async getBoundingBox(node: NavigableAXNode): Promise<Rect | null> {
        if (node.backendDOMNodeId === undefined) {
            return null;
        }

        try {
            const { model } = await this.cdpSession.send('DOM.getBoxModel', {
                backendNodeId: node.backendDOMNodeId
            });
            return {
                x: model.border[0],
                y: model.border[1],
                width: model.width,
                height: model.height
            };
        } catch (error) {
            return null;
        }
    }

    async getAttribute(node: NavigableAXNode, attr: string): Promise<string | null> {
        if (node.backendDOMNodeId === undefined) {
            return null;
        }

        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId: node.backendDOMNodeId
            });
            if (!object.objectId) return null;

            const result = await this.cdpSession.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: `function(attr) { return this.getAttribute(attr); }`,
                arguments: [{ value: attr }],
                returnByValue: true,
                silent: true
            });

            await this.cdpSession.send('Runtime.releaseObject', { objectId: object.objectId });
            return result.result.value ?? null;
        } catch (error) {
            return null;
        }
    }

    async getInnerText(node: NavigableAXNode): Promise<string | null> {
        if (node.backendDOMNodeId === undefined) {
            return null;
        }

        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId: node.backendDOMNodeId
            });
            if (!object.objectId) return null;

            const result = await this.cdpSession.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: 'function() { return this.innerText; }',
                returnByValue: true,
                silent: true
            });

            await this.cdpSession.send('Runtime.releaseObject', { objectId: object.objectId });
            return result.result.value ?? null;
        } catch (error) {
            return null;
        }
    }

    async setValue(node: NavigableAXNode, value: string): Promise<void> {
        if (node.backendDOMNodeId === undefined) {
            throw new Error('CDP provider requires backendDOMNodeId');
        }

        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId: node.backendDOMNodeId
            });
            if (!object.objectId) return;

            await this.cdpSession.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: `function(val) {
                    this.value = val;
                    this.dispatchEvent(new Event('input', { bubbles: true }));
                    this.dispatchEvent(new Event('change', { bubbles: true }));
                }`,
                arguments: [{ value }],
                silent: true
            });

            await this.cdpSession.send('Runtime.releaseObject', { objectId: object.objectId });
        } catch (error) {
            throw new Error(`Failed to set node value: ${error}`);
        }
    }

    async dispatchKeyToElement(node: NavigableAXNode, key: string, type: 'keydown' | 'keyup' | 'keypress'): Promise<void> {
        if (node.backendDOMNodeId === undefined) {
            return;
        }

        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId: node.backendDOMNodeId
            });
            if (!object.objectId) return;

            await this.cdpSession.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: `function(key, type) {
                    this.dispatchEvent(new KeyboardEvent(type, {
                        key,
                        bubbles: true,
                        cancelable: true
                    }));
                }`,
                arguments: [{ value: key }, { value: type }],
                silent: true
            });

            await this.cdpSession.send('Runtime.releaseObject', { objectId: object.objectId });
        } catch (error) {
            // Ignore dispatch failures
        }
    }

    async getFocusedNodeId(): Promise<number | null> {
        try {
            const result = await this.page.evaluate(() => {
                const focused = document.activeElement;
                if (!focused || focused === document.body || focused === document.documentElement) {
                    return null;
                }
                return true;
            });

            if (!result) return null;

            const { root } = await this.cdpSession.send('DOM.getDocument', { depth: 0 });

            try {
                const { nodeId } = await this.cdpSession.send('DOM.querySelector', {
                    nodeId: root.nodeId,
                    selector: ':focus'
                });

                if (!nodeId || nodeId === 0) return null;

                const { node } = await this.cdpSession.send('DOM.describeNode', { nodeId });
                return node.backendNodeId ?? null;
            } catch (queryError) {
                return null;
            }
        } catch (error) {
            return null;
        }
    }

    async getNodeIdByDomId(domId: string): Promise<number | null> {
        try {
            const result = await this.page.evaluate((id) => {
                const el = document.getElementById(id);
                return el ? true : false;
            }, domId);

            if (!result) return null;

            const { root } = await this.cdpSession.send('DOM.getDocument', { depth: 0 });
            const { nodeId } = await this.cdpSession.send('DOM.querySelector', {
                nodeId: root.nodeId,
                selector: `#${CSS.escape(domId)}`
            });

            if (!nodeId) return null;

            const { node } = await this.cdpSession.send('DOM.describeNode', { nodeId });
            return node.backendNodeId ?? null;
        } catch (error) {
            return null;
        }
    }
}
