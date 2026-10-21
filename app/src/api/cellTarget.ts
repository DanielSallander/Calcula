//! FILENAME: app/src/api/cellTarget.ts
// PURPOSE: The extension-facing CELL TARGET seam: a door that acts on cells
//          asks WHICH cells -- Core's selection on the active sheet, or an
//          object's own cells (a floating grid's) -- and acts there.
// CONTEXT: P3 (owner finding G3). With a floating grid's cell selected, Core's
//          selection stays on a sheet cell HIDDEN under the grid (BUG-0185), so
//          every Home door was refused there. A selection owner may now answer
//          the cells it holds (`SelectionOwner.cellTarget`) and declare the
//          kinds of act it admits (`actsOn`); the door asks
//          `resolveCellTarget(action, capability)` and passes the answer's
//          `ref` to the wrapper it already calls (`{ target: ref }`). The
//          backend resolves the object's hidden backing sheet in ONE place.
//
// USE, as a DOOR:
//
//     const t = resolveCellTarget("Bold", "format");
//     if (t === null) return;                       // refused and announced
//     const sel = t.kind === "object" ? t.selection : t.selection ?? fallback;
//     await applyFormatting(rows, cols, { bold: true }, { target: targetRefOf(t) });
//
// `targetRefOf` is undefined for the grid target, so ONE call serves both.
// Reads of an object's cells go through `getCellTargetCells` / `readTargetCell`
// (never `getCell`, which reads the active sheet). Imported by its own path.

import { invokeBackend } from "./backend";
import { dispatchGridAction } from "./gridDispatch";
import { AppEvents, emitAppEvent } from "./events";
import { setSelection as setSelectionAction } from "../core/state/gridActions";
import { cellTargetArg } from "../core/lib/tauri-api";
import { getSelectionOwnerById, openGridCellEditor } from "../core/lib/selectionOwner";
import type { CellTarget } from "../core/lib/selectionOwner";
import type {
  CellTargetCells,
  CellTargetRef,
  MergedRegion,
  Selection,
  StyleEntry,
  TargetCellData,
  TypedCellData,
} from "../core/types/types";
import type { CellConditionalFormat, ConditionalFormatDefinition } from "./backend";

export type {
  CellTarget,
  CellTargetCapability,
  OwnedCellTarget,
} from "../core/lib/selectionOwner";
export type { CellTargetRef, CellTargetCells, TargetCellData, TargetCellValueKind } from "../core/types/types";
export type { CellTargetOptions } from "../core/lib/tauri-api";
export {
  resolveCellTarget,
  cellTargetFor,
  CELL_TARGET_CAPABILITIES,
  WHOLE_OBJECT_CAPABILITIES,
} from "../core/lib/selectionOwner";

/** The most cells one `get_cell_target_cells` call returns (Rust `MAX_TYPED_RANGE_CELLS`). */
export const CELL_TARGET_READ_BAND = 100_000;

/** The `target` a wrapper takes for `t`: the object's ref, or undefined for the grid. */
export function targetRefOf(t: CellTarget): CellTargetRef | undefined {
  return t.kind === "object" ? t.ref : undefined;
}

/** A rectangle in the target's own (backing == local) coordinates, inclusive. */
export interface CellTargetRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function mergeKey(m: MergedRegion): string {
  return `${m.startRow}:${m.startCol}:${m.endRow}:${m.endCol}`;
}

/**
 * A styled read of a target's cells: every stored cell (with its display in
 * the app locale, spans, rich text, value kind), the merges, the conditional
 * formats evaluated on the BACKING grid with the rules that produced them, and
 * the styles the cells use. The backend refuses more than
 * `CELL_TARGET_READ_BAND` cells at once, so a larger rectangle is read in
 * bands and joined here. Fails closed (rejects) until the backend accepts the
 * target (`TARGET_COMMANDS`).
 */
