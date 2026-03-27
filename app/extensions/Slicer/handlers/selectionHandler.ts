//! FILENAME: app/extensions/Slicer/handlers/selectionHandler.ts
// PURPOSE: Show/hide the contextual Slicer Options ribbon tab based on slicer selection.
//          Supports multi-select via Ctrl+click.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  ExtensionRegistry,
} from "../../../src/api";
import { getSlicerById } from "../lib/slicerStore";
import { requestOverlayRedraw } from "../../../src/api/gridOverlays";
import { SLICER_OPTIONS_TAB_ID, SlicerOptionsTabDefinition } from "../manifest";
import { SlicerEvents } from "../lib/slicerEvents";
import type { Slicer } from "../lib/slicerTypes";

// ============================================================================
// State
// ============================================================================

/** Set of currently selected slicer IDs (supports multi-select). */
const selectedSlicerIds = new Set<number>();
let optionsTabRegistered = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Called when a slicer is clicked (from the grid overlay hit test).
 * Shows the contextual ribbon tab and broadcasts the slicer state.
 * @param additive If true (Ctrl+click), toggle the slicer in/out of the selection set.
 */
export function selectSlicer(slicerId: number, additive = false): void {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return;

  if (additive) {
    // Ctrl+click: toggle this slicer in the selection set
    if (selectedSlicerIds.has(slicerId)) {
      selectedSlicerIds.delete(slicerId);
    } else {
      selectedSlicerIds.add(slicerId);
    }
  } else {
    // Normal click: exclusive selection
    selectedSlicerIds.clear();
    selectedSlicerIds.add(slicerId);
  }

  if (selectedSlicerIds.size > 0) {
    addTaskPaneContextKey("slicer");

    if (!optionsTabRegistered) {
      ExtensionRegistry.registerRibbonTab(SlicerOptionsTabDefinition);
      optionsTabRegistered = true;
    }

    // Broadcast ALL selected slicers to the ribbon tab
    broadcastSelectedSlicers();
  } else {
    deselectSlicer();
  }

  // Redraw to show/update selection borders
  requestOverlayRedraw();
}

/**
 * Broadcast the current selection to the ribbon tab via a custom event.
 * Sends an array of Slicer objects for the tab to render mixed-value UI.
 */
export function broadcastSelectedSlicers(): void {
  const slicers: Slicer[] = [];
  for (const id of selectedSlicerIds) {
    const s = getSlicerById(id);
    if (s) slicers.push(s);
  }
  window.dispatchEvent(
    new CustomEvent(SlicerEvents.SLICER_UPDATED, { detail: slicers }),
  );
}

/**
 * Called when the user clicks away from any slicer (e.g., on a cell).
 * Hides the contextual ribbon tab.
 */
export function deselectSlicer(): void {
  if (selectedSlicerIds.size > 0) {
    selectedSlicerIds.clear();
    removeTaskPaneContextKey("slicer");

    if (optionsTabRegistered) {
      ExtensionRegistry.unregisterRibbonTab(SLICER_OPTIONS_TAB_ID);
      optionsTabRegistered = false;
    }

    window.dispatchEvent(new Event("slicer:deselected"));

    // Redraw to remove selection borders
    requestOverlayRedraw();
  }
}

/**
 * Get the currently selected slicer ID (primary/last-clicked).
 * For backward compatibility — returns the last selected slicer.
 */
export function getSelectedSlicerId(): number | null {
  if (selectedSlicerIds.size === 0) return null;
  let last: number | null = null;
  for (const id of selectedSlicerIds) {
    last = id;
  }
  return last;
}

/**
 * Get all currently selected slicer IDs.
 */
export function getSelectedSlicerIds(): ReadonlySet<number> {
  return selectedSlicerIds;
}

/**
 * Check if a specific slicer is selected.
 */
export function isSlicerSelected(slicerId: number): boolean {
  return selectedSlicerIds.has(slicerId);
}

/**
 * Handle grid selection changes. If the user clicks on a cell (not a slicer),
 * deselect the slicer.
 */
export function handleSelectionChange(
  _selection: { endRow: number; endCol: number } | null,
): void {
  if (selectedSlicerIds.size > 0) {
    deselectSlicer();
  }
}

/**
 * Ensure the tab is registered (used after slicer creation).
 */
export function ensureOptionsTabRegistered(): void {
  if (selectedSlicerIds.size > 0 && !optionsTabRegistered) {
    ExtensionRegistry.registerRibbonTab(SlicerOptionsTabDefinition);
    optionsTabRegistered = true;
  }
}

/**
 * Reset all selection handler state (used during extension cleanup).
 */
export function resetSelectionHandlerState(): void {
  if (optionsTabRegistered) {
    ExtensionRegistry.unregisterRibbonTab(SLICER_OPTIONS_TAB_ID);
    optionsTabRegistered = false;
  }
  selectedSlicerIds.clear();
}
