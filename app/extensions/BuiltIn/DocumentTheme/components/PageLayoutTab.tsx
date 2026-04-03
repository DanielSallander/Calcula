//! FILENAME: app/extensions/BuiltIn/DocumentTheme/components/PageLayoutTab.tsx
//! PURPOSE: Page Layout ribbon tab with theme management UI.

import React from "react";
import { css } from "@emotion/css";
import type { RibbonContext } from "@api/extensions";
import { ThemeGallery } from "./ThemeGallery";
import { ThemeFontPicker } from "./ThemeFontPicker";

const styles = {
  container: css`
    display: flex;
    align-items: stretch;
    height: 100%;
    width: 100%;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
  `,
  group: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2px 8px;
    border-right: 1px solid var(--border-default);
    gap: 2px;
  `,
  groupLabel: css`
    font-size: 10px;
    color: var(--text-secondary);
    margin-top: auto;
    padding-top: 2px;
    white-space: nowrap;
  `,
  groupContent: css`
    display: flex;
    gap: 4px;
    align-items: center;
    flex: 1;
  `,
};

export function PageLayoutTab(_props: { context: RibbonContext }): React.ReactElement {
  return (
    <div className={styles.container}>
      {/* Themes Group */}
      <div className={styles.group}>
        <div className={styles.groupContent}>
          <ThemeGallery />
          <ThemeFontPicker />
        </div>
        <div className={styles.groupLabel}>Themes</div>
      </div>
    </div>
  );
}
