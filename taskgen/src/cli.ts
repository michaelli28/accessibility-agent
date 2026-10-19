#!/usr/bin/env node

/**
 * CLI Entry Point for Task Generation
 *
 * Usage:
 *   npx ts-node taskgen/src/cli.ts --url https://example.com --output tasks.json
 *   npm run taskgen -- --url https://example.com --output tasks.json
 */

import { TaskGenerationOrchestrator, generateTasksForUrl } from './orchestrator';
import { TaskGenConfig } from './types';

// ==================== Argument Parsing ====================

interface CliArgs {
  url: string;
  output: string;
  maxPages: number;
  maxDepth: number;
  includeJourneys: boolean;
  exportGraph: boolean;
  graphOutput: string;
  detailed: boolean;
  headless: boolean;
  help: boolean;
  gapDetection: boolean;
  gapReport: string;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    url: '',
    output: 'data/generated-tests.json',
    maxPages: 20,
    maxDepth: 2,
    includeJourneys: true,
    exportGraph: false,
    graphOutput: 'data/element-graph.json',
    detailed: false,
    headless: true,
    help: false,
    gapDetection: false,
    gapReport: '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--url':
      case '-u':
        result.url = args[++i] || '';
        break;
      case '--output':
      case '-o':
        result.output = args[++i] || 'data/generated-tests.json';
        break;
      case '--max-pages':
      case '-m':
        result.maxPages = parseInt(args[++i] || '20', 10);
        break;
      case '--max-depth':
      case '-d':
        result.maxDepth = parseInt(args[++i] || '2', 10);
        break;
      case '--no-journeys':
        result.includeJourneys = false;
        break;
      case '--export-graph':
        result.exportGraph = true;
        break;
      case '--graph-output':
        result.graphOutput = args[++i] || 'data/element-graph.json';
        break;
      case '--detailed':
        result.detailed = true;
        break;
      case '--no-headless':
        result.headless = false;
        break;
      case '--gap-detection':
        result.gapDetection = true;
        break;
      case '--gap-report':
        result.gapReport = args[++i] || 'data/gap-report.json';
        result.gapDetection = true; // Implicitly enable gap detection
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        // Positional argument (URL if not provided)
        if (!arg.startsWith('-') && !result.url) {
          result.url = arg;
        }
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Accessibility Task Generator

Automatically generates accessibility testing tasks that cover all HTML elements
across a website, ensuring comprehensive WCAG 2.1 AA compliance testing.

Usage:
  npx ts-node taskgen/src/cli.ts [options] <url>
  npm run taskgen -- [options] <url>

Options:
  -u, --url <url>          Target website URL (required)
  -o, --output <file>      Output file for generated tasks (default: data/generated-tests.json)
  -m, --max-pages <n>      Maximum pages to crawl (default: 20)
  -d, --max-depth <n>      Maximum crawl depth (default: 2)
  --no-journeys            Exclude user journey tasks (only atomic tasks)
  --export-graph           Export the element graph to JSON
  --graph-output <file>    Element graph output file (default: data/element-graph.json)
  --detailed               Export detailed task metadata (not just url/goal)
  --no-headless            Run browser in visible mode (for debugging)
  --gap-detection          Enable accessibility gap detection (finds inaccessible elements)
  --gap-report <file>      Output file for gap detection report (implies --gap-detection)
  -h, --help               Show this help message

Examples:
  # Generate tasks for a website
  npm run taskgen -- --url https://example.com

  # Generate tasks with custom output file
  npm run taskgen -- --url https://example.com --output my-tests.json

  # Generate tasks and export element graph
  npm run taskgen -- --url https://example.com --export-graph

  # Generate only atomic tasks (no journeys)
  npm run taskgen -- --url https://example.com --no-journeys

  # Crawl more pages
  npm run taskgen -- --url https://example.com --max-pages 50 --max-depth 3

  # Enable gap detection to find inaccessible elements
  npm run taskgen -- --url https://example.com --gap-detection

  # Generate gap report
  npm run taskgen -- --url https://example.com --gap-report gaps.json

Output Format:
  The generated tasks are JSON objects with:
  - url: The target page URL
  - goal: Numbered step-by-step instructions for the agent

