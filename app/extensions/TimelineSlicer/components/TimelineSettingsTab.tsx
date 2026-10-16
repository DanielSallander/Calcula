//! FILENAME: app/extensions/TimelineSlicer/components/TimelineSettingsTab.tsx
// PURPOSE: The timeline's SETTINGS tab in the object pane (WP-C D-PANE: a
//          timeline's tab set is Settings | Format): the Timeline Settings
//          body in its pane layout, each change committed at once.
// CONTEXT: The body is TimelineSettingsBody.tsx -- the dialog's own fields --
//          so the pane and "Timeline Settings..." cannot drift apart. Every
//          change is ONE undo step labelled "Timeline Settings" (the backend's
//          update joins the transaction opened here), sending only what
//          changed. The tab re-reads the timeline whenever the store says what
//          it holds changed (an undo, a ribbon edit, a script). On a subscribed
//          page every control is disabled with the pane's reason.

import React, { useCallback, useEffect, useState } from "react";
import { runInUndoTransaction } from "@api/objectGeometry";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { getTimelineById, updateTimelineAsync } from "../lib/timelineSlicerStore";
import { TimelineSlicerEvents } from "../lib/timelineSlicerEvents";
import {
  TimelineSettingsBody,
  timelineSettingsParams,
  timelineSettingsValuesOf,
  type TimelineSettingsValues,
} from "./TimelineSettingsBody";

export interface TimelineSettingsTabProps {
  timelineId: string;
  readOnly: boolean;
  readOnlyReason: string | null;
}

/** The undo step one Settings-tab change records. */
export const TIMELINE_SETTINGS_UNDO_LABEL = "Timeline Settings";

/** What the tab says when its timeline is gone. */
export const TIMELINE_SETTINGS_GONE = "This timeline no longer exists.";

/** Commit some settings as ONE "Timeline Settings" step (nothing when nothing is sent). */
export async function commitTimelineSettings(timelineId: string, patch: Partial<TimelineSettingsValues>): Promise<void> {
  const params = timelineSettingsParams(patch);
  if (Object.keys(params).length === 0) return;
  await runInUndoTransaction(TIMELINE_SETTINGS_UNDO_LABEL, async () => {
    await updateTimelineAsync(timelineId, params);
  });
  requestOverlayRedraw();
}

export function TimelineSettingsTab({ timelineId, readOnly, readOnlyReason }: TimelineSettingsTabProps): React.ReactElement {
  const read = useCallback((): TimelineSettingsValues | null => {
    const tl = getTimelineById(timelineId);
    return tl ? timelineSettingsValuesOf(tl) : null;
  }, [timelineId]);

  const [values, setValues] = useState<TimelineSettingsValues | null>(read);

  // Follow the store: whatever changed the timeline, the tab shows it.
  useEffect(() => {
    setValues(read());
    const refresh = (): void => setValues(read());
    window.addEventListener(TimelineSlicerEvents.TIMELINE_DATA_CHANGED, refresh);
    window.addEventListener(TimelineSlicerEvents.TIMELINE_UPDATED, refresh);
    return () => {
      window.removeEventListener(TimelineSlicerEvents.TIMELINE_DATA_CHANGED, refresh);
      window.removeEventListener(TimelineSlicerEvents.TIMELINE_UPDATED, refresh);
    };
  }, [read]);

  const onChange = useCallback(
    (patch: Partial<TimelineSettingsValues>) => {
      if (readOnly) return;
      setValues((v) => (v ? { ...v, ...patch } : v));
      void commitTimelineSettings(timelineId, patch).catch((err) =>
        console.error("[TimelineSlicer] the settings could not be saved:", err),
      );
    },
    [timelineId, readOnly],
  );

  if (!values) {
    return (
      <div data-testid="timeline-settings-tab" style={{ padding: "16px 12px", fontSize: 12 }}>
        {TIMELINE_SETTINGS_GONE}
      </div>
    );
  }

  return (
    <div data-testid="timeline-settings-tab" title={readOnly && readOnlyReason ? readOnlyReason : undefined}>
      <TimelineSettingsBody variant="pane" values={values} onChange={onChange} disabled={readOnly} />
    </div>
  );
}
