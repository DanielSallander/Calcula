//! FILENAME: app/src/api/gridLayers.ts
// PURPOSE: Grid layers — full-viewport, scroll-synced canvas paint layers at
//          named z-anchors (granular bricks, phase 4). Where grid OVERLAYS are
//          rectangular regions (charts, pivots), a LAYER paints across the
//          whole viewport at a defined depth of the frame: behind the cells,
//          under/over the selection chrome, or above the headers.
// ARCHITECTURE: API-layer registry with walk-points woven into the Core's
//          renderGrid() pass order. The built-in passes stay where they are;
//          layers slot between them at the four anchors.
// PERFORMANCE CONTRACT: paint() runs inside the 60fps frame for every
//          registered layer — O(viewport) work only, no allocation-heavy
//          loops, no I/O; the caller wraps each layer in save/restore +
//          try/catch so a bad layer cannot corrupt the frame or kill the rest.

import type { GridConfig, Viewport, DimensionOverrides, FreezeConfig } from "./types";

// ============================================================================
// Types
// ============================================================================

/**
 * Where in the frame a layer paints:
 * - "under-cells": after the background clear, before gridlines/cell content
 *   (backgrounds, watermarks, heat glass under the data)
 * - "under-selection": after cell content + cell-anchored overlays, before the
 *   selection highlight (range tints that must not obscure selection chrome)
 * - "over-selection": after selection + floating overlays, before headers
 *   (annotation ink, review markers that sit on top of content)
 * - "over-headers": after headers and header chrome (topmost furniture)
 */
export type GridLayerAnchor =
  | "under-cells"
  | "under-selection"
  | "over-selection"
  | "over-headers";

/** Context passed to a layer's paint function each frame. */
export interface GridLayerContext {
  ctx: CanvasRenderingContext2D;
  config: GridConfig;
  viewport: Viewport;
  dimensions: DimensionOverrides;
  canvasWidth: number;
  canvasHeight: number;
  /** Effective freeze config (split mode is expressed as freeze here). */
  freezeConfig: FreezeConfig | null;
}

export interface GridLayerRegistration {
  /** Unique id (used for unregistration and error attribution). */
  id: string;
  anchor: GridLayerAnchor;
  /** Within an anchor: lower paints first (deeper). Default 0. */
  priority?: number;
  paint: (context: GridLayerContext) => void;
}

// ============================================================================
// Internal State
// ============================================================================

const layersByAnchor = new Map<GridLayerAnchor, GridLayerRegistration[]>();

function anchorList(anchor: GridLayerAnchor): GridLayerRegistration[] {
  let list = layersByAnchor.get(anchor);
  if (!list) {
    list = [];
    layersByAnchor.set(anchor, list);
  }
  return list;
}

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a grid layer at a named z-anchor.
 * @returns Cleanup function that unregisters the layer.
 */
export function registerGridLayer(registration: GridLayerRegistration): () => void {
  const list = anchorList(registration.anchor);
  list.push(registration);
  list.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return () => {
    const current = layersByAnchor.get(registration.anchor);
    if (!current) return;
    const i = current.indexOf(registration);
    if (i >= 0) current.splice(i, 1);
  };
}

/** Unregister a layer by id (any anchor). */
export function unregisterGridLayer(id: string): void {
  for (const list of layersByAnchor.values()) {
    const i = list.findIndex((l) => l.id === id);
    if (i >= 0) list.splice(i, 1);
  }
}

/** Fast flag for the renderer: any layers at this anchor? */
export function hasGridLayers(anchor: GridLayerAnchor): boolean {
  const list = layersByAnchor.get(anchor);
  return !!list && list.length > 0;
}

/**
 * Paint all layers registered at an anchor (priority order). Called by the
 * Core renderGrid() walk-points. Each layer runs inside save/restore +
 * try/catch — a throwing layer is contained and the rest still paint.
 */
export function paintGridLayers(anchor: GridLayerAnchor, context: GridLayerContext): void {
  const list = layersByAnchor.get(anchor);
  if (!list || list.length === 0) return;
  for (const layer of list) {
    context.ctx.save();
    try {
      layer.paint(context);
    } catch (error) {
      console.error(`[GridLayers] Error in layer "${layer.id}":`, error);
    }
    context.ctx.restore();
  }
}

/** All registered layers (panels/tests). */
export function listGridLayers(): GridLayerRegistration[] {
  const all: GridLayerRegistration[] = [];
  for (const list of layersByAnchor.values()) {
    all.push(...list);
  }
  return all.sort((a, b) => a.id.localeCompare(b.id));
}
