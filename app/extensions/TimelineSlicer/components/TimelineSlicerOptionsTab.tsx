//! FILENAME: app/extensions/TimelineSlicer/components/TimelineSlicerOptionsTab.tsx
// PURPOSE: Panel sections for the contextual Timeline options panel.
// CONTEXT: Appears when a timeline slicer is selected on the grid. Each former
//          RibbonGroup is now a PanelSection (registered via
//          TimelineOptionsPanelDefinition in ../manifest.ts); the shell owns
//          group chrome, labels, and width-collapse behavior, so sections only
//          render their inner controls with @api/layout primitives.

import React, { useState, useEffect } from "react";
import { showDialog } from "@api";
import { ControlRow, ActionRow, Button, ToggleButton } from "@api/layout";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { TimelineSlicerEvents } from "../lib/timelineSlicerEvents";
import {
  getTimelineById,
  updateTimelineAsync,
  deleteTimelineAsync,
  updateTimelineSelectionAsync,
} from "../lib/timelineSlicerStore";
import { getSelectedTimelineId } from "../handlers/selectionHandler";
import { TIMELINE_SETTINGS_DIALOG_ID } from "../manifest";
import type { TimelineSlicer, TimelineLevel } from "../lib/timelineSlicerTypes";

// ============================================================================
// Shared selection state
// ============================================================================

/**
 * Tracks the currently selected timeline for the contextual panel sections.
 * Mirrors the selection broadcast from handlers/selectionHandler.ts: the
 * TIMELINE_UPDATED custom event carries the selected timeline(s) and the
 * "timelineSlicer:deselected" event clears the state.
 */
function useSelectedTimeline(): [
  TimelineSlicer | null,
  (tl: TimelineSlicer | null) => void,
] {
  const [timeline, setTimeline] = useState<TimelineSlicer | null>(null);

  useEffect(() => {
    const handleUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (Array.isArray(detail) && detail.length > 0) {
        setTimeline(detail[0]);
      } else if (detail && !Array.isArray(detail)) {
        setTimeline(detail);
      }
    };

    const handleDeselect = () => setTimeline(null);

    window.addEventListener(TimelineSlicerEvents.TIMELINE_UPDATED, handleUpdate);
    window.addEventListener("timelineSlicer:deselected", handleDeselect);

    // Initialize from current selection
    const id = getSelectedTimelineId();
    if (id != null) {
      const tl = getTimelineById(id);
      if (tl) setTimeline(tl);
    }

    return () => {
      window.removeEventListener(TimelineSlicerEvents.TIMELINE_UPDATED, handleUpdate);
      window.removeEventListener("timelineSlicer:deselected", handleDeselect);
    };
  }, []);

  return [timeline, setTimeline];
}

// ============================================================================
// Section: Level
// ============================================================================

const LEVELS: TimelineLevel[] = ["years", "quarters", "months", "days"];
const LEVEL_LABELS = ["Years", "Quarters", "Months", "Days"];

/** Time-level switcher (Years / Quarters / Months / Days). */
export function TimelineLevelSection(): React.ReactElement | null {
  const [timeline, setTimeline] = useSelectedTimeline();

  const handleLevelChange = async (level: TimelineLevel) => {
    if (!timeline) return;
    const updated = await updateTimelineAsync(timeline.id, { level });
    if (updated) setTimeline(updated);
    requestOverlayRedraw();
  };

  if (!timeline) return null;

  return (
    <ControlRow gap={2}>
      {LEVELS.map((level, i) => (
        <ToggleButton
          key={level}
          size="sm"
          active={timeline.level === level}
          onClick={() => handleLevelChange(level)}
          title={`Show ${LEVEL_LABELS[i]}`}
        >
          {LEVEL_LABELS[i]}
        </ToggleButton>
      ))}
    </ControlRow>
  );
}

// ============================================================================
// Section: Filter
// ============================================================================

/** Clear-filter action for the selected timeline. */
export function TimelineFilterSection(): React.ReactElement | null {
  const [timeline, setTimeline] = useSelectedTimeline();

  const handleClearFilter = async () => {
    if (!timeline) return;
    await updateTimelineSelectionAsync(timeline.id, null, null);
    const tl = getTimelineById(timeline.id);
    if (tl) setTimeline(tl);
  };

  if (!timeline) return null;

  return (
    <ActionRow>
      <Button
        onClick={handleClearFilter}
        title="Clear the timeline filter"
        style={{
          opacity: timeline.selectionStart !== null ? 1 : 0.5,
        }}
      >
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 4h16l-5 6v5l-4 2V10z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
          <line x1="15" y1="15" x2="19" y2="19" stroke="#c42b1c" strokeWidth="2"/>
          <line x1="19" y1="15" x2="15" y2="19" stroke="#c42b1c" strokeWidth="2"/>
        </svg>
        Clear Filter
      </Button>
    </ActionRow>
  );
}

// ============================================================================
// Section: Timeline (settings / delete)
// ============================================================================

/** Settings and delete actions for the selected timeline. */
export function TimelineActionsSection(): React.ReactElement | null {
  const [timeline] = useSelectedTimeline();

  const handleSettings = () => {
    if (!timeline) return;
    showDialog(TIMELINE_SETTINGS_DIALOG_ID, { timelineId: timeline.id });
  };

  const handleDelete = async () => {
    if (!timeline) return;
    await deleteTimelineAsync(timeline.id);
  };

  if (!timeline) return null;

  return (
    <ActionRow>
      <Button onClick={handleSettings} title="Timeline Settings">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M11 14a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="1.4"/>
          <path d="M9.5 2.5l-.4 1.7a7 7 0 00-1.8 1l-1.6-.6L4.2 6.8l1.2 1.2a7 7 0 000 2l-1.2 1.2 1.5 2.2 1.6-.6a7 7 0 001.8 1l.4 1.7h3l.4-1.7a7 7 0 001.8-1l1.6.6 1.5-2.2-1.2-1.2a7 7 0 000-2l1.2-1.2-1.5-2.2-1.6.6a7 7 0 00-1.8-1l-.4-1.7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
        </svg>
        Settings
      </Button>
      <Button
        onClick={handleDelete}
        title="Delete this Timeline"
        style={{ color: "#c42b1c" }}
      >
        <span>&#x2716;</span>
        Delete
      </Button>
    </ActionRow>
  );
}
