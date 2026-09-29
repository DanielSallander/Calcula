//! FILENAME: app/extensions/Charts/lib/chartMenuSelection.ts
// PURPOSE: What a RIGHT-CLICK on a chart does to a CANVAS object selection,
//          before the chart menu opens -- so the menu's Copy / Duplicate /
//          Paste (which act on the WHOLE object selection there, W25) act on
//          what the user pointed at -- and those three rows themselves.
// CONTEXT: The right-click handler (index.ts) selected the chart through
//          Charts' own `selectChart`, which leaves every OTHER family's
//          selection alone: a shape selected before a right-click on an
//          unselected chart stayed selected and would have been duplicated
//          with it. And a right-click on a chart the selection SET holds (a
//          second chart) replaced Charts' one chart with it, dropping the
//          first chart out of the multi-selection. On a canvas:
//            - a chart OUTSIDE the selection becomes THE selection, across
//              families (`selectObject`, the press-free select);
//            - a chart INSIDE a multi-selection becomes its primary and the
//              family's current chart (the sub-selection ladder needs it)
//              while every other member stays selected
//              (`setObjectSelectionSet(members, it)`).
//          A worksheet keeps Charts' own select (no selection set there).

import { getGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  getSelectedObjectRegions,
  selectObject,
  setObjectSelectionSet,
} from "@api/objectSelection";
import {
  canvasOwnsObjectClipboard,
  copySelectedObjects,
  duplicateSelectedObjects,
  hasObjectClipboard,
  pasteObjectClipboard,
} from "@api/objectClipboard";
import { isChartSelected } from "../handlers/selectionHandler";

function chartRegion(chartId: string): GridRegion | null {
  return getGridRegions().find((r) => r.type === "chart" && r.data?.chartId === chartId) ?? null;
}

/**
 * On a canvas, make the right-clicked chart part of the object selection the
 * way the menu needs it (see above). Returns true when it acted; on a
 * worksheet (or for a chart with no published region) it does nothing and
 * the caller's own select runs.
 */
export function selectChartForCanvasMenu(chartId: string): boolean {
  if (!canvasOwnsObjectClipboard()) return false;
  const region = chartRegion(chartId);
  if (!region) return false;
  const members = getSelectedObjectRegions();
  if (!members.some((m) => m.id === region.id)) {
    selectObject(region);
  } else if (!isChartSelected(chartId)) {
    setObjectSelectionSet(members, region);
  }
  return true;
}

/** One chart-menu row (the shape ChartContextMenu paints). */
export interface ChartObjectClipboardRow {
  id: string;
  label: string;
  run: () => void;
}

function report(what: string) {
  return (err: unknown): void => {
    console.error(`[Charts] ${what} failed:`, err);
  };
}

/**
 * The chart menu's object rows on a CANVAS -- Duplicate, Copy and (while the
 * object clipboard holds something) Paste -- acting on the WHOLE object
 * selection through the object clipboard, the menu door the canvas keys
 * Ctrl+D / Ctrl+C / Ctrl+V have (lib/canvasClipboard.ts in CanvasSheet). None
 * on a worksheet: there a chart's Ctrl+C is still the grid's.
 */
export function chartObjectClipboardRows(): ChartObjectClipboardRow[] {
  if (!canvasOwnsObjectClipboard()) return [];
  const rows: ChartObjectClipboardRow[] = [
    { id: "duplicateObjects", label: "Duplicate", run: () => void duplicateSelectedObjects().catch(report("Duplicate")) },
    { id: "copyObjects", label: "Copy", run: () => void copySelectedObjects().catch(report("Copy")) },
  ];
  if (hasObjectClipboard()) {
    rows.push({ id: "pasteObjects", label: "Paste", run: () => void pasteObjectClipboard().catch(report("Paste")) });
  }
  return rows;
}
