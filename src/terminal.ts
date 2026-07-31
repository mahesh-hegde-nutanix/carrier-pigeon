import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { workspaceBaseUri } from './context';

const COMMAND_TIMEOUT_MS = 120000;

// Matches CSI (colours, cursor moves) and OSC (title, shell-integration marker)
// escape sequences so captured output is readable plaintext.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Runs a command in the background using child_process.spawn.
 * Streams output via the optional onChunk callback.
 */
export async function runCommand(
    command: string,
    cwd?: vscode.Uri,
    onChunk?: (data: string) => void
): Promise<string> {
    const cwdPath = cwd ? cwd.fsPath : workspaceBaseUri()?.fsPath;

    return new Promise((resolve) => {
        const child = spawn(command, {
            shell: true,
            cwd: cwdPath,
        });

        let output = '';
        let isTimeout = false;

        const timer = setTimeout(() => {
            isTimeout = true;
            child.kill();
        }, COMMAND_TIMEOUT_MS);

        const handleData = (data: Buffer | string) => {
            const chunk = data.toString().replace(ANSI, '');
            output += chunk;
            if (onChunk) onChunk(chunk);
        };

        child.stdout.on('data', handleData);
        child.stderr.on('data', handleData);

        child.on('error', (err) => {
            clearTimeout(timer);
            const chunk = `\nError: ${err.message}`;
            output += chunk;
            if (onChunk) onChunk(chunk);
            resolve(`${output.trim()}\n(failed to start)`);
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            output = output.trim();
            
            let footer = '';
            if (isTimeout) {
                footer = `\n(timed out after ${COMMAND_TIMEOUT_MS / 1000}s)`;
            } else {
                footer = `\n(exit code: ${code ?? 'unknown'})`;
            }
            
            if (onChunk) onChunk(footer);
            resolve(`${output}${footer}`);
        });
    });
}
