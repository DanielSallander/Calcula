//! FILENAME: app/extensions/Insights/index.ts
// PURPOSE: Insights extension entry point — the pane, the provider, and the four
//          ways a person asks for facts.
// CONTEXT: Calcula's answer to "show insights", except every sentence is
//          computed by Rust and none is written by a model. This file wires the
//          surfaces; it contains no analysis of its own.
//
//          THE PROVIDER REGISTRATION IS THE LOAD-BEARING LINE. Registering
//          `InsightsProvider` is what turns the chat's "analyse this" from an
//          impression into a deterministic answer: the chat asks
//          `@api/insightsService` and gets the same bundle the pane shows,
//          without ever importing this extension. It is registered in
//          `activate` and unregistered in `deactivate`, like every other seam.
//
//          The connection cache is refreshed on activation AND on every document
//          swap, because `InsightsProvider.hasModel()` is synchronous by
//          contract and answers from that cache. Without the document listener a
//          File > Open into a workbook with no model would keep offering the
//          Model source of the workbook that left.

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { gridExtensions, GridMenuGroups, type GridMenuContext } from "@api/extensions";
import { registerInsightsProvider } from "@api/insightsService";
import { AppEvents, onAppEvent } from "@api/events";
import { insightsBackend } from "./lib/backend";
import { createInsightsProvider } from "./lib/provider";
import { registerChartExplain } from "./lib/chartExplain";
import {
  analyzeSelection,
  refreshConnections,
  reset as resetInsightsStore,
} from "./lib/store";
import { InsightsPane } from "./components/InsightsPane";
import {
  INSIGHTS_ANALYZE_SELECTION_COMMAND,
  INSIGHTS_DATA_MENU_ITEM_ID,
  INSIGHTS_GRID_MENU_ITEM_ID,
  INSIGHTS_PANE_ID,
  INSIGHTS_PANE_TITLE,
  InsightsManifest,
} from "./manifest";

let isActivated = false;
const cleanupFns: (() => void)[] = [];

/** True when the selection covers more than one cell. */
function isMultiCellSelection(context: GridMenuContext): boolean {
  const sel = context.selection;
  if (!sel) return false;
  return sel.startRow !== sel.endRow || sel.startCol !== sel.endCol;
}

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[Insights] Already activated, skipping.");
    return;
  }

  console.log("[Insights] Activating...");

  // Bind the capability-scoped backend door BEFORE anything that could trigger
  // a backend call — the pane, the store and the provider all route through it.
  insightsBackend.set(context.invokeBackend);

  const openPane = (): void => {
    context.ui.taskPanes.open(INSIGHTS_PANE_ID);
    context.ui.taskPanes.showContainer();
  };

  // 1. The pane.
  context.ui.taskPanes.register({
    id: INSIGHTS_PANE_ID,
    title: INSIGHTS_PANE_TITLE,
    component: InsightsPane,
    contextKeys: ["always"],
    priority: 42,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(INSIGHTS_PANE_ID));

  // 2. The provider — what makes an external "analyse this" deterministic.
  cleanupFns.push(registerInsightsProvider(createInsightsProvider()));

  // 3. The command. Opens the pane and runs, so a keybinding or the command
  //    palette lands the reader on the answer rather than on an empty pane.
  context.commands.register(INSIGHTS_ANALYZE_SELECTION_COMMAND, () => {
    openPane();
    return analyzeSelection();
  });
  cleanupFns.push(() => context.commands.unregister(INSIGHTS_ANALYZE_SELECTION_COMMAND));

  // 4. Grid context menu — only for a real rectangle. On a single cell the item
  //    would be offering to guess at what the user meant.
  gridExtensions.registerContextMenuItem({
    id: INSIGHTS_GRID_MENU_ITEM_ID,
    label: "Analyse this range…",
    group: GridMenuGroups.DATA,
    order: 60,
    visible: isMultiCellSelection,
    onClick: () => {
      openPane();
      void analyzeSelection();
    },
  });
  cleanupFns.push(() => gridExtensions.unregisterContextMenuItem(INSIGHTS_GRID_MENU_ITEM_ID));

  // 5. Data menu. Insights is an analysis tool and belongs beside the others;
  //    the "data" menu is created by AutoFilter and appended to by everyone.
  context.ui.menus.registerItem("data", {
    id: INSIGHTS_DATA_MENU_ITEM_ID,
    label: "Insights",
    order: 75,
    action: () => {
      openPane();
    },
  });
  cleanupFns.push(() => context.ui.menus.unregisterItem("data", INSIGHTS_DATA_MENU_ITEM_ID));

  // 6. "Explain this chart" on the chart context menu.
  cleanupFns.push(registerChartExplain(openPane));

  // 7. The document can be replaced under us (File > New / File > Open, and the
  //    .calp working-copy open that announces the same way). The previous
  //    workbook's connections and its answer both belong to a document that has
  //    gone; keeping either would have the pane describe cells nobody is
  //    looking at.
  const onDocumentReplaced = (): void => {
    resetInsightsStore();
    void refreshConnections();
  };
  for (const evt of [AppEvents.AFTER_OPEN, AppEvents.AFTER_NEW] as const) {
    cleanupFns.push(onAppEvent(evt, onDocumentReplaced));
  }

  // 8. Seed the connection cache `hasModel()` answers from.
  void refreshConnections();

  isActivated = true;
  console.log("[Insights] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[Insights] Deactivating...");
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Insights] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  resetInsightsStore();
  isActivated = false;
  console.log("[Insights] Deactivated.");
}

const extension: ExtensionModule = {
  manifest: InsightsManifest,
  activate,
  deactivate,
};

export default extension;
