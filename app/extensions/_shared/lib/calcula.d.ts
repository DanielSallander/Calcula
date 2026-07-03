/**
 * Calcula Script API Type Definitions
 *
 * These declarations describe the global `Calcula` and `console` objects
 * available inside the Calcula script engine (QuickJS runtime).
 *
 * All row/column indices are 0-based.
 * An optional `sheetIndex` parameter defaults to the active sheet when omitted.
 */

// ============================================================================
// Canonical Shared Object Model (Workbook -> Sheet -> Range -> Cell)
// ============================================================================
//
// The notebook/QuickJS runtime binds the SAME Workbook -> Sheet -> Range model
// that extensions (api/range.ts, api/objectModel.ts) and object scripts
// (scriptHost/worker/canonicalModel.ts) expose. Member set is pinned by
// api/canonicalModelSpec.ts via the canonicalModelCoverage drift guard.
//
// This runtime is SYNCHRONOUS: methods return values directly (NOT Promises).
// Reach it via `Calcula.workbook`.

/**
 * A rectangular range (a single cell is a 1x1 range) on a sheet.
 * Values are display strings. All offsets/indices are 0-based.
 */
interface NotebookRange {
  /** A1 address ("A1" or "A1:B5"). */
  readonly address: string;
  /** Number of rows in the range. */
  readonly rowCount: number;
  /** Number of columns in the range. */
  readonly colCount: number;
  /** True when the range covers exactly one cell. */
  readonly isSingleCell: boolean;
  /** A new range shifted by (rowOffset, colOffset), same size. */
  offset(rowOffset: number, colOffset: number): NotebookRange;
  /** A new range, same top-left, resized to rows x cols. */
  resize(rows: number, cols: number): NotebookRange;
  /** A single-cell range at the given offset within this range (throws if outside). */
  getCell(rowOffset: number, colOffset: number): NotebookRange;
  /** The top-left cell's display value. */
  getValue(): string;
  /** All values as a rows x cols grid of display strings. */
  getValues(): string[][];
  /** Set the top-left cell's value. */
  setValue(value: string): void;
  /** Set values from a 2D array (clamped to the range's dimensions). */
  setValues(values: string[][]): void;
}

/** A worksheet: the navigation level above a NotebookRange. */
interface NotebookSheet {
  /** 0-based sheet index. */
  readonly index: number;
  /** Sheet name (tab label). */
  readonly name: string;
  /** A range on THIS sheet by A1 address (a "Sheet!" prefix is ignored). */
  range(address: string): NotebookRange;
  /** A single cell on this sheet (0-based). */
  cell(row: number, col: number): NotebookRange;
  /** Make this the active sheet. */
  activate(): void;
}

/** The workbook: navigate Workbook -> Sheet -> Range across sheets. */
interface NotebookWorkbook {
  /** All sheets, in tab order. */
  sheets(): NotebookSheet[];
  /** The active sheet. */
  activeSheet(): NotebookSheet;
  /** A sheet by exact name or 0-based index; null if not found. */
  sheet(nameOrIndex: string | number): NotebookSheet | null;
}

// ============================================================================
// Calcula Namespace
// ============================================================================

declare namespace Calcula {
  // --------------------------------------------------------------------------
  // Canonical Object Model
  // --------------------------------------------------------------------------

  /**
   * The canonical shared object model entry point. Navigate
   * Workbook -> Sheet -> Range -> Cell. Synchronous (no Promises).
   *
   * @example
   * Calcula.workbook.sheet(0).range("A1:B2").setValues([["x","y"],["z","w"]]);
   * const v = Calcula.workbook.activeSheet().cell(0, 0).getValue();
   */
  const workbook: NotebookWorkbook;

  // --------------------------------------------------------------------------
  // Cell Operations
  // --------------------------------------------------------------------------

  /**
   * Get the display value of a cell.
   * @param row - 0-based row index
   * @param col - 0-based column index
   * @param sheetIndex - Optional sheet index (defaults to active sheet)
   * @returns The cell value as a string, or empty string if the cell is empty.
   */
  function getCellValue(row: number, col: number, sheetIndex?: number): string;

