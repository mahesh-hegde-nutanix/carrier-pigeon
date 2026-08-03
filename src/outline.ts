import * as vscode from 'vscode';
import { filterIgnored } from './settings';
import { resolveWorkspacePath, toFolderRelative } from './context';

// Symbol kinds worth descending into. Function/method bodies are intentionally
// excluded so their local variables never bloat the outline.
const CONTAINER_KINDS = new Set<vscode.SymbolKind>([
    vscode.SymbolKind.Namespace,
    vscode.SymbolKind.Module,
    vscode.SymbolKind.Package,
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Struct,
    vscode.SymbolKind.Enum
]);

const MAX_DEPTH = 3;
const MAX_FILES = 200;
const NO_OUTLINE = '  (Symbol outline not available)';

/** Renders a compact symbol outline for each file under the given paths. */
export async function readOutline(paths: string[]): Promise<string> {
    const sections: string[] = [];
    for (const path of paths) {
        const uris = (await resolveFiles(path)).sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        if (uris.length === 0) {
            sections.push(`# ${path}\n  (no files found)`);
            continue;
        }
        sections.push(`# ${path}`);
        const shown = uris.slice(0, MAX_FILES);
        for (const uri of shown) {
            sections.push(await fileOutline(uri));
        }
        if (uris.length > shown.length) {
            sections.push(`  (${uris.length - shown.length} more files omitted)`);
        }
    }
    return sections.join('\n\n');
}

/** Resolves a path (file, directory, or glob) to matching file URIs. */
async function resolveFiles(path: string): Promise<vscode.Uri[]> {
    const uri = resolveWorkspacePath(path);
    if (uri) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type !== vscode.FileType.Directory) {
                return filterIgnored([uri]);
            }
        } catch {
            // Not a plain file (e.g. a glob pattern); fall through to search.
        }
    }

    const relPath = toFolderRelative(path);
    const direct = await vscode.workspace.findFiles(relPath, null);
    if (direct.length > 0) return filterIgnored(direct);
    
    const clean = relPath.replace(/\/+$/, '');
    const glob = clean ? `${clean}/**` : '**';
    return filterIgnored(await vscode.workspace.findFiles(glob, null));
}

async function fileOutline(uri: vscode.Uri): Promise<string> {
    const rel = vscode.workspace.asRelativePath(uri);
    let symbols: vscode.DocumentSymbol[] | undefined;
    try {
        symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            uri
        );
    } catch (e) {
        console.error(`[Outline] symbol provider failed for ${rel}:`, e);
    }
    // Fall back to just the file entry (the tree from this point) when the LSP
    // yields nothing or errors out.
    if (!symbols || symbols.length === 0) {
        return `${rel}\n${NO_OUTLINE}`;
    }
    const lines = [rel];
    renderSymbols(symbols, 0, lines);
    return lines.join('\n');
}

function renderSymbols(symbols: vscode.DocumentSymbol[], depth: number, lines: string[]): void {
    if (depth > MAX_DEPTH) return;
    const sorted = [...symbols].sort((a, b) => a.range.start.line - b.range.start.line);
    for (const sym of sorted) {
        // Locals nested inside declarations are noise; keep package-level
        // variables/constants (depth 0) only.
        if (depth > 0 && (sym.kind === vscode.SymbolKind.Variable || sym.kind === vscode.SymbolKind.Constant)) {
            continue;
        }
        const indent = '  '.repeat(depth + 1);
        const start = sym.range.start.line + 1;
        const end = sym.range.end.line + 1;
        lines.push(`${indent}${sym.name} (${kindName(sym.kind)}) L${start}-${end}`);
        if (CONTAINER_KINDS.has(sym.kind) && sym.children.length > 0) {
            renderSymbols(sym.children, depth + 1, lines);
        }
    }
}

const KIND_NAMES: Record<number, string> = {
    [vscode.SymbolKind.File]: 'file',
    [vscode.SymbolKind.Module]: 'module',
    [vscode.SymbolKind.Namespace]: 'namespace',
    [vscode.SymbolKind.Package]: 'package',
    [vscode.SymbolKind.Class]: 'class',
    [vscode.SymbolKind.Method]: 'method',
    [vscode.SymbolKind.Property]: 'property',
    [vscode.SymbolKind.Field]: 'field',
    [vscode.SymbolKind.Constructor]: 'constructor',
    [vscode.SymbolKind.Enum]: 'enum',
    [vscode.SymbolKind.Interface]: 'interface',
    [vscode.SymbolKind.Function]: 'function',
    [vscode.SymbolKind.Variable]: 'variable',
    [vscode.SymbolKind.Constant]: 'constant',
    [vscode.SymbolKind.Struct]: 'struct',
    [vscode.SymbolKind.EnumMember]: 'enum-member',
    [vscode.SymbolKind.TypeParameter]: 'type-param'
};

function kindName(kind: vscode.SymbolKind): string {
    return KIND_NAMES[kind] ?? 'symbol';
}
