import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ChatSender } from '../shared/session';
import { els } from './dom';
import { getActive, saveActive } from './state';

const GREETING = 'Hello! I am your AI coding assistant. Type @ to mention files in this workspace.';

export function renderMessages(): void {
    els.chatHistory.innerHTML = '';
    const active = getActive();
    if (!active || active.messages.length === 0) {
        const greeting = document.createElement('div');
        greeting.className = 'message ai';
        greeting.textContent = GREETING;
        els.chatHistory.appendChild(greeting);
        return;
    }
    active.messages.forEach(m => renderMessageDom(m.text, m.sender));
}

export function appendMessage(text: string, sender: ChatSender, skipSave = false): HTMLElement {
    const active = getActive();
    if (active && !skipSave) {
        active.messages.push({ sender, text });
        saveActive();
    }
    // Drop the greeting once the first real message arrives.
    if (els.chatHistory.querySelector('.message') && active && active.messages.length === 1) {
        els.chatHistory.innerHTML = '';
    }
    return renderMessageDom(text, sender);
}

export function updateMessageDom(msgDiv: HTMLElement, text: string, sender: ChatSender): void {
    const contentDiv = msgDiv.querySelector('.message-content') as HTMLElement;
    if (!contentDiv) return;
    if (sender === 'ai' || sender === 'tool') {
        contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }));
    } else {
        contentDiv.textContent = text;
    }
    els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

function renderMessageDom(text: string, sender: ChatSender): HTMLElement {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ' + sender;

    const isCollapsed = sender !== 'ai';
    const contentDiv = document.createElement('div');

    if (sender === 'ai' || sender === 'tool') {
        const toolClass = sender === 'tool' ? ' tool-output' : '';
        const collapsedClass = isCollapsed ? ' collapsed' : '';
        contentDiv.className = `message-content markdown${toolClass}${collapsedClass}`;
        contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }));
    } else {
        contentDiv.className = `message-content${isCollapsed ? ' collapsed' : ''}`;
        contentDiv.textContent = text;
    }

    msgDiv.appendChild(contentDiv);
    msgDiv.appendChild(makeToggle(contentDiv, isCollapsed));

    els.chatHistory.appendChild(msgDiv);
    els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    return msgDiv;
}

function makeToggle(contentDiv: HTMLElement, isCollapsed: boolean): HTMLElement {
    const toggleBtn = document.createElement('div');
    toggleBtn.className = 'toggle-btn';
    toggleBtn.textContent = isCollapsed ? 'Show more' : 'Show less';
    toggleBtn.onclick = () => {
        const collapsed = contentDiv.classList.toggle('collapsed');
        toggleBtn.textContent = collapsed ? 'Show more' : 'Show less';
    };
    return toggleBtn;
}
