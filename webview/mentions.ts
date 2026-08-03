import { els, post } from './dom';
import { WorkspaceSymbol, SelectionMatchResultMsg, ContextBuildDetails } from '../shared/protocol';
import { getActive, getMentionedFiles, getSkills, getWorkspaceFiles, saveActive } from './state';

interface MentionState {
    start: number;
    end: number;
    query: string;
    trigger: '@' | '/' | '#';
}

interface CompletionItem {
    value: string;
    label: string;
    detail: string;
    kind: 'file' | 'skill' | 'symbol' | 'dir';
    insertText?: string;
}

const MAX_TEXTAREA_HEIGHT = 120;
const MAX_MENTION_RESULTS = 50;
const SYMBOL_SEARCH_DELAY_MS = 150;

let filteredItems: CompletionItem[] = [];
let currentMentionState: MentionState | null = null;
let selectedPopupIndex = -1;
let activeTrigger: '@' | '/' | '#' | null = null;
let symbolSearchTimer: ReturnType<typeof setTimeout> | undefined;
let latestSymbolRequestId = 0;
// True while the host is building the context payload (potentially slow FS work).
let copying = false;
let copyingSessionId: string | null = null;
let toolRunning = false;
let toolRunningSessionId: string | null = null;
// A copy is queued, waiting on a fresh file list so pasted @mentions resolve.
let pendingCopy = false;
let pendingPaste: { text: string, start: number, end: number } | null = null;

/** Attaches all input-area listeners. Call once on startup. */
export function initMentions(): void {
    els.modeSelect.addEventListener('change', () => {
        const active = getActive();
        if (active) {
            active.mode = els.modeSelect.value as 'ask' | 'edit';
            saveActive();
        }
    });

    els.chatInput.addEventListener('input', () => {
        els.callGraphError.style.display = 'none';
        els.callGraphError.title = '';
        autoResizeTextarea();
        checkMentionTrigger();
        updateButtons();
    });

    els.chatInput.addEventListener('keydown', onKeydown);
    els.chatInput.addEventListener('paste', onPaste);
}

function onPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;

    e.preventDefault();
    pendingPaste = {
        text,
        start: els.chatInput.selectionStart,
        end: els.chatInput.selectionEnd
    };

    post({ type: 'requestCheckSelectionMatch', text });
}

export function handleSelectionMatchResult(msg: SelectionMatchResultMsg): void {
    if (!pendingPaste || pendingPaste.text !== msg.text) return;

    let inserted = msg.text;
    if (msg.filePath && msg.startLine !== undefined && msg.endLine !== undefined) {
        inserted = `@${msg.filePath}:${msg.startLine}-${msg.endLine}\n\n\`\`\`\n${msg.text}\n\`\`\``;
    }

    els.chatInput.focus();
    els.chatInput.setRangeText(inserted, pendingPaste.start, pendingPaste.end, 'end');
    pendingPaste = null;
    
    // Trigger input event to re-calculate mentions, sizing and button state
    els.chatInput.dispatchEvent(new Event('input'));
}

/** Starts a background workspace file load so @mentions are ready on first use. */
export function prefetchWorkspaceFiles(): void {
    post({ type: 'requestFiles', purpose: 'prefetch' });
}

export function updateButtons(): void {
    const active = getActive();
    els.actionButtons.innerHTML = '';

    if (els.chatInput.value.trim().length === 0) {
        els.callGraphCheck.checked = false;
    }

    if (!active) return;

    if (copying) {
        els.actionButtons.appendChild(createLoadingButton(' COPYING\u2026'));
    } else if (toolRunning && toolRunningSessionId === active.id) {
        els.actionButtons.appendChild(createLoadingButton(' RUNNING\u2026'));
    } else if (els.chatInput.value.trim().length > 0) {
        els.actionButtons.appendChild(createActionButton(COPY_ICON, ' COPY CONTEXT', performCopy));
    }
    if (active.initialContextCopied) {
        els.actionButtons.appendChild(createActionButton(PASTE_ICON, ' PASTE', performPaste));
    }
}

