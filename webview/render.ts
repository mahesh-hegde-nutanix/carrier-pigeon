import { els } from './dom';
import { getActive } from './state';
import { renderTabs } from './tabs';
import { renderMessages } from './messagesUi';
import { updateButtons } from './mentions';
import { syncModeUI } from './main';

/** Repaints the whole UI (tabs, messages, mode, action buttons) from state. */
export function renderAll(): void {
    renderTabs();
    renderMessages();
    syncModeUI();
    updateButtons();
}
