import * as vscode from 'vscode';
import { resolveWorkspacePath } from './context';
import { getSettings } from './settings';

interface GraphNode {
    item: vscode.CallHierarchyItem;
    incoming: GraphNode[];
    outgoing: GraphNode[];
}

interface TypeNode {
    item: vscode.TypeHierarchyItem;
    subtypes: TypeNode[];
    methods: string[];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function generateCallGraphContext(text: string, files: string[], maxDepth = 1): Promise<string> {
    const timeoutMs = getSettings().callGraphTimeoutMs;
    // Enforce configurable timeout ceiling to ensure context compilation doesn't lock up
    return await Promise.race([
        buildGraph(text, files, maxDepth),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`Graph generation timed out after ${timeoutMs / 1000} seconds`)), timeoutMs))
    ]);
}

async function buildGraph(text: string, files: string[], maxDepth: number): Promise<string> {
    const seeds: vscode.CallHierarchyItem[] = [];
    const typeSeeds: vscode.TypeHierarchyItem[] = [];
    const docSymbolCache = new Map<string, vscode.DocumentSymbol[]>();
    let hasExplicitTargets = false;

    for (const file of files) {
        const uri = resolveWorkspacePath(file);
        if (!uri) continue;

        const explicitSymbols = new Set<string>();
        let match;

        // Parse exact position mentions `#path:line:char (SymbolName)`
        const exactPositions: vscode.Position[] = [];
        const posRegex = new RegExp(`#${escapeRegExp(file)}:(\\d+):(\\d+)\\s*\\(((?:[^)(]+|\\([^)(]*\\))+)\\)`, 'g');
        while ((match = posRegex.exec(text)) !== null) {
            exactPositions.push(new vscode.Position(parseInt(match[1], 10) - 1, parseInt(match[2], 10) - 1));
            explicitSymbols.add(match[3]);
            hasExplicitTargets = true;
        }

        for (const pos of exactPositions) {
            try {
                const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, pos);
                if (items && items.length > 0) {
                    seeds.push(...items);
                }
            } catch { }
            try {
                const typeItems = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.prepareTypeHierarchy', uri, pos);
                if (typeItems && typeItems.length > 0) {
                    typeSeeds.push(...typeItems);
                }
            } catch { }
        }

        let docSymbols: vscode.DocumentSymbol[] | undefined;
        try {
            docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
            if (docSymbols) {
                docSymbolCache.set(uri.toString(), docSymbols);
            }
        } catch {
            // Ignore missing LSP support
        }
        if (!docSymbols) continue;

        const targetSymbols: vscode.DocumentSymbol[] = [];
        const queue = [...docSymbols];
        
        while(queue.length > 0) {
            const sym = queue.shift()!;
            if (explicitSymbols.size > 0) {
                if (explicitSymbols.has(sym.name)) targetSymbols.push(sym);
            } else {
                if ([
                    vscode.SymbolKind.Function,
                    vscode.SymbolKind.Method,
                    vscode.SymbolKind.Constructor,
                    vscode.SymbolKind.Class,
                    vscode.SymbolKind.Interface,
                    vscode.SymbolKind.Struct
                ].includes(sym.kind)) {
                    targetSymbols.push(sym);
                }
            }
            // We might need to dig into child scopes to find symbols
            if (sym.children) {
                queue.push(...sym.children);
            }
        }

        for (const sym of targetSymbols) {
            const range = (sym as any).selectionRange || (sym as any).range || (sym as any).location?.range;
            if (!range) continue;

            try {
                const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, range.start);
                if (items && items.length > 0) {
                    seeds.push(...items);
                }
            } catch {
                // Ignore missing support on specific nodes
            }

            try {
                if ([vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct].includes(sym.kind)) {
                    const typeItems = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.prepareTypeHierarchy', uri, range.start);
                    if (typeItems && typeItems.length > 0) {
                        typeSeeds.push(...typeItems);
                    }
                }
            } catch {
                // Ignore missing support on specific nodes
            }
        }
    }

    if (seeds.length === 0 && typeSeeds.length === 0) {
        console.warn('[CallGraph] No supported symbols found to seed the call graph.');
        return '';
    }

    const visited = new Set<string>();
    const graph: GraphNode[] = [];
    
    // Process seeds
    for (const seed of seeds) {
        graph.push(await traverse(seed, 0, maxDepth, visited));
    }

    const typeVisited = new Set<string>();
    const typeGraph: TypeNode[] = [];
    for (const tSeed of typeSeeds) {
        typeGraph.push(await traverseType(tSeed, 0, maxDepth, typeVisited, docSymbolCache));
    }

    // Skip output if nothing has callers or callees
    let hasConnections = hasExplicitTargets;

    if (!hasConnections) {
        const checkConnections = (nodes: GraphNode[]) => {
            for (const n of nodes) {
                if (n.incoming.length > 0 || n.outgoing.length > 0) {
                    hasConnections = true;
                    return;
                }
            }
        };
        checkConnections(graph);

        const checkTypeConnections = (nodes: TypeNode[]) => {
            for (const n of nodes) {
                if (n.subtypes.length > 0 || n.methods.length > 0) {
                    hasConnections = true;
                    return;
                }
            }
        };
        checkTypeConnections(typeGraph);
    }

    if (!hasConnections) {
        console.log('[CallGraph] Graph generation yielded empty result (no connections).');
        return '';
    }

    let result = '';
    graph.forEach((node, idx) => {
        result += renderNode(node, '', idx === graph.length - 1 && typeGraph.length === 0, true);
    });

    typeGraph.forEach((node, idx) => {
        result += renderTypeNode(node, '', idx === typeGraph.length - 1, true);
    });

    return result.trimEnd();
}