export function setToolRunningState(running: boolean, sessionId?: string): void {
    toolRunning = running;
    toolRunningSessionId = sessionId || null;
    setInputBlocked(copying || toolRunning);
    updateButtons();
}

/** Clears the copy-in-progress state once the host responds. */
export function endCopying(sessionId: string, details?: ContextBuildDetails): void {
    if (copyingSessionId !== sessionId) return;
    copying = false;
    copyingSessionId = null;
    setInputBlocked(copying || toolRunning);
    els.callGraphCheck.checked = false;
    if (details?.callGraphError) {
        els.callGraphError.style.display = 'flex';
        els.callGraphError.title = details.callGraphError;
    } else {
        els.callGraphError.style.display = 'none';
        els.callGraphError.title = '';
    }
    updateButtons();
}

/** Unblocks the UI if the copied session is closed before the host responds. */
export function cancelCopyForSession(sessionId: string): void {
    if (copyingSessionId !== sessionId) return;
    pendingCopy = false;
    copying = false;
    copyingSessionId = null;
    setInputBlocked(copying || toolRunning);
    updateButtons();
}

export function autoResizeTextarea(): void {
    els.chatInput.style.height = 'auto';
    els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px';
}

function performCopy(): void {
    const active = getActive();
    if (!active || !els.chatInput.value.trim()) return;

    els.callGraphError.style.display = 'none';
    els.callGraphError.title = '';

    // Refresh the file list before scanning so @mentions that were pasted
    // (and thus never triggered a file fetch) are still resolved. The copy is
    // completed in finishPendingCopy once the list arrives.
    pendingCopy = true;
    copying = true;
    copyingSessionId = active.id;
    setInputBlocked(true);
    updateButtons();
    post({ type: 'requestFiles', purpose: 'copy' });
}

/** Completes a copy queued by performCopy, after the file list has refreshed. */
export function finishPendingCopy(): void {
    if (!pendingCopy) return;
    pendingCopy = false;

    const active = getActive();
    const text = els.chatInput.value.trim();
    if (!active || active.id !== copyingSessionId || !text) {
        copying = false;
        copyingSessionId = null;
        setInputBlocked(copying || toolRunning);
        updateButtons();
        return;
    }

    const mentionedFiles = getMentionedFiles(text);
    post({
        type: 'requestContextCopy',
        sessionId: active.id,
        text,
        files: mentionedFiles,
        isInitial: !active.initialContextCopied,
        mode: active.mode || 'edit',
        includeCallGraph: els.callGraphCheck.checked
    });
}

function performPaste(): void {
    post({ type: 'requestPaste' });
}

function createActionButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'action-button';
    btn.innerHTML = icon + label;
    btn.onclick = onClick;
    return btn;
}

