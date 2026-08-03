//! FILENAME: app/src/api/scriptableObjects.ts
// PURPOSE: Scriptable Objects API — types, contexts, and registration for user-scriptable objects.
// CONTEXT: Every object in Calcula (slicers, charts, cells, sheets, etc.) can expose a "Code" tab
//          where users can write TypeScript to extend behavior. This file defines the typed contexts
//          and the runtime manager that executes object scripts.

// ============================================================================
// Access Levels
// ============================================================================

/** Script access level — controls what API surface the script can reach. */
export type ScriptAccessLevel = "restricted" | "unlocked";

/**
 * Thrown by `ObjectScriptManager.mountScript` when the global Script Security
 * setting (or a declined prompt) refused the mount.
 *
 * A distinct type because the remedy is distinct: nothing is broken, the user
 * said no — or the policy says no — and the message a caller shows should say
 * so instead of blaming the script.
 */
export class ScriptSecurityRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptSecurityRefusedError";
  }
}

// ============================================================================
// Object Script Definition (storage representation)
// ============================================================================

/** Identifies what kind of scriptable object this script belongs to. */
export type ScriptableObjectType =
  // Primitive objects (workbook-scoped, one script per type)
  | "workbook"
  | "sheet"
  | "cell"
  | "row"
  | "column"
  // Component objects (per-instance scripts)
  | "slicer"
  | "chart"
  | "pivot"
  | "button"
  | "textbox"
  | "timeline"
  | "shape"
  | "table"
  | "namedRange"
  // A cell-behavior binding target (granular bricks phase 2); the instanceId
  // is the binding id in the cell-behaviors store.
  | "range"
  // UI objects (per-instance scripts, keyed by panel ID)
  | "panel";

/** Where a script came from — local (user-created) or distributed (from a .calp package). */
export type ScriptProvenance = "local" | "distributed";

import type { CapabilityId } from "./scriptHost/allowlist";

/** Stored script definition for a scriptable object. */
export interface ObjectScriptDefinition {
  /** Unique script ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** The object type this script targets */
  objectType: ScriptableObjectType;
  /** For component objects: the instance ID. Null for primitive objects. */
  instanceId: string | null;
  /** The script source code (TypeScript/JavaScript) */
  source: string;
  /** Access level: restricted (default) or unlocked (full API) */
  accessLevel: ScriptAccessLevel;
  /** Optional description */
  description?: string;
  /** Where the script came from. Distributed scripts are read-only. */
  provenance?: ScriptProvenance;
  /** For distributed scripts: the package name it came from. */
  packageName?: string;
  /** For distributed scripts: the resolved package VERSION it was pulled from.
   *  Set by the .calp pull (server-authoritative) and persisted in the .cala;
   *  surfaced read-only to the script as `context.package.version`. */
  packageVersion?: string;
  /** Minimum required API version (semver). Checked on mount. */
  requiredApiVersion?: string;
  /**
   * The authoritative declared-capability ceiling (R19). For local scripts the
   * backend derives this from the source `// @capability` pragmas; for
   * distributed scripts it comes from the package manifest at pull time. The
   * broker rejects any capability not in this set (PermissionDenied) before the
   * grant check, so a distributed script's source can never widen its ceiling.
   */
  declaredCapabilities?: CapabilityId[];
}

// ============================================================================
// Lifecycle Events
// ============================================================================

/** Lifecycle stage for scriptable objects. */
export type ObjectLifecycleStage =
  | "create"
  | "mount"
  | "unmount"
  | "destroy";

/** Base event handler signature. */
export type EventHandler<T = void> = (detail: T) => void | Promise<void>;

/** Cleanup function returned by event subscriptions. */
export type CleanupFn = () => void;

/**
 * What a CANCELLABLE Before* handler may return to stop the operation.
 * `undefined` (the common "I only did some work" case) always allows.
 */
export type LifecycleVerdictReply =
  | void
  | undefined
  | false
  | "cancel"
  | { cancel: true; reason?: string };

/** Handler signature for the cancellable workbook Before* hooks. */
export type BeforeLifecycleHandler<T = void> = (
  detail: T,
) => LifecycleVerdictReply | Promise<LifecycleVerdictReply>;

// ============================================================================
// Base Object Context (shared by all object types)
// ============================================================================

/**
 * Where a distributed script came from, mirrored read-only into
 * `context.package`. Host-supplied at mount; scripts cannot forge it.
 */
export interface ScriptPackageInfo {
  /** The .calp package name. */
  readonly name: string;
  /** Resolved semver of the version this script was pulled from, or null when
   *  the package predates version stamping on scripts. */
  readonly version: string | null;
  readonly provenance: "distributed";
}

/** Base context available to all scriptable objects (restricted mode). */
export interface BaseObjectContext {
  /** The object type */
  readonly objectType: ScriptableObjectType;

  /** The script access level */
  readonly accessLevel: ScriptAccessLevel;

  /**
   * The .calp package this script shipped in, or `null` for a locally authored
   * script. Read-only and host-supplied — a distributed script can branch on
   * its own package/version (feature-gate against an older report, warn when
   * the host workbook is newer than the package it came from) without being
   * able to claim a provenance it does not have.
   */
  readonly package: ScriptPackageInfo | null;

  /**
   * Expose a custom method that other scripts or extensions can call.
   * @param name Method name
   * @param handler The method implementation
   * @param options Pass { public: true } to allow calls from scripts of a
   *                different tier or package (defaults to same-trust only).
   */
  expose(name: string, handler: (...args: unknown[]) => unknown, options?: { public?: boolean }): CleanupFn;

  /**
   * Log to the script console (visible in the Code tab output panel).
   */
  log(...args: unknown[]): void;

  /**
   * Show a toast notification to the user.
   */
  notify(message: string, type?: "info" | "success" | "warning" | "error"): void;

  /**
   * Call a method exposed by another object's script.
   * Cross-tier or cross-package calls require the target to have been
   * exposed with `{ public: true }`.
   * @param targetType The object type (e.g., "slicer", "workbook").
   * @param targetInstanceId The instance ID (null for primitives).
   * @param methodName The method name registered via expose().
   * @param args Arguments to pass.
   * @returns Promise of the return value, or undefined if the method is not found.
   */
  callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: unknown[]): Promise<unknown>;

  /** The current script API version. Scripts can check this for compatibility. */
  readonly apiVersion: string;

  /**
   * Full extension API access (only available in "unlocked" mode).
   * In "restricted" mode, this is null.
   */
  readonly api: UnlockedAPI | null;
}

/**
 * A cell READ WITH ITS TYPE (B1) — what `getData()` / `getCellData()` return.
 *
 * The display string alone cannot tell the number 5 from the text "5", an error
 * cell from a cell containing "#DIV/0!", or a formula from its rendered result.
 * Reading display strings and writing them back therefore REPLACES EVERY
 * FORMULA WITH ITS TEXT — use this shape (and write `formula` back) whenever a
 * script round-trips cells.
 *
 * Mirrors Rust `TypedCellData` and the worker-realm `ScriptCell`.
 */
export interface ScriptCell {
  /** number | string | boolean | null (null = an empty cell). An error cell
   *  carries its Excel literal, e.g. "#DIV/0!". */
  value: string | number | boolean | null;
  /** The formatted text the grid shows. */
  display: string;
  /** The cell's formula ("=A1+B1"); absent when it has none (or a protected
   *  sheet hides it). */
  formula?: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
}

/** One border edge of a cell format (B2). */
export interface ScriptBorderSide {
  style: "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  /** "#RRGGBB" or "#RRGGBBAA". */
  color: string;
}

/**
 * A PARTIAL cell format (B2) — what `range.format()` / `setRangeFormat()` take.
 *
 * Only the properties you SET change; everything else is left alone, so
 * `format({ bold: true })` never resets the number format or the fill. An
 * unknown property is REJECTED by the broker (with the accepted list) rather
 * than silently ignored, so a typo fails loudly.
 *
 * Protection attributes (locked / formulaHidden) and the checkbox/button cell
 * controls are deliberately NOT here: they are separate surfaces with their own
 * governance, not formatting.
 *
 * Mirrors the worker-realm `ScriptFormat` and a strict subset of the backend's
 * FormattingOptions.
 */
