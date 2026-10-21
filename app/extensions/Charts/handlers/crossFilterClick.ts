//! FILENAME: app/extensions/Charts/handlers/crossFilterClick.ts
// PURPOSE: The click grammar of a cross-filter SOURCE chart (P4, G4, S6): what
//          a released press on a canvas design-query chart's datum, legend
//          entry or background does to the page's visual selections
//          (@api/reportFilters). Power BI's grammar:
//
//            plain click            replaces EVERY selection on the page with
//                                   this source's one tuple (a plain click in
//                                   another visual drops that visual's
//                                   selection);
//            plain click on the     clears this source;
//            sole selected datum
//            Ctrl+click             toggles the tuple within this source and
//                                   keeps every other source (AND);
//            background / margin    clears this source (the zone arms such a
//                                   press only while the chart HAS a selection);
//            no member paths        does nothing, and says so once per chart.
//
//          A datum's MemberPath is its category's path plus its series' path
//          (`categoryMembers[pointIndex]` + `seriesMembers[seriesIndex]`); a
//          legend entry is its series' path only. On a RADIAL mark (pie,
//          donut) a slice IS its category -- the hit and the legend name the
//          category index -- so both give `categoryMembers[index]` plus the one
//          series' path. A path's fields are the selection's fields; a tuple
//          over a different field list REPLACES the selection.
// CONTEXT: Pure apart from the seam calls (the selections and the page list).
//          The chart's zone (lib/chartZoneAt.ts) decides WHERE a press is a
//          cross-filter press; index.ts arms it, checks the release is over
//          the same datum, selects the chart and assigns the cue first (DC-8),
//          then calls `applyCrossFilterClick`.

import {
  addToCrossFilter,
  clearCrossFilter,
  getCrossFilters,
  isCrossFilterSource,
  setCrossFilter,
  type CrossFilterSelection,
  type MemberPath,
  type VisualRef,
} from "@api/reportFilters";
import { getReportPagesSnapshot, sheetIdAt } from "@api/reportPages";
import { isCartesianChart, isDesignQueryDataSource, type ChartDefinition, type ChartHitResult, type ParsedChartData } from "../types";
import { isDatumHit } from "../rendering/chartHitTesting";

/** What a released cross-filter press did (the tests and the console read it). */
export type CrossFilterClickOutcome =
  /** The page's selections were replaced by this source's one tuple. */
  | "selected"
  /** The tuple was toggled within this source (Ctrl). */
  | "toggled"
  /** This source's selection was cleared. */
  | "cleared"
  /** The datum names no member (no paths on this read): nothing happened. */
  | "noPaths"
  /** Nothing to do (a background click on a chart without a selection, no page id, no model). */
  | "ignored";

export interface CrossFilterClickInput {
  chart: Pick<ChartDefinition, "chartId" | "name" | "sheetIndex" | "spec">;
  /** The PAINTED data the hit indices index (the render cache's `data`). */
  data: ParsedChartData | null | undefined;
  /** The hit at the press (a datum, a legend entry, or anything else = the background). */
  hit: ChartHitResult | null | undefined;
  /** Ctrl (or Cmd) was held at the press. */
  ctrl: boolean;
}

/** The ref a chart's selection is held under. */
export function chartVisualRef(chartId: string): VisualRef {
  return { kind: "chart", id: chartId };
}

/** Whether the hit is one a cross-filter gesture reads as a member (a datum or a legend entry). */
export function isMemberHit(hit: ChartHitResult | null | undefined): boolean {
  return !!hit && (isDatumHit(hit) || hit.element === "legendEntry");
}

/**
 * The member path a hit names, or null when it names none on this data: no
 * member paths (a view without `groupMembers`, a transform, a composed chart),
 * an index outside them, or an EMPTY path (a grand total, a lone measure's
 * legend entry -- no field narrows it, so it filters nothing).
 */
