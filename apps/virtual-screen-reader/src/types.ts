/**
 * Represents a node in the Accessibility Tree as returned by CDP.
 * Based on Protocol.Accessibility.AXNode
 */
export interface AXNode {
    nodeId: string;
    ignored: boolean;
    ignoredReasons?: { reason: string }[];
    role?: AXValue;
    name?: AXValue;
    description?: AXValue;
    value?: AXValue;
    properties?: AXProperty[];
    childIds?: string[];
    backendDOMNodeId?: number;
    frameId?: string;
    /**
     * Locator path for Playwright-based element identification (Firefox/WebKit).
     * Array of role:index segments, e.g., ['main', 'list', 'listitem:2', 'link'].
     * Used when backendDOMNodeId is not available (non-CDP browsers).
     */
    locatorPath?: string[];
}

export interface AXValue {
    type: AXValueType;
    value?: any;
    relatedNodes?: AXRelatedNode[];
    sources?: AXValueSource[];
}

export type AXValueType =
    | 'boolean'
    | 'tristate'
    | 'booleanOrUndefined'
    | 'idref'
    | 'idrefList'
    | 'integer'
    | 'node'
    | 'nodeList'
    | 'number'
    | 'string'
    | 'computedString'
    | 'token'
    | 'tokenList'
    | 'domRelation'
    | 'role'
    | 'internalRole'
    | 'valueUndefined';

export interface AXProperty {
    name: string;
    value: AXValue;
}

export interface AXRelatedNode {
    backendDOMNodeId: number;
    idref?: string;
    text?: string;
}

export interface AXValueSource {
    type: string;
    value?: AXValue;
    attribute?: string;
    attributeValue?: AXValue;
    superseded?: boolean;
    nativeSource?: string;
    nativeSourceValue?: AXValue;
    invalid?: boolean;
    invalidReason?: string;
}

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

// ============================================================================
// AX Tree Navigation Types
// ============================================================================

/**
 * Extended AX node with navigation-friendly structure.
 * Built from flat CDP AXNode array into a navigable tree.
 */
export interface NavigableAXNode extends AXNode {
    /** Parent node in tree (null for root) */
    parent: NavigableAXNode | null;
    /** Child nodes */
    children: NavigableAXNode[];
    /** Depth in tree (0 = root) */
    depth: number;
    /** Position in document order (0-indexed) */
    domOrder: number;
    /** Whether this node is worth stopping on during navigation */
    isInteresting: boolean;
    /** Resolved role string (from role.value) */
    computedRole: string;
    /** Resolved accessible name (from name.value) */
    computedName: string;
    /** Parsed state/property flags */
    states: AXStateFlags;
    /** Nodes controlled by this element (from aria-controls) */
    controlledNodes?: NavigableAXNode[];
    /** Node that controls this element (reverse of aria-controls) */
    controllerNode?: NavigableAXNode;
}

/**
 * Parsed accessibility state flags from AX properties.
 */
export interface AXStateFlags {
    // Boolean states
    expanded?: boolean;
    pressed?: boolean | 'mixed';
    checked?: boolean | 'mixed';
    selected?: boolean;
    disabled?: boolean;
    hidden?: boolean;
    invalid?: boolean;
    busy?: boolean;
    focused?: boolean;
    required?: boolean;
    readonly?: boolean;
    multiselectable?: boolean;
    hasPopup?: boolean | string;
    autocomplete?: string;

    // Value states
    valueNow?: number;
    valueMin?: number;
    valueMax?: number;
    valueText?: string;

    // Position/hierarchy states
    setSize?: number;
    posInSet?: number;
    level?: number;

    // Live region states
    live?: 'off' | 'polite' | 'assertive';
    atomic?: boolean;
    relevant?: string;

    // Orientation
    orientation?: 'horizontal' | 'vertical';
}

/**
 * Result of a navigation action.
 */
export interface NavigationResult {
    /** The node we navigated to (null if navigation failed) */
    node: NavigableAXNode | null;
    /** Message to announce (boundary messages, errors) */
    message: string;
    /** Whether navigation succeeded */
    success: boolean;
}

/**
 * Navigation command types.
 */
