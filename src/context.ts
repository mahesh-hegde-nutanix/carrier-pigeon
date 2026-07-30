import * as vscode from 'vscode';
import { ChatMode } from '../shared/session';
import { logTiming, timed } from './timing';

const SYSTEM_PROMPT_BEGIN = `
You're an expert software engineering assistant over a chat UI.

You need to help me to work with a codebase consisting of one or more repositories.
`;

const SYSTEM_PROMPT_END = `
Be terse, efficient and to the point. User attention is valuable and scarce. Do not write walls of text because nobody will read it.

Follow the coding style guidelines in the Rules files which are added later in this file.

__If in doubt, always ask the user.__
Before making any change which would be un-idiomatic and can have long-reaching effects, take a verbal confirmation from the user.
Highlight the question line in bold and mention the possible choices if applicable.

Git repository roots in the file trees will be marked '[GIT]'.
gitignored files will not be shown by the trees - use find/ls if you must.
`;

const EDIT_MODE_PROMPT = `
Write concise and robust code. Consider all edge cases.
If you are unsure about some symbols, ask to read them first.

### File writes and updates

To update a file, provide a search-replace diff inside markdown code block.

`+ "```" + `
>>> SEARCH file_path_or_name
existing code
===
new code
<<< REPLACE
`+ "```" + `

File update is a special tool which takes this format. 
Other tools are to be called in JSON format wrapped in code blocks. They are described later.
`;

const ASK_MODE_PROMPT = `Explore the codebase using provided tools and answer the user's questions in a brief and practical manner`;

const TOOL_DESCRIPTIONS = `

### Other tools

All the other tools follow the standard JSON-in-code-block format. Each tool call must be on its own line. You can make multiple tool calls in a single codeblock by writing one call per line (like JSONL / NDJSON).

* read_files
Read one or more files into the context. It can contain globs.
Example:

` + "```" + `
{"tool": "read_files", "files": ["path/*.go", "main.go"]}
` + "```" + `

Any number of tool calls be made in a code block for conciseness. Each tool call should go on its own line.

---

* read_outline
Read the symbol outline of all files in a path. Use it with whole packages to understand their layout.
Example:

` + "```" + `
{"tool": "read_outline", "paths": ["my/repo/package"]}
` + "```" + `

---

* run_cmd
Runs a command in shell, returns both stdout and stderr. Assume a Linux environment with standard tools.

Example:
` + "```" + `
{"tool": "run_cmd", "command": "grep -rn -A 2 'Upload.*Registry'; find -name *registry*"}
` + "```" + `

---
`

const RULE_FILE_NAMES = ['.cursorrules', 'AGENTS.md', 'CONTEXT.md', 'PIGEON.md'];

// Rendered workspace tree is trimmed to fit this budget, but never shallower
// than TREE_MIN_DEPTH so nested structure stays visible.
const TREE_MAX_CHARS = 16000;
const TREE_MAX_DEPTH = 12;
const TREE_MIN_DEPTH = 2;

export interface ContextRequest {
    text: string;
    files: string[];
    isInitial: boolean;
    mode: ChatMode;
}

/** Caches the rule-files context per workspace, invalidating on file changes. */
export class RuleFilesCache implements vscode.Disposable {
    private cached: string | undefined;
    private readonly watcher: vscode.FileSystemWatcher;

    constructor() {
        this.watcher = vscode.workspace.createFileSystemWatcher(
            `**/{${RULE_FILE_NAMES.join(',')}}`
        );
        const invalidate = () => { this.cached = undefined; };
        this.watcher.onDidCreate(invalidate);
        this.watcher.onDidChange(invalidate);
        this.watcher.onDidDelete(invalidate);
    }

    async get(): Promise<string> {
        if (this.cached === undefined) {
            this.cached = await getRuleFilesContext();
        }
        return this.cached;
    }

    dispose(): void {
        this.watcher.dispose();
    }
}

/**
 * Caches the workspace file listing. The list only changes on create/delete
 * (a rename is a delete + create), so content edits do not invalidate it.
 */
export class WorkspaceFilesCache implements vscode.Disposable {
    private cached: Thenable<vscode.Uri[]> | undefined;
    private readonly watcher: vscode.FileSystemWatcher;

    constructor() {
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
        const invalidate = (uri: vscode.Uri) => {
            this.cached = undefined;
            console.log(`[CarrierPigeon] workspace files cache invalidated by: ${uri.fsPath}`);
        };
        this.watcher.onDidCreate(invalidate);
        this.watcher.onDidDelete(invalidate);
    }

