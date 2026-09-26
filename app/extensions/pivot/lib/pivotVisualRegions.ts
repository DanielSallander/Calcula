//! FILENAME: app/extensions/Pivot/lib/pivotVisualRegions.ts
// PURPOSE: Region sync for CANVAS pivots: which pivots publish the cell-anchored
//          `pivot` region and which publish a FLOATING `pivot-visual` region,
//          plus the frame each visual is shown in (the backend's, or a live
//          one while the designer drags it).
// CONTEXT: A canvas pivot is written into the canvas's hidden grid, so the
//          backend reports it with cell coordinates like any other pivot -- and
//          a `canvasFrame`. It must NOT also publish the cell region: the Core
//          skips painting cell regions on a canvas, but their bottom-right resize
//          handle stays live (overlayResizeHandlers checks no surface), so an
//          invisible handle would sit somewhere on the page.
//
//          The partition is on `canvasFrame`, never on the surface flag: the
//          backend guarantees every canvas pivot has a frame, and the surface
//          flag can still describe the previous sheet while a SHEET_CHANGED
//          refresh is in flight.
//
//          The region keeps startRow..endCol: they map a view cell to the hidden
//          grid cell (drill-through, GETPIVOTDATA and the pane's getAtCell all
//          address cells).

import {
  replaceGridRegionsByType,
  removeGridRegionsByType,
  type GridRegion,
} from "@api/gridOverlays";
import type { PivotRegionData, CanvasFrameConfig } from "../types";

/** The cell-anchored region type every worksheet pivot publishes. */
export const PIVOT_CELL_REGION_TYPE = "pivot";
/** The floating region type a canvas pivot publishes instead. */
export const PIVOT_VISUAL_REGION_TYPE = "pivot-visual";

export function pivotVisualRegionId(pivotId: string): string {
  return `pivot-visual-${pivotId}`;
}

