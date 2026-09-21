//! FILENAME: app/extensions/Charts/handlers/selectionHandler.ts
// PURPOSE: Track selection context for the Chart extension with hierarchical selection.
// CONTEXT: Supports Excel-like selection progression:
//          Level 0: No chart selected
//          Level 1: Chart selected (whole chart - blue border + handles)
//          Level 2: Series selected (all bars in a series highlighted, others dimmed)
//          Level 3: Data point selected (single bar highlighted, everything else dimmed)
//
//          Uses a deferred-click mechanism to distinguish clicks from drags:
//          On mousedown (floatingObject:selected) -> record the press origin
//                                                    and set pending click
//          On movePreview -> clear pending ONLY once the press has travelled
//                            further than Core's own 3px hasMoved threshold
//          On moveComplete -> clear pending (was a drag)
//          On mouseup -> if pending still set, it was a click -> advance selection
//
//          Core dispatches `floatingObject:movePreview` on EVERY mousemove once
//          a move drag is live; its 3px threshold gates only `moveComplete`.
//          Charts never sets `movable: false`, so every left press starts a move
//          drag, and clearing the pending click on the first preview meant one
//          pixel of hand jitter between press and release silently cancelled the
//          ladder advance. The threshold is re-stated here rather than fixed in
//          Core because FIVE extensions listen to that event and each moves its
//          object on it — raising Core's dispatch threshold would change drag
//          feel in four other features.

import {
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  registerPanel,
  unregisterPanel,
} from "@api";
import { isKeyClaimed } from "@api/pointerClaims";
import { isGridFocused } from "@api/keybindings";
import { setSelectedChartCue } from "@api/chartCues";
import { isTextEntryTarget } from "../lib/overlayKeys";
import type {
  ChartElementId,
  ChartHitResult,
  ChartSubSelection,
  HitGeometry,
  ChartLayout,
} from "../types";
import { chartElementOf } from "../rendering/chartHitTesting";
import { CHART_DESIGN_TAB_ID, buildChartDesignPanelDefinition } from "../manifest";
import { ChartEvents } from "../lib/chartEvents";

// ============================================================================
// State
// ============================================================================

let currentChartId: string | null = null;

let subSelection: ChartSubSelection = { level: "none" };

/** Whether the contextual Design panel is currently registered. */
let designTabRegistered = false;

/** Section-id fingerprint of the last-registered Design panel. */
let designSectionIds = "";

/** Pending click state for deferred click detection. */
let pendingClick: {
  chartId: string;
  canvasX: number;
  canvasY: number;
} | null = null;

/**
 * Core's own click-vs-drag threshold: `handleOverlayMoveMouseMove` in
 * `app/src/core/hooks/useMouseSelection/layout/overlayMoveHandlers.ts` sets
 * `hasMoved` once |delta| EXCEEDS 3 in either axis, and only a `hasMoved` drag
 * ever produces a `moveComplete`. Matching the number here is what makes the
 * two ends of the gesture agree: below it Core reports no move at all, so the
 * press must still read as a click.
 */
export const MOVE_JITTER_THRESHOLD_PX = 3;

/**
 * Where the object sat when the press landed, so a live preview can be measured
 * against the press rather than against the object's own (already moved)
 * position. `exceeded` is sticky exactly as Core's `hasMoved` is: once a drag
 * has left the dead zone, dragging back INTO it is still a drag.
 */
let movePress: {
  chartId: string;
  x: number;
  y: number;
  exceeded: boolean;
} | null = null;

/**
 * A sub-selection that was chosen on data the chart has since been told to
 * re-read. `token` is the data-cache entry it was chosen on: the refreshed
 * geometry does not exist yet at the moment the edit lands (the re-read is
 * async), so the check has to wait until the cache is a DIFFERENT object.
 */
let staleSubSelection: { token: unknown } | null = null;

// ============================================================================
// Contextual Design Panel (sections vary with the selected chart's type)
// ============================================================================

/** Register (or upsert) the Design panel for the currently selected chart. */
function registerDesignPanel(): void {
  const definition = buildChartDesignPanelDefinition();
  designSectionIds = definition.sections.map((s) => s.id).join("|");
  registerPanel(definition);
}

/**
 * Re-register the Design panel when the applicable section set changes (e.g.
 * the chart type switches bar -> pie and the Stacking/Trendline groups no
 * longer apply) — mirroring the former monolithic tab's conditional
 * RibbonGroup rendering. No-op when the section list is unchanged, so
 * in-section editing (title typing, etc.) never remounts the panel.
 */
