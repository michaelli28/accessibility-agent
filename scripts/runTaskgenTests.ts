#!/usr/bin/env ts-node

/**
 * Run accessibility tests from a generated task file.
 *
 * Usage: npm run taskgen:run -- <tasks-file.json> [--parallel N]
 *
 * Examples:
 *   npm run taskgen:run -- data/cmu-tests.json
 *   npm run taskgen:run -- data/cmu-tests.json --parallel 3
 *   npm run taskgen:run -- data/cmu-tests.json --limit 10
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserClient } from '../virtual-screen-reader/src/playwrightClient';
import { ScreenReaderDriver } from '../virtual-screen-reader/src/ScreenReaderDriver';
import { Agent } from '../agent/src/Agent';
import { buildOpenAIModel } from '../agent/src/OpenAIClient';
import { buildGeminiModel } from '../agent/src/GeminiClient';

interface SimpleTask {
  url: string;
  goal: string;
}

interface TestResult {
  url: string;
  goal: string;
  success: boolean;
  reason: string | null;
  error: string | null;
  stepCount: number;
  durationMs: number;
}

// Parse CLI arguments
function parseArgs(): { tasksFile: string; parallel: number; limit: number; provider: string } {
  const args = process.argv.slice(2);
  let tasksFile = '';
  let parallel = 1;
  let limit = Infinity;
  let provider = 'openai';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--parallel' || args[i] === '-p') {
      parallel = parseInt(args[++i] || '1', 10);
    } else if (args[i] === '--limit' || args[i] === '-l') {
      limit = parseInt(args[++i] || '10', 10);
    } else if (args[i] === '--provider') {
      provider = args[++i] || 'openai';
    } else if (!args[i].startsWith('-')) {
      tasksFile = args[i];
    }
  }

  return { tasksFile, parallel, limit, provider };
}

// Run a single task
async function runTask(
  task: SimpleTask,
  index: number,
  provider: string
): Promise<TestResult> {
  const startTime = Date.now();
  console.log(`\n[${index + 1}] Starting: ${task.url}`);
  console.log(`    Goal: ${task.goal.substring(0, 100)}...`);

  const client = new BrowserClient();

  try {
    await client.launch(true);
    await client.goto(task.url);

    const driver = new ScreenReaderDriver(client);
    await driver.enable();

    const model = provider === 'gemini' ? buildGeminiModel() : buildOpenAIModel();

    const stepCallback = (step: any) => {
      const action = step.action?.key || step.action?.type || 'unknown';
      console.log(`    Step ${step.stepNumber}: ${action}`);
    };

    const agent = new Agent(driver, model, stepCallback);
    const trace = await agent.run(task.goal);

    await driver.disable();

    const durationMs = Date.now() - startTime;
    const result: TestResult = {
      url: task.url,
      goal: task.goal,
      success: trace.success,
      reason: trace.reason || null,
      error: trace.error || null,
      stepCount: trace.steps.length,
      durationMs,
    };

    if (trace.success) {
      console.log(`    ✓ PASSED (${trace.steps.length} steps, ${(durationMs / 1000).toFixed(1)}s)`);
    } else {
      console.log(`    ✗ FAILED: ${trace.reason || trace.error}`);
    }

    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    console.log(`    ✗ ERROR: ${error.message}`);
    return {
      url: task.url,
      goal: task.goal,
      success: false,
      reason: null,
      error: error.message,
      stepCount: 0,
      durationMs,
    };
  } finally {
    await client.close();
  }
}

// Run tasks in parallel batches
async function runTasksParallel(
  tasks: SimpleTask[],
  parallel: number,
  provider: string
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (let i = 0; i < tasks.length; i += parallel) {
    const batch = tasks.slice(i, i + parallel);
    const batchPromises = batch.map((task, j) => runTask(task, i + j, provider));
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return results;
}

async function main() {
  const { tasksFile, parallel, limit, provider } = parseArgs();

  if (!tasksFile) {
    console.error('Usage: npm run taskgen:run -- data/<tasks-file.json> [--parallel N] [--limit N]');
    process.exit(1);
  }

  // Resolve file path
  const filePath = path.resolve(process.cwd(), tasksFile);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  // Load tasks
  const content = fs.readFileSync(filePath, 'utf-8');
  let tasks: SimpleTask[] = JSON.parse(content);

  // Apply limit
  if (limit < tasks.length) {
    console.log(`Limiting to first ${limit} tasks (of ${tasks.length} total)`);
    tasks = tasks.slice(0, limit);
  }

  console.log('='.repeat(60));
  console.log('Accessibility Test Runner');
  console.log('='.repeat(60));
  console.log(`Tasks file: ${tasksFile}`);
  console.log(`Total tasks: ${tasks.length}`);
  console.log(`Parallelism: ${parallel}`);
  console.log(`Provider: ${provider}`);
  console.log('='.repeat(60));

  const startTime = Date.now();

  // Run tasks
  const results = await runTasksParallel(tasks, parallel, provider);

  const totalDuration = Date.now() - startTime;

  // Summary
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Pass rate: ${((passed / results.length) * 100).toFixed(1)}%`);
  console.log(`Total duration: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log('='.repeat(60));

  // Write results to file
  const resultsFile = tasksFile.replace('.json', '-results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\nResults written to: ${resultsFile}`);

  // Exit with error if any tests failed
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
