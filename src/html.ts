import * as vscode from 'vscode';

/** Builds the webview HTML shell, wiring up the bundled script and stylesheet. */
export function getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${nonce}">
        body {
            margin: 0;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-foreground);
        }
        body.booting > * {
            visibility: hidden;
        }
    </style>
    <link href="${styleUri}" rel="stylesheet">
    <title>AI Chat</title>
</head>
<body class="booting">
    <div class="tab-bar" id="tab-bar">
        <div class="tabs" id="tabs"></div>
        <button class="tab-btn tab-new" id="tab-new" title="New tab">+ New tab</button>
        <button class="tab-btn tab-history" id="tab-history" title="History">&#128336;</button>
        <button class="tab-btn tab-settings" id="tab-settings" title="Settings">&#9881;</button>
    </div>

    <div class="chat-history" id="chat-history"></div>

    <div class="input-area">
        <div class="pending-tools" id="pending-tools"></div>
        <div class="mention-popup" id="mention-popup"></div>
        <textarea id="chat-input" placeholder="Ask a question, @ mention a file, # find a symbol, or / invoke a skill..." rows="1"></textarea>
        <div class="input-bottom-row">
            <select id="mode-select" class="mode-selector">
                <option value="edit" selected>&#9998; EDIT MODE</option>
                <option value="ask">&#128172; ASK MODE</option>
            </select>
            <div class="action-buttons-container" id="action-buttons-container"></div>
        </div>
    </div>

    <div class="history-overlay" id="history-overlay">
        <div class="history-header">
            <span>History</span>
            <button class="tab-btn" id="history-close" title="Close">&#10005;</button>
        </div>
        <div class="history-list" id="history-list"></div>
    </div>

    <div class="history-overlay" id="settings-overlay">
        <div class="history-header">
            <span>Settings</span>
            <button class="tab-btn" id="settings-close" title="Close">&#10005;</button>
        </div>
        <div class="settings-body">
            <label class="settings-label" for="settings-instructions">Custom instructions</label>
            <div class="settings-hint">Appended before the tool descriptions in the initial prompt.</div>
            <textarea id="settings-instructions" class="settings-textarea" rows="6"></textarea>

            <label class="settings-label" for="settings-tree-bytes">Max file tree size (bytes)</label>
            <input id="settings-tree-bytes" class="settings-input" type="number" min="0" />

            <label class="settings-label" for="settings-ignore">Ignore patterns</label>
            <div class="settings-hint">Comma-separated regexes, matched against workspace-relative paths.</div>
            <textarea id="settings-ignore" class="settings-textarea" rows="3"></textarea>

            <button id="settings-save" class="settings-save">Save</button>
        </div>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