export function memberPathOfHit(
  data: ParsedChartData | null | undefined,
  hit: ChartHitResult | null | undefined,
  mark: string,
): MemberPath | null {
  if (!data || !hit || !data.categoryMembers || !data.seriesMembers) return null;
  const radial = !isCartesianChart(mark);
  let path: MemberPath | undefined;
  if (isDatumHit(hit)) {
    const ci = radial ? (hit.pointIndex ?? hit.seriesIndex) : hit.pointIndex;
    const si = radial ? 0 : hit.seriesIndex;
    if (ci === undefined || si === undefined) return null;
    const category = data.categoryMembers[ci];
    const series = data.seriesMembers[si] ?? (radial ? [] : undefined);
    if (!category || !series) return null;
    path = [...category, ...series];
  } else if (hit.element === "legendEntry") {
    const i = hit.seriesIndex;
    if (i === undefined) return null;
    if (radial) {
      const category = data.categoryMembers[i];
      if (!category) return null;
      path = [...category, ...(data.seriesMembers[0] ?? [])];
    } else {
      path = data.seriesMembers[i];
    }
  }
  if (!path || path.length === 0) return null;
  // A path naming one field twice cannot be a tuple (the seam refuses it).
  if (new Set(path.map((c) => c.field)).size !== path.length) return null;
  return path;
}

/** Charts already told their datums name no member (one console line each). */
const noPathsNoted = new Set<string>();

/** Forget the "said once" notes (tests). */
export function resetCrossFilterClickNotes(): void {
  noPathsNoted.clear();
}

function noteNoPaths(chartId: string): void {
  if (noPathsNoted.has(chartId)) return;
  noPathsNoted.add(chartId);
  console.warn(
    `[Charts] Chart "${chartId}": this point names no model member (its data carries no member paths), so the click filters nothing.`,
  );
}

/** Whether `held` is exactly the one tuple `path` names. */
function isSoleTuple(held: CrossFilterSelection, path: MemberPath): boolean {
  if (held.tuples.length !== 1 || held.fields.length !== path.length) return false;
  const tuple = held.tuples[0];
  return held.fields.every((f, i) => {
    const coord = path.find((c) => c.field === f);
    return !!coord && coord.key === tuple[i];
  });
}

/**
 * Run the gesture for one released cross-filter press. Reads and writes only
 * the @api/reportFilters selections (view state: no undo, no dirty flag).
 */
export function applyCrossFilterClick(input: CrossFilterClickInput): CrossFilterClickOutcome {
  const { chart, data, hit, ctrl } = input;
  const ref = chartVisualRef(chart.chartId);

  // The background (anything that is not a member): clears this source.
  if (!isMemberHit(hit)) {
    if (!isCrossFilterSource(ref)) return "ignored";
    clearCrossFilter(ref);
    return "cleared";
  }

  const path = memberPathOfHit(data, hit, String(chart.spec?.mark ?? ""));
  if (!path) {
    noteNoPaths(chart.chartId);
    return "noPaths";
  }

  const source = chart.spec?.data;
  const connectionId = isDesignQueryDataSource(source) && source.connectionId ? String(source.connectionId) : "";
  const pageSheetId = sheetIdAt(getReportPagesSnapshot(), chart.sheetIndex);
  if (!connectionId || !pageSheetId) return "ignored";

  const fields = path.map((c) => c.field);
  const tuple = path.map((c) => c.key);
  const fresh: CrossFilterSelection = {
    source: ref,
    sourceName: chart.name ?? chart.chartId,
    pageSheetId,
    connectionId,
    fields,
    tuples: [tuple],
  };
  const held = getCrossFilters().find((s) => s.source.kind === ref.kind && s.source.id === ref.id);

  if (ctrl) {
    // Toggle within this source; every other source is kept (AND). A source
    // with no selection, or one held on another page or model, starts afresh.
    if (held && held.pageSheetId === pageSheetId && held.connectionId === connectionId) {
      addToCrossFilter(ref, path);
    } else {
      setCrossFilter(fresh);
    }
    return "toggled";
  }

  if (held && held.pageSheetId === pageSheetId && isSoleTuple(held, path)) {
    clearCrossFilter(ref);
    return "cleared";
  }

  // A plain click: this source's one tuple replaces every selection on the page.
  for (const other of getCrossFilters(pageSheetId)) {
    if (other.source.kind === ref.kind && other.source.id === ref.id) continue;
    clearCrossFilter(other.source);
  }
  setCrossFilter(fresh);
  return "selected";
}
