//! FILENAME: app/extensions/Pivot/lib/pivotVisualOverlay.ts
// PURPOSE: The `pivot-visual` floating object: a canvas pivot shown in its
//          designer-sized box. Registers the overlay (paint, hit test, the ONE
//          zone answer, double-click), keeps the chrome's hover highlight, and
//          wires the floating-object events (select, move, resize, chrome
//          press), the object-selection provider and the wheel target.
//          The chrome (+/-, report filter, Row/Column Labels button, Cancel)
//          ACTS ON RELEASE over the same piece of chrome (BUG-0258 design
//          phase 4, D5): the press only starts `beginPivotChromePress`
//          (pivotChromePress.ts); sliding off cancels.
//          While a formula picks a reference (D-PICK) the box answers
//          `referenceAt` -- the hidden-grid cell under the point -- and Core
//          turns the press into the pick before anything selects; a pick
//          drag across the box is painted dashed here.
//          The box's CELLS are content (D-CELLS): a press selects them
//          (pivotCellPress.ts, the store in pivotVisualCellSelection.ts) and
//          the selection is painted here; the box moves by its 4px border
//          band, blank area past the content, Core's hover grip, or -- in
//          Design Mode -- its whole body.
//          THE CONTAINER (WP-C D-FORMAT): Core paints the box's visual
//          container (shadow, background, title bands, border) around this
//          render; the cells are laid out, painted, scrolled and hit-tested
//          inside its CONTENT rect (`visualContentRectFor`, the one Core's
//          zone band and paint use -- paint == hit), clipped by
//          `withContainerContentClip`. The box paints no fill or outline of
//          its own: one owner of the box background (review R1-8).
// CONTEXT: Snap, the page clamp and consume mode (a subscribed canvas) are
//          applied by the Core through @api/layoutSurface before any of the
//          move/resize events below are dispatched -- nothing here
//          re-implements them. A frame edit is persisted through
//          `update_pivot_properties({pivotId, canvasFrame})`, undoable on the
//          backend side; the cells do not change, so no pivot refresh follows.

import { showToast } from "@api";
import {
  getFloatingReferencePickPreview,
  getGridRegions,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlaySheetToCanvas,
  requestOverlayRedraw,
  topFloatingRegionAtClient,
  type GridRegion,
  type OverlayHitTestContext,
  type OverlayReferencePick,
  type OverlayRegistration,
  type OverlayRenderContext,
  type OverlayZone,
} from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/grid";
import { isFormulaReferencePickActive } from "@api/editing";
import { drawObjectScriptBadgeIfPresent } from "@api/objectScriptBadge";
import { visualContentRectFor, withContainerContentClip, type ContainerRegion } from "@api/visualContainerPaint";
import type { DimensionOverrides } from "@api/types";
import { registerObjectWheelTarget } from "../../_shared/lib/objectWheelScroll";
import { paintInnerSelection, paintPickPreview, type PaintRect } from "../../_shared/lib/innerSelectionPaint";
import { PivotEvents } from "../../_shared/lib/pivotEvents";
import { getDesignMode, onDesignModeChange } from "@api/designMode";
import type { PivotViewResponse } from "./pivot-api";
import { deletePivotTable, getPivotCellWindow, updatePivotProperties } from "./pivot-api";
import { joinUndoTransaction, registerObjectGeometryProvider } from "@api/objectGeometry";
import {
  createPivotVisualGeometryProvider,
  trackPivotFrameSave,
  type PivotFrameSave,
} from "./pivotVisualGeometry";
import {
  deleteCachedPivotView,
  getCellWindowCache,
  ensureCellWindow,
  isLoading,
  getLoadingState,
} from "./pivotViewStore";
import type { PivotTheme } from "../rendering/pivot";
import {
  buildPivotVisualGeometry,
  clampVisualScroll,
  paintPivotVisual,
  selectionPiecesInBox,
  viewColCount,
  viewRowCount,
  type PivotVisualBox,
  type PivotVisualGeometry,
} from "../rendering/pivotVisualRenderer";
import {
  paintPivotPlaceholderContent,
  paintPivotLoadingIndicator,
} from "../rendering/pivotStatusPainters";
import {
  PIVOT_VISUAL_REGION_TYPE,
  pivotIdOfVisual,
  setLiveFrame,
  commitLiveFrame,
  effectiveFrame,
  republishVisualRegions,
} from "./pivotVisualRegions";
import {
  clampPivotCellSelection,
  getPivotCellSelection,
  onPivotCellSelectionChanged,
  pivotCellRect,
  setPivotCellSheetSource,
} from "./pivotVisualCellSelection";
import { beginPivotCellPress, cancelPivotCellPress } from "./pivotCellPress";
import {
  getPivotVisualRecord,
  getPivotVisualHover,
  setPivotVisualRecord,
  setPivotVisualHover,
  hitPivotVisualChrome,
  hoverForHit,
  viewCellAtCanvasPoint,
  anyPivotVisualHover,
  pivotVisualRecordCount,
  isInsidePivotVisualBox,
  type PivotVisualChromeHit,
  type PivotVisualRecord,
} from "./pivotVisualHits";
import { getPivotVisualScroll, setPivotVisualScroll, createPivotVisualWheelTarget } from "./pivotVisualScroll";
import {
  togglePivotHeaderAt,
  openPivotReportFilterAt,
  openPivotHeaderFilter,
  cancelPivotLoading,
  getPivotViewCell,
} from "./pivotChromeActions";
import { runPivotCellDoubleClick } from "./pivotCellDoubleClick";
import {
  getDisplayedPivotView,
  getPivotCrossFilterBadge,
  onPivotFilteredViewChange,
  refuseWhileFiltered,
} from "./pivotCrossFilterView";
import { applyPivotCrossFilterClick } from "./pivotCrossFilterClick";
import { paintPivotCrossFilterBadge } from "../rendering/pivotCrossFilterBadge";
import { beginPivotChromePress, cancelPivotChromePress } from "./pivotChromePress";
import { chromeReleaseActs, forgetChromeReleases } from "./pivotChromeRepeat";
import { registerPivotVisualSelection } from "./pivotVisualSelection";
import { closePivotBoxMenu, handlePivotBoxContextMenu } from "./pivotVisualContextMenu";
import {
  selectPivotVisual,
  deselectPivotVisual,
} from "../handlers/selectionHandler";