function refreshDesignPanelSections(): void {
  if (!designTabRegistered) return;
  const definition = buildChartDesignPanelDefinition();
  const ids = definition.sections.map((s) => s.id).join("|");
  if (ids !== designSectionIds) {
    designSectionIds = ids;
    registerPanel(definition);
  }
}

/** Window listener: chart specs changed — the section set may have too. */
function handleChartUpdatedForDesignPanel(): void {
  refreshDesignPanelSections();
}

// ============================================================================
// Selection Management
// ============================================================================

/**
 * Select a chart by ID. Called when a floating chart is clicked.
 * For the first click (chart not yet selected), sets to Level 1.
 * For subsequent clicks, sets pendingClick for deferred processing.
 */
export function selectChart(chartId: string): void {
  if (currentChartId !== chartId) {
    // First click on this chart: select it (Level 1)
    currentChartId = chartId;
    subSelection = { level: "chart" };
    staleSubSelection = null;
    addTaskPaneContextKey("chart");

    // Show the contextual Design panel (ribbon-placed by default)
    if (!designTabRegistered) {
      registerDesignPanel();
      designTabRegistered = true;
      // Keep the section set in sync with chart-type changes while selected.
      window.addEventListener(ChartEvents.CHART_UPDATED, handleChartUpdatedForDesignPanel);
    } else {
      // Switching directly to a different chart: its type may need a
      // different section set (e.g. bar -> pie drops Stacking/Trendline).
      refreshDesignPanelSections();
    }
  }
  // If already selected, the pending click mechanism in index.ts
  // will handle advancing the sub-selection after mouseup.
}

/**
 * Deselect any selected chart. Called when user clicks on the grid (not on a chart).
 */
export function deselectChart(): void {
  if (currentChartId !== null) {
    // The ring the reader had selected belonged to a datum on THIS chart, and
    // they have just clicked away from it. Leaving it selected is the same
    // stale-subject defect as a click on an unringed bar: the context menu
    // would still offer to act on a point of interest nobody is looking at.
    setSelectedChartCue(currentChartId, null);
    currentChartId = null;
    subSelection = { level: "none" };
    pendingClick = null;
    movePress = null;
    staleSubSelection = null;
    removeTaskPaneContextKey("chart");

    // Hide the contextual Design panel
    if (designTabRegistered) {
      window.removeEventListener(ChartEvents.CHART_UPDATED, handleChartUpdatedForDesignPanel);
      unregisterPanel(CHART_DESIGN_TAB_ID);
      designTabRegistered = false;
      designSectionIds = "";
    }
  }
}

/**
 * Handle selection changes from the extension registry.
 * When the user clicks on a cell (not on a chart), deselect any selected chart.
 */
export function handleSelectionChange(
  _selection: { endRow: number; endCol: number } | null,
): void {
  deselectChart();
}

/**
 * Check if a specific chart is currently selected (any level).
 */
export function isChartSelected(chartId: string): boolean {
  return currentChartId === chartId;
}

/**
 * Get the ID of the currently selected chart.
 */
export function getCurrentChartId(): string | null {
  return currentChartId;
}

/**
 * Get the current sub-selection state.
 */
export function getSubSelection(): ChartSubSelection {
  return subSelection;
}

// ============================================================================
// Hierarchical Selection State Machine
// ============================================================================

/**
 * Advance the selection based on a hit-test result.
 * Called after a confirmed click (not a drag) on a chart that is already selected.
 *
 * State transitions:
 * - Level 1 (chart) + datum hit -> Level 2 (series)
 * - Level 2 (series) + same series datum hit -> Level 3 (dataPoint)
 * - Level 2 (series) + different series datum hit -> Level 2 (new series)
 * - Level 3 (dataPoint) + same datum hit -> Level 3 (same, no-op)
 * - Level 3 (dataPoint) + same series different datum -> Level 3 (new point)
 * - Level 3 (dataPoint) + different series datum hit -> Level 2 (new series)
 * - any level + an axis hit -> the axis level
 * - any level + a title / axis-title hit -> that element
 * - any level + a legend hit -> the LEGEND; clicking the already-selected
 *   legend again drills into the ENTRY under the cursor, which is the same
 *   whole-then-part shape the datum ladder has (series, then point)
 * - any level + the PLOT AREA -> the plot-area element rung
 * - any level + the CHART AREA (the outer margin) / a filter button / a miss ->
 *   Level 1 (chart)
 */
