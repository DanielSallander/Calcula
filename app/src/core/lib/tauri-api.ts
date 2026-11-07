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
  IndexRun,
  FunctionInfo,
  UpdateCellResult,
  SpillRangeInfo,
  UsedRangeResult,
  ClearApplyTo,
  ClearArea,
  FormattingArea,
  SplitConfig,
  MergedRegion,
  MergeResult,
  MergeOptions,
  LineRun,
  CellShiftResult,
  InsertCellsShift,
  DeleteCellsShift,
  CellTargetRef,
  StyleCheckArea,
  StructuralDelta,
  CalculationModeChange,
} from "../types";
import { getGroupForActiveSheet } from "../state/sheetGrouping";
// The sheet ON SCREEN, which `groupArgs` checks against the group (review G#4).
// Precedent for this core/lib -> state snapshot read: clearGestures.ts,
// pointModeSheetSwitch.ts, pointModeView.ts.
import { getGridStateSnapshot } from "../state/GridContext";
// The Rust commands that accept a cell target (P3): a target on any other
// command is refused HERE, before invoke (see placementArgs).
import { TARGET_COMMANDS } from "../../api/cellTargetCommands";
import { AppEvents, emitAppEvent } from "./events";
import { cellEvents, cellToChange } from "./cellEvents";
// STRUCTURAL_UNDO lives only in the @api event table (Core's own table has no
// entry for it); the cell-shift wrappers below announce through it.
import { AppEvents as ApiAppEvents } from "../../api/events";
import type { StructuralEditElsewhereEdit, StructuralEditElsewherePayload } from "../../api/events";

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
  // An off-sheet edit still waiting in the open burst is delivered FIRST, so a
  // store that replays both kinds of shift (the embedded forms, Controls' id-
  // keyed state) sees every edit in the order it was made -- a script that
  // inserts on Log, activates Log and inserts again within the burst window
  // would otherwise have its second insert applied before its first.
  flushPendingStructuralEditsElsewhere();
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
 *  must never block the write (each custom-function call is then answered
 *  from the backend's results cache for exactly its arguments, and shows
 *  #NAME? when no answer is recorded for them). */
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

/** Whether a written value IS a CUBE formula (not text that mentions one). */
function isCubeFormulaInput(value: string): boolean {
  return /^\s*=/.test(value) && inputReferencesCube(value);
}

/**
 * The BATCH and BACKGROUND write doors (`updateCellsBatch`, `updateCellOnSheets`)
 * and CUBE formulas (BUG-0476). True when some written value is a CUBE formula,
 * and then -- only then -- the session latch is set, exactly as the grid
 * editor's `updateCell` sets it: a later Calculate Now prefetches the cube data
 * again. Without it a script's, an extension's or a paste's `=CUBEVALUE(...)`
 * showed #N/A, and a later plain Calculate Now did not refresh it either
 * (`workbookHasCubeFormulas()` was still false); only `recalcWithCube()` did.
 */
function noteCubeFormulaWrites(values: Iterable<string>): boolean {
  for (const value of values) {
    if (isCubeFormulaInput(value)) {
      sessionHasCube = true;
      return true;
    }
  }
  return false;
}

/**
 * Whether a batch on the ACTIVE sheet should prefetch cube data: when it writes
 * a CUBE formula (which latches the session), and -- like `shouldPrefetchCube`
 * for the grid editor -- whenever the session has latched, because ANY batch
 * may then feed a cube cell. A paste, a fill or a script's `setValue` into a
 * cube ARGUMENT cell (`B2 = CUBEVALUE(..., A2)`, a new member name into A2)
 * re-evaluates B2 in the batch's cascade; without cube data it kept the
 * previous member's number beside the new name. A workbook with no CUBE
 * formula never latches, so its batches stay ONE IPC call.
 */
function shouldPrefetchCubeForBatch(values: Iterable<string>): boolean {
  return noteCubeFormulaWrites(values) || sessionHasCube;
}

/** The volatile custom-function cells a UDF pass found, for the cube prefetch. */
function udfVolatileArg(resolved: UdfResolveResult | undefined): Record<string, unknown> {
  return resolved && resolved.volatileCells.length > 0
    ? { udfVolatileCells: resolved.volatileCells }
    : {};
}

/**
 * The TARGETED cube prefetch for a batch of writes (BUG-0476): the async
 * `cube_prefetch` command, in its `edits` shape, resolves exactly the cube
 * cells the write command evaluates -- each written CUBE formula as the batch
 * evaluates it at its turn, and on the active sheet under automatic
 * calculation every cell of its cascade, computed by the backend with the
 * write's OWN cascade function -- the multi-edit twin of the single edit's
 * prefetch in `updateCell`. `sheetIndex` names the sheet the writes land on
 * (omitted: the active sheet), whose own cells a cube argument reads. Each
 * write travels with its `styleIndex` and `invariant` flag, so a value is
 * parsed exactly as the batch stores it; `udf` carries the volatile
 * custom-function cells the same batch's cascade re-evaluates.
 *
 * No recalculation of anything: the write command serves the result to the
 * cells it evaluates, so manual calculation keeps what the user left stale
 * and nothing announces a recalculation that did not happen. Best-effort,
 * like every cube prefetch: a failure returns `undefined` and the write goes
 * ahead without cube data (each cube call is answered from the backend's
 * results cache for exactly its arguments, and shows #N/A when none is
 * recorded for them; a cube formula written by it shows #N/A until a cube
 * refresh unless its exact call was answered before).
 */
async function prefetchCubeForWrites(
  edits: ReadonlyArray<Pick<CellUpdateInput, "row" | "col" | "value" | "invariant" | "styleIndex" | "pasted">>,
  sheetIndex?: number,
  udf?: UdfResolveResult,
): Promise<unknown | undefined> {
  try {
    const args: Record<string, unknown> = {
      edits: edits.map((u) => ({
        row: u.row,
        col: u.col,
        value: u.value,
        invariant: u.invariant,
        styleIndex: u.styleIndex,
        // A pasted CUBE formula in an @ cell is a formula, so the pre-fetch
        // must parse it as the batch stores it.
        pasted: u.pasted,
      })),
      ...udfVolatileArg(udf),
    };
    if (sheetIndex !== undefined) args.sheetIndex = sheetIndex;
    return await invoke("cube_prefetch", args);
  } catch (e) {
    console.warn("[cube] prefetch for a batch write failed; proceeding without cube data", e);
    return undefined;
  }
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
      /**
       * EVERY sheet the one command formatted, when it was not just the
       * active sheet: a grouped gesture's group (`groupArgs`, the active sheet
       * included) or the sheets `applyFormattingToSheets` named (a script's
       * off-sheet format; the active sheet NOT included). Absent = the active
       * sheet only, as before. A replay formats exactly these sheets: the
       * recorded group used to replay on the active sheet alone.
       */
      sheetIndices?: number[];
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
      /** The grouped sheets the preset reached (`groupArgs`), as `formatting`'s. */
      sheetIndices?: number[];
    }
  | {
      kind: "clearRange";
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      applyTo: ClearApplyTo;
      /**
       * The sheet the clear WROTE when it was not the active one:
       * `clearRangeOnSheets` records one event per other grouped sheet per
       * area (a grouped Delete / Clear Contents / Clear Formats / Clear All),
       * `clearRangeWithOptions` the `sheetIndex` its caller named (a script's
       * off-sheet clear). Absent = the active sheet, the implicit target of
       * every other bridge event (the recorder stamps that one on the action).
       * A replay clears THIS sheet, never the active one.
       */
      sheetIndex?: number;
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
  /**
   * Excel's Insert Cells / Delete Cells on the active sheet (BUG-0358): the
   * block and the shift, and whether the person answered OK to unmerging the
   * merged blocks the shift cut. A block spanning every column (row) is
   * recorded as the entire-row (column) edit it is, never as this.
   */
  | {
      kind: "insertCells";
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      shift: InsertCellsShift;
      unmergeCutMerges: boolean;
    }
  | {
      kind: "deleteCells";
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      shift: DeleteCellsShift;
      unmergeCutMerges: boolean;
    }
  | {
      kind: "mergeCells";
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      /**
       * The sheet the caller NAMED (`mergeCells`' `sheetIndex`: a script's
       * off-sheet merge). Absent = the active sheet. A replay merges THIS
       * sheet, never the active one (as `clearRange`'s).
       */
      sheetIndex?: number;
    }
  | {
      kind: "unmergeCells";
      row: number;
      col: number;
      /** The sheet the caller named (`unmergeCells`' `sheetIndex`), as `mergeCells`'. */
      sheetIndex?: number;
    }
  | { kind: "rowHeight"; row: number; height: number }
  | { kind: "columnWidth"; col: number; width: number }
  /**
   * ONE batch Row Height... over inclusive `runs` (`setRowHeights`; Select All
   * is `[[0, 1048575]]`), replayed as ONE `api.setRowHeights(runs, height)` --
   * the same command, so Select All replays as the sheet's standard height
   * and a hidden row is shown or passed over by the same rules. It used to be
   * one `rowHeight` event per row: 1,048,576 of them for Select All.
   */
  | { kind: "rowHeights"; runs: Array<[number, number]>; height: number }
  /** ONE batch Column Width... over `runs` (`setColumnWidths`), as `rowHeights`. */
  | { kind: "columnWidths"; runs: Array<[number, number]>; width: number }
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
  | {
      kind: "addSheet";
      index: number;
      name: string;
      /** Present only for a canvas: a replayed macro must add the same KIND. */
      sheetKind?: "canvas";
    }
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

/**
 * Write one entry on the active sheet. `groupSheets`, when given and not
 * empty, makes it a GROUPED entry: the backend also writes every one of those
 * (other, non-active) sheets in the SAME call and records ONE undo step for
 * all of them (`update_cell_grouped` in commands/data.rs), answering
 * `groupWritten` / `groupError`. One call, so no transaction is ever held
 * open across an await for another writer to join. A CUBE entry carries one
 * targeted prefetch per grouped sheet, aligned with `groupSheets`, by the rule
 * `updateCellOnSheets` uses.
 */
export async function updateCell(
  row: number,
  col: number,
  input: string,
  groupSheets?: number[],
): Promise<UpdateCellResult> {
  const t0 = performance.now();
  // Pre-resolve any user-defined formula functions the edit will trigger, so the
  // synchronous backend recalc can serve their results (see setUdfResolveHook).
  const udf = await resolveUdfsFor([{ row, col, value: input }]);
  // Pre-resolve any CUBE formulas the edit affects so the synchronous backend
  // recalc can serve their BI-model results. Best-effort: failure must not block
  // the edit (the cube cells just show #N/A until data is available). The
  // volatile custom-function cells the UDF pass found ride along: the edit's
  // cascade re-evaluates them too, so the prefetch must cover them.
  let cubeResults: unknown | undefined;
  if (shouldPrefetchCube(input)) {
    try {
      cubeResults = await invoke("cube_prefetch", { row, col, value: input, ...udfVolatileArg(udf) });
    } catch (e) {
      console.warn("[cube] prefetch failed; proceeding without cube data", e);
    }
  }
  // FIXED: Mapped 'input' to 'value' to match Rust command signature
  const args: Record<string, unknown> = { row, col, value: input };
  applyUdfArgs(args, udf);
  if (cubeResults) args.cubeResults = cubeResults;
  if (groupSheets && groupSheets.length > 0) {
    args.groupSheets = groupSheets;
    if (noteCubeFormulaWrites([input])) {
      const perSheet: unknown[] = [];
      for (const sheetIndex of groupSheets) {
        const prefetch = await prefetchCubeForWrites([{ row, col, value: input }], sheetIndex);
        if (!prefetch) break;
        perSheet.push(prefetch);
      }
      // All or nothing, as in updateCellOnSheets: Rust ignores a misaligned list.
      if (perSheet.length === groupSheets.length) args.groupCubeResults = perSheet;
    }
  }
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
  /**
   * Optional style index: the LOOK the cell must show (a paste or fill sends
   * the source cell's displayed index). When provided it becomes the cell's own
   * style -- `0` (Normal) under a row/column format is written as an explicit
   * Normal, so the line's format does not show through -- and with an empty
   * `value` the position keeps that look as an empty cell. Omitted, the cell
   * keeps its own style (a typed value under a line format inherits it). On a
   * PROTECTED sheet it is a format like any other (Excel [LIVE]): dropped when
   * the sheet does not allow Format Cells, and the cell keeps its Locked flag.
   */
  styleIndex?: number;
  /** When true, the value is already in invariant (US) format — skip delocalization. */
  invariant?: boolean;
  /**
   * When true, this write is a PASTE -- a copied formula, or a copied cell's
   * STORED value written back (Paste, Cut + Paste, a drag move or copy, Paste
   * Special, a script's pasteRange) -- and not an entry someone typed. The
   * backend's typed-entry ladder then skips its Text rung, so a formula stays a
   * formula and a number, TRUE / FALSE or an error stays one in a
   * Text-formatted (`@`) cell, which keeps its format (Excel keeps a pasted
   * value's kind there; typing `=A1` into an `@` cell stores the text).
   * Text is pasted behind the apostrophe escape and stays text either way.
   * Omitted: a typed entry, as before. Mirrors Rust `CellUpdateInput.pasted`.
   */
  pasted?: boolean;
  /**
   * Set, this write lands a MOVED cell (the destination half of Cut + Paste)
   * from the named SOURCE cell: its format moves with it. On a PROTECTED sheet
   * that does not allow Format Cells, `styleIndex` is then still written (a
   * copy's is dropped), and the cell still keeps its Locked flag -- Excel moves
   * a cut cell's format with the option off or on, and drops only a copy's
   * [LIVE]. BOUND, not asserted: the backend honours it only when the source
   * cell (read before any write of the batch) shows exactly `styleIndex`;
   * otherwise the write is a copy. Omitted: a copy or an entry. Mirrors Rust
   * `CellUpdateInput.moved` / `MovedFrom`.
   */
  moved?: MovedFrom;
  /**
   * Set, this write PASTES the named source cell as it holds it AT THE WRITE
   * (BUG-0657): the backend reads it under the batch's own guards, before any
   * of its writes, and writes its formula shifted by (this cell - the source)
   * as Copy + Paste shifts it -- or, with `valuesOnly` or no formula, its
   * stored value as a paste. `value` is then only the fallback for a source
   * the backend cannot vouch for (a collection value, a `TABLE(..)` formula, a
   * source that does not resolve). Mirrors Rust `CellUpdateInput.source` /
   * `PasteSource`.
   */
  source?: PasteSource;
}

/**
 * The source cell of a pasted write (`CellUpdateInput.source`): a cell of the
 * sheet at `sheetIndex`, or -- with `target` -- a cell of that object (its own
 * coordinates; `sheetIndex` is then not used). `valuesOnly`: paste the
 * source's value (a formula's result), never its formula. `unshifted`: the
 * write MOVES the source (Cut + Paste, a drag move), so its formula lands as
 * the source holds it -- the move's relocation re-points it -- where a copy's
 * is shifted by (this cell - the source). A source formula its protected
 * sheet hides is pasted as its value, and a data table's body cell is copied
 * as its value. Mirrors Rust `PasteSource`.
 */
export interface PasteSource {
  sheetIndex: number;
  row: number;
  col: number;
  target?: CellTargetRef;
  valuesOnly?: boolean;
  unshifted?: boolean;
}

/**
 * The source cell of a moved write (`CellUpdateInput.moved`): a cell of the
 * sheet at `sheetIndex`, or -- with `target` -- a cell of that object (a
 * floating grid's own cell, `row` / `col` in its coordinates; `sheetIndex` is
 * then not used). Mirrors Rust `MovedFrom`.
 */
export interface MovedFrom {
  sheetIndex: number;
  row: number;
  col: number;
  target?: CellTargetRef;
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
 * CUBE formulas (BUG-0476): a batch that writes one sets the session's cube
 * latch, as `updateCell` does; and once the session has latched, EVERY batch
 * first asks `cube_prefetch` for exactly the cube data the batch evaluates
 * (`prefetchCubeForWrites`) -- a paste into a cube argument cell re-evaluates
 * the cube cell that reads it -- which the batch command serves to the cells it
 * evaluates. No recalculation of anything else, so manual calculation is
 * respected. A workbook with no CUBE formula never latches: ONE IPC call.
 *
 * @param updates - Array of cell updates with row, col, and value
 * @returns Array of all updated cells (including dependents)
 */
export async function updateCellsBatch(
  updates: CellUpdateInput[],
  opts?: CellTargetOptions,
): Promise<CellData[]> {
  const t0 = performance.now();
  const placed = cellTargetArg("update_cells_batch", opts);
  if (placed.target) {
    // An OBJECT's cells (P3): written on its backing sheet by the backend's
    // target route, which carries literal values and formulas only (no UDF
    // pre-resolution keyed on active-sheet cells) and is never recorded as a
    // grid gesture (its coordinates are the object's, not the sheet's).
    const targeted = await invoke<CellData[]>("update_cells_batch", { updates, ...placed });
    console.log(
      `[PERF][bridge] updateCellsBatch(${updates.length}, target) => ${targeted.length} cells | ipc=${(performance.now() - t0).toFixed(1)}ms`,
    );
    return targeted;
  }
  const udf = await resolveUdfsFor(
    updates.map((u) => ({ row: u.row, col: u.col, value: u.value, invariant: u.invariant })),
  );
  // A CUBE formula among the writes latches the session (BUG-0476); once
  // latched, any batch may feed a cube cell, so it fetches the cube data its
  // evaluation needs. A workbook with no cube stays ONE IPC call.
  const args: Record<string, unknown> = { updates };
  applyUdfArgs(args, udf);
  if (shouldPrefetchCubeForBatch(updates.map((u) => u.value))) {
    const cubeResults = await prefetchCubeForWrites(updates, undefined, udf);
    if (cubeResults) args.cubeResults = cubeResults;
  }
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
  // `clear_range` REMOVES every stored cell of the rectangle -- its value AND
  // its own format (`Grid::clear_cell`) -- so the recorder hears a Clear ALL.
  // It said "contents", and a replayed recording of a row move / copy (the
  // callers in useClipboard) then left the destination cells' formats that
  // the gesture itself had wiped. (One residual difference: a replayed "all"
  // over WHOLE rows or columns also removes their row / column format, which
  // `clear_range` leaves.)
  recordGridEvent({
    kind: "clearRange",
    startRow,
    startCol,
    endRow,
    endCol,
    applyTo: "all",
  });
  return result;
}

// ClearApplyTo is imported from ../types

/**
 * Clear a range with options for what to clear.
 *
 * `sheetIndex` (Wave 3): clear on a NON-ACTIVE sheet. State updates backend-
 * side only — the result's `updatedCells` is empty and the active canvas needs
 * no repaint (the target sheet re-materializes from its grid on switch).
 *
 * The macro recorder hears the sheet the caller named (`sheetIndex` on the
 * `clearRange` event), so a script's off-sheet clear replays on THAT sheet.
 * It used to record no sheet, and every such clear replayed on the sheet that
 * was active. (A grouped clear's other sheets are recorded by
 * `clearRangeOnSheets`, the door the gesture writes them through.)
 */
export async function clearRangeWithOptions(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  applyTo: ClearApplyTo = "all",
  sheetIndex?: number,
  opts?: CellTargetOptions & {
    /**
     * The OTHER blocks of a multi-area selection (BUG-0394 / BUG-0395),
     * cleared by this same call on the active sheet: every block is gated
     * before any is written (one refusing block clears none), as ONE undo
     * step with ONE dependents cascade. Contents, formats, all only; no
     * `sheetIndex`, no target.
     */
    moreAreas?: ClearArea[];
  },
): Promise<unknown> {
  // `target` rides INSIDE the params struct, beside `sheetIndex` (TARGET_IN_PARAMS).
  const placed = cellTargetArg("clear_range_with_options", opts, sheetIndex);
  const moreAreas = opts?.moreAreas ?? [];
  const result = await invoke("clear_range_with_options", {
    params: {
      startRow,
      startCol,
      endRow,
      endCol,
      applyTo,
      sheetIndex: sheetIndex ?? null,
      ...placed,
    },
    ...moreAreasArg(moreAreas),
  });
  if (!placed.target) {
    // One recorded clear per block, so a recorded multi-area clear replays
    // exactly as the single-block calls it replaced.
    for (const area of [{ startRow, startCol, endRow, endCol }, ...moreAreas]) {
      recordGridEvent({
        kind: "clearRange",
        ...area,
        applyTo,
        ...(typeof sheetIndex === "number" ? { sheetIndex } : {}),
      });
    }
  }
  return result;
}

/** `{ moreAreas }` for a clear command when there are other blocks, else nothing
 *  (a one-block call keeps the wire shape it always had). */
function moreAreasArg(moreAreas: readonly ClearArea[] | undefined): { moreAreas?: ClearArea[] } {
  return moreAreas && moreAreas.length > 0 ? { moreAreas: moreAreas.map((a) => ({ ...a })) } : {};
}

/**
 * Clear all hyperlinks in a range.
 */
export async function clearHyperlinksInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  moreAreas?: ClearArea[],
): Promise<number> {
  const cleared = await invoke<number>("clear_hyperlinks_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
    ...moreAreasArg(moreAreas),
  });
  if (cleared > 0) {
    emitAppEvent(AppEvents.HYPERLINKS_CHANGED, { sheetIndex: null });
  }
  return cleared;
}

/**
 * A cell that holds a hyperlink, as Rust `get_hyperlinks_in_range` reports it
 * (`HyperlinkIndicator`). Core reads only the position; the full shape, with
 * the link kind typed, is `@api`'s `HyperlinkIndicator`.
 */
export interface LinkedCell {
  row: number;
  col: number;
  linkType: string;
  tooltip?: string;
}

/**
 * The cells of a range (on the active sheet) that hold a hyperlink -- Core's
 * own door to the Hyperlinks store's indicator query, so Core's gestures
 * (Remove Hyperlinks) never reach the IPC bridge with a raw `invoke`.
 */
export async function getHyperlinksInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<LinkedCell[]> {
  return invoke<LinkedCell[]>("get_hyperlinks_in_range", { startRow, startCol, endRow, endCol });
}

export async function getGridBounds(): Promise<[number, number]> {
  return invoke<[number, number]>("get_grid_bounds");
}

export async function getCellCount(): Promise<number> {
  return invoke<number>("get_cell_count");
}

/**
 * Get the bounding box of all stored cells on a sheet.
 * @param sheetIndex - Sheet to inspect (defaults to the active sheet)
 */
export async function getUsedRange(sheetIndex?: number): Promise<UsedRangeResult> {
  return invoke<UsedRangeResult>("get_used_range", { sheetIndex });
}

/**
 * True when the sheet at `sheetIndex` holds NOTHING a delete would lose --
 * asked of EVERY sheet-keyed store in the backend (`sheet_is_blank`): cells
 * and formats, sizes and hidden lines, merges, notes, comments, hyperlinks,
 * data validation, conditional formats, filters, tables, sheet-scoped names,
 * protection, a print area, and the objects placed on it. The used range sees
 * only cells, which let a sheet holding only a note or a validation rule be
 * deleted without a question (review finding, 2026-10-04). Rejects for an
 * index past the workbook.
 */
export async function isSheetBlank(sheetIndex: number): Promise<boolean> {
  return invoke<boolean>("sheet_is_blank", { sheetIndex });
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
 * @param sheetIndex - Sheet to inspect (defaults to the active sheet)
 */
export async function getCurrentRegion(
  row: number,
  col: number,
  sheetIndex?: number
): Promise<CurrentRegionResult> {
  return invoke<CurrentRegionResult>("get_current_region", { row, col, sheetIndex });
}

/**
 * Target cell of a Ctrl+Arrow / Range.End edge navigation (getRangeEdge).
 */
export interface RangeEdgeResult {
  row: number;
  col: number;
}

/**
 * Excel Ctrl+Arrow / Range.End edge navigation, resolved entirely server-side
 * against the full Excel grid bounds (1,048,576 rows x 16,384 columns).
 * Same algorithm as the keyboard's findCtrlArrowTarget — one implementation
 * in engine::navigation.
 * @param row - Starting row (0-based)
 * @param col - Starting column (0-based)
 * @param direction - "up" | "down" | "left" | "right"
 * @param sheetIndex - Sheet to navigate on (defaults to the active sheet)
 */
export async function getRangeEdge(
  row: number,
  col: number,
  direction: ArrowDirection,
  sheetIndex?: number
): Promise<RangeEdgeResult> {
  return invoke<RangeEdgeResult>("get_range_edge", {
    row,
    col,
    direction,
    sheetIndex,
  });
}

/**
 * The cell classes getSpecialCells can select (Excel Range.SpecialCells).
 *
 * Excel's "Last cell" is NOT among them and must not be added here: this union
 * mirrors the kinds `get_special_cells` decodes in Rust, so a member the
 * backend cannot answer would be a type that lies. The last used cell is a
 * property of the sheet rather than a class of cell, and `getUsedRange` below
 * is the one call that reports it — for Ctrl+End, for Ctrl+Shift+End, and for
 * Go To Special's "Last cell" (`goToSpecial` in app/src/api/grid.ts).
 */
export type SpecialCellsKind = "constants" | "formulas" | "blanks" | "visible";

/** One cell coordinate in a getSpecialCells answer. */
export interface SpecialCellRef {
  row: number;
  col: number;
}

/**
 * Result of getSpecialCells. `cells` is row-major sorted and capped at
 * 100,000 entries; `truncated` reports whether the cap dropped anything.
 */
export interface SpecialCellsResult {
  cells: SpecialCellRef[];
  truncated: boolean;
}

/**
 * Excel's Range.SpecialCells / Go To Special, resolved server-side.
 *
 * "visible" is the backend-only kind: it consults the authoritative hidden
 * state for ANY sheet -- rows/columns hidden BY HAND, AutoFilter criteria, an
 * applied advanced filter, and collapsed outline groups, composed by
 * `collect_hidden_rows_for_sheet`. The rect (inclusive, normalized) is clamped
 * to the sheet's used range. `sheetIndex` defaults to the active sheet.
 */
export async function getSpecialCells(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  kind: SpecialCellsKind,
  sheetIndex?: number
): Promise<SpecialCellsResult> {
  return invoke<SpecialCellsResult>("get_special_cells", {
    startRow,
    startCol,
    endRow,
    endCol,
    kind,
    sheetIndex,
  });
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

// `LineRun` (an inclusive `[first, last]` run) mirrors Rust's `(u32, u32)`
// run and lives with the other API types in core/types/types.ts.
export type { LineRun } from "../types";

/** Sort and merge runs (overlapping and adjacent ones join), first <= last. */
function mergeLineRuns(runs: readonly LineRun[]): Array<[number, number]> {
  const sorted = runs
    .map(([a, b]): [number, number] => [Math.min(a, b), Math.max(a, b)])
    .sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const run of sorted) {
    const last = merged[merged.length - 1];
    if (last && run[0] <= last[1] + 1) last[1] = Math.max(last[1], run[1]);
    else merged.push([run[0], run[1]]);
  }
  return merged;
}

/**
 * Excel's Row Height... over every row of `runs` in ONE call and ONE undo step
 * (Rust `set_row_heights`): `[[0, 1048575]]` is Select All, not a million
 * indices. `height <= 0` removes the rows' own heights (the default), as
 * {@link setRowHeight} does. Gated by the sheet's "Format rows" protection
 * option -- a refusal rejects with the backend's sentence and changes nothing.
 *
 * The macro recorder sees ONE `rowHeights` event carrying the runs AS SENT,
 * as Excel's recorder writes `Rows("18:22").RowHeight = 30` (or
 * `Cells.RowHeight`) for the selection, never row by row. Its replay,
 * `api.setRowHeights(runs, height)`, reaches this same command, so Select All
 * replays as the sheet's standard and a hidden row is shown or passed over by
 * the same rules (under filter mode the backend passes over the hidden rows
 * of runs that hold a visible one, on the replay as in the gesture). It used
 * to record one `rowHeight` event per row -- 1,048,576 for Select All, each
 * replayed as that row's own height. The backend's reply (the runs the size
 * reached) is not needed for that.
 */
export async function setRowHeights(
  runs: readonly LineRun[],
  height: number,
  opts?: CellTargetOptions,
): Promise<void> {
  const merged = mergeLineRuns(runs);
  const placed = cellTargetArg("set_row_heights", opts);
  await invoke<LineRun[] | null>("set_row_heights", { rows: merged, height, ...placed });
  if (!placed.target && merged.length > 0) {
    recordGridEvent({ kind: "rowHeights", runs: merged.map(([a, b]): [number, number] => [a, b]), height });
  }
}

/**
 * Excel's Column Width... over every column of `runs`, ONE call and ONE undo
 * step (Rust `set_column_widths`). See {@link setRowHeights}: the recorder sees
 * ONE `columnWidths` event with the runs as sent.
 */
export async function setColumnWidths(
  runs: readonly LineRun[],
  width: number,
  opts?: CellTargetOptions,
): Promise<void> {
  const merged = mergeLineRuns(runs);
  const placed = cellTargetArg("set_column_widths", opts);
  await invoke<LineRun[] | null>("set_column_widths", { cols: merged, width, ...placed });
  if (!placed.target && merged.length > 0) {
    recordGridEvent({ kind: "columnWidths", runs: merged.map(([a, b]): [number, number] => [a, b]), width });
  }
}

/**
 * Hide or unhide ROWS on the active sheet. Returns the resulting user-hidden
 * row set, ascending.
 *
 * This is the USER-hide authority, and it is deliberately separate from the
 * hidden sets a filter or an outline produces:
 *
 *     effectiveHidden(row) = userHidden OR filterHidden OR outlineHidden
 *
 * So clearing a filter leaves a hand-hidden row hidden, and unhiding by hand
 * does not resurrect a filter-hidden row. Range-taking so a 500-row "Hide" is
 * one IPC call and one undo step; it is undoable and marks the document dirty.
 */
export async function setRowsHidden(rows: number[], hidden: boolean, opts?: CellTargetOptions): Promise<number[]> {
  // With a target (P3) the OBJECT's own hidden set changes, never the sheet's;
  // the result is then the object's resulting set.
  return invoke<number[]>("set_rows_hidden", { rows, hidden, ...cellTargetArg("set_rows_hidden", opts) });
}

/** Hide or unhide COLUMNS on the active sheet (see {@link setRowsHidden}). */
export async function setColsHidden(cols: number[], hidden: boolean, opts?: CellTargetOptions): Promise<number[]> {
  return invoke<number[]>("set_cols_hidden", { cols, hidden, ...cellTargetArg("set_cols_hidden", opts) });
}

/** Rows the user hid by hand on the active sheet, ascending. */
export async function getUserHiddenRows(): Promise<number[]> {
  return invoke<number[]>("get_user_hidden_rows");
}

/** Columns the user hid by hand on the active sheet, ascending. */
export async function getUserHiddenCols(): Promise<number[]> {
  return invoke<number[]>("get_user_hidden_cols");
}

/**
 * Which rows (or columns) are hidden on ONE sheet, split by authority --
 * mirrors Rust `HiddenLinesInfo`.
 *
 * Two different questions, deliberately not conflated:
 *   - `user`      -- what was hidden BY HAND ("what did I hide?")
 *   - `effective` -- hidden by ANY authority: user OR filter OR outline
 *                    ("is this row visible?")
 *
 * `user` is always a subset of `effective`; both are ascending.
 */
export interface HiddenLinesInfo {
  user: number[];
  effective: number[];
}

/** Hidden ROWS on `sheetIndex` (the active sheet by default), split into the
 *  by-hand set and the effective union. Works for ANY sheet. */
export async function getHiddenRowsInfo(sheetIndex?: number): Promise<HiddenLinesInfo> {
  return invoke<HiddenLinesInfo>("get_hidden_rows_info", { sheetIndex });
}

/** Hidden COLUMNS on `sheetIndex` (see {@link getHiddenRowsInfo}). There are no
 *  column filters, so `effective` here is user OR outline. */
export async function getHiddenColsInfo(sheetIndex?: number): Promise<HiddenLinesInfo> {
  return invoke<HiddenLinesInfo>("get_hidden_cols_info", { sheetIndex });
}

export async function getDefaultDimensions(): Promise<DefaultDimensions> {
  return invoke<DefaultDimensions>("get_default_dimensions");
}

/** Rejects (with the backend's sentence) on a sheet protected against row
 *  formatting -- the same gate as {@link setRowHeight}. */
export async function setDefaultRowHeight(height: number): Promise<DefaultDimensions> {
  return invoke<DefaultDimensions>("set_default_row_height", { height });
}

/** Rejects (with the backend's sentence) on a sheet protected against column
 *  formatting -- the same gate as {@link setColumnWidth}. */
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
 * Point a cell at an existing style index -- the LOOK it must show (callers
 * pass a source cell's displayed index): `0` (Normal) under a row/column
 * format is written as an explicit Normal, so the line's format does not show
 * through.
 *
 * REJECTS when the cell is locked on a protected sheet. This command takes an
 * arbitrary style index, so it is the sharpest way to change a cell's
 * protection attributes wholesale (Format Painter and Paste-Formats both go
 * through it) — callers must handle the rejection rather than assume success.
 *
 * `opts.target` (BUG-0513): a floating grid's cell -- written on its backing
 * sheet, inside its extent, gated by the HOST's protection; the coordinates
 * are the object's own.
 *
 * `opts.checkArea` (ALL OR NOTHING): the call is a CHECK only -- every gate
 * the write asks of one cell is asked of the whole rectangle, nothing is
 * written, and it answers null (`row`, `col` and `styleIndex` are not used).
 * A gesture that styles cell by cell (Format Painter, Paste Formatting) asks
 * it first, so a refusal comes before its first cell changes.
 */
export async function setCellStyle(
  row: number,
  col: number,
  styleIndex: number,
  opts?: SetCellStyleOptions,
): Promise<CellData | null> {
  const checkArea = opts?.checkArea;
  return invoke<CellData | null>("set_cell_style", {
    row,
    col,
    styleIndex,
    ...cellTargetArg("set_cell_style", opts),
    ...(checkArea ? { checkArea } : {}),
  });
}

/** `setCellStyle`'s options: the target, and the whole-rectangle CHECK. */
export interface SetCellStyleOptions extends CellTargetOptions {
  checkArea?: StyleCheckArea;
}

/**
 * One cell of a style-only batch (`setCellStyles`). Mirrors Rust
 * `CellStyleWrite`.
 */
export interface CellStyleWrite {
  row: number;
  col: number;
  /** The LOOK the cell must show, exactly as `setCellStyle`'s `styleIndex`. */
  styleIndex: number;
  /**
   * The cell keeps every border side it shows (Paste Special > All Except
   * Borders: the source's style but the destination's own borders).
   */
  keepBorders?: boolean;
}

/**
 * Style many cells in ONE call (`set_cell_style`'s `cells`): each as
 * `setCellStyle` would style it -- the requested look, the Locked flag kept on
 * a protected sheet -- gated once and all or nothing (a refusal writes
 * nothing), as ONE undo step (or inside the caller's open one). An empty list
 * makes no call.
 */
export async function setCellStyles(writes: CellStyleWrite[], opts?: CellTargetOptions): Promise<void> {
  if (writes.length === 0) return;
  await invoke<CellData | null>("set_cell_style", {
    row: 0,
    col: 0,
    styleIndex: 0,
    cells: writes,
    ...cellTargetArg("set_cell_style", opts),
  });
}

/**
 * Set rich text runs on a cell for partial formatting.
 * Pass null to clear rich text and revert to uniform cell style.
 */
export async function setCellRichText(
  row: number,
  col: number,
  runs: RichTextRun[] | null,
  opts?: CellTargetOptions,
): Promise<CellData | null> {
  return invoke<CellData | null>("set_cell_rich_text", { row, col, runs, ...cellTargetArg("set_cell_rich_text", opts) });
}

/**
 * Prime the frontend style cache with the registry entries a formatting command
 * just used or created.
 *
 * WHY HERE. The renderer resolves a cell with
 * `getStyleFromCache(styleCache, cell.styleIndex)`, and that lookup FALLS BACK
 * to index 0 -- the document default -- when the index is unknown. Applying a
 * format MINTS an index, so a caller that refreshed the CELLS without also
 * refreshing the STYLE TABLE painted the cell unformatted while `get_style`
 * reported the format correctly. Measured on the running app (BUG-0076): Ctrl+B
 * on a cell with a background fill turned it WHITE and left it unbolded --
 * 2,277 fill pixels went to 0 -- while `get_style` reported bold AND the colour.
 *
 * The ribbon happened to be correct because `useHomeTabState.applyFormat`
 * dispatches `styles:refresh` by hand; the Core keyboard route
 * (`format.toggleBold` -> `applyFormattingToSelection`) did not, and neither did
 * the script host's `applyRangeFormat` for the ACTIVE sheet. That is the same
 * shape as the outline / hyperlink / validation / annotation defect this file
 * already carries a comment about: a refresh wired to ONE caller.
 *
 * Emitting from the wrapper cannot be routed around -- there is no other door to
 * `apply_formatting` -- and it costs no IPC: `FormattingResult.styles` is exactly
 * "New or updated styles that the frontend should cache" (api_types.rs),
 * collected from `used_style_indices` in `commands/styles.rs`. It was previously
 * read for a console.log of its LENGTH and otherwise discarded.
 *
 * EXPORTED, and that correction is BUG-0080. This function's own comment used to
 * read "there is no other door to THE COMMAND", which is true of
 * `apply_formatting` and false of the STYLE CACHE: `apply_named_style` and
 * `apply_named_style_range` return the same `FormattingResult` with the same
 * `styles` array, their wrappers live in `src/api/backend.ts`, and both are
 * exported through `@api` for extensions. Neither announced anything. Measured
 * at the unit tier (`formatStyleCachePrime.test.tsx`): a cell the backend
 * reports as carrying the named style's `#00A650` fill painted `#ffffff`, the
 * document default. The class is the door, not the command -- so every wrapper
 * that receives a `FormattingResult` announces through THIS function.
 */
export function announceStyleEntries(result: FormattingResult): void {
  if (result.styles.length > 0) {
    emitAppEvent(AppEvents.STYLE_ENTRIES_UPDATED, { styles: result.styles });
  }
}

/**
 * The group a formatting command must also write, as its `sheetIndices`
 * argument -- or nothing, when no sheets are grouped.
 *
 * ONE COMMAND PER GESTURE (review finding, 2026-10-04). The wrappers used to
 * format the active sheet and then repeat the change on the group with a second
 * command; a protected grouped sheet refused only that second call, after the
 * active sheet was already formatted (and the refusal went to the console), and
 * a successful group took one Ctrl+Z per sheet plus one. The backend now gates
 * every sheet of the group before writing any and records ONE undo step.
 *
 * ONLY THE GROUP THE SHEET ON SCREEN BELONGS TO (review G#4). This sent the
 * selected group whatever sheet was on screen, and the backend formats the
 * active sheet PLUS every listed sheet -- so after a Name Box / Go To / link /
 * command-line switch to a sheet outside the group (which Excel ungroups on),
 * a Bold there also bolded the old group's sheets, off screen [LIVE, Excel 16:
 * the same gesture bolds the sheet on screen only]. The group is now
 * `getGroupForActiveSheet` (core/state/sheetGrouping.ts), the one membership
 * rule the typed entry and the clear gestures apply too. Serves every
 * formatting wrapper that takes `placementArgs`: applyFormatting,
 * applyBorderPreset, adjustNumberFormatDecimals.
 */
function groupArgs(): { sheetIndices?: number[] } {
  const group = getGroupForActiveSheet(getGridStateSnapshot()?.sheetContext.activeSheetIndex);
  return group.length > 1 ? { sheetIndices: group } : {};
}

/**
 * The one option a cell wrapper takes to act on an OBJECT's cells instead of
 * the active sheet's (P3, owner finding G3): `target` names the object (a
 * floating grid); the backend resolves its hidden backing sheet in ONE place.
 *
 * EXPLICIT, never ambient: no wrapper reads the selection owner. A script that
 * calls `applyFormatting` while a floating-grid cell is selected still formats
 * the active sheet; only a door that resolved a target
 * (`resolveCellTarget`, @api/cellTarget) passes one.
 */
export interface CellTargetOptions {
  target?: CellTargetRef;
}

/** The sentence when a caller names a target AND a sheet (mirrors Rust's refusal). */
export const TARGET_WITH_SHEET_REFUSAL = "Pass a floating grid target or a sheet, not both.";

/**
 * `{ target }` for `command` when `opts` names one, else `{}`.
 *
 * FAILS CLOSED. Tauri drops an argument a command does not declare, so a
 * target sent to a command that has not learned it would be IGNORED and the
 * command would act on the ACTIVE sheet at the object's local coordinates,
 * reporting success (BUG-0185 again). A target on a command missing from
 * `TARGET_COMMANDS` (api/cellTargetCommands.ts) therefore THROWS here,
 * before any invoke. `sheet`: the caller's explicit sheet selector, which a
 * target excludes.
 */
export function cellTargetArg(
  command: string,
  opts?: CellTargetOptions,
  sheet?: number | readonly number[] | null,
): { target?: CellTargetRef } {
  const target = opts?.target;
  if (target === undefined || target === null) return {};
  if (!TARGET_COMMANDS.includes(command)) {
    throw new Error(`${command} does not accept a floating grid target yet.`);
  }
  if (sheet !== undefined && sheet !== null) throw new Error(TARGET_WITH_SHEET_REFUSAL);
  return { target };
}

/**
 * Where a formatting wrapper lands, as its caller names it: an object's cells
 * (`target`), or the ACTIVE SHEET ALONE (`activeSheetOnly`) -- never the user's
 * sheet group. Without either, the gesture reaches the group the sheet on
 * screen belongs to (`groupArgs`), as a ribbon click does.
 *
 * `activeSheetOnly` is the SCRIPT's placement (review
 * NEW-script-format-follows-ui-group): a script's `api.setRangeFormat` is
 * Excel's `ActiveSheet.Range(...)`, which formats that sheet only, whatever
 * sheets the user happens to have grouped [LIVE, Excel 16: Sheet1+Sheet3
 * grouped, `ActiveSheet.Range("D4").Font.Bold = True` bolds Sheet1 only, while
 * `Selection.Font.Italic` -- the user's selection -- reaches both]. Through the
 * ambient group, a macro or a button that formatted one cell formatted every
 * grouped sheet too, off screen.
 */
export interface FormatPlacementOptions extends CellTargetOptions {
  activeSheetOnly?: boolean;
}

/**
 * Where a formatting command lands: `{ target }` for an object's cells (a
 * target ALWAYS drops the ambient sheet group -- an object's cells are not
 * grouped), nothing beyond the active sheet when the caller asked for it
 * alone, else the group (`groupArgs`). Fails closed like `cellTargetArg`.
 */
export function placementArgs(
  command: string,
  opts?: FormatPlacementOptions,
): { target?: CellTargetRef; sheetIndices?: number[] } {
  const placed = cellTargetArg(command, opts);
  if (placed.target) return placed;
  return opts?.activeSheetOnly === true ? {} : groupArgs();
}

/**
 * The shortest ascending run `encodeIndexList` sends as an `IndexRun`. Below
 * it a plain list costs nothing worth saving, and ordinary selections keep the
 * plain shape every caller and test double already reads.
 */
export const INDEX_RUN_MIN_LENGTH = 64;

/**
 * A `rows` / `cols` list as `apply_formatting` takes it (BUG-0354): an
 * ascending contiguous run of at least `INDEX_RUN_MIN_LENGTH` indices crosses
 * the bridge as `{ first, last }`; anything else as the list itself.
 *
 * WHY. Select All builds all 1,048,576 row indices, and a whole column's Left
 * Border (the Borders split's edge presets) the same million: about 7 MB of
 * JSON per call, parsed on the Rust side into a million values, for what is
 * two numbers. The backend expands the run back into its list
 * (`deserialize_index_list`, api_types.rs), so nothing else changes. A list
 * that is not ascending (the active cell first) or has a gap stays a list.
 */
export function encodeIndexList(list: number[]): number[] | IndexRun {
  if (list.length < INDEX_RUN_MIN_LENGTH) return list;
  for (let i = 1; i < list.length; i++) {
    if (list[i] !== list[i - 1] + 1) return list;
  }
  return { first: list[0], last: list[list.length - 1] };
}

export async function applyFormatting(
  rows: number[],
  cols: number[],
  formatting: FormattingOptions,
  opts?: FormatPlacementOptions & {
    /**
     * The OTHER blocks of a multi-area selection (BUG-0394), formatted by this
     * same call as ONE undo step -- each as the rows and columns of its own
     * cross product. Not with a `target`.
     */
    moreAreas?: FormattingArea[];
  },
): Promise<FormattingResult> {
  const placement = placementArgs("apply_formatting", opts);
  const moreAreas = opts?.moreAreas ?? [];
  if (placement.target && moreAreas.length > 0) {
    throw new Error("Several areas are formatted on the sheet, not in an object's cells.");
  }
  console.log(
    "[tauri-api] applyFormatting:",
    `${rows.length} rows x ${cols.length} cols`,
    moreAreas.length > 0 ? `+ ${moreAreas.length} more area(s)` : "",
  );
  const result = await invoke<FormattingResult>("apply_formatting", {
    ...(moreAreas.length > 0
      ? { moreAreas: moreAreas.map((a) => ({ rows: encodeIndexList(a.rows), cols: encodeIndexList(a.cols) })) }
      : {}),
    params: {
      rows: encodeIndexList(rows),
      cols: encodeIndexList(cols),
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
      textColorTheme: formatting.textColorTheme,
      textColorTint: formatting.textColorTint,
      bgColorTheme: formatting.bgColorTheme,
      bgColorTint: formatting.bgColorTint,
      locked: formatting.locked,
      formulaHidden: formatting.formulaHidden,
    },
    ...placement,
  });
  console.log(
    "[tauri-api] applyFormatting result:",
    "cells=",
    result.cells.length,
    "styles=",
    result.styles.length
  );
  announceStyleEntries(result);
  // An object's cells are not a gesture on the sheet: never recorded (P3).
  // Grouped sheets were formatted by the SAME command (`groupArgs`), so the
  // event names them: recorded without, a grouped Bold replayed on the active
  // sheet alone.
  if (!placement.target) {
    // One recorded formatting per block (a multi-area call replays as the
    // single-block calls it replaced).
    for (const area of [{ rows, cols }, ...moreAreas]) {
      recordGridEvent({ kind: "formatting", rows: area.rows, cols: area.cols, formatting, ...recordedSheets(placement.sheetIndices) });
    }
  }
  return result;
}

/**
 * The `sheetIndices` a recorded formatting event carries: the sheets one
 * command reached beyond "the active sheet" (a copy -- the grouping state is
 * live), or nothing when it reached only the active sheet.
 */
function recordedSheets(sheetIndices: readonly number[] | undefined): { sheetIndices?: number[] } {
  return sheetIndices !== undefined && sheetIndices.length > 0 ? { sheetIndices: [...sheetIndices] } : {};
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
 *
 * Whole rows, whole columns and Select All are written through the backend's
 * row/column defaults, so `result.cells` holds only the cells that needed a
 * style of their own: refresh the grid afterwards rather than patching from
 * `result.cells` alone. An unchanged range returns empty arrays.
 *
 * SHEET GROUPING (survey D4): like `applyFormatting`, the preset reaches every
 * grouped sheet -- through the SAME command (`groupArgs`), gated whole and one
 * undo step. A refusal anywhere in the group rejects and changes nothing.
 */
export async function applyBorderPreset(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  preset: string,
  style: string,
  color: string,
  width: number,
  opts?: FormatPlacementOptions,
): Promise<FormattingResult> {
  const placement = placementArgs("apply_border_preset", opts);
  const result = await invoke<FormattingResult>("apply_border_preset", {
    startRow,
    startCol,
    endRow,
    endCol,
    preset,
    style,
    color,
    width,
    ...placement,
  });
  if (!placement.target) {
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
      ...recordedSheets(placement.sheetIndices),
    });
  }
  announceStyleEntries(result);
  return result;
}

/**
 * Repeat a border preset on every listed sheet except the active one. One undo
 * step for all of them; refused whole if any listed sheet protects the range.
 * `applyBorderPreset` no longer needs it (it sends the group to its own
 * command); kept for callers that format the active sheet themselves.
 */
export async function applyBorderPresetToSheets(
  sheetIndices: number[],
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  preset: string,
  style: string,
  color: string,
  width: number
): Promise<void> {
  return invoke<void>("apply_border_preset_to_sheets", {
    sheetIndices,
    startRow,
    startCol,
    endRow,
    endCol,
    preset,
    style,
    color,
    width,
  });
}

/**
 * A `rows` / `cols` list whose FIRST entry is the active cell's line (the
 * order `adjustNumberFormatDecimals` takes), as the bridge sends it.
 *
 *   - What `encodeIndexList` shortens (a long ascending run -- already led by
 *     the active line) or leaves alone (a short list) goes as it says, with no
 *     `lead`: the backend reads the active line from the list's first entry.
 *   - `[lead, ...every other line of one contiguous run, ascending]` -- the
 *     Home tab's `activeCellFirst` over a rectangle -- goes as that run, with
 *     the active line as `lead` (the run alone has lost which line came first).
 *   - Anything else (a gap, a repeat, an unordered tail) stays the list.
 *
 * O(length), no sort: Select All's million rows are walked once.
 */
export function encodeActiveFirstIndexList(list: number[]): { wire: number[] | IndexRun; lead?: number } {
  const plain = encodeIndexList(list);
  if (plain !== list || list.length < INDEX_RUN_MIN_LENGTH) return { wire: plain };
  const lead = list[0];
  const first = list[1];
  let last = first;
  // Whether the walk stepped over the lead's own place inside the run.
  let skippedLead = false;
  for (let i = 2; i < list.length; i++) {
    const next = list[i];
    if (next === last + 1) {
      last = next;
    } else if (!skippedLead && lead === last + 1 && next === last + 2) {
      skippedLead = true;
      last = next;
    } else {
      return { wire: list };
    }
  }
  if (skippedLead) return { wire: { first, last }, lead };
  // The lead sits just past the end (Ctrl+A: the active cell on the last line).
  // Just BEFORE the start would make the list ascending, handled above.
  if (lead === last + 1) return { wire: { first, last: lead }, lead };
  return { wire: list };
}

/**
 * Excel's Home > Number > Increase Decimal (`delta` = 1) / Decrease Decimal
 * (`delta` = -1), decided by the backend on the TYPED number format.
 *
 * The ACTIVE cell decides: pass its row FIRST in `rows` and its column FIRST
 * in `cols` (the backend reads `rows[0]`, `cols[0]`). Its format gains or
 * loses one decimal KEEPING ITS KIND -- Number, Currency, Accounting, Percent,
 * Scientific; General uses the decimals it shows; a Custom code edits every
 * numeric section -- and the whole `rows` x `cols` selection receives the
 * result as ONE undo step. Where Excel changes nothing (a date, time, fraction
 * or text format, an empty or text active cell, no decimal left to remove)
 * nothing is written and the result's arrays are empty.
 *
 * Like `applyFormatting` this announces the new styles, records the change
 * for the macro recorder (as the resulting number format, which replays
 * through `applyFormatting`), and reaches grouped sheets through the SAME
 * command (`groupArgs`).
 *
 * A whole column, a whole row or Select All is written as row/column TIERS
 * (review finding, 2026-10-04: Select All used to walk 17.2 billion cells), so
 * `result.cells` may be empty while `result.styles` carries the new format:
 * refresh the grid rather than patching from `result.cells` alone.
 *
 * THE WIRE (BUG-0354 follow-up). The backend was bounded, but this still sent
 * Select All's 1,048,576 row indices (and 16,384 columns) as JSON arrays, and
 * `encodeIndexList` alone could not shorten them: the active cell comes FIRST,
 * so the list is not ascending (Ctrl+A puts the active cell on the LAST row:
 * `[1048575, 0, 1, ...]`). `encodeActiveFirstIndexList` sends such a list as
 * the run it covers plus the active line on its own (`activeRow` /
 * `activeCol`); the command reads the active cell from those when they are
 * present, else from `rows[0]` / `cols[0]` as before. Short lists, ascending
 * runs (already led by the active line) and scattered lists keep their shape.
 */
export async function adjustNumberFormatDecimals(
  rows: number[],
  cols: number[],
  delta: 1 | -1,
  opts?: FormatPlacementOptions & {
    /**
     * The text the ACTIVE cell shows at its column's width (BUG-0355,
     * `@api/shownCellText`): a General number steps from the decimals SHOWN,
     * as in Excel. Absent: General's full rendering.
     */
    shownText?: string | null;
  },
): Promise<FormattingResult> {
  const placement = placementArgs("adjust_number_format_decimals", opts);
  const rowWire = encodeActiveFirstIndexList(rows);
  const colWire = encodeActiveFirstIndexList(cols);
  const result = await invoke<FormattingResult>("adjust_number_format_decimals", {
    rows: rowWire.wire,
    cols: colWire.wire,
    delta,
    ...(rowWire.lead !== undefined ? { activeRow: rowWire.lead } : {}),
    ...(colWire.lead !== undefined ? { activeCol: colWire.lead } : {}),
    ...placement,
    ...(opts?.shownText ? { shownText: opts.shownText } : {}),
  });
  announceStyleEntries(result);

  // The FIRST returned style carries the new number format (the active cell's,
  // adjusted): the backend lists every style carrying it -- the written cells'
  // and the tiers' alike -- ahead of the rest. The rest are an almost-whole
  // range's EXCEPTIONS (A2:A1048576 leaves A1 out), which keep their OLD style
  // and were once sorted first by registry index, so a recorded step replayed
  // `numberFormat: "General"` (round-3 review rev3A#6; pinned in Rust by
  // the_decimal_step_names_the_new_format_first_on_an_almost_whole_column).
  // Its display name is a value applyFormatting parses back to the identical
  // typed format (every_display_name_the_serializer_emits_round_trips), so it
  // is what a recorded macro replays. Empty styles: Excel changed nothing.
  const numberFormat = result.styles[0]?.style.numberFormat;
  if (numberFormat !== undefined && !placement.target) {
    // With the group it reached, as applyFormatting records it.
    recordGridEvent({
      kind: "formatting",
      rows,
      cols,
      formatting: { numberFormat },
      ...recordedSheets(placement.sheetIndices),
    });
  }
  return result;
}

// ============================================================================
// Multi-Sheet (Sheet Grouping) Operations
// ============================================================================

/**
 * Replicate a cell value update to multiple non-active sheets.
 * The script host's off-sheet single-cell write (a grouped ENTRY no longer
 * comes here: `updateCell` with `groupSheets` writes the whole group in one
 * call and one undo step). Dependent formulas (written sheets + active sheet) are
 * recalculated by the backend unless `recalc` is false — the bulk script path
 * passes false per cell and calls recalculateSheetsAfterScriptWrite ONCE.
 *
 * A CUBE formula written here (BUG-0476) sets the session's cube latch, so a
 * later Calculate Now prefetches cube data, and is SERVED on write: one
 * targeted `cube_prefetch` per target sheet, built from THAT sheet's cells
 * (a cube argument naming a cell reads the sheet the formula lands on), goes
 * to the command as `cubeResults`, aligned with `sheetIndices`. Sequential,
 * so two sheets never race to connect the same model. Any other value is
 * still ONE IPC call, latched session or not -- unlike `updateCellsBatch`,
 * deliberately: the command serves cube data only to the cell it writes, and
 * the whole-sheet recalculation that follows (`recalc_after_off_sheet_write`)
 * takes none, so a prefetch for a plain value would have nothing to serve. A
 * cube cell on that sheet reading the written cell is not refreshed until
 * the next Calculate Now (whose full refresh covers every sheet): each of its
 * calls is answered
 * from the results cache for exactly its arguments, and shows #N/A when the
 * write changed them to ones never answered
 * (docs/design/cube-formulas-and-custom-functions.md sections 2.4 and 2.5).
 */
export async function updateCellOnSheets(
  sheetIndices: number[],
  row: number,
  col: number,
  value: string,
  invariant?: boolean,
  recalc?: boolean
): Promise<number[]> {
  const args: Record<string, unknown> = { sheetIndices, row, col, value, invariant, recalc };
  if (noteCubeFormulaWrites([value])) {
    const perSheet: unknown[] = [];
    for (const sheetIndex of sheetIndices) {
      const prefetch = await prefetchCubeForWrites([{ row, col, value, invariant }], sheetIndex);
      if (!prefetch) break;
      perSheet.push(prefetch);
    }
    // All or nothing: a list the command cannot align with the sheets would
    // serve nothing anyway (Rust ignores a misaligned list).
    if (perSheet.length === sheetIndices.length && perSheet.length > 0) args.cubeResults = perSheet;
  }
  return invoke<number[]>("update_cell_on_sheets", args);
}

/**
 * The recalc half of updateCellOnSheets on its own: evaluate every named sheet
 * plus the active sheet (twice — the second pass propagates one more
 * cross-sheet hop). Called once after a bulk off-sheet script write.
 */
export async function recalculateSheetsAfterScriptWrite(
  sheetIndices: number[]
): Promise<void> {
  return invoke<void>("recalculate_sheets_after_script_write", { sheetIndices });
}

/**
 * Replicate formatting to multiple non-active sheets. The script host's
 * off-sheet `setRangeFormat` runs through it.
 *
 * Recorded, once it LANDED, as ONE `formatting` event naming exactly these
 * sheets, so a replay formats them and not the active one; unrecorded, a
 * script's off-sheet format run while recording vanished from the macro.
 */
export async function applyFormattingToSheets(
  sheetIndices: number[],
  rows: number[],
  cols: number[],
  formatting: FormattingOptions
): Promise<void> {
  await invoke<void>("apply_formatting_to_sheets", {
    sheetIndices,
    params: {
      // The same wire shape as applyFormatting (BUG-0354).
      rows: encodeIndexList(rows),
      cols: encodeIndexList(cols),
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
      textColorTheme: formatting.textColorTheme,
      textColorTint: formatting.textColorTint,
      bgColorTheme: formatting.bgColorTheme,
      bgColorTint: formatting.bgColorTint,
      locked: formatting.locked,
      formulaHidden: formatting.formulaHidden,
    },
  });
  if (sheetIndices.length > 0) {
    recordGridEvent({ kind: "formatting", rows, cols, formatting, sheetIndices: [...sheetIndices] });
  }
}

/**
 * The sheet group's clear (Delete / Clear Contents / Clear Formats / Clear All
 * with sheet tabs grouped): the rectangle, plus `options.moreAreas` (the other
 * Ctrl+click blocks), on every listed sheet but the active one, as
 * `options.applyTo` says (default "contents").
 *
 * ALL OR NOTHING. The backend gates EVERY listed sheet -- the active one
 * included -- for every area before it writes anything, and refuses the whole
 * call if one of them refuses (Excel: one protected grouped sheet and nothing
 * is cleared anywhere). So the gesture lists the active sheet too and calls
 * this FIRST, then clears the active sheet through its own command. One call
 * for every area, one undo step, one recalculation.
 *
 * Returns the sheets it wrote (every listed sheet but the active one). The
 * macro recorder hears ONE `clearRange` per written sheet per area, with that
 * sheet, so a recorded grouped clear replays on every grouped sheet (it used to
 * record nothing for them).
 */
export async function clearRangeOnSheets(
  sheetIndices: number[],
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  options?: { applyTo?: "contents" | "formats" | "all"; moreAreas?: ClearArea[] },
): Promise<number[]> {
  const applyTo = options?.applyTo ?? "contents";
  const moreAreas = options?.moreAreas ?? [];
  const written = await invoke<number[] | null>("clear_range_on_sheets", {
    sheetIndices,
    startRow,
    startCol,
    endRow,
    endCol,
    applyTo,
    moreAreas,
  });
  const sheets = Array.isArray(written) ? written : [];
  const areas: ClearArea[] = [{ startRow, startCol, endRow, endCol }, ...moreAreas];
  for (const sheetIndex of sheets) {
    for (const area of areas) {
      recordGridEvent({ kind: "clearRange", ...area, applyTo, sheetIndex });
    }
  }
  return sheets;
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

/**
 * Set the calculation mode; answers the mode IN EFFECT afterwards.
 *
 * Leaving manual for automatic is a recalculation, as in Excel: the backend
 * runs Calculate Now itself (with the cube pre-fetch) and answers the cells it
 * repainted, so every caller -- the Formulas menu, a script's
 * `setCalculationMode("automatic")`, the release when a script holding manual
 * ends, the workbook-swap sweep -- shows the recalculated values and announces
 * the pass, the way `calculateNow` does. Nobody chains Calculate Now after it.
 *
 * ONE SWITCH AT A TIME, IN CALL ORDER. The command is async on the backend, and
 * two switches sent close together (Manual, then Automatic) started their
 * bodies on pool threads in either order, so the backend could end in the
 * mode of the EARLIER click while the menu showed the later one. Each call now
 * waits for the previous one to settle before it is sent, so the last call is
 * the last applied; the answer is the mode actually in effect, which the
 * caller shows.
 */
let calculationModeQueue: Promise<unknown> = Promise.resolve();

/**
 * "automaticExceptTables" is Excel's "Automatic except for data tables"
 * (xlCalculationSemiautomatic, BUG-0754): every formula recalculates
 * automatically and only the live data tables wait for F9.
 */
export function setCalculationMode(mode: "automatic" | "automaticExceptTables" | "manual"): Promise<string> {
  const run = calculationModeQueue.then(async () => {
    const startedAt = performance.now();
    const change = await invoke<CalculationModeChange>("set_calculation_mode", { mode });
    // Setting the calculation mode ends copy and cut mode, either way and
    // even to the mode already in effect [LIVE 2026-10-30, clip5/probe-endings.ps1
    // and clip6/probe-calc.ps1: auto->auto, manual->manual, auto->manual and
    // manual->auto each take CutCopyMode from xlCopy to 0].
    announceClipboardModeEnding("calculationMode");
    // The switch applied; a recalculation that then failed is reported beside
    // the mode (the values stay "pending", as after a cancelled pass).
    if (change.recalculationError) console.warn("[calc]", change.recalculationError);
    const cells = change.recalculated;
    if (cells) {
      announceRecalcCompleted("workbook", cells.length, startedAt);
      cellEvents.emitBatch(cells.map(cellToChange));
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    }
    return change.mode;
  });
  // A failed switch must not wedge the ones after it.
  calculationModeQueue = run.catch(() => undefined);
  return run;
}

export async function getCalculationMode(): Promise<string> {
  return invoke<string>("get_calculation_mode");
}

/**
 * Get the current calculation state.
 * Returns "done" or "pending" (Excel's xlPending: a cancelled recalculation,
 * a manual-calculation edit a formula depends on, or a workbook saved that way).
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

/**
 * Announce a command that ENDS the clipboard mode -- a copy's and a cut's --
 * as Excel's does [LIVE] (DATA_COMMAND_APPLIED; Core's clipboard listens):
 * Calculate Now / Calculate Sheet, a Merge or Unmerge, a change of the
 * calculation mode (`setCalculationMode`). Announced next to the
 * invoke, once it landed, so every caller -- the ribbon, F9, a script, the
 * command line -- announces it.
 */
function announceClipboardModeEnding(command: "calculate" | "merge" | "calculationMode"): void {
  emitAppEvent(ApiAppEvents.DATA_COMMAND_APPLIED, { command });
}

async function recalcAll(forceCube: boolean): Promise<CellData[]> {
  // Pre-resolve cube formulas on every sheet so a full recalc refreshes them
  // against current model data (e.g. after a calculated measure changes, or F9).
  // Gated on the workbook having cube formulas (avoids the IPC otherwise) unless
  // forced. Best-effort: a failure must not block the recalc.
  let cubeResults: unknown | undefined;
  if (forceCube || workbookHasCubeFormulas()) {
    try {
      cubeResults = await invoke("cube_prefetch_all", {});
    } catch (e) {
      console.warn("[cube] full prefetch failed; cube calls are answered from the results cache", e);
    }
  }
  const startedAt = performance.now();
  const cells = await invoke<CellData[]>("calculate_now", cubeResults ? { cubeResults } : {});
  announceRecalcCompleted("workbook", cells.length, startedAt);
  return cells;
}

/** **Calculate Now — F9 — the WHOLE WORKBOOK**, as Excel's F9 means it.
 *  Its partner is `calculateSheet` (Shift+F9), the active sheet alone. The
 *  returned cells are the ACTIVE sheet's: an off-sheet value must never be
 *  painted onto the sheet on screen, and every sheet switch re-fetches. */
export async function calculateNow(): Promise<CellData[]> {
  console.log("[tauri-api] calculateNow - recalculating the workbook");
  const result = await recalcAll(false);
  console.log(`[tauri-api] calculateNow returned ${result.length} updated cells`);
  // F9 ENDS the clipboard mode as Excel's Calculate does [LIVE, rev11B and
  // clip5/probe-endings.ps1: Application.Calculate -> CutCopyMode 0]; the
  // full recalculation with cubes (`recalcWithCube`, Excel's CalculateFull,
  // which keeps the mode [LIVE]) does not.
  announceClipboardModeEnding("calculate");
  return result;
}

/** Full recalc that ALWAYS refreshes cube formulas (used after a BI model change
 *  such as adding/editing a calculated measure). */
export async function recalcWithCube(): Promise<CellData[]> {
  return recalcAll(true);
}

/** **Calculate Sheet — Shift+F9 — the ACTIVE sheet alone**, as Excel means it.
 *  No cube prefetch: that belongs to a FULL recalculation (see `recalcAll`). */
export async function calculateSheet(): Promise<CellData[]> {
  console.log("[tauri-api] calculateSheet - recalculating the active sheet");
  const startedAt = performance.now();
  const result = await invoke<CellData[]>("calculate_sheet");
  console.log(`[tauri-api] calculateSheet returned ${result.length} updated cells`);
  announceRecalcCompleted("sheet", result.length, startedAt);
  // Shift+F9 ENDS the clipboard mode as Excel's Worksheet.Calculate does [LIVE].
  announceClipboardModeEnding("calculate");
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

/**
 * What kind of surface a sheet is: an ordinary cell "worksheet", or a "canvas"
 * that shows only floating objects on a fixed page (Rust `SheetKind`,
 * core/persistence). Fixed when the sheet is created.
 */
export type SheetKindName = "worksheet" | "canvas";

/** A floating object hosted on a canvas, by its family's kind and stable id. */
export interface CanvasObjectRef {
  kind: string;
  id: string;
}

/**
 * A canvas sheet's layout (Rust `CanvasLayout`). Every size is LOGICAL px -- the
 * same units as a floating object's x/y/width/height, so the snap grid and the
 * objects it positions never disagree about scale.
 */
export interface CanvasLayout {
  snapToGrid: boolean;
  gridSizePx: number;
  showGrid: boolean;
  /** A preset id from `CANVAS_PAGE_PRESETS` (@api/canvasSheet) or "custom". */
  pagePreset: string;
  pageWidth: number;
  pageHeight: number;
  /** CSS hex colour; "" means the theme's default page colour. */
  background: string;
  /**
   * The colour of the area OUTSIDE the page (Power BI's Wallpaper): a CSS hex
   * colour, or absent / "" for the theme's. Absent on the wire when "".
   */
  wallpaper?: string;
  /**
   * Lock Objects for this page (Power BI's View > Lock objects): no object on
   * it may be moved or resized while set. Absent on the wire when false. Read
   * it through `canvasObjectsLocked` (@api/canvasSheet).
   */
  objectsLocked?: boolean;
  /**
   * Paint order, bottom first (absent when empty). Objects MISSING from the
   * list paint above every listed one; a duplicated ref counts at its first
   * position. Refs follow `CANVAS_OBJECT_KINDS` (@api/canvasSheet).
   */
  zOrder?: CanvasObjectRef[];
  /** Objects locked against move/resize (absent when empty). */
  locked?: CanvasObjectRef[];
  /**
   * Edit interactions (P4): how one visual's selection reaches another on this
   * page. `defaultMode` is what a visual source gives a target with no pair
   * (absent = Power BI's default: highlight where the target can, else
   * filter); `pairs` say it pair by pair. Absent on the wire at its default
   * (no pairs, no default mode). Rust `CanvasInteractions`; source and target
   * kinds follow `CANVAS_INTERACTION_KINDS` (@api/canvasSheet).
   */
  interactions?: {
    defaultMode?: "filter" | "highlight";
    pairs?: Array<{ source: CanvasObjectRef; target: CanvasObjectRef; mode: "filter" | "highlight" | "none" }>;
  };
}

/** Partial update for a canvas layout (Rust `CanvasLayoutPatch`). */
export type CanvasLayoutPatch = Partial<CanvasLayout>;

export interface SheetInfo {
  index: number;
  name: string;
  tabColor?: string;
  /** Sheet visibility: "visible", "hidden", or "veryHidden" */
  visibility: SheetVisibility;
  /**
   * The workbook's stable sheet uuid.
   *
   * OPTIONAL on purpose. A frontend running against an older `app_lib.dll` must
   * degrade to "no mark", not to a type error — and anything that follows a
   * sheet must key on THIS, never on `index` (shifts on insert/delete/move) or
   * `name` (shifts on rename).
   */
  sheetId?: string;
  /**
   * "worksheet" or "canvas". Rides in the same payload as `sheetId` so the tab
   * strip, the Core surface switch and the Canvas ribbon tab learn it together
   * with the list. Optional for the same reason `sheetId` is; absent means a
   * worksheet.
   */
  kind?: SheetKindName;
  /** The canvas's layout; absent for a worksheet. */
  canvasLayout?: CanvasLayout;
  /**
   * True for a TEMPORARY sheet: a drill-through's result, which the tab strip
   * discards when the user leaves it and keeps on a double-click of its tab
   * (`keepEphemeralSheet`). Session-only on the backend -- a save writes the
   * sheet as an ordinary one -- and optional here for the same reason `sheetId`
   * is: absent means an ordinary sheet (docs/design/model-drillthrough.md 2.6).
   */
  ephemeral?: boolean;
}

export interface SheetsResult {
  sheets: SheetInfo[];
  activeIndex: number;
}

/**
 * The backend's answer to `discard_ephemeral_sheet` (`discardEphemeralSheet`;
 * Rust `sheets::DiscardedSheet`): which sheet it removed, resolved from the
 * STABLE id at the moment of deletion, and the list afterwards.
 */
export interface DiscardedSheet {
  /** The TRUE workbook index the sheet had when the backend removed it. */
  deletedIndex: number;
  /** Its name, as it was. */
  deletedName: string;
  /** The sheet list and the active sheet afterwards. */
  result: SheetsResult;
}

/**
 * Whether a sheet wrapper reports to the macro recorder. `record: false` is for
 * the drill-through's own choreography: the landing on its temporary sheet and
 * the strip's discard of it are consequences of the drill, not steps of the
 * user's macro, and replayed as a structural `deleteSheet` they would delete
 * whatever sheet holds that index later (model-drillthrough.md 2.7).
 */
export interface SheetRecordingOptions {
  record?: boolean;
}

export async function getSheets(): Promise<SheetsResult> {
  return invoke<SheetsResult>("get_sheets");
}

export async function getActiveSheet(): Promise<number> {
  return invoke<number>("get_active_sheet");
}

export async function setActiveSheet(
  index: number,
  options?: SheetRecordingOptions,
): Promise<SheetsResult> {
  const result = await invoke<SheetsResult>("set_active_sheet", { index });
  if (options?.record !== false) recordGridEvent({ kind: "activateSheet", index });
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

/**
 * Add a sheet at the end of the workbook and switch to it. `kind` defaults to
 * a worksheet; "canvas" adds a canvas sheet with the default layout.
 */
export async function addSheet(name?: string, kind?: SheetKindName): Promise<SheetsResult> {
  const before = await sheetNamesBefore();
  const result = await invoke<SheetsResult>("add_sheet", {
    name: name ?? null,
    kind: kind ?? null,
  });
  announceSheetAdded(before, result, "new");
  // The sheet COLLECTION changed (§3cd). SheetTabs reloads its list from the
  // `sheets` domain; SHEET_ADDED above is a lifecycle notification that the tab
  // bar has never listened to, so a script's `sheets.add` used to leave the tab
  // bar showing the old list until something else happened to switch sheets.
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["sheets"], source: "commit" });
  // Recorded with the RESOLVED name/index: add_sheet auto-names when the caller
  // passes none, and a macro that replays "add a sheet called undefined" is
  // useless. Same name-diff the announcement uses (sheet names are unique).
  const known = new Set(before.map((s) => s.name));
  const added = result.sheets.find((s) => !known.has(s.name));
  if (added) {
    recordGridEvent({
      kind: "addSheet",
      index: added.index,
      name: added.name,
      ...(added.kind === "canvas" ? { sheetKind: "canvas" as const } : {}),
    });
  }
  return result;
}

/**
 * Change a canvas sheet's layout (partial patch). `sheetIndex` defaults to the
 * active sheet. Refused by the backend for a worksheet or an out-of-range value.
 * The backend announces the change on `sheet:canvas-layout-changed`, which the
 * Shell bridges to `AppEvents.CANVAS_LAYOUT_CHANGED`.
 */
export async function setCanvasLayout(
  patch: CanvasLayoutPatch,
  sheetIndex?: number,
): Promise<CanvasLayout> {
  return invoke<CanvasLayout>("set_canvas_layout", {
    sheetIndex: sheetIndex ?? null,
    patch,
  });
}

/**
 * Announce a sheet DELETED -- SHEET_DELETED, then MUTATION_REFRESH over every
 * domain a sheet's deletion leaves stale. ONE body for both routes that delete
 * a sheet (`deleteSheet` and `discardEphemeralSheet`), so the two can never
 * announce different cascades.
 */
function announceSheetDeleted(sheetIndex: number, sheetName: string): void {
  emitAppEvent(AppEvents.SHEET_DELETED, { sheetIndex, sheetName });
  // §3bn. Deleting a sheet is the widest object deletion in the workbook: the
  // tables and pivots ON it go, the slicers, timelines, charts and sparklines
  // anchored to it go with them, and every one of those objects on a sheet
  // ABOVE it is renumbered. Each of those stores is cached by its own
  // extension, so an announcement is the only thing that makes the caches
  // agree with the backend -- otherwise a slicer keeps painting on the sheet
  // that inherited its index. Core names DOMAINS, never features; the Shell
  // translator owns the mapping.
  // "paneControl" is here because the cascade is TRANSITIVE and nobody had
  // noticed: the sheet's CHARTS go with it, and a deleted chart clears the
  // chart-parameter binding of every pane-control slider that drove it. The
  // §3cd domain walk derives that from the matrix; the backend half of the
  // same cascade was missing outright (cascade_deleted_charts was never run on
  // this path), which is what made the announcement worth having.
  // "floatingRanges" for the same transitive reason: floating ranges HOSTED
  // on the deleted sheet die with it (Sheet → floatingRange.hostSheet,
  // Cascade), and the FloatingRange extension caches the row store.
  emitAppEvent(AppEvents.MUTATION_REFRESH, {
    domains: ["sheets", "slicer", "pivot", "ribbonFilter", "objects", "paneControl", "floatingRanges"],
    source: "commit",
  });
}

/**
 * `deleteSheet`'s options: the recorder's, and the sheet the caller MEANS.
 */
export interface SheetDeleteOptions extends SheetRecordingOptions {
  /**
   * The STABLE id of the sheet the caller means by `index`. When given, the
   * backend deletes only if the sheet at `index` still carries this id when
   * the delete holds its locks, and otherwise refuses -- nothing deleted,
   * nothing announced, nothing recorded -- with "The sheets changed while that
   * sheet was being deleted, so nothing was deleted." An index read earlier
   * names whichever sheet slid into it after a temporary sheet's discard, an
   * MCP move or an insert, and a delete ends the undo history: the tab strip's
   * Delete passes the id of the sheet its confirmation named
   * (model-drillthrough.md 2.7).
   */
  expectedSheetId?: string;
}

export async function deleteSheet(
  index: number,
  options?: SheetDeleteOptions,
): Promise<SheetsResult> {
  const before = await sheetNamesBefore();
  const expectedSheetId = options?.expectedSheetId;
  // The name SHEET_DELETED carries. By id when the caller named the sheet: a
  // delete that lands deleted THAT sheet at `index`, whatever stood at `index`
  // when the names were read.
  const removed =
    (expectedSheetId !== undefined ? before.find((s) => s.sheetId === expectedSheetId) : undefined) ??
    before.find((s) => s.index === index);
  const result = await invoke<SheetsResult>(
    "delete_sheet",
    expectedSheetId !== undefined ? { index, expectedSheetId } : { index },
  );
  // Only after the delete LANDED, at the index it was asked for -- which, with
  // an expected id, is guaranteed to be the index the backend deleted.
  announceSheetDeleted(index, removed?.name ?? "");
  // `record: false` skips ONLY the recorder: the announcements above are owed
  // to every cache no matter who deleted the sheet.
  if (options?.record !== false) recordGridEvent({ kind: "deleteSheet", index });
  return result;
}

/**
 * Discard a TEMPORARY (drill-through) sheet by its STABLE id -- the tab strip's
 * discard of a temporary sheet the user left, and of the one a drill runner
 * clears before it adds the next (docs/design/model-drillthrough.md 2.7).
 *
 * By id, never by index: the backend resolves the id to the sheet's CURRENT
 * index in the same command that deletes it, and refuses -- leaving the
 * document clean and nothing deleted -- when no sheet has that id ("There is
 * no sheet with that id.") or the sheet is no longer temporary ("That sheet is
 * not temporary any more."). An index read earlier could name whichever sheet
 * slid into it after an insert, a copy or a move: the strip once deleted the
 * user's own sheet that way and left the temporary one behind.
 *
 * Otherwise it is the `delete_sheet` command's own body (the slicer pre and
 * post work, the quiet BI re-query), and it announces EXACTLY what
 * `deleteSheet` announces -- SHEET_DELETED with the index and name the backend
 * reports, and the same seven-domain MUTATION_REFRESH -- through the one
 * shared `announceSheetDeleted`. It records NOTHING: the discard is a
 * consequence of the drill, not a step of the user's macro, and replayed it
 * would delete whatever sheet holds that index later.
 */
export async function discardEphemeralSheet(sheetId: string): Promise<DiscardedSheet> {
  const answer = await invoke<DiscardedSheet>("discard_ephemeral_sheet", { sheetId });
  announceSheetDeleted(answer.deletedIndex, answer.deletedName);
  return answer;
}

export async function renameSheet(index: number, newName: string): Promise<SheetsResult> {
  const before = await sheetNamesBefore();
  const oldName = before.find((s) => s.index === index)?.name ?? "";
  const result = await invoke<SheetsResult>("rename_sheet", { index, newName });
  emitAppEvent(AppEvents.SHEET_RENAMED, { sheetIndex: index, oldName, newName });
  // Same reason as addSheet: the tab bar reads the sheet LIST, and a rename
  // driven from a script or a macro never touched it (§3cd).
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["sheets"], source: "commit" });
  recordGridEvent({ kind: "renameSheet", index, newName });
  return result;
}

export async function moveSheet(fromIndex: number, toIndex: number): Promise<SheetsResult> {
  const result = await invoke<SheetsResult>("move_sheet", { fromIndex, toIndex });
  // A move renumbers sheets under every index-anchored object exactly as a
  // delete does (§3bn) -- the backend re-anchors them, and the caches have to
  // re-read or they keep the pre-move index.
  emitAppEvent(AppEvents.MUTATION_REFRESH, {
    domains: ["sheets", "slicer", "pivot", "ribbonFilter", "objects"],
    source: "commit",
  });
  return result;
}

export async function copySheet(sourceIndex: number, newName?: string): Promise<SheetsResult> {
  const before = await sheetNamesBefore();
  const result = await invoke<SheetsResult>("copy_sheet", {
    sourceIndex,
    newName: newName ?? null,
  });
  announceSheetAdded(before, result, "copy");
  // The insertion shifted every sheet at or above it up by one, and the backend
  // re-anchored the index-keyed object stores with it (§3bn).
  emitAppEvent(AppEvents.MUTATION_REFRESH, {
    domains: ["sheets", "slicer", "pivot", "ribbonFilter", "objects"],
    source: "commit",
  });
  return result;
}

export async function hideSheet(index: number, level?: "hidden" | "veryHidden"): Promise<SheetsResult> {
  const activeBefore = await activeSheetBeforeVisibilityChange();
  const result = await invoke<SheetsResult>("hide_sheet", { index, level: level ?? null });
  announceVisibilityChange(activeBefore, result);
  return result;
}

export async function unhideSheet(index: number): Promise<SheetsResult> {
  const activeBefore = await activeSheetBeforeVisibilityChange();
  const result = await invoke<SheetsResult>("unhide_sheet", { index });
  announceVisibilityChange(activeBefore, result);
  return result;
}

/**
 * The backend's active sheet BEFORE a hide/unhide, so the announcement below
 * can tell whether the call moved it. A failing read never fails the hide (the
 * same rule as `sheetNamesBefore`): it answers null, and an unknown "before"
 * announces nothing -- exactly the behaviour these wrappers had before they
 * announced at all, never the out-of-order announcement described below.
 */
async function activeSheetBeforeVisibilityChange(): Promise<number | null> {
  try {
    return await invoke<number>("get_active_sheet");
  } catch {
    return null;
  }
}

/**
 * The sheet COLLECTION's visibility changed (§3cd): announce the generic
 * domain moveSheet uses, so every reader of the sheet list (tab strip, report
 * pages) re-reads -- hiding a NON-active sheet, or unhiding any sheet, used to
 * announce nothing at all.
 *
 * But ONLY when the active sheet stayed put. A hide of the ACTIVE sheet moved
 * the backend's active sheet; the caller that applies that switch (SheetTabs'
 * `applySheetsResult`) announces SHEET_CHANGED with its detail AFTER the
 * frontend switched. Announcing here as well would put a detail-less
 * SHEET_CHANGED in front of the switch, and every cache keyed on the BACKEND's
 * active sheet (Controls' `reloadForSheetChange` reads `getActiveSheet()`)
 * would load the new sheet's objects while the grid still paints the old one.
 *
 * Called only after the invoke resolved: a refused hide (last visible sheet,
 * protected structure) throws first and announces nothing.
 */
function announceVisibilityChange(activeBefore: number | null, result: SheetsResult): void {
  if (activeBefore === null || result?.activeIndex !== activeBefore) return;
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["sheets"], source: "commit" });
}

