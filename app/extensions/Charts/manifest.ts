//! FILENAME: app/extensions/Charts/manifest.ts
// PURPOSE: Chart extension manifest and registration definitions.
// CONTEXT: Defines what the Chart extension contributes to the application.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "@api";
import type { PanelDefinition } from "@api/uiTypes";
import React from "react";
import { CreateChartDialog } from "./components/CreateChartDialog";
import { buildChartDesignSections } from "./components/ChartDesignSections";

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

/** Accent color for chart contextual tab (Excel-style blue-ish) */
const CHART_TAB_COLOR = "#4472c4";

/** Ribbon-tab sort order for the contextual Design panel. */
const CHART_TAB_ORDER = 501;

export const CHART_DESIGN_TAB_ID = "chart-design";

/**
 * Build the Chart Design panel definition for the currently selected chart.
 * A builder (not a constant) because the section list depends on the chart
 * type — the Stacking/Axes/Trendline groups only apply to some marks, exactly
 * as the former monolithic tab rendered them conditionally.
 */
export function buildChartDesignPanelDefinition(): PanelDefinition {
  return {
    id: CHART_DESIGN_TAB_ID,
    title: "Chart Design",
    icon: null,
    sections: buildChartDesignSections(),
    defaultPlacement: "ribbon",
    ribbonOrder: CHART_TAB_ORDER,
    ribbonColor: CHART_TAB_COLOR,
    priority: 1000 - CHART_TAB_ORDER,
  };
}

// ============================================================================
// Dialog Registration
// ============================================================================

export const CHART_DIALOG_ID = "chart:createDialog";

export const ChartDialogDefinition: DialogDefinition = {
  id: CHART_DIALOG_ID,
  component: CreateChartDialog as React.ComponentType<DialogProps>,
  priority: 100,
};
