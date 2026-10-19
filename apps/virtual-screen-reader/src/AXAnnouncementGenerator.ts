/**
 * AXAnnouncementGenerator - Generates screen reader announcements from AX nodes.
 *
 * This replaces the DOM-based SpeechAnnouncer. Announcements are generated
 * entirely from the accessibility tree properties, ensuring accuracy.
 */

import { NavigableAXNode } from './types';

/**
 * Options for announcement generation.
 */
export interface AnnouncementOptions {
    /** Include description (aria-describedby) */
    includeDescription?: boolean;
    /** The action that caused this announcement (for context) */
    action?: string;
}

/**
 * Complete role to announcement text mapping.
 * Functions receive the node for dynamic text (e.g., heading levels).
 */
const ROLE_ANNOUNCEMENTS: Record<string, string | ((node: NavigableAXNode) => string)> = {
    // Landmarks
    banner: 'Banner',
    main: 'Main',
    navigation: 'Navigation',
    complementary: 'Complementary',
    contentinfo: 'Content Info',
    search: 'Search',
    form: 'Form',
    region: 'Region',

    // Headings (dynamic based on level)
    heading: (node) => {
        const level = node.states.level || 1;
        return `Heading Level ${level}`;
    },

    // Interactive - Buttons & Links
    button: 'Button',
    link: 'Link',

    // Interactive - Form Controls
    textbox: 'Edit',
    searchbox: 'Search Edit',
    checkbox: 'Checkbox',
    radio: 'Radio Button',
    combobox: 'Combo Box',
    listbox: 'List Box',
    option: 'Option',
    switch: 'Switch',
    slider: 'Slider',
    spinbutton: 'Spin Button',

    // Interactive - Menus
    menu: 'Menu',
    menubar: 'Menu Bar',
    menuitem: 'Menu Item',
    menuitemcheckbox: 'Menu Item Checkbox',
    menuitemradio: 'Menu Item Radio',

    // Interactive - Tabs
    tab: 'Tab',
    tablist: 'Tab List',
    tabpanel: 'Tab Panel',

    // Interactive - Trees
    tree: 'Tree',
    treeitem: 'Tree Item',
    treegrid: 'Tree Grid',

    // Interactive - Grids
    grid: 'Grid',
    gridcell: 'Cell',
    row: 'Row',
    rowgroup: 'Row Group',
    rowheader: 'Row Header',
    columnheader: 'Column Header',

    // Lists
    list: (node) => {
        // Try to get item count from children
        const itemCount = node.children.filter(c => c.computedRole === 'listitem').length;
        if (itemCount > 0) {
            return `List, ${itemCount} items`;
        }
        return 'List';
    },
    listitem: (node) => {
        const pos = node.states.posInSet;
        const total = node.states.setSize;
        if (pos && total) {
            return `List Item ${pos} of ${total}`;
        }
        return 'List Item';
    },

    // Tables
    table: (node) => {
        // Try to get row/column count
        const rows = node.children.filter(c =>
            c.computedRole === 'row' || c.computedRole === 'rowgroup'
        ).length;
        if (rows > 0) {
            return `Table, ${rows} rows`;
        }
        return 'Table';
    },
    cell: 'Cell',

    // Media & Figures
    img: 'Image',
    figure: 'Figure',

    // Dialogs & Alerts
    dialog: 'Dialog',
    alertdialog: 'Alert Dialog',
    alert: 'Alert',
    status: 'Status',
    log: 'Log',
    marquee: 'Marquee',
    timer: 'Timer',

    // Progress
    progressbar: (node) => {
        const value = formatProgressValue(node);
        if (value) {
            return `Progress Bar, ${value}`;
        }
        return 'Progress Bar';
    },
    meter: (node) => {
        const value = formatProgressValue(node);
        if (value) {
            return `Meter, ${value}`;
        }
        return 'Meter';
    },

    // Misc Structure
    article: 'Article',
    section: 'Section',
    group: 'Group',
    toolbar: 'Toolbar',
    separator: 'Separator',
    tooltip: 'Tooltip',
    feed: 'Feed',
    math: 'Math',
    definition: 'Definition',
    term: 'Term',
    note: 'Note',
    blockquote: 'Block Quote',
    caption: 'Caption',
    paragraph: '',  // Don't announce paragraph role

    // Document
    document: 'Document',
    application: 'Application',

    // Ignored for announcement (return empty string)
    generic: '',
    none: '',
    presentation: '',
    statictext: '',  // Name is the content
    inlinetextbox: '',
    rootwebarea: '',
    webarea: '',
    iframe: '',
    iframepresentational: '',
    ignorednode: '',
    unknown: '',
};

