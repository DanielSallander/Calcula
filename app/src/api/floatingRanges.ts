//! FILENAME: app/src/api/floatingRanges.ts
// PURPOSE: Typed backend bindings for Floating Ranges — free-floating objects
//          whose content is a REAL range of cells (a hidden backing sheet in
//          the engine, referenced like a sheet: =Float1!A1).
// CONTEXT: The FloatingRange extension is the primary caller; the script broker
//          reaches the same functionality through @api/floatingRangeService.
//          These wrappers are the ONLY place the invoke names + payload shapes
//          live, mirroring api_types.rs (camelCase over IPC per the Golden Rule).
//
// UNDO SEMANTICS (backend-decided, stated here so callers can warn honestly):
//   - create keeps undo history (pure append);
//   - geometry / window-size changes (update_floating_range) are UNDOABLE;
//   - cell writes (update_floating_range_cell) are UNDOABLE;
//   - rename and delete END the undo history (sheet-rename/delete machinery).

import { invokeBackend } from "./backend";
import { AppEvents, emitAppEvent } from "./events";
import { refreshGridData } from "./grid";
import type { TypedCellData } from "../core/types";

// ============================================================================
// Types (mirror Rust FloatingRangeInfo / FloatingRangePatch in api_types.rs)
// ============================================================================

/** One floating range, flattened for IPC. */
export interface FloatingRangeInfo {
  /** EntityId (uuid) of the floating-range object row. */
  id: string;
  /** SheetId of the hidden backing sheet. Its NAME is the FR's name. */
  backingSheetId: string;
  /** SheetId of the sheet the object floats over. */
  hostSheetId: string;
  /** Sheet-pixel position relative to the host sheet's A1 origin. */
  x: number;
  y: number;
  /** RESERVED — always 0 in v1, persisted, never rendered. */
  rotation: number;
  /** RESERVED — always false in v1. */
  pinToGrid: boolean;
  /** Visible window (the grid behind it is sparse; shrink hides, never deletes). */
  rowCount: number;
  colCount: number;
  /** Per-column width overrides (px); absent columns use the default. */
  colWidths: Record<number, number>;
  /** Per-row height overrides (px); absent rows use the default. */
  rowHeights: Record<number, number>;
  /** The FR's name — lives in the SHARED sheet namespace (=Name!A1 works). */
  name: string;
  /** Live index of the backing sheet (for event filtering ONLY, never addressing). */
  backingSheetIndex: number;
  /** Live index of the host sheet (for region filtering by active sheet). */
  hostSheetIndex: number;
}

/** Partial geometry/window update for update_floating_range. */
export interface FloatingRangePatch {
  x?: number;
  y?: number;
  rowCount?: number;
  colCount?: number;
}

/** Backend-enforced window bounds (1..MAX each). */
export const FLOATING_RANGE_MAX_ROWS = 1000;
export const FLOATING_RANGE_MAX_COLS = 256;

// ============================================================================
// Commands
// ============================================================================

/** All floating ranges in the workbook (every sheet). */
export function listFloatingRanges(): Promise<FloatingRangeInfo[]> {
  return invokeBackend<FloatingRangeInfo[]>("list_floating_ranges");
}

/**
 * The floating range ROW STORE changed (create / delete / geometry / window):
 * announced at the WRAPPER, like every backend-state refresh family, so any
 * route through these bindings — the extension's own menus, a test, a future
 * tool — keeps the FloatingRange extension's cached rows honest. The Shell
 * translator fans the domain out to FLOATING_RANGES_CHANGED + grid:refresh.
 */
function announceFloatingRangeRowsChanged(): void {
  emitAppEvent(AppEvents.MUTATION_REFRESH, {
    domains: ["floatingRanges"],
    source: "commit",
  });
}

/**
 * Create a 1x1 floating range on the ACTIVE sheet at sheet-pixel (x, y).
 * Omitted name auto-mints "Float1", "Float2", … in the shared sheet namespace.
 * Keeps undo history (pure append).
 */
export async function createFloatingRange(
  x: number,
  y: number,
  name?: string | null,
): Promise<FloatingRangeInfo> {
  const created = await invokeBackend<FloatingRangeInfo>("create_floating_range", {
    name: name ?? null,
    x,
    y,
  });
  announceFloatingRangeRowsChanged();
  return created;
}

/**
 * Patch geometry (x/y) and/or the visible window (rowCount/colCount).
 * UNDOABLE backend-side; bounds 1..1000 rows, 1..256 cols; a no-op patch
 * records nothing.
 */
export async function updateFloatingRange(
  id: string,
  patch: FloatingRangePatch,
): Promise<FloatingRangeInfo> {
  const info = await invokeBackend<FloatingRangeInfo>("update_floating_range", { id, patch });
  announceFloatingRangeRowsChanged();
  return info;
}

/**
 * Write one cell of the FR's private A1 space (window-bounded; full recalc of
 * dependents in every direction; undoable).
 *
 * Announces at the WRAPPER (the OUTLINE_CHANGED convention): grid formulas that
 * reference this FR were recalculated in the backend, so the visible grid must
 * re-fetch, and extension caches (charts over =Float1!A1, other FRs) must go
 * stale — regardless of which route performed the write.
 */
export async function updateFloatingRangeCell(
  id: string,
  row: number,
  col: number,
  value: string,
  invariant?: boolean,
): Promise<number[]> {
  const result = await invokeBackend<number[]>("update_floating_range_cell", {
    id,
    row,
    col,
    value,
    invariant: invariant ?? null,
  });
  refreshGridData();
  emitAppEvent(AppEvents.CELLS_UPDATED);
  return result;
}

/**
 * Rename the FR (validated against the shared sheet namespace; repairs every
 * formula that referenced the old name). ENDS the undo history.
 */
export async function renameFloatingRange(
  id: string,
  newName: string,
): Promise<FloatingRangeInfo> {
  const info = await invokeBackend<FloatingRangeInfo>("rename_floating_range", { id, newName });
  announceFloatingRangeRowsChanged();
  return info;
}

/**
 * Delete the FR and its backing sheet (references become #REF!, like a sheet
 * delete). ENDS the undo history. Announces at the wrapper: dependent grid
 * cells now hold #REF! and must be re-fetched.
 */
export async function deleteFloatingRange(id: string): Promise<void> {
  await invokeBackend<void>("delete_floating_range", { id });
  announceFloatingRangeRowsChanged();
  refreshGridData();
  emitAppEvent(AppEvents.CELLS_UPDATED);
}

/**
 * Read a rectangle of FR cells with value TYPES preserved — the same sparse
 * typed payload as get_range_cells_typed (only cells that exist come back).
 */
export function getFloatingRangeCells(
  id: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<TypedCellData[]> {
  return invokeBackend<TypedCellData[]>("get_floating_range_cells", {
    id,
    startRow,
    startCol,
    endRow,
    endCol,
  });
}