export async function setTabColor(index: number, color: string): Promise<SheetsResult> {
  return invoke<SheetsResult>("set_tab_color", { index, color });
}

/**
 * Make a TEMPORARY (drill-through) sheet an ordinary one, by its STABLE id:
 * the backend drops the id from the session-only ephemeral set and answers
 * the list. A sheet PRIMITIVE, like `setScrollArea`: it dirties nothing (no
 * save reads the flag) and the Shell calls it by its own name, never through a
 * feature's command.
 *
 * The backend REFUSES an id no sheet has ("There is no sheet with that id." --
 * say, the discard already landed) and an object-backed sheet. A sheet that is
 * ALREADY ordinary is not refused: keeping the same sheet twice (a repeated
 * double-click, Keep Sheet racing a refused discard's keep) is harmless and
 * true. So an answer alone never proves THIS sheet was temporary and is now
 * kept -- a caller that tells the user so reads the answered list: the row
 * with this id, and its `ephemeral` flag off.
 *
 * Announces the `sheets` domain the way `renameSheet` does: a listed attribute
 * changed, and the readers of the list -- the report pages, which skip an
 * ephemeral canvas -- have to re-read to see the sheet as permanent.
 */
export async function keepEphemeralSheet(sheetId: string): Promise<SheetsResult> {
  const result = await invoke<SheetsResult>("keep_ephemeral_sheet", { sheetId });
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["sheets"], source: "commit" });
  return result;
}