export interface ScriptFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: "none" | "single" | "double" | "singleAccounting" | "doubleAccounting";
  strikethrough?: boolean;
  /** Font size in POINTS (1-409). */
  fontSize?: number;
  fontFamily?: string;
  /** "#RRGGBB" or "#RRGGBBAA". */
  textColor?: string;
  backgroundColor?: string;
  textAlign?: "left" | "center" | "right" | "general";
  verticalAlign?: "top" | "middle" | "bottom";
  /** An Excel number-format code, e.g. "#,##0.00", "0.0%", "General". */
  numberFormat?: string;
  wrapText?: boolean;
  textRotation?: "none" | "rotate90" | "rotate270";
  /** Indent steps (0-250). */
  indent?: number;
  shrinkToFit?: boolean;
  borderTop?: ScriptBorderSide;
  borderRight?: ScriptBorderSide;
  borderBottom?: ScriptBorderSide;
  borderLeft?: ScriptBorderSide;
  borderDiagonalDown?: ScriptBorderSide;
  borderDiagonalUp?: ScriptBorderSide;
}

/** A sort criterion for `api.sortRange` (mirrors @api SortField). */
export interface ScriptSortField {
  /** 0-based offset of the sort column FROM THE RANGE START (not an absolute
   *  column index). */
  key: number;
  /** Default true. */
  ascending?: boolean;
  sortOn?: "value" | "cellColor" | "fontColor" | "icon";
  /** The colour to sort on when sortOn is cellColor / fontColor. */
  color?: string;
  dataOption?: "normal" | "textAsNumber";
  subField?: string;
  /** A built-in list name ("weekdays", "months", ...) or a comma-separated
   *  custom order. */
  customOrder?: string;
}

/** A cell matched by `api.findAll`. */
export interface ScriptFindMatch {
  row: number;
  col: number;
}

// ============================================================================
// Workbook objects (B3) — enumeration, creation, cross-instance handles
// ============================================================================
// Mirrors scriptHost/objectInventory.ts (the host's ScriptObjectRef) and the
// worker-realm handles in scriptHost/worker/contextShims.ts.

/**
 * One object found by `api.charts()` / `api.tables()` / `api.pivots()` /
 * `api.namedRanges()` / `api.slicers()` / `api.shapes()`.
 *
 * `id` is the handle every other object method takes. Enumeration answers
 * "what is in this workbook", never "what is inside this object".
 */
export interface ScriptObjectRef {
  kind: "chart" | "table" | "pivot" | "namedRange" | "slicer" | "shape";
  id: string;
  name: string;
  /** null for a workbook-scoped object. */
  sheetIndex: number | null;
  range?: string;
  sourceRange?: string;
  refersTo?: string;
  kindDetail?: string;
  fieldName?: string;
  rowCount?: number;
  columnCount?: number;
}

/** A pivot layout area, named as the Pivot Layout DSL names it. */
export type ScriptPivotArea = "rows" | "columns" | "values" | "filters";

/** An aggregation, in the Pivot Layout DSL's spelling (its VALUES clause). */
export type ScriptAggregation =
  | "sum" | "count" | "average" | "min" | "max"
  | "countnumbers" | "stddev" | "stddevp" | "var" | "varp" | "product";

/** A LAYOUT directive, in the Pivot Layout DSL's spelling (its LAYOUT clause). */
export type ScriptPivotLayoutDirective =
  | "compact" | "outline" | "tabular"
  | "repeat-labels" | "no-repeat-labels"
  | "grand-totals" | "no-grand-totals"
  | "row-totals" | "no-row-totals"
  | "column-totals" | "no-column-totals"
  | "show-empty-rows" | "show-empty-cols"
  | "values-on-rows" | "values-on-columns"
  | "auto-fit"
  | "subtotals-top" | "subtotals-bottom" | "subtotals-off";

/** A handle on ANOTHER chart in the workbook (`api.chart(id)`). */
export interface ScriptChartHandle {
  readonly id: string;
  /** Async: only the script's OWN object has a live worker-local mirror. */
  getSpec(): Promise<Record<string, unknown>>;
  updateSpec(patch: Record<string, unknown>): Promise<void>;
  replaceSpec(fullSpec: Record<string, unknown>): Promise<void>;
  setStyleProperty(name: string, value: string): Promise<void>;
  delete(): Promise<void>;
}

/** A handle on ANOTHER table (`api.table(id)`). Coordinates are TABLE-RELATIVE
 *  and clamped to the table body, exactly as inside that table's own script. */
export interface ScriptTableHandle {
  readonly id: string;
  getCellValue(row: number, colIndex: number): Promise<string>;
  setCellValue(row: number, colIndex: number, value: string): Promise<void>;
  addRow(): Promise<void>;
  range(address: string): ScriptRange;
  cell(row: number, colIndex: number): ScriptRange;
  delete(): Promise<void>;
}

/** A handle on ANOTHER pivot table (`api.pivot(id)`). */
export interface ScriptPivotHandle {
  readonly id: string;
  getFields(): Promise<{ rows: string[]; columns: string[]; values: string[]; filters: string[] }>;
  refresh(): Promise<void>;
  addField(
    field: string,
    area: ScriptPivotArea,
    position?: number,
    aggregation?: ScriptAggregation,
  ): Promise<void>;
  moveField(field: string, area: ScriptPivotArea, position?: number): Promise<void>;
  removeField(field: string, area?: ScriptPivotArea): Promise<void>;
  setAggregation(field: string, aggregation: ScriptAggregation): Promise<void>;
  setLayout(directives: ScriptPivotLayoutDirective[]): Promise<void>;
  delete(): Promise<void>;
}

/** A handle on ANOTHER slicer (`api.slicer(id)`). */
export interface ScriptSlicerHandle {
  readonly id: string;
  getSelectedItems(): Promise<string[]>;
  /** null selects ALL items; [] clears the selection. */
  setSelectedItems(items: string[] | null): Promise<void>;
  clearSelection(): Promise<void>;
  selectAll(): Promise<void>;
  setStyleProperty(name: string, value: string): Promise<void>;
}

/** A handle on ANOTHER form control / shape (`api.shape(id)`). */
export interface ScriptShapeHandle {
  readonly id: string;
  setProperty(key: string, value: string): Promise<void>;
  getCellValue(cellRef: string): Promise<string>;
  sendMessage(type: string, data?: unknown): Promise<void>;
}

/** A handle on ANOTHER named range (`api.namedRange(name)`). */
export interface ScriptNamedRangeHandle {
  readonly name: string;
  getValues(): Promise<string[][]>;
  setValues(values: string[][]): Promise<void>;
  delete(): Promise<void>;
}

/** The `fields` argument of `api.createPivot`, in the DSL's areas. */
export interface ScriptPivotFieldSpec {
  rows?: string[];
  columns?: string[];
  filters?: string[];
  values: Array<string | { field: string; aggregation?: ScriptAggregation }>;
}

/** A worksheet facet of the canonical model (C3) — the navigation level above a
 *  ScriptRange. Reached via the unlocked `api.workbook`. */
export interface ScriptSheet {
  readonly index: number;
  readonly name: string;
  /** A range on THIS sheet by A1 address ("A1", "A1:B5"). */
  range(address: string): ScriptRange;
  /** A single cell on this sheet (0-based), as a single-cell range. */
  cell(row: number, col: number): ScriptRange;
  /** Make this the active sheet. */
  activate(): Promise<void>;
}

/** The workbook facet of the canonical model (C3): navigate Workbook -> Sheet ->
 *  Range across sheets. Reached via the unlocked `api.workbook`. */
export interface ScriptWorkbook {
  /** All sheets, in tab order. */
  sheets(): Promise<ScriptSheet[]>;
  /** The active sheet. */
  activeSheet(): Promise<ScriptSheet>;
  /** A sheet by exact name or 0-based index; null if not found. */
  sheet(nameOrIndex: string | number): Promise<ScriptSheet | null>;
}

