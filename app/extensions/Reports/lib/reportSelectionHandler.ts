//! FILENAME: app/extensions/Reports/lib/reportSelectionHandler.ts
// PURPOSE: Show/hide the contextual "Report" ribbon tab: registered while the
//   selection's anchor cell sits inside a report region, unregistered when it
//   leaves (the pivot Analyze-tab pattern, via dynamic registerPanel).

import { registerPanel, unregisterPanel } from "@api";
import type { ReportInfo } from "../types";
import { findReportAt, getCachedReport } from "./reportRegions";
import { ReportPanelDefinition, REPORT_TAB_ID } from "../components/ReportTabSection";

/** Window event fired when the active report changes (tab sections re-render). */
export const ACTIVE_REPORT_CHANGED = "calcula-report:activeChanged";

let tabRegistered = false;
let activeReportId: string | null = null;
let activeReportRef: ReportInfo | null = null;
let lastSelection: { row: number; col: number } | null = null;

/** The report the selection currently sits in (fresh from the cache), or null. */
export function getActiveReport(): ReportInfo | null {
  return activeReportId ? getCachedReport(activeReportId) : null;
}

function setActiveReport(report: ReportInfo | null): void {
  // Object identity (not just id): a cache refresh after rename/edit produces a
  // NEW object for the same id — the tab sections must re-render then too.
  const changed = report !== activeReportRef;
  activeReportId = report?.id ?? null;
  activeReportRef = report;
  if (report && !tabRegistered) {
    registerPanel(ReportPanelDefinition);
    tabRegistered = true;
  } else if (!report && tabRegistered) {
    unregisterPanel(REPORT_TAB_ID);
    tabRegistered = false;
  }
  if (changed) {
    window.dispatchEvent(new CustomEvent(ACTIVE_REPORT_CHANGED));
  }
}

/** Called from the extension's selection listener with the anchor cell. */
export function handleReportSelectionChange(
  sel: { startRow: number; startCol: number } | null,
): void {
  lastSelection = sel ? { row: sel.startRow, col: sel.startCol } : null;
  reevaluateActiveReport();
}

/** Re-run the hit test for the last-known selection — called after every
 *  region-cache refresh so a deleted/moved report drops the tab, and a
 *  just-created one under the cursor shows it. */
export function reevaluateActiveReport(): void {
  const report = lastSelection ? findReportAt(lastSelection.row, lastSelection.col) : null;
  setActiveReport(report);
}

/** Unregister + reset (extension deactivate). */
export function resetReportSelectionHandler(): void {
  if (tabRegistered) {
    unregisterPanel(REPORT_TAB_ID);
    tabRegistered = false;
  }
  activeReportId = null;
  activeReportRef = null;
  lastSelection = null;
}