export function advanceSelection(chartId: string, hitResult: ChartHitResult): void {
  if (currentChartId !== chartId) return;

  const element = chartElementOf(hitResult);

  // Axis click -> select the axis
  if (element === "xAxis" || element === "yAxis") {
    subSelection = { level: "axis", axisType: hitResult.axisType ?? (element === "yAxis" ? "y" : "x") };
    return;
  }

  // The legend is selected whole first; a second click on it drills into the
  // entry the cursor is over. An entry hit is what BOTH clicks produce (the
  // entries fill the legend box), so the drill-in is decided by what is
  // already selected, not by where the second click landed.
  if (element === "legendEntry" || element === "legend") {
    const onLegend = subSelection.level === "element" && subSelection.elementId === "legend";
    if (onLegend && element === "legendEntry") {
      subSelection = { level: "element", elementId: "legendEntry", seriesIndex: hitResult.seriesIndex };
    } else if (subSelection.level === "element" && subSelection.elementId === "legendEntry" && element === "legendEntry") {
      // Already inside the legend: a click on a DIFFERENT entry moves to it.
      subSelection = { level: "element", elementId: "legendEntry", seriesIndex: hitResult.seriesIndex };
    } else {
      subSelection = { level: "element", elementId: "legend" };
    }
    return;
  }

  if (element === "title" || element === "xAxisTitle" || element === "yAxisTitle") {
    subSelection = { level: "element", elementId: element };
    return;
  }

  // THE PLOT AREA IS A RUNG, NOT A WAY OUT.
  //
  // It was reachable by KEYBOARD (`buildChartNavGroups` emits it), paintable
  // (`CHART_SELECTABLE_ELEMENT_IDS`), nameable ("Plot Area") and formattable
  // (the Format pane's PlotAreaSections) — and the MOUSE could not produce it,
  // because every non-datum, non-legend, non-title hit funnelled into
  // `{ level: "chart" }`. A rung half the product knows about and the primary
  // input device cannot reach is the dead-member defect the element taxonomy
  // exists to prevent, pointing the other way.
  //
  // EXCEL'S MODEL, WHICH IS WHY THERE IS STILL A MOUSE ROUTE BACK OUT: a click
  // on the plot BACKGROUND selects the plot area; a click on the chart's outer
  // margin — outside the plot and off every piece of furniture — selects the
  // chart area. The hit-tester already tells those two pixels apart:
  // `hitTestChartElements` answers `plotArea` inside `layout.plotArea` and
  // `chartArea` for anything else inside the canvas, which is what stopped the
  // top and right margins being dead pixels. So the outer margin is the way
  // back to chart level, and Escape is the keyboard's.
  if (element === "plotArea") {
    subSelection = { level: "element", elementId: "plotArea" };
    return;
  }

  if (element !== "datum") {
    // Clicked the chart area (the outer margin), a filter button or nothing at
    // all -> back to chart level. The plot background is handled above.
    subSelection = { level: "chart" };
    return;
  }

  const seriesIndex = hitResult.seriesIndex;
  const categoryIndex = hitResult.pointIndex ?? hitResult.categoryIndex;

  switch (subSelection.level) {
    case "series":
      if (subSelection.seriesIndex === seriesIndex) {
        // Same series -> advance to data point
        subSelection = { level: "dataPoint", seriesIndex, categoryIndex };
      } else {
        // Different series -> switch to that series
        subSelection = { level: "series", seriesIndex };
      }
      break;

    case "dataPoint":
      if (subSelection.seriesIndex === seriesIndex) {
        // Same series -> select the clicked data point
        subSelection = { level: "dataPoint", seriesIndex, categoryIndex };
      } else {
        // Different series -> switch to that series
        subSelection = { level: "series", seriesIndex };
      }
      break;

    default:
      // Chart level, an axis, a title, the legend — anything that is not
      // already inside a series. A datum click enters the datum ladder at its
      // first rung. This used to be a `case "chart"` alone, so a click on a bar
      // while an AXIS was selected fell out of the switch and changed nothing
      // at all: the reader clicked the bar and the axis stayed selected.
      subSelection = { level: "series", seriesIndex };
      break;
  }
}

/**
 * Set the sub-selection outright, for a gesture that decides its own answer.
 *
 * The ONE caller is the double-click (handlers/chartTextEditing.ts), and the
 * reason it cannot go through {@link advanceSelection} is that a double-click
 * has ALREADY advanced the ladder — once or twice depending on whether the
 * chart was selected when the gesture started, which is the state-dependence
 * documented in chartTextEditing's header. A gesture that must have one answer
 * has to be able to STATE it rather than nudge a ladder whose starting rung it
 * does not know.
 *
 * Ignored when `chartId` is not the selected chart, so it can never move the
 * selection onto a chart nobody selected.
 */
