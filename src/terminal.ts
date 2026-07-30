import * as vscode from 'vscode';
import { workspaceBaseUri } from './context';

const TERMINAL_NAME = 'Carrier Pigeon';
const SHELL_INTEGRATION_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 120000;

// Matches CSI (colours, cursor moves) and OSC (title, shell-integration marker)
// escape sequences so captured output is readable plaintext.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// Restricts a repo cwd to safe path characters so it can be interpolated into a
// `cd` command without shell-quoting risks.
const SAFE_PATH = /^[A-Za-z0-9/_.\-]+$/;

/**
 * Runs a command in a shared, user-visible terminal and returns its output.
 * The terminal's base cwd is the workspace root; when `cwd` is given (a repo
 * override) it is changed to first. Captures output and exit code via shell
 * integration when available; otherwise runs the command visibly without capture.
 */
export async function runCommand(command: string, cwd?: vscode.Uri): Promise<string> {
    if (cwd && !SAFE_PATH.test(cwd.fsPath)) {
        return `(refusing to run: repo path has unsafe characters: ${cwd.fsPath})`;
    }
    const terminal = getTerminal();
    terminal.show(true);
    const shell = await waitForShellIntegration(terminal);
    if (!shell) {
        if (cwd) terminal.sendText(`cd -- "${cwd.fsPath}"`);
        terminal.sendText(command);
        return `$ ${command}\n(output not captured: shell integration unavailable)`;
    }
    if (cwd) {
        const cd = await runExecution(shell, `cd -- "${cwd.fsPath}"`);
        if (cd.timedOut || (cd.exitCode ?? 1) !== 0) {
            return `$ cd ${cwd.fsPath}\n${cd.output}\n(failed to change directory)`;
        }
    }
    return formatResult(command, await runExecution(shell, command));
}

function getTerminal(): vscode.Terminal {
    return vscode.window.terminals.find(t => t.name === TERMINAL_NAME)
        ?? vscode.window.createTerminal({ name: TERMINAL_NAME, cwd: workspaceBaseUri() });
}

function waitForShellIntegration(
    terminal: vscode.Terminal
): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
    return new Promise(resolve => {
        const sub = vscode.window.onDidChangeTerminalShellIntegration(e => {
            if (e.terminal === terminal) {
                clearTimeout(timer);
                sub.dispose();
                resolve(e.shellIntegration);
            }
        });
        const timer = setTimeout(() => {
            sub.dispose();
            resolve(undefined);
        }, SHELL_INTEGRATION_TIMEOUT_MS);
    });
}

interface ExecutionResult {
    output: string;
    exitCode: number | undefined;
    timedOut: boolean;
}

async function runExecution(
    shell: vscode.TerminalShellIntegration,
    command: string
): Promise<ExecutionResult> {
    const execution = shell.executeCommand(command);
    const endPromise = new Promise<number | undefined>(resolve => {
        const sub = vscode.window.onDidEndTerminalShellExecution(e => {
            if (e.execution === execution) {
                sub.dispose();
                resolve(e.exitCode);
            }
        });
    });

    const chunks: string[] = [];
    const drain = (async () => {
        for await (const data of execution.read()) chunks.push(data);
        return endPromise;
    })();

    const timedOut = Symbol('timeout');
    const outcome = await Promise.race([
        drain,
        new Promise<typeof timedOut>(res => setTimeout(() => res(timedOut), COMMAND_TIMEOUT_MS))
    ]);

    const output = chunks.join('').replace(ANSI, '').trim();
    if (outcome === timedOut) return { output, exitCode: undefined, timedOut: true };
    return { output, exitCode: outcome, timedOut: false };
}

function formatResult(command: string, result: ExecutionResult): string {
    if (result.timedOut) {
        return `$ ${command}\n${result.output}\n(timed out after ${COMMAND_TIMEOUT_MS / 1000}s)`;
    }
    return `$ ${command}\n${result.output}\n(exit code: ${result.exitCode ?? 'unknown'})`;
}
