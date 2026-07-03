//! FILENAME: app/extensions/ControlsPane/manifest.ts
// PURPOSE: Extension manifest and definitions for the Controls pane.

import React from "react";
import type { AddInManifest, DialogDefinition, DialogProps } from "@api";
import type { PanelDefinition } from "@api/ui";
import { FilterPaneSection } from "./components/FilterPaneSection";
import { AddFilterDialog } from "./components/AddFilterDialog";

export const CONTROLS_PANE_TAB_ID = "controls-pane";
export const ADD_FILTER_DIALOG_ID = "controls-pane-add-filter";

export const ControlsPaneManifest: AddInManifest = {
  id: "calcula.controls-pane",
  name: "Controls Pane",
  version: "1.0.0",
  description: "Pane hosting ribbon filters and interactive controls (buttons, sliders, dropdowns, custom)",
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

/**
 * Location-agnostic "Controls" panel (ribbon-placed by default; movable to the
 * sidebar). Single section: a mixed strip of filter cards and control cards.
 */
export const ControlsPanePanelDefinition: PanelDefinition = {
  id: CONTROLS_PANE_TAB_ID,
  title: "Controls",
  icon: null,
  sections: [
    {
      id: "controls-pane.items",
      label: "Controls",
      component: FilterPaneSection,
      // The item cards are a fixed-height (56px) band-designed strip;
      // trust it inline and skip the shell's height probe.
      ribbonPresentation: "inline",
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: 45,
  priority: 955, // 1000 - ribbonOrder
};

export const AddFilterDialogDefinition: DialogDefinition = {
  id: ADD_FILTER_DIALOG_ID,
  component: AddFilterDialog as React.ComponentType<DialogProps>,
  priority: 100,
};
