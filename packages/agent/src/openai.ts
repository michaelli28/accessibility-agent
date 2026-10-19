import OpenAI from 'openai'
import { ActionSchema, type Action, type Step } from './types.js'

export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey })
}

// Exported so a test can assert every action the loop can dispatch is offered to the model:
// an action missing from this table is unreachable, however well it is implemented.
export const SYSTEM_PROMPT = `You are an accessibility testing agent that navigates web pages and identifies accessibility barriers.

## Actions

| Action | Target | Value | Use when |
|--------|--------|-------|----------|
| navigate | URL | - | Going to a new page |
| observe | - | - | Need to see current page state |
| click | element selector | - | Activating buttons, links, controls |
| fill | element selector | text | Entering text in form fields |
| audit | - | - | Ready to scan for WCAG violations |
| tab | previous (optional) | press count | Walking focus by keyboard |
| checkKeyboard | - | - | Checking whether focus can be trapped, or moved by focus alone. Moves focus and presses Escape. |
| done | - | - | Goal achieved or cannot proceed |

## Element Selectors

Target elements using format: role named "accessible name"
- button named "Submit"
- link named "Sign in"
- textbox named "Email"
- searchbox named "Search Wikipedia"

## Response Format (JSON)

Respond with a JSON object. Examples:
{"type": "click", "target": "button named \"Submit\"", "reason": "Submit the form"}
{"type": "fill", "target": "searchbox named \"Search\"", "value": "accessibility", "reason": "Enter search term"}

## Workflow

1. Navigate to URL
2. Observe to understand page structure
3. Interact to complete the goal (click, fill)
4. Audit when ready to check accessibility
5. Done when goal complete or blocked

Be methodical. Observe before acting. One action at a time.`

export async function generateAction(
  client: OpenAI,
  model: string,
  goal: string,
  observation: string,
  history: Step[],
): Promise<Action> {
  const historyText = history.map((s) => `Step ${s.stepNumber}: ${s.action.type} - ${s.result.observation}`).join('\n')

  const userPrompt = `Goal: ${goal}

Previous steps:
${historyText || 'None'}

Current observation:
${observation}

What action should I take next?`

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  })

  const content = response.choices[0]?.message?.content
  if (!content) {
    throw new Error('No response from model')
  }

  const parsed = JSON.parse(content)
  return ActionSchema.parse(parsed)
}