export function setSubSelection(chartId: string, next: ChartSubSelection): void {
  if (currentChartId !== chartId) return;
  subSelection = next;
}

// ============================================================================
// Surviving a data refresh
// ============================================================================

/**
 * Does a datum with these indices still exist in the refreshed geometry?
 *
 * Asked of the GEOMETRY rather than of the parsed data because the two do not
 * index the same thing everywhere: a pie's `SliceArc.seriesIndex` walks the
 * CATEGORIES (`hitTestSlices` reports `categoryIndex: arc.seriesIndex`), so a
 * series/category count taken from `ParsedChartData` would answer the wrong
 * question for every radial mark. The geometry is what the click was resolved
 * against, so it is what the selection has to survive against.
 *
 * `categoryIndex` undefined asks the series-level question: does ANY datum of
 * that series still exist?
 */
export function geometryHasDatum(
  geometry: HitGeometry,
  seriesIndex: number,
  categoryIndex?: number,
): boolean {
  switch (geometry.type) {
    case "bars":
      return geometry.rects.some(
        (r) => r.seriesIndex === seriesIndex && (categoryIndex === undefined || r.categoryIndex === categoryIndex),
      );
    case "points":
      return geometry.markers.some(
        (m) => m.seriesIndex === seriesIndex && (categoryIndex === undefined || m.categoryIndex === categoryIndex),
      );
    case "slices":
      // A slice IS its category: hitTestSlices reports categoryIndex = seriesIndex.
      return geometry.arcs.some(
        (a) => a.seriesIndex === seriesIndex && (categoryIndex === undefined || categoryIndex === a.seriesIndex),
      );
    case "composite":
      return geometry.groups.some((g) => geometryHasDatum(g, seriesIndex, categoryIndex));
  }
}

/**
 * Note that the selected chart is about to re-read its data.
 *
 * This used to drop the reader straight back to chart level, so typing in a
 * source cell threw away "this one bar" mid-task. It cannot decide anything
 * yet: the refreshed geometry does not exist at this moment (the re-read is
 * async and the data cache still holds the PRE-edit numbers), so it records
 * the cache entry the selection was made against and defers the decision to
 * `revalidateSubSelection`.
 *
 * Only a series/dataPoint selection can go stale — chart and axis levels carry
 * no indices to invalidate.
 */
export function markSubSelectionStale(token: unknown): void {
  if (currentChartId === null) return;
  if (subSelection.level !== "series" && subSelection.level !== "dataPoint") return;
  staleSubSelection = { token };
}

/** Is a sub-selection currently waiting to be checked against fresh geometry? */
export function isSubSelectionStale(): boolean {
  return staleSubSelection !== null;
}

/**
 * Check a stale sub-selection against the geometry the chart has ACTUALLY
 * re-read, keeping it when its datum still exists and dropping to chart level
 * when it does not.
 *
 * `token` is the current data-cache entry. While it is still the SAME object
 * the selection was marked stale against, the re-read has not landed and
 * nothing is decided — that guard is the whole reason a pivot chart whose
 * category set SHRANK cannot keep a stale index: validating early would pass
 * against the old geometry and clear the flag before the short data arrived.
 *
 * Returns true when the selection level actually changed, so the caller can
 * announce it.
 */
export function revalidateSubSelection(
  chartId: string,
  token: unknown,
  geometry: HitGeometry | null,
): boolean {
  if (staleSubSelection === null) return false;
  if (currentChartId !== chartId) return false;
  if (token === staleSubSelection.token) return false; // not refreshed yet
  staleSubSelection = null;

  if (subSelection.level !== "series" && subSelection.level !== "dataPoint") return false;
  const { seriesIndex } = subSelection;
  if (seriesIndex == null || geometry === null) {
    subSelection = { level: "chart" };
    return true;
  }
  const categoryIndex = subSelection.level === "dataPoint" ? subSelection.categoryIndex : undefined;
  if (geometryHasDatum(geometry, seriesIndex, categoryIndex)) return false;

  subSelection = { level: "chart" };
  return true;
}

// ============================================================================
// Who owns a keystroke
// ============================================================================

