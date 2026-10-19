import { AXNode, AXValue, AXProperty } from './types';

/**
 * Parsed node from ARIA snapshot YAML.
 */
interface ParsedNode {
    role: string;
    name?: string;
    properties: Record<string, any>;
    children: ParsedNode[];
    locatorPath: string[];
}

/**
 * Parser for Playwright's ariaSnapshot() YAML output.
 * Converts the YAML tree structure into a flat AXNode[] array.
 *
 * Example YAML input:
 * ```yaml
 * - navigation:
 *   - link "Home"
 *   - link "About"
 * - main:
 *   - heading "Page Title" [level=1]
 *   - button "Submit" [disabled]
 * ```
 */
export class AriaSnapshotParser {
    private nodeIdCounter = 0;

    /**
     * Parse ariaSnapshot YAML string into AXNode array.
     */
    parse(yamlString: string): AXNode[] {
        this.nodeIdCounter = 0;
        const lines = yamlString.split('\n');
        const rootNodes = this.parseLines(lines, []);
        return this.flattenToAXNodes(rootNodes);
    }

    /**
     * Parse lines into a tree of ParsedNodes.
     */
    private parseLines(lines: string[], parentPath: string[]): ParsedNode[] {
        const result: ParsedNode[] = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            if (!line.trim()) {
                i++;
                continue;
            }

            const indent = this.getIndent(line);
            const content = line.trim();

            // Skip metadata lines (start with /url, /value, etc.)
            if (content.startsWith('- /')) {
                i++;
                continue;
            }

            if (content.startsWith('- ')) {
                const nodeContent = content.slice(2);
                const { role, name, properties, hasChildren } = this.parseNodeLine(nodeContent);

                // Track sibling count for this role at this level
                const siblingIndex = result.filter(n => n.role === role).length;
                const pathSegment = siblingIndex > 0 ? `${role}:${siblingIndex}` : role;
                const locatorPath = [...parentPath, pathSegment];

                const node: ParsedNode = {
                    role,
                    name,
                    properties,
                    children: [],
                    locatorPath
                };

                // Find children (lines with greater indent)
                if (hasChildren) {
                    const childLines: string[] = [];
                    let j = i + 1;
                    while (j < lines.length) {
                        const childLine = lines[j];
                        if (!childLine.trim()) {
                            j++;
                            continue;
                        }
                        const childIndent = this.getIndent(childLine);
                        if (childIndent > indent) {
                            // Normalize indent for recursive parsing
                            childLines.push(childLine.slice(indent + 2));
                            j++;
                        } else {
                            break;
                        }
                    }
                    node.children = this.parseLines(childLines, locatorPath);
                    i = j;
                } else {
                    i++;
                }

                result.push(node);
            } else {
                i++;
            }
        }

