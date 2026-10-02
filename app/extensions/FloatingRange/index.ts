//! FILENAME: app/extensions/FloatingRange/index.ts
// PURPOSE: Floating Range extension — a shape-like object whose content is a
//          REAL range of cells (hidden backing sheet), referenced like a sheet
//          (=Float1!A1). Registers the overlay, the floatingObject:* handlers,
//          the capture-phase keyboard, Insert/context menus, the properties
//          dialog, the @api/floatingRangeService provider, the overflow-scroll
//          wheel target (M7: content past the window scrolls; lib/frView.ts),
//          the formula bar / Name Box view of the selected cell and its edit
//          (lib/frFormulaBar.ts over @api/externalEdit: one edit session, two
//          views, surviving a point-mode sheet switch), and the document
//          lifecycle (open/new/sheet-switch/undo re-sync).
// CONTEXT: Store per Charts/lib/chartStore.ts; interaction per Controls; cell
//          paint per shapeRenderer's async cache. Overlay priority 13 — above
//          Controls (12), below Charts (15).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  AppEvents,
  emitAppEvent,
  showToast,
  showDialog,
  showOverlay,
  registerFloatingRangeProvider,
  registerGridLayer,
  type CellValuesChangedPayload,
  isKeyClaimed,
} from "@api";
import { getActiveSheet } from "@api/lib";
import {
  getGridRegions,
  requestOverlayRedraw,
  topFloatingRegionAt,
  isPointModeOnForeignSheet,
  type OverlayHitTestContext,
  type OverlayZone,
} from "@api/gridOverlays";
import {
  endExternalFormulaSession,
  getParkedViewSheetIndex,
  isExternalSessionParked,
  registerExternalAddressResolver,
  isTypedCharacterKey,
  returnParkedViewToHost,
} from "@api/externalEdit";
import { confirmAsync, promptAsync } from "@api/dialogs";
import { registerCellClickInterceptor, onGridCellPressed } from "@api/cellClickInterceptors";
import { getLayoutSurface } from "@api/layoutSurface";
import { getGridStateSnapshot } from "@api/grid";
import { registerObjectWheelTarget } from "../_shared/lib/objectWheelScroll";
import {
  isGlobalFormulaMode,
  getGlobalIsEditing,
  insertTextIntoActiveFormula,
  getExternalFormulaTarget,
} from "@api/editing";
import {
  createFloatingRange,
  updateFloatingRange,
  updateFloatingRangeCell,
  renameFloatingRange,
  deleteFloatingRange,
  FLOATING_RANGE_MAX_ROWS,
  FLOATING_RANGE_MAX_COLS,
  FLOATING_RANGE_MIN_COL_W,
  FLOATING_RANGE_MAX_COL_W,
  FLOATING_RANGE_MIN_ROW_H,
  FLOATING_RANGE_MAX_ROW_H,
  type FloatingRangeInfo,
} from "@api/floatingRanges";
import {
  FLOATING_RANGE_REGION_TYPE,
  loadFloatingRangesFromBackend,
  resetFloatingRangeStore,
  getAllFloatingRanges,
  getFloatingRangeById,
  upsertFromInfo,
  removeFloatingRange,
  toInfo,
  setFrActiveSheetIndex,
  getFrActiveSheetIndex,
  syncFloatingRangeRegions,
  flushPendingFloatingRangeSaves,
  frGeometryEditable,
  frObjectEditable,
  installFrRegionResyncs,
  type FloatingRangeEntry,
} from "./lib/floatingRangeStore";
import {
  frameCanvasBounds,
  clientToCanvas,
  frameAtCanvasPoint,
} from "./lib/frCanvasGeometry";
import { getFrView, ensureFrCellVisible, createFrWheelTarget } from "./lib/frView";
import { createFrAutoScroller, frAutoScrollStep } from "./lib/frDragAutoScroll";
import { installFrMovePersistence } from "./lib/frMove";
import { pruneFrScrolls } from "./lib/frScroll";
import { invalidateAllFrExtents } from "./lib/frExtent";
import { readFrCells } from "./lib/frCellReads";
import {
  localCellFromPoint,
  frameWidth,
  frameHeight,
  frameSizeForCounts,
  bestCountsForSize,
  frRowHdrW,
  frCellsTop,
  contentWidth,
  contentHeight,
  frEdgeHandleAt,
  frBorderGrabAt,
  fitCountsWithin,
  maxScaleWithin,
  edgeAxis,
  edgeMovesOrigin,
  clampScaleFactor,
  scaledColWidths,
  scaledRowHeights,
  trackedColIndices,
  trackedRowIndices,
  frColWidth,
  frRowHeight,
  type FrEdge,
} from "./lib/frDimensions";
import {
  selectFloatingRange,
  deselectAllFloatingRanges,
  getSelectedFloatingRange,
  getLocalSelection,
  setLocalSelection,
  clearLocalSelection,
  extendLocalSelection,
  localSelectionRect,
  moveLocalSelection,
  resetFrSelection,
} from "./lib/frSelection";
import {
  installFrFormulaBarPublisher,
  createFrAddressResolver,
  refreshFrFormulaBarContent,
} from "./lib/frFormulaBar";
import {
  renderFloatingRange,
  hitTestFloatingRange,
  paintFrEdgeBalls,
  FR_EDGE_BALL_LAYER_ID,
  invalidateFrCache,
  invalidateAllFrCaches,
  removeFrFromCache,
  resetFrRenderCaches,
  setFrResizeGhost,
  frHandlesLive,
} from "./rendering/frRenderer";
import {
  openFrEditor,
  cancelFrEditor,
  commitFrEditor,
  getFrEditorCell,
  isFrEditorOpen,
  destroyFrEditor,
} from "./editor/frEditor";
import { buildQualifiedRef } from "./lib/frRefs";
import {
  installFrKeyRouting,
  frOwnsGridKeys,
  handOverToWholeSelectionDelete,
} from "./lib/frKeyRouting";
import { registerFloatingRangeObjectSelection, frIdOf } from "./lib/frObjectSelection";
import { registerObjectGeometryProvider } from "@api/objectGeometry";
import { createFloatingRangeGeometryProvider } from "./lib/frGeometry";
import {
  buildFrContextMenu,
  isFrContextMenuOpen,
  type FrContextMenuHandlers,
} from "./lib/frContextMenu";
import { FloatingRangePropertiesDialog } from "./components/FloatingRangePropertiesDialog";
import { FloatingRangeContextMenu } from "./components/FloatingRangeContextMenu";

// ============================================================================
// State
// ============================================================================

const cleanupFns: (() => void)[] = [];

const FR_PROPERTIES_DIALOG_ID = "floatingRange.properties";
const FR_CONTEXT_MENU_ID = "floatingRange:contextMenu";

/** Active drag teardown — cell drag-extend OR edge resize (also run on
 *  deactivate). One slot, because the two can never be live at once. */
let activeDragCleanup: (() => void) | null = null;

/** Pointer travel (px) below which a press on an edge ball is a CLICK, not a
 *  drag -- Core's own move threshold (overlayMoveHandlers.ts). */
const EDGE_DRAG_THRESHOLD_PX = 3;

// ============================================================================
// Geometry helpers
// ============================================================================
//
// Where the frame is on the canvas (frameCanvasBounds / clientToCanvas /
// frameAtCanvasPoint) lives in lib/frCanvasGeometry.ts, with the gutters Core
// PAINTED -- on a canvas sheet they are 0 whatever the stored config says.
// Which CELL a point is over is always asked through the live view
// (lib/frView.ts), so a scrolled range answers the scrolled cell.

/** Clamp a frame-relative point into the cells area and resolve its cell, at
 *  the range's current scroll. */
function clampedCellFromFramePoint(
  entry: FloatingRangeEntry,
  dx: number,
  dy: number,
): { row: number; col: number } {
  const minX = frRowHdrW(entry);
  const minY = frCellsTop(entry);
  const cx = Math.min(Math.max(dx, minX), frameWidth(entry) - 0.01);
  const cy = Math.min(Math.max(dy, minY), frameHeight(entry) - 0.01);
  const hit = localCellFromPoint(entry, cx, cy, getFrView(entry));
  if (hit.zone === "cells") return { row: hit.row, col: hit.col };
  return { row: 0, col: 0 };
}

function externalTargetExpecting(): boolean {
  return getExternalFormulaTarget()?.isExpectingReference() === true;
}

/**
 * A press on a WORKSHEET grid cell ends this extension's selection (listeners
 * 8a and 8c in activate()): the object and its cell are deselected, so the
 * formula bar and the Name Box stop naming the floating cell. Never on a
 * canvas (no cells; its background press is the marquee's, where Shift/Ctrl
 * ADD to the selection), and never while this range's edit picks a reference
 * or is parked on another sheet (the press FEEDS the edit).
 */
function leaveForGridCellPress(): void {
  if (getGridStateSnapshot()?.surface === "canvas") return;
  if (isFrEditorOpen() && (externalTargetExpecting() || isExternalSessionParked())) return;
  if (isFrEditorOpen()) void commitFrEditor(null);
  if (getLocalSelection() !== null || getSelectedFloatingRange() !== null) {
    deselectAllFloatingRanges();
    clearLocalSelection();
    requestOverlayRedraw();
  }
}

/**
 * COMMIT BEFORE SELECT — the FR's own `onCommitBeforeSelect`.
 *
 * Core `preventDefault()`s the mousedown for every floating-overlay body hit
 * (`overlayMoveHandlers.ts`), which cancels the browser's focus transfer: the
 * editor's textarea NEVER blurs, so `frEditor.handleBlur` — the only other
 * commit-on-click-away path — is unreachable for any click that starts inside
 * the grid. Without this the old cell stays in edit mode while the selection
 * walks off to the clicked one (the reported glitch). The main grid does not
 * rely on blur either; it awaits an explicit commit inside the mousedown
 * (`cellSelectionHandlers.ts`), and this is the same move.
 *
 * `target` is the cell the click resolved to, or null for a click that is not
 * on a cell at all (title bar, row/column header). A click on the cell being
 * edited is NOT a commit — that is the user placing the caret inside their own
 * editor.
 */
