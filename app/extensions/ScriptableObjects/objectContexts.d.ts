// Auto-generated type declarations for Object Script contexts.
// These types are loaded into Monaco's TypeScript language service
// for IntelliSense in the Code Editor dialog.
//
// To regenerate: keep in sync with app/src/api/scriptableObjects.ts

// ============================================================================
// Base
// ============================================================================

/**
 * A cell READ WITH ITS TYPE — what getData() / getCellData() return.
 *
 * A display string cannot tell the number 5 from the text "5", an error cell
 * from a cell containing "#DIV/0!", or a formula from its rendered result.
 * Reading display strings and writing them back REPLACES EVERY FORMULA WITH
 * ITS TEXT. When you round-trip cells, read with getData() and write back
 * `cell.formula ?? String(cell.value ?? "")`.
 */
declare interface ScriptCell {
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

// ============================================================================
// caps.dialog — ask the user something (the ui.dialog capability)
// ============================================================================

/** Presentation for `alert` and `confirm`. */
declare interface ScriptDialogTextOptions {
  /** Heading shown above the message (max 120 chars). */
  title?: string;
  /** Caption of the confirming button (max 40 chars). Default "OK". */
  okLabel?: string;
  /** Caption of the cancelling button — `confirm` only. Default "Cancel". */
  cancelLabel?: string;
  /** `confirm` only: style the confirming button as destructive. */
  danger?: boolean;
}

/** Presentation and seed value for `prompt`. */
declare interface ScriptDialogPromptOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Pre-filled text. */
  defaultValue?: string;
  placeholder?: string;
  /** Render a multi-line box (Enter inserts a newline instead of submitting). */
  multiline?: boolean;
  maxLength?: number;
}

/** One choice in a `select` field. A bare string is shorthand for both. */
declare interface ScriptDialogOption {
  value: string;
  label?: string;
}

/**
 * One field of a declarative form. `name` is the key its answer lands under in
 * the object `form()` resolves with; the answer's TYPE follows `type`
 * (number -> number, checkbox -> boolean, everything else -> string). An
 * optional field left blank comes back as `null`.
 *
 * There is no regex `pattern` member on purpose: your regular expression would
 * run in the app's own thread against the user's keystrokes. Use
 * required/min/max/maxLength, and do richer checks in your script after the
 * dialog resolves.
 */
declare interface ScriptDialogField {
  /** Identifier (letters, digits, underscore) — the result key. */
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "checkbox";
  /** Blank (or, for a checkbox, unticked) blocks the OK button. */
  required?: boolean;
  /** Initial value, matching the field's own type. */
  default?: string | number | boolean;
  placeholder?: string;
  /** Secondary line under the control. */
  help?: string;
  /** `text` only: a multi-line box. */
  multiline?: boolean;
  /** `text` only. */
  maxLength?: number;
  /** `number` only. */
  min?: number;
  /** `number` only. */
  max?: number;
  /** `number` only. */
  step?: number;
  /** `select` only, and required for it: the choices (max 200). */
  options?: Array<string | ScriptDialogOption>;
}

/** The form `caps.dialog.form(spec)` renders (max 32 fields). */
declare interface ScriptDialogFormSpec {
  /** Heading shown above the fields. */
  title?: string;
  /** Paragraph above the fields. */
  description?: string;
  /** Caption of the submit button. Default "OK". */
  submitLabel?: string;
  /** Caption of the cancel button. Default "Cancel". */
  cancelLabel?: string;
  fields: ScriptDialogField[];
}

/**
 * Modal question + answer. Every method waits for the user — there is no
 * timeout you need to handle, and dismissing is never an error.
 *
 * Only one dialog can be open at a time (yours, or any script's): a second
 * concurrent call rejects rather than stacking modals on the user, and a script
 * whose dialogs are dismissed three times in a row stops being able to ask for
 * the rest of the session.
 */
declare interface ScriptDialogApi {
  /** Show a message and wait until the user closes it. */
  alert(message: string, options?: ScriptDialogTextOptions): Promise<void>;
  /** Ask a yes/no question. Cancel, Escape and closing all resolve `false`. */
  confirm(message: string, options?: ScriptDialogTextOptions): Promise<boolean>;
  /** Ask for one value. Resolves `null` if the user cancels. */
  prompt(message: string, options?: ScriptDialogPromptOptions): Promise<string | null>;
  /**
   * Ask for several values at once. Resolves an object keyed by field name, or
   * `null` if the user cancels.
   *
   * ```js
   * const answers = await context.caps.dialog.form({
   *   title: "Monthly close",
   *   fields: [
   *     { name: "period", label: "Period", type: "date", required: true },
   *     { name: "rate", label: "FX rate", type: "number", min: 0, default: 1 },
   *     { name: "region", label: "Region", type: "select", options: ["EMEA", "APAC"] },
   *     { name: "lock", label: "Lock the sheet afterwards", type: "checkbox" },
   *   ],
   * });
   * if (!answers) return; // cancelled
   * ```
   */
  form(spec: ScriptDialogFormSpec): Promise<Record<string, unknown> | null>;
}

// ============================================================================
// caps.schedule — persistent recurring jobs (the `schedule` capability).
// Declare it with `// @capability schedule`.
// ============================================================================

/** One scheduled job, as stored in the workbook. */
declare interface ScheduledJob {
  /** Stable id — pass it to `cancel()`. */
  id: string;
  /** The script that owns the job (always your own script's id). */
  scriptId: string;
  /** The exposed method the job invokes. */
  handler: string;
  /** "every" (fixed interval) or "dailyAt" (a local wall-clock time). */
  cadence: "every" | "dailyAt";
  /** For "every": seconds between runs (never below 30). */
  intervalSecs: number;
  /** For "dailyAt": minutes since local midnight. */
  minuteOfDay: number;
  /** When the next run is due (epoch milliseconds). */
  nextRunMs: number;
  /** False while the user has paused the job from the transparency panel. */
  enabled: boolean;
  /** The label you gave it, shown to the user. */
  label: string | null;
  /** When it last ran, and how that went. */
  lastRunMs: number;
  lastOk: boolean;
  lastError: string | null;
  runCount: number;
}

/**
 * Recurring work that survives reload. See `context.caps.schedule` for the
 * limits that matter (app-open only; user-visible and user-cancellable).
 */
declare interface ScriptScheduleApi {
  /**
   * Run `handlerName` every `intervalSecs` seconds. Minimum 30 seconds — this
   * is background automation, not an animation loop (use `setInterval` inside
   * your script for anything faster and session-scoped).
   *
   * Calling this again for the same handler UPDATES the existing job rather
   * than adding a second one, so it is safe to call unconditionally on mount.
   */
  every(
    intervalSecs: number,
    handlerName: string,
    options?: { label?: string },
  ): Promise<ScheduledJob>;
  /**
   * Run `handlerName` once a day at `timeOfDay`, a 24-hour **local** "HH:MM"
   * (e.g. `"06:30"`). Local time means the user's clock, so the job follows
   * them across daylight-saving changes.
   */
  at(
    timeOfDay: string,
    handlerName: string,
    options?: { label?: string },
  ): Promise<ScheduledJob>;
  /** Your script's own scheduled jobs in this workbook. */
  list(): Promise<ScheduledJob[]>;
  /** Cancel one of your own jobs. Resolves true if a job was removed. */
  cancel(jobId: string): Promise<boolean>;
}

