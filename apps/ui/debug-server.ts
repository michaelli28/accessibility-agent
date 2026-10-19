import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { BrowserClient, ScreenReaderDriver } from '@adf/virtual-screen-reader';
import { AgentOpenrouter } from '../agent/src/AgentOpenrouter';
import { AgentMinimal, DebugEvent as MinimalDebugEvent } from '../agent/src/AgentMinimal';
import { AgentStepwise } from '../agent/src/AgentStepwise';
import { DebugEvent } from '../agent/src/types';
import {
  loadTestCases,
  listBenchmarkReports,
  loadBenchmarkReport,
  runBenchmark,
} from '../agent/benchmarks/runner';
import { BenchmarkEvent } from '../agent/benchmarks/types';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.DEBUG_PORT || 3001;

// Serve static files from debug-public
app.use(express.static(path.join(__dirname, 'debug-public')));

// Track active sessions
interface DebugSession {
  // For full agent (AgentOpenrouter)
  client: BrowserClient | null;
  driver: ScreenReaderDriver | null;
  // For minimal agent (AgentMinimal)
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  // Common
  isRunning: boolean;
  manualOversight: boolean;
  pendingConfirmation: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null;
  // Benchmark cancellation
  benchmarkAbortController: AbortController | null;
}

const sessions = new Map<WebSocket, DebugSession>();

