import { Session } from '../shared/session';
import { els, post } from './dom';
import {
    getActiveId,
    getSessions,
    persistOpenTabs,
    saveSession,
    setActiveId
} from './state';
import { renderAll } from './render';

export function renderTabs(): void {
    const activeId = getActiveId();
    els.tabs.innerHTML = '';
    getSessions().forEach(s => {
        const tab = document.createElement('div');
        tab.className = 'tab' + (s.id === activeId ? ' active' : '');
        tab.onclick = () => switchTab(s.id);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'tab-name';
        nameSpan.textContent = s.name;
        nameSpan.title = 'Double-click to rename';
        nameSpan.ondblclick = (e) => { e.stopPropagation(); startRename(s, tab, nameSpan); };
        tab.appendChild(nameSpan);

        const close = document.createElement('span');
        close.className = 'tab-close';
        close.textContent = '\u2715';
        close.title = 'Close tab';
        close.onclick = (e) => { e.stopPropagation(); closeTab(s.id); };
        tab.appendChild(close);

        els.tabs.appendChild(tab);
    });
}

export function switchTab(id: string): void {
    if (id === getActiveId()) return;
    setActiveId(id);
    persistOpenTabs();
    renderAll();
}

export function closeTab(id: string): void {
    const sessions = getSessions();
    const idx = sessions.findIndex(s => s.id === id);
    if (idx < 0) return;
    sessions.splice(idx, 1);
    if (getActiveId() === id) {
        setActiveId(sessions.length ? sessions[Math.max(0, idx - 1)].id : null);
    }
    if (sessions.length === 0) {
        post({ type: 'createSession' });
    } else {
        persistOpenTabs();
        renderAll();
    }
}

function startRename(session: Session, tab: HTMLElement, nameSpan: HTMLElement): void {
    const input = document.createElement('input');
    input.className = 'tab-name-input';
    input.value = session.name;
    tab.replaceChild(input, nameSpan);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (v) {
            session.name = v;
            saveSession(session);
        }
        renderTabs();
    };
    input.onclick = (e) => e.stopPropagation();
    input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { done = true; renderTabs(); }
    };
    input.onblur = commit;
}
