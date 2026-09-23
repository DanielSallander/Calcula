//! FILENAME: app/extensions/Settings/SettingsView.tsx
// PURPOSE: Settings panel for the Activity Bar
// CONTEXT: Contains user preferences like file explorer open behavior
//
//          Calcula Clusters: the page switcher is the @api SegmentedTabs strip
//          (role="tablist", arrow keys, one tab stop) and section headers use
//          the one panel header recipe — 12px/600, sentence case — shared with
//          sidebar sections and Group headers. Chrome paints with LT tokens.
//
//          The four tab labels are longer than a 320px panel is wide, so the
//          strip keeps each tab at its natural width and SCROLLS sideways when
//          the panel is narrow (it fills the width when there is room). The
//          selected tab is scrolled into view, which matters for the deep link
//          to Script Security, the last tab.
//
//          E2E CONTRACT: each tab is a <button> whose text is exactly its label
//          (appearance-skins.spec finds `button` with text /^Appearance$/).

import React, { useCallback, useEffect, useRef, useState } from "react";
import { css } from "@emotion/css";
import type { ActivityViewProps } from "@api/uiTypes";
import {
  getLocaleSettings,
  setLocale,
  getSupportedLocales,
  type LocaleSettings,
  type SupportedLocaleEntry,
} from "@api/locale";
import {
  Dropdown,
  FONT_FAMILY,
  FONT_MONO,
  HEADER_FONT_SIZE,
  LT,
  SegmentedTabs,
  type DropdownOption,
  type SegmentedTab,
} from "@api/layout";
import { KeybindingsPage } from "./components/KeybindingsPage";
import { AppearancePage } from "./components/AppearancePage";
import { ScriptSecurityPage } from "./components/ScriptSecurityPage";

export type SettingsTab = "general" | "appearance" | "keybindings" | "scriptSecurity";

/** Window event that selects a Settings tab (detail = SettingsTab). */
export const SETTINGS_SHOW_TAB_EVENT = "calcula:settings-show-tab";

/** The tabs, in strip order. Labels are also the E2E handles (see header). */
const SETTINGS_TABS: ReadonlyArray<SegmentedTab & { id: SettingsTab }> = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "keybindings", label: "Keyboard Shortcuts" },
  { id: "scriptSecurity", label: "Script Security" },
];

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
// Styles
// ============================================================================