export async function nextSheet(): Promise<SheetsResult> {
  return invoke<SheetsResult>("next_sheet");
}

export async function previousSheet(): Promise<SheetsResult> {
  return invoke<SheetsResult>("previous_sheet");
}

/**
 * Wave 3 cross-sheet dispatch for the four structural commands: when
 * `sheetIndex` names a NON-ACTIVE sheet, the backend runs the whole
 * off-sheet chain (state only) and the frontend must NOT emit its
 * active-canvas structural events — those shift frontend stores that
 * describe the VISIBLE sheet (pinned controls, selections, ...), which the
 * edit never touched. It announces `announceStructuralEditElsewhere`
 * instead. Returns true when the off-sheet path applies.
 */
async function isOffSheetTarget(sheetIndex: number | undefined): Promise<boolean> {
  if (sheetIndex === undefined || sheetIndex === null) return false;
  const active = await invoke<number>("get_active_sheet");
  return active !== sheetIndex;
}

/**
 * A row/column edit landed OFF the active sheet's canvas: on a NON-ACTIVE
 * sheet (`sheetIndex`: a script's, the CLI's) or on a floating grid's BACKING
 * sheet (the cell-target route). The backend moved the chart and sparkline
 * data ranges there as well, inside the edit's own undo step (BUG-0357,
 * chart_range_shift.rs) -- and a chart PLACED on the active sheet may chart
 * the sheet that moved. The Charts and Sparklines stores cache those ranges and
 * write a record back whole, so while these routes announced nothing the
 * stores kept the old range until a reload, and the next persist of such a
 * chart (a drag, a title edit) wrote the OLD range back over the moved one.
 *
 * The ROWS_INSERTED family cannot say it: those events carry ACTIVE-sheet
 * coordinates and their listeners shift active-sheet stores by them.
 *
 * WHAT IS ANNOUNCED, AND ONLY THAT (review FU#5). This used to announce what
 * the UNDO of the same edit announces -- STRUCTURAL_UNDO and the `objects`
 * domain -- and both reach far more than this edit changed: every
 * STRUCTURAL_UNDO listener re-reads the VISIBLE sheet's store and several close
 * open UI (an AutoFilter dropdown, a validation list or input prompt; Controls
 * drops and reloads the sheet's controls; the chart store's reload deselects
 * the selected chart), and the `objects` fan-out (charts:refresh) clears every
 * chart's point selections, widget values and insight cues. So an edit on a
 * sheet the user is not even looking at disturbed the sheet they are, more than
 * an edit on that sheet itself does. Now, per burst:
 *   - STRUCTURAL_EDIT_ELSEWHERE: every store that caches what the backend
 *     keeps for OTHER sheets re-reads it -- the chart and sparkline ranges and
 *     the author's designated writeback regions, through
 *     `extensions/_shared/lib/structuralEditReload.ts`, and @api/cellBehaviors'
 *     workbook-wide binding index (whose only off-sheet trigger was the
 *     `objects` domain, rev4A#1); the chart store reconciles a pending save
 *     with the moved range as after an on-sheet edit, and keeps the chart that
 *     is selected;
 *   - TABLE_DEFINITIONS_UPDATED: tables are workbook-wide, and the edited sheet's
 *     moved;
 *   - "grid:refresh": the sheet on screen re-reads its cells (a formula there
 *     that points at the edited sheet was rewritten and recalculated), and so do
 *     floating grids (the cell-target route edits one's backing sheet) and the
 *     object bindings that read cells;
 *   - after a DELETE, the BUG-0054 cascade (`announceStructuralDeleteCascade`):
 *     a pivot the delete covered died with its slicers.
 *
 * ONE ANNOUNCEMENT PER BURST. Each call announced at once, so a script loop of
 * N off-sheet inserts set off N rounds of re-reads, all fire-and-forget, piling
 * up behind the loop. The first call of a burst announces AT ONCE (a single
 * edit is never left unannounced); calls inside the following
 * `STRUCTURAL_EDIT_ELSEWHERE_WINDOW_MS` fold into ONE trailing announcement at
 * its end, and the window stays open while they keep coming. So every edit is
 * announced within one window, and at most one announcement is made per window
 * -- plus one more each time an on-screen insert or delete has to deliver the
 * window's edits ahead of its own event (see below).
 * The chart store's save cannot write an old range back meanwhile: the backend
 * refuses a save made against a record it has since rewritten
 * (CHART_RECORD_CHANGED) and the store merges.
 *
 * THE EDITS RIDE ALONG, NONE FOLDED (`StructuralEditElsewherePayload.edits`).
 * A re-read cannot help a store whose coordinates the BACKEND never holds -- an
 * embedded form's anchor, Controls' side state filed under an id derived from
 * the anchor cell the backend just moved -- so each announcement lists every
 * edit it covers, in order, and such a store replays them on the sheet named,
 * as it replays the ROWS_ family's coordinates on the sheet on screen. The
 * descriptions are folded (they name what happened); the edits never are. And
 * an on-screen insert or delete flushes the trailing edits FIRST
 * (`emitStructuralEvent`), so the two kinds of shift are heard in the order
 * they were made.
 *
 * Called only after the invoke resolved: a refused edit throws first and
 * announces nothing.
 */
