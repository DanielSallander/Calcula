//! FILENAME: app/src/core/lib/tauri-api.ts
// PURPOSE: TypeScript API wrapper for Tauri backend commands.
// CONTEXT: Provides type-safe functions to invoke Rust commands from the frontend.
// Handles all communication with the Tauri backend including cell operations,
// styling, formatting, function library, and calculation mode.

import { invoke } from "@tauri-apps/api/core";
import type {
  CellData,
  TypedCellData,
  RichTextRun,
  StyleData,
  DimensionData,
  DefaultDimensions,
  FormattingOptions,
  FormattingResult,
  FunctionInfo,
  UpdateCellResult,
  SpillRangeInfo,
  UsedRangeResult,
  ClearApplyTo,
  SplitConfig,
} from "../types";
import { isSheetGroupingActive, getSelectedSheetIndices } from "../state/sheetGrouping";
import { AppEvents, emitAppEvent } from "./events";

/**
 * Announce a row/column insert or delete.
 *
 * Emitted HERE rather than at the call site so EVERY caller announces it. The
 * toolbar path in Spreadsheet.tsx used to emit these by hand, which meant any
 * other caller — Subtotals inserting subtotal rows, DataForm deleting a record
 * — silently skipped the announcement, and every coordinate cache in the app
 * (AutoFilter, Pivot, Table, Review, Hyperlinks, conditional formats, data
 * validations) stayed pinned to pre-edit positions with no way to notice.
 *
 * The payload carries the edit's position and size. It deliberately does NOT
 * carry a sheet index: these commands always act on the ACTIVE sheet, and
 * resolving it here would mean reaching into grid state from the IPC layer.
 */
function emitStructuralEvent(
  event: string,
  detail: { startRow?: number; startCol?: number; count: number },
): void {
  emitAppEvent(event, detail);
}

// ============================================================================
// UDF pre-resolution hook (Inversion of Control)
// ----------------------------------------------------------------------------
// User-defined formula functions (UDFs) have JS implementations, but the Rust
// recalc is synchronous and holds a state lock, so it can never call a JS UDF
// back mid-evaluation. Instead the @api UDF layer installs a resolver here that
// runs BEFORE the write: it asks the backend which UDF calls the pending edits
// will trigger (collect), resolves their JS results off-thread, and returns a
// pre-fetched results table the backend's evaluator then serves. Core stays
// ignorant of @api and of the UDF mechanism — it only invokes the hook when one
// is installed. When no UDFs are registered the hook returns undefined and the
// fast path (no extra IPC) is preserved.
//
// The hook takes a LIST of pending writes because BOTH write paths need it:
// update_cell (one cell) and update_cells_batch (paste, fill handle, multi-cell
// edit). The batch path used to skip pre-resolution entirely, so a freshly
// pasted or filled UDF formula had no pre-fetched result and no stored value to
// preserve — it landed as #NAME?.
// ============================================================================

/** One pending cell write handed to the UDF resolve hook. */
export interface UdfPendingEdit {
  row: number;
  col: number;
  value: string;
  /** When true, the value is already in invariant (US) format (see CellUpdateInput). */
  invariant?: boolean;
}

/** What the resolver hands back: the pre-fetched results table (opaque to Core)
 *  plus the cells calling a VOLATILE UDF, which the backend splices into its
 *  recalc order so they really do recompute. */
export interface UdfResolveResult {
  results: Record<string, unknown>;
  volatileCells: Array<{ row: number; col: number }>;
}

/** A resolver for a set of pending writes, or undefined when there is nothing
 *  to resolve (no UDFs registered, or none reached). */
export type UdfResolveHook = (
  edits: UdfPendingEdit[],
) => Promise<UdfResolveResult | undefined>;

let udfResolveHook: UdfResolveHook | null = null;

/** Installed by the @api UDF layer; pass null to uninstall. */
export function setUdfResolveHook(hook: UdfResolveHook | null): void {
  udfResolveHook = hook;
}

/** Run the installed hook for `edits`. Best-effort by contract: a hook failure
 *  must never block the write (the UDF cells just keep their last value). */
async function resolveUdfsFor(
  edits: UdfPendingEdit[],
): Promise<UdfResolveResult | undefined> {
  if (!udfResolveHook) return undefined;
  try {
    return await udfResolveHook(edits);
  } catch (e) {
    console.warn("[udf] resolve hook failed; proceeding without UDF results", e);
    return undefined;
  }
}

/** Attach the resolver's output to an invoke argument bag (no-op when empty). */
function applyUdfArgs(
  args: Record<string, unknown>,
  resolved: UdfResolveResult | undefined,
): void {
  if (!resolved) return;
  if (Object.keys(resolved.results).length > 0) args.udfResults = resolved.results;
  if (resolved.volatileCells.length > 0) args.udfVolatileCells = resolved.volatileCells;
}

// ============================================================================
// CUBE formula pre-resolution
// ----------------------------------------------------------------------------
// CUBE functions (CUBEVALUE/CUBEMEMBER/...) query a BI model asynchronously, but
// the Rust recalc is synchronous. Like UDFs, we pre-fetch their results BEFORE
// update_cell: the async `cube_prefetch` command resolves every cube call the
// edit affects, and the synchronous evaluator serves the returned table. The
// IPC is gated to cube-bearing edits so ordinary edits stay on the fast path.
// ============================================================================

