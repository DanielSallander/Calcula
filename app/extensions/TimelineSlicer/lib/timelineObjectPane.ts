//! FILENAME: app/extensions/TimelineSlicer/lib/timelineObjectPane.ts
// PURPOSE: The timeline's @api/objectPane provider (WP-C D-PANE): its BUILD
//          tab in the ONE object pane -- Settings (+ the host's Format) -- and
//          the pane header.
// CONTEXT: Settings is the Timeline Settings dialog's body
//          (components/TimelineSettingsBody.tsx) in its pane layout,
//          committing each change at once; the header text / show header are
//          the Format tab's Title card and the style its Style card.

import React from "react";
import type { GridRegion } from "@api/gridOverlays";
import type { ObjectPaneProvider, ObjectPaneTab, ObjectPaneTabContext } from "@api/objectPane";
import { TimelineSettingsTab } from "../components/TimelineSettingsTab";
import { TIMELINE_FORMAT_REGION_TYPE, timelineIdOfFormatRegion } from "./timelineObjectFormat";
import type { TimelineSlicer } from "./timelineSlicerTypes";

/** The timeline's build tab id (never "format": the host owns it). */
export const TIMELINE_PANE_TAB_SETTINGS = "settings";

/** What the provider needs from the store (injected: no store import here). */
export interface TimelineObjectPaneDeps {
  getTimeline(timelineId: string): TimelineSlicer | undefined;
}

/** "Timeline - Order Date", or "Timeline" when the timeline is gone. */
export function timelinePaneHeader(tl: Pick<TimelineSlicer, "name"> | undefined): string {
  return tl && tl.name ? `Timeline - ${tl.name}` : "Timeline";
}

/** Build the @api/objectPane provider for the timeline region type. */
export function createTimelineObjectPaneProvider(deps: TimelineObjectPaneDeps): ObjectPaneProvider {
  return {
    types: [TIMELINE_FORMAT_REGION_TYPE],

    tabs(region: GridRegion): readonly ObjectPaneTab[] {
      const timelineId = timelineIdOfFormatRegion(region);
      if (timelineId === null) return [];
      return [
        {
          id: TIMELINE_PANE_TAB_SETTINGS,
          label: "Settings",
          render: (ctx: ObjectPaneTabContext) =>
            React.createElement(TimelineSettingsTab, {
              key: timelineId,
              timelineId,
              readOnly: ctx.readOnly,
              readOnlyReason: ctx.readOnlyReason,
            }),
        },
      ];
    },

    headerOf(region: GridRegion): string {
      const timelineId = timelineIdOfFormatRegion(region);
      return timelinePaneHeader(timelineId === null ? undefined : deps.getTimeline(timelineId));
    },
  };
}
