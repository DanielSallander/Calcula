//! FILENAME: app/src/api/cellDecorations.ts
// PURPOSE: Cell Decoration Pipeline for in-cell graphical decorations
// CONTEXT: Allows extensions to draw custom graphics inside cells at render time
//          (e.g., Sparklines, data bars) without polluting the Core with feature logic.
// ARCHITECTURE: Part of the API layer - the bridge between Core and Extensions.
//              Follows the exact same pattern as styleInterceptors.ts.

import type { GridConfig, Viewport, DimensionOverrides, StyleDataMap } from "./types";

// ============================================================================
// Types
// ============================================================================

/** Context passed to cell decoration functions during render */
export interface CellDecorationContext {
  /** The 2D canvas rendering context */
  ctx: CanvasRenderingContext2D;
  /** Cell row index (0-based) */
  row: number;
  /** Cell column index (0-based) */
  col: number;
  /** Left pixel boundary of the visible cell area (clipped) */
  cellLeft: number;
  /** Top pixel boundary of the visible cell area (clipped) */
  cellTop: number;
  /** Right pixel boundary of the visible cell area (clipped) */
  cellRight: number;
  /** Bottom pixel boundary of the visible cell area (clipped) */
  cellBottom: number;
  /** Grid configuration */
  config: GridConfig;
  /** Current viewport (scroll position) */
  viewport: Viewport;
  /** Dimension overrides (custom column widths, row heights) */
  dimensions: DimensionOverrides;
  /** Display value of the cell (e.g., "TRUE", "FALSE", "") */
  display: string;
  /** Style index of the cell (for looking up full style data) */
  styleIndex: number;
  /** Style cache for looking up full style data by index */
  styleCache: StyleDataMap;
}

/**
 * Cell decoration function signature.
 * Called during render for each visible cell, between background/borders
 * and text rendering. The canvas is already clipped to the cell bounds.
 *
 * @param context - The rendering context with cell bounds and grid state
 */
export type CellDecorationFn = (context: CellDecorationContext) => void;

/**
 * Where a decoration sits relative to the SELECTION chrome. The mirror, at
 * cell scale, of {@link GridLayerAnchor} for full-viewport layers.
 *
 * - `"under-selection"` (default) — decoration is CONTENT. Data bars,
 *   sparklines, checkboxes: they belong to the cell's body and the selection
 *   tint reading over them is correct, exactly as it reads over the text.
 *
 * - `"over-selection"` — decoration is INDICATOR CHROME. A note triangle, an
 *   error triangle, a bookmark dot: it tells the user something about the cell
 *   that must not disappear when the cell is selected.
 *
 * WHY THIS ANCHOR EXISTS. The active-cell highlight fills the cell and then
 * strokes a 2px border inset 1px from its edge. The note indicator is a 6px
 * triangle in the cell's top-right corner, so the border covered 18 of its 21
 * pixels and the 15% selection tint took most of the rest: selecting a
 * commented cell hid its own indicator (measured 15 indicator pixels with the
 * selection elsewhere, 0 with the cell selected). Excel keeps the indicator
 * visible. The fix is a z-order the decoration DECLARES, not a special case for
 * notes inside the selection painter — which would have to be repeated for the
 * error triangle and the bookmark dot, and would put feature knowledge in Core.
 */
export type CellDecorationAnchor = "under-selection" | "over-selection";

/** Decoration registration with metadata */
export interface CellDecorationRegistration {
  id: string;
  decorator: CellDecorationFn;
  /** Priority for rendering order (lower = draws first/underneath). Default: 0 */
  priority: number;
  /** Z-position relative to the selection chrome. Default: "under-selection". */
  anchor: CellDecorationAnchor;
}

// ============================================================================
// Internal State
// ============================================================================

const decorationRegistry = new Map<string, CellDecorationRegistration>();
/** Sorted, split by anchor — the renderer walks each anchor at its own point. */
const sortedByAnchor: Record<CellDecorationAnchor, CellDecorationRegistration[]> = {
  "under-selection": [],
  "over-selection": [],
};
let isDirty = true;

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a cell decoration renderer.
 * Decorations are called in priority order (lower priority = drawn first/underneath).
 *
 * @param id - Unique identifier for this decoration
 * @param decorator - The decoration rendering function
 * @param priority - Rendering priority (lower = underneath). Default: 0
 * @param anchor - Z-position relative to the selection chrome. Default:
 *   `"under-selection"`. Pass `"over-selection"` for INDICATOR chrome that must
 *   stay visible when the cell is selected — see {@link CellDecorationAnchor}.
 * @returns Cleanup function to unregister the decoration
 *
 * @example
 * ```ts
 * // Content: the selection tint reading over it is correct.
 * registerCellDecoration("sparklines", drawSparkline, 0);
 *
 * // Indicator: must survive the active-cell highlight.
 * registerCellDecoration("annotation-triangles", drawTriangle, 5, "over-selection");
 * ```
 */
export function registerCellDecoration(
  id: string,
  decorator: CellDecorationFn,
  priority: number = 0,
  anchor: CellDecorationAnchor = "under-selection"
): () => void {
  const registration: CellDecorationRegistration = {
    id,
    decorator,
    priority,
    anchor,
  };

  decorationRegistry.set(id, registration);
  isDirty = true;

  return () => {
    unregisterCellDecoration(id);
  };
}

/**
 * Unregister a cell decoration by ID.
 */
export function unregisterCellDecoration(id: string): void {
  if (decorationRegistry.delete(id)) {
    isDirty = true;
  }
}

/**
 * Get the registered decorations for an anchor, sorted by priority.
 * Uses internal caching for performance (hot path in render loop).
 */
function getSortedDecorations(anchor: CellDecorationAnchor): CellDecorationRegistration[] {
  if (isDirty) {
    const all = Array.from(decorationRegistry.values()).sort(
      (a, b) => a.priority - b.priority
    );
    sortedByAnchor["under-selection"] = all.filter((d) => d.anchor === "under-selection");
    sortedByAnchor["over-selection"] = all.filter((d) => d.anchor === "over-selection");
    isDirty = false;
  }
  return sortedByAnchor[anchor];
}

/**
 * Check if any decorations are registered at an anchor.
 * Used by the renderer to skip the decoration pipeline entirely when empty.
 *
 * @param anchor - Which anchor to test. Default: `"under-selection"`, the pass
 *   that runs inside the normal cell paint.
 */
export function hasCellDecorations(
  anchor: CellDecorationAnchor = "under-selection"
): boolean {
  if (decorationRegistry.size === 0) return false;
  return getSortedDecorations(anchor).length > 0;
}

/**
 * Apply the registered decorations at one anchor to a cell.
 *
 * `"under-selection"` runs inside the Core renderer's per-cell paint, between
 * background/borders and text. `"over-selection"` is REPLAYED after the
 * selection chrome, from the contexts the cell pass captured — see
 * `gridRenderer/rendering/cells.ts`.
 *
 * @param context - The cell decoration context with canvas and bounds
 * @param anchor - Which anchor to run. Default: `"under-selection"`.
 */
export function applyCellDecorations(
  context: CellDecorationContext,
  anchor: CellDecorationAnchor = "under-selection"
): void {
  const decorations = getSortedDecorations(anchor);

  if (decorations.length === 0) {
    return;
  }

  for (const registration of decorations) {
    try {
      registration.decorator(context);
    } catch (error) {
      console.error(`[CellDecoration] Error in decorator "${registration.id}":`, error);
    }
  }
}