function announceStructuralEditElsewhere(
  description: string,
  edit: StructuralEditElsewhereEdit,
  options?: { deletes?: boolean },
): void {
  const deletes = options?.deletes === true;
  if (elsewhereBurst === null) {
    elsewhereBurst = { trailing: null };
    flushStructuralEditElsewhere({ descriptions: [description], edits: [edit] }, deletes);
    setTimeout(closeStructuralEditElsewhereWindow, STRUCTURAL_EDIT_ELSEWHERE_WINDOW_MS);
    return;
  }
  const trailing =
    elsewhereBurst.trailing ?? (elsewhereBurst.trailing = { descriptions: [], edits: [], deletes: false });
  if (!trailing.descriptions.includes(description)) trailing.descriptions.push(description);
  trailing.edits.push(edit);
  trailing.deletes = trailing.deletes || deletes;
}

/** How long one off-canvas structural announcement covers the calls after it (see above). */
const STRUCTURAL_EDIT_ELSEWHERE_WINDOW_MS = 50;

/** What arrived inside an open window and is announced at its end. */
interface TrailingStructuralEdits {
  descriptions: string[];
  edits: StructuralEditElsewhereEdit[];
  deletes: boolean;
}

/** The open burst: null between bursts; `trailing` = what arrived inside the window. */
let elsewhereBurst: { trailing: TrailingStructuralEdits | null } | null = null;

