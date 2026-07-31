import * as vscode from 'vscode';
import { resolveWorkspacePath } from './context';

interface GraphNode {
    item: vscode.CallHierarchyItem;
    incoming: GraphNode[];
    outgoing: GraphNode[];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function generateCallGraphContext(text: string, files: string[], maxDepth = 1): Promise<string> {
    try {
        // Enforce 10-second timeout ceiling to ensure context compilation doesn't lock up
        return await Promise.race([
            buildGraph(text, files, maxDepth),
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
        ]);
    } catch (e) {
        console.warn('[CallGraph] Failed or timed out:', e);
        return '';
    }
}

async function buildGraph(text: string, files: string[], maxDepth: number): Promise<string> {
    const seeds: vscode.CallHierarchyItem[] = [];

    for (const file of files) {
        const uri = resolveWorkspacePath(file);
        if (!uri) continue;

        // Parse explicitly mentioned symbols `@path (SymbolName)`
        const explicitSymbols = new Set<string>();
        const regex = new RegExp(`@${escapeRegExp(file)}\\s+\\(([^)]+)\\)`, 'g');
        let match;
        while ((match = regex.exec(text)) !== null) {
            explicitSymbols.add(match[1]);
        }

        let docSymbols: vscode.DocumentSymbol[] | undefined;
        try {
            docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
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
                    vscode.SymbolKind.Interface
                ].includes(sym.kind)) {
                    targetSymbols.push(sym);
                }
            }
            // For explicit symbols we might need to dig into child scopes
            if (explicitSymbols.size > 0 && sym.children) {
                queue.push(...sym.children);
            }
        }

        for (const sym of targetSymbols) {
            try {
                const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, sym.selectionRange.start);
                if (items && items.length > 0) {
                    seeds.push(...items);
                }
            } catch {
                // Ignore missing support on specific nodes
            }
        }
    }

    if (seeds.length === 0) return '';

    const visited = new Set<string>();
    const graph: GraphNode[] = [];
    
    // Process seeds
    for (const seed of seeds) {
        graph.push(await traverse(seed, 0, maxDepth, visited));
    }

    // Skip output if nothing has callers or callees
    let hasConnections = false;
    const checkConnections = (nodes: GraphNode[]) => {
        for (const n of nodes) {
            if (n.incoming.length > 0 || n.outgoing.length > 0) {
                hasConnections = true;
                return;
            }
        }
    };
    checkConnections(graph);
    
    if (!hasConnections) return '';

    let result = '';
    graph.forEach((node, idx) => {
        result += renderNode(node, '', idx === graph.length - 1, true);
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
        res += `${childPrefix}${hasOutgoing ? '├── ' : '└── '}Callers\n`;
        const subPrefix = childPrefix + (hasOutgoing ? '│   ' : '    ');
        node.incoming.forEach((child, i) => {
            res += renderNode(child, subPrefix, i === node.incoming.length - 1, false);
        });
    }

    if (hasOutgoing) {
        res += `${childPrefix}└── Callees\n`;
        const subPrefix = childPrefix + '    ';
        node.outgoing.forEach((child, i) => {
            res += renderNode(child, subPrefix, i === node.outgoing.length - 1, false);
        });
    }

    return res;
}
