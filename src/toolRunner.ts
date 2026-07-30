import * as vscode from 'vscode';
import { EditCall, ReadFilesCall, ToolCall } from '../shared/toolParser';
import { fileBlock, readFileText } from './context';
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
                results.push(`## Command\n\`\`\`\n${await runCommand(call.command)}\n\`\`\``);
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
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const uri = vscode.Uri.joinPath(folder.uri, pattern);
        try {
            await vscode.workspace.fs.stat(uri);
            return [uri];
        } catch {
            // Not a direct file under this folder; fall through to glob search.
        }
    }
    return vscode.workspace.findFiles(pattern, null);
}