function closeStructuralEditElsewhereWindow(): void {
  const trailing = elsewhereBurst?.trailing ?? null;
  if (trailing === null) {
    elsewhereBurst = null;
    return;
  }
  elsewhereBurst = { trailing: null };
  flushStructuralEditElsewhere({ descriptions: trailing.descriptions, edits: trailing.edits }, trailing.deletes);
  setTimeout(closeStructuralEditElsewhereWindow, STRUCTURAL_EDIT_ELSEWHERE_WINDOW_MS);
}

/**
 * Announce NOW what the open window holds, if anything -- before an on-screen
 * structural event (`emitStructuralEvent`), so no edit is heard after one made
 * later. The window stays open: its timer still runs and ends the burst (or
 * announces what arrives after this) as before.
 */
function flushPendingStructuralEditsElsewhere(): void {
  const trailing = elsewhereBurst?.trailing ?? null;
  if (elsewhereBurst === null || trailing === null) return;
  elsewhereBurst.trailing = null;
  flushStructuralEditElsewhere({ descriptions: trailing.descriptions, edits: trailing.edits }, trailing.deletes);
}

function flushStructuralEditElsewhere(payload: StructuralEditElsewherePayload, deletes: boolean): void {
  emitAppEvent(ApiAppEvents.STRUCTURAL_EDIT_ELSEWHERE, payload);
  emitAppEvent(ApiAppEvents.TABLE_DEFINITIONS_UPDATED);
  emitAppEvent(AppEvents.GRID_DATA_REFRESH);
  if (deletes) announceStructuralDeleteCascade();
}

/**
 * Insert rows at the specified position, shifting existing rows down.
 * @param row - The row index where new rows will be inserted
 * @param count - Number of rows to insert
 * @param sheetIndex - Target sheet (0-based); omit for the active sheet.
 *   A non-active target updates backend state only (empty result, no
 *   canvas events) — the sheet re-materializes from its grid on switch — and
 *   announces it off the canvas (`announceStructuralEditElsewhere`), with the
 *   edit's sheet and lines.
 */
