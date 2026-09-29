//! FILENAME: app/extensions/TimelineSlicer/components/TimelineSlicerOptionsTab.tsx
// PURPOSE: Panel sections for the contextual Timeline options panel.
// CONTEXT: Appears when a timeline slicer is selected on the grid. Each former
//          RibbonGroup is now a PanelSection (registered via
//          TimelineOptionsPanelDefinition in ../manifest.ts); the shell owns
//          group chrome, labels, and width-collapse behavior, so sections only
//          render their inner controls with @api/layout primitives.
//
//          Calcula Clusters: every section fills the band's 61px content box
//          with ONE TALL ROW (the fill rule, @api/layout tokens.ts) — the time
//          level is a tall SegmentedChoice (one radio group: arrow keys move
//          and select, one Tab crosses it), and the actions are CommandButton
//          heroes. "Clear Filter" is genuinely disabled while no range is
//          selected, rather than drawn at half opacity and left clickable.
//          Outside the band the same controls render at the standard 28px.
//
//          Colours come only from the icon set and the primitives.

import React, { useState, useEffect } from "react";
import { showDialog } from "@api";
import {
  ActionRow,
  CommandButton,
  GAP_XS,
  HERO_ICON_SIZE,
  SegmentedChoice,
  useSurfaceLayout,
  type SegmentedChoiceOption,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
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

/** The time levels, coarsest first, with their visible names. */
const LEVEL_OPTIONS: ReadonlyArray<SegmentedChoiceOption<TimelineLevel>> = [
  { value: "years", label: "Years", tooltip: "Show Years" },
  { value: "quarters", label: "Quarters", tooltip: "Show Quarters" },
  { value: "months", label: "Months", tooltip: "Show Months" },
  { value: "days", label: "Days", tooltip: "Show Days" },
];

/** Time-level switcher (Years / Quarters / Months / Days). */
export function TimelineLevelSection(): React.ReactElement | null {
  const [timeline, setTimeline] = useSelectedTimeline();
  const band = useSurfaceLayout().container === "band";

  const handleLevelChange = async (level: TimelineLevel) => {
    if (!timeline) return;
    const updated = await updateTimelineAsync(timeline.id, { level });
    if (updated) setTimeline(updated);
    requestOverlayRedraw();
  };

  if (!timeline) return null;

  return (
    <SegmentedChoice<TimelineLevel>
      ariaLabel="Time level"
      // One tall row in the band; a standard 28px pill in a panel or flyout.
      size={band ? "tall" : "md"}
      value={timeline.level}
      options={LEVEL_OPTIONS}
      onChange={handleLevelChange}
    />
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
    // A USER gesture: a clear that grows a pivot over the user's cells is
    // asked about once, and a decline takes it back (the review of S2).
    await updateTimelineSelectionAsync(timeline.id, null, null, { askBeforeOverwrite: true });
    const tl = getTimelineById(timeline.id);
    if (tl) setTimeline(tl);
  };

  if (!timeline) return null;

  const hasFilter = timeline.selectionStart !== null;

  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.ClearFilter size={HERO_ICON_SIZE} />}
        label="Clear Filter"
        onClick={handleClearFilter}
        tooltip={hasFilter ? "Clear the timeline filter" : "The timeline has no filter to clear"}
        disabled={!hasFilter}
      />
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
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Settings size={HERO_ICON_SIZE} />}
        label="Settings"
        onClick={handleSettings}
        tooltip="Timeline Settings"
      />
      <CommandButton
        icon={<RibbonIcon.Delete size={HERO_ICON_SIZE} />}
        label="Delete"
        onClick={handleDelete}
        tooltip="Delete this Timeline"
      />
    </ActionRow>
  );
}
