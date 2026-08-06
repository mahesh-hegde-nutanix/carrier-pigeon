import * as vscode from 'vscode';
import { EditCall } from '../shared/toolParser';
import { resolveWorkspacePath, toFolderRelative, fileBlock } from './context';

// Diagnostics update asynchronously after an edit. We wait until they stay quiet
// for QUIET_MS, capped at MAX_WAIT_MS. Both are heuristics.
const DIAG_QUIET_MS = 700;
const DIAG_MAX_WAIT_MS = 4000;
const MAX_ADDED_INDENT_LEVELS = 3;

interface EditFailure {
    path: string;
    reason: string;
    uri?: vscode.Uri;
}

interface MatchResult {
    range: vscode.Range;
    replacement: string;
}

/**
 * Applies search-replace edits with indentation tolerance and reports any edit
 * failures or newly introduced lint errors. Returns undefined when everything
 * applied cleanly.
 */
export async function applyEdits(edits: EditCall[], sessionFiles: string[]): Promise<string | undefined> {
    const workspaceEdit = new vscode.WorkspaceEdit();
    const failures: EditFailure[] = [];
    const editedUris: vscode.Uri[] = [];

    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const uri = await resolveFile(edit.path);
        if (!uri) {
            if (edit.search.trim() !== '') {
                failures.push({ path: edit.path, reason: 'file not found and search block is not empty. To create a new file, provide an empty search block.' });
                continue;
            }
            
            const newUri = resolveWorkspacePath(edit.path);
            if (!newUri) {
                failures.push({ path: edit.path, reason: 'file not found and could not resolve workspace path for creation' });
                continue;
            }
            
            workspaceEdit.createFile(newUri, { 
                ignoreIfExists: true,
                contents: Buffer.from(edit.replace, 'utf8')
            });
            if (!editedUris.some(u => u.toString() === newUri.toString())) editedUris.push(newUri);
            continue;
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        const match = findMatch(doc, edit.search, edit.replace);
        if (!match) {
            failures.push({ path: edit.path, reason: `search block (${i + 1}) not found which starts with: ${firstLine(edit.search)}`, uri });
            continue;
        }
        workspaceEdit.replace(uri, match.range, match.replacement);
        if (!editedUris.some(u => u.toString() === uri.toString())) editedUris.push(uri);
    }

    const monitored = await monitoredUris(editedUris, sessionFiles);
    const before = snapshotErrors(monitored);

    const applied = editedUris.length > 0 ? await vscode.workspace.applyEdit(workspaceEdit) : true;
    if (!applied) {
        failures.push({ path: editedUris.map(u => vscode.workspace.asRelativePath(u)).join(', '), reason: 'applyEdit rejected' });
    } else {
        await Promise.all(editedUris.map(u => vscode.workspace.openTextDocument(u).then(d => d.save())));
    }

    await waitForDiagnostics();
    const newErrors = diffErrors(before, snapshotErrors(monitored));

    return await buildReport(failures, newErrors);
}

async function resolveFile(relPath: string): Promise<vscode.Uri | undefined> {
    const uri = resolveWorkspacePath(relPath);
    if (uri) {
        try {
            await vscode.workspace.fs.stat(uri);
            return uri;
        } catch {
            // Resolved by name but missing; fall through to a search.
        }
    }
    const found = await vscode.workspace.findFiles(toFolderRelative(relPath), null, 1);
    return found[0];
}

/** Finds the search block in the document, tolerating indentation shifts. */
function findMatch(doc: vscode.TextDocument, search: string, replace: string): MatchResult | undefined {
    const text = doc.getText();
    const unit = detectIndentUnit(text);

    const exact = text.indexOf(search);
    if (exact >= 0) {
        return toResult(doc, exact, search.length, reindent(normalize(replace).lines, normalize(search).common));
    }

    const searchNorm = normalize(search);
    const replaceNorm = normalize(replace);
    for (const prefix of candidatePrefixes(searchNorm.common, unit)) {
        const block = reindent(searchNorm.lines, prefix);
        const idx = text.indexOf(block);
        if (idx >= 0) {
            return toResult(doc, idx, block.length, reindent(replaceNorm.lines, prefix));
        }
    }
    return undefined;
}

function toResult(doc: vscode.TextDocument, index: number, length: number, replacement: string): MatchResult {
    const range = new vscode.Range(doc.positionAt(index), doc.positionAt(index + length));
    return { range, replacement };
}

/** Indent prefixes to try: strip-all, as-given, and up to N added levels. */
function candidatePrefixes(common: string, unit: string): string[] {
    const prefixes = ['', common];
    for (let n = 1; n <= MAX_ADDED_INDENT_LEVELS; n++) {
        prefixes.push(common + unit.repeat(n));
    }
    return [...new Set(prefixes)];
}

interface NormalizedBlock {
    lines: string[];
    common: string;
}