/** What the overlay needs from the extension entry point. */
export interface PivotVisualDeps {
  /** The pivot's current style theme (the gallery hover preview wins). */
  getTheme(pivotId: string): PivotTheme;
}

/** Drawn above cell overlays and below slicers (15); z-order is M8's. */
export const PIVOT_VISUAL_PRIORITY = 12;

// ============================================================================
// Geometry cache
// ============================================================================

interface GeometryCacheEntry {
  dims: DimensionOverrides;
  frozenHeaders: boolean;
  startRow: number;
  startCol: number;
  defaultWidth: number;
  defaultHeight: number;
  geometry: PivotVisualGeometry;
}

/**
 * Per VIEW object: rebuilding the prefix sums of a windowed pivot's million
 * rows on every frame would be wasted work while nothing changed. A new view
 * (refilter, field change) or new dimensions (auto-fit wrote widths) is a new
 * key or a changed entry.
 */
const geometryCache = new WeakMap<PivotViewResponse, GeometryCacheEntry>();

function geometryFor(oc: OverlayRenderContext, region: GridRegion, view: PivotViewResponse, frozenHeaders: boolean): PivotVisualGeometry {
  const defaultWidth = oc.config.defaultCellWidth ?? 100;
  const defaultHeight = oc.config.defaultCellHeight ?? 20;
  const hit = geometryCache.get(view);
  if (
    hit &&
    hit.dims === oc.dimensions &&
    hit.frozenHeaders === frozenHeaders &&
    hit.startRow === region.startRow &&
    hit.startCol === region.startCol &&
    hit.defaultWidth === defaultWidth &&
    hit.defaultHeight === defaultHeight
  ) {
    return hit.geometry;
  }
  const geometry = buildPivotVisualGeometry(view, frozenHeaders, {
    // The canvas's own hidden grid: the pivot's auto-fit widths live there.
    columnWidth: (j) => overlayGetColumnWidth(oc, region.startCol + j),
    rowHeight: (i) => overlayGetRowHeight(oc, region.startRow + i),
  });
  geometryCache.set(view, {
    dims: oc.dimensions,
    frozenHeaders,
    startRow: region.startRow,
    startCol: region.startCol,
    defaultWidth,
    defaultHeight,
    geometry,
  });
  return geometry;
}

// ============================================================================
// Paint
// ============================================================================

/**
 * A reference pick dragging across THIS box (D-PICK): Core's pick session
 * publishes the hidden-grid rectangle it covers (`getFloatingReferencePickPreview`,
 * re-painted on every change), and the box draws it dashed over the cells it
 * names -- the same pieces a press there would name, clipped to the box.
 */
