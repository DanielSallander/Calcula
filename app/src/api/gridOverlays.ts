//! FILENAME: app/src/api/gridOverlays.ts
// PURPOSE: Generic overlay lifecycle system for grid canvas.
// CONTEXT: Allows extensions to register rectangular region overlays on the grid,
// with rendering, hit-testing, and lifecycle events. The Core renderer calls
// this generic API without knowing about any specific extension (e.g., pivot).

import type { GridConfig, Viewport, DimensionOverrides } from "./types";

// ============================================================================
// Region Definition
// ============================================================================

/** A rectangular region on the grid that an extension claims ownership of. */
export interface GridRegion {
  /** Unique region identifier (e.g., "pivot-1") */
  id: string;
  /** Region type, used to match overlay renderers (e.g., "pivot") */
  type: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Extension-defined metadata */
  data?: Record<string, unknown>;
}

// ============================================================================
// Overlay Renderer
// ============================================================================

/** Context passed to overlay render functions during grid paint. */
export interface OverlayRenderContext {
  ctx: CanvasRenderingContext2D;
  region: GridRegion;
  config: GridConfig;
  viewport: Viewport;
  dimensions: DimensionOverrides;
  canvasWidth: number;
  canvasHeight: number;
}

/** A function that renders an overlay for a given region. */
export type OverlayRendererFn = (context: OverlayRenderContext) => void;

// ============================================================================
// Hit Testing
// ============================================================================

/** Context passed to overlay hit-test functions. */
export interface OverlayHitTestContext {
  region: GridRegion;
  canvasX: number;
  canvasY: number;
  row: number;
  col: number;
}

/** A function that tests whether a point falls within an overlay region. */
export type OverlayHitTestFn = (context: OverlayHitTestContext) => boolean;

// ============================================================================
// Lifecycle Events
// ============================================================================

/** Handler called when the set of grid regions changes. */
export type RegionChangeHandler = (regions: GridRegion[]) => void;

// ============================================================================
// Overlay Registration
// ============================================================================

/** Describes an overlay renderer that handles a specific region type. */
export interface OverlayRegistration {
  /** Region type this overlay handles (e.g., "pivot") */
  type: string;
  /** Render function called during grid paint */
  render: OverlayRendererFn;
  /** Optional hit-test function for mouse interaction */
  hitTest?: OverlayHitTestFn;
  /** Priority for render ordering (higher = later = on top). Default: 0 */
  priority?: number;
}

// ============================================================================
// Internal State
// ============================================================================

const overlayRegistry = new Map<string, OverlayRegistration>();
let gridRegions: GridRegion[] = [];
const regionChangeListeners = new Set<RegionChangeHandler>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register an overlay renderer for a region type.
 * @returns A cleanup function that unregisters the overlay.
 */
export function registerGridOverlay(registration: OverlayRegistration): () => void {
  overlayRegistry.set(registration.type, registration);
  return () => {
    overlayRegistry.delete(registration.type);
  };
}

/** Unregister an overlay renderer by type. */
export function unregisterGridOverlay(type: string): void {
  overlayRegistry.delete(type);
}

/**
 * Set the current grid regions (replaces all).
 * Fires region change listeners.
 */
export function setGridRegions(regions: GridRegion[]): void {
  gridRegions = regions;
  notifyRegionChange();
}

/**
 * Add regions without replacing existing ones.
 * Fires region change listeners.
 */
export function addGridRegions(regions: GridRegion[]): void {
  gridRegions = [...gridRegions, ...regions];
  notifyRegionChange();
}

/** Remove all regions of a given type. Fires region change listeners. */
export function removeGridRegionsByType(type: string): void {
  gridRegions = gridRegions.filter((r) => r.type !== type);
  notifyRegionChange();
}

/** Get all current grid regions. */
export function getGridRegions(): GridRegion[] {
  return gridRegions;
}

/**
 * Get all registered overlay renderers, sorted by priority (ascending).
 * Lower priority renders first (underneath); higher priority renders on top.
 */
export function getOverlayRenderers(): OverlayRegistration[] {
  return Array.from(overlayRegistry.values()).sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );
}

/**
 * Listen for region changes.
 * @returns A cleanup function that removes the listener.
 */
export function onRegionChange(handler: RegionChangeHandler): () => void {
  regionChangeListeners.add(handler);
  return () => {
    regionChangeListeners.delete(handler);
  };
}

/**
 * Hit-test: find which overlay region (if any) is at the given position.
 * Tests in reverse priority order so the topmost overlay wins.
 */
export function hitTestOverlays(
  canvasX: number,
  canvasY: number,
  row: number,
  col: number
): GridRegion | null {
  const renderers = getOverlayRenderers().reverse();

  for (const renderer of renderers) {
    if (!renderer.hitTest) continue;

    const matchingRegions = gridRegions.filter((r) => r.type === renderer.type);
    for (const region of matchingRegions) {
      if (renderer.hitTest({ region, canvasX, canvasY, row, col })) {
        return region;
      }
    }
  }

  return null;
}

// ============================================================================
// Internal Helpers
// ============================================================================

function notifyRegionChange(): void {
  const snapshot = [...gridRegions];
  for (const handler of regionChangeListeners) {
    handler(snapshot);
  }
}