        return result;
    }

    /**
     * Get indentation level (number of leading spaces).
     */
    private getIndent(line: string): number {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
    }

    /**
     * Parse a single node line. Formats:
     * - 'button "Submit"'           -> role with quoted name
     * - 'heading "Title" [level=1]' -> role with name and attributes
     * - 'navigation:'               -> container with children (colon at end)
     * - 'link "Home":'              -> role with name AND children
     * - 'paragraph: Some text'      -> role with inline text content (colon+space+text)
     */
    private parseNodeLine(content: string): {
        role: string;
        name?: string;
        properties: Record<string, any>;
        hasChildren: boolean;
    } {
        const properties: Record<string, any> = {};
        let hasChildren = false;
        let role: string;
        let name: string | undefined;

        // Check if line ends with colon (indicates children follow)
        if (content.endsWith(':')) {
            hasChildren = true;
            content = content.slice(0, -1);
        }

        // Extract properties in brackets [key=value] or [key]
        let remaining = content;
        const propPattern = /\[([^\]]+)\]/g;
        let propMatch;
        while ((propMatch = propPattern.exec(content)) !== null) {
            const propContent = propMatch[1];
            if (propContent.includes('=')) {
                const [key, value] = propContent.split('=', 2);
                properties[key.trim()] = this.parsePropertyValue(value.trim());
            } else {
                properties[propContent.trim()] = true;
            }
            remaining = remaining.replace(propMatch[0], '');
        }
        remaining = remaining.trim();

        // Pattern 1: role "quoted name" (with or without trailing colon already removed)
        const quotedNameMatch = remaining.match(/^(\w+(?:-\w+)*)\s+"([^"]*)"$/);
        const quotedNameMatchSingle = remaining.match(/^(\w+(?:-\w+)*)\s+'([^']*)'$/);

        if (quotedNameMatch) {
            return {
                role: quotedNameMatch[1],
                name: quotedNameMatch[2],
                properties,
                hasChildren
            };
        }
        if (quotedNameMatchSingle) {
            return {
                role: quotedNameMatchSingle[1],
                name: quotedNameMatchSingle[2],
                properties,
                hasChildren
            };
        }

        // Pattern 2: role: inline text content (colon followed by space and text)
        // This is different from hasChildren - inline text doesn't have children
        const inlineTextMatch = remaining.match(/^(\w+(?:-\w+)*):\s+(.+)$/);
        if (inlineTextMatch) {
            return {
                role: inlineTextMatch[1],
                name: inlineTextMatch[2],
                properties,
                hasChildren: false  // Inline text means no children
            };
        }

        // Pattern 3: Just a role (possibly hyphenated like "menu-item")
        const roleOnlyMatch = remaining.match(/^(\w+(?:-\w+)*)$/);
        if (roleOnlyMatch) {
            return {
                role: roleOnlyMatch[1],
                name: undefined,
                properties,
                hasChildren
            };
        }

        // Fallback: split by whitespace, first part is role, rest is name
        const parts = remaining.split(/\s+/);
        role = parts[0].replace(/:$/, ''); // Remove any trailing colon from role
        if (parts.length > 1) {
            name = parts.slice(1).join(' ');
        }

        return { role, name, properties, hasChildren };
    }

    /**
     * Parse a property value (handles numbers, booleans, strings).
     */
    private parsePropertyValue(value: string): any {
        if (value === 'true') return true;
        if (value === 'false') return false;
        const num = Number(value);
        if (!isNaN(num)) return num;
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            return value.slice(1, -1);
        }
        return value;
    }

    /**
     * Flatten parsed tree into AXNode array (document order).
     */
    private flattenToAXNodes(nodes: ParsedNode[]): AXNode[] {
        const result: AXNode[] = [];
        const nodeMap = new Map<ParsedNode, string>();

        // First pass: assign IDs
        const assignIds = (nodes: ParsedNode[]) => {
            for (const node of nodes) {
                const nodeId = `node_${this.nodeIdCounter++}`;
                nodeMap.set(node, nodeId);
                assignIds(node.children);
            }
        };
        assignIds(nodes);

        // Second pass: create AXNodes
        const processNode = (node: ParsedNode): AXNode => {
            const nodeId = nodeMap.get(node)!;
            const childIds = node.children.map(c => nodeMap.get(c)!);

            const axNode: AXNode = {
                nodeId,
                ignored: false,
                role: this.toAXValue(node.role),
                name: node.name ? this.toAXValue(node.name) : undefined,
                properties: this.toAXProperties(node.properties),
                childIds: childIds.length > 0 ? childIds : undefined,
                locatorPath: node.locatorPath
            };

            return axNode;
        };

        // Flatten in document order
        const flatten = (nodes: ParsedNode[]) => {
            for (const node of nodes) {
                result.push(processNode(node));
                flatten(node.children);
            }
        };
        flatten(nodes);

        return result;
    }

    /**
     * Convert a value to AXValue format.
     */
    private toAXValue(value: any): AXValue {
        if (typeof value === 'string') {
            return { type: 'string', value };
        }
        if (typeof value === 'boolean') {
            return { type: 'boolean', value };
        }
        if (typeof value === 'number') {
            return { type: 'number', value };
        }
        return { type: 'string', value: String(value) };
    }

    /**
     * Convert properties object to AXProperty array.
     */
    private toAXProperties(props: Record<string, any>): AXProperty[] {
        return Object.entries(props).map(([name, value]) => ({
            name,
            value: this.toAXValue(value)
        }));
    }
}
