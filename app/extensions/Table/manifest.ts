//! FILENAME: app/extensions/Table/manifest.ts
// PURPOSE: Table extension manifest and registration definitions.
// CONTEXT: Defines what the Table extension contributes to the application.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "@api";
import type { PanelDefinition } from "@api/uiTypes";
import React from "react";
import { CreateTableDialog } from "./components/CreateTableDialog";
import { RemoveDuplicatesDialog } from "./components/RemoveDuplicatesDialog";
import { TABLE_DESIGN_SECTIONS } from "./components/TableDesignTab";

// ============================================================================
// Extension Manifest
// ============================================================================

export const TABLE_EXTENSION_ID = "calcula.table";

export const TableManifest: AddInManifest = {
  id: TABLE_EXTENSION_ID,
  name: "Tables",
  version: "1.0.0",
  description: "Table functionality for Calcula",
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

// ============================================================================
// Contextual Table Design Panel
// ============================================================================

// Accent color for table contextual tab (Excel-style blue)
const TABLE_TAB_COLOR = "#4472c4";

export const TABLE_DESIGN_TAB_ID = "table-design";

/**
 * Location-agnostic panel definition for the contextual "Table Design" tab.
 * Registered/unregistered by the selection handler while the selection is
 * inside a table. One section per former ribbon group; the shell renders
 * them as ribbon groups (label below content) or sidebar blocks.
 */
export const TableDesignPanelDefinition: PanelDefinition = {
  id: TABLE_DESIGN_TAB_ID,
  title: "Table Design",
  icon: null,
  sections: TABLE_DESIGN_SECTIONS,
  defaultPlacement: "ribbon",
  ribbonOrder: 498,
  ribbonColor: TABLE_TAB_COLOR,
  priority: 502, // 1000 - ribbonOrder
};

// ============================================================================
// Dialog Registration
// ============================================================================

export const TABLE_DIALOG_ID = "table:createDialog";

export const TableDialogDefinition: DialogDefinition = {
  id: TABLE_DIALOG_ID,
  component: CreateTableDialog as React.ComponentType<DialogProps>,
  priority: 100,
};

export const REMOVE_DUPLICATES_DIALOG_ID = "table:removeDuplicatesDialog";

export const RemoveDuplicatesDialogDefinition: DialogDefinition = {
  id: REMOVE_DUPLICATES_DIALOG_ID,
  component: RemoveDuplicatesDialog as React.ComponentType<DialogProps>,
  priority: 100,
};
