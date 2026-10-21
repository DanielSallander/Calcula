//! FILENAME: app/extensions/Pivot/lib/pivotCanvasCellKeys.ts
// PURPOSE: The keyboard of a canvas pivot box's CELLS (D-CELLS, owner finding
//          F4). With cells selected in the selected box:
//            - ArrowUp/Down/Left/Right move the active cell (the selection
//              collapses onto it); Shift+arrows move the selection's far
//              corner. Hidden rows (a collapsed group's, a filtered row's) are
//              skipped, the edges clamp, and the box's body scrolls so the
//              cell the key moved to stays in sight;
//            - Escape clears the cells and keeps the box selected (a second
//              Escape is the canvas's own: it deselects the box);
//            - Delete, Backspace, Ctrl+X, Shift+Delete, Ctrl+V, Shift+Insert
//              and Ctrl+D REFUSE with the pivot's one sentence -- a pivot's
//              cells are not edited, and Delete must NEVER reach the generic
//              object Delete, which deletes the whole PivotTable;
//          and with the box selected (cells or not), Ctrl+A selects its whole
//          content. Tab is left alone: it keeps cycling the canvas's objects.
// CONTEXT: Registry bindings with a `when` guard (CanvasSheet's objectNudge /
//          objectCycling precedent), so they win only while they apply, and a
//          guard that says no leaves the key to the binding underneath. The
//          Pivot extension activates BEFORE the canvas and the generic object
//          keys (extensions/manifest.ts), so these win a tie by registration
//          order; the box's object-selection provider ALSO claims Arrow,
//          Escape, Clipboard and Delete while cells are selected
//          (pivotVisualSelection.ts `ownsKey`), so the canvas's nudge, Escape
//          and object clipboard and the generic object Delete stand down by
//          their own guards whatever the order.
//
//          `context: "not-editing"`: while an edit is open -- Core's own, or an
//          EXTERNAL one such as a floating grid's cell edit -- the dispatcher
//          skips these bindings and the keys belong to the edit.
//
//          Navigation and Escape also stand down while the box's right-click
//          menu is open or one of its presses is held (a +/- press, a cell
//          drag): the menu's own listener takes the arrows and Escape, and
//          Escape during a cell drag ends the drag and KEEPS the cells
//          (pivotCellPress.ts). The REFUSALS do not stand down then: a refused
//          Delete is harmless, and without it the key would fall through to
//          the grid.
//
//          Copy (Ctrl+C, Ctrl+Insert, and the Home/Edit Copy doors through the
//          provider's `innerClipboardCommand`) copies the selected cells from
//          the canvas's HIDDEN GRID with Core's own copy primitive
//          (`copyCellRange`, @api/cellClipboard), so Paste, Paste Special and
//          Paste Link read the same internal clipboard a worksheet Copy fills.
//          Rows the box hides (a collapsed group's, a filtered row's) are left
//          out, the block reads in batches, and it is capped at 200,000 cells.
//          Nothing here writes to the document: the selection, the scroll and
//          the clipboard are not document state.
//
//          A FILTERED box (P4 S7, pivotCrossFilterView.ts) shows a transient
//          view another visual's selection filters; its cells are NOT the
//          hidden grid's. The arrows then walk the grid it shows, and Copy
//          copies what it shows -- the cells' display text, tab-separated --
//          to the system clipboard (never the hidden grid's real cells).