export async function insertRows(
  row: number,
  count: number,
  sheetIndex?: number,
  opts?: CellTargetOptions,
): Promise<CellData[]> {
  console.log(`[tauri-api] insertRows(${row}, ${count})`);
  const placed = cellTargetArg("insert_rows", opts, sheetIndex);
  if (placed.target) {
    // An OBJECT's lines (P3, table semantics): the backend shifts the object's
    // backing sheet and grows or shrinks its window as ONE undo step. No
    // active-sheet structural event (the active sheet did not change) and no
    // recording -- only the off-canvas announcement (no sheet index names a
    // backing sheet, so its edit says null).
    const result = await invoke<CellData[]>("insert_rows", { row, count, ...placed });
    announceStructuralEditElsewhere("Insert Rows", { sheetIndex: null, kind: "rowInsert", at: row, count });
    return result;
  }
  if (await isOffSheetTarget(sheetIndex)) {
    const result = await invoke<CellData[]>("insert_rows", { row, count, sheetIndex });
    announceStructuralEditElsewhere("Insert Rows", { sheetIndex: sheetIndex as number, kind: "rowInsert", at: row, count });
    return result;
  }
  const result = await invoke<CellData[]>("insert_rows", { row, count });
  console.log(`[tauri-api] insertRows returned ${result.length} updated cells`);
  emitStructuralEvent(AppEvents.ROWS_INSERTED, { startRow: row, count });
  // The sizes moved with the lines (BUG-0360): every caller re-reads them.
  refreshDimensionsAfterLineEdit();
  recordGridEvent({ kind: "insertRows", startRow: row, count });
  return result;
}

/**
 * Insert columns at the specified position, shifting existing columns right.
 * @param col - The column index where new columns will be inserted
 * @param count - Number of columns to insert
 * @param sheetIndex - Target sheet (0-based); omit for the active sheet (see insertRows).
 */
export async function insertColumns(
  col: number,
  count: number,
  sheetIndex?: number,
  opts?: CellTargetOptions,
): Promise<CellData[]> {
  console.log(`[tauri-api] insertColumns(${col}, ${count})`);
  const placed = cellTargetArg("insert_columns", opts, sheetIndex);
  if (placed.target) {
    // An OBJECT's lines (P3, table semantics): the backend shifts the object's
    // backing sheet and grows or shrinks its window as ONE undo step. No
    // active-sheet structural event (the active sheet did not change) and no
    // recording -- only the off-canvas announcement (no sheet index names a
    // backing sheet, so its edit says null).
    const result = await invoke<CellData[]>("insert_columns", { col, count, ...placed });
    announceStructuralEditElsewhere("Insert Columns", { sheetIndex: null, kind: "colInsert", at: col, count });
    return result;
  }
  if (await isOffSheetTarget(sheetIndex)) {
    const result = await invoke<CellData[]>("insert_columns", { col, count, sheetIndex });
    announceStructuralEditElsewhere("Insert Columns", { sheetIndex: sheetIndex as number, kind: "colInsert", at: col, count });
    return result;
  }
  const result = await invoke<CellData[]>("insert_columns", { col, count });
  console.log(`[tauri-api] insertColumns returned ${result.length} updated cells`);
  emitStructuralEvent(AppEvents.COLUMNS_INSERTED, { startCol: col, count });
  refreshDimensionsAfterLineEdit(); // BUG-0360
  recordGridEvent({ kind: "insertColumns", startCol: col, count });
  return result;
}

/**
 * Delete rows at the specified position, shifting remaining rows up.
 * @param row - The row index where deletion starts
 * @param count - Number of rows to delete
 * @param sheetIndex - Target sheet (0-based); omit for the active sheet (see insertRows).
 */
export async function deleteRows(
  row: number,
  count: number,
  sheetIndex?: number,
  opts?: CellTargetOptions,
): Promise<CellData[]> {
  console.log(`[tauri-api] deleteRows(${row}, ${count})`);
  const placed = cellTargetArg("delete_rows", opts, sheetIndex);
  if (placed.target) {
    // An OBJECT's lines (P3, table semantics): the backend shifts the object's
    // backing sheet and grows or shrinks its window as ONE undo step. No
    // active-sheet structural event (the active sheet did not change) and no
    // recording -- only the off-canvas announcement (no sheet index names a
    // backing sheet, so its edit says null).
    const result = await invoke<CellData[]>("delete_rows", { row, count, ...placed });
    announceStructuralEditElsewhere("Delete Rows", { sheetIndex: null, kind: "rowDelete", at: row, count });
    return result;
  }
  if (await isOffSheetTarget(sheetIndex)) {
    const result = await invoke<CellData[]>("delete_rows", { row, count, sheetIndex });
    // The BUG-0054 cascade rides the same burst (one per burst, not per call).
    announceStructuralEditElsewhere(
      "Delete Rows",
      { sheetIndex: sheetIndex as number, kind: "rowDelete", at: row, count },
      { deletes: true },
    );
    return result;
  }
  const result = await invoke<CellData[]>("delete_rows", { row, count });
  console.log(`[tauri-api] deleteRows returned ${result.length} updated cells`);
  emitStructuralEvent(AppEvents.ROWS_DELETED, { startRow: row, count });
  announceStructuralDeleteCascade();
  refreshDimensionsAfterLineEdit(); // BUG-0360
  recordGridEvent({ kind: "deleteRows", startRow: row, count });
  return result;
}

/**
 * BUG-0054: a row/column delete that fully covers a pivot region removes the
 * pivot in the backend AND cascades the slicers / timeline slicers / ribbon
 * filter targets bound to it (`shift_pivot_regions_for_row_delete` +
 * `collect_doomed_pivots`) — and each of those stores is cached by its own
 * extension, so without an announcement a dead slicer keeps painting and
 * eating clicks. Same recipe as `deleteSheet` above: Core names DOMAINS,
 * never features; the Shell translator owns the mapping. Emitted
 * unconditionally because the frontend cannot know whether a pivot died
 * without re-asking, which is exactly what the refresh does.
 */
function announceStructuralDeleteCascade(): void {
  emitAppEvent(AppEvents.MUTATION_REFRESH, {
    domains: ["slicer", "pivot", "ribbonFilter"],
    source: "commit",
  });
}

/**
 * Delete columns at the specified position, shifting remaining columns left.
 * @param col - The column index where deletion starts
 * @param count - Number of columns to delete
 * @param sheetIndex - Target sheet (0-based); omit for the active sheet (see insertRows).
 */
export async function deleteColumns(
  col: number,
  count: number,
  sheetIndex?: number,
  opts?: CellTargetOptions,
): Promise<CellData[]> {
  console.log(`[tauri-api] deleteColumns(${col}, ${count})`);
  const placed = cellTargetArg("delete_columns", opts, sheetIndex);
  if (placed.target) {
    // An OBJECT's lines (P3, table semantics): the backend shifts the object's
    // backing sheet and grows or shrinks its window as ONE undo step. No
    // active-sheet structural event (the active sheet did not change) and no
    // recording -- only the off-canvas announcement (no sheet index names a
    // backing sheet, so its edit says null).
    const result = await invoke<CellData[]>("delete_columns", { col, count, ...placed });
    announceStructuralEditElsewhere("Delete Columns", { sheetIndex: null, kind: "colDelete", at: col, count });
    return result;
  }
  if (await isOffSheetTarget(sheetIndex)) {
    const result = await invoke<CellData[]>("delete_columns", { col, count, sheetIndex });
    // The BUG-0054 cascade rides the same burst (one per burst, not per call).
    announceStructuralEditElsewhere(
      "Delete Columns",
      { sheetIndex: sheetIndex as number, kind: "colDelete", at: col, count },
      { deletes: true },
    );
    return result;
  }
  const result = await invoke<CellData[]>("delete_columns", { col, count });
  console.log(`[tauri-api] deleteColumns returned ${result.length} updated cells`);
  emitStructuralEvent(AppEvents.COLUMNS_DELETED, { startCol: col, count });
  announceStructuralDeleteCascade();
  refreshDimensionsAfterLineEdit(); // BUG-0360
  recordGridEvent({ kind: "deleteColumns", startCol: col, count });
  return result;
}

// ============================================================================
// Insert Cells / Delete Cells (Excel's "Shift cells right / down / left / up")
// ============================================================================

/** The last row / column index of a sheet (0-based): Excel's 1,048,576 x XFD. */
const SHEET_LAST_ROW_INDEX = 1_048_575;
const SHEET_LAST_COL_INDEX = 16_383;

// `CellShiftResult` (Rust `api_types::CellShiftResult`) and the two shift
// unions mirror the Rust command's types and live in core/types/types.ts.
export type { CellShiftResult, InsertCellsShift, DeleteCellsShift } from "../types";

/** Options for the cell-shift wrappers. */
export interface CellShiftOptions {
  /** The user answered OK to `confirm`: unmerge the merges the shift cuts and go on. */
  unmergeCutMerges?: boolean;
}

/**
 * Which whole-line command a range that spans every column (row) is: Excel
 * inserts / deletes ENTIRE rows (columns) for such a range whatever shift was
 * asked for (measured live). Those go through the row / column wrappers so
 * they announce and record exactly as the row / column commands do.
 */
function wholeLineSpan(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): { axis: "rows" | "columns"; start: number; count: number } | null {
  // THE SHEET-SIZE BOUND OF THIS ROUTE'S OWN (BUG-0399). A script reaches
  // this wrapper through @api with any numbers: a range "spanning every
  // column" whose rows ran past the sheet (endRow 5,000,000) became an
  // insert/delete of millions of rows, refused only by the backend's push-off
  // gate. Every coordinate must be a cell index of the sheet; an end past the
  // sheet's last line is that last line, so a count is never more lines than
  // the sheet has from `start` on.
  for (const [name, value] of [
    ["startRow", startRow],
    ["startCol", startCol],
    ["endRow", endRow],
    ["endCol", endCol],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`Insert/Delete Cells: ${name} must be a cell index of the sheet (got ${String(value)}).`);
    }
  }
  const r0 = Math.min(startRow, endRow);
  const r1 = Math.min(Math.max(startRow, endRow), SHEET_LAST_ROW_INDEX);
  const c0 = Math.min(startCol, endCol);
  const c1 = Math.min(Math.max(startCol, endCol), SHEET_LAST_COL_INDEX);
  if (r0 > SHEET_LAST_ROW_INDEX || c0 > SHEET_LAST_COL_INDEX) {
    throw new RangeError("Insert/Delete Cells: the range starts outside the sheet.");
  }
  if (c0 === 0 && c1 >= SHEET_LAST_COL_INDEX) return { axis: "rows", start: r0, count: r1 - r0 + 1 };
  if (r0 === 0 && r1 >= SHEET_LAST_ROW_INDEX) return { axis: "columns", start: c0, count: c1 - c0 + 1 };
  return null;
}

/**
 * A cell shift moved part of the sheet's cells and every store anchored to
 * them (notes, comments, hyperlinks, controls, validations, conditional
 * formats, tables, names). It moves no WHOLE rows or columns, so the
 * ROWS_INSERTED family cannot describe it: the extensions that cache those
 * stores re-read them on STRUCTURAL_UNDO -- the announcement an undone insert
 * also makes -- and on the MUTATION_REFRESH domains below. It carries the
 * shift as COORDINATES (`source: "edit"`, `deltas`: the backend's band edit,
 * `CellShiftResult.delta`), which the stores whose coordinates the backend
 * never holds follow (@api/structuralFollow). Emitted here, at the IPC
 * wrapper, so every route announces (the convention events.ts records).
 */
function announceCellShift(description: string, delta: StructuralDelta | null | undefined): void {
  emitAppEvent(ApiAppEvents.STRUCTURAL_UNDO, { description, source: "edit", deltas: delta ? [delta] : [] });
  emitAppEvent(AppEvents.MUTATION_REFRESH, {
    domains: [
      "styles",
      "objects",
      "namedRanges",
      "hyperlinks",
      "validations",
      "annotations",
      "controls",
      "conditionalFormats",
    ],
    source: "commit",
  });
}

/**
 * A row / column insert or delete on the ACTIVE sheet moved the backend's row
 * heights or column widths -- and an inserted line now TAKES its neighbour's
 * size (Excel's "Format Same As Above"). Most callers re-read only the cells,
 * so the grid is told here to re-read its dimensions too (Core's own
 * `dimensions:refresh`, which Spreadsheet answers by fetching the sizes, the
 * defaults and the hidden sets); without it the old sizes stayed painted on
 * the old lines until the next sheet switch.
 *
 * ASKED BY THE FOUR LINE WRAPPERS THEMSELVES (BUG-0360), so EVERY caller gets
 * it: a script's table row insert, Insert Copied Cells' whole rows, the cell
 * shift's whole-line route, a CLI or extension call -- not only the callers
 * that remembered to ask. Core's own row/column gesture still awaits its own
 * `refreshDimensions()` before it animates; the second, queued re-read this
 * adds is an idempotent fetch of the same sizes.
 */
function refreshDimensionsAfterLineEdit(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("dimensions:refresh"));
}

/**
 * Excel's Insert Cells on the ACTIVE sheet: shift the range's cells right or
 * down inside the band of rows (columns) it covers. References into the moved
 * block follow it on every sheet; see `commands/structure_cells.rs` for the
 * measured rules. ONE undo step.
 */
export async function insertCellsRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  shift: InsertCellsShift,
  options: CellShiftOptions = {},
): Promise<CellShiftResult> {
  const whole = wholeLineSpan(startRow, startCol, endRow, endCol);
  if (whole) {
    // The row / column wrapper re-reads the dimensions itself (BUG-0360).
    if (whole.axis === "rows") await insertRows(whole.start, whole.count);
    else await insertColumns(whole.start, whole.count);
    return { applied: true, confirm: null, wholeLines: true };
  }
  const result = await invoke<CellShiftResult>("insert_cells", {
    startRow,
    startCol,
    endRow,
    endCol,
    shift,
    unmergeCutMerges: options.unmergeCutMerges ?? false,
  });
  if (result.applied) {
    announceCellShift("Insert Cells", result.delta);
    // Recorded once it landed (BUG-0358); a stop to ask changed nothing.
    recordGridEvent({
      kind: "insertCells",
      startRow,
      startCol,
      endRow,
      endCol,
      shift,
      unmergeCutMerges: options.unmergeCutMerges ?? false,
    });
  }
  return result;
}

/**
 * Excel's Delete Cells on the ACTIVE sheet: remove the range's cells and shift
 * the rest of the band left or up. See `insertCellsRange`.
 */
export async function deleteCellsRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  shift: DeleteCellsShift,
  options: CellShiftOptions = {},
): Promise<CellShiftResult> {
  const whole = wholeLineSpan(startRow, startCol, endRow, endCol);
  if (whole) {
    if (whole.axis === "rows") await deleteRows(whole.start, whole.count);
    else await deleteColumns(whole.start, whole.count);
    return { applied: true, confirm: null, wholeLines: true };
  }
  const result = await invoke<CellShiftResult>("delete_cells", {
    startRow,
    startCol,
    endRow,
    endCol,
    shift,
    unmergeCutMerges: options.unmergeCutMerges ?? false,
  });
  if (result.applied) {
    announceCellShift("Delete Cells", result.delta);
    recordGridEvent({
      kind: "deleteCells",
      startRow,
      startCol,
      endRow,
      endCol,
      shift,
      unmergeCutMerges: options.unmergeCutMerges ?? false,
    });
  }
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
   * A READOUT (test oracles, diagnostics) -- never the way to decide whether a
   * close is yours: between this probe and your begin the open transaction can
   * commit, and your "join" then OPENS one nobody closes (the W3 window). Use
   * the answer of `beginUndoTransaction` itself: a ticket when YOUR begin
   * opened the transaction (close it, presenting the ticket), null when it
   * joined another caller's (close nothing) -- `ownUndoTransaction` does both.
   */
  transactionOpen: boolean;
  /**
   * The history ids on the undo stack, oldest first.
   *
   * `undoDepth` is a SIZE, not a position, and the two must not be confused.
   * History is capped at `historyLimit`; past the cap every push silently
   * drops the oldest entry and the depth stops growing, so
   * `depthNow - depthThen` under-counts the distance back to a remembered
   * point. To return to one, remember the id on TOP at that moment and later
   * count the entries above it; if the id is absent, that state is
   * unreachable and no step count restores it.
   */
  undoSeqs: number[];
  /** How many transactions the cap has dropped over this document's life. */
  evictedTotal: number;
  /**
   * How many transactions a WHOLESALE clear has discarded over this document's
   * life — i.e. how much history a workbook-STRUCTURE change ended.
   *
   * A remembered id can go missing for three reasons and only one of them is a
   * product defect: the cap dropped it (`evictedTotal` moved), a sheet was
   * added / deleted / renamed / moved / copied and Excel-parity ended the
   * history (this moved), or the caller undid past it (neither moved).
   */
  clearedTotal: number;
  /** The history cap (Excel keeps 100 too). */
  historyLimit: number;
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
  /** User-hidden rows/columns restored (a hide/unhide undo, or the coordinate
   *  shift a structural undo reverses). Re-read getUserHiddenRows/Cols:
   *  nothing in updatedCells reveals that a row's visibility changed. */
  hiddenChanged: boolean;
  /** Why a SCOPED undo refused, as a sentence to show. Absent on every
   *  ordinary undo, and on a scoped one that went ahead. Distinct from
   *  `success: false`, which means "there was nothing to undo". */
  refusal?: string | null;
  /** Every refresh DOMAIN this undo/redo touched, named exactly as the Shell's
   *  MUTATION_REFRESH translator expects.
   *
   *  The flags above are DERIVED from this same set in Rust, so the two cannot
   *  disagree; the list exists because the flags could not grow — the domains
   *  that never got one (outline, hyperlinks, validations, annotations,
   *  controls) are precisely the ones whose undo repainted nothing. Read this,
   *  not the flags, when deciding what to refresh. */
  refreshDomains: string[];
  /** The sheet that is ACTIVE now the restore has finished.
   *
   *  Excel keeps one undo history and switches to the sheet the undone action
   *  happened on, so the user can see what changed; the backend performs that
   *  switch and reports it here. Reported UNCONDITIONALLY, not only when it
   *  moved — the caller decides whether to follow by comparing it with the
   *  sheet IT believes is active, which is the only comparison that can also
   *  repair a disagreement. */
  activeSheetIndex: number;
  /** Name of `activeSheetIndex`. It rides along so following the switch costs
   *  no second round trip: the tab strip, the grid's sheet context and the
   *  SHEET_CHANGED announcement all need it, and fetching it separately would
   *  open a window in which the app has switched sheets and cannot say which. */
  activeSheetName: string;
  /** Top-left cell the restore rewrote on `activeSheetIndex`, or null when it
   *  named no cell (a column width, a whole-sheet snapshot, an opaque custom
   *  payload). Switching sheets is only half of "so the user can see what
   *  changed" — the restored cells can be far outside the viewport that sheet
   *  was left at, and this is what the selection is aimed at. */
  restoredAnchor: { row: number; col: number } | null;
  /** The whole RANGE the restore rewrote on `activeSheetIndex`, or null on the
   *  same restores `restoredAnchor` is null on.
   *
   *  Excel selects the range an undo restored, not merely its corner: undo a
   *  four-cell paste and all four come back selected. `restoredAnchor` is this
   *  range's top-left corner, and both come from one derivation in the backend,
   *  so they cannot disagree about which cells the restore touched. Inclusive at
   *  both ends.
   *
   *  NOTE Excel leaves the ACTIVE cell at the top-left; Calcula's selection
   *  model pins the active cell to `endRow`/`endCol`, so a well-formed
   *  selection leaves it at the bottom-right. Named divergence, not an
   *  oversight — see `UndoResult.restored_range` in undo_commands.rs. */
  restoredRange: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  } | null;
  /** The coordinate changes this restore made, IN THE ORDER MADE: for an Undo
   *  the inverse of each change the step recorded, newest first (an undone
   *  insert reads as the delete that took its lines back); for a Redo each
   *  change again, oldest first. Every change of a grouped step is listed, an
   *  Insert / Delete Cells with its band, a cut-paste as a move -- read from
   *  the step itself, never its description. Empty when nothing moved.
   *  Optional only so an older double without it reads as empty. */
  structuralDeltas?: StructuralDelta[];
}

