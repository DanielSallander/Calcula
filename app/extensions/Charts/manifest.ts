//! FILENAME: app/extensions/Charts/manifest.ts
// PURPOSE: Chart extension manifest and registration definitions.
// CONTEXT: Defines what the Chart extension contributes to the application.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "../../src/api";
import React from "react";
import { CreateChartDialog } from "./components/CreateChartDialog";
import { ChartDesignTab } from "./components/ChartDesignTab";

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
// Contextual Ribbon Tab (registered dynamically when a chart is selected)
// ============================================================================

/** Accent color for chart contextual tab (Excel-style blue-ish) */
const CHART_TAB_COLOR = "#4472c4";

export const CHART_DESIGN_TAB_ID = "chart-design";
export const ChartDesignTabDefinition = {
  id: CHART_DESIGN_TAB_ID,
  label: "Chart Design",
  order: 501,
  component: ChartDesignTab,
  color: CHART_TAB_COLOR,
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