import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused, hasDomTextSelection } from "@api/keybindings";
import { getGridStateSnapshot } from "@api/grid";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { showToast } from "@api/notifications";
import { copyCellRange } from "@api/cellClipboard";
import {
  clearPivotCellSelection,
  extendPivotCellSelection,
  getPivotCellSelection,
  pivotCellGridRange,
  pivotCellRect,
  setPivotCellAnchor,
  setPivotCellSelection,
} from "./pivotVisualCellSelection";
import { stepPivotCell, type PivotCellStep } from "./pivotCellNavigation";
import { ensurePivotCellVisible } from "./pivotVisualScroll";
import { getPivotVisualRecord } from "./pivotVisualHits";
import { isPivotBoxMenuOpen, isPivotCellPressHeld, isPivotChromePressLive } from "./pivotVisualMenuState";
import { getDisplayedPivotView, isShowingFilteredView } from "./pivotCrossFilterView";
import { getPivotViewRow } from "./pivotChromeActions";
import { isViewRowVisible, viewColCount, viewRowCount } from "../rendering/pivotVisualRenderer";
import { getCachedRegions, getSelectedVisualPivotId } from "../handlers/selectionHandler";
import {
  PIVOT_CANVAS_CLEAR_CELLS_COMMAND,
  PIVOT_CANVAS_COPY_CELLS_COMMAND,
  PIVOT_CANVAS_REFUSE_EDIT_COMMAND,
  PIVOT_CANVAS_SELECT_ALL_COMMAND,
  PIVOT_EDIT_REFUSAL,
  pivotCanvasMoveCommand,
} from "./pivotCanvasCellCommands";

// ============================================================================
// Guards
// ============================================================================

function onCanvas(): boolean {
  return getGridStateSnapshot()?.surface === "canvas";
}

/** A box menu is open or a box press is held: its own listeners own the keys. */
function boxGestureLive(): boolean {
  return isPivotBoxMenuOpen() || isPivotChromePressLive() || isPivotCellPressHeld();
}

/**
 * Cells are selected in the SELECTED box on a canvas. The commands re-check
 * this at run time (the palette, a script, a door may run them anywhere).
 */
function cellSelectionLive(): boolean {
  if (!onCanvas()) return false;
  const sel = getPivotCellSelection();
  return sel !== null && getSelectedVisualPivotId() === sel.pivotId;
}

/**
 * Whether the cell keys (arrows, Shift+arrows, Escape) apply right now: on a
 * canvas, the grid has the keyboard, the selected box has cells selected, and
 * no box menu or box press owns the keys.
 */
export function canvasCellKeysApply(): boolean {
  return cellSelectionLive() && isGridFocused() && !boxGestureLive();
}

/**
 * Whether the REFUSAL keys apply: as `canvasCellKeysApply`, but also while a
 * box menu is open or a press is held -- a refusal acts on nothing, and the
 * key must not fall through to the grid or to the generic object Delete.
 */
export function canvasCellEditKeysApply(): boolean {
  return cellSelectionLive() && isGridFocused();
}

/**
 * Whether Ctrl+A selects the selected box's content: on a canvas, the grid
 * has the keyboard, a pivot box is selected (cells or not), and no box menu
 * or press owns the keys.
 */
export function canvasSelectAllApplies(): boolean {
  return onCanvas() && isGridFocused() && getSelectedVisualPivotId() !== null && !boxGestureLive();
}

/**
 * Whether Ctrl+C / Ctrl+Insert copy the selected cells: cells are selected in
 * the selected box on a canvas and the grid has the keyboard -- the REFUSAL
 * keys' guard, which a box menu or a held press does not stand down: a copy
 * behind the open menu copies the same cells, where standing down would hand
 * the key to Core's Copy of a selection the canvas does not show -- and the
 * browser holds no real text selection, which a copy always yields to (the
 * dispatcher's own rule for Core's Copy).
 */
export function canvasCellCopyApplies(): boolean {
  return canvasCellEditKeysApply() && !hasDomTextSelection();
}

// ============================================================================
// The actions
// ============================================================================

/** What an arrow step needs of a box: its size and which rows are hidden. */
interface NavigationShape {
  rowCount: number;
  colCount: number;
  rowHeights: number[];
}

/**
 * The box's navigation shape: the geometry it was last painted with, or --
 * when it has not been painted (off screen) -- one derived from its cached
 * view (a hidden row is height 0 either way). Null without either.
 */
function navigationShapeOf(pivotId: string): NavigationShape | null {
  const g = getPivotVisualRecord(pivotId)?.geometry;
  if (g) return { rowCount: g.rowCount, colCount: g.colCount, rowHeights: g.rowHeights };
  const view = getDisplayedPivotView(pivotId);
  if (!view) return null;
  const rowCount = viewRowCount(view);
  const rowHeights = new Array<number>(rowCount);
  for (let i = 0; i < rowCount; i++) rowHeights[i] = isViewRowVisible(view, i) ? 1 : 0;
  return { rowCount, colCount: viewColCount(view), rowHeights };
}

