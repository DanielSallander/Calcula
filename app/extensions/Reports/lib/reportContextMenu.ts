//! FILENAME: app/extensions/Reports/lib/reportContextMenu.ts
// PURPOSE: Grid right-click menu items for report regions — visible only when
//   the clicked cell sits inside a report (the pivot context-menu pattern).

import {
  gridExtensions,
  showDialog,
  type GridContextMenuItem,
  type GridMenuContext,
} from "@api";
import { EDIT_DIALOG_ID, MANAGE_DIALOG_ID } from "../dialogIds";
import { findReportAt, refreshReportRegions } from "./reportRegions";
import { deleteReport, refreshOneReport } from "./reportRefresh";

const CONTEXT_ITEM_IDS = [
  "report:editQuery",
  "report:refresh",
  "report:delete",
  "report:manage",
];

function clickedReport(ctx: GridMenuContext) {
  if (!ctx.clickedCell) return null;
  return findReportAt(ctx.clickedCell.row, ctx.clickedCell.col);
}

const isInReportRegion = (ctx: GridMenuContext): boolean => clickedReport(ctx) !== null;

/** Register the report context-menu items. Returns an unregister fn. */
export function registerReportContextMenu(): () => void {
  const items: GridContextMenuItem[] = [
    {
      id: "report:editQuery",
      label: "Edit Design Query…",
      group: "report",
      order: 1,
      visible: isInReportRegion,
      onClick: (ctx) => {
        const report = clickedReport(ctx);
        if (report) showDialog(EDIT_DIALOG_ID, { reportId: report.id });
      },
    },
    {
      id: "report:refresh",
      label: "Refresh Report",
      group: "report",
      order: 2,
      visible: isInReportRegion,
      onClick: async (ctx) => {
        const report = clickedReport(ctx);
        if (!report) return;
        const result = await refreshOneReport(report);
        if (!result.ok) {
          alert(`"${report.name}" was not refreshed:\n${result.message ?? "unknown error"}`);
        } else if ((result.overwrittenCellCount ?? 0) > 0) {
          alert(
            `${result.overwrittenCellCount} existing cell(s) outside the previous report area were overwritten (Ctrl+Z to undo).`,
          );
        }
        await refreshReportRegions();
      },
    },
    {
      id: "report:delete",
      label: "Delete Report",
      group: "report",
      order: 3,
      visible: isInReportRegion,
      onClick: async (ctx) => {
        const report = clickedReport(ctx);
        if (!report) return;
        if (!window.confirm(`Delete report "${report.name}"? Its cells are cleared (Ctrl+Z undoes).`)) {
          return;
        }
        try {
          await deleteReport(report.id);
        } catch (e) {
          alert(String(e));
        }
        await refreshReportRegions();
      },
    },
    {
      id: "report:manage",
      label: "Manage Reports…",
      group: "report",
      order: 4,
      visible: isInReportRegion,
      separatorAfter: true,
      onClick: () => showDialog(MANAGE_DIALOG_ID, {}),
    },
  ];
  gridExtensions.registerContextMenuItems(items);
  return () => {
    for (const id of CONTEXT_ITEM_IDS) gridExtensions.unregisterContextMenuItem(id);
  };
}
