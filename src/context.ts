import * as vscode from 'vscode';
import { ChatMode } from '../shared/session';
import { filterIgnored, getSettings } from './settings';
import { logTiming, timed } from './timing';
import { SkillRegistry } from './skills';
import * as cp from 'child_process';
import * as util from 'util';

const execFileAsync = util.promisify(cp.execFile);

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
In a multi-repo workspace, individual repo roots are marked '[repo]'; a '[repo]' name may be passed as the run_cmd 'repo' parameter.
gitignored files will not be shown by the trees - use find/ls if you must.

Reminder: these files / repos are not on your system. The user is communicating via a chat.

Provide the tool calls in format described so that the user can execute them and relay the results.
`;

const EDIT_MODE_PROMPT = `
Write concise and robust code. Consider all edge cases.

If you are unsure about some symbols, ask to read them first.

If the user clearly didn't ask to write code, then just answer the user's question at the end. 
No need to produce edits in that case.

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

* read_skill
Reads a skill's main page and its references tree. Pass a non-empty "references" array to read those specific reference files instead of the tree.
Use the skill and reference names exactly as listed; skill storage paths are not exposed.
Example:

` + "```" + `
{"tool": "read_skill", "skill": "skill-name"}
{"tool": "read_skill", "skill": "skill-name", "references": ["topic.md"]}
` + "```" + `

---

* run_cmd
Runs a command in shell, returns both stdout and stderr. Assume a Linux environment with standard tools.
By default the command runs from the workspace root, so use the same folder-prefixed paths shown in the tree.
Optionally set "repo" to a '[repo]' name to run from that repo's root; paths are then relative to that repo.

Example:
` + "```" + `
{"tool": "run_cmd", "command": "grep -rn -A 2 'Upload.*Registry'; find -name *registry*"}
{"tool": "run_cmd", "command": "go build ./...", "repo": "pigeon"}
` + "```" + `

