import { Command } from 'commander'
import { runAudit } from './commands/audit.js'
import { runFlow } from './commands/flow.js'
import { runGaps } from './commands/gaps.js'

// Exit codes go through process.exitCode, never process.exit: exit drops stdout still buffered for a
// pipe, and on macOS the old `at-agent gaps <url> --json | jq` received 65,536 of 423,097 bytes.
export function createProgram(): Command {
  const program = new Command()

  program
    .name('at-agent')
    .description('AI-powered accessibility testing agent')
    .version('0.0.1')

  program
    .command('audit <url>')
    .description('Run accessibility audit on a URL')
    .option('--json', 'Output results as JSON')
    .option('--tags <tags...>', 'WCAG tags to check (e.g., wcag2a wcag2aa)')
    .action(async (url: string, options: { json?: boolean; tags?: string[] }) => {
      const result = await runAudit({ url, json: options.json, tags: options.tags })

      if (result.output) {
        console.log(result.output)
      }

      if (!result.success) {
        console.error(`Error: ${result.error}`)
        process.exitCode = 1
        return
      }

      // Exit with non-zero if critical/serious violations found
      if (result.summary && (result.summary.byImpact.critical > 0 || result.summary.byImpact.serious > 0)) {
        process.exitCode = 1
      }
    })

  program
    .command('flow <url>')
    .description('Run AI-guided accessibility flow test')
    .requiredOption('--goal <goal>', 'Goal for the agent to achieve')
    .option('--json', 'Output results as JSON')
    .option('--max-steps <number>', 'Maximum steps (default: 20)', parseInt)
    .option('--api-key <key>', 'OpenAI API key (or set OPENAI_API_KEY env var)')
    .option('--headed', 'Show browser window')
    .action(async (url: string, options: { goal: string; json?: boolean; maxSteps?: number; apiKey?: string; headed?: boolean }) => {
      const result = await runFlow({
        url,
        goal: options.goal,
        json: options.json,
        maxSteps: options.maxSteps,
        apiKey: options.apiKey,
        headed: options.headed,
      })

      if (result.output) {
        console.log(result.output)
      }

      if (!result.success) {
        console.error(`Error: ${result.error}`)
        process.exitCode = 1
      }
    })

  program
    .command('gaps <url>')
    .description('Detect interactive elements missing from the accessibility tree')
    .option('--json', 'Output results as JSON')
    .action(async (url: string, options: { json?: boolean }) => {
      const result = await runGaps({ url, json: options.json })

      if (result.output) {
        console.log(result.output)
      }

      if (!result.success) {
        console.error(`Error: ${result.error}`)
        process.exitCode = 1
        return
      }

      // Exit with non-zero if critical/serious gaps found
      if (result.summary && (result.summary.bySeverity.critical > 0 || result.summary.bySeverity.serious > 0)) {
        process.exitCode = 1
      }
    })

  return program
}