  /**
   * Set the value of a cell.
   * Numbers, booleans ("TRUE"/"FALSE"), and text are auto-detected from the string.
   * @param row - 0-based row index
   * @param col - 0-based column index
   * @param value - The value to set (as string)
   * @param sheetIndex - Optional sheet index (defaults to active sheet)
   */
  function setCellValue(
    row: number,
    col: number,
    value: string,
    sheetIndex?: number,
  ): void;

  /**
   * Get a rectangular range of cell values.
   * @param startRow - 0-based start row
   * @param startCol - 0-based start column
   * @param endRow - 0-based end row (inclusive)
   * @param endCol - 0-based end column (inclusive)
   * @param sheetIndex - Optional sheet index (defaults to active sheet)
   * @returns JSON string of a 2D array of cell values (string[][])
   */
  function getRange(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    sheetIndex?: number,
  ): string;

  /**
   * Set a rectangular range of cell values.
   * @param startRow - 0-based start row
   * @param startCol - 0-based start column
   * @param valuesJson - JSON string of a 2D array of values (string[][])
   * @param sheetIndex - Optional sheet index (defaults to active sheet)
   */
  function setRange(
    startRow: number,
    startCol: number,
    valuesJson: string,
    sheetIndex?: number,
  ): void;

  /**
   * Get the formula of a cell.
   * @param row - 0-based row index
   * @param col - 0-based column index
   * @param sheetIndex - Optional sheet index (defaults to active sheet)
   * @returns The formula string (without leading '='), or empty string if none.
   */
  function getCellFormula(
    row: number,
    col: number,
    sheetIndex?: number,
  ): string;

  // --------------------------------------------------------------------------
  // Sheet Operations
  // --------------------------------------------------------------------------

  /**
   * Get the active sheet info.
   * @returns JSON string of `{ index: number, name: string }`
   */
  function getActiveSheet(): string;

  /**
   * Get all sheet names.
   * @returns JSON string of `string[]`
   */
  function getSheetNames(): string;

  /**
   * Switch the active sheet.
   * @param index - 0-based sheet index
   */
  function setActiveSheet(index: number): void;

  /**
   * Get the total number of sheets.
   * @returns The sheet count
   */
  function getSheetCount(): number;

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  /**
   * Log a message to the script console output.
   * @param args - One or more values to log (joined with spaces)
   */
  function log(...args: string[]): void;

  // --------------------------------------------------------------------------
  // Navigation & View
  // --------------------------------------------------------------------------

  /**
   * Get the current view mode.
   * @returns "normal" or "pageBreakPreview"
   */
  function getViewMode(): string;

  /**
   * Set the view mode (applied after the script completes).
   * @param mode - "normal" or "pageBreakPreview"
   */
  function setViewMode(mode: string): void;

  /**
   * Get the current zoom level as a decimal (1.0 = 100%).
   * @returns The zoom factor
   */
  function getZoom(): number;

  /**
   * Set the zoom level (applied after the script completes).
   * @param percent - Zoom factor as a decimal (1.0 = 100%)
   */
  function setZoom(percent: number): void;

  /**
   * Get the cell reference style.
   * @returns "A1" or "R1C1"
   */
  function getReferenceStyle(): string;

  /**
   * Set the cell reference style (applied after the script completes).
   * @param style - "A1" or "R1C1"
   */
  function setReferenceStyle(style: string): void;

  // --------------------------------------------------------------------------
  // Sheet Operations (navigation & visibility)
  // --------------------------------------------------------------------------

  /** Switch to the next sheet (wraps around to the first). */
  function nextSheet(): void;

  /** Switch to the previous sheet (wraps around to the last). */
  function previousSheet(): void;

  /**
   * Get a sheet's visibility.
   * @param index - 0-based sheet index
   * @returns "visible", "hidden", or "veryHidden"
   */
  function getSheetVisibility(index: number): string;