function paintPivotPickPreview(
  ctx: CanvasRenderingContext2D,
  region: GridRegion,
  box: PivotVisualBox,
  geometry: PivotVisualGeometry,
  scroll: { left: number; top: number },
): void {
  const preview = getFloatingReferencePickPreview();
  if (!preview || preview.regionId !== region.id || preview.range.space !== "sheet") return;
  const range = preview.range;
  const pieces = selectionPiecesInBox(geometry, scroll, box.width, box.height, {
    startRow: range.startRow - region.startRow,
    startCol: range.startCol - region.startCol,
    endRow: range.endRow - region.startRow,
    endCol: range.endCol - region.startCol,
  });
  if (pieces.length === 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  paintPickPreview(
    ctx,
    pieces.map((p) => ({ x: box.x + p.x, y: box.y + p.y, width: p.width, height: p.height })),
  );
  ctx.restore();
}

/**
 * The box's INNER cell selection (D-CELLS), when it is this pivot's: the
 * rectangle's pieces (one per frozen quadrant it touches, the same arithmetic a
 * press there inverts) filled except the ACTIVE cell (the anchor), bordered,
 * clipped to the box -- the one inner-selection ink a floating grid's cells
 * use too (_shared/lib/innerSelectionPaint.ts).
 */
function paintPivotCellSelection(
  ctx: CanvasRenderingContext2D,
  pivotId: string,
  box: PivotVisualBox,
  geometry: PivotVisualGeometry,
  scroll: { left: number; top: number },
): void {
  const sel = getPivotCellSelection();
  if (!sel || sel.pivotId !== pivotId) return;
  const toCanvas = (p: PaintRect): PaintRect => ({ x: box.x + p.x, y: box.y + p.y, width: p.width, height: p.height });
  const pieces = selectionPiecesInBox(geometry, scroll, box.width, box.height, pivotCellRect(sel)).map(toCanvas);
  if (pieces.length === 0) return;
  const activePieces = selectionPiecesInBox(geometry, scroll, box.width, box.height, {
    startRow: sel.anchorRow,
    startCol: sel.anchorCol,
    endRow: sel.anchorRow,
    endCol: sel.anchorCol,
  });
  const active = activePieces.length === 1 ? toCanvas(activePieces[0]) : null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  paintInnerSelection(ctx, pieces, active);
  ctx.restore();
}

/** Paint one `pivot-visual` region. Exported for tests. */
export function renderPivotVisualRegion(oc: OverlayRenderContext, deps: PivotVisualDeps): void {
  const region = oc.region;
  const f = region.floating;
  const pivotId = pivotIdOfVisual(region);
  if (!f || !pivotId) return;

  // Whole pixels: the renderer's 0.5px line snapping stays crisp at any zoom.
  const origin = overlaySheetToCanvas(oc, f.x, f.y);
  const outer: PivotVisualBox = {
    x: Math.round(origin.canvasX),
    y: Math.round(origin.canvasY),
    width: Math.max(0, Math.round(f.width)),
    height: Math.max(0, Math.round(f.height)),
  };
  // The CONTENT rect inside the container (padding, border, Core's title
  // bands): the box the cells live in. Sheet px from the one layout Core
  // painted, mapped to the canvas by the outer box's own offset.
  const content = visualContentRectFor(region.id, f, (region as ContainerRegion).container);
  const box: PivotVisualBox = {
    x: outer.x + Math.round(content.x - f.x),
    y: outer.y + Math.round(content.y - f.y),
    width: Math.max(0, Math.round(content.width)),
    height: Math.max(0, Math.round(content.height)),
  };

  const record: PivotVisualRecord = {
    pivotId,
    box,
    outer,
    bounds: null,
    cancel: null,
    geometry: null,
    scroll: getPivotVisualScroll(pivotId),
    startRow: region.startRow,
    startCol: region.startCol,
  };

  const onScreen =
    box.width > 0 &&
    box.height > 0 &&
    box.x < oc.canvasWidth &&
    box.y < oc.canvasHeight &&
    box.x + box.width > 0 &&
    box.y + box.height > 0;
  if (!onScreen) {
    setPivotVisualRecord(record);
    return;
  }

  const ctx = oc.ctx;
  const isEmpty = region.data?.isEmpty === true;
  // What the box SHOWS: the filtered view while another visual's selection
  // reaches it (P4 S7, pivotCrossFilterView.ts), else the real one.
  const view = isEmpty ? undefined : getDisplayedPivotView(pivotId);

  withContainerContentClip(ctx, region as ContainerRegion, outer, box, () => {
    if (view) {
      const frozenHeaders = region.data?.frozenHeaders === true;
      const geometry = geometryFor(oc, region, view, frozenHeaders);
      const scroll = clampVisualScroll(geometry, box.width, box.height, getPivotVisualScroll(pivotId));
      setPivotVisualScroll(pivotId, scroll);

      const windowed = view.isWindowed === true;
      const cache = windowed ? getCellWindowCache(pivotId) : undefined;
      const { bounds } = paintPivotVisual({
        ctx,
        view,
        geometry,
        box,
        scroll,
        theme: deps.getTheme(pivotId),
        getRow: windowed ? (i) => cache?.getRow(i) ?? null : undefined,
        onMissingRows: windowed
          ? (first, last) =>
              ensureCellWindow(pivotId, view.version, first, last - first + 1, getPivotCellWindow, () =>
                requestOverlayRedraw(),
              )
          : undefined,
        hover: getPivotVisualHover(pivotId),
      });
      record.bounds = bounds;
      record.geometry = geometry;
      record.scroll = scroll;
      paintPivotCellSelection(ctx, pivotId, box, geometry, scroll);
      paintPivotPickPreview(ctx, region, box, geometry, scroll);
    } else if (isEmpty) {
      // Empty pivot: the "Click in this area" hint Excel shows, on the
      // container's background (Core paints it; the box paints no fill of its
      // own). A view still on its way shows just the background.
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.width, box.height);
      ctx.clip();
      paintPivotPlaceholderContent(ctx, box, String(region.data?.name ?? ""));
      ctx.restore();
    }
  });

  // "Filtered by <source>" -- or, over the real view, "Not filtered by
  // <source>: <reason>" when the backend refused the filtered one.
  const badge = isEmpty ? null : getPivotCrossFilterBadge(pivotId);
  if (badge) paintPivotCrossFilterBadge(ctx, box, badge, deps.getTheme(pivotId));

  const loading = isLoading(pivotId) ? getLoadingState(pivotId) : undefined;
  if (loading) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();
    record.cancel = paintPivotLoadingIndicator(ctx, box, loading);
    ctx.restore();
    // Keep the bar moving while the operation runs.
    requestAnimationFrame(() => {
      if (isLoading(pivotId)) requestOverlayRedraw();
    });
  }

  setPivotVisualRecord(record);
  // The box's outline is its container's border (Core paints it, default a
  // 1 px #c8c8c8). Selected: Core paints the selection outline and the
  // handles over it (floatingObjectChrome.ts, BUG-0258 phase 3).
  // Transparency: badge a pivot that has a script attached (design mode).
  drawObjectScriptBadgeIfPresent(ctx, "pivot", pivotId, outer.x, outer.y, outer.width);
}

