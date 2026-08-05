//! FILENAME: app/extensions/ScriptNotebook/lib/deferredActions.ts
// PURPOSE: Map the deferred actions a script queued onto host operations.
// CONTEXT: Scripts run in an isolated interpreter over cloned grid state, so
//          anything that touches the live UI (navigation, view toggles, fills,
//          named styles, sheet visibility, ...) comes back as a DeferredAction
//          queue that the host replays IN ORDER once the run finishes.
//          The mapping is pure and host-injected: it validates payloads and
//          decides WHAT to call, never HOW to reach the grid — that lives in
//          deferredActionHost.ts. Keeps this testable without a live grid.

import type { DeferredAction } from "../types";

// ============================================================================
// Host contract
// ============================================================================

/** View modes the grid understands (mirrors the Core `ViewMode` union). */
export const VIEW_MODES = ["normal", "pageLayout", "pageBreakPreview"] as const;
export type ViewModeName = (typeof VIEW_MODES)[number];

/** Formula reference notations. */
export const REFERENCE_STYLES = ["A1", "R1C1"] as const;
export type ReferenceStyleName = (typeof REFERENCE_STYLES)[number];

/** Sheet visibility levels. */
export const SHEET_VISIBILITIES = ["visible", "hidden", "veryHidden"] as const;
export type SheetVisibilityName = (typeof SHEET_VISIBILITIES)[number];

/**
 * Every host operation a deferred action can drive. One method per capability
 * (not per action) so the mapping stays the only place that knows the wire
 * vocabulary.
 */
export interface DeferredActionHost {
  /** 0-based index of the sheet the user is looking at right now. */
  getActiveSheetIndex(): number;
  /** Bring a sheet to the front (used before a cross-sheet goto). */
  activateSheet(sheetIndex: number): Promise<void>;
  /**
   * Scroll to a cell, optionally selecting it. `endRow`/`endCol` are the
   * inclusive end of the selection (equal to `row`/`col` for a single cell);
   * the viewport always scrolls to the range's top-left.
   */
  gotoCell(row: number, col: number, select: boolean, endRow: number, endCol: number): void;
  /** Full workbook recalculation (Excel: Application.Calculate). */
  recalculate(): Promise<void>;
  /** Status bar message; null resets it to the default text. */
  setStatusBar(message: string | null): void;
  setViewMode(mode: ViewModeName): void;
  /** Zoom as a percentage (100 = 100%). */
  setZoomPercent(percent: number): void;
  setReferenceStyle(style: ReferenceStyleName): Promise<void>;
  setDisplayZeros(value: boolean): void;
  setDisplayGridlines(value: boolean): void;
  setDisplayHeadings(value: boolean): void;
  /** Formula view (Ctrl+`): show formula text instead of computed values. */
  setDisplayFormulas(value: boolean): void;
  fillDown(startRow: number, startCol: number, endRow: number, endCol: number): Promise<void>;
  fillRight(startRow: number, startCol: number, endRow: number, endCol: number): Promise<void>;
  /**
   * Apply a named style to the single cell (row, col), or — when endRow/endCol
   * are given — to the inclusive rect, as ONE undo step.
   */
  applyNamedStyle(
    name: string,
    row: number,
    col: number,
    endRow?: number,
    endCol?: number,
  ): Promise<void>;
  /** A1-style range restriction, or null to clear it. */
  setScrollArea(area: string | null): Promise<void>;
  setIterationSettings(
    enabled: boolean,
    maxIterations: number,
    maxChange: number,
  ): Promise<void>;
  setSheetVisibility(sheetIndex: number, visibility: SheetVisibilityName): Promise<void>;
}

// ============================================================================
// Validation helpers
// ============================================================================

function isSheetIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** Cell coordinates must be whole, non-negative numbers. */
function isCellCoord(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function asViewMode(mode: string): ViewModeName | null {
  return (VIEW_MODES as readonly string[]).includes(mode) ? (mode as ViewModeName) : null;
}

function asReferenceStyle(style: string): ReferenceStyleName | null {
  return (REFERENCE_STYLES as readonly string[]).includes(style)
    ? (style as ReferenceStyleName)
    : null;
}

function asSheetVisibility(visibility: string): SheetVisibilityName | null {
  return (SHEET_VISIBILITIES as readonly string[]).includes(visibility)
    ? (visibility as SheetVisibilityName)
    : null;
}

/**
 * The zoom bounds the script surface promises, in REAL percent. Wave 4 healed
 * the old factor form (`SetZoom.percent` used to carry 1.0 for 100%): the wire
 * now carries the percent itself, validated to this range engine-side; this is
 * the host's belt-and-braces re-check.
 */
export const ZOOM_PERCENT_MIN = 10;
export const ZOOM_PERCENT_MAX = 400;

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Apply one deferred action. Returns false when the payload was rejected
 * (out-of-range coordinates, unknown view mode, ...) so callers can log it.
 */
async function applyDeferredAction(
  action: DeferredAction,
  host: DeferredActionHost,
): Promise<boolean> {
  switch (action.action) {
    case "goto": {
      if (!isCellCoord(action.row) || !isCellCoord(action.col)) return false;
      // endRow/endCol extend the target to a range (A1-form goto). Null means
      // a single cell; a half-set or inverted pair is a malformed payload.
      let endRow = action.row;
      let endCol = action.col;
      if (action.endRow !== null || action.endCol !== null) {
        if (
          action.endRow === null ||
          action.endCol === null ||
          !isCellCoord(action.endRow) ||
          !isCellCoord(action.endCol) ||
          action.endRow < action.row ||
          action.endCol < action.col
        ) {
          return false;
        }
        endRow = action.endRow;
        endCol = action.endCol;
      }
      // sheetIndex is NaN when the script did not name a sheet — stay put.
      if (isSheetIndex(action.sheetIndex) && action.sheetIndex !== host.getActiveSheetIndex()) {
        await host.activateSheet(action.sheetIndex);
      }
      host.gotoCell(action.row, action.col, action.select, endRow, endCol);
      return true;
    }

    case "activateSheet": {
      if (!isSheetIndex(action.sheetIndex)) return false;
      // A script that ends on the sheet it switched to must leave the user
      // there too; re-activating the current sheet is a cheap no-op skip.
      if (action.sheetIndex !== host.getActiveSheetIndex()) {
        await host.activateSheet(action.sheetIndex);
      }
      return true;
    }

    case "calculate":
      await host.recalculate();
      return true;

    case "setStatusBar":
      host.setStatusBar(action.message);
      return true;

    case "setDisplayZeros":
      host.setDisplayZeros(action.value);
      return true;

    case "setDisplayGridlines":
      host.setDisplayGridlines(action.value);
      return true;

    case "setDisplayHeadings":
      host.setDisplayHeadings(action.value);
      return true;

    case "setDisplayFormulas":
      host.setDisplayFormulas(action.value);
      return true;

    case "setViewMode": {
      const mode = asViewMode(action.mode);
      if (!mode) return false;
      host.setViewMode(mode);
      return true;
    }

    case "setZoom": {
      // A REAL percent, passed through verbatim (the engine already validated
      // the range; re-check here so a hand-crafted payload cannot sneak past).
      if (!(action.percent >= ZOOM_PERCENT_MIN && action.percent <= ZOOM_PERCENT_MAX)) {
        return false;
      }
      host.setZoomPercent(action.percent);
      return true;
    }

    case "setReferenceStyle": {
      const style = asReferenceStyle(action.style);
      if (!style) return false;
      await host.setReferenceStyle(style);
      return true;
    }

    case "fillDown": {
      if (
        !isCellCoord(action.startRow) ||
        !isCellCoord(action.startCol) ||
        !isCellCoord(action.endRow) ||
        !isCellCoord(action.endCol)
      ) {
        return false;
      }
      await host.fillDown(action.startRow, action.startCol, action.endRow, action.endCol);
      return true;
    }

    case "fillRight": {
      if (
        !isCellCoord(action.startRow) ||
        !isCellCoord(action.startCol) ||
        !isCellCoord(action.endRow) ||
        !isCellCoord(action.endCol)
      ) {
        return false;
      }
      await host.fillRight(action.startRow, action.startCol, action.endRow, action.endCol);
      return true;
    }

    case "applyNamedStyle": {
      if (!action.name || !isCellCoord(action.row) || !isCellCoord(action.col)) return false;
      // endRow/endCol widen the target to an inclusive rect. Same half-set
      // rule as goto: both or neither.
      if (action.endRow !== null || action.endCol !== null) {
        if (
          action.endRow === null ||
          action.endCol === null ||
          !isCellCoord(action.endRow) ||
          !isCellCoord(action.endCol)
        ) {
          return false;
        }
        await host.applyNamedStyle(action.name, action.row, action.col, action.endRow, action.endCol);
        return true;
      }
      await host.applyNamedStyle(action.name, action.row, action.col);
      return true;
    }

    case "setScrollArea": {
      // An empty string from the script means "clear the restriction".
      const area = action.area && action.area.trim() !== "" ? action.area : null;
      await host.setScrollArea(area);
      return true;
    }

    case "setIterationSettings": {
      if (!Number.isInteger(action.maxIterations) || action.maxIterations < 0) return false;
      if (!Number.isFinite(action.maxChange) || action.maxChange < 0) return false;
      await host.setIterationSettings(action.enabled, action.maxIterations, action.maxChange);
      return true;
    }

    case "setSheetVisibility": {
      const visibility = asSheetVisibility(action.visibility);
      if (!visibility || !isSheetIndex(action.sheetIndex)) return false;
      await host.setSheetVisibility(action.sheetIndex, visibility);
      return true;
    }
  }
}

/**
 * Replay a script's deferred-action queue against the host, in order.
 * One failing action never aborts the rest of the queue — a script that hides
 * gridlines and then navigates must still navigate.
 */
export async function applyDeferredActions(
  actions: readonly DeferredAction[],
  host: DeferredActionHost,
): Promise<void> {
  for (const action of actions) {
    try {
      const applied = await applyDeferredAction(action, host);
      if (!applied) {
        console.warn("[ScriptNotebook] Ignored deferred action with invalid payload:", action);
      }
    } catch (err) {
      console.error("[ScriptNotebook] Deferred action failed:", action, err);
    }
  }
}
