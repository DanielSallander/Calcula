//! FILENAME: app/extensions/Pivot/lib/pivotObjectPane.ts
// PURPOSE: The canvas pivot box's @api/objectPane provider (WP-C D-PANE): its
//          BUILD tabs in the ONE object pane -- Fields | Design (+ the host's
//          Format) -- and the pane header.
// CONTEXT: Fields and Design are the worksheet field-list editor's two
//          bodies, LIFTED (components/CanvasPivotBuildBody.tsx): both tabs
//          render THE SAME component type with the same key, so the host's
//          one build slot keeps ONE instance -- one PivotEditor, its zones and
//          a deferred update intact -- across Fields, Design and a visit to
//          Format. Each tab tells the body which of its two bodies to show.
//
//          A worksheet pivot's CELL selection keeps the `pivot-editor` task
//          pane (Excel parity); only the canvas BOX (`pivot-visual`) is
//          provided here. A press on the box opens the pane on Fields (the
//          host's default: the first build tab); Ctrl+1 and "Format..." name
//          Format themselves.

import React from "react";
import type { GridRegion } from "@api/gridOverlays";
import type { ObjectPaneProvider, ObjectPaneTab, ObjectPaneTabContext } from "@api/objectPane";
import { CanvasPivotBuildBody } from "../components/CanvasPivotBuildBody";
import type { PivotEditorTab } from "../components/PivotEditor";

/** The build tab ids of a pivot box (never "format": the host owns it). */
export const PIVOT_PANE_TAB_FIELDS = "fields";
export const PIVOT_PANE_TAB_DESIGN = "design";

const TABS: ReadonlyArray<{ id: PivotEditorTab; label: string }> = [
  { id: PIVOT_PANE_TAB_FIELDS, label: "Fields" },
  { id: PIVOT_PANE_TAB_DESIGN, label: "Design" },
];

function pivotIdOf(region: GridRegion): string | null {
  const id = (region.data as { pivotId?: unknown } | undefined)?.pivotId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** Build the @api/objectPane provider for the box's region type. */
export function createPivotObjectPaneProvider(regionType: string): ObjectPaneProvider {
  return {
    types: [regionType],

    tabs(region): readonly ObjectPaneTab[] {
      const pivotId = pivotIdOf(region);
      if (pivotId === null) return [];
      return TABS.map(({ id, label }) => ({
        id,
        label,
        // ONE component type and ONE key for both tabs: one instance across them.
        render: (ctx: ObjectPaneTabContext) =>
          React.createElement(CanvasPivotBuildBody, {
            key: pivotId,
            pivotId,
            anchorRow: ctx.region.startRow,
            anchorCol: ctx.region.startCol,
            tab: id,
            readOnly: ctx.readOnly,
            readOnlyReason: ctx.readOnlyReason,
          }),
      }));
    },

    headerOf(region): string {
      const name = (region.data as { name?: unknown } | undefined)?.name;
      return typeof name === "string" && name !== "" ? `PivotTable - ${name}` : "PivotTable";
    },
  };
}