/**
 * Begin an undo transaction. All subsequent cell changes will be grouped
 * into a single undoable action until commitUndoTransaction() is called.
 *
 * Resolves a TICKET when THIS begin OPENED the transaction, or `null` when it
 * JOINED one another caller already holds open (the join marks that step as
 * shared). Decided by the backend under the one lock that opens it, so it is
 * the only race-free answer to "is this commit mine?": commit (or cancel)
 * exactly when this handed you a ticket, and PRESENT it -- the backend then
 * closes the slot only while it still holds the transaction you opened. A
 * sheet add / delete / rename / move / copy or a document swap ends that
 * transaction behind your back (Excel parity), and without the ticket your
 * close would land on whatever a stranger opened next.
 * @param description - Human-readable label for the transaction (e.g., "Paste 10 cells")
 */
export async function beginUndoTransaction(description: string): Promise<UndoTransactionTicket | null> {
  return invoke<UndoTransactionTicket | null>("begin_undo_transaction", { description });
}

/** Names the ONE undo transaction a {@link beginUndoTransaction} opened. */
export type UndoTransactionTicket = number;

// Reading a begin's answer, and closing ONLY what that begin opened, live in a
// pure module of their own (no IPC), so a gesture can close through the very
// commit / cancel it imports -- and a test that mocks this module wholesale
// still gets the real reading. See undoTransactionOwnership.ts.
export { readUndoBeginAnswer, ownUndoTransaction } from "./undoTransactionOwnership";
export type {
  UndoBeginAnswer,
  OwnedUndoTransaction,
  UndoTransactionCloses,
} from "./undoTransactionOwnership";

/**
 * Commit the current undo transaction, finalizing it as a single undo entry.
 * With `ticket` (from the begin that opened it): only while the backend's slot
 * still holds THAT transaction. Without: whatever is open.
 */
export async function commitUndoTransaction(ticket?: UndoTransactionTicket | null): Promise<void> {
  if (ticket === undefined || ticket === null) return invoke<void>("commit_undo_transaction");
  return invoke<void>("commit_undo_transaction", { ticket });
}

/**
 * Cancel the current undo transaction without saving it: its undo record is
 * DROPPED, its writes stay. With `ticket`: only while the backend's slot still
 * holds THAT transaction. Without: whatever is open.
 */
export async function cancelUndoTransaction(ticket?: UndoTransactionTicket | null): Promise<void> {
  if (ticket === undefined || ticket === null) return invoke<void>("cancel_undo_transaction");
  return invoke<void>("cancel_undo_transaction", { ticket });
}

/**
 * A point in the open undo transaction (Rust `UndoSavepoint`), handed out by
 * {@link beginUndoSavepoint} and presented back, verbatim, to
 * {@link rollBackToUndoSavepoint}.
 */
export interface UndoSavepoint {
  /** The ticket of the transaction the point is in. */
  transaction: number;
  /** How many changes that transaction held at the point. */
  changes: number;
}

/** What {@link beginUndoSavepoint} answers (Rust `UndoSavepointBegin`). */
export interface UndoSavepointBegin {
  /** The ticket when THIS call opened the transaction; null when it joined one. */
  ticket: UndoTransactionTicket | null;
  /** The point, or null when none can be named (nothing could be taken back to it). */
  savepoint: UndoSavepoint | null;
  /** Why there is no point, when the backend knows (another granted run holds the step). */
  refused?: string | null;
}

/** What {@link rollBackToUndoSavepoint} answers (Rust `UndoRollback`). */
export interface UndoRollback extends UndoResult {
  /** Every cell the rollback took back, by its true sheet index. */
  takenBackCells?: { sheet: number; row: number; col: number }[];
}

/**
 * Mark a SAVEPOINT in the open undo transaction -- opening it first when none
 * is open, or JOINING the one a caller holds (undo_commands.rs, "Undo
 * SAVEPOINTS"). Everything recorded after the point can then be taken back
 * EXACTLY with {@link rollBackToUndoSavepoint}, leaving the changes before it
 * (a caller's, in a joined step) untouched. A gesture that already holds its
 * own step (`beginUndoTransaction`) joins it here and gets the point inside it.
 * No point (`savepoint: null`) when the open step is a granted run's
 * (`refused` says so) or carries no ticket this door can name.
 */
export async function beginUndoSavepoint(description: string): Promise<UndoSavepointBegin> {
  return invoke<UndoSavepointBegin>("begin_undo_savepoint", { description });
}

/**
 * Take back exactly the changes recorded after `savepoint` -- through the
 * restore Ctrl+Z uses, leaving no undo and no redo step -- or move nothing and
 * say why in `refusal` (`success: false`). The open transaction is left open,
 * holding what it held at the point: its opener still closes it.
 */