/** Extended API surface available only in "unlocked" access mode. */
export interface UnlockedAPI {
  /**
   * Canonical Workbook -> Sheet -> Range navigation (C3): the same model
   * extensions use, e.g. `const s = await api.workbook.sheet("Data"); await
   * s.range("A1:B5").setValues(...)`. Cross-sheet reach (unlocked tier only).
   */
  readonly workbook: ScriptWorkbook;
  /** Read a cell value by row/col (active sheet) as a DISPLAY STRING. */
  getCellValue(row: number, col: number): Promise<string>;
  /** Write a cell value by row/col (active sheet). */
  setCellValue(row: number, col: number, value: string): Promise<void>;
  /** Batch-update multiple cells (one undo step). */
  updateCellsBatch(updates: Array<{ row: number; col: number; value: string }>): Promise<void>;
  /** Read one cell WITH its type and formula (any sheet; defaults to active). */
  getCellData(row: number, col: number, sheetIndex?: number): Promise<ScriptCell>;
  /**
   * Read a whole rectangle in ONE call as typed cells (max 100 000 cells).
   * Prefer this over looping getCellValue: a 100x100 block is one round trip
   * instead of 10 000, and the cells keep their types + formulas.
   */
  getRangeValues(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    sheetIndex?: number,
  ): Promise<ScriptCell[][]>;
  /** Get all sheet names. */
  getSheetNames(): Promise<string[]>;
  /** Get the active sheet index. */
  getActiveSheet(): Promise<number>;
  /** Set the active sheet. */
  setActiveSheet(index: number): Promise<void>;
  /** Emit a custom event on the global event bus. */
  emitEvent(name: string, detail?: unknown): void;
  /** Listen for a global event. Returns unsubscribe function. */
  onEvent(name: string, handler: (detail: unknown) => void): CleanupFn;
  /** Execute a registered command by ID. Args are forwarded to the handler unchanged. */
  executeCommand(commandId: string, args?: unknown): void;

  // ---- Batch Transaction Support ----

  /**
   * Begin an undo transaction. All cell changes until commitBatch() are
   * grouped as a single undo entry.
   * @param description Human-readable description shown in the Undo menu.
   */
  beginBatch(description: string): Promise<void>;
  /** Commit the current batch, finalizing it as a single undo entry. */
  commitBatch(): Promise<void>;
  /** Cancel the current batch, discarding all changes since beginBatch(). */
  cancelBatch(): Promise<void>;

  // ---- Formatting (B2) ----

  /**
   * Apply a PARTIAL format to a rectangle (max 100 000 cells) — one call, one
   * undo step. Only the properties you set change. Works on ANY sheet.
   */
  setRangeFormat(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    format: ScriptFormat,
    sheetIndex?: number,
  ): Promise<void>;
  /** Remove ALL formatting from a rectangle, keeping the values. ACTIVE SHEET
   *  only — switch with setActiveSheet() first. */
  clearRangeFormat(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    sheetIndex?: number,
  ): Promise<void>;

  // ---- Structure (B2) ----
  // NOTE: every method in this block acts on the ACTIVE sheet. Passing a
  // `sheetIndex` that names another sheet REJECTS (it does not silently retarget)
  // — call setActiveSheet() first. Only formatting is genuinely sheet-scoped.

  /** Insert `count` rows at `startRow`, shifting everything below down. */
  insertRows(startRow: number, count: number, sheetIndex?: number): Promise<void>;
  /** Delete `count` rows from `startRow` (their contents are lost). */
  deleteRows(startRow: number, count: number, sheetIndex?: number): Promise<void>;
  /** Insert `count` columns at `startCol`, shifting everything right. */
  insertColumns(startCol: number, count: number, sheetIndex?: number): Promise<void>;
  /** Delete `count` columns from `startCol` (their contents are lost). */
  deleteColumns(startCol: number, count: number, sheetIndex?: number): Promise<void>;
  /** Merge a rectangle into one cell (only the top-left value survives). */
  mergeCells(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    sheetIndex?: number,
  ): Promise<void>;
  /** Split the merged region containing (row, col) back into single cells. */
  unmergeCells(row: number, col: number, sheetIndex?: number): Promise<void>;
  /** Set a row's height in pixels (0 restores the sheet default). */
  setRowHeight(row: number, height: number, sheetIndex?: number): Promise<void>;
  /** Set a column's width in pixels (0 restores the sheet default). */
  setColumnWidth(col: number, width: number, sheetIndex?: number): Promise<void>;
  /**
   * Freeze rows/columns so they stay on screen while scrolling. `freezeRow` is
   * the number of rows to freeze from the top; null unfreezes that axis.
   */
  freezePanes(freezeRow: number | null, freezeCol: number | null): Promise<void>;

  // ---- Sheets (B2) ----

  /** Add a sheet (and make it active). Rejects a name that already exists. */
  addSheet(name?: string): Promise<{ index: number; name: string }>;
  /** Delete a sheet and everything on it. Rejects on the last remaining sheet. */
  deleteSheet(index: number): Promise<void>;
  /** Rename a sheet. Rejects a name that already exists. */
  renameSheet(index: number, newName: string): Promise<void>;
  /** Show or hide a sheet. Rejects hiding the last visible one. */
  setSheetVisibility(index: number, visibility: "visible" | "hidden" | "veryHidden"): Promise<void>;

  // ---- Sort + find/replace (B2) ----

  /**
   * Sort a rectangle by one or more criteria (ACTIVE SHEET). Field `key` is an
   * offset FROM THE RANGE START, so sorting A1:C10 by column B uses key 1.
   * Resolves to the number of rows (or columns) moved.
   */
  sortRange(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    fields: ScriptSortField[],
    options?: { matchCase?: boolean; hasHeaders?: boolean; orientation?: "rows" | "columns" },
    sheetIndex?: number,
  ): Promise<number>;
  /** Find every matching cell on the active sheet, in reading order. */
  findAll(
    query: string,
    options?: { caseSensitive?: boolean; matchEntireCell?: boolean; searchFormulas?: boolean },
  ): Promise<{ matches: ScriptFindMatch[]; totalCount: number }>;
  /** Replace everywhere on the active sheet (one undo step). */
  replaceAll(
    search: string,
    replacement: string,
    options?: { caseSensitive?: boolean; matchEntireCell?: boolean },
  ): Promise<{ replacementCount: number }>;

  // ---- Workbook objects: enumerate (B3) ----
  // Identity and position only — never an object's contents.

  /** Every chart in the workbook. */
  charts(): Promise<ScriptObjectRef[]>;
  /** Every structured table in the workbook. */
  tables(): Promise<ScriptObjectRef[]>;
  /** Every pivot table in the workbook. */
  pivots(): Promise<ScriptObjectRef[]>;
  /** Every named range in the workbook. */
  namedRanges(): Promise<ScriptObjectRef[]>;
  /** Every slicer in the workbook. */
  slicers(): Promise<ScriptObjectRef[]>;
  /** Every cell-anchored form control / shape in the workbook. */
  shapes(): Promise<ScriptObjectRef[]>;

  // ---- Workbook objects: create / delete (B3) ----