/**
 * Is this keydown the Charts extension's to act on at all?
 *
 * ONE predicate, asked by all three of the extension's capture-phase key
 * listeners (Delete, the insight-overlay step, the element walk), because the
 * question is the same for every one of them and a per-listener copy is a copy
 * that drifts. Three gates, and the middle one is the one that was missing:
 *
 *  1. `isKeyClaimed` — a widget stacked ON the grid (an on-grid form field, a
 *     shape's declared hit rectangle, the overlay text editor) owns its own
 *     keys. A claim is a GRID-OVERLAY concept, which is exactly why it cannot
 *     answer gate 2.
 *  2. `isGridFocused` — is the grid the subject AT ALL? A `<button>` or a
 *     `<select>` in a task pane or on the ribbon carries no claim and is none
 *     of INPUT/TEXTAREA/contentEditable, so with only gates 1 and 3 the answer
 *     was yes. THAT IS A DATA-LOSS DEFECT: select a chart, click the Format
 *     pane's Options tab (a real `<button>`, now focused), press Delete — and
 *     the chart was destroyed. Three clicks. The contextual Design panel has
 *     the same shape, and the Format pane widened it from a ribbon strip to a
 *     whole pane of focusable controls. The predicate is Core's own
 *     (`@api/keybindings`), imported rather than re-derived here: a second
 *     spelling of `[data-focus-container="spreadsheet"]` inside an extension
 *     would drift on the first change to the attribute.
 *  3. `isTextEntryTarget` — a keystroke aimed at a text field is that field's.
 *     Kept even though gate 1 covers a claimed editor, because a plain field
 *     rendered without a claim is still typing.
 */
export function chartOwnsKeystroke(e: KeyboardEvent): boolean {
  if (isKeyClaimed(e)) return false;
  if (!isGridFocused()) return false;
  if (isTextEntryTarget(e.target)) return false;
  return true;
}

/**
 * ARROW-KEY PRECEDENCE, STATED ONCE.
 *
 * Two features want Left/Right on a selected chart, and both listen on the same
 * capture-phase document door, installed from the same file:
 *
 *   (a) the insight overlay's STEP through the points of interest
 *       (insight-overlays §4.8a, rule in lib/overlayKeys.ts), and
 *   (b) the chart-element WALK below (CI-10).
 *
 * Whichever is written second silently dead-keys the other, so this is ONE
 * predicate that both listeners read rather than two guards somebody has to keep
 * opposite:
 *
 *   PLAIN Left/Right belong to the overlay step WHEN, AND ONLY WHEN, the
 *   sub-selection is at CHART level and the chart actually carries cues.
 *   Everywhere else — any deeper rung, any chart without cues, and every
 *   modified arrow — they belong to the element walk.
 *
 * It is the right split rather than a coin toss: chart level is exactly where
 * the walk has nothing to do (the chart-area group has one member, so Left/Right
 * there moves nothing), and it is where a reader who turned cues on is looking.
 * The modifier test comes FIRST and matches `overlayStepDelta`'s own, so a
 * Ctrl+arrow is never withheld from the walk on the strength of a cue — which is
 * what lets the walk offer both bindings without either being taken away.
 */
export function arrowsBelongToOverlayStep(
  sub: ChartSubSelection,
  cueCount: number,
  e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (sub.level !== "chart") return false;
  return cueCount > 0;
}

// ============================================================================
// Keyboard navigation (CI-10) — the same ladder, walked instead of clicked
// ============================================================================
//
// WHY THIS IS NOT A NICETY. A data point that another mark covers, or that is
// two pixels wide, cannot be CLICKED at all. The arrow keys are the only way to
// reach it, which makes this an accessibility requirement rather than a
// convenience: Excel's Up/Down walks the element GROUPS and Left/Right walks the
// MEMBERS inside the group the reader is standing on.
//
// Everything here is PURE — it takes the layout and the geometry and answers
// with a sub-selection. The listener that applies it lives in index.ts, next to
// the two other capture-phase key listeners it has to agree with.
//
// TWO SOURCES, BOTH ALREADY THE CLICK'S OWN:
//   * The furniture comes from `layout.elements` — the MEASURED rects. A title
//     that is not drawn has no rect, so it is not in the walk. Deriving the walk
//     from the SPEC instead would put a rung on an element the reader cannot
//     see, which is the dead-hit-result defect `CHART_ELEMENT_IDS` documents.
//   * The data rungs come from `HitGeometry` — the very thing a click is
//     resolved against, so the keyboard and the mouse cannot disagree about
//     which datum exists. It also means the radial convention is inherited
//     rather than re-decided: `hitTestSliceArcs` reports a slice as
//     `seriesIndex === pointIndex === arc.seriesIndex`, so each slice walks as
//     its own single-point series — exactly what clicking one does.

/** A group of chart elements the Up/Down walk steps between. */
export interface ChartNavGroup {
  /** Stable identity for tests and for locating the current group. */
  id: string;
  /**
   * The rungs inside this group, in Left/Right order. Member 0 is the WHOLE
   * thing (the series, the legend) and the rest are its parts, which is the
   * same whole-then-part shape the click ladder has.
   */
  members: ChartSubSelection[];
}

