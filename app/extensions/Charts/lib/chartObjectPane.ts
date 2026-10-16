//! FILENAME: app/extensions/Charts/lib/chartObjectPane.ts
// PURPOSE: The chart's @api/objectPane provider (WP-C D-PANE): which BUILD tabs
//          a chart offers in the ONE object pane, which tab a door or a press
//          lands on, the pane header, and the chart's doors into it.
// CONTEXT: The tab set follows the chart's DATA SOURCE (D-PANE):
//            design query (incl. Card, Multi-row card, KPI, Gauge)  Fields | Design | Format
//            cell range                                             Data | Format
//            PivotTable                                             Data | Format
//          The host (BuiltIn/ObjectPane) adds Format itself and renders the
//          active build tab into ONE slot that stays mounted under Format.
//          S9a rendered each build tab as `ChartBuildPending`. S9c replaced
//          the Data tab's body (`renderChartDataTab`: the range editor
//          pane/ChartRangeDataTab, or pane/ChartPivotDataTab for a PivotTable
//          source); S9b replaced Fields / Design with ONE body for both,
//          pane/ChartDesignQueryBuild (the wells over the model's field list,
//          or the DSL editor, under a shared connection select). The tab IDS
//          are final, so a door ("Edit data") and the
//          reader's remembered tab already name the right one.
//
//          THE FORMAT DOORS (Ctrl+1 on a selected chart, the chart
//          double-click, the context menu's "Format <element>...", the retired
//          Format Axis / Format Data Point dialog ids) all end in
//          `openChartFormatPane`: the ladder's rung is published first (so the
//          Format tab's "Chart elements" card shows the element the reader
//          picked) and the object pane opens on Format as a COMMAND -- a door,
//          so it opens even when the reader closed the pane by hand.
//
//          No store-reading module is imported at the top level of anything
//          the store imports; this module is imported only by the extension's
//          entry, its menus and its redirectors.

import React from "react";
import { getGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  OBJECT_PANE_FORMAT_TAB,
  openObjectPane,
  type ObjectPaneOpenReason,
  type ObjectPaneProvider,
  type ObjectPaneTab,
  type ObjectPaneTabContext,
} from "@api/objectPane";
import type { ChartDefinition, ChartSpec, DataSource } from "../types";
import { isDataRangeRef, isDesignQueryDataSource, isPivotDataSource } from "../types";
import { ChartBuildPending } from "../components/pane/ChartBuildPending";
import { ChartRangeDataTab } from "../components/pane/ChartRangeDataTab";
import { ChartPivotDataTab } from "../components/pane/ChartPivotDataTab";
import { ChartDesignQueryBuild } from "../components/pane/ChartDesignQueryBuild";

/** The build tab ids a chart can offer (never "format": the host owns it). */
export const CHART_PANE_TAB_FIELDS = "fields";
export const CHART_PANE_TAB_DESIGN = "design";
export const CHART_PANE_TAB_DATA = "data";

/** The source kinds the tab set follows. */
export type ChartPaneSourceKind = "designQuery" | "range" | "pivot";

/** Which kind of source a chart reads. A string source is an A1 range or a defined name: a range. */
export function chartPaneSourceKind(data: DataSource | null | undefined): ChartPaneSourceKind {
  if (data && isDesignQueryDataSource(data)) return "designQuery";
  if (data && isPivotDataSource(data)) return "pivot";
  return "range";
}

/** The build tab ids for a chart, in order. */
export function chartPaneTabIds(spec: ChartSpec | null | undefined): string[] {
  if (!spec) return [];
  return chartPaneSourceKind(spec.data) === "designQuery"
    ? [CHART_PANE_TAB_FIELDS, CHART_PANE_TAB_DESIGN]
    : [CHART_PANE_TAB_DATA];
}

/** The tab "Edit data" opens: Fields for a design query, Data otherwise. */
export function chartEditDataTab(spec: ChartSpec | null | undefined): string {
  return chartPaneTabIds(spec)[0] ?? CHART_PANE_TAB_DATA;
}

const TAB_LABELS: Readonly<Record<string, string>> = {
  [CHART_PANE_TAB_FIELDS]: "Fields",
  [CHART_PANE_TAB_DESIGN]: "Design",
  [CHART_PANE_TAB_DATA]: "Data",
};