// ============================================================================
// Hit testing and chrome
// ============================================================================

function recordFor(hitCtx: OverlayHitTestContext): PivotVisualRecord | null {
  const pivotId = pivotIdOfVisual(hitCtx.region);
  return pivotId ? getPivotVisualRecord(pivotId) ?? null : null;
}

/** The body rectangle only (Slicer's pattern); Core has already bounds-tested. */
export function hitTestPivotVisual(hitCtx: OverlayHitTestContext): boolean {
  const b = hitCtx.floatingCanvasBounds;
  if (!b) return false;
  return (
    hitCtx.canvasX >= b.x &&
    hitCtx.canvasX <= b.x + b.width &&
    hitCtx.canvasY >= b.y &&
    hitCtx.canvasY <= b.y + b.height
  );
}

/** The band inside the box's edge that MOVES the box (its cells are content, D-CELLS). */
export const PIVOT_BOX_BORDER_BAND = 4;

/**
 * The box's ONE zone answer (BUG-0258 design phase 2), from which Core derives
 * the press, the pointer and the meaning of Ctrl/Shift. In order:
 *
 *   the CHROME (a +/-, a report-filter combo, a Row/Column Labels button, the
 *     loading indicator's Cancel)     content, a hand, part = the chrome kind
 *   outside the box                   null (frame)
 *   the 4px band inside its edge      frame, part "border" (moves the box)
 *   anywhere else, in DESIGN MODE     frame, part "bodyGrab" (the whole body
 *                                     moves it -- the Charts/Controls/
 *                                     FloatingRange convention; the chrome
 *                                     above still acts)
 *   a CELL of the view                content, cursor "cell", part "cell"
 *                                     (D-CELLS: it selects cells,
 *                                     pivotCellPress.ts)
 *   blank area past the content       frame, part "blank" (moves the box)
 *
 * Content presses go to `floatingObject:bodyDragStart` and never move the
 * box -- also on a locked box and a subscribed page (reading the report is
 * not editing it). The chrome acts when its press is RELEASED over the same
 * piece of chrome (pivotChromePress.ts; phase 4, D5). The box also moves by
 * Core's six-dot grip, published on hover (`grip: "hover"`, pivotVisualRegions.ts).
 *
 * PURE, which the old `getCursor` was not -- it wrote the hover highlight as a
 * side effect of being asked. The highlight is `updatePivotVisualHoverAt`'s.
 */
export function pivotVisualZoneAt(hitCtx: OverlayHitTestContext): OverlayZone | null {
  const record = recordFor(hitCtx);
  const x = hitCtx.canvasX;
  const y = hitCtx.canvasY;
  const hit = record ? hitPivotVisualChrome(record, x, y) : null;
  if (hit) return { kind: "content", cursor: "pointer", part: hit.kind };

  const box = hitCtx.floatingCanvasBounds ?? record?.box ?? null;
  if (!box || x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) return null;

  const band = PIVOT_BOX_BORDER_BAND;
  if (x < box.x + band || y < box.y + band || x > box.x + box.width - band || y > box.y + box.height - band) {
    return { kind: "frame", part: "border" };
  }
  // Outside the CONTENT rect (the container's padding, border and Core's
  // title bands): frame too -- Core answers that band itself before asking,
  // so this only keeps a direct caller (the double-click) on the same rule.
  if (record && !isInsidePivotVisualBox(record, x, y)) return { kind: "frame", part: "border" };
  if (hitCtx.region.data?.bodyGrab === true) return { kind: "frame", part: "bodyGrab" };

  const at = record ? viewCellAtCanvasPoint(record, x, y) : null;
  if (at) return { kind: "content", cursor: "cell", part: "cell" };
  return { kind: "frame", part: "blank" };
}

