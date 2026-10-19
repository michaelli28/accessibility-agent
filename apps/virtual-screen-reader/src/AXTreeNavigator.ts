/**
 * AXTreeNavigator - Navigation controller operating on the Accessibility Tree.
 *
 * This replaces the DOM-based NavigationController. Instead of using TreeWalker
 * on the DOM, we navigate the browser's computed accessibility tree via CDP.
 */

import {
    AXNode,
    AXProperty,
    NavigableAXNode,
    AXStateFlags,
    NavigationResult,
} from './types';

// Roles that are always worth stopping on during navigation
const INTERESTING_ROLES = new Set([
    // Landmarks
    'banner', 'main', 'navigation', 'complementary', 'contentinfo',
    'search', 'form', 'region',

    // Headings
    'heading',

    // Interactive - Buttons & Links
    'button', 'link',

    // Interactive - Form Controls
    'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'option', 'switch', 'slider', 'spinbutton',

    // Interactive - Menus
    'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio',

    // Interactive - Tabs
    'tab', 'tablist', 'tabpanel',

    // Interactive - Trees
    'tree', 'treeitem', 'treegrid',

    // Interactive - Grids
    'grid', 'gridcell', 'row', 'rowheader', 'columnheader',

    // Lists
    'list', 'listitem',

    // Tables
    'table', 'cell',

    // Media & Figures
    'img', 'figure',

    // Dialogs & Alerts
    'dialog', 'alertdialog', 'alert', 'status', 'log', 'marquee', 'timer',

    // Progress
    'progressbar', 'meter',

    // Misc Structure
    'article', 'toolbar', 'tooltip', 'definition', 'term', 'note',

    // Document - NOT rootwebarea/webarea (those are container roles)
    'document', 'application',
]);

// Roles that should NEVER be considered interesting (internal/structural)
const NEVER_INTERESTING_ROLES = new Set([
    'rootwebarea',
    'webarea',
    'inlinetextbox',
    'linebreak',
    'generic',
    'none',
    'presentation',
    'ignorednode',
    'unknown',
]);

// Roles that are focusable (for Tab navigation)
export const FOCUSABLE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
    'combobox', 'listbox', 'slider', 'spinbutton', 'switch',
    'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'treeitem', 'gridcell', 'option', 'row',
]);

// Roles that are landmarks
const LANDMARK_ROLES = new Set([
    'banner', 'main', 'navigation', 'complementary', 'contentinfo',
    'search', 'form', 'region',
]);

// Roles for form fields
const FORM_FIELD_ROLES = new Set([
    'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
    'listbox', 'slider', 'spinbutton', 'switch',
]);

/**
 * Extracts the role string from an AX node.
 */
function extractRole(node: AXNode): string {
    if (node.role?.value) {
        return String(node.role.value).toLowerCase();
    }
    return 'generic';
}

/**
 * Extracts the accessible name from an AX node.
 */
function extractName(node: AXNode): string {
    if (node.name?.value) {
        return String(node.name.value);
    }
    return '';
}

/**
 * Extracts state flags from AX properties.
 */
function extractStates(properties?: AXProperty[]): AXStateFlags {
    const states: AXStateFlags = {};

    if (!properties) return states;

    for (const prop of properties) {
        const name = prop.name;
        const value = prop.value?.value;

        switch (name) {
            case 'expanded':
                states.expanded = value === true;
                break;
            case 'pressed':
                states.pressed = value === 'mixed' ? 'mixed' : value === true;
                break;
            case 'checked':
                states.checked = value === 'mixed' ? 'mixed' : value === true;
                break;
            case 'selected':
                states.selected = value === true;
                break;
            case 'disabled':
                states.disabled = value === true;
                break;
            case 'hidden':
                states.hidden = value === true;
                break;
            case 'invalid':
                states.invalid = value === true || value === 'true';
                break;
            case 'busy':
                states.busy = value === true;
                break;
            case 'focused':
                states.focused = value === true;
                break;
            case 'required':
                states.required = value === true;
                break;
            case 'readonly':
                states.readonly = value === true;
                break;
            case 'multiselectable':
                states.multiselectable = value === true;
                break;
            case 'hasPopup':
                // hasPopup can be true or a string like "menu", "listbox", "tree", "grid", "dialog"
                states.hasPopup = (value === true || (typeof value === 'string' && value)) ? value : false;
                break;
            case 'autocomplete':
                states.autocomplete = String(value);
                break;
            case 'valueMin':
                states.valueMin = Number(value);
                break;
            case 'valueMax':
                states.valueMax = Number(value);
                break;
            case 'valueNow':
                states.valueNow = Number(value);
                break;
            case 'valueText':
                states.valueText = String(value);
                break;
            case 'setSize':
                states.setSize = Number(value);
                break;
            case 'posInSet':
                states.posInSet = Number(value);
                break;
            case 'level':
                states.level = Number(value);
                break;
            case 'live':
                states.live = value as 'off' | 'polite' | 'assertive';
                break;
            case 'atomic':
                states.atomic = value === true;
                break;
            case 'relevant':
                states.relevant = String(value);
                break;
            case 'orientation':
                states.orientation = value as 'horizontal' | 'vertical';
                break;
        }
    }

    return states;
}

