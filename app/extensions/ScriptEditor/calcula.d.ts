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
