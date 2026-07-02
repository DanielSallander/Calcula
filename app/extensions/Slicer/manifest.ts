//! FILENAME: app/extensions/Slicer/manifest.ts
// PURPOSE: Slicer extension manifest and registration definitions.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "@api";
import type { PanelDefinition } from "@api/uiTypes";
import React from "react";
import { InsertSlicerDialog } from "./components/InsertSlicerDialog";
import { SlicerSettingsDialog } from "./components/SlicerSettingsDialog";
import { SlicerComputedPropertiesDialog } from "./components/SlicerComputedPropertiesDialog";
import { SlicerConnectionsDialog } from "./components/SlicerConnectionsDialog";
import {
  SlicerPropertiesSection,
  SlicerButtonsSection,
  SlicerStylesSection,
  SlicerSizeSection,
  SlicerActionsSection,
} from "./components/SlicerOptionsSections";

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
// Contextual Slicer Panel (ribbon-placed)
// ============================================================================

const SLICER_TAB_COLOR = "#548235"; // Green accent (distinct from table blue)

export const SLICER_OPTIONS_TAB_ID = "slicer-options";

/**
 * Location-agnostic panel definition for the contextual "Slicer" tab.
 * Registered/unregistered by handlers/selectionHandler.ts as slicers are
 * selected/deselected. One section per former RibbonGroup; collapsePriority
 * mirrors the old collapseOrder semantics (lower demotes to a launcher first
 * under width pressure). All sections stay on the default "auto" ribbon
 * presentation so the shell measures them for the width-collapse math.
 */
export const SlicerOptionsPanelDefinition: PanelDefinition = {
  id: SLICER_OPTIONS_TAB_ID,
  title: "Slicer",
  icon: null,
  sections: [
    {
      id: "slicer-options.properties",
      label: "Properties",
      component: SlicerPropertiesSection,
      collapsePriority: 4,
    },
    {
      id: "slicer-options.buttons",
      label: "Buttons",
      component: SlicerButtonsSection,
      collapsePriority: 3,
    },
    {
      // The style gallery flex-squeezed before any group collapsed in the old
      // tab; priority 0 keeps it first in line for launcher demotion.
      id: "slicer-options.styles",
      label: "Slicer Styles",
      component: SlicerStylesSection,
      collapsePriority: 0,
    },
    {
      id: "slicer-options.size",
      label: "Size",
      component: SlicerSizeSection,
      collapsePriority: 2,
    },
    {
      id: "slicer-options.actions",
      label: "Actions",
      component: SlicerActionsSection,
      collapsePriority: 1,
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: 499,
  ribbonColor: SLICER_TAB_COLOR,
  priority: 501, // 1000 - ribbonOrder
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