/**
 * One arrow step: `extend` moves the selection's far corner (Shift+arrow),
 * otherwise the active cell moves and the selection collapses onto it. The
 * box's body scrolls to keep the cell the key reached in sight.
 */
export function movePivotCanvasCells(dir: PivotCellStep, extend: boolean): void {
  if (!cellSelectionLive()) return;
  const sel = getPivotCellSelection();
  if (!sel) return;
  const shape = navigationShapeOf(sel.pivotId);
  if (!shape || shape.rowCount <= 0 || shape.colCount <= 0) return;
  if (extend) {
    const to = stepPivotCell(shape, sel.endRow, sel.endCol, dir);
    extendPivotCellSelection(to.row, to.col);
    ensurePivotCellVisible(sel.pivotId, to.row, to.col);
  } else {
    const to = stepPivotCell(shape, sel.anchorRow, sel.anchorCol, dir);
    setPivotCellAnchor(sel.pivotId, to.row, to.col);
    ensurePivotCellVisible(sel.pivotId, to.row, to.col);
  }
  // A step at an edge changes no selection but may still have scrolled.
  requestOverlayRedraw();
}

/**
 * Ctrl+A: the selected box's whole content -- from its first shown row and
 * column to its last shown row and last column (the active cell is the top
 * left). Nothing without a box or a view.
 */
