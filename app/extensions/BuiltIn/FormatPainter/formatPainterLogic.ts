//! FILENAME: app/extensions/BuiltIn/FormatPainter/formatPainterLogic.ts
// PURPOSE: Core logic for the Format Painter tool: capture source styles, apply to target.
// CONTEXT: Called by the extension entry point. Uses the public API only (no deep core imports).
//
// ON A FLOATING GRID'S CELLS (P3, owner finding G3): the SOURCE may be a
// floating grid's selected cells -- read through its styled read
// (`getCellTargetCells`), never Core's hidden cell under it -- and the painter
// then paints onto sheet cells as usual. Painting INTO a floating grid's cells
// is refused with one sentence and the painter stays armed: a stroke assigns
// the source's style INDEX to each destination cell, and no style-index write
// takes a target yet (the backend's set_cell_style acts on the active sheet;
// BUG-0513). A move of the floating grid's own
// selection (`onCellTargetChanged`) is a stroke attempt like a sheet click.

import type { Selection } from "@api/types";
import {
  getCell,
  setCellStyle,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
  setClipboard,
  clearClipboard,
  emitAppEvent,
  AppEvents,
  restoreFocusToGrid,
  ExtensionRegistry,
  registerEditGuard,
  dispatchGridAction,
} from "@api";

import {
  isFormatPainterActive,
  isFormatPainterPersistent,
  isFormatPainterStarting,
  getSourceStyles,
  getSourceDimensions,
  setFormatPainterActive,
  setFormatPainterPersistent,
  beginFormatPainterStart,
  lockStartingFormatPainter,
  cancelFormatPainterStart,
  finishFormatPainterStart,
  clearFormatPainterState,
  addCleanup,
  runAllCleanups,
} from "./formatPainterState";
import { alertAsync } from "@api/dialogs";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import {
  cellTargetFor,
  getCellTargetCells,
  onCellTargetChanged,
  resolveCellTarget,
  targetRefOf,
  type CellTargetRef,
} from "@api/cellTarget";

/** The sentence a stroke into a floating grid's cells is refused with. */
export const PAINT_INTO_FLOATING_GRID_REFUSAL =
  "Format Painter cannot paint into a floating grid's cells yet. Click a sheet cell to paint there. Nothing was changed.";

/** A stroke's closes, read when the close runs (see ownUndoTransaction). */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

// ============================================================================
// Paintbrush Cursor (SVG data URL)
// ============================================================================

const PAINTBRUSH_CURSOR_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23333' stroke-width='1.5'%3E%3Cpath d='M18.37 2.63a2 2 0 0 1 0 2.83L14 9.82l-1.17-1.17 4.37-4.37a1 1 0 0 1 1.41 0l.76.76zM12.13 9.35l-1.48-1.48-4.6 4.6a2 2 0 0 0-.5.9L4.5 17.5l4.13-1.05a2 2 0 0 0 .9-.5l4.6-4.6-2-2z'/%3E%3Cpath d='M4.5 17.5L2 22l4.5-2.5'/%3E%3C/svg%3E") 2 22, cell`;

// ============================================================================
// Capture Source Formatting
// ============================================================================

/**
 * Read the styleIndex of every cell in the source selection.
 * Returns a Map of "relRow,relCol" -> styleIndex.
 */
export async function captureSourceFormat(
  selection: Selection,
  target?: CellTargetRef,
): Promise<{ styles: Map<string, number>; width: number; height: number }> {
  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  const width = maxCol - minCol + 1;
  const height = maxRow - minRow + 1;
  const styles = new Map<string, number>();

  if (target) {
    // A floating grid's cells: ONE styled read of the rectangle. A cell the
    // read does not return stores nothing, so it carries the default style.
    const read = await getCellTargetCells(target, { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol });
    const byCell = new Map(read.cells.map((cell) => [`${cell.row},${cell.col}`, cell.styleIndex] as const));
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        styles.set(`${r - minRow},${c - minCol}`, byCell.get(`${r},${c}`) ?? 0);
      }
    }
    return { styles, width, height };
  }

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      const relR = r - minRow;
      const relC = c - minCol;
      try {
        const cell = await getCell(r, c);
        styles.set(`${relR},${relC}`, cell?.styleIndex ?? 0);
      } catch {
        styles.set(`${relR},${relC}`, 0);
      }
    }
  }

  return { styles, width, height };
}

// ============================================================================
// Apply Format to Target
// ============================================================================

/**
 * Apply the captured source styles to the target selection.
 * Uses tiling for range-to-range: source pattern repeats over the target.
 */
