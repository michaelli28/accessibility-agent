import { describe, it, expect } from 'vitest'
import { summarizeGaps } from './summary.js'
import type { AccessibilityGap } from './types.js'

function gap(gapType: AccessibilityGap['gapType'], severity: AccessibilityGap['severity']): AccessibilityGap {
  return {
    domElement: {
      nodeId: 1,
      backendNodeId: 2,
      nodeName: 'DIV',
      localName: 'div',
      attributes: {},
      boundingBox: null,
      pageUrl: 'http://fixture.test/',
    },
    signals: {
      hasClickHandler: true,
      hasCursorPointer: false,
      isSemanticInteractive: false,
      hasTabindex: false,
      tabindexValue: null,
      hasRoleAttribute: false,
      roleValue: null,
      hasAriaExpanded: false,
      classNameHints: [],
    },
    gapType,
    severity,
    wcagViolations: [],
    evidence: '',
  }
}

describe('summarizeGaps', () => {
  it('returns zeroed counts for every type and severity when there are no gaps', () => {
    expect(summarizeGaps([])).toEqual({
      total: 0,
      byType: {
        missing_from_a11y_tree: 0,
        no_accessible_name: 0,
        wrong_role: 0,
        not_focusable: 0,
        hidden_but_interactive: 0,
      },
      bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    })
  })

  it('counts gaps by type and severity', () => {
    const summary = summarizeGaps([
      gap('missing_from_a11y_tree', 'critical'),
      gap('missing_from_a11y_tree', 'critical'),
      gap('no_accessible_name', 'serious'),
    ])
    expect(summary.total).toBe(3)
    expect(summary.byType.missing_from_a11y_tree).toBe(2)
    expect(summary.byType.no_accessible_name).toBe(1)
    expect(summary.bySeverity).toEqual({
      critical: 2,
      serious: 1,
      moderate: 0,
      minor: 0,
    })
  })
})
