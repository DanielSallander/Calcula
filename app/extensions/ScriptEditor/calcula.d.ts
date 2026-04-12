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
// Calcula Namespace
// ============================================================================

declare namespace Calcula {
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
