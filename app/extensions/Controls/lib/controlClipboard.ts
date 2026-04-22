//! FILENAME: app/extensions/Controls/lib/controlClipboard.ts
// PURPOSE: Clipboard (copy/paste) and duplicate operations for floating controls.
// CONTEXT: Works with the floating store and backend control metadata.

import { AppEvents } from "@api";
import { emitAppEvent } from "@api/events";
import {
  getFloatingControl,
  addFloatingControl,
  syncFloatingControlRegions,
  makeFloatingControlId,
} from "./floatingStore";
import {
  getControlMetadata,
  setControlMetadata,
} from "./controlApi";
import {
  selectFloatingControl,
} from "../Button/floatingSelection";
import {
  invalidateFloatingButtonCache,
} from "../Button/floatingRenderer";
import {
  invalidateShapeCache,
} from "../Shape/shapeRenderer";
import {
  invalidateImageCache,
} from "../Image/imageRenderer";
import type { ControlMetadata } from "./types";

// ============================================================================
// Clipboard State
// ============================================================================

interface ClipboardEntry {
  /** The control metadata (deep copy) */
  metadata: ControlMetadata;
  /** Original width */
  width: number;
  /** Original height */
  height: number;
}

let clipboardEntry: ClipboardEntry | null = null;

/** Track how many times we've pasted from the same copy, to cascade offset. */
let pasteCount = 0;

// ============================================================================
// Constants
// ============================================================================

/** Pixel offset for each paste or duplicate operation. */
const PASTE_OFFSET = 20;

// ============================================================================
// Copy
// ============================================================================

/**
 * Copy a floating control's properties to the internal clipboard.
 */
export async function copyControl(controlId: string): Promise<void> {
  const ctrl = getFloatingControl(controlId);
  if (!ctrl) return;

  const metadata = await getControlMetadata(ctrl.sheetIndex, ctrl.row, ctrl.col);
  if (!metadata) return;

  // Deep copy the metadata
  clipboardEntry = {
    metadata: JSON.parse(JSON.stringify(metadata)),
    width: ctrl.width,
    height: ctrl.height,
  };
  pasteCount = 0;
}

// ============================================================================
// Paste
// ============================================================================

/**
 * Paste the clipboard control at an offset from the original position.
 * Each subsequent paste increases the offset to cascade.
 */
export async function pasteControl(sheetIndex: number): Promise<void> {
  if (!clipboardEntry) return;

  pasteCount++;
  const offset = PASTE_OFFSET * pasteCount;

  await createControlCopy(
    clipboardEntry.metadata,
    clipboardEntry.width,
    clipboardEntry.height,
    sheetIndex,
    offset,
  );
}

/**
 * Check whether there is a control on the clipboard.
 */
export function hasClipboardControl(): boolean {
  return clipboardEntry !== null;
}

// ============================================================================
// Duplicate
// ============================================================================

/**
 * Duplicate a floating control, placing the copy offset by 20px.
 */
export async function duplicateControl(controlId: string): Promise<void> {
  const ctrl = getFloatingControl(controlId);
  if (!ctrl) return;

  const metadata = await getControlMetadata(ctrl.sheetIndex, ctrl.row, ctrl.col);
  if (!metadata) return;

  const metaCopy: ControlMetadata = JSON.parse(JSON.stringify(metadata));

  await createControlCopy(
    metaCopy,
    ctrl.width,
    ctrl.height,
    ctrl.sheetIndex,
    PASTE_OFFSET,
  );
}

// ============================================================================
// Internal: Create a control copy
// ============================================================================

/**
 * Find the next free anchor cell on the given sheet.
 * Controls are anchored by (sheetIndex, row, col). We search for an unused cell
 * starting from (0, maxCol+1) to avoid collisions.
 */
async function findFreeAnchorCell(sheetIndex: number): Promise<{ row: number; col: number }> {
  const { getAllControls } = await import("./controlApi");
  const controls = await getAllControls(sheetIndex);

  // Find max col used, then use the next one at row 0
  let maxCol = -1;
  for (const entry of controls) {
    if (entry.col > maxCol) maxCol = entry.col;
  }
  // Use row 0 and maxCol+1 to avoid collisions
  return { row: 0, col: maxCol + 1 };
}

/**
 * Create a copy of a control with the given metadata and dimensions,
 * placed at an offset from the original position.
 */
async function createControlCopy(
  metadata: ControlMetadata,
  width: number,
  height: number,
  sheetIndex: number,
  offset: number,
): Promise<void> {
  // Parse the original position from metadata
  const origX = parseFloat(metadata.properties.x?.value ?? "0");
  const origY = parseFloat(metadata.properties.y?.value ?? "0");

  const newX = origX + offset;
  const newY = origY + offset;

  // Update position in the metadata copy
  metadata.properties.x = { valueType: "static", value: String(newX) };
  metadata.properties.y = { valueType: "static", value: String(newY) };

  // Find a free anchor cell
  const anchor = await findFreeAnchorCell(sheetIndex);

  // Save metadata to backend
  await setControlMetadata(sheetIndex, anchor.row, anchor.col, metadata);

  // Add to floating store
  const controlId = makeFloatingControlId(sheetIndex, anchor.row, anchor.col);
  addFloatingControl({
    id: controlId,
    sheetIndex,
    row: anchor.row,
    col: anchor.col,
    x: newX,
    y: newY,
    width,
    height,
    controlType: metadata.controlType,
  });

  // Select the new control
  selectFloatingControl(controlId);

  // Invalidate caches and refresh
  invalidateFloatingButtonCache(controlId);
  invalidateShapeCache(controlId);
  invalidateImageCache(controlId);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}