  Example:
  {
    "url": "https://example.com/login",
    "goal": "1. Navigate to email field. 2. Type 'test@example.com'. 3. Navigate to password field. 4. Type 'password123'. 5. Navigate to and click Submit button. 6. Report success with the reason as the result."
  }
`);
}

// ==================== Main ====================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.url) {
    console.error('Error: URL is required');
    console.error('Usage: npm run taskgen -- --url <url>');
    console.error('Run with --help for more options');
    process.exit(1);
  }

  // Validate URL
  try {
    new URL(args.url);
  } catch {
    console.error(`Error: Invalid URL: ${args.url}`);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Accessibility Task Generator');
  console.log('='.repeat(60));
  console.log(`Target URL: ${args.url}`);
  console.log(`Max pages: ${args.maxPages}`);
  console.log(`Max depth: ${args.maxDepth}`);
  console.log(`Include journeys: ${args.includeJourneys}`);
  console.log(`Gap detection: ${args.gapDetection ? 'enabled' : 'disabled'}`);
  console.log(`Output file: ${args.output}`);
  if (args.gapReport) {
    console.log(`Gap report: ${args.gapReport}`);
  }
  console.log('='.repeat(60));
  console.log('');

  const orchestrator = new TaskGenerationOrchestrator({ headless: args.headless });

  try {
    const startTime = Date.now();

    const config: TaskGenConfig = {
      entryUrl: args.url,
      maxPages: args.maxPages,
      maxDepth: args.maxDepth,
      wcagLevel: 'AA',
      coverageThreshold: 80,
      includeJourneyTasks: args.includeJourneys,
      includeAtomicTasks: true,
      enableGapDetection: args.gapDetection,
      gapReportPath: args.gapReport || undefined,
    };

    // Generate tasks
    const { graph, tasks, estimatedCoverage, gapReport } = await orchestrator.generateInitialTasks(config);

    // Export tasks
    if (args.detailed) {
      await orchestrator.exportDetailedTasks(tasks, args.output);
    } else {
      await orchestrator.exportTasks(tasks, args.output);
    }

    // Export graph if requested
    if (args.exportGraph) {
      await orchestrator.exportGraph(args.graphOutput);
    }

    const duration = Date.now() - startTime;

    // Print summary
    console.log('');
    console.log('='.repeat(60));
    console.log('Summary');
    console.log('='.repeat(60));
    console.log(`Pages crawled: ${graph.pageCount}`);
    console.log(`Total elements: ${graph.totalElements}`);
    console.log(`Interactive elements: ${graph.interactiveElements}`);
    console.log(`Landmark elements: ${graph.landmarkElements}`);
    console.log(`Tasks generated: ${tasks.length}`);
    console.log(`Estimated coverage: ${estimatedCoverage.coveragePercent.toFixed(1)}%`);
    console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);

    // Gap detection results
    if (gapReport) {
      console.log('');
      console.log('Gap Detection Results:');
      console.log(`  Total accessibility gaps: ${gapReport.totalGaps}`);
      console.log(`  - Critical: ${gapReport.gapsBySeverity['critical'] || 0}`);
      console.log(`  - Serious: ${gapReport.gapsBySeverity['serious'] || 0}`);
      console.log(`  - Moderate: ${gapReport.gapsBySeverity['moderate'] || 0}`);
      console.log(`  - Minor: ${gapReport.gapsBySeverity['minor'] || 0}`);
      if (gapReport.totalGaps > 0) {
        console.log('  Gap types:');
        for (const [type, count] of Object.entries(gapReport.gapsByType)) {
          if (count > 0) {
            console.log(`    - ${type}: ${count}`);
          }
        }
      }
    }

    console.log('');
    console.log(`Tasks exported to: ${args.output}`);
    if (args.exportGraph) {
      console.log(`Graph exported to: ${args.graphOutput}`);
    }
    if (args.gapReport) {
      console.log(`Gap report exported to: ${args.gapReport}`);
    }
    console.log('='.repeat(60));

    // Print task type breakdown
    const taskTypes = tasks.reduce((acc, t) => {
      acc[t.type] = (acc[t.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('');
    console.log('Task Breakdown:');
    for (const [type, count] of Object.entries(taskTypes)) {
      console.log(`  - ${type}: ${count}`);
    }

    // Print coverage by element type
    console.log('');
    console.log('Coverage by Element Type:');
    for (const [type, metrics] of estimatedCoverage.elementsByType) {
      if (metrics.total > 0) {
        console.log(`  - ${type}: ${metrics.covered}/${metrics.total} (${metrics.percent.toFixed(1)}%)`);
      }
    }

    console.log('');
    console.log('Done! Run the generated tasks with the AT Agent.');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await orchestrator.close();
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
