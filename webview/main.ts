import './style.css';
import { HostToWebview } from '../shared/protocol';
import { els, post, revealBooted } from './dom';
import {
    getActive,
    getMentionedFiles,
    getSessions,
    persistOpenTabs,
    saveActive,
    setActiveId,
    setSkills,
    setSessions,
    setWorkspaceFiles
} from './state';
import { renderAll } from './render';
import { appendMessage, updateMessageDom } from './messagesUi';
import { handlePaste, handleToolResults } from './toolsUi';
import { showHistory, openLoadedSession, handleSessionDeleted } from './history';
import { initSettings, showSettings } from './settings';
import { autoResizeTextarea, endCopying, finishPendingCopy, handleSelectionMatchResult, initMentions, prefetchWorkspaceFiles, refreshMentionTrigger, showSymbolResults, updateButtons, setToolRunningState } from './mentions';
import { ContextBuildDetails } from '../shared/protocol';

export function syncModeUI() {
    const active = getActive();
    if (!active) return;
    const mode = active.mode || 'edit';
    els.modeBtnAsk.classList.toggle('active', mode === 'ask');
    els.modeBtnEdit.classList.toggle('active', mode === 'edit');
}

let currentStreamMessage: { text: string, dom: HTMLElement } | null = null;

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
    const message = event.data;
    switch (message.type) {
        case 'initState':
            setSessions(message.sessions);
            setActiveId(message.activeId);
            setSkills(message.skills);
            renderAll();
            revealBooted();
            prefetchWorkspaceFiles();
            break;
        case 'sessionCreated':
            getSessions().push(message.session);
            setActiveId(message.session.id);
            persistOpenTabs();
            renderAll();
            break;
        case 'sessionList':
            showHistory(message.sessions);
            break;
        case 'sessionLoaded':
            openLoadedSession(message.session);
            break;
        case 'sessionDeleted':
            handleSessionDeleted(message.id, message.sessions);
            break;
        case 'fileList':
            setWorkspaceFiles(message.files);
            if (message.purpose === 'copy') {
                finishPendingCopy();
            } else {
                refreshMentionTrigger();
            }
            break;
        case 'symbolList':
            showSymbolResults(message.requestId, message.symbols);
            break;
        case 'contextCopied':
            onContextCopied(message.sessionId, message.text, message.details);
            break;
        case 'pastedMessage':
            if (message.value) handlePaste(message.value);
            break;
        case 'selectionMatchResult':
            handleSelectionMatchResult(message);
            break;
        case 'toolOutputChunk':
            if (!currentStreamMessage) {
                currentStreamMessage = { text: message.chunk, dom: appendMessage(message.chunk, 'tool', true) };
            } else {
                currentStreamMessage.text += message.chunk;
                updateMessageDom(currentStreamMessage.dom, currentStreamMessage.text, 'tool');
            }
            break;
        case 'toolResults':
            if (currentStreamMessage) {
                const active = getActive();
                if (active) {
                    active.messages.push({ sender: 'tool', text: currentStreamMessage.text });
                    saveActive();
                }
                currentStreamMessage = null;
            }
            setToolRunningState(false);
            handleToolResults(message);
            break;
        case 'settingsLoaded':
            showSettings(message.settings);
            break;
    }
});

function onContextCopied(sessionId: string, text: string, details?: ContextBuildDetails): void {
    endCopying(sessionId, details);
    const active = getActive();
    if (!active || active.id !== sessionId) return;
    getMentionedFiles(text).forEach(f => {
        if (!active.mentionedFiles.includes(f)) active.mentionedFiles.push(f);
    });
    active.initialContextCopied = true;
    appendMessage(text, 'user');
    els.chatInput.value = '';
    autoResizeTextarea();
    updateButtons();
}

els.tabNew.onclick = () => post({ type: 'createSession' });
els.tabHistory.onclick = () => post({ type: 'requestSessions' });
els.historyClose.onclick = () => els.historyOverlay.classList.remove('active');

initMentions();
initSettings();

// Ask the extension host for the restored tab state.
post({ type: 'ready' });
