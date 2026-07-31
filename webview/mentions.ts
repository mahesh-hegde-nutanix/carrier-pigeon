import { els, post } from './dom';
import { getActive, getMentionedFiles, getWorkspaceFiles, saveActive } from './state';

interface MentionState {
    start: number;
    end: number;
    query: string;
}

const MAX_TEXTAREA_HEIGHT = 120;
const MAX_MENTION_RESULTS = 50;

let filteredFiles: string[] = [];
let currentMentionState: MentionState | null = null;
let selectedPopupIndex = -1;
// True while the cursor sits inside an @-mention token.
let mentionActive = false;
// True while the host is building the context payload (potentially slow FS work).
let copying = false;
let copyingSessionId: string | null = null;
// A copy is queued, waiting on a fresh file list so pasted @mentions resolve.
let pendingCopy = false;

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
        autoResizeTextarea();
        checkMentionTrigger();
        updateButtons();
    });

    els.chatInput.addEventListener('keydown', onKeydown);
}

/** Starts a background workspace file load so @mentions are ready on first use. */
export function prefetchWorkspaceFiles(): void {
    post({ type: 'requestFiles', purpose: 'prefetch' });
}

export function updateButtons(): void {
    const active = getActive();
    els.actionButtons.innerHTML = '';
    if (!active) return;

    if (copying) {
        els.actionButtons.appendChild(createLoadingButton());
    } else if (els.chatInput.value.trim().length > 0) {
        els.actionButtons.appendChild(createActionButton(COPY_ICON, ' COPY CONTEXT', performCopy));
    }
    if (active.initialContextCopied) {
        els.actionButtons.appendChild(createActionButton(PASTE_ICON, ' PASTE', performPaste));
    }
}

/** Clears the copy-in-progress state once the host responds. */
export function endCopying(sessionId: string): void {
    if (copyingSessionId !== sessionId) return;
    copying = false;
    copyingSessionId = null;
    setInputBlocked(false);
    updateButtons();
}

/** Unblocks the UI if the copied session is closed before the host responds. */
export function cancelCopyForSession(sessionId: string): void {
    if (copyingSessionId !== sessionId) return;
    pendingCopy = false;
    copying = false;
    copyingSessionId = null;
    setInputBlocked(false);
    updateButtons();
}

export function autoResizeTextarea(): void {
    els.chatInput.style.height = 'auto';
    els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px';
}

function performCopy(): void {
    const active = getActive();
    if (!active || !els.chatInput.value.trim()) return;

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
        setInputBlocked(false);
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
        mode: active.mode || 'edit'
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

function createLoadingButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'action-button';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> COPYING\u2026';
    return btn;
}

function setInputBlocked(blocked: boolean): void {
    els.chatInput.disabled = blocked;
}

function checkMentionTrigger(): void {
    const val = els.chatInput.value;
    const cursorPos = els.chatInput.selectionStart;
    const match = val.substring(0, cursorPos).match(/@([^\s]*)$/);

    if (!match) {
        mentionActive = false;
        hidePopup();
        return;
    }

    // Re-fetch the file list once per mention token so files created since the
    // last mention (the host list is cached and invalidated on create/delete)
    // still appear.
    if (!mentionActive) {
        mentionActive = true;
        post({ type: 'requestFiles', purpose: 'mention' });
    }
    const query = match[1].toLowerCase();
    currentMentionState = {
        start: cursorPos - match[0].length,
        end: cursorPos,
        query
    };

    const allPaths = getWorkspacePaths();

    if (query) {
        filteredFiles = allPaths
            .map(f => {
                const indices = fuzzyMatchIndices(query, f);
                return { file: f, indices, score: computeFuzzyScore(indices, f) };
            })
            .filter(item => item.indices !== null)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_MENTION_RESULTS)
            .map(item => item.file);
    } else {
        filteredFiles = allPaths.slice(0, MAX_MENTION_RESULTS);
    }

    if (filteredFiles.length > 0) {
        showPopup();
    } else {
        hidePopup();
    }
}

/** Re-runs mention detection after the file list arrives. */
export function refreshMentionTrigger(): void {
    els.chatInput.dispatchEvent(new Event('input'));
}

function showPopup(): void {
    els.mentionPopup.innerHTML = '';
    selectedPopupIndex = 0;
    filteredFiles.forEach((file, index) => {
        const div = document.createElement('div');
        div.className = 'mention-item' + (index === 0 ? ' selected' : '');
        
        const lastSlash = file.lastIndexOf('/');
        const base = lastSlash >= 0 ? file.substring(lastSlash + 1) : file;
        const dir = lastSlash >= 0 ? file.substring(0, lastSlash + 1) : '';

        if (currentMentionState && currentMentionState.query) {
            const indices = fuzzyMatchIndices(currentMentionState.query, file);
            if (indices && indices.length > 0) {
                const baseIndices = indices.filter(i => i > lastSlash).map(i => i - (lastSlash + 1));
                const dirIndices = indices.filter(i => i <= lastSlash);
                
                const baseHtml = highlightFuzzyMatch(base, baseIndices);
                const dirHtml = dir ? highlightFuzzyMatch(dir, dirIndices) : '';
                
                div.innerHTML = `<div class="mention-base">${baseHtml}</div>` +
                                (dir ? `<div class="mention-dir">${dirHtml}</div>` : '');
            } else {
                div.innerHTML = `<div class="mention-base">${base}</div>` +
                                (dir ? `<div class="mention-dir">${dir}</div>` : '');
            }
        } else {
            div.innerHTML = `<div class="mention-base">${base}</div>` +
                            (dir ? `<div class="mention-dir">${dir}</div>` : '');
        }
        div.onmousedown = (e) => {
            e.preventDefault();
            insertMention(file);
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

function insertMention(filePath: string): void {
    if (!currentMentionState) return;
    const val = els.chatInput.value;
    const before = val.substring(0, currentMentionState.start);
    const after = val.substring(currentMentionState.end);
    els.chatInput.value = before + '@' + filePath + ' ' + after;
    const newCursorPos = currentMentionState.start + filePath.length + 2;
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
        if (filteredFiles[selectedPopupIndex]) insertMention(filteredFiles[selectedPopupIndex]);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        hidePopup();
    }
}

const COPY_ICON =
    '<svg viewBox="0 0 16 16"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path d="M3 1L2 2v10h1V2h6.414l-1-1H3z"/></svg>';
const PASTE_ICON =
    '<svg viewBox="0 0 16 16"><path d="M11 2h-1.54C9.13 1 8.35 1 7.5 1c-.85 0-1.63 0-1.96 1H4L3 3v11l1 1h8l1-1V3l-1-1zM7.5 2c.28 0 .5.22.5.5s-.22.5-.5.5-.5-.22-.5-.5.22-.5.5-.5zM12 14H4V3h1v1h6V3h1v11z"/></svg>';

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
        result += text.substring(lastIdx, idx);
        result += '<strong>' + text[idx] + '</strong>';
        lastIdx = idx + 1;
    }
    result += text.substring(lastIdx);
    return result;
}
