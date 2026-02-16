//! FILENAME: app/extensions/Table/manifest.ts
// PURPOSE: Table extension manifest and registration definitions.
// CONTEXT: Defines what the Table extension contributes to the application.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "../../src/api";
import React from "react";
import { CreateTableDialog } from "./components/CreateTableDialog";

// ============================================================================
// Extension Manifest
// ============================================================================

export const TABLE_EXTENSION_ID = "calcula.table";

export const TableManifest: AddInManifest = {
  id: TABLE_EXTENSION_ID,
  name: "Tables",
  version: "1.0.0",
  description: "Table functionality for Calcula",
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
