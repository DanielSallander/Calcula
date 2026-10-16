//! FILENAME: app/extensions/FloatingRange/lib/frObjectPane.ts
// PURPOSE: The floating grid's @api/objectPane provider (WP-C D-PANE): its ONE
//          build tab in the object pane -- Properties (rows, columns, header
//          strips) -- beside the host's Format tab, and the pane header.
// CONTEXT: The tab body is components/FloatingRangePropertiesBody.tsx (lifted
//          from the old Properties dialog). The name and the title bar are
//          Format > Title (lib/frObjectFormat.ts). A press on a range on a
//          canvas opens the pane by the host's policy (the default
//          `opensOnPress`); on a worksheet only a door does ("Format...",
//          "Properties...", Ctrl+1).

import React from "react";
import type { GridRegion } from "@api/gridOverlays";
import type { ObjectPaneProvider, ObjectPaneTab, ObjectPaneTabContext } from "@api/objectPane";
import { FloatingRangePropertiesBody } from "../components/FloatingRangePropertiesBody";
import { FR_PROPERTIES_TAB } from "./frContextMenu";
import { frIdOfFormatRegion } from "./frObjectFormat";

/** The pane header's lead for a floating grid. */
export const FR_PANE_HEADER = "Floating range";

/** Build the @api/objectPane provider for the grid's region type. */
export function createFrObjectPaneProvider(
  regionType: string,
  nameOf: (frId: string) => string | null,
): ObjectPaneProvider {
  return {
    types: [regionType],

    tabs(region: GridRegion): readonly ObjectPaneTab[] {
      const frId = frIdOfFormatRegion(region);
      if (frId === null) return [];
      return [
        {
          id: FR_PROPERTIES_TAB,
          label: "Properties",
          render: (ctx: ObjectPaneTabContext) =>
            React.createElement(FloatingRangePropertiesBody, {
              key: frId,
              frId,
              readOnly: ctx.readOnly,
              readOnlyReason: ctx.readOnlyReason,
            }),
        },
      ];
    },

    headerOf(region: GridRegion): string {
      const frId = frIdOfFormatRegion(region);
      const name = frId === null ? null : nameOf(frId);
      return name ? `${FR_PANE_HEADER} - ${name}` : FR_PANE_HEADER;
    },
  };
}