// Send message helper
function send(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Debug client connected');

  sessions.set(ws, {
    client: null,
    driver: null,
    browser: null,
    context: null,
    page: null,
    isRunning: false,
    manualOversight: false,
    pendingConfirmation: null,
    benchmarkAbortController: null
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
    console.log('Debug client disconnected');
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
    case 'confirm':
      // User confirmed the LLM request - resolve the pending promise
      if (session.pendingConfirmation) {
        session.pendingConfirmation.resolve();
        session.pendingConfirmation = null;
      }
      break;
    case 'reject':
      // User rejected - stop the agent
      if (session.pendingConfirmation) {
        session.pendingConfirmation.reject(new Error('User rejected LLM request'));
        session.pendingConfirmation = null;
      }
      break;

    // Benchmark commands
    case 'get_test_cases':
      send(ws, { type: 'test_cases', testCases: loadTestCases() });
      break;

    case 'get_reports':
      send(ws, { type: 'benchmark_reports', reports: listBenchmarkReports() });
      break;

    case 'get_report':
      const report = loadBenchmarkReport(data.reportId);
      if (report) {
        send(ws, { type: 'benchmark_report', report });
      } else {
        send(ws, { type: 'error', message: `Report not found: ${data.reportId}` });
      }
      break;

    case 'run_benchmark':
      await handleRunBenchmark(ws, session, data);
      break;

    case 'stop_benchmark':
      await handleStopBenchmark(ws, session);
      break;

    default:
      send(ws, { type: 'error', message: `Unknown command: ${data.type}` });
  }
}

// Run the agent with debug events
async function runAgent(
  ws: WebSocket,
  session: DebugSession,
  data: { url: string; goal: string; model?: string; apiKey?: string; manualOversight?: boolean; agentType?: 'full' | 'minimal'; stepwise?: boolean; navigationMode?: 'default' | 'pagerank' }
) {
  if (session.isRunning) {
    send(ws, { type: 'error', message: 'Agent is already running' });
    return;
  }

  const { url, goal, model, apiKey, manualOversight, agentType = 'full', stepwise = false, navigationMode = 'default' } = data;

  if (!url || !goal) {
    send(ws, { type: 'error', message: 'URL and goal are required' });
    return;
  }

  // Clean up any existing session
  await cleanupSession(ws);

  session.isRunning = true;
  session.manualOversight = manualOversight || false;

  // Debug event handler - sends all events to the UI
  const onDebug = (event: DebugEvent | MinimalDebugEvent) => {
    send(ws, { type: 'debug_event', event });
  };

  try {
    // Manual oversight callback - waits for user confirmation before each LLM call
    const beforeLlmRequest = session.manualOversight
      ? async (loopCount: number, messages: unknown[]) => {
          send(ws, {
            type: 'awaiting_confirmation',
            loopCount,
            messageCount: (messages as any[]).length
          });
          return new Promise<void>((resolve, reject) => {
            session.pendingConfirmation = { resolve, reject };
          });
        }
      : undefined;

    if (agentType === 'minimal') {
      // ========== MINIMAL MODE (Playwright only) ==========
      const modeLabel = stepwise ? 'stepwise + minimal' : 'minimal';
      send(ws, { type: 'status', message: `Launching browser (${modeLabel} mode)...` });
      // Use same browser settings as full screen reader mode
      session.browser = await chromium.launch({
        headless: false,
        channel: 'chrome',
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--start-maximized'],
      });
      session.context = await session.browser.newContext({
        viewport: null,
        hasTouch: false,
      });
      session.page = await session.context.newPage();
      await session.page.goto(url, { waitUntil: 'domcontentloaded' });

      // Send initial screenshot
      try {
        const buffer = await session.page.screenshot();
        const base64 = buffer.toString('base64');
        send(ws, { type: 'screenshot', screenshot: base64, url });
      } catch (e) {
        console.error('Failed to capture screenshot:', e);
      }

      if (stepwise) {
        // Stepwise + Minimal
        const agent = new AgentStepwise({
          navigationMode: 'minimal',
          page: session.page,
          apiKey: apiKey || process.env['OPENROUTER_API_KEY'],
          model: model || 'google/gemini-2.0-flash-001',
          onLog: (msg) => console.log(msg),
          onDebug,
          beforeLlmRequest,
        });

        send(ws, { type: 'status', message: 'Starting stepwise + minimal agent...' });
        const trace = await agent.run(goal);

        // Final screenshot
        if (session.page) {
          try {
            const buffer = await session.page.screenshot();
            const base64 = buffer.toString('base64');
            const currentUrl = session.page.url();
            send(ws, { type: 'screenshot', screenshot: base64, url: currentUrl });
          } catch (e) {
            console.error('Failed to capture final screenshot:', e);
          }
        }

        // Send completion
        const totalSteps = trace.stepTraces.reduce((sum, st) => sum + st.steps.length, 0);
        send(ws, {
          type: 'complete',
          success: trace.success,
          error: trace.error,
          reason: trace.reason,
          totalSteps,
          parsedSteps: trace.parsedSteps.length,
          failedAtStep: trace.failedAtStep,
        });
      } else {
        // Direct Minimal
        const agent = new AgentMinimal({
          page: session.page,
          apiKey: apiKey || process.env['OPENROUTER_API_KEY'],
          model: model || 'google/gemini-2.0-flash-001',
          onLog: (msg) => console.log(msg),
          onDebug,
          beforeLlmRequest,
          navigationMode,
        });

        send(ws, { type: 'status', message: 'Starting minimal agent...' });
        const trace = await agent.run(goal);

        // Final screenshot
        if (session.page) {
          try {
            const buffer = await session.page.screenshot();
            const base64 = buffer.toString('base64');
            const currentUrl = session.page.url();
            send(ws, { type: 'screenshot', screenshot: base64, url: currentUrl });
          } catch (e) {
            console.error('Failed to capture final screenshot:', e);
          }
        }

        // Send completion
        send(ws, {
          type: 'complete',
          success: trace.success,
          error: trace.error,
          reason: trace.reason,
          totalSteps: trace.steps.length
        });
      }
    } else {
      // ========== FULL MODE (BrowserClient + ScreenReaderDriver) ==========
      const modeLabel = stepwise ? 'stepwise + full' : 'full';
      send(ws, { type: 'status', message: `Launching browser (${modeLabel} mode)...` });
      session.client = new BrowserClient();
      await session.client.launch(false); // headed mode
      await session.client.goto(url);

      session.driver = new ScreenReaderDriver(session.client);
      await session.driver.enable();

      // Send initial screenshot
      try {
        const buffer = await session.client.screenshot();
        const base64 = buffer.toString('base64');
        send(ws, { type: 'screenshot', screenshot: base64, url });
      } catch (e) {
        console.error('Failed to capture screenshot:', e);
      }

      // Step handler - sends screenshot after each step
      const onStep = async () => {
        if (session.client) {
          try {
            await new Promise(resolve => setTimeout(resolve, 200));
            const buffer = await session.client.screenshot();
            const base64 = buffer.toString('base64');
            const page = session.client.getPage();
            const currentUrl = page ? page.url() : url;
            send(ws, { type: 'screenshot', screenshot: base64, url: currentUrl });
          } catch (e) {
            console.error('Failed to capture screenshot:', e);
          }
        }
      };

      if (stepwise) {
        // Stepwise + Full
        const agent = new AgentStepwise({
          navigationMode: 'full',
          driver: session.driver,
          apiKey: apiKey || process.env['OPENROUTER_API_KEY'],
          model: model || 'google/gemini-2.0-flash-001',
          onLog: (msg) => console.log(msg),
          onDebug,
          beforeLlmRequest,
          onStep,
        });

        send(ws, { type: 'status', message: 'Starting stepwise + full agent...' });
        const trace = await agent.run(goal);

        // Final screenshot
        if (session.client) {
          try {
            const buffer = await session.client.screenshot();
            const base64 = buffer.toString('base64');
            const page = session.client.getPage();
            const currentUrl = page ? page.url() : url;
            send(ws, { type: 'screenshot', screenshot: base64, url: currentUrl });
          } catch (e) {
            console.error('Failed to capture final screenshot:', e);
          }
        }

        // Send completion
        const totalSteps = trace.stepTraces.reduce((sum, st) => sum + st.steps.length, 0);
        send(ws, {
          type: 'complete',
          success: trace.success,
          error: trace.error,
          reason: trace.reason,
          totalSteps,
          parsedSteps: trace.parsedSteps.length,
          failedAtStep: trace.failedAtStep,
        });
      } else {
        // Direct Full
        const agent = new AgentOpenrouter({
          driver: session.driver,
          onStep,
          apiKey: apiKey || process.env['OPENROUTER_API_KEY'],
          model: model || 'google/gemini-2.0-flash-001',
          onDebug,
          beforeLlmRequest,
          navigationMode,
          entryUrl: url,
        });

        send(ws, { type: 'status', message: 'Starting full agent...' });
        const trace = await agent.run(goal);

        // Final screenshot
        if (session.client) {
          try {
            const buffer = await session.client.screenshot();
            const base64 = buffer.toString('base64');
            const page = session.client.getPage();
            const currentUrl = page ? page.url() : url;
            send(ws, { type: 'screenshot', screenshot: base64, url: currentUrl });
          } catch (e) {
            console.error('Failed to capture final screenshot:', e);
          }
        }

        // Send completion
        send(ws, {
          type: 'complete',
          success: trace.success,
          error: trace.error,
          reason: trace.reason,
          totalSteps: trace.steps.length
        });
      }
    }

  } catch (error: any) {
    console.error('Agent error:', error);
    send(ws, {
      type: 'complete',
      success: false,
      error: error.message || 'Agent execution failed'
    });
  } finally {
    session.isRunning = false;
    session.pendingConfirmation = null;
  }
}

// Run benchmark with real-time updates
async function handleRunBenchmark(
  ws: WebSocket,
  session: DebugSession,
  data: {
    testCaseIds: string[];
    models: string[];
    runsPerTestCase?: number;
    apiKey?: string;
    name?: string;
    agentType?: 'full' | 'minimal';
    stepwise?: boolean;
  }
) {
  if (session.isRunning) {
    send(ws, { type: 'error', message: 'Agent is already running' });
    return;
  }

  const { testCaseIds, models, runsPerTestCase, apiKey, name, agentType = 'full', stepwise = false } = data;

  if (!testCaseIds || testCaseIds.length === 0) {
    send(ws, { type: 'error', message: 'At least one test case ID is required' });
    return;
  }

  if (!models || models.length === 0) {
    send(ws, { type: 'error', message: 'At least one model is required' });
    return;
  }

  session.isRunning = true;
  session.benchmarkAbortController = new AbortController();

  try {
    const report = await runBenchmark({
      testCaseIds,
      models,
      runsPerTestCase: runsPerTestCase || 1,
      apiKey: apiKey || process.env['OPENROUTER_API_KEY'],
      name,
      agentType,
      stepwise,
      abortSignal: session.benchmarkAbortController.signal,
      onEvent: (event: BenchmarkEvent) => {
        send(ws, { type: 'benchmark_event', event });
      },
    });

    // Check if we were aborted
    if (session.benchmarkAbortController?.signal.aborted) {
      send(ws, { type: 'benchmark_stopped', report });
    } else {
      send(ws, { type: 'benchmark_complete', report });
    }
  } catch (error: any) {
    // Check if this was an abort
    if (error.name === 'AbortError' || session.benchmarkAbortController?.signal.aborted) {
      console.log('Benchmark stopped by user');
      send(ws, { type: 'benchmark_stopped', report: null });
    } else {
      console.error('Benchmark error:', error);
      send(ws, {
        type: 'benchmark_error',
        error: error.message || 'Benchmark failed',
      });
    }
  } finally {
    session.isRunning = false;
    session.benchmarkAbortController = null;
  }
}

// Stop benchmark
async function handleStopBenchmark(ws: WebSocket, session: DebugSession) {
  if (session.benchmarkAbortController) {
    console.log('Stopping benchmark...');
    session.benchmarkAbortController.abort();
    send(ws, { type: 'status', message: 'Stopping benchmark...' });
  } else {
    send(ws, { type: 'error', message: 'No benchmark is running' });
  }
}

// Stop the agent
async function stopAgent(ws: WebSocket, session: DebugSession) {
  // Reject any pending confirmation
  if (session.pendingConfirmation) {
    session.pendingConfirmation.reject(new Error('Agent stopped by user'));
    session.pendingConfirmation = null;
  }
  await cleanupSession(ws);
  send(ws, { type: 'status', message: 'Agent stopped' });
}

// Cleanup session
async function cleanupSession(ws: WebSocket) {
  const session = sessions.get(ws);
  if (!session) return;

  session.isRunning = false;

  // Clean up full agent resources
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

  // Clean up minimal agent resources
  if (session.page) {
    session.page = null;
  }

  if (session.browser) {
    try {
      await session.browser.close();
    } catch (e) {
      console.error('Error closing browser:', e);
    }
    session.browser = null;
  }
}

// Start server
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🔍 Agent Debug UI                                        ║
║                                                            ║
║   Server running at: http://localhost:${PORT}               ║
║                                                            ║
║   View all agent internals: messages, tool calls, etc.     ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');

  for (const [ws] of sessions) {
    await cleanupSession(ws);
    ws.close();
  }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
