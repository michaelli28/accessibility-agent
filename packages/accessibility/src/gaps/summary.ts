import type { Impact } from '../types.js'
import { ACCESSIBILITY_GAP_TYPES, type AccessibilityGap, type AccessibilityGapType } from './types.js'

export interface GapSummary {
  total: number
  byType: Record<AccessibilityGapType, number>
  bySeverity: Record<Impact, number>
}

export function summarizeGaps(gaps: readonly AccessibilityGap[]): GapSummary {
  const byType = Object.fromEntries(ACCESSIBILITY_GAP_TYPES.map((t) => [t, 0])) as Record<AccessibilityGapType, number>
  const bySeverity: Record<Impact, number> = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  }

  for (const gap of gaps) {
    byType[gap.gapType]++
    bySeverity[gap.severity]++
  }

  return { total: gaps.length, byType, bySeverity }
}
