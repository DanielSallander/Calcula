//! FILENAME: app/src/core/lib/cellClickInterceptors.ts
// PURPOSE: Generic cell click interceptor registry for the grid.
// CONTEXT: Extensions register interceptor functions that can handle cell clicks
// before the Core's default selection behavior runs. If any interceptor returns
// true, the click is considered handled and default behavior is suppressed.
// NOTE: This is a Core primitive. The API layer re-exports it for extensions.

// ============================================================================
// Types
// ============================================================================

/** Minimal click event data passed to interceptors. */
export interface CellClickEvent {
  clientX: number;
  clientY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * An async function that can intercept a cell click.
 * Return `true` to indicate the click was handled (prevents default behavior).
 * Return `false` to let the next interceptor or default behavior proceed.
 */
export type CellClickInterceptorFn = (
  row: number,
  col: number,
  event: CellClickEvent
) => Promise<boolean>;

// ============================================================================
// Internal State
// ============================================================================

const interceptors = new Set<CellClickInterceptorFn>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a cell click interceptor.
 * @param interceptor - Async function that can handle a cell click.
 * @returns A cleanup function that unregisters the interceptor.
 */
export function registerCellClickInterceptor(
  interceptor: CellClickInterceptorFn
): () => void {
  interceptors.add(interceptor);
  return () => {
    interceptors.delete(interceptor);
  };
}

/**
 * Check all registered cell click interceptors for a given cell.
 * Returns `true` if any interceptor handled the click.
 */
export async function checkCellClickInterceptors(
  row: number,
  col: number,
  event: CellClickEvent
): Promise<boolean> {
  for (const interceptor of interceptors) {
    try {
      if (await interceptor(row, col, event)) {
        return true;
      }
    } catch (error) {
      console.error("Error in cell click interceptor:", error);
    }
  }
  return false;
}

// ============================================================================
// Grid Cell Press (announced AFTER Core handled it)
// ============================================================================

/**
 * A grid press Core has HANDLED as a selection gesture -- on a CELL, a row or
 * column HEADER, or the select-all corner: the press was not taken by a
 * floating object, a fill handle or an interceptor, it was not a reference
 * pick, and the selection is now the sheet's. Two kinds:
 *   - a SELECTING press (`keptSelection: false`): commit-before-select has
 *     already run (an open edit -- Core's own or an external session -- is
 *     committed) and the pressed cell, row, column or sheet is now selected;
 *   - a right-press INSIDE the selection (`keptSelection: true`): Core keeps
 *     its selection for the context menu and commits nothing, but the press is
 *     still the user's pointer ON THE SHEET's selection (BUG-0186).
 * An object that keeps its own selection over the grid (a floating grid's
 * cell) must drop it on EITHER kind: after either one the grid's selection is
 * what the next command -- the context menu that opens, a ribbon button --
 * acts on, and two selections must never both look current.
 */
export interface GridCellPress {
  /** The pressed row (-1 for a column-header or select-all press). */
  row: number;
  /** The pressed column (-1 for a row-header or select-all press). */
  col: number;
  /** 0 = primary, 2 = secondary. */
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  /** What was pressed: a cell, a row header, a column header, the corner. */
  target: "cell" | "row" | "column" | "all";
  /** True for a right-press inside the selection (kept for the context menu). */
  keptSelection: boolean;
}

/** Hears every handled grid cell press. Synchronous; a throw is logged and ignored. */
export type GridCellPressListener = (press: GridCellPress) => void;

const pressListeners = new Set<GridCellPressListener>();

/**
 * Listen for handled grid cell presses. WHY THIS EXISTS: a selection-change
 * listener cannot see a press that leaves Core's selection UNCHANGED -- a
 * click on the cell Core already had active. An object that keeps its own
 * cell selection over the grid (a floating grid's selected cell, which leaves
 * Core's active cell where it was, hidden underneath) never learnt that the
 * user clicked back onto the sheet, so the formula bar and the Name Box went
 * on targeting the object's cell. The interceptors run BEFORE the press and
 * stand down while an edit is live; this runs AFTER it, always.
 * @returns A cleanup function that removes the listener.
 */
export function onGridCellPressed(listener: GridCellPressListener): () => void {
  pressListeners.add(listener);
  return () => {
    pressListeners.delete(listener);
  };
}

/**
 * CORE ONLY (the cell-selection mouse handler): announce a handled press.
 * Deliberately NOT re-exported through @api -- an extension must not be able
 * to fake the user's click.
 */
export function notifyGridCellPressed(press: GridCellPress): void {
  for (const listener of [...pressListeners]) {
    try {
      listener(press);
    } catch (error) {
      console.error("Error in grid cell press listener:", error);
    }
  }
}

// ============================================================================
// Cell Cursor Interceptors
// ============================================================================

/**
 * Synchronous function that returns a CSS cursor string for a cell,
 * or null to use the default cursor.
 */
export type CellCursorInterceptorFn = (row: number, col: number) => string | null;

const cursorInterceptors = new Set<CellCursorInterceptorFn>();

/**
 * Register a cell cursor interceptor.
 * @param interceptor - Function that returns a cursor string or null.
 * @returns A cleanup function that unregisters the interceptor.
 */
export function registerCellCursorInterceptor(
  interceptor: CellCursorInterceptorFn
): () => void {
  cursorInterceptors.add(interceptor);
  return () => {
    cursorInterceptors.delete(interceptor);
  };
}

/**
 * Check all registered cursor interceptors for a cell.
 * Returns the first non-null cursor, or null for default.
 */
export function getCellCursorOverride(row: number, col: number): string | null {
  for (const interceptor of cursorInterceptors) {
    try {
      const cursor = interceptor(row, col);
      if (cursor) return cursor;
    } catch (error) {
      console.error("Error in cell cursor interceptor:", error);
    }
  }
  return null;
}