    get(): Thenable<vscode.Uri[]> {
        if (this.cached === undefined) {
            // Passing null for exclude respects .gitignore. The promise is
            // cached so concurrent callers share a single scan.
            this.cached = vscode.workspace.findFiles('**/*', null);
        }
        return this.cached;
    }

    dispose(): void {
        this.watcher.dispose();
    }
}

/** Per-workspace caches shared across context builds. */
export interface ContextCaches {
    rules: RuleFilesCache;
    files: WorkspaceFilesCache;
}

interface GitRepository {
    rootUri: vscode.Uri;
}

interface GitAPI {
    repositories: GitRepository[];
}

interface GitExtensionExports {
    getAPI(version: 1): GitAPI;
}

/** Git repository roots expressed as workspace tree paths. */
interface GitRoots {
    // Relative directory paths that carry a [GIT] marker in the tree.
    dirs: Set<string>;
    // True when a workspace folder root is itself a repository (no tree node).
    rootIsRepo: boolean;
}

/**
 * Locates git repository roots via the built-in git extension and maps them to
 * the same relative paths used to build the workspace tree.
 */
async function getGitRoots(): Promise<GitRoots> {
    const roots: GitRoots = { dirs: new Set(), rootIsRepo: false };
    const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!ext) return roots;
    try {
        const git = (await ext.activate()).getAPI(1);
        for (const repo of git.repositories) {
            const rel = vscode.workspace.asRelativePath(repo.rootUri);
            if (rel === '' || rel.startsWith('/')) {
                roots.rootIsRepo = true;
            } else {
                roots.dirs.add(rel);
            }
        }
    } catch (e) {
        console.error('[GitRoots] Failed to read git repositories:', e);
    }
    return roots;
}

/** Builds the full clipboard payload for a copy-context request. */
export async function buildContextPayload(
    req: ContextRequest,
    caches: ContextCaches
): Promise<string> {
    const start = Date.now();
    const buffer: string[] = [];

    if (req.isInitial) {
        buffer.push(`## Instructions\n${systemPrompt(req.mode)}\n`);
        buffer.push(`## Task\n${req.text}\n`);

        try {
            const uris = await timed('files.scan', () => caches.files.get());
            const gitRoots = await getGitRoots();
            buffer.push(`## Workspace Tree\n\`\`\`\n${getWorkspaceTreeString(uris, gitRoots)}\`\`\`\n`);
        } catch (treeErr) {
            console.error('[Webview] Error generating workspace tree for context:', treeErr);
            buffer.push(`## Workspace Tree\n(Error generating tree)\n`);
        }

        try {
            const rulesContext = await caches.rules.get();
            if (rulesContext) buffer.push(`## Rule Files\n${rulesContext}\n`);
        } catch (rulesErr) {
            console.error('[Webview] Error fetching rule files for context:', rulesErr);
        }
    } else {
        buffer.push(`## Task\n${req.text}\n`);
    }

    try {
        const filesContext = await getFilesContext(req.files);
        if (filesContext) buffer.push(`## Referenced Files\n${filesContext}\n`);
    } catch (filesErr) {
        console.error('[Webview] Error fetching mentioned files for context:', filesErr);
    }

    logTiming(`buildContextPayload (initial=${req.isInitial})`, start);
    return buffer.join('\n');
}

function systemPrompt(mode: ChatMode): string {
    const modeSpecific = mode === 'edit' ? EDIT_MODE_PROMPT : ASK_MODE_PROMPT;
    return `${SYSTEM_PROMPT_BEGIN}\n\n${modeSpecific}\n\n${SYSTEM_PROMPT_END}\n\n${TOOL_DESCRIPTIONS}`;
}

interface FileTree {
    [name: string]: FileTree | null;
}

/** Renders an ascii tree from a workspace file listing, marking git roots. */
function getWorkspaceTreeString(uris: vscode.Uri[], gitRoots: GitRoots): string {
    try {
        console.log(`[CarrierPigeon][timing] tree.fileCount: ${uris.length}`);
        const renderStart = Date.now();
        const tree: FileTree = {};

        for (const uri of uris) {
            const parts = vscode.workspace.asRelativePath(uri).split('/');
            let curr = tree;
            parts.forEach((part, i) => {
                if (i === parts.length - 1) {
                    curr[part] = null;
                } else {
                    curr[part] = (curr[part] as FileTree) || {};
                    curr = curr[part] as FileTree;
                }
            });
        }

        // Shrink the depth until the rendered tree fits the char budget, but
        // keep at least TREE_MIN_DEPTH levels so nesting stays visible even in
        // large repos (a smaller budget previously collapsed this to one level).
        let depth = TREE_MAX_DEPTH;
        let result = printTree(tree, '', 0, depth, '', gitRoots.dirs);
        while (result.length > TREE_MAX_CHARS && depth > TREE_MIN_DEPTH) {
            depth--;
            result = printTree(tree, '', 0, depth, '', gitRoots.dirs);
        }
        // A workspace-folder root that is itself a repository has no tree node,
        // so surface it as an explicit root line.
        if (gitRoots.rootIsRepo) result = '. [GIT]\n' + result;
        logTiming('tree.render', renderStart);
        return result;
    } catch (e) {
        console.error('[TreeBuilder] Error generating workspace tree:', e);
        return 'Error generating workspace tree.';
    }
}

