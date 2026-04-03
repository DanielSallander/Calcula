//! FILENAME: app/extensions/Settings/SettingsView.tsx
// PURPOSE: Settings panel for the Activity Bar
// CONTEXT: Contains user preferences like file explorer open behavior

import React, { useCallback, useEffect, useState } from "react";
import type { ActivityViewProps } from "@api/uiTypes";

const h = React.createElement;

// ============================================================================
// Settings Storage
// ============================================================================

const STORAGE_KEY = "calcula.settings";

export type FileOpenMode = "preview" | "taskpane";

interface CalcuaSettings {
  fileClickAction: FileOpenMode; // "preview" = side panel, "taskpane" = right task pane
}

const defaultSettings: CalcuaSettings = {
  fileClickAction: "preview",
};

/** Read settings from localStorage */
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

/** Write settings to localStorage */
function saveSettings(settings: CalcuaSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  // Notify listeners
  window.dispatchEvent(new CustomEvent("calcula:settings-changed", { detail: settings }));
}

// ============================================================================
// Settings View Component
// ============================================================================

export function SettingsView(_props: ActivityViewProps): React.ReactElement {
  const [settings, setSettings] = useState<CalcuaSettings>(getSettings);

  // Listen for external changes
  useEffect(() => {
    const handler = () => setSettings(getSettings());
    window.addEventListener("calcula:settings-changed", handler);
    return () => window.removeEventListener("calcula:settings-changed", handler);
  }, []);

  const updateFileClickAction = useCallback((mode: FileOpenMode) => {
    const next = { ...settings, fileClickAction: mode };
    setSettings(next);
    saveSettings(next);
  }, [settings]);

  return h("div", { style: styles.container },
    // Section: File Explorer
    h("div", { style: styles.section },
      h("div", { style: styles.sectionTitle }, "File Explorer"),

      h("div", { style: styles.setting },
        h("div", { style: styles.settingLabel }, "Single-click opens file in:"),
        h("div", { style: styles.radioGroup },
          h("label", { style: styles.radioLabel },
            h("input", {
              type: "radio",
              name: "fileClickAction",
              value: "preview",
              checked: settings.fileClickAction === "preview",
              onChange: () => updateFileClickAction("preview"),
              style: styles.radioInput,
            }),
            h("span", null, "Side panel preview"),
          ),
          h("label", { style: styles.radioLabel },
            h("input", {
              type: "radio",
              name: "fileClickAction",
              value: "taskpane",
              checked: settings.fileClickAction === "taskpane",
              onChange: () => updateFileClickAction("taskpane"),
              style: styles.radioInput,
            }),
            h("span", null, "Task pane (right side)"),
          ),
        ),
        h("div", { style: styles.settingHint },
          settings.fileClickAction === "preview"
            ? "Single-click previews below the tree. Double-click opens in the task pane."
            : "Single-click opens directly in the task pane on the right side."
        ),
      ),
    ),

    // Future sections can be added here
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "auto",
    padding: "14px 16px",
    fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    color: "#777",
    marginBottom: 14,
    paddingBottom: 6,
    borderBottom: "1px solid #e0e0e0",
  },
  setting: {
    marginBottom: 16,
  },
  settingLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: "#333",
    marginBottom: 10,
  },
  radioGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginLeft: 2,
  },
  radioLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    color: "#444",
    cursor: "pointer",
  },
  radioInput: {
    margin: 0,
    cursor: "pointer",
    accentColor: "#10b981",
  },
  settingHint: {
    fontSize: 11,
    color: "#999",
    marginTop: 10,
    lineHeight: "1.5",
  },
};
