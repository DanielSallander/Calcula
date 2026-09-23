//! FILENAME: app/extensions/Charts/manifest.ts
// PURPOSE: Chart extension manifest and registration definitions.
// CONTEXT: Defines what the Chart extension contributes to the application.
//
//          Icons come from `@api/ribbonIcons` (not the `@api` barrel) so the
//          selection-handler tests, which mock `@api` with only the panel
//          calls, can still build the panel definition.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "@api";
import type { PanelDefinition, TaskPaneViewDefinition } from "@api/uiTypes";
import { RibbonIcon } from "@api/ribbonIcons";
import React from "react";
import { CreateChartDialog } from "./components/CreateChartDialog";
import { buildChartDesignSections } from "./components/ChartDesignSections";
import { CHART_FORMAT_PANE_ID, ChartFormatPane } from "./components/ChartFormatPane";
import { CHART_JSON_PANE_ID, ChartJsonPane } from "./components/ChartJsonPane";

// ============================================================================
// Extension Manifest
// ============================================================================

export const CHART_EXTENSION_ID = "calcula.charts";

export const ChartManifest: AddInManifest = {
  id: CHART_EXTENSION_ID,
  name: "Charts",
  version: "1.0.0",
  description: "Chart functionality for Calcula",
};

// ============================================================================
// Contextual Design Panel (registered dynamically when a chart is selected)
// ============================================================================

/**
 * Accent for the chart contextual tab: the skin's chart-tab token, with the
 * former Excel-style blue as the fallback for a skin that predates it.
 */
const CHART_TAB_COLOR = "var(--tab-accent-chart, #4472c4)";

/** Ribbon-tab sort order for the contextual Design panel. */
const CHART_TAB_ORDER = 501;

export const CHART_DESIGN_TAB_ID = "chart-design";

/**
 * Build the Chart Design panel definition for the currently selected chart.
 * A builder (not a constant) because the section list depends on the chart
 * type — the Layout cluster only applies to axis charts (see
 * buildChartDesignSections for why it is the only conditional one).
 */
export function buildChartDesignPanelDefinition(): PanelDefinition {
  return {
    id: CHART_DESIGN_TAB_ID,
    title: "Chart Design",
    icon: React.createElement(RibbonIcon.ChartColumn, { size: 20 }),
    sections: buildChartDesignSections(),
    defaultPlacement: "ribbon",
    ribbonOrder: CHART_TAB_ORDER,
    ribbonColor: CHART_TAB_COLOR,
    priority: 1000 - CHART_TAB_ORDER,
  };
}

// ============================================================================
// Task Pane Registration — the retargeting Format pane
// ============================================================================

/**
 * The Format task pane, Excel's "Format <element>".
 *
 * `contextKeys: ["chart"]` finishes wiring that was half-built:
 * `handlers/selectionHandler.ts` has been calling `addTaskPaneContextKey("chart")`
 * since the selection ladder landed, and until now NO pane in the repository
 * declared that key — so selecting a chart added a context nothing listened to.
 *
 * AUTHORITY. This pane formats THE CURRENT SELECTION; the contextual Design
 * panel above ({@link buildChartDesignPanelDefinition}) configures THE WHOLE
 * CHART. The full statement of the split is in the pane's own header.
 */
export { CHART_FORMAT_PANE_ID } from "./components/ChartFormatPane";

export const ChartFormatPaneDefinition: TaskPaneViewDefinition = {
  id: CHART_FORMAT_PANE_ID,
  title: "Format Chart",
  icon: React.createElement(RibbonIcon.FormatPoint, { size: 16 }),
  component: ChartFormatPane,
  contextKeys: ["chart"],
  priority: 100,
  closable: true,
};

// ============================================================================
// Task Pane Registration — the Chart JSON pane
// ============================================================================

/**
 * The chart's stored entry as editable JSON. Opened and closed by the Chart
 * Design band's JSON hero (it replaced a fixed-position overlay); it follows
 * the published chart selection, like the Format pane.
 */
export { CHART_JSON_PANE_ID } from "./components/ChartJsonPane";

export const ChartJsonPaneDefinition: TaskPaneViewDefinition = {
  id: CHART_JSON_PANE_ID,
  title: "Chart JSON",
  icon: React.createElement(RibbonIcon.Code, { size: 16 }),
  component: ChartJsonPane,
  contextKeys: ["chart"],
  priority: 90,
  closable: true,
};

// ============================================================================
// Dialog Registration
// ============================================================================

export const CHART_DIALOG_ID = "chart:createDialog";

export const ChartDialogDefinition: DialogDefinition = {
  id: CHART_DIALOG_ID,
  component: CreateChartDialog as React.ComponentType<DialogProps>,
  priority: 100,
};