  /** Add a chart from a full ChartSpec (schema-validated — REJECTS rather than
   *  creating a broken chart). Resolves to the new chart's id. */
  createChart(
    spec: Record<string, unknown>,
    options?: { name?: string; sheetIndex?: number; x?: number; y?: number; width?: number; height?: number },
  ): Promise<string>;
  /** Delete a chart by id. */
  deleteChart(chartId: string): Promise<void>;
  /** Turn a block of cells into a table. Always on the ACTIVE SHEET (header
   *  names are read from the live grid) — call setActiveSheet() first for
   *  another sheet. */
  createTable(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    options?: { name?: string; hasHeaders?: boolean },
  ): Promise<ScriptObjectRef>;
  /** Delete a table (its cells and values are kept). ACTIVE SHEET only. */
  deleteTable(tableId: string): Promise<void>;
  /** Create a named range. Omit `sheetIndex` (or pass null) for workbook scope. */
  createNamedRange(
    name: string,
    refersTo: string,
    options?: { sheetIndex?: number | null; comment?: string },
  ): Promise<void>;
  /** Delete a named range (formulas using the name will break). */
  deleteNamedRange(name: string): Promise<void>;
  /** Create a pivot table and lay out its fields in one call. Field names are
   *  the SOURCE COLUMN names; areas use the Pivot Layout DSL's vocabulary. */
  createPivot(
    sourceRange: string,
    destinationCell: string,
    fields: ScriptPivotFieldSpec,
    options?: { name?: string; sourceSheet?: number; destinationSheet?: number; hasHeaders?: boolean },
  ): Promise<ScriptObjectRef>;
  /** Delete a pivot table. */
  deletePivot(pivotId: string): Promise<void>;

  // ---- Workbook objects: address ANOTHER instance (B3) ----
  // A script is pinned to ONE object at mount. These handles reach any OTHER
  // object in the workbook by id, through the SAME host aspect executors that
  // object's own script uses. Unlocked tier only.

  /** A handle on any chart. */
  chart(chartId: string): ScriptChartHandle;
  /** A handle on any table (table-relative coordinates, clamped to its body). */
  table(tableId: string): ScriptTableHandle;
  /** A handle on any pivot table, including its field layout. */
  pivot(pivotId: string): ScriptPivotHandle;
  /** A handle on any slicer's selection and style. */
  slicer(slicerId: string): ScriptSlicerHandle;
  /** A handle on any form control / shape. */
  shape(shapeId: string): ScriptShapeHandle;
  /** A handle on any named range. */
  namedRange(name: string): ScriptNamedRangeHandle;
}

// ============================================================================
// Inter-Script Communication
// ============================================================================

// Exposed methods live in the broker's host registry (scriptHost/broker.ts),
// which carries owner identity and the public flag for cross-tier policy.
// The host-side helpers below remain for trusted (extension/test) callers.

import {
  clearExposed,
  hostCallExposed,
  listExposed,
} from "./scriptHost/broker";
import {
  hostMountScript,
  hostUnmountScript,
  hostResetAll,
} from "./scriptHost/host";
import { emitAppEvent } from "./events";
import { ensureScriptsAllowed } from "./scriptSecurity";
// Shared-library imports (@api/scriptLibraries). A script's `// @uses` pragmas
// are resolved HERE, by trusted host code, against the workbook lockfile —
// before the source ever reaches the worker. See docs/design/script-package-manager.md.
import { linkScript, resetScriptLibraryRealms, type LinkedImport } from "./scriptLibraries";

/**
 * Call an exposed method on another script from TRUSTED host code
 * (extensions, tests). Host callers are not subject to the cross-tier
 * public:true policy — that policy governs script-to-script calls.
 * @returns The return value of the method, or undefined if not found.
 */
export function callExposedMethod(
  targetType: string,
  targetInstanceId: string | null,
  methodName: string,
  ...args: unknown[]
): unknown {
  return hostCallExposed(targetType, targetInstanceId, methodName, args);
}

/** List all exposed methods (for debugging/inspection). */
export function listExposedMethods(): Array<{ objectType: string; instanceId: string | null; methodName: string }> {
  return listExposed().map((m) => ({
    objectType: m.objectType,
    instanceId: m.instanceId,
    methodName: m.methodName,
  }));
}

// ============================================================================
// Script API Versioning
// ============================================================================

/**
 * Current version of the object script context API.
 * Follows semantic versioning. Scripts can declare a minimum required version.
 */
export const SCRIPT_API_VERSION = "1.0.0";

