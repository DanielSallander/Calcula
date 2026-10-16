//! FILENAME: app/extensions/Pivot/lib/pivotChromeActions.ts
// PURPOSE: What a press on a pivot's in-cell chrome DOES -- the +/- toggle,
//          a report-filter combo, a Row/Column Labels filter button and the
//          loading indicator's Cancel -- independent of HOW the press arrived.
// CONTEXT: A worksheet pivot hears the press through its ONE cell click
//          interceptor, which claims it for the release (pivotCellChrome.ts,
//          Core's release seam); a canvas pivot box through Core's content
//          press (its chrome is CONTENT in the box's `zoneAt`, and Core
//          dispatches `floatingObject:bodyDragStart`), because over a floating
//          object the interceptors are never asked (pivotChromePress.ts). On
//          both, the action runs at the press's RELEASE over the same chrome
//          (BUG-0258 phase 4). Both routes call these, so the two cannot drift
//          apart.

import { emitAppEvent } from "@api/events";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { PivotEvents } from "../../_shared/lib/pivotEvents";
import type { PivotViewResponse, PivotRowData, PivotCellData } from "./pivot-api";
import { getPivotAtCell, togglePivotGroup, cancelPivotOperation, getCellDisplayValue } from "./pivot-api";
import {
  getCachedPivotView,
  getCellWindowCache,
  markUserCancelled,
  clearLoading,
  restorePreviousView,
} from "./pivotViewStore";

/**
 * View row `viewRow` of a pivot, windowed-aware: a windowed view carries cells
 * for its first window only, the rest live in the cell-window cache.
 */
export function getPivotViewRow(
  pivotId: string,
  view: PivotViewResponse,
  viewRow: number,
): PivotRowData | null {
  if (view.isWindowed === true) {
    return getCellWindowCache(pivotId)?.getRow(viewRow) ?? null;
  }
  return view.rows[viewRow] ?? null;
}

/** The cached cell at (viewRow, viewCol), or null. */
export function getPivotViewCell(pivotId: string, viewRow: number, viewCol: number): PivotCellData | null {
  const view = getCachedPivotView(pivotId);
  if (!view) return null;
  return getPivotViewRow(pivotId, view, viewRow)?.cells[viewCol] ?? null;
}

/**
 * The item name a pivot cell stands for: its formatted text, or -- when the
 * backend sent none (a text header whose label IS its value, an unformatted
 * numeric header such as the year 2013) -- its value as text. Every menu item
 * and toggle that names an item by its label reads this, so a numeric header
 * is never named "" (BUG-0454).
 */
export function pivotCellLabel(cell: PivotCellData): string {
  return cell.formattedValue || getCellDisplayValue(cell.value);
}

/**
 * The row header that governs view row `viewRow`: the right-most RowHeader
 * among the row-label columns that names an item (carries a group path).
 * Attribute columns are RowHeader cells too but name no item, so they never
 * govern; in a tabular layout the repeated parent labels sit LEFT of the
 * row's own item, so the right-most one is the row's own. Windowed-aware.
 * Null when the row is not cached or no header governs it (a subtotal or
 * grand-total row, a column-header row).
 */
export function governingRowHeader(
  pivotId: string,
  viewRow: number,
): { cell: PivotCellData; viewCol: number } | null {
  const view = getCachedPivotView(pivotId);
  if (!view) return null;
  const row = getPivotViewRow(pivotId, view, viewRow);
  if (!row) return null;
  const limit = Math.min(view.rowLabelColCount ?? 0, row.cells.length);
  for (let c = limit - 1; c >= 0; c--) {
    const cell = row.cells[c];
    if (cell && cell.cellType === "RowHeader" && (cell.groupPath?.length ?? 0) > 0) {
      return { cell, viewCol: c };
    }
  }
  return null;
}

/**
 * The position of a header's field in its zone (what `togglePivotGroup`'s
 * `fieldIndex` means). A compact layout states it as the indent; a tabular or
 * outline layout indents nothing and puts each field in its own column, where
 * the group path (one entry per level down to the item) states it.
 */
function headerZonePosition(header: PivotCellData): number {
  if ((header.indentLevel ?? 0) > 0) return header.indentLevel!;
  const depth = (header.groupPath?.length ?? 0) - 1;
  return depth > 0 ? depth : 0;
}

/**
 * Expand (`expand` true) or collapse the item a header names -- ONLY when its
 * state differs: an item that cannot expand, or is already in that state,
 * sends nothing and answers false. On a change it toggles the exact item by
 * its group path (togglePivotGroup), asks for a refresh and answers true. A
 * backend failure is thrown to the caller (who tells the user).
 */