export async function applyFormatToTarget(target: Selection): Promise<void> {
  if (!isFormatPainterActive()) return;

  // Where the stroke lands. Core's selection on the sheet; an owner that does
  // not admit formatting refuses once (BUG-0185: Core's selection is HIDDEN
  // under it); a floating grid's cells have no style-index write (see the
  // header) -- refused, once. Either way the painter stays armed.
  const place = resolveCellTarget("Format Painter", "format");
  if (place === null) return;
  if (place.kind === "object") {
    void alertAsync(PAINT_INTO_FLOATING_GRID_REFUSAL);
    return;
  }

  const sourceStyles = getSourceStyles();
  const { width: srcW, height: srcH } = getSourceDimensions();

  if (sourceStyles.size === 0 || srcW === 0 || srcH === 0) return;

  const minRow = Math.min(target.startRow, target.endRow);
  const maxRow = Math.max(target.startRow, target.endRow);
  const minCol = Math.min(target.startCol, target.endCol);
  const maxCol = Math.max(target.startCol, target.endCol);

  // Closes ONLY the undo transaction its own begin opened: inside a script's
  // open batch the stroke joins, and the script closes that step (wave E, Y7).
  let tx: OwnedUndoTransaction | null = null;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction("Format Painter"), UNDO_CLOSES);

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const relR = (r - minRow) % srcH;
        const relC = (c - minCol) % srcW;
        const styleIndex = sourceStyles.get(`${relR},${relC}`);

        if (styleIndex !== undefined) {
          await setCellStyle(r, c, styleIndex);
        }
      }
    }

    await tx.commit();

    // Refresh style cache and grid
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));

    console.log(
      `[FormatPainter] Applied format to ${(maxRow - minRow + 1) * (maxCol - minCol + 1)} cells`
    );
  } catch (err) {
    console.error("[FormatPainter] Failed to apply format:", err);
    // Close the transaction (left open, later edits silently join it) and
    // tell the user why the paint stopped — a sheet-protection refusal names
    // the cell and the remedy.
    try { await tx?.cancel(); } catch { /* already closed */ }
    void alertAsync(err instanceof Error ? err.message : String(err));
  }

  // Deactivate in single-use mode
  if (!isFormatPainterPersistent()) {
    deactivateFormatPainter();
  }
}

// ============================================================================
// Cursor Management
// ============================================================================

function setCursorPaintbrush(): void {
  const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (canvas) {
    canvas.style.setProperty("cursor", PAINTBRUSH_CURSOR_SVG, "important");
  }
}

function clearCursorOverride(): void {
  const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (canvas) {
    canvas.style.removeProperty("cursor");
  }
}

// ============================================================================
// Activation / Deactivation
// ============================================================================

/**
 * Activate the Format Painter tool -- the one entry for both commands, so the
 * Home tab can send FORMAT_PAINTER on a click and FORMAT_PAINTER_LOCK on a
 * double-click, as Excel's button behaves:
 *
 *   painter state    | FORMAT_PAINTER (persistent=false) | FORMAT_PAINTER_LOCK (persistent=true)
 *   -----------------|-----------------------------------|--------------------------------------
 *   off              | arm, single-use                   | arm, locked
 *   starting         | ignored                           | the start arms LOCKED
 *   armed            | off (a click on the button)       | upgraded to locked, stays on
 *
 * LOCK used to switch an armed painter OFF (activation toggled whatever was
 * running), so a double-click -- click, then LOCK -- ended with no painter.
 * And a second activation during the start (the source read) started a
 * SECOND painter: two sets of listeners, every later paint two undo steps.
 * A double-click's DOM events (click, click, dblclick) come out locked on both
 * timings: a quick start ignores the second click and the dblclick locks it; a
 * start that finished before the second click is switched off by it and the
 * dblclick arms a locked one.
 *
 * @param persistent - True for persistent mode (stays active after applying once).
 * @param currentSelection - The current grid selection (source).
 */
