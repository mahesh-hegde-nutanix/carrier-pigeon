import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ChatSender } from '../shared/session';
import { els } from './dom';
import { getActive, saveActive } from './state';

const GREETING = 'Hello! I am your AI coding assistant. Type @ to mention files in this workspace.';
const COLLAPSE_LINE_LIMIT = 10;

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

export function appendMessage(text: string, sender: ChatSender): HTMLElement {
    const active = getActive();
    if (active) {
        active.messages.push({ sender, text });
        saveActive();
    }
    // Drop the greeting once the first real message arrives.
    if (els.chatHistory.querySelector('.message') && active && active.messages.length === 1) {
        els.chatHistory.innerHTML = '';
    }
    return renderMessageDom(text, sender);
}

function renderMessageDom(text: string, sender: ChatSender): HTMLElement {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ' + sender;

    const contentDiv = document.createElement('div');
    if (sender === 'ai') {
        // AI replies are markdown; render and sanitize them for readability.
        contentDiv.className = 'message-content markdown';
        contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }));
        msgDiv.appendChild(contentDiv);
    } else {
        // User messages are large context/result payloads; keep them plain and
        // collapsible.
        contentDiv.className = 'message-content collapsed';
        contentDiv.textContent = text;
        msgDiv.appendChild(contentDiv);
        if (text.split('\n').length > COLLAPSE_LINE_LIMIT) {
            msgDiv.appendChild(makeToggle(contentDiv));
        }
    }

    els.chatHistory.appendChild(msgDiv);
    els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    return msgDiv;
}

function makeToggle(contentDiv: HTMLElement): HTMLElement {
    const toggleBtn = document.createElement('div');
    toggleBtn.className = 'toggle-btn';
    toggleBtn.textContent = 'Show more';
    toggleBtn.onclick = () => {
        const collapsed = contentDiv.classList.toggle('collapsed');
        toggleBtn.textContent = collapsed ? 'Show more' : 'Show less';
    };
    return toggleBtn;
}
