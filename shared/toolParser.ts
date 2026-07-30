// Parses an AI reply (markdown) into executable tool calls. The reply may mix
// prose with fenced code blocks; only code blocks carry tool calls. Two forms
// are recognised: JSONL tool calls (one JSON object per line) and the special
// search-replace edit format. Anything else is prose and yields no tool calls.

import { marked, Tokens } from 'marked';

export interface ReadFilesCall {
    tool: 'read_files';
    files: string[];
}

export interface ReadOutlineCall {
    tool: 'read_outline';
    paths: string[];
}

export interface RunCmdCall {
    tool: 'run_cmd';
    command: string;
    // Optional workspace folder name ('[repo]') to run the command from.
    repo?: string;
}

export interface EditCall {
    tool: 'edit';
    path: string;
    search: string;
    replace: string;
}

export type ToolCall = ReadFilesCall | ReadOutlineCall | RunCmdCall | EditCall;

const SEARCH_PREFIX = '>>> SEARCH ';
const REPLACE_PREFIX = '<<< REPLACE';
const SEPARATOR = '===';

/** Extracts every tool call from an AI reply. Empty when the reply is prose. */
export function parseAiMessage(text: string): ToolCall[] {
    const calls = codeBlocks(text).flatMap(parseBlock);
    if (calls.length > 0) return calls;

    // The user may have copied only the code block contents, without the
    // surrounding fences. If the whole message looks like a tool block, parse
    // it directly.
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith(SEARCH_PREFIX)) {
        return parseBlock(trimmed);
    }
    return calls;
}

/** Routes a single block to the matching parser. */
function parseBlock(block: string): ToolCall[] {
    return block.includes(SEARCH_PREFIX) ? parseEditBlock(block) : parseJsonlBlock(block);
}

/** Yields the inner content of each fenced code block. */
function codeBlocks(text: string): string[] {
    const blocks: string[] = [];
    marked.walkTokens(marked.lexer(text), token => {
        if (token.type === 'code') blocks.push((token as Tokens.Code).text);
    });
    return blocks;
}

function parseEditBlock(block: string): EditCall[] {
    const edits: EditCall[] = [];
    const lines = block.split('\n');
    let i = 0;
    while (i < lines.length) {
        if (!lines[i].startsWith(SEARCH_PREFIX)) {
            i++;
            continue;
        }
        const path = lines[i].slice(SEARCH_PREFIX.length).trim();
        i++;
        const search: string[] = [];
        while (i < lines.length && lines[i].trim() !== SEPARATOR) {
            search.push(lines[i]);
            i++;
        }
        i++; // skip separator
        const replace: string[] = [];
        while (i < lines.length && !lines[i].startsWith(REPLACE_PREFIX)) {
            replace.push(lines[i]);
            i++;
        }
        i++; // skip replace marker
        if (path) {
            edits.push({ tool: 'edit', path, search: search.join('\n'), replace: replace.join('\n') });
        }
    }
    return edits;
}

function parseJsonlBlock(block: string): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        const call = parseJsonCall(trimmed);
        if (call) calls.push(call);
    }
    return calls;
}

function parseJsonCall(line: string): ToolCall | undefined {
    let obj: unknown;
    try {
        obj = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (typeof obj !== 'object' || obj === null) return undefined;
    const record = obj as Record<string, unknown>;
    switch (record.tool) {
        case 'read_files':
            return isStringArray(record.files) ? { tool: 'read_files', files: record.files } : undefined;
        case 'read_outline':
            return isStringArray(record.paths) ? { tool: 'read_outline', paths: record.paths } : undefined;
        case 'run_cmd':
            return typeof record.command === 'string'
                ? {
                    tool: 'run_cmd',
                    command: record.command,
                    repo: typeof record.repo === 'string' ? record.repo : undefined
                }
                : undefined;
        default:
            return undefined;
    }
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(v => typeof v === 'string');
}
