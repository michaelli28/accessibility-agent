import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BrowserClient } from '../src/playwrightClient';
import { ScreenReaderDriver } from '../src/ScreenReaderDriver';

const PORT = 3000;

// Simple HTTP server to serve static files
const httpServer = createServer((req, res) => {
    const url = req.url === '/' ? '/index.html' : req.url;
    const filePath = join(__dirname, url || '');

    try {
        const content = readFileSync(filePath);
        const ext = filePath.split('.').pop();
        const contentTypes: Record<string, string> = {
            'html': 'text/html',
            'css': 'text/css',
            'js': 'application/javascript'
        };
        res.writeHead(200, { 'Content-Type': contentTypes[ext || 'html'] || 'text/plain' });
        res.end(content);
    } catch {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// WebSocket server
const wss = new WebSocketServer({ server: httpServer });

let browserClient: BrowserClient | null = null;
let driver: ScreenReaderDriver | null = null;
let currentUrl: string = '';

// Broadcast to all connected clients
function broadcast(message: object): void {
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Handle console messages from the browser
function handleConsoleMessage(msg: string): void {
    if (msg.startsWith('[SR] ')) {
        const text = msg.replace('[SR] ', '');
        broadcast({ type: 'speech', text });
    } else if (msg.startsWith('[SR Tree] ')) {
        const json = msg.replace('[SR Tree] ', '');
        try {
            const tree = JSON.parse(json);
            broadcast({ type: 'tree', tree });
        } catch (e) {
            console.error('Failed to parse tree data:', e);
        }
    } else if (msg.startsWith('[SR Stats] ')) {
        // Already included in tree data, skip
    }
}

async function navigateToUrl(url: string): Promise<void> {
    console.log(`[Server] Navigating to: ${url}`);

    if (browserClient) {
        await browserClient.close();
    }

    browserClient = new BrowserClient();
    await browserClient.launch(false); // headless: false

    // Set up console listener BEFORE navigation
    browserClient.onConsoleMessage(handleConsoleMessage);

    await browserClient.goto(url);
    currentUrl = url;

    driver = new ScreenReaderDriver(browserClient);
    await driver.enable();

    broadcast({
        type: 'navigated',
        url,
        title: await browserClient.getTitle()
    });
}

async function handleKeyPress(key: string): Promise<void> {
    if (!driver) {
        broadcast({ type: 'error', message: 'No page loaded' });
        return;
    }

    console.log(`[Server] Key press: ${key}`);
    const result = await driver.performAction({ type: 'KEY_PRESS', key });

    broadcast({
        type: 'action_result',
        success: result.success,
        snapshot: result.snapshot
    });
}

async function getPathTo(targetId: string): Promise<void> {
    if (!browserClient) {
        broadcast({ type: 'error', message: 'No page loaded' });
        return;
    }

    try {
        const result = await browserClient.getPage()?.evaluate((id: string) => {
            const sr = (window as any).adfScreenReader;
            if (sr && sr.getPathTo) {
                return sr.getPathTo(id);
            }
            return { found: false, keys: [], targetId: id };
        }, targetId);

        broadcast({ type: 'path_result', ...result });
    } catch (error) {
        broadcast({ type: 'error', message: `Failed to get path: ${error}` });
    }
}

async function navigateTo(targetId: string): Promise<void> {
    if (!browserClient || !driver) {
        broadcast({ type: 'error', message: 'No page loaded' });
        return;
    }

    try {
        // Get the path first
        const result = await browserClient.getPage()?.evaluate((id: string) => {
            const sr = (window as any).adfScreenReader;
            if (sr && sr.getPathTo) {
                return sr.getPathTo(id);
            }
            return { found: false, keys: [], targetId: id };
        }, targetId);

        if (!result || !result.found) {
            broadcast({ type: 'error', message: 'No path found to target' });
            return;
        }

        console.log(`[Server] Navigating to ${targetId} via: ${result.keys.join(' → ')}`);

        // Execute each keystroke
        for (const key of result.keys) {
            await driver.performAction({ type: 'KEY_PRESS', key });
            // Small delay between keystrokes for UI to update
            await new Promise(resolve => setTimeout(resolve, 150));
        }

        broadcast({ type: 'navigation_complete', targetId, keys: result.keys });
    } catch (error) {
        broadcast({ type: 'error', message: `Navigation failed: ${error}` });
    }
}

wss.on('connection', (ws) => {
    console.log('[Server] Client connected');

    // Send current state to new client
    ws.send(JSON.stringify({
        type: 'connected',
        url: currentUrl || null
    }));

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());

            switch (message.type) {
                case 'navigate':
                    await navigateToUrl(message.url);
                    break;
                case 'keypress':
                    await handleKeyPress(message.key);
                    break;
                case 'getPath':
                    await getPathTo(message.targetId);
                    break;
                case 'navigateTo':
                    await navigateTo(message.targetId);
                    break;
                default:
                    console.log('[Server] Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('[Server] Error handling message:', error);
            broadcast({ type: 'error', message: String(error) });
        }
    });

    ws.on('close', () => {
        console.log('[Server] Client disconnected');
    });
});

httpServer.listen(PORT, () => {
    console.log(`[Server] Running at http://localhost:${PORT}`);
    console.log('[Server] Open this URL in your browser to use the visualizer');
});

// Cleanup on exit
process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    if (browserClient) {
        await browserClient.close();
    }
    process.exit(0);
});
