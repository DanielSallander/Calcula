//! FILENAME: app/extensions/BuiltIn/FormatPainter/formatPainterState.ts
// PURPOSE: Module-level state for the Format Painter tool.
// CONTEXT: Manages active/inactive state, source styles, and cleanup functions.
// NOTE: Uses module-level variables (not React state) so it works from event handlers.
//
// PUBLISHED. Every change of `active` / `persistent` is published through
// @api/formatPainterState -- the ribbon's Format Painter button draws itself
// pressed (and locked) from it (Home tab = Excel's Home tab, contract 6.6).
// The setters below are the ONLY writers of those two flags, so a transition
// cannot happen without being announced.
//
// STARTING. Arming the painter first READS the source cells (one backend call
// per cell), so there is a window between "asked to start" and "armed". A
// second activation landing in that window -- the second click of a
// double-click, a key repeat -- used to start a SECOND painter beside the
// first: two sets of listeners, so every later paint was recorded as two undo
// steps (clipboard survey section 7). The window is now a state of its own: a
// second start is ignored, a LOCK upgrades the start, an Escape cancels it.

import type { Selection } from "@api/types";
import { publishFormatPainterState } from "@api/formatPainterState";

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

/** A start is reading its source cells (see STARTING above). */
let starting = false;
/** The start will arm a LOCKED painter (asked by LOCK, or upgraded by one). */
let startPersistent = false;
/** The start was cancelled (Escape, the extension going away): it must not arm. */
let startCancelled = false;

function publish(): void {
  publishFormatPainterState({ active, locked: active && persistent });
}

// ============================================================================
// Getters
// ============================================================================

export function isFormatPainterActive(): boolean {
  return active;
}

export function isFormatPainterPersistent(): boolean {
  return persistent;
}

/** Whether a painter is still reading its source cells, not yet armed. */
export function isFormatPainterStarting(): boolean {
  return starting;
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
  publish();
}

/**
 * Lock (or unlock) an ARMED painter in place -- its source, listeners and
 * cursor stay as they are. FORMAT_PAINTER_LOCK on an active painter lands
 * here: it upgrades, it never switches the painter off.
 */
export function setFormatPainterPersistent(isPersistent: boolean): void {
  if (!active) return;
  persistent = isPersistent;
  publish();
}

// ============================================================================
// Starting
// ============================================================================

/** A start begins reading its source; `isPersistent` = LOCK asked for it. */
export function beginFormatPainterStart(isPersistent: boolean): void {
  starting = true;
  startPersistent = isPersistent;
  startCancelled = false;
}

/** A LOCK arriving while a start reads its source: the painter arms locked. */
export function lockStartingFormatPainter(): void {
  if (starting) startPersistent = true;
}

/** Escape (or the extension going away) while a start reads its source: it never arms. */
export function cancelFormatPainterStart(): void {
  if (starting) startCancelled = true;
}

/** The start's source read is done: what it should do now. Ends the starting window. */
export function finishFormatPainterStart(): { persistent: boolean; cancelled: boolean } {
  const outcome = { persistent: startPersistent, cancelled: startCancelled };
  starting = false;
  startPersistent = false;
  startCancelled = false;
  return outcome;
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
  publish();
}