/** True when a formula input references any CUBE function. Exported for testing. */
export function inputReferencesCube(input: string): boolean {
  return /\bCUBE[A-Z]*\s*\(/i.test(input);
}

// Once a CUBE formula has been entered this session, ANY later edit may feed a
// cube cell (e.g. editing a plain precedent that a CUBEVALUE filters on), so we
// keep pre-fetching. This refreshes cube dependents that a non-cube edit would
// otherwise leave stale. Reset via resetCubeSession() (e.g. on new/blank file).
let sessionHasCube = false;

/** Reset the per-session "workbook has cube formulas" latch. */
export function resetCubeSession(): void {
  sessionHasCube = false;
}

/** Whether a CUBE formula has been seen this session (gates full-recalc prefetch). */
export function workbookHasCubeFormulas(): boolean {
  return sessionHasCube;
}

/** Whether the pending edit should trigger a cube pre-fetch. */
function shouldPrefetchCube(input: string): boolean {
  if (inputReferencesCube(input)) {
    sessionHasCube = true;
    return true;
  }
  return sessionHasCube;
}

// ============================================================================
// Macro-recorder observation hook (Inversion of Control)
// ----------------------------------------------------------------------------
// The macro recorder is an EXTENSION, and Core may never import one. So Core
// exposes a settable observer — the same shape as setUdfResolveHook above — that
// the recorder installs while it is recording and uninstalls when it stops.
// When no hook is installed every call site short-circuits on a null check, so
// the not-recording path costs one comparison.
//
// WHY THE BRIDGE AND NOT THE COMMAND LAYER: the UI commands that drive these
// operations act on the AMBIENT SELECTION ("insert a row" = "insert a row where
// the cursor is"). A macro replayed later has a different selection, so a
// recording taken at the command layer replays somewhere else. Every operation
// below arrives HERE with explicit coordinates, which is exactly what a
// generated script needs. The command layer (api/commands.ts) is observed too,
// but only for actions that never reach this bridge with arguments.
//
// The events are deliberately STRUCTURAL, not textual: Core does not know what
// a "macro" is or which script runtime the recorder will target. It reports
// what happened; the recorder's codegen decides how to say it.
//
// ONE HOOK, TWO FILES: most bridge calls live below, but the sort family
// (sortRange / sortRangeByColumn / removeDuplicates) invokes Tauri from
// app/src/api/backend.ts. It reports through the same exported recordGridEvent,
// so a recording stays complete no matter which file made the call.
// ============================================================================

/** A cell write observed at the bridge, surfaced to the macro recorder. */
export interface RecordedCellWrite {
  row: number;
  col: number;
  value: string;
  /**
   * True when `value` is already in invariant (US) format rather than the
   * user's locale — the batch path's `invariant` flag. The recorder needs this:
   * replaying "1.5" verbatim in a comma-decimal locale would not parse back to
   * the same number, so the generator re-localizes such values.
   */
  invariant?: boolean;
}

/**
 * One sort criterion as the bridge received it.
 *
 * Structurally identical to the facade's `SortField` (app/src/api/backend.ts)
 * and to the object script's `ScriptSortField`, but declared here because Core
 * may not import the facade. `key` is an offset FROM THE RANGE START, not an
 * absolute column — the same convention the backend and the script API use, so
 * the recorder can replay it without re-basing.
 */
export interface RecordedSortField {
  key: number;
  ascending?: boolean;
  sortOn?: "value" | "cellColor" | "fontColor" | "icon";
  color?: string;
  dataOption?: "normal" | "textAsNumber";
  subField?: string;
  customOrder?: string;
}

/**
 * One workbook mutation observed at the IPC bridge, with the arguments the
 * backend actually received. `kind` is the discriminant.
 */
export type RecordedGridEvent =
  | { kind: "cellWrites"; writes: RecordedCellWrite[] }
  | {
      kind: "formatting";
      rows: number[];
      cols: number[];
      formatting: FormattingOptions;
    }
  | {
      kind: "borderPreset";
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      preset: string;
      style: string;
      color: string;
      width: number;
    }
  | {
      kind: "clearRange";
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      applyTo: ClearApplyTo;
    }
  | {
      kind: "fillRange";
      sourceStartRow: number;
      sourceStartCol: number;
      sourceEndRow: number;
      sourceEndCol: number;
      targetStartRow: number;
      targetStartCol: number;
      targetEndRow: number;
      targetEndCol: number;
    }
  | { kind: "insertRows"; startRow: number; count: number }
  | { kind: "deleteRows"; startRow: number; count: number }
  | { kind: "insertColumns"; startCol: number; count: number }
  | { kind: "deleteColumns"; startCol: number; count: number }
  | {
      kind: "mergeCells";
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
    }
  | { kind: "unmergeCells"; row: number; col: number }
  | { kind: "rowHeight"; row: number; height: number }
  | { kind: "columnWidth"; col: number; width: number }
  | { kind: "freezePanes"; freezeRow: number | null; freezeCol: number | null }
  | {
      kind: "replaceAll";
      search: string;
      replacement: string;
      caseSensitive: boolean;
      matchEntireCell: boolean;
    }
  | {
      kind: "sort";
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      /** At least one criterion; `key` is relative to `startRow`/`startCol`. */
      fields: RecordedSortField[];
      matchCase: boolean;
      hasHeaders: boolean;
      orientation: "rows" | "columns";
    }
  | {
      kind: "removeDuplicates";
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      /** ABSOLUTE column indices that form the duplicate key. */
      keyColumns: number[];
      hasHeaders: boolean;
    }
  | { kind: "activateSheet"; index: number }
  | { kind: "addSheet"; index: number; name: string }
  | { kind: "deleteSheet"; index: number }
  | { kind: "renameSheet"; index: number; newName: string };

/** Best-effort observer of workbook mutations for the macro recorder. At most
 *  one is installed (by the recorder while recording); pass null to uninstall.
 *  A failing hook never blocks the operation. */
export type GridRecorderHook = (event: RecordedGridEvent) => void;

let gridRecorderHook: GridRecorderHook | null = null;

/** Installed by the macro recorder while recording; pass null to uninstall. */
export function setGridRecorderHook(hook: GridRecorderHook | null): void {
  gridRecorderHook = hook;
}

/** Whether a recorder is currently observing (lets call sites skip building an
 *  event payload they would only throw away). */
export function isGridRecorderActive(): boolean {
  return gridRecorderHook !== null;
}

/**
 * Report one observed mutation to the installed recorder hook (a no-op when
 * nobody is recording, and never able to fail the operation it observes).
 *
 * Exported because not every bridge call lives in this file: the sort family
 * (`sortRange`, `sortRangeByColumn`, `removeDuplicates`) invokes Tauri from the
 * facade's own command wrappers in `app/src/api/backend.ts`. Those calls have to
 * reach the same single hook, or a recorded macro would silently omit the sort —
 * the worst failure mode for a record-and-replay tool.
 */
export function recordGridEvent(event: RecordedGridEvent): void {
  if (!gridRecorderHook) return;
  try {
    gridRecorderHook(event);
  } catch (e) {
    console.warn("[recorder] grid hook failed; ignoring", e);
  }
}

// ============================================================================
// Cell Operations
// ============================================================================

export function indexToCol(index: number): string {
  let col = "";
  while (index >= 0) {
    col = String.fromCharCode(65 + (index % 26)) + col;
    index = Math.floor(index / 26) - 1;
  }
  return col;
}

export function colToIndex(col: string): number {
  let index = 0;
  for (let i = 0; i < col.length; i++) {
    index = index * 26 + (col.charCodeAt(i) - 64);
  }
  return index - 1;
}

export async function getViewportCells(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<CellData[]> {
  const t0 = performance.now();
  const result = await invoke<CellData[]>("get_viewport_cells", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
  const dt = performance.now() - t0;
  console.log(`[PERF][bridge] getViewportCells(${startRow},${startCol})-(${endRow},${endCol}) => ${result.length} cells | ipc=${dt.toFixed(1)}ms`);
  return result;
}

/**
 * Batch-get cell values from arbitrary sheets (for Watch Window).
 * Each request is [sheetIndex, row, col]. Returns parallel array of results.
 */
export async function getWatchCells(
  requests: [number, number, number][],
): Promise<(CellData | null)[]> {
  return invoke<(CellData | null)[]>("get_watch_cells", { requests });
}

/**
 * Read a rectangle of cells with their VALUE TYPES preserved, in ONE call.
 *
 * The typed counterpart of getViewportCells: the result distinguishes the
 * number 5 from the text "5", surfaces errors as errors, and carries each
 * cell's formula — so a read/modify/write round-trip cannot silently replace a
 * formula with its display text.
 *
 * SPARSE: only cells that exist in the grid come back (callers fill the
 * rectangle themselves). Capped at 100_000 cells per call (backend rejects
 * more). `sheetIndex` defaults to the active sheet.
 */
export async function getRangeCellsTyped(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  sheetIndex?: number,
): Promise<TypedCellData[]> {
  return invoke<TypedCellData[]>("get_range_cells_typed", {
    sheetIndex: sheetIndex ?? null,
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

export async function getCell(row: number, col: number): Promise<CellData | null> {
  const t0 = performance.now();
  const result = await invoke<CellData | null>("get_cell", { row, col });
  const dt = performance.now() - t0;
  if (dt > 1) {
    console.log(`[PERF][bridge] getCell(${row},${col}) | ipc=${dt.toFixed(1)}ms`);
  }
  return result;
}

/** Structured contents of a List or Dict cell. */
export interface CollectionItem {
  type: "scalar" | "list" | "dict";
  display?: string;
  count?: number;
  items?: CollectionItem[];
  entries?: { key: string; value: CollectionItem }[];
}

export interface CollectionPreviewResult {
  cellType: string;
  root?: CollectionItem;
}

export async function getCellCollection(
  row: number,
  col: number,
): Promise<CollectionPreviewResult> {
  return invoke<CollectionPreviewResult>("get_cell_collection", { row, col });
}

/**
 * Batch-get JSON text representations for collection cells.
 * Returns parallel array: JSON string for List/Dict cells, empty string for others.
 */
export async function getCollectionTexts(
  cells: [number, number][],
): Promise<string[]> {
  return invoke<string[]>("get_collection_texts", { cells });
}

export async function updateCell(
  row: number,
  col: number,
  input: string
): Promise<UpdateCellResult> {
  const t0 = performance.now();
  // Pre-resolve any user-defined formula functions the edit will trigger, so the
  // synchronous backend recalc can serve their results (see setUdfResolveHook).
  const udf = await resolveUdfsFor([{ row, col, value: input }]);
  // Pre-resolve any CUBE formulas the edit affects so the synchronous backend
  // recalc can serve their BI-model results. Best-effort: failure must not block
  // the edit (the cube cells just show #N/A until data is available).
  let cubeResults: unknown | undefined;
  if (shouldPrefetchCube(input)) {
    try {
      cubeResults = await invoke("cube_prefetch", { row, col, value: input });
    } catch (e) {
      console.warn("[cube] prefetch failed; proceeding without cube data", e);
    }
  }
  // FIXED: Mapped 'input' to 'value' to match Rust command signature
  const args: Record<string, unknown> = { row, col, value: input };
  applyUdfArgs(args, udf);
  if (cubeResults) args.cubeResults = cubeResults;
  const result = await invoke<UpdateCellResult>("update_cell", args);
  const dt = performance.now() - t0;
  console.log(`[PERF][bridge] updateCell(${row},${col}) => ${result.cells.length} cells | ipc=${dt.toFixed(1)}ms`);
  recordGridEvent({ kind: "cellWrites", writes: [{ row, col, value: input }] });
  return result;
}

/**
 * Input for batch cell updates.
 */
export interface CellUpdateInput {
  row: number;
  col: number;
  value: string;
  /** Optional style index. When provided, overrides the cell's style. */
  styleIndex?: number;
  /** When true, the value is already in invariant (US) format — skip delocalization. */
  invariant?: boolean;
}

/**
 * Batch update multiple cells in a single operation.
 * This is significantly faster than calling updateCell multiple times
 * because it sends all updates in a single IPC call.
 *
 * Runs the SAME UDF pre-resolution pass as `updateCell` — paste, fill handle
 * and multi-cell edits all land here, and without the pass every pasted UDF
 * formula evaluated to #NAME? (nothing pre-fetched, and nothing stored to
 * preserve). The hook itself fast-paths to `undefined` when the workbook has no
 * custom functions, so an ordinary paste costs no extra IPC.
 *
 * @param updates - Array of cell updates with row, col, and value
 * @returns Array of all updated cells (including dependents)
 */
export async function updateCellsBatch(
  updates: CellUpdateInput[]
): Promise<CellData[]> {
  const t0 = performance.now();
  const udf = await resolveUdfsFor(
    updates.map((u) => ({ row: u.row, col: u.col, value: u.value, invariant: u.invariant })),
  );
  const args: Record<string, unknown> = { updates };
  applyUdfArgs(args, udf);
  const result = await invoke<CellData[]>("update_cells_batch", args);
  const dt = performance.now() - t0;
  console.log(`[PERF][bridge] updateCellsBatch(${updates.length}) => ${result.length} cells | ipc=${dt.toFixed(1)}ms`);
  recordGridEvent({
    kind: "cellWrites",
    writes: updates.map((u) => ({
      row: u.row,
      col: u.col,
      value: u.value,
      invariant: u.invariant,
    })),
  });
  return result;
}

export async function clearCell(row: number, col: number): Promise<void> {
  return invoke<void>("clear_cell", { row, col });
}

export async function clearRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<number> {
  const result = await invoke<number>("clear_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
  recordGridEvent({
    kind: "clearRange",
    startRow,
    startCol,
    endRow,
    endCol,
    applyTo: "contents",
  });
  return result;
}

// ClearApplyTo is imported from ../types

/**
 * Clear a range with options for what to clear.
 */
export async function clearRangeWithOptions(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  applyTo: ClearApplyTo = "all"
): Promise<unknown> {
  const result = await invoke("clear_range_with_options", {
    params: {
      startRow,
      startCol,
      endRow,
      endCol,
      applyTo,
    },
  });
  recordGridEvent({ kind: "clearRange", startRow, startCol, endRow, endCol, applyTo });
  return result;
}

/**
 * Clear all hyperlinks in a range.
 */
export async function clearHyperlinksInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<number> {
  return invoke<number>("clear_hyperlinks_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

export async function getGridBounds(): Promise<[number, number]> {
  return invoke<[number, number]>("get_grid_bounds");
}

export async function getCellCount(): Promise<number> {
  return invoke<number>("get_cell_count");
}

export async function getUsedRange(): Promise<UsedRangeResult> {
  return invoke<UsedRangeResult>("get_used_range");
}

/**
 * Get all spill ranges for the active sheet.
 * Returns bounding boxes for dynamic array formula results.
 */
export async function getSpillRanges(): Promise<SpillRangeInfo[]> {
  return invoke<SpillRangeInfo[]>("get_spill_ranges");
}

/**
 * Get all non-empty cells in a row range using sparse iteration.
 * Much faster than getViewportCells for full-width row reads.
 */
export async function getCellsInRows(
  startRow: number,
  endRow: number
): Promise<CellData[]> {
  return invoke<CellData[]>("get_cells_in_rows", { startRow, endRow });
}

/**
 * Get all non-empty cells in a column range using sparse iteration.
 * Much faster than getViewportCells for full-height column reads.
 */
export async function getCellsInCols(
  startCol: number,
  endCol: number
): Promise<CellData[]> {
  return invoke<CellData[]>("get_cells_in_cols", { startCol, endCol });
}

/**
 * Check if any cells with actual content exist in a range.
 * Returns true if any cell has a value or formula (ignores style-only cells).
 */
export async function hasContentInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<boolean> {
  return invoke<boolean>("has_content_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

// ============================================================================
// Navigation Operations
// ============================================================================

export type ArrowDirection = "up" | "down" | "left" | "right";

/**
 * Find the target cell for Ctrl+Arrow navigation (Excel-like behavior).
 * @param row - Current row position
 * @param col - Current column position
 * @param direction - Direction to navigate ("up", "down", "left", "right")
 * @param maxRow - Maximum row index (totalRows - 1)
 * @param maxCol - Maximum column index (totalCols - 1)
 * @returns Target [row, col] position
 */
export async function findCtrlArrowTarget(
  row: number,
  col: number,
  direction: ArrowDirection,
  maxRow: number,
  maxCol: number
): Promise<[number, number]> {
  return invoke<[number, number]>("find_ctrl_arrow_target", {
    row,
    col,
    direction,
    maxRow,
    maxCol,
  });
}

/**
 * Detect the contiguous data region around a cell (Excel's CurrentRegion).
 * Returns [startRow, startCol, endRow, endCol] or null if the cell is isolated/empty.
 */
export async function detectDataRegion(
  row: number,
  col: number
): Promise<[number, number, number, number] | null> {
  return invoke<[number, number, number, number] | null>("detect_data_region", {
    row,
    col,
  });
}

/**
 * Result of getCurrentRegion - structured version of detectDataRegion.
 */
export interface CurrentRegionResult {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  empty: boolean;
}

/**
 * Get the current region around a cell as a structured result.
 * Returns a CurrentRegionResult with `empty: true` if the cell is isolated,
 * or the bounding rectangle of the contiguous data region otherwise.
 */
export async function getCurrentRegion(
  row: number,
  col: number
): Promise<CurrentRegionResult> {
  return invoke<CurrentRegionResult>("get_current_region", { row, col });
}

// ============================================================================
// Dimension Operations
// ============================================================================

export async function setColumnWidth(col: number, width: number): Promise<void> {
  await invoke<void>("set_column_width", { col, width });
  recordGridEvent({ kind: "columnWidth", col, width });
}

export async function getColumnWidth(col: number): Promise<number | null> {
  return invoke<number | null>("get_column_width", { col });
}

export async function getAllColumnWidths(): Promise<DimensionData[]> {
  return invoke<DimensionData[]>("get_all_column_widths");
}

export async function setRowHeight(row: number, height: number): Promise<void> {
  await invoke<void>("set_row_height", { row, height });
  recordGridEvent({ kind: "rowHeight", row, height });
}

export async function getRowHeight(row: number): Promise<number | null> {
  return invoke<number | null>("get_row_height", { row });
}

export async function getAllRowHeights(): Promise<DimensionData[]> {
  return invoke<DimensionData[]>("get_all_row_heights");
}

export async function getDefaultDimensions(): Promise<DefaultDimensions> {
  return invoke<DefaultDimensions>("get_default_dimensions");
}

export async function setDefaultRowHeight(height: number): Promise<DefaultDimensions> {
  return invoke<DefaultDimensions>("set_default_row_height", { height });
}

export async function setDefaultColumnWidth(width: number): Promise<DefaultDimensions> {
  return invoke<DefaultDimensions>("set_default_column_width", { width });
}

// ============================================================================
// Style Operations
// ============================================================================

export async function getStyle(styleIndex: number): Promise<StyleData> {
  // FIXED: Mapped 'styleIndex' to 'style_index' if Rust expects snake_case (standard practice)
  // Assuming get_style(index: usize) in Rust based on context, but keeping key flexible
  // NOTE: get_style definition in commands.rs uses `index`, not `style_index`. Keeping as is based on step 3 file.
  // Rust: pub fn get_style(state: State<AppState>, index: usize) -> StyleData
  return invoke<StyleData>("get_style", { index: styleIndex });
}

export async function getAllStyles(): Promise<StyleData[]> {
  return invoke<StyleData[]>("get_all_styles");
}

/**
 * Point a cell at an existing style index.
 *
 * REJECTS when the cell is locked on a protected sheet. This command takes an
 * arbitrary style index, so it is the sharpest way to change a cell's
 * protection attributes wholesale (Format Painter and Paste-Formats both go
 * through it) — callers must handle the rejection rather than assume success.
 * Resolves to `null` when the target cell does not exist.
 */
export async function setCellStyle(
  row: number,
  col: number,
  styleIndex: number
): Promise<CellData | null> {
  return invoke<CellData | null>("set_cell_style", { row, col, styleIndex });
}

/**
 * Set rich text runs on a cell for partial formatting.
 * Pass null to clear rich text and revert to uniform cell style.
 */
export async function setCellRichText(
  row: number,
  col: number,
  runs: RichTextRun[] | null
): Promise<CellData | null> {
  return invoke<CellData | null>("set_cell_rich_text", { row, col, runs });
}

export async function applyFormatting(
  rows: number[],
  cols: number[],
  formatting: FormattingOptions
): Promise<FormattingResult> {
  console.log(
    "[tauri-api] applyFormatting:",
    `${rows.length} rows x ${cols.length} cols`,
  );
  const result = await invoke<FormattingResult>("apply_formatting", {
    params: {
      rows,
      cols,
      bold: formatting.bold,
      italic: formatting.italic,
      underline: formatting.underline,
      strikethrough: formatting.strikethrough,
      fontSize: formatting.fontSize,
      fontFamily: formatting.fontFamily,
      textColor: formatting.textColor,
      backgroundColor: formatting.backgroundColor,
      textAlign: formatting.textAlign,
      verticalAlign: formatting.verticalAlign,
      numberFormat: formatting.numberFormat,
      wrapText: formatting.wrapText,
      textRotation: formatting.textRotation,
      borderTop: formatting.borderTop,
      borderRight: formatting.borderRight,
      borderBottom: formatting.borderBottom,
      borderLeft: formatting.borderLeft,
      borderDiagonalDown: formatting.borderDiagonalDown,
      borderDiagonalUp: formatting.borderDiagonalUp,
      checkbox: formatting.checkbox,
      button: formatting.button,
      indent: formatting.indent,
      shrinkToFit: formatting.shrinkToFit,
      fill: formatting.fill,
      locked: formatting.locked,
      formulaHidden: formatting.formulaHidden,
    },
  });
  console.log(
    "[tauri-api] applyFormatting result:",
    "cells=",
    result.cells.length,
    "styles=",
    result.styles.length
  );
  recordGridEvent({ kind: "formatting", rows, cols, formatting });

  // Sheet grouping: replicate formatting to all grouped (non-active) sheets
  if (isSheetGroupingActive()) {
    try {
      await applyFormattingToSheets(
        getSelectedSheetIndices(),
        rows,
        cols,
        formatting
      );
      console.log("[tauri-api] Replicated formatting to grouped sheets");
    } catch (err) {
      console.error("[tauri-api] Failed to replicate formatting to grouped sheets:", err);
    }
  }

  return result;
}

export async function getStyleCount(): Promise<number> {
  return invoke<number>("get_style_count");
}

/**
 * Apply a border preset to a rectangular range.
 * @param startRow - First row of range (inclusive)
 * @param startCol - First column of range (inclusive)
 * @param endRow - Last row of range (inclusive)
 * @param endCol - Last column of range (inclusive)
 * @param preset - One of: "insideHorizontal", "insideVertical", "insideBoth", "outside", "allBorders", "none"
 * @param style - Border line style: "solid", "dashed", "dotted", "double"
 * @param color - CSS hex color (e.g. "#000000")
 * @param width - Border width 0-3
 */
export async function applyBorderPreset(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  preset: string,
  style: string,
  color: string,
  width: number
): Promise<FormattingResult> {
  const result = await invoke<FormattingResult>("apply_border_preset", {
    startRow,
    startCol,
    endRow,
    endCol,
    preset,
    style,
    color,
    width,
  });
  recordGridEvent({
    kind: "borderPreset",
    startRow,
    startCol,
    endRow,
    endCol,
    preset,
    style,
    color,
    width,
  });
  return result;
}

// ============================================================================
// Multi-Sheet (Sheet Grouping) Operations
// ============================================================================

/**
 * Replicate a cell value update to multiple non-active sheets.
 * Used when sheet grouping is active.
 */
export async function updateCellOnSheets(
  sheetIndices: number[],
  row: number,
  col: number,
  value: string
): Promise<void> {
  return invoke<void>("update_cell_on_sheets", { sheetIndices, row, col, value });
}

/**
 * Replicate formatting to multiple non-active sheets.
 * Used when sheet grouping is active.
 */
export async function applyFormattingToSheets(
  sheetIndices: number[],
  rows: number[],
  cols: number[],
  formatting: FormattingOptions
): Promise<void> {
  return invoke<void>("apply_formatting_to_sheets", {
    sheetIndices,
    params: {
      rows,
      cols,
      bold: formatting.bold,
      italic: formatting.italic,
      underline: formatting.underline,
      strikethrough: formatting.strikethrough,
      fontSize: formatting.fontSize,
      fontFamily: formatting.fontFamily,
      textColor: formatting.textColor,
      backgroundColor: formatting.backgroundColor,
      textAlign: formatting.textAlign,
      verticalAlign: formatting.verticalAlign,
      numberFormat: formatting.numberFormat,
      wrapText: formatting.wrapText,
      textRotation: formatting.textRotation,
      borderTop: formatting.borderTop,
      borderRight: formatting.borderRight,
      borderBottom: formatting.borderBottom,
      borderLeft: formatting.borderLeft,
      borderDiagonalDown: formatting.borderDiagonalDown,
      borderDiagonalUp: formatting.borderDiagonalUp,
      checkbox: formatting.checkbox,
      button: formatting.button,
      indent: formatting.indent,
      shrinkToFit: formatting.shrinkToFit,
      fill: formatting.fill,
      locked: formatting.locked,
      formulaHidden: formatting.formulaHidden,
    },
  });
}

/**
 * Clear a range of cells on multiple non-active sheets.
 * Used when sheet grouping is active.
 */
export async function clearRangeOnSheets(
  sheetIndices: number[],
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<void> {
  return invoke<void>("clear_range_on_sheets", {
    sheetIndices,
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

// ============================================================================
// Function Library Operations
// ============================================================================

export async function getFunctionsByCategory(
  category: string
): Promise<{ functions: FunctionInfo[] }> {
  return invoke<{ functions: FunctionInfo[] }>("get_functions_by_category", {
    category,
  });
}

export async function getAllFunctions(): Promise<{ functions: FunctionInfo[] }> {
  return invoke<{ functions: FunctionInfo[] }>("get_all_functions");
}

export async function getFunctionTemplate(functionName: string): Promise<string> {
  return invoke<string>("get_function_template", { functionName });
}

// ============================================================================
// Calculation Mode Operations
// ============================================================================

export async function setCalculationMode(mode: "automatic" | "manual"): Promise<string> {
  return invoke<string>("set_calculation_mode", { mode });
}

export async function getCalculationMode(): Promise<string> {
  return invoke<string>("get_calculation_mode");
}

/**
 * Get the current calculation state.
 * Returns "done", "calculating", or "pending".
 */
export async function getCalculationState(): Promise<string> {
  return invoke<string>("get_calculation_state");
}

/**
 * Announce that an explicit recalculation pass finished.
 *
 * Emitted HERE, next to the invoke, so every caller of Calculate Now /
 * Calculate Sheet announces it — the same reasoning as the row/column
 * announcements above. This is the "the workbook is settled" signal; the
 * incremental per-edit recalc is already reported by CELL_VALUES_CHANGED.
 */
function announceRecalcCompleted(
  scope: "workbook" | "sheet",
  cellsUpdated: number,
  startedAt: number,
): void {
  emitAppEvent(AppEvents.RECALCULATION_COMPLETED, {
    scope,
    cellsUpdated,
    durationMs: Math.round(performance.now() - startedAt),
  });
}

async function recalcAll(forceCube: boolean): Promise<CellData[]> {
  // Pre-resolve cube formulas across the sheet so a full recalc refreshes them
  // against current model data (e.g. after a calculated measure changes, or F9).
  // Gated on the workbook having cube formulas (avoids the IPC otherwise) unless
  // forced. Best-effort: a failure must not block the recalc.
  let cubeResults: unknown | undefined;
  if (forceCube || workbookHasCubeFormulas()) {
    try {
      cubeResults = await invoke("cube_prefetch_all", {});
    } catch (e) {
      console.warn("[cube] full prefetch failed; cube cells keep last values", e);
    }
  }
  const startedAt = performance.now();
  const cells = await invoke<CellData[]>("calculate_now", cubeResults ? { cubeResults } : {});
  announceRecalcCompleted("workbook", cells.length, startedAt);
  return cells;
}

export async function calculateNow(): Promise<CellData[]> {
  console.log("[tauri-api] calculateNow - recalculating all formulas");
  const result = await recalcAll(false);
  console.log(`[tauri-api] calculateNow returned ${result.length} updated cells`);
  return result;
}

/** Full recalc that ALWAYS refreshes cube formulas (used after a BI model change
 *  such as adding/editing a calculated measure). */
export async function recalcWithCube(): Promise<CellData[]> {
  return recalcAll(true);
}

export async function calculateSheet(): Promise<CellData[]> {
  console.log("[tauri-api] calculateSheet - recalculating current sheet");
  const startedAt = performance.now();
  const result = await invoke<CellData[]>("calculate_sheet");
  console.log(`[tauri-api] calculateSheet returned ${result.length} updated cells`);
  announceRecalcCompleted("sheet", result.length, startedAt);
  return result;
}

/**
 * Targeted recalc of GET.CONTROLVALUE dependents after a control/ribbon-filter
 * value change. `changedNames` limits the recalc to formulas bound to those
 * control names (case-insensitive); omit to re-evaluate every GET.CONTROLVALUE
 * cell (undo/redo path). Spill-aware on the active sheet — apply the returned
 * cells exactly like calculate_now results (canvas refreshCells + redraw).
 */
export async function recalcControlDependents(
  changedNames?: string[]
): Promise<CellData[]> {
  return invoke<CellData[]>(
    "recalc_control_dependents",
    changedNames ? { changedNames } : {}
  );
}

// ============================================================================
// Iterative Calculation Settings
// ============================================================================

export interface IterationSettings {
  enabled: boolean;
  maxIterations: number;
  maxChange: number;
}

export async function getIterationSettings(): Promise<IterationSettings> {
  return invoke<IterationSettings>("get_iteration_settings");
}

export async function setIterationSettings(
  enabled: boolean,
  maxIterations: number,
  maxChange: number,
): Promise<IterationSettings> {
  return invoke<IterationSettings>("set_iteration_settings", {
    enabled,
    maxIterations,
    maxChange,
  });
}

// ============================================================================
// Precision As Displayed
// ============================================================================

export async function getPrecisionAsDisplayed(): Promise<boolean> {
  return invoke<boolean>("get_precision_as_displayed");
}

export async function setPrecisionAsDisplayed(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_precision_as_displayed", { enabled });
}

// ============================================================================
// Calculate Before Save
// ============================================================================

export async function getCalculateBeforeSave(): Promise<boolean> {
  return invoke<boolean>("get_calculate_before_save");
}

export async function setCalculateBeforeSave(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_calculate_before_save", { enabled });
}

// ============================================================================
// Sheet Operations
// ============================================================================

export type SheetVisibility = "visible" | "hidden" | "veryHidden";

export interface SheetInfo {
  index: number;
  name: string;
  tabColor?: string;
  /** Sheet visibility: "visible", "hidden", or "veryHidden" */
  visibility: SheetVisibility;
}

export interface SheetsResult {
  sheets: SheetInfo[];
  activeIndex: number;
}

export async function getSheets(): Promise<SheetsResult> {
  return invoke<SheetsResult>("get_sheets");
}

export async function getActiveSheet(): Promise<number> {
  return invoke<number>("get_active_sheet");
}

export async function setActiveSheet(index: number): Promise<SheetsResult> {
  const result = await invoke<SheetsResult>("set_active_sheet", { index });
  recordGridEvent({ kind: "activateSheet", index });
  return result;
}

/**
 * Read the sheet list without failing the caller.
 *
 * The sheet-collection events below need the names as they were BEFORE the
 * mutation (a delete's result no longer contains the deleted sheet; a rename's
 * result no longer contains the old name). A failed pre-read must never fail the
 * operation itself, so it degrades to "no previous names known" and the event
 * still fires with whatever is resolvable.
 */
async function sheetNamesBefore(): Promise<SheetInfo[]> {
  try {
    return (await getSheets()).sheets;
  } catch {
    return [];
  }
}

/**
 * Announce a sheet ADDED. Which entry is new is resolved by diffing against the
 * pre-read names rather than trusting activeIndex — add_sheet activates the new
 * sheet today, but a caller that adds without activating must still announce the
 * right one. Sheet names are unique within a workbook, so the diff is exact.
 */
function announceSheetAdded(
  before: SheetInfo[],
  after: SheetsResult,
  source: "new" | "copy",
): void {
  const known = new Set(before.map((s) => s.name));
  const added = after.sheets.find((s) => !known.has(s.name));
  if (!added) return;
  emitAppEvent(AppEvents.SHEET_ADDED, {
    sheetIndex: added.index,
    sheetName: added.name,
    source,
  });
}

export async function addSheet(name?: string): Promise<SheetsResult> {
  const before = await sheetNamesBefore();
  const result = await invoke<SheetsResult>("add_sheet", { name: name ?? null });
  announceSheetAdded(before, result, "new");
  // Recorded with the RESOLVED name/index: add_sheet auto-names when the caller
  // passes none, and a macro that replays "add a sheet called undefined" is
  // useless. Same name-diff the announcement uses (sheet names are unique).
  const known = new Set(before.map((s) => s.name));
  const added = result.sheets.find((s) => !known.has(s.name));
  if (added) {
    recordGridEvent({ kind: "addSheet", index: added.index, name: added.name });
  }
  return result;
}

export async function deleteSheet(index: number): Promise<SheetsResult> {
  const before = await sheetNamesBefore();
  const removed = before.find((s) => s.index === index);
  const result = await invoke<SheetsResult>("delete_sheet", { index });
  emitAppEvent(AppEvents.SHEET_DELETED, {
    sheetIndex: index,
    sheetName: removed?.name ?? "",
  });
  recordGridEvent({ kind: "deleteSheet", index });
  return result;
}

export async function renameSheet(index: number, newName: string): Promise<SheetsResult> {
  const before = await sheetNamesBefore();
  const oldName = before.find((s) => s.index === index)?.name ?? "";
  const result = await invoke<SheetsResult>("rename_sheet", { index, newName });
  emitAppEvent(AppEvents.SHEET_RENAMED, { sheetIndex: index, oldName, newName });
  recordGridEvent({ kind: "renameSheet", index, newName });
  return result;
}

export async function moveSheet(fromIndex: number, toIndex: number): Promise<SheetsResult> {
  return invoke<SheetsResult>("move_sheet", { fromIndex, toIndex });
}

export async function copySheet(sourceIndex: number, newName?: string): Promise<SheetsResult> {
  const before = await sheetNamesBefore();
  const result = await invoke<SheetsResult>("copy_sheet", {
    sourceIndex,
    newName: newName ?? null,
  });
  announceSheetAdded(before, result, "copy");
  return result;
}

export async function hideSheet(index: number, level?: "hidden" | "veryHidden"): Promise<SheetsResult> {
  return invoke<SheetsResult>("hide_sheet", { index, level: level ?? null });
}

export async function unhideSheet(index: number): Promise<SheetsResult> {
  return invoke<SheetsResult>("unhide_sheet", { index });
}

export async function setTabColor(index: number, color: string): Promise<SheetsResult> {
  return invoke<SheetsResult>("set_tab_color", { index, color });
}

export async function nextSheet(): Promise<SheetsResult> {
  return invoke<SheetsResult>("next_sheet");
}

export async function previousSheet(): Promise<SheetsResult> {
  return invoke<SheetsResult>("previous_sheet");
}

/**
 * Insert rows at the specified position, shifting existing rows down.
 * @param row - The row index where new rows will be inserted
 * @param count - Number of rows to insert
 */
export async function insertRows(row: number, count: number): Promise<CellData[]> {
  console.log(`[tauri-api] insertRows(${row}, ${count})`);
  const result = await invoke<CellData[]>("insert_rows", { row, count });
  console.log(`[tauri-api] insertRows returned ${result.length} updated cells`);
  emitStructuralEvent(AppEvents.ROWS_INSERTED, { startRow: row, count });
  recordGridEvent({ kind: "insertRows", startRow: row, count });
  return result;
}

/**
 * Insert columns at the specified position, shifting existing columns right.
 * @param col - The column index where new columns will be inserted
 * @param count - Number of columns to insert
 */
export async function insertColumns(col: number, count: number): Promise<CellData[]> {
  console.log(`[tauri-api] insertColumns(${col}, ${count})`);
  const result = await invoke<CellData[]>("insert_columns", { col, count });
  console.log(`[tauri-api] insertColumns returned ${result.length} updated cells`);
  emitStructuralEvent(AppEvents.COLUMNS_INSERTED, { startCol: col, count });
  recordGridEvent({ kind: "insertColumns", startCol: col, count });
  return result;
}

/**
 * Delete rows at the specified position, shifting remaining rows up.
 * @param row - The row index where deletion starts
 * @param count - Number of rows to delete
 */
export async function deleteRows(row: number, count: number): Promise<CellData[]> {
  console.log(`[tauri-api] deleteRows(${row}, ${count})`);
  const result = await invoke<CellData[]>("delete_rows", { row, count });
  console.log(`[tauri-api] deleteRows returned ${result.length} updated cells`);
  emitStructuralEvent(AppEvents.ROWS_DELETED, { startRow: row, count });
  recordGridEvent({ kind: "deleteRows", startRow: row, count });
  return result;
}

/**
 * Delete columns at the specified position, shifting remaining columns left.
 * @param col - The column index where deletion starts
 * @param count - Number of columns to delete
 */
export async function deleteColumns(col: number, count: number): Promise<CellData[]> {
  console.log(`[tauri-api] deleteColumns(${col}, ${count})`);
  const result = await invoke<CellData[]>("delete_columns", { col, count });
  console.log(`[tauri-api] deleteColumns returned ${result.length} updated cells`);
  emitStructuralEvent(AppEvents.COLUMNS_DELETED, { startCol: col, count });
  recordGridEvent({ kind: "deleteColumns", startCol: col, count });
  return result;
}

// ============================================================================
// Undo/Redo Operations
// ============================================================================

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
  /** Number of transactions available to undo (used by test oracles). */
  undoDepth: number;
  /** Number of transactions available to redo (used by test oracles). */
  redoDepth: number;
  /**
   * Whether an undo transaction is currently OPEN (begin without commit).
   * Probe this before grouping your own writes: beginUndoTransaction is a
   * no-op while a transaction is open, so an unconditional commit would close
   * someone else's group early.
   */
  transactionOpen: boolean;
}

export interface UndoResult {
  success: boolean;
  description: string | null;
  updatedCells: CellData[];
  canUndo: boolean;
  canRedo: boolean;
  mergeChanged: boolean;
  structuralRestore: boolean;
  pivotChanged: boolean;
  slicerChanged: boolean;
  ribbonFilterChanged: boolean;
  /** Pane controls (Controls pane) restored — GET.CONTROLVALUE dependents
   *  need a targeted recalc. */
  paneControlChanged: boolean;
  /** Object state restored (charts, sparklines, tables, autofilters,
   *  validation, named ranges, freeze panes) — stores must refresh. */
  objectsChanged: boolean;
}

/**
 * Begin an undo transaction. All subsequent cell changes will be grouped
 * into a single undoable action until commitUndoTransaction() is called.
 * @param description - Human-readable label for the transaction (e.g., "Paste 10 cells")
 */
export async function beginUndoTransaction(description: string): Promise<void> {
  return invoke<void>("begin_undo_transaction", { description });
}

/**
 * Commit the current undo transaction, finalizing it as a single undo entry.
 */
export async function commitUndoTransaction(): Promise<void> {
  return invoke<void>("commit_undo_transaction");
}

/**
 * Cancel the current undo transaction without saving it.
 */
export async function cancelUndoTransaction(): Promise<void> {
  return invoke<void>("cancel_undo_transaction");
}

/**
 * Get the current undo/redo state.
 */
export async function getUndoState(): Promise<UndoState> {
  return invoke<UndoState>("get_undo_state");
}

/**
 * Undo the last action.
 */
export async function undo(): Promise<UndoResult> {
  console.log("[tauri-api] undo");
  const result = await invoke<UndoResult>("undo");
  console.log(`[tauri-api] undo returned ${result.updatedCells.length} updated cells, canUndo=${result.canUndo}, canRedo=${result.canRedo}`);
  return result;
}

/**
 * Redo the last undone action.
 */
export async function redo(): Promise<UndoResult> {
  console.log("[tauri-api] redo");
  const result = await invoke<UndoResult>("redo");
  console.log(`[tauri-api] redo returned ${result.updatedCells.length} updated cells, canUndo=${result.canUndo}, canRedo=${result.canRedo}`);
  return result;
}

// ============================================================================
// Find & Replace Operations
// ============================================================================

export interface FindResult {
  matches: [number, number][];
  totalCount: number;
}

export interface ReplaceResult {
  updatedCells: CellData[];
  replacementCount: number;
}

export interface FindOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
  searchFormulas?: boolean;
}

/**
 * Find all cells matching the search query.
 * Returns coordinates sorted in reading order (row, then column).
 */
export async function findAll(
  query: string,
  options: FindOptions = {}
): Promise<FindResult> {
  const {
    caseSensitive = false,
    matchEntireCell = false,
    searchFormulas = false,
  } = options;

  return invoke<FindResult>("find_all", {
    query,
    caseSensitive,
    matchEntireCell,
    searchFormulas,
  });
}

/**
 * Count matches without returning coordinates (faster for display).
 */
export async function countMatches(
  query: string,
  options: FindOptions = {}
): Promise<number> {
  const {
    caseSensitive = false,
    matchEntireCell = false,
    searchFormulas = false,
  } = options;

  return invoke<number>("count_matches", {
    query,
    caseSensitive,
    matchEntireCell,
    searchFormulas,
  });
}

/**
 * Replace all occurrences. This is an atomic operation for undo.
 */
export async function replaceAll(
  search: string,
  replacement: string,
  options: { caseSensitive?: boolean; matchEntireCell?: boolean } = {}
): Promise<ReplaceResult> {
  const { caseSensitive = false, matchEntireCell = false } = options;

  console.log(
    `[tauri-api] replaceAll("${search}" -> "${replacement}", caseSensitive=${caseSensitive})`
  );

  const result = await invoke<ReplaceResult>("replace_all", {
    search,
    replacement,
    caseSensitive,
    matchEntireCell,
  });

  console.log(
    `[tauri-api] replaceAll completed: ${result.replacementCount} replacements`
  );

  recordGridEvent({
    kind: "replaceAll",
    search,
    replacement,
    caseSensitive,
    matchEntireCell,
  });
  return result;
}

/**
 * Replace a single occurrence in a specific cell.
 */
export async function replaceSingle(
  row: number,
  col: number,
  search: string,
  replacement: string,
  caseSensitive: boolean = false
): Promise<CellData | null> {
  return invoke<CellData | null>("replace_single", {
    row,
    col,
    search,
    replacement,
    caseSensitive,
  });
}


// ============================================================================
// FREEZE PANES API
// ============================================================================

export interface FreezeConfig {
  freezeRow: number | null;
  freezeCol: number | null;
}

export async function setFreezePanes(
  freezeRow: number | null,
  freezeCol: number | null
): Promise<SheetsResult> {
  console.log('[tauri-api] setFreezePanes called with:', { freezeRow, freezeCol });
  const result = await invoke<SheetsResult>("set_freeze_panes", { freezeRow, freezeCol });
  console.log('[tauri-api] setFreezePanes result:', result);
  recordGridEvent({ kind: "freezePanes", freezeRow, freezeCol });
  return result;
}

export async function getFreezePanes(): Promise<FreezeConfig> {
  console.log('[tauri-api] getFreezePanes called');
  const result = await invoke<FreezeConfig>("get_freeze_panes", {});
  console.log('[tauri-api] getFreezePanes result:', result);
  return result;
}

// ============================================================================
// SPLIT WINDOW API
// ============================================================================

// SplitConfig is imported from ../types

export async function setSplitWindow(
  splitRow: number | null,
  splitCol: number | null
): Promise<void> {
  await invoke<void>("set_split_window", { splitRow, splitCol });
}

export async function getSplitWindow(): Promise<SplitConfig> {
  return await invoke<SplitConfig>("get_split_window", {});
}

// ============================================================================
// SCROLL AREA API
// ============================================================================

/**
 * Set the scrollable area restriction for the active sheet.
 * @param scrollArea - A1-style range like "A1:Z100", or null to clear.
 */
export async function setScrollArea(scrollArea: string | null): Promise<void> {
  await invoke<void>("set_scroll_area", { scrollArea });
}

/**
 * Get the scrollable area restriction for the active sheet.
 * Returns null if no restriction is set.
 */
export async function getScrollArea(): Promise<string | null> {
  return invoke<string | null>("get_scroll_area");
}

// ============================================================================
// GO TO SPECIAL API
// ============================================================================

export interface GoToSpecialResult {
  cells: Array<{ row: number; col: number }>;
}

export async function goToSpecial(
  criteria: string,
  searchRange: [number, number, number, number] | null
): Promise<GoToSpecialResult> {
  return await invoke<GoToSpecialResult>("go_to_special", { criteria, searchRange });
}

// ============================================================================
// MERGE CELLS API
// ============================================================================

export interface MergedRegion {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface MergeResult {
  success: boolean;
  mergedRegions: MergedRegion[];
  updatedCells: CellData[];
}

/**
 * Merge cells in the specified range.
 * The top-left cell becomes the master cell.
 */
export async function mergeCells(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<MergeResult> {
  console.log(`[tauri-api] mergeCells(${startRow}, ${startCol}, ${endRow}, ${endCol})`);
  const result = await invoke<MergeResult>("merge_cells", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
  console.log(`[tauri-api] mergeCells result:`, result);
  recordGridEvent({ kind: "mergeCells", startRow, startCol, endRow, endCol });
  return result;
}

/**
 * Unmerge cells at the specified position.
 */
export async function unmergeCells(row: number, col: number): Promise<MergeResult> {
  console.log(`[tauri-api] unmergeCells(${row}, ${col})`);
  const result = await invoke<MergeResult>("unmerge_cells", { row, col });
  console.log(`[tauri-api] unmergeCells result:`, result);
  recordGridEvent({ kind: "unmergeCells", row, col });
  return result;
}

/**
 * Get all merged regions for the current sheet.
 */
export async function getMergedRegions(): Promise<MergedRegion[]> {
  return invoke<MergedRegion[]>("get_merged_regions");
}

/**
 * Check if a cell is part of a merged region.
 */
export async function getMergeInfo(
  row: number,
  col: number
): Promise<MergedRegion | null> {
  return invoke<MergedRegion | null>("get_merge_info", { row, col });
}

export async function shiftFormulaForFill(
  formula: string,
  rowDelta: number,
  colDelta: number
): Promise<string> {
  return await invoke<string>("shift_formula_for_fill", {
    formula,
    rowDelta,
    colDelta,
  });
}

/**
 * Input for batch formula shifting.
 */
export interface FormulaShiftInput {
  formula: string;
  rowDelta: number;
  colDelta: number;
}

/**
 * Batch shift multiple formulas at once for fill operations.
 * This is significantly faster than calling shiftFormulaForFill multiple times
 * because it processes all formulas in a single IPC call.
 * @param inputs - Array of formula shift inputs
 * @returns Array of shifted formulas in the same order as inputs
 */
export async function shiftFormulasBatch(
  inputs: FormulaShiftInput[]
): Promise<string[]> {
  if (inputs.length === 0) {
    return [];
  }
  const t0 = performance.now();
  const result = await invoke<{ formulas: string[] }>("shift_formulas_batch", {
    inputs,
  });
  const dt = performance.now() - t0;
  console.log(`[PERF][bridge] shiftFormulasBatch(${inputs.length}) | ipc=${dt.toFixed(1)}ms`);
  return result.formulas;
}

/**
 * Fill a target range by copying/tiling source cells from the source range.
 * Formulas have their relative references shifted by the delta between source and target.
 * Non-formula cells are copied verbatim (value + style).
 * This is the backend for Ctrl+D (Fill Down), Ctrl+R (Fill Right), etc.
 */
export async function fillRange(
  sourceStartRow: number,
  sourceStartCol: number,
  sourceEndRow: number,
  sourceEndCol: number,
  targetStartRow: number,
  targetStartCol: number,
  targetEndRow: number,
  targetEndCol: number,
): Promise<CellData[]> {
  const t0 = performance.now();
  const result = await invoke<CellData[]>("fill_range", {
    sourceStartRow,
    sourceStartCol,
    sourceEndRow,
    sourceEndCol,
    targetStartRow,
    targetStartCol,
    targetEndRow,
    targetEndCol,
  });
  const dt = performance.now() - t0;
  console.log(
    `[PERF][bridge] fillRange src=(${sourceStartRow},${sourceStartCol})-(${sourceEndRow},${sourceEndCol}) ` +
    `tgt=(${targetStartRow},${targetStartCol})-(${targetEndRow},${targetEndCol}) => ${result.length} cells | ipc=${dt.toFixed(1)}ms`
  );
  recordGridEvent({
    kind: "fillRange",
    sourceStartRow,
    sourceStartCol,
    sourceEndRow,
    sourceEndCol,
    targetStartRow,
    targetStartCol,
    targetEndRow,
    targetEndCol,
  });
  return result;
}

/**
 * Relocate formula references in the current sheet that point into a source range,
 * making them point to a destination range instead.  Called after a drag-move so
 * that formulas referencing the moved cells are updated to the new location.
 */
export async function relocateCellReferences(
  srcStartRow: number,
  srcStartCol: number,
  srcEndRow: number,
  srcEndCol: number,
  destStartRow: number,
  destStartCol: number,
): Promise<CellData[]> {
  const result = await invoke<CellData[]>("relocate_cell_references", {
    srcStartRow,
    srcStartCol,
    srcEndRow,
    srcEndCol,
    destStartRow,
    destStartCol,
  });
  return result;
}

// ============================================================================
// Named Ranges
// ============================================================================

import type {
  NamedRange,
  NamedRangeResult,
  ApplyNamesResult,
  DataValidation,
  DataValidationResult,
  DataValidationPrompt,
  InvalidCellsResult,
  CellValidationResult,
  ValidationRange,
} from "../types";

/**
 * Create a new named range.
 */
export async function createNamedRange(
  name: string,
  sheetIndex: number | null,
  refersTo: string,
  comment?: string,
  folder?: string
): Promise<NamedRangeResult> {
  return invoke<NamedRangeResult>("create_named_range", {
    name,
    sheetIndex,
    refersTo,
    comment: comment ?? null,
    folder: folder ?? null,
  });
}

/**
 * Update an existing named range.
 */
export async function updateNamedRange(
  name: string,
  sheetIndex: number | null,
  refersTo: string,
  comment?: string,
  folder?: string
): Promise<NamedRangeResult> {
  return invoke<NamedRangeResult>("update_named_range", {
    name,
    sheetIndex,
    refersTo,
    comment: comment ?? null,
    folder: folder ?? null,
  });
}

/**
 * Delete a named range.
 */
export async function deleteNamedRange(name: string): Promise<NamedRangeResult> {
  return invoke<NamedRangeResult>("delete_named_range", { name });
}

/**
 * Get a named range by name.
 */
export async function getNamedRange(name: string): Promise<NamedRange | null> {
  return invoke<NamedRange | null>("get_named_range", { name });
}

/**
 * Get all named ranges.
 */
export async function getAllNamedRanges(): Promise<NamedRange[]> {
  return invoke<NamedRange[]>("get_all_named_ranges");
}

/**
 * Find a named range that matches the given selection coordinates.
 * Used by NameBox to display the name instead of the cell address.
 */
export async function getNamedRangeForSelection(
  sheetIndex: number,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<NamedRange | null> {
  return invoke<NamedRange | null>("get_named_range_for_selection", {
    sheetIndex,
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Rename a named range.
 */
export async function renameNamedRange(
  oldName: string,
  newName: string
): Promise<NamedRangeResult> {
  return invoke<NamedRangeResult>("rename_named_range", { oldName, newName });
}

/**
 * Apply named range names to formulas, replacing cell references with names.
 * @param names Which named ranges to apply (empty array = all)
 * @param startRow Restrict to range start row (undefined = entire sheet)
 * @param startCol Restrict to range start col (undefined = entire sheet)
 * @param endRow Restrict to range end row (undefined = entire sheet)
 * @param endCol Restrict to range end col (undefined = entire sheet)
 */
export async function applyNamesToFormulas(
  names: string[] = [],
  startRow?: number,
  startCol?: number,
  endRow?: number,
  endCol?: number
): Promise<ApplyNamesResult> {
  return invoke<ApplyNamesResult>("apply_names_to_formulas", {
    names,
    startRow: startRow ?? null,
    startCol: startCol ?? null,
    endRow: endRow ?? null,
    endCol: endCol ?? null,
  });
}

// ============================================================================
// Data Validation
// ============================================================================

/**
 * Set data validation on a range.
 */
export async function setDataValidation(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  validation: DataValidation
): Promise<DataValidationResult> {
  console.log(
    `[tauri-api] setDataValidation(${startRow}, ${startCol}, ${endRow}, ${endCol})`,
    validation
  );
  return invoke<DataValidationResult>("set_data_validation", {
    startRow,
    startCol,
    endRow,
    endCol,
    validation,
  });
}

/**
 * Clear data validation from a range.
 */
export async function clearDataValidation(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<DataValidationResult> {
  console.log(
    `[tauri-api] clearDataValidation(${startRow}, ${startCol}, ${endRow}, ${endCol})`
  );
  return invoke<DataValidationResult>("clear_data_validation", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Get data validation for a specific cell.
 */
export async function getDataValidation(
  row: number,
  col: number
): Promise<DataValidation | null> {
  return invoke<DataValidation | null>("get_data_validation", { row, col });
}

/**
 * Get all validation ranges for the current sheet.
 */
export async function getAllDataValidations(): Promise<ValidationRange[]> {
  return invoke<ValidationRange[]>("get_all_data_validations");
}

/**
 * Validate a cell value against its validation rule.
 */
export async function validateCell(
  row: number,
  col: number
): Promise<CellValidationResult> {
  return invoke<CellValidationResult>("validate_cell", { row, col });
}

/**
 * Get the input prompt for a cell (if any).
 */
export async function getValidationPrompt(
  row: number,
  col: number
): Promise<DataValidationPrompt | null> {
  return invoke<DataValidationPrompt | null>("get_validation_prompt", { row, col });
}

/**
 * Get all invalid cells in the current sheet.
 */
export async function getInvalidCells(): Promise<InvalidCellsResult> {
  return invoke<InvalidCellsResult>("get_invalid_cells");
}

/**
 * Get dropdown list values for a cell with list validation.
 */
export async function getValidationListValues(
  row: number,
  col: number
): Promise<string[] | null> {
  return invoke<string[] | null>("get_validation_list_values", { row, col });
}

/**
 * Check if a cell has an in-cell dropdown.
 */
export async function hasInCellDropdown(
  row: number,
  col: number
): Promise<boolean> {
  return invoke<boolean>("has_in_cell_dropdown", { row, col });
}

/**
 * Validate a pending (not yet committed) value against a cell's validation rule.
 * Used by commit guards to validate before writing to the grid.
 */
export async function validatePendingValue(
  row: number,
  col: number,
  pendingValue: string
): Promise<CellValidationResult> {
  return invoke<CellValidationResult>("validate_pending_value", {
    row,
    col,
    pendingValue,
  });
}

// ============================================================================
// Comments / Notes
// ============================================================================

import type {
  Comment,
  CommentResult,
  ReplyResult,
  CommentIndicator,
  AddCommentParams,
  UpdateCommentParams,
  AddReplyParams,
  UpdateReplyParams,
  Note,
  NoteResult,
  NoteIndicator,
  AddNoteParams,
  UpdateNoteParams,
  ResizeNoteParams,
} from "../types";

/**
 * Add a comment to a cell.
 */
export async function addComment(params: AddCommentParams): Promise<CommentResult> {
  console.log(`[tauri-api] addComment(${params.row}, ${params.col})`);
  return invoke<CommentResult>("add_comment", { params });
}

/**
 * Update an existing comment's content.
 */
export async function updateComment(params: UpdateCommentParams): Promise<CommentResult> {
  console.log(`[tauri-api] updateComment(${params.commentId})`);
  return invoke<CommentResult>("update_comment", { params });
}

/**
 * Delete a comment and all its replies.
 */
export async function deleteComment(commentId: string): Promise<CommentResult> {
  console.log(`[tauri-api] deleteComment(${commentId})`);
  return invoke<CommentResult>("delete_comment", { commentId });
}

/**
 * Get a comment at a specific cell.
 */
export async function getComment(row: number, col: number): Promise<Comment | null> {
  return invoke<Comment | null>("get_comment", { row, col });
}

/**
 * Get a comment by ID.
 */
export async function getCommentById(commentId: string): Promise<Comment | null> {
  return invoke<Comment | null>("get_comment_by_id", { commentId });
}

/**
 * Get all comments for the current sheet.
 */
export async function getAllComments(): Promise<Comment[]> {
  return invoke<Comment[]>("get_all_comments");
}

/**
 * Get all comments for a specific sheet.
 */
export async function getCommentsForSheet(sheetIndex: number): Promise<Comment[]> {
  return invoke<Comment[]>("get_comments_for_sheet", { sheetIndex });
}

/**
 * Get comment indicators for the current sheet (for rendering comment markers).
 */
export async function getCommentIndicators(): Promise<CommentIndicator[]> {
  return invoke<CommentIndicator[]>("get_comment_indicators");
}

/**
 * Get comment indicators for a viewport range.
 */
export async function getCommentIndicatorsInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<CommentIndicator[]> {
  return invoke<CommentIndicator[]>("get_comment_indicators_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Set the resolved status of a comment.
 */
export async function resolveComment(
  commentId: string,
  resolved: boolean
): Promise<CommentResult> {
  console.log(`[tauri-api] resolveComment(${commentId}, ${resolved})`);
  return invoke<CommentResult>("resolve_comment", { commentId, resolved });
}

/**
 * Add a reply to a comment.
 */
export async function addReply(params: AddReplyParams): Promise<ReplyResult> {
  console.log(`[tauri-api] addReply(${params.commentId})`);
  return invoke<ReplyResult>("add_reply", { params });
}

/**
 * Update a reply's content.
 */
export async function updateReply(params: UpdateReplyParams): Promise<ReplyResult> {
  console.log(`[tauri-api] updateReply(${params.commentId}, ${params.replyId})`);
  return invoke<ReplyResult>("update_reply", { params });
}

/**
 * Delete a reply from a comment.
 */
export async function deleteReply(
  commentId: string,
  replyId: string
): Promise<ReplyResult> {
  console.log(`[tauri-api] deleteReply(${commentId}, ${replyId})`);
  return invoke<ReplyResult>("delete_reply", { commentId, replyId });
}

/**
 * Move a comment to a different cell.
 */
export async function moveComment(
  commentId: string,
  newRow: number,
  newCol: number
): Promise<CommentResult> {
  console.log(`[tauri-api] moveComment(${commentId}, ${newRow}, ${newCol})`);
  return invoke<CommentResult>("move_comment", { commentId, newRow, newCol });
}

/**
 * Get the total count of comments on the current sheet.
 */
export async function getCommentCount(): Promise<number> {
  return invoke<number>("get_comment_count");
}

/**
 * Check if a cell has a comment.
 */
export async function hasComment(row: number, col: number): Promise<boolean> {
  return invoke<boolean>("has_comment", { row, col });
}

/**
 * Clear all comments from the current sheet.
 */
export async function clearAllComments(): Promise<number> {
  console.log("[tauri-api] clearAllComments");
  return invoke<number>("clear_all_comments");
}

/**
 * Clear comments in a range.
 */
export async function clearCommentsInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<number> {
  console.log(
    `[tauri-api] clearCommentsInRange(${startRow}, ${startCol}, ${endRow}, ${endCol})`
  );
  return invoke<number>("clear_comments_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

// ============================================================================
// Notes (Legacy Yellow Sticky Notes)
// ============================================================================

/**
 * Add a note to a cell.
 */
export async function addNote(params: AddNoteParams): Promise<NoteResult> {
  console.log(`[tauri-api] addNote(${params.row}, ${params.col})`);
  return invoke<NoteResult>("add_note", { params });
}

/**
 * Update an existing note's content.
 */
export async function updateNote(params: UpdateNoteParams): Promise<NoteResult> {
  console.log(`[tauri-api] updateNote(${params.noteId})`);
  return invoke<NoteResult>("update_note", { params });
}

/**
 * Delete a note.
 */
export async function deleteNote(noteId: string): Promise<NoteResult> {
  console.log(`[tauri-api] deleteNote(${noteId})`);
  return invoke<NoteResult>("delete_note", { noteId });
}

/**
 * Get a note at a specific cell.
 */
export async function getNote(row: number, col: number): Promise<Note | null> {
  return invoke<Note | null>("get_note", { row, col });
}

/**
 * Get a note by ID.
 */
export async function getNoteById(noteId: string): Promise<Note | null> {
  return invoke<Note | null>("get_note_by_id", { noteId });
}

/**
 * Get all notes for the current sheet.
 */
export async function getAllNotes(): Promise<Note[]> {
  return invoke<Note[]>("get_all_notes");
}

/**
 * Get note indicators for the current sheet.
 */
export async function getNoteIndicators(): Promise<NoteIndicator[]> {
  return invoke<NoteIndicator[]>("get_note_indicators");
}

/**
 * Get note indicators for a viewport range.
 */
export async function getNoteIndicatorsInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<NoteIndicator[]> {
  return invoke<NoteIndicator[]>("get_note_indicators_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Resize a note's box dimensions.
 */
export async function resizeNote(params: ResizeNoteParams): Promise<NoteResult> {
  console.log(`[tauri-api] resizeNote(${params.noteId})`);
  return invoke<NoteResult>("resize_note", { params });
}

/**
 * Toggle the visibility of a single note.
 */
export async function toggleNoteVisibility(
  noteId: string,
  visible: boolean
): Promise<NoteResult> {
  return invoke<NoteResult>("toggle_note_visibility", { noteId, visible });
}

/**
 * Show or hide all notes on the current sheet.
 */
export async function showAllNotes(visible: boolean): Promise<number> {
  console.log(`[tauri-api] showAllNotes(${visible})`);
  return invoke<number>("show_all_notes", { visible });
}

/**
 * Move a note to a different cell.
 */
export async function moveNote(
  noteId: string,
  newRow: number,
  newCol: number
): Promise<NoteResult> {
  console.log(`[tauri-api] moveNote(${noteId}, ${newRow}, ${newCol})`);
  return invoke<NoteResult>("move_note", { noteId, newRow, newCol });
}

/**
 * Check if a cell has a note.
 */
export async function hasNote(row: number, col: number): Promise<boolean> {
  return invoke<boolean>("has_note", { row, col });
}

/**
 * Clear all notes from the current sheet.
 */
export async function clearAllNotes(): Promise<number> {
  console.log("[tauri-api] clearAllNotes");
  return invoke<number>("clear_all_notes");
}

/**
 * Clear notes in a range.
 */
export async function clearNotesInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<number> {
  console.log(
    `[tauri-api] clearNotesInRange(${startRow}, ${startCol}, ${endRow}, ${endCol})`
  );
  return invoke<number>("clear_notes_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Convert a note to a threaded comment.
 */
export async function convertNoteToComment(
  noteId: string,
  authorEmail: string
): Promise<CommentResult> {
  console.log(`[tauri-api] convertNoteToComment(${noteId})`);
  return invoke<CommentResult>("convert_note_to_comment", { noteId, authorEmail });
}

// ============================================================================
// Grouping / Outline API
// ============================================================================

export interface OutlineSettings {
  summaryRowPosition: "belowRight" | "aboveLeft";
  summaryColPosition: "belowRight" | "aboveLeft";
  showOutlineSymbols: boolean;
  autoStyles: boolean;
}

export interface RowGroup {
  startRow: number;
  endRow: number;
  level: number;
  collapsed: boolean;
}

export interface ColumnGroup {
  startCol: number;
  endCol: number;
  level: number;
  collapsed: boolean;
}

export interface SheetOutline {
  rowGroups: RowGroup[];
  columnGroups: ColumnGroup[];
  settings: OutlineSettings;
  maxRowLevel: number;
  maxColLevel: number;
}

export interface RowOutlineSymbol {
  row: number;
  level: number;
  isCollapsed: boolean;
  isButtonRow: boolean;
  isHidden: boolean;
}

export interface ColOutlineSymbol {
  col: number;
  level: number;
  isCollapsed: boolean;
  isButtonCol: boolean;
  isHidden: boolean;
}

export interface OutlineInfo {
  rowSymbols: RowOutlineSymbol[];
  colSymbols: ColOutlineSymbol[];
  maxRowLevel: number;
  maxColLevel: number;
  settings: OutlineSettings;
}

export interface GroupResult {
  success: boolean;
  outline?: SheetOutline;
  error?: string;
  hiddenRowsChanged: number[];
  hiddenColsChanged: number[];
}

/** Group rows (create or increment outline level). */
export async function groupRows(startRow: number, endRow: number): Promise<GroupResult> {
  return invoke<GroupResult>("group_rows", { params: { startRow, endRow } });
}

/** Ungroup rows (remove or decrement outline level). */
export async function ungroupRows(startRow: number, endRow: number): Promise<GroupResult> {
  return invoke<GroupResult>("ungroup_rows", { startRow, endRow });
}

/** Group columns (create or increment outline level). */
export async function groupColumns(startCol: number, endCol: number): Promise<GroupResult> {
  return invoke<GroupResult>("group_columns", { params: { startCol, endCol } });
}

/** Ungroup columns (remove or decrement outline level). */
export async function ungroupColumns(startCol: number, endCol: number): Promise<GroupResult> {
  return invoke<GroupResult>("ungroup_columns", { startCol, endCol });
}

/** Collapse the group(s) containing the given row (hides detail rows). */
export async function collapseRowGroup(row: number): Promise<GroupResult> {
  return invoke<GroupResult>("collapse_row_group", { row });
}

/** Expand the group(s) containing the given row (shows detail rows). */
export async function expandRowGroup(row: number): Promise<GroupResult> {
  return invoke<GroupResult>("expand_row_group", { row });
}

/** Collapse the group(s) containing the given column. */
export async function collapseColumnGroup(col: number): Promise<GroupResult> {
  return invoke<GroupResult>("collapse_column_group", { col });
}

/** Expand the group(s) containing the given column. */
export async function expandColumnGroup(col: number): Promise<GroupResult> {
  return invoke<GroupResult>("expand_column_group", { col });
}

/**
 * Collapse/expand groups to show only rows/columns up to the given level.
 * Pass undefined for either dimension to leave it unchanged.
 */
export async function showOutlineLevel(
  rowLevel?: number,
  colLevel?: number,
): Promise<GroupResult> {
  return invoke<GroupResult>("show_outline_level", {
    rowLevel: rowLevel ?? null,
    colLevel: colLevel ?? null,
  });
}

/** Get outline symbols for a viewport range (used for rendering the outline bar). */
export async function getOutlineInfo(
  startRow: number,
  endRow: number,
  startCol: number,
  endCol: number,
): Promise<OutlineInfo> {
  return invoke<OutlineInfo>("get_outline_info", { startRow, endRow, startCol, endCol });
}

/** Get all rows currently hidden by outline group collapse. */
export async function getHiddenRowsByGroup(): Promise<number[]> {
  return invoke<number[]>("get_hidden_rows_by_group");
}

/** Get all columns currently hidden by outline group collapse. */
export async function getHiddenColsByGroup(): Promise<number[]> {
  return invoke<number[]>("get_hidden_cols_by_group");
}

/** Remove all outline/grouping for the current sheet. */
export async function clearOutline(): Promise<GroupResult> {
  return invoke<GroupResult>("clear_outline");
}

// ============================================================================
// Number Format Preview
// ============================================================================

/** Result from previewing a custom number format. */
export interface PreviewResult {
  display: string;
  color?: string;
}

/** Preview how a custom number format string will format a sample value. */
export async function previewNumberFormat(
  formatString: string,
  sampleValue: number,
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_number_format", { formatString, sampleValue });
}

// ============================================================================
// Status Bar Aggregation
// ============================================================================

/** Result of computing aggregations over a selected range. */
export interface SelectionAggregationResult {
  sum: number | null;
  average: number | null;
  min: number | null;
  max: number | null;
  count: number;
  numericalCount: number;
}

// ============================================================================
// Auto-Recover Settings
// ============================================================================

export interface AutoRecoverSettings {
  enabled: boolean;
  intervalMs: number;
}

/** Get current auto-recover settings. */
export async function getAutoRecoverSettings(): Promise<AutoRecoverSettings> {
  return invoke<AutoRecoverSettings>("get_auto_recover_settings");
}

/** Update auto-recover settings. */
export async function setAutoRecoverSettings(
  enabled: boolean,
  intervalMs: number,
): Promise<AutoRecoverSettings> {
  return invoke<AutoRecoverSettings>("set_auto_recover_settings", { enabled, intervalMs });
}

/** Perform a background auto-recover save. Returns the recovery file path or rejects if not dirty. */
export async function autoRecoverSave(): Promise<string> {
  return invoke<string>("auto_recover_save");
}

/** Compute aggregations (sum, average, count, etc.) for a cell selection range. */
export async function getSelectionAggregations(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  selectionType: string,
): Promise<SelectionAggregationResult> {
  return invoke<SelectionAggregationResult>("get_selection_aggregations", {
    startRow,
    startCol,
    endRow,
    endCol,
    selectionType,
  });
}