//! FILENAME: app/extensions/Insights/manifest.ts
// PURPOSE: Extension metadata and the ids every Insights surface shares.
// CONTEXT: Four entry points open the same pane — the command, the grid context
//          menu, the Data menu and the chart menu — so the ids live in one place
//          rather than being retyped at each registration. A retyped pane id is
//          a second pane that looks identical and never receives a result.

import type { ExtensionManifest } from "@api/contract";

/** Task pane id. Referenced by the command, both menus, and chart explain. */
export const INSIGHTS_PANE_ID = "insights";

/** The pane's tab title. */
export const INSIGHTS_PANE_TITLE = "Insights";

/** Command id — the one an external caller or a keybinding would name. */
export const INSIGHTS_ANALYZE_SELECTION_COMMAND = "insights.analyzeSelection";

/** Grid context-menu item id. */
export const INSIGHTS_GRID_MENU_ITEM_ID = "insights.analyzeRange";

/** Data-menu item id. */
export const INSIGHTS_DATA_MENU_ITEM_ID = "data:insights";

export const InsightsManifest: ExtensionManifest = {
  id: "calcula.insights",
  name: "Insights",
  version: "1.0.0",
  description:
    "Deterministic facts about a range, a semantic model or a chart. Every sentence is computed, never written by a model.",
};
