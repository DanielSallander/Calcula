//! FILENAME: app/extensions/Pivot/lib/pivotVisualOverlay.ts
// PURPOSE: The `pivot-visual` floating object: a canvas pivot shown in its
//          designer-sized box. Registers the overlay (paint, hit test, cursor,
//          press claim, double-click) and wires the floating-object events
//          (select, move, resize, chrome press), the object-selection provider
//          and the wheel target.
// CONTEXT: Snap, the page clamp and consume mode (a subscribed canvas, or design
//          mode off) are applied by the Core through @api/layoutSurface before
//          any of the move/resize events below are dispatched -- nothing here
//          re-implements them. A frame edit is persisted through
//          `update_pivot_properties({pivotId, canvasFrame})`, undoable on the
//          backend side; the cells do not change, so no pivot refresh follows.

import { showToast } from "@api";
import {
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlaySheetToCanvas,
  requestOverlayRedraw,
  type GridRegion,
  type OverlayHitTestContext,
  type OverlayRegistration,
  type OverlayRenderContext,
} from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/grid";
import { getLayoutSurface } from "@api/layoutSurface";
import { drawObjectScriptBadgeIfPresent } from "@api/objectScriptBadge";
import type { DimensionOverrides } from "@api/types";
import { registerObjectWheelTarget } from "../../_shared/lib/objectWheelScroll";
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
  getCachedPivotView,
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
  paintPivotVisualFrame,
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
} from "./pivotVisualRegions";
import {
  getPivotVisualRecord,
  getPivotVisualHover,
  setPivotVisualRecord,
  setPivotVisualHover,
  hitPivotVisualChrome,
  hoverForHit,
  viewCellAtCanvasPoint,
  anyPivotVisualHover,
  allPivotVisualRecords,
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
import { registerPivotVisualSelection } from "./pivotVisualSelection";
import { closePivotBoxMenu, handlePivotBoxContextMenu } from "./pivotVisualContextMenu";
import {
  isPivotVisualSelected,
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

/** Handles are live only where the surface lets objects be resized. */
function surfaceEditable(): boolean {
  const sheet = getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0;
  return getLayoutSurface(sheet)?.editable ?? true;
}

/** Paint one `pivot-visual` region. Exported for tests. */
export function renderPivotVisualRegion(oc: OverlayRenderContext, deps: PivotVisualDeps): void {
  const region = oc.region;
  const f = region.floating;
  const pivotId = pivotIdOfVisual(region);
  if (!f || !pivotId) return;

  // Whole pixels: the renderer's 0.5px line snapping stays crisp at any zoom.
  const origin = overlaySheetToCanvas(oc, f.x, f.y);
  const box: PivotVisualBox = {
    x: Math.round(origin.canvasX),
    y: Math.round(origin.canvasY),
    width: Math.max(0, Math.round(f.width)),
    height: Math.max(0, Math.round(f.height)),
  };

  const record: PivotVisualRecord = {
    pivotId,
    box,
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
  const view = isEmpty ? undefined : getCachedPivotView(pivotId);

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
  } else {
    // Empty pivot (or its view is still on its way): an opaque box, and for an
    // empty one the "Click in this area" hint Excel shows.
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(box.x, box.y, box.width, box.height);
    if (isEmpty) {
      paintPivotPlaceholderContent(ctx, box, String(region.data?.name ?? ""));
    }
    ctx.restore();
  }

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
  paintPivotVisualFrame(ctx, box, {
    selected: isPivotVisualSelected(pivotId),
    showHandles: surfaceEditable(),
  });
  // Transparency: badge a pivot that has a script attached (design mode).
  drawObjectScriptBadgeIfPresent(ctx, "pivot", pivotId, box.x, box.y, box.width);
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

/** Pointer over chrome; also drives the hover highlight (no extra listener). */
export function pivotVisualCursor(hitCtx: OverlayHitTestContext): string | null {
  const record = recordFor(hitCtx);
  const hit = record ? hitPivotVisualChrome(record, hitCtx.canvasX, hitCtx.canvasY) : null;
  if (setPivotVisualHover(record?.pivotId ?? null, hoverForHit(hit))) {
    requestOverlayRedraw();
  }
  return hit ? "pointer" : null;
}

/** A press on chrome is a button press, never the start of a move. */
export function pivotVisualClaimsBodyDrag(hitCtx: OverlayHitTestContext): boolean {
  const record = recordFor(hitCtx);
  return !!record && hitPivotVisualChrome(record, hitCtx.canvasX, hitCtx.canvasY) !== null;
}

/**
 * A double-click inside the box. On chrome it is swallowed (the two presses
 * already acted); on a cell it maps view cell -> hidden-grid cell and runs the
 * same toggle / drill-through as a worksheet pivot. Always true inside the box:
 * a canvas has no cell editor to fall through to.
 */
export function pivotVisualDoubleClick(hitCtx: OverlayHitTestContext): boolean {
  const record = recordFor(hitCtx);
  if (!record) return false;
  if (!isInsidePivotVisualBox(record, hitCtx.canvasX, hitCtx.canvasY)) return false;
  if (hitPivotVisualChrome(record, hitCtx.canvasX, hitCtx.canvasY)) return true;

  const at = viewCellAtCanvasPoint(record, hitCtx.canvasX, hitCtx.canvasY);
  if (!at) return true;
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
 * The two presses of a double-click on a +/- would toggle it twice (back to
 * where it was). A repeat of the SAME chrome within this window is dropped.
 */
const REPEAT_PRESS_MS = 450;
let lastPress: { key: string; at: number } | null = null;

function pressKey(pivotId: string, hit: PivotVisualChromeHit): string {
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
 * Run the chrome action under a press. Exported for tests; returns what was
 * hit (null when the press was on no chrome or was a dropped repeat).
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

  const key = pressKey(pivotId, hit);
  if (hit.kind !== "cancel" && lastPress && lastPress.key === key && now - lastPress.at < REPEAT_PRESS_MS) {
    return null;
  }
  lastPress = { key, at: now };

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
 * Clear a box's hover when the pointer has left it (getCursor is asked only
 * while the pointer is over SOME floating object). Called from the extension's
 * existing document mousemove observer with a CLIENT point.
 */
export function clearPivotVisualHoverOutside(clientX: number, clientY: number): void {
  if (!anyPivotVisualHover()) return;
  const area = document.querySelector("[data-grid-area]") as HTMLElement | null;
  const zoom = getGridStateSnapshot()?.zoom || 1;
  const rect = area?.getBoundingClientRect();
  const x = (clientX - (rect?.left ?? 0)) / zoom;
  const y = (clientY - (rect?.top ?? 0)) / zoom;
  const over = allPivotVisualRecords().find((r) => isInsidePivotVisualBox(r, x, y));
  if (over) return;
  if (setPivotVisualHover(null, {})) requestOverlayRedraw();
}

/** The overlay registration for `pivot-visual`. */
export function createPivotVisualOverlay(deps: PivotVisualDeps): OverlayRegistration {
  return {
    type: PIVOT_VISUAL_REGION_TYPE,
    priority: PIVOT_VISUAL_PRIORITY,
    render: (oc) => renderPivotVisualRegion(oc, deps),
    hitTest: hitTestPivotVisual,
    getCursor: pivotVisualCursor,
    claimsBodyDrag: pivotVisualClaimsBodyDrag,
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
  lastPress = null;

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

  // A press on ANY floating object: ours selects the box (and opens the field
  // list, as clicking into a worksheet pivot does); anything else deselects it.
  listen("floatingObject:selected", (e) => {
    const d = detailOf(e);
    const pivotId = visualPivotIdOf(d);
    if (pivotId) selectPivotVisual(pivotId, { openPane: true });
    else deselectPivotVisual();
  });

  // A press Core handed over because claimsBodyDrag said "chrome".
  listen("floatingObject:bodyDragStart", (e) => {
    const d = detailOf(e);
    const pivotId = visualPivotIdOf(d);
    if (!pivotId || typeof d.canvasX !== "number" || typeof d.canvasY !== "number") return;
    handlePivotVisualPress(pivotId, d.canvasX, d.canvasY);
  });

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