/**
 * The CELL a reference pick names at a point of the box (D-PICK,
 * `OverlayRegistration.referenceAt`): the view cell under the point, mapped to
 * the canvas's hidden-grid cell it was written to (`startRow/startCol` + the
 * view offset, so a box in column block 1 answers from column 1024 on). The
 * answer is a `sheet` pick -- the hidden grid IS the shown sheet's grid -- so
 * Core routes it exactly as a worksheet pivot pick: GETPIVOTDATA through the
 * formula-reference interceptor for a single value cell, a plain
 * `Canvas1!B5` otherwise, a range for a drag. Over the chrome (+/-, a filter
 * button) the answer is the cell beneath it: during a pick the chrome does not
 * act. Blank area past the content, an empty pivot and a view not painted yet
 * answer null (the press is inert).
 *
 * PURE, the `zoneAt` contract: reads the painted record only; no hover, no
 * selection, no dispatch.
 */
export function pivotVisualReferenceAt(hitCtx: OverlayHitTestContext): OverlayReferencePick | null {
  const record = recordFor(hitCtx);
  if (!record) return null;
  const at = viewCellAtCanvasPoint(record, hitCtx.canvasX, hitCtx.canvasY);
  if (!at) return null;
  return { space: "sheet", row: record.startRow + at.viewRow, col: record.startCol + at.viewCol };
}

/**
 * Where view cell (`viewRow`, `viewCol`) of `pivotId`'s box is SHOWN, in SHEET
 * px (the frame's page coordinates plus the box-local offset at the box's
 * last-painted geometry and scroll): only its visible part, clipped to the
 * box and its frozen quadrant; null when the cell is scrolled out of view,
 * hidden, outside the view, or the box has not been painted. For journeys
 * (`__CALCULA_PIVOT__.cellSheetRect`): the centre of the answer is a point a
 * press names that very cell at.
 */
export function pivotCellSheetRect(
  pivotId: string,
  viewRow: number,
  viewCol: number,
): { x: number; y: number; width: number; height: number } | null {
  const record = getPivotVisualRecord(pivotId);
  const frame = effectiveFrame(pivotId);
  if (!record?.geometry || !frame) return null;
  const g = record.geometry;
  if (!Number.isInteger(viewRow) || !Number.isInteger(viewCol)) return null;
  if (viewRow < 0 || viewCol < 0 || viewRow >= g.rowCount || viewCol >= g.colCount) return null;
  const pieces = selectionPiecesInBox(g, record.scroll, record.box.width, record.box.height, {
    startRow: viewRow,
    startCol: viewCol,
    endRow: viewRow,
    endCol: viewCol,
  });
  const p = pieces[0];
  if (!p) return null;
  // Box-local pieces sit in the CONTENT rect: add its offset inside the frame.
  const dx = record.outer ? record.box.x - record.outer.x : 0;
  const dy = record.outer ? record.box.y - record.outer.y : 0;
  return { x: frame.x + dx + p.x, y: frame.y + dy + p.y, width: p.width, height: p.height };
}

/**
 * A double-click inside the box. On chrome it is swallowed (the two presses
 * already acted); on a cell it maps view cell -> hidden-grid cell and runs the
 * same toggle / drill-through as a worksheet pivot. It acts only where a press
 * would select a CELL (`pivotVisualZoneAt` answers content "cell"): on the 4px
 * border band, on blank area and on the Design-Mode body grab -- the places
 * whose press MOVES the box -- it is inert, so a double-click aimed at the
 * frame never drills a cell the user did not aim at. Always true inside the
 * box: a canvas has no cell editor to fall through to.
 */
export function pivotVisualDoubleClick(hitCtx: OverlayHitTestContext): boolean {
  const record = recordFor(hitCtx);
  if (!record) return false;
  if (!isInsidePivotVisualBox(record, hitCtx.canvasX, hitCtx.canvasY)) return false;
  if (hitPivotVisualChrome(record, hitCtx.canvasX, hitCtx.canvasY)) return true;

  const zone = pivotVisualZoneAt(hitCtx);
  if (zone?.kind !== "content" || zone.part !== "cell") return true;

  const at = viewCellAtCanvasPoint(record, hitCtx.canvasX, hitCtx.canvasY);
  if (!at) return true;
  // A filtered box shows cells of a transient view: drilling or toggling
  // the REAL cell at those coordinates would act on a cell the user never saw.
  if (refuseWhileFiltered(record.pivotId)) return true;
  const cell = getPivotViewCell(record.pivotId, at.viewRow, at.viewCol);
  if (!cell) return true;
  runPivotCellDoubleClick(
    record.pivotId,
    cell,
    record.startRow + at.viewRow,
    record.startCol + at.viewCol,
    at.viewCol,
  );
  return true;
}

/** Convert a logical canvas point to a CLIENT point (menu anchors). */
function clientPointOf(canvasX: number, canvasY: number): { x: number; y: number } {
  const area = document.querySelector("[data-grid-area]") as HTMLElement | null;
  const zoom = getGridStateSnapshot()?.zoom || 1;
  const rect = area?.getBoundingClientRect();
  return {
    x: (rect?.left ?? 0) + canvasX * zoom,
    y: (rect?.top ?? 0) + canvasY * zoom,
  };
}

/**
 * The inverse: a CLIENT point in logical canvas px (Core's basis: the grid
 * area's top-left, divided by the zoom); null before the grid mounts. The
 * chrome press converts its release point with it.
 */
