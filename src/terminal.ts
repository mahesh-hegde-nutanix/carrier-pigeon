import * as vscode from 'vscode';

const TERMINAL_NAME = 'Carrier Pigeon';
const SHELL_INTEGRATION_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 120000;

// Matches CSI (colours, cursor moves) and OSC (title, shell-integration marker)
// escape sequences so captured output is readable plaintext.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Runs a command in a shared, user-visible terminal and returns its output.
 * Captures output and exit code via shell integration when available; otherwise
 * runs the command visibly without capture.
 */
export async function runCommand(command: string): Promise<string> {
    const terminal = getTerminal();
    terminal.show(true);
    const shell = await waitForShellIntegration(terminal);
    if (!shell) {
        terminal.sendText(command);
        return `$ ${command}\n(output not captured: shell integration unavailable)`;
    }
    return captureExecution(shell, command);
}

function getTerminal(): vscode.Terminal {
    return vscode.window.terminals.find(t => t.name === TERMINAL_NAME)
        ?? vscode.window.createTerminal(TERMINAL_NAME);
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

async function captureExecution(
    shell: vscode.TerminalShellIntegration,
    command: string
): Promise<string> {
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
    if (outcome === timedOut) {
        return `$ ${command}\n${output}\n(timed out after ${COMMAND_TIMEOUT_MS / 1000}s)`;
    }
    return `$ ${command}\n${output}\n(exit code: ${outcome ?? 'unknown'})`;
}