function printTree(
    node: FileTree,
    prefix: string,
    depth: number,
    maxDepth: number,
    currentPath: string,
    gitRoots: Set<string>
): string {
    if (depth > maxDepth) return '';
    let result = '';
    const keys = Object.keys(node).sort();

    keys.forEach((key, i) => {
        const isLast = i === keys.length - 1;
        const marker = isLast ? '└── ' : '├── ';
        const isDir = node[key] !== null;
        const nextPath = currentPath ? `${currentPath}/${key}` : key;
        // Directories show their full relative path; files show only their name.
        let display = isDir ? nextPath : key;
        if (isDir && gitRoots.has(nextPath)) display += ' [GIT]';

        result += prefix + marker + display + '\n';

        if (isDir) {
            const nextPrefix = prefix + (isLast ? '    ' : '│   ');
            result += printTree(node[key] as FileTree, nextPrefix, depth + 1, maxDepth, nextPath, gitRoots);
        }
    });
    return result;
}

async function getRuleFilesContext(): Promise<string> {
    try {
        const globs: string[] = [];
        // String concatenation avoids `/*` breaking syntax highlighting.
        RULE_FILE_NAMES.forEach(p => {
            globs.push(p);
            globs.push('*/' + p);
            globs.push('*/*/' + p);
        });

        const uris = await timed('rules.findFiles', () =>
            vscode.workspace.findFiles(`{${globs.join(',')}}`, null)
        );
        const buffer: string[] = [];

        const readStart = Date.now();
        for (const uri of uris) {
            try {
                const content = await readFileText(uri);
                const relPath = vscode.workspace.asRelativePath(uri);
                buffer.push(fileBlock(relPath, content));
            } catch (e) {
                console.error(`[RuleFiles] Failed to read rule file: ${uri.fsPath}`, e);
            }
        }
        logTiming(`rules.read (${uris.length} files)`, readStart);
        return buffer.join('\n');
    } catch (e) {
        console.error('[RuleFiles] Failed to get rule files context:', e);
        return '';
    }
}

async function getFilesContext(filePaths: string[]): Promise<string> {
    const start = Date.now();
    const buffer: string[] = [];
    let searched = 0;
    for (const filePath of filePaths) {
        try {
            const content = await readMentionedFile(filePath);
            if (content !== undefined) {
                if (content.searched) searched++;
                buffer.push(fileBlock(filePath, content.text));
            } else {
                console.warn(`[FilesContext] Could not resolve file path: ${filePath}`);
            }
        } catch (e) {
            console.error(`[FilesContext] Failed to read file context for: ${filePath}`, e);
        }
    }
    logTiming(`mentionedFiles (${filePaths.length} files, ${searched} searched)`, start);
    return buffer.join('\n');
}

interface MentionedFileContent {
    text: string;
    // Whether we had to fall back to a workspace search (the slow path).
    searched: boolean;
}

/**
 * Reads a workspace-relative mentioned file. Resolves the path against the
 * workspace folders directly (fast); only falls back to a search if that misses
 * (e.g. multi-root paths that include the folder name).
 */
async function readMentionedFile(relPath: string): Promise<MentionedFileContent | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
            const text = await readFileText(vscode.Uri.joinPath(folder.uri, relPath));
            return { text, searched: false };
        } catch {
            // Not under this folder; try the next one.
        }
    }

    const uris = await vscode.workspace.findFiles(relPath, undefined, 1);
    if (uris.length === 0) return undefined;
    return { text: await readFileText(uris[0]), searched: true };
}

export function fileBlock(relPath: string, content: string): string {
    return [
        `\n------------------- begins: ${relPath} ---------------------`,
        content,
        `------------------- ends: ${relPath} -----------------\n`
    ].join('\n');
}

export async function readFileText(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
}