  /**
   * Hide a sheet (applied after the script completes).
   * @param index - 0-based sheet index
   * @param level - Optional: "hidden" (default) or "veryHidden"
   */
  function hideSheet(index: number, level?: string): void;

  /**
   * Make a hidden sheet visible again (applied after the script completes).
   * @param index - 0-based sheet index
   */
  function unhideSheet(index: number): void;

  // --------------------------------------------------------------------------
  // Workbook Properties
  // --------------------------------------------------------------------------

  /**
   * Get a custom workbook property.
   * @param key - Property name
   * @returns The property value, or empty string if not set.
   */
  function getWorkbookProperty(key: string): string;

  /**
   * Set a custom workbook property.
   * @param key - Property name
   * @param value - Property value
   */
  function setWorkbookProperty(key: string, value: string): void;

  // --------------------------------------------------------------------------
  // Formatting & Style
  // --------------------------------------------------------------------------

  /**
   * Get the names of all defined named styles.
   * @returns JSON string of `string[]`
   */
  function getNamedStyles(): string;

  /**
   * Apply a named style to a cell (applied after the script completes).
   * @param styleName - The named style to apply
   * @param row - 0-based row index
   * @param col - 0-based column index
   */
  function applyNamedStyle(styleName: string, row: number, col: number): void;

  // --------------------------------------------------------------------------
  // Calculation
  // --------------------------------------------------------------------------

  /**
   * Get the current calculation state.
   * @returns "done" (calculation is synchronous in the current version)
   */
  function getCalculationState(): string;

  /**
   * Get iterative-calculation settings.
   * @returns JSON string of `{ enabled: boolean, maxIterations: number, maxChange: number }`
   */
  function getIterationSettings(): string;

  /**
   * Set iterative-calculation settings (applied after the script completes).
   * @param enabled - Whether iterative calculation is on
   * @param maxIterations - Maximum iteration count
   * @param maxChange - Maximum change threshold to stop iterating
   */
  function setIterationSettings(
    enabled: boolean,
    maxIterations: number,
    maxChange: number,
  ): void;

  // --------------------------------------------------------------------------
  // Data
  // --------------------------------------------------------------------------

  /**
   * Fill the top row of a range downward into the rest of the range
   * (applied after the script completes).
   * @param startRow - 0-based start row
   * @param startCol - 0-based start column
   * @param endRow - 0-based end row (inclusive)
   * @param endCol - 0-based end column (inclusive)
   */
  function fillDown(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): void;

  /**
   * Fill the left column of a range rightward into the rest of the range
   * (applied after the script completes).
   * @param startRow - 0-based start row
   * @param startCol - 0-based start column
   * @param endRow - 0-based end row (inclusive)
   * @param endCol - 0-based end column (inclusive)
   */
  function fillRight(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): void;

  /**
   * Get the contiguous data region surrounding a cell (like Ctrl+Shift+*).
   * @param row - 0-based row index
   * @param col - 0-based column index
   * @returns JSON string of `{ startRow, startCol, endRow, endCol }`
   */
  function getCurrentRegion(row: number, col: number): string;

  /**
   * Compute the product of a list of numbers.
   * @param valuesJson - JSON string of a `number[]`
   * @returns The product of all values
   */
  function product(valuesJson: string): number;

  // --------------------------------------------------------------------------
  // Worksheet Properties
  // --------------------------------------------------------------------------

  /**
   * Get the used range of the active sheet (bounding box of non-empty cells).
   * @returns JSON string of `{ startRow, startCol, endRow, endCol, empty: boolean }`
   */
  function getUsedRange(): string;

  /** Whether zero values are displayed on the active sheet. */
  function getDisplayZeros(): boolean;

  /**
   * Toggle display of zero values on the active sheet (applied after the
   * script completes).
   * @param value - true to show zeros, false to hide them
   */
  function setDisplayZeros(value: boolean): void;

  /** Whether the workbook has unsaved changes. */
  function isDirty(): boolean;