/** Which way a keystroke moves through {@link ChartNavGroup}s. */
export type ChartNavDirection = "nextGroup" | "prevGroup" | "nextMember" | "prevMember";

/** Where a sub-selection sits in the walk. */
export interface ChartNavPosition {
  groupIndex: number;
  memberIndex: number;
}

/** Every (series, category) pair the geometry actually carries, in paint order. */
function geometryDatumIndices(
  geometry: HitGeometry,
): Array<{ seriesIndex: number; categoryIndex: number }> {
  switch (geometry.type) {
    case "bars":
      return geometry.rects.map((r) => ({ seriesIndex: r.seriesIndex, categoryIndex: r.categoryIndex }));
    case "points":
      return geometry.markers.map((m) => ({ seriesIndex: m.seriesIndex, categoryIndex: m.categoryIndex }));
    case "slices":
      // A slice IS its category — the same rule `geometryHasDatum` and
      // `hitTestSliceArcs` use. Re-deriving it differently here is how the
      // keyboard would come to address a datum the mouse cannot.
      return geometry.arcs.map((a) => ({ seriesIndex: a.seriesIndex, categoryIndex: a.seriesIndex }));
    case "composite":
      return geometry.groups.flatMap(geometryDatumIndices);
  }
}

/**
 * The Up/Down walk for a chart, in a FIXED order.
 *
 * The order is chart area, title, legend, plot area, the two axes, the two axis
 * titles, then one group per series. It is fixed rather than derived from paint
 * order because a walk whose order changes with the palette or the mark is a
 * walk the reader cannot learn; absent furniture is simply skipped.
 *
 * The chart area and the plot area are unconditional — they ARE the chart — so
 * even before the first render has produced a layout or any geometry the walk
 * has somewhere to stand.
 */
export function buildChartNavGroups(
  layout: ChartLayout | null,
  geometry: HitGeometry | null,
): ChartNavGroup[] {
  const groups: ChartNavGroup[] = [{ id: "chartArea", members: [{ level: "chart" }] }];
  const el = layout?.elements;

  if (el?.title) {
    groups.push({ id: "title", members: [{ level: "element", elementId: "title" }] });
  }

  if (el?.legend) {
    const members: ChartSubSelection[] = [{ level: "element", elementId: "legend" }];
    for (const item of el.legendItems ?? []) {
      members.push({ level: "element", elementId: "legendEntry", seriesIndex: item.seriesIndex });
    }
    groups.push({ id: "legend", members });
  }

  groups.push({ id: "plotArea", members: [{ level: "element", elementId: "plotArea" }] });

  if (el?.xAxisBand) groups.push({ id: "xAxis", members: [{ level: "axis", axisType: "x" }] });
  if (el?.yAxisBand) groups.push({ id: "yAxis", members: [{ level: "axis", axisType: "y" }] });
  if (el?.xAxisTitle) {
    groups.push({ id: "xAxisTitle", members: [{ level: "element", elementId: "xAxisTitle" }] });
  }
  if (el?.yAxisTitle) {
    groups.push({ id: "yAxisTitle", members: [{ level: "element", elementId: "yAxisTitle" }] });
  }

  if (geometry !== null) {
    const bySeries = new Map<number, number[]>();
    for (const { seriesIndex, categoryIndex } of geometryDatumIndices(geometry)) {
      let cats = bySeries.get(seriesIndex);
      if (cats === undefined) {
        cats = [];
        bySeries.set(seriesIndex, cats);
      }
      if (!cats.includes(categoryIndex)) cats.push(categoryIndex);
    }
    for (const seriesIndex of [...bySeries.keys()].sort((a, b) => a - b)) {
      const members: ChartSubSelection[] = [{ level: "series", seriesIndex }];
      for (const categoryIndex of bySeries.get(seriesIndex) ?? []) {
        members.push({ level: "dataPoint", seriesIndex, categoryIndex });
      }
      groups.push({ id: `series:${seriesIndex}`, members });
    }
  }

  return groups;
}

/** Are these two sub-selections the same rung? */
function sameRung(a: ChartSubSelection, b: ChartSubSelection): boolean {
  if (a.level !== b.level) return false;
  switch (a.level) {
    case "none":
    case "chart":
      return true;
    case "axis":
      return a.axisType === b.axisType;
    case "series":
      return a.seriesIndex === b.seriesIndex;
    case "dataPoint":
      return a.seriesIndex === b.seriesIndex && a.categoryIndex === b.categoryIndex;
    case "element":
      if (a.elementId !== b.elementId) return false;
      // A legend entry is only itself when it stands for the same series.
      return a.elementId === "legendEntry" ? a.seriesIndex === b.seriesIndex : true;
  }
}

