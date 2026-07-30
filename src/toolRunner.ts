import * as vscode from 'vscode';
import { EditCall, ReadFilesCall, RunCmdCall, ToolCall } from '../shared/toolParser';
import { fileBlock, readFileText, resolveRepoUri, resolveWorkspacePath, toFolderRelative } from './context';
import { readOutline } from './outline';
import { runCommand } from './terminal';
import { applyEdits } from './edits';

export interface ToolRunResult {
    // Combined output of read/outline/run tools, destined for the clipboard.
    resultsText?: string;
    // Edit failures and new lint errors, if any.
    errorReport?: string;
}

/** Executes accepted tool calls, separating readable results from edit errors. */
export async function runTools(calls: ToolCall[], sessionFiles: string[]): Promise<ToolRunResult> {
    const results: string[] = [];
    const edits: EditCall[] = [];

    for (const call of calls) {
        switch (call.tool) {
            case 'read_files':
                results.push(await readFilesResult(call));
                break;
            case 'read_outline':
                results.push(`## Outline\n${await readOutline(call.paths)}`);
                break;
            case 'run_cmd':
                results.push(await runCmdResult(call));
                break;
            case 'edit':
                edits.push(call);
                break;
        }
    }

    const errorReport = edits.length > 0 ? await applyEdits(edits, sessionFiles) : undefined;
    return {
        resultsText: results.length > 0 ? results.join('\n\n') : undefined,
        errorReport
    };
}

async function runCmdResult(call: RunCmdCall): Promise<string> {
    if (!call.repo) {
        return `## Command\n\`\`\`\n${await runCommand(call.command)}\n\`\`\``;
    }
    const cwd = resolveRepoUri(call.repo);
    if (!cwd) {
        const notice = `(unknown repo '${call.repo}': running from workspace root)`;
        return `## Command\n\`\`\`\n${notice}\n${await runCommand(call.command)}\n\`\`\``;
    }
    return `## Command (${call.repo})\n\`\`\`\n${await runCommand(call.command, cwd)}\n\`\`\``;
}

async function readFilesResult(call: ReadFilesCall): Promise<string> {
    const blocks: string[] = [];
    for (const pattern of call.files) {
        const uris = await resolveReadFiles(pattern);
        if (uris.length === 0) {
            blocks.push(`(no files matched: ${pattern})`);
            continue;
        }
        for (const uri of uris) {
            try {
                blocks.push(fileBlock(vscode.workspace.asRelativePath(uri), await readFileText(uri)));
            } catch (e) {
                console.error(`[ToolRunner] Failed to read ${uri.fsPath}:`, e);
                blocks.push(`(failed to read: ${vscode.workspace.asRelativePath(uri)})`);
            }
        }
    }
    return blocks.join('\n');
}

async function resolveReadFiles(pattern: string): Promise<vscode.Uri[]> {
    const uri = resolveWorkspacePath(pattern);
    if (uri) {
        try {
            await vscode.workspace.fs.stat(uri);
            return [uri];
        } catch {
            // Not a plain file (e.g. a glob pattern); fall through to search.
        }
    }
    return vscode.workspace.findFiles(toFolderRelative(pattern), null);
}