// ============================================================================
// caps.writeback — the .calp collection loop (the distribution.writeback
// capability). Declare it with `// @capability distribution.writeback`.
// ============================================================================

/** One value you fill into a subscribed package's input cell. Pick the member
 *  that matches the region's declared `valueType`; the backend re-checks it. */
declare type WritebackValue =
  | { type: "number"; value: number }
  | { type: "text"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "empty" };

/** One input area a subscribed package asks you to fill in. */
declare interface WritebackRegion {
  regionId: string;
  /** Stable sheet id — pass it back to `saveDraft`. */
  sheetId: string;
  /** Index of that sheet in this workbook. */
  sheetIndex: number;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
  /** What the publisher expects here. Absent = unschematized. */
  valueType?: "number" | "integer" | "text" | "date" | "boolean" | "enum";
  required?: boolean;
  /** ISO 8601 cut-off for an until-deadline region. */
  deadline?: string;
}

/** One answer of yours, and where it is in its life. */
declare interface WritebackDraft {
  id: string;
  regionId: string;
  cellRow: number;
  cellCol: number;
  value: WritebackValue;
  state: "draft" | "submitted" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  /** The publisher's reason, once they have decided. */
  reviewReason?: string | null;
}

/** Everything you have entered but not necessarily sent. */
declare interface WritebackLayerView {
  formatVersion: number;
  drafts: WritebackDraft[];
}

/** One value that WOULD leave the machine on submit. */
declare interface WritebackOutboundValue {
  cellRow: number;
  cellCol: number;
  valueDisplay: string;
  valueKind: "number" | "text" | "boolean" | "empty";
}

/** Exactly what `submitRegion` would send, and to whom. */
declare interface WritebackSubmissionPreview {
  regionId: string;
  packageName: string;
  resolvedVersion: string;
  registryPath: string;
  submitterId: string;
  submitterName: string;
  values: WritebackOutboundValue[];
}

/** One row of the publisher's "everybody's answers" view. */
declare interface WritebackSubmissionRow {
  submissionId: string;
  regionId: string;
  cellRow: number;
  cellCol: number;
  submitterId: string;
  submitterName: string;
  valueDisplay: string;
  valueKind: "number" | "text" | "boolean" | "empty";
  state: "draft" | "submitted" | "approved" | "rejected";
  submittedAt: string | null;
  updatedAt: string;
  reviewReason?: string | null;
  reviewedBy?: string | null;
}

/** Which publisher-side store an action addresses: a GRID writeback region, or
 *  a BI MODEL writeback column. Exactly one key — never both. */
declare type WritebackTarget = { regionId: string } | { writebackId: string };

/** A publisher's approve / reject / reset decision. */
declare type WritebackReview =
  | {
      regionId: string;
      submitterId: string;
      cellRow: number;
      cellCol: number;
      newState: "approved" | "rejected" | "submitted";
      reason?: string;
      /** The submissionId you were shown. Pass it: if a newer submission
       *  arrived meanwhile the backend refuses rather than deciding blind. */
      submissionId?: string;
    }
  | {
      writebackId: string;
      submissionId: string;
      newState: "approved" | "rejected" | "submitted";
      reason?: string;
    };

/**
 * Fill in and send the input cells of a subscribed .calp package.
 *
 * You do NOT need this to type into a writeback cell from a script —
 * `context.api.setCellValue` on a writeback cell is captured as a validated
 * draft automatically, exactly like a person's keystroke. Use this API when you
 * want the loop itself: enumerate the regions, review what would be sent, and
 * submit.
 *
 * The last two methods are the PUBLISHER side. They read other people's
 * submitted answers and change what everyone downstream sees, so Calcula also
 * requires that this workbook can SIGN the package — holding the capability is
 * not enough, and a subscriber's script can never approve its own submissions.
 */
declare interface ScriptWritebackApi {
  /** The input areas this workbook is asked to fill in. */
  listRegions(): Promise<WritebackRegion[]>;
  /** Your answers so far, with the state of each. */
  getLayer(): Promise<WritebackLayerView>;
  /**
   * Fill in one cell. Validated against the publisher's schema and lifecycle
   * rules; rejected values throw with the real reason. A region whose policy is
   * `immediate` sends the value as soon as it is drafted.
   */
  saveDraft(
    regionId: string,
    sheetId: string,
    row: number,
    col: number,
    value: WritebackValue,
  ): Promise<unknown>;
  /** Send every unsent answer for one area. Returns how many went. */
  submitRegion(regionId: string): Promise<number>;
  /** See exactly what `submitRegion` would send, before sending it. */
  previewSubmission(regionId: string): Promise<WritebackSubmissionPreview>;
  /** PUBLISHER ONLY: every respondent's answers for an area you publish. */
  listSubmissions(target: WritebackTarget): Promise<WritebackSubmissionRow[]>;
  /** PUBLISHER ONLY: approve, reject, or reopen somebody's answer. */
  setSubmissionState(decision: WritebackReview): Promise<void>;
}

/**
 * Read and change this workbook's BI model DEFINITIONS (the bi.model
 * capability; declare it with `// @capability bi.model`).
 *
 * Every mutation lands on the user's model undo stack and is audited. Security
 * roles, data sources, connections and credentials are NOT reachable — not as
 * an argument and not in an answer: even a mutation's return value is projected
 * down to the same whitelist `info` returns.
 */
