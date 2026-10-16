//! FILENAME: app/extensions/Controls/lib/controlObjectPane.ts
// PURPOSE: The floating controls' @api/objectPane provider (WP-C D-PANE): a
//          shape's, a text box's, a button's, a picture's and a page
//          navigator's BUILD tab in the ONE object pane -- Properties (+ the
//          host's Format) -- its header, and whether a canvas press may open
//          the pane on it.
// CONTEXT: The Properties tab HOSTS the existing Properties pane component
//          (PropertiesPane/PropertiesPane.tsx) with the data the old
//          `control-properties` task pane was opened with -- {row, col,
//          sheetIndex, controlType} from the region's data -- keyed by the
//          region id, so a retarget to another control remounts it. A floating
//          control no longer opens `control-properties` at all: the object
//          pane's policy opens at the release of a canvas press, and doors
//          (Ctrl+1, the menu's "Format..." / "Properties...") open it anywhere.
//          An EMBEDDED (in-cell) button keeps `control-properties`.
//
//          A RUN-MODE button or page navigator is CONTENT: a press acts (runs,
//          navigates), so it never opens the pane (`opensOnPress` false outside
//          Design Mode -- WP-B's `isDesignModeOnlyControl`).

import React from "react";
import type { GridRegion } from "@api/gridOverlays";
import type { TaskPaneViewProps } from "@api/uiTypes";
import type { ObjectPaneProvider, ObjectPaneTab, ObjectPaneTabContext } from "@api/objectPane";
import { controlKindLabel, isDesignModeOnlyControl } from "./controlKinds";
import { controlOfRegion } from "./controlObjectFormat";
import { getControlContainerEntry } from "./controlContainer";

/** The build tab id of a control (never "format": the host owns it). */
export const CONTROL_PANE_TAB_PROPERTIES = "properties";

/** What the provider needs (injected by activate()). */
export interface ControlObjectPaneDeps {
  /** The region type every floating control publishes. */
  regionType: string;
  /** The Properties pane component the tab hosts. */
  PropertiesComponent: React.ComponentType<TaskPaneViewProps>;
  /** Whether Design Mode is on. */
  isDesignMode(): boolean;
}

/** The pane header: the control's kind, and its name when it has one ("Shape - Logo"). */
export function controlPaneHeader(region: GridRegion): string {
  const info = controlOfRegion(region);
  const label = controlKindLabel(info?.controlType ?? "");
  const entry = info ? getControlContainerEntry(info.controlId) : undefined;
  const kindLabel = entry?.kind === "textBox" ? "Text box" : label;
  const name = entry?.props.name;
  return typeof name === "string" && name.trim() !== "" ? `${kindLabel} - ${name}` : kindLabel;
}

/** Build the @api/objectPane provider for the floating-control region type. */
export function createControlObjectPaneProvider(deps: ControlObjectPaneDeps): ObjectPaneProvider {
  return {
    types: [deps.regionType],

    tabs(region): readonly ObjectPaneTab[] {
      const info = controlOfRegion(region);
      if (!info) return [];
      return [
        {
          id: CONTROL_PANE_TAB_PROPERTIES,
          label: "Properties",
          render: (ctx: ObjectPaneTabContext) => {
            const live = controlOfRegion(ctx.region) ?? info;
            return React.createElement(deps.PropertiesComponent, {
              key: ctx.region.id,
              data: {
                row: live.row,
                col: live.col,
                sheetIndex: live.sheetIndex,
                controlType: live.controlType,
              },
            });
          },
        },
      ];
    },

    headerOf(region): string {
      return controlPaneHeader(region);
    },

    opensOnPress(region): boolean {
      const type = controlOfRegion(region)?.controlType ?? "";
      return !(isDesignModeOnlyControl(type) && !deps.isDesignMode());
    },
  };
}
