//! FILENAME: app/extensions/TimelineSlicer/components/TimelineFormatCards.tsx
// PURPOSE: The timeline's own "Visual" card in the object pane's Format tab
//          (WP-C D-FORMAT): STYLE -- the timeline styles gallery.
// CONTEXT: The host (BuiltIn/ObjectPane) wraps the card in its collapsible
//          frame; this is the body only. A pick is ONE "Timeline Style" undo
//          step (update_timeline_slicer { stylePreset }); the card re-reads the
//          timeline when the store says it changed, so an undo shows at once.
//          On a subscribed page the gallery is disabled with the pane's reason.

import React, { useEffect, useState } from "react";
import type { FormatCardContribution, FormatCardProps } from "@api/objectFormat";
import { runInUndoTransaction } from "@api/objectGeometry";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { getTimelineById, updateTimelineAsync } from "../lib/timelineSlicerStore";
import { TimelineSlicerEvents } from "../lib/timelineSlicerEvents";
import { TimelineStylesGallery } from "./TimelineSlicerStylesGallery";

/** The contribution id (the Format tab's `data-format-card`). */
export const TIMELINE_STYLE_CARD_ID = "timeline-style";

/** The undo step a style pick records. */
export const TIMELINE_STYLE_UNDO_LABEL = "Timeline Style";

function timelineIdOf(region: FormatCardProps["region"]): string | null {
  const id = (region.data as { timelineId?: unknown } | undefined)?.timelineId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** Set a timeline's style as ONE undo step (nothing when it is already that style). */
export async function setTimelineStyle(timelineId: string, stylePreset: string): Promise<void> {
  if (getTimelineById(timelineId)?.stylePreset === stylePreset) return;
  await runInUndoTransaction(TIMELINE_STYLE_UNDO_LABEL, async () => {
    await updateTimelineAsync(timelineId, { stylePreset });
  });
  requestOverlayRedraw();
}

/** The Style card: the timeline styles gallery. */
export function TimelineStyleCard({ region, readOnly, readOnlyReason }: FormatCardProps): React.ReactElement | null {
  const timelineId = timelineIdOf(region);
  const [preset, setPreset] = useState<string | null>(() =>
    timelineId ? getTimelineById(timelineId)?.stylePreset ?? null : null,
  );

  useEffect(() => {
    if (!timelineId) return;
    const refresh = (): void => setPreset(getTimelineById(timelineId)?.stylePreset ?? null);
    refresh();
    window.addEventListener(TimelineSlicerEvents.TIMELINE_DATA_CHANGED, refresh);
    window.addEventListener(TimelineSlicerEvents.TIMELINE_UPDATED, refresh);
    return () => {
      window.removeEventListener(TimelineSlicerEvents.TIMELINE_DATA_CHANGED, refresh);
      window.removeEventListener(TimelineSlicerEvents.TIMELINE_UPDATED, refresh);
    };
  }, [timelineId]);

  if (!timelineId || preset === null) return null;
  return (
    <fieldset
      disabled={readOnly}
      title={readOnly && readOnlyReason ? readOnlyReason : undefined}
      style={{ border: 0, margin: 0, padding: 0, minWidth: 0, ...(readOnly ? { pointerEvents: "none", opacity: 0.6 } : {}) }}
      data-testid="timeline-format-style"
    >
      <TimelineStylesGallery
        selected={preset}
        onSelect={(next) => {
          if (readOnly) return;
          setPreset(next);
          void setTimelineStyle(timelineId, next).catch((err) =>
            console.error("[TimelineSlicer] the style could not be set:", err),
          );
        }}
      />
    </fieldset>
  );
}

/** The timeline's visual cards. */
export const TIMELINE_FORMAT_CARDS: readonly FormatCardContribution[] = Object.freeze([
  { id: TIMELINE_STYLE_CARD_ID, title: "Timeline style", order: 10, Component: TimelineStyleCard },
]);
