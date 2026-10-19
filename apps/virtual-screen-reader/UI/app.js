// WebSocket connection
let ws = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

// DOM elements
const statusEl = document.getElementById('status');
const urlInput = document.getElementById('url-input');
const goBtn = document.getElementById('go-btn');
const treeContainer = document.getElementById('tree-container');
const outputLog = document.getElementById('output-log');
const elementRole = document.getElementById('element-role');
const elementName = document.getElementById('element-name');
const elementContext = document.getElementById('element-context');
const statTotal = document.getElementById('stat-total');
const statVisited = document.getElementById('stat-visited');
const statMax = document.getElementById('stat-max');

// Graph viz state
let cy = null;

// Register plugins if they exist
// (Cytoscape plugins usually auto-register or attach to the global cytoscape object)

// Connect to WebSocket server
function connect() {
    ws = new WebSocket(`ws://${window.location.host}`);

    ws.onopen = () => {
        console.log('Connected to server');
        statusEl.textContent = 'Connected';
        statusEl.classList.add('connected');
        reconnectAttempts = 0;
    };

    ws.onclose = () => {
        console.log('Disconnected from server');
        statusEl.textContent = 'Disconnected';
        statusEl.classList.remove('connected');

        // Attempt to reconnect
        if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            setTimeout(connect, 2000);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleMessage(message);
    };
}

// Handle incoming messages
function handleMessage(message) {
    switch (message.type) {
        case 'connected':
            if (message.url) {
                urlInput.value = message.url;
            }
            break;

        case 'navigated':
            addLogEntry(`Navigated to: ${message.title}`, 'navigation');
            break;

        case 'speech':
            addLogEntry(message.text);
            updateCurrentElement(message.text);
            break;

        case 'tree':
            updateTree(message.tree);
            updateGraph(message.tree);
            break;

        case 'action_result':
            if (!message.success) {
                addLogEntry(`Action failed: ${message.snapshot?.text || 'Unknown error'}`, 'error');
            }
            break;

        case 'navigation_complete':
            addLogEntry(`Navigated via: ${message.keys.join(' → ')}`, 'navigation');
            break;

        case 'error':
            addLogEntry(`Error: ${message.message}`, 'error');
            break;
    }
}

