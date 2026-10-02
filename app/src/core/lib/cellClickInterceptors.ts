//! FILENAME: app/src/core/lib/cellClickInterceptors.ts
// PURPOSE: Generic cell click interceptor registry for the grid.
// CONTEXT: Extensions register interceptor functions that can handle cell clicks
// before the Core's default selection behavior runs. If any interceptor returns
// true, the click is considered handled and default behavior is suppressed.
// An interceptor may instead answer with a RELEASE CLAIM (`actOnRelease` /
// `actOnCellRelease` below): the press is taken now and acts only when it is
// released over the same target, and sliding off cancels -- the standard
// Windows button rule (BUG-0258 design phase 4). Core runs that one press
// session for every family (core/lib/cellPressRelease.ts).
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
 * What an interceptor answers a press with:
 *   - `true`: handled AT THE PRESS (prevents default behavior);
 *   - `false`: not mine -- the next interceptor or default behavior proceeds;
 *   - a {@link CellReleaseClaim}: mine, and it ACTS AT THE RELEASE over the
 *     same target; the press is taken now (no selection) and Core holds it.
 */
export type CellClickAnswer = boolean | CellReleaseClaim;

/**
 * An async function that can intercept a cell click.
 * Return `true` to indicate the click was handled (prevents default behavior).
 * Return `false` to let the next interceptor or default behavior proceed.
 * Return a release claim to act when the press is RELEASED over the same
 * target (buttons, a pivot's +/- and filter buttons): see {@link actOnRelease}.
 */
export type CellClickInterceptorFn = (
  row: number,
  col: number,
  event: CellClickEvent
) => Promise<CellClickAnswer>;

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
 * Returns `true` if any interceptor handled the click at the press, the
 * release claim of the first one that claimed it for its release, or `false`.
 * The first answer that is not `false` wins, in registration order.
 */
export async function checkCellClickInterceptors(
  row: number,
  col: number,
  event: CellClickEvent
): Promise<CellClickAnswer> {
  for (const interceptor of interceptors) {
    try {
      const answer: unknown = await interceptor(row, col, event);
      if (isCellReleaseClaim(answer)) {
        return answer;
      }
      if (answer) {
        return true;
      }
    } catch (error) {
      console.error("Error in cell click interceptor:", error);
    }
  }
  return false;
}

// ============================================================================
// Release claims (BUG-0258 design phase 4: act on RELEASE, sliding off cancels)
// ============================================================================

/**
 * Where the pointer is during a claimed press: the client point and the CELL
 * under it, measured when it is asked (Core's own pane-aware hit test, with the
 * geometry as it is painted then). Core hands a claim ONLY a point that is on
 * the cells of the sheet the press began on: never one over a floating object,
 * over DOM stacked above the grid (a menu, a dialog, a claimed form), over a
 * header or outside the grid -- there the pointer is off every cell target.
 */
export interface CellPressPoint extends CellClickEvent {
  /** The cell under the point. */
  row: number;
  col: number;
}

/**
 * A press an interceptor takes NOW and acts on at its RELEASE -- the standard
 * Windows button rule, the owner's answer to "buttons: run on press or on
 * release?" (BUG-0258 design phase 4): on release, and sliding off cancels.
 *
 * Core holds the press (core/lib/cellPressRelease.ts) and:
 *   - asks `targetAt` at every move and at the release, and runs
 *     `runAtRelease` ONCE, only when the release's answer is `key`;
 *   - tells `setPressed` (optional) when the pointer enters or leaves the
 *     target while the press is held, and `false` at every end;
 *   - ends the press with NOTHING run on Escape, a window blur, a move with the
 *     primary button up, a middle release with the primary up, the next press,
 *     and for any press that is not a primary one.
 * Build one with {@link actOnRelease} or, for a target that is one cell,
 * {@link actOnCellRelease}.
 */
export interface CellReleaseClaim {
  /** Marks the answer as a release claim (`actOnRelease` sets it). */
  readonly actsOn: "release";
  /** Names the target the press began on. */
  readonly key: string;
  /**
   * The key of the target under a point, measured NOW (the geometry as it is
   * painted at that moment), or null when the point is on no target of this
   * claim. A throw counts as null.
   */
  targetAt(point: CellPressPoint): string | null;
  /** What the press does. Called once, at a release whose `targetAt` is `key`. */
  runAtRelease(release: CellPressPoint): void | Promise<void>;
  /** The pressed look, where the target has one: true while held inside. */
  setPressed?(pressed: boolean): void;
}

/** What {@link actOnRelease} takes: a claim without its marker. */
export type CellReleaseClaimSpec = Omit<CellReleaseClaim, "actsOn">;

/** Build a release claim (the answer an interceptor returns to act at the release). */
export function actOnRelease(spec: CellReleaseClaimSpec): CellReleaseClaim {
  const claim: CellReleaseClaim = {
    actsOn: "release",
    key: spec.key,
    targetAt: (point) => spec.targetAt(point),
    runAtRelease: (release) => spec.runAtRelease(release),
  };
  if (spec.setPressed) {
    const setPressed = spec.setPressed;
    return { ...claim, setPressed: (pressed) => setPressed(pressed) };
  }
  return claim;
}

/** Is this interceptor answer a release claim? */
export function isCellReleaseClaim(value: unknown): value is CellReleaseClaim {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CellReleaseClaim>;
  return (
    v.actsOn === "release" &&
    typeof v.key === "string" &&
    typeof v.targetAt === "function" &&
    typeof v.runAtRelease === "function"
  );
}

/** The cell a held cell claim shows PRESSED (see {@link isCellPressed}). */
let pressedCell: { row: number; col: number } | null = null;

/**
 * A release claim whose target is ONE CELL (an in-cell button): the release
 * acts only on that same cell. With `pressedLook`, the cell shows pressed
 * while the press is held over it -- its renderer asks {@link isCellPressed}.
 */
export function actOnCellRelease(
  row: number,
  col: number,
  run: (release: CellPressPoint) => void | Promise<void>,
  options: { pressedLook?: boolean } = {},
): CellReleaseClaim {
  const key = `cell:${row}:${col}`;
  return actOnRelease({
    key,
    targetAt: (point) => (point.row === row && point.col === col ? key : null),
    runAtRelease: run,
    ...(options.pressedLook
      ? {
          setPressed: (pressed: boolean) => {
            if (pressed) {
              pressedCell = { row, col };
            } else if (pressedCell !== null && pressedCell.row === row && pressedCell.col === col) {
              pressedCell = null;
            }
          },
        }
      : {}),
  });
}

/**
 * Does the cell at (row, col) show PRESSED -- a held press of a cell claim
 * with the pressed look, with the pointer over that cell? Renderers ask it
 * while painting; it is the active sheet's (Core ends the look when the
 * press ends, and a press never survives onto another sheet's cells).
 */
export function isCellPressed(row: number, col: number): boolean {
  return pressedCell !== null && pressedCell.row === row && pressedCell.col === col;
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