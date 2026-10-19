import * as tl from 'azure-pipelines-task-lib/task';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

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

async function startLiveRun(
  dashboardUrl: string,
  apiKey: string,
  tests: TestConfig[]
): Promise<string | null> {
  try {
    const buildId = tl.getVariable('Build.BuildId') || '';
    const buildNumber = tl.getVariable('Build.BuildNumber') || '';
    const projectName = tl.getVariable('System.TeamProject') || '';
    const definitionName = tl.getVariable('Build.DefinitionName') || '';
    const sourceBranch = tl.getVariable('Build.SourceBranch') || '';
    const sourceVersion = tl.getVariable('Build.SourceVersion') || '';
    const collectionUri = tl.getVariable('System.CollectionUri') || '';

    // Construct build URL
    let buildUrl = '';
    if (collectionUri && projectName && buildId) {
      buildUrl = `${collectionUri}${encodeURIComponent(projectName)}/_build/results?buildId=${buildId}`;
    }

    // Clean branch name
    const branch = sourceBranch.replace('refs/heads/', '');

    const payload = {
      platform: 'azure-devops',
      jobName: `${projectName}/${definitionName}`,
      buildNumber: buildNumber,
      buildUrl: buildUrl,
      branch: branch,
      commit: sourceVersion,
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
      tl.warning(`Failed to start live run: HTTP ${response.status}`);
      return null;
    }
  } catch (error) {
    tl.warning(`Error starting live run: ${error}`);
    return null;
  }
}

async function notifyTestComplete(
  dashboardUrl: string,
  apiKey: string,
  testRunId: string,
  testIndex: number,
  success: boolean,
  url: string,
  goal: string
): Promise<void> {
  try {
    const endpoint = dashboardUrl.endsWith('/')
      ? `${dashboardUrl}api/live/test-complete`
      : `${dashboardUrl}/api/live/test-complete`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify({
        testRunId,
        testIndex,
        success,
        url,
        goal
      })
    });

    if (!response.ok) {
      tl.warning(`Failed to notify test complete: HTTP ${response.status}`);
    }
  } catch (error) {
    tl.warning(`Error notifying test complete: ${error}`);
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
      tl.warning(`Failed to complete live run: HTTP ${response.status}`);
      return null;
    }
  } catch (error) {
    tl.warning(`Error completing live run: ${error}`);
    return null;
  }
}

function parseTestConfig(configPath: string): TestConfig[] {
  const content = fs.readFileSync(configPath, 'utf-8');
  const ext = path.extname(configPath).toLowerCase();

  if (ext === '.json') {
    return JSON.parse(content);
  }

  // Parse text format: url|goal per line
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [url, goal] = line.split('|', 2);
      return { url: url.trim(), goal: goal.trim() };
    })
    .filter(t => t.url && t.goal);
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

  // Set up environment
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HEADLESS: headless ? 'true' : 'false'
  };

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

  return new Promise<TestResult>((resolve) => {
    let stdout = '';
    let stderr = '';

    const npmPath = tl.which('npm', true);
    const child = spawn(npmPath, args, {
      cwd: agentPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      const duration = Date.now() - startTime;

      // Try to parse JSON from output
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

            resolve({
              url: config.url,
              goal: config.goal,
              success: parsed.success || false,
              reason: parsed.reason || null,
              error: parsed.error || null,
              steps: parsed.steps || [],
              violations: parsed.violations || [],
              duration
            });
            return;
          }
        }
      } catch (parseError) {
        tl.debug(`Failed to parse JSON output: ${parseError}`);
      }

      // Return error result if we couldn't parse
      resolve({
        url: config.url,
        goal: config.goal,
        success: false,
        reason: null,
        error: stderr || `Process exited with code ${code}`,
        steps: [],
        violations: [],
        duration
      });
    });

    child.on('error', (error) => {
      const duration = Date.now() - startTime;
      resolve({
        url: config.url,
        goal: config.goal,
        success: false,
        reason: null,
        error: error.message,
        steps: [],
        violations: [],
        duration
      });
    });
  });
}