function commitFrEditorBeforeSelect(
  frId: string,
  target: { row: number; col: number } | null,
): void {
  const editing = getFrEditorCell();
  if (!editing) return;
  if (
    target &&
    editing.frId === frId &&
    editing.row === target.row &&
    editing.col === target.col
  ) {
    return;
  }
  // Fire-and-forget is correct: commitFrEditor tears the editor down
  // SYNCHRONOUSLY before its first await, so the selection written on the next
  // line already sees a closed editor.
  void commitFrEditor(null);
}

// ============================================================================
// Mutating operations (shared by keyboard / menus / provider)
// ============================================================================

/**
 * Refuse a SIZE change the range's editability forbids (`frGeometryEditable`,
 * the one answer): a range on a subscribed canvas, or one its canvas locks.
 * Every geometry door funnels through `resizeFr` / `resizeFrCells`, so the
 * menu, the Properties dialog's path, a script's `resize` and the gestures
 * cannot disagree about it. The message names the reason and the remedy.
 */
function assertGeometryEditable(frId: string): void {
  if (frGeometryEditable(frId)) return;
  const entry = getFloatingRangeById(frId);
  if (!entry) throw new Error(`No floating range with id ${frId}`);
  const name = `"${entry.name}"`;
  throw new Error(
    frObjectEditable(frId)
      ? `The floating range ${name} is locked on this canvas; unlock it to change its size.`
      : `The floating range ${name} is on a canvas subscribed from an application, which is read-only until it is detached.`,
  );
}

/** Tell the user a size change did not happen (menu doors are fire-and-forget). */
function reportGeometryFailure(err: unknown): void {
  console.error("[FloatingRange] Resize failed:", err);
  showToast(
    `The floating range could not be resized: ${err instanceof Error ? err.message : String(err)}`,
    { type: "error" },
  );
}

/**
 * Change the window's row/column counts (and, for a corner drag, the origin).
 * The door the menu, the corner count-resize and the script provider's
 * `resize` share -- so the geometry refusal is here, once. Exported for the
 * unit tier.
 */
export async function resizeFr(
  frId: string,
  rows: number,
  cols: number,
  x?: number,
  y?: number,
): Promise<FloatingRangeInfo> {
  assertGeometryEditable(frId);
  const patch: { rowCount: number; colCount: number; x?: number; y?: number } = {
    rowCount: Math.max(1, Math.min(FLOATING_RANGE_MAX_ROWS, Math.trunc(rows))),
    colCount: Math.max(1, Math.min(FLOATING_RANGE_MAX_COLS, Math.trunc(cols))),
  };
  if (x !== undefined) patch.x = x;
  if (y !== undefined) patch.y = y;
  const info = await updateFloatingRange(frId, patch);
  upsertFromInfo(info);
  // The visible window changed — a regrown row's cells must be re-fetched.
  invalidateFrCache(frId);
  syncFloatingRangeRegions();
  requestOverlayRedraw();
  emitAppEvent(AppEvents.GRID_REFRESH);
  return info;
}

/**
 * Persist a cell-size scale (the edge-handle drag's ONE write). Geometry rides
 * along because dragging the left or top edge keeps the OPPOSITE edge fixed,
 * which moves the frame's origin — sending it separately would be two undo
 * steps for one gesture.
 */
async function resizeFrCells(
  frId: string,
  colWidths: Record<number, number>,
  rowHeights: Record<number, number>,
  x: number,
  y: number,
): Promise<FloatingRangeInfo> {
  assertGeometryEditable(frId);
  const info = await updateFloatingRange(frId, { colWidths, rowHeights, x, y });
  upsertFromInfo(info);
  syncFloatingRangeRegions();
  requestOverlayRedraw();
  emitAppEvent(AppEvents.GRID_REFRESH);
  return info;
}

async function renameFr(frId: string, name: string): Promise<FloatingRangeInfo> {
  const info = await renameFloatingRange(frId, name);
  upsertFromInfo(info);
  syncFloatingRangeRegions();
  requestOverlayRedraw();
  emitAppEvent(AppEvents.GRID_REFRESH);
  return info;
}

