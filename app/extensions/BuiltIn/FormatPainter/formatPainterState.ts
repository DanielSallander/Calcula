//! FILENAME: app/extensions/BuiltIn/FormatPainter/formatPainterState.ts
// PURPOSE: Module-level state for the Format Painter tool.
// CONTEXT: Manages active/inactive state, source styles, and cleanup functions.
// NOTE: Uses module-level variables (not React state) so it works from event handlers.

import type { Selection } from "../../../src/api/types";

// ============================================================================
// State
// ============================================================================

let active = false;
let persistent = false;
let sourceSelection: Selection | null = null;
let sourceStyles: Map<string, number> = new Map();
let sourceWidth = 0;
let sourceHeight = 0;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Getters
// ============================================================================

export function isFormatPainterActive(): boolean {
  return active;
}

export function isFormatPainterPersistent(): boolean {
  return persistent;
}

export function getSourceSelection(): Selection | null {
  return sourceSelection;
}

export function getSourceStyles(): Map<string, number> {
  return sourceStyles;
}

export function getSourceDimensions(): { width: number; height: number } {
  return { width: sourceWidth, height: sourceHeight };
}

// ============================================================================
// Setters
// ============================================================================

export function setFormatPainterActive(
  isActive: boolean,
  isPersistent: boolean,
  source: Selection | null,
  styles: Map<string, number>,
  width: number,
  height: number
): void {
  active = isActive;
  persistent = isPersistent;
  sourceSelection = source;
  sourceStyles = styles;
  sourceWidth = width;
  sourceHeight = height;
}

// ============================================================================
// Cleanup Management
// ============================================================================

export function addCleanup(fn: () => void): void {
  cleanupFns.push(fn);
}

export function runAllCleanups(): void {
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[FormatPainter] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
}

// ============================================================================
// Reset
// ============================================================================

export function clearFormatPainterState(): void {
  active = false;
  persistent = false;
  sourceSelection = null;
  sourceStyles = new Map();
  sourceWidth = 0;
  sourceHeight = 0;
  runAllCleanups();
}
