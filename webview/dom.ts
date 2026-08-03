import { WebviewToHost } from '../shared/protocol';

interface VsCodeApi {
    postMessage(msg: WebviewToHost): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

/** Sends a typed message to the extension host. */
export function post(msg: WebviewToHost): void {
    vscodeApi.postMessage(msg);
}

/** Shows the webview after CSS and initial state have been applied. */
export function revealBooted(): void {
    document.body.classList.remove('booting');
}

function byId<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

export const els = {
    chatHistory: byId<HTMLDivElement>('chat-history'),
    chatInput: byId<HTMLTextAreaElement>('chat-input'),
    pendingTools: byId<HTMLDivElement>('pending-tools'),
    mentionPopup: byId<HTMLDivElement>('mention-popup'),
    modeSelect: byId<HTMLSelectElement>('mode-select'),
    callGraphCheck: byId<HTMLInputElement>('call-graph-check'),
    callGraphError: byId<HTMLSpanElement>('call-graph-error'),
    tabs: byId<HTMLDivElement>('tabs'),
    historyOverlay: byId<HTMLDivElement>('history-overlay'),
    historyList: byId<HTMLDivElement>('history-list'),
    actionButtons: byId<HTMLDivElement>('action-buttons-container'),
    tabNew: byId<HTMLButtonElement>('tab-new'),
    tabHistory: byId<HTMLButtonElement>('tab-history'),
    historyClose: byId<HTMLButtonElement>('history-close'),
    tabSettings: byId<HTMLButtonElement>('tab-settings'),
    settingsOverlay: byId<HTMLDivElement>('settings-overlay'),
    settingsClose: byId<HTMLButtonElement>('settings-close'),
    settingsInstructions: byId<HTMLTextAreaElement>('settings-instructions'),
    settingsTreeBytes: byId<HTMLInputElement>('settings-tree-bytes'),
    settingsIgnore: byId<HTMLTextAreaElement>('settings-ignore'),
    settingsCallGraphTimeout: byId<HTMLInputElement>('settings-callgraph-timeout'),
    settingsSave: byId<HTMLButtonElement>('settings-save')
};