/** The pivot id a published visual region carries, or null. */
export function pivotIdOfVisual(region: GridRegion): string | null {
  if (region.type !== PIVOT_VISUAL_REGION_TYPE) return null;
  const id = region.data?.pivotId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The worksheet shape (unchanged from before canvas pivots existed). */
export function toCellRegion(r: PivotRegionData): GridRegion {
  return {
    id: `pivot-${r.pivotId}`,
    type: PIVOT_CELL_REGION_TYPE,
    startRow: r.startRow,
    startCol: r.startCol,
    endRow: r.endRow,
    endCol: r.endCol,
    data: { isEmpty: r.isEmpty, pivotId: r.pivotId, name: r.name },
  };
}

/** A canvas pivot as a floating object positioned by its frame. */
export function toVisualRegion(r: PivotRegionData, frame: CanvasFrameConfig): GridRegion {
  return {
    id: pivotVisualRegionId(r.pivotId),
    type: PIVOT_VISUAL_REGION_TYPE,
    startRow: r.startRow,
    startCol: r.startCol,
    endRow: r.endRow,
    endCol: r.endCol,
    floating: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    data: {
      pivotId: r.pivotId,
      name: r.name,
      isEmpty: r.isEmpty,
      frozenHeaders: frame.frozenHeaders === true,
    },
  };
}

/**
 * Split backend regions into the two published shapes. `frameFor` lets the
 * caller substitute a live (dragged / saving) frame for the backend's.
 */
export function partitionPivotRegions(
  regions: readonly PivotRegionData[],
  frameFor: (r: PivotRegionData) => CanvasFrameConfig | null | undefined = (r) => r.canvasFrame,
): { cell: GridRegion[]; visual: GridRegion[] } {
  const cell: GridRegion[] = [];
  const visual: GridRegion[] = [];
  for (const r of regions) {
    if (r.canvasFrame != null) {
      const frame = frameFor(r) ?? r.canvasFrame;
      visual.push(toVisualRegion(r, frame));
    } else {
      cell.push(toCellRegion(r));
    }
  }
  return { cell, visual };
}

// ============================================================================
// Frame store
// ============================================================================

/** The canvas pivots last published (the source of every re-publish). */
let visualSources: PivotRegionData[] = [];
/** The frame the backend holds for each canvas pivot (as far as we know). */
const backendFrames = new Map<string, CanvasFrameConfig>();
/** A frame the designer is dragging, or one whose save has not returned yet. */
const liveFrames = new Map<string, CanvasFrameConfig>();
/**
 * Save generations. A region fetch that STARTED before a frame save completed
 * carries the pre-save frame; publishing it would snap the box back until the
 * next refresh. Each completed save stamps the pivot with a new generation;
 * a fetch captures the generation at its start and yields to newer saves.
 * (An undo of the move starts its refresh AFTER the save, so it is honoured.)
 */
let frameGeneration = 0;
const savedAtGeneration = new Map<string, number>();

/** The generation a region fetch should capture before it awaits. */
export function currentFrameGeneration(): number {
  return frameGeneration;
}

/** The frame a visual is painted with now. */
export function effectiveFrame(pivotId: string): CanvasFrameConfig | undefined {
  return liveFrames.get(pivotId) ?? backendFrames.get(pivotId);
}

function frameForPublish(r: PivotRegionData, fetchGeneration: number): CanvasFrameConfig | undefined {
  const live = liveFrames.get(r.pivotId);
  if (live) return live;
  const savedGen = savedAtGeneration.get(r.pivotId);
  if (savedGen !== undefined && savedGen > fetchGeneration) {
    return backendFrames.get(r.pivotId) ?? r.canvasFrame;
  }
  if (r.canvasFrame) backendFrames.set(r.pivotId, { ...r.canvasFrame });
  return r.canvasFrame;
}

/**
 * Publish the backend's regions: `pivot` for worksheet pivots, `pivot-visual`
 * for canvas pivots. One notification (the first replace is silent), so no
 * paint ever sees the cell set updated and the visual set stale.
 */
export function publishPivotRegions(
  regions: readonly PivotRegionData[],
  fetchGeneration: number = frameGeneration,
): { cell: GridRegion[]; visual: GridRegion[] } {
  visualSources = regions.filter((r) => r.canvasFrame != null);
  const live = new Set(visualSources.map((r) => r.pivotId));
  for (const id of [...backendFrames.keys()]) {
    if (!live.has(id)) {
      backendFrames.delete(id);
      liveFrames.delete(id);
      savedAtGeneration.delete(id);
    }
  }
  const parts = partitionPivotRegions(regions, (r) => frameForPublish(r, fetchGeneration));
  replaceGridRegionsByType(PIVOT_CELL_REGION_TYPE, parts.cell, false);
  replaceGridRegionsByType(PIVOT_VISUAL_REGION_TYPE, parts.visual);
  return parts;
}

/** Re-publish the visual regions from the last sources with the current frames. */
export function republishVisualRegions(): void {
  const { visual } = partitionPivotRegions(visualSources, (r) => effectiveFrame(r.pivotId));
  replaceGridRegionsByType(PIVOT_VISUAL_REGION_TYPE, visual);
}

/** Patch the live frame of a visual (a move or resize preview) and re-publish. */
export function setLiveFrame(
  pivotId: string,
  patch: { x: number; y: number; width?: number; height?: number },
): CanvasFrameConfig | null {
  const base = effectiveFrame(pivotId);
  if (!base) return null;
  const next: CanvasFrameConfig = {
    ...base,
    x: patch.x,
    y: patch.y,
    width: patch.width ?? base.width,
    height: patch.height ?? base.height,
  };
  liveFrames.set(pivotId, next);
  republishVisualRegions();
  return next;
}

/**
 * Persist the live frame of a visual. Whole pixels are sent (the box is
 * painted on whole pixels anyway). On failure the live frame is dropped, so
 * the box returns to the backend's frame, and `onError` reports it.
 */
export async function commitLiveFrame(
  pivotId: string,
  save: (frame: CanvasFrameConfig) => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<boolean> {
  const live = liveFrames.get(pivotId);
  if (!live) return false;
  const frame: CanvasFrameConfig = {
    ...live,
    x: Math.max(0, Math.round(live.x)),
    y: Math.max(0, Math.round(live.y)),
    width: Math.max(1, Math.round(live.width)),
    height: Math.max(1, Math.round(live.height)),
  };
  liveFrames.set(pivotId, frame);
  republishVisualRegions();
  let ok = false;
  try {
    await save(frame);
    frameGeneration += 1;
    savedAtGeneration.set(pivotId, frameGeneration);
    backendFrames.set(pivotId, frame);
    ok = true;
  } catch (error) {
    onError(error);
  } finally {
    // A newer gesture that started while this save was in flight keeps its frame.
    if (liveFrames.get(pivotId) === frame) liveFrames.delete(pivotId);
    republishVisualRegions();
  }
  return ok;
}

/** Remove the visual regions (the cell ones are the caller's). */
export function removePivotVisualRegions(): void {
  visualSources = [];
  removeGridRegionsByType(PIVOT_VISUAL_REGION_TYPE);
}

/** Forget everything (deactivate, a new document). */
export function resetPivotVisualRegionState(): void {
  visualSources = [];
  backendFrames.clear();
  liveFrames.clear();
  savedAtGeneration.clear();
}
