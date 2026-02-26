//! FILENAME: app/extensions/pivot/handlers/headerFilterMenuHandler.ts
// PURPOSE: Handles pivot:openHeaderFilterMenu events to show the
//          Row Labels / Column Labels header filter dropdown.

import { OverlayExtensions } from "../../../src/api";
import { PIVOT_HEADER_FILTER_OVERLAY_ID } from "../manifest";

/**
 * Handle the pivot:openHeaderFilterMenu event.
 * Opens the header filter dropdown overlay for the given zone.
 */
export async function handleOpenHeaderFilterMenu(detail: {
  pivotId: number;
  zone: 'row' | 'column';
  anchorX: number;
  anchorY: number;
}): Promise<void> {
  const { pivotId, zone, anchorX, anchorY } = detail;

  // Dynamically import pivot API to get field summaries from cached view
  const { getPivotView } = await import("../lib/pivot-api");

  try {
    const view = await getPivotView(pivotId);
    const fields = zone === 'row'
      ? view.rowFieldSummaries ?? []
      : view.columnFieldSummaries ?? [];

    if (fields.length === 0) {
      console.warn("[Pivot Extension] No field summaries for zone:", zone);
      return;
    }

    OverlayExtensions.showOverlay(PIVOT_HEADER_FILTER_OVERLAY_ID, {
      data: {
        zone,
        fields,
        pivotId,
      },
      anchorRect: {
        x: anchorX,
        y: anchorY,
        width: 260,
        height: 0,
      },
    });
  } catch (error) {
    console.error("[Pivot Extension] Failed to open header filter menu:", error);
  }
}
