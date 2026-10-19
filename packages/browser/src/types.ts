import { z } from 'zod'

// Browser launch options
export const BrowserOptionsSchema = z.object({
  headless: z.boolean().default(true),
  slowMo: z.number().optional(),
})
export type BrowserOptions = z.infer<typeof BrowserOptionsSchema>

// Element location info
export const ElementLocationSchema = z.object({
  selector: z.string(),
  boundingBox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable(),
})
export type ElementLocation = z.infer<typeof ElementLocationSchema>

// Element data returned from queries
export const ElementDataSchema = z.object({
  tagName: z.string(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  value: z.string().nullable(),
  checked: z.boolean().nullable(),
  disabled: z.boolean(),
  location: ElementLocationSchema,
})
export type ElementData = z.infer<typeof ElementDataSchema>

// Accessibility tree node
export const AccessibilityNodeSchema: z.ZodType<AccessibilityNode> = z.lazy(() =>
  z.object({
    role: z.string(),
    name: z.string().nullable(),
    value: z.string().nullable(),
    description: z.string().nullable(),
    // Heading depth from the snapshot's [level=N]. Absent on non-headings, and on a heading whose
    // level the snapshot did not state -- which is NOT the same as level 1.
    level: z.number().int().positive().optional(),
    children: z.array(AccessibilityNodeSchema),
  }),
)
export interface AccessibilityNode {
  role: string
  name: string | null
  value: string | null
  description: string | null
  level?: number
  children: AccessibilityNode[]
}

// Screenshot options
export const ScreenshotOptionsSchema = z.object({
  fullPage: z.boolean().default(false),
  type: z.enum(['png', 'jpeg']).default('png'),
})
export type ScreenshotOptions = z.infer<typeof ScreenshotOptionsSchema>
