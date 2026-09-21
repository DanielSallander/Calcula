//! FILENAME: app/src/api/chartSelection.ts
// PURPOSE: The published, read-only answer to "what inside a chart is selected
//          right now, and what is it called?" — written by Charts, read by
//          anyone (the Format pane, contributed menu items, Insights, the
//          shell's Name Box).
// CONTEXT: Before this existed, every consumer that needed the selection
//          re-derived it from the raw `app:chart-selection-changed` CustomEvent
//          and each one derived a slightly different thing: Insights asked only
//          `getSelectedChartId()` and threw the rung away, ChartDesignSections
//          reached into the Charts extension's own `getSubSelection()`, and the
//          shell's NameBox parsed the event payload by hand. Three readers,
//          three shapes, one fact. A reader outside Charts had no legal route
//          to the rung at all, because the Facade Rule forbids importing the
//          extension.
//
//          @api MUST NEVER IMPORT FROM app/extensions, so this file holds only
//          types and a registry. The element vocabulary below is therefore a
//          SECOND spelling of `CHART_ELEMENT_IDS` in
//          `app/extensions/Charts/types.ts`, and the two are pinned together in
//          BOTH directions rather than trusted:
//
//            * Charts -> API is checked by the COMPILER. Charts publishes with
//              `elementId: ChartElementId`, so an id Charts can produce and
//              this union cannot name fails to typecheck at the publish site.
//            * API -> Charts is checked by a TEST that reads Charts' types.ts
//              at test time and diffs the two arrays
//              (`ChartFormatPaneSelection.test.ts`). A member here with no
//              counterpart there is an element nothing can ever select — the
//              dead-member defect CI-7 removed from the union in the first
//              place.
//
//          THE DISPLAY NAME IS DERIVED, NEVER PUBLISHED. `publishChartSelection`
//          takes only the structural facts and computes the name itself, so the
//          name and the rung cannot disagree. A publisher that could pass both
//          would be free to say "Chart Area" over a selected data point, and
//          the Name Box would print it.
//
//          NOTHING HERE PERSISTS. The snapshot is live UI state; it is not
//          saved, not undoable and not part of any document.

// ============================================================================
// Vocabulary
// ============================================================================

/**
 * Every individually addressable chart element, as Excel's `GetChartElement`
 * names them. Mirrors `CHART_ELEMENT_IDS` in the Charts extension — see the
 * two-direction pinning described in this file's header.
 */
export const CHART_SELECTION_ELEMENT_IDS = [
  "chartArea",
  "plotArea",
  "datum",
  "title",
  "xAxisTitle",
  "yAxisTitle",
  "xAxis",
  "yAxis",
  "legend",
  "legendEntry",
  "trendline",
  "errorBars",
  "dataLabel",
  "dataTable",
  "filterButton",
  "none",
] as const;

/** Name of a chart element. Derived from {@link CHART_SELECTION_ELEMENT_IDS}. */
export type ChartSelectionElementId = (typeof CHART_SELECTION_ELEMENT_IDS)[number];

/**
 * How deep into a chart the selection has gone.
 *
 * `element` covers every non-datum, non-axis piece of furniture (title, axis
 * titles, legend, legend entry); {@link ChartSelectionTarget.elementId} says
 * which one. One level rather than one level per element, because the element's
 * name is already carried.
 */
export type ChartSelectionLevelName =
  | "none"
  | "chart"
  | "series"
  | "dataPoint"
  | "axis"
  | "element";

// ============================================================================
// The snapshot
// ============================================================================

/** The structural facts a publisher supplies. */
export interface ChartSelectionTarget {
  /** null when no chart is selected. */
  chartId: string | null;
  /** The chart's display name ("Chart 1"), or null when none is selected. */
  chartName: string | null;
  level: ChartSelectionLevelName;
  /** Set at "series", "dataPoint" and legend-entry "element" levels. */
  seriesIndex?: number;
  /** Set at "dataPoint" level. PAINTER space — post-filter, as drawn. */
  categoryIndex?: number;
  /** Set at "axis" level. */
  axisType?: "x" | "y";
  /** Set at "element" level. */
  elementId?: ChartSelectionElementId;
  /**
   * The resolved series name, when the publisher knows it. Used only to make
   * the display name readable; the ordinal is always available as a fallback.
   */
  seriesName?: string;
  /** The resolved category label, when the publisher knows it. */
  categoryName?: string;
}

