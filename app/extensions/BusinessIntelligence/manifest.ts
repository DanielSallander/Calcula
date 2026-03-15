//! FILENAME: app/extensions/BusinessIntelligence/manifest.ts
// PURPOSE: BI extension manifest, task pane, and ribbon definitions.

import type {
  AddInManifest,
  TaskPaneViewDefinition,
} from "../../src/api";
import { BiPane } from "./components/BiPane";
import { ConnectionsPane } from "./components/ConnectionsPane";

// ============================================================================
// Extension Manifest
// ============================================================================

export const BI_EXTENSION_ID = "calcula.bi";

export const BiManifest: AddInManifest = {
  id: BI_EXTENSION_ID,
  name: "Business Intelligence",
  version: "1.0.0",
  description: "Query external databases using analytical data models",
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

// ============================================================================
// Task Panes
// ============================================================================

export const BI_PANE_ID = "bi-pane";

export const BiPaneDefinition: TaskPaneViewDefinition = {
  id: BI_PANE_ID,
  title: "Business Intelligence",
  icon: "[BI]",
  component: BiPane,
  contextKeys: ["bi"],
  priority: 90,
  closable: true,
};

export const CONNECTIONS_PANE_ID = "connections-pane";

export const ConnectionsPaneDefinition: TaskPaneViewDefinition = {
  id: CONNECTIONS_PANE_ID,
  title: "Workbook Connections",
  icon: "[Conn]",
  component: ConnectionsPane,
  contextKeys: ["connections"],
  priority: 85,
  closable: true,
};
