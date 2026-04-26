//! FILENAME: app/extensions/Slicer/manifest.ts
// PURPOSE: Slicer extension manifest and registration definitions.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "@api";
import React from "react";
import { InsertSlicerDialog } from "./components/InsertSlicerDialog";
import { SlicerSettingsDialog } from "./components/SlicerSettingsDialog";
import { SlicerComputedPropertiesDialog } from "./components/SlicerComputedPropertiesDialog";
import { SlicerConnectionsDialog } from "./components/SlicerConnectionsDialog";
import { SlicerOptionsTab } from "./components/SlicerOptionsTab";

// ============================================================================
// Extension Manifest
// ============================================================================

export const SLICER_EXTENSION_ID = "calcula.slicer";

export const SlicerManifest: AddInManifest = {
  id: SLICER_EXTENSION_ID,
  name: "Slicers",
  version: "1.0.0",
  description: "Visual filter controls for Tables and PivotTables",
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

// ============================================================================
// Contextual Ribbon Tab
// ============================================================================

const SLICER_TAB_COLOR = "#548235"; // Green accent (distinct from table blue)

export const SLICER_OPTIONS_TAB_ID = "slicer-options";
export const SlicerOptionsTabDefinition = {
  id: SLICER_OPTIONS_TAB_ID,
  label: "Slicer",
  order: 499,
  component: SlicerOptionsTab,
  color: SLICER_TAB_COLOR,
};

// ============================================================================
// Dialog Registration
// ============================================================================

export const INSERT_SLICER_DIALOG_ID = "slicer:insertDialog";
export const SLICER_SETTINGS_DIALOG_ID = "slicer:settingsDialog";
export const SLICER_COMPUTED_PROPS_DIALOG_ID = "slicer:computedPropsDialog";
export const SLICER_CONNECTIONS_DIALOG_ID = "slicer:connectionsDialog";

export const InsertSlicerDialogDefinition: DialogDefinition = {
  id: INSERT_SLICER_DIALOG_ID,
  component: InsertSlicerDialog as React.ComponentType<DialogProps>,
  priority: 100,
};

export const SlicerSettingsDialogDefinition: DialogDefinition = {
  id: SLICER_SETTINGS_DIALOG_ID,
  component: SlicerSettingsDialog as React.ComponentType<DialogProps>,
  priority: 100,
};

export const SlicerComputedPropsDialogDefinition: DialogDefinition = {
  id: SLICER_COMPUTED_PROPS_DIALOG_ID,
  component: SlicerComputedPropertiesDialog as React.ComponentType<DialogProps>,
  priority: 100,
};

export const SlicerConnectionsDialogDefinition: DialogDefinition = {
  id: SLICER_CONNECTIONS_DIALOG_ID,
  component: SlicerConnectionsDialog as React.ComponentType<DialogProps>,
  priority: 100,
};