/** What every reader gets. Frozen — this registry is read-only to consumers. */
export interface ChartSelectionSnapshot extends ChartSelectionTarget {
  /**
   * What to show the reader, Excel's Name Box wording: "Series 1 Point 3",
   * "Chart Title", "Vertical (Value) Axis". Empty string when nothing is
   * selected. DERIVED from the fields above by {@link chartSelectionDisplayName}
   * — never supplied by the publisher.
   */
  displayName: string;
}

/** The snapshot when no chart is selected. */
export const EMPTY_CHART_SELECTION: ChartSelectionSnapshot = Object.freeze({
  chartId: null,
  chartName: null,
  level: "none" as const,
  displayName: "",
});

// ============================================================================
// The display name (CI-9b)
// ============================================================================

const AXIS_NAME: Record<"x" | "y", string> = {
  x: "Horizontal (Category) Axis",
  y: "Vertical (Value) Axis",
};

/** Excel's name for the whole chart canvas, spelled once. */
const CHART_AREA_NAME = "Chart Area";

/**
 * THE CHART AREA IS ONE RUNG WITH ONE SPELLING.
 *
 * Two routes reach it — `level: "chart"` (the click that selects the object)
 * and `level: "element", elementId: "chartArea"` (the element vocabulary's name
 * for the same canvas) — and they used to disagree: one printed the chart's
 * NAME and the other printed the chart's name too, which only looked like
 * agreement because BOTH were wrong. Excel's Name Box says "Chart Area" there,
 * and a reader who cannot learn the element's name from the one surface that
 * names elements cannot learn it anywhere.
 *
 * It is QUALIFIED rather than bare, which is where this departs from Excel on
 * purpose. Excel can afford an unqualified "Chart Area" because its charts are
 * sheet-scoped objects whose identity the Name Box carries separately; we have
 * ONE Name Box, and it is the only surface that says WHICH chart is selected.
 * Dropping the name to match Excel's wording exactly would trade a known fact
 * for a new one instead of adding it, so the reader gets both: `Chart 1 Chart
 * Area`. With no name known it degrades to the bare element name rather than
 * inventing a placeholder one.
 */
function chartAreaLabel(chartName: string | null | undefined): string {
  return chartName ? `${chartName} ${CHART_AREA_NAME}` : CHART_AREA_NAME;
}

/**
 * Excel's Name Box wording for a chart selection.
 *
 * ORDINALS FIRST, NAMES WHEN KNOWN. Excel's Name Box literally reads
 * `Series 1 Point 3`; its Chart Elements dropdown reads `Series "Sales"`. The
 * reader needs to know WHICH RUNG they are on more than they need the label
 * they can already see on the chart, so the ordinal is never dropped — a name,
 * when the publisher supplies one, is appended in quotes after it.
 *
 * Pure, so the shell can call it on a snapshot it already holds without
 * re-reading the registry.
 */