  /**
   * Scroll the grid to make a cell visible WITHOUT changing the selection
   * (applied after the script completes).
   * @param row - 0-based row index
   * @param col - 0-based column index
   */
  function scrollToCell(row: number, col: number): void;

  /**
   * Get the scroll area (the range users are restricted to scrolling within).
   * @returns An A1-style range string, or empty string if unrestricted.
   */
  function getScrollArea(): string;

  /**
   * Set the scroll area (applied after the script completes).
   * @param area - An A1-style range string; pass an empty string to clear it.
   */
  function setScrollArea(area: string): void;

  // --------------------------------------------------------------------------
  // Display
  // --------------------------------------------------------------------------

  /**
   * Set the status bar message (applied after the script completes).
   * @param text - The message to display
   */
  function setStatusBarText(text: string): void;

  /** Reset the status bar to its default (applied after the script completes). */
  function clearStatusBarText(): void;

  /**
   * Toggle gridline display on the active sheet (applied after the script completes).
   * @param value - true to show gridlines, false to hide them
   */
  function setDisplayGridlines(value: boolean): void;

  /**
   * Toggle row/column heading display on the active sheet (applied after the
   * script completes).
   * @param value - true to show headings, false to hide them
   */
  function setDisplayHeadings(value: boolean): void;

  /** Whether gridlines are displayed on the active sheet. */
  function getDisplayGridlines(): boolean;

  /** Whether row/column headings are displayed on the active sheet. */
  function getDisplayHeadings(): boolean;

  // --------------------------------------------------------------------------
  // Application Object (modelled after Excel's Application object)
  // --------------------------------------------------------------------------

  /**
   * Application-level properties and methods, analogous to Excel's
   * `Application` object. Provides read-only app metadata, read-write
   * control properties, and deferred action methods.
   *
   * @example
   * // Read application info
   * Calcula.log(Calcula.application.name);           // "Calcula"
   * Calcula.log(Calcula.application.version);         // "0.1.0"
   * Calcula.log(Calcula.application.decimalSeparator); // "." or ","
   *
   * // Suppress grid refresh during batch operations
   * Calcula.application.screenUpdating = false;
   * // ... bulk cell writes ...
   * Calcula.application.screenUpdating = true;
   *
   * // Navigate to a cell after script completes
   * Calcula.application.goto(0, 0);
   *
   * // Set a status bar message
   * Calcula.application.statusBar = "Processing complete!";
   */
  namespace application {
    // -- Read-only Properties --

    /** Application name. Always "Calcula". */
    const name: string;

    /** Application version (e.g. "0.1.0"). */
    const version: string;

    /** Operating system identifier (e.g. "windows", "macos", "linux"). */
    const operatingSystem: string;

    /** File path separator ("\" on Windows, "/" on Unix). */
    const pathSeparator: string;

    /** Locale decimal separator (e.g. "." or ","). */
    const decimalSeparator: string;

    /** Locale thousands/grouping separator (e.g. ",", ".", or space). */
    const thousandsSeparator: string;

    // -- Read-write Properties --

    /**
     * Calculation mode: "automatic" or "manual".
     * Read-only in the current version.
     */
    let calculationMode: string;

    /**
     * Controls whether the grid refreshes after the script completes.
     * Set to `false` before batch operations to improve performance,
     * then set back to `true` when done.
     * Default: `true`.
     *
     * Analogous to Excel's `Application.ScreenUpdating`.
     */
    let screenUpdating: boolean;

    /**
     * Controls whether application events are fired during script execution.
     * Default: `true`.
     *
     * Analogous to Excel's `Application.EnableEvents`.
     */
    let enableEvents: boolean;

    /**
     * Set to a string to display a message in the status bar.
     * Set to `"false"` or empty string to reset to default.
     *
     * Analogous to Excel's `Application.StatusBar`.
     */
    let statusBar: string;

    // -- Methods --

    /**
     * Request a full recalculation after the script completes.
     *
     * Analogous to Excel's `Application.Calculate`.
     */
    function calculate(): void;