function createLoadingButton(text: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'action-button';
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${text}`;
    return btn;
}

function setInputBlocked(blocked: boolean): void {
    els.chatInput.disabled = blocked;
}

function checkMentionTrigger(): void {
    const val = els.chatInput.value;
    const cursorPos = els.chatInput.selectionStart;
    const match = val.substring(0, cursorPos).match(/(?:^|\s)([@/#])([^\s]*)$/);

    if (!match) {
        activeTrigger = null;
        cancelSymbolSearch();
        hidePopup();
        return;
    }
    const trigger = match[1] as '@' | '/' | '#';

    // Re-fetch the file list once per mention token so files created since the
    // last mention (the host list is cached and invalidated on create/delete)
    // still appear.
    if (trigger === '@' && activeTrigger !== '@') {
        post({ type: 'requestFiles', purpose: 'mention' });
    }
    activeTrigger = trigger;
    const query = match[2].toLowerCase();
    const tokenLength = match[1].length + match[2].length;
    currentMentionState = {
        start: cursorPos - tokenLength,
        end: cursorPos,
        query,
        trigger
    };

    if (trigger === '#') {
        scheduleSymbolSearch(query);
        return;
    }
    cancelSymbolSearch();
    const candidates = trigger === '@' ? fileCompletionItems() : skillCompletionItems();

    if (query) {
        filteredItems = candidates
            .map(item => {
                const indices = fuzzyMatchIndices(query, item.value);
                return { item, indices, score: computeFuzzyScore(indices, item.value) };
            })
            .filter(item => item.indices !== null)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_MENTION_RESULTS)
            .map(result => result.item);
    } else {
        filteredItems = candidates.slice(0, MAX_MENTION_RESULTS);
    }

    if (filteredItems.length > 0) {
        showPopup();
    } else {
        hidePopup();
    }
}

/** Re-runs mention detection after the file list arrives. */
export function refreshMentionTrigger(): void {
    els.chatInput.dispatchEvent(new Event('input'));
}

/** Displays results for the latest in-progress workspace symbol search. */
export function showSymbolResults(requestId: number, symbols: WorkspaceSymbol[]): void {
    if (
        requestId !== latestSymbolRequestId ||
        currentMentionState?.trigger !== '#'
    ) {
        return;
    }
    filteredItems = symbols.slice(0, MAX_MENTION_RESULTS).map(symbol => {
        const unqualifiedName = symbol.name.split(/[\.:]+/).pop() || symbol.name;
        
        let shortPath = symbol.path;
        if (shortPath.length > 40) {
            shortPath = '...' + shortPath.slice(-37);
        }
        
        let insertText = `@${symbol.path} (${unqualifiedName})`;
        if (symbol.line !== undefined && symbol.character !== undefined) {
            insertText = `#${symbol.path}:${symbol.line + 1}:${symbol.character + 1} (${unqualifiedName})`;
        }
        
        return {
            value: unqualifiedName,
            label: unqualifiedName,
            detail: shortPath,
            kind: 'symbol',
            insertText
        };
    });
    if (filteredItems.length > 0) {
        showPopup();
    } else {
        hidePopup();
    }
}

function scheduleSymbolSearch(query: string): void {
    cancelSymbolSearch();
    filteredItems = [];
    els.mentionPopup.classList.remove('active');
    selectedPopupIndex = -1;
    if (!query) return;

    const requestId = ++latestSymbolRequestId;
    symbolSearchTimer = setTimeout(() => {
        post({ type: 'requestSymbols', requestId, query });
        symbolSearchTimer = undefined;
    }, SYMBOL_SEARCH_DELAY_MS);
}

function cancelSymbolSearch(): void {
    if (symbolSearchTimer !== undefined) {
        clearTimeout(symbolSearchTimer);
        symbolSearchTimer = undefined;
    }
    latestSymbolRequestId++;
}

function showPopup(): void {
    els.mentionPopup.innerHTML = '';
    selectedPopupIndex = 0;
    filteredItems.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = `mention-item ${item.kind}` + (index === 0 ? ' selected' : '');

        if (currentMentionState && currentMentionState.query) {
            const indices = fuzzyMatchIndices(currentMentionState.query, item.value);
            if (indices && indices.length > 0) {
                const labelOffset = item.value.length - item.label.length;
                const labelIndices = indices
                    .filter(i => i >= labelOffset)
                    .map(i => i - labelOffset);
                div.innerHTML = `<div class="mention-base">${highlightFuzzyMatch(item.label, labelIndices)}</div>` +
                    (item.detail ? `<div class="mention-dir">${escapeHtml(item.detail)}</div>` : '');
            } else {
                div.innerHTML = completionHtml(item);
            }
        } else {
            div.innerHTML = completionHtml(item);
        }
        div.onmousedown = (e) => {
            e.preventDefault();
            insertMention(item);
        };
        els.mentionPopup.appendChild(div);
    });
    els.mentionPopup.classList.add('active');
}

function hidePopup(): void {
    els.mentionPopup.classList.remove('active');
    currentMentionState = null;
    selectedPopupIndex = -1;
}

function insertMention(item: CompletionItem): void {
    if (!currentMentionState) return;
    const val = els.chatInput.value;
    const before = val.substring(0, currentMentionState.start);
    const after = val.substring(currentMentionState.end);
    const inserted = item.insertText ?? currentMentionState.trigger + item.value;
    els.chatInput.value = before + inserted + ' ' + after;
    const newCursorPos = currentMentionState.start + inserted.length + 1;
    els.chatInput.setSelectionRange(newCursorPos, newCursorPos);
    hidePopup();
    autoResizeTextarea();
    els.chatInput.focus();
    updateButtons();
}

