import { ToolCall, parseAiMessage } from '../shared/toolParser';
import { ToolResultsMsg } from '../shared/protocol';
import { els, post } from './dom';
import { getActive } from './state';
import { appendMessage } from './messagesUi';

// The AI message that carried the currently pending tool calls; a COPY ERRORS
// button attaches here if the edits report problems.
let toolMessageEl: HTMLElement | null = null;

/** Displays a pasted AI reply and, if it contains tool calls, their preview. */
export function handlePaste(value: string): void {
    const el = appendMessage(value, 'ai');
    const calls = parseAiMessage(value);
    if (calls.length === 0) return;
    toolMessageEl = el;
    renderPendingTools(calls);
}

/** Appends tool results as a user message and surfaces any error report. */
export function handleToolResults(msg: ToolResultsMsg): void {
    clearPendingTools();
    if (msg.resultsText) {
        const el = appendMessage(msg.resultsText, 'user');
        if (msg.copied) addCopiedIndicator(el);
    }
    if (msg.errorReport && toolMessageEl) {
        addCopyErrorsButton(toolMessageEl, msg.errorReport);
    }
}

function renderPendingTools(calls: ToolCall[]): void {
    els.pendingTools.innerHTML = '';
    const checkboxes: HTMLInputElement[] = [];

    calls.forEach(call => {
        const row = document.createElement('label');
        row.className = 'tool-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkboxes.push(checkbox);

        const label = document.createElement('span');
        label.className = 'tool-label';
        label.textContent = describe(call);

        row.appendChild(checkbox);
        row.appendChild(label);
        els.pendingTools.appendChild(row);
    });

    const actions = document.createElement('div');
    actions.className = 'tool-actions';

    const accept = document.createElement('button');
    accept.className = 'tool-btn tool-btn-accept';
    accept.textContent = 'ACCEPT';

    const reject = document.createElement('button');
    reject.className = 'tool-btn';
    reject.textContent = 'REJECT';
    reject.onclick = clearPendingTools;

    const syncAccept = () => {
        accept.disabled = !checkboxes.some(c => c.checked);
    };
    checkboxes.forEach(c => c.addEventListener('change', syncAccept));
    accept.onclick = () => {
        const selected = calls.filter((_, i) => checkboxes[i].checked);
        if (selected.length === 0) return;
        post({
            type: 'executeTools',
            calls: selected,
            sessionFiles: getActive()?.mentionedFiles ?? []
        });
        clearPendingTools();
    };

    actions.appendChild(reject);
    actions.appendChild(accept);
    els.pendingTools.appendChild(actions);
    els.pendingTools.classList.add('active');
}

function clearPendingTools(): void {
    els.pendingTools.innerHTML = '';
    els.pendingTools.classList.remove('active');
}

function describe(call: ToolCall): string {
    switch (call.tool) {
        case 'read_files':
            return `read_files: ${call.files.join(', ')}`;
        case 'read_outline':
            return `read_outline: ${call.paths.join(', ')}`;
        case 'run_cmd':
            return call.repo ? `[${call.repo}] ${call.command}` : call.command;
        case 'edit':
            return `edit: ${call.path}`;
    }
}

function addCopiedIndicator(messageEl: HTMLElement): void {
    const note = document.createElement('div');
    note.className = 'copied-indicator';
    note.textContent = '\u2713 copied to clipboard';
    messageEl.appendChild(note);
}

function addCopyErrorsButton(messageEl: HTMLElement, report: string): void {
    const btn = document.createElement('button');
    btn.className = 'tool-btn copy-errors-btn';
    btn.textContent = 'COPY ERRORS';
    btn.onclick = () => post({ type: 'copyText', text: report });
    messageEl.appendChild(btn);
    messageEl.classList.add('has-error');
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
