import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface TestConfig {
  url: string;
  goal: string;
}

interface TestStep {
  stepNumber: number;
  action: string;
  observation: string;
  thought?: string;
}

interface TestResult {
  url: string;
  goal: string;
  success: boolean;
  reason: string | null;
  error: string | null;
  steps: TestStep[];
  violations: Array<{
    type: string;
    message: string;
    element: string;
    severity: string;
  }>;
  duration: number;
}

interface LiveStartResponse {
  testRunId: string;
  projectName?: string;
}

interface LiveCompleteResponse {
  success: boolean;
  testRunId: string;
  projectName?: string;
}

async function startLiveRun(
  dashboardUrl: string,
  apiKey: string,
  tests: TestConfig[]
): Promise<string | null> {
  try {
    const context = github.context;

    const payload = {
      platform: 'github',
      jobName: `${context.repo.owner}/${context.repo.repo}`,
      buildNumber: context.runNumber.toString(),
      buildUrl: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
      branch: context.ref.replace('refs/heads/', ''),
      commit: context.sha,
      totalTests: tests.length,
      tests: tests.map(t => ({ url: t.url, goal: t.goal }))
    };

    const endpoint = dashboardUrl.endsWith('/')
      ? `${dashboardUrl}api/live/start`
      : `${dashboardUrl}/api/live/start`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = (await response.json()) as LiveStartResponse;
      return data.testRunId;
    } else {
      core.warning(`Failed to start live run: HTTP ${response.status}`);
      return null;
    }
  } catch (error) {
    core.warning(`Error starting live run: ${error}`);
    return null;
  }
}

async function completeLiveRun(
  dashboardUrl: string,
  apiKey: string,
  testRunId: string,
  results: TestResult[],
  totalDuration: number
): Promise<string | null> {
  try {
    const payload = {
      testRunId,
      results: results.map(r => ({
        url: r.url,
        goal: r.goal,
        success: r.success,
        reason: r.reason,
        error: r.error,
        steps: r.steps,
        violations: r.violations,
        duration: r.duration
      })),
      totalDuration
    };

    const endpoint = dashboardUrl.endsWith('/')
      ? `${dashboardUrl}api/live/complete`
      : `${dashboardUrl}/api/live/complete`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const resultsUrl = `${dashboardUrl.replace(/\/$/, '')}/runs/${testRunId}`;
      return resultsUrl;
    } else {
      core.warning(`Failed to complete live run: HTTP ${response.status}`);
      return null;
    }
  } catch (error) {
    core.warning(`Error completing live run: ${error}`);
    return null;
  }
}