    /**
     * Navigate to a specific cell after the script completes.
     * Sets the selection and scrolls the viewport.
     *
     * Analogous to Excel's `Application.Goto`.
     *
     * @param row - 0-based row index
     * @param col - 0-based column index
     * @param sheetIndex - Optional sheet index (defaults to active sheet)
     */
    function goto(row: number, col: number, sheetIndex?: number): void;
  }

  // --------------------------------------------------------------------------
  // Bookmarks
  // --------------------------------------------------------------------------

  namespace bookmarks {
    /**
     * List all cell bookmarks.
     * @returns JSON string of cell bookmarks array
     */
    function listCellBookmarks(): string;

    /**
     * Add a cell bookmark. The bookmark is created after the script completes.
     * @param row - 0-based row index
     * @param col - 0-based column index
     * @param sheetIndex - Optional sheet index (defaults to active sheet)
     * @param label - Optional label (defaults to cell reference)
     * @param color - Optional color: "blue"|"green"|"orange"|"red"|"purple"|"yellow"
     */
    function addCellBookmark(
      row: number,
      col: number,
      sheetIndex?: number,
      label?: string,
      color?: string,
    ): void;

    /**
     * Remove a cell bookmark at the specified location.
     * @param row - 0-based row index
     * @param col - 0-based column index
     * @param sheetIndex - Optional sheet index (defaults to active sheet)
     */
    function removeCellBookmark(
      row: number,
      col: number,
      sheetIndex?: number,
    ): void;

    /**
     * List all view bookmarks.
     * @returns JSON string of view bookmarks array
     */
    function listViewBookmarks(): string;

    /**
     * Create a view bookmark that captures the current view state.
     * The view state is captured after the script completes.
     * @param label - Display name for the view bookmark
     * @param color - Optional color: "blue"|"green"|"orange"|"red"|"purple"|"yellow"
     * @param dimensionsJson - Optional JSON string specifying which dimensions to capture.
     *   Example: '{"selection":true,"zoom":true,"autoFilter":true}'
     *   If omitted, default dimensions are used (selection, activeSheet, zoom, viewport, autoFilter).
     */
    function createViewBookmark(
      label: string,
      color?: string,
      dimensionsJson?: string,
    ): void;

    /**
     * Delete a view bookmark by ID.
     * @param id - The view bookmark ID
     */
    function deleteViewBookmark(id: string): void;

    /**
     * Activate a view bookmark (restore its captured state).
     * The activation happens after the script completes.
     * @param id - The view bookmark ID
     */
    function activateViewBookmark(id: string): void;
  }
}

// ============================================================================
// Console (mirrors browser console API)
// ============================================================================

declare namespace console {
  function log(...args: string[]): void;
  function warn(...args: string[]): void;
  function error(...args: string[]): void;
  function info(...args: string[]): void;
}

// ============================================================================
// Model (read-only BI model access — NOTEBOOK CELLS ONLY)
// ============================================================================

/** A whitelisted, non-sensitive BI connection summary. */
interface ModelConnectionSummary {
  id: string;
  name: string;
  description: string;
  connectionType: string;
  isConnected: boolean;
  tableCount: number;
  measureCount: number;
}

/**
 * A tabular model-query result. Cells are display strings (null = missing).
 * When a result is the LAST EXPRESSION of a notebook cell it auto-renders as
 * a table output.
 */
interface ModelResult {
  columns: string[];
  rows: (string | null)[][];
  /** Rows in this result object (post any row-cap truncation). */
  rowCount: number;
  /** Rows the query produced before truncation. */
  totalRows: number;
  /** True when rows were dropped to fit the row cap (50,000). */
  truncated: boolean;
  /** The rows as an array of {column: value} records. */
  objects(): Array<Record<string, string | null>>;
  /**
   * Write the result into the grid through the notebook's cloned grid state
   * (audited, undoable, rewindable like any notebook mutation).
   * @param startRow - 0-based anchor row
   * @param startCol - 0-based anchor column
   * @param opts - headers (default true) writes the column row first;
   *               sheet targets a specific sheet index (default active)
   * @returns The written extent (rows and cols).
   */
  toGrid(
    startRow: number,
    startCol: number,
    opts?: { headers?: boolean; sheet?: number },
  ): { rows: number; cols: number };
}

