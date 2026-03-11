//! FILENAME: app/extensions/BusinessIntelligence/manifest.ts
// PURPOSE: BI extension manifest, task pane, and ribbon definitions.

import type {
  AddInManifest,
  TaskPaneViewDefinition,
} from "../../src/api";
import { BiPane } from "./components/BiPane";

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
// Task Pane
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
