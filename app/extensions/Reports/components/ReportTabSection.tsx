//! FILENAME: app/extensions/Reports/components/ReportTabSection.tsx
// PURPOSE: The contextual "Report" ribbon tab — registered while the selection
//   sits inside a report region (see reportSelectionHandler). Mirrors the pivot
//   Analyze contextual-tab pattern: a PanelDefinition with big-button sections.

import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { css } from "@emotion/css";
import { showDialog } from "@api";
import type { PanelDefinition } from "@api/uiTypes";
import type { PanelSectionProps } from "@api/uiTypes";
import { ActionRow } from "@api/layout";
import { EDIT_DIALOG_ID, MANAGE_DIALOG_ID } from "../dialogIds";
import { cellRef } from "../lib/cellRef";
import { deleteReport, refreshOneReport } from "../lib/reportRefresh";
import { refreshReportRegions } from "../lib/reportRegions";
import {
  ACTIVE_REPORT_CHANGED,
  getActiveReport,
} from "../lib/reportSelectionHandler";
import type { ReportInfo } from "../types";

const styles = {
  button: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 10px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    font-size: 11px;
    color: var(--text-primary, #333);
    white-space: nowrap;

    &:hover {
      background: var(--button-hover-bg, rgba(0, 0, 0, 0.06));
    }

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `,
  buttonIcon: css`
    font-size: 16px;
    line-height: 1;
  `,
  info: css`
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    padding: 0 4px;
    min-width: 0;
  `,
  name: css`
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary, #333);
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  location: css`
    font-size: 11px;
    color: var(--text-secondary, #666);
    white-space: nowrap;
  `,
};

/** Re-render on active-report changes (selection moved between/out of reports,
 *  region cache refreshed after a rename/edit). */
function useActiveReport(): ReportInfo | null {
  const subscribe = useCallback((notify: () => void) => {
    window.addEventListener(ACTIVE_REPORT_CHANGED, notify);
    return () => window.removeEventListener(ACTIVE_REPORT_CHANGED, notify);
  }, []);
  return useSyncExternalStore(subscribe, getActiveReport);
}

/** "Report" info group: name + anchor, and the query editor entry point. */
export function ReportInfoSection(_props: PanelSectionProps): React.ReactElement | null {
  const report = useActiveReport();
  if (!report) return null;
  return (
    <ActionRow gap={8}>
      <div className={styles.info}>
        <span className={styles.name} title={report.name}>
          {report.name}
        </span>
        <span className={styles.location}>
          at {cellRef(report.anchorRow, report.anchorCol)}
        </span>
      </div>
      <button
        className={styles.button}
        onClick={() => showDialog(EDIT_DIALOG_ID, { reportId: report.id })}
        title="Edit this report's design query"
      >
        <span className={styles.buttonIcon}>✎</span>
        Edit Query
      </button>
    </ActionRow>
  );
}

/** "Actions" group: refresh / delete / manage. */
export function ReportActionsSection(_props: PanelSectionProps): React.ReactElement | null {
  const report = useActiveReport();
  const [busy, setBusy] = useState(false);

  // Reset the busy flag if the active report changes mid-operation.
  useEffect(() => setBusy(false), [report?.id]);

  const onRefresh = useCallback(async () => {
    if (!report || busy) return;
    setBusy(true);
    try {
      const result = await refreshOneReport(report);
      if (!result.ok) {
        alert(`"${report.name}" was not refreshed:\n${result.message ?? "unknown error"}`);
      } else if ((result.overwrittenCellCount ?? 0) > 0) {
        alert(
          `${result.overwrittenCellCount} existing cell(s) outside the previous report area were overwritten (Ctrl+Z to undo).`,
        );
      }
      await refreshReportRegions();
    } finally {
      setBusy(false);
    }
  }, [report, busy]);

  const onDelete = useCallback(async () => {
    if (!report || busy) return;
    if (!window.confirm(`Delete report "${report.name}"? Its cells are cleared (Ctrl+Z undoes).`)) {
      return;
    }
    setBusy(true);
    try {
      await deleteReport(report.id);
      await refreshReportRegions();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  }, [report, busy]);

  if (!report) return null;
  return (
    <ActionRow gap={8}>
      <button className={styles.button} onClick={onRefresh} disabled={busy} title="Re-run the design query">
        <span className={styles.buttonIcon}>↻</span>
        Refresh
      </button>
      <button className={styles.button} onClick={onDelete} disabled={busy} title="Delete the report and clear its cells">
        <span className={styles.buttonIcon}>🗑</span>
        Delete
      </button>
      <button
        className={styles.button}
        onClick={() => showDialog(MANAGE_DIALOG_ID, {})}
        title="List, refresh or delete any report"
      >
        <span className={styles.buttonIcon}>☰</span>
        Manage
      </button>
    </ActionRow>
  );
}

// Accent matches the Reports dialogs' accent green.
const REPORT_TAB_COLOR = "#2e7d5b";

export const REPORT_TAB_ID = "report-tab";

export const ReportPanelDefinition: PanelDefinition = {
  id: REPORT_TAB_ID,
  title: "Report",
  icon: null,
  sections: [
    {
      id: "report-tab.report",
      label: "Report",
      icon: "📄",
      component: ReportInfoSection,
      ribbonPresentation: "inline",
      collapsePriority: 1,
    },
    {
      id: "report-tab.actions",
      label: "Actions",
      icon: "⚡",
      component: ReportActionsSection,
      ribbonPresentation: "inline",
      collapsePriority: 2,
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: 510,
  ribbonColor: REPORT_TAB_COLOR,
  priority: 1000 - 510,
};
