//! FILENAME: app/extensions/ControlsPane/manifest.ts
// PURPOSE: Extension manifest and definitions for the Controls pane.

import React from "react";
import { RibbonIcon } from "@api";
import type { AddInManifest, DialogDefinition, DialogProps } from "@api";
import type { PanelDefinition } from "@api/ui";
import { ControlsPaneSection } from "./components/ControlsPaneSection";
import { AddFilterDialog } from "./components/AddFilterDialog";
import { AddControlDialog } from "./components/AddControlDialog";

export const CONTROLS_PANE_TAB_ID = "controls-pane";
export const ADD_FILTER_DIALOG_ID = "controls-pane-add-filter";
export const ADD_CONTROL_DIALOG_ID = "controls-pane-add-control";

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
 * Not a contextual tab, so it carries no ribbonColor (its presence is what
 * marks a tab contextual).
 */
export const ControlsPanePanelDefinition: PanelDefinition = {
  id: CONTROLS_PANE_TAB_ID,
  title: "Controls",
  // Activity-bar glyph, and the launcher of the fully demoted panel.
  icon: React.createElement(RibbonIcon.Controls, { size: 20 }),
  sections: [
    {
      id: "controls-pane.items",
      label: "Controls",
      icon: React.createElement(RibbonIcon.Controls, { size: 24 }),
      component: ControlsPaneSection,
      // The item cards are a fixed-height (56px) band-designed strip beside
      // a 61px Add hero — exactly the cluster's content box; trust it inline
      // and skip the shell's height probe.
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

export const AddControlDialogDefinition: DialogDefinition = {
  id: ADD_CONTROL_DIALOG_ID,
  component: AddControlDialog as React.ComponentType<DialogProps>,
  priority: 100,
};