function canvasPointOf(clientX: number, clientY: number): { x: number; y: number } | null {
  const area = document.querySelector("[data-grid-area]") as HTMLElement | null;
  if (!area) return null;
  const zoom = getGridStateSnapshot()?.zoom || 1;
  const rect = area.getBoundingClientRect();
  return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
}

/**
 * Which piece of chrome a hit is: the pivot, the kind, and the icon / field /
 * header button. A press acts only when it is released over the chrome with
 * the SAME key (pivotChromePress.ts), and the double-click guard compares it.
 */
export function pressKey(pivotId: string, hit: PivotVisualChromeHit): string {
  switch (hit.kind) {
    case "icon":
    case "headerFilter":
      return `${pivotId}|${hit.kind}|${hit.key}`;
    case "filter":
      return `${pivotId}|filter|${hit.fieldIndex}`;
    default:
      return `${pivotId}|cancel`;
  }
}

/**
 * Run the chrome action at a point: called at the RELEASE of a chrome press
 * that ended over the chrome it began on (pivotChromePress.ts), never at the
 * press. Exported for tests; returns what was hit (null when the point is on
 * no chrome or the click was a dropped repeat).
 */
export function handlePivotVisualPress(
  pivotId: string,
  canvasX: number,
  canvasY: number,
  now: number = Date.now(),
): PivotVisualChromeHit | null {
  const record = getPivotVisualRecord(pivotId);
  if (!record) return null;
  const hit = hitPivotVisualChrome(record, canvasX, canvasY);
  if (!hit) return null;

  // The two clicks of a double-click on a +/- would toggle it twice (back to
  // where it was): a repeat of the SAME chrome within the window is dropped --
  // the one guard the worksheet chrome asks too (pivotChromeRepeat.ts).
  if (!chromeReleaseActs(pressKey(pivotId, hit), hit.kind !== "cancel", now)) {
    return null;
  }
  // A filtered box's chrome is painted over the TRANSIENT view: its +/- and
  // filter buttons name displayed cells and field indices, which the real
  // pivot's commands must never be handed (P4 S7). Cancel stays.
  if (hit.kind !== "cancel" && refuseWhileFiltered(pivotId)) return hit;

  switch (hit.kind) {
    case "cancel":
      cancelPivotLoading(pivotId);
      break;
    case "icon":
      void togglePivotHeaderAt(pivotId, hit.viewRow, hit.viewCol, hit.isRow);
      break;
    case "filter": {
      const anchor = clientPointOf(canvasX, canvasY);
      void openPivotReportFilterAt(
        record.startRow + hit.viewRow,
        record.startCol + hit.viewCol,
        hit.fieldIndex,
        anchor.x,
        anchor.y,
      );
      break;
    }
    case "headerFilter": {
      const anchor = clientPointOf(canvasX, canvasY);
      openPivotHeaderFilter(pivotId, hit.zone, anchor.x, anchor.y + 2);
      break;
    }
  }
  return hit;
}

/**
 * The chrome's hover highlight for the pointer at a CLIENT point: SET for the
 * box Core's own hit order says is TOPMOST there (`topFloatingRegionAtClient`),
 * so a box another object covers never lights up from behind it, and CLEARED
 * everywhere else -- off every box, over a cell, over another object, or over
 * DOM stacked above the grid (a menu, a dialog: `target` outside the grid
 * area). Called from the extension's document mousemove observer; it replaced
 * a `getCursor` that wrote the highlight while Core asked it for a pointer.
 */
export function updatePivotVisualHoverAt(clientX: number, clientY: number, target?: EventTarget | null): void {
  if (!anyPivotVisualHover() && pivotVisualRecordCount() === 0) return;
  // While a formula picks a reference the chrome does not act (a press names
  // the cell beneath it, D-PICK), so it must not light up as if it would.
  if (isFormulaReferencePickActive()) {
    if (setPivotVisualHover(null, {})) requestOverlayRedraw();
    return;
  }
  const area = document.querySelector("[data-grid-area]") as HTMLElement | null;
  const overGrid = !!area && (!(target instanceof Node) || area.contains(target));
  const top = overGrid ? topFloatingRegionAtClient(clientX, clientY) : null;
  const pivotId = top && top.type === PIVOT_VISUAL_REGION_TYPE ? pivotIdOfVisual(top) : null;
  const record = pivotId ? getPivotVisualRecord(pivotId) ?? null : null;
  let changed: boolean;
  if (record && area) {
    const zoom = getGridStateSnapshot()?.zoom || 1;
    const rect = area.getBoundingClientRect();
    const hit = hitPivotVisualChrome(record, (clientX - rect.left) / zoom, (clientY - rect.top) / zoom);
    changed = setPivotVisualHover(record.pivotId, hoverForHit(hit));
  } else {
    changed = setPivotVisualHover(null, {});
  }
  if (changed) requestOverlayRedraw();
}

