//! FILENAME: app/extensions/Table/manifest.ts
// PURPOSE: Table extension manifest and registration definitions.
// CONTEXT: Defines what the Table extension contributes to the application.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "@api";
import React from "react";
import { CreateTableDialog } from "./components/CreateTableDialog";
import { RemoveDuplicatesDialog } from "./components/RemoveDuplicatesDialog";
import { TableDesignTab } from "./components/TableDesignTab";

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
// Contextual Ribbon Tab
// ============================================================================

// Accent color for table contextual tab (Excel-style blue)
const TABLE_TAB_COLOR = "#4472c4";

export const TABLE_DESIGN_TAB_ID = "table-design";
export const TableDesignTabDefinition = {
  id: TABLE_DESIGN_TAB_ID,
  label: "Table Design",
  order: 498,
  component: TableDesignTab,
  color: TABLE_TAB_COLOR,
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
