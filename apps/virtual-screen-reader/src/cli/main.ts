import { BrowserClient } from '../playwrightClient';
import { ScreenReaderDriver } from '../ScreenReaderDriver';
import * as readline from 'readline';

async function main() {
    const url = process.argv[2];
    if (!url) {
        console.error('Please provide a URL. Usage: npm start <url>');
        process.exit(1);
    }

    console.log(`[Harness] Launching browser for ${url}...`);
    const client = new BrowserClient();
    await client.launch(false); // headless: false to see the browser

    try {
        await client.goto(url);
        console.log('[Harness] Page loaded.');

        const driver = new ScreenReaderDriver(client);
        await driver.enable();

        console.log('\n--- Interactive Mode ---');
        console.log('Controls:');
        console.log('  ↓ (Arrow Down)    - Next Item');
        console.log('  ↑ (Arrow Up)      - Previous Item');
        console.log('  H                 - Next Heading');
        console.log('  Shift+H           - Previous Heading');
        console.log('  L                 - Next List');
        console.log('  Shift+L           - Previous List');
        console.log('  Enter             - Activate Element');
        console.log('  Q / Ctrl+C        - Quit\n');

        // Initial state
        let snapshot = await driver.getPerceptualOutput();
        logSnapshot('Initial', snapshot);

        // Enable raw mode to capture individual keypresses
        if (process.stdin.isTTY) {
            readline.emitKeypressEvents(process.stdin);
            process.stdin.setRawMode(true);
        }

        let isProcessing = false;

        const handleKeypress = async (str: string, key: any) => {
            // Prevent concurrent action processing
            if (isProcessing) return;

            // Handle Ctrl+C
            if (key && key.ctrl && key.name === 'c') {
                console.log('\n[Harness] Exiting...');
                process.exit(0);
            }

            // Handle quit
            if (key && (key.name === 'q' || key.name === 'Q')) {
                console.log('\n[Harness] Quitting...');
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
                process.stdin.pause();
                return;
            }

            isProcessing = true;

            try {
                let actionKey = '';

                // Map keypresses to screen reader actions
                if (key) {
                    switch (key.name) {
                        case 'down':
                            actionKey = 'ArrowDown';
                            console.log('\n[Input] ↓ Next Item');
                            break;
                        case 'up':
                            actionKey = 'ArrowUp';
                            console.log('\n[Input] ↑ Previous Item');
                            break;
                        case 'h':
                            if (key.shift) {
                                actionKey = 'Shift+h';
                                console.log('\n[Input] Shift+H - Previous Heading');
                            } else {
                                actionKey = 'h';
                                console.log('\n[Input] H - Next Heading');
                            }
                            break;
                        case 'l':
                            if (key.shift) {
                                actionKey = 'Shift+l';
                                console.log('\n[Input] Shift+L - Previous List');
                            } else {
                                actionKey = 'l';
                                console.log('\n[Input] L - Next List');
                            }
                            break;
                        case 'return':
                        case 'enter':
                            actionKey = 'Enter';
                            console.log('\n[Input] Enter - Activate');
                            break;
                    }
                }

                if (actionKey) {
                    const result = await driver.performAction({ type: 'KEY_PRESS', key: actionKey });
                    if (result.success) {
                        logSnapshot('SR', result.snapshot);
                    } else {
                        console.error(`[Error] ${result.message}`);
                    }
                }
            } catch (error) {
                console.error('[Error]', error);
            } finally {
                isProcessing = false;
            }
        };

        process.stdin.on('keypress', handleKeypress);

        // Wait for stdin to close
        await new Promise((resolve) => {
            process.stdin.on('close', resolve);
        });

    } catch (error) {
        console.error('[Harness] Error:', error);
    } finally {
        console.log('\n[Harness] Closing browser...');
        await client.close();
    }
}

function logSnapshot(prefix: string, snapshot: any) {
    console.log(`[${prefix}] Spoken: "${snapshot.text}"`);
}

main();
