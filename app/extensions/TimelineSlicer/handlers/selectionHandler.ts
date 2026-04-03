//! FILENAME: app/extensions/TimelineSlicer/handlers/selectionHandler.ts
// PURPOSE: Show/hide the contextual Timeline Options ribbon tab based on selection.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  ExtensionRegistry,
} from "@api";
import { getTimelineById } from "../lib/timelineSlicerStore";
import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  TIMELINE_OPTIONS_TAB_ID,
  TimelineOptionsTabDefinition,
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
      ExtensionRegistry.registerRibbonTab(TimelineOptionsTabDefinition);
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
      ExtensionRegistry.unregisterRibbonTab(TIMELINE_OPTIONS_TAB_ID);
      optionsTabRegistered = false;
    }

    window.dispatchEvent(new Event("timelineSlicer:deselected"));
    requestOverlayRedraw();
  }
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
    ExtensionRegistry.unregisterRibbonTab(TIMELINE_OPTIONS_TAB_ID);
    optionsTabRegistered = false;
  }
  selectedTimelineIds.clear();
}
