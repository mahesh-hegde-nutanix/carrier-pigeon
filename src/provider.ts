import * as vscode from 'vscode';
import { SessionStore } from './sessionStore';
import { buildContextPayload, RuleFilesCache, WorkspaceFilesCache } from './context';
import { getHtmlForWebview } from './html';
import { HostToWebview, WebviewToHost } from '../shared/protocol';
import { ChatMode, Session } from '../shared/session';
import { logTiming, timed } from './timing';
import { runTools } from './toolRunner';
import { ToolCall } from '../shared/toolParser';

export const CHAT_VIEW_ID = 'carrierPigeon.chatView';

/** Backs the Carrier Pigeon chat webview: renders it and bridges its messages. */
export class AIChatViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private readonly store: SessionStore;
    private readonly rulesCache: RuleFilesCache;
    private readonly filesCache: WorkspaceFilesCache;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.store = new SessionStore(context);
        this.rulesCache = new RuleFilesCache();
        this.filesCache = new WorkspaceFilesCache();
        context.subscriptions.push(this.rulesCache, this.filesCache);
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };
        webviewView.webview.html = getHtmlForWebview(
            webviewView.webview,
            this.context.extensionUri
        );

        webviewView.webview.onDidReceiveMessage(async (data: WebviewToHost) => {
            try {
                await this.handleMessage(data);
            } catch (err) {
                console.error('[CarrierPigeon] Error handling message:', data && data.type, err);
            }
        });
    }

    private post(message: HostToWebview): void {
        this.view?.webview.postMessage(message);
    }

    private async handleMessage(data: WebviewToHost): Promise<void> {
        switch (data.type) {
            case 'ready':
                await this.sendInitState();
                break;
            case 'requestFiles': {
                const uris = await timed('requestFiles.scan', () => this.filesCache.get());
                console.log(`[CarrierPigeon][timing] requestFiles.fileCount: ${uris.length}`);
                const files = uris.map(uri => vscode.workspace.asRelativePath(uri));
                this.post({ type: 'fileList', files });
                break;
            }
            case 'requestContextCopy':
                await this.copyContext(data.text, data.files, data.isInitial, data.mode);
                break;
            case 'requestPaste': {
                const value = await vscode.env.clipboard.readText();
                this.post({ type: 'pastedMessage', value });
                break;
            }
            case 'createSession': {
                const session = await this.store.createSession();
                this.post({ type: 'sessionCreated', session });
                break;
            }
            case 'saveSession': {
                const session = data.session;
                session.updatedAt = new Date().toISOString();
                await this.store.writeSession(session);
                break;
            }
            case 'updateOpenTabs':
                await this.store.setTabState({ ids: data.ids, activeId: data.activeId });
                break;
            case 'requestSessions': {
                const sessions = await this.store.listSessions();
                this.post({ type: 'sessionList', sessions });
                break;
            }
            case 'loadSession': {
                const session = await this.store.readSession(data.id);
                this.post({ type: 'sessionLoaded', session });
                break;
            }
            case 'deleteSession': {
                await this.store.deleteSession(data.id);
                const sessions = await this.store.listSessions();
                this.post({ type: 'sessionDeleted', id: data.id, sessions });
                break;
            }
            case 'executeTools':
                await this.executeTools(data.calls, data.sessionFiles);
                break;
            case 'copyText':
                await vscode.env.clipboard.writeText(data.text);
                vscode.window.setStatusBarMessage('$(clippy) Carrier Pigeon: errors copied', 3000);
                break;
        }
    }

    private async executeTools(calls: ToolCall[], sessionFiles: string[]): Promise<void> {
        const result = await runTools(calls, sessionFiles);
        let copied = false;
        if (result.resultsText) {
            await vscode.env.clipboard.writeText(result.resultsText);
            copied = true;
            vscode.window.setStatusBarMessage('$(clippy) Carrier Pigeon: tool results copied', 3000);
        }
        this.post({
            type: 'toolResults',
            resultsText: result.resultsText,
            copied,
            errorReport: result.errorReport
        });
    }

    private async copyContext(
        text: string,
        files: string[],
        isInitial: boolean,
        mode: ChatMode
    ): Promise<void> {
        const start = Date.now();
        const payload = await buildContextPayload(
            { text, files, isInitial, mode },
            { rules: this.rulesCache, files: this.filesCache }
        );
        await timed('clipboard.write', () => vscode.env.clipboard.writeText(payload));
        vscode.window.setStatusBarMessage(
            '$(clippy) Carrier Pigeon: context copied to clipboard',
            3000
        );
        this.post({ type: 'contextCopied', text });
        logTiming('copyContext total', start);
    }

    private async sendInitState(): Promise<void> {
        const state = this.store.getTabState();
        const openSessions: Session[] = [];
        let activeId = state?.activeId ?? null;

        if (state && Array.isArray(state.ids)) {
            for (const id of state.ids) {
                try {
                    openSessions.push(await this.store.readSession(id));
                } catch {
                    // Session was deleted externally; skip it.
                }
            }
        }

        if (openSessions.length === 0) {
            const session = await this.store.createSession();
            openSessions.push(session);
            activeId = session.id;
        }

        if (!openSessions.some(s => s.id === activeId)) {
            activeId = openSessions[0].id;
        }

        this.post({ type: 'initState', sessions: openSessions, activeId });
    }
}