async function runSingleTest(
  config: TestConfig,
  provider: string,
  apiKey: string,
  headless: boolean,
  agentPath: string,
  liveTestRunId: string | null,
  testIndex: number,
  dashboardUrl: string | null,
  dashboardApiKey: string | null
): Promise<TestResult> {
  const startTime = Date.now();

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HEADLESS: headless ? 'true' : 'false'
  };

  // Set API key based on provider
  if (provider === 'openai') {
    env.OPENAI_API_KEY = apiKey;
  } else {
    env.GEMINI_API_KEY = apiKey;
  }

  // Set live tracking environment variables
  if (liveTestRunId && dashboardUrl && dashboardApiKey) {
    env.DASHBOARD_URL = dashboardUrl.replace(/\/$/, '');
    env.DASHBOARD_API_KEY = dashboardApiKey;
    env.TEST_RUN_ID = liveTestRunId;
    env.TEST_INDEX = testIndex.toString();
  }

  const args = [
    'run', 'start:agent-cli', '--',
    config.url,
    config.goal,
    provider,
    '--json'
  ];

  if (liveTestRunId) {
    args.push('--live');
  }

  let stdout = '';
  let stderr = '';

  try {
    await exec.exec('npm', args, {
      cwd: agentPath,
      env,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
        stderr: (data: Buffer) => {
          stderr += data.toString();
        }
      }
    });
  } catch {
    // Command may exit with non-zero on test failure, that's expected
  }

  const duration = Date.now() - startTime;

  // Parse JSON from output
  try {
    const jsonStart = stdout.indexOf('{"url"');
    if (jsonStart >= 0) {
      let jsonStr = stdout.substring(jsonStart);
      let braceCount = 0;
      let jsonEnd = -1;

      for (let i = 0; i < jsonStr.length; i++) {
        if (jsonStr[i] === '{') braceCount++;
        else if (jsonStr[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }

      if (jsonEnd > 0) {
        jsonStr = jsonStr.substring(0, jsonEnd);
        const parsed = JSON.parse(jsonStr);

        return {
          url: config.url,
          goal: config.goal,
          success: parsed.success || false,
          reason: parsed.reason || null,
          error: parsed.error || null,
          steps: parsed.steps || [],
          violations: parsed.violations || [],
          duration
        };
      }
    }
  } catch (parseError) {
    core.debug(`Failed to parse JSON output: ${parseError}`);
  }

  // Return error result if we couldn't parse
  return {
    url: config.url,
    goal: config.goal,
    success: false,
    reason: null,
    error: stderr || 'Could not parse agent output',
    steps: [],
    violations: [],
    duration
  };
}

async function runDiscovery(
  agentPath: string,
  baseUrl: string,
  discoveryFocus: string | null,
  discoveryPrompt: string | null,
  discoveryMaxTests: number | null,
  discoveryExclude: string | null,
  openaiApiKey: string
): Promise<string> {
  core.info('');
  core.info('===========================================');
  core.info('  Running Auto-Discovery');
  core.info('===========================================');
  core.info(`Base URL: ${baseUrl}`);
  if (discoveryFocus) core.info(`Focus areas: ${discoveryFocus}`);
  if (discoveryPrompt) core.info(`Custom prompt: ${discoveryPrompt.substring(0, 50)}...`);
  if (discoveryMaxTests) core.info(`Max tests: ${discoveryMaxTests}`);
  core.info('');

  // Create output path for discovered tests
  const outputPath = path.join(os.tmpdir(), `discovered-tests-${Date.now()}.json`);
  const discoveryAgentPath = path.join(agentPath, 'discovery-agent');
  const discoverScript = path.join(discoveryAgentPath, 'discover.py');

  // Check if discovery agent exists
  if (!fs.existsSync(discoverScript)) {
    throw new Error(`Discovery agent not found at: ${discoverScript}. Make sure the discovery-agent directory is included.`);
  }

  // Build discovery command arguments
  const args = [
    discoverScript,
    '--root-dir', process.cwd(),
    '--base-url', baseUrl,
    '--output', outputPath
  ];

  if (discoveryFocus) {
    args.push('--focus', discoveryFocus);
  }

  if (discoveryPrompt) {
    args.push('--prompt', discoveryPrompt);
  }

  if (discoveryMaxTests) {
    args.push('--max-tests', discoveryMaxTests.toString());
  }

  if (discoveryExclude) {
    args.push('--exclude', discoveryExclude);
  }

  // Always use verbose mode for CI logs
  args.push('--verbose');

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    OPENAI_API_KEY: openaiApiKey
  };

  let stdout = '';
  let stderr = '';

  try {
    // First, install discovery agent dependencies
    core.info('Installing discovery agent dependencies...');
    await exec.exec('pip', ['install', '-r', path.join(discoveryAgentPath, 'requirements.txt')], {
      silent: false
    });

    core.info('Running discovery agent...');
    await exec.exec('python', args, {
      env,
      silent: false,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
        stderr: (data: Buffer) => {
          stderr += data.toString();
        }
      }
    });
  } catch (error) {
    core.error(`Discovery agent failed: ${stderr || error}`);
    throw new Error(`Discovery agent failed: ${error}`);
  }

  // Verify output file was created
  if (!fs.existsSync(outputPath)) {
    throw new Error('Discovery agent did not generate test file');
  }

  // Validate the generated tests
  const content = fs.readFileSync(outputPath, 'utf-8');
  const tests = JSON.parse(content);

  if (!Array.isArray(tests) || tests.length === 0) {
    throw new Error('Discovery agent generated no tests');
  }

  core.info(`Discovery complete: ${tests.length} tests generated`);
  core.info('');

  return outputPath;
}

