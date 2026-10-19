import type { Page } from 'playwright'
import type { ElementNode, ElementTypeFlags, PageElementGraph } from './types.js'

// Port of taskgen/src/element-crawler.ts: getAccessibilityTree, convertToElementGraph and the helpers they call.

interface AXValue {
  value?: unknown
}

interface AXProperty {
  name: string
  value: AXValue
}

// The subset of CDP Accessibility.AXNode the conversion reads.
export interface AXNode {
  nodeId: string
  ignored: boolean
  ignoredReasons?: AXProperty[]
  role?: AXValue
  name?: AXValue
  description?: AXValue
  value?: AXValue
  properties?: AXProperty[]
  backendDOMNodeId?: number
}

const LANDMARK_ROLES = ['banner', 'main', 'navigation', 'search', 'complementary', 'contentinfo', 'form', 'region']
const INTERACTIVE_ROLES = [
  'button',
  'link',
  'menuitem',
  'checkbox',
  'radio',
  'textbox',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
]
const FORM_FIELD_ROLES = ['textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'searchbox']

// CDP types AXValue.value as any; taskgen used it as a string. Strings pass through unchanged.
function axText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : String(value)
}

export async function getAccessibilityTree(page: Page): Promise<AXNode[]> {
  const client = await page.context().newCDPSession(page)
  try {
    const { nodes } = await client.send('Accessibility.getFullAXTree')
    return nodes
  } finally {
    await client.detach()
  }
}

export function convertToElementGraph(
  axNodes: readonly AXNode[],
  pageUrl: string,
  pageTitle: string,
): PageElementGraph {
  const elements = new Map<string, ElementNode>()

  // Ignored and unnamed generic nodes are kept (taskgen dropped both) so the gap detector can bridge an
  // aria-hidden control or an unnamed clickable div to its AX node (F2).
  for (const axNode of axNodes) {
    const role = axText(axNode.role?.value) || 'generic'
    const name = axText(axNode.name?.value) || ''

    const xpath = generateXPathFromNodeId(axNode.nodeId)
    const elementId = `${pageUrl}#${xpath}`
    const typeFlags = computeTypeFlags(role, axNode.properties)

    const element: ElementNode = {
      id: elementId,
      pageUrl,
      xpath,
      role,
      name,
      description: axText(axNode.description?.value),
      value: axText(axNode.value?.value),
      backendDOMNodeId: axNode.backendDOMNodeId,
      ignored: axNode.ignored,
      ignoredReasons: (axNode.ignoredReasons ?? []).map((r) => r.name),
      typeFlags,
    }

    elements.set(elementId, element)
  }

  return {
    pageUrl,
    title: pageTitle,
    elements,
    crawledAt: new Date(),
    elementCount: elements.size,
  }
}

function computeTypeFlags(role: string, properties?: readonly AXProperty[]): ElementTypeFlags {
  let headingLevel: number | null = null
  if (role === 'heading') {
    const levelProp = properties?.find((p) => p.name === 'level')
    headingLevel = levelProp ? Number(levelProp.value.value) : 1
  }

  const isLandmark = LANDMARK_ROLES.includes(role)
  const isLink = role === 'link'

  return {
    isLandmark,
    landmarkRole: isLandmark ? role : null,
    isButton: role === 'button',
    isFormField: FORM_FIELD_ROLES.includes(role),
    isTable: role === 'table' || role === 'grid',
    isLink,
    isList: role === 'list',
    headingLevel,
    isInteractive: INTERACTIVE_ROLES.includes(role),
    isNavigational: isLink,
  }
}

function generateXPathFromNodeId(nodeId: string): string {
  return `node-${nodeId}`
}
