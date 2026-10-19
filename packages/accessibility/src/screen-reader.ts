import type { BrowserPage, AccessibilityNode } from '@at-agent/browser'

export interface ReadableItem {
  role: string
  name: string | null
  value: string | null
  level?: number
}

export interface Heading {
  level: number
  text: string
}

export interface Landmark {
  role: string
  name: string | null
}

export class ScreenReaderSimulator {
  constructor(private readonly page: BrowserPage) {}

  async readPage(): Promise<ReadableItem[]> {
    const tree = await this.page.accessibilityTree()
    return this.flattenTree(tree)
  }

  async getHeadings(): Promise<Heading[]> {
    const tree = await this.page.accessibilityTree()
    return this.extractHeadings(tree)
  }

  async getLandmarks(): Promise<Landmark[]> {
    const tree = await this.page.accessibilityTree()
    return this.extractLandmarks(tree)
  }

  private flattenTree(node: AccessibilityNode): ReadableItem[] {
    const items: ReadableItem[] = []

    // Include this node if it has meaningful content
    if (this.isReadable(node)) {
      items.push({
        role: node.role,
        name: node.name,
        value: node.value,
      })
    }

    // Recurse into children
    for (const child of node.children) {
      items.push(...this.flattenTree(child))
    }

    return items
  }

  private isReadable(node: AccessibilityNode): boolean {
    // Include nodes that have names or are interactive
    const meaningfulRoles = [
      'heading',
      'link',
      'button',
      'textbox',
      'checkbox',
      'radio',
      'combobox',
      'listitem',
      'img',
      'figure',
      'paragraph',
      'text',
    ]
    return meaningfulRoles.includes(node.role) || (node.name !== null && node.name.trim() !== '')
  }

  private extractHeadings(node: AccessibilityNode, headings: Heading[] = []): Heading[] {
    if (node.role === 'heading' && node.name) {
      const level = this.getHeadingLevel(node)
      headings.push({ level, text: node.name })
    }

    for (const child of node.children) {
      this.extractHeadings(child, headings)
    }

    return headings
  }

  // The snapshot's own level. Falls back to 1 only when it stated none, which is a guess and is
  // why getHeadings' callers should not treat a lone level 1 as evidence of document structure.
  private getHeadingLevel(node: AccessibilityNode): number {
    return node.level ?? 1
  }

  private extractLandmarks(node: AccessibilityNode, landmarks: Landmark[] = []): Landmark[] {
    const landmarkRoles = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region']

    if (landmarkRoles.includes(node.role)) {
      landmarks.push({ role: node.role, name: node.name })
    }

    for (const child of node.children) {
      this.extractLandmarks(child, landmarks)
    }

    return landmarks
  }
}
