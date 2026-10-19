import { firefox, chromium, webkit, Browser, Page, CDPSession, BrowserContext } from 'playwright';
import { AXNode, NavigableAXNode, Rect } from './types';
import { AccessibilityProvider, BrowserType } from './AccessibilityProvider';
import { CDPAccessibilityProvider } from './CDPAccessibilityProvider';
import { PlaywrightAccessibilityProvider } from './PlaywrightAccessibilityProvider';

/**
 * Checks if an error is due to page navigation (execution context destroyed).
 * These errors are expected during navigation and can usually be safely ignored or retried.
 */
function isNavigationError(error: any): boolean {
    const message = error?.message || '';
    return message.includes('Execution context was destroyed') ||
           message.includes('Target closed') ||
           message.includes('page has been closed');
}

/**
 * Configuration for the injected MutationObserver.
 * These values control how DOM mutations are batched and processed.
 */
const MUTATION_OBSERVER_CONFIG = {
    /** Minimum interval between processing mutation batches (ms) */
    rateLimitMs: 100,
    /** Maximum mutations to process in a single batch */
    maxMutationsPerBatch: 50,
    /** Maximum pending mutations before oldest are dropped */
    maxQueueSize: 500,
    /** Window for suppressing duplicate live region announcements (ms) */
    duplicateWindowMs: 1000,
} as const;

export class BrowserClient {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private cdpSession: CDPSession | null = null;
    private navigationOccurred: boolean = false;
    private pageLoadCallback: (() => Promise<void>) | null = null;
    private screencastCallback: ((frame: { data: string; metadata: any }) => void) | null = null;
    private isScreencasting: boolean = false;
    private isRemote: boolean = false;
    private browserType: BrowserType = 'chrome';
    private provider: AccessibilityProvider | null = null;
    private screenshotInterval: NodeJS.Timeout | null = null;
    private pendingNewTab: Page | null = null;

    /**
     * Launches a new browser instance.
     * @param headless Whether to run in headless mode
     * @param browserType Which browser to use: 'chrome', 'chromium', 'firefox', or 'webkit'
     *                    'chrome' uses your installed Chrome browser (recommended for CDP)
     *                    'chromium' uses Playwright's bundled Chromium
     */
    async launch(headless: boolean = true, browserType: BrowserType = 'chrome'): Promise<void> {
        this.browserType = browserType;

        // Launch browser based on type
        if (browserType === 'chrome') {
            this.browser = await chromium.launch({
                headless,
                channel: 'chrome',
                ignoreDefaultArgs: ['--enable-automation'],
                args: ['--start-maximized'],
            });
        } else if (browserType === 'chromium') {
            this.browser = await chromium.launch({
                headless,
                ignoreDefaultArgs: ['--enable-automation'],
                args: ['--start-maximized'],
            });
        } else if (browserType === 'firefox') {
            this.browser = await firefox.launch({ headless });
        } else if (browserType === 'webkit') {
            this.browser = await webkit.launch({ headless });
        } else {
            throw new Error(`Unsupported browser type: ${browserType}`);
        }

        // Create context with viewport: null to let window size dictate viewport
        if (browserType === 'chrome' || browserType === 'chromium') {
            this.context = await this.browser.newContext({
                viewport: null,
                hasTouch: false,
            });
        } else {
            this.context = await this.browser.newContext();
        }
        this.page = await this.context.newPage();
        this.isRemote = false;

        // Create provider based on browser type
        // Chrome and Chromium both support CDP - use it for better performance
        if (browserType === 'chrome' || browserType === 'chromium') {
            this.cdpSession = await this.context.newCDPSession(this.page);
            await this.cdpSession.send('DOM.enable');
            this.provider = new CDPAccessibilityProvider(this.cdpSession, this.page);
        } else {
            // Firefox/WebKit - use Playwright's cross-browser APIs
            this.cdpSession = null;
            this.provider = new PlaywrightAccessibilityProvider(this.page);
        }

        await this.setupPage();
    }

    /**
     * Get the current browser type.
     */
    getBrowserType(): BrowserType {
        return this.browserType;
    }

    /**
     * Get the accessibility provider.
     */
    getProvider(): AccessibilityProvider | null {
        return this.provider;
    }

    /**
     * Connects to an existing browser via CDP endpoint (e.g., Docker container).
     */
    async connectCDP(cdpEndpoint: string): Promise<void> {
        this.browser = await chromium.connectOverCDP(cdpEndpoint);
        this.isRemote = true;

        // Get the default context or create one
        const contexts = this.browser.contexts();
        if (contexts.length > 0) {
            this.context = contexts[0];
            const pages = this.context.pages();
            if (pages.length > 0) {
                this.page = pages[0];
            } else {
                this.page = await this.context.newPage();
            }
        } else {
            this.context = await this.browser.newContext();
            this.page = await this.context.newPage();
        }

        this.cdpSession = await this.context.newCDPSession(this.page);
        await this.setupPage();
    }

