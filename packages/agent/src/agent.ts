import { BrowserClient, BrowserPage } from '@at-agent/browser'
import type { Violation, KeyboardTrapResult, ContextChangeResult } from '@at-agent/accessibility'
import { createOpenAIClient, generateAction } from './openai.js'
import { executeAction } from './tools.js'
import { AgentOptionsSchema, type AgentOptions, type AgentResult, type Step, type TabPress } from './types.js'
import type OpenAI from 'openai'

export class Agent {
  private client: OpenAI
  private stopped = false

  constructor(apiKey: string) {
    this.client = createOpenAIClient(apiKey)
  }

  async run(goal: string, options: Partial<AgentOptions> & { startUrl: string }): Promise<AgentResult> {
    const opts = AgentOptionsSchema.parse(options)
    this.stopped = false

    const browser = new BrowserClient({ headless: !opts.headed })
    await browser.launch()

    const steps: Step[] = []
    const violations: Violation[] = []
    // One entry per Tab PRESS, not per tab action.
    const tabPresses: TabPress[] = []
    // Last check wins, deliberately without a latch: latching a three-valued verdict would make one
    // `undetermined` permanently non-pass and a stale `fail` unclearable.
    let keyboard: KeyboardTrapResult | null = null
    let contextChange: ContextChangeResult | null = null
    let page: BrowserPage | null = null

    try {
      page = await browser.newPage()
      let observation = `Starting at ${opts.startUrl}. Goal: ${goal}`

      for (let stepNumber = 1; stepNumber <= opts.maxSteps; stepNumber++) {
        if (this.stopped) {
          return this.createResult(
            goal,
            steps,
            violations,
            false,
            'Agent stopped by user',
            tabPresses,
            keyboard,
            contextChange,
          )
        }

        const action = await generateAction(this.client, opts.model, goal, observation, steps)

        // Navigate to start URL on first step if action is not navigate
        if (stepNumber === 1 && action.type !== 'navigate') {
          await page.goto(opts.startUrl)
        }

        const result = await executeAction(action, page, {
          headed: opts.headed,
        })

        if (action.type === 'tab' && result.presses) {
          tabPresses.push(...result.presses)
        }

        if (action.type === 'checkKeyboard' && result.keyboard) {
          keyboard = result.keyboard
          contextChange = result.contextChange ?? null
        }

        const step: Step = {
          stepNumber,
          action,
          result,
          timestamp: new Date().toISOString(),
        }
        steps.push(step)

        // Collect violations from audit steps
        if (result.violations) {
          violations.push(...result.violations)
        }

        observation = result.observation

        // Check if done
        if (action.type === 'done') {
          return this.createResult(goal, steps, violations, true, action.reason, tabPresses, keyboard, contextChange)
        }
      }

      // Reached max steps
      return this.createResult(
        goal,
        steps,
        violations,
        false,
        `Reached max steps (${opts.maxSteps}) without completing goal`,
        tabPresses,
        keyboard,
        contextChange,
      )
    } finally {
      if (page) {
        await page.close()
      }
      await browser.close()
    }
  }

  stop(): void {
    this.stopped = true
  }

  private createResult(
    goal: string,
    steps: Step[],
    violations: Violation[],
    success: boolean,
    summary: string,
    tabPresses: TabPress[],
    keyboard: KeyboardTrapResult | null,
    contextChange: ContextChangeResult | null,
  ): AgentResult {
    return {
      success,
      goal,
      steps,
      violations,
      summary,
      tabPresses,
      keyboard,
      contextChange,
    }
  }
}
