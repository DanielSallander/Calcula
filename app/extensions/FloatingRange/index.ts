//! FILENAME: app/extensions/FloatingRange/index.ts
// PURPOSE: Floating Range extension — a shape-like object whose content is a
//          REAL range of cells (hidden backing sheet), referenced like a sheet
//          (=Float1!A1). Registers the overlay, the floatingObject:* handlers,
//          the capture-phase keyboard, Insert/context menus, the properties
//          dialog, the @api/floatingRangeService provider, and the document
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
  type CellValuesChangedPayload,
} from "@api";
import { getActiveSheet } from "@api/lib";
import {
  requestOverlayRedraw,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import { confirmAsync, promptAsync } from "@api/dialogs";
import { getDesignMode, onDesignModeChange } from "@api/designMode";
import { getGridStateSnapshot, rowHeaderGutter, colHeaderGutter } from "@api/grid";
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
  getFloatingRangeCells,
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
  moveFloatingRange,
  toInfo,
  setFrActiveSheetIndex,
  getFrActiveSheetIndex,
  syncFloatingRangeRegions,
  flushPendingFloatingRangeSaves,
  type FloatingRangeEntry,
} from "./lib/floatingRangeStore";
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
  localSelectionRect,
  moveLocalSelection,
  resetFrSelection,
} from "./lib/frSelection";
import {
  renderFloatingRange,
  hitTestFloatingRange,
  getFrCursor,
  invalidateFrCache,
  invalidateAllFrCaches,
  removeFrFromCache,
  resetFrRenderCaches,
  setFrResizeGhost,
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
  buildFrContextMenu,
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

/** Double-click detection: Core dispatches no dblclick to overlays, so two
 *  bodyDragStart hits on the same local cell within 350 ms open the editor. */
let lastBodyDown: { frId: string; row: number; col: number; time: number } | null =
  null;

/** Active drag teardown — cell drag-extend OR edge resize (also run on
 *  deactivate). One slot, because the two can never be live at once. */
let activeDragCleanup: (() => void) | null = null;

/**
 * True while an edge-handle resize owns the mouse.
 *
 * Core consults `claimsBodyDrag` and then, on a claim, dispatches
 * `floatingObject:bodyDragStart` SYNCHRONOUSLY in the same mousedown. So the
 * edge drag is already installed by the time `handleBodyDragStart` runs — and
 * that function opens its own drag by calling `activeDragCleanup?.()`, which
 * would remove the edge drag's listeners before its first mousemove and leave
 * the yellow ball looking inert. This flag is how the second handler knows the
 * first one already took the gesture.
 */
let edgeResizeActive = false;

// ============================================================================
// Geometry helpers
// ============================================================================

/** Frame's logical canvas bounds from live grid state (headings-gutter aware —
 *  never `?? 50`). Null when grid state is not initialized. */
function frameCanvasBounds(
  entry: FloatingRangeEntry,
): { x: number; y: number; width: number; height: number } | null {
  const state = getGridStateSnapshot();
  if (!state) return null;
  const rhw = rowHeaderGutter(state.config);
  const chh = colHeaderGutter(state.config);
  return {
    x: rhw + entry.x - state.viewport.scrollX,
    y: chh + entry.y - state.viewport.scrollY,
    width: frameWidth(entry),
    height: frameHeight(entry),
  };
}

/** Client (mouse) coordinates -> zoom-corrected logical canvas coordinates —
 *  the same basis Core hands claimsBodyDrag/bodyDragStart. */
function clientToCanvas(clientX: number, clientY: number): { x: number; y: number } | null {
  const layer = document.querySelector("[data-grid-canvas-layer]");
  if (!layer) return null;
  const rect = layer.getBoundingClientRect();
  const zoom = getGridStateSnapshot()?.zoom ?? 1;
  return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
}

/**
 * The floating range whose FRAME contains a logical-canvas point, or null.
 * Active sheet only (that is what publishes regions), last one first so the
 * topmost of two overlapping frames wins — the same order Core's own
 * `findFloatingRegionAt` walks.
 */
function frameAtCanvasPoint(
  canvasX: number,
  canvasY: number,
): FloatingRangeEntry | null {
  const active = getAllFloatingRanges().filter(
    (e) => e.sheetIndex === getFrActiveSheetIndex(),
  );
  for (let i = active.length - 1; i >= 0; i--) {
    const entry = active[i];
    const b = frameCanvasBounds(entry);
    if (!b) continue;
    if (
      canvasX >= b.x &&
      canvasX <= b.x + b.width &&
      canvasY >= b.y &&
      canvasY <= b.y + b.height
    ) {
      return entry;
    }
  }
  return null;
}

/** Clamp a frame-relative point into the cells area and resolve its cell. */
function clampedCellFromFramePoint(
  entry: FloatingRangeEntry,
  dx: number,
  dy: number,
): { row: number; col: number } {
  const minX = frRowHdrW(entry);
  const minY = frCellsTop(entry);
  const cx = Math.min(Math.max(dx, minX), frameWidth(entry) - 0.01);
  const cy = Math.min(Math.max(dy, minY), frameHeight(entry) - 0.01);
  const hit = localCellFromPoint(entry, cx, cy);
  if (hit.zone === "cells") return { row: hit.row, col: hit.col };
  return { row: 0, col: 0 };
}

function externalTargetExpecting(): boolean {
  return getExternalFormulaTarget()?.isExpectingReference() === true;
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

async function resizeFr(
  frId: string,
  rows: number,
  cols: number,
  x?: number,
  y?: number,
): Promise<FloatingRangeInfo> {
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

/** Clear the CONTENT of the local selection (only cells that actually hold
 *  something — the read bounds the write batch). Undoable per cell. */
async function clearLocalSelectionCells(frId: string): Promise<void> {
  const entry = getFloatingRangeById(frId);
  const sel = getLocalSelection();
  if (!entry || !sel || sel.frId !== frId) return;
  const rect = localSelectionRect(sel);
  const maxRow = Math.min(rect.maxRow, entry.rows - 1);
  const maxCol = Math.min(rect.maxCol, entry.cols - 1);
  try {
    const cells = await getFloatingRangeCells(
      frId,
      rect.minRow,
      rect.minCol,
      maxRow,
      maxCol,
    );
    for (const cell of cells) {
      if (cell.type === "empty" && !cell.formula) continue;
      await updateFloatingRangeCell(frId, cell.row, cell.col, "");
    }
  } catch (err) {
    console.error("[FloatingRange] Clear cells failed:", err);
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
  const baseSizes =
    axis === "cols"
      ? trackedColIndices(entry).map((c) => frColWidth(entry, c))
      : trackedRowIndices(entry).map((r) => frRowHeight(entry, r));
  const min = axis === "cols" ? FLOATING_RANGE_MIN_COL_W : FLOATING_RANGE_MIN_ROW_H;
  const max = axis === "cols" ? FLOATING_RANGE_MAX_COL_W : FLOATING_RANGE_MAX_ROW_H;

  if (baseExtent <= 0) return;

  const applyScale = (scale: number) => {
    const live = getFloatingRangeById(frId);
    if (!live) return;
    // Restore the baseline first: the scale is always measured from the drag's
    // START, never compounded onto the previous frame.
    live.colWidths = { ...baseWidths };
    live.rowHeights = { ...baseHeights };
    if (axis === "cols") live.colWidths = scaledColWidths(live, scale);
    else live.rowHeights = scaledRowHeights(live, scale);
    if (movesOrigin) {
      // The dragged edge moves; the opposite one stays where it was.
      if (axis === "cols") live.x = Math.max(0, baseX + baseFrameW - frameWidth(live));
      else live.y = Math.max(0, baseY + baseFrameH - frameHeight(live));
    }
    syncFloatingRangeRegions();
    requestOverlayRedraw();
  };

  let lastScale = 1;

  const onMove = (ev: MouseEvent) => {
    const canvas = clientToCanvas(ev.clientX, ev.clientY);
    if (!canvas) return;
    const delta =
      axis === "cols" ? canvas.x - startCanvasX : canvas.y - startCanvasY;
    // Dragging the left/top edge outward means a NEGATIVE delta grows the
    // object, so the sign flips for the origin-moving edges.
    const grow = movesOrigin ? -delta : delta;
    lastScale = clampScaleFactor(baseSizes, (baseExtent + grow) / baseExtent, min, max);
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
      console.error("[FloatingRange] Cell resize failed:", err);
      // The optimistic local scale is now a lie; the backend is the authority.
      void loadFloatingRangesFromBackend().then(() => {
        syncFloatingRangeRegions();
        requestOverlayRedraw();
      });
    });
  };

  activeDragCleanup?.();
  edgeResizeActive = true;
  activeDragCleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", finish);
    activeDragCleanup = null;
    edgeResizeActive = false;
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", finish);
}

// ============================================================================
// claimsBodyDrag — the zone router (and the M7 formula-mode branch)
// ============================================================================

function claimsBodyDrag(ctx: OverlayHitTestContext): boolean {
  const frId = ctx.region.data?.frId as string | undefined;
  if (!frId || !ctx.floatingCanvasBounds) return false;
  const entry = getFloatingRangeById(frId);
  if (!entry) return false;

  const dx = ctx.canvasX - ctx.floatingCanvasBounds.x;
  const dy = ctx.canvasY - ctx.floatingCanvasBounds.y;
  const hit = localCellFromPoint(entry, dx, dy);

  // Formula-reference picking (M7): a click on an FR cell while ANY editor
  // expects a reference inserts "Name!A1" instead of selecting/moving. The
  // external target (an open FR editor) wins over the grid editor; self-
  // reference is legal — cycles are the engine's job.
  const extExpecting = externalTargetExpecting();
  const gridExpecting = isGlobalFormulaMode();
  if (extExpecting || gridExpecting) {
    if (hit.zone === "cells") {
      if (extExpecting) {
        getExternalFormulaTarget()?.insertReference({
          sheetName: entry.name,
          startRow: hit.row,
          startCol: hit.col,
          endRow: hit.row,
          endCol: hit.col,
        });
      } else {
        insertTextIntoActiveFormula(buildQualifiedRef(entry.name, hit.row, hit.col));
      }
    }
    // Claim regardless of zone: in formula mode a click must never select or
    // move the object (accepted, Excel-like).
    return true;
  }

  // The FR's commit-before-select. This is the ONE mousedown hook Core calls
  // for every zone — including the title bar, which dispatches no
  // bodyDragStart — so it is the only place that can cover all of them.
  commitFrEditorBeforeSelect(
    frId,
    hit.zone === "cells" ? { row: hit.row, col: hit.col } : null,
  );

  // Edge handles: scale the CELLS. Checked before the zone router because a
  // handle sits ON the frame border, where the zone underneath it would
  // otherwise answer "cells" or "rowHeader". Design mode only, and gated on
  // the same `resizable` flag Core reads for the corner handles — so the ball
  // is never grabbable in a mode where it is not painted.
  if (ctx.region.data?.resizable === true) {
    const edge = frEdgeHandleAt(entry, dx, dy);
    if (edge) {
      startEdgeResizeDrag(entry, edge, ctx.canvasX, ctx.canvasY);
      return true;
    }
  }

  // The handles' hit radius reaches a few pixels PAST the frame (see
  // hitTestFloatingRange), so a near-miss lands here with no zone. Claim it and
  // do nothing: falling through would start a move from outside the object.
  if (hit.zone === "outside") return true;

  // Title bar: Core runs the normal move path (floatingObject:selected has
  // already been dispatched, so the object still gets selected).
  if (hit.zone === "title") return false;

  // No title bar = no grab zone. Rather than leave the object strandable,
  // DESIGN MODE takes the whole body as the move handle — the Charts/Controls
  // convention for an object with no title. Run mode is unchanged: the body
  // still selects and edits cells, which is the working-surface doctrine in
  // syncFloatingRangeRegions. Gated on `movable` (which the store publishes
  // from the design-mode state) so the claim can never hand Core a drag it
  // will refuse, leaving the click doing nothing at all.
  if (!entry.showTitle && ctx.region.data?.movable === true) return false;

  // Headers + cells: the FR owns the interaction (local selection).
  return true;
}

// ============================================================================
// floatingObject:* handlers
// ============================================================================

function setupFloatingObjectEvents(): void {
  const handleSelected = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) return;
    // A ref-pick click must not also select the object.
    if (isGlobalFormulaMode() || externalTargetExpecting()) return;
    const frId = detail.data?.frId as string | undefined;
    if (!frId) return;
    const sel = getLocalSelection();
    if (sel && sel.frId !== frId) clearLocalSelection();
    selectFloatingRange(frId);
    requestOverlayRedraw();
  };
  window.addEventListener("floatingObject:selected", handleSelected);
  cleanupFns.push(() =>
    window.removeEventListener("floatingObject:selected", handleSelected),
  );

  const handleMovePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) return;
    const frId = detail.data?.frId as string | undefined;
    if (!frId) return;
    moveFloatingRange(frId, detail.x as number, detail.y as number);
    syncFloatingRangeRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:movePreview", handleMovePreview);
  cleanupFns.push(() =>
    window.removeEventListener("floatingObject:movePreview", handleMovePreview),
  );

  const handleMoveComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) return;
    const frId = detail.data?.frId as string | undefined;
    if (!frId) return;
    // Same store write; the 300 ms debounce coalesces preview + complete into
    // one undoable update_floating_range.
    moveFloatingRange(frId, detail.x as number, detail.y as number);
    syncFloatingRangeRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:moveComplete", handleMoveComplete);
  cleanupFns.push(() =>
    window.removeEventListener("floatingObject:moveComplete", handleMoveComplete),
  );

  // --------------------------------------------------------------------------
  // Corner resize is REINTERPRETED as a quantized count change (M8): the ghost
  // snaps to whole rows/cols; resizeComplete converts the final rect to counts
  // and adjusts x/y so the visually fixed corner stays put. Raw w/h is NEVER
  // persisted.
  // --------------------------------------------------------------------------
  const quantize = (
    entry: FloatingRangeEntry,
    detail: { x: number; y: number; width: number; height: number },
  ) => {
    const counts = bestCountsForSize(entry, detail.width, detail.height);
    const snapped = frameSizeForCounts(entry, counts.rows, counts.cols);
    // Left/top edge moved => the OPPOSITE edge is the fixed one.
    const leftDragged = Math.abs(detail.x - entry.x) > 0.5;
    const topDragged = Math.abs(detail.y - entry.y) > 0.5;
    const x = leftDragged
      ? Math.max(0, entry.x + frameWidth(entry) - snapped.width)
      : entry.x;
    const y = topDragged
      ? Math.max(0, entry.y + frameHeight(entry) - snapped.height)
      : entry.y;
    return { ...counts, x, y, width: snapped.width, height: snapped.height };
  };

  const handleResizePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) return;
    const frId = detail.data?.frId as string | undefined;
    const entry = frId ? getFloatingRangeById(frId) : null;
    if (!frId || !entry) return;
    const q = quantize(entry, detail as { x: number; y: number; width: number; height: number });
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
    const q = quantize(entry, detail as { x: number; y: number; width: number; height: number });
    if (q.rows === entry.rows && q.cols === entry.cols && q.x === entry.x && q.y === entry.y) {
      requestOverlayRedraw();
      return;
    }
    void resizeFr(frId, q.rows, q.cols, q.x, q.y).catch((err) => {
      console.error("[FloatingRange] Resize failed:", err);
      syncFloatingRangeRegions();
      requestOverlayRedraw();
    });
  };
  window.addEventListener("floatingObject:resizeComplete", handleResizeComplete);
  cleanupFns.push(() =>
    window.removeEventListener("floatingObject:resizeComplete", handleResizeComplete),
  );

  // --------------------------------------------------------------------------
  // Body drag: local cell selection + drag-extend + dblclick-by-timestamp.
  // --------------------------------------------------------------------------
  const handleBodyDragStart = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) return;
    // The ref-pick claim also dispatches bodyDragStart; insertion already
    // happened inside claimsBodyDrag, so there is nothing to select here.
    if (isGlobalFormulaMode() || externalTargetExpecting()) return;
    const frId = detail.data?.frId as string | undefined;
    const entry = frId ? getFloatingRangeById(frId) : null;
    if (!frId || !entry) return;
    const bounds = frameCanvasBounds(entry);
    if (!bounds) return;

    // An edge-handle drag already claimed this very mousedown (see
    // `edgeResizeActive`). Everything below would move the local selection and
    // then tear that drag down again.
    if (edgeResizeActive) return;

    const dx = (detail.canvasX as number) - bounds.x;
    const dy = (detail.canvasY as number) - bounds.y;
    const hit = localCellFromPoint(entry, dx, dy);
    if (hit.zone === "outside" || hit.zone === "title") return;

    // Zone -> initial local selection.
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
      endCol = entry.cols - 1;
    } else if (hit.zone === "colHeader") {
      anchorCol = endCol = hit.col;
      anchorRow = 0;
      endRow = entry.rows - 1;
    }

    // Double-click = two bodyDragStart on the same cell within 350 ms.
    if (hit.zone === "cells") {
      const now = performance.now();
      if (
        lastBodyDown &&
        lastBodyDown.frId === frId &&
        lastBodyDown.row === hit.row &&
        lastBodyDown.col === hit.col &&
        now - lastBodyDown.time < 350
      ) {
        lastBodyDown = null;
        setLocalSelection({ frId, anchorRow, anchorCol, endRow, endCol });
        openFrEditor(frId, hit.row, hit.col, null);
        return;
      }
      lastBodyDown = { frId, row: hit.row, col: hit.col, time: now };
    } else {
      lastBodyDown = null;
    }

    setLocalSelection({ frId, anchorRow, anchorCol, endRow, endCol });
    requestOverlayRedraw();

    // Drag-extend via window listeners (Charts brush precedent).
    activeDragCleanup?.();
    const onMove = (ev: MouseEvent) => {
      const canvas = clientToCanvas(ev.clientX, ev.clientY);
      const liveEntry = getFloatingRangeById(frId);
      const liveBounds = liveEntry ? frameCanvasBounds(liveEntry) : null;
      const sel = getLocalSelection();
      if (!canvas || !liveEntry || !liveBounds || !sel || sel.frId !== frId) return;
      const cell = clampedCellFromFramePoint(
        liveEntry,
        canvas.x - liveBounds.x,
        canvas.y - liveBounds.y,
      );
      if (cell.row !== sel.endRow || cell.col !== sel.endCol) {
        sel.endRow = cell.row;
        sel.endCol = cell.col;
        requestOverlayRedraw();
      }
    };
    const onUp = () => activeDragCleanup?.();
    activeDragCleanup = () => {
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

function handleFrKeyDown(e: KeyboardEvent): void {
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

    switch (e.key) {
      case "ArrowUp":
        swallow();
        moveLocalSelection(-1, 0, e.shiftKey, entry.rows, entry.cols);
        requestOverlayRedraw();
        return;
      case "ArrowDown":
        swallow();
        moveLocalSelection(1, 0, e.shiftKey, entry.rows, entry.cols);
        requestOverlayRedraw();
        return;
      case "ArrowLeft":
        swallow();
        moveLocalSelection(0, -1, e.shiftKey, entry.rows, entry.cols);
        requestOverlayRedraw();
        return;
      case "ArrowRight":
        swallow();
        moveLocalSelection(0, 1, e.shiftKey, entry.rows, entry.cols);
        requestOverlayRedraw();
        return;
      case "Enter":
        swallow();
        moveLocalSelection(e.shiftKey ? -1 : 1, 0, false, entry.rows, entry.cols);
        requestOverlayRedraw();
        return;
      case "Tab":
        swallow();
        moveLocalSelection(0, e.shiftKey ? -1 : 1, false, entry.rows, entry.cols);
        requestOverlayRedraw();
        return;
      case "Escape":
        swallow();
        // Drop the LOCAL selection; the object stays selected.
        clearLocalSelection();
        requestOverlayRedraw();
        return;
      case "F2":
        swallow();
        openFrEditor(sel.frId, sel.anchorRow, sel.anchorCol, null);
        return;
      case "Delete":
      case "Backspace":
        // Internal selection ALWAYS wins over object delete (explicit guard).
        swallow();
        void clearLocalSelectionCells(sel.frId);
        return;
      default:
        // Type-to-edit: a printable character opens the editor seeded with it.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          swallow();
          openFrEditor(sel.frId, sel.anchorRow, sel.anchorCol, e.key);
        }
        return;
    }
  }

  // Object selected, NO local cell selection: Delete removes the OBJECT
  // (confirmed — delete ends the undo history).
  const objId = getSelectedFloatingRange();
  if (objId && (e.key === "Delete" || e.key === "Backspace")) {
    e.preventDefault();
    e.stopPropagation();
    void confirmAndDeleteFr(objId);
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  // 1. Overlay registration (priority 13: above Controls 12, below Charts 15).
  cleanupFns.push(
    context.grid.overlays.register({
      type: FLOATING_RANGE_REGION_TYPE,
      render: renderFloatingRange,
      hitTest: hitTestFloatingRange,
      getCursor: getFrCursor,
      claimsBodyDrag,
      priority: 13,
    }),
  );

  // 2. floatingObject:* wiring.
  setupFloatingObjectEvents();

  // 3. Capture-phase keyboard.
  window.addEventListener("keydown", handleFrKeyDown, true);
  cleanupFns.push(() =>
    window.removeEventListener("keydown", handleFrKeyDown, true),
  );

  // 3b. Design mode gates move/resize (the BUTTON rule — see
  // syncFloatingRangeRegions). The flags live on the published regions, so a
  // toggle must re-publish them or the change waits for the next unrelated
  // sync; the redraw repaints the frames so any design-only chrome follows.
  cleanupFns.push(
    onDesignModeChange(() => {
      syncFloatingRangeRegions();
      requestOverlayRedraw();
    }),
  );

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
  //    DESIGN MODE gates it, for the same reason it gates move and resize: the
  //    items here are AUTHORING acts on the object (grow it, rename it, delete
  //    it, change its chrome), while run mode treats the range as a working
  //    surface whose cells select and edit.
  const menuHandlers: FrContextMenuHandlers = {
    addRow: (frId) => {
      const entry = getFloatingRangeById(frId);
      if (entry) void resizeFr(frId, entry.rows + 1, entry.cols);
    },
    addColumn: (frId) => {
      const entry = getFloatingRangeById(frId);
      if (entry) void resizeFr(frId, entry.rows, entry.cols + 1);
    },
    deleteLastRow: (frId) => {
      const entry = getFloatingRangeById(frId);
      if (entry && entry.rows > 1) void resizeFr(frId, entry.rows - 1, entry.cols);
    },
    deleteLastColumn: (frId) => {
      const entry = getFloatingRangeById(frId);
      if (entry && entry.cols > 1) void resizeFr(frId, entry.rows, entry.cols - 1);
    },
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
    if (e.shiftKey) return; // Shift+right-click = the browser's own menu
    if (!getDesignMode()) return;

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
    const entry = frameAtCanvasPoint(point.x, point.y);
    if (!entry) return;

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
      getCells: (id, startRow, startCol, endRow, endCol) =>
        getFloatingRangeCells(id, startRow, startCol, endRow, endCol),
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
      if (sig !== lastSelectionSig) {
        lastSelectionSig = sig;
        // Same commit-before-select rule, for the click that lands on an
        // ORDINARY grid cell: that mousedown is preventDefault'd too, so the
        // editor would otherwise sit open over a grid the user has moved on
        // from. Never while a reference is being picked — that click is
        // FEEDING the editor, and the grid selection does not move for it.
        if (isFrEditorOpen() && !externalTargetExpecting()) {
          void commitFrEditor(null);
        }
        deselectAllFloatingRanges();
        clearLocalSelection();
        requestOverlayRedraw();
      }
    }),
  );

  // 9. Document lifecycle — ONE serialized queue (Controls precedent): the
  //    startup load is the first link, so a reload can never race it.
  let reloadQueue: Promise<void> = (async () => {
    await loadFloatingRangesFromBackend();
    setFrActiveSheetIndex(await getActiveSheet());
    syncFloatingRangeRegions();
  })().catch((err) => {
    console.error("[FloatingRange] Initial load failed:", err);
  });

  const reloadForNewDocument = () => {
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

  const resyncForSheetChange = () => {
    reloadQueue = reloadQueue
      .then(async () => {
        const next = await getActiveSheet();
        if (next === getFrActiveSheetIndex()) return;
        cancelFrEditor();
        resetFrSelection();
        setFrActiveSheetIndex(next);
        // Store holds ALL sheets (Charts model) — a switch only re-filters.
        // Host/backing indexes may have shifted (sheet add/delete), so re-read.
        await loadFloatingRangesFromBackend();
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
        setFrActiveSheetIndex(await getActiveSheet());
        // Prune id-keyed side state for rows that no longer exist.
        const live = new Set(getAllFloatingRanges().map((e) => e.id));
        const selectedId = getSelectedFloatingRange();
        if (selectedId && !live.has(selectedId)) deselectAllFloatingRanges();
        const sel = getLocalSelection();
        if (sel && !live.has(sel.frId)) clearLocalSelection();
        invalidateAllFrCaches();
        syncFloatingRangeRegions();
        requestOverlayRedraw();
      })
      .catch((err) => {
        console.error("[FloatingRange] Backend-change reload failed:", err);
      });
  };
  cleanupFns.push(
    context.events.on(AppEvents.FLOATING_RANGES_CHANGED, reloadForBackendChange),
  );

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
        if (any) requestOverlayRedraw();
      },
    ),
  );

  // Coarse safety net: any cell change anywhere stales every FR cache (the
  // refetch is lazy and only for on-screen FRs).
  cleanupFns.push(
    context.events.on(AppEvents.CELLS_UPDATED, () => {
      if (getAllFloatingRanges().length === 0) return;
      invalidateAllFrCaches();
      requestOverlayRedraw();
    }),
  );

  // grid:refresh = "re-fetch cell content" — stale-all + redraw.
  const onGridDataRefresh = () => {
    if (getAllFloatingRanges().length === 0) return;
    invalidateAllFrCaches();
    requestOverlayRedraw();
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
