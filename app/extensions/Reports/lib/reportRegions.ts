//! FILENAME: app/extensions/Reports/lib/reportRegions.ts
// PURPOSE: Frontend cache of report definitions/bounds for synchronous
//   hit-testing — context-menu visibility, the contextual Report ribbon tab,
//   and selection handling all need "is this cell inside a report?" without an
//   IPC round-trip. Mirrors the pivot extension's cached-regions pattern.
// REFRESH: initial load on activate; after every report mutation (the mutating
//   code calls refreshReportRegions()); on raw "grid:refresh" (covers undo/redo
//   restores, debounced); on sheet switch (active-sheet index affects hits).

import { getSheets } from "@api";
import type { ReportInfo } from "../types";
import { listReports } from "./reportRefresh";

let cachedReports: ReportInfo[] = [];
let activeSheetIndex = 0;

/** Called after every cache refresh so the selection handler can re-evaluate
 *  (e.g. hide the Report tab when the selected report was deleted). */
let onChanged: (() => void) | null = null;

export function setReportRegionsChangedCallback(cb: (() => void) | null): void {
  onChanged = cb;
}

/** All cached report definitions (bounds included). */
export function getCachedReports(): ReportInfo[] {
  return cachedReports;
}

/** The report whose region (on the ACTIVE sheet) contains the cell, or null. */
export function findReportAt(row: number, col: number): ReportInfo | null {
  for (const r of cachedReports) {
    if (
      r.sheetIndex === activeSheetIndex &&
      row >= r.anchorRow &&
      row <= r.endRow &&
      col >= r.anchorCol &&
      col <= r.endCol
    ) {
      return r;
    }
  }
  return null;
}

/** A cached report by id, or null. */
export function getCachedReport(reportId: string): ReportInfo | null {
  return cachedReports.find((r) => r.id === reportId) ?? null;
}

/** Re-fetch the definitions + active sheet index. Keeps the stale cache on failure. */
export async function refreshReportRegions(): Promise<void> {
  try {
    const [reports, sheets] = await Promise.all([listReports(), getSheets()]);
    cachedReports = reports;
    activeSheetIndex = sheets.activeIndex ?? 0;
    onChanged?.();
  } catch {
    /* keep the stale cache */
  }
}

let debounceTimer: number | undefined;

/** Debounced refresh for bursty triggers (grid:refresh fires on every edit). */
export function refreshReportRegionsDebounced(): void {
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined;
    void refreshReportRegions();
  }, 200);
}

/** Clear cache + callback (extension deactivate). */
export function resetReportRegions(): void {
  if (debounceTimer) {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  cachedReports = [];
  activeSheetIndex = 0;
  onChanged = null;
}
