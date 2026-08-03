// User-configurable settings shared between the extension host and webview.

export interface AppSettings {
    // Prepended to the tool descriptions in the initial system prompt.
    customInstructions: string;
    // Character budget for the rendered workspace tree.
    maxTreeBytes: number;
    // Regexes (matched against workspace-relative paths) excluded from workspace
    // scans, on top of VS Code's default excludes.
    ignorePatterns: string[];
    // Timeout in milliseconds for call graph generation.
    callGraphTimeoutMs: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
    customInstructions: '',
    maxTreeBytes: 16000,
    ignorePatterns: [],
    callGraphTimeoutMs: 120000
};
