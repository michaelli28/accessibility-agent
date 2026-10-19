import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { BrowserClient, ScreenReaderDriver } from '@adf/virtual-screen-reader';
import { Agent } from '../agent/src/Agent';
import { buildOpenAIModel } from '../agent/src/OpenAIClient';
import { buildGeminiModel } from '../agent/src/GeminiClient';
import { AgentStep, AgentTrace } from '../agent/src/types';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Track active agent sessions
interface AgentSession {
  client: BrowserClient | null;
  driver: ScreenReaderDriver | null;
  abortController: AbortController | null;
  isRunning: boolean;
}

const sessions = new Map<WebSocket, AgentSession>();

// Send message helper
function send(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Initialize session
  sessions.set(ws, {
    client: null,
    driver: null,
    abortController: null,
    isRunning: false
  });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      await handleMessage(ws, data);
    } catch (error: any) {
      console.error('Error handling message:', error);
      send(ws, { type: 'error', message: error.message || 'Unknown error' });
    }
  });

  ws.on('close', async () => {
    console.log('Client disconnected');
    await cleanupSession(ws);
    sessions.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Handle incoming messages
async function handleMessage(ws: WebSocket, data: any) {
  const session = sessions.get(ws);
  if (!session) return;

  switch (data.type) {
    case 'run':
      await runAgent(ws, session, data);
      break;
    case 'stop':
      await stopAgent(ws, session);
      break;
    default:
      send(ws, { type: 'error', message: `Unknown command: ${data.type}` });
  }
}

// Helper to capture and send screenshot
async function sendScreenshot(ws: WebSocket, client: BrowserClient) {
  try {
    const buffer = await client.screenshot();
    const base64 = buffer.toString('base64');
    const page = client.getPage();
    const currentUrl = page ? page.url() : '';
    send(ws, { type: 'screenshot', screenshot: base64, url: currentUrl });
  } catch (e) {
    console.error('Failed to capture screenshot:', e);
  }
}

// Run the agent
async function runAgent(ws: WebSocket, session: AgentSession, data: { url: string; goal: string; provider: string }) {
  if (session.isRunning) {
    send(ws, { type: 'error', message: 'Agent is already running' });
    return;
  }

  const { url, goal, provider } = data;

  if (!url || !goal) {
    send(ws, { type: 'error', message: 'URL and goal are required' });
    return;
  }

  // Clean up any existing session from previous run
  if (session.client) {
    try {
      await session.client.close();
    } catch (e) {
      // Ignore cleanup errors
    }
    session.client = null;
    session.driver = null;
  }

  session.isRunning = true;
  session.abortController = new AbortController();

  try {
    // Initialize browser and screen reader
    send(ws, { type: 'log', message: 'Launching browser...' });
    session.client = new BrowserClient();
    await session.client.launch(false); // headed mode
    await session.client.goto(url);

    session.driver = new ScreenReaderDriver(session.client);
    await session.driver.enable();

    // Send initial screenshot
    send(ws, { type: 'log', message: 'Capturing page...' });
    await sendScreenshot(ws, session.client);

    // Initialize model
    send(ws, { type: 'log', message: `Loading ${provider} model...` });
    const model = provider === 'gemini' ? buildGeminiModel() : buildOpenAIModel();

    // Create agent with step callback
    const agent = new Agent(session.driver, model, async (step: AgentStep) => {
      // Send step update
      send(ws, { type: 'step', step });

      // Send screenshot after each step
      if (session.client) {
        await sendScreenshot(ws, session.client);
      }
    });

    // Run the agent
    send(ws, { type: 'log', message: 'Starting agent execution...' });
    const trace: AgentTrace = await agent.run(goal);

    // Final screenshot
    if (session.client) {
      await sendScreenshot(ws, session.client);
    }

    // Send completion
    send(ws, {
      type: 'complete',
      success: trace.success,
      error: trace.error,
      reason: trace.reason,
      totalSteps: trace.steps.length
    });

  } catch (error: any) {
    console.error('Agent error:', error);
    send(ws, {
      type: 'complete',
      success: false,
      error: error.message || 'Agent execution failed'
    });
  } finally {
    session.isRunning = false;
  }
}

// Stop the agent
async function stopAgent(ws: WebSocket, session: AgentSession) {
  if (session.abortController) {
    session.abortController.abort();
  }
  await cleanupSession(ws);
  send(ws, { type: 'log', message: 'Agent stopped' });
}

// Cleanup session
async function cleanupSession(ws: WebSocket) {
  const session = sessions.get(ws);
  if (!session) return;

  session.isRunning = false;

  if (session.driver) {
    try {
      await session.driver.disable();
    } catch (e) {
      console.error('Error disabling driver:', e);
    }
    session.driver = null;
  }

  if (session.client) {
    try {
      await session.client.close();
    } catch (e) {
      console.error('Error closing browser:', e);
    }
    session.client = null;
  }

  session.abortController = null;
}

// Start server
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🤖 Accessibility Agent UI                                ║
║                                                            ║
║   Server running at: http://localhost:${PORT}               ║
║                                                            ║
║   Open this URL in your browser to start using the agent   ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');

  // Close all sessions
  for (const [ws] of sessions) {
    await cleanupSession(ws);
    ws.close();
  }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
