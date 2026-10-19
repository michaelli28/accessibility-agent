import { z } from 'zod'
import {
  ViolationSchema,
  TabKeySchema,
  KeyboardTrapResultSchema,
  ContextChangeResultSchema,
} from '@at-agent/accessibility'

// Action types the agent can perform
export const ActionTypeSchema = z.enum([
  'navigate',
  'click',
  'fill',
  'audit',
  'observe',
  'tab',
  'checkKeyboard',
  'done',
])
export type ActionType = z.infer<typeof ActionTypeSchema>

// An action the agent wants to perform
export const ActionSchema = z.object({
  type: ActionTypeSchema,
  target: z.string().nullish(), // nullish allows null, undefined, or string
  // The prompt calls tab's value a "press count", so a model may send a JSON number.
  value: z.union([z.string(), z.number().transform(String)]).nullish(),
  reason: z.string(),
})
export type Action = z.infer<typeof ActionSchema>

// One Tab press and the element it landed on, read immediately after that press. One record per
// PRESS: a single read after N presses reports an N-press run as one element, which the retired
// detector then read as a one-element cycle (bench/probes/wrap/RESULT.md:345).
export const TabPressSchema = z.object({
  index: z.number().int().positive(),
  key: TabKeySchema,
  element: z.string(),
  timestamp: z.number(),
})
export type TabPress = z.infer<typeof TabPressSchema>

// Result of executing an action
export const ActionResultSchema = z.object({
  success: z.boolean(),
  observation: z.string(),
  violations: z.array(ViolationSchema).optional(),
  presses: z.array(TabPressSchema).optional(),
  keyboard: KeyboardTrapResultSchema.optional(),
  contextChange: ContextChangeResultSchema.optional(),
})
export type ActionResult = z.infer<typeof ActionResultSchema>

// A single step in agent execution
export const StepSchema = z.object({
  stepNumber: z.number(),
  action: ActionSchema,
  result: ActionResultSchema,
  timestamp: z.string(),
})
export type Step = z.infer<typeof StepSchema>

// Agent configuration options
export const AgentOptionsSchema = z.object({
  startUrl: z.string().url(),
  maxSteps: z.number().positive().default(20),
  model: z.string().default('gpt-5'),
  headed: z.boolean().default(false),
})
export type AgentOptions = z.infer<typeof AgentOptionsSchema>

// Final result of agent execution
export const AgentResultSchema = z.object({
  success: z.boolean(),
  goal: z.string(),
  steps: z.array(StepSchema),
  violations: z.array(ViolationSchema),
  summary: z.string(),
  tabPresses: z.array(TabPressSchema).optional(),
  // Null when no checkKeyboard action ran. Last check wins; there is deliberately no latch, because
  // latching a three-valued verdict would make one `undetermined` permanently non-pass.
  keyboard: KeyboardTrapResultSchema.nullable(),
  contextChange: ContextChangeResultSchema.nullable(),
})
export type AgentResult = z.infer<typeof AgentResultSchema>

// Options for executeAction
export const ExecuteActionOptionsSchema = z.object({
  headed: z.boolean().default(false),
})
export type ExecuteActionOptions = z.infer<typeof ExecuteActionOptionsSchema>