/**
 * Determines if a node is "interesting" for navigation.
 */
function calculateIsInteresting(node: NavigableAXNode): boolean {
    // Never interesting if ignored by the browser
    if (node.ignored) return false;

    // Never interesting if hidden
    if (node.states.hidden) return false;

    // Never interesting for internal/structural roles
    if (NEVER_INTERESTING_ROLES.has(node.computedRole)) {
        return false;
    }

    // Always interesting if it has a meaningful role
    if (INTERESTING_ROLES.has(node.computedRole)) {
        return true;
    }

    // Static text: only interesting if it's standalone (not inside a named parent)
    if (node.computedRole === 'statictext') {
        // Skip if parent already has the same or similar name
        if (node.parent && node.parent.computedName) {
            const parentName = node.parent.computedName.trim().toLowerCase();
            const nodeName = (node.computedName || '').trim().toLowerCase();
            // If parent's name contains this text, skip it
            if (parentName.includes(nodeName) || nodeName.includes(parentName)) {
                return false;
            }
        }
        // Only interesting if it has actual content
        return node.computedName ? node.computedName.trim().length > 0 : false;
    }

    // Paragraph with text is interesting (for reading content)
    if (node.computedRole === 'paragraph' && node.computedName && node.computedName.trim().length > 0) {
        return true;
    }

    return false;
}

/**
 * AXTreeNavigator manages navigation through the accessibility tree.
 */
export class AXTreeNavigator {
    private root: NavigableAXNode | null = null;
    private flatNodes: NavigableAXNode[] = [];
    private interestingNodes: NavigableAXNode[] = [];
    private currentIndex: number = -1;