/** Where `sub` sits in `groups`, or null when the walk cannot name it. */
export function findChartNavPosition(
  groups: readonly ChartNavGroup[],
  sub: ChartSubSelection,
): ChartNavPosition | null {
  for (let g = 0; g < groups.length; g++) {
    const members = groups[g].members;
    for (let m = 0; m < members.length; m++) {
      if (sameRung(members[m], sub)) return { groupIndex: g, memberIndex: m };
    }
  }
  return null;
}

/**
 * The rung an arrow key moves to, or null when nothing moves.
 *
 * A selection the walk cannot name — nothing selected, or a rung whose element
 * has stopped being drawn since it was chosen — enters at the first group's
 * first member rather than answering "no move": a reader pressing an arrow is
 * asking to go SOMEWHERE, and refusing would leave them with a chart selected
 * and a dead keyboard.
 *
 * Both walks WRAP. A group of one member (every piece of furniture) therefore
 * answers null for Left/Right — there is nowhere else inside it to stand.
 */
export function navigateChartSelection(
  groups: readonly ChartNavGroup[],
  current: ChartSubSelection,
  direction: ChartNavDirection,
): ChartSubSelection | null {
  if (groups.length === 0) return null;

  const pos = findChartNavPosition(groups, current);
  if (pos === null) return groups[0].members[0] ?? null;

  if (direction === "nextGroup" || direction === "prevGroup") {
    const delta = direction === "nextGroup" ? 1 : -1;
    const gi = (pos.groupIndex + delta + groups.length) % groups.length;
    return groups[gi].members[0] ?? null;
  }

  const members = groups[pos.groupIndex].members;
  if (members.length <= 1) return null;
  const delta = direction === "nextMember" ? 1 : -1;
  const mi = (pos.memberIndex + delta + members.length) % members.length;
  return members[mi] ?? null;
}

/**
 * One rung UP from `sub`, or null meaning "leave the chart entirely".
 *
 * Before this, Escape was not a chart keystroke at all: it fell straight
 * through to the grid, and the only way out of a rung was to click somewhere
 * else — which drops the whole chart. Excel steps out one level at a time, so a
 * reader who drilled three rungs deep to reach a covered point can back out to
 * its series without losing the chart.
 */
export function escapeLevelUp(sub: ChartSubSelection): ChartSubSelection | null {
  switch (sub.level) {
    case "dataPoint":
      return sub.seriesIndex == null
        ? { level: "chart" }
        : { level: "series", seriesIndex: sub.seriesIndex };
    case "series":
    case "axis":
      return { level: "chart" };
    case "element":
      // Inside the legend, the whole legend is the level above an entry.
      return sub.elementId === "legendEntry"
        ? { level: "element", elementId: "legend" }
        : { level: "chart" };
    case "chart":
    case "none":
      return null;
  }
}

// ============================================================================
// The two AREAS — and why Delete must not destroy the chart on either
// ============================================================================

/**
 * The element ids that stand for a REGION of the chart rather than a piece of
 * furniture sitting in it.
 *
 * Delete means "remove the smallest thing selected", and for a region there is
 * nothing smaller to remove: Excel's Delete on a selected plot area does
 * nothing destructive at all. Before this list existed, `plotArea` fell through
 * the Delete listener's element branches into the final "destroy the whole
 * chart" arm, so Down-Down-Down to the plot area and Delete was a three-key
 * route from a selected chart to no chart — and the walk's own coverage test
 * BLESSED it, on the ground that "the two areas ARE the chart".
 *
 * They are not. The chart OBJECT is `level: "chart"` — the rung with the border
 * and the resize handles, the one the reader gets by clicking the chart and the
 * ONLY rung whose Delete is destructive. These two are element rungs: things to
 * format, with a fill and a border of their own. Keeping exactly one
 * destructive route is the point; a second one reachable by a walk nobody
 * audits is how work disappears.
 */
export const CHART_AREA_ELEMENT_IDS: readonly ChartElementId[] = ["plotArea", "chartArea"];

/** Is this element rung one of the two AREAS, where Delete is a no-op? */
export function isChartAreaElement(id: ChartElementId | undefined): boolean {
  return id !== undefined && CHART_AREA_ELEMENT_IDS.includes(id);
}

// ============================================================================
// Hiding ONE legend entry (GAP 2)
// ============================================================================

