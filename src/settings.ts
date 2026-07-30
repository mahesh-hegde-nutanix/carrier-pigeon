import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { AppSettings, DEFAULT_SETTINGS } from '../shared/settings';

const STORAGE_DIR_NAME = '.carrier-pigeon';
const SETTINGS_FILE_NAME = 'settings.json';

const settingsUri = vscode.Uri.file(
    path.join(os.homedir(), STORAGE_DIR_NAME, SETTINGS_FILE_NAME)
);

let current: AppSettings = DEFAULT_SETTINGS;

/** Returns the in-memory settings; defaults until loadSettings resolves. */
export function getSettings(): AppSettings {
    return current;
}

/** Loads settings from disk into memory, falling back to defaults. */
export async function loadSettings(): Promise<void> {
    try {
        const data = await vscode.workspace.fs.readFile(settingsUri);
        const parsed = JSON.parse(Buffer.from(data).toString('utf8')) as Partial<AppSettings>;
        current = { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
        current = DEFAULT_SETTINGS;
    }
}

/** Persists settings to disk and updates the in-memory copy. */
export async function saveSettings(settings: AppSettings): Promise<void> {
    current = settings;
    await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.join(os.homedir(), STORAGE_DIR_NAME))
    );
    const body = Buffer.from(JSON.stringify(settings, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(settingsUri, body);
}

/** Drops uris whose workspace-relative path matches any configured ignore regex. */
export function filterIgnored(uris: vscode.Uri[]): vscode.Uri[] {
    const patterns = compileIgnorePatterns(current.ignorePatterns);
    if (patterns.length === 0) return uris;
    return uris.filter(uri => {
        const rel = vscode.workspace.asRelativePath(uri);
        return !patterns.some(re => re.test(rel));
    });
}

function compileIgnorePatterns(patterns: string[]): RegExp[] {
    const compiled: RegExp[] = [];
    for (const raw of patterns) {
        const source = raw.trim();
        if (!source) continue;
        try {
            compiled.push(new RegExp(source));
        } catch (e) {
            console.error('[Settings] Invalid ignore regex:', raw, e);
        }
    }
    return compiled;
}