export function selectAllPivotCanvasCells(): void {
  if (!onCanvas()) return;
  const pivotId = getSelectedVisualPivotId();
  if (pivotId === null) return;
  const shape = navigationShapeOf(pivotId);
  if (!shape || shape.rowCount <= 0 || shape.colCount <= 0) return;
  let first = -1;
  let last = -1;
  for (let i = 0; i < shape.rowCount; i++) {
    if ((shape.rowHeights[i] ?? 0) > 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return; // every row hidden: nothing to select
  setPivotCellSelection({ pivotId, anchorRow: first, anchorCol: 0, endRow: last, endCol: shape.colCount - 1 });
  requestOverlayRedraw();
}

/** Escape: clear the cells; the box stays selected. */
export function clearPivotCanvasCells(): void {
  if (!cellSelectionLive()) return;
  clearPivotCellSelection();
}

/** An edit of the selected cells: refused, with the pivot's one sentence. */
export function refusePivotCanvasCellEdit(): void {
  if (!cellSelectionLive()) return;
  showToast(PIVOT_EDIT_REFUSAL, { variant: "info" });
}

/** The most cells one copy of a box's cells reads (review: Risk 7, J15). */
export const PIVOT_CANVAS_COPY_MAX_CELLS = 200_000;

/** What the user is told when the selected block is over the cap. */
export const PIVOT_CANVAS_COPY_TOO_LARGE = "That selection is too large to copy (more than 200,000 cells).";

/**
 * Copy the selected cells (Ctrl+C, Ctrl+Insert, Home > Copy, Edit > Copy).
 * The box's view cells live in the canvas's HIDDEN GRID at the pivot's anchor
 * (`region.startRow + viewRow`, `region.startCol + viewCol`), so the copy is
 * Core's own copy of that grid rectangle: the same internal and system
 * clipboard a worksheet Copy fills, values and styles as the grid holds them.
 * Rows the box does not show (height 0: a collapsed group's, a filtered
 * row's) are left out and the block closes up, as a filtered worksheet copy
 * does. Every refusal is told; the clipboard that was there stays.
 */
export async function copyPivotCanvasCells(): Promise<void> {
  if (!cellSelectionLive()) return;
  const sel = getPivotCellSelection();
  if (!sel) return;
  // The pivot's region on the active canvas: its anchor places the cells.
  const region = getCachedRegions().find((r) => r.pivotId === sel.pivotId && r.canvasFrame != null);
  if (!region || !Number.isInteger(region.startRow) || !Number.isInteger(region.startCol)) {
    showToast("Copy failed: the PivotTable is not on this page.", { variant: "error" });
    return;
  }
  if (isShowingFilteredView(sel.pivotId)) {
    await copyShownPivotCells(sel.pivotId);
    return;
  }
  const view = pivotCellRect(sel);
  const grid = pivotCellGridRange(sel, region.startRow, region.startCol);
  const skipRows = new Set<number>();
  const shape = navigationShapeOf(sel.pivotId);
  if (shape) {
    for (let r = view.startRow; r <= view.endRow; r++) {
      if (r < shape.rowHeights.length && shape.rowHeights[r] === 0) skipRows.add(region.startRow + r);
    }
  }
  let result: Awaited<ReturnType<typeof copyCellRange>>;
  try {
    result = await copyCellRange({
      startRow: grid.startRow,
      startCol: grid.startCol,
      endRow: grid.endRow,
      endCol: grid.endCol,
      skipRows,
      batchRead: true,
      maxCells: PIVOT_CANVAS_COPY_MAX_CELLS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showToast(`Copy failed: ${message}`, { variant: "error" });
    return;
  }
  if (result.copied) return;
  switch (result.reason) {
    case "tooLarge":
      showToast(PIVOT_CANVAS_COPY_TOO_LARGE, { variant: "warning" });
      return;
    case "empty":
      showToast("There is nothing to copy: every selected row is hidden.", { variant: "info" });
      return;
    default:
      showToast("Copy failed: the PivotTable's cells could not be read or put on the clipboard.", {
        variant: "error",
      });
  }
}

/**
 * Copy what a FILTERED box shows (P4 S7): the selected rectangle of its
 * displayed view, each cell's display text, tab-separated, rows the box hides
 * left out, put on the system clipboard as text. The hidden grid holds the
 * REAL pivot's cells, which are not what the user sees.
 */
export async function copyShownPivotCells(pivotId: string): Promise<void> {
  const sel = getPivotCellSelection();
  const shown = getDisplayedPivotView(pivotId);
  if (!sel || sel.pivotId !== pivotId || !shown) return;
  const rect = pivotCellRect(sel);
  const cells = (rect.endRow - rect.startRow + 1) * (rect.endCol - rect.startCol + 1);
  if (cells > PIVOT_CANVAS_COPY_MAX_CELLS) {
    showToast(PIVOT_CANVAS_COPY_TOO_LARGE, { variant: "warning" });
    return;
  }
  const shape = navigationShapeOf(pivotId);
  const lines: string[] = [];
  for (let r = rect.startRow; r <= rect.endRow; r++) {
    if (shape && r < shape.rowHeights.length && shape.rowHeights[r] === 0) continue;
    const row = getPivotViewRow(pivotId, shown, r);
    const texts: string[] = [];
    for (let c = rect.startCol; c <= rect.endCol; c++) {
      const cell = row?.cells[c];
      const text = cell ? (cell.formattedValue ?? (cell.value == null ? "" : String(cell.value))) : "";
      texts.push(text.replace(/[\t\r\n]+/g, " "));
    }
    lines.push(texts.join("\t"));
  }
  if (lines.length === 0) {
    showToast("There is nothing to copy: every selected row is hidden.", { variant: "info" });
    return;
  }
  try {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) throw new Error("the clipboard is not available");
    await clipboard.writeText(lines.join("\r\n"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showToast(`Copy failed: ${message}`, { variant: "error" });
  }
}

// ============================================================================
// Commands and bindings
// ============================================================================

const DIRECTIONS: ReadonlyArray<{ dir: PivotCellStep; key: string; name: string }> = [
  { dir: "left", key: "ArrowLeft", name: "Left" },
  { dir: "right", key: "ArrowRight", name: "Right" },
  { dir: "up", key: "ArrowUp", name: "Up" },
  { dir: "down", key: "ArrowDown", name: "Down" },
];

/** The refused combos, each with its binding slug. */
export const PIVOT_CANVAS_REFUSED_KEYS: ReadonlyArray<{ combo: string; slug: string; label: string }> = [
  { combo: "Delete", slug: "refuseDelete", label: "Refuse Delete in PivotTable Cells" },
  { combo: "Backspace", slug: "refuseBackspace", label: "Refuse Backspace in PivotTable Cells" },
  { combo: "Ctrl+X", slug: "refuseCut", label: "Refuse Cut in PivotTable Cells" },
  { combo: "Shift+Delete", slug: "refuseShiftDelete", label: "Refuse Cut (Shift+Delete) in PivotTable Cells" },
  { combo: "Ctrl+V", slug: "refusePaste", label: "Refuse Paste in PivotTable Cells" },
  { combo: "Shift+Insert", slug: "refuseShiftInsert", label: "Refuse Paste (Shift+Insert) in PivotTable Cells" },
  { combo: "Ctrl+D", slug: "refuseFillDown", label: "Refuse Fill Down in PivotTable Cells" },
];

/** The copy combos, each with its binding slug. */
export const PIVOT_CANVAS_COPY_KEYS: ReadonlyArray<{ combo: string; slug: string; label: string }> = [
  { combo: "Ctrl+C", slug: "copy", label: "Copy PivotTable Cells" },
  { combo: "Ctrl+Insert", slug: "copyInsert", label: "Copy PivotTable Cells (Ctrl+Insert)" },
];

/** The binding id of a slug (`ext.pivot.canvasCells.<slug>`). */
export function pivotCanvasCellBindingId(slug: string): string {
  return `ext.pivot.canvasCells.${slug}`;
}

/** Register the cell commands and their guarded bindings; returns the cleanups. */
export function installPivotCanvasCellKeys(extensionId: string): Array<() => void> {
  const cleanups: Array<() => void> = [];

  const command = (id: string, run: () => void | Promise<void>): void => {
    CommandRegistry.register(id, run);
    cleanups.push(() => CommandRegistry.unregister(id));
  };
  const bind = (slug: string, combo: string, commandId: string, label: string, when: () => boolean): void => {
    cleanups.push(
      registerKeybinding(
        {
          id: pivotCanvasCellBindingId(slug),
          combo,
          commandId,
          label,
          category: "PivotTable",
          context: "not-editing",
          source: "extension",
          extensionId,
        },
        when,
      ),
    );
  };

  for (const { dir, key, name } of DIRECTIONS) {
    for (const extend of [false, true]) {
      const id = pivotCanvasMoveCommand(dir, extend);
      command(id, () => movePivotCanvasCells(dir, extend));
      bind(
        `${extend ? "extend" : "move"}${name}`,
        extend ? `Shift+${key}` : key,
        id,
        extend ? `Extend PivotTable Cell Selection ${name}` : `Move PivotTable Cell ${name}`,
        canvasCellKeysApply,
      );
    }
  }

  command(PIVOT_CANVAS_CLEAR_CELLS_COMMAND, clearPivotCanvasCells);
  bind("clear", "Escape", PIVOT_CANVAS_CLEAR_CELLS_COMMAND, "Clear PivotTable Cell Selection", canvasCellKeysApply);

  command(PIVOT_CANVAS_SELECT_ALL_COMMAND, selectAllPivotCanvasCells);
  bind("selectAll", "Ctrl+A", PIVOT_CANVAS_SELECT_ALL_COMMAND, "Select All PivotTable Cells", canvasSelectAllApplies);

  command(PIVOT_CANVAS_REFUSE_EDIT_COMMAND, refusePivotCanvasCellEdit);
  for (const { combo, slug, label } of PIVOT_CANVAS_REFUSED_KEYS) {
    bind(slug, combo, PIVOT_CANVAS_REFUSE_EDIT_COMMAND, label, canvasCellEditKeysApply);
  }

  // The copy catches its own failures (every one is told), so a key or a door
  // that awaits it never sees a rejection.
  command(PIVOT_CANVAS_COPY_CELLS_COMMAND, copyPivotCanvasCells);
  for (const { combo, slug, label } of PIVOT_CANVAS_COPY_KEYS) {
    bind(slug, combo, PIVOT_CANVAS_COPY_CELLS_COMMAND, label, canvasCellCopyApplies);
  }

  return cleanups;
}