async function deleteFrObject(frId: string): Promise<void> {
  await deleteFloatingRange(frId);
  // An edit of one of its cells is DISCARDED, before the selection clear
  // below: that clear would otherwise commit it into the deleted range (an
  // edit never outlives its cell's selection, lib/frFormulaBar.ts).
  if (getFrEditorCell()?.frId === frId) cancelFrEditor();
  removeFloatingRange(frId);
  removeFrFromCache(frId);
  const sel = getLocalSelection();
  if (sel?.frId === frId) clearLocalSelection();
  if (getSelectedFloatingRange() === frId) deselectAllFloatingRanges();
  syncFloatingRangeRegions();
  requestOverlayRedraw();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/** Delete the OBJECT — confirmed first, because delete ends the undo history. */
async function confirmAndDeleteFr(frId: string): Promise<void> {
  const entry = getFloatingRangeById(frId);
  if (!entry) return;
  const ok = await confirmAsync(
    `Delete floating range "${entry.name}"?\n\n` +
      `Formulas that reference it will show #REF!, and the undo history will be cleared.`,
    { title: "Delete Floating Range" },
  );
  if (!ok) return;
  try {
    await deleteFrObject(frId);
  } catch (err) {
    showToast(
      `The floating range could not be deleted: ${err instanceof Error ? err.message : String(err)}`,
      { type: "error" },
    );
  }
}

/**
 * Delete SEVERAL ranges for a canvas-wide Delete (@api/objectSelection
 * `deleteSelectedObjects`, through the provider's `deleteObjects`): ONE
 * confirmation naming every range -- a delete ends the undo history, and the
 * user must hear that once, not once per range -- then each delete in turn.
 * Resolves when every delete has LANDED. REJECTS when the user declines (all
 * of them stay) or the backend refuses one (the refused ones stay; the seam
 * names what is still standing, so a partial success is reported correctly).
 * Exported for the unit tier.
 */
export async function deleteFrObjectsConfirmed(frIds: readonly string[]): Promise<void> {
  const entries = frIds
    .map((id) => getFloatingRangeById(id))
    .filter((e): e is FloatingRangeEntry => !!e);
  if (entries.length === 0) return;
  const names = entries.map((e) => `"${e.name}"`).join(", ");
  const ok = await confirmAsync(
    (entries.length === 1
      ? `Delete floating range ${names}?`
      : `Delete ${entries.length} floating ranges (${names})?`) +
      `\n\nFormulas that reference ${entries.length === 1 ? "it" : "them"} will show #REF!, ` +
      `and the undo history will be cleared.`,
    { title: entries.length === 1 ? "Delete Floating Range" : "Delete Floating Ranges" },
  );
  if (!ok) {
    throw new Error(
      entries.length === 1
        ? "Deleting the floating range was cancelled."
        : "Deleting the floating ranges was cancelled.",
    );
  }
  const reasons: string[] = [];
  for (const entry of entries) {
    try {
      await deleteFrObject(entry.id);
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (reasons.length > 0) {
    throw new Error(`The floating range could not be deleted: ${Array.from(new Set(reasons)).join(" ")}`);
  }
}

/**
 * Clear the CONTENT of the local selection (only cells that actually hold
 * something — the read bounds the write batch). Undoable per cell.
 *
 * The selection is clamped to the CONTENT extent (M7), not the window, so a
 * cleared cell can be one only scrolling shows. The read is banded (a whole
 * column over a 1000-row extent is past the backend's one-read limit), and a
 * cell the backend REFUSES does not stop the others: each is tried, and the
 * refusals are reported once, visibly -- a Delete that silently left cells
 * behind would look like it worked.
 */
async function clearLocalSelectionCells(frId: string): Promise<void> {
  const entry = getFloatingRangeById(frId);
  const sel = getLocalSelection();
  if (!entry || !sel || sel.frId !== frId) return;
  const view = getFrView(entry);
  const rect = localSelectionRect(sel);
  const maxRow = Math.min(rect.maxRow, view.rows - 1);
  const maxCol = Math.min(rect.maxCol, view.cols - 1);
  let failed = 0;
  let firstError: unknown = null;
  try {
    const cells = await readFrCells(frId, {
      startRow: rect.minRow,
      startCol: rect.minCol,
      endRow: maxRow,
      endCol: maxCol,
    });
    for (const cell of cells) {
      if (cell.type === "empty" && !cell.formula) continue;
      try {
        await updateFloatingRangeCell(frId, cell.row, cell.col, "");
      } catch (err) {
        failed++;
        if (firstError === null) firstError = err;
      }
    }
  } catch (err) {
    failed++;
    if (firstError === null) firstError = err;
  }
  if (failed > 0) {
    console.error("[FloatingRange] Clear cells failed:", firstError);
    const reason = firstError instanceof Error ? firstError.message : String(firstError);
    showToast(
      failed === 1
        ? `A cell could not be cleared: ${reason}`
        : `${failed} cells could not be cleared: ${reason}`,
      { type: "error" },
    );
  }
  invalidateFrCache(frId);
  requestOverlayRedraw();
}

async function createFrOnActiveSheet(
  req: { name?: string; x?: number; y?: number; rows?: number; cols?: number } = {},
): Promise<FloatingRangeEntry> {
  const state = getGridStateSnapshot();
  const scrollX = state?.viewport.scrollX ?? 0;
  const scrollY = state?.viewport.scrollY ?? 0;
  const existing = getAllFloatingRanges().filter(
    (e) => e.sheetIndex === getFrActiveSheetIndex(),
  ).length;
  // Viewport-visible position with a 24 px cascade per existing FR.
  const x = req.x ?? scrollX + 60 + 24 * existing;
  const y = req.y ?? scrollY + 40 + 24 * existing;

  let info = await createFloatingRange(x, y, req.name);
  const rows = req.rows ?? 1;
  const cols = req.cols ?? 1;
  if (rows > 1 || cols > 1) {
    info = await updateFloatingRange(info.id, {
      rowCount: Math.max(1, Math.min(FLOATING_RANGE_MAX_ROWS, Math.trunc(rows))),
      colCount: Math.max(1, Math.min(FLOATING_RANGE_MAX_COLS, Math.trunc(cols))),
    });
  }
  const entry = upsertFromInfo(info);
  syncFloatingRangeRegions();
  requestOverlayRedraw();
  emitAppEvent(AppEvents.GRID_REFRESH);
  return entry;
}

async function insertFloatingRangeFromMenu(): Promise<void> {
  // A canvas subscribed from an application is the publisher's read-only
  // layout: the Canvas tab's Insert group is disabled there, and the menu door
  // says why rather than asking the backend (which refuses the create too).
  if (getLayoutSurface(getFrActiveSheetIndex())?.editable === false) {
    showToast(
      "A floating range cannot be inserted on a canvas subscribed from an application: it is read-only until it is detached.",
      { type: "error" },
    );
    return;
  }
  try {
    const entry = await createFrOnActiveSheet();
    selectFloatingRange(entry.id);
    setLocalSelection({
      frId: entry.id,
      anchorRow: 0,
      anchorCol: 0,
      endRow: 0,
      endCol: 0,
    });
    requestOverlayRedraw();
  } catch (err) {
    showToast(
      `The floating range could not be created: ${err instanceof Error ? err.message : String(err)}`,
      { type: "error" },
    );
  }
}

// ============================================================================
// Edge-handle drag — scale the CELLS, leave the counts alone
// ============================================================================

/**
 * Start an edge-handle drag. The object is mutated LIVE (so the user sees the
 * real frame stretch, not a ghost of it) and written ONCE on mouseup, which is
 * what makes the whole gesture a single undo step.
 *
 * `syncFloatingRangeRegions()` has to run on every frame, not just at the end:
 * the published region's `floating.width/height` IS the hit box Core tests, so
 * a frame that grew without re-publishing would paint over pixels that still
 * belong to the grid — and the corner handles would sit at the old corners.
 */
function startEdgeResizeDrag(
  entry: FloatingRangeEntry,
  edge: FrEdge,
  startCanvasX: number,
  startCanvasY: number,
): void {
  const frId = entry.id;
  const axis = edgeAxis(edge);
  const movesOrigin = edgeMovesOrigin(edge);

  // Everything the scale is measured AGAINST is captured once, so a drag that
  // wanders back to where it started restores the original sizes exactly
  // rather than accumulating rounding on every mousemove.
  const baseWidths = { ...entry.colWidths };
  const baseHeights = { ...entry.rowHeights };
  const baseX = entry.x;
  const baseY = entry.y;
  const baseExtent = axis === "cols" ? contentWidth(entry) : contentHeight(entry);
  const baseFrameW = frameWidth(entry);
  const baseFrameH = frameHeight(entry);
  // Every column (row) the CONTENT reaches is scaled with the window's (E10):
  // a default-width column scrolled into view after the stretch used to keep
  // its old width beside the stretched ones.
  const extent = getFrView(entry);
  const baseSizes =
    axis === "cols"
      ? trackedColIndices(entry, extent.cols).map((c) => frColWidth(entry, c))
      : trackedRowIndices(entry, extent.rows).map((r) => frRowHeight(entry, r));
  const min = axis === "cols" ? FLOATING_RANGE_MIN_COL_W : FLOATING_RANGE_MIN_ROW_H;
  const max = axis === "cols" ? FLOATING_RANGE_MAX_COL_W : FLOATING_RANGE_MAX_ROW_H;

  if (baseExtent <= 0) return;

  // THE PAGE. Core keeps every dragged edge it moves on a canvas's page
  // (`applySurfaceToResize`), and this gesture is the FR's own, so it keeps
  // the same promise itself: the scale stops where the dragged edge meets the
  // page border, rather than overflowing it. A left/top edge moves the origin
  // with the opposite edge fixed, so its limit is the sheet origin -- on every
  // sheet kind, or the `Math.max(0, ...)` below would move the FIXED edge.
  const page = getLayoutSurface(entry.sheetIndex)?.page ?? null;
  const baseFrameExtent = axis === "cols" ? baseFrameW : baseFrameH;
  const maxFrameExtent = movesOrigin
    ? (axis === "cols" ? baseX : baseY) + baseFrameExtent
    : page
      ? (axis === "cols" ? page.width - baseX : page.height - baseY)
      : Infinity;
  // The rounding slack is for the sizes that MAKE the frame -- the window's
  // (contentWidth/contentHeight sum entry.cols/entry.rows) -- not every size
  // the scale writes: counting the whole content extent stopped the frame
  // ~5 px short of the page over 1000 content rows (review B, 2026-09-28).
  const frameSizeCount = axis === "cols" ? entry.cols : entry.rows;
  const scaleCap = maxScaleWithin(baseFrameExtent, baseExtent, maxFrameExtent, frameSizeCount);

  const applyScale = (scale: number) => {
    const live = getFloatingRangeById(frId);
    if (!live) return;
    // Restore the baseline first: the scale is always measured from the drag's
    // START, never compounded onto the previous frame.
    live.colWidths = { ...baseWidths };
    live.rowHeights = { ...baseHeights };
    if (axis === "cols") live.colWidths = scaledColWidths(live, scale, extent.cols);
    else live.rowHeights = scaledRowHeights(live, scale, extent.rows);
    if (movesOrigin) {
      // The dragged edge moves; the opposite one stays where it was.
      if (axis === "cols") live.x = Math.max(0, baseX + baseFrameW - frameWidth(live));
      else live.y = Math.max(0, baseY + baseFrameH - frameHeight(live));
    }
    syncFloatingRangeRegions();
    requestOverlayRedraw();
  };

  let lastScale = 1;
  // A CLICK on a ball is not a resize. The balls sit over the edge cells of
  // every selected range, in every mode, so a 1px wobble while clicking one of
  // those cells used to rescale every column by a fraction of a pixel -- an
  // invisible change that still recorded "Resize floating range cells" and
  // dirtied the document. Latched: once the press has travelled past the
  // threshold it is a drag, and the scale is still measured from the PRESS
  // point, so a drag that returns to its start restores the sizes exactly.
  let dragging = false;

  const onMove = (ev: MouseEvent) => {
    const canvas = clientToCanvas(ev.clientX, ev.clientY);
    if (!canvas) return;
    const delta =
      axis === "cols" ? canvas.x - startCanvasX : canvas.y - startCanvasY;
    if (!dragging) {
      if (Math.abs(delta) <= EDGE_DRAG_THRESHOLD_PX) return;
      dragging = true;
    }
    // Dragging the left/top edge outward means a NEGATIVE delta grows the
    // object, so the sign flips for the origin-moving edges.
    const grow = movesOrigin ? -delta : delta;
    lastScale = Math.min(
      clampScaleFactor(baseSizes, (baseExtent + grow) / baseExtent, min, max),
      scaleCap,
    );
    applyScale(lastScale);
  };

  const finish = () => {
    activeDragCleanup?.();
    const live = getFloatingRangeById(frId);
    if (!live) return;
    if (lastScale === 1) {
      // Nothing moved: no write, no undo entry, no announcement.
      return;
    }
    void resizeFrCells(
      frId,
      { ...live.colWidths },
      { ...live.rowHeights },
      live.x,
      live.y,
    ).catch((err) => {
      // Loud: the frame visibly stretched, so a refusal nobody announces
      // reads as the gesture silently undoing itself.
      reportGeometryFailure(err);
      // The optimistic local scale is now a lie; the backend is the authority.
      void loadFloatingRangesFromBackend().then(() => {
        syncFloatingRangeRegions();
        requestOverlayRedraw();
      });
    });
  };

  activeDragCleanup?.();
  activeDragCleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", finish);
    activeDragCleanup = null;
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", finish);
}

/**
 * Corner resize is REINTERPRETED as a quantized count change (M8): the rect
 * Core dragged (already snapped and page-clamped) becomes whole row/column
 * counts, and x/y move only for a left/top drag so the visually fixed corner
 * stays put. Raw w/h is NEVER persisted. Exported for the unit tier.
 */
export function quantizeCornerResize(
  entry: FloatingRangeEntry,
  detail: { x: number; y: number; width: number; height: number },
): {
  rows: number;
  cols: number;
  x: number;
  y: number;
  width: number;
  height: number;
} {
  // Left/top edge moved => the OPPOSITE edge is the fixed one.
  const leftDragged = Math.abs(detail.x - entry.x) > 0.5;
  const topDragged = Math.abs(detail.y - entry.y) > 0.5;
  // The NEAREST whole counts can overshoot the dragged rect by half a
  // track. Where Core clamped that rect -- at a canvas page's far edge, or
  // at the sheet origin for a left/top drag -- the overshoot would carry the
  // frame past the clamp (or, at the origin, move the FIXED edge), so the
  // counts step down until the frame fits.
  const page = getLayoutSurface(entry.sheetIndex)?.page ?? null;
  const maxWidth = leftDragged
    ? entry.x + frameWidth(entry)
    : page
      ? page.width - entry.x
      : Infinity;
  const maxHeight = topDragged
    ? entry.y + frameHeight(entry)
    : page
      ? page.height - entry.y
      : Infinity;
  const counts = fitCountsWithin(
    entry,
    bestCountsForSize(entry, detail.width, detail.height),
    maxWidth,
    maxHeight,
  );
  const snapped = frameSizeForCounts(entry, counts.rows, counts.cols);
  const x = leftDragged
    ? Math.max(0, entry.x + frameWidth(entry) - snapped.width)
    : entry.x;
  const y = topDragged
    ? Math.max(0, entry.y + frameHeight(entry) - snapped.height)
    : entry.y;
  return { ...counts, x, y, width: snapped.width, height: snapped.height };
}

// ============================================================================
// frZoneAt -- what a point on the range is FOR (one answer per press)
// ============================================================================

/**
 * The parts of a range a press can land on, as `frZoneAt` names them. Core
 * carries the part on both press events (`floatingObject:selected` and, for
 * content, `floatingObject:bodyDragStart`), so the handlers act on what the
 * press was decided to be BEFORE it selected anything.
 */
export type FrPressPart =
  | "referencePick"
  | "edgeHandle"
  | "outside"
  | "title"
  | "border"
  | "bodyGrab"
  | "cells"
  | "rowHeader"
  | "colHeader";

/**
 * The range's ZONE under a point -- its `OverlayRegistration.zoneAt`
 * (@api/gridOverlays), from which Core derives the press, the pointer and the
 * meaning of Ctrl/Shift, so the three can never disagree (BUG-0258):
 *
 *   a formula expects a reference, anywhere   content 'cell'           referencePick
 *   a LIVE edge ball                          content 'ew'/'ns-resize' edgeHandle
 *   a near miss outside the frame             content 'default'        outside
 *   the title bar                             frame                    title
 *   no title: the 4px border band (movable)   frame                    border
 *   no title, Design Mode: the whole body     frame                    bodyGrab
 *   cells / row header / column header        content 'cell'           cells, rowHeader, colHeader
 *
 * A frame press is Core's: it selects the range, and a drag moves it when it
 * can move (a frozen title shows 'default' and only selects). A content press
 * is the range's own work, on a locked or subscribed range too.
 *
 * PURE -- a contract, not a style: Core asks on every hover move, and ONCE per
 * press BEFORE the press selects anything. That is what makes this answer the
 * place for the two facts the press's handlers must never re-derive later:
 *   - the press is a REFERENCE PICK. Re-asked after the insertion it is not:
 *     "=SUM(" became "=SUM(Float1!B1", which no longer EXPECTS a reference, so
 *     the pick also moved the cell selection onto the picked cell, and the
 *     edit-lifetime rule (lib/frFormulaBar.ts) then COMMITTED the half-typed
 *     formula -- the user's next keystroke typed over the cell they had only
 *     meant to reference.
 *   - the edge handles were LIVE. `ctx.region` is the region Core captured
 *     before the press selected the range (its `resizable` says whether the
 *     balls were armed when the user pressed), and the editor is read here,
 *     before the press's commit-before-select closes it: read after it, a
 *     press on an invisible ball of a range being edited would commit the edit
 *     AND start a cell-scale drag.
 * The press's side effects live in its handlers (setupFloatingObjectEvents):
 * the commit-before-select in `floatingObject:selected`, the reference
 * insertion and the edge-scale drag in `floatingObject:bodyDragStart`.
 *
 * Exported for the unit tier (frMoveZones.test.ts).
 */
export function frZoneAt(ctx: OverlayHitTestContext): OverlayZone | null {
  const frId = ctx.region.data?.frId as string | undefined;
  if (!frId || !ctx.floatingCanvasBounds) return null;
  const entry = getFloatingRangeById(frId);
  if (!entry) return null;

  // Formula-reference picking (M7): a press on the range while ANY editor
  // expects a reference FEEDS that formula -- over a cell it inserts
  // "Name!A1" -- and never selects or moves the object (accepted, Excel-like),
  // wherever it lands.
  if (externalTargetExpecting() || isGlobalFormulaMode()) {
    return { kind: "content", cursor: "cell", part: "referencePick" };
  }

  const dx = ctx.canvasX - ctx.floatingCanvasBounds.x;
  const dy = ctx.canvasY - ctx.floatingCanvasBounds.y;

  // Edge handles: scale the CELLS. Checked before the zones because a handle
  // sits ON the frame border, where the zone underneath would otherwise
  // answer "cells" or "rowHeader". Gated on `frHandlesLive` -- the same gate
  // the paint and the extended hit area use, so a ball is never grabbable
  // where it is not painted: an unselected range's balls do not take the
  // press that selects it, and never while its cell editor is open.
  // `frGeometryEditable` is the one per-range answer every geometry door
  // asks, read live.
  if (frHandlesLive(ctx.region, frId) && frGeometryEditable(frId)) {
    const edge = frEdgeHandleAt(entry, dx, dy);
    if (edge) {
      return {
        kind: "content",
        cursor: edgeAxis(edge) === "cols" ? "ew-resize" : "ns-resize",
        part: "edgeHandle",
      };
    }
  }

  // At the range's scroll: a press on a scrolled cell means THAT cell, not
  // the window cell that used to sit there.
  const hit = localCellFromPoint(entry, dx, dy, getFrView(entry));

  // The handles' hit radius reaches a few pixels PAST the frame (see
  // hitTestFloatingRange), so a near miss lands here with no zone. It is the
  // range's, and inert: as frame it would start a move from outside the
  // object.
  if (hit.zone === "outside") return { kind: "content", cursor: "default", part: "outside" };

  // The title bar is the frame in every mode (owner decision 2026-09-27).
  if (hit.zone === "title") return { kind: "frame", part: "title" };

  // With the title bar hidden, the 4px band inside the frame edge is the move
  // handle (Excel's text box moves by its border). Gated on `movable`, so the
  // band never offers a drag Core would refuse -- on a subscribed canvas or a
  // locked range the band is just the edge cells.
  if (!entry.showTitle && ctx.region.data?.movable === true && frBorderGrabAt(entry, dx, dy)) {
    return { kind: "frame", part: "border" };
  }

  // In DESIGN MODE the whole body of a title-less range is the frame -- the
  // Charts/Controls convention. `bodyGrab`, NOT `movable`: a range moves
  // outside Design Mode too, so reading `movable` here would turn the whole
  // body of every title-less range into a move handle and its cells could no
  // longer be selected or edited.
  if (ctx.region.data?.bodyGrab === true) return { kind: "frame", part: "bodyGrab" };

  // Cells and headers: the range's working surface (its cell selection).
  return { kind: "content", cursor: "cell", part: hit.zone };
}

/** The local cell under a press point, at the range's scroll; null over a header, the title or outside. */
function cellUnderPress(
  entry: FloatingRangeEntry,
  canvasX: number,
  canvasY: number,
): { row: number; col: number } | null {
  const bounds = frameCanvasBounds(entry);
  if (!bounds) return null;
  const hit = localCellFromPoint(entry, canvasX - bounds.x, canvasY - bounds.y, getFrView(entry));
  return hit.zone === "cells" ? { row: hit.row, col: hit.col } : null;
}

/**
 * A reference pick's insertion: "Name!A1" for local cell (row, col). The
 * external target (an open FR editor, the formula bar) wins over the grid
 * editor; self-reference is legal -- cycles are the engine's job.
 */
function insertReferenceTo(entry: FloatingRangeEntry, row: number, col: number): void {
  if (externalTargetExpecting()) {
    getExternalFormulaTarget()?.insertReference({
      sheetName: entry.name,
      startRow: row,
      startCol: col,
      endRow: row,
      endCol: col,
    });
  } else {
    insertTextIntoActiveFormula(buildQualifiedRef(entry.name, row, col));
  }
}

// ============================================================================
// onDoubleClick — the real gesture, not a timer
// ============================================================================

/**
 * A double-click on an FR CELL opens that cell's editor.
 *
 * Core hands this over through `OverlayRegistration.onDoubleClick`
 * (@api/gridOverlays), which is the ONLY seam that reaches the owner of a
 * floating object: the cell double-click interceptors are asked about a CELL,
 * and Core resolves no cell over a floating overlay.
 *
 * Before that seam existed this was INFERRED from two `bodyDragStart` events on
 * the same local cell within 350 ms — a private clock that (a) could not tell a
 * double-click from two deliberate single clicks a third of a second apart, (b)
 * fired only because the FR claimed its body drags, so no overlay without such
 * a claim could have copied it, and (c) had to be reset on every zone change
 * by hand. The browser already knows what a double-click is; ask it.
 *
 * The zone's refusals (`frZoneAt`) are repeated here rather than shared, because a
 * double-click is a different gesture with the same geometry: a reference pick
 * must not open an editor (the first click already inserted the reference), and
 * a title-bar or header double-click has no cell to edit.
 */
export function handleFrDoubleClick(ctx: OverlayHitTestContext): boolean {
  const frId = ctx.region.data?.frId as string | undefined;
  if (!frId || !ctx.floatingCanvasBounds) return false;
  const entry = getFloatingRangeById(frId);
  if (!entry) return false;
  if (isGlobalFormulaMode() || externalTargetExpecting()) return false;

  const dx = ctx.canvasX - ctx.floatingCanvasBounds.x;
  const dy = ctx.canvasY - ctx.floatingCanvasBounds.y;
  const hit = localCellFromPoint(entry, dx, dy, getFrView(entry));
  if (hit.zone !== "cells") return false;

  setLocalSelection({
    frId,
    anchorRow: hit.row,
    anchorCol: hit.col,
    endRow: hit.row,
    endCol: hit.col,
  });
  // A cell only partly scrolled into view is brought fully in before its
  // editor opens over it (the editor is clipped to the viewport otherwise).
  ensureFrCellVisible(entry, hit.row, hit.col);
  openFrEditor(frId, hit.row, hit.col, null);
  return true;
}

// ============================================================================
// floatingObject:* handlers
// ============================================================================

function setupFloatingObjectEvents(): void {
  const handleSelected = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    // A ref-pick click must not also select the object (nor drop a selection).
    if (isGlobalFormulaMode() || externalTargetExpecting()) return;
    if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) {
      // Another object took the press: the range's CELL selection ends (the
      // formula bar and the Name Box stop showing its cell, and an open edit
      // is committed -- lib/frFormulaBar.ts). The OBJECT selection is left
      // alone: a Ctrl/Shift press on a canvas ADDS to the selection set.
      if (getLocalSelection()) {
        clearLocalSelection();
        requestOverlayRedraw();
      }
      return;
    }
    const frId = detail.data?.frId as string | undefined;
    if (!frId) return;
    const sel = getLocalSelection();
    if (sel && sel.frId !== frId) clearLocalSelection();
    selectFloatingRange(frId);
    // The FR's COMMIT BEFORE SELECT, for every part of this press -- the
    // title, the border band and Design Mode's body grab dispatch no
    // bodyDragStart, so this is the one handler that covers them all. The
    // object is selected first and the cell selection moves after (in
    // bodyDragStart): the order a click-away has always had. A frame press
    // names no target cell, so it commits even over the edited cell; a CELL
    // press (the part `frZoneAt` decided before the press) names its cell, and
    // a press on the cell being edited places the caret instead.
    const entry = getFloatingRangeById(frId);
    commitFrEditorBeforeSelect(
      frId,
      detail.part === "cells" && entry
        ? cellUnderPress(entry, detail.canvasX as number, detail.canvasY as number)
        : null,
    );
    requestOverlayRedraw();
  };
  window.addEventListener("floatingObject:selected", handleSelected);
  cleanupFns.push(() =>
    window.removeEventListener("floatingObject:selected", handleSelected),
  );

  // --------------------------------------------------------------------------
  // Move: preview frames SHOW the new position and write nothing; the ONE
  // write is moveComplete's. Persisting previews (through the 300 ms debounce)
  // made a human drag that paused mid-gesture several "Move floating range"
  // undo steps -- invisible to a test driver's fast mouse, everyday for a
  // person now that the title bar moves a range without Design Mode.
  // --------------------------------------------------------------------------
  cleanupFns.push(installFrMovePersistence());

  // --------------------------------------------------------------------------
  // Corner resize is REINTERPRETED as a quantized count change (M8,
  // `quantizeCornerResize`): the ghost snaps to whole rows/cols;
  // resizeComplete converts the final rect to counts and adjusts x/y so the
  // visually fixed corner stays put. Raw w/h is NEVER persisted.
  // --------------------------------------------------------------------------
  const handleResizePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) return;
    const frId = detail.data?.frId as string | undefined;
    const entry = frId ? getFloatingRangeById(frId) : null;
    if (!frId || !entry) return;
    const q = quantizeCornerResize(entry, detail as { x: number; y: number; width: number; height: number });
    setFrResizeGhost({
      frId,
      x: q.x,
      y: q.y,
      width: q.width,
      height: q.height,
      rows: q.rows,
      cols: q.cols,
    });
    requestOverlayRedraw();
  };
  window.addEventListener("floatingObject:resizePreview", handleResizePreview);
  cleanupFns.push(() =>
    window.removeEventListener("floatingObject:resizePreview", handleResizePreview),
  );

  const handleResizeComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) return;
    const frId = detail.data?.frId as string | undefined;
    const entry = frId ? getFloatingRangeById(frId) : null;
    setFrResizeGhost(null);
    if (!frId || !entry) return;
    const q = quantizeCornerResize(entry, detail as { x: number; y: number; width: number; height: number });
    if (q.rows === entry.rows && q.cols === entry.cols && q.x === entry.x && q.y === entry.y) {
      requestOverlayRedraw();
      return;
    }
    void resizeFr(frId, q.rows, q.cols, q.x, q.y).catch((err) => {
      reportGeometryFailure(err);
      syncFloatingRangeRegions();
      requestOverlayRedraw();
    });
  };
  window.addEventListener("floatingObject:resizeComplete", handleResizeComplete);
  cleanupFns.push(() =>
    window.removeEventListener("floatingObject:resizeComplete", handleResizeComplete),
  );

  // --------------------------------------------------------------------------
  // Body drag: the CONTENT press, acting on the part `frZoneAt` decided before
  // the press -- a reference pick, an edge-ball scale, or the local cell
  // selection + drag-extend. A near miss outside the frame does nothing.
  // --------------------------------------------------------------------------
  const handleBodyDragStart = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) return;
    const frId = detail.data?.frId as string | undefined;
    const entry = frId ? getFloatingRangeById(frId) : null;
    if (!frId || !entry) return;
    const bounds = frameCanvasBounds(entry);
    if (!bounds) return;
    const dx = (detail.canvasX as number) - bounds.x;
    const dy = (detail.canvasY as number) - bounds.y;
    const part = detail.part as FrPressPart | undefined;

    // A REFERENCE PICK: over a cell the reference goes into the formula;
    // anywhere else the press does nothing. Nothing is selected, and the fact
    // is the PART, never re-asked: the insertion has just changed the text
    // ("=SUM(" is now "=SUM(Float1!B1", which no longer expects a reference),
    // so asking again would select the picked cell and commit the edit it was
    // feeding.
    if (part === "referencePick") {
      const hit = localCellFromPoint(entry, dx, dy, getFrView(entry));
      if (hit.zone === "cells") insertReferenceTo(entry, hit.row, hit.col);
      return;
    }

    // An EDGE BALL that was live when the press BEGAN: the part was decided
    // before the press's commit-before-select closed any editor, which is why
    // it is read here and never re-derived.
    if (part === "edgeHandle") {
      const edge = frEdgeHandleAt(entry, dx, dy);
      if (edge) startEdgeResizeDrag(entry, edge, detail.canvasX as number, detail.canvasY as number);
      return;
    }

    // The working surface only: cells and headers.
    if (part !== "cells" && part !== "rowHeader" && part !== "colHeader") return;
    // Second line of defence (the press was decided outside formula mode).
    if (isGlobalFormulaMode() || externalTargetExpecting()) return;

    const view = getFrView(entry);
    const hit = localCellFromPoint(entry, dx, dy, view);
    if (hit.zone === "outside" || hit.zone === "title") return;

    // Zone -> initial local selection. A header selects the whole row/column
    // of the CONTENT extent, not just the window's part of it.
    let anchorRow = 0;
    let anchorCol = 0;
    let endRow = 0;
    let endCol = 0;
    if (hit.zone === "cells") {
      anchorRow = endRow = hit.row;
      anchorCol = endCol = hit.col;
    } else if (hit.zone === "rowHeader") {
      anchorRow = endRow = hit.row;
      anchorCol = 0;
      endCol = view.cols - 1;
    } else if (hit.zone === "colHeader") {
      anchorCol = endCol = hit.col;
      anchorRow = 0;
      endRow = view.rows - 1;
    }

    // A double-click is NOT inferred here any more. It arrives as a real
    // double-click through the overlay's `onDoubleClick` seam — see
    // `handleFrDoubleClick`.
    setLocalSelection({ frId, anchorRow, anchorCol, endRow, endCol });
    requestOverlayRedraw();

    // Drag-extend via window listeners (Charts brush precedent).
    activeDragCleanup?.();
    // Held past an edge of the cell area, the range scrolls that way and the
    // selection's moving end follows it, one cell per tick (E10,
    // lib/frDragAutoScroll.ts) -- it used to stop at the window's edge.
    const autoScroller = createFrAutoScroller((step) => {
      const liveEntry = getFloatingRangeById(frId);
      const sel = getLocalSelection();
      if (!liveEntry || !sel || sel.frId !== frId) return;
      const liveView = getFrView(liveEntry);
      const row = Math.max(0, Math.min(liveView.rows - 1, sel.endRow + step.dRow));
      const col = Math.max(0, Math.min(liveView.cols - 1, sel.endCol + step.dCol));
      if (row === sel.endRow && col === sel.endCol) return;
      extendLocalSelection(row, col);
      ensureFrCellVisible(liveEntry, row, col);
      requestOverlayRedraw();
    });
    const onMove = (ev: MouseEvent) => {
      const canvas = clientToCanvas(ev.clientX, ev.clientY);
      const liveEntry = getFloatingRangeById(frId);
      const liveBounds = liveEntry ? frameCanvasBounds(liveEntry) : null;
      const sel = getLocalSelection();
      if (!canvas || !liveEntry || !liveBounds || !sel || sel.frId !== frId) {
        autoScroller.stop();
        return;
      }
      const dx = canvas.x - liveBounds.x;
      const dy = canvas.y - liveBounds.y;
      autoScroller.update(frAutoScrollStep(liveEntry, dx, dy));
      // The cell under the pointer, clamped into the cells on screen -- past
      // an edge that is the edge cell, which the ticker has just scrolled the
      // selection's end to, so the two agree.
      const cell = clampedCellFromFramePoint(liveEntry, dx, dy);
      if (cell.row !== sel.endRow || cell.col !== sel.endCol) {
        // Through the selection's own door, never in place: the formula bar
        // and the Name Box follow the extended range.
        extendLocalSelection(cell.row, cell.col);
        requestOverlayRedraw();
      }
    };
    const onUp = () => activeDragCleanup?.();
    activeDragCleanup = () => {
      autoScroller.stop();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      activeDragCleanup = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  window.addEventListener("floatingObject:bodyDragStart", handleBodyDragStart);
  cleanupFns.push(() =>
    window.removeEventListener("floatingObject:bodyDragStart", handleBodyDragStart),
  );
  cleanupFns.push(() => activeDragCleanup?.());
}