async function run(): Promise<void> {
  try {
    // Get inputs
    let testConfigPath = core.getInput('test-config');
    const provider = core.getInput('provider') || 'openai';
    const openaiApiKey = core.getInput('openai-api-key');
    const geminiApiKey = core.getInput('gemini-api-key');
    const headless = core.getInput('headless') !== 'false';
    const continueOnFailure = core.getInput('continue-on-failure') !== 'false';
    const dashboardUrl = core.getInput('dashboard-url');
    const dashboardApiKey = core.getInput('dashboard-api-key');
    const agentPathInput = core.getInput('agent-path', { required: true });

    // Discovery mode inputs
    const discoveryMode = core.getInput('discovery-mode') || 'off';
    const baseUrl = core.getInput('base-url');
    const discoveryFocus = core.getInput('discovery-focus') || null;
    const discoveryPrompt = core.getInput('discovery-prompt') || null;
    const discoveryMaxTestsStr = core.getInput('discovery-max-tests');
    const discoveryMaxTests = discoveryMaxTestsStr ? parseInt(discoveryMaxTestsStr, 10) : null;
    const discoveryExclude = core.getInput('discovery-exclude') || null;

    // Use the agent path from input
    const agentPath = path.resolve(agentPathInput);

    // Validate API key
    const apiKey = provider === 'openai' ? openaiApiKey : geminiApiKey;
    if (!apiKey) {
      throw new Error(`API key required for provider: ${provider}. Set ${provider}-api-key input.`);
    }

    // Handle discovery mode
    let discoveredTestsPath: string | null = null;
    if (discoveryMode !== 'off') {
      // Validate discovery requirements
      if (!baseUrl) {
        throw new Error('base-url is required when discovery-mode is enabled');
      }
      if (!openaiApiKey) {
        throw new Error('openai-api-key is required for auto-discovery (discovery agent uses OpenAI)');
      }

      // Run discovery
      discoveredTestsPath = await runDiscovery(
        agentPath,
        baseUrl,
        discoveryMode === 'guided' ? discoveryFocus : null,
        discoveryPrompt,
        discoveryMaxTests,
        discoveryExclude,
        openaiApiKey
      );

      // Use discovered tests as the config path
      testConfigPath = discoveredTestsPath;
    }

    // Validate test config exists (either provided or discovered)
    if (!testConfigPath) {
      throw new Error('Either test-config or discovery-mode with base-url must be provided');
    }

    // Read and parse test config
    const configFullPath = path.resolve(process.cwd(), testConfigPath);
    if (!fs.existsSync(configFullPath)) {
      throw new Error(`Test configuration file not found: ${testConfigPath}`);
    }

    const configContent = fs.readFileSync(configFullPath, 'utf-8');
    let tests: TestConfig[];

    if (testConfigPath.endsWith('.json')) {
      tests = JSON.parse(configContent);
    } else {
      // Parse text format: url|goal per line
      tests = configContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
          const [url, goal] = line.split('|', 2);
          return { url: url.trim(), goal: goal.trim() };
        })
        .filter(t => t.url && t.goal);
    }

    if (tests.length === 0) {
      throw new Error('No tests found in configuration file');
    }

    core.info('===========================================');
    core.info('  Accessibility Agent Test Runner');
    core.info('===========================================');
    core.info(`Tests to run: ${tests.length}`);
    core.info(`LLM Provider: ${provider}`);
    core.info(`Headless: ${headless}`);
    if (discoveredTestsPath) {
      core.info(`Discovery mode: ${discoveryMode}`);
    }
    core.info('');
    core.info(`Agent path: ${agentPath}`);

    // Build the agent if needed (ensures dist/injected.js exists)
    const injectedPath = path.join(agentPath, 'virtual-screen-reader', 'dist', 'injected.js');
    if (!fs.existsSync(injectedPath)) {
      core.info('Building agent (first run)...');
      await exec.exec('npm', ['run', 'build'], { cwd: agentPath, silent: true });
      core.info('Build complete.');
    }

    // Start live tracking if dashboard is configured
    let liveTestRunId: string | null = null;
    if (dashboardUrl && dashboardApiKey) {
      liveTestRunId = await startLiveRun(dashboardUrl, dashboardApiKey, tests);
      if (liveTestRunId) {
        core.info(`[Live] Test run started: ${liveTestRunId}`);
        core.info(`[Live] View progress at: ${dashboardUrl.replace(/\/$/, '')}/runs/${liveTestRunId}`);
      }
    }

    const results: TestResult[] = [];
    const totalStartTime = Date.now();
    let hasFailure = false;

    for (let i = 0; i < tests.length; i++) {
      const test = tests[i];

      core.info('-------------------------------------------');
      core.info(`Test ${i + 1}/${tests.length}`);
      core.info(`URL: ${test.url}`);
      core.info(`Goal: ${test.goal}`);
      core.info('-------------------------------------------');

      const result = await runSingleTest(
        test,
        provider,
        apiKey,
        headless,
        agentPath,
        liveTestRunId,
        i,
        dashboardUrl || null,
        dashboardApiKey || null
      );

      results.push(result);

      if (result.success) {
        core.info(`PASSED: ${result.reason || 'Test completed successfully'}`);
      } else {
        hasFailure = true;
        const failReason = result.error || result.reason || 'Test did not pass';
        core.error(`FAILED: ${failReason}`);

        if (!continueOnFailure) {
          core.error('Stopping due to test failure (continue-on-failure=false)');
          break;
        }
      }

      core.info('');
    }

    const totalDuration = Date.now() - totalStartTime;

    // Complete live run if started
    let dashboardResultsUrl: string | null = null;
    if (liveTestRunId && dashboardUrl && dashboardApiKey) {
      dashboardResultsUrl = await completeLiveRun(
        dashboardUrl,
        dashboardApiKey,
        liveTestRunId,
        results,
        totalDuration
      );
    }

    // Calculate stats
    const totalTests = results.length;
    const passedTests = results.filter(r => r.success).length;
    const failedTests = totalTests - passedTests;
    const passRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : '0.0';

    // Print summary
    core.info('===========================================');
    core.info('  Test Summary');
    core.info('===========================================');
    core.info(`Total: ${totalTests}`);
    core.info(`Passed: ${passedTests}`);
    core.info(`Failed: ${failedTests}`);
    core.info(`Pass Rate: ${passRate}%`);
    core.info(`Duration: ${(totalDuration / 1000).toFixed(1)}s`);
    if (dashboardResultsUrl) {
      core.info(`Dashboard: ${dashboardResultsUrl}`);
    }
    core.info('===========================================');

    // Set outputs
    core.setOutput('total-tests', totalTests.toString());
    core.setOutput('passed-tests', passedTests.toString());
    core.setOutput('failed-tests', failedTests.toString());
    core.setOutput('pass-rate', passRate);
    core.setOutput('results-json', JSON.stringify(results));

    if (dashboardResultsUrl) {
      core.setOutput('dashboard-url', dashboardResultsUrl);
    }

    if (discoveredTestsPath) {
      core.setOutput('discovered-tests-path', discoveredTestsPath);
    }

    // Fail the action if any tests failed
    if (hasFailure) {
      core.setFailed(`${failedTests} out of ${totalTests} accessibility tests failed`);
    }

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  }
}

run();