/**
 * Read-only access to this workbook's Calcula models (BI connections).
 * AVAILABLE IN NOTEBOOK CELLS ONLY — other script surfaces throw
 * "Model API is not available on this surface".
 *
 * Governance: model.* is capability-gated per notebook. The first call
 * prompts for consent (`bi.query` for structured/metadata access, the
 * higher-trust `bi.sql` for raw SQL); grants last for the session and every
 * call — success or denial — is recorded in the always-on audit log.
 * Row-level-security roles active on a connection apply to every query.
 *
 * `connection` arguments accept a connection NAME or id.
 */
declare namespace model {
  /** List this workbook's BI connections (non-sensitive summaries). [bi.query] */
  function connections(): ModelConnectionSummary[];

  /**
   * Model metadata for a connection: tables/columns, measures, relationships,
   * hierarchies, KPIs, security roles, calculation groups. [bi.query]
   */
  function info(connection: string): unknown;

  /**
   * Run a structured model query. [bi.query]
   * @example
   * const r = model.query("Sales DB", {
   *   measures: ["Total Revenue"],
   *   groupBy: [{ table: "Geo", column: "Country" }],
   *   filters: [{ table: "Date", column: "Year", operator: "=", value: "2026" }],
   * });
   * r // last expression -> renders as a table
   */
  function query(
    connection: string,
    spec: {
      measures: string[];
      groupBy?: Array<{ table: string; column: string }>;
      filters?: Array<{ table: string; column: string; operator: string; value: string }>;
    },
  ): ModelResult;

  /**
   * Run READ-ONLY raw SQL against the connection's data source (single
   * SELECT/WITH statement; validated server-side). [bi.sql — higher trust,
   * separate consent]
   */
  function sql(connection: string, sql: string): ModelResult;

  /**
   * Scalar measure value under member filters (CUBEVALUE parity). Members use
   * the native syntax: "[Measure Name]", "Table[Column]=Value". [bi.query]
   * @example model.value("Sales DB", "[Total Revenue]", "Geo[Country]=Sweden")
   */
  function value(connection: string, ...members: string[]): number | null;

  /** Distinct members of a Table[Column] level (CUBEMEMBER-ish parity). [bi.query] */
  function members(connection: string, level: string): string[];

  /**
   * KPI value (property 1), goal (2), or status -1/0/1 (3) — CUBEKPIMEMBER
   * parity. [bi.query]
   */
  function kpi(connection: string, name: string, property?: number): number | null;
}

// ============================================================================
// Display (rich structured output)
// ============================================================================

declare namespace display {
  /**
   * Render tabular data as a table output item (notebook cells render it as a
   * real table; string-only surfaces flatten it to tab-separated text).
   *
   * Accepted shapes:
   * - `display.table([{a: 1, b: 2}, ...])` — array of objects (keys of the
   *   first object become the column headers)
   * - `display.table([[1, 2], [3, 4]])` — array of arrays (no header row)
   * - `display.table(["A", "B"], [[1, 2], [3, 4]])` — explicit columns + rows
   * - `display.table({columns: [...], rows: [[...]]})` — result-shaped object
   *
   * A notebook cell whose LAST EXPRESSION is a `{columns, rows}`-shaped object
   * (all columns strings, all rows arrays) auto-renders as a table without
   * calling display.table.
   *
   * Rows are capped per table item (200 live / 50 persisted in the workbook
   * file); the rendered footer shows the original row count when truncated.
   */
  function table(
    data:
      | Array<Record<string, unknown>>
      | unknown[][]
      | { columns: string[]; rows: unknown[][] },
    rows?: unknown[][],
  ): void;
}
