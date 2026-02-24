//! FILENAME: app/extensions/BuiltIn/StatusBarAggregation/index.ts
// PURPOSE: Status Bar Aggregation extension module entry point.
// CONTEXT: Registers a status bar widget that shows quick aggregation statistics
//          (Average, Count, Sum, etc.) for the current cell selection.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule } from "../../../src/api/contract";
import { registerStatusBarItem, unregisterStatusBarItem } from "../../../src/api/ui";
import { StatusBarAggregationWidget } from "./StatusBarAggregationWidget";

const STATUS_BAR_ITEM_ID = "calcula.statusbar.aggregation";

let isActivated = false;

function activate(): void {
  if (isActivated) {
    console.warn("[StatusBarAggregation] Already activated, skipping.");
    return;
  }

  console.log("[StatusBarAggregation] Activating...");

  registerStatusBarItem({
    id: STATUS_BAR_ITEM_ID,
    component: StatusBarAggregationWidget,
    alignment: "right",
    priority: 100,
  });

  isActivated = true;
  console.log("[StatusBarAggregation] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[StatusBarAggregation] Deactivating...");
  unregisterStatusBarItem(STATUS_BAR_ITEM_ID);
  isActivated = false;
  console.log("[StatusBarAggregation] Deactivated.");
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.status-bar-aggregation",
    name: "Status Bar Aggregation",
    version: "1.0.0",
    description: "Shows quick aggregation statistics (Average, Count, Sum, etc.) for the current selection in the status bar.",
  },
  activate,
  deactivate,
};

export default extension;
