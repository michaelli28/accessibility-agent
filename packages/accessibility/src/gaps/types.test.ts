import { describe, it, expect } from 'vitest'
import {
  ACCESSIBILITY_GAP_TYPES,
  AccessibilityGapTypeSchema,
  AccessibilityGapSchema,
  DOMElementSchema,
  InteractivitySignalsSchema,
  type AccessibilityGap,
} from './types.js'

const signals = {
  hasClickHandler: true,
  hasCursorPointer: false,
  isSemanticInteractive: false,
  hasTabindex: false,
  tabindexValue: null,
  hasRoleAttribute: false,
  roleValue: null,
  hasAriaExpanded: false,
  classNameHints: ['btn'],
}

const domElement = {
  nodeId: 12,
  backendNodeId: 34,
  nodeName: 'DIV',
  localName: 'div',
  attributes: { class: 'btn' },
  boundingBox: null,
  pageUrl: 'http://fixture.test/',
}

describe('gap types', () => {
  it('lists exactly the five taskgen gap types', () => {
    expect([...ACCESSIBILITY_GAP_TYPES]).toEqual([
      'missing_from_a11y_tree',
      'no_accessible_name',
      'wrong_role',
      'not_focusable',
      'hidden_but_interactive',
    ])
  })

  it('rejects an unknown gap type', () => {
    expect(() => AccessibilityGapTypeSchema.parse('keyboard_trap')).toThrow()
  })

  it('accepts a DOM element whose bounding box is missing or null', () => {
    expect(DOMElementSchema.parse(domElement).boundingBox).toBeNull()
    const { boundingBox: _omit, ...withoutBox } = domElement
    expect(DOMElementSchema.parse(withoutBox).boundingBox).toBeUndefined()
  })

  it('rejects signals with a non-numeric tabindex value', () => {
    expect(() => InteractivitySignalsSchema.parse({ ...signals, tabindexValue: '0' })).toThrow()
  })

  it('parses a full gap and rejects a severity outside the impact scale', () => {
    const gap: AccessibilityGap = {
      domElement,
      signals,
      gapType: 'missing_from_a11y_tree',
      severity: 'critical',
      wcagViolations: ['4.1.2'],
      suggestedFix: 'Use a button.',
      evidence: 'DIV element with interactivity signals is not exposed in the accessibility tree',
    }
    expect(AccessibilityGapSchema.parse(gap)).toEqual(gap)
    expect(() => AccessibilityGapSchema.parse({ ...gap, severity: 'blocker' })).toThrow()
  })
})