---
`

const RULE_FILE_NAMES = ['.cursorrules', 'AGENTS.md', 'CONTEXT.md', 'PIGEON.md'];

// Rendered workspace tree is trimmed to fit the configured char budget, but
// never shallower than TREE_MIN_DEPTH so nested structure stays visible.
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
    private readonly ignoreWatcher: vscode.FileSystemWatcher;

    constructor() {
        const invalidate = (uri: vscode.Uri) => {
            this.cached = undefined;
            console.log(`[CarrierPigeon] workspace files cache invalidated by: ${uri.fsPath}`);
        };
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
        this.watcher.onDidCreate(invalidate);
        this.watcher.onDidDelete(invalidate);
        // A .gitignore edit changes which files are hidden without any
        // create/delete, so invalidate on its content changes too.
        this.ignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
        this.ignoreWatcher.onDidChange(invalidate);
    }

    /** Returns the scanned files with the configured ignore patterns applied.
     * The git-filtered scan is cached; the regex ignore filter runs live so
     * setting changes take effect without invalidation. */
    async get(): Promise<vscode.Uri[]> {
        if (this.cached === undefined) {
            this.cached = scanWorkspaceFiles();
        }
        return filterIgnored(await this.cached);
    }

    dispose(): void {
        this.watcher.dispose();
        this.ignoreWatcher.dispose();
    }
}

/**
 * Scans the workspace and drops git-ignored files. Uses native git ls-files for speed
 * where available, falling back to VS Code's findFiles.
 */
async function scanWorkspaceFiles(): Promise<vscode.Uri[]> {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) return [];

    const uris: vscode.Uri[] = [];

    for (const folder of folders) {
        let usedGit = false;
        try {
            // -z ensures null-separated output for safe path parsing (spaces/quotes)
            const { stdout } = await execFileAsync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
                cwd: folder.uri.fsPath,
                maxBuffer: 1024 * 1024 * 50 // 50MB limit
            });
            const files = stdout.split('\0').filter(Boolean);
            for (const file of files) {
                uris.push(vscode.Uri.joinPath(folder.uri, file));
            }
            usedGit = true;
        } catch (e) {
            console.warn(`[Git] ls-files not available for ${folder.name}, falling back to findFiles`);
        }

        if (!usedGit) {
            const pattern = new vscode.RelativePattern(folder, '**/*');
            const fallbackUris = await vscode.workspace.findFiles(pattern, undefined);
            uris.push(...fallbackUris);
        }
    }
    return uris;
}

/** Per-workspace caches shared across context builds. */
export interface ContextCaches {
    rules: RuleFilesCache;
    files: WorkspaceFilesCache;
    skills: SkillRegistry;
}

interface GitRepository {
    rootUri: vscode.Uri;
    checkIgnore(paths: string[]): Promise<Set<string>>;
}

interface GitAPI {
    repositories: GitRepository[];
    getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtensionExports {
    getAPI(version: 1): GitAPI;
}

/** Returns the built-in git extension's API, or undefined when it is
 * unavailable (extension missing or failed to activate). */
async function getGitApi(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!ext) return undefined;
    try {
        return (await ext.activate()).getAPI(1);
    } catch (e) {
        console.error('[Git] Failed to activate git extension:', e);
        return undefined;
    }
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
    const git = await getGitApi();
    if (!git) return roots;
    try {
        const singleRoot = (vscode.workspace.workspaceFolders ?? []).length === 1;
        for (const repo of git.repositories) {
            const folder = vscode.workspace.getWorkspaceFolder(repo.rootUri);
            // Skip repos outside the workspace (e.g. an enclosing parent repo).
            if (!folder) continue;
            if (repo.rootUri.toString() === folder.uri.toString()) {
                // The repo root is a workspace folder root: it's the tree root in
                // single-root, or a top-level node (named by folder) in multi-root.
                if (singleRoot) roots.rootIsRepo = true;
                else roots.dirs.add(folder.name);
            } else {
                roots.dirs.add(vscode.workspace.asRelativePath(repo.rootUri));
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

    buffer.push(`${req.text}\n`);

    if (req.isInitial) {
        buffer.push(`## Instructions\n${systemPrompt(req.mode, caches.skills)}\n`);

        try {
            const uris = await timed('files.scan', () => caches.files.get());
            const gitRoots = await getGitRoots();
            const tree = getWorkspaceTreeString(uris, gitRoots, repoDirs(), getSettings().maxTreeBytes, req.files);
            buffer.push(`## Workspace Tree\n\`\`\`\n${tree}\`\`\`\n`);
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
    }

    try {
        const skillsContext = await caches.skills.contextForInvocations(req.text);
        if (skillsContext) buffer.push(`## Skill Rules\n${skillsContext}\n`);
    } catch (skillsErr) {
        console.error('[Webview] Error fetching skill files for context:', skillsErr);
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

function systemPrompt(mode: ChatMode, skills: SkillRegistry): string {
    const modeSpecific = mode === 'edit' ? EDIT_MODE_PROMPT : ASK_MODE_PROMPT;
    const custom = getSettings().customInstructions.trim();
    const customBlock = custom ? `${custom}\n\n` : '';
    return `${SYSTEM_PROMPT_BEGIN}\n\n${modeSpecific}\n\n${SYSTEM_PROMPT_END}\n\n${customBlock}${TOOL_DESCRIPTIONS}${skillsPrompt(skills)}`;
}

function skillsPrompt(skills: SkillRegistry): string {
    const available = skills.implicitSummaries();
    if (available.length === 0) return '';
    const entries = available.map(skill => `- ${skill.name} (${skill.description})`).join('\n');
    return `
Skills contain proprietary knowledge bases and workflows. Use the read_skill tool to read a skill's main page. Utilize read_skill with a list of references to drill down into more specific references. Following skills are available.

${entries}
`;
}

interface FileTree {
    [name: string]: FileTree | null;
}

/**
 * Workspace-folder names that appear as top-level tree nodes, marked '[repo]'.
 * Only meaningful in multi-root workspaces where asRelativePath prefixes them.
 */
function repoDirs(): Set<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) return new Set();
    return new Set(folders.map(f => f.name));
}