    /**
     * Common page setup for both launch and connect.
     */
    private async setupPage(): Promise<void> {
        if (!this.page || !this.context) return;

        // Enable DOM domain for CDP if available
        if (this.cdpSession) {
            await this.cdpSession.send('DOM.enable');
        }

        // Listen for new tabs (popups, target="_blank" links)
        this.context.on('page', async (newPage: Page) => {
            this.pendingNewTab = newPage;
        });

        // Listen for page load events to detect full page navigations
        this.page.on('load', async () => {
            this.navigationOccurred = true;
            if (this.pageLoadCallback) {
                try {
                    await this.pageLoadCallback();
                } catch (e: any) {
                    // Ignore callback errors
                }
            }
        });
    }

    /**
     * Check if connected to a remote browser.
     */
    isRemoteBrowser(): boolean {
        return this.isRemote;
    }

    /**
     * Injects a script to run on every page load AND immediately.
     */
    async injectScript(content: string): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");
        await this.page.addInitScript({ content });
        await this.page.evaluate(content);
    }

    /**
     * Navigates to a URL.
     */
    async goto(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' = 'domcontentloaded'): Promise<void> {
        if (!this.page) throw new Error("Browser not initialized. Call launch() first.");
        await this.page.goto(url, { waitUntil });
    }

    /**
     * Waits for the given timeout in milliseconds.
     */
    async waitForTimeout(timeout: number): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");
        await this.page.waitForTimeout(timeout);
    }

    /**
     * Fetches the full Accessibility Tree.
     * Uses CDP for Chromium, ariaSnapshot for Firefox/WebKit.
     */
    async getFullAXTree(): Promise<AXNode[]> {
        if (!this.provider) throw new Error("Provider not initialized.");
        return this.provider.getAccessibilityTree();
    }

    /**
     * Gets the bounding box for a node.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async getBoundingBox(nodeOrId: NavigableAXNode | number): Promise<Rect | null> {
        if (typeof nodeOrId === 'number') {
            // Legacy: backend node ID (CDP only)
            if (!this.cdpSession) throw new Error("CDP Session not initialized for backendNodeId.");
            try {
                const { model } = await this.cdpSession.send('DOM.getBoxModel', {
                    backendNodeId: nodeOrId
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

        // New: NavigableAXNode
        if (!this.provider) throw new Error("Provider not initialized.");
        return this.provider.getBoundingBox(nodeOrId);
    }

    /**
     * Focuses a node.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async focus(nodeOrId: NavigableAXNode | number): Promise<void> {
        if (typeof nodeOrId === 'number') {
            // Legacy: backend node ID (CDP only)
            if (!this.cdpSession) throw new Error("CDP Session not initialized for backendNodeId.");
            try {
                await this.cdpSession.send('DOM.focus', { backendNodeId: nodeOrId });
            } catch (e) {
                // Ignore if not focusable
            }
            return;
        }

        // New: NavigableAXNode
        if (!this.provider) throw new Error("Provider not initialized.");
        await this.provider.focusElement(nodeOrId);
    }

    /**
     * Simulates a key press.
     */
    async pressKey(key: string): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");
        await this.page.keyboard.press(key);
    }

    /**
     * Types text into the currently focused element.
     */
    async typeText(text: string): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");
        await this.page.keyboard.type(text);
    }

    /**
     * Simulates a mouse click at specific coordinates.
     */
    async click(x: number, y: number): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");
        await this.page.mouse.click(x, y);
    }

    /**
     * Takes a screenshot and returns it as a buffer.
     */
    async screenshot(path?: string): Promise<Buffer> {
        if (!this.page) throw new Error("Page not initialized.");
        return await this.page.screenshot({ path, fullPage: true });
    }

    /**
     * Navigates back to the previous page in browser history.
     */
    async goBack(): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");
        await this.page.goBack({ waitUntil: 'domcontentloaded' });
    }

    /**
     * Closes the browser instance or disconnects from remote.
     */
    async close(): Promise<void> {
        // Stop screencast if active
        await this.stopScreencast();

        // Clear screenshot interval
        if (this.screenshotInterval) {
            clearInterval(this.screenshotInterval);
            this.screenshotInterval = null;
        }

        if (this.browser) {
            if (this.isRemote) {
                // For remote browsers, just disconnect (don't close)
                await this.browser.close();
            } else {
                await this.browser.close();
            }
            this.browser = null;
            this.context = null;
            this.page = null;
            this.cdpSession = null;
            this.provider = null;
        }
    }

    /**
     * Highlights a bounding box on the page for visual debugging.
     * Returns a promise that resolves when highlighting is complete.
     */
    highlightBox(rect: Rect | null): void {
        if (!this.page) return;

        this.page.evaluate((rect) => {
            let box = document.getElementById('adf-highlight-box');
            if (!box) {
                box = document.createElement('div');
                box.id = 'adf-highlight-box';
                box.style.position = 'fixed'; // Fixed to viewport to match CDP coordinates
                box.style.border = '2px solid red';
                box.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
                box.style.pointerEvents = 'none'; // Click-through
                box.style.zIndex = '2147483647'; // Max z-index
                document.body.appendChild(box);
            }

            if (rect) {
                box.style.display = 'block';
                box.style.left = `${rect.x}px`;
                box.style.top = `${rect.y}px`;
                box.style.width = `${rect.width}px`;
                box.style.height = `${rect.height}px`;
            } else {
                box.style.display = 'none';
            }
        }, rect).catch((error: Error) => {
            if (!isNavigationError(error)) {
                console.warn('[BrowserClient] Highlight error:', error.message);
            }
        });
    }

    /**
     * Clears the highlight box.
     */
    clearHighlight(): void {
        this.highlightBox(null);
    }

    /**
     * Gets bounding box for AX tree operations.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async getNodeBoundingBox(nodeOrId: NavigableAXNode | number): Promise<Rect | null> {
        return this.getBoundingBox(nodeOrId);
    }

    /**
     * Focuses a node for AX tree operations.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async focusNode(nodeOrId: NavigableAXNode | number): Promise<void> {
        return this.focus(nodeOrId);
    }

    /**
     * Listen to console messages from the page.
     */
    onConsoleMessage(callback: (msg: string) => void) {
        if (!this.page) return;
        this.page.on('console', msg => callback(msg.text()));
    }

    /**
     * Gets the current page URL.
     * Handles execution context destruction during navigation gracefully.
     */
    async getCurrentUrl(): Promise<string> {
        if (!this.page) throw new Error("Page not initialized.");
        try {
            return this.page.url();
        } catch (error: any) {
            if (isNavigationError(error)) {
                await this.waitForNavigation();
                return this.page.url();
            }
            throw error;
        }
    }

    /**
     * Gets the current page title.
     * Handles execution context destruction during navigation gracefully.
     */
    async getTitle(): Promise<string> {
        if (!this.page) throw new Error("Page not initialized.");
        try {
            return await this.page.title();
        } catch (error: any) {
            if (isNavigationError(error)) {
                await this.waitForNavigation();
                return await this.page.title();
            }
            throw error;
        }
    }

    /**
     * Waits for navigation to complete.
     * Used internally to handle execution context destruction.
     *
     * Strategy:
     * 1. Try waiting for 'domcontentloaded' (fast, usually sufficient)
     * 2. On timeout, retry with 'load' state (waits for full page load)
     * 3. On second failure, assume page is ready (SPA navigation may not trigger load events)
     */
    async waitForNavigation(timeout: number = 5000): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");

        try {
            await this.page.waitForLoadState('domcontentloaded', { timeout });
            return;
        } catch {
            // domcontentloaded timed out - try waiting for full load
        }

        try {
            // Shorter timeout for 'load' since we already waited
            await this.page.waitForLoadState('load', { timeout: Math.min(timeout, 2000) });
        } catch {
            // Both failed - page may be a SPA that doesn't trigger traditional load events
            // This is expected behavior, not an error condition
        }
    }

    /**
     * Waits for network to be idle (no requests for 500ms).
     * This is useful after page load to ensure JS has finished rendering.
     * Has a short timeout since some pages have persistent connections.
     */
    async waitForNetworkIdle(timeout: number = 2000): Promise<void> {
        if (!this.page) return;
        try {
            await this.page.waitForLoadState('networkidle', { timeout });
        } catch {
            // Timeout is expected for pages with persistent connections (websockets, polling)
            // This is not an error - we just use whatever content is available
        }
    }

    /**
     * Re-injects a script into the current page (useful after navigation).
     * Handles execution context destruction during navigation gracefully.
     */
    async reinjectScript(content: string): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");
        try {
            await this.page.evaluate(content);
        } catch (error: any) {
            if (isNavigationError(error)) {
                await this.waitForNavigation();
                await this.page.evaluate(content);
            } else {
                throw error;
            }
        }
    }

    /**
     * Checks if a full page navigation occurred and resets the flag.
     */
    checkAndClearNavigation(): boolean {
        const occurred = this.navigationOccurred;
        this.navigationOccurred = false;
        return occurred;
    }

    /**
     * Register a callback to be invoked immediately when a page loads.
     */
    onPageLoad(callback: () => Promise<void>): void {
        this.pageLoadCallback = callback;
    }

    /**
     * Checks if a new tab was opened (e.g., from target="_blank" link).
     */
    hasPendingNewTab(): boolean {
        return this.pendingNewTab !== null;
    }

    /**
     * Switches to the pending new tab, updating page, CDP session, and provider.
     * Returns true if switch was successful, false if no pending tab.
     */
    async switchToNewTab(): Promise<boolean> {
        if (!this.pendingNewTab || !this.context) {
            return false;
        }

        const newPage = this.pendingNewTab;
        this.pendingNewTab = null;

        // Wait for the new page to load
        try {
            await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
        } catch (e: any) {
            // Timeout - continue anyway, page might be slow
        }

        // Update page reference
        this.page = newPage;

        // Create new CDP session and provider for the new page
        if (this.browserType === 'chrome' || this.browserType === 'chromium') {
            this.cdpSession = await this.context.newCDPSession(this.page);
            await this.cdpSession.send('DOM.enable');
            this.provider = new CDPAccessibilityProvider(this.cdpSession, this.page);
        } else {
            this.cdpSession = null;
            this.provider = new PlaywrightAccessibilityProvider(this.page);
        }

        // Set up load listener on the new page
        this.page.on('load', async () => {
            this.navigationOccurred = true;
            if (this.pageLoadCallback) {
                try {
                    await this.pageLoadCallback();
                } catch (e: any) {
                    // Ignore callback errors
                }
            }
        });

        return true;
    }

    /**
     * Clears any pending new tab without switching to it.
     */
    clearPendingNewTab(): void {
        this.pendingNewTab = null;
    }

    /**
     * Get the page instance for direct access.
     */
    getPage(): Page | null {
        return this.page;
    }

    /**
     * Starts screencast - streams browser frames in real-time.
     * Uses CDP for Chromium, falls back to periodic screenshots for Firefox/WebKit.
     */
    async startScreencast(
        callback: (frame: { data: string; metadata: any }) => void,
        options?: { format?: 'jpeg' | 'png'; quality?: number; maxWidth?: number; maxHeight?: number }
    ): Promise<void> {
        if (this.isScreencasting) return;

        this.screencastCallback = callback;
        this.isScreencasting = true;

        if (this.cdpSession) {
            // CDP available (Chromium) - use native screencast
            this.cdpSession.on('Page.screencastFrame', async (params) => {
                if (this.screencastCallback) {
                    this.screencastCallback({
                        data: params.data,
                        metadata: params.metadata
                    });
                }
                if (this.cdpSession && this.isScreencasting) {
                    try {
                        await this.cdpSession.send('Page.screencastFrameAck', {
                            sessionId: params.sessionId
                        });
                    } catch (e) {
                        // Session might be closed
                    }
                }
            });

            await this.cdpSession.send('Page.startScreencast', {
                format: options?.format || 'jpeg',
                quality: options?.quality || 80,
                maxWidth: options?.maxWidth || 1280,
                maxHeight: options?.maxHeight || 720,
                everyNthFrame: 1
            });
        } else if (this.page) {
            // Firefox/WebKit - fallback to periodic screenshots
            const fps = 10; // ~10fps for reasonable performance
            this.screenshotInterval = setInterval(async () => {
                if (!this.page || !this.isScreencasting) return;
                try {
                    const buffer = await this.page.screenshot({
                        type: options?.format || 'jpeg',
                        quality: options?.quality || 80
                    });
                    if (this.screencastCallback) {
                        this.screencastCallback({
                            data: buffer.toString('base64'),
                            metadata: { timestamp: Date.now() }
                        });
                    }
                } catch (e) {
                    // Page might be navigating
                }
            }, 1000 / fps);
        }
    }

    /**
     * Stops the screencast.
     */
    async stopScreencast(): Promise<void> {
        if (!this.isScreencasting) return;

        // Stop CDP screencast if active
        if (this.cdpSession) {
            try {
                await this.cdpSession.send('Page.stopScreencast');
            } catch (e) {
                // Session might already be closed
            }
        }

        // Clear screenshot interval if active
        if (this.screenshotInterval) {
            clearInterval(this.screenshotInterval);
            this.screenshotInterval = null;
        }

        this.isScreencasting = false;
        this.screencastCallback = null;
    }

    /**
     * Check if screencast is currently active.
     */
    isScreencastActive(): boolean {
        return this.isScreencasting;
    }

    /**
     * Scrolls the page by a given amount.
     */
    async scrollBy(deltaX: number, deltaY: number): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");
        await this.page.evaluate(({ dx, dy }) => {
            window.scrollBy(dx, dy);
        }, { dx: deltaX, dy: deltaY });
    }

    /**
     * Scrolls the page to a specific position.
     */
    async scrollTo(x: number, y: number): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");
        await this.page.evaluate(({ sx, sy }) => {
            window.scrollTo(sx, sy);
        }, { sx: x, sy: y });
    }

    /**
     * Gets the current scroll position and page dimensions.
     */
    async getScrollInfo(): Promise<{ scrollX: number; scrollY: number; scrollWidth: number; scrollHeight: number; viewportWidth: number; viewportHeight: number }> {
        if (!this.page) throw new Error("Page not initialized.");
        return await this.page.evaluate(() => ({
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
        }));
    }

    // =========================================================================
    // AX Tree Operations (Cross-browser)
    // =========================================================================

    /**
     * Clicks a node.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async clickNode(nodeOrId: NavigableAXNode | number): Promise<void> {
        if (typeof nodeOrId !== 'number') {
            // New: NavigableAXNode
            if (!this.provider) throw new Error("Provider not initialized.");
            await this.provider.clickElement(nodeOrId);
            return;
        }

        // Legacy: backend node ID (CDP only)
        if (!this.cdpSession || !this.page) throw new Error("CDP Session not initialized.");

        const backendNodeId = nodeOrId;

        // First scroll into view
        await this.scrollNodeIntoView(backendNodeId);

        let programmaticClickSucceeded = false;
        let programmaticError: Error | null = null;

        // Strategy 1: Try programmatic click (most reliable for links/buttons)
        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId
            });
            if (object.objectId) {
                // Dispatch a proper MouseEvent click (triggers event listeners)
                await this.cdpSession.send('Runtime.callFunctionOn', {
                    objectId: object.objectId,
                    functionDeclaration: `function() {
                        // Create and dispatch a proper click event
                        const event = new MouseEvent('click', {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        });
                        this.dispatchEvent(event);

                        // For links, also try direct click as backup
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
                programmaticClickSucceeded = true;
                return;
            }
        } catch (e: any) {
            programmaticError = e;
            // Fall through to mouse click
        }

        // Strategy 2: Mouse click at coordinates (fallback)
        let mouseClickSucceeded = false;
        let mouseError: Error | null = null;

        try {
            const rect = await this.getBoundingBox(backendNodeId);
            if (rect) {
                const centerX = rect.x + rect.width / 2;
                const centerY = rect.y + rect.height / 2;
                await this.page.mouse.click(centerX, centerY);
                mouseClickSucceeded = true;
                return;
            } else {
                mouseError = new Error('Node has no bounding box');
            }
        } catch (e: any) {
            mouseError = e;
        }

        // If both strategies failed, throw an error
        if (!programmaticClickSucceeded && !mouseClickSucceeded) {
            const errorMsg = `Click failed: programmatic=${programmaticError?.message || 'no objectId'}, mouse=${mouseError?.message || 'unknown'}`;
            throw new Error(errorMsg);
        }
    }

    /**
     * Scrolls a node into view.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async scrollNodeIntoView(nodeOrId: NavigableAXNode | number): Promise<void> {
        if (typeof nodeOrId !== 'number') {
            // New: NavigableAXNode
            if (!this.provider) throw new Error("Provider not initialized.");
            await this.provider.scrollIntoView(nodeOrId);
            return;
        }

        // Legacy: backend node ID (CDP only)
        if (!this.cdpSession) throw new Error("CDP Session not initialized.");

        const backendNodeId = nodeOrId;

        try {
            await this.cdpSession.send('DOM.scrollIntoViewIfNeeded', {
                backendNodeId
            });
        } catch (error: any) {
            // Fallback: resolve to object and call scrollIntoView
            try {
                const { object } = await this.cdpSession.send('DOM.resolveNode', {
                    backendNodeId
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
                // Ignore scroll failures - element might already be visible
            }
        }
    }

    /**
     * Resolves a backend node ID to a CDP RemoteObject for JavaScript operations.
     */
    async resolveNodeToObject(backendNodeId: number): Promise<{ objectId?: string } | null> {
        if (!this.cdpSession) throw new Error("CDP Session not initialized.");

        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId
            });
            return object;
        } catch (error) {
            return null;
        }
    }

    /**
     * Releases a RemoteObject by its object ID.
     */
    async releaseObject(objectId: string): Promise<void> {
        if (!this.cdpSession) return;
        try {
            await this.cdpSession.send('Runtime.releaseObject', { objectId });
        } catch (e) {
            // Ignore - object might already be released
        }
    }

    /**
     * Gets an attribute value from a node.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async getNodeAttribute(nodeOrId: NavigableAXNode | number, attributeName: string): Promise<string | null> {
        if (typeof nodeOrId !== 'number') {
            // New: NavigableAXNode
            if (!this.provider) throw new Error("Provider not initialized.");
            return this.provider.getAttribute(nodeOrId, attributeName);
        }

        // Legacy: backend node ID (CDP only)
        if (!this.cdpSession) throw new Error("CDP Session not initialized.");

        const backendNodeId = nodeOrId;

        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId
            });
            if (!object.objectId) return null;

            const result = await this.cdpSession.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: `function(attr) { return this.getAttribute(attr); }`,
                arguments: [{ value: attributeName }],
                returnByValue: true,
                silent: true
            });

            await this.cdpSession.send('Runtime.releaseObject', { objectId: object.objectId });
            return result.result.value ?? null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Gets the inner text of a node.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async getNodeInnerText(nodeOrId: NavigableAXNode | number): Promise<string | null> {
        if (typeof nodeOrId !== 'number') {
            // New: NavigableAXNode
            if (!this.provider) throw new Error("Provider not initialized.");
            return this.provider.getInnerText(nodeOrId);
        }

        // Legacy: backend node ID (CDP only)
        if (!this.cdpSession) throw new Error("CDP Session not initialized.");

        const backendNodeId = nodeOrId;

        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId
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

    /**
     * Sets the value of an input element.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async setNodeValue(nodeOrId: NavigableAXNode | number, value: string): Promise<void> {
        if (typeof nodeOrId !== 'number') {
            // New: NavigableAXNode
            if (!this.provider) throw new Error("Provider not initialized.");
            await this.provider.setValue(nodeOrId, value);
            return;
        }

        // Legacy: backend node ID (CDP only)
        if (!this.cdpSession) throw new Error("CDP Session not initialized.");

        const backendNodeId = nodeOrId;

        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId
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

    /**
     * Dispatches a keyboard event to a specific node.
     * @param nodeOrId NavigableAXNode or backend DOM node ID (legacy)
     */
    async dispatchKeyToNode(nodeOrId: NavigableAXNode | number, key: string, type: 'keydown' | 'keyup' | 'keypress' = 'keydown'): Promise<void> {
        if (typeof nodeOrId !== 'number') {
            // New: NavigableAXNode
            if (!this.provider) throw new Error("Provider not initialized.");
            await this.provider.dispatchKeyToElement(nodeOrId, key, type);
            return;
        }

        // Legacy: backend node ID (CDP only)
        if (!this.cdpSession) throw new Error("CDP Session not initialized.");

        const backendNodeId = nodeOrId;

        try {
            const { object } = await this.cdpSession.send('DOM.resolveNode', {
                backendNodeId
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

    /**
     * Gets the CDP session for direct access (for advanced operations).
     */
    getCDPSession(): CDPSession | null {
        return this.cdpSession;
    }

    /**
     * Gets the backendDOMNodeId of the currently focused element.
     * Returns null if no element is focused, using Firefox, or focus is on body/document.
     * Note: Only works with CDP (Chromium). Returns null for Firefox/WebKit.
     */
    async getFocusedBackendNodeId(): Promise<number | null> {
        // Use provider if available
        if (this.provider) {
            return this.provider.getFocusedNodeId();
        }

        // Fallback to CDP (shouldn't happen if provider is set)
        if (!this.cdpSession || !this.page) return null;

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

    /**
     * Finds an element by its DOM ID attribute and returns its backendDOMNodeId.
     * Used to resolve aria-controls targets.
     * Note: Only works with CDP (Chromium). Returns null for Firefox/WebKit.
     */
    async getBackendNodeIdByDomId(domId: string): Promise<number | null> {
        // Use provider if available
        if (this.provider) {
            return this.provider.getNodeIdByDomId(domId);
        }

        // Fallback to CDP
        if (!this.cdpSession || !this.page) return null;

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

    // =========================================================================
    // Dynamic Content Detection (MutationObserver)
    // =========================================================================

    private mutationCallback: ((mutations: MutationSummary[]) => void) | null = null;
    private consoleHandler: ((msg: any) => void) | null = null;
    private mutationObserverActive: boolean = false;

    /**
     * Starts monitoring DOM mutations for dynamic content changes.
     * Uses MutationObserver injected into the page for immediate detection.
     */
    async startMutationObserver(callback: (mutations: MutationSummary[]) => void): Promise<void> {
        if (!this.page) throw new Error("Page not initialized.");

        // Clean up any existing observer first
        await this.stopMutationObserver();

        this.mutationCallback = callback;
        this.mutationObserverActive = true;

        // Create a named handler so we can remove it later
        this.consoleHandler = (msg: any) => {
            if (!this.mutationObserverActive) return;

            const text = msg.text();
            if (text.startsWith('[SR-MUTATION]')) {
                try {
                    const data = JSON.parse(text.replace('[SR-MUTATION]', ''));
                    if (this.mutationCallback) {
                        this.mutationCallback(data);
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            }
        };

        // Listen for console messages from the mutation observer
        this.page.on('console', this.consoleHandler);

        // Inject the MutationObserver script
        await this.injectMutationObserverScript();
    }

    /**
     * Re-injects the MutationObserver after page navigation.
     * Call this from onPageLoad callback if mutation observation is active.
     */
    async reinjectMutationObserver(): Promise<void> {
        if (!this.mutationObserverActive || !this.page) return;
        await this.injectMutationObserverScript();
    }

    /**
     * Injects the MutationObserver script into the page.
     */
    private async injectMutationObserverScript(): Promise<void> {
        if (!this.page) return;

        // Note: Using a string to avoid TypeScript helper injection issues in browser context
        // Config values are interpolated from MUTATION_OBSERVER_CONFIG
        const mutationObserverScript = `
            (function() {
                // Skip if already installed
                if (window.__srMutationObserver) return;

                // Configuration (injected from MUTATION_OBSERVER_CONFIG)
                var RATE_LIMIT_MS = ${MUTATION_OBSERVER_CONFIG.rateLimitMs};
                var MAX_MUTATIONS_PER_BATCH = ${MUTATION_OBSERVER_CONFIG.maxMutationsPerBatch};
                var MAX_QUEUE_SIZE = ${MUTATION_OBSERVER_CONFIG.maxQueueSize};
                var DUPLICATE_WINDOW_MS = ${MUTATION_OBSERVER_CONFIG.duplicateWindowMs};

                var pendingMutations = [];
                var batchTimeout = null;
                var recentLiveRegions = {};

                // Cleanup function exposed for disconnect
                function cleanup() {
                    if (batchTimeout) {
                        clearTimeout(batchTimeout);
                        batchTimeout = null;
                    }
                    pendingMutations = [];
                    recentLiveRegions = {};
                }

                function isDuplicateLiveRegion(nodeId, content) {
                    var key = nodeId + '::' + content;
                    var now = Date.now();

                    // Clean old entries
                    for (var k in recentLiveRegions) {
                        if (now - recentLiveRegions[k] > DUPLICATE_WINDOW_MS) {
                            delete recentLiveRegions[k];
                        }
                    }

                    if (recentLiveRegions[key]) {
                        return true;  // Duplicate
                    }

                    recentLiveRegions[key] = now;
                    return false;
                }

                function processMutationBatch() {
                    batchTimeout = null;
                    if (pendingMutations.length === 0) return;

                    var toProcess = pendingMutations.slice(0, MAX_MUTATIONS_PER_BATCH);
                    pendingMutations = pendingMutations.slice(MAX_MUTATIONS_PER_BATCH);

                    if (pendingMutations.length > 0 && !batchTimeout) {
                        batchTimeout = setTimeout(processMutationBatch, RATE_LIMIT_MS);
                    }

                    var summary = [];

                    for (var i = 0; i < toProcess.length; i++) {
                        var mutation = toProcess[i];

                        if (mutation.type === 'childList' || mutation.type === 'characterData') {
                            var target = mutation.target;
                            var liveRegion = target.closest && target.closest('[aria-live]');
                            if (!liveRegion && target.nodeType === Node.ELEMENT_NODE) {
                                liveRegion = target.getAttribute && target.getAttribute('aria-live') ? target : null;
                            }

                            if (liveRegion) {
                                var el = liveRegion instanceof Element ? liveRegion : (target.closest ? target.closest('[aria-live]') : null);
                                if (el) {
                                    var live = el.getAttribute('aria-live');
                                    var busy = el.getAttribute('aria-busy');
                                    var atomic = el.getAttribute('aria-atomic');

                                    if (busy === 'true') continue;

                                    var content = (el.textContent || '').trim();
                                    var nodeId = el.id || el.getAttribute('data-sr-id') || null;

                                    // Skip duplicates
                                    if (isDuplicateLiveRegion(nodeId || 'unknown', content)) continue;

                                    summary.push({
                                        type: 'liveRegion',
                                        politeness: live === 'assertive' ? 'assertive' : 'polite',
                                        atomic: atomic === 'true',
                                        content: content,
                                        nodeId: nodeId
                                    });
                                }
                            }
                        }

                        if (mutation.type === 'childList') {
                            var addedNodes = mutation.addedNodes;
                            for (var j = 0; j < addedNodes.length; j++) {
                                var node = addedNodes[j];
                                if (node.nodeType === Node.ELEMENT_NODE) {
                                    var addedEl = node;
                                    if (addedEl.matches && addedEl.matches('[role="dialog"], [role="alertdialog"], dialog')) {
                                        var labelEl = addedEl.querySelector('[aria-labelledby]');
                                        summary.push({
                                            type: 'dialogOpened',
                                            name: addedEl.getAttribute('aria-label') || (labelEl ? labelEl.textContent : null) || 'Dialog'
                                        });
                                    }
                                    if (addedEl.matches && addedEl.matches('[role="alert"]')) {
                                        summary.push({
                                            type: 'alert',
                                            content: (addedEl.textContent || '').trim()
                                        });
                                    }
                                }
                            }

                            var removedNodes = mutation.removedNodes;
                            for (var k = 0; k < removedNodes.length; k++) {
                                var removedNode = removedNodes[k];
                                if (removedNode.nodeType === Node.ELEMENT_NODE) {
                                    var removedEl = removedNode;
                                    if (removedEl.matches && removedEl.matches('[role="dialog"], [role="alertdialog"], dialog')) {
                                        summary.push({ type: 'dialogClosed' });
                                    }
                                }
                            }
                        }

                        if (mutation.type === 'attributes') {
                            var attr = mutation.attributeName;
                            var attrTarget = mutation.target;
                            // Track more aria attributes
                            if (attr === 'aria-expanded' || attr === 'aria-selected' ||
                                attr === 'aria-checked' || attr === 'aria-pressed' ||
                                attr === 'aria-hidden' || attr === 'aria-disabled' ||
                                attr === 'aria-invalid' || attr === 'aria-current') {
                                var value = attrTarget.getAttribute(attr);
                                var attrName = attrTarget.getAttribute('aria-label') || ((attrTarget.textContent || '').trim().slice(0, 50));
                                summary.push({
                                    type: 'stateChange',
                                    attribute: attr,
                                    value: value,
                                    name: attrName
                                });
                            }
                        }
                    }

                    if (summary.length > 0) {
                        console.log('[SR-MUTATION]' + JSON.stringify(summary));
                    }
                }

                var observer = new MutationObserver(function(mutations) {
                    // Enforce queue size limit - drop oldest if full
                    var available = MAX_QUEUE_SIZE - pendingMutations.length;
                    if (available <= 0) {
                        // Queue is full, drop oldest mutations
                        pendingMutations = pendingMutations.slice(mutations.length);
                    }

                    pendingMutations.push.apply(pendingMutations, mutations);

                    if (!batchTimeout) {
                        batchTimeout = setTimeout(processMutationBatch, RATE_LIMIT_MS);
                    }
                });

                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                    attributes: true,
                    attributeFilter: [
                        'aria-live', 'aria-expanded', 'aria-selected', 'aria-checked',
                        'aria-pressed', 'aria-busy', 'aria-hidden', 'aria-disabled',
                        'aria-invalid', 'aria-current'
                    ]
                });

                // Store reference and cleanup function
                window.__srMutationObserver = observer;
                window.__srMutationCleanup = cleanup;
            })();
        `;

        try {
            await this.page.evaluate(mutationObserverScript);
        } catch (error: any) {
            if (!isNavigationError(error)) {
                console.warn('[BrowserClient] Failed to inject mutation observer:', error.message);
            }
        }
    }

    /**
     * Stops mutation observation and cleans up all resources.
     */
    async stopMutationObserver(): Promise<void> {
        this.mutationObserverActive = false;
        this.mutationCallback = null;

        // Remove console listener
        if (this.page && this.consoleHandler) {
            this.page.off('console', this.consoleHandler);
            this.consoleHandler = null;
        }

        // Disconnect observer and clear timeout in page
        if (this.page) {
            try {
                await this.page.evaluate(() => {
                    // Call cleanup to clear pending timeout
                    if ((window as any).__srMutationCleanup) {
                        (window as any).__srMutationCleanup();
                        (window as any).__srMutationCleanup = null;
                    }
                    // Disconnect observer
                    if ((window as any).__srMutationObserver) {
                        (window as any).__srMutationObserver.disconnect();
                        (window as any).__srMutationObserver = null;
                    }
                });
            } catch (error: any) {
                if (!isNavigationError(error)) {
                    console.warn('[BrowserClient] Error stopping mutation observer:', error.message);
                }
            }
        }
    }

    /**
     * Check if mutation observer is currently active.
     */
    isMutationObserverActive(): boolean {
        return this.mutationObserverActive;
    }
}

/**
 * Summary of a DOM mutation for screen reader announcement.
 */
export interface MutationSummary {
    type: 'liveRegion' | 'dialogOpened' | 'dialogClosed' | 'alert' | 'stateChange';
    politeness?: 'polite' | 'assertive';
    atomic?: boolean;
    content?: string;
    name?: string;
    attribute?: string;
    value?: string;
    nodeId?: string | null;
}
