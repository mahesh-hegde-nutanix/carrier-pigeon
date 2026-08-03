import { Session, SessionSummary } from '../shared/session';
import { els, post } from './dom';
import {
    getActiveId,
    getSessions,
    persistOpenTabs,
    setActiveId
} from './state';
import { renderAll } from './render';
import { cancelCopyForSession } from './mentions';

export function showHistory(sessions: SessionSummary[]): void {
    els.historyList.innerHTML = '';
    if (sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = 'No sessions yet.';
        els.historyList.appendChild(empty);
    }
    sessions.forEach(s => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.onclick = () => openHistoryItem(s.id);

        const left = document.createElement('div');

        const nm = document.createElement('div');
        nm.textContent = s.name;
        left.appendChild(nm);

        if (s.firstMessage) {
            const sub = document.createElement('div');
            sub.className = 'h-subtitle';
            const text = s.firstMessage.trim();
            sub.textContent = text.length > 80 ? text.substring(0, 80) + '...' : text;
            left.appendChild(sub);
        }

        const meta = document.createElement('div');
        meta.className = 'h-meta';
        const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
        meta.textContent = (s.messageCount || 0) + ' messages \u00b7 ' + when;
        left.appendChild(meta);
        item.appendChild(left);

        const del = document.createElement('span');
        del.className = 'h-del';
        del.textContent = '\uD83D\uDDD1';
        del.title = 'Delete';
        del.onclick = (e) => {
            e.stopPropagation();
            post({ type: 'deleteSession', id: s.id });
        };
        item.appendChild(del);

        els.historyList.appendChild(item);
    });
    els.historyOverlay.classList.add('active');
}

function openHistoryItem(id: string): void {
    const existing = getSessions().find(s => s.id === id);
    if (existing) {
        setActiveId(id);
        els.historyOverlay.classList.remove('active');
        persistOpenTabs();
        renderAll();
    } else {
        post({ type: 'loadSession', id });
    }
}

export function openLoadedSession(session: Session): void {
    if (!getSessions().some(s => s.id === session.id)) {
        getSessions().push(session);
    }
    setActiveId(session.id);
    els.historyOverlay.classList.remove('active');
    persistOpenTabs();
    renderAll();
}

export function handleSessionDeleted(id: string, sessions: SessionSummary[]): void {
    cancelCopyForSession(id);
    const open = getSessions();
    const idx = open.findIndex(s => s.id === id);
    if (idx >= 0) {
        open.splice(idx, 1);
        if (getActiveId() === id) {
            setActiveId(open.length ? open[Math.max(0, idx - 1)].id : null);
        }
        if (open.length === 0) {
            post({ type: 'createSession' });
        } else {
            persistOpenTabs();
        }
        renderAll();
    }
    if (els.historyOverlay.classList.contains('active')) {
        showHistory(sessions);
    }
}
