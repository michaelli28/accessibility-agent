import { BrowserClient, ScreenReaderDriver } from '@adf/virtual-screen-reader';
import * as readline from 'readline';

/**
 * Interactive test harness for the AX-tree-based screen reader.
 *
 * Usage: npm run dev:sr <url>
 */

const HELP_TEXT = `
--- Screen Reader Test Harness (AX-Tree Mode) ---

Navigation Commands (Browse Mode):
  n, ↓, [Enter]  Next element
  p, ↑           Previous element
  h              Next heading
  H, shift+h     Previous heading
  1-6            Next heading of level 1-6
  b              Next button
  B, shift+b     Previous button
  k              Next link
  K, shift+k     Previous link
  f              Next form field
  F, shift+f     Previous form field
  t              Next table
  T, shift+t     Previous table
  l              Next list
  L, shift+l     Previous list
  d              Next landmark
  D, shift+d     Previous landmark
  q              Jump to main content
  tab            Next focusable element
  shift+tab      Previous focusable element

Table Navigation (inside tables):
  ctrl+alt+right Move to next column
  ctrl+alt+left  Move to previous column
  ctrl+alt+down  Move to next row
  ctrl+alt+up    Move to previous row

Actions:
  enter          Activate current element
  space          Press space (toggle checkboxes, etc.)
  type <text>    Type text into current element

Modes:
  - Browse Mode: Navigate with arrow keys and shortcuts
  - Forms Mode: Auto-enters when focusing text inputs
                Keys pass through to the input
                Press Escape to return to Browse Mode

Other:
  r, refresh     Force refresh AX tree
  s, state       Show navigator state (debug)
  m, mode        Show current interaction mode
  help, ?        Show this help
  quit, exit     Exit the harness
`;

