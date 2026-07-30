// Types shared between the extension host and the webview.

export type ChatSender = 'user' | 'ai';

export type ChatMode = 'ask' | 'edit';

export interface ChatMessage {
    sender: ChatSender;
    text: string;
}

export interface Session {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    mode: ChatMode;
    initialContextCopied: boolean;
    mentionedFiles: string[];
    messages: ChatMessage[];
}

/** Lightweight session metadata shown in the history overlay. */
export interface SessionSummary {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
}

/** Persisted set of tabs and which one is active. */
export interface TabState {
    ids: string[];
    activeId: string | null;
}