/**
 * Formats the value for progress bars and meters.
 */
function formatProgressValue(node: NavigableAXNode): string | null {
    const { valueNow, valueMin, valueMax, valueText } = node.states;

    if (valueText) {
        return valueText;
    }

    if (valueNow !== undefined) {
        if (valueMax !== undefined && valueMin !== undefined && valueMax !== valueMin) {
            const percent = Math.round(((valueNow - valueMin) / (valueMax - valueMin)) * 100);
            return `${percent}%`;
        }
        return `${valueNow}`;
    }

    return null;
}

/**
 * AXAnnouncementGenerator generates screen reader announcements from AX nodes.
 */
export class AXAnnouncementGenerator {
    /**
     * Generates the full announcement for a node.
     */
    generateAnnouncement(node: NavigableAXNode, options: AnnouncementOptions = {}): string {
        const parts: string[] = [];

        // 1. Role announcement
        const roleText = this.formatRole(node);
        if (roleText) {
            parts.push(roleText);
        }

        // 2. Accessible name
        if (node.computedName) {
            parts.push(node.computedName);
        }

        // 3. State information
        const stateText = this.formatState(node);
        if (stateText) {
            parts.push(stateText);
        }

        // 4. Value (for inputs, sliders, etc.)
        const valueText = this.formatValue(node);
        if (valueText) {
            parts.push(valueText);
        }

        // 5. Position in set (if not already in role)
        const positionText = this.formatPositionInSet(node);
        if (positionText) {
            parts.push(positionText);
        }

        // 6. Description (aria-describedby)
        if (options.includeDescription && node.description?.value) {
            parts.push(String(node.description.value));
        }

        // If we have nothing to say, provide a fallback
        if (parts.length === 0) {
            if (node.computedRole && node.computedRole !== 'generic') {
                return node.computedRole;
            }
            return 'Element';
        }

        return parts.join(', ');
    }

    /**
     * Formats the role announcement.
     */
    formatRole(node: NavigableAXNode): string {
        const role = node.computedRole.toLowerCase();
        const announcement = ROLE_ANNOUNCEMENTS[role];

        if (!announcement) {
            return ''; // Unknown role - don't announce
        }

        if (typeof announcement === 'function') {
            return announcement(node);
        }

        return announcement;
    }

    /**
     * Formats state announcements.
     */
    formatState(node: NavigableAXNode): string {
        const states: string[] = [];
        const s = node.states;

        // Expanded/Collapsed (for buttons, comboboxes, tree items)
        if (s.expanded === true) {
            states.push('expanded');
        } else if (s.expanded === false) {
            states.push('collapsed');
        }

        // Pressed (for toggle buttons)
        if (s.pressed === true) {
            states.push('pressed');
        } else if (s.pressed === false && node.computedRole === 'button') {
            // Only announce "not pressed" for toggle buttons that have aria-pressed
            // We can detect this by checking if pressed is explicitly false vs undefined
            // For now, skip "not pressed" as it's verbose
        } else if (s.pressed === 'mixed') {
            states.push('partially pressed');
        }

        // Checked (for checkboxes, radio buttons, menu items)
        if (s.checked === true) {
            states.push('checked');
        } else if (s.checked === false) {
            states.push('not checked');
        } else if (s.checked === 'mixed') {
            states.push('partially checked');
        }

        // Selected (for tabs, options, tree items)
        if (s.selected === true) {
            states.push('selected');
        }

        // Disabled
        if (s.disabled === true) {
            states.push('disabled');
        }

        // Invalid
        if (s.invalid === true) {
            states.push('invalid');
        }

        // Required
        if (s.required === true) {
            states.push('required');
        }

        // Read-only
        if (s.readonly === true) {
            states.push('read only');
        }

        // Busy
        if (s.busy === true) {
            states.push('busy');
        }

        // Has popup
        if (s.hasPopup === true || (typeof s.hasPopup === 'string' && s.hasPopup !== 'false')) {
            states.push('has popup');
        }

        // Multiselectable
        if (s.multiselectable === true) {
            states.push('multi-selectable');
        }

        // Autocomplete
        if (s.autocomplete && s.autocomplete !== 'none') {
            states.push(`autocomplete ${s.autocomplete}`);
        }

        // Orientation (for sliders, scrollbars)
        if (s.orientation) {
            states.push(s.orientation);
        }

        return states.join(', ');
    }

