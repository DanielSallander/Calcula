//! FILENAME: app/extensions/Slicer/handlers/selectionHandler.ts
// PURPOSE: Show/hide the contextual Slicer Options ribbon tab based on slicer selection.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  ExtensionRegistry,
  emitAppEvent,
} from "../../../src/api";
import { getSlicerById } from "../lib/slicerStore";
import { SLICER_OPTIONS_TAB_ID, SlicerOptionsTabDefinition } from "../manifest";
import { SlicerEvents } from "../lib/slicerEvents";

// ============================================================================
// State
// ============================================================================

let selectedSlicerId: number | null = null;
let optionsTabRegistered = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Called when a slicer is clicked (from the grid overlay hit test).
 * Shows the contextual ribbon tab and broadcasts the slicer state.
 */
export function selectSlicer(slicerId: number): void {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return;

  selectedSlicerId = slicerId;
  addTaskPaneContextKey("slicer");

  if (!optionsTabRegistered) {
    ExtensionRegistry.registerRibbonTab(SlicerOptionsTabDefinition);
    optionsTabRegistered = true;
  }

  // Broadcast current slicer state to the ribbon tab
  window.dispatchEvent(
    new CustomEvent(SlicerEvents.SLICER_UPDATED, { detail: slicer }),
  );
}

/**
 * Called when the user clicks away from any slicer (e.g., on a cell).
 * Hides the contextual ribbon tab.
 */
export function deselectSlicer(): void {
  if (selectedSlicerId !== null) {
    selectedSlicerId = null;
    removeTaskPaneContextKey("slicer");

    if (optionsTabRegistered) {
      ExtensionRegistry.unregisterRibbonTab(SLICER_OPTIONS_TAB_ID);
      optionsTabRegistered = false;
    }

    window.dispatchEvent(new Event("slicer:deselected"));
  }
}

/**
 * Get the currently selected slicer ID.
 */
export function getSelectedSlicerId(): number | null {
  return selectedSlicerId;
}

/**
 * Handle grid selection changes. If the user clicks on a cell (not a slicer),
 * deselect the slicer.
 */
export function handleSelectionChange(
  _selection: { endRow: number; endCol: number } | null,
): void {
  // When the grid selection changes (user clicked a cell), deselect slicer
  deselectSlicer();
}

/**
 * Ensure the tab is registered (used after slicer creation).
 */
export function ensureOptionsTabRegistered(): void {
  if (selectedSlicerId !== null && !optionsTabRegistered) {
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
  selectedSlicerId = null;
}