declare interface ScriptBiModelApi {
  /** Sanitized snapshot: tables, measures, relationships, writeback columns. */
  info(connectionId: string): Promise<unknown>;
  /** Create or replace one definition. `kind` is "measure" | "calcColumn" |
   *  "relationship" | "hierarchy" | "kpi" | "calcGroup" | "perspective" |
   *  "culture" | "scriptFunction" | "calculatedTable" | "tableVariable" |
   *  "context" | "contextColumn" | "writebackColumn" | "metadata" |
   *  "dateTable" | "extensionData". */
  upsert(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Delete one definition (same `kind` vocabulary as `upsert`). */
  delete(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Check a measure formula WITHOUT saving it. */
  validateMeasure(connectionId: string, name: string, formula: string, originalName?: string): Promise<unknown>;
  /** Check a context expression WITHOUT saving it. */
  validateContext(connectionId: string, name: string, expression: string, originalName?: string): Promise<unknown>;
  /** Every outstanding issue in the whole model. */
  validateModel(connectionId: string): Promise<unknown>;
  /** The model's dependency graph (nodes + edges). */
  dependencyGraph(connectionId: string): Promise<unknown>;
  /** What one measure is built from, all the way down. */
  measureLineage(connectionId: string, name: string): Promise<unknown>;
  /**
   * What would BREAK if you deleted this object — the impact check to run
   * before a delete. `kind` is "measure" | "calcColumn" | "contextColumn" |
   * "calculatedTable" | "table"; `table` is required for the two column kinds.
   * Security roles that depend on it are reported as a COUNT
   * (`privilegedDependents`), never by name.
   */
  dependents(connectionId: string, kind: string, name: string, table?: string): Promise<unknown>;
  /**
   * Start an atomic run: every edit until `batchEnd` lands as ONE undo entry.
   * Only this script may end or cancel it, and an abandoned batch is rolled
   * back (never committed) after ~30 seconds. Batching buys atomicity, not
   * budget — each edit inside still costs a rate-limit token.
   */
  batchBegin(connectionId: string): Promise<unknown>;
  /** Commit the open batch as one undo entry. */
  batchEnd(connectionId: string): Promise<unknown>;
  /** Roll the open batch back as if none of it had happened. */
  batchCancel(connectionId: string): Promise<unknown>;
}

/** One border edge of a cell format. */
declare interface ScriptBorderSide {
  style: "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  /** "#RRGGBB" or "#RRGGBBAA". */
  color: string;
}

/**
 * A PARTIAL cell format — what range.format() / setRangeFormat() take.
 *
 * Only the properties you SET change; everything else is left alone, so
 * format({ bold: true }) never resets the number format or the fill. An unknown
 * property is REJECTED (with the accepted list) rather than silently ignored,
 * so a typo fails loudly instead of doing nothing.
 *
 * Protection attributes (locked / formulaHidden) and the checkbox/button cell
 * controls are deliberately NOT here — they are separate surfaces.
 */
declare interface ScriptFormat {
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

/** A sort criterion for api.sortRange. */
declare interface ScriptSortField {
  /** 0-based offset of the sort column FROM THE RANGE START (not an absolute
   *  column index): sorting A1:C10 by column B uses key 1. */
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

/** A cell matched by api.findAll. */
declare interface ScriptFindMatch {
  row: number;
  col: number;
}

// ============================================================================
// Workbook objects (B3)
// ============================================================================

/**
 * One object found by api.charts() / api.tables() / api.pivots() /
 * api.namedRanges() / api.slicers() / api.shapes().
 *
 * `id` is the handle every other object method takes — pass it to
 * `api.chart(id)`, `api.deleteTable(id)`, and so on. It is an EntityId for
 * charts/tables/pivots/slicers, the NAME for a named range, and the anchor-
 * derived control id ("control-0-5-10") for a form control.
 *
 * Enumeration answers "what is in this workbook", never "what is inside this
 * object": there is no spec body, no cell data and no connection detail here.
 */
declare interface ScriptObjectRef {
  kind: "chart" | "table" | "pivot" | "namedRange" | "slicer" | "shape";
  /** Stable handle. */
  id: string;
  name: string;
  /** null for a workbook-scoped object (a workbook-scoped name, a pivot). */
  sheetIndex: number | null;
  /** A1 address the object occupies / its data range. */
  range?: string;
  /** Pivot: the source data range it aggregates. */
  sourceRange?: string;
  /** Named range: the formula it refers to. */
  refersTo?: string;
  /** Chart: its mark ("bar", "line", ...). Shape: its control type. */
  kindDetail?: string;
  /** Slicer: the field it filters on. */
  fieldName?: string;
  /** Table: data-row count. */
  rowCount?: number;
  /** Table: column count. */
  columnCount?: number;
}

/** A pivot layout area, named as the Pivot Layout DSL names it. */
declare type ScriptPivotArea = "rows" | "columns" | "values" | "filters";

/**
 * An aggregation, in the Pivot Layout DSL's spelling — the same words the
 * VALUES clause accepts (`VALUES sum(Revenue)`).
 */
declare type ScriptAggregation =
  | "sum" | "count" | "average" | "min" | "max"
  | "countnumbers" | "stddev" | "stddevp" | "var" | "varp" | "product";

/**
 * A LAYOUT directive, in the Pivot Layout DSL's spelling — the same words the
 * LAYOUT clause accepts (`LAYOUT tabular, values-on-rows`).
 */
declare type ScriptPivotLayoutDirective =
  | "compact" | "outline" | "tabular"
  | "repeat-labels" | "no-repeat-labels"
  | "grand-totals" | "no-grand-totals"
  | "row-totals" | "no-row-totals"
  | "column-totals" | "no-column-totals"
  | "show-empty-rows" | "show-empty-cols"
  | "values-on-rows" | "values-on-columns"
  | "auto-fit"
  | "subtotals-top" | "subtotals-bottom" | "subtotals-off";

/** A handle on ANOTHER chart in the workbook (api.chart(id)). */
declare interface ScriptChartHandle {
  readonly id: string;
  /** The chart's ChartSpec. Async — only your OWN object has a live mirror. */
  getSpec(): Promise<Record<string, unknown>>;
  /** Merge a partial patch into the spec (schema-validated; rejects if invalid). */
  updateSpec(patch: Record<string, unknown>): Promise<void>;
  /** Replace the whole spec (schema-validated; rejects if invalid). */
  replaceSpec(fullSpec: Record<string, unknown>): Promise<void>;
  setStyleProperty(name: string, value: string): Promise<void>;
  /** Delete this chart. */
  delete(): Promise<void>;
}

/** A handle on ANOTHER table (api.table(id)). Coordinates are TABLE-RELATIVE
 *  (row 0 = first data row, col 0 = first table column) and clamped to the
 *  table body, exactly as inside that table's own script. */
declare interface ScriptTableHandle {
  readonly id: string;
  getCellValue(row: number, colIndex: number): Promise<string>;
  setCellValue(row: number, colIndex: number, value: string): Promise<void>;
  addRow(): Promise<void>;
  range(address: string): ScriptRange;
  cell(row: number, colIndex: number): ScriptRange;
  /** Delete this table (the cells and their values are kept). */
  delete(): Promise<void>;
}

/** A handle on ANOTHER pivot table (api.pivot(id)). */
declare interface ScriptPivotHandle {
  readonly id: string;
  getFields(): Promise<{ rows: string[]; columns: string[]; values: string[]; filters: string[] }>;
  refresh(): Promise<void>;
  /** Place a source field in an area. `position` inserts at an index (default:
   *  append); `aggregation` applies when the area is "values". */
  addField(field: string, area: ScriptPivotArea, position?: number, aggregation?: ScriptAggregation): Promise<void>;
  /** Move an already-placed field to another area. */
  moveField(field: string, area: ScriptPivotArea, position?: number): Promise<void>;
  /** Remove a placed field. Omit `area` to remove it from wherever it sits. */
  removeField(field: string, area?: ScriptPivotArea): Promise<void>;
  /** Change how a VALUE field is summarized. */
  setAggregation(field: string, aggregation: ScriptAggregation): Promise<void>;
  /** Apply LAYOUT directives (applied left to right, later wins). */
  setLayout(directives: ScriptPivotLayoutDirective[]): Promise<void>;
  /** Delete this pivot table. */
  delete(): Promise<void>;
}

/** A handle on ANOTHER slicer (api.slicer(id)). */
declare interface ScriptSlicerHandle {
  readonly id: string;
  getSelectedItems(): Promise<string[]>;
  /** null selects ALL items; [] clears the selection. */
  setSelectedItems(items: string[] | null): Promise<void>;
  clearSelection(): Promise<void>;
  selectAll(): Promise<void>;
  setStyleProperty(name: string, value: string): Promise<void>;
}

/** A handle on ANOTHER form control / shape (api.shape(id)). */
declare interface ScriptShapeHandle {
  readonly id: string;
  setProperty(key: string, value: string): Promise<void>;
  getCellValue(cellRef: string): Promise<string>;
  sendMessage(type: string, data?: unknown): Promise<void>;
}

/** A handle on ANOTHER named range (api.namedRange(name)). */
declare interface ScriptNamedRangeHandle {
  readonly name: string;
  getValues(): Promise<string[][]>;
  setValues(values: string[][]): Promise<void>;
  /** Delete this name (formulas using it will break). */
  delete(): Promise<void>;
}

/** A worksheet facet of the canonical model (C3). Reached via api.workbook. */
declare interface ScriptSheet {
  readonly index: number;
  readonly name: string;
  /** A range on THIS sheet by A1 address ("A1", "A1:B5"). */
  range(address: string): ScriptRange;
  /** A single cell on this sheet (0-based), as a single-cell range. */
  cell(row: number, col: number): ScriptRange;
  /** Make this the active sheet. */
  activate(): Promise<void>;
}

/** The workbook facet of the canonical model (C3): Workbook -> Sheet -> Range. */
declare interface ScriptWorkbook {
  /** All sheets, in tab order. */
  sheets(): Promise<ScriptSheet[]>;
  /** The active sheet. */
  activeSheet(): Promise<ScriptSheet>;
  /** A sheet by exact name or 0-based index; null if not found. */
  sheet(nameOrIndex: string | number): Promise<ScriptSheet | null>;
}

/** Extended API surface available only in "unlocked" access mode. */
declare interface UnlockedAPI {
  /**
   * Canonical Workbook -> Sheet -> Range navigation (C3): the same model
   * extensions use. e.g. `const s = await api.workbook.sheet("Data"); await
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
  getRangeValues(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<ScriptCell[][]>;
  /** Get all sheet names. */
  getSheetNames(): Promise<string[]>;
  /** Get the active sheet index. */
  getActiveSheet(): Promise<number>;
  /** Set the active sheet. */
  setActiveSheet(index: number): Promise<void>;
  /** Emit a custom event on the global event bus. Any name you invent is
   *  namespaced to `userscript:*`, so it can never collide with an app event. */
  emitEvent(name: string, detail?: unknown): void;
  /**
   * Listen for an event. Returns an unsubscribe function.
   *
   * Your own custom names work (they are namespaced to `userscript:*` on both
   * sides). In addition, this read-only set of APP events can be named directly:
   *
   * | Event | Payload |
   * |---|---|
   * | `app:sheet-changed` | `{ sheetIndex, sheetName }` — the ACTIVE sheet changed |
   * | `app:sheet-added` | `{ sheetIndex, sheetName, source }` — `source` is `"new"` or `"copy"` |
   * | `app:sheet-deleted` | `{ sheetIndex, sheetName }` — the index it HAD |
   * | `app:sheet-renamed` | `{ sheetIndex, oldName, newName }` |
   * | `app:recalculation-completed` | `{ scope, cellsUpdated, durationMs }` — an explicit recalc pass (F9) finished |
   * | `app:cell-values-changed` | `{ changes, source }` |
   * | `app:selection-changed` | the current selection |
   * | `app:after-open` / `app:after-save` / `app:after-new` | workbook lifecycle |
   * | `app:edit-started` / `app:edit-ended` | cell editing |
   * | `app:rows-inserted` / `app:rows-deleted` / `app:columns-inserted` / `app:columns-deleted` | `{ startRow \| startCol, count }` |
   * | `app:row-resized` / `app:column-resized` | dimension changes |
   * | `app:theme-changed` | document theme |
   * | `app:bi-model-changed` / `app:bi-refresh-completed` | BI model lifecycle |
   * | `app:package-updated` | `{ packageName, version }` — a .calp subscribe or refresh landed |
   *
   * Anything else is treated as one of your own custom names.
   *
   * ```js
   * context.api.onEvent("app:sheet-renamed", ({ oldName, newName }) => {
   *   context.log(`${oldName} is now ${newName}`);
   * });
   * ```
   */
  onEvent(name: string, handler: (detail: any) => void): () => void;
  /** Execute a registered command by ID. Args are forwarded to the handler unchanged. */
  executeCommand(commandId: string, args?: unknown): void;
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

  // -- Formatting --

  /**
   * Apply a PARTIAL format to a rectangle (max 100 000 cells) — one call, one
   * undo step. Only the properties you set change. Works on ANY sheet.
   * e.g. `await api.setRangeFormat(0, 0, 0, 4, { bold: true, backgroundColor: "#EEEEEE" })`
   */
  setRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, format: ScriptFormat, sheetIndex?: number): Promise<void>;
  /** Remove ALL formatting from a rectangle, keeping the values. ACTIVE SHEET
   *  only — call setActiveSheet() first for another sheet. */
  clearRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<void>;

  // -- Structure --
  // Every method in this block acts on the ACTIVE sheet. Passing a sheetIndex
  // that names another sheet REJECTS (it never silently retargets) — call
  // setActiveSheet() first. Only formatting is genuinely sheet-scoped.

  /** Insert `count` rows at `startRow`, shifting everything below down. */
  insertRows(startRow: number, count: number, sheetIndex?: number): Promise<void>;
  /** Delete `count` rows from `startRow` (their contents are lost). */
  deleteRows(startRow: number, count: number, sheetIndex?: number): Promise<void>;
  /** Insert `count` columns at `startCol`, shifting everything right. */
  insertColumns(startCol: number, count: number, sheetIndex?: number): Promise<void>;
  /** Delete `count` columns from `startCol` (their contents are lost). */
  deleteColumns(startCol: number, count: number, sheetIndex?: number): Promise<void>;
  /** Merge a rectangle into one cell (only the top-left value survives). */
  mergeCells(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<void>;
  /** Split the merged region containing (row, col) back into single cells. */
  unmergeCells(row: number, col: number, sheetIndex?: number): Promise<void>;
  /** Set a row's height in pixels (0 restores the sheet default). */
  setRowHeight(row: number, height: number, sheetIndex?: number): Promise<void>;
  /** Set a column's width in pixels (0 restores the sheet default). */
  setColumnWidth(col: number, width: number, sheetIndex?: number): Promise<void>;
  /** Freeze rows/columns so they stay on screen while scrolling. `freezeRow` is
   *  how many rows to freeze from the top; null unfreezes that axis. */
  freezePanes(freezeRow: number | null, freezeCol: number | null): Promise<void>;

  // -- Sheets --

  /** Add a sheet (and make it active). Rejects a name that already exists. */
  addSheet(name?: string): Promise<{ index: number; name: string }>;
  /** Delete a sheet and everything on it. Rejects on the last remaining sheet. */
  deleteSheet(index: number): Promise<void>;
  /** Rename a sheet. Rejects a name that already exists. */
  renameSheet(index: number, newName: string): Promise<void>;
  /** Show or hide a sheet. Rejects hiding the last visible one. */
  setSheetVisibility(index: number, visibility: "visible" | "hidden" | "veryHidden"): Promise<void>;

  // -- Sort + find/replace --

  /**
   * Sort a rectangle by one or more criteria (ACTIVE SHEET). Resolves to the
   * number of rows (or columns) moved.
   */
  sortRange(startRow: number, startCol: number, endRow: number, endCol: number, fields: ScriptSortField[], options?: { matchCase?: boolean; hasHeaders?: boolean; orientation?: "rows" | "columns" }, sheetIndex?: number): Promise<number>;
  /** Find every matching cell on the active sheet, in reading order. */
  findAll(query: string, options?: { caseSensitive?: boolean; matchEntireCell?: boolean; searchFormulas?: boolean }): Promise<{ matches: ScriptFindMatch[]; totalCount: number }>;
  /** Replace everywhere on the active sheet (one undo step). */
  replaceAll(search: string, replacement: string, options?: { caseSensitive?: boolean; matchEntireCell?: boolean }): Promise<{ replacementCount: number; skippedWriteback: number }>;

  // -- Workbook objects: enumerate --
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

  // -- Workbook objects: create / delete --

  /**
   * Add a chart from a full ChartSpec. The spec is schema-validated — the
   * promise REJECTS (with the violations) rather than creating a broken chart.
   * Resolves to the new chart's id.
   * e.g. `const id = await api.createChart({ mark: "bar", data: "Sheet1!A1:B10", series: [...] })`
   */
  createChart(spec: Record<string, unknown>, options?: { name?: string; sheetIndex?: number; x?: number; y?: number; width?: number; height?: number }): Promise<string>;
  /** Delete a chart by id. */
  deleteChart(chartId: string): Promise<void>;
  /**
   * Turn a block of cells into a table. Always on the ACTIVE SHEET (the header
   * names are read from the live grid) — call setActiveSheet() first for
   * another sheet. Resolves to the new table's descriptor.
   */
  createTable(startRow: number, startCol: number, endRow: number, endCol: number, options?: { name?: string; hasHeaders?: boolean }): Promise<ScriptObjectRef>;
  /** Delete a table (its cells and values are kept). ACTIVE SHEET only. */
  deleteTable(tableId: string): Promise<void>;
  /**
   * Create a named range. Omit `sheetIndex` (or pass null) for a
   * workbook-scoped name. `refersTo` is a formula: "=Sheet1!$A$1:$B$10".
   */
  createNamedRange(name: string, refersTo: string, options?: { sheetIndex?: number | null; comment?: string }): Promise<void>;
  /** Delete a named range (formulas using the name will break). */
  deleteNamedRange(name: string): Promise<void>;
  /**
   * Create a pivot table and lay out its fields in one call. Field names are
   * the SOURCE COLUMN names; areas use the Pivot Layout DSL's vocabulary.
   * e.g. `await api.createPivot("A1:D100", "F1", { rows: ["Region"], values: [{ field: "Sales", aggregation: "sum" }] })`
   */
  createPivot(
    sourceRange: string,
    destinationCell: string,
    fields: {
      rows?: string[];
      columns?: string[];
      filters?: string[];
      values: Array<string | { field: string; aggregation?: ScriptAggregation }>;
    },
    options?: { name?: string; sourceSheet?: number; destinationSheet?: number; hasHeaders?: boolean },
  ): Promise<ScriptObjectRef>;
  /** Delete a pivot table. */
  deletePivot(pivotId: string): Promise<void>;

  // -- Workbook objects: address ANOTHER instance --
  // A script is pinned to ONE object at mount. These handles reach any OTHER
  // object in the workbook by id, using the same operations that object's own
  // script has. Unlocked scripts only.

  /** A handle on any chart: `await api.chart(id).updateSpec({ title: "Q4" })`. */
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

/**
 * Which .calp package a DISTRIBUTED script shipped in. Supplied by Calcula at
 * mount time from the package it actually came from — a script cannot set or
 * change it, so a value you read here (or receive from another script) is true.
 */
declare interface ScriptPackageInfo {
  /** The package name, as published. */
  readonly name: string;
  /** The exact version this script's source came from ("2.4.1"), or `null` for
   *  a package pulled before versions were stamped onto scripts. */
  readonly version: string | null;
  readonly provenance: "distributed";
}

/** Base context available to all scriptable objects. */
declare interface BaseObjectContext {
  /** The object type. */
  readonly objectType: string;
  /** The script access level: "restricted" or "unlocked". */
  readonly accessLevel: string;
  /** The current script API version (semver). */
  readonly apiVersion: string;
  /**
   * The package this script was distributed in, or `null` when it was written
   * locally in this workbook.
   *
   * ```js
   * if (context.package) {
   *   context.log(`shipped in ${context.package.name} v${context.package.version}`);
   * }
   * ```
   */
  readonly package: ScriptPackageInfo | null;
  /**
   * Expose a custom method that other scripts or extensions can call.
   * The method becomes callable from other scripts via callMethod().
   * Pass { public: true } to allow calls from scripts of a different
   * tier or package; otherwise only same-trust scripts can call it.
   * @returns Cleanup function that withdraws the method immediately. Calling it
   *          is optional — every exposed method is withdrawn automatically when
   *          the script is unmounted or the workbook closes.
   */
  expose(name: string, handler: (...args: any[]) => any, options?: { public?: boolean }): () => void;
  /**
   * Call a method exposed by another object's script. Asynchronous: await
   * the result. Cross-tier or cross-package calls require the target to
   * have been exposed with { public: true }.
   * @param targetType The object type (e.g., "slicer", "workbook").
   * @param targetInstanceId The instance ID (null for primitives).
   * @param methodName The method name registered via expose().
   * @param args Arguments to pass.
   * @returns Promise of the return value, or undefined if the method is not found.
   */
  callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: any[]): Promise<any>;
  /** Log to the script console (visible in the Code tab output panel). */
  log(...args: any[]): void;
  /** Show a toast notification to the user. */
  notify(message: string, type?: "info" | "success" | "warning" | "error"): void;
  /**
   * Sandboxed capability surface. Requires the net.fetch capability, granted
   * just-in-time (Allow once / always / Deny) on first use, or via package consent.
   */
  caps: {
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; text(): string; json(): unknown }>;
    /** Per-script key/value store, workbook-local and private to this script. Requires the `storage` capability (declared via `// @capability storage`, granted via JIT/consent). */
    storage: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
    /**
     * Ask the user something and branch on the answer — the MsgBox / InputBox /
     * UserForm shape, awaitable. Requires the `ui.dialog` capability (declare it
     * with `// @capability ui.dialog`; the user grants it on first use, or via
     * package consent for a distributed script).
     *
     * The dialog is drawn by Calcula itself from what you pass — you supply data,
     * never markup — and its title bar always names your script, so a dialog can
     * never be mistaken for the app. A dismissal is never an error: confirm
     * resolves `false`, prompt and form resolve `null`.
     *
     * ```js
     * const ok = await context.caps.dialog.confirm(
     *   `Delete ${rows} rows? This cannot be undone.`,
     *   { title: "Delete rows", okLabel: "Delete", danger: true },
     * );
     * if (!ok) return;
     * ```
     */
    dialog: ScriptDialogApi;
    /**
     * Fill in and send the input cells of a subscribed .calp package — the
     * data-collection loop, automated. Requires the `distribution.writeback`
     * capability (`// @capability distribution.writeback`).
     *
     * Typing into a writeback cell with `context.api.setCellValue` already
     * routes through the same validated draft path a person's keystroke takes,
     * so you only need this API for the loop itself:
     *
     * ```js
     * const [region] = await context.caps.writeback.listRegions();
     * await context.caps.writeback.saveDraft(
     *   region.regionId, region.sheetId, region.rowStart, region.colStart,
     *   { type: "number", value: 42 },
     * );
     * const preview = await context.caps.writeback.previewSubmission(region.regionId);
     * context.log(`sending ${preview.values.length} values to ${preview.packageName}`);
     * await context.caps.writeback.submitRegion(region.regionId);
     * ```
     */
    writeback: ScriptWritebackApi;
    /**
     * Read and change this workbook's BI model definitions. Requires the
     * `bi.model` capability (`// @capability bi.model`). Security roles, data
     * sources and credentials are unreachable — in arguments AND in answers.
     */
    biModel: ScriptBiModelApi;
    /**
     * Run one of your own methods on a recurring schedule — the replacement for
     * VBA's `Application.OnTime`. Requires the `schedule` capability
     * (`// @capability schedule`).
     *
     * Two things make this different from `setTimeout`, and both are the point:
     * the schedule is SAVED IN THE WORKBOOK, so it resumes the next time the
     * file is opened; and it starts itself, with nobody clicking anything.
     *
     * Two things bound it, and you should design around them rather than hope:
     *  - It only runs **while Calcula is open**. There is no background service
     *    and no headless runtime. A job set for 03:00 runs at 03:00 if the app
     *    is open then, and otherwise runs shortly after the workbook is next
     *    opened — once, not once per missed slot.
     *  - The user can see every job in the transparency panel and cancel it,
     *    and revoking the `schedule` capability stops jobs already saved in the
     *    file at their next tick. Treat a schedule as a standing request, not a
     *    guarantee.
     *
     * `handlerName` names a method you published with `context.expose(...)` —
     * a schedule stores the NAME, never a function, which is what lets the user
     * still see what it will run after a reload.
     *
     * ```js
     * context.expose("refreshFromApi", async () => {
     *   const res = await context.caps.fetch("https://api.example.com/daily");
     *   context.api.setCellValue(0, 0, String(res.json().total));
     * });
     *
     * // Every 15 minutes, and again after every reopen (min interval: 30s).
     * await context.caps.schedule.every(900, "refreshFromApi", { label: "Daily totals" });
     *
     * // ...or once a day at 06:30 local time.
     * await context.caps.schedule.at("06:30", "refreshFromApi");
     * ```
     */
    schedule: ScriptScheduleApi;
  };
  /**
   * Full extension API access (only available in "unlocked" mode).
   * In "restricted" mode, this is null.
   */
  readonly api: UnlockedAPI | null;
}

// ============================================================================
// Primitive Contexts (workbook-scoped)
// ============================================================================

/** Context for Workbook-level scripts. */
declare interface WorkbookContext extends BaseObjectContext {
  /** Called when the workbook is opened. */
  onOpen(handler: () => void): () => void;
  /**
   * Called before the workbook is saved — and it can STOP the save.
   *
   * Return `false`, `"cancel"`, or `{ cancel: true, reason }` to cancel;
   * returning nothing (the usual case) lets the save proceed. A cancellation is
   * shown to the user with your script's name and your `reason`, so it never
   * looks like Ctrl+S simply broke.
   *
   * You may `await` inside the handler — write a timestamp, validate a block of
   * inputs, ask the user with `caps.dialog.confirm`. But answer QUICKLY: Calcula
   * gives each script a few seconds, and a verdict that arrives after that is
   * ignored and the save goes ahead. That is deliberate — a hung script must
   * never be able to make a workbook unsaveable.
   *
   * ```js
   * workbook.onBeforeSave(async ({ path }) => {
   *   const total = await context.api.getCellValue(20, 3);
   *   if (!total) return { cancel: true, reason: "Fill in the total in D21 first" };
   *   await context.api.setCellValue(0, 5, new Date().toISOString());
   * });
   * ```
   */
  onBeforeSave(
    handler: (detail: { path?: string }) =>
      | void
      | false
      | "cancel"
      | { cancel: true; reason?: string }
      | Promise<void | false | "cancel" | { cancel: true; reason?: string }>,
  ): () => void;
  /** Called after the workbook is saved. */
  onAfterSave(handler: () => void): () => void;
  /**
   * Called before the workbook is closed — and it can STOP the close, with the
   * same verdict shapes and the same deadline as
   * {@link WorkbookContext.onBeforeSave}. Use it to flush state or to warn about
   * work in progress; do NOT use it to trap the user in the app.
   */
  onBeforeClose(
    handler: () =>
      | void
      | false
      | "cancel"
      | { cancel: true; reason?: string }
      | Promise<void | false | "cancel" | { cancel: true; reason?: string }>,
  ): () => void;
  /** Called when the active sheet changes. */
  onSheetChange(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  /** Called when the theme changes. */
  onThemeChange(handler: () => void): () => void;
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
 * same Workbook -> Sheet -> Range -> Cell shape extensions use, bound to the
 * script's own sheet and async over the broker. Values are display strings.
 */
declare interface ScriptRange {
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
   * become its rendered text). Use getData() when you need types or formulas.
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
   *  step. Absent properties are left alone:
   *  `await sheet.range("A1:C1").format({ bold: true })`. */
  format(format: ScriptFormat): Promise<void>;
  /** Remove ALL formatting from the range, keeping the values. */
  clearFormat(): Promise<void>;
}

/** Context for Sheet-level scripts (applies to all sheets). */
declare interface SheetContext extends BaseObjectContext {
  /** Called when any sheet is activated (switched to). */
  onActivate(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  /** Called when any sheet is deactivated (switched away from). */
  onDeactivate(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  /** Called when the selection changes on any sheet. */
  onSelectionChange(handler: (detail: { sheetIndex: number; row: number; col: number; endRow: number; endCol: number }) => void): () => void;
  /** Called when data changes on any sheet. */
  onDataChange(handler: (detail: { sheetIndex: number; changes: Array<{ row: number; col: number; oldValue?: string; newValue: string }> }) => void): () => void;
  /** Read a cell's DISPLAY STRING from the specified (or active) sheet. */
  getCellValue(row: number, col: number, sheetIndex?: number): Promise<string>;
  /** Write a cell value. */
  setCellValue(row: number, col: number, value: string, sheetIndex?: number): Promise<void>;
  /** Read one cell WITH its type and formula. Restricted scripts may only name
   *  their own (active) sheet. */
  getCellData(row: number, col: number, sheetIndex?: number): Promise<ScriptCell>;
  /** Apply a PARTIAL format to a rectangle on this sheet — one call, one undo
   *  step. Only the properties you set change. Restricted scripts may only name
   *  their own (active) sheet. */
  setRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, format: ScriptFormat, sheetIndex?: number): Promise<void>;
  /** Remove ALL formatting from a rectangle on this sheet, keeping the values. */
  clearRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<void>;
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
declare interface CellContext extends BaseObjectContext {
  /** Called when any cell is edited (value committed). */
  onEdit(handler: (detail: { row: number; col: number; sheetIndex: number; oldValue?: string; newValue: string; formula?: string | null }) => void): () => void;
  /** Called when a cell is selected. */
  onSelect(handler: (detail: { row: number; col: number; sheetIndex: number }) => void): () => void;
  /** Called when editing starts on a cell. */
  onEditStart(handler: (detail: { row: number; col: number; sheetIndex: number }) => void): () => void;
  /** Called when editing ends (commit or cancel). */
  onEditEnd(handler: (detail: { row: number; col: number; sheetIndex: number; committed: boolean }) => void): () => void;
  /**
   * Register a custom cell renderer that runs for every visible cell.
   * Return a style override object to modify appearance, or null to use default.
   *
   * MUST be a pure function of its cell argument (value + coordinates):
   * results are cached and re-evaluated only when the cell changes. A
   * renderer reading outside state degrades to stale styling — call
   * render.invalidate() after changing such state to force re-evaluation.
   */
  onRender(handler: (cell: { row: number; col: number; sheetIndex: number; value: string; formula?: string | null }) => { textColor?: string; backgroundColor?: string; bold?: boolean; italic?: boolean } | null): () => void;
  /** Cache controls for onRender. */
  render: {
    /** Clear this script's cached render results and repaint. */
    invalidate(): void;
  };
}

/** Context for Row-level scripts (applies to all rows). */
declare interface RowContext extends BaseObjectContext {
  /** Called when rows are inserted. */
  onInsert(handler: (detail: { sheetIndex: number; startRow: number; count: number }) => void): () => void;
  /** Called when rows are deleted. */
  onDelete(handler: (detail: { sheetIndex: number; startRow: number; count: number }) => void): () => void;
  /** Called when a row height changes. */
  onResize(handler: (detail: { sheetIndex: number; row: number; height: number }) => void): () => void;
}

/** Context for Column-level scripts (applies to all columns). */
declare interface ColumnContext extends BaseObjectContext {
  /** Called when columns are inserted. */
  onInsert(handler: (detail: { sheetIndex: number; startCol: number; count: number }) => void): () => void;
  /** Called when columns are deleted. */
  onDelete(handler: (detail: { sheetIndex: number; startCol: number; count: number }) => void): () => void;
  /** Called when a column width changes. */
  onResize(handler: (detail: { sheetIndex: number; col: number; width: number }) => void): () => void;
}

// ============================================================================
// Component Contexts (per-instance)
// ============================================================================

/** Context for Slicer instances. */
declare interface SlicerContext extends BaseObjectContext {
  /** The slicer instance ID. */
  readonly instanceId: string;
  /** The slicer name. */
  readonly name: string;
  /** Called when slicer selection changes (items are selected/deselected). */
  onSelectionChange(handler: (detail: { selectedItems: string[] }) => void): () => void;
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
    itemRenderer(renderer: (
      item: { text: string; selected: boolean; hasData: boolean; index: number },
      ctx: CanvasRenderingContext2D,
      bounds: { x: number; y: number; width: number; height: number },
    ) => void): () => void;
    /**
     * Set a canvas-style property on the slicer.
     * Supported: backgroundColor, headerBackgroundColor, headerTextColor,
     *            itemBackgroundColor, itemTextColor, selectedBackgroundColor,
     *            selectedTextColor, borderColor, borderRadius, opacity.
     */
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
declare interface TimelineContext extends BaseObjectContext {
  /** The timeline instance ID. */
  readonly instanceId: string;
  /** The timeline name. */
  readonly name: string;
  /** Called when the selected date range changes. start/end are ISO
   *  "YYYY-MM-DD" strings, or null for an open bound. */
  onChange(handler: (detail: { start: string | null; end: string | null }) => void): () => void;
  /** Get the currently selected date range (null bound = open-ended). */
  getRange(): { start: string | null; end: string | null };
  /** Set the selected date range (ISO "YYYY-MM-DD"; null leaves a bound open). */
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
declare interface ChartContext extends BaseObjectContext {
  /** The chart instance ID. */
  readonly instanceId: string;
  /** Called when the chart's source data changes. */
  onDataChange(handler: () => void): () => void;
  /** Get the chart specification (JSON object). */
  getSpec(): Record<string, unknown>;
  /** Update the chart specification (merge patch). Schema-validated — the promise
   *  rejects if the merged spec would be invalid. */
  updateSpec(patch: Record<string, unknown>): Promise<void>;
  /** Replace the entire chart specification (full re-author). Schema-validated —
   *  the promise rejects on an invalid spec. */
  replaceSpec(fullSpec: Record<string, unknown>): Promise<void>;
  /** Style customization. */
  style: {
    /** Set a canvas-style property override (stored in chart spec). */
    setProperty(name: string, value: string): void;
  };
}

/** The drilled cell delivered to a pivot `onDrillThrough` handler. */
declare interface PivotDrillContext {
  /** The pivot instance ID. */
  readonly pivotId: string;
  /** The drilled cell as resolved dimension coordinates (empty for a grand total). */
  readonly cell: ReadonlyArray<{ table: string; column: string; value: string }>;
}

/** Context for Pivot Table instances. */
declare interface PivotContext extends BaseObjectContext {
  /** The pivot instance ID. */
  readonly instanceId: string;
  /** Called when the pivot is refreshed (recalculated). */
  onRefresh(handler: () => void): () => void;
  /**
   * Called when the user double-clicks a data/total cell and the pivot's
   * drill-through behavior is set to "script". The handler receives the drilled
   * cell as resolved (table, column, value) pairs; produce the drill via your
   * granted capabilities (e.g. bi.query, then write a sheet).
   */
  onDrillThrough(handler: (ctx: PivotDrillContext) => void): () => void;
  /** Get current pivot field configuration (sync, seeded from the mount
   *  snapshot and refreshed after every layout change below). */
  getFields(): { rows: string[]; columns: string[]; values: string[]; filters: string[] };
  /** Refresh the pivot table data. */
  refresh(): Promise<void>;

  // -- Layout --
  // The vocabulary is the Pivot Layout DSL's, so a script and the DSL editor
  // describe the same pivot with the same words: areas are rows/columns/values/
  // filters, aggregations are sum/count/average/..., and setLayout takes the
  // LAYOUT clause's directives. `field` is the SOURCE COLUMN name; naming a
  // column that does not exist rejects with the list of the ones that do.

  /**
   * Place a source field in an area.
   * e.g. `await pivot.addField("Revenue", "values", undefined, "average")`
   * @param position insert index within the area (default: append).
   * @param aggregation only meaningful for the "values" area (default: sum).
   */
  addField(field: string, area: ScriptPivotArea, position?: number, aggregation?: ScriptAggregation): Promise<void>;
  /** Move an already-placed field to another area (or another position). */
  moveField(field: string, area: ScriptPivotArea, position?: number): Promise<void>;
  /** Remove a placed field. Omit `area` to remove it from wherever it sits. */
  removeField(field: string, area?: ScriptPivotArea): Promise<void>;
  /** Change how a VALUE field is summarized. */
  setAggregation(field: string, aggregation: ScriptAggregation): Promise<void>;
  /** Apply LAYOUT directives, left to right (a later directive wins).
   *  e.g. `await pivot.setLayout(["tabular", "values-on-rows", "no-grand-totals"])` */
  setLayout(directives: ScriptPivotLayoutDirective[]): Promise<void>;
}

// ============================================================================
// Panel Context (ribbon tabs & sidebar views)
// ============================================================================

/** Context for Panel instances (ribbon tabs and sidebar views). */
declare interface PanelContext extends BaseObjectContext {
  /** The panel ID (matches the PanelDefinition.id used during registration). */
  readonly instanceId: string;
  /** The panel title. */
  readonly title: string;

  // -- Events --

  /** Called when the panel tab/icon is clicked by the user. */
  onClick(handler: (detail: { placement: string }) => void): () => void;
  /** Called when the panel becomes the active tab or view. */
  onActivate(handler: (detail: { placement: string }) => void): () => void;
  /** Called when the panel loses active state (another tab/view selected). */
  onDeactivate(handler: (detail: { placement: string }) => void): () => void;
  /** Called when the panel is moved between ribbon and sidebar. */
  onPlacementChange(handler: (detail: { oldPlacement: string; newPlacement: string }) => void): () => void;
  /** Called when the panel becomes visible (opened/expanded). */
  onShow(handler: () => void): () => void;
  /** Called when the panel is hidden (closed/collapsed). */
  onHide(handler: () => void): () => void;

  // -- Actions --

  /** Open (activate) this panel programmatically. */
  open(): void;
  /** Close (hide) this panel. For sidebar panels, collapses the side panel. */
  close(): void;
  /** Set a badge on the panel's tab/icon (e.g., notification count). Pass null to clear. */
  setBadge(text: string | null): void;
  /** Move this panel to a different location ("ribbon" or "sidebar"). */
  moveTo(placement: "ribbon" | "sidebar"): void;

  /** Panel properties (read-only). */
  readonly properties: {
    /** Panel ID. */
    readonly panelId: string;
    /** Panel title. */
    readonly title: string;
    /** Current placement: "ribbon" or "sidebar". */
    readonly placement: string;
    /** Whether the panel can be moved between locations. */
    readonly movable: boolean;
  };
}

// ============================================================================
// Shape Context
// ============================================================================

/** A custom property declared by a shape script. */
declare interface DeclaredProperty {
  key: string;
  label: string;
  type: "text" | "color" | "number" | "boolean";
  defaultValue?: string;
}

/** Rendering bounds passed to custom canvas renderers. */
declare interface ShapeRenderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Context for Shape control instances. */
/** Context for Button instances — the canonical "click a button, run your
 *  code" surface (the #1 VBA entry point). Unlocked scripts can touch the grid
 *  via `api`; all scripts can `notify`, `log`, and `expose` methods. */
declare interface ButtonContext extends BaseObjectContext {
  /** Unique instance ID (e.g., "control-0-5-10"). */
  readonly instanceId: string;
  /** Called when the button is clicked (run mode). */
  onClick(handler: (detail: { x: number; y: number }) => void): () => void;
}

/** Context for Table (ListObject) instances — the most-automated VBA object.
 *  The instanceId is the table's EntityId. Cell reads/writes resolve through
 *  the table's grid coordinates so they recalc and are undoable. */
declare interface TableContext extends BaseObjectContext {
  /** The table instance ID (the table's EntityId string). */
  readonly instanceId: string;
  /** The table name. */
  readonly name: string;
  /** Called when any cell inside the table's range changes. */
  onDataChange(handler: (detail: { changes: Array<{ row: number; col: number; newValue: string }> }) => void): () => void;
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
  /** Table properties (read-only). */
  readonly properties: {
    readonly name: string;
    readonly sheetIndex: number;
    readonly rowCount: number;
  };
}

/** Context for Named Range instances — the Excel `Name` object. The instanceId
 *  is the name string. Reads are seeded/refreshed from the resolved range;
 *  writes resolve to grid coordinates (recalc + undoable). */
declare interface NamedRangeContext extends BaseObjectContext {
  /** The named range instance ID (the name string). */
  readonly instanceId: string;
  /** The name. */
  readonly name: string;
  /** Called when any cell inside the resolved range changes. */
  onChange(handler: (detail: { changes: Array<{ row: number; col: number; newValue: string }> }) => void): () => void;
  /** Get the resolved A1 address (e.g., "Sheet1!A1:B10"). Sync, seeded. */
  getAddress(): string;
  /** Get the range's values as a 2D array of display strings. Sync, seeded. */
  getValues(): string[][];
  /** Write a 2D array of values into the range (async, undoable). */
  setValues(values: string[][]): Promise<void>;
  /** Named range properties (read-only). */
  readonly properties: {
    readonly refersTo: string;
    readonly scope: string;
  };
}

declare interface ShapeContext extends BaseObjectContext {
  /** Unique instance ID (e.g., "control-0-195-2"). */
  readonly instanceId: string;
  /** Shape type identifier (e.g., "rectangle", "snipSingleCorner"). */
  readonly shapeType: string;

  /** Called when the shape is clicked. */
  onClick(handler: (detail: { x: number; y: number }) => void): () => void;
  /** Called when the shape is resized. */
  onResize(handler: (detail: { width: number; height: number }) => void): () => void;
  /** Called when a property value changes. */
  onPropertyChange(handler: (detail: { key: string; oldValue: string; newValue: string }) => void): () => void;

  /** Get the current resolved value of a shape property. */
  getProperty(key: string): string;
  /** Set a shape property value. */
  setProperty(key: string, value: string): Promise<void>;

  /** Read a cell value by reference (e.g., "A1", "B5"). Returns the display value. */
  getCellValue(cellRef: string): Promise<string>;
  /** Called when any cell value changes. Use to re-render when source data updates. */
  onCellChange(handler: (detail: { changes: Array<{ row: number; col: number; newValue: string }> }) => void): () => void;

  /** Rendering methods. */
  render: {
    /** Replace canvas rendering with an interactive HTML iframe overlay. */
    setHtmlContent(html: string): void;
    /** Send a message to the shape's HTML iframe. Inside the iframe, listen via `window.addEventListener('shape-message', (e) => { e.detail.type, e.detail.data })`. */
    sendMessage(type: string, data?: unknown): void;
    /** Listen for messages sent from the shape's HTML iframe via `calcula.sendMessage(type, data)`. */
    onMessage(handler: (detail: { type: string; data: unknown }) => void): () => void;
    /** Provide a custom canvas render function (replaces default shape path rendering). */
    canvasRenderer(renderer: (ctx: CanvasRenderingContext2D, bounds: ShapeRenderBounds) => void): () => void;
    /** Declare custom properties that appear in the Properties pane. */
    declareProperties(props: DeclaredProperty[]): void;
  };
}
