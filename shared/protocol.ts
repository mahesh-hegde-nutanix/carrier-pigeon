// Message protocol between the extension host and the webview.
// Both directions are modelled as discriminated unions on `type`.

import { ChatMode, Session, SessionSummary } from './session';
import { AppSettings } from './settings';
import { SkillSummary } from './skills';
import { ToolCall } from './toolParser';

// ---- webview -> host --------------------------------------------------------

export interface ReadyMsg {
    type: 'ready';
}

export interface RequestFilesMsg {
    type: 'requestFiles';
    purpose: FileListPurpose;
}

export interface RequestContextCopyMsg {
    type: 'requestContextCopy';
    sessionId: string;
    text: string;
    files: string[];
    isInitial: boolean;
    mode: ChatMode;
}

export interface RequestPasteMsg {
    type: 'requestPaste';
}

export interface CreateSessionMsg {
    type: 'createSession';
}

export interface SaveSessionMsg {
    type: 'saveSession';
    session: Session;
}

export interface UpdateOpenTabsMsg {
    type: 'updateOpenTabs';
    ids: string[];
    activeId: string | null;
}

export interface RequestSessionsMsg {
    type: 'requestSessions';
}

export interface LoadSessionMsg {
    type: 'loadSession';
    id: string;
}

export interface DeleteSessionMsg {
    type: 'deleteSession';
    id: string;
}

/** Discards a closed empty session; unlike deleteSession it triggers no UI refresh. */
export interface DiscardSessionMsg {
    type: 'discardSession';
    id: string;
}

export interface ExecuteToolsMsg {
    type: 'executeTools';
    calls: ToolCall[];
    // Files already in the session context; edits are checked for new lint
    // errors against these plus the edited files.
    sessionFiles: string[];
}

export interface CopyTextMsg {
    type: 'copyText';
    text: string;
}

export interface RequestSettingsMsg {
    type: 'requestSettings';
}

export interface UpdateSettingsMsg {
    type: 'updateSettings';
    settings: AppSettings;
}

export type WebviewToHost =
    | ReadyMsg
    | RequestFilesMsg
    | RequestContextCopyMsg
    | RequestPasteMsg
    | CreateSessionMsg
    | SaveSessionMsg
    | UpdateOpenTabsMsg
    | RequestSessionsMsg
    | LoadSessionMsg
    | DeleteSessionMsg
    | DiscardSessionMsg
    | ExecuteToolsMsg
    | CopyTextMsg
    | RequestSettingsMsg
    | UpdateSettingsMsg;

// ---- host -> webview --------------------------------------------------------

export type FileListPurpose = 'prefetch' | 'mention' | 'copy';

export interface InitStateMsg {
    type: 'initState';
    sessions: Session[];
    activeId: string | null;
    skills: SkillSummary[];
}

export interface SessionCreatedMsg {
    type: 'sessionCreated';
    session: Session;
}

export interface SessionListMsg {
    type: 'sessionList';
    sessions: SessionSummary[];
}

export interface SessionLoadedMsg {
    type: 'sessionLoaded';
    session: Session;
}

export interface SessionDeletedMsg {
    type: 'sessionDeleted';
    id: string;
    sessions: SessionSummary[];
}

export interface FileListMsg {
    type: 'fileList';
    purpose: FileListPurpose;
    files: string[];
}

export interface ContextCopiedMsg {
    type: 'contextCopied';
    sessionId: string;
    text: string;
}

export interface PastedMessageMsg {
    type: 'pastedMessage';
    value: string;
}

export interface ToolResultsMsg {
    type: 'toolResults';
    // Combined output of read/outline/run tools, already copied to clipboard.
    resultsText?: string;
    copied: boolean;
    // Edit failures and newly introduced lint errors, if any.
    errorReport?: string;
}

export interface SettingsLoadedMsg {
    type: 'settingsLoaded';
    settings: AppSettings;
}

export interface ToolOutputChunkMsg {
    type: 'toolOutputChunk';
    chunk: string;
}

export type HostToWebview =
    | InitStateMsg
    | SessionCreatedMsg
    | SessionListMsg
    | SessionLoadedMsg
    | SessionDeletedMsg
    | FileListMsg
    | ContextCopiedMsg
    | PastedMessageMsg
    | ToolResultsMsg
    | SettingsLoadedMsg
    | ToolOutputChunkMsg;
