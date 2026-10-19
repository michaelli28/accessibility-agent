import { Agent, type AgentResult } from '@at-agent/agent'
import { formatAgentResult, formatViolation, formatJSON } from '../output.js'

export interface FlowCommandOptions {
  url: string
  goal: string
  json?: boolean
  maxSteps?: number
  apiKey?: string
  headed?: boolean
}

export interface FlowCommandResult {
  success: boolean
  agentResult?: AgentResult
  output?: string
  error?: string
}

export async function runFlow(options: FlowCommandOptions): Promise<FlowCommandResult> {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY

  if (!apiKey) {
    return {
      success: false,
      error: 'OPENAI_API_KEY environment variable is required for flow testing',
    }
  }

  try {
    const agent = new Agent(apiKey)
    const agentResult = await agent.run(options.goal, {
      startUrl: options.url,
      maxSteps: options.maxSteps ?? 20,
      headed: options.headed,
    })

    if (options.json) {
      return {
        success: agentResult.success,
        agentResult,
        output: formatJSON(agentResult),
      }
    }

    // Format text output
    const lines = [formatAgentResult(agentResult)]

    if (agentResult.violations.length > 0) {
      lines.push('', 'Violations Found:', '')
      for (const violation of agentResult.violations) {
        lines.push(formatViolation(violation), '')
      }
    }

    return {
      success: agentResult.success,
      agentResult,
      output: lines.join('\n'),
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