const s = {
  container: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    font-family: ${FONT_FAMILY};
    background-color: ${LT.panel};
    color: ${LT.text};
  `,
  /** Scroll host for the strip: sideways only, thin, no layout jump. */
  tabBar: css`
    flex-shrink: 0;
    padding: 10px 12px 8px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    border-bottom: 1px solid ${LT.controlDivider};
  `,
  /** Natural-width tabs that still fill the strip when it is wider. The
   *  primitive fills the panel with inline styles (width 100%, flex 1 per
   *  tab), which would squeeze "Keyboard Shortcuts" into a third of its text;
   *  only !important out-ranks an inline style. */
  tabStrip: css`
    && {
      width: max-content !important;
      min-width: 100%;
    }

    && > [role="tab"] {
      flex: 1 0 auto !important;
    }
  `,
  generalContent: css`
    flex: 1;
    overflow: auto;
    padding: 14px 16px;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 22px;
  `,
  /** The one panel header recipe: 12px/600, sentence case. */
  sectionTitle: css`
    margin: 0;
    font-size: ${HEADER_FONT_SIZE}px;
    font-weight: 600;
    line-height: 16px;
    color: ${LT.text};
  `,
  setting: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  settingLabel: css`
    font-size: 12px;
    font-weight: 500;
    color: ${LT.text};
  `,
  radioGroup: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-left: 2px;
  `,
  radioLabel: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: ${LT.text};
    cursor: pointer;
  `,
  radioInput: css`
    margin: 0;
    cursor: pointer;
    accent-color: ${LT.stateAccent};
  `,
  settingHint: css`
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: ${LT.textSecondary};
  `,
  localePreview: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: ${LT.radiusControl};
    background: ${LT.surface};
    box-shadow: inset 0 0 0 1px ${LT.controlBorder};
  `,
  previewRow: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  `,
  previewLabel: css`
    color: ${LT.textSecondary};
    font-weight: 500;
  `,
  previewValue: css`
    color: ${LT.text};
    font-family: ${FONT_MONO};
    text-align: right;
  `,
};

// ============================================================================
// Helpers
// ============================================================================

function describeDecimal(sep: string): string {
  if (sep === ".") return ". (period)";
  if (sep === ",") return ", (comma)";
  return sep;
}

function describeThousands(sep: string): string {
  if (sep === ",") return ", (comma)";
  if (sep === ".") return ". (period)";
  if (sep === " ") return "(space)";
  if (sep === "'") return "' (apostrophe)";
  return sep;
}

function describeList(sep: string): string {
  if (sep === ",") return ", (comma)  e.g. SUM(A1,B1)";
  if (sep === ";") return "; (semicolon)  e.g. SUM(A1;B1)";
  return sep;
}

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
  const tabBarRef = useRef<HTMLDivElement>(null);

  // Listen for external changes
  useEffect(() => {
    const handler = () => setSettings(getSettings());
    window.addEventListener("calcula:settings-changed", handler);
    return () => window.removeEventListener("calcula:settings-changed", handler);
  }, []);

  // Deep-link: `settings.showTab` (see index.ts) selects a tab so a script
  // prompt's "change it in Settings > Script Security" can actually take the
  // user there instead of leaving them to find it.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<SettingsTab>).detail;
      if (tab) setActiveTab(tab);
    };
    window.addEventListener(SETTINGS_SHOW_TAB_EVENT, handler);
    return () => window.removeEventListener(SETTINGS_SHOW_TAB_EVENT, handler);
  }, []);

  // A narrow panel scrolls the strip; keep the selected tab visible.
  useEffect(() => {
    const selected = tabBarRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    selected?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

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

  const handleLocaleChange = useCallback((value: string) => {
    setLocaleOverride(value);
    setLocale(value).then(setLocaleState);
  }, []);

  const localeOptions: DropdownOption<string>[] = [
    { value: "system", label: "System default" },
    ...supportedLocales.map((l) => ({ value: l.localeId, label: l.displayName })),
  ];

  return (
    <div className={s.container}>
      {/* Tab bar */}
      <div ref={tabBarRef} className={s.tabBar}>
        <SegmentedTabs
          tabs={SETTINGS_TABS}
          value={activeTab}
          onChange={(id) => setActiveTab(id as SettingsTab)}
          ariaLabel="Settings pages"
          testIdPrefix="settings-tab-"
          className={s.tabStrip}
        />
      </div>

      {/* Appearance tab */}
      {activeTab === "appearance" && <AppearancePage />}

      {/* Keybindings tab */}
      {activeTab === "keybindings" && <KeybindingsPage />}

      {/* Script Security tab (the destination every script prompt points at) */}
      {activeTab === "scriptSecurity" && <ScriptSecurityPage />}

      {/* General tab */}
      {activeTab === "general" && (
        <div className={s.generalContent} data-testid="settings-general">
          {/* Section: Regional settings */}
          <section className={s.section} aria-labelledby="settings-regional-heading">
            <h3 id="settings-regional-heading" className={s.sectionTitle}>
              Regional settings
            </h3>

            <div className={s.setting}>
              <div className={s.settingLabel}>Locale</div>
              <Dropdown<string>
                ariaLabel="Locale"
                value={localeOverride}
                options={localeOptions}
                onChange={handleLocaleChange}
                placeholder={localeOverride}
                testId="settings-locale"
                optionTestIdPrefix="settings-locale-"
              />
              <p className={s.settingHint}>
                Controls decimal separators, formula argument separators, date formats, and currency display.
              </p>
            </div>

            {/* Locale preview */}
            {locale && (
              <div className={s.localePreview} data-testid="settings-locale-preview">
                <div className={s.previewRow}>
                  <span className={s.previewLabel}>Decimal separator:</span>
                  <span className={s.previewValue}>{describeDecimal(locale.decimalSeparator)}</span>
                </div>
                <div className={s.previewRow}>
                  <span className={s.previewLabel}>Thousands separator:</span>
                  <span className={s.previewValue}>{describeThousands(locale.thousandsSeparator)}</span>
                </div>
                <div className={s.previewRow}>
                  <span className={s.previewLabel}>Formula separator:</span>
                  <span className={s.previewValue}>{describeList(locale.listSeparator)}</span>
                </div>
                <div className={s.previewRow}>
                  <span className={s.previewLabel}>Date format:</span>
                  <span className={s.previewValue}>{locale.dateFormat}</span>
                </div>
                <div className={s.previewRow}>
                  <span className={s.previewLabel}>Number example:</span>
                  <span className={s.previewValue}>
                    {`1${locale.thousandsSeparator}234${locale.thousandsSeparator}567${locale.decimalSeparator}89`}
                  </span>
                </div>
              </div>
            )}
          </section>

          {/* Section: File Explorer */}
          <section className={s.section} aria-labelledby="settings-explorer-heading">
            <h3 id="settings-explorer-heading" className={s.sectionTitle}>
              File Explorer
            </h3>

            <div className={s.setting}>
              <div className={s.settingLabel} id="settings-file-click-label">
                Single-click opens file in:
              </div>
              <div className={s.radioGroup} role="radiogroup" aria-labelledby="settings-file-click-label">
                <label className={s.radioLabel}>
                  <input
                    type="radio"
                    name="fileClickAction"
                    value="preview"
                    checked={settings.fileClickAction === "preview"}
                    onChange={() => updateFileClickAction("preview")}
                    className={s.radioInput}
                  />
                  <span>Side panel preview</span>
                </label>
                <label className={s.radioLabel}>
                  <input
                    type="radio"
                    name="fileClickAction"
                    value="taskpane"
                    checked={settings.fileClickAction === "taskpane"}
                    onChange={() => updateFileClickAction("taskpane")}
                    className={s.radioInput}
                  />
                  <span>Task pane (right side)</span>
                </label>
              </div>
              <p className={s.settingHint}>
                {settings.fileClickAction === "preview"
                  ? "Single-click previews below the tree. Double-click opens in the task pane."
                  : "Single-click opens directly in the task pane on the right side."}
              </p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
