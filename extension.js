// Carrier Pigeon is an extension to enable semi-agentic workflows with nothing but access to a web based
// Chat UI for LLMs.
//
// The name is a reference to RFC2549: IP over Avian Carriers

const vscode = require('vscode');

class AIChatViewProvider {
    /**
     * @param {vscode.ExtensionContext} context
     */
    constructor(context) {
        this._context = context;
    }

    /**
     * @param {vscode.WebviewView} webviewView
     */
    resolveWebviewView(webviewView) {
        this._view = webviewView;

        // Allow JavaScript in the webview
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        // Set the HTML content
        webviewView.webview.html = this._getHtmlForWebview();

        // Listen for messages from the webview (the UI)
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'requestFiles':
                    // Fetch files respecting .gitignore and default search excludes by passing null
                    try {
                        const uris = await vscode.workspace.findFiles('**/*', null);
                        const paths = uris.map(uri => vscode.workspace.asRelativePath(uri));
                        console.log('[CarrierPigeon] paths', paths)
                        // Send the file list back to the webview
                        this._view.webview.postMessage({
                            type: 'fileList',
                            files: paths
                        });
                    } catch (err) {
                        console.error('[Webview] Error fetching workspace files:', err);
                    }
                    break;
                case 'requestContextCopy':
                    try {
                        const { text, files, isInitial, mode } = data;
                        const payloadBuffer = [];

                        if (isInitial) {
                            const commonSystemPromptBegin = "You're an expert software engineer.";

                            let modeSpecificPrompt = "";
                            if (mode === 'edit') {
                                modeSpecificPrompt = "Write concise and robust code. Consider all edge cases";
                            } else {
                                modeSpecificPrompt = "Explore the codebase using provided tools and answer the user's questions in a brief and practical manner";
                            }

                            const commonSystemPromptEnd = "Be terse and efficient in your responses to the user. Ask user before performing unidiomatic changes."

                            const fullSystemPrompt = `${commonSystemPromptBegin}\n\n${modeSpecificPrompt}\n\n${commonSystemPromptEnd}`;

                            payloadBuffer.push(`## Important instructions:\n${fullSystemPrompt}\n\n`);
                            payloadBuffer.push(`## Task Details\n${text}\n`);

                            try {
                                const treeString = await this._getWorkspaceTreeString();
                                payloadBuffer.push(`Workspace Tree:\n${treeString}\n`);
                            } catch (treeErr) {
                                console.error('[Webview] Error generating workspace tree for context:', treeErr);
                                payloadBuffer.push(`Workspace Tree: (Error generating tree)\n`);
                            }

                            try {
                                const rulesContext = await this._getRuleFilesContext();
                                if (rulesContext) payloadBuffer.push(rulesContext);
                            } catch (rulesErr) {
                                console.error('[Webview] Error fetching rule files for context:', rulesErr);
                            }

                            try {
                                const filesContext = await this._getFilesContext(files);
                                if (filesContext) payloadBuffer.push(filesContext);
                            } catch (filesErr) {
                                console.error('[Webview] Error fetching initial mentioned files for context:', filesErr);
                            }
                        } else {
                            // Further context
                            payloadBuffer.push(`## Task details:\n${text}\n`);
                            try {
                                const filesContext = await this._getFilesContext(files);
                                if (filesContext) payloadBuffer.push(filesContext);
                            } catch (filesErr) {
                                console.error('[Webview] Error fetching additional mentioned files for context:', filesErr);
                            }
                        }

                        // Write constructed payload to the system clipboard
                        const finalPayload = payloadBuffer.join('\n');
                        await vscode.env.clipboard.writeText(finalPayload);

                        // Tell the UI that it was successfully copied
                        this._view.webview.postMessage({
                            type: 'contextCopied',
                            text: text
                        });
                    } catch (err) {
                        console.error('[Webview] Fatal error constructing or copying context:', err);
                    }
                    break;
                case 'requestPaste':
                    try {
                        const clipboardText = await vscode.env.clipboard.readText();
                        this._view.webview.postMessage({
                            type: 'pastedMessage',
                            value: clipboardText
                        });
                    } catch (err) {
                        console.error('[Webview] Error reading from clipboard during paste:', err);
                    }
                    break;
            }
        });
    }

    async _getWorkspaceTreeString() {
        try {
            // Passing null for exclude makes VS Code automatically respect .gitignore
            const uris = await vscode.workspace.findFiles('**/*', null);
            const tree = {};

            // Build in-memory object tree
            uris.forEach(uri => {
                const path = vscode.workspace.asRelativePath(uri);
                const parts = path.split('/');
                let curr = tree;
                for (let i = 0; i < parts.length; i++) {
                    if (i === parts.length - 1) {
                        curr[parts[i]] = null; // Mark as file
                    } else {
                        curr[parts[i]] = curr[parts[i]] || {};
                        curr = curr[parts[i]];
                    }
                }
            });

            // Convert object tree to ascii string recursively
            function printTree(node, prefix = '', depth = 0, maxDepth = 100, currentPath = '') {
                if (depth > maxDepth) return '';
                let result = '';
                const keys = Object.keys(node).sort();

                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const isLast = i === keys.length - 1;
                    const marker = isLast ? '└── ' : '├── ';

                    const isDir = node[key] !== null;
                    // Directories show full relative path; Files show just their name
                    const displayString = isDir ? (currentPath ? `${currentPath}/${key}` : key) : key;

                    result += prefix + marker + displayString + '\n';

                    if (isDir) {
                        const nextPrefix = prefix + (isLast ? '    ' : '│   ');
                        const nextPath = currentPath ? `${currentPath}/${key}` : key;
                        result += printTree(node[key], nextPrefix, depth + 1, maxDepth, nextPath);
                    }
                }
                return result;
            }

            // Iteratively decrease depth if it exceeds 2048 characters
            let maxDepth = 10;
            let result = printTree(tree, '', 0, maxDepth, '');
            while (result.length > 2048 && maxDepth > 0) {
                maxDepth--;
                result = printTree(tree, '', 0, maxDepth, '');
            }
            return result;
        } catch (e) {
            console.error('[TreeBuilder] Error generating workspace tree:', e);
            return "Error generating workspace tree.";
        }
    }

    async _getRuleFilesContext() {
        try {
            const patterns = ['.cursorrules', 'AGENTS.md', 'CONTEXT.md', 'PIGEON.md'];
            let globs = [];

            // Using string concatenation exclusively to avoid `/*` syntax highlighting issues
            patterns.forEach(p => {
                globs.push(p);
                globs.push('*/' + p);
                globs.push('*/*/' + p);
            });

            const uris = await vscode.workspace.findFiles(`{${globs.join(',')}}`, null);
            const buffer = [];

            for (const uri of uris) {
                try {
                    const fileData = await vscode.workspace.fs.readFile(uri);
                    const content = Buffer.from(fileData).toString('utf8');
                    const relPath = vscode.workspace.asRelativePath(uri);

                    buffer.push(`\n------------------- begins: ${relPath} ---------------------`);
                    buffer.push(content);
                    buffer.push(`------------------- ends: ${relPath} -----------------\n`);
                } catch (e) {
                    console.error(`[RuleFiles] Failed to read rule file: ${uri.fsPath}`, e);
                }
            }
            return buffer.join('\n');
        } catch (e) {
            console.error('[RuleFiles] Failed to get rule files context:', e);
            return "";
        }
    }

    async _getFilesContext(filePaths) {
        const buffer = [];
        for (const path of filePaths) {
            try {
                const uris = await vscode.workspace.findFiles(path);
                if (uris.length > 0) {
                    const fileData = await vscode.workspace.fs.readFile(uris[0]);
                    const content = Buffer.from(fileData).toString('utf8');

                    buffer.push(`\n------------------- begins: ${path} ---------------------`);
                    buffer.push(content);
                    buffer.push(`------------------- ends: ${path} -----------------\n`);
                } else {
                    console.warn(`[FilesContext] No URI found for requested file path: ${path}`);
                }
            } catch (e) {
                console.error(`[FilesContext] Failed to read file context for: ${path}`, e);
            }
        }
        return buffer.join('\n');
    }

    _getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    _getHtmlForWebview() {
        const nonce = this._getNonce();

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>AI Chat</title>
                <style>
                    :root {
                        --chat-bg: var(--vscode-editor-background);
                        --input-bg: var(--vscode-input-background);
                        --input-fg: var(--vscode-input-foreground);
                        --input-border: var(--vscode-input-border);
                        --border-color: var(--vscode-panel-border);
                        --accent: var(--vscode-button-background);
                        --accent-hover: var(--vscode-button-hoverBackground);
                        --popup-bg: var(--vscode-editorWidget-background);
                        --popup-border: var(--vscode-editorWidget-border);
                        --popup-hover: var(--vscode-list-hoverBackground);
                    }
                    
                    body, html {
                        margin: 0;
                        padding: 0;
                        height: 100%;
                        background-color: var(--chat-bg);
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        display: flex;
                        flex-direction: column;
                    }

                    .chat-history {
                        flex: 1;
                        overflow-y: auto;
                        padding: 15px;
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                    }

                    .message {
                        max-width: 85%;
                        padding: 8px 12px;
                        border-radius: 6px;
                        word-wrap: break-word;
                        line-height: 1.4;
                    }

                    .message.user {
                        align-self: flex-end;
                        background-color: var(--accent);
                        color: var(--vscode-button-foreground);
                    }

                    .message.ai {
                        align-self: flex-start;
                        background-color: var(--input-bg);
                        border: 1px solid var(--border-color);
                    }

                    .input-area {
                        padding: 10px;
                        border-top: 1px solid var(--border-color);
                        position: relative;
                        background: var(--chat-bg);
                    }

                    .mention-popup {
                        display: none;
                        position: absolute;
                        bottom: 100%;
                        left: 10px;
                        right: 10px;
                        margin-bottom: 5px;
                        background: var(--popup-bg);
                        border: 1px solid var(--popup-border);
                        box-shadow: 0 4px 6px rgba(0,0,0,0.2);
                        max-height: 200px;
                        overflow-y: auto;
                        border-radius: 4px;
                        z-index: 1000;
                    }

                    .mention-popup.active {
                        display: block;
                    }

                    .mention-item {
                        padding: 6px 10px;
                        cursor: pointer;
                        font-family: monospace;
                        font-size: 0.9em;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    }

                    .mention-item:hover, .mention-item.selected {
                        background-color: var(--popup-hover);
                    }

                    textarea {
                        width: 100%;
                        box-sizing: border-box;
                        background: var(--input-bg);
                        color: var(--input-fg);
                        border: 1px solid var(--input-border);
                        padding: 8px;
                        border-radius: 4px;
                        resize: none;
                        font-family: inherit;
                        min-height: 40px;
                        max-height: 120px;
                        overflow-y: auto;
                    }

                    textarea:focus {
                        outline: 1px solid var(--accent);
                        outline-offset: -1px;
                    }
                    
                    .message-content {
                        overflow: hidden;
                        white-space: pre-wrap;
                    }

                    .message-content.collapsed {
                        display: -webkit-box;
                        -webkit-line-clamp: 10;
                        -webkit-box-orient: vertical;
                    }

                    .toggle-btn {
                        color: var(--vscode-textLink-foreground);
                        cursor: pointer;
                        font-size: 0.85em;
                        margin-top: 6px;
                        display: inline-block;
                        font-weight: bold;
                    }

                    .toggle-btn:hover {
                        color: var(--vscode-textLink-activeForeground);
                        text-decoration: underline;
                    }

                    .input-bottom-row {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-top: 10px;
                    }

                    .mode-selector {
                        background: var(--vscode-dropdown-background);
                        color: var(--vscode-dropdown-foreground);
                        border: 1px solid var(--vscode-dropdown-border);
                        padding: 6px 8px;
                        border-radius: 4px;
                        font-family: inherit;
                        font-size: 0.85em;
                        font-weight: 500;
                        cursor: pointer;
                        outline: none;
                    }

                    .mode-selector:focus {
                        outline: 1px solid var(--vscode-focusBorder);
                    }

                    .action-buttons-container {
                        display: flex;
                        gap: 8px;
                        justify-content: flex-end;
                    }

                    .action-button {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        padding: 8px 14px;
                        border-radius: 20px;
                        background: var(--accent);
                        color: var(--vscode-button-foreground);
                        border: none;
                        cursor: pointer;
                        font-size: 0.9em;
                        font-weight: 500;
                        transition: background-color 0.2s;
                    }

                    .action-button:hover {
                        background: var(--accent-hover);
                    }
                    
                    .action-button svg {
                        width: 14px;
                        height: 14px;
                        fill: currentColor;
                    }
                </style>
            </head>
            <body>
                <div class="chat-history" id="chat-history">
                    <div class="message ai">Hello! I am your AI coding assistant. Type @ to mention files in this workspace.</div>
                </div>
                
                <div class="input-area">
                    <div class="mention-popup" id="mention-popup"></div>
                    <textarea id="chat-input" placeholder="Ask a question or type @ to mention a file..." rows="1"></textarea>
                    <div class="input-bottom-row">
                        <select id="mode-select" class="mode-selector">
                            <option value="ask">ASK MODE</option>
                            <option value="edit">EDIT MODE</option>
                        </select>
                        <div class="action-buttons-container" id="action-buttons-container"></div>
                    </div>
                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    
                    const chatHistory = document.getElementById('chat-history');
                    const chatInput = document.getElementById('chat-input');
                    const mentionPopup = document.getElementById('mention-popup');
                    
                    let workspaceFiles = [];
                    let filteredFiles = [];
                    let currentMentionState = null;
                    let selectedPopupIndex = -1;
                    
                    let initialContextCopied = false;
                    let mentionedFilesSoFar = new Set();
                    const actionButtonsContainer = document.getElementById('action-buttons-container');

                    // Listen for messages FROM VS Code
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'fileList') {
                            workspaceFiles = message.files;
                            // Re-trigger input to open the dropdown instantly
                            chatInput.dispatchEvent(new Event('input'));
                        } else if (message.type === 'contextCopied') {
                            const sentText = message.text;
                            appendMessage(sentText, 'user');
                            
                            // Update state
                            initialContextCopied = true;
                            const allMentioned = getMentionedFiles(sentText);
                            allMentioned.forEach(f => mentionedFilesSoFar.add(f));
                            
                            chatInput.value = '';
                            autoResizeTextarea();
                            updateButtons();
                        } else if (message.type === 'pastedMessage') {
                            const pastedText = message.value;
                            if (pastedText) {
                                appendMessage(pastedText, 'ai');
                            }
                        }
                    });

                    function appendMessage(text, sender) {
                        const msgDiv = document.createElement('div');
                        msgDiv.className = 'message ' + sender;
                        
                        const contentDiv = document.createElement('div');
                        contentDiv.className = 'message-content collapsed';
                        contentDiv.textContent = text;
                        msgDiv.appendChild(contentDiv);

                        // Check line counts for collapse feature
                        const lines = text.split('\\n').length;
                        if (lines > 10) {
                            const toggleBtn = document.createElement('div');
                            toggleBtn.className = 'toggle-btn';
                            toggleBtn.textContent = 'Show more';
                            
                            toggleBtn.onclick = () => {
                                if (contentDiv.classList.contains('collapsed')) {
                                    contentDiv.classList.remove('collapsed');
                                    toggleBtn.textContent = 'Show less';
                                } else {
                                    contentDiv.classList.add('collapsed');
                                    toggleBtn.textContent = 'Show more';
                                }
                            };
                            msgDiv.appendChild(toggleBtn);
                        }

                        chatHistory.appendChild(msgDiv);
                        chatHistory.scrollTop = chatHistory.scrollHeight;
                    }
                    
                    function getMentionedFiles(text) {
                        const mentioned = [];
                        workspaceFiles.forEach(file => {
                            if (text.includes('@' + file)) {
                                mentioned.push(file);
                            }
                        });
                        return mentioned;
                    }

                    function updateButtons() {
                        const hasText = chatInput.value.trim().length > 0;
                        actionButtonsContainer.innerHTML = ''; 
                        
                        if (!initialContextCopied) {
                            if (hasText) {
                                actionButtonsContainer.appendChild(createCopyButton());
                            }
                        } else {
                            if (hasText) {
                                actionButtonsContainer.appendChild(createCopyButton());
                            }
                            actionButtonsContainer.appendChild(createPasteButton());
                        }
                    }

                    function createCopyButton() {
                        const btn = document.createElement('button');
                        btn.className = 'action-button';
                        btn.innerHTML = \`<svg viewBox="0 0 16 16"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path d="M3 1L2 2v10h1V2h6.414l-1-1H3z"/></svg> COPY CONTEXT\`;
                        btn.onclick = () => performCopy();
                        return btn;
                    }

                    function createPasteButton() {
                        const btn = document.createElement('button');
                        btn.className = 'action-button';
                        btn.innerHTML = \`<svg viewBox="0 0 16 16"><path d="M11 2h-1.54C9.13 1 8.35 1 7.5 1c-.85 0-1.63 0-1.96 1H4L3 3v11l1 1h8l1-1V3l-1-1zM7.5 2c.28 0 .5.22.5.5s-.22.5-.5.5-.5-.22-.5-.5.22-.5.5-.5zM12 14H4V3h1v1h6V3h1v11z"/></svg> PASTE\`;
                        btn.onclick = () => performPaste();
                        return btn;
                    }

                    function performCopy() {
                        const text = chatInput.value.trim();
                        if (!text) return;

                        const modeSelect = document.getElementById('mode-select');
                        const mode = modeSelect ? modeSelect.value : 'ask';

                        const allMentioned = getMentionedFiles(text);
                        // Filter to files we haven't sent yet
                        const newMentioned = allMentioned.filter(f => !mentionedFilesSoFar.has(f));
                        
                        vscode.postMessage({
                            type: 'requestContextCopy',
                            text: text,
                            files: newMentioned,
                            isInitial: !initialContextCopied,
                            mode: mode
                        });
                    }

                    function performPaste() {
                        vscode.postMessage({ type: 'requestPaste' });
                    }
                    let hasRequestedFiles = false;
                    chatInput.addEventListener('input', (e) => {
                        autoResizeTextarea();
                        checkMentionTrigger();
                        updateButtons(); // Refresh buttons based on input
                    });

                    // Trigger initial state UI setup
                    updateButtons();

                    function autoResizeTextarea() {
                        chatInput.style.height = 'auto';
                        chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
                    }

                    function checkMentionTrigger() {
                        const val = chatInput.value;
                        const cursorPos = chatInput.selectionStart;
                        
                        // Look backwards from cursor for an '@' symbol followed by non-space chars
                        const textBeforeCursor = val.substring(0, cursorPos);
                        const match = textBeforeCursor.match(/@([^\\s]*)$/);

                        if (match) {
                            if (!hasRequestedFiles) {
                                hasRequestedFiles = true;
                                console.log('[CarrierPigeon] Lazy fetching files...');
                                vscode.postMessage({ type: 'requestFiles' });
                            }
                            const query = match[1].toLowerCase();
                            currentMentionState = {
                                start: cursorPos - match[0].length,
                                end: cursorPos,
                                query: query
                            };

                            // Fuzzy search (simple includes)
                            filteredFiles = workspaceFiles.filter(f => f.toLowerCase().includes(query)).slice(0, 50);
                            
                            if (filteredFiles.length > 0) {
                                showPopup();
                            } else {
                                hidePopup();
                            }
                        } else {
                            hidePopup();
                        }
                    }

                    function showPopup() {
                        mentionPopup.innerHTML = '';
                        selectedPopupIndex = 0; // Select first item by default
                        
                        filteredFiles.forEach((file, index) => {
                            const div = document.createElement('div');
                            div.className = 'mention-item' + (index === 0 ? ' selected' : '');
                            div.textContent = file;
                            
                            // Highlight the matching part
                            if (currentMentionState && currentMentionState.query) {
                                const regex = new RegExp("(" + currentMentionState.query.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&') + ")", "gi");
                                div.innerHTML = file.replace(regex, "<strong>$1</strong>");
                            }
                            
                            div.onmousedown = (e) => {
                                e.preventDefault(); // Prevent input blur
                                insertMention(file);
                            };
                            mentionPopup.appendChild(div);
                        });
                        
                        mentionPopup.classList.add('active');
                    }

                    function hidePopup() {
                        mentionPopup.classList.remove('active');
                        currentMentionState = null;
                        selectedPopupIndex = -1;
                    }

                    function insertMention(filePath) {
                        if (!currentMentionState) return;
                        
                        const val = chatInput.value;
                        const before = val.substring(0, currentMentionState.start);
                        const after = val.substring(currentMentionState.end);
                        
                        // Insert the file path with an @ symbol, and add a space after it
                        const newVal = before + '@' + filePath + ' ' + after;
                        chatInput.value = newVal;

                        // Move cursor
                        const newCursorPos = currentMentionState.start + filePath.length + 2; // +1 for @, +1 for space
                        chatInput.setSelectionRange(newCursorPos, newCursorPos);
                        
                        hidePopup();
                        autoResizeTextarea();
                        chatInput.focus();
                    }

                    chatInput.addEventListener('keydown', (e) => {
                        if (mentionPopup.classList.contains('active')) {
                            const items = mentionPopup.querySelectorAll('.mention-item');
                            
                            if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                if (items.length > 0) items[selectedPopupIndex].classList.remove('selected');
                                selectedPopupIndex = (selectedPopupIndex + 1) % items.length;
                                if (items.length > 0) items[selectedPopupIndex].classList.add('selected');
                                items[selectedPopupIndex].scrollIntoView({ block: 'nearest' });
                                return;
                            }
                            
                            if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                if (items.length > 0) items[selectedPopupIndex].classList.remove('selected');
                                selectedPopupIndex = (selectedPopupIndex - 1 + items.length) % items.length;
                                if (items.length > 0) items[selectedPopupIndex].classList.add('selected');
                                items[selectedPopupIndex].scrollIntoView({ block: 'nearest' });
                                return;
                            }
                            
                            if (e.key === 'Enter' || e.key === 'Tab') {
                                e.preventDefault();
                                if (filteredFiles[selectedPopupIndex]) {
                                    insertMention(filteredFiles[selectedPopupIndex]);
                                }
                                return;
                            }
                            
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                hidePopup();
                                return;
                            }
                        } else {
                            // Normal chat behavior
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                performCopy(); // Submits just like clicking the copy button
                            }
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    const provider = new AIChatViewProvider(context);

    // Register the provider for our specific view ID
    // Note: ensure 'mySidebar.stubView' matches the 'id' in your package.json under 'views'
    const disposable = vscode.window.registerWebviewViewProvider(
        'carrierPigeon.chatView',
        provider,
        {
            webviewOptions: {
                retainContextWhenHidden: true // Keeps the chat state when switching sidebars
            }
        }
    );

    context.subscriptions.push(disposable);
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
};
