//! FILENAME: app/extensions/Table/manifest.ts
// PURPOSE: Table extension manifest and registration definitions.
// CONTEXT: Defines what the Table extension contributes to the application.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "@api";
import { RibbonIcon } from "@api";
import type { PanelDefinition, TaskPaneViewDefinition } from "@api/uiTypes";
import React from "react";
import { CreateTableDialog } from "./components/CreateTableDialog";
import { RemoveDuplicatesDialog } from "./components/RemoveDuplicatesDialog";
import { TABLE_DESIGN_SECTIONS } from "./components/TableDesignTab";
import { TableJsonPane, TABLE_JSON_PANE_ID } from "./components/TableJsonPane";

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

// Accent for the contextual tab: the skin's `--tab-accent-table` token, with the
// former Excel-style blue as the fallback half (a skin can restyle it; a window
// that never loaded a skin still shows an accent).
const TABLE_TAB_COLOR = "var(--tab-accent-table, #4472c4)";

export const TABLE_DESIGN_TAB_ID = "table-design";

/**
 * Location-agnostic panel definition for the contextual "Table Design" tab.
 * Registered/unregistered by the selection handler while the selection is
 * inside a table. One section per ribbon cluster; the shell renders them as
 * ribbon clusters (caption below content) or sidebar blocks.
 */
export const TableDesignPanelDefinition: PanelDefinition = {
  id: TABLE_DESIGN_TAB_ID,
  title: "Table Design",
  icon: React.createElement(RibbonIcon.Table, { size: 20 }),
  sections: TABLE_DESIGN_SECTIONS,
  defaultPlacement: "ribbon",
  ribbonOrder: 498,
  ribbonColor: TABLE_TAB_COLOR,
  priority: 502, // 1000 - ribbonOrder
};

// ============================================================================
// Task Pane — the table's definition as JSON
// ============================================================================

export { TABLE_JSON_PANE_ID };

/**
 * "Table JSON": the selected table's definition in a Monaco editor. Opened and
 * closed by the Table Design panel's JSON hero; it follows the selection from
 * table to table (see components/TableJsonPane.tsx). Declares the "table"
 * context key, which handlers/selectionHandler.ts adds while the cursor is in
 * a table.
 */
export const TableJsonPaneDefinition: TaskPaneViewDefinition = {
  id: TABLE_JSON_PANE_ID,
  title: "Table JSON",
  icon: React.createElement(RibbonIcon.Code, { size: 16 }),
  component: TableJsonPane,
  contextKeys: ["table"],
  priority: 50,
  closable: true,
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