function onKeydown(e: KeyboardEvent): void {
    if (!els.mentionPopup.classList.contains('active')) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            performCopy();
        }
        return;
    }

    const items = els.mentionPopup.querySelectorAll('.mention-item');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length === 0) return;
        items[selectedPopupIndex].classList.remove('selected');
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        selectedPopupIndex = (selectedPopupIndex + delta + items.length) % items.length;
        items[selectedPopupIndex].classList.add('selected');
        items[selectedPopupIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (filteredItems[selectedPopupIndex]) insertMention(filteredItems[selectedPopupIndex]);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        hidePopup();
    }
}

const COPY_ICON =
    '<svg viewBox="0 0 16 16"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path d="M3 1L2 2v10h1V2h6.414l-1-1H3z"/></svg>';
const PASTE_ICON =
    '<svg viewBox="0 0 16 16"><path d="M11 2h-1.54C9.13 1 8.35 1 7.5 1c-.85 0-1.63 0-1.96 1H4L3 3v11l1 1h8l1-1V3l-1-1zM7.5 2c.28 0 .5.22.5.5s-.22.5-.5.5-.5-.22-.5-.5.22-.5.5-.5zM12 14H4V3h1v1h6V3h1v11z"/></svg>';

function fileCompletionItems(): CompletionItem[] {
    return getWorkspacePaths().map(value => {
        const isDir = value.endsWith('/');
        const cleanPath = isDir ? value.slice(0, -1) : value;
        const lastSlash = cleanPath.lastIndexOf('/');
        return {
            value,
            label: lastSlash >= 0 ? cleanPath.substring(lastSlash + 1) + (isDir ? '/' : '') : value,
            detail: lastSlash >= 0 ? cleanPath.substring(0, lastSlash + 1) : '',
            kind: isDir ? 'dir' : 'file'
        };
    });
}

function skillCompletionItems(): CompletionItem[] {
    return getSkills().map(skill => ({
        value: skill.name,
        label: skill.name,
        detail: skill.description,
        kind: 'skill'
    }));
}

function completionHtml(item: CompletionItem): string {
    return `<div class="mention-base">${escapeHtml(item.label)}</div>` +
        (item.detail ? `<div class="mention-dir">${escapeHtml(item.detail)}</div>` : '');
}

function getWorkspacePaths(): string[] {
    const files = getWorkspaceFiles();
    const paths = new Set<string>();
    files.forEach(f => {
        paths.add(f);
        let lastSlash = f.lastIndexOf('/');
        while (lastSlash > 0) {
            paths.add(f.substring(0, lastSlash) + '/');
            lastSlash = f.lastIndexOf('/', lastSlash - 1);
        }
    });
    return Array.from(paths);
}

function computeFuzzyScore(indices: number[] | null, text: string): number {
    if (!indices || indices.length === 0) return 0;
    let score = 0;
    let streak = 0;
    for (let i = 1; i < indices.length; i++) {
        if (indices[i] === indices[i - 1] + 1) {
            streak++;
            score += streak * 10;
        } else {
            streak = 0;
        }
    }
    // Prefer shorter strings, and matches closer to the start
    score -= text.length * 0.1;
    score -= indices[0] * 0.1;
    return score;
}

function fuzzyMatchIndices(query: string, text: string): number[] | null {
    if (!query) return [];
    let qIdx = 0;
    const matchIndices: number[] = [];
    const lowerText = text.toLowerCase();
    for (let i = 0; i < lowerText.length; i++) {
        if (lowerText[i] === query[qIdx]) {
            matchIndices.push(i);
            qIdx++;
            if (qIdx === query.length) return matchIndices;
        }
    }
    return null;
}

function highlightFuzzyMatch(text: string, indices: number[]): string {
    let result = '';
    let lastIdx = 0;
    for (const idx of indices) {
        result += escapeHtml(text.substring(lastIdx, idx));
        result += '<strong>' + escapeHtml(text[idx]) + '</strong>';
        lastIdx = idx + 1;
    }
    result += escapeHtml(text.substring(lastIdx));
    return result;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