export async function getCellTargetCells(ref: CellTargetRef, rect: CellTargetRect): Promise<CellTargetCells> {
  const r0 = Math.max(0, Math.min(rect.startRow, rect.endRow));
  const r1 = Math.max(rect.startRow, rect.endRow);
  const c0 = Math.max(0, Math.min(rect.startCol, rect.endCol));
  const c1 = Math.max(rect.startCol, rect.endCol);
  const placed = cellTargetArg("get_cell_target_cells", { target: ref });

  const cols = c1 - c0 + 1;
  const colBand = Math.min(cols, CELL_TARGET_READ_BAND);
  const rowBand = Math.max(1, Math.floor(CELL_TARGET_READ_BAND / colBand));

  const cells: TargetCellData[] = [];
  const conditional: CellConditionalFormat[] = [];
  const merges = new Map<string, MergedRegion>();
  const styles = new Map<number, StyleEntry>();
  const rules = new Map<number, ConditionalFormatDefinition>();

  for (let br = r0; br <= r1; br += rowBand) {
    const er = Math.min(r1, br + rowBand - 1);
    for (let bc = c0; bc <= c1; bc += colBand) {
      const ec = Math.min(c1, bc + colBand - 1);
      const part = await invokeBackend<CellTargetCells>("get_cell_target_cells", {
        ...placed,
        startRow: br,
        startCol: bc,
        endRow: er,
        endCol: ec,
      });
      cells.push(...(part.cells ?? []));
      conditional.push(...(part.conditional ?? []));
      for (const m of part.merges ?? []) merges.set(mergeKey(m), m);
      for (const st of part.styles ?? []) styles.set(st.index, st);
      for (const rule of part.rules ?? []) rules.set(rule.id, rule);
    }
  }
  return {
    cells,
    merges: [...merges.values()],
    conditional,
    styles: [...styles.values()],
    rules: [...rules.values()],
  };
}

/** One cell of a target (the styled read of a 1x1 rectangle); null when it stores nothing. */
export async function readTargetCell(ref: CellTargetRef, row: number, col: number): Promise<TargetCellData | null> {
  const read = await getCellTargetCells(ref, { startRow: row, startCol: col, endRow: row, endCol: col });
  return read.cells.find((c) => c.row === row && c.col === col) ?? null;
}

/**
 * A TYPED read of a target's cells: the stored values as the engine holds
 * them (the number 5, not its display "5,00") -- what a door that computes
 * from values needs (Fill Series' start number, AutoSum's number runs).
 * `getCellTargetCells` answers display text for painting; this answers
 * values. Sparse (empty cells are omitted), clipped to nothing outside the
 * rectangle, banded at `CELL_TARGET_READ_BAND`. The read is addressed by the
 * object's id, never by a backing sheet index; the kind decides the command
 * here, in the API, so a door names no feature.
 */
export async function getCellTargetCellsTyped(ref: CellTargetRef, rect: CellTargetRect): Promise<TypedCellData[]> {
  if (ref.kind !== "floatingRange") throw new Error(`Unknown cell target kind '${String(ref.kind)}'.`);
  const r0 = Math.max(0, Math.min(rect.startRow, rect.endRow));
  const r1 = Math.max(rect.startRow, rect.endRow);
  const c0 = Math.max(0, Math.min(rect.startCol, rect.endCol));
  const c1 = Math.max(rect.startCol, rect.endCol);
  const cols = c1 - c0 + 1;
  const colBand = Math.min(cols, CELL_TARGET_READ_BAND);
  const rowBand = Math.max(1, Math.floor(CELL_TARGET_READ_BAND / colBand));
  const out: TypedCellData[] = [];
  for (let br = r0; br <= r1; br += rowBand) {
    const er = Math.min(r1, br + rowBand - 1);
    for (let bc = c0; bc <= c1; bc += colBand) {
      const ec = Math.min(c1, bc + colBand - 1);
      const part = await invokeBackend<TypedCellData[]>("get_floating_range_cells", {
        id: ref.id,
        startRow: br,
        startCol: bc,
        endRow: er,
        endCol: ec,
      });
      out.push(...(part ?? []));
    }
  }
  return out;
}

// ============================================================================
// The owner's selection moved
// ============================================================================

const changeListeners = new Set<() => void>();
let changeQueued = false;

function tellChange(): void {
  changeQueued = false;
  // A COPY: a listener may unsubscribe (or subscribe) while being told.
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[cellTarget] change listener threw:", err);
    }
  }
}

/**
 * Hear an owner's cell selection move (or its cells change under a write that
 * went through a target), e.g. to re-read the ribbon's pressed state. Core's
 * own selection moves are heard where they always were. Returns the
 * unsubscribe.
 */
