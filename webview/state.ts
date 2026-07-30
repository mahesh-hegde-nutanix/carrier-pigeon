import { Session } from '../shared/session';
import { post } from './dom';

// Full session objects backing the open tabs.
let openSessions: Session[] = [];
let activeId: string | null = null;

// All workspace file paths, lazily fetched for @-mentions.
let workspaceFiles: string[] = [];

export function getSessions(): Session[] {
    return openSessions;
}

export function setSessions(sessions: Session[]): void {
    openSessions = sessions;
}

export function getActiveId(): string | null {
    return activeId;
}

export function setActiveId(id: string | null): void {
    activeId = id;
}

export function getActive(): Session | null {
    return openSessions.find(s => s.id === activeId) || null;
}

export function getWorkspaceFiles(): string[] {
    return workspaceFiles;
}

export function setWorkspaceFiles(files: string[]): void {
    workspaceFiles = files;
}

export function persistOpenTabs(): void {
    post({
        type: 'updateOpenTabs',
        ids: openSessions.map(s => s.id),
        activeId
    });
}

export function saveSession(session: Session | null): void {
    if (session) post({ type: 'saveSession', session });
}

export function saveActive(): void {
    saveSession(getActive());
}

/** Returns workspace files explicitly @-mentioned in the given text. */
export function getMentionedFiles(text: string): string[] {
    return workspaceFiles.filter(file => text.includes('@' + file));
}
