//! FILENAME: app/extensions/TimelineSlicer/handlers/selectionHandler.ts
// PURPOSE: Show/hide the contextual Timeline options panel based on selection.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
} from "@api";
import { registerPanel, unregisterPanel } from "@api/ui";
import { getTimelineById } from "../lib/timelineSlicerStore";
import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  TIMELINE_OPTIONS_TAB_ID,
  TimelineOptionsPanelDefinition,
} from "../manifest";
import { TimelineSlicerEvents } from "../lib/timelineSlicerEvents";
import type { TimelineSlicer } from "../lib/timelineSlicerTypes";

// ============================================================================
// State
// ============================================================================

const selectedTimelineIds = new Set<number>();
let optionsTabRegistered = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Called when a timeline slicer is clicked.
 * Shows the contextual ribbon tab and broadcasts the state.
 */
export function selectTimeline(timelineId: number, additive = false): void {
  const tl = getTimelineById(timelineId);
  if (!tl) return;

  if (additive) {
    if (selectedTimelineIds.has(timelineId)) {
      selectedTimelineIds.delete(timelineId);
    } else {
      selectedTimelineIds.add(timelineId);
    }
  } else {
    selectedTimelineIds.clear();
    selectedTimelineIds.add(timelineId);
  }

  if (selectedTimelineIds.size > 0) {
    addTaskPaneContextKey("timeline-slicer");

    if (!optionsTabRegistered) {
      registerPanel(TimelineOptionsPanelDefinition);
      optionsTabRegistered = true;
    }

    broadcastSelectedTimelines();
  } else {
    deselectTimeline();
  }

  requestOverlayRedraw();
}

/**
 * Broadcast the current selection to the ribbon tab via a custom event.
 */
export function broadcastSelectedTimelines(): void {
  const timelines: TimelineSlicer[] = [];
  for (const id of selectedTimelineIds) {
    const tl = getTimelineById(id);
    if (tl) timelines.push(tl);
  }
  window.dispatchEvent(
    new CustomEvent(TimelineSlicerEvents.TIMELINE_UPDATED, {
      detail: timelines,
    }),
  );
}

/**
 * Called when the user clicks away from any timeline slicer.
 */
export function deselectTimeline(): void {
  if (selectedTimelineIds.size > 0) {
    selectedTimelineIds.clear();
    removeTaskPaneContextKey("timeline-slicer");

    if (optionsTabRegistered) {
      unregisterPanel(TIMELINE_OPTIONS_TAB_ID);
      optionsTabRegistered = false;
    }

    window.dispatchEvent(new Event("timelineSlicer:deselected"));
    requestOverlayRedraw();
  }
}

/**
 * Drop ONE timeline out of the selection because it no longer exists.
 *
 * §3cd: the twin of `dropSlicerFromSelection`, and for the same reason — the
 * contextual Timeline Options tab is a function of the selection, so an id
 * whose timeline was cascade-deleted leaves the tab on screen with nothing to
 * configure. One timeline, not the whole selection: Excel keeps the survivors
 * of a multi-select.
 */
export function dropTimelineFromSelection(timelineId: number): void {
  if (!selectedTimelineIds.delete(timelineId)) return;
  if (selectedTimelineIds.size === 0) {
    // Re-arm the guard `deselectTimeline` checks -- the delete above already
    // emptied the set, and it returns early on an empty one.
    selectedTimelineIds.add(timelineId);
    deselectTimeline();
    return;
  }
  broadcastSelectedTimelines();
  requestOverlayRedraw();
}

export function getSelectedTimelineId(): number | null {
  if (selectedTimelineIds.size === 0) return null;
  let last: number | null = null;
  for (const id of selectedTimelineIds) {
    last = id;
  }
  return last;
}

export function getSelectedTimelineIds(): ReadonlySet<number> {
  return selectedTimelineIds;
}

export function isTimelineSelected(timelineId: number): boolean {
  return selectedTimelineIds.has(timelineId);
}

export function handleSelectionChange(
  _selection: { endRow: number; endCol: number } | null,
): void {
  if (selectedTimelineIds.size > 0) {
    deselectTimeline();
  }
}

export function resetSelectionHandlerState(): void {
  if (optionsTabRegistered) {
    unregisterPanel(TIMELINE_OPTIONS_TAB_ID);
    optionsTabRegistered = false;
  }
  selectedTimelineIds.clear();
}