function normalize(block: string): NormalizedBlock {
    const lines = block.split('\n');
    const indents = lines.filter(l => l.trim() !== '').map(leadingWhitespace);
    const common = commonPrefix(indents);
    const stripped = lines.map(l => (l.startsWith(common) ? l.slice(common.length) : l.trimStart()));
    return { lines: stripped, common };
}

function reindent(lines: string[], prefix: string): string {
    return lines.map(l => (l === '' ? '' : prefix + l)).join('\n');
}

function leadingWhitespace(line: string): string {
    return line.slice(0, line.length - line.trimStart().length);
}

function commonPrefix(values: string[]): string {
    if (values.length === 0) return '';
    let prefix = values[0];
    for (const v of values.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < v.length && prefix[i] === v[i]) i++;
        prefix = prefix.slice(0, i);
        if (prefix === '') break;
    }
    return prefix;
}

function detectIndentUnit(text: string): string {
    let minSpaces = Infinity;
    for (const line of text.split('\n')) {
        const ws = leadingWhitespace(line);
        if (ws.includes('\t')) return '\t';
        if (ws.length > 0) minSpaces = Math.min(minSpaces, ws.length);
    }
    return Number.isFinite(minSpaces) ? ' '.repeat(minSpaces) : '    ';
}

function firstLine(block: string): string {
    return block.split('\n').find(l => l.trim() !== '')?.trim() ?? '(empty)';
}

// ---- diagnostics ------------------------------------------------------------

async function monitoredUris(edited: vscode.Uri[], sessionFiles: string[]): Promise<vscode.Uri[]> {
    const map = new Map<string, vscode.Uri>();
    for (const uri of edited) map.set(uri.toString(), uri);
    for (const path of sessionFiles) {
        const uri = await resolveFile(path);
        if (uri) map.set(uri.toString(), uri);
    }
    return [...map.values()];
}

type ErrorSet = Map<string, Set<string>>;

function snapshotErrors(uris: vscode.Uri[]): ErrorSet {
    const snapshot: ErrorSet = new Map();
    for (const uri of uris) {
        const keys = new Set<string>();
        for (const diag of vscode.languages.getDiagnostics(uri)) {
            if (diag.severity === vscode.DiagnosticSeverity.Error) {
                keys.add(`${diag.range.start.line}:${diag.message}`);
            }
        }
        snapshot.set(uri.toString(), keys);
    }
    return snapshot;
}

interface NewError {
    uri: vscode.Uri;
    line: number;
    message: string;
}

function diffErrors(before: ErrorSet, after: ErrorSet): NewError[] {
    const errors: NewError[] = [];
    for (const [key, keys] of after) {
        const prior = before.get(key) ?? new Set<string>();
        const uri = vscode.Uri.parse(key);
        for (const diag of vscode.languages.getDiagnostics(uri)) {
            if (diag.severity !== vscode.DiagnosticSeverity.Error) continue;
            const diagKey = `${diag.range.start.line}:${diag.message}`;
            if (keys.has(diagKey) && !prior.has(diagKey)) {
                errors.push({ uri, line: diag.range.start.line + 1, message: diag.message });
            }
        }
    }
    return errors;
}

function waitForDiagnostics(): Promise<void> {
    return new Promise(resolve => {
        const finish = () => {
            clearTimeout(quiet);
            clearTimeout(max);
            sub.dispose();
            resolve();
        };
        let quiet = setTimeout(finish, DIAG_QUIET_MS);
        const max = setTimeout(finish, DIAG_MAX_WAIT_MS);
        const sub = vscode.languages.onDidChangeDiagnostics(() => {
            clearTimeout(quiet);
            quiet = setTimeout(finish, DIAG_QUIET_MS);
        });
    });
}

async function buildReport(failures: EditFailure[], newErrors: NewError[]): Promise<string | undefined> {
    if (failures.length === 0 && newErrors.length === 0) return undefined;
    const parts: string[] = [];
    if (failures.length > 0) {
        parts.push('EDIT FAILURES:');
        for (const f of failures) parts.push(`- ${f.path}: ${f.reason}`);
    }
    if (newErrors.length > 0) {
        parts.push('NEW LINT ERRORS:');
        for (const e of newErrors) {
            parts.push(`- ${vscode.workspace.asRelativePath(e.uri)}:${e.line}: ${e.message}`);
        }
    }

    const missingFiles = new Set<vscode.Uri>();
    for (const f of failures) {
        if (f.uri && f.reason.includes('search block')) {
            missingFiles.add(f.uri);
        }
    }

    if (missingFiles.size > 0) {
        parts.push('\nAttaching current contents of files with failed edits:');
        for (const uri of missingFiles) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                parts.push(fileBlock(vscode.workspace.asRelativePath(uri), doc.getText()));
            } catch (e) {
                console.error('Failed to read document for report', e);
            }
        }
    }

    return parts.join('\n');
}