// Update the tree visualization (List View)
function updateTree(treeData) {
    // Update stats
    statTotal.textContent = treeData.stats.totalNodes;
    statVisited.textContent = treeData.stats.visitedNodes;
    statMax.textContent = treeData.stats.maxVisitCount;

    // Nodes are already in DOM order from server
    const sortedNodes = treeData.nodes;

    // Build tree HTML
    let html = '';
    for (const node of sortedNodes) {
        const classes = [
            'tree-node',
            node.isCurrent ? 'current' : '',
            node.visited ? 'visited' : 'unvisited'
        ].filter(Boolean).join(' ');

        const visitsLabel = node.visitCount > 1 ? `(${node.visitCount}x)` : '';

        // Display name or content for generic elements
        const displayText = node.name || node.content || '';

        html += `
            <div class="${classes}" style="--depth: ${node.depth}" data-node-id="${escapeHtml(node.id)}" title="Click to navigate here">
                <span class="tree-node-role">${node.role}</span>
                <span class="tree-node-name">${escapeHtml(truncate(displayText, 60))}</span>
                ${visitsLabel ? `<span class="tree-node-visits">${visitsLabel}</span>` : ''}
            </div>
        `;
    }

    treeContainer.innerHTML = html || '<p class="placeholder">Navigate the page to build the tree...</p>';

    // Add click handlers to tree nodes
    treeContainer.querySelectorAll('.tree-node').forEach(nodeEl => {
        nodeEl.addEventListener('click', () => {
            const nodeId = nodeEl.getAttribute('data-node-id');
            if (nodeId && !nodeEl.classList.contains('current')) {
                navigateToNode(nodeId);
            }
        });
    });

    // Scroll current node into view
    const currentNode = treeContainer.querySelector('.tree-node.current');
    if (currentNode) {
        currentNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Update the graph visualization using Cytoscape
function updateGraph(treeData) {
    const container = document.getElementById('graph-container');
    if (!container) return;

    // Initialize cytoscape if not already done
    if (!cy) {
        if (typeof cytoscape === 'undefined') return;

        cy = cytoscape({
            container: container,
            style: [
                {
                    selector: 'node',
                    style: {
                        'label': 'data(label)',
                        'background-color': '#666',
                        'color': '#fff',
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'width': 'label',
                        'height': 'label',
                        'padding': '10px',
                        'shape': 'round-rectangle',
                        'font-size': '12px'
                    }
                },
                {
                    selector: 'node.current',
                    style: {
                        'background-color': '#007bff',
                        'border-width': 2,
                        'border-color': '#0056b3'
                    }
                },
                {
                    selector: 'edge',
                    style: {
                        'width': 2,
                        'line-color': '#555',
                        'target-arrow-color': '#555',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'label': 'data(label)',
                        'font-size': '10px',
                        'color': '#aaa',
                        'text-rotation': 'autorotate',
                        'text-background-opacity': 1,
                        'text-background-color': '#222',
                        'text-background-padding': '2px'
                    }
                }
            ],
            layout: {
                name: 'dagre',
                rankDir: 'TB',
                animate: false
            }
        });
        
        // Add click listener
        cy.on('tap', 'node', function(evt){
            var node = evt.target;
            navigateToNode(node.id());
        });
    }

    // Prepare data
    const nodes = treeData.nodes.map(node => ({
        group: 'nodes',
        data: {
            id: node.id,
            label: `${node.role}\n${truncate(node.name || node.content || '', 15)}`
        },
        classes: node.isCurrent ? 'current' : ''
    }));

    const edges = (treeData.edges || []).map((edge, i) => ({
        group: 'edges',
        data: {
            id: 'e' + i,
            source: edge.fromId,
            target: edge.toId,
            label: edge.action
        }
    }));

    // Batch updates for performance
    cy.batch(() => {
        cy.elements().remove();
        cy.add(nodes);
        cy.add(edges);
    });
    
    // Rerun layout
    cy.layout({
        name: 'dagre',
        rankDir: 'TB',
        animate: false, // Disable animation for performance
        fit: true
    }).run();
}

// Navigate to a specific node
function navigateToNode(nodeId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    addLogEntry(`Navigating to node...`, 'navigation');
    ws.send(JSON.stringify({ type: 'navigateTo', targetId: nodeId }));
}

// Update current element display
function updateCurrentElement(text) {
    // Parse the speech output to extract role and name
    // Format: "[tree context], Role, Name, ..."
    const parts = text.split(', ');

    // Skip tree context parts (those in brackets)
    let roleIndex = 0;
    for (let i = 0; i < parts.length; i++) {
        if (!parts[i].startsWith('[')) {
            roleIndex = i;
            break;
        }
    }

    const role = parts[roleIndex] || '-';
    const name = parts.slice(roleIndex + 1).join(', ') || 'No name';
    const context = parts.slice(0, roleIndex).join(' ');

    elementRole.textContent = role;
    elementName.textContent = name;
    elementContext.textContent = context;
}

// Add entry to output log
function addLogEntry(text, type = '') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-message">${escapeHtml(text)}</span>
    `;

    outputLog.appendChild(entry);
    outputLog.scrollTop = outputLog.scrollHeight;

    // Keep only last 100 entries
    while (outputLog.children.length > 100) {
        outputLog.removeChild(outputLog.firstChild);
    }
}

// Utility functions
function truncate(str, maxLength) {
    if (!str) return '';
    return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Send navigation request
function navigate(url) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert('Not connected to server');
        return;
    }

    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }

    ws.send(JSON.stringify({ type: 'navigate', url }));
}

// Send key press
function sendKeyPress(key) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    ws.send(JSON.stringify({ type: 'keypress', key }));
}

// Event listeners
goBtn.addEventListener('click', () => {
    navigate(urlInput.value);
});

urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        navigate(urlInput.value);
    }
});

// Keyboard shortcuts (when not focused on input)
document.addEventListener('keydown', (e) => {
    // Don't capture when typing in input
    if (document.activeElement === urlInput) {
        return;
    }

    let key = null;

    switch (e.key) {
        case 'ArrowDown':
            if (e.shiftKey && (e.metaKey || e.ctrlKey)) {
                key = 'Cmd+Shift+ArrowDown';
            } else {
                key = 'ArrowDown';
            }
            break;
        case 'ArrowUp':
            key = 'ArrowUp';
            break;
        case 'Escape':
            key = 'Escape';
            break;
        case 'a':
        case 'A':
            if (e.shiftKey) {
                key = 'Shift+a';
            }
            break;
        case 'h':
        case 'H':
            key = e.shiftKey ? 'Shift+h' : 'h';
            break;
        case 'l':
        case 'L':
            key = e.shiftKey ? 'Shift+l' : 'l';
            break;
        case 'd':
        case 'D':
            key = e.shiftKey ? 'Shift+d' : 'd';
            break;
        case 'q':
        case 'Q':
            key = 'q';
            break;
        case 'b':
        case 'B':
            key = e.shiftKey ? 'Shift+b' : 'b';
            break;
        case 'f':
        case 'F':
            key = e.shiftKey ? 'Shift+f' : 'f';
            break;
        case 't':
        case 'T':
            key = e.shiftKey ? 'Shift+t' : 't';
            break;
        case 'k':
        case 'K':
            key = e.shiftKey ? 'Shift+k' : 'k';
            break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
            key = e.shiftKey ? `Shift+${e.key}` : e.key;
            break;
        case 'Enter':
            key = 'Enter';
            break;
        case ' ':
            key = ' ';
            break;
        case 'Tab':
            key = 'Tab';
            break;
        case 'Backspace':
            key = e.shiftKey ? 'Shift+Backspace' : 'Backspace';
            break;
    }

    if (key) {
        e.preventDefault();
        sendKeyPress(key);
    }
});

// Initialize connection
connect();