/** "A design query", "Sheet1!A1:D10", "PivotTable" -- what a build tab names as the source. */
export function chartSourceText(spec: ChartSpec): string {
  const data = spec.data;
  if (isDesignQueryDataSource(data)) return "A design query against a BI model";
  if (isPivotDataSource(data)) return "A PivotTable";
  if (typeof data === "string") return data;
  if (isDataRangeRef(data)) {
    const col = (n: number): string => {
      let s = "";
      let v = n + 1;
      while (v > 0) {
        const r = (v - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        v = Math.floor((v - 1) / 26);
      }
      return s;
    };
    return `${col(data.startCol)}${data.startRow + 1}:${col(data.endCol)}${data.endRow + 1}`;
  }
  return "A cell range";
}

/** The chart id a chart region carries, or null. */
function chartIdOf(region: GridRegion): string | null {
  const id = (region.data as { chartId?: unknown } | undefined)?.chartId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The published (floating) region of a chart, or null when it is not on screen. */
export function chartRegionOf(chartId: string): GridRegion | null {
  return getGridRegions().find((r) => r.type === "chart" && !!r.floating && chartIdOf(r) === chartId) ?? null;
}

/**
 * The Data tab's body for a range or PivotTable source (WP-C S9c), or null for
 * a source it does not edit (a design query has Fields / Design instead).
 */
export function renderChartDataTab(
  ctx: ObjectPaneTabContext,
  chartId: string,
  chart: ChartDefinition | null,
  deps: Pick<ChartObjectPaneDeps, "getChart" | "openDataEditor">,
): React.ReactElement | null {
  if (!chart) return null;
  const kind = chartPaneSourceKind(chart.spec.data);
  if (kind === "range") {
    return React.createElement(ChartRangeDataTab, {
      key: `range-${chartId}`,
      ctx,
      chartId,
      getChart: deps.getChart,
      onEditInDialog: () => deps.openDataEditor(chartId),
    });
  }
  if (kind === "pivot") {
    return React.createElement(ChartPivotDataTab, {
      key: `pivot-${chartId}`,
      ctx,
      chartId,
      getChart: deps.getChart,
    });
  }
  return null;
}

/** What the provider needs from the store and the pane (injected by activate()). */
export interface ChartObjectPaneDeps {
  getChart(chartId: string): ChartDefinition | null;
  /** Publish the ladder's current rung into @api/chartSelection (the element card's subject). */
  publishSelection(): void;
  /** Open the chart's existing data editor (the chart dialog's Data tab). */
  openDataEditor(chartId: string): void;
}

/** Build the @api/objectPane provider registered for region type "chart". */
export function createChartObjectPaneProvider(deps: ChartObjectPaneDeps): ObjectPaneProvider {
  const chartOf = (region: GridRegion): ChartDefinition | null => {
    const id = chartIdOf(region);
    return id === null ? null : deps.getChart(id);
  };

  return {
    types: ["chart"],

    tabs(region): readonly ObjectPaneTab[] {
      const chart = chartOf(region);
      if (!chart) return [];
      const chartId = chart.chartId;
      return chartPaneTabIds(chart.spec).map((id) => ({
        id,
        label: TAB_LABELS[id] ?? id,
        // ONE component type for every build tab: one instance across them.
        render: (ctx: ObjectPaneTabContext) => {
          const live = deps.getChart(chartId);
          // S9c: a range or PivotTable source edits its data here. Keyed by
          // the chart, so a retarget to another chart starts a fresh editor.
          const dataTab = id === CHART_PANE_TAB_DATA ? renderChartDataTab(ctx, chartId, live, deps) : null;
          if (dataTab !== null) return dataTab;
          // S9b: a design query's Fields AND Design render the SAME component
          // (one instance across both tabs: the draft and the loaded model
          // survive a switch), keyed by the chart.
          if ((id === CHART_PANE_TAB_FIELDS || id === CHART_PANE_TAB_DESIGN) && live && isDesignQueryDataSource(live.spec.data)) {
            return React.createElement(ChartDesignQueryBuild, {
              key: `design-query-${chartId}`,
              ctx,
              chartId,
              getChart: deps.getChart,
            });
          }
          return React.createElement(ChartBuildPending, {
            ctx,
            sourceText: live ? chartSourceText(live.spec) : "",
            onEditData: () => deps.openDataEditor(chartId),
          });
        },
      }));
    },

    defaultTab(region, reason: ObjectPaneOpenReason): string {
      // A press or a follow lands on the chart's data (Fields / Data); a
      // command without a tab of its own lands on Format -- the format doors
      // name Format anyway, and "Edit data" names its tab.
      if (reason === "command") return OBJECT_PANE_FORMAT_TAB;
      return chartEditDataTab(chartOf(region)?.spec);
    },

    headerOf(region): string {
      const chart = chartOf(region);
      return chart ? `Chart - ${chart.name}` : "Chart";
    },

    beforeShowFormat(): void {
      deps.publishSelection();
    },
  };
}

/**
 * THE format door for charts: publish the ladder's rung, then open the object
 * pane on Format for `chartId` (or the primary selected object). Returns
 * whether the pane opened.
 */
export function openChartFormatPane(publishSelection: () => void, chartId?: string | null): boolean {
  publishSelection();
  const region = chartId ? chartRegionOf(chartId) : null;
  return openObjectPane({ ...(region ? { region } : {}), tab: OBJECT_PANE_FORMAT_TAB, reason: "command" });
}
