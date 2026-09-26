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

import {
  getSelectedObjectRegions,
  type ObjectSelectionKey,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import type { GridRegion } from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/grid";
import { canvasObjectRef } from "@api/canvasSheet";
import {
  arrowsBelongToOverlayStep,
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
  /**
   * How many insight cues the chart carries (the overlay step owns plain
   * Left/Right at chart level while it has any). Absent = none.
   */
  cueCountOf?: (chartId: string) => number;
}

/** The modifiers of a plain arrow keystroke (what a nudge row without Shift is). */
const PLAIN_ARROW = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false } as const;

/**
 * Whether the selected chart's INNER selection owns the arrow keys -- in which
 * case a canvas's nudge must leave them alone:
 *   - below chart level (a series, a point, an axis, an element): the arrows
 *     WALK the chart's elements (CI-10) -- a selected series walks its points;
 *   - at chart level on a chart that carries insight cues: plain Left/Right
 *     STEP the cues (`arrowsBelongToOverlayStep`, the one precedence rule).
 * Otherwise (chart level, no cues) the arrows are free: the chart NUDGES.
 * Ctrl+arrows keep walking the chart from chart level either way -- the nudge
 * never binds them.
 */
export function chartOwnsArrows(cueCountOf?: (chartId: string) => number): boolean {
  const id = getCurrentChartId();
  if (id === null) return false;
  const sub = getSubSelection();
  if (sub.level !== "chart") return true;
  return arrowsBelongToOverlayStep(sub, cueCountOf ? cueCountOf(id) : 0, PLAIN_ARROW);
}

/**
 * Whether a press on an ALREADY-selected chart arms the pending click (the
 * sub-selection ladder's advance at mouseup: chart -> series -> point).
 *
 * On a CANVAS, a chart that is one of SEVERAL selected objects is a member of
 * a multi-selection. The first plain click on it NARROWS the selection to it
 * (press parity, @api/objectSelection); arming the ladder as well made that
 * one click narrow AND jump to series level. A Ctrl/Shift press adds or
 * removes the chart from the set -- never a ladder step either. A second
 * click, once the chart is the only object selected, walks the ladder as
 * always. Worksheets keep their historical behaviour. Pure over its inputs.
 */
export function pressArmsChartLadder(opts: {
  onCanvas: boolean;
  selectedCount: number;
  additive: boolean;
}): boolean {
  if (!opts.onCanvas) return true;
  if (opts.additive) return false;
  return opts.selectedCount <= 1;
}

/**
 * {@link pressArmsChartLadder} for a live `floatingObject:selected` detail,
 * read at the moment Charts handles the press (after Core's press parity).
 */
export function pressArmsPendingChartClick(detail: { ctrlKey?: unknown; shiftKey?: unknown }): boolean {
  return pressArmsChartLadder({
    onCanvas: getGridStateSnapshot()?.surface === "canvas",
    selectedCount: getSelectedObjectRegions().length,
    additive: detail?.ctrlKey === true || detail?.shiftKey === true,
  });
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
 * chart's: a chart has no inner Tab order. The arrows follow
 * {@link chartOwnsArrows}.
 */
export function chartOwnsObjectKey(
  key: ObjectSelectionKey,
  cueCountOf?: (chartId: string) => number,
): boolean {
  if (key === "Arrow") return chartOwnsArrows(cueCountOf);
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
      return chartOwnsObjectKey(key, deps.cueCountOf);
    },

    refOf(region: GridRegion) {
      const id = chartIdOfRegion(region);
      return id === null ? null : canvasObjectRef("chart", id);
    },

    // The name the chart region is published with (syncChartRegions).
    labelOf(region: GridRegion): string | null {
      const name = region?.data?.name;
      return typeof name === "string" && name !== "" ? name : null;
    },
  };
}
