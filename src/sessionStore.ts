import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session, SessionSummary, TabState } from '../shared/session';

const STORAGE_DIR_NAME = '.carrier-pigeon';
const SESSIONS_SUBDIR = 'sessions';
const OPEN_TABS_STATE_KEY = 'carrierPigeon.openTabs';
const SESSION_FILE_SUFFIX = '.json';

/** Persists chat sessions as JSON files under the user's home directory. */
export class SessionStore {
    private readonly storageDir: vscode.Uri;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.storageDir = vscode.Uri.file(
            path.join(os.homedir(), STORAGE_DIR_NAME, SESSIONS_SUBDIR)
        );
    }

    getTabState(): TabState | undefined {
        return this.context.globalState.get<TabState>(OPEN_TABS_STATE_KEY);
    }

    async setTabState(state: TabState): Promise<void> {
        await this.context.globalState.update(OPEN_TABS_STATE_KEY, state);
    }

    async writeSession(session: Session): Promise<void> {
        await this.ensureStorageDir();
        const data = Buffer.from(JSON.stringify(session, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(this.sessionUri(session.id), data);
    }

    async readSession(id: string): Promise<Session> {
        const data = await vscode.workspace.fs.readFile(this.sessionUri(id));
        return JSON.parse(Buffer.from(data).toString('utf8')) as Session;
    }

    async deleteSession(id: string): Promise<void> {
        try {
            await vscode.workspace.fs.delete(this.sessionUri(id));
        } catch (e) {
            console.error('[CarrierPigeon] Failed to delete session:', id, e);
        }
    }

    /** Returns metadata for every stored session, most recently updated first. */
    async listSessions(): Promise<SessionSummary[]> {
        await this.ensureStorageDir();
        const entries = await vscode.workspace.fs.readDirectory(this.storageDir);
        const sessions: SessionSummary[] = [];
        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File || !name.endsWith(SESSION_FILE_SUFFIX)) continue;
            try {
                const s = await this.readSession(name.slice(0, -SESSION_FILE_SUFFIX.length));
                sessions.push({
                    id: s.id,
                    name: s.name,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                    messageCount: (s.messages || []).length
                });
            } catch (e) {
                console.error('[CarrierPigeon] Failed to read session file:', name, e);
            }
        }
        sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return sessions;
    }

    async createSession(): Promise<Session> {
        const now = new Date().toISOString();
        const session: Session = {
            id: crypto.randomUUID(),
            name: await this.nextSessionName(),
            createdAt: now,
            updatedAt: now,
            mode: 'edit',
            initialContextCopied: false,
            mentionedFiles: [],
            messages: []
        };
        await this.writeSession(session);
        return session;
    }

    /** Removes stored sessions that have no messages, except those in keepIds.
     * Cleans up empty sessions orphaned by a crash or an unclean shutdown. */
    async pruneEmptySessions(keepIds: Set<string>): Promise<void> {
        const summaries = await this.listSessions();
        for (const s of summaries) {
            if (s.messageCount === 0 && !keepIds.has(s.id)) {
                await this.deleteSession(s.id);
            }
        }
    }

    private async nextSessionName(): Promise<string> {
        const sessions = await this.listSessions();
        const existing = new Set(sessions.map(s => s.name));
        let n = sessions.length + 1;
        while (existing.has(`Session ${n}`)) n++;
        return `Session ${n}`;
    }

    private sessionUri(id: string): vscode.Uri {
        return vscode.Uri.joinPath(this.storageDir, `${id}${SESSION_FILE_SUFFIX}`);
    }

    private async ensureStorageDir(): Promise<void> {
        await vscode.workspace.fs.createDirectory(this.storageDir);
    }
}
