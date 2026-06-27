//! FILENAME: app/extensions/_shared/lib/appSettings.ts
// PURPOSE: App-level user settings (localStorage-backed), shared across
//   extensions (Settings owns the UI; FileExplorer reads fileClickAction).
//   Lives in _shared so extensions don't import each other's internals.

const STORAGE_KEY = "calcula.settings";

export type FileOpenMode = "preview" | "taskpane";

export interface CalcuaSettings {
  fileClickAction: FileOpenMode; // "preview" = side panel, "taskpane" = right task pane
}

const defaultSettings: CalcuaSettings = {
  fileClickAction: "preview",
};

/** Event dispatched when settings change. */
export const SETTINGS_CHANGED_EVENT = "calcula:settings-changed";

/** Read settings from localStorage. */
export function getSettings(): CalcuaSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaultSettings, ...parsed };
    }
  } catch {
    // ignore
  }
  return { ...defaultSettings };
}

/** Write settings to localStorage and notify listeners. */
export function saveSettings(settings: CalcuaSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: settings }));
}