export function chartSelectionDisplayName(target: ChartSelectionTarget): string {
  if (target.chartId === null || target.level === "none") return "";

  const seriesLabel = (): string => {
    const i = target.seriesIndex;
    if (i == null) return "Series";
    const ordinal = `Series ${i + 1}`;
    return target.seriesName ? `${ordinal} "${target.seriesName}"` : ordinal;
  };

  switch (target.level) {
    case "chart":
      // Same rung, same spelling as `elementId: "chartArea"` below — see
      // {@link chartAreaLabel}.
      return chartAreaLabel(target.chartName);

    case "series":
      return seriesLabel();

    case "dataPoint": {
      const c = target.categoryIndex;
      const point =
        c == null
          ? "Point"
          : target.categoryName
            ? `Point ${c + 1} "${target.categoryName}"`
            : `Point ${c + 1}`;
      return `${seriesLabel()} ${point}`;
    }

    case "axis":
      return AXIS_NAME[target.axisType ?? "x"];

    case "element":
      switch (target.elementId) {
        case "title":
          return "Chart Title";
        case "xAxisTitle":
          return `${AXIS_NAME.x} Title`;
        case "yAxisTitle":
          return `${AXIS_NAME.y} Title`;
        case "legend":
          return "Legend";
        case "legendEntry":
          return target.seriesIndex == null
            ? "Legend Entry"
            : `${seriesLabel()} Legend Entry`;
        case "trendline":
          return target.seriesIndex == null ? "Trendline" : `${seriesLabel()} Trendline`;
        case "errorBars":
          // Per SERIES, never per point — Excel has no per-point error bar, so
          // the name must never grow a category.
          return target.seriesIndex == null ? "Error Bars" : `${seriesLabel()} Error Bars`;
        case "dataLabel":
          return target.seriesIndex == null ? "Data Label" : `${seriesLabel()} Data Label`;
        case "dataTable":
          return "Data Table";
        case "plotArea":
          return "Plot Area";
        case "chartArea":
          // The SAME string `level: "chart"` returns. Two routes, one rung, one
          // spelling — see {@link chartAreaLabel}.
          return chartAreaLabel(target.chartName);
        case "filterButton":
          return "Field Button";
        case "xAxis":
          return AXIS_NAME.x;
        case "yAxis":
          return AXIS_NAME.y;
        default:
          // "datum" / "none" / absent: the element level cannot name anything
          // finer than the chart area, so it says so rather than silently
          // falling back to the OBJECT's name and claiming a rung it is not on.
          return chartAreaLabel(target.chartName);
      }
  }
}

// ============================================================================
// The registry
// ============================================================================

type Listener = (snapshot: ChartSelectionSnapshot) => void;

let current: ChartSelectionSnapshot = EMPTY_CHART_SELECTION;
const listeners = new Set<Listener>();

/** Field-by-field equality, so a republish of the same rung notifies nobody. */
function sameSelection(a: ChartSelectionSnapshot, b: ChartSelectionSnapshot): boolean {
  return (
    a.chartId === b.chartId &&
    a.chartName === b.chartName &&
    a.level === b.level &&
    a.seriesIndex === b.seriesIndex &&
    a.categoryIndex === b.categoryIndex &&
    a.axisType === b.axisType &&
    a.elementId === b.elementId &&
    a.seriesName === b.seriesName &&
    a.categoryName === b.categoryName &&
    a.displayName === b.displayName
  );
}

/**
 * Publish the current chart selection. THE ONE WRITE DOOR, and it belongs to
 * Charts: the extension that owns the selection ladder is the only thing that
 * can know what rung it is on.
 *
 * Passing `null` clears the selection, which is the same snapshot a publisher
 * gets by passing `level: "none"`.
 *
 * Listeners are notified ONLY when something actually changed. A pane that
 * re-rendered on every republish would repaint on every mouse-up inside the
 * chart it is already targeting.
 */
export function publishChartSelection(target: ChartSelectionTarget | null): void {
  const next: ChartSelectionSnapshot =
    target === null || target.chartId === null
      ? EMPTY_CHART_SELECTION
      : Object.freeze({ ...target, displayName: chartSelectionDisplayName(target) });

  if (sameSelection(current, next)) return;
  current = next;
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch (err) {
      // One bad reader must not stop the others from being told, and must not
      // take the gesture that published down with it.
      console.error("[chartSelection] listener failed:", err);
    }
  }
}

/** The current selection. Never null; `level: "none"` when nothing is selected. */
export function getChartSelection(): ChartSelectionSnapshot {
  return current;
}

/**
 * Subscribe to selection changes. Returns the unsubscribe.
 *
 * The snapshot is passed to the listener AND available from
 * {@link getChartSelection}, so this works directly as the `subscribe` half of
 * a `useSyncExternalStore` pair.
 */
export function onChartSelectionChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Clear the registry AND its listeners (test teardown, extension deactivation).
 * Never call this to deselect — that is `publishChartSelection(null)`, which
 * tells the readers.
 */
export function resetChartSelectionRegistry(): void {
  current = EMPTY_CHART_SELECTION;
  listeners.clear();
}