    /**
     * Builds a navigable tree from flat CDP AX nodes.
     * Preserves navigation position if possible.
     */
    buildNavigableTree(flatNodes: AXNode[]): NavigableAXNode | null {
        // Save current position to restore after rebuild
        const previousNode = this.getCurrentNode();
        const previousBackendNodeId = previousNode?.backendDOMNodeId;
        const previousNodeId = previousNode?.nodeId;

        if (flatNodes.length === 0) {
            this.root = null;
            this.flatNodes = [];
            this.interestingNodes = [];
            this.currentIndex = -1;
            return null;
        }

        // Create lookup map with extended node properties
        const nodeMap = new Map<string, NavigableAXNode>();

        for (const node of flatNodes) {
            const navigable: NavigableAXNode = {
                ...node,
                parent: null,
                children: [],
                depth: 0,
                domOrder: 0,
                isInteresting: false,
                computedRole: extractRole(node),
                computedName: extractName(node),
                states: extractStates(node.properties),
            };
            nodeMap.set(node.nodeId, navigable);
        }

        // Link parent/child relationships
        for (const node of nodeMap.values()) {
            if (node.childIds) {
                for (const childId of node.childIds) {
                    const child = nodeMap.get(childId);
                    if (child) {
                        child.parent = node;
                        node.children.push(child);
                    }
                }
            }
        }

        // Find root (node with no parent)
        let root: NavigableAXNode | null = null;
        for (const node of nodeMap.values()) {
            if (!node.parent) {
                root = node;
                break;
            }
        }

        if (!root) {
            // Fallback: use first node
            root = nodeMap.values().next().value || null;
        }

        // Calculate depths, dom order, and interesting flag via DFS
        this.flatNodes = [];
        this.interestingNodes = [];

        const traverse = (node: NavigableAXNode, depth: number) => {
            node.depth = depth;
            node.domOrder = this.flatNodes.length;
            node.isInteresting = calculateIsInteresting(node);

            this.flatNodes.push(node);
            if (node.isInteresting) {
                this.interestingNodes.push(node);
            }

            for (const child of node.children) {
                traverse(child, depth + 1);
            }
        };

        if (root) {
            traverse(root, 0);
        }

        this.root = root;

        // Try to restore previous position
        let restored = false;

        if (previousBackendNodeId) {
            // First try by backendNodeId (most reliable across refreshes)
            const idx = this.interestingNodes.findIndex(n => n.backendDOMNodeId === previousBackendNodeId);
            if (idx >= 0) {
                this.currentIndex = idx;
                restored = true;
            }
        }

        if (!restored && previousNodeId) {
            // Fallback to nodeId
            const idx = this.interestingNodes.findIndex(n => n.nodeId === previousNodeId);
            if (idx >= 0) {
                this.currentIndex = idx;
                restored = true;
            }
        }

        if (!restored && previousNode) {
            // Try to find a node with similar characteristics (same role and name)
            const idx = this.interestingNodes.findIndex(n =>
                n.computedRole === previousNode.computedRole &&
                n.computedName === previousNode.computedName &&
                n.computedName // Only match if name is non-empty
            );
            if (idx >= 0) {
                this.currentIndex = idx;
                restored = true;
            }
        }

        if (!restored && previousNode && previousNode.domOrder !== undefined) {
            // Last resort: find the closest node by previous DOM order
            // This prevents jumping to the start when the exact node is gone
            const prevOrder = previousNode.domOrder;
            let closestIdx = -1;
            let closestDist = Infinity;

            for (let i = 0; i < this.interestingNodes.length; i++) {
                const dist = Math.abs(this.interestingNodes[i].domOrder - prevOrder);
                if (dist < closestDist) {
                    closestDist = dist;
                    closestIdx = i;
                }
            }

            if (closestIdx >= 0) {
                this.currentIndex = closestIdx;
                restored = true;
            }
        }

        if (!restored) {
            this.currentIndex = -1; // Will be set to 0 on first navigation
        }

        return root;
    }

    /**
     * Gets the current node.
     */
    getCurrentNode(): NavigableAXNode | null {
        if (this.currentIndex >= 0 && this.currentIndex < this.interestingNodes.length) {
            return this.interestingNodes[this.currentIndex];
        }
        return null;
    }

    /**
     * Gets the backend DOM node ID for the current node.
     */
    getCurrentBackendNodeId(): number | null {
        const node = this.getCurrentNode();
        return node?.backendDOMNodeId ?? null;
    }

    /**
     * Resets navigation to the beginning.
     */
    reset(): void {
        this.currentIndex = -1;
    }

    /**
     * Moves to the next interesting node.
     * If current node is expanded and has aria-controls, jump into controlled content.
     */
    moveNext(): NavigationResult {
        if (this.interestingNodes.length === 0) {
            const totalNodes = this.flatNodes.length;
            const message = totalNodes === 0
                ? 'No accessibility tree available'
                : `No navigable content (${totalNodes} nodes in tree, none are interesting)`;
            return { node: null, message, success: false };
        }

        const current = this.getCurrentNode();

        // If current node is expanded AND has controlled nodes (via aria-controls), jump to controlled content
        if (current?.states.expanded && current.controlledNodes && current.controlledNodes.length > 0) {
            const controlledNode = current.controlledNodes[0];
            const targetNode = this.findFirstInterestingInSubtree(controlledNode);

            if (targetNode) {
                const targetIndex = this.interestingNodes.indexOf(targetNode);
                if (targetIndex >= 0) {
                    this.currentIndex = targetIndex;
                    return {
                        node: targetNode,
                        message: '',
                        success: true,
                    };
                }
            }
        }

        // Handle initial state (currentIndex = -1) or normal forward navigation
        const nextIndex = this.currentIndex + 1;
        if (nextIndex < this.interestingNodes.length) {
            this.currentIndex = nextIndex;
            return {
                node: this.interestingNodes[this.currentIndex],
                message: '',
                success: true,
            };
        }

        return {
            node: this.getCurrentNode(),
            message: 'End of page',
            success: false,
        };
    }

