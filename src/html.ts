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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>AI Chat</title>
</head>
<body>
    <div class="tab-bar" id="tab-bar">
        <div class="tabs" id="tabs"></div>
        <button class="tab-btn tab-new" id="tab-new" title="New tab">+ New tab</button>
        <button class="tab-btn tab-history" id="tab-history" title="History">&#128336;</button>
    </div>

    <div class="chat-history" id="chat-history"></div>

    <div class="input-area">
        <div class="pending-tools" id="pending-tools"></div>
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

    <div class="history-overlay" id="history-overlay">
        <div class="history-header">
            <span>History</span>
            <button class="tab-btn" id="history-close" title="Close">&#10005;</button>
        </div>
        <div class="history-list" id="history-list"></div>
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
