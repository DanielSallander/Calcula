//! FILENAME: app/extensions/JsonView/index.ts
// PURPOSE: JSON View extension module entry point.
// CONTEXT: Registers a TaskPane view and Dialog for inspecting/editing workbook
//          objects as JSON. Phase A of the JSON View feature.

import type { ExtensionModule } from "@api/contract";
import React from "react";
import {
  registerTaskPane,
  unregisterTaskPane,
  registerDialog,
  unregisterDialog,
  registerMenuItem,
  registerActivityView,
  unregisterActivityView,
} from "@api/ui";
import { CommandRegistry } from "@api/commands";
import { JsonEditorPane } from "./components/JsonEditorPane";
import { JsonEditorDialog } from "./components/JsonEditorDialog";
import { WorkbookExplorerPanel } from "./components/WorkbookExplorerPanel";

// ============================================================================
// Constants
// ============================================================================

const TASK_PANE_ID = "json-editor";
const DIALOG_ID = "json-editor-dialog";
const ACTIVITY_VIEW_ID = "jsonView.workbookExplorer";

// SVG icon for curly braces — represents JSON/data structure
const JsonIcon = React.createElement(
  "svg",
  { width: 24, height: 24, viewBox: "0 0 24 24", fill: "currentColor" },
  React.createElement("path", {
    d: "M4 18V14.3C4 13.4716 3.32843 12.8 2.5 12.8V11.2C3.32843 11.2 4 10.5284 4 9.7V6C4 4.34315 5.34315 3 7 3H8V5H7C6.44772 5 6 5.44772 6 6V10.1C6 10.9284 5.42843 11.6 4.6 11.8V12.2C5.42843 12.4 6 13.0716 6 13.9V18C6 18.5523 6.44772 19 7 19H8V21H7C5.34315 21 4 19.6569 4 18ZM20 14.3V18C20 19.6569 18.6569 21 17 21H16V19H17C17.5523 19 18 18.5523 18 18V13.9C18 13.0716 18.5716 12.4 19.4 12.2V11.8C18.5716 11.6 18 10.9284 18 10.1V6C18 5.44772 17.5523 5 17 5H16V3H17C18.6569 3 20 4.34315 20 6V9.7C20 10.5284 20.6716 11.2 21.5 11.2V12.8C20.6716 12.8 20 13.4716 20 14.3Z",
  }),
);

// ============================================================================
// Lifecycle
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

function activate(): void {
  if (isActivated) return;

  // Register TaskPane view (available for any context)
  registerTaskPane({
    id: TASK_PANE_ID,
    title: "JSON View",
    component: JsonEditorPane,
    contextKeys: ["always"],
    priority: 5,
  });
  cleanupFns.push(() => unregisterTaskPane(TASK_PANE_ID));

  // Register Dialog for larger editing
  registerDialog({
    id: DIALOG_ID,
    component: JsonEditorDialog,
  });
  cleanupFns.push(() => unregisterDialog(DIALOG_ID));

  // Register ActivityBar view (Workbook Explorer tree — Phase B)
  registerActivityView({
    id: ACTIVITY_VIEW_ID,
    title: "Workbook Explorer",
    icon: JsonIcon,
    component: WorkbookExplorerPanel,
    priority: 5,
  });
  cleanupFns.push(() => unregisterActivityView(ACTIVITY_VIEW_ID));

  // Register menu item under View menu
  registerMenuItem("view", {
    id: "jsonView.openPane",
    label: "JSON View",
    action: () => {
      CommandRegistry.execute("taskPane.open", { viewId: TASK_PANE_ID });
    },
    priority: 80,
  });

  isActivated = true;
  console.log("[JsonView] Activated.");
}

function deactivate(): void {
  if (!isActivated) return;
  cleanupFns.forEach((fn) => fn());
  cleanupFns.length = 0;
  isActivated = false;
  console.log("[JsonView] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.json-view",
    name: "JSON View",
    version: "1.0.0",
    description:
      "Inspect and edit any workbook object (charts, tables, slicers, theme, etc.) as JSON.",
  },
  activate,
  deactivate,
};

export default extension;
