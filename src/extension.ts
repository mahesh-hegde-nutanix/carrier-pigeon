import * as vscode from 'vscode';
import { AIChatViewProvider, CHAT_VIEW_ID } from './provider';

export function activate(context: vscode.ExtensionContext): void {
    const provider = new AIChatViewProvider(context);

    const disposable = vscode.window.registerWebviewViewProvider(
        CHAT_VIEW_ID,
        provider,
        {
            // Keeps the chat state when switching sidebars.
            webviewOptions: { retainContextWhenHidden: true }
        }
    );

    context.subscriptions.push(disposable);
}

export function deactivate(): void { }
