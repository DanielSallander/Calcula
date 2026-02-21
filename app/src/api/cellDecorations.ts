//! FILENAME: app/src/api/cellDecorations.ts
// PURPOSE: Cell Decoration Pipeline for in-cell graphical decorations
// CONTEXT: Allows extensions to draw custom graphics inside cells at render time
//          (e.g., Sparklines, data bars) without polluting the Core with feature logic.
// ARCHITECTURE: Part of the API layer - the bridge between Core and Extensions.
//              Follows the exact same pattern as styleInterceptors.ts.

import type { GridConfig, Viewport, DimensionOverrides } from "./types";

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
}

/**
 * Cell decoration function signature.
 * Called during render for each visible cell, between background/borders
 * and text rendering. The canvas is already clipped to the cell bounds.
 *
 * @param context - The rendering context with cell bounds and grid state
 */
export type CellDecorationFn = (context: CellDecorationContext) => void;

/** Decoration registration with metadata */
export interface CellDecorationRegistration {
  id: string;
  decorator: CellDecorationFn;
  /** Priority for rendering order (lower = draws first/underneath). Default: 0 */
  priority: number;
}

// ============================================================================
// Internal State
// ============================================================================

const decorationRegistry = new Map<string, CellDecorationRegistration>();
let sortedDecorations: CellDecorationRegistration[] = [];
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
 * @returns Cleanup function to unregister the decoration
 *
 * @example
 * ```ts
 * const cleanup = registerCellDecoration(
 *   "sparklines",
 *   (context) => {
 *     // Draw sparkline graphics in the cell
 *     drawSparkline(context);
 *   },
 *   0
 * );
 * ```
 */
export function registerCellDecoration(
  id: string,
  decorator: CellDecorationFn,
  priority: number = 0
): () => void {
  const registration: CellDecorationRegistration = {
    id,
    decorator,
    priority,
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
 * Get all registered decorations, sorted by priority.
 * Uses internal caching for performance (hot path in render loop).
 */
function getSortedDecorations(): CellDecorationRegistration[] {
  if (isDirty) {
    sortedDecorations = Array.from(decorationRegistry.values()).sort(
      (a, b) => a.priority - b.priority
    );
    isDirty = false;
  }
  return sortedDecorations;
}

/**
 * Check if any decorations are registered.
 * Used by the renderer to skip the decoration pipeline entirely when empty.
 */
export function hasCellDecorations(): boolean {
  return decorationRegistry.size > 0;
}

/**
 * Apply all registered decorations to a cell.
 * Called by the Core renderer for each visible cell between
 * background/border rendering and text rendering.
 *
 * @param context - The cell decoration context with canvas and bounds
 */
export function applyCellDecorations(context: CellDecorationContext): void {
  const decorations = getSortedDecorations();

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