async function main() {
    const url = process.argv[2];
    if (!url) {
        console.error('Please provide a URL. Usage: npm run dev:sr <url>');
        process.exit(1);
    }

    console.log(`[Harness] Launching browser for ${url}...`);
    const client = new BrowserClient();
    await client.launch(false); // headed mode
    await client.goto(url);

    const driver = new ScreenReaderDriver(client, console.log, {
        verbose: true,
        enableLiveRegions: true,
    });
    await driver.enable();

    try {
        console.log('[Harness] Page loaded. Screen reader initialized.');
        console.log('Type "help" or "?" for available commands.\n');

        // Initial state
        let snapshot = await driver.getPerceptualOutput();
        logSnapshot('Initial', snapshot);

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.setPrompt('SR> ');
        rl.prompt();

        rl.on('line', async (line) => {
            const input = line.trim();
            const inputLower = input.toLowerCase();

            // Exit commands
            if (inputLower === 'quit' || inputLower === 'exit') {
                rl.close();
                return;
            }

            // Help
            if (inputLower === 'help' || inputLower === '?') {
                console.log(HELP_TEXT);
                rl.prompt();
                return;
            }

            // State/debug
            if (inputLower === 's' || inputLower === 'state') {
                const state = driver.getNavigatorState();
                console.log('\n[Navigator State]');
                if (state.currentNode) {
                    console.log(`  Role: ${state.currentNode.computedRole}`);
                    console.log(`  Name: "${state.currentNode.computedName}"`);
                    console.log(`  NodeId: ${state.currentNode.nodeId}`);
                    console.log(`  BackendDOMNodeId: ${state.currentNode.backendDOMNodeId}`);
                    console.log(`  States: ${JSON.stringify(state.currentNode.states, null, 2)}`);
                } else {
                    console.log('  No current node');
                }
                console.log(`  Cache: ${JSON.stringify(state.cacheStats)}`);
                console.log('');
                rl.prompt();
                return;
            }

            // Refresh
            if (inputLower === 'r' || inputLower === 'refresh') {
                console.log('[Harness] Forcing AX tree refresh...');
                await driver.forceRefresh();
                const snapshot = await driver.getPerceptualOutput();
                logSnapshot('Refreshed', snapshot);
                rl.prompt();
                return;
            }

            // Mode
            if (inputLower === 'm' || inputLower === 'mode') {
                const mode = driver.getMode();
                console.log(`\n[Mode] Current: ${mode}`);
                console.log(mode === 'browse'
                    ? '  Use arrow keys to navigate. Enter to activate.'
                    : '  Keys go directly to input. Press Escape to exit.');
                console.log('');
                rl.prompt();
                return;
            }

            // Type command
            if (inputLower.startsWith('type ')) {
                const text = input.slice(5);
                const result = await driver.performAction({ type: 'TYPE', text });
                logSnapshot('Type', result.snapshot);
                rl.prompt();
                return;
            }

            // Navigation key mapping
            let actionKey = '';

            // Map shortcut commands to keys
            switch (inputLower) {
                case '':
                case 'n':
                    actionKey = 'ArrowDown';
                    break;
                case 'p':
                    actionKey = 'ArrowUp';
                    break;
                case 'h':
                    actionKey = 'h';
                    break;
                case 'shift+h':
                    actionKey = 'H';
                    break;
                case 'b':
                    actionKey = 'b';
                    break;
                case 'shift+b':
                    actionKey = 'B';
                    break;
                case 'k':
                    actionKey = 'k';
                    break;
                case 'shift+k':
                    actionKey = 'K';
                    break;
                case 'f':
                    actionKey = 'f';
                    break;
                case 'shift+f':
                    actionKey = 'F';
                    break;
                case 't':
                    actionKey = 't';
                    break;
                case 'shift+t':
                    actionKey = 'T';
                    break;
                case 'l':
                    actionKey = 'l';
                    break;
                case 'shift+l':
                    actionKey = 'L';
                    break;
                case 'd':
                    actionKey = 'd';
                    break;
                case 'shift+d':
                    actionKey = 'D';
                    break;
                case 'q':
                    actionKey = 'q';
                    break;
                case 'tab':
                    actionKey = 'Tab';
                    break;
                case 'shift+tab':
                    actionKey = 'Shift+Tab';
                    break;
                case 'enter':
                    actionKey = 'Enter';
                    break;
                case 'space':
                    actionKey = 'Space';
                    break;
                case '1':
                case '2':
                case '3':
                case '4':
                case '5':
                case '6':
                    actionKey = inputLower;
                    break;
                // Table navigation
                case 'ctrl+alt+right':
                    actionKey = 'Control+Alt+ArrowRight';
                    break;
                case 'ctrl+alt+left':
                    actionKey = 'Control+Alt+ArrowLeft';
                    break;
                case 'ctrl+alt+down':
                    actionKey = 'Control+Alt+ArrowDown';
                    break;
                case 'ctrl+alt+up':
                    actionKey = 'Control+Alt+ArrowUp';
                    break;
                case 'escape':
                case 'esc':
                    actionKey = 'Escape';
                    break;
                default:
                    // Handle uppercase single chars (for Shift+key navigation)
                    if (input.length === 1 && input !== inputLower) {
                        actionKey = input; // Pass uppercase char as-is
                    }
            }

            if (actionKey) {
                const result = await driver.performAction({ type: 'KEY_PRESS', key: actionKey });
                if (result.success) {
                    logSnapshot('Action', result.snapshot);
                } else {
                    console.error(`[Error] ${result.message}`);
                }
            } else if (input) {
                console.log(`Unknown command: "${input}". Type "help" for available commands.`);
            }

            rl.prompt();
        });

        await new Promise((resolve) => {
            rl.on('close', resolve);
        });

    } catch (error) {
        console.error('[Harness] Error:', error);
    } finally {
        console.log('\n[Harness] Closing browser...');
        await driver.disable();
        await client.close();
    }
}

function logSnapshot(prefix: string, snapshot: any) {
    console.log(`\n[${prefix}] ${snapshot.text}`);
    if (snapshot.pageTitle) {
        console.log(`[Page] ${snapshot.pageTitle} - ${snapshot.pageUrl}`);
    }
    if (snapshot.cursorBox) {
        const { x, y, width, height } = snapshot.cursorBox;
        console.log(`[Box] x:${Math.round(x)}, y:${Math.round(y)}, w:${Math.round(width)}, h:${Math.round(height)}`);
    }
}

main();