export function onCellTargetChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * Called by an OWNER when its selection moved, and by a write through a target
 * (`announceFormattingResult`). Coalesced to one announcement per microtask.
 */
export function notifyCellTargetChanged(): void {
  if (changeQueued || changeListeners.size === 0) return;
  changeQueued = true;
  queueMicrotask(tellChange);
}

/**
 * A write through `ref` changed the OBJECT itself, not only its cells: its
 * window, line sizes or hidden lines (Insert / Delete Sheet Rows, Row Height,
 * AutoFit, Hide / Unhide on a floating grid's cells). The object's row store
 * is re-read through the domain refresh every row-store write announces
 * (`@api/floatingRanges`), the cells through `grid:refresh`, and the owner's
 * listeners through `notifyCellTargetChanged`. The domain is chosen by the
 * target's KIND here, in the API, so a door names no feature.
 */
export function announceCellTargetObjectChanged(ref: CellTargetRef): void {
  if (ref.kind === "floatingRange") {
    emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["floatingRanges"], source: "commit" });
  }
  window.dispatchEvent(new CustomEvent("grid:refresh"));
  notifyCellTargetChanged();
}

/**
 * The object's own line state for `ref`: its per-line sizes and the lines it
 * hides (local == backing indices). Read from the object's row store; null
 * when the object no longer exists. AutoFit compares against these sizes and
 * Unhide reads these hidden sets -- never the active sheet's, which describe
 * the host under the object.
 */
export interface CellTargetLines {
  rowHeights: Record<number, number>;
  colWidths: Record<number, number>;
  hiddenRows: number[];
  hiddenCols: number[];
}

export async function getCellTargetLines(ref: CellTargetRef): Promise<CellTargetLines | null> {
  if (ref.kind !== "floatingRange") return null;
  const rows = await invokeBackend<FloatingRangeLineRow[]>("list_floating_ranges");
  const row = (rows ?? []).find((r) => r.id === ref.id);
  if (!row) return null;
  return {
    rowHeights: { ...(row.rowHeights ?? {}) },
    colWidths: { ...(row.colWidths ?? {}) },
    hiddenRows: [...(row.hiddenRows ?? [])],
    hiddenCols: [...(row.hiddenCols ?? [])],
  };
}

/** The fields of a floating-range row this module reads (the row store's wire shape). */
interface FloatingRangeLineRow {
  id: string;
  rowHeights?: Record<number, number>;
  colWidths?: Record<number, number>;
  hiddenRows?: number[];
  hiddenCols?: number[];
}

// ============================================================================
// Acting on the target's selection and editor
// ============================================================================

/**
 * Replace the target's selection (Find, Go To Special, a paste result): the
 * owner's own (`SelectionOwner.selectCells`) for an object, Core's for the
 * grid. Coordinates are the target's own.
 */
export function selectTargetCells(t: CellTarget, selection: Selection): void {
  if (t.kind === "object") {
    const owner = getSelectionOwnerById(t.ownerId);
    if (!owner?.selectCells) {
      console.warn(`[cellTarget] '${t.ownerId}' cannot take a selection; nothing was selected.`);
      return;
    }
    try {
      owner.selectCells(selection);
    } catch (err) {
      console.error(`[cellTarget] '${t.ownerId}' selectCells threw:`, err);
    }
    return;
  }
  dispatchGridAction(
    setSelectionAction({
      startRow: selection.startRow,
      startCol: selection.startCol,
      endRow: selection.endRow,
      endCol: selection.endCol,
      type: selection.type,
      additionalRanges: selection.additionalRanges,
    }),
  );
}

/**
 * Open the target's in-cell editor on its active cell with `text` (Insert
 * Function's "=", AutoSum's guess): the owner's own editor for an object
 * (`SelectionOwner.editActiveCell`), Core's for the grid. False when it did
 * not open -- the caller must not fall back to the other editor.
 */
export function editTargetCell(t: CellTarget, text: string): boolean {
  if (t.kind === "object") {
    const owner = getSelectionOwnerById(t.ownerId);
    if (!owner?.editActiveCell) return false;
    try {
      return owner.editActiveCell(text) === true;
    } catch (err) {
      console.error(`[cellTarget] '${t.ownerId}' editActiveCell threw:`, err);
      return false;
    }
  }
  return openGridCellEditor(text);
}
