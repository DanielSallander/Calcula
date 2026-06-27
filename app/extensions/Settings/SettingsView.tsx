//! FILENAME: app/extensions/Settings/SettingsView.tsx
// PURPOSE: Settings panel for the Activity Bar
// CONTEXT: Contains user preferences like file explorer open behavior

import React, { useCallback, useEffect, useState } from "react";
import type { ActivityViewProps } from "@api/uiTypes";
import {
  getLocaleSettings,
  setLocale,
  getSupportedLocales,
  type LocaleSettings,
  type SupportedLocaleEntry,
} from "@api/locale";
import { KeybindingsPage } from "./components/KeybindingsPage";
import { AppearancePage } from "./components/AppearancePage";

const h = React.createElement;

type SettingsTab = "general" | "appearance" | "keybindings";

// ============================================================================
// Settings Storage
// ============================================================================

// App settings live in _shared/lib/appSettings (shared with FileExplorer);
// re-exported here so existing importers of "./SettingsView" keep working.
import {
  getSettings,
  saveSettings,
  type CalcuaSettings,
  type FileOpenMode,
} from "../_shared/lib/appSettings";
export { getSettings, type FileOpenMode };

// ============================================================================
// Settings View Component
// ============================================================================

export function SettingsView(_props: ActivityViewProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<CalcuaSettings>(getSettings);
  const [locale, setLocaleState] = useState<LocaleSettings | null>(null);
  const [supportedLocales, setSupportedLocales] = useState<SupportedLocaleEntry[]>([]);
  const [localeOverride, setLocaleOverride] = useState<string>(
    localStorage.getItem("calcula.locale") || "system"
  );

  // Listen for external changes
  useEffect(() => {
    const handler = () => setSettings(getSettings());
    window.addEventListener("calcula:settings-changed", handler);
    return () => window.removeEventListener("calcula:settings-changed", handler);
  }, []);

  // Load locale settings
  useEffect(() => {
    getLocaleSettings().then(setLocaleState);
    getSupportedLocales().then(setSupportedLocales);
  }, []);

  const updateFileClickAction = useCallback((mode: FileOpenMode) => {
    const next = { ...settings, fileClickAction: mode };
    setSettings(next);
    saveSettings(next);
  }, [settings]);

  const handleLocaleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = (e.target as HTMLSelectElement).value;
    setLocaleOverride(value);
    setLocale(value).then(setLocaleState);
  }, []);

  // Tab bar + content
  return h("div", { style: styles.container },
    // Tab bar
    h("div", { style: styles.tabBar },
      h("button", {
        style: activeTab === "general" ? { ...styles.tab, ...styles.tabActive } : styles.tab,
        onClick: () => setActiveTab("general"),
      }, "General"),
      h("button", {
        style: activeTab === "appearance" ? { ...styles.tab, ...styles.tabActive } : styles.tab,
        onClick: () => setActiveTab("appearance"),
      }, "Appearance"),
      h("button", {
        style: activeTab === "keybindings" ? { ...styles.tab, ...styles.tabActive } : styles.tab,
        onClick: () => setActiveTab("keybindings"),
      }, "Keyboard Shortcuts"),
    ),

    // Appearance tab
    activeTab === "appearance" && h(AppearancePage, null),

    // Keybindings tab
    activeTab === "keybindings" && h(KeybindingsPage, null),

    // General tab
    activeTab === "general" && h("div", { style: styles.generalContent },
    // Section: Regional Settings
    h("div", { style: styles.section },
      h("div", { style: styles.sectionTitle }, "Regional Settings"),

      h("div", { style: styles.setting },
        h("div", { style: styles.settingLabel }, "Locale"),
        h("select", {
          style: styles.select,
          value: localeOverride,
          onChange: handleLocaleChange,
        },
          h("option", { value: "system" }, "System default"),
          ...supportedLocales.map(l =>
            h("option", { key: l.localeId, value: l.localeId }, l.displayName)
          ),
        ),
        h("div", { style: styles.settingHint },
          "Controls decimal separators, formula argument separators, date formats, and currency display."
        ),
      ),

      // Locale preview
      locale && h("div", { style: styles.localePreview },
        h("div", { style: styles.previewRow },
          h("span", { style: styles.previewLabel }, "Decimal separator:"),
          h("span", { style: styles.previewValue },
            locale.decimalSeparator === "." ? '. (period)' :
            locale.decimalSeparator === "," ? ', (comma)' : locale.decimalSeparator
          ),
        ),
        h("div", { style: styles.previewRow },
          h("span", { style: styles.previewLabel }, "Thousands separator:"),
          h("span", { style: styles.previewValue },
            locale.thousandsSeparator === "," ? ', (comma)' :
            locale.thousandsSeparator === "." ? '. (period)' :
            locale.thousandsSeparator === "\u00A0" ? '(space)' :
            locale.thousandsSeparator === "'" ? "' (apostrophe)" :
            locale.thousandsSeparator
          ),
        ),
        h("div", { style: styles.previewRow },
          h("span", { style: styles.previewLabel }, "Formula separator:"),
          h("span", { style: styles.previewValue },
            locale.listSeparator === "," ? ', (comma)  e.g. SUM(A1,B1)' :
            locale.listSeparator === ";" ? '; (semicolon)  e.g. SUM(A1;B1)' :
            locale.listSeparator
          ),
        ),
        h("div", { style: styles.previewRow },
          h("span", { style: styles.previewLabel }, "Date format:"),
          h("span", { style: styles.previewValue }, locale.dateFormat),
        ),
        h("div", { style: styles.previewRow },
          h("span", { style: styles.previewLabel }, "Number example:"),
          h("span", { style: styles.previewValue },
            `1${locale.thousandsSeparator}234${locale.thousandsSeparator}567${locale.decimalSeparator}89`
          ),
        ),
      ),
    ),

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
    ), // end generalContent
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
    overflow: "hidden",
    fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
    backgroundColor: "var(--panel-bg)",
    color: "var(--text-primary)",
  },
  tabBar: {
    display: "flex",
    gap: 0,
    borderBottom: "1px solid var(--border-default)",
    padding: "0 12px",
    flexShrink: 0,
  },
  tab: {
    padding: "10px 16px",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-secondary)",
    backgroundColor: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    cursor: "pointer",
    outline: "none",
  },
  tabActive: {
    color: "var(--text-primary)",
    fontWeight: 600,
    borderBottomColor: "var(--accent-primary)",
  },
  generalContent: {
    flex: 1,
    overflow: "auto",
    padding: "14px 16px",
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    color: "var(--text-secondary)",
    marginBottom: 14,
    paddingBottom: 6,
    borderBottom: "1px solid var(--border-default)",
  },
  setting: {
    marginBottom: 16,
  },
  settingLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-primary)",
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
    color: "var(--text-secondary)",
    cursor: "pointer",
  },
  radioInput: {
    margin: 0,
    cursor: "pointer",
    accentColor: "var(--accent-primary)",
  },
  settingHint: {
    fontSize: 11,
    color: "var(--text-tertiary)",
    marginTop: 10,
    lineHeight: "1.5",
  },
  select: {
    width: "100%",
    padding: "6px 8px",
    fontSize: 12,
    borderRadius: 4,
    border: "1px solid var(--border-default)",
    backgroundColor: "var(--bg-surface)",
    color: "var(--text-primary)",
    cursor: "pointer",
    outline: "none",
  },
  localePreview: {
    marginTop: 12,
    padding: "10px 12px",
    backgroundColor: "var(--bg-surface)",
    borderRadius: 4,
    border: "1px solid var(--border-default)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  previewRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 11,
  },
  previewLabel: {
    color: "var(--text-secondary)",
    fontWeight: 500,
  },
  previewValue: {
    color: "var(--text-primary)",
    fontFamily: "'Cascadia Code', 'Consolas', monospace",
  },
};
