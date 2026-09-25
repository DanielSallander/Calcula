//! FILENAME: app/extensions/Charts/lib/chartObjectSelection.ts
// PURPOSE: Charts' provider for the `@api/objectSelection` seam -- select,
//          deselect and ask about a chart WITHOUT a mouse press.
// CONTEXT: The only way a chart used to become selected was Core's
//          `floatingObject:selected`, which Charts rightly reads as "a left
//          press landed here": on an already-selected chart it ARMS A PENDING
//          CLICK that the next mouseup completes by walking the sub-selection
//          ladder (chart -> series -> point). Keyboard object cycling on a
//          canvas (Tab / Shift+Tab) and a background click that deselects have
//          no press behind them, so routing them through that event would
//          advance the ladder on some unrelated mouseup. This provider is the
//          press-free route: `select` selects and nothing else.
//
//          The owning extension decides HOW (the controlsService precedent):
//          the seam's callers say WHAT, and this file does exactly what the
//          press path does to SELECT (selectChart + the selection announcement
//          + a grid refresh) minus the pending click.

import type { ObjectSelectionKey, ObjectSelectionProvider } from "@api/objectSelection";
import type { GridRegion } from "@api/gridOverlays";
import {
  clearPendingClick,
  deselectChart,
  escapeLevelUp,
  getCurrentChartId,
  getSubSelection,
  isChartSelected,
  selectChart,
} from "../handlers/selectionHandler";

/** The side effects a selection change needs, injected by activate(). */
export interface ChartObjectSelectionDeps {
  /** Announce the selection (CHART_SELECTION_CHANGED + the @api registry). */
  emitSelection: () => void;
  /** A chart's cached raster paints its sub-selection highlight; drop it. */
  invalidateChart: (chartId: string) => void;
  /** Repaint the grid (and with it the overlay regions). */
  refresh: () => void;
}

/** The chart id a published chart region carries, or null. */
export function chartIdOfRegion(region: GridRegion): string | null {
  const id = region?.data?.chartId;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Whether the chart's INNER selection owns `key` right now.
 *
 * Escape belongs to a chart whose sub-selection is below chart level (a series,
 * a point, an axis, an element): it steps up one rung first, exactly as the
 * chart's own Escape handler does (`escapeLevelUp`). At chart level Escape is
 * not the chart's -- the object cycler deselects the object. Tab is never the
 * chart's: a chart has no inner Tab order.
 */
export function chartOwnsObjectKey(key: ObjectSelectionKey): boolean {
  if (key !== "Escape") return false;
  if (getCurrentChartId() === null) return false;
  return escapeLevelUp(getSubSelection()) !== null;
}

/** Build the provider registered for region type "chart". */
export function createChartObjectSelectionProvider(deps: ChartObjectSelectionDeps): ObjectSelectionProvider {
  return {
    types: ["chart"],

    isSelected(region: GridRegion): boolean {
      const id = chartIdOfRegion(region);
      return id !== null && isChartSelected(id);
    },

    select(region: GridRegion): void {
      const id = chartIdOfRegion(region);
      if (id === null) return;
      // No click semantics: a pending click left by an earlier press on this
      // chart must not be completed by the next mouseup either.
      clearPendingClick();
      const previous = getCurrentChartId();
      if (previous === id) return;
      // Switching charts: the previous one's cached raster carries its
      // sub-selection highlight.
      if (previous !== null) deps.invalidateChart(previous);
      selectChart(id);
      deps.invalidateChart(id);
      deps.emitSelection();
      deps.refresh();
    },

    deselectAll(): void {
      const previous = getCurrentChartId();
      clearPendingClick();
      if (previous === null) return;
      deselectChart();
      deps.invalidateChart(previous);
      deps.emitSelection();
      deps.refresh();
    },

    ownsKey(key: ObjectSelectionKey): boolean {
      return chartOwnsObjectKey(key);
    },
  };
}