    /**
     * Finds the first interesting node within a subtree (including the node itself).
     */
    private findFirstInterestingInSubtree(node: NavigableAXNode): NavigableAXNode | null {
        // If this node is interesting, return it
        if (node.isInteresting) {
            return node;
        }

        // Otherwise, search children in order
        for (const child of node.children) {
            const found = this.findFirstInterestingInSubtree(child);
            if (found) return found;
        }

        return null;
    }

    /**
     * Moves to the previous interesting node.
     * If at the start of controlled content, return to the controller.
     */
    movePrev(): NavigationResult {
        if (this.interestingNodes.length === 0) {
            return { node: null, message: 'No content', success: false };
        }

        const current = this.getCurrentNode();

        // If current node has a controller, check if we should jump back to it
        if (current?.controllerNode) {
            // Check if the previous node in the flat list is NOT controlled by the same controller
            // This means we're at the "start" of the controlled content
            const prevIndex = this.currentIndex - 1;
            const prevNode = prevIndex >= 0 ? this.interestingNodes[prevIndex] : null;

            // If prev node is the controller itself, or has a different/no controller,
            // we're at the boundary - jump to controller
            const isAtBoundary = !prevNode ||
                prevNode === current.controllerNode ||
                prevNode.controllerNode !== current.controllerNode;

            if (isAtBoundary) {
                const controllerIndex = this.interestingNodes.indexOf(current.controllerNode);
                if (controllerIndex >= 0) {
                    this.currentIndex = controllerIndex;
                    return {
                        node: current.controllerNode,
                        message: '',
                        success: true,
                    };
                }
            }
        }

        if (this.currentIndex > 0) {
            this.currentIndex--;
            return {
                node: this.interestingNodes[this.currentIndex],
                message: '',
                success: true,
            };
        }

        if (this.currentIndex === -1 && this.interestingNodes.length > 0) {
            // First navigation - go to first element
            this.currentIndex = 0;
            return {
                node: this.interestingNodes[0],
                message: '',
                success: true,
            };
        }

        return {
            node: this.getCurrentNode(),
            message: 'Top of page',
            success: false,
        };
    }

