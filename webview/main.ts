import './style.css';
import { HostToWebview } from '../shared/protocol';
import { els, post, revealBooted } from './dom';
import {
    getActive,
    getMentionedFiles,
    getSessions,
    persistOpenTabs,
    setActiveId,
    setSessions,
    setWorkspaceFiles
} from './state';
import { renderAll } from './render';
import { appendMessage } from './messagesUi';
import { handlePaste, handleToolResults } from './toolsUi';
import { showHistory, openLoadedSession, handleSessionDeleted } from './history';
import { initSettings, showSettings } from './settings';
import { autoResizeTextarea, endCopying, finishPendingCopy, initMentions, prefetchWorkspaceFiles, refreshMentionTrigger, updateButtons } from './mentions';

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
    const message = event.data;
    switch (message.type) {
        case 'initState':
            setSessions(message.sessions);
            setActiveId(message.activeId);
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
        case 'contextCopied':
            onContextCopied(message.sessionId, message.text);
            break;
        case 'pastedMessage':
            if (message.value) handlePaste(message.value);
            break;
        case 'toolResults':
            handleToolResults(message);
            break;
        case 'settingsLoaded':
            showSettings(message.settings);
            break;
    }
});

function onContextCopied(sessionId: string, text: string): void {
    endCopying(sessionId);
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