/**
 * Where the selection goes after a legend entry is hidden.
 *
 * `entryIndices` is the painter-space index carried by each legend ROW as the
 * layout measured it BEFORE the hide (`ChartElementRects.legendItems`) — series
 * indices for a cartesian legend, category indices for a radial one, which is
 * the same space `LegendSpec.hiddenEntries` is written in.
 *
 * The rung that was selected has just stopped existing, and leaving it selected
 * is the stale-subject defect the cue rings already taught us. Moving to the
 * NEXT surviving row (wrapping) is what makes repeated Delete peel entries off
 * one at a time, which is the gesture a reader who pressed Delete once is
 * already holding.
 *
 * When nothing survives, the legend box itself stops being drawn — the layout
 * returns no legend rects once every row is hidden — so the whole legend is not
 * a rung either and the chart is the nearest thing certain to exist. The same
 * answer covers "we were not told which rows there were": naming a row we
 * cannot see is how a selection comes to point at furniture that is not there.
 */
export function selectionAfterHidingLegendEntry(
  entryIndices: readonly number[],
  hiddenIndex: number,
): ChartSubSelection {
  const at = entryIndices.indexOf(hiddenIndex);
  // PAINT ORDER, not numeric order. The rows are walked in the order the legend
  // draws them, which is the order the reader sees and the order the Left/Right
  // walk already uses; sorting the indices instead would make "the next one"
  // mean something different for any legend whose rows are not in index order.
  const after =
    at === -1
      ? [...entryIndices]
      : [...entryIndices.slice(at + 1), ...entryIndices.slice(0, at)];
  const next = after.find((i) => i !== hiddenIndex);
  if (next === undefined) return { level: "chart" };
  return { level: "element", elementId: "legendEntry", seriesIndex: next };
}

// ============================================================================
// Deferred Click (distinguishes clicks from drags)
// ============================================================================

/**
 * Set a pending click. Called on floatingObject:selected for already-selected charts.
 */
export function setPendingClick(chartId: string, canvasX: number, canvasY: number): void {
  pendingClick = { chartId, canvasX, canvasY };
}

/**
 * Record where the object sat when the press landed. Called on
 * floatingObject:selected for EVERY chart press (selected or not), because the
 * press that selects a chart is also the press whose jitter must not be read
 * as a drag.
 */
export function notePressOrigin(chartId: string, x: number, y: number): void {
  movePress = { chartId, x, y, exceeded: false };
}

/**
 * Record a live move preview and answer whether it is a REAL move.
 *
 * Core fires a preview on every mousemove once the drag is live, including the
 * sub-pixel tremor between pressing and releasing the button, and Charts used
 * to cancel the pending click on all of them. Returns false for a preview that
 * has not left Core's own 3px dead zone — the caller then leaves both the
 * pending click AND the object alone, which also means a tremor no longer
 * schedules a save of a position that never changed. Returns true for a real
 * move, having cleared the pending click.
 *
 * With no recorded press (a programmatic or replayed move) the preview is
 * taken at face value, which is the behaviour that was there before.
 */
export function noteMovePreview(chartId: string, x: number, y: number): boolean {
  if (movePress !== null && movePress.chartId === chartId && !movePress.exceeded) {
    if (
      Math.abs(x - movePress.x) <= MOVE_JITTER_THRESHOLD_PX &&
      Math.abs(y - movePress.y) <= MOVE_JITTER_THRESHOLD_PX
    ) {
      return false;
    }
    movePress.exceeded = true;
  }
  clearPendingClick();
  return true;
}

/**
 * Clear the pending click (was a drag, not a click).
 * Called on floatingObject:moveComplete.
 */
export function clearPendingClick(): void {
  pendingClick = null;
}

/**
 * Consume and return the pending click (if any).
 * Called on mouseup to determine if a click occurred.
 */
export function consumePendingClick(): { chartId: string; canvasX: number; canvasY: number } | null {
  const click = pendingClick;
  pendingClick = null;
  return click;
}

// ============================================================================
// Reset
// ============================================================================

/**
 * Reset all selection handler state (used during extension deactivation).
 */
export function resetSelectionHandlerState(): void {
  currentChartId = null;
  subSelection = { level: "none" };
  pendingClick = null;
  movePress = null;
  staleSubSelection = null;
  if (designTabRegistered) {
    window.removeEventListener(ChartEvents.CHART_UPDATED, handleChartUpdatedForDesignPanel);
    unregisterPanel(CHART_DESIGN_TAB_ID);
    designTabRegistered = false;
    designSectionIds = "";
  }
}
