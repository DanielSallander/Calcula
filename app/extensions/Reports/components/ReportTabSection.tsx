//! FILENAME: app/extensions/Reports/components/ReportTabSection.tsx
// PURPOSE: The contextual "Report" ribbon tab — registered while the selection
//   sits inside a report region (see reportSelectionHandler). Mirrors the pivot
//   Analyze contextual-tab pattern: a PanelDefinition with hero sections.
// CONTEXT: Composed from @api/layout primitives (Calcula Clusters). Every
//   command is a CommandButton hero with a RibbonIcon, so each section's band
//   content is ONE TALL ROW of 61px heroes (the fill rule in @api/layout
//   tokens.ts); in the sidebar the same heroes render as 28px buttons. The
//   former emotion hero recipe and its emoji/unicode glyph icons are gone.
//
//   E2E contract: the contextual TAB is found as the only <button> whose text is
//   exactly "Report" (e2e/journeys/report-store.spec.ts), so no hero in this
//   tab may be labelled "Report" — the info section shows the report's own name
//   as text, never as a button.

import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { css } from "@emotion/css";
import { showDialog } from "@api";
import type { PanelDefinition, PanelSectionProps } from "@api/uiTypes";
import {
  ActionRow,
  CommandButton,
  FONT_FAMILY,
  GAP_MD,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_MD,
  ICON_SIZE_SM,
  LT,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { EDIT_DIALOG_ID, MANAGE_DIALOG_ID } from "../dialogIds";
import { cellRef } from "../lib/cellRef";
import { deleteReport, refreshOneReport } from "../lib/reportRefresh";
import { refreshReportRegions } from "../lib/reportRegions";
import {
  ACTIVE_REPORT_CHANGED,
  getActiveReport,
} from "../lib/reportSelectionHandler";
import type { ReportInfo } from "../types";
import { confirmAsync, alertAsync } from "@api/dialogs";

const styles = {
  info: css`
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    font-family: ${FONT_FAMILY};
    padding: 0 4px;
    min-width: 0;
  `,
  name: css`
    font-size: 12px;
    font-weight: 600;
    line-height: 16px;
    color: ${LT.text};
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  location: css`
    font-size: 11px;
    line-height: 13px;
    color: ${LT.textSecondary};
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
    <ActionRow gap={GAP_MD}>
      <div className={styles.info} data-testid="report-tab-info">
        <span className={styles.name} title={report.name}>
          {report.name}
        </span>
        <span className={styles.location}>
          at {cellRef(report.anchorRow, report.anchorCol)}
        </span>
      </div>
      <CommandButton
        icon={<RibbonIcon.Pencil size={HERO_ICON_SIZE} />}
        label="Edit Query"
        tooltip="Edit this report's design query"
        data-testid="report-tab-edit-query"
        onClick={() => showDialog(EDIT_DIALOG_ID, { reportId: report.id })}
      />
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
        void alertAsync(`"${report.name}" was not refreshed:\n${result.message ?? "unknown error"}`);
      } else if ((result.overwrittenCellCount ?? 0) > 0) {
        void alertAsync(
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
    if (
      !(await confirmAsync(`Delete report "${report.name}"? Its cells are cleared (Ctrl+Z undoes).`))
    ) {
      return;
    }
    setBusy(true);
    try {
      await deleteReport(report.id);
      await refreshReportRegions();
    } catch (e) {
      void alertAsync(String(e));
    } finally {
      setBusy(false);
    }
  }, [report, busy]);

  if (!report) return null;
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Refresh size={HERO_ICON_SIZE} />}
        label="Refresh"
        tooltip="Re-run the design query"
        data-testid="report-tab-refresh"
        disabled={busy}
        onClick={() => void onRefresh()}
      />
      <CommandButton
        icon={<RibbonIcon.Delete size={HERO_ICON_SIZE} />}
        label="Delete"
        tooltip="Delete the report and clear its cells"
        data-testid="report-tab-delete"
        disabled={busy}
        onClick={() => void onDelete()}
      />
      <CommandButton
        icon={<RibbonIcon.More size={HERO_ICON_SIZE} />}
        label="Manage"
        tooltip="List, refresh or delete any report"
        data-testid="report-tab-manage"
        onClick={() => showDialog(MANAGE_DIALOG_ID, {})}
      />
    </ActionRow>
  );
}

/** The Report tab's accent: the skin's report accent token, falling back to the
 *  Reports dialogs' accent green the tab used before tokens existed. */
const REPORT_TAB_COLOR = "var(--tab-accent-report, #2e7d5b)";

export const REPORT_TAB_ID = "report-tab";

export const ReportPanelDefinition: PanelDefinition = {
  id: REPORT_TAB_ID,
  title: "Report",
  icon: <RibbonIcon.Report size={ICON_SIZE_SM} />,
  sections: [
    {
      id: "report-tab.report",
      label: "Report",
      icon: <RibbonIcon.Report size={ICON_SIZE_MD} />,
      component: ReportInfoSection,
      ribbonPresentation: "inline",
      collapsePriority: 1,
    },
    {
      id: "report-tab.actions",
      label: "Actions",
      icon: <RibbonIcon.Lightning size={ICON_SIZE_MD} />,
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