// ============================================================================
// Capture-phase keyboard (active only for FR selections; the FR editor's own
// textarea handles its keys — the input/textarea guard skips it here)
// ============================================================================

/** Exported for the unit tier (the extent-wide navigation + reveal, M7). */
export function handleFrKeyDown(e: KeyboardEvent): void {
  // A keystroke aimed at a surface stacked ON the grid -- an on-grid form's
  // field, a shape's declared hit rectangle -- is not this extension's.
  // The tag list below cannot see a <select> or a <button>; the claim can.
  // See core/lib/pointerClaims.ts, and the census in
  // core/lib/globalInputListeners.ts (a new global listener adds a row).
  if (isKeyClaimed(e)) return;
  // A key the keybinding dispatcher already TOOK is not this listener's
  // (review C, W18). The dispatcher is a window-capture listener installed at
  // bootstrap, so it runs first on this same target and phase, where its
  // stopPropagation cannot reach this listener. It ran a command for the key,
  // and that command's own door decided -- Group refused while the range owns
  // the selection, and this listener then ALSO read Alt+Shift+Right as
  // Shift+Right and extended the range's selection; Shift+F2 (New Note) opened
  // the range's cell editor as F2. The range's own keys (arrows, Enter, Tab,
  // Escape, F2, typing) are bound to nothing while its cell is selected (the
  // canvas's Tab/Escape/nudge bindings ask the object's `ownsKey` and stand
  // down), so they still arrive here undecided.
  if (e.defaultPrevented) return;
  const target = e.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  ) {
    return;
  }
  if (getGlobalIsEditing() || isFrEditorOpen()) return;

  // Delete/Backspace WITH A MODIFIER (review 2026-09-28): the range binds only
  // the bare keys (lib/frKeyRouting.ts), and the grid's keyboard -- a listener
  // on the container, AFTER this one -- clears Core's selection on whatever it
  // treats as a delete: a modified one used to clear Core's HIDDEN cell
  // (Ctrl+Backspace is Excel's "show the active cell", pressed out of habit).
  // While the range owns the grid's keys (its cells or the object, the
  // keyboard the grid's), none of them reaches the grid. Nothing is cleared:
  // a clear is the bare key, here as on the sheet.
  if (
    (e.key === "Delete" || e.key === "Backspace") &&
    (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) &&
    frOwnsGridKeys()
  ) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  const sel = getLocalSelection();
  if (sel) {
    const entry = getFloatingRangeById(sel.frId);
    if (!entry) {
      clearLocalSelection();
      return;
    }
    const swallow = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // Navigation spans the CONTENT extent, not just the window (M7): a cell
    // past the window's edge is one arrow press away, and the move scrolls it
    // into view. The moving end is the one kept visible (Shift extends it).
    const view = getFrView(entry);
    const move = (dRow: number, dCol: number, extend: boolean) => {
      moveLocalSelection(dRow, dCol, extend, view.rows, view.cols);
      const moved = getLocalSelection();
      if (moved) ensureFrCellVisible(entry, moved.endRow, moved.endCol);
      requestOverlayRedraw();
    };

    switch (e.key) {
      case "ArrowUp":
        swallow();
        move(-1, 0, e.shiftKey);
        return;
      case "ArrowDown":
        swallow();
        move(1, 0, e.shiftKey);
        return;
      case "ArrowLeft":
        swallow();
        move(0, -1, e.shiftKey);
        return;
      case "ArrowRight":
        swallow();
        move(0, 1, e.shiftKey);
        return;
      case "Enter":
        swallow();
        move(e.shiftKey ? -1 : 1, 0, false);
        return;
      case "Tab":
        swallow();
        move(0, e.shiftKey ? -1 : 1, false);
        return;
      case "Escape":
        // With the range's right-click menu open, Escape is the MENU's (it
        // closes itself and stops the key): the cell selection stays.
        if (isFrContextMenuOpen()) return;
        swallow();
        // Drop the LOCAL selection; the object stays selected.
        clearLocalSelection();
        requestOverlayRedraw();
        return;
      case "F2":
        swallow();
        // The editor opens over the active cell, so that cell must be in view.
        ensureFrCellVisible(entry, sel.anchorRow, sel.anchorCol);
        openFrEditor(sel.frId, sel.anchorRow, sel.anchorCol, null);
        return;
      // The BARE Delete and Backspace are NOT this listener's: they go through the
      // keybinding registry (lib/frKeyRouting.ts), whose window-capture
      // dispatcher runs first and would otherwise hand Delete to the grid's
      // clear-contents over Core's hidden cell -- while this listener, on the
      // same target, cleared the range's cell as well.
      default:
        // Type-to-edit: a printable character opens the editor seeded with it
        // -- an AltGr one included ("@" is Ctrl+Alt+2 on sv-SE as Windows
        // reports it; the grid's own rule, isTypedCharacterKey). Never a key
        // the keybinding dispatcher already took (it runs first, on the same
        // window-capture phase, and prevents what it matches).
        if (!e.defaultPrevented && isTypedCharacterKey(e)) {
          swallow();
          ensureFrCellVisible(entry, sel.anchorRow, sel.anchorCol);
          openFrEditor(sel.frId, sel.anchorRow, sel.anchorCol, e.key);
        }
        return;
    }
  }
}

