/**
 * This script tests the BrowserClient and ScreenReaderDriver from virtual-screen-reader.
 *
 * To test functionality, use:
 * - npm run dev:sr <url> - Interactive screen reader testing
 * - npm run start:agent <url> "<goal>" - Run the agent
 */

import { BrowserClient, ScreenReaderDriver } from '@adf/virtual-screen-reader';

async function main() {
  console.log('Testing BrowserClient + ScreenReaderDriver...');

  const client = new BrowserClient();
  await client.launch(false); // headed mode

  console.log('Navigating to example.com...');
  await client.goto('https://example.com');

  const driver = new ScreenReaderDriver(client);
  console.log('Enabling screen reader driver...');
  await driver.enable();

  console.log('Getting perceptual output...');
  const snapshot = await driver.getPerceptualOutput();
  console.log('Screen reader says:', snapshot.text);

  console.log('Taking screenshot...');
  const screenshotBuffer = await client.screenshot();
  console.log('Screenshot captured:', screenshotBuffer.length, 'bytes');

  console.log('Closing browser...');
  await driver.disable();
  await client.close();

  console.log('Done!');
}

main().catch(console.error);
