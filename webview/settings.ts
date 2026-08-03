import { AppSettings, DEFAULT_SETTINGS } from '../shared/settings';
import { els, post } from './dom';

export function openSettings(): void {
    post({ type: 'requestSettings' });
}

/** Fills the form with the given settings and shows the overlay. */
export function showSettings(settings: AppSettings): void {
    els.settingsInstructions.value = settings.customInstructions;
    els.settingsTreeBytes.value = String(settings.maxTreeBytes);
    els.settingsIgnore.value = settings.ignorePatterns.join(', ');
    els.settingsCallGraphTimeout.value = String(settings.callGraphTimeoutMs);
    els.settingsOverlay.classList.add('active');
}

function closeSettings(): void {
    els.settingsOverlay.classList.remove('active');
}

function saveSettings(): void {
    const bytes = parseInt(els.settingsTreeBytes.value, 10);
    const timeout = parseInt(els.settingsCallGraphTimeout.value, 10);
    const settings: AppSettings = {
        customInstructions: els.settingsInstructions.value,
        maxTreeBytes: Number.isNaN(bytes) ? DEFAULT_SETTINGS.maxTreeBytes : bytes,
        ignorePatterns: els.settingsIgnore.value
            .split(',')
            .map(p => p.trim())
            .filter(p => p.length > 0),
        callGraphTimeoutMs: Number.isNaN(timeout) ? DEFAULT_SETTINGS.callGraphTimeoutMs : timeout
    };
    post({ type: 'updateSettings', settings });
    closeSettings();
}

export function initSettings(): void {
    els.tabSettings.onclick = openSettings;
    els.settingsClose.onclick = closeSettings;
    els.settingsSave.onclick = saveSettings;
}
