import * as vscode from 'vscode';
import { EditCall, ReadFilesCall, RunCmdCall, ToolCall } from '../shared/toolParser';
import { fileBlock, readFileText, resolveRepoUri, resolveWorkspacePath, toFolderRelative } from './context';
import { readOutline } from './outline';
import { runCommand } from './terminal';
import { applyEdits } from './edits';
import { SkillRegistry } from './skills';

export interface ToolRunResult {
    // Combined output of read/outline/run tools, destined for the clipboard.
    resultsText?: string;
    // Edit failures and new lint errors, if any.
    errorReport?: string;
}

/** Executes accepted tool calls, separating readable results from edit errors. */
export async function runTools(
    calls: ToolCall[],
    sessionFiles: string[],
    skills: SkillRegistry,
    onChunk?: (chunk: string) => void
): Promise<ToolRunResult> {
    const results: string[] = [];
    const edits: EditCall[] = [];

    for (const call of calls) {
        switch (call.tool) {
            case 'read_files': {
                const res = await readFilesResult(call);
                if (onChunk) onChunk(`**Read Files**\n\`\`\`\n${res}\n\`\`\`\n\n`);
                results.push(res);
                break;
            }
            case 'read_outline': {
                const res = `**Outline**\n${await readOutline(call.paths)}`;
                if (onChunk) onChunk(`${res}\n\n`);
                results.push(res);
                break;
            }
            case 'read_skill': {
                const res = await skills.read(call.skill, call.references);
                if (onChunk) onChunk(`**Read Skill: ${call.skill}**\n\`\`\`\n${res}\n\`\`\`\n\n`);
                results.push(res);
                break;
            }
            case 'run_cmd': {
                results.push(await runCmdResult(call, onChunk));
                break;
            }
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

async function runCmdResult(call: RunCmdCall, onChunk?: (chunk: string) => void): Promise<string> {
    let cwd: vscode.Uri | undefined;
    let repoLabel = 'workspace root';
    let notice = '';

    if (call.repo) {
        cwd = resolveRepoUri(call.repo);
        if (!cwd) {
            notice = `(unknown repo '${call.repo}': running from workspace root)\n`;
        } else {
            repoLabel = call.repo;
        }
    }

    if (onChunk) onChunk(`**Command (${repoLabel})**\n\`\`\`text\n${notice}$ ${call.command}\n`);

    const rawOutput = await runCommand(call.command, cwd, onChunk);

    if (onChunk) onChunk(`\n\`\`\`\n\n`);

    return `**Command (${repoLabel})**\n\`\`\`text\n${notice}$ ${call.command}\n${rawOutput}\n\`\`\``;
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
