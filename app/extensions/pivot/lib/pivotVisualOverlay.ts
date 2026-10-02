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
// CONTEXT: Snap, the page clamp and consume mode (a subscribed canvas) are
//          applied by the Core through @api/layoutSurface before any of the
//          move/resize events below are dispatched -- nothing here
//          re-implements them. A frame edit is persisted through
//          `update_pivot_properties({pivotId, canvasFrame})`, undoable on the
//          backend side; the cells do not change, so no pivot refresh follows.

import { showToast } from "@api";
import {
  getGridRegions,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlaySheetToCanvas,
  requestOverlayRedraw,
  topFloatingRegionAtClient,
  type GridRegion,
  type OverlayHitTestContext,
  type OverlayRegistration,
  type OverlayRenderContext,
  type OverlayZone,
} from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/grid";
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
  // The box's grey outline. Selected: Core paints the selection outline and
  // the handles over it (floatingObjectChrome.ts, BUG-0258 phase 3).
  paintPivotVisualFrame(ctx, box);
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

/**
 * The box's ONE zone answer (BUG-0258 design phase 2), from which Core derives
 * the press, the pointer and the meaning of Ctrl/Shift. The CHROME (a +/-, a
 * report-filter combo, a Row/Column Labels button, the loading indicator's
 * Cancel) is content with a hand: Core hands the press to
 * `floatingObject:bodyDragStart` (a button press, never the start of a move),
 * also on a locked box and a subscribed page, and the chrome acts when that
 * press is RELEASED over the same piece of chrome (pivotChromePress.ts; phase
 * 4, D5) -- a drag that starts on a +/- neither moves the box nor toggles.
 * The cells are frame (null): the box moves by them, as it always did.
 *
 * PURE, which the old `getCursor` was not -- it wrote the hover highlight as a
 * side effect of being asked. The highlight is `updatePivotVisualHoverAt`'s.
 */
export function pivotVisualZoneAt(hitCtx: OverlayHitTestContext): OverlayZone | null {
  const record = recordFor(hitCtx);
  const hit = record ? hitPivotVisualChrome(record, hitCtx.canvasX, hitCtx.canvasY) : null;
  return hit ? { kind: "content", cursor: "pointer", part: hit.kind } : null;
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
  forgetChromeReleases();
  // A chrome press of an earlier installation acts on nothing now; nor does
  // one still live when this installation is torn down.
  cancelPivotChromePress();
  cleanups.push(cancelPivotChromePress);

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

  // A press Core handed over because `zoneAt` said "chrome" (content). It
  // acts at its RELEASE over the same chrome, never here (D5).
  listen("floatingObject:bodyDragStart", (e) => {
    const d = detailOf(e);
    const pivotId = visualPivotIdOf(d);
    if (!pivotId || typeof d.canvasX !== "number" || typeof d.canvasY !== "number") return;
    beginPivotChromePress({
      pivotId,
      regionId: typeof d.regionId === "string" ? d.regionId : undefined,
      canvasX: d.canvasX,
      canvasY: d.canvasY,
      clientToCanvas: canvasPointOf,
    });
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
