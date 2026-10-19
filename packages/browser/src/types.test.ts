import { describe, it, expect } from 'vitest'
import {
  BrowserOptionsSchema,
  ElementDataSchema,
  AccessibilityNodeSchema,
  ScreenshotOptionsSchema,
} from './types.js'

describe('BrowserOptionsSchema', () => {
  it('applies defaults for empty object', () => {
    const result = BrowserOptionsSchema.parse({})
    expect(result).toEqual({ headless: true })
  })

  it('accepts valid options', () => {
    const result = BrowserOptionsSchema.parse({ headless: false, slowMo: 100 })
    expect(result).toEqual({ headless: false, slowMo: 100 })
  })

  it('rejects invalid headless value', () => {
    expect(() => BrowserOptionsSchema.parse({ headless: 'yes' })).toThrow()
  })
})

describe('ElementDataSchema', () => {
  it('validates complete element data', () => {
    const element = {
      tagName: 'button',
      role: 'button',
      name: 'Submit',
      value: null,
      checked: null,
      disabled: false,
      location: {
        selector: 'button.submit',
        boundingBox: { x: 10, y: 20, width: 100, height: 40 },
      },
    }
    const result = ElementDataSchema.parse(element)
    expect(result.tagName).toBe('button')
    expect(result.role).toBe('button')
  })
})

describe('AccessibilityNodeSchema', () => {
  it('validates nested accessibility tree', () => {
    const tree = {
      role: 'WebArea',
      name: 'Test Page',
      value: null,
      description: null,
      children: [
        {
          role: 'heading',
          name: 'Welcome',
          value: null,
          description: null,
          children: [],
        },
      ],
    }
    const result = AccessibilityNodeSchema.parse(tree)
    expect(result.role).toBe('WebArea')
    expect(result.children).toHaveLength(1)
    expect(result.children[0].role).toBe('heading')
  })
})

describe('ScreenshotOptionsSchema', () => {
  it('applies defaults', () => {
    const result = ScreenshotOptionsSchema.parse({})
    expect(result).toEqual({ fullPage: false, type: 'png' })
  })
})