/**
 * Core's floating-object HOVER changed (@api/gridOverlays
 * `onFloatingHoverChanged`) to `hoveredRegionId`: unless that is a canvas pivot
 * box, no box's chrome may stay lit. The document mousemove above sets and
 * clears the highlight while the pointer moves; but when the pointer LEAVES
 * the grid, or the grid SCROLLS or the SHEET changes under a still pointer, no
 * mousemove comes -- and Core's hover, which ends in all three, says so here.
 * Over a box the per-button highlight stays the mousemove's.
 */
export function clearPivotVisualHoverUnlessHovered(hoveredRegionId: string | null): void {
  if (!anyPivotVisualHover()) return;
  if (hoveredRegionId !== null) {
    const hovered = getGridRegions().find((r) => r.id === hoveredRegionId);
    if (hovered && hovered.type === PIVOT_VISUAL_REGION_TYPE) return;
  }
  if (setPivotVisualHover(null, {})) requestOverlayRedraw();
}

/** The overlay registration for `pivot-visual`. */
export function createPivotVisualOverlay(deps: PivotVisualDeps): OverlayRegistration {
  return {
    type: PIVOT_VISUAL_REGION_TYPE,
    priority: PIVOT_VISUAL_PRIORITY,
    render: (oc) => renderPivotVisualRegion(oc, deps),
    hitTest: hitTestPivotVisual,
    zoneAt: pivotVisualZoneAt,
    referenceAt: pivotVisualReferenceAt,
    onDoubleClick: pivotVisualDoubleClick,
  };
}

// ============================================================================
// Floating-object events
// ============================================================================

interface FloatingDetail {
  regionId?: string;
  regionType?: string;
  data?: Record<string, unknown>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  canvasX?: number;
  canvasY?: number;
  /** The zone part Core resolved for a content press (`pivotVisualZoneAt`). */
  part?: string;
  /** The RAW Shift of a content press (Shift+click extends the cell selection). */
  shiftKey?: boolean;
  /** The RAW Ctrl (Cmd) of a content press (Ctrl+click toggles a cross-filter tuple). */
  ctrlKey?: boolean;
  metaKey?: boolean;
}

function detailOf(e: Event): FloatingDetail {
  return ((e as CustomEvent).detail ?? {}) as FloatingDetail;
}

function visualPivotIdOf(d: FloatingDetail): string | null {
  if (d.regionType !== PIVOT_VISUAL_REGION_TYPE) return null;
  const id = d.data?.pivotId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Persist a box's frame (the pivot API's properties update). */
const saveCanvasFrame: PivotFrameSave = (pivotId, frame) => updatePivotProperties({ pivotId, canvasFrame: frame });

function saveFrame(pivotId: string): void {
  // Joined to the frontend's open undo transaction when there is one (a canvas
  // group drag led by this box), and tracked either way, so the gesture's one
  // undo step is committed only after the frame landed.
  void trackPivotFrameSave(
    joinUndoTransaction(() =>
      commitLiveFrame(
        pivotId,
        (frame) => saveCanvasFrame(pivotId, frame),
        (error) => {
          const msg = error instanceof Error ? error.message : String(error);
          showToast(`The PivotTable box could not be moved: ${msg}`, { type: "error" });
        },
      ),
    ),
  );
}

/**
 * Install the canvas pivot box: the overlay, the provider, the wheel target and
 * the floating-object listeners. Returns the cleanups.
 */
