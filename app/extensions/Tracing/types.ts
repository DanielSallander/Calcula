//! FILENAME: app/extensions/Tracing/types.ts
// PURPOSE: Type definitions for the Tracing extension (Trace Precedents / Dependents).
// CONTEXT: Used by tracingStore, arrow renderer, hit test, and navigation.

// ============================================================================
// Arrow Types
// ============================================================================

/** Direction of the trace operation. */
export type TraceDirection = "precedents" | "dependents";

/** Visual style of a trace arrow. */
export type ArrowStyle = "solid-blue" | "dashed-black" | "solid-red";

/** A single visible arrow on the grid. */
export interface TraceArrow {
  /** Unique identifier for this arrow */
  id: string;
  /** Direction (precedents = incoming data, dependents = outgoing consumers) */
  direction: TraceDirection;
  /** Source cell (the cell being traced) */
  sourceRow: number;
  sourceCol: number;
  /** Target cell (single cell endpoint) */
  targetRow: number;
  targetCol: number;
  /**
   * If the target is a contiguous range, store its bounds.
   * The renderer draws a colored border around the range and routes
   * the arrow to the nearest edge of that border.
   */
  targetRange?: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  };
  /** Whether this arrow represents a cross-sheet reference */
  isCrossSheet: boolean;
  /** Cross-sheet metadata (only set when isCrossSheet is true) */
  crossSheetInfo?: {
    sheetName: string;
    sheetIndex: number;
    row: number;
    col: number;
  };
  /** Arrow visual style */
  style: ArrowStyle;
  /** Trace level (1 = direct, 2 = inputs of inputs, etc.) */
  level: number;
}

// ============================================================================
// Arrow Path (computed pixel coordinates)
// ============================================================================

/** Computed pixel coordinates for rendering an arrow on the canvas. */
export interface ArrowPath {
  /** Start point (source cell center) */
  startX: number;
  startY: number;
  /** End point (target cell center, range edge, or cross-sheet icon position) */
  endX: number;
  endY: number;
  /** Angle of the line at the endpoint (radians), used for arrowhead rotation */
  angle: number;
}
