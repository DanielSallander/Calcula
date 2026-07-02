//! FILENAME: app/extensions/FilterPane/manifest.ts
// PURPOSE: Extension manifest and definitions for the Filter Pane.

import React from "react";
import type { AddInManifest, DialogDefinition, DialogProps } from "@api";
import type { PanelDefinition } from "@api/ui";
import { FilterPaneSection } from "./components/FilterPaneSection";
import { AddFilterDialog } from "./components/AddFilterDialog";

export const FILTER_PANE_TAB_ID = "filter-pane";
export const ADD_FILTER_DIALOG_ID = "filter-pane-add-filter";

export const FilterPaneManifest: AddInManifest = {
  id: "calcula.filter-pane",
  name: "Filter Pane",
  version: "1.0.0",
  description: "Power BI-style filter pane in ribbon",
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

/**
 * Location-agnostic "Filters" panel (ribbon-placed by default; movable to the
 * sidebar). Single section: the former tab had no group boundaries — just the
 * add-filter button plus the dynamic filter-card strip.
 */
export const FilterPanePanelDefinition: PanelDefinition = {
  id: FILTER_PANE_TAB_ID,
  title: "Filters",
  icon: null,
  sections: [
    {
      id: "filter-pane.filters",
      label: "Filters",
      component: FilterPaneSection,
      // The filter cards are a fixed-height (56px) band-designed strip;
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
