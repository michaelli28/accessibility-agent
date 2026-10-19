import { describe, it, expect } from 'vitest'
import { NavigatorState, NavigationResult, NavigableNode } from './types.js'
import { ScreenReaderNavigator } from './screen-reader-navigator.js'
import { BrowserClient, type AccessibilityNode } from '@at-agent/browser'

describe('Screen Reader Navigator Types', () => {
  it('should have NavigableNode type with required fields', () => {
    const node: NavigableNode = {
      role: 'button',
      name: 'Submit',
      value: null,
      level: undefined,
      children: [],
      isInteresting: true,
    }
    expect(node.role).toBe('button')
    expect(node.name).toBe('Submit')
    expect(node.isInteresting).toBe(true)
  })

  it('should have NavigatorState type', () => {
    const state: NavigatorState = {
      currentIndex: 0,
      nodes: [],
      mode: 'browse',
    }
    expect(state.mode).toBe('browse')
  })

  it('should have NavigationResult type', () => {
    const result: NavigationResult = {
      success: true,
      node: null,
      message: 'End of page',
    }
    expect(result.success).toBe(true)
  })
})

describe('ScreenReaderNavigator', () => {
  const mockTree: AccessibilityNode = {
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
      {
        role: 'button',
        name: 'Click me',
        value: null,
        description: null,
        children: [],
      },
      {
        role: 'link',
        name: 'Learn more',
        value: null,
        description: null,
        children: [],
      },
    ],
  }

  it('should initialize with empty state', () => {
    const navigator = new ScreenReaderNavigator()
    expect(navigator.getCurrentNode()).toBeNull()
  })

  it('should load accessibility tree', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)
    expect(navigator.getNodeCount()).toBeGreaterThan(0)
  })

  it('should move to next node', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    const result = navigator.moveNext()
    expect(result.success).toBe(true)
    expect(result.node?.role).toBe('heading')
    expect(result.node?.name).toBe('Welcome')
  })

  it('should move to previous node', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    navigator.moveNext() // heading
    navigator.moveNext() // button

    const result = navigator.movePrev()
    expect(result.success).toBe(true)
    expect(result.node?.role).toBe('heading')
  })

  it('should return failure at end of page', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    navigator.moveNext() // heading
    navigator.moveNext() // button
    navigator.moveNext() // link

    const result = navigator.moveNext()
    expect(result.success).toBe(false)
    expect(result.message).toBe('End of page')
  })

  it('should return failure at top of page', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)
    navigator.moveNext() // Move to first node
    const result = navigator.movePrev() // Try to go back before first
    expect(result.success).toBe(false)
    expect(result.message).toBe('Top of page')
  })

  it('should reset navigation position', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    navigator.moveNext() // heading
    navigator.moveNext() // button
    expect(navigator.getCurrentNode()?.role).toBe('button')

    navigator.reset()
    expect(navigator.getCurrentNode()).toBeNull()

    const result = navigator.moveNext()
    expect(result.success).toBe(true)
    expect(result.node?.role).toBe('heading')
  })

  it('should get and set navigation mode', () => {
    const navigator = new ScreenReaderNavigator()

    expect(navigator.getMode()).toBe('browse')

    navigator.setMode('focus')
    expect(navigator.getMode()).toBe('focus')

    navigator.setMode('browse')
    expect(navigator.getMode()).toBe('browse')
  })
})

describe('ScreenReaderNavigator - Role Navigation', () => {
  const mockTree: AccessibilityNode = {
    role: 'WebArea',
    name: 'Test Page',
    value: null,
    description: null,
    children: [
      { role: 'banner', name: 'Header', value: null, description: null, children: [] },
      { role: 'heading', name: 'Title', value: null, description: null, children: [] },
      { role: 'button', name: 'Action', value: null, description: null, children: [] },
      { role: 'heading', name: 'Section', value: null, description: null, children: [] },
      { role: 'main', name: 'Content', value: null, description: null, children: [] },
      { role: 'link', name: 'More', value: null, description: null, children: [] },
    ],
  }

  it('should move to next heading', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    const result = navigator.moveToNextHeading()
    expect(result.success).toBe(true)
    expect(result.node?.name).toBe('Title')
  })

  it('should move to previous heading', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    navigator.moveToNextHeading() // Title
    navigator.moveToNextHeading() // Section

    const result = navigator.moveToPrevHeading()
    expect(result.success).toBe(true)
    expect(result.node?.name).toBe('Title')
  })

  it('should move to next landmark', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    const result = navigator.moveToNextLandmark()
    expect(result.success).toBe(true)
    expect(result.node?.role).toBe('banner')
  })

  it('should move to main content', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    const result = navigator.moveToMain()
    expect(result.success).toBe(true)
    expect(result.node?.role).toBe('main')
  })

  it('should return failure when no more headings', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    navigator.moveToNextHeading() // Title
    navigator.moveToNextHeading() // Section

    const result = navigator.moveToNextHeading()
    expect(result.success).toBe(false)
    expect(result.message).toBe('No next heading')
  })

  it('should move to previous landmark', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    navigator.moveToNextLandmark() // banner
    navigator.moveToNextLandmark() // main

    const result = navigator.moveToPrevLandmark()
    expect(result.success).toBe(true)
    expect(result.node?.role).toBe('banner')
  })

  it('should return failure when no next landmark exists', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    navigator.moveToNextLandmark() // banner
    navigator.moveToNextLandmark() // main

    const result = navigator.moveToNextLandmark()
    expect(result.success).toBe(false)
    expect(result.message).toBe('No next landmark')
  })

  it('should return failure when no previous landmark exists', () => {
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(mockTree)

    navigator.moveToNextLandmark() // banner (first landmark)

    const result = navigator.moveToPrevLandmark()
    expect(result.success).toBe(false)
    expect(result.message).toBe('No previous landmark')
  })

  it('should return failure when no main landmark exists', () => {
    const treeWithoutMain: AccessibilityNode = {
      role: 'WebArea',
      name: 'Test Page',
      value: null,
      description: null,
      children: [
        { role: 'banner', name: 'Header', value: null, description: null, children: [] },
        { role: 'heading', name: 'Title', value: null, description: null, children: [] },
      ],
    }
    const navigator = new ScreenReaderNavigator()
    navigator.loadTree(treeWithoutMain)

    const result = navigator.moveToMain()
    expect(result.success).toBe(false)
    expect(result.message).toBe('No main content')
  })
})

describe('ScreenReaderNavigator on a real BrowserPage.accessibilityTree()', () => {
  it('browse mode reads prose, which the tree names text and paragraph', async () => {
    const client = new BrowserClient()
    await client.launch()
    try {
      const page = await client.newPage()
      await page.playwrightPage.setContent('<h1>Title</h1><p>Some prose.</p><p>Visit <a href="#x">the shop</a> today.</p>')
      const navigator = new ScreenReaderNavigator()
      navigator.loadTree(await page.accessibilityTree())

      const read: string[] = []
      for (let r = navigator.moveNext(); r.success; r = navigator.moveNext()) read.push(`${r.node?.role}:${r.node?.name}`)
      expect(read).toEqual(['heading:Title', 'paragraph:Some prose.', 'text:Visit', 'link:the shop', 'text:today.'])
    } finally {
      await client.close()
    }
  })
})