export async function activateFormatPainter(
  persistent: boolean,
  currentSelection: Selection | null
): Promise<void> {
  // Still reading the source: a second start is ignored, a LOCK upgrades it.
  if (isFormatPainterStarting()) {
    if (persistent) lockStartingFormatPainter();
    return;
  }

  if (isFormatPainterActive()) {
    // LOCK on an armed painter upgrades it in place (same source, same
    // listeners); a plain click on the button turns it off.
    if (persistent) {
      setFormatPainterPersistent(true);
      return;
    }
    deactivateFormatPainter();
    return;
  }

  // The SOURCE: Core's selection, or a floating grid's selected cells (P3),
  // read through its target. An owner that admits no read refuses, once
  // (BUG-0185: Core's selection is hidden under it). Every door (Ctrl+Shift+C,
  // the ribbon, the Edit menu, Format Painter Lock) comes through here, and
  // turning the painter OFF (above) is never refused.
  const sourcePlace = resolveCellTarget("Format Painter", "read");
  if (sourcePlace === null) return;
  const sourceTarget = targetRefOf(sourcePlace);
  if (sourcePlace.kind === "object") currentSelection = sourcePlace.selection;
  if (!currentSelection) {
    console.warn("[FormatPainter] No selection to capture format from.");
    return;
  }

  console.log(
    `[FormatPainter] Activating (${persistent ? "persistent" : "single-use"})`,
    currentSelection
  );

  // 1. Capture source styles. The read is the STARTING window (one backend
  //    call per source cell): a second activation in it is ignored, a LOCK
  //    upgrades it, an Escape cancels it (formatPainterState.ts).
  beginFormatPainterStart(persistent);
  let capture: Awaited<ReturnType<typeof captureSourceFormat>>;
  try {
    capture = await captureSourceFormat(currentSelection, sourceTarget);
  } catch (err) {
    finishFormatPainterStart();
    throw err;
  }
  const start = finishFormatPainterStart();
  if (start.cancelled) {
    console.log("[FormatPainter] Start cancelled before the painter armed");
    return;
  }
  const { styles, width, height } = capture;

  // 2. Update state
  setFormatPainterActive(true, start.persistent, currentSelection, styles, width, height);

  // 3. Show marching ants around source -- a SHEET source only: Core's ants
  //    are drawn on the active sheet, where a floating grid's coordinates
  //    would outline the host's cells under the grid.
  if (!sourceTarget) dispatchGridAction(setClipboard("copy", { ...currentSelection }));

  // 4. Change cursor to paintbrush
  setCursorPaintbrush();

  // Keep cursor overridden on mouse move (core resets cursor on every move)
  const handleMouseMove = () => {
    if (isFormatPainterActive()) {
      setCursorPaintbrush();
    }
  };
  window.addEventListener("mousemove", handleMouseMove);
  addCleanup(() => window.removeEventListener("mousemove", handleMouseMove));

  // 5. Listen for selection changes and apply on mouseup (supports drag-to-select)
  //
  // EVERY change after activation is a candidate target. This used to skip
  // "the first callback" on the belief that the registry replays the current
  // selection on subscribe -- it does not (ExtensionRegistry.onSelectionChange
  // only adds the listener), so what it skipped was the USER'S FIRST CLICK:
  // after Ctrl+Shift+C the first click on B2 painted nothing and a second one
  // did (found live 2026-09-29, e2e fixall-edit K3). A notification that merely
  // restates the SOURCE range is not a target: painting a range onto itself
  // changes nothing, and re-renders can re-announce an unchanged selection.
  const source = { ...currentSelection };
  // A floating grid's source range is not a SHEET range: no Core selection
  // restates it.
  const isSourceRange = (s: Selection): boolean =>
    !sourceTarget &&
    s.startRow === source.startRow &&
    s.startCol === source.startCol &&
    s.endRow === source.endRow &&
    s.endCol === source.endCol;
  let pendingTarget: Selection | null = null;

  const unsubSelection = ExtensionRegistry.onSelectionChange(
    (newSelection: Selection | null) => {
      if (!isFormatPainterActive() || !newSelection) return;
      if (isSourceRange(newSelection)) return;

      // Store as pending - apply will happen on mouseup
      pendingTarget = newSelection;
    }
  );
  addCleanup(unsubSelection);

  // Apply format when mouse is released (user finished dragging to select target)
  const handleMouseUp = () => {
    if (!isFormatPainterActive() || !pendingTarget) return;

    const target = pendingTarget;
    pendingTarget = null;
    applyFormatToTarget(target);
  };
  window.addEventListener("mouseup", handleMouseUp);
  addCleanup(() => window.removeEventListener("mouseup", handleMouseUp));

  // A floating grid's OWN selection moved (P3): a stroke attempt on its cells,
  // like a click on a sheet cell. Core's selection does not move there, so the
  // listener above never hears it.
  const unsubTarget = onCellTargetChanged(() => {
    if (!isFormatPainterActive()) return;
    const moved = cellTargetFor("format", "Format Painter");
    if ("refusal" in moved || moved.kind !== "object") return;
    // A notification that restates the floating-grid SOURCE is not a stroke.
    const restatesSource =
      sourceTarget !== undefined &&
      moved.ref.id === sourceTarget.id &&
      moved.selection.startRow === source.startRow &&
      moved.selection.startCol === source.startCol &&
      moved.selection.endRow === source.endRow &&
      moved.selection.endCol === source.endCol;
    if (restatesSource) return;
    void applyFormatToTarget(moved.selection);
  });
  addCleanup(unsubTarget);

  // 6. Register edit guard to block editing while painter is active
  const unsubEditGuard = registerEditGuard(async () => {
    if (isFormatPainterActive()) {
      return { blocked: true, message: "Format Painter is active. Click a cell to apply formatting." };
    }
    return null;
  });
  addCleanup(unsubEditGuard);

  restoreFocusToGrid();
}

/**
 * Deactivate the Format Painter tool. A painter still STARTING (reading its
 * source) has nothing to tear down yet: its start is cancelled, and it never
 * arms.
 */
export function deactivateFormatPainter(): void {
  if (!isFormatPainterActive()) {
    cancelFormatPainterStart();
    return;
  }

  console.log("[FormatPainter] Deactivating");

  // 1. Restore cursor
  clearCursorOverride();

  // 2. Clear marching ants
  dispatchGridAction(clearClipboard());

  // 3. Unregister all listeners and guards
  runAllCleanups();

  // 4. Reset state
  clearFormatPainterState();

  // 5. Restore focus
  restoreFocusToGrid();
}
