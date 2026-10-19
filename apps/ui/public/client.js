// Accessibility Agent Client - Conversational Interface
(function() {
    'use strict';

    // State
    let ws = null;
    let selectedProvider = 'openai';
    let isRunning = false;
    let currentSteps = [];
    let currentAgentMessage = null;
    let conversations = [];
    let currentConversationId = null;

    // DOM Elements
    const urlInput = document.getElementById('urlInput');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const chatContainer = document.getElementById('chatContainer');
    const providerBtns = document.querySelectorAll('.provider-btn');
    const newChatBtn = document.getElementById('newChatBtn');
    const conversationList = document.getElementById('conversationList');
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarToggleFloat = document.getElementById('sidebarToggleFloat');
    const browserPreview = document.getElementById('browserPreview');
    const previewContent = document.getElementById('previewContent');
    const previewUrl = document.getElementById('previewUrl');
    const closePreview = document.getElementById('closePreview');
    const resizeHandle = document.getElementById('resizeHandle');
    const searchInput = document.getElementById('searchInput');
    const searchClear = document.getElementById('searchClear');

    // Initialize
    function init() {
        loadConversations();
        loadSidebarState();
        loadPreviewWidth();
        setupEventListeners();
        setupTextareaAutoResize();
        setupResizeHandle();
        setupSearch();
        renderConversationList();
    }

    // Load conversations from localStorage
    function loadConversations() {
        const stored = localStorage.getItem('accessibility-agent-conversations');
        if (stored) {
            try {
                conversations = JSON.parse(stored);
            } catch (e) {
                conversations = [];
            }
        }
    }

    // Save conversations to localStorage
    function saveConversations() {
        localStorage.setItem('accessibility-agent-conversations', JSON.stringify(conversations));
    }

    // Load sidebar state
    function loadSidebarState() {
        const collapsed = localStorage.getItem('sidebar-collapsed') === 'true';
        if (collapsed) {
            sidebar.classList.add('collapsed');
        }
    }

    // Save sidebar state
    function saveSidebarState() {
        localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('collapsed'));
    }

    // Generate unique ID
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    // Setup event listeners
    function setupEventListeners() {
        // Provider selection
        providerBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                providerBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedProvider = btn.dataset.provider;
            });
        });

        // Send message
        sendBtn.addEventListener('click', handleSend);

        // Cancel button
        cancelBtn.addEventListener('click', handleCancel);

        // Enter key to send
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });

        // New chat button
        newChatBtn.addEventListener('click', startNewConversation);

        // Sidebar toggle (both buttons)
        sidebarToggle.addEventListener('click', toggleSidebar);
        sidebarToggleFloat.addEventListener('click', toggleSidebar);

        // Close preview - also close WebSocket to release browser
        closePreview.addEventListener('click', () => {
            browserPreview.classList.remove('visible');
            if (ws) {
                ws.close();
                ws = null;
            }
        });
    }

    // Toggle sidebar
    function toggleSidebar() {
        sidebar.classList.toggle('collapsed');
        saveSidebarState();
    }

    // Setup textarea auto-resize
    function setupTextareaAutoResize() {
        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        });
    }

    // Load preview width from localStorage
    function loadPreviewWidth() {
        const savedWidth = localStorage.getItem('preview-width');
        if (savedWidth) {
            browserPreview.style.width = savedWidth;
        }
    }

    // Save preview width to localStorage
    function savePreviewWidth() {
        localStorage.setItem('preview-width', browserPreview.style.width);
    }

    // Setup resize handle for preview panel
    function setupResizeHandle() {
        let isDragging = false;
        let startX = 0;
        let startWidth = 0;

        resizeHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startWidth = browserPreview.offsetWidth;
            resizeHandle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const deltaX = startX - e.clientX;
            const newWidth = Math.min(
                Math.max(startWidth + deltaX, 200),
                window.innerWidth * 0.8
            );
            browserPreview.style.width = `${newWidth}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                resizeHandle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                savePreviewWidth();
            }
        });
    }

    // Setup search functionality
    function setupSearch() {
        searchInput.addEventListener('input', () => {
            renderConversationList(searchInput.value);
        });

        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            renderConversationList();
            searchInput.focus();
        });
    }

    // Render conversation list in sidebar
    function renderConversationList(searchQuery = '') {
        conversationList.innerHTML = '';

        // Sort by most recent first
        let sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

        // Filter by search query if provided
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase().trim();
            sorted = sorted.filter(conv => {
                const title = (conv.title || '').toLowerCase();
                const messages = conv.messages || [];
                // Search in title
                if (title.includes(query)) return true;
                // Search in message content
                return messages.some(msg =>
                    (msg.content || '').toLowerCase().includes(query)
                );
            });
        }

        sorted.forEach(conv => {
            const item = document.createElement('div');
            item.className = 'conversation-item' + (conv.id === currentConversationId ? ' active' : '');
            item.innerHTML = `
                <span class="conversation-item-text">${escapeHtml(conv.title || 'New conversation')}</span>
                <div class="conversation-actions">
                    <button class="conversation-action-btn delete" title="Delete">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            `;

            // Click on conversation to load it
            item.addEventListener('click', (e) => {
                if (!e.target.closest('.conversation-action-btn')) {
                    loadConversation(conv.id);
                }
            });

            // Delete button
            const deleteBtn = item.querySelector('.conversation-action-btn.delete');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteConversation(conv.id);
            });

            conversationList.appendChild(item);
        });
    }

    // Delete conversation
    function deleteConversation(id) {
        const index = conversations.findIndex(c => c.id === id);
        if (index === -1) return;

        conversations.splice(index, 1);
        saveConversations();

        // If deleted conversation was active, start new
        if (currentConversationId === id) {
            startNewConversation();
        } else {
            renderConversationList();
        }
    }

    // Start new conversation
    function startNewConversation() {
        currentConversationId = null;
        currentSteps = [];

        // Clear chat
        chatContainer.innerHTML = '';

        // Show welcome message
        const welcome = document.createElement('div');
        welcome.className = 'welcome-container';
        welcome.id = 'welcomeMessage';
        welcome.innerHTML = `
            <div class="welcome-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
            </div>
            <h1 class="welcome-title">Welcome to Accessibility Agent</h1>
            <p class="welcome-subtitle">Enter a URL above and describe what you'd like the agent to accomplish. The agent will navigate and interact with the page to complete your goal.</p>
        `;
        chatContainer.appendChild(welcome);

        // Clear URL input
        urlInput.value = '';

        // Hide preview
        browserPreview.classList.remove('visible');

        // Update sidebar
        renderConversationList();
    }

    // Load existing conversation
    function loadConversation(id) {
        const conv = conversations.find(c => c.id === id);
        if (!conv) return;

        currentConversationId = id;
        currentSteps = [];

        // Set URL
        urlInput.value = conv.url || '';

        // Clear and render messages
        chatContainer.innerHTML = '';

        conv.messages.forEach(msg => {
            if (msg.role === 'user') {
                addUserMessage(msg.content, false);
            } else if (msg.role === 'agent') {
                addAgentMessageWithContent(msg.content, msg.success, msg.reason, msg.steps);
            }
        });

        // Update sidebar
        renderConversationList();
        scrollToBottom();
    }

    // Add agent message with pre-existing content (for loading)
    function addAgentMessageWithContent(content, success, reason, steps) {
        const messageEl = document.createElement('div');
        messageEl.className = 'message agent';

        let stepsHtml = '';
        if (steps && steps.length > 0) {
            stepsHtml = `
                <div class="steps-accordion">
                    <button class="steps-toggle">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"/>
                        </svg>
                        <span class="steps-count">${steps.length} steps</span>
                    </button>
                    <div class="steps-list">
                        <div class="steps-list-inner">
                            ${steps.map((step, i) => `
                                <div class="step-item">
                                    <span class="step-num">${i + 1}</span>
                                    <div class="step-info">
                                        <div class="step-action">${formatAction(step.action)}</div>
                                        ${step.thought ? `<div class="step-thought">${escapeHtml(step.thought)}</div>` : ''}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `;
        }

        const resultIcon = success
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

        messageEl.innerHTML = `
            <div class="message-avatar">A</div>
            <div class="message-content">
                <div class="message-bubble">${escapeHtml(content)}</div>
                <div class="result-box ${success ? 'success' : 'error'}">
                    <div class="result-header">
                        ${resultIcon}
                        <span>${success ? 'Success' : 'Failed'}</span>
                    </div>
                    ${reason ? `<div class="result-reason">${escapeHtml(reason)}</div>` : ''}
                </div>
                ${stepsHtml}
            </div>
        `;

        chatContainer.appendChild(messageEl);

        // Setup toggle
        const toggle = messageEl.querySelector('.steps-toggle');
        const list = messageEl.querySelector('.steps-list');
        if (toggle && list) {
            toggle.addEventListener('click', () => {
                toggle.classList.toggle('expanded');
                list.classList.toggle('expanded');
            });
        }

        return messageEl;
    }

    // Handle send
    function handleSend() {
        const goal = messageInput.value.trim();
        const url = urlInput.value.trim();

        if (!goal) {
            shakeElement(messageInput.parentElement);
            return;
        }

        if (!url) {
            shakeElement(urlInput.parentElement);
            return;
        }

        // Clear input
        messageInput.value = '';
        messageInput.style.height = 'auto';

        // Hide welcome message
        const welcomeEl = document.getElementById('welcomeMessage');
        if (welcomeEl) {
            welcomeEl.remove();
        }

        // Create or update conversation
        if (!currentConversationId) {
            currentConversationId = generateId();
            conversations.push({
                id: currentConversationId,
                title: goal.substring(0, 50),
                url: url,
                messages: [],
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        }

        // Add user message to conversation
        const conv = conversations.find(c => c.id === currentConversationId);
        if (conv) {
            conv.messages.push({ role: 'user', content: goal });
            conv.updatedAt = Date.now();
            conv.url = url;
            saveConversations();
        }

        // Add user message to UI
        addUserMessage(goal);

        // Update sidebar
        renderConversationList();

        // Start agent
        startAgent(url, goal, selectedProvider);
    }

    // Handle cancel
    function handleCancel() {
        if (ws) {
            ws.send(JSON.stringify({ type: 'stop' }));
        }
        stopAgent('Cancelled by user');
    }

    // Add user message to chat
    function addUserMessage(text, animate = true) {
        const messageEl = document.createElement('div');
        messageEl.className = 'message user';
        if (!animate) messageEl.style.animation = 'none';
        messageEl.innerHTML = `
            <div class="message-avatar">U</div>
            <div class="message-content">
                <div class="message-bubble">${escapeHtml(text)}</div>
            </div>
        `;
        chatContainer.appendChild(messageEl);
        scrollToBottom();
    }

    // Add agent message (returns the element for updates)
    function addAgentMessage() {
        const messageEl = document.createElement('div');
        messageEl.className = 'message agent';
        messageEl.innerHTML = `
            <div class="message-avatar">A</div>
            <div class="message-content">
                <div class="agent-thinking">
                    <div class="thinking-dots">
                        <span></span>
                        <span></span>
                        <span></span>
                    </div>
                    <span class="thinking-text">Working on it...</span>
                </div>
            </div>
        `;
        chatContainer.appendChild(messageEl);
        scrollToBottom();
        return messageEl;
    }

    // Update agent message with steps
    function updateAgentWithStep(messageEl, step) {
        currentSteps.push(step);

        const content = messageEl.querySelector('.message-content');
        const thinkingEl = content.querySelector('.agent-thinking');

        // Update thinking text
        if (thinkingEl) {
            const thinkingText = thinkingEl.querySelector('.thinking-text');
            if (thinkingText) {
                thinkingText.textContent = `Step ${step.stepNumber}: ${formatAction(step.action)}`;
            }
        }

        // Add or update steps accordion
        let accordion = content.querySelector('.steps-accordion');
        if (!accordion) {
            accordion = document.createElement('div');
            accordion.className = 'steps-accordion';
            accordion.innerHTML = `
                <button class="steps-toggle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"/>
                    </svg>
                    <span class="steps-count">${currentSteps.length} steps</span>
                </button>
                <div class="steps-list">
                    <div class="steps-list-inner"></div>
                </div>
            `;
            content.appendChild(accordion);

            // Toggle handler
            const toggle = accordion.querySelector('.steps-toggle');
            const list = accordion.querySelector('.steps-list');
            toggle.addEventListener('click', () => {
                toggle.classList.toggle('expanded');
                list.classList.toggle('expanded');
            });
        }

        // Update step count
        const countEl = accordion.querySelector('.steps-count');
        if (countEl) {
            countEl.textContent = `${currentSteps.length} steps`;
        }

        // Add step to list
        const listInner = accordion.querySelector('.steps-list-inner');
        const stepEl = document.createElement('div');
        stepEl.className = 'step-item';
        stepEl.innerHTML = `
            <span class="step-num">${step.stepNumber}</span>
            <div class="step-info">
                <div class="step-action">${formatAction(step.action)}</div>
                ${step.thought ? `<div class="step-thought">${escapeHtml(step.thought)}</div>` : ''}
            </div>
        `;
        listInner.appendChild(stepEl);

        // Update screenshot preview if available
        if (step.screenshotBase64) {
            updateBrowserPreview(step.screenshotBase64, urlInput.value);
        }

        scrollToBottom();
    }

    // Update browser preview with screenshot or screencast frame
    function updateBrowserPreview(base64, url, format = 'png') {
        browserPreview.classList.add('visible');
        previewUrl.textContent = url || 'Unknown URL';

        // Remove any existing iframe (noVNC)
        const existingIframe = previewContent.querySelector('iframe');
        if (existingIframe) {
            existingIframe.remove();
        }

        // Reuse existing img element if possible for smoother updates
        let img = previewContent.querySelector('img');
        if (!img) {
            previewContent.innerHTML = '';
            img = document.createElement('img');
            img.alt = 'Browser preview';
            previewContent.appendChild(img);
        }
        img.src = `data:image/${format};base64,${base64}`;
    }

    // Show noVNC live preview
    function showNoVNCPreview(novncUrl) {
        browserPreview.classList.add('visible');
        previewUrl.textContent = 'Live Preview (noVNC)';

        // Clear content and add iframe
        previewContent.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.src = `${novncUrl}?autoconnect=true&resize=scale&quality=6&compression=2`;
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.allow = 'fullscreen';
        previewContent.appendChild(iframe);
    }

    // Finalize agent message with result
    function finalizeAgentMessage(messageEl, success, reason) {
        const content = messageEl.querySelector('.message-content');

        // Remove thinking indicator
        const thinkingEl = content.querySelector('.agent-thinking');
        if (thinkingEl) {
            thinkingEl.remove();
        }

        // Add result bubble
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = success
            ? 'I\'ve completed the task.'
            : 'I wasn\'t able to complete the task.';
        content.insertBefore(bubble, content.firstChild);

        // Add result box
        const resultBox = document.createElement('div');
        resultBox.className = `result-box ${success ? 'success' : 'error'}`;
        resultBox.innerHTML = `
            <div class="result-header">
                ${success
                    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
                }
                <span>${success ? 'Success' : 'Failed'}</span>
            </div>
            ${reason ? `<div class="result-reason">${escapeHtml(reason)}</div>` : ''}
        `;

        // Insert after bubble
        bubble.after(resultBox);

        // Save to conversation
        const conv = conversations.find(c => c.id === currentConversationId);
        if (conv) {
            conv.messages.push({
                role: 'agent',
                content: success ? 'I\'ve completed the task.' : 'I wasn\'t able to complete the task.',
                success: success,
                reason: reason,
                steps: [...currentSteps]
            });
            conv.updatedAt = Date.now();
            saveConversations();
        }

        scrollToBottom();
    }

    // Start agent
    function startAgent(url, goal, provider) {
        isRunning = true;
        currentSteps = [];

        // Update UI
        sendBtn.disabled = true;
        cancelBtn.classList.add('visible');

        // Show preview panel
        browserPreview.classList.add('visible');
        previewUrl.textContent = url;
        previewContent.innerHTML = `
            <div class="browser-preview-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                    <line x1="8" y1="21" x2="16" y2="21"/>
                    <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
                <span>Loading page...</span>
            </div>
        `;

        // Add agent message
        currentAgentMessage = addAgentMessage();

        // Connect WebSocket
        connectWebSocket(url, goal, provider);
    }

    // Stop agent
    function stopAgent(reason) {
        isRunning = false;
        sendBtn.disabled = false;
        cancelBtn.classList.remove('visible');

        if (currentAgentMessage) {
            finalizeAgentMessage(currentAgentMessage, false, reason);
            currentAgentMessage = null;
        }

        if (ws) {
            ws.close();
            ws = null;
        }
    }

    // Connect WebSocket
    function connectWebSocket(url, goal, provider) {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${wsProtocol}//${window.location.host}`);

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: 'run',
                url: url,
                goal: goal,
                provider: provider
            }));
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleMessage(data);
            } catch (e) {
                console.error('Failed to parse message:', e);
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            stopAgent('Connection error');
        };

        ws.onclose = () => {
            if (isRunning) {
                stopAgent('Connection closed');
            }
        };
    }

    // Handle WebSocket message
    function handleMessage(data) {
        switch (data.type) {
            case 'step':
                if (currentAgentMessage) {
                    updateAgentWithStep(currentAgentMessage, data.step);
                }
                break;
            case 'screenshot':
                updateBrowserPreview(data.screenshot, data.url || urlInput.value, 'png');
                break;
            case 'screencast-frame':
                // Real-time screencast frame (jpeg format) - fallback
                updateBrowserPreview(data.frame, data.url || urlInput.value, 'jpeg');
                break;
            case 'novnc-url':
                // Show live noVNC preview
                showNoVNCPreview(data.url);
                break;
            case 'complete':
                handleComplete(data);
                break;
            case 'error':
                stopAgent(data.message);
                break;
            case 'log':
                console.log('[Server]', data.message);
                break;
        }
    }

    // Handle completion
    function handleComplete(data) {
        isRunning = false;
        sendBtn.disabled = false;
        cancelBtn.classList.remove('visible');

        if (currentAgentMessage) {
            finalizeAgentMessage(currentAgentMessage, data.success, data.reason || data.error);
            currentAgentMessage = null;
        }

        // Keep WebSocket open so user can still scroll the preview
        // WebSocket will be closed when starting a new run or closing preview
    }

    // Format action for display
    function formatAction(action) {
        if (!action) return 'Unknown action';

        const type = action.type || 'Unknown';
        let detail = '';

        switch (type) {
            case 'KEY_PRESS':
                detail = action.key ? ` "${action.key}"` : '';
                break;
            case 'TYPE':
                detail = action.text ? ` "${truncate(action.text, 20)}"` : '';
                break;
            case 'CLICK':
                detail = action.targetId ? ` on #${action.targetId}` : '';
                break;
            case 'finish_run':
                return 'Finishing task';
        }

        return `${type}${detail}`;
    }

    // Shake element animation
    function shakeElement(element) {
        element.style.animation = 'shake 0.4s ease';
        element.addEventListener('animationend', () => {
            element.style.animation = '';
        }, { once: true });

        if (!document.getElementById('shake-style')) {
            const style = document.createElement('style');
            style.id = 'shake-style';
            style.textContent = `
                @keyframes shake {
                    0%, 100% { transform: translateX(0); }
                    20%, 60% { transform: translateX(-5px); }
                    40%, 80% { transform: translateX(5px); }
                }
            `;
            document.head.appendChild(style);
        }
    }

    // Scroll to bottom of chat
    function scrollToBottom() {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    // Utility: Escape HTML
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Utility: Truncate string
    function truncate(str, maxLength) {
        if (!str) return '';
        return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
