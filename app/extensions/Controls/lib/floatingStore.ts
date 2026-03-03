//! FILENAME: app/extensions/Controls/lib/floatingStore.ts
// PURPOSE: In-memory store for floating (non-embedded) control positions.
// CONTEXT: Follows the same pattern as Charts' chartStore.ts.
//          Manages floating control state and syncs to the grid overlay system.

import {
  removeGridRegionsByType,
  replaceGridRegionsByType,
  type GridRegion,
} from "../../../src/api/gridOverlays";
import { getDesignMode } from "./designMode";

// ============================================================================
// Types
// ============================================================================

export interface FloatingControl {
  /** Unique ID: "control-{sheet}-{row}-{col}" */
  id: string;
  sheetIndex: number;
  /** Anchor cell row (for metadata lookup) */
  row: number;
  /** Anchor cell column (for metadata lookup) */
  col: number;
  /** X position in sheet pixels (relative to cell A1 top-left) */
  x: number;
  /** Y position in sheet pixels */
  y: number;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Control type (e.g., "button") */
  controlType: string;
}

// ============================================================================
// Store State
// ============================================================================

let floatingControls: FloatingControl[] = [];

// ============================================================================
// Store Operations
// ============================================================================

/** Build a unique ID for a floating control. */
export function makeFloatingControlId(sheetIndex: number, row: number, col: number): string {
  return `control-${sheetIndex}-${row}-${col}`;
}

/** Add a floating control to the store. */
export function addFloatingControl(ctrl: FloatingControl): void {
  // Remove existing with same ID first
  floatingControls = floatingControls.filter((c) => c.id !== ctrl.id);
  floatingControls.push(ctrl);
}

/** Remove a floating control by ID. */
export function removeFloatingControl(id: string): void {
  floatingControls = floatingControls.filter((c) => c.id !== id);
}

/** Get a floating control by ID. */
export function getFloatingControl(id: string): FloatingControl | null {
  return floatingControls.find((c) => c.id === id) ?? null;
}

/** Get all floating controls. */
export function getAllFloatingControls(): FloatingControl[] {
  return [...floatingControls];
}

/** Get floating controls for a specific sheet. */
export function getFloatingControlsForSheet(sheetIndex: number): FloatingControl[] {
  return floatingControls.filter((c) => c.sheetIndex === sheetIndex);
}

/** Move a floating control to a new position. */
export function moveFloatingControl(id: string, x: number, y: number): void {
  const ctrl = floatingControls.find((c) => c.id === id);
  if (ctrl) {
    ctrl.x = x;
    ctrl.y = y;
  }
}

/** Resize a floating control (full bounds update for all-corner resize). */
export function resizeFloatingControl(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const ctrl = floatingControls.find((c) => c.id === id);
  if (ctrl) {
    ctrl.x = x;
    ctrl.y = y;
    ctrl.width = width;
    ctrl.height = height;
  }
}

/** Reset the entire floating store (used during extension deactivation). */
export function resetFloatingStore(): void {
  floatingControls = [];
  removeGridRegionsByType("floating-control");
}

// ============================================================================
// Grid Overlay Sync
// ============================================================================

/**
 * Sync all floating controls to the grid overlay system.
 * Call this after any mutation (add, move, resize, remove).
 *
 * Floating controls use the `floating` field on GridRegion for pixel positioning.
 * Cell-based fields (startRow, etc.) are set to 0 since they're unused.
 */
export function syncFloatingControlRegions(): void {
  const regions: GridRegion[] = floatingControls.map((ctrl) => ({
    id: ctrl.id,
    type: "floating-control",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: {
      x: ctrl.x,
      y: ctrl.y,
      width: ctrl.width,
      height: ctrl.height,
    },
    data: {
      sheetIndex: ctrl.sheetIndex,
      row: ctrl.row,
      col: ctrl.col,
      controlType: ctrl.controlType,
      movable: getDesignMode() || ctrl.controlType === "shape",
      resizable: getDesignMode() || ctrl.controlType === "shape",
    },
  }));

  replaceGridRegionsByType("floating-control", regions);
}