    /**
     * Formats value announcements for form controls.
     */
    formatValue(node: NavigableAXNode): string {
        const role = node.computedRole;
        const s = node.states;

        // Text fields - announce content
        if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton') {
            if (node.value?.value) {
                return `has text: ${node.value.value}`;
            }
            return 'blank';
        }

        // Sliders - announce value
        if (role === 'slider') {
            if (s.valueText) {
                return s.valueText;
            }
            if (s.valueNow !== undefined) {
                if (s.valueMax !== undefined && s.valueMin !== undefined && s.valueMax !== s.valueMin) {
                    const percent = Math.round(((s.valueNow - s.valueMin) / (s.valueMax - s.valueMin)) * 100);
                    return `${percent}%`;
                }
                return `${s.valueNow}`;
            }
        }

        // Combobox - announce selected value
        if (role === 'combobox') {
            if (node.value?.value) {
                return node.value.value;
            }
        }

        return '';
    }

    /**
     * Formats position in set (for list items, tabs, menu items, etc.).
     * Returns empty if position is already included in role announcement.
     */
    formatPositionInSet(node: NavigableAXNode): string {
        const s = node.states;
        const role = node.computedRole;

        // Skip if role already includes position (listitem does this)
        if (role === 'listitem') {
            return ''; // Already handled in role announcement
        }

        if (s.posInSet !== undefined && s.setSize !== undefined) {
            return `${s.posInSet} of ${s.setSize}`;
        }

        return '';
    }

    /**
     * Generates a live region announcement.
     */
    generateLiveRegionAnnouncement(node: NavigableAXNode): string {
        // For live regions, we want to announce the full content
        // without role prefixes
        if (node.computedName) {
            return node.computedName;
        }

        // Recursively get text content from children
        const getText = (n: NavigableAXNode): string => {
            if (n.computedName) {
                return n.computedName;
            }
            return n.children.map(getText).filter(t => t).join(' ');
        };

        return getText(node);
    }

    /**
     * Generates announcement for activation result.
     */
    generateActivationAnnouncement(node: NavigableAXNode, result: string): string {
        const name = node.computedName || '';
        const role = this.formatRole(node) || 'element';

        switch (result) {
            case 'activated':
                return `${role}, ${name}, activated`;
            case 'checked':
                return `${role}, ${name}, checked`;
            case 'unchecked':
                return `${role}, ${name}, not checked`;
            case 'expanded':
                return `${role}, ${name}, expanded`;
            case 'collapsed':
                return `${role}, ${name}, collapsed`;
            case 'pressed':
                return `${role}, ${name}, pressed`;
            case 'not pressed':
                return `${role}, ${name}, not pressed`;
            case 'partially checked':
                return `${role}, ${name}, partially checked`;
            case 'selected':
                return `${role}, ${name}, selected`;
            case 'not selected':
                return `${role}, ${name}, not selected`;
            default:
                return `${role}, ${name}, ${result}`;
        }
    }

    /**
     * Generates a boundary announcement.
     */
    generateBoundaryAnnouncement(boundary: 'top' | 'bottom'): string {
        return boundary === 'top' ? 'Top of page' : 'End of page';
    }

    /**
     * Generates a navigation announcement (page change).
     */
    generateNavigationAnnouncement(pageTitle: string): string {
        return `Navigated to ${pageTitle || 'new page'}`;
    }
}
