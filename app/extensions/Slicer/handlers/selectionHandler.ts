//! FILENAME: app/extensions/Slicer/handlers/selectionHandler.ts
// PURPOSE: Show/hide the contextual Slicer Options panel (ribbon-placed) based
//          on slicer selection. Supports multi-select via Ctrl+click.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
} from "@api";
import { registerPanel, unregisterPanel } from "@api/ui";
import { getSlicerById } from "../lib/slicerStore";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { SLICER_OPTIONS_TAB_ID, SlicerOptionsPanelDefinition } from "../manifest";
import { SlicerEvents } from "../lib/slicerEvents";
import type { Slicer } from "../lib/slicerTypes";

// ============================================================================
// State
// ============================================================================

/** Set of currently selected slicer IDs (supports multi-select). */
const selectedSlicerIds = new Set<string>();
let optionsPanelRegistered = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Called when a slicer is clicked (from the grid overlay hit test).
 * Shows the contextual panel and broadcasts the slicer state.
 * @param additive If true (Ctrl+click), toggle the slicer in/out of the selection set.
 */
export function selectSlicer(slicerId: string, additive = false): void {
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

    if (!optionsPanelRegistered) {
      registerPanel(SlicerOptionsPanelDefinition);
      optionsPanelRegistered = true;
    }

    // Broadcast ALL selected slicers to the panel sections
    broadcastSelectedSlicers();
  } else {
    deselectSlicer();
  }

  // Redraw to show/update selection borders
  requestOverlayRedraw();
}

/**
 * Broadcast the current selection to the panel sections via a custom event.
 * Sends an array of Slicer objects for the sections to render mixed-value UI.
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
 * Hides the contextual panel.
 */
export function deselectSlicer(): void {
  if (selectedSlicerIds.size > 0) {
    selectedSlicerIds.clear();
    removeTaskPaneContextKey("slicer");

    if (optionsPanelRegistered) {
      unregisterPanel(SLICER_OPTIONS_TAB_ID);
      optionsPanelRegistered = false;
    }

    window.dispatchEvent(new Event("slicer:deselected"));

    // Redraw to remove selection borders
    requestOverlayRedraw();
  }
}

/**
 * Drop ONE slicer out of the selection because it no longer exists.
 *
 * §3cd, BUG-0026. The contextual Slicer Options tab is a function of the
 * SELECTION, and the selection is a set of ids — so an id whose slicer was
 * removed by a backend cascade (its table deleted, its pivot deleted, its sheet
 * deleted, or any of those driven by an AI client over MCP) leaves the tab on
 * screen addressing an object that is gone. The measured end state was a Slicer
 * tab on a workbook with zero slicers.
 *
 * ONE slicer, not the whole selection: Excel keeps the rest of a multi-select
 * when one of its members goes away, and the previous handler cleared
 * everything. The panel is unregistered only when nothing is left to configure.
 */
export function dropSlicerFromSelection(slicerId: string): void {
  if (!selectedSlicerIds.delete(slicerId)) return;
  if (selectedSlicerIds.size === 0) {
    // Re-arm the guard `deselectSlicer` checks — the delete above already
    // emptied the set, and it returns early on an empty one.
    selectedSlicerIds.add(slicerId);
    deselectSlicer();
    return;
  }
  broadcastSelectedSlicers();
  requestOverlayRedraw();
}

/**
 * Get the currently selected slicer ID (primary/last-clicked).
 * For backward compatibility — returns the last selected slicer.
 */
export function getSelectedSlicerId(): string | null {
  if (selectedSlicerIds.size === 0) return null;
  let last: string | null = null;
  for (const id of selectedSlicerIds) {
    last = id;
  }
  return last;
}

/**
 * Get all currently selected slicer IDs.
 */
export function getSelectedSlicerIds(): ReadonlySet<string> {
  return selectedSlicerIds;
}

/**
 * Check if a specific slicer is selected.
 */
export function isSlicerSelected(slicerId: string): boolean {
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
 * Ensure the panel is registered (used after slicer creation).
 */
export function ensureOptionsTabRegistered(): void {
  if (selectedSlicerIds.size > 0 && !optionsPanelRegistered) {
    registerPanel(SlicerOptionsPanelDefinition);
    optionsPanelRegistered = true;
  }
}

/**
 * Reset all selection handler state (used during extension cleanup).
 */
export function resetSelectionHandlerState(): void {
  if (optionsPanelRegistered) {
    unregisterPanel(SLICER_OPTIONS_TAB_ID);
    optionsPanelRegistered = false;
  }
  selectedSlicerIds.clear();
}
