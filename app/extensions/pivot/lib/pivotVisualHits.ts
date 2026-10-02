//! FILENAME: app/extensions/Pivot/lib/pivotVisualHits.ts
// PURPOSE: What each canvas pivot box painted LAST (its box on the canvas, the
//          chrome bounds, the geometry and scroll it was painted with), the
//          pure hit test over it, and the per-box hover state.
// CONTEXT: The cellClicks interceptors never run on a canvas (a press on a
//          floating object is consumed by Core before them), so the +/-, the
//          report-filter combos, the Row/Column Labels buttons and the Cancel
//          button are reached through the overlay hooks instead: `zoneAt` (the
//          press and the pointer; chrome is CONTENT), `floatingObject:bodyDragStart`
//          (the press, which acts when it is RELEASED over the same chrome:
//          pivotChromePress.ts), onDoubleClick, and the document-mousemove hover
//          (`updatePivotVisualHoverAt`, occlusion-aware). All of them ask
//          `hitPivotVisualChrome` against the record of the box under the
//          pointer. The records are this module's own -- the worksheet overlay
//          clears ITS bound maps on every paint.

import type { PivotInteractiveBounds } from "@api/pivotTypes";
import type {
  PivotVisualBox,
  PivotVisualGeometry,
  PivotVisualHover,
  PivotVisualScroll,
} from "../rendering/pivotVisualRenderer";
import { viewCellAtLocal } from "../rendering/pivotVisualRenderer";

/** Extra pixels around the 12px +/- icon (the worksheet overlay uses the same). */
export const VISUAL_ICON_HIT_PADDING = 4;

export interface PivotVisualRecord {
  pivotId: string;
  /** The box in canvas coordinates at the last paint. */
  box: PivotVisualBox;
  /** Box-local chrome bounds (after scroll); null for an empty / unloaded pivot. */
  bounds: PivotInteractiveBounds | null;
  /** The Cancel button of the loading indicator, in canvas coordinates. */
  cancel: { x: number; y: number; width: number; height: number } | null;
  geometry: PivotVisualGeometry | null;
  scroll: PivotVisualScroll;
  /** Hidden-grid anchor: view cell (r, c) is grid cell (startRow + r, startCol + c). */
  startRow: number;
  startCol: number;
}

export type PivotVisualChromeHit =
  | { kind: "cancel" }
  | { kind: "icon"; viewRow: number; viewCol: number; isRow: boolean; key: string }
  | { kind: "headerFilter"; zone: "row" | "column"; viewRow: number; viewCol: number; key: string }
  | { kind: "filter"; fieldIndex: number; viewRow: number; viewCol: number };

const records = new Map<string, PivotVisualRecord>();
const hovers = new Map<string, PivotVisualHover>();

export function setPivotVisualRecord(record: PivotVisualRecord): void {
  records.set(record.pivotId, record);
}

export function getPivotVisualRecord(pivotId: string): PivotVisualRecord | undefined {
  return records.get(pivotId);
}

export function allPivotVisualRecords(): PivotVisualRecord[] {
  return [...records.values()];
}

/** How many boxes have a record -- without copying them (the hover observer asks on every mousemove). */
export function pivotVisualRecordCount(): number {
  return records.size;
}

/** Drop the records of boxes that are no longer published. */
export function prunePivotVisualRecords(livePivotIds: ReadonlySet<string>): void {
  for (const id of [...records.keys()]) {
    if (!livePivotIds.has(id)) records.delete(id);
  }
  for (const id of [...hovers.keys()]) {
    if (!livePivotIds.has(id)) hovers.delete(id);
  }
}

function inside(px: number, py: number, b: { x: number; y: number; width: number; height: number }, pad = 0): boolean {
  return px >= b.x - pad && px <= b.x + b.width + pad && py >= b.y - pad && py <= b.y + b.height + pad;
}