/**
 * The range's Delete (and Backspace), run by the registry binding
 * (lib/frKeyRouting.ts): the LOCAL cell selection always wins -- its cells are
 * cleared; with only the OBJECT selected, the object is deleted (confirmed,
 * because delete ends the undo history). Exported for the unit tier.
 *
 * A CANVAS selection that spans families (a range beside a chart, or a second
 * range the selection set holds), with no inner cell selection, is not the
 * range's alone: the dispatcher runs ONE winner per Delete, so whichever
 * family's binding wins hands the WHOLE selection to the seam
 * (`handOverToWholeSelectionDelete`, lib/frKeyRouting.ts), which deletes every
 * member through its family's `deleteObjects` -- this range's included.
 */
export function deleteFrSelection(): void {
  if (handOverToWholeSelectionDelete()) return;
  const sel = getLocalSelection();
  if (sel) {
    if (!getFloatingRangeById(sel.frId)) {
      clearLocalSelection();
      return;
    }
    void clearLocalSelectionCells(sel.frId);
    return;
  }
  const objId = getSelectedFloatingRange();
  if (objId) void confirmAndDeleteFr(objId);
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  // 1. Overlay registration (priority 13: above Controls 12, below Charts 15).
  //    ONE zone answer (`frZoneAt`) drives the press, the pointer and the
  //    meaning of Ctrl/Shift; no cursor or claim of its own beside it.
  cleanupFns.push(
    context.grid.overlays.register({
      type: FLOATING_RANGE_REGION_TYPE,
      render: renderFloatingRange,
      hitTest: hitTestFloatingRange,
      zoneAt: frZoneAt,
      onDoubleClick: handleFrDoubleClick,
      priority: 13,
    }),
  );

  // 1'. The yellow EDGE BALLS paint in a grid layer ABOVE Core's selection
  //     chrome (Core paints a selected object's outline after every object,
  //     BUG-0258 design phase 3; the corner handles are Core's too). Before
  //     the canvas's lock mark (priority 0).
  cleanupFns.push(
    registerGridLayer({
      id: FR_EDGE_BALL_LAYER_ID,
      anchor: "over-selection",
      priority: -1,
      paint: (layerCtx) => paintFrEdgeBalls(layerCtx),
    }),
  );

  // 1a. Overflow scroll (M7): a wheel over a range whose content reaches past
  //     its window scrolls the cell area. Through the SHARED helper's one
  //     capture-phase listener (no listener of our own); a range with no
  //     overflow on the wheeled axis lets the wheel through to the page.
  cleanupFns.push(registerObjectWheelTarget(createFrWheelTarget()));

  // 1b. Keyboard / programmatic selection (@api/objectSelection). A canvas
  //     sheet's Tab cycling selects ranges through this, and asks `ownsKey`
  //     first: while a range has an inner cell selection, Tab and Escape are
  //     handleFrKeyDown's (below), and a second window-capture listener cannot
  //     stop this one from also seeing the key. A canvas-wide Delete deletes
  //     the range's share of a multi-selection through `deleteRanges`.
  cleanupFns.push(
    registerFloatingRangeObjectSelection({ deleteRanges: deleteFrObjectsConfirmed }),
  );

  // 1c. Geometry without a pointer gesture (@api/objectGeometry): the canvas's
  //     align, distribute, nudge and group drag -- position only.
  cleanupFns.push(registerObjectGeometryProvider(createFloatingRangeGeometryProvider()));

  // 2. floatingObject:* wiring.
  setupFloatingObjectEvents();

  // 3. Capture-phase keyboard.
  window.addEventListener("keydown", handleFrKeyDown, true);
  cleanupFns.push(() =>
    window.removeEventListener("keydown", handleFrKeyDown, true),
  );

  // 3a. While the range owns the selection nothing may act on Core's hidden
  //     active cell (lib/frKeyRouting.ts): Delete/Backspace are the range's;
  //     the range CLAIMS the selection (@api/selectionOwner), so every door
  //     that writes to Core's selection -- the grid commands, the grid
  //     keyboard, the formatting doors, the extensions' selection commands --
  //     refuses in its own door, whatever key reached it (W18); only Data
  //     Validation's Alt+Down, with no command behind it, is a combination.
  cleanupFns.push(
    installFrKeyRouting({
      extensionId: "calcula.floating-range",
      deleteSelection: deleteFrSelection,
    }),
  );

  // 3b. The published flags (movable / resizable / bodyGrab, see
  // syncFloatingRangeRegions) follow Design Mode, the layout surface
  // (subscribe, detach, lock, a canvas store that loads after the ranges) and
  // the object selection. Each re-publishes on its own signal, or the change
  // would wait for the next unrelated sync.
  cleanupFns.push(installFrRegionResyncs());

  // 4. Insert menu.
  context.ui.menus.registerItem("insert", {
    id: "insert.floatingRange",
    label: "Floating Range",
    action: () => void insertFloatingRangeFromMenu(),
  });
  cleanupFns.push(() =>
    context.ui.menus.unregisterItem("insert", "insert.floatingRange"),
  );

  // 5. Object right-click menu.
  //
  //    Core does NOT open the grid's cell menu over a floating object and
  //    expects the owning extension to show its own from a capture-phase
  //    contextmenu listener (Charts / Slicer / TimelineSlicer all do). The FR
  //    never registered one, so its menu — Properties… included — could not be
  //    reached by right-clicking the object at all.
  //
  //    EDITABILITY gates it, not Design Mode (owner decision 2026-09-27): the
  //    items are AUTHORING acts on the object (grow it, rename it, delete it,
  //    change its chrome), so the menu opens wherever the range may be
  //    authored -- a worksheet, or a canvas that is not subscribed
  //    (`frObjectEditable`) -- and its SIZE items only where its geometry may
  //    change (`frGeometryEditable`: not on a range the canvas locks). The
  //    cells stay the working surface in every mode; the menu is a right-click.
  const menuHandlers: FrContextMenuHandlers = {
    addRow: (frId) => {
      const entry = getFloatingRangeById(frId);
      if (entry) void resizeFr(frId, entry.rows + 1, entry.cols).catch(reportGeometryFailure);
    },
    addColumn: (frId) => {
      const entry = getFloatingRangeById(frId);
      if (entry) void resizeFr(frId, entry.rows, entry.cols + 1).catch(reportGeometryFailure);
    },
    deleteLastRow: (frId) => {
      const entry = getFloatingRangeById(frId);
      if (entry && entry.rows > 1) {
        void resizeFr(frId, entry.rows - 1, entry.cols).catch(reportGeometryFailure);
      }
    },
    deleteLastColumn: (frId) => {
      const entry = getFloatingRangeById(frId);
      if (entry && entry.cols > 1) {
        void resizeFr(frId, entry.rows, entry.cols - 1).catch(reportGeometryFailure);
      }
    },
    canEditGeometry: (frId) => frGeometryEditable(frId),
    // The published region "Size and Position..." opens for (@api/objectPosition).
    regionOf: (frId) =>
      getGridRegions().find((r) => r.type === FLOATING_RANGE_REGION_TYPE && frIdOf(r) === frId) ?? null,
    rename: (frId) => {
      void (async () => {
        const entry = getFloatingRangeById(frId);
        if (!entry) return;
        const name = await promptAsync(
          "New name (shared with sheet names; renaming updates referencing formulas and clears the undo history):",
          { title: "Rename Floating Range", defaultValue: entry.name },
        );
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed || trimmed === entry.name) return;
        try {
          await renameFr(frId, trimmed);
        } catch (err) {
          showToast(
            `The floating range could not be renamed: ${err instanceof Error ? err.message : String(err)}`,
            { type: "error" },
          );
        }
      })();
    },
    properties: (frId) => {
      showDialog(FR_PROPERTIES_DIALOG_ID, { frId });
    },
    deleteObject: (frId) => void confirmAndDeleteFr(frId),
    getCounts: (frId) => {
      const entry = getFloatingRangeById(frId);
      return entry ? { rows: entry.rows, cols: entry.cols } : null;
    },
};

  context.ui.overlays.register({
    id: FR_CONTEXT_MENU_ID,
    component: FloatingRangeContextMenu,
    layer: "dropdown",
  });
  cleanupFns.push(() => context.ui.overlays.unregister(FR_CONTEXT_MENU_ID));

  const handleFrContextMenu = (e: MouseEvent) => {
    // A formula is picking a reference on ANOTHER sheet (an edit parked
    // there, or the grid's own cross-sheet edit): nothing of this sheet's
    // ranges is on screen. The frame lookup below reads the store, not the
    // (suppressed) regions, so it would open an invisible range's menu.
    if (isPointModeOnForeignSheet()) return;
    if (e.shiftKey) return; // Shift+right-click = the browser's own menu

    // The listener is on `window`, so it sees right-clicks in dialogs and side
    // panels too. Those have client coordinates that can map INTO an FR's
    // frame once converted to the canvas basis, which would pop an object menu
    // from a click that never touched the grid. Containment settles it before
    // any geometry runs. Text fields keep their own menu.
    const target = e.target as HTMLElement | null;
    const layer = document.querySelector("[data-grid-canvas-layer]");
    if (!target || !layer || !layer.contains(target)) return;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) {
      return;
    }

    const point = clientToCanvas(e.clientX, e.clientY);
    if (!point) return;
    // THE TOPMOST OBJECT DECIDES (@api/gridOverlays). Another object painted
    // over the frame here owns this right-click -- the frame's own lookup sees
    // only floating ranges and would open this menu for a range the user
    // cannot see under a chart or a slicer. A range on top is THE range, in
    // the canvas's stacking order.
    const top = topFloatingRegionAt(point.x, point.y);
    if (top && top.type !== FLOATING_RANGE_REGION_TYPE) return;
    const topId = top ? frIdOf(top) : null;
    const entry = (topId ? getFloatingRangeById(topId) : null) ?? frameAtCanvasPoint(point.x, point.y);
    if (!entry) return;
    // A range on a SUBSCRIBED canvas is the publisher's: no authoring menu,
    // whatever Design Mode says (the right-click still falls through to what
    // any right-click on a read-only object does).
    if (!frObjectEditable(entry.id)) return;

    // preventDefault ALSO satisfies Core's `defaultPrevented` check, so the
    // grid's handler stands down even before its own floating-region test.
    e.preventDefault();
    e.stopPropagation();

    // Right-click selects, exactly as left-click does. Core's mousedown has
    // usually done this already (it dispatches floatingObject:selected for
    // every button), but a menu opened by a keyboard Menu key has had no
    // mousedown at all.
    selectFloatingRange(entry.id);
    requestOverlayRedraw();

    showOverlay(FR_CONTEXT_MENU_ID, {
      data: {
        frId: entry.id,
        screenX: e.clientX,
        screenY: e.clientY,
        items: buildFrContextMenu(entry.id, menuHandlers),
      },
    });
  };
  window.addEventListener("contextmenu", handleFrContextMenu, true);
  cleanupFns.push(() =>
    window.removeEventListener("contextmenu", handleFrContextMenu, true),
  );

  // 6. Properties dialog.
  context.ui.dialogs.register({
    id: FR_PROPERTIES_DIALOG_ID,
    component: FloatingRangePropertiesDialog,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(FR_PROPERTIES_DIALOG_ID));

  // 7. Provider seam (@api/floatingRangeService) — the door the script broker
  //    and other extensions use; it keeps store + regions + caches in step so
  //    a successful call is a VISIBLE result.
  cleanupFns.push(
    registerFloatingRangeProvider({
      list: () => getAllFloatingRanges().map(toInfo),
      create: async (req) => {
        const entry = await createFrOnActiveSheet(req);
        return toInfo(entry);
      },
      resize: (id, rows, cols) => resizeFr(id, rows, cols),
      rename: (id, name) => renameFr(id, name),
      delete: (id) => deleteFrObject(id),
      // In bands the backend accepts (lib/frCellReads.ts): one read of more
      // than 100,000 cells is refused, and a window can hold 256,000 (E10).
      getCells: (id, startRow, startCol, endRow, endCol) =>
        readFrCells(id, { startRow, startCol, endRow, endCol }),
      setCells: async (id, startRow, startCol, values) => {
        for (let r = 0; r < values.length; r++) {
          const rowValues = values[r];
          for (let c = 0; c < rowValues.length; c++) {
            const value = rowValues[c];
            if (typeof value !== "string") continue;
            await updateFloatingRangeCell(id, startRow + r, startCol + c, value);
          }
        }
        invalidateFrCache(id);
        requestOverlayRedraw();
      },
    }),
  );

  // 8. Deselect on a GENUINE grid-selection change (Controls guard precedent —
  //    identical re-emits of the same selection must not clear a fresh pick).
  let lastSelectionSig: string | null = null;
  cleanupFns.push(
    ExtensionRegistry.onSelectionChange((sel) => {
      const sig = sel
        ? `${sel.type ?? ""}:${sel.startRow},${sel.startCol},${sel.endRow},${sel.endCol}`
        : "none";
      if (sig === lastSelectionSig) return;
      // ALWAYS recorded, point mode included: a change skipped below must not
      // be replayed as a "genuine" one by the next, unrelated emit.
      lastSelectionSig = sig;
      // No grid selection is a CANVAS surface, not a grid click -- in
      // particular the return to a canvas host at the end of a point-mode
      // edit, whose Enter move reads this range's cell selection only after
      // its write lands.
      if (sel === null) return;
      // Point mode: the grid selection moved because the grid shows ANOTHER
      // sheet (the edit is parked there) or the click FED a reference. The
      // edit, the object and its cell all stay.
      if (isFrEditorOpen() && (externalTargetExpecting() || isExternalSessionParked())) return;
      // Same commit-before-select rule, for the click that lands on an
      // ORDINARY grid cell: that mousedown is preventDefault'd too, so the
      // editor would otherwise sit open over a grid the user has moved on
      // from.
      if (isFrEditorOpen()) void commitFrEditor(null);
      deselectAllFloatingRanges();
      clearLocalSelection();
      requestOverlayRedraw();
    }),
  );

  // 8a. A PRESS on a grid cell -- not a changed selection -- ends the range's
  //     selection. Listener 8 dedupes identical selections, so a click on the
  //     cell Core ALREADY had active (the one the range's cell hid) changed
  //     nothing it could see: the range kept its cell, the Name Box went on
  //     naming it, and the formula bar -- the edit's other view -- wrote the
  //     next entry into the floating cell instead of the cell just clicked.
  //     Core's cell-click interceptors run for exactly that press: an
  //     unclaimed cell press (never over a floating object, never the fill
  //     handle), and never while any edit is live (a pick or the commit-
  //     before-select owns those). Observe and decline: Core selects as usual.
  //     WORKSHEETS only: a canvas has no cells, and its background press is
  //     announced separately (the canvas marquee), where a Shift/Ctrl press
  //     ADDS to the selection -- dropping the range there would break that.
  cleanupFns.push(
    registerCellClickInterceptor(async () => {
      leaveForGridCellPress();
      return false;
    }),
  );

  // 8c. The same rule AFTER the press, from Core's own announcement
  //     (`onGridCellPressed`, @api/cellClickInterceptors). The interceptors
  //     above stand down while an edit is live -- a pick or the commit-before-
  //     select owns that press -- so with a BAR session open (not picking) a
  //     press on Core's already-active cell committed the session and then
  //     left this range's cell selected: the formula bar went on targeting the
  //     floating cell. Core announces the press only after its commit-before-
  //     select and its selection, so the edit is already written by then.
  cleanupFns.push(onGridCellPressed(() => leaveForGridCellPress()));

  // 8b. A GENUINE sheet switch is starting (a tab click, the Name Box, a new
  //     sheet, an undo that follows its sheet; a point-mode switch never
  //     announces this). The edit is COMMITTED -- a plain value typed and left
  //     by a tab click is Excel's commit, never a discard -- and the cell
  //     selection is dropped at once, so the formula bar and the Name Box stop
  //     showing this range's cell before the new sheet arrives, not after the
  //     queued re-sync below.
  //
  //     PARKED is not this listener's to end. A parked edit is a formula
  //     picking a reference on the viewed sheet; its end returns to the host
  //     first (the seam's `endExternalFormulaSession`), which this synchronous
  //     listener cannot do without racing the caller's own switch -- a commit
  //     here wrote the half-typed "=SUM(" into the cell as literal text
  //     without ever going back. The DOORS refuse to navigate instead: the
  //     Name Box -- a typed address AND a pick from its name list -- through
  //     this extension's resolver (lib/frFormulaBar.ts), and Undo/Redo, which
  //     Core refuses while any external edit is live (the keyboard in
  //     api/keybindings.ts; the command -- ribbon, Quick Access Toolbar,
  //     menu -- in useSpreadsheetSelection). A door that still switches
  //     regardless is a genuine switch, and its SHEET_CHANGED commits below
  //     as any genuine switch does.
  const onBeforeSheetSwitch = () => {
    if (isExternalSessionParked() && isFrEditorOpen()) return;
    if (isFrEditorOpen()) void commitFrEditor(null);
    if (getLocalSelection()) {
      clearLocalSelection();
      requestOverlayRedraw();
    }
  };
  window.addEventListener("sheet:beforeSwitch", onBeforeSheetSwitch);
  cleanupFns.push(() => window.removeEventListener("sheet:beforeSwitch", onBeforeSheetSwitch));

  // 9. Document lifecycle — ONE serialized queue (Controls precedent): the
  //    startup load is the first link, so a reload can never race it.
  let reloadQueue: Promise<void> = (async () => {
    await loadFloatingRangesFromBackend();
    setFrActiveSheetIndex(await getActiveSheet());
    syncFloatingRangeRegions();
  })().catch((err) => {
    console.error("[FloatingRange] Initial load failed:", err);
  });

  // 8c. The formula bar and the Name Box (@api/externalEdit): the selected
  //     cell is published for the bar to show and edit, an edit never
  //     outlives its cell's selection, and the Name Box accepts "Float1!B2"
  //     -- after the queue above, so a re-sync the box's own sheet switch
  //     queued cannot wipe the selection it sets.
  cleanupFns.push(installFrFormulaBarPublisher());
  cleanupFns.push(registerExternalAddressResolver(createFrAddressResolver(() => reloadQueue)));

  const reloadForNewDocument = () => {
    // The document is already REPLACED: an edit still open belongs to the OLD
    // one. End it NOW, before anything is queued -- the SHEET_CHANGED
    // {sheetIndex: 0} that the replacement announces next, synchronously
    // (file-api's announceBackendStateReplaced), would otherwise read as a
    // genuine switch and COMMIT the old document's text into the NEW one (a
    // re-opened copy carries the same range ids, so the write lands). A
    // discard, never a commit: the old document is gone. The queued pair below
    // stays as a harmless no-op.
    cancelFrEditor();
    resetFrSelection();
    reloadQueue = reloadQueue
      .then(async () => {
        cancelFrEditor();
        resetFrSelection();
        resetFrRenderCaches();
        resetFloatingRangeStore();
        await loadFloatingRangesFromBackend();
        setFrActiveSheetIndex(await getActiveSheet());
        syncFloatingRangeRegions();
        requestOverlayRedraw();
      })
      .catch((err) => {
        console.error("[FloatingRange] Document-change reload failed:", err);
      });
  };
  for (const evt of [AppEvents.AFTER_OPEN, AppEvents.AFTER_NEW] as const) {
    cleanupFns.push(context.events.on(evt, reloadForNewDocument));
  }

  /**
   * SHEET_CHANGED. Two kinds arrive here: a GENUINE switch (it names the new
   * sheet) and a detail-less STRUCTURAL announcement (the Shell fans the
   * `sheets` refresh domain out to it: a script, MCP, an undo, an application
   * pull, "Detach all") that usually leaves the active sheet where it was.
   * "Did the sheet change" decides everything:
   *   - a genuine switch COMMITS an open edit at once, before any await --
   *     never cancels it (a plain value left by a tab click is Excel's
   *     commit), and never a half-typed formula on a background pull;
   *   - while an edit is PARKED the backend's active sheet is the VIEWED one
   *     by design: the ranges are re-read but the host sheet is kept, or the
   *     host's ranges would be re-filtered away under the parked edit.
   */
  const resyncForSheetChange = (payload?: unknown) => {
    const detail = (payload ?? {}) as { sheetIndex?: unknown };
    const shown = getParkedViewSheetIndex() ?? getFrActiveSheetIndex();
    if (typeof detail.sheetIndex === "number" && detail.sheetIndex !== shown) {
      if (isFrEditorOpen()) void commitFrEditor(null);
      clearLocalSelection();
    }
    reloadQueue = reloadQueue
      .then(async () => {
        const next = await getActiveSheet();
        const viewed = getParkedViewSheetIndex();
        if (viewed !== null && next === viewed) {
          await loadFloatingRangesFromBackend();
          invalidateAllFrExtents();
          syncFloatingRangeRegions();
          requestOverlayRedraw();
          return;
        }
        if (next === getFrActiveSheetIndex()) return;
        if (isFrEditorOpen()) void commitFrEditor(null);
        resetFrSelection();
        setFrActiveSheetIndex(next);
        // Store holds ALL sheets (Charts model) — a switch only re-filters.
        // Host/backing indexes may have shifted (sheet add/delete), so re-read.
        await loadFloatingRangesFromBackend();
        // The content extents were read by backing-sheet INDEX (frExtent.ts),
        // so they are re-read too; each stays in force until its re-read
        // lands. The session scroll is untouched -- a switch keeps it.
        invalidateAllFrExtents();
        syncFloatingRangeRegions();
        requestOverlayRedraw();
      })
      .catch((err) => {
        console.error("[FloatingRange] Sheet-change re-sync failed:", err);
      });
  };
  cleanupFns.push(context.events.on(AppEvents.SHEET_CHANGED, resyncForSheetChange));

  // 9b. Backend rows changed underneath us (undo/redo of geometry/resize,
  //     script writes, .calp materialization): the Shell translator fans the
  //     `floatingRanges` MUTATION_REFRESH domain out to this event.
  const reloadForBackendChange = () => {
    reloadQueue = reloadQueue
      .then(async () => {
        await loadFloatingRangesFromBackend();
        // While an edit is PARKED the backend's active sheet is the VIEWED
        // one: keep the host, or the host's ranges (the parked edit's among
        // them) would be re-filtered to the viewed sheet and never
        // re-published on the way back (the return emits no SHEET_CHANGED).
        // The park is read AFTER the await: read before it, a point-mode tab
        // click whose set_active_sheet the backend answered first parked the
        // edit while this call was in flight, and the VIEWED sheet then
        // replaced the host.
        const next = await getActiveSheet();
        if (getParkedViewSheetIndex() === null) setFrActiveSheetIndex(next);
        // Prune id-keyed side state for rows that no longer exist.
        const live = new Set(getAllFloatingRanges().map((e) => e.id));
        // An edit of a range that is gone is DISCARDED (returning to its
        // sheet first when parked); the write would only be refused.
        const editing = getFrEditorCell();
        if (editing && !live.has(editing.frId)) {
          await endExternalFormulaSession("cancel");
          // The external slot may hold another editor (a pick-only chart
          // text editor), in which case the call above found no session.
          if (getFrEditorCell()?.frId === editing.frId) cancelFrEditor();
        }
        const selectedId = getSelectedFloatingRange();
        if (selectedId && !live.has(selectedId)) deselectAllFloatingRanges();
        const sel = getLocalSelection();
        if (sel && !live.has(sel.frId)) clearLocalSelection();
        // The session scroll is KEPT for every range that survived the reload
        // (an undo of a move must not jump the content back to the top).
        pruneFrScrolls(live);
        invalidateAllFrCaches();
        syncFloatingRangeRegions();
        requestOverlayRedraw();
        // A script write, an undo or a pull may have changed the selected
        // cell's content while its selection survived.
        refreshFrFormulaBarContent();
      })
      .catch((err) => {
        console.error("[FloatingRange] Backend-change reload failed:", err);
      });
  };
  cleanupFns.push(
    context.events.on(AppEvents.FLOATING_RANGES_CHANGED, reloadForBackendChange),
  );
  // An application pull, refresh or detach can add, move or remove floating
  // ranges (they travel in the .calp as floating_ranges.json): re-read.
  cleanupFns.push(context.events.on(AppEvents.PACKAGE_UPDATED, reloadForBackendChange));

  // 10. Repaint triggers (plan §2, enumerated).
  // Exact + free: a change on an FR's BACKING sheet stales exactly that FR.
  cleanupFns.push(
    context.events.on<CellValuesChangedPayload>(
      AppEvents.CELL_VALUES_CHANGED,
      (payload) => {
        const changes = payload?.changes;
        if (!changes || changes.length === 0) return;
        let any = false;
        for (const entry of getAllFloatingRanges()) {
          if (
            changes.some((ch) => ch.sheetIndex === entry.backingSheetIndex)
          ) {
            invalidateFrCache(entry.id);
            any = true;
          }
        }
        if (any) {
          requestOverlayRedraw();
          // The formula bar shows a selected cell's content too.
          refreshFrFormulaBarContent();
        }
      },
    ),
  );

  // Coarse safety net: any cell change anywhere stales every FR cache (the
  // refetch is lazy and only for on-screen FRs). A cell commit announces
  // itself here (`updateFloatingRangeCell`), so this also refreshes what the
  // formula bar shows for the selected cell.
  cleanupFns.push(
    context.events.on(AppEvents.CELLS_UPDATED, () => {
      if (getAllFloatingRanges().length === 0) return;
      invalidateAllFrCaches();
      requestOverlayRedraw();
      refreshFrFormulaBarContent();
    }),
  );

  // grid:refresh = "re-fetch cell content" — stale-all + redraw. A rename and
  // a formula rewrite announce themselves only here.
  const onGridDataRefresh = () => {
    if (getAllFloatingRanges().length === 0) return;
    invalidateAllFrCaches();
    requestOverlayRedraw();
    refreshFrFormulaBarContent();
  };
  window.addEventListener("grid:refresh", onGridDataRefresh);
  cleanupFns.push(() => window.removeEventListener("grid:refresh", onGridDataRefresh));

  // 11. Flush pending debounced geometry saves before a file save.
  cleanupFns.push(
    context.events.on(AppEvents.BEFORE_SAVE, () => {
      void flushPendingFloatingRangeSaves();
    }),
  );
}

function deactivate(): void {
  // An edit PARKED on another sheet (a formula picking a reference there):
  // tearing the editor down unregisters the session, which clears the park
  // WITHOUT returning -- the grid stayed on the viewed sheet with every
  // family's HOST objects painted over it until the next switch (E6). Start
  // the return first (the host is captured now; the switch lands after this
  // synchronous teardown), then discard the edit as before.
  if (isFrEditorOpen() && isExternalSessionParked()) {
    void returnParkedViewToHost().catch((err) => {
      console.error("[FloatingRange] could not return to the edit's sheet on deactivate:", err);
    });
  }
  destroyFrEditor();
  for (let i = cleanupFns.length - 1; i >= 0; i--) {
    try {
      cleanupFns[i]();
    } catch (error) {
      console.error("[FloatingRange] Error during cleanup:", error);
    }
  }
  cleanupFns.length = 0;
  resetFrSelection();
  resetFrRenderCaches();
  resetFloatingRangeStore();
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.floating-range",
    name: "Floating Range",
    version: "1.0.0",
    apiVersion: "^1.0.0",
    description:
      "Free-floating objects whose content is a real range of cells, referenced like a sheet (=Float1!A1).",
  },
  activate,
  deactivate,
};

export default extension;