async function run(): Promise<void> {
  try {
    // Get inputs
    const testConfigPath = tl.getPathInput('testConfig', true, true);
    const agentPath = tl.getPathInput('agentPath', true, true);
    const provider = tl.getInput('provider') || 'openai';
    const openaiApiKey = tl.getInput('openaiApiKey');
    const geminiApiKey = tl.getInput('geminiApiKey');
    const headless = tl.getBoolInput('headless');
    const continueOnFailure = tl.getBoolInput('continueOnFailure');
    const dashboardUrl = tl.getInput('dashboardUrl');
    const dashboardApiKey = tl.getInput('dashboardApiKey');

    if (!testConfigPath) {
      throw new Error('Test configuration file path is required');
    }

    if (!agentPath) {
      throw new Error('Agent path is required');
    }

    // Validate API key
    const apiKey = provider === 'openai' ? openaiApiKey : geminiApiKey;
    if (!apiKey) {
      throw new Error(`API key required for provider: ${provider}. Set ${provider}ApiKey input.`);
    }

    // Parse test configuration
    const tests = parseTestConfig(testConfigPath);
    if (tests.length === 0) {
      throw new Error('No tests found in configuration file');
    }

    console.log('===========================================');
    console.log('  AT Agent - Accessibility Testing');
    console.log('===========================================');
    console.log(`Tests to run: ${tests.length}`);
    console.log(`LLM Provider: ${provider}`);
    console.log(`Headless: ${headless}`);
    console.log(`Agent path: ${agentPath}`);
    console.log('');

    // Start live tracking if dashboard is configured
    let liveTestRunId: string | null = null;
    if (dashboardUrl && dashboardApiKey) {
      liveTestRunId = await startLiveRun(dashboardUrl, dashboardApiKey, tests);
      if (liveTestRunId) {
        console.log(`[Live] Test run started: ${liveTestRunId}`);
        console.log(`[Live] View progress at: ${dashboardUrl.replace(/\/$/, '')}/runs/${liveTestRunId}`);
      }
    }

    const results: TestResult[] = [];
    const totalStartTime = Date.now();
    let hasFailure = false;

    for (let i = 0; i < tests.length; i++) {
      const test = tests[i];

      console.log('-------------------------------------------');
      console.log(`Test ${i + 1}/${tests.length}`);
      console.log(`URL: ${test.url}`);
      console.log(`Goal: ${test.goal}`);
      console.log('-------------------------------------------');

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

      // Notify dashboard of test completion for real-time stats
      if (liveTestRunId && dashboardUrl && dashboardApiKey) {
        await notifyTestComplete(
          dashboardUrl,
          dashboardApiKey,
          liveTestRunId,
          i,
          result.success,
          test.url,
          test.goal
        );
      }

      if (result.success) {
        console.log(`PASSED: ${result.reason || 'Test completed successfully'}`);
      } else {
        hasFailure = true;
        const failReason = result.error || result.reason || 'Test did not pass';
        tl.error(`FAILED: ${failReason}`);

        if (!continueOnFailure) {
          tl.error('Stopping due to test failure (continueOnFailure=false)');
          break;
        }
      }

      console.log('');
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
    console.log('===========================================');
    console.log('  Test Summary');
    console.log('===========================================');
    console.log(`Total: ${totalTests}`);
    console.log(`Passed: ${passedTests}`);
    console.log(`Failed: ${failedTests}`);
    console.log(`Pass Rate: ${passRate}%`);
    console.log(`Duration: ${(totalDuration / 1000).toFixed(1)}s`);
    if (dashboardResultsUrl) {
      console.log(`Dashboard: ${dashboardResultsUrl}`);
    }
    console.log('===========================================');

    // Set outputs
    tl.setVariable('totalTests', totalTests.toString());
    tl.setVariable('passedTests', passedTests.toString());
    tl.setVariable('failedTests', failedTests.toString());
    tl.setVariable('passRate', passRate);
    tl.setVariable('resultsJson', JSON.stringify(results));

    if (dashboardResultsUrl) {
      tl.setVariable('dashboardUrl', dashboardResultsUrl);
    }

    // Set task result
    if (hasFailure) {
      tl.setResult(tl.TaskResult.Failed, `${failedTests} out of ${totalTests} accessibility tests failed`);
    } else {
      tl.setResult(tl.TaskResult.Succeeded, `All ${totalTests} accessibility tests passed`);
    }

  } catch (error) {
    if (error instanceof Error) {
      tl.setResult(tl.TaskResult.Failed, error.message);
    } else {
      tl.setResult(tl.TaskResult.Failed, 'An unexpected error occurred');
    }
  }
}

run();
