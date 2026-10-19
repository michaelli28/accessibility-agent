import { z } from 'zod'

// Violation impact levels (matches axe-core)
export const ImpactSchema = z.enum(['critical', 'serious', 'moderate', 'minor'])
export type Impact = z.infer<typeof ImpactSchema>

// A single node that violated a rule
export const ViolationNodeSchema = z.object({
  html: z.string(),
  target: z.array(z.string()),
  failureSummary: z.string().nullable(),
})
export type ViolationNode = z.infer<typeof ViolationNodeSchema>

// A WCAG violation
export const ViolationSchema = z.object({
  id: z.string(),
  impact: ImpactSchema,
  description: z.string(),
  help: z.string(),
  helpUrl: z.string(),
  wcagTags: z.array(z.string()),
  nodes: z.array(ViolationNodeSchema),
})
export type Violation = z.infer<typeof ViolationSchema>

// A rule that passed
export const PassedRuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  nodeCount: z.number(),
})
export type PassedRule = z.infer<typeof PassedRuleSchema>

// Complete audit result
export const AuditResultSchema = z.object({
  url: z.string(),
  timestamp: z.string(),
  violations: z.array(ViolationSchema),
  passes: z.array(PassedRuleSchema),
  incomplete: z.array(z.object({
    id: z.string(),
    description: z.string(),
  })),
})
export type AuditResult = z.infer<typeof AuditResultSchema>

// Audit options
export const AuditOptionsSchema = z.object({
  rules: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
})
export type AuditOptions = z.infer<typeof AuditOptionsSchema>

// Screen Reader Navigation Types

export type NavigationMode = 'browse' | 'focus'

export type NavigableNode = {
  role: string
  name: string | null
  value: string | null
  level?: number
  children: NavigableNode[]
  isInteresting: boolean
}

export type NavigatorState = {
  currentIndex: number
  nodes: NavigableNode[]
  mode: NavigationMode
}

export type NavigationResult = {
  success: boolean
  node: NavigableNode | null
  message: string
}