/** Renders an ascii tree from a workspace file listing, marking git and repo roots. */
function getWorkspaceTreeString(uris: vscode.Uri[], gitRoots: GitRoots, repos: Set<string>, maxChars: number, mentionedFiles: string[] = []): string {
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

        let activeTopLevel: string | undefined;
        if (mentionedFiles.length > 0) {
            const topLevels = new Set(mentionedFiles.map(f => f.split('/')[0]));
            if (topLevels.size === 1) {
                activeTopLevel = [...topLevels][0];
            }
        }

        // Shrink the depth until the rendered tree fits the char budget, but
        // keep at least TREE_MIN_DEPTH levels so nesting stays visible even in
        // large repos (a smaller budget previously collapsed this to one level).
        let depth = TREE_MAX_DEPTH;
        let result = printTree(tree, '', 0, depth, '', gitRoots.dirs, repos, activeTopLevel);
        while (result.length > maxChars && depth > TREE_MIN_DEPTH) {
            depth--;
            result = printTree(tree, '', 0, depth, '', gitRoots.dirs, repos, activeTopLevel);
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
    gitRoots: Set<string>,
    repos: Set<string>,
    activeTopLevel?: string
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
        if (isDir && repos.has(nextPath)) display += ' [repo]';

        result += prefix + marker + display + '\n';

        if (isDir) {
            const nextPrefix = prefix + (isLast ? '    ' : '│   ');
            let branchMaxDepth = maxDepth;
            if (depth === 0 && activeTopLevel && key !== activeTopLevel) {
                branchMaxDepth = 0;
            }
            result += printTree(node[key] as FileTree, nextPrefix, depth + 1, branchMaxDepth, nextPath, gitRoots, repos, activeTopLevel);
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
            vscode.workspace.findFiles(`{${globs.join(',')}}`, undefined)
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
            // Remove trailing slash if present for resolution
            const cleanPath = filePath.endsWith('/') ? filePath.slice(0, -1) : filePath;
            const uri = resolveWorkspacePath(cleanPath);
            let isDir = false;
            
            if (uri) {
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    if (stat.type === vscode.FileType.Directory) {
                        isDir = true;
                    }
                } catch { }
            }

            if (isDir && uri) {
                const pattern = new vscode.RelativePattern(uri, '**/*');
                const uris = await vscode.workspace.findFiles(pattern, undefined);
                const treeStr = getWorkspaceTreeString(uris, { dirs: new Set(), rootIsRepo: false }, new Set(), getSettings().maxTreeBytes);
                buffer.push(fileBlock(cleanPath + ' (Tree)', treeStr));
            } else {
                const content = await readMentionedFile(cleanPath);
                if (content !== undefined) {
                    if (content.searched) searched++;
                    buffer.push(fileBlock(cleanPath, content.text));
                } else {
                    console.warn(`[FilesContext] Could not resolve file path: ${cleanPath}`);
                }
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
 * Reads a workspace-relative mentioned file. Resolves the path directly against
 * a workspace folder (fast); only falls back to a search if that misses.
 */
async function readMentionedFile(relPath: string): Promise<MentionedFileContent | undefined> {
    const uri = resolveWorkspacePath(relPath);
    if (uri) {
        try {
            return { text: await readFileText(uri), searched: false };
        } catch {
            // Resolved by name but unreadable; fall through to a search.
        }
    }

    const uris = await vscode.workspace.findFiles(toFolderRelative(relPath), null, 1);
    if (uris.length === 0) return undefined;
    return { text: await readFileText(uris[0]), searched: true };
}

/**
 * Base directory for running commands: the directory holding the
 * .code-workspace file (so folder-prefixed tree paths resolve), else the
 * single folder root, else the first folder as a fallback.
 */
export function workspaceBaseUri(): vscode.Uri | undefined {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile && workspaceFile.scheme === 'file') {
        return vscode.Uri.joinPath(workspaceFile, '..');
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Resolves a workspace folder name (a '[repo]' marker) to its root uri. */
export function resolveRepoUri(name: string): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.find(f => f.name === name)?.uri;
}

/**
 * Resolves a workspace-relative path (as produced by asRelativePath, which
 * prepends the folder name in multi-root workspaces) to a concrete uri.
 * Returns undefined when the path matches no workspace folder.
 */
export function resolveWorkspacePath(relPath: string): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
        if (relPath === folder.name) return folder.uri;
        if (relPath.startsWith(folder.name + '/')) {
            return vscode.Uri.joinPath(folder.uri, relPath.slice(folder.name.length + 1));
        }
    }
    // Single-root paths carry no folder-name prefix.
    if (folders.length === 1) return vscode.Uri.joinPath(folders[0].uri, relPath);
    return undefined;
}

/**
 * Strips the multi-root folder-name prefix from a path, yielding a
 * folder-root-relative glob suitable for findFiles (which matches include
 * patterns relative to each workspace folder).
 */
export function toFolderRelative(relPath: string): string {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (relPath === folder.name) return '';
        if (relPath.startsWith(folder.name + '/')) return relPath.slice(folder.name.length + 1);
    }
    return relPath;
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