    /**
     * Moves to the next node matching any of the given roles.
     */
    moveToNextByRole(roles: string | string[]): NavigationResult {
        const roleSet = new Set(Array.isArray(roles) ? roles : [roles]);

        for (let i = this.currentIndex + 1; i < this.interestingNodes.length; i++) {
            const node = this.interestingNodes[i];
            if (roleSet.has(node.computedRole)) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        const roleNames = Array.from(roleSet).join('/');
        return {
            node: this.getCurrentNode(),
            message: `No next ${roleNames}`,
            success: false,
        };
    }

    /**
     * Moves to the previous node matching any of the given roles.
     */
    moveToPrevByRole(roles: string | string[]): NavigationResult {
        const roleSet = new Set(Array.isArray(roles) ? roles : [roles]);

        for (let i = this.currentIndex - 1; i >= 0; i--) {
            const node = this.interestingNodes[i];
            if (roleSet.has(node.computedRole)) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        const roleNames = Array.from(roleSet).join('/');
        return {
            node: this.getCurrentNode(),
            message: `No previous ${roleNames}`,
            success: false,
        };
    }

    // =========================================================================
    // Heading Navigation
    // =========================================================================

    moveToNextHeading(): NavigationResult {
        return this.moveToNextByRole('heading');
    }

    moveToPrevHeading(): NavigationResult {
        return this.moveToPrevByRole('heading');
    }

    moveToNextHeadingLevel(level: number): NavigationResult {
        for (let i = this.currentIndex + 1; i < this.interestingNodes.length; i++) {
            const node = this.interestingNodes[i];
            if (node.computedRole === 'heading' && node.states.level === level) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        return {
            node: this.getCurrentNode(),
            message: `No next heading level ${level}`,
            success: false,
        };
    }

    moveToPrevHeadingLevel(level: number): NavigationResult {
        for (let i = this.currentIndex - 1; i >= 0; i--) {
            const node = this.interestingNodes[i];
            if (node.computedRole === 'heading' && node.states.level === level) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        return {
            node: this.getCurrentNode(),
            message: `No previous heading level ${level}`,
            success: false,
        };
    }

    // =========================================================================
    // Landmark Navigation
    // =========================================================================

    moveToNextLandmark(): NavigationResult {
        for (let i = this.currentIndex + 1; i < this.interestingNodes.length; i++) {
            const node = this.interestingNodes[i];
            if (LANDMARK_ROLES.has(node.computedRole)) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        return {
            node: this.getCurrentNode(),
            message: 'No next landmark',
            success: false,
        };
    }

    moveToPrevLandmark(): NavigationResult {
        for (let i = this.currentIndex - 1; i >= 0; i--) {
            const node = this.interestingNodes[i];
            if (LANDMARK_ROLES.has(node.computedRole)) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        return {
            node: this.getCurrentNode(),
            message: 'No previous landmark',
            success: false,
        };
    }

    moveToMain(): NavigationResult {
        for (let i = 0; i < this.interestingNodes.length; i++) {
            const node = this.interestingNodes[i];
            if (node.computedRole === 'main') {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        return {
            node: this.getCurrentNode(),
            message: 'No main content found',
            success: false,
        };
    }

    // =========================================================================
    // Element Type Navigation
    // =========================================================================

    moveToNextButton(): NavigationResult {
        return this.moveToNextByRole('button');
    }

    moveToPrevButton(): NavigationResult {
        return this.moveToPrevByRole('button');
    }

    moveToNextLink(): NavigationResult {
        return this.moveToNextByRole('link');
    }

    moveToPrevLink(): NavigationResult {
        return this.moveToPrevByRole('link');
    }

    moveToNextFormField(): NavigationResult {
        for (let i = this.currentIndex + 1; i < this.interestingNodes.length; i++) {
            const node = this.interestingNodes[i];
            if (FORM_FIELD_ROLES.has(node.computedRole)) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        return {
            node: this.getCurrentNode(),
            message: 'No next form field',
            success: false,
        };
    }

    moveToPrevFormField(): NavigationResult {
        for (let i = this.currentIndex - 1; i >= 0; i--) {
            const node = this.interestingNodes[i];
            if (FORM_FIELD_ROLES.has(node.computedRole)) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        return {
            node: this.getCurrentNode(),
            message: 'No previous form field',
            success: false,
        };
    }

    moveToNextTable(): NavigationResult {
        return this.moveToNextByRole(['table', 'grid', 'treegrid']);
    }

    moveToPrevTable(): NavigationResult {
        return this.moveToPrevByRole(['table', 'grid', 'treegrid']);
    }

    moveToNextList(): NavigationResult {
        return this.moveToNextByRole('list');
    }

    moveToPrevList(): NavigationResult {
        return this.moveToPrevByRole('list');
    }

    // =========================================================================
    // Focusable Navigation (Tab)
    // =========================================================================

    moveToNextFocusable(): NavigationResult {
        for (let i = this.currentIndex + 1; i < this.interestingNodes.length; i++) {
            const node = this.interestingNodes[i];
            if (FOCUSABLE_ROLES.has(node.computedRole) && !node.states.disabled) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        return {
            node: this.getCurrentNode(),
            message: 'No next focusable element',
            success: false,
        };
    }

    moveToPrevFocusable(): NavigationResult {
        for (let i = this.currentIndex - 1; i >= 0; i--) {
            const node = this.interestingNodes[i];
            if (FOCUSABLE_ROLES.has(node.computedRole) && !node.states.disabled) {
                this.currentIndex = i;
                return { node, message: '', success: true };
            }
        }

        return {
            node: this.getCurrentNode(),
            message: 'No previous focusable element',
            success: false,
        };
    }

    // =========================================================================
    // Table Navigation
    // =========================================================================

    /**
     * Gets the table context for the current node (if inside a table).
     */
    getTableContext(): { table: NavigableAXNode; row: number; col: number; rowCount: number; colCount: number } | null {
        const current = this.getCurrentNode();
        if (!current) return null;

        // Find containing table
        let node: NavigableAXNode | null = current;
        let tableNode: NavigableAXNode | null = null;

        while (node) {
            if (node.computedRole === 'table' || node.computedRole === 'grid' || node.computedRole === 'treegrid') {
                tableNode = node;
                break;
            }
            node = node.parent;
        }

        if (!tableNode) return null;

        // Find current row and column
        const { row, col } = this.findCellPosition(current, tableNode);
        const { rowCount, colCount } = this.getTableDimensions(tableNode);

        return { table: tableNode, row, col, rowCount, colCount };
    }

    /**
     * Finds the row and column position of a cell within a table.
     */
    private findCellPosition(cell: NavigableAXNode, table: NavigableAXNode): { row: number; col: number } {
        // Use posInSet/setSize if available
        if (cell.states.posInSet !== undefined) {
            // For cells, this might be column position
        }

        // Find row containing this cell
        let rowNode: NavigableAXNode | null = cell;
        while (rowNode && rowNode !== table) {
            if (rowNode.computedRole === 'row') break;
            rowNode = rowNode.parent;
        }

        if (!rowNode || rowNode === table) {
            return { row: 0, col: 0 };
        }

        // Count rows before this one
        let rowIndex = 0;
        const rows = this.findChildrenByRole(table, ['row']);
        for (let i = 0; i < rows.length; i++) {
            if (rows[i] === rowNode) {
                rowIndex = i;
                break;
            }
        }

        // Count cells before this one in the row
        let colIndex = 0;
        const cells = this.findChildrenByRole(rowNode, ['cell', 'gridcell', 'columnheader', 'rowheader']);
        for (let i = 0; i < cells.length; i++) {
            if (cells[i] === cell || this.isDescendant(cell, cells[i])) {
                colIndex = i;
                break;
            }
        }

        return { row: rowIndex, col: colIndex };
    }

    /**
     * Gets table dimensions.
     */
    private getTableDimensions(table: NavigableAXNode): { rowCount: number; colCount: number } {
        const rows = this.findChildrenByRole(table, ['row']);
        let maxCols = 0;

        for (const row of rows) {
            const cells = this.findChildrenByRole(row, ['cell', 'gridcell', 'columnheader', 'rowheader']);
            maxCols = Math.max(maxCols, cells.length);
        }

        return { rowCount: rows.length, colCount: maxCols };
    }

    /**
     * Finds children (direct or nested) with specific roles.
     */
    private findChildrenByRole(parent: NavigableAXNode, roles: string[]): NavigableAXNode[] {
        const results: NavigableAXNode[] = [];
        const roleSet = new Set(roles);

        const traverse = (node: NavigableAXNode) => {
            if (roleSet.has(node.computedRole)) {
                results.push(node);
                return; // Don't recurse into matched nodes
            }
            for (const child of node.children) {
                traverse(child);
            }
        };

        for (const child of parent.children) {
            traverse(child);
        }

        return results;
    }

    /**
     * Checks if a node is a descendant of another.
     */
    private isDescendant(node: NavigableAXNode, ancestor: NavigableAXNode): boolean {
        let current: NavigableAXNode | null = node;
        while (current) {
            if (current === ancestor) return true;
            current = current.parent;
        }
        return false;
    }

    /**
     * Navigates to a table cell by row/column.
     */
    moveToTableCell(direction: 'left' | 'right' | 'up' | 'down'): NavigationResult {
        const context = this.getTableContext();
        if (!context) {
            return { node: this.getCurrentNode(), message: 'Not in a table', success: false };
        }

        let newRow = context.row;
        let newCol = context.col;

        switch (direction) {
            case 'left':
                newCol = Math.max(0, context.col - 1);
                break;
            case 'right':
                newCol = Math.min(context.colCount - 1, context.col + 1);
                break;
            case 'up':
                newRow = Math.max(0, context.row - 1);
                break;
            case 'down':
                newRow = Math.min(context.rowCount - 1, context.row + 1);
                break;
        }

        // Check if we hit a boundary
        if (newRow === context.row && newCol === context.col) {
            const boundaryMsg = direction === 'left' || direction === 'right'
                ? 'Edge of table row'
                : 'Edge of table column';
            return { node: this.getCurrentNode(), message: boundaryMsg, success: false };
        }

        // Find the cell at newRow, newCol
        const rows = this.findChildrenByRole(context.table, ['row']);
        if (newRow >= rows.length) {
            return { node: this.getCurrentNode(), message: 'Edge of table', success: false };
        }

        const targetRow = rows[newRow];
        const cells = this.findChildrenByRole(targetRow, ['cell', 'gridcell', 'columnheader', 'rowheader']);
        if (newCol >= cells.length) {
            return { node: this.getCurrentNode(), message: 'Edge of table row', success: false };
        }

        const targetCell = cells[newCol];

        // Update current index to this cell (or first interesting node within it)
        const cellIndex = this.interestingNodes.findIndex(n =>
            n === targetCell || this.isDescendant(n, targetCell)
        );

        if (cellIndex >= 0) {
            this.currentIndex = cellIndex;
            return { node: this.interestingNodes[cellIndex], message: '', success: true };
        }

        // Cell is not in interesting nodes - return the target cell with empty message.
        // Don't update currentIndex so sequential navigation continues from last position.
        // Return the targetCell so table context (headers, position) can still be announced.
        return {
            node: targetCell,
            message: 'Empty cell',
            success: true
        };
    }

    /**
     * Gets row/column header for the current cell.
     */
    getTableCellHeaders(): { rowHeader?: string; colHeader?: string } {
        const context = this.getTableContext();
        if (!context) return {};

        const rows = this.findChildrenByRole(context.table, ['row']);
        const result: { rowHeader?: string; colHeader?: string } = {};

        // Get column header (from first row if it has columnheaders)
        if (rows.length > 0) {
            const headerRow = rows[0];
            const headerCells = this.findChildrenByRole(headerRow, ['columnheader']);
            if (context.col < headerCells.length) {
                result.colHeader = headerCells[context.col].computedName || undefined;
            }
        }

        // Get row header (first cell in current row if it's a rowheader)
        if (context.row < rows.length) {
            const currentRow = rows[context.row];
            const firstCell = this.findChildrenByRole(currentRow, ['rowheader']);
            if (firstCell.length > 0) {
                result.rowHeader = firstCell[0].computedName || undefined;
            }
        }

        return result;
    }

    // =========================================================================
    // Utility Methods
    // =========================================================================

    /**
     * Gets the total count of interesting nodes.
     */
    getInterestingNodeCount(): number {
        return this.interestingNodes.length;
    }

    /**
     * Gets the current position (1-indexed for display).
     */
    getCurrentPosition(): number {
        return this.currentIndex + 1;
    }

    /**
     * Finds all nodes matching a predicate.
     */
    findAll(predicate: (node: NavigableAXNode) => boolean): NavigableAXNode[] {
        return this.interestingNodes.filter(predicate);
    }

    /**
     * Gets all live regions in the tree.
     */
    getLiveRegions(): NavigableAXNode[] {
        return this.flatNodes.filter(
            node => node.states.live && node.states.live !== 'off'
        );
    }

    /**
     * Gets the root node.
     */
    getRoot(): NavigableAXNode | null {
        return this.root;
    }

    /**
     * Gets all interesting nodes (for full traversal).
     */
    getAllInterestingNodes(): NavigableAXNode[] {
        return [...this.interestingNodes];
    }

    /**
     * Sets the current node by node ID.
     */
    setCurrentByNodeId(nodeId: string): boolean {
        const index = this.interestingNodes.findIndex(n => n.nodeId === nodeId);
        if (index >= 0) {
            this.currentIndex = index;
            return true;
        }
        return false;
    }

    /**
     * Sets the current node by backend DOM node ID.
     */
    setCurrentByBackendNodeId(backendNodeId: number): boolean {
        const index = this.interestingNodes.findIndex(n => n.backendDOMNodeId === backendNodeId);
        if (index >= 0) {
            this.currentIndex = index;
            return true;
        }
        return false;
    }
}
