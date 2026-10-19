import { describe, it, expect } from 'vitest'
import {
  ImpactSchema,
  ViolationSchema,
  AuditResultSchema,
} from './types.js'

describe('ImpactSchema', () => {
  it('accepts valid impact levels', () => {
    expect(ImpactSchema.parse('critical')).toBe('critical')
    expect(ImpactSchema.parse('serious')).toBe('serious')
    expect(ImpactSchema.parse('moderate')).toBe('moderate')
    expect(ImpactSchema.parse('minor')).toBe('minor')
  })

  it('rejects invalid impact', () => {
    expect(() => ImpactSchema.parse('high')).toThrow()
  })
})

describe('ViolationSchema', () => {
  it('validates a complete violation', () => {
    const violation = {
      id: 'image-alt',
      impact: 'critical',
      description: 'Images must have alternate text',
      help: 'Ensure images have alt attributes',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.0/image-alt',
      wcagTags: ['wcag2a', 'wcag111'],
      nodes: [{
        html: '<img src="photo.jpg">',
        target: ['img'],
        failureSummary: 'Fix any of: Element does not have an alt attribute',
      }],
    }
    const result = ViolationSchema.parse(violation)
    expect(result.id).toBe('image-alt')
    expect(result.nodes).toHaveLength(1)
  })
})

describe('AuditResultSchema', () => {
  it('validates a complete audit result', () => {
    const result = {
      url: 'https://example.com',
      timestamp: '2024-01-15T00:00:00Z',
      violations: [],
      passes: [{ id: 'color-contrast', description: 'Elements have sufficient color contrast', nodeCount: 5 }],
      incomplete: [],
    }
    const parsed = AuditResultSchema.parse(result)
    expect(parsed.url).toBe('https://example.com')
    expect(parsed.passes).toHaveLength(1)
  })
})