export async function setPivotItemExpandedAt(
  pivotId: string,
  header: PivotCellData,
  isRow: boolean,
  expand: boolean,
): Promise<boolean> {
  if (!header.isExpandable) return false;
  const collapsed = header.isCollapsed === true;
  if (expand !== collapsed) return false;
  await togglePivotGroup({
    pivotId,
    isRow,
    fieldIndex: headerZonePosition(header),
    value: pivotCellLabel(header),
    groupPath: header.groupPath,
  });
  window.dispatchEvent(new CustomEvent("pivot:refresh"));
  return true;
}

/**
 * Toggle the +/- of the header cell at (viewRow, viewCol). Returns false when
 * the cell is not in the cached view (nothing was sent).
 */
export async function togglePivotHeaderAt(
  pivotId: string,
  viewRow: number,
  viewCol: number,
  isRow: boolean,
): Promise<boolean> {
  const cell = getPivotViewCell(pivotId, viewRow, viewCol);
  if (!cell) return false;

  const itemLabel = pivotCellLabel(cell);
  // In compact layout, all row headers share col 0 but have different indent levels.
  // Use indentLevel to determine the correct field index.
  // For columns, indentLevel carries the column field depth directly.
  const fieldIndex = isRow ? (cell.indentLevel ?? viewCol) : (cell.indentLevel ?? 0);

  try {
    await togglePivotGroup({
      pivotId,
      isRow,
      fieldIndex,
      value: itemLabel,
      // Send full group path so that toggling "Female under Gothenburg"
      // doesn't affect "Female under Stockholm"
      groupPath: cell.groupPath,
    });
    // Trigger refresh to reload pivot data
    window.dispatchEvent(new CustomEvent("pivot:refresh"));
  } catch (error) {
    console.error("[Pivot Extension] Failed to toggle expand/collapse:", error);
  }
  return true;
}

/** A report-filter zone as the backend knows it: what its menu opens on. */
export interface PivotReportFilterZone {
  fieldIndex: number;
  fieldName: string;
  row: number;
  col: number;
}

/**
 * The report-filter zone of the combo at hidden-grid cell (gridRow, gridCol)
 * for `fieldIndex`, or null when the backend knows no such zone. A worksheet
 * press asks this at the PRESS (a combo it cannot serve is not claimed, and
 * the cell is selected as before) and opens the menu at the release
 * (pivotCellChrome.ts).
 */
export async function findPivotReportFilterZone(
  gridRow: number,
  gridCol: number,
  fieldIndex: number,
): Promise<PivotReportFilterZone | null> {
  try {
    const pivotInfo = await getPivotAtCell(gridRow, gridCol);
    if (!pivotInfo?.filterZones) return null;
    for (const zone of pivotInfo.filterZones) {
      if (zone.fieldIndex === fieldIndex) {
        return { fieldIndex: zone.fieldIndex, fieldName: zone.fieldName, row: zone.row, col: zone.col };
      }
    }
  } catch (error) {
    console.error("[Pivot Extension] Failed to check pivot filter:", error);
  }
  return null;
}

/** Open a report filter's menu, anchored at a CLIENT point. */
export function openPivotReportFilterZone(zone: PivotReportFilterZone, anchorX: number, anchorY: number): void {
  emitAppEvent(PivotEvents.PIVOT_OPEN_FILTER_MENU, {
    fieldIndex: zone.fieldIndex,
    fieldName: zone.fieldName,
    row: zone.row,
    col: zone.col,
    anchorX,
    anchorY,
  });
}

/**
 * Open the report-filter menu of the combo at hidden-grid cell (gridRow,
 * gridCol), anchored at a CLIENT point. Returns false when the backend knows
 * no such filter zone.
 */
export async function openPivotReportFilterAt(
  gridRow: number,
  gridCol: number,
  fieldIndex: number,
  anchorX: number,
  anchorY: number,
): Promise<boolean> {
  const zone = await findPivotReportFilterZone(gridRow, gridCol, fieldIndex);
  if (!zone) return false;
  openPivotReportFilterZone(zone, anchorX, anchorY);
  return true;
}

/** Open the Row Labels / Column Labels filter menu, anchored at a CLIENT point. */
export function openPivotHeaderFilter(
  pivotId: string,
  zone: "row" | "column",
  anchorX: number,
  anchorY: number,
): void {
  emitAppEvent(PivotEvents.PIVOT_OPEN_HEADER_FILTER_MENU, {
    pivotId,
    zone,
    anchorX,
    anchorY,
  });
}

/**
 * The loading indicator's Cancel: restore the previous view at once (instant
 * feedback), suppress the in-flight result, and ask the backend to stop.
 */
export function cancelPivotLoading(pivotId: string): void {
  markUserCancelled(pivotId);
  clearLoading(pivotId);
  restorePreviousView(pivotId);
  requestOverlayRedraw();

  // Also tell the backend to cancel (best-effort, may arrive too late)
  cancelPivotOperation(pivotId).catch((err) => {
    console.warn("[Pivot Extension] Cancel failed:", err);
  });
}
