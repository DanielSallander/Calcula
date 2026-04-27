//! FILENAME: app/extensions/FilterPane/manifest.ts
// PURPOSE: Extension manifest and definitions for the Filter Pane.

import React from "react";
import type { AddInManifest, DialogDefinition, DialogProps } from "@api";
import { FilterPaneTab } from "./components/FilterPaneTab";
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

export const FilterPaneTabDefinition = {
  id: FILTER_PANE_TAB_ID,
  label: "Filters",
  order: 45,
  component: FilterPaneTab,
};

export const AddFilterDialogDefinition: DialogDefinition = {
  id: ADD_FILTER_DIALOG_ID,
  component: AddFilterDialog as React.ComponentType<DialogProps>,
  priority: 100,
};