/** Whether a canvas point lies in the record's box. */
export function isInsidePivotVisualBox(record: PivotVisualRecord, canvasX: number, canvasY: number): boolean {
  return inside(canvasX, canvasY, record.box);
}

/**
 * The chrome under a CANVAS point, or null. Bounds are box-local after the
 * scroll, so the point is mapped by the box origin ONLY.
 */
export function hitPivotVisualChrome(
  record: PivotVisualRecord,
  canvasX: number,
  canvasY: number,
): PivotVisualChromeHit | null {
  if (!isInsidePivotVisualBox(record, canvasX, canvasY)) return null;
  if (record.cancel && inside(canvasX, canvasY, record.cancel)) return { kind: "cancel" };
  const b = record.bounds;
  if (!b) return null;

  const lx = canvasX - record.box.x;
  const ly = canvasY - record.box.y;

  for (const [key, icon] of b.expandCollapseIcons) {
    if (inside(lx, ly, icon, VISUAL_ICON_HIT_PADDING)) {
      return { kind: "icon", viewRow: icon.row, viewCol: icon.col, isRow: icon.isRow, key };
    }
  }
  for (const [key, hf] of b.headerFilterButtons) {
    if (inside(lx, ly, hf)) {
      return { kind: "headerFilter", zone: hf.zone, viewRow: hf.row, viewCol: hf.col, key };
    }
  }
  for (const fb of b.filterButtons.values()) {
    if (inside(lx, ly, fb)) {
      return { kind: "filter", fieldIndex: fb.fieldIndex, viewRow: fb.row, viewCol: fb.col };
    }
  }
  return null;
}

/** The view cell under a canvas point (for the double-click), or null. */
export function viewCellAtCanvasPoint(
  record: PivotVisualRecord,
  canvasX: number,
  canvasY: number,
): { viewRow: number; viewCol: number } | null {
  if (!record.geometry || !isInsidePivotVisualBox(record, canvasX, canvasY)) return null;
  return viewCellAtLocal(record.geometry, record.scroll, canvasX - record.box.x, canvasY - record.box.y);
}

// ============================================================================
// Hover
// ============================================================================

export function getPivotVisualHover(pivotId: string): PivotVisualHover | undefined {
  return hovers.get(pivotId);
}

/** The hover a chrome hit implies (what the renderer highlights). */
export function hoverForHit(hit: PivotVisualChromeHit | null): PivotVisualHover {
  if (!hit) return {};
  switch (hit.kind) {
    case "icon":
      return { iconKey: hit.key };
    case "headerFilter":
      return { headerFilterKey: hit.key };
    case "filter":
      return { filterFieldIndex: hit.fieldIndex };
    default:
      return {};
  }
}

function sameHover(a: PivotVisualHover | undefined, b: PivotVisualHover): boolean {
  return (
    (a?.iconKey ?? null) === (b.iconKey ?? null) &&
    (a?.headerFilterKey ?? null) === (b.headerFilterKey ?? null) &&
    (a?.filterFieldIndex ?? null) === (b.filterFieldIndex ?? null)
  );
}

/**
 * Set the hover of one box and clear every other box's. Returns true when
 * anything changed (the caller repaints only then).
 */
export function setPivotVisualHover(pivotId: string | null, hover: PivotVisualHover): boolean {
  let changed = false;
  for (const [id, h] of [...hovers.entries()]) {
    if (id !== pivotId) {
      if (!sameHover(h, {})) changed = true;
      hovers.delete(id);
    }
  }
  if (pivotId !== null) {
    if (!sameHover(hovers.get(pivotId), hover)) changed = true;
    if (sameHover(undefined, hover)) hovers.delete(pivotId);
    else hovers.set(pivotId, hover);
  }
  return changed;
}

/** Whether any box currently shows a hover. */
export function anyPivotVisualHover(): boolean {
  return hovers.size > 0;
}

export function resetPivotVisualHits(): void {
  records.clear();
  hovers.clear();
}