export function installPivotVisual(
  deps: PivotVisualDeps,
  registerOverlay: (registration: OverlayRegistration) => () => void,
): Array<() => void> {
  const cleanups: Array<() => void> = [];
  forgetChromeReleases();
  // A chrome press of an earlier installation acts on nothing now; nor does
  // one still live when this installation is torn down. The same for a cell
  // press (its drag ends; the cells it selected stay).
  cancelPivotChromePress();
  cancelPivotCellPress();
  cleanups.push(cancelPivotChromePress, cancelPivotCellPress);

  // The cell selection (D-CELLS): made on the ACTIVE sheet (so a detail-less
  // SHEET_CHANGED on the same canvas keeps it), repainted on every change, and
  // clamped to each new view of its pivot (a refilter, a collapse).
  cleanups.push(setPivotCellSheetSource(() => getGridStateSnapshot()?.sheetContext?.activeSheetIndex));
  cleanups.push(onPivotCellSelectionChanged(() => requestOverlayRedraw()));
  // Design Mode turns the whole body into the box's move handle (`bodyGrab`,
  // published with the region): re-publish when it flips.
  cleanups.push(onDesignModeChange(() => republishVisualRegions()));

  cleanups.push(registerOverlay(createPivotVisualOverlay(deps)));
  cleanups.push(
    registerPivotVisualSelection({
      // The same delete the pivot's own menu runs; the cached view goes only
      // once the pivot is gone (a refused delete keeps its box painted).
      deletePivot: async (pivotId) => {
        await deletePivotTable(pivotId);
        deleteCachedPivotView(pivotId);
      },
    }),
  );
  // Move / resize the box WITHOUT a pointer gesture (@api/objectGeometry): the
  // canvas's align, distribute, nudge and group drag.
  cleanups.push(registerObjectGeometryProvider(createPivotVisualGeometryProvider(saveCanvasFrame)));
  cleanups.push(registerObjectWheelTarget(createPivotVisualWheelTarget()));

  const listen = (name: string, handler: (e: Event) => void) => {
    window.addEventListener(name, handler);
    cleanups.push(() => window.removeEventListener(name, handler));
  };

  // A right-click on the box: the pivot's own menu (Core opens no cell menu
  // on a floating object). Capture phase, so it runs before the grid's
  // handler, which stands down on a claimed (default-prevented) event.
  const onContextMenu = (e: MouseEvent) => {
    handlePivotBoxContextMenu(e);
  };
  window.addEventListener("contextmenu", onContextMenu, true);
  cleanups.push(() => {
    window.removeEventListener("contextmenu", onContextMenu, true);
    closePivotBoxMenu();
  });

  // A press on ANY floating object: ours selects the box; anything else
  // deselects it. The box opens NO pane of its own (WP-C D-PANE): the ONE
  // object pane opens at the release of a press that did not move, by its
  // own policy (BuiltIn/ObjectPane), on the box's Fields tab.
  listen("floatingObject:selected", (e) => {
    const d = detailOf(e);
    const pivotId = visualPivotIdOf(d);
    if (pivotId) selectPivotVisual(pivotId);
    else deselectPivotVisual();
  });

  // A press Core handed over because `zoneAt` said "content": on a CELL it
  // selects cells (anchor, Shift extends, the drag extends -- D-CELLS); on the
  // chrome it acts at its RELEASE over the same chrome, never here (D5).
  listen("floatingObject:bodyDragStart", (e) => {
    const d = detailOf(e);
    const pivotId = visualPivotIdOf(d);
    if (!pivotId || typeof d.canvasX !== "number" || typeof d.canvasY !== "number") return;
    const regionId = typeof d.regionId === "string" ? d.regionId : undefined;
    if (d.part === "cell") {
      const shiftKey = d.shiftKey === true;
      const ctrl = d.ctrlKey === true || d.metaKey === true;
      beginPivotCellPress({
        pivotId,
        regionId,
        canvasX: d.canvasX,
        canvasY: d.canvasY,
        shiftKey,
        clientToCanvas: canvasPointOf,
        // A plain or Ctrl CLICK on a cell also cross-filters the page (P4
        // S7) -- outside Design Mode, never on a Shift-extend or a drag.
        ...(!shiftKey && !getDesignMode()
          ? { onClick: (cell: { viewRow: number; viewCol: number }) => void applyPivotCrossFilterClick({ pivotId, ...cell, ctrl }) }
          : {}),
      });
      return;
    }
    beginPivotChromePress({
      pivotId,
      regionId,
      canvasX: d.canvasX,
      canvasY: d.canvasY,
      clientToCanvas: canvasPointOf,
    });
  });

  // A new view of a pivot: its cell selection is clamped into it (cleared
  // when the active cell no longer exists).
  listen(PivotEvents.PIVOT_VIEW_UPDATED, (e) => {
    const pivotId = ((e as CustomEvent).detail as { pivotId?: unknown } | undefined)?.pivotId;
    if (typeof pivotId !== "string") return;
    const view = getDisplayedPivotView(pivotId);
    if (!view) return;
    clampPivotCellSelection(pivotId, viewRowCount(view), viewColCount(view));
  });
  // The same when a filtered view comes, changes or goes: the cells are
  // clamped into the grid the box shows now.
  cleanups.push(
    onPivotFilteredViewChange((pivotId) => {
      const view = getDisplayedPivotView(pivotId);
      if (view) clampPivotCellSelection(pivotId, viewRowCount(view), viewColCount(view));
    }),
  );

  // Move / resize: previews patch the live frame (the box follows the pointer);
  // completes persist it. Snap, page clamp and consume mode are Core's.
  listen("floatingObject:movePreview", (e) => {
    const d = detailOf(e);
    const pivotId = visualPivotIdOf(d);
    if (!pivotId || typeof d.x !== "number" || typeof d.y !== "number") return;
    setLiveFrame(pivotId, { x: d.x, y: d.y });
  });
  listen("floatingObject:moveComplete", (e) => {
    const d = detailOf(e);
    const pivotId = visualPivotIdOf(d);
    if (!pivotId || typeof d.x !== "number" || typeof d.y !== "number") return;
    if (setLiveFrame(pivotId, { x: d.x, y: d.y })) saveFrame(pivotId);
  });
  listen("floatingObject:resizePreview", (e) => {
    const d = detailOf(e);
    const pivotId = visualPivotIdOf(d);
    if (!pivotId || typeof d.x !== "number" || typeof d.y !== "number") return;
    setLiveFrame(pivotId, { x: d.x, y: d.y, width: d.width, height: d.height });
  });
  listen("floatingObject:resizeComplete", (e) => {
    const d = detailOf(e);
    const pivotId = visualPivotIdOf(d);
    if (!pivotId || typeof d.x !== "number" || typeof d.y !== "number") return;
    if (setLiveFrame(pivotId, { x: d.x, y: d.y, width: d.width, height: d.height })) saveFrame(pivotId);
  });

  return cleanups;
}