async function traverse(item: vscode.CallHierarchyItem, depth: number, maxDepth: number, visited: Set<string>): Promise<GraphNode> {
    const node: GraphNode = { item, incoming: [], outgoing: [] };
    if (depth >= maxDepth) return node;

    const key = `${item.uri.toString()}#${item.range.start.line}:${item.range.start.character}`;
    if (visited.has(key)) return node;
    visited.add(key);

    try {
        const incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item) || [];
        for (const call of incomingCalls) {
            node.incoming.push(await traverse(call.from, depth + 1, maxDepth, visited));
        }
    } catch { }

    try {
        const outgoingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item) || [];
        for (const call of outgoingCalls) {
            node.outgoing.push(await traverse(call.to, depth + 1, maxDepth, visited));
        }
    } catch { }

    return node;
}

async function traverseType(
    item: vscode.TypeHierarchyItem, 
    depth: number, 
    maxDepth: number, 
    visited: Set<string>,
    docSymbolCache: Map<string, vscode.DocumentSymbol[]>
): Promise<TypeNode> {
    const node: TypeNode = { item, subtypes: [], methods: [] };

    const key = `${item.uri.toString()}#${item.range.start.line}:${item.range.start.character}`;
    if (visited.has(key)) return node;
    visited.add(key);

    try {
        let syms = docSymbolCache.get(item.uri.toString());
        if (!syms) {
            syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', item.uri) || [];
            docSymbolCache.set(item.uri.toString(), syms);
        }

        const containsPosition = (range: any, pos: any) => {
            if (typeof range.contains === 'function') return range.contains(pos);
            if (pos.line < range.start.line || pos.line > range.end.line) return false;
            if (pos.line === range.start.line && pos.character < range.start.character) return false;
            if (pos.line === range.end.line && pos.character > range.end.character) return false;
            return true;
        };

        const findSymbol = (symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
            for (const s of symbols) {
                if (s.name === item.name && containsPosition(s.range, item.range.start)) {
                    return s;
                }
                if (s.children) {
                    const found = findSymbol(s.children);
                    if (found) return found;
                }
            }
            return undefined;
        };

        const matched = findSymbol(syms);
        if (matched && matched.children) {
            for (const child of matched.children) {
                if ([vscode.SymbolKind.Method, vscode.SymbolKind.Function].includes(child.kind)) {
                    node.methods.push(child.name);
                }
            }
        }
    } catch { }

    if (depth >= maxDepth) return node;

    try {
        const subtypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.provideSubtypes', item) || [];
        for (const sub of subtypes) {
            node.subtypes.push(await traverseType(sub, depth + 1, maxDepth, visited, docSymbolCache));
        }
    } catch { }

    return node;
}

function renderNode(node: GraphNode, prefix: string, isLast: boolean, isRoot: boolean): string {
    let res = '';
    const marker = isRoot ? '' : (isLast ? '└── ' : '├── ');
    const namePath = `${node.item.name} (${vscode.workspace.asRelativePath(node.item.uri)})`;

    res += `${prefix}${marker}${namePath}\n`;

    const childPrefix = isRoot ? prefix : prefix + (isLast ? '    ' : '│   ');
    const hasIncoming = node.incoming.length > 0;
    const hasOutgoing = node.outgoing.length > 0;

    // Callers preferred/first
    if (hasIncoming) {
        res += `${childPrefix}${hasOutgoing ? '├── ' : '└── '}Is called by\n`;
        const subPrefix = childPrefix + (hasOutgoing ? '│   ' : '    ');
        node.incoming.forEach((child, i) => {
            res += renderNode(child, subPrefix, i === node.incoming.length - 1, false);
        });
    }

    if (hasOutgoing) {
        res += `${childPrefix}└── Calls into\n`;
        const subPrefix = childPrefix + '    ';
        node.outgoing.forEach((child, i) => {
            res += renderNode(child, subPrefix, i === node.outgoing.length - 1, false);
        });
    }

    return res;
}

function renderTypeNode(node: TypeNode, prefix: string, isLast: boolean, isRoot: boolean): string {
    let res = '';
    const marker = isRoot ? '' : (isLast ? '└── ' : '├── ');
    const namePath = `${node.item.name} (${vscode.workspace.asRelativePath(node.item.uri)})`;

    res += `${prefix}${marker}${namePath} [Type]\n`;

    const childPrefix = isRoot ? prefix : prefix + (isLast ? '    ' : '│   ');
    const hasMethods = node.methods.length > 0;
    const hasSubtypes = node.subtypes.length > 0;

    if (hasMethods) {
        res += `${childPrefix}${hasSubtypes ? '├── ' : '└── '}Methods\n`;
        const subPrefix = childPrefix + (hasSubtypes ? '│   ' : '    ');
        node.methods.forEach((m, i) => {
            const mIsLast = i === node.methods.length - 1;
            res += `${subPrefix}${mIsLast ? '└── ' : '├── '}${m}\n`;
        });
    }

    if (hasSubtypes) {
        res += `${childPrefix}└── Is implemented by\n`;
        const subPrefix = childPrefix + '    ';
        node.subtypes.forEach((child, i) => {
            res += renderTypeNode(child, subPrefix, i === node.subtypes.length - 1, false);
        });
    }

    return res;
}