export type NavigationCommand =
    | { type: 'next' }
    | { type: 'prev' }
    | { type: 'nextByRole'; role: string | string[] }
    | { type: 'prevByRole'; role: string | string[] }
    | { type: 'nextHeading' }
    | { type: 'prevHeading' }
    | { type: 'nextHeadingLevel'; level: number }
    | { type: 'prevHeadingLevel'; level: number }
    | { type: 'nextLandmark' }
    | { type: 'prevLandmark' }
    | { type: 'nextButton' }
    | { type: 'prevButton' }
    | { type: 'nextLink' }
    | { type: 'prevLink' }
    | { type: 'nextFormField' }
    | { type: 'prevFormField' }
    | { type: 'nextTable' }
    | { type: 'prevTable' }
    | { type: 'nextList' }
    | { type: 'prevList' }
    | { type: 'main' }
    | { type: 'nextFocusable' }
    | { type: 'prevFocusable' };

/**
 * Key to navigation command mapping (Browse Mode).
 */
export const KEY_TO_COMMAND: Record<string, NavigationCommand> = {
    'ArrowDown': { type: 'next' },
    'ArrowUp': { type: 'prev' },
    'h': { type: 'nextHeading' },
    'H': { type: 'prevHeading' },
    'Shift+h': { type: 'prevHeading' },
    'b': { type: 'nextButton' },
    'B': { type: 'prevButton' },
    'Shift+b': { type: 'prevButton' },
    'k': { type: 'nextLink' },
    'K': { type: 'prevLink' },
    'Shift+k': { type: 'prevLink' },
    'f': { type: 'nextFormField' },
    'F': { type: 'prevFormField' },
    'Shift+f': { type: 'prevFormField' },
    't': { type: 'nextTable' },
    'T': { type: 'prevTable' },
    'Shift+t': { type: 'prevTable' },
    'l': { type: 'nextList' },
    'L': { type: 'prevList' },
    'Shift+l': { type: 'prevList' },
    'd': { type: 'nextLandmark' },
    'D': { type: 'prevLandmark' },
    'Shift+d': { type: 'prevLandmark' },
    'q': { type: 'main' },
    '1': { type: 'nextHeadingLevel', level: 1 },
    '2': { type: 'nextHeadingLevel', level: 2 },
    '3': { type: 'nextHeadingLevel', level: 3 },
    '4': { type: 'nextHeadingLevel', level: 4 },
    '5': { type: 'nextHeadingLevel', level: 5 },
    '6': { type: 'nextHeadingLevel', level: 6 },
    'Tab': { type: 'nextFocusable' },
    'Shift+Tab': { type: 'prevFocusable' },
};

/**
 * Table navigation commands.
 */
export type TableNavigationCommand =
    | { type: 'tableCellRight' }
    | { type: 'tableCellLeft' }
    | { type: 'tableCellDown' }
    | { type: 'tableCellUp' };

/**
 * Key to table navigation command mapping.
 * Uses Ctrl+Alt+Arrow like NVDA/JAWS.
 */
export const TABLE_NAV_COMMANDS: Record<string, TableNavigationCommand> = {
    'Control+Alt+ArrowRight': { type: 'tableCellRight' },
    'Control+Alt+ArrowLeft': { type: 'tableCellLeft' },
    'Control+Alt+ArrowDown': { type: 'tableCellDown' },
    'Control+Alt+ArrowUp': { type: 'tableCellUp' },
};

/**
 * Screen reader interaction mode.
 */
export type InteractionMode = 'browse' | 'forms';

/**
 * Roles that trigger forms mode when focused/activated.
 */
export const FORMS_MODE_ROLES = new Set([
    'textbox',
    'searchbox',
    'spinbutton',
    'combobox',
    'listbox',
    'textarea',
]);

/**
 * Table context for table navigation.
 */
export interface TableContext {
    tableNode: NavigableAXNode;
    currentRow: number;
    currentCol: number;
    rowCount: number;
    colCount: number;
}

/**
 * Cached AX tree with metadata.
 */
export interface CachedAXTree {
    root: NavigableAXNode | null;
    flatNodes: NavigableAXNode[];
    interestingNodes: NavigableAXNode[];
    timestamp: number;
    url: string;
}