/** Parse a semver string into [major, minor, patch]. */
function parseSemVer(v: string): [number, number, number] {
  const parts = v.split(".").map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** Check if an API version is compatible (same major, >= minor.patch). */
export function isApiVersionCompatible(required: string): boolean {
  const [reqMajor, reqMinor, reqPatch] = parseSemVer(required);
  const [curMajor, curMinor, curPatch] = parseSemVer(SCRIPT_API_VERSION);
  if (reqMajor !== curMajor) return false;
  if (reqMinor > curMinor) return false;
  if (reqMinor === curMinor && reqPatch > curPatch) return false;
  return true;
}

// ============================================================================
// Primitive Object Contexts (workbook-scoped)
// ============================================================================

/** Context for Workbook-level scripts. */
export interface WorkbookContext extends BaseObjectContext {
  readonly objectType: "workbook";

  /** Called when the workbook is opened. */
  onOpen(handler: EventHandler): CleanupFn;

  /**
   * Called before the workbook is saved — CANCELLABLE. Return
   * {@link LifecycleVerdictReply} (`false`, `"cancel"` or `{ cancel: true,
   * reason }`) to stop the save; anything else (including nothing) allows it.
   * The verdict must arrive inside the host's deadline; a late one is ignored
   * and the save proceeds, so a hung script can never block Ctrl+S.
   */
  onBeforeSave(handler: BeforeLifecycleHandler<{ path?: string }>): CleanupFn;

  /** Called after the workbook is saved. */
  onAfterSave(handler: EventHandler): CleanupFn;

  /** Called before the workbook is closed — CANCELLABLE, exactly like
   *  {@link WorkbookContext.onBeforeSave}. */
  onBeforeClose(handler: BeforeLifecycleHandler): CleanupFn;

  /** Called when the active sheet changes. */
  onSheetChange(handler: EventHandler<{ sheetIndex: number; sheetName: string }>): CleanupFn;

  /** Called when the theme changes. */
  onThemeChange(handler: EventHandler): CleanupFn;

  /** Access workbook properties. */
  readonly properties: {
    readonly title: string;
    readonly author: string;
    readonly sheetCount: number;
    getSheetNames(): string[];
  };
}

/**
 * The object-script Range facet of the canonical shared object model (C3) — the
 * same Workbook -> Sheet -> Range -> Cell shape extensions use (api/range.ts),
 * bound to the script's own sheet and async over the broker. Values are display
 * strings (the object-script convention). Built by Sheet.range() / Sheet.cell().
 */
export interface ScriptRange {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
  readonly rowCount: number;
  readonly colCount: number;
  readonly isSingleCell: boolean;
  /** A1 address ("A1" or "A1:B5"). */
  readonly address: string;
  /** A new range shifted by (rowOffset, colOffset), same size. */
  offset(rowOffset: number, colOffset: number): ScriptRange;
  /** A new range, same top-left, resized to rows x cols. */
  resize(rows: number, cols: number): ScriptRange;
  /** A single-cell range at the given offset within this range. */
  getCell(rowOffset: number, colOffset: number): ScriptRange;
  /** The top-left cell's display value. */
  getValue(): Promise<string>;
  /**
   * All values as a rows x cols grid of display strings — ONE round trip.
   * These are FORMATTED strings: do NOT write them back (every formula would
   * become its rendered text, and "1 234,50 kr" is not a number). Use
   * getData() when you need types or formulas.
   */
  getValues(): Promise<string[][]>;
  /** All cells with value, type and formula — ONE round trip. The safe read
   *  for a read/modify/write round-trip. */
  getData(): Promise<ScriptCell[][]>;
  /** All formulas as a rows x cols grid ("" where a cell has none). */
  getFormulas(): Promise<string[][]>;
  /** Set the top-left cell's value. */
  setValue(value: string): Promise<void>;
  /** Set values from a 2D array (clamped to the range's dimensions) — ONE call,
   *  one undo step. */
  setValues(values: string[][]): Promise<void>;
  /** Apply a PARTIAL format to every cell in the range — ONE call, one undo
   *  step. Absent properties are left alone. */
  format(format: ScriptFormat): Promise<void>;
  /** Remove ALL formatting from the range, keeping the values. */
  clearFormat(): Promise<void>;
}

/** Context for Sheet-level scripts (applies to all sheets). */
export interface SheetContext extends BaseObjectContext {
  readonly objectType: "sheet";

  /** Called when any sheet is activated (switched to). */
  onActivate(handler: EventHandler<{ sheetIndex: number; sheetName: string }>): CleanupFn;

  /** Called when any sheet is deactivated (switched away from). */
  onDeactivate(handler: EventHandler<{ sheetIndex: number; sheetName: string }>): CleanupFn;

  /** Called when the selection changes on any sheet. */
  onSelectionChange(handler: EventHandler<{
    sheetIndex: number;
    row: number;
    col: number;
    endRow: number;
    endCol: number;
  }>): CleanupFn;

  /** Called when data changes on any sheet. */
  onDataChange(handler: EventHandler<{
    sheetIndex: number;
    changes: Array<{ row: number; col: number; oldValue?: string; newValue: string }>;
  }>): CleanupFn;

  /** Read a cell's DISPLAY STRING from the specified (or active) sheet. */
  getCellValue(row: number, col: number, sheetIndex?: number): Promise<string>;

  /** Write a cell value. */
  setCellValue(row: number, col: number, value: string, sheetIndex?: number): Promise<void>;

  /**
   * Read one cell WITH its type and formula. Restricted scripts may only name
   * their own (active) sheet.
   */
  getCellData(row: number, col: number, sheetIndex?: number): Promise<ScriptCell>;

  /**
   * Apply a PARTIAL format to a rectangle on this sheet (B2) — one call, one
   * undo step. Only the properties you set change. Restricted scripts may only
   * name their own (active) sheet.
   */
  setRangeFormat(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    format: ScriptFormat,
    sheetIndex?: number,
  ): Promise<void>;

  /** Remove ALL formatting from a rectangle on this sheet, keeping the values. */
  clearRangeFormat(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    sheetIndex?: number,
  ): Promise<void>;

  /**
   * A range on THIS sheet by A1 address ("A1", "A1:B5") — the canonical model
   * facet (C3). Reads/writes are clamped to this sheet. Prefer this over the
   * flat getCellValue/setCellValue: `sheet.range("A1:B5").setValues(...)`.
   */
  range(address: string): ScriptRange;

  /** A single cell on this sheet (0-based), as a single-cell range. */
  cell(row: number, col: number): ScriptRange;
}

/** Context for Cell-level scripts (applies to all cells). */
export interface CellContext extends BaseObjectContext {
  readonly objectType: "cell";

  /** Called when any cell is edited (value committed). */
  onEdit(handler: EventHandler<{
    row: number;
    col: number;
    sheetIndex: number;
    oldValue?: string;
    newValue: string;
    formula?: string | null;
  }>): CleanupFn;

  /** Called when a cell is selected. */
  onSelect(handler: EventHandler<{
    row: number;
    col: number;
    sheetIndex: number;
  }>): CleanupFn;

  /** Called when editing starts on a cell. */
  onEditStart(handler: EventHandler<{
    row: number;
    col: number;
    sheetIndex: number;
  }>): CleanupFn;

  /** Called when editing ends (commit or cancel). */
  onEditEnd(handler: EventHandler<{
    row: number;
    col: number;
    sheetIndex: number;
    committed: boolean;
  }>): CleanupFn;

  /**
   * Register a custom cell renderer that runs for every visible cell.
   * Return a style override object to modify appearance, or null to use default.
   */
  onRender(handler: (cell: {
    row: number;
    col: number;
    sheetIndex: number;
    value: string;
    formula?: string | null;
  }) => { textColor?: string; backgroundColor?: string; bold?: boolean; italic?: boolean } | null): CleanupFn;
}

/** Context for Row-level scripts (applies to all rows). */
export interface RowContext extends BaseObjectContext {
  readonly objectType: "row";

  /** Called when rows are inserted. */
  onInsert(handler: EventHandler<{ sheetIndex: number; startRow: number; count: number }>): CleanupFn;

  /** Called when rows are deleted. */
  onDelete(handler: EventHandler<{ sheetIndex: number; startRow: number; count: number }>): CleanupFn;

  /** Called when a row height changes. */
  onResize(handler: EventHandler<{ sheetIndex: number; row: number; height: number }>): CleanupFn;
}

/** Context for Column-level scripts (applies to all columns). */
export interface ColumnContext extends BaseObjectContext {
  readonly objectType: "column";

  /** Called when columns are inserted. */
  onInsert(handler: EventHandler<{ sheetIndex: number; startCol: number; count: number }>): CleanupFn;

  /** Called when columns are deleted. */
  onDelete(handler: EventHandler<{ sheetIndex: number; startCol: number; count: number }>): CleanupFn;

  /** Called when a column width changes. */
  onResize(handler: EventHandler<{ sheetIndex: number; col: number; width: number }>): CleanupFn;
}

// ============================================================================
// Component Object Contexts (per-instance)
// ============================================================================

/** Context for Slicer instances. */
export interface SlicerContext extends BaseObjectContext {
  readonly objectType: "slicer";

  /** The slicer instance ID. */
  readonly instanceId: string;

  /** The slicer name. */
  readonly name: string;

  /** Called when slicer selection changes (items are selected/deselected). */
  onSelectionChange(handler: EventHandler<{ selectedItems: string[] }>): CleanupFn;

  /** Get the currently selected items. */
  getSelectedItems(): string[];

  /** Set the selected items programmatically. */
  setSelectedItems(items: string[]): Promise<void>;

  /** Clear all selections. */
  clearSelection(): Promise<void>;

  /** Select all items. */
  selectAll(): Promise<void>;

  /** Style customization namespace. */
  style: {
    /** Override the item renderer for custom appearance. */
    itemRenderer(renderer: (item: {
      text: string;
      selected: boolean;
      hasData: boolean;
      index: number;
    }, ctx: CanvasRenderingContext2D, bounds: { x: number; y: number; width: number; height: number }) => void): CleanupFn;

    /** Set a CSS property on the slicer container. */
    setProperty(name: string, value: string): void;
  };

  /** Slicer properties (read-only). */
  readonly properties: {
    readonly fieldName: string;
    readonly sourceType: string;
    readonly columns: number;
  };
}

/** Context for Timeline (date-range slicer) instances. */
export interface TimelineContext extends BaseObjectContext {
  readonly objectType: "timeline";

  /** The timeline instance ID. */
  readonly instanceId: string;

  /** The timeline name. */
  readonly name: string;

  /** Called when the selected date range changes. start/end are ISO "YYYY-MM-DD"
   *  strings, or null for an open bound (no lower/upper limit). */
  onChange(handler: EventHandler<{ start: string | null; end: string | null }>): CleanupFn;

  /** Get the currently selected date range. A null bound means open-ended. */
  getRange(): { start: string | null; end: string | null };

  /** Set the selected date range programmatically (ISO "YYYY-MM-DD"; pass null
   *  to leave a bound open). */
  setRange(start: string | null, end: string | null): Promise<void>;

  /** Clear the selection so every date is shown. */
  clearSelection(): Promise<void>;

  /** Timeline properties (read-only). */
  readonly properties: {
    /** The date field the timeline filters on. */
    readonly fieldName: string;
    /** Current granularity: "years" | "quarters" | "months" | "days". */
    readonly level: string;
    /** Source type (currently always "pivot"). */
    readonly sourceType: string;
  };
}

/** Context for Chart instances. */
export interface ChartContext extends BaseObjectContext {
  readonly objectType: "chart";

  /** The chart instance ID. */
  readonly instanceId: string;

  /** Called when the chart's source data changes. */
  onDataChange(handler: EventHandler): CleanupFn;

  /** Get the chart specification (opaque JSON). */
  getSpec(): Record<string, unknown>;

  /**
   * Deep-merge a partial patch into the chart spec. The merged result is
   * validated against the ChartSpec schema; the returned promise REJECTS if the
   * edit would produce an invalid spec (unknown key, wrong type, bad enum), so a
   * script can `try/await` to learn it wrote garbage instead of silently
   * corrupting the chart.
   */
  updateSpec(patch: Record<string, unknown>): Promise<void>;

  /**
   * Replace the ENTIRE chart spec (full re-author, not a merge — omitted fields
   * are dropped). The spec is schema-validated; the promise REJECTS on an invalid
   * spec. Use {@link getSpec} as the read side.
   */
  replaceSpec(fullSpec: Record<string, unknown>): Promise<void>;

  /** Style customization. */
  style: {
    setProperty(name: string, value: string): void;
  };
}

/** The drilled cell delivered to a pivot `onDrillThrough` handler. */
export interface PivotDrillContext {
  readonly pivotId: string;
  readonly cell: ReadonlyArray<{ table: string; column: string; value: string }>;
}

/** Context for Pivot Table instances. */
export interface PivotContext extends BaseObjectContext {
  readonly objectType: "pivot";

  /** The pivot instance ID. */
  readonly instanceId: string;

  /** Called when the pivot is refreshed (recalculated). */
  onRefresh(handler: EventHandler): CleanupFn;

  /**
   * Called when the user double-clicks a data/total cell and the pivot's
   * drill-through behavior is "script". Receives the drilled cell as resolved
   * (table, column, value) pairs.
   */
  onDrillThrough(handler: EventHandler<PivotDrillContext>): CleanupFn;

  /** Get current pivot field configuration (sync, seeded from the mount
   *  snapshot and refreshed after every layout change below). */
  getFields(): { rows: string[]; columns: string[]; values: string[]; filters: string[] };

  /** Refresh the pivot table data. */
  refresh(): Promise<void>;

  // ---- Layout mutation (B3) ----
  // The vocabulary is the Pivot Layout DSL's (extensions/_shared/dsl/
  // pivotLayout), so a script and the DSL editor describe the same pivot with
  // the same words. `field` is the SOURCE COLUMN name; naming a column that
  // does not exist rejects with the list of the ones that do.

  /** Place a source field in an area. `position` inserts at an index (default:
   *  append); `aggregation` applies to the "values" area (default: sum). */
  addField(
    field: string,
    area: ScriptPivotArea,
    position?: number,
    aggregation?: ScriptAggregation,
  ): Promise<void>;
  /** Move an already-placed field to another area (or another position). */
  moveField(field: string, area: ScriptPivotArea, position?: number): Promise<void>;
  /** Remove a placed field. Omit `area` to remove it from wherever it sits. */
  removeField(field: string, area?: ScriptPivotArea): Promise<void>;
  /** Change how a VALUE field is summarized. */
  setAggregation(field: string, aggregation: ScriptAggregation): Promise<void>;
  /** Apply LAYOUT directives, left to right (a later directive wins). */
  setLayout(directives: ScriptPivotLayoutDirective[]): Promise<void>;
}

// ============================================================================
// Panel Context (ribbon tabs & sidebar views)
// ============================================================================

/** Context for Panel instances (ribbon tabs and sidebar views). */
export interface PanelContext extends BaseObjectContext {
  readonly objectType: "panel";

  /** The panel ID (matches the PanelDefinition.id used during registration). */
  readonly instanceId: string;

  /** The panel title. */
  readonly title: string;

  /** Called when the panel tab/icon is clicked by the user. */
  onClick(handler: EventHandler<{ placement: string }>): CleanupFn;

  /** Called when the panel becomes the active tab or view. */
  onActivate(handler: EventHandler<{ placement: string }>): CleanupFn;

  /** Called when the panel loses active state (another tab/view selected). */
  onDeactivate(handler: EventHandler<{ placement: string }>): CleanupFn;

  /** Called when the panel is moved between ribbon and sidebar. */
  onPlacementChange(handler: EventHandler<{ oldPlacement: string; newPlacement: string }>): CleanupFn;

  /** Called when the panel becomes visible (opened/expanded). */
  onShow(handler: EventHandler): CleanupFn;

  /** Called when the panel is hidden (closed/collapsed). */
  onHide(handler: EventHandler): CleanupFn;

  // -- Actions --

  /** Open (activate) this panel programmatically. */
  open(): void;

  /** Close (hide) this panel. For sidebar panels, collapses the side panel. */
  close(): void;

  /**
   * Set a badge on the panel's tab/icon (e.g., notification count).
   * Pass null or empty string to clear the badge.
   */
  setBadge(text: string | null): void;

  /**
   * Move this panel to a different location.
   * @param placement "ribbon" or "sidebar"
   */
  moveTo(placement: "ribbon" | "sidebar"): void;

  /** Panel properties (read-only). */
  readonly properties: {
    readonly panelId: string;
    readonly title: string;
    readonly placement: string;
    readonly movable: boolean;
  };
}

// ============================================================================
// Shape Context
// ============================================================================

/** A custom property declared by a shape script via render.declareProperties(). */
export interface DeclaredProperty {
  /** Property key for storage */
  key: string;
  /** Display label in the Properties pane */
  label: string;
  /** Input type */
  type: "text" | "color" | "number" | "boolean";
  /** Default value */
  defaultValue?: string;
}

/** Rendering bounds passed to custom canvas renderers. */
export interface ShapeRenderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Context for Shape control instances. */
export interface ShapeContext extends BaseObjectContext {
  readonly objectType: "shape";
  /** Unique instance ID (e.g., "control-0-195-2") */
  readonly instanceId: string;
  /** Shape type identifier (e.g., "rectangle", "snipSingleCorner") */
  readonly shapeType: string;

  // -- Events --

  /** Called when the shape is clicked. */
  onClick(handler: EventHandler<{ x: number; y: number }>): CleanupFn;
  /** Called when the shape is resized. */
  onResize(handler: EventHandler<{ width: number; height: number }>): CleanupFn;
  /** Called when a property changes. */
  onPropertyChange(handler: EventHandler<{ key: string; oldValue: string; newValue: string }>): CleanupFn;

  // -- Property Access --

  /** Get the current resolved value of a shape property. */
  getProperty(key: string): string;
  /** Set a shape property value. */
  setProperty(key: string, value: string): Promise<void>;

  // -- Cell Data Binding --

  /** Read a cell value by reference (e.g., "A1", "B5"). Returns the display value. */
  getCellValue(cellRef: string): Promise<string>;
  /** Called when any cell value changes. Use to re-render when source data updates. */
  onCellChange(handler: EventHandler<{ changes: Array<{ row: number; col: number; newValue: string }> }>): CleanupFn;

  // -- Rendering --

  render: {
    /** Replace canvas rendering with an interactive HTML iframe overlay. */
    setHtmlContent(html: string): void;
    /** Send a message to the shape's HTML iframe. Use `window.addEventListener('shape-message', ...)` inside the iframe to receive. */
    sendMessage(type: string, data?: unknown): void;
    /** Listen for messages from the shape's HTML iframe. Inside the iframe, call `calcula.sendMessage(type, data)` to send. */
    onMessage(handler: EventHandler<{ type: string; data: unknown }>): CleanupFn;
    /** Provide a custom canvas render function (replaces default shape path rendering). */
    canvasRenderer(renderer: (ctx: CanvasRenderingContext2D, bounds: ShapeRenderBounds) => void): CleanupFn;
    /** Declare custom properties that appear in the Properties pane. */
    declareProperties(props: DeclaredProperty[]): void;
  };
}

/** Context for Button control instances — the canonical "click a button, run
 *  your code" surface (the #1 VBA entry point). The handler can read/write the
 *  grid via `api` (unlocked scripts), `notify`, call exposed methods, etc. */
export interface ButtonContext extends BaseObjectContext {
  readonly objectType: "button";
  /** Unique instance ID (e.g., "control-0-5-10"). */
  readonly instanceId: string;

  /** Called when the button is clicked (run mode). */
  onClick(handler: EventHandler<{ x: number; y: number }>): CleanupFn;
}

/** Context for Table (ListObject) instances — the most-automated VBA object.
 *  The instanceId is the table's EntityId. Cell reads/writes resolve through
 *  the table's grid coordinates (host-side) so they recalc and are undoable. */
export interface TableContext extends BaseObjectContext {
  readonly objectType: "table";
  /** The table instance ID (the table's EntityId string). */
  readonly instanceId: string;
  /** The table name. */
  readonly name: string;

  /** Called when any cell inside the table's range changes. */
  onDataChange(handler: EventHandler<{ changes: Array<{ row: number; col: number; newValue: string }> }>): CleanupFn;

  /** Get the table's column header names (sync, seeded from the mount snapshot). */
  getHeaders(): string[];
  /** Get the number of data rows in the table (sync, seeded). */
  getRowCount(): number;

  /** Read a table cell by 0-based data row + 0-based column index (async). */
  getCellValue(row: number, colIndex: number): Promise<string>;
  /** Write a table cell by 0-based data row + 0-based column index (async, undoable). */
  setCellValue(row: number, colIndex: number, value: string): Promise<void>;
  /** Append a new data row to the table (async, undoable). */
  addRow(): Promise<void>;

  /**
   * A canonical-model Range over the table's data body, in TABLE-RELATIVE
   * coordinates (row 0 = first data row, col 0 = first table column). The same
   * ScriptRange the sheet context exposes: `table.range("A1:C5").getValues()`.
   */
  range(address: string): ScriptRange;
  /** A single table cell (0-based data row + column index) as a ScriptRange. */
  cell(row: number, colIndex: number): ScriptRange;

  /** Table properties (read-only, mirror-backed). */
  readonly properties: {
    readonly name: string;
    readonly sheetIndex: number;
    readonly rowCount: number;
  };
}

/** Context for Named Range instances — the Excel `Name` object. The instanceId
 *  is the name string. Reads are seeded/refreshed from the resolved range;
 *  writes resolve to grid coordinates host-side (recalc + undoable). */
export interface NamedRangeContext extends BaseObjectContext {
  readonly objectType: "namedRange";
  /** The named range instance ID (the name string). */
  readonly instanceId: string;
  /** The name. */
  readonly name: string;

  /** Called when any cell inside the resolved range changes. */
  onChange(handler: EventHandler<{ changes: Array<{ row: number; col: number; newValue: string }> }>): CleanupFn;

  /** Get the resolved A1 address (e.g., "Sheet1!A1:B10"). Sync, seeded. */
  getAddress(): string;
  /** Get the range's values as a 2D array of display strings. Sync, seeded + refreshed on change. */
  getValues(): string[][];
  /** Write a 2D array of values into the range (async, undoable). */
  setValues(values: string[][]): Promise<void>;

  /** Named range properties (read-only, mirror-backed). */
  readonly properties: {
    readonly refersTo: string;
    readonly scope: string;
  };
}

/** Context for a cell-behavior binding (objectType "range") — the tinkerer's
 *  per-cell brick (granular bricks phase 2). The instanceId is the binding id;
 *  the target range lives in the cell-behaviors store and shifts with
 *  structural edits. Events arrive asynchronously from grid gestures; whether
 *  a click suppresses default selection is the binding's `claimClick`
 *  metadata, never a handler return value. */
export interface RangeContext extends BaseObjectContext {
  readonly objectType: "range";
  /** The binding id. */
  readonly instanceId: string;

  /** A cell inside the target was clicked (run mode). */
  onClick(
    handler: EventHandler<{ row: number; col: number; sheetIndex: number; ctrlKey: boolean; metaKey: boolean }>
  ): CleanupFn;
  /** A cell inside the target was double-clicked (run mode). */
  onDoubleClick(
    handler: EventHandler<{ row: number; col: number; sheetIndex: number }>
  ): CleanupFn;
  /** Cells inside the target changed. Batched per frame; `truncated` is set
   *  when more than the delivery cap changed (re-read via getValues). */
  onChange(
    handler: EventHandler<{
      changes: Array<{ row: number; col: number; newValue: string }>;
      truncated?: boolean;
    }>
  ): CleanupFn;
  /**
   * Validate/rewrite a user edit inside the target BEFORE it commits. Unlike
   * the other hooks this one REPLIES: return "block" (cancel the edit),
   * "retry" (keep the editor open for correction), { newValue } (commit a
   * rewritten value), or null/undefined to allow. The verdict is awaited
   * under a hard 1.5s deadline — timeouts and errors default to ALLOW, so a
   * slow script can never hold the user's keystroke hostage.
   */
  onBeforeCommit(
    handler: (payload: { row: number; col: number; value: string }) =>
      | "block"
      | "retry"
      | { action?: "allow" | "block" | "retry"; newValue?: string }
      | null
      | undefined
      | Promise<"block" | "retry" | { action?: "allow" | "block" | "retry"; newValue?: string } | null | undefined>
  ): CleanupFn;

  /** The target's A1 address (e.g. "Sheet1!B2:B10"). Sync, mirror-backed. */
  getAddress(): string;
  /** The target's values as a 2D array of display strings. Sync, refreshed on change. */
  getValues(): string[][];
  /** Write a 2D array of values into the target (async, undoable, clamped). */
  setValues(values: string[][]): Promise<void>;
  /** Assign a cell type to the whole target (the two-tier handshake with the
   *  extension-tier cell-type brick). Undoable. */
  setCellType(typeId: string, params?: Record<string, unknown>): Promise<void>;
  /** Clear cell-type assignments on the target. Undoable. */
  clearCellType(): Promise<void>;
}

// ============================================================================
// Context Type Map (for generic access)
// ============================================================================

/** Maps object types to their context interfaces. */
export interface ObjectContextMap {
  workbook: WorkbookContext;
  sheet: SheetContext;
  cell: CellContext;
  row: RowContext;
  column: ColumnContext;
  slicer: SlicerContext;
  chart: ChartContext;
  pivot: PivotContext;
  button: ButtonContext;
  textbox: BaseObjectContext;
  timeline: TimelineContext;
  shape: ShapeContext;
  table: TableContext;
  namedRange: NamedRangeContext;
  range: RangeContext;
  panel: PanelContext;
}

// ============================================================================
// Script Setup Function Signature
// ============================================================================

/** The function signature that all object scripts must export as default. */
export type ObjectScriptSetup<T extends ScriptableObjectType = ScriptableObjectType> =
  (context: ObjectContextMap[T]) => void | CleanupFn | Promise<void | CleanupFn>;

// ============================================================================
// Object Script Manager API (exposed to extensions)
// ============================================================================

/** API for managing object scripts — used by the ScriptableObjects extension. */
export interface IObjectScriptAPI {
  /**
   * Register a script for a scriptable object.
   * For primitives: objectType is used, instanceId is null.
   * For components: objectType + instanceId identify the specific instance.
   */
  registerScript(definition: ObjectScriptDefinition): void;

  /** Remove a script by ID. */
  removeScript(scriptId: string): void;

  /** Get the script for an object (primitive by type, component by instanceId). */
  getScript(objectType: ScriptableObjectType, instanceId?: string | null): ObjectScriptDefinition | null;

  /** Get all registered object scripts. */
  getAllScripts(): ObjectScriptDefinition[];

  /**
   * Execute a specific object script (mounts its lifecycle).
   *
   * THROWS on every failure — unknown id, a Script-Security refusal, a broken
   * library import, a `setup()` that raised. It used to `return` quietly on the
   * first two, which let callers report a phantom success ("the button will
   * work after a reload") for a script that was never going to run. A caller
   * that cannot act on the failure must still SHOW it; `console.warn` is not
   * user feedback.
   */
  mountScript(scriptId: string): Promise<void>;

  /** Unmount a running script. */
  unmountScript(scriptId: string): void;

  /** Check if a script is currently mounted (running). */
  isScriptMounted(scriptId: string): boolean;

  /** Subscribe to script changes (add/remove/update). */
  onScriptChange(callback: () => void): CleanupFn;
}

// ============================================================================
// Object Script Manager (singleton — manages all object scripts)
// ============================================================================

type ScriptChangeListener = () => void;

interface MountedScript {
  definition: ObjectScriptDefinition;
  cleanupFns: CleanupFn[];
  teardown?: CleanupFn;
}

const registeredScripts = new Map<string, ObjectScriptDefinition>();
const mountedScripts = new Map<string, MountedScript>();
const changeListeners = new Set<ScriptChangeListener>();

function notifyChange(): void {
  for (const listener of changeListeners) {
    try { listener(); } catch { /* ignore */ }
  }
}

/**
 * What each mounted script linked, keyed by scriptId. Read by the transparency
 * surfaces so "which libraries can this script call, and at what ceiling" is
 * answerable without re-deriving it from the source.
 */
const linkedImports = new Map<string, LinkedImport[]>();

/** The library imports a mounted script linked (transparency panel / tests). */
export function getLinkedImports(scriptId: string): LinkedImport[] {
  return linkedImports.get(scriptId) ?? [];
}

/** Every mounted script's linked library imports. */
export function listLinkedImports(): Array<{ scriptId: string; imports: LinkedImport[] }> {
  return [...linkedImports.entries()].map(([scriptId, imports]) => ({ scriptId, imports }));
}

/** Get the lookup key for a script — primitives use objectType, components use instanceId. */
function getLookupKey(objectType: ScriptableObjectType, instanceId?: string | null): string {
  if (instanceId) return `component:${objectType}:${instanceId}`;
  return `primitive:${objectType}`;
}

export const ObjectScriptManager: IObjectScriptAPI = {
  registerScript(definition: ObjectScriptDefinition): void {
    registeredScripts.set(definition.id, definition);
    notifyChange();
  },

  removeScript(scriptId: string): void {
    // Unmount if running
    if (mountedScripts.has(scriptId)) {
      ObjectScriptManager.unmountScript(scriptId);
    }
    registeredScripts.delete(scriptId);
    notifyChange();
  },

  getScript(objectType: ScriptableObjectType, instanceId?: string | null): ObjectScriptDefinition | null {
    const key = getLookupKey(objectType, instanceId);
    for (const script of registeredScripts.values()) {
      const scriptKey = getLookupKey(script.objectType, script.instanceId);
      if (scriptKey === key) return script;
    }
    return null;
  },

  getAllScripts(): ObjectScriptDefinition[] {
    return Array.from(registeredScripts.values());
  },

  async mountScript(scriptId: string): Promise<void> {
    const definition = registeredScripts.get(scriptId);
    if (!definition) {
      throw new Error(
        `No object script is registered under the id "${scriptId}", so there is nothing to mount.`,
      );
    }

    // SECURITY GATE (B1): honor the global "Script Security" setting on EVERY
    // object-script mount, not just workbook-load. This is the single chokepoint
    // all mount paths funnel through — workbook open, cross-window save-and-apply,
    // the manual toggle in the Object Scripts pane, code-editor remount, and
    // component/shape template stamping. Gating here guarantees "disabled" blocks
    // them all and "prompt" asks once per session before any object script runs.
    // The workbook-load path already batch-gates, so after that grant this is a
    // quiet no-op (status === "allowed"); for the other paths it is the gate.
    const allowed = await ensureScriptsAllowed(
      `Allow the object script "${definition.name}" to run? It can read and change workbook data.`,
    );
    if (!allowed) {
      // A refusal the USER made (or a policy they set) — the one failure the
      // caller most needs to repeat back, because "nothing happened" after
      // declining a prompt is indistinguishable from a broken feature.
      throw new ScriptSecurityRefusedError(
        `"${definition.name}" was not started: the Script Security setting blocked it ` +
          `(File ▸ Options ▸ Script Security, or the prompt was declined).`,
      );
    }

    // Already mounted? Unmount first.
    if (mountedScripts.has(scriptId)) {
      ObjectScriptManager.unmountScript(scriptId);
    }

    const mounted: MountedScript = {
      definition,
      cleanupFns: [],
    };

    try {
      // Check API version compatibility
      if (definition.requiredApiVersion && !isApiVersionCompatible(definition.requiredApiVersion)) {
        throw new Error(
          `Script "${definition.name}" requires API version ${definition.requiredApiVersion} ` +
          `but the current version is ${SCRIPT_API_VERSION}. ` +
          `Please update Calcula to run this script.`
        );
      }

      // LINK the script's declared library imports BEFORE mounting it.
      //
      // Ordering is a security property, not a convenience: the aliases are
      // resolved from the AUTHORITATIVE source against the workbook lockfile,
      // each library realm is mounted at `declared(library) INTERSECT
      // declared(this script)` (so a dependency can never widen this script's
      // ceiling), and an alias that is not installed / whose consent lapsed
      // throws here — the consumer never starts with a dangling import.
      //
      // The returned prelude is a SINGLE line of host-generated code (no
      // third-party bytes, just resolved addresses and host-issued call
      // tokens), prepended so the user's own line numbers are unchanged.
      const link = await linkScript({
        scriptId: definition.id,
        scriptName: definition.name,
        source: definition.source,
        declaredCapabilities: definition.declaredCapabilities ?? [],
        accessLevel: definition.accessLevel,
      });
      mounted.cleanupFns.push(link.release);
      if (link.imports.length > 0) {
        linkedImports.set(definition.id, link.imports);
        mounted.cleanupFns.push(() => linkedImports.delete(definition.id));
      }

      // Worker realm (sandbox Phase 3): the script executes in its own
      // Worker with no ambient authority; every privileged call comes
      // back as an RPC through the broker. Unmount = terminate.
      await hostMountScript({
        id: definition.id,
        name: definition.name,
        objectType: definition.objectType,
        instanceId: definition.instanceId,
        source: link.prelude + definition.source,
        accessLevel: definition.accessLevel,
        provenance: definition.provenance,
        packageName: definition.packageName,
        packageVersion: definition.packageVersion,
        declaredCapabilities: definition.declaredCapabilities,
        apiVersion: SCRIPT_API_VERSION,
      });
      mounted.cleanupFns.push(() => hostUnmountScript(definition.id));
      mountedScripts.set(scriptId, mounted);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error(`[ObjectScriptManager] Failed to mount script "${definition.name}":`, error);
      emitAppEvent("objectscript:error", {
        scriptId: definition.id,
        scriptName: definition.name,
        error: errorMsg,
        stack: errorStack,
      });
      // Clean up any handlers that were registered before the error
      for (const fn of mounted.cleanupFns) {
        try { fn(); } catch { /* ignore */ }
      }
      // Rethrow: the `objectscript:error` event only reaches whoever is
      // listening (historically just the editor window, normally closed), so it
      // cannot be the only channel. The caller decides how to say it.
      throw error instanceof Error ? error : new Error(errorMsg);
    }
  },

  unmountScript(scriptId: string): void {
    const mounted = mountedScripts.get(scriptId);
    if (!mounted) return;

    // Call the teardown function if provided
    if (mounted.teardown) {
      try { mounted.teardown(); } catch (e) {
        console.error(`[ObjectScriptManager] Teardown error for "${mounted.definition.name}":`, e);
      }
    }

    // Clean up all registered handlers (reverse order)
    for (let i = mounted.cleanupFns.length - 1; i >= 0; i--) {
      try { mounted.cleanupFns[i](); } catch { /* ignore */ }
    }

    mountedScripts.delete(scriptId);
  },

  isScriptMounted(scriptId: string): boolean {
    return mountedScripts.has(scriptId);
  },

  onScriptChange(callback: ScriptChangeListener): CleanupFn {
    changeListeners.add(callback);
    return () => changeListeners.delete(callback);
  },
};

// ============================================================================
// Reset (for testing / workbook close)
// ============================================================================

/** Unmount all scripts and clear all registrations. */
export function resetObjectScriptManager(): void {
  for (const scriptId of mountedScripts.keys()) {
    ObjectScriptManager.unmountScript(scriptId);
  }
  registeredScripts.clear();
  mountedScripts.clear();
  changeListeners.clear();
  linkedImports.clear();
  // Library realms are mounted scripts too — drop them with everything else, or
  // a closed workbook leaves a realm holding a consented capability set.
  resetScriptLibraryRealms();
  clearExposed();
  hostResetAll();
}