export async function rollBackToUndoSavepoint(savepoint: UndoSavepoint): Promise<UndoRollback> {
  return invoke<UndoRollback>("roll_back_to_undo_savepoint", { savepoint });
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
export async function undo(expectedSeq?: number): Promise<UndoResult> {
  console.log("[tauri-api] undo");
  // SCOPED UNDO. With `expectedSeq` this takes back entry N and nothing else,
  // refusing (and saying why, in `refusal`) if the top of the history has moved.
  //
  // For the caller that writes, hands control back, and must later reverse its
  // OWN write — the push hold-back rolls unticked cells back to their base
  // values, publishes, and restores them, and the publish is long enough for an
  // MCP tool or a script to record an entry of its own. A bare undo there takes
  // back that entry and leaves the author's work rolled back.
  const result = await invoke<UndoResult>("undo", { expectedSeq });
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
  /** Target sheet (0-based). Omit for the active sheet (Wave 3 cross-sheet ops). */
  sheetIndex?: number;
}

/**
 * Find all cells matching the search query.
 * Returns coordinates sorted in reading order (row, then column).
 */
export async function findAll(
  query: string,
  options: FindOptions = {},
  opts?: CellTargetOptions,
): Promise<FindResult> {
  const {
    caseSensitive = false,
    matchEntireCell = false,
    searchFormulas = false,
    sheetIndex,
  } = options;

  return invoke<FindResult>("find_all", {
    query,
    caseSensitive,
    matchEntireCell,
    searchFormulas,
    sheetIndex: sheetIndex ?? null,
    ...cellTargetArg("find_all", opts, sheetIndex),
  });
}

/**
 * Count matches without returning coordinates (faster for display).
 */
export async function countMatches(
  query: string,
  options: FindOptions = {},
  opts?: CellTargetOptions,
): Promise<number> {
  const {
    caseSensitive = false,
    matchEntireCell = false,
    searchFormulas = false,
    sheetIndex,
  } = options;

  return invoke<number>("count_matches", {
    query,
    caseSensitive,
    matchEntireCell,
    searchFormulas,
    sheetIndex: sheetIndex ?? null,
    ...cellTargetArg("count_matches", opts, sheetIndex),
  });
}

/**
 * Replace all occurrences. This is an atomic operation for undo.
 *
 * `sheetIndex` (Wave 3): replace on a NON-ACTIVE sheet — the result's
 * `updatedCells` is empty (no active-canvas repaint) and only
 * `replacementCount` is meaningful.
 */
export async function replaceAll(
  search: string,
  replacement: string,
  options: { caseSensitive?: boolean; matchEntireCell?: boolean; sheetIndex?: number } = {},
  opts?: CellTargetOptions,
): Promise<ReplaceResult> {
  const { caseSensitive = false, matchEntireCell = false, sheetIndex } = options;
  const placed = cellTargetArg("replace_all", opts, sheetIndex);

  console.log(
    `[tauri-api] replaceAll("${search}" -> "${replacement}", caseSensitive=${caseSensitive})`
  );

  const result = await invoke<ReplaceResult>("replace_all", {
    search,
    replacement,
    caseSensitive,
    matchEntireCell,
    sheetIndex: sheetIndex ?? null,
    ...placed,
  });

  console.log(
    `[tauri-api] replaceAll completed: ${result.replacementCount} replacements`
  );

  if (!placed.target) {
    recordGridEvent({
      kind: "replaceAll",
      search,
      replacement,
      caseSensitive,
      matchEntireCell,
    });
  }
  return result;
}

/**
 * Replace a single occurrence in a specific cell.
 *
 * `sheetIndex` (Wave 3): replace on a NON-ACTIVE sheet — the returned
 * CellData (when a replacement happened) is a sheet-tagged stub with no
 * display payload, so do not paint it.
 */
export async function replaceSingle(
  row: number,
  col: number,
  search: string,
  replacement: string,
  caseSensitive: boolean = false,
  sheetIndex?: number,
  opts?: CellTargetOptions,
): Promise<CellData | null> {
  return invoke<CellData | null>("replace_single", {
    row,
    col,
    search,
    replacement,
    caseSensitive,
    sheetIndex: sheetIndex ?? null,
    ...cellTargetArg("replace_single", opts, sheetIndex),
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
// PER-SHEET ZOOM API
// ============================================================================

/**
 * Persist the ACTIVE sheet's zoom, as a REAL PERCENT (100 = 100%).
 *
 * PERCENT, deliberately — the backend, the file (`zoom` in metadata.json),
 * Excel's `zoomScale` and the script contract (`Calcula.getZoom()`) all speak
 * percent. The reducer's `state.zoom` is a RENDER FACTOR (1.0 = 100%); the
 * conversion belongs at this boundary and nowhere else, because a second
 * conversion site is exactly how the factor-vs-percent split-brain happened.
 *
 * Rejects out-of-range values rather than clamping (the backend enforces
 * 10..400), so a caller with a bug hears about it.
 */
export async function setSheetZoom(zoomPercent: number): Promise<void> {
  await invoke<void>("set_sheet_zoom", { zoom: zoomPercent });
}

/** The ACTIVE sheet's persisted zoom as a REAL PERCENT (100 = 100%). */
export async function getSheetZoom(): Promise<number> {
  return await invoke<number>("get_sheet_zoom", {});
}

/**
 * The ACTIVE sheet's DISPLAY FLAGS. Mirrors Rust `api_types::SheetDisplayFlags`.
 */
export async function getSheetDisplayFlags(): Promise<{
  displayZeros: boolean;
  showFormulas: boolean;
  viewMode: string;
  displayHeadings: boolean;
}> {
  return await invoke("get_sheet_display_flags", {});
}

/**
 * Write a PARTIAL display-flags patch for the ACTIVE sheet. One command for all four
 * (see `sheets::set_sheet_display_flags` for why), and partial so a caller cannot
 * clobber the flags it does not know about.
 */
export async function setSheetDisplayFlags(patch: {
  displayZeros?: boolean;
  showFormulas?: boolean;
  viewMode?: string;
  displayHeadings?: boolean;
}): Promise<void> {
  await invoke<void>("set_sheet_display_flags", { patch });
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
  searchRange: [number, number, number, number] | null,
  opts?: CellTargetOptions,
): Promise<GoToSpecialResult> {
  return await invoke<GoToSpecialResult>("go_to_special", {
    criteria,
    searchRange,
    ...cellTargetArg("go_to_special", opts),
  });
}

// ============================================================================
// MERGE CELLS API
// ============================================================================

// The types live in ../types (mirrors of api_types.rs); re-exported here for
// the importers that have always taken them from this module.
export type { MergedRegion, MergeResult, MergeOptions, MovedCell } from "../types";

/** Record what a merge call actually did, region by region, so a macro
 *  replays it with explicit coordinates: absorbed or rebuilt merges are taken
 *  apart first (an unmerge at each master), then every created region is
 *  merged. A Merge Across over N rows therefore records N merges, and the
 *  recorder's codegen needs no new event kind.
 *
 *  `sheetIndex`: the sheet the caller NAMED (a script's off-sheet merge),
 *  carried on every event so the replay merges THAT sheet; recorded without
 *  it, the regions replayed on the active sheet. */
function recordMergeResult(result: MergeResult | null | undefined, sheetIndex?: number): void {
  if (!result || !result.success) return;
  const onSheet = typeof sheetIndex === "number" ? { sheetIndex } : {};
  for (const r of result.removedRegions ?? []) {
    recordGridEvent({ kind: "unmergeCells", row: r.startRow, col: r.startCol, ...onSheet });
  }
  for (const r of result.createdRegions ?? []) {
    recordGridEvent({
      kind: "mergeCells",
      startRow: r.startRow,
      startCol: r.startCol,
      endRow: r.endRow,
      endCol: r.endCol,
      ...onSheet,
    });
  }
}

/**
 * Merge cells in the specified range.
 * The top-left cell becomes the master cell.
 *
 * `sheetIndex` (Wave 3): merge on a NON-ACTIVE sheet — `mergedRegions` in the
 * result then describes the TARGET sheet's merge set and `updatedCells` is
 * empty (no active-canvas repaint).
 *
 * `options` (the ribbon's Merge menu): across / probe -- see `MergeOptions`.
 * Left out, this is a plain Range.Merge. EVERY merge applies Excel's value
 * rule (an empty top-left takes the first value, moved, its readers
 * re-pointed by the backend). A probe changes nothing and records nothing.
 */
export async function mergeCells(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  sheetIndex?: number,
  options?: MergeOptions,
  opts?: CellTargetOptions,
): Promise<MergeResult> {
  const placed = cellTargetArg("merge_cells", opts, sheetIndex);
  const result = await invoke<MergeResult>("merge_cells", {
    startRow,
    startCol,
    endRow,
    endCol,
    sheetIndex: sheetIndex ?? null,
    options: options ?? null,
    ...placed,
  });
  if (!options?.probe && !placed.target) recordMergeResult(result, sheetIndex);
  // A Merge ENDS the clipboard mode as Excel's does [LIVE 2026-10-30,
  // rev11B/probe.ps1 and clip5/probe-endings.ps1: Range.Merge -> CutCopyMode
  // 0], before the gesture announces any value it moved (CELLS_MOVED): the
  // mode is over either way. A probe changes nothing and ends nothing.
  if (!options?.probe && result?.success) announceClipboardModeEnding("merge");
  return result;
}

/**
 * Unmerge cells at the specified position.
 *
 * `sheetIndex` (Wave 3): unmerge on a NON-ACTIVE sheet (see mergeCells).
 *
 * `end` (the ribbon's Unmerge Cells): unmerge EVERY merged region that
 * intersects the rectangle from (row, col) to `end`, in one undo step. Active
 * sheet only. Left out, only the region containing (row, col) is dissolved.
 */
export async function unmergeCells(
  row: number,
  col: number,
  sheetIndex?: number,
  end?: { endRow: number; endCol: number },
  opts?: CellTargetOptions,
): Promise<MergeResult> {
  const placed = cellTargetArg("unmerge_cells", opts, sheetIndex);
  const result = await invoke<MergeResult>("unmerge_cells", {
    row,
    col,
    sheetIndex: sheetIndex ?? null,
    endRow: end?.endRow ?? null,
    endCol: end?.endCol ?? null,
    ...placed,
  });
  if (result?.success && !placed.target) {
    // With the sheet the caller named, as mergeCells records it.
    const onSheet = typeof sheetIndex === "number" ? { sheetIndex } : {};
    for (const r of result.removedRegions ?? []) {
      recordGridEvent({ kind: "unmergeCells", row: r.startRow, col: r.startCol, ...onSheet });
    }
  }
  // An Unmerge ENDS the clipboard mode too [LIVE 2026-10-30, clip5/probe-endings.ps1].
  if (result?.success) announceClipboardModeEnding("merge");
  return result;
}

/**
 * Get the merged regions of the current sheet: all of them, or only those
 * that intersect `range` when one is given.
 */
export async function getMergedRegions(range?: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}): Promise<MergedRegion[]> {
  if (!range) return invoke<MergedRegion[]>("get_merged_regions");
  return invoke<MergedRegion[]>("get_merged_regions", {
    startRow: Math.min(range.startRow, range.endRow),
    startCol: Math.min(range.startCol, range.endCol),
    endRow: Math.max(range.startRow, range.endRow),
    endCol: Math.max(range.startCol, range.endCol),
  });
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

/**
 * Whether the ACTIVE sheet is protected. Core's own door to the question the
 * merge gestures ask before they do anything (Excel disables merging on a
 * protected sheet); the facade's `isSheetProtected` lives above Core.
 */
export async function isActiveSheetProtected(): Promise<boolean> {
  return invoke<boolean>("is_sheet_protected");
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
  /** The cell the formula is copied FROM (Rust `FormulaShiftInput.source_row`):
   *  only an unqualified structured reference (`[@Qty]`) needs it. */
  sourceRow?: number;
  sourceCol?: number;
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
/**
 * The merged areas of an OBJECT's cells (a floating grid, P3) that meet the
 * rectangle -- the `merges` of `get_cell_target_cells`, for a fill that widens
 * its source band to the merges it holds as the sheet's fill does (BUG-0768).
 */
export async function getCellTargetMergedRegions(
  target: CellTargetRef,
  range: { startRow: number; startCol: number; endRow: number; endCol: number },
): Promise<MergedRegion[]> {
  const placed = cellTargetArg("get_cell_target_cells", { target });
  const answer = await invoke<{ merges?: MergedRegion[] }>("get_cell_target_cells", {
    ...placed,
    startRow: Math.max(0, Math.min(range.startRow, range.endRow)),
    startCol: Math.max(0, Math.min(range.startCol, range.endCol)),
    endRow: Math.max(range.startRow, range.endRow),
    endCol: Math.max(range.startCol, range.endCol),
  });
  return Array.isArray(answer?.merges) ? answer.merges : [];
}

export async function fillRange(
  sourceStartRow: number,
  sourceStartCol: number,
  sourceEndRow: number,
  sourceEndCol: number,
  targetStartRow: number,
  targetStartCol: number,
  targetEndRow: number,
  targetEndCol: number,
  opts?: CellTargetOptions,
): Promise<CellData[]> {
  const t0 = performance.now();
  // `target` (P3) names the OBJECT whose cells both ranges are in; the
  // `target*` coordinates are the fill's destination, as before.
  const placed = cellTargetArg("fill_range", opts);
  const result = await invoke<CellData[]>("fill_range", {
    sourceStartRow,
    sourceStartCol,
    sourceEndRow,
    sourceEndCol,
    targetStartRow,
    targetStartCol,
    targetEndRow,
    targetEndCol,
    ...placed,
  });
  const dt = performance.now() - t0;
  console.log(
    `[PERF][bridge] fillRange src=(${sourceStartRow},${sourceStartCol})-(${sourceEndRow},${sourceEndCol}) ` +
    `tgt=(${targetStartRow},${targetStartCol})-(${targetEndRow},${targetEndCol}) => ${result.length} cells | ipc=${dt.toFixed(1)}ms`
  );
  if (placed.target) return result;
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
 * Re-point every reference INTO a moved block -- on every sheet and in defined
 * names -- to where the block landed on the ACTIVE sheet, the way Excel's move
 * (drag, Cut + Paste) does; a reference to a cell the move overwrote becomes
 * `#REF!`. Called after the move's writes (the moved formulas are written
 * UNSHIFTED) and the source clear.
 *
 * `srcSheetIndex`: the sheet the block was cut FROM, when that is not the
 * active sheet (a Cut on Sheet1 pasted on Sheet2). Omitted, the block moved on
 * the active sheet itself.
 *
 * The step records the block as MOVED, so its Undo / Redo hands the cell
 * followers (a watch, a bookmark) the move back and forth
 * (`UndoResult.structuralDeltas`) -- a drag of whole rows or columns too: it
 * overwrites where it lands, and the lines it passes over stay [LIVE].
 */
export async function relocateCellReferences(
  srcStartRow: number,
  srcStartCol: number,
  srcEndRow: number,
  srcEndCol: number,
  destStartRow: number,
  destStartCol: number,
  srcSheetIndex?: number,
): Promise<CellData[]> {
  const result = await invoke<CellData[]>("relocate_cell_references", {
    srcStartRow,
    srcStartCol,
    srcEndRow,
    srcEndCol,
    destStartRow,
    destStartCol,
    ...(typeof srcSheetIndex === "number" ? { srcSheetIndex } : {}),
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
 * Delete a named range. `sheetIndex` is the SCOPE of the name to delete
 * (a workbook `Rate` and a `Sheet1!Rate` are two names, as in Excel); omitted
 * or null, the workbook's name, else (Excel's `Names(name)`) the first sheet's
 * own; a name scoped only to a later sheet is not found.
 */
export async function deleteNamedRange(name: string, sheetIndex?: number | null): Promise<NamedRangeResult> {
  return invoke<NamedRangeResult>("delete_named_range", { name, sheetIndex: sheetIndex ?? null });
}

/**
 * Get a named range by name. `fromSheetIndex` is the sheet it is asked FROM
 * (the Name Box's active sheet): that sheet's own name of the spelling shadows
 * the workbook's, as in a formula, and `Sheet2!Rate` asks Sheet2's. Omitted,
 * the workbook's name, else (Excel's `Names(name)`) the first sheet's own.
 */
export async function getNamedRange(name: string, fromSheetIndex?: number | null): Promise<NamedRange | null> {
  return invoke<NamedRange | null>("get_named_range", { name, sheetIndex: fromSheetIndex ?? null });
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
  newName: string,
  sheetIndex?: number | null
): Promise<NamedRangeResult> {
  // `sheetIndex`: the SCOPE of the name to rename, as for deleteNamedRange.
  return invoke<NamedRangeResult>("rename_named_range", { oldName, newName, sheetIndex: sheetIndex ?? null });
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
 * Announce that the data-validation rule set changed.
 *
 * Emitted HERE rather than at the call site, for the same reason
 * emitStructuralEvent is: the DataValidation extension caches the rule set and
 * builds the in-cell dropdown-chevron grid regions from that cache, so a rule
 * written by a route that forgot to announce is a rule with no chevron — and,
 * because nothing suppresses the fill handle over a chevron that was never
 * placed, a fill handle sitting exactly where the chevron belongs. The dialog
 * path announced; the script path and any direct caller did not.
 */
function emitValidationsChanged(sheetIndex?: number): void {
  emitAppEvent(AppEvents.VALIDATIONS_CHANGED, { sheetIndex: sheetIndex ?? null });
}

/**
 * Set data validation on a range.
 *
 * `sheetIndex` (Wave 3): target a NON-ACTIVE sheet's validation store; omit
 * for the active sheet.
 */
export async function setDataValidation(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  validation: DataValidation,
  sheetIndex?: number
): Promise<DataValidationResult> {
  console.log(
    `[tauri-api] setDataValidation(${startRow}, ${startCol}, ${endRow}, ${endCol})`,
    validation
  );
  const result = await invoke<DataValidationResult>("set_data_validation", {
    startRow,
    startCol,
    endRow,
    endCol,
    validation,
    sheetIndex: sheetIndex ?? null,
  });
  if (result.success) emitValidationsChanged(sheetIndex);
  return result;
}

/**
 * Clear data validation from a range.
 *
 * `sheetIndex` (Wave 3): target a NON-ACTIVE sheet; omit for the active sheet.
 */
export async function clearDataValidation(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  sheetIndex?: number
): Promise<DataValidationResult> {
  console.log(
    `[tauri-api] clearDataValidation(${startRow}, ${startCol}, ${endRow}, ${endCol})`
  );
  const result = await invoke<DataValidationResult>("clear_data_validation", {
    startRow,
    startCol,
    endRow,
    endCol,
    sheetIndex: sheetIndex ?? null,
  });
  if (result.success) emitValidationsChanged(sheetIndex);
  return result;
}

/**
 * Get data validation for a specific cell.
 *
 * `sheetIndex` (Wave 3): read a NON-ACTIVE sheet; omit for the active sheet.
 */
export async function getDataValidation(
  row: number,
  col: number,
  sheetIndex?: number
): Promise<DataValidation | null> {
  return invoke<DataValidation | null>("get_data_validation", {
    row,
    col,
    sheetIndex: sheetIndex ?? null,
  });
}

/**
 * Get all validation ranges for a sheet (the active sheet when `sheetIndex`
 * is omitted).
 */
export async function getAllDataValidations(sheetIndex?: number): Promise<ValidationRange[]> {
  return invoke<ValidationRange[]>("get_all_data_validations", {
    sheetIndex: sheetIndex ?? null,
  });
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
  PasteCommentsResult,
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
 * Announce that the annotation set (notes + threaded comments) changed.
 *
 * Emitted HERE rather than at the call site, for the same reason
 * emitStructuralEvent is. The Review extension paints its note/comment
 * triangles from a frontend cache, and the Comments sidebar re-reads on this
 * event; an annotation written by a route that forgot to announce is an
 * annotation with no indicator until an unrelated refresh happens to run. The
 * script rows used to emit this by hand — three of the five did.
 *
 * OUT-OF-BAND MUTATORS (a .calp pull, a future MCP tool, a test that invoked
 * the Rust command directly) have no wrapper to go through and must dispatch
 * AppEvents.ANNOTATIONS_CHANGED themselves.
 */
function emitAnnotationsChanged(): void {
  emitAppEvent(AppEvents.ANNOTATIONS_CHANGED, {});
}

/**
 * Add a comment to a cell.
 */
export async function addComment(params: AddCommentParams): Promise<CommentResult> {
  console.log(`[tauri-api] addComment(${params.row}, ${params.col})`);
  const result = await invoke<CommentResult>("add_comment", { params });
  if (result.success) emitAnnotationsChanged();
  return result;
}

/**
 * Paste Special > Comments in ONE call and one undo step (BUG-0725), on the
 * active sheet: each of `comments` REPLACES its destination's comment, and
 * each `cleared` destination ([row, col], its copied cell had none) loses its
 * comment -- Excel's paste [LIVE]. A destination holding a Note is skipped.
 */
export async function pasteComments(
  comments: AddCommentParams[],
  cleared: Array<[number, number]>,
): Promise<PasteCommentsResult> {
  const result = await invoke<PasteCommentsResult>("paste_comments", { comments, cleared });
  if (result.pasted > 0 || result.removed > 0) emitAnnotationsChanged();
  return result;
}

/**
 * Update an existing comment's content.
 */
export async function updateComment(params: UpdateCommentParams): Promise<CommentResult> {
  console.log(`[tauri-api] updateComment(${params.commentId})`);
  const result = await invoke<CommentResult>("update_comment", { params });
  if (result.success) emitAnnotationsChanged();
  return result;
}

/**
 * Delete a comment and all its replies.
 */
export async function deleteComment(commentId: string): Promise<CommentResult> {
  console.log(`[tauri-api] deleteComment(${commentId})`);
  const result = await invoke<CommentResult>("delete_comment", { commentId });
  if (result.success) emitAnnotationsChanged();
  return result;
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
  const result = await invoke<CommentResult>("resolve_comment", { commentId, resolved });
  if (result.success) emitAnnotationsChanged();
  return result;
}

/**
 * Add a reply to a comment.
 */
export async function addReply(params: AddReplyParams): Promise<ReplyResult> {
  console.log(`[tauri-api] addReply(${params.commentId})`);
  const result = await invoke<ReplyResult>("add_reply", { params });
  if (result.success) emitAnnotationsChanged();
  return result;
}

/**
 * Update a reply's content.
 */
export async function updateReply(params: UpdateReplyParams): Promise<ReplyResult> {
  console.log(`[tauri-api] updateReply(${params.commentId}, ${params.replyId})`);
  const result = await invoke<ReplyResult>("update_reply", { params });
  if (result.success) emitAnnotationsChanged();
  return result;
}

/**
 * Delete a reply from a comment.
 */
export async function deleteReply(
  commentId: string,
  replyId: string
): Promise<ReplyResult> {
  console.log(`[tauri-api] deleteReply(${commentId}, ${replyId})`);
  const result = await invoke<ReplyResult>("delete_reply", { commentId, replyId });
  if (result.success) emitAnnotationsChanged();
  return result;
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
  const result = await invoke<CommentResult>("move_comment", { commentId, newRow, newCol });
  if (result.success) emitAnnotationsChanged();
  return result;
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
  const changed = await invoke<number>("clear_all_comments");
  if (changed > 0) emitAnnotationsChanged();
  return changed;
}

/**
 * Clear comments in a range.
 */
export async function clearCommentsInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  moreAreas?: ClearArea[],
): Promise<number> {
  console.log(
    `[tauri-api] clearCommentsInRange(${startRow}, ${startCol}, ${endRow}, ${endCol})`
  );
  const changed = await invoke<number>("clear_comments_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
    ...moreAreasArg(moreAreas),
  });
  if (changed > 0) emitAnnotationsChanged();
  return changed;
}

// ============================================================================
// Notes (Legacy Yellow Sticky Notes)
// ============================================================================

/**
 * Add a note to a cell.
 */
export async function addNote(params: AddNoteParams): Promise<NoteResult> {
  console.log(`[tauri-api] addNote(${params.row}, ${params.col})`);
  const result = await invoke<NoteResult>("add_note", { params });
  if (result.success) emitAnnotationsChanged();
  return result;
}

/**
 * Update an existing note's content.
 */
export async function updateNote(params: UpdateNoteParams): Promise<NoteResult> {
  console.log(`[tauri-api] updateNote(${params.noteId})`);
  const result = await invoke<NoteResult>("update_note", { params });
  if (result.success) emitAnnotationsChanged();
  return result;
}

/**
 * Delete a note.
 */
export async function deleteNote(noteId: string): Promise<NoteResult> {
  console.log(`[tauri-api] deleteNote(${noteId})`);
  const result = await invoke<NoteResult>("delete_note", { noteId });
  if (result.success) emitAnnotationsChanged();
  return result;
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
  const result = await invoke<NoteResult>("resize_note", { params });
  if (result.success) emitAnnotationsChanged();
  return result;
}

/**
 * Toggle the visibility of a single note.
 */
export async function toggleNoteVisibility(
  noteId: string,
  visible: boolean
): Promise<NoteResult> {
  const result = await invoke<NoteResult>("toggle_note_visibility", { noteId, visible });
  if (result.success) emitAnnotationsChanged();
  return result;
}

/**
 * Show or hide all notes on the current sheet.
 */
export async function showAllNotes(visible: boolean): Promise<number> {
  console.log(`[tauri-api] showAllNotes(${visible})`);
  const changed = await invoke<number>("show_all_notes", { visible });
  if (changed > 0) emitAnnotationsChanged();
  return changed;
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
  const result = await invoke<NoteResult>("move_note", { noteId, newRow, newCol });
  if (result.success) emitAnnotationsChanged();
  return result;
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
  const changed = await invoke<number>("clear_all_notes");
  if (changed > 0) emitAnnotationsChanged();
  return changed;
}

/**
 * Clear notes in a range.
 */
export async function clearNotesInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  moreAreas?: ClearArea[],
): Promise<number> {
  console.log(
    `[tauri-api] clearNotesInRange(${startRow}, ${startCol}, ${endRow}, ${endCol})`
  );
  const changed = await invoke<number>("clear_notes_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
    ...moreAreasArg(moreAreas),
  });
  if (changed > 0) emitAnnotationsChanged();
  return changed;
}

/**
 * Convert a note to a threaded comment.
 */
export async function convertNoteToComment(
  noteId: string,
  authorEmail: string
): Promise<CommentResult> {
  console.log(`[tauri-api] convertNoteToComment(${noteId})`);
  const result = await invoke<CommentResult>("convert_note_to_comment", { noteId, authorEmail });
  if (result.success) emitAnnotationsChanged();
  return result;
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

/**
 * Run an outline-mutating command and announce the result.
 *
 * EVERY outline mutator goes through here, for the same reason
 * emitStructuralEvent exists. The Grouping extension is the only thing that
 * pushes group-hidden rows/cols into grid state and sizes the outline bar, so
 * an outline change it never hears about leaves the grid showing rows the
 * backend now hides, with no outline bar to expand them again. Announcing from
 * the wrapper means the Data menu, the grid context menu, the outline bar's own
 * +/- and level buttons, the keyboard shortcuts, the Group Settings dialog and
 * the script broker's api.groupRows family all announce identically, without
 * any of them remembering to.
 *
 * OUT-OF-BAND MUTATORS (a .calp pull, a future MCP tool, a test that invoked
 * the Rust command directly) have no wrapper to go through and must dispatch
 * AppEvents.OUTLINE_CHANGED themselves.
 */
async function invokeOutlineMutation(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<GroupResult> {
  const result = await invoke<GroupResult>(cmd, args);
  if (result.success) emitAppEvent(AppEvents.OUTLINE_CHANGED, { command: cmd });
  return result;
}

/** Group rows (create or increment outline level). */
export async function groupRows(startRow: number, endRow: number): Promise<GroupResult> {
  return invokeOutlineMutation("group_rows", { params: { startRow, endRow } });
}

/** Ungroup rows (remove or decrement outline level). */
export async function ungroupRows(startRow: number, endRow: number): Promise<GroupResult> {
  return invokeOutlineMutation("ungroup_rows", { startRow, endRow });
}

/** Group columns (create or increment outline level). */
export async function groupColumns(startCol: number, endCol: number): Promise<GroupResult> {
  return invokeOutlineMutation("group_columns", { params: { startCol, endCol } });
}

/** Ungroup columns (remove or decrement outline level). */
export async function ungroupColumns(startCol: number, endCol: number): Promise<GroupResult> {
  return invokeOutlineMutation("ungroup_columns", { startCol, endCol });
}

/** Collapse the group(s) containing the given row (hides detail rows). */
export async function collapseRowGroup(row: number): Promise<GroupResult> {
  return invokeOutlineMutation("collapse_row_group", { row });
}

/** Expand the group(s) containing the given row (shows detail rows). */
export async function expandRowGroup(row: number): Promise<GroupResult> {
  return invokeOutlineMutation("expand_row_group", { row });
}

/** Collapse the group(s) containing the given column. */
export async function collapseColumnGroup(col: number): Promise<GroupResult> {
  return invokeOutlineMutation("collapse_column_group", { col });
}

/** Expand the group(s) containing the given column. */
export async function expandColumnGroup(col: number): Promise<GroupResult> {
  return invokeOutlineMutation("expand_column_group", { col });
}

/**
 * Collapse/expand groups to show only rows/columns up to the given level.
 * Pass undefined for either dimension to leave it unchanged.
 */
export async function showOutlineLevel(
  rowLevel?: number,
  colLevel?: number,
): Promise<GroupResult> {
  return invokeOutlineMutation("show_outline_level", {
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
  return invokeOutlineMutation("clear_outline");
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

/** One row of Excel's Home > Number dropdown, resolved for the current locale. */
export interface RibbonNumberFormat {
  /** Preset keyword to send back through applyFormatting. */
  preset: string;
  /** What get_style reports for a cell carrying this preset. */
  displayName: string;
  /** The preset applied to the sample value. */
  sample: string;
}

/**
 * Resolve Excel's Home > Number dropdown for the CURRENT locale.
 *
 * The backend owns this mapping on purpose. Short Date / Long Date / Time /
 * Currency / Accounting are REGIONAL presets -- Excel writes them as
 * `[$-x-sysdate]`-style handles and resolves them from the OS -- and the
 * `displayName` each one reads back as is `format_number_format_name`'s
 * output. Deriving either half in TypeScript would be a second source of truth
 * for exactly the mapping BUG-0065 was filed against.
 */
export async function getRibbonNumberFormats(
  sampleValue?: number,
): Promise<RibbonNumberFormat[]> {
  return invoke<RibbonNumberFormat[]>("get_ribbon_number_formats", {
    sampleValue: sampleValue ?? null,
  });
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