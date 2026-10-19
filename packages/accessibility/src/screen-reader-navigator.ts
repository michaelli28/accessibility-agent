import type { AccessibilityNode } from '@at-agent/browser'
import type { NavigableNode, NavigatorState, NavigationResult, NavigationMode } from './types.js'

const INTERESTING_ROLES = new Set([
  'heading',
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'tablist',
  'menu',
  'menuitem',
  'table',
  'row',
  'cell',
  'banner',
  'main',
  'navigation',
  'complementary',
  'contentinfo',
  'search',
  'form',
  'region',
  'alert',
  'dialog',
  'img',
  'list',
  'listitem',
])

const LANDMARK_ROLES = new Set([
  'banner',
  'main',
  'navigation',
  'complementary',
  'contentinfo',
  'search',
  'form',
  'region',
])

export class ScreenReaderNavigator {
  private state: NavigatorState = {
    currentIndex: -1,
    nodes: [],
    mode: 'browse',
  }

  loadTree(tree: AccessibilityNode): void {
    this.state.nodes = this.flattenTree(tree)
    this.state.currentIndex = -1
  }

  private flattenTree(node: AccessibilityNode, depth = 0): NavigableNode[] {
    const nodes: NavigableNode[] = []

    const navigable: NavigableNode = {
      role: node.role,
      name: node.name,
      value: node.value,
      level: this.extractLevel(node),
      children: [],
      isInteresting: this.isInteresting(node),
    }

    if (navigable.isInteresting) {
      nodes.push(navigable)
    }

    for (const child of node.children) {
      nodes.push(...this.flattenTree(child, depth + 1))
    }

    return nodes
  }

  private isInteresting(node: AccessibilityNode): boolean {
    if (INTERESTING_ROLES.has(node.role)) {
      return true
    }
    // Prose as BrowserPage.accessibilityTree (Playwright's ariaSnapshot) names it; a paragraph with inline children
    // is unnamed and read through its text children.
    if ((node.role === 'text' || node.role === 'paragraph') && node.name && node.name.trim().length > 0) {
      return true
    }
    return false
  }

  // undefined, not 1, when the snapshot stated no level: a navigator that invents a depth would
  // make every page look like a flat run of h1s.
  private extractLevel(node: AccessibilityNode): number | undefined {
    return node.role === 'heading' ? node.level : undefined
  }

  getCurrentNode(): NavigableNode | null {
    if (this.state.currentIndex >= 0 && this.state.currentIndex < this.state.nodes.length) {
      return this.state.nodes[this.state.currentIndex]
    }
    return null
  }

  getNodeCount(): number {
    return this.state.nodes.length
  }

  getMode(): NavigationMode {
    return this.state.mode
  }

  setMode(mode: NavigationMode): void {
    this.state.mode = mode
  }

  moveNext(): NavigationResult {
    const nextIndex = this.state.currentIndex + 1
    if (nextIndex < this.state.nodes.length) {
      this.state.currentIndex = nextIndex
      return {
        success: true,
        node: this.state.nodes[nextIndex],
        message: '',
      }
    }
    return {
      success: false,
      node: this.getCurrentNode(),
      message: 'End of page',
    }
  }

  movePrev(): NavigationResult {
    if (this.state.currentIndex > 0) {
      this.state.currentIndex--
      return {
        success: true,
        node: this.state.nodes[this.state.currentIndex],
        message: '',
      }
    }
    return {
      success: false,
      node: this.getCurrentNode(),
      message: 'Top of page',
    }
  }

  reset(): void {
    this.state.currentIndex = -1
  }

  moveToNextHeading(): NavigationResult {
    return this.moveToNextByRole('heading')
  }

  moveToPrevHeading(): NavigationResult {
    return this.moveToPrevByRole('heading')
  }

  moveToNextLandmark(): NavigationResult {
    for (let i = this.state.currentIndex + 1; i < this.state.nodes.length; i++) {
      if (LANDMARK_ROLES.has(this.state.nodes[i].role)) {
        this.state.currentIndex = i
        return { success: true, node: this.state.nodes[i], message: '' }
      }
    }
    return { success: false, node: this.getCurrentNode(), message: 'No next landmark' }
  }

  moveToPrevLandmark(): NavigationResult {
    for (let i = this.state.currentIndex - 1; i >= 0; i--) {
      if (LANDMARK_ROLES.has(this.state.nodes[i].role)) {
        this.state.currentIndex = i
        return { success: true, node: this.state.nodes[i], message: '' }
      }
    }
    return { success: false, node: this.getCurrentNode(), message: 'No previous landmark' }
  }

  moveToMain(): NavigationResult {
    for (let i = 0; i < this.state.nodes.length; i++) {
      if (this.state.nodes[i].role === 'main') {
        this.state.currentIndex = i
        return { success: true, node: this.state.nodes[i], message: '' }
      }
    }
    return { success: false, node: this.getCurrentNode(), message: 'No main content' }
  }

  moveToNextByRole(role: string): NavigationResult {
    for (let i = this.state.currentIndex + 1; i < this.state.nodes.length; i++) {
      if (this.state.nodes[i].role === role) {
        this.state.currentIndex = i
        return { success: true, node: this.state.nodes[i], message: '' }
      }
    }
    return { success: false, node: this.getCurrentNode(), message: `No next ${role}` }
  }

  moveToPrevByRole(role: string): NavigationResult {
    for (let i = this.state.currentIndex - 1; i >= 0; i--) {
      if (this.state.nodes[i].role === role) {
        this.state.currentIndex = i
        return { success: true, node: this.state.nodes[i], message: '' }
      }
    }
    return { success: false, node: this.getCurrentNode(), message: `No previous ${role}` }
  }
}
