//! FILENAME: app/extensions/Slicer/lib/slicerObjectPane.ts
// PURPOSE: The slicer's @api/objectPane provider (WP-C D-PANE): its BUILD tab
//          in the ONE object pane -- Settings (+ the host's Format) -- and the
//          pane header. A model slicer is a slicer: the same tabs.
// CONTEXT: Settings is the Slicer Settings dialog's body
//          (components/SlicerSettingsBody.tsx) in one column, committing each
//          change at once. There is no Field tab: re-pointing a slicer at
//          another field is out of scope (the decision's tab set is
//          Settings | Format).

import React from "react";
import type { GridRegion } from "@api/gridOverlays";
import type { ObjectPaneProvider, ObjectPaneTab, ObjectPaneTabContext } from "@api/objectPane";
import { SlicerSettingsTab } from "../components/SlicerSettingsTab";
import { SLICER_FORMAT_REGION_TYPE, slicerIdOfFormatRegion } from "./slicerObjectFormat";
import type { Slicer } from "./slicerTypes";

/** The slicer's build tab id (never "format": the host owns it). */
export const SLICER_PANE_TAB_SETTINGS = "settings";

/** What the provider needs from the store (injected: no store import here). */
export interface SlicerObjectPaneDeps {
  getSlicer(slicerId: string): Slicer | undefined;
}

/** "Slicer - Region", or "Slicer" when the slicer is gone. */
export function slicerPaneHeader(slicer: Pick<Slicer, "name"> | undefined): string {
  return slicer && slicer.name ? `Slicer - ${slicer.name}` : "Slicer";
}

/** Build the @api/objectPane provider for the slicer region type. */
export function createSlicerObjectPaneProvider(deps: SlicerObjectPaneDeps): ObjectPaneProvider {
  return {
    types: [SLICER_FORMAT_REGION_TYPE],

    tabs(region: GridRegion): readonly ObjectPaneTab[] {
      const slicerId = slicerIdOfFormatRegion(region);
      if (slicerId === null) return [];
      return [
        {
          id: SLICER_PANE_TAB_SETTINGS,
          label: "Settings",
          render: (ctx: ObjectPaneTabContext) =>
            React.createElement(SlicerSettingsTab, {
              key: slicerId,
              slicerId,
              readOnly: ctx.readOnly,
              readOnlyReason: ctx.readOnlyReason,
            }),
        },
      ];
    },

    headerOf(region: GridRegion): string {
      const slicerId = slicerIdOfFormatRegion(region);
      return slicerPaneHeader(slicerId === null ? undefined : deps.getSlicer(slicerId));
    },
  };
}
