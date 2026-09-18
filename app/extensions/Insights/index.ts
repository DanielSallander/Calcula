//! FILENAME: app/extensions/Insights/index.ts
// PURPOSE: Insights extension entry point — the pane, the provider, and the four
//          ways a person asks for facts.
// CONTEXT: Calcula's answer to "show insights", except every sentence is
//          computed by Rust and none is written by a model. This file wires the
//          surfaces; it contains no analysis of its own.
//
//          THE PROVIDER REGISTRATION IS THE LOAD-BEARING LINE. Registering
//          `InsightsProvider` is what turns the chat's "what is going on here"
//          from an impression into a deterministic answer: the AI chat's
//          pre-route (AIChat/lib/tierZero.ts) asks `@api/insightsService`
//          before the model sees the message and gets the same bundle the pane
//          shows, without ever importing this extension. It is registered in
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
import { analyzeCurrentTarget, registerChartExplain } from "./lib/chartExplain";
import { registerOverlayMenu } from "./lib/overlayMenu";
import { followChartData, loadComments, resetOverlays, showOverlay, hideOverlay, isOverlayOn } from "./lib/overlay";
import {
  followSheetData,
  hideSheetOverlay,
  isSheetOverlayOn,
  pivotRect,
  registerCellCueDecoration,
  resetSheetOverlays,
  showSheetOverlay,
  type SheetOverlayOwner,
} from "./lib/sheetOverlay";
import { getSelectedChartId } from "@api/chartData";
import { getGridRegions } from "@api/gridOverlays";
import { showToast } from "@api/notifications";
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
  INSIGHTS_GRID_OVERLAY_MENU_ITEM_ID,
  INSIGHTS_PANE_ID,
  INSIGHTS_PANE_TITLE,
  INSIGHTS_TOGGLE_OVERLAY_COMMAND,
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

/**
 * True when the selection touches a pivot table's output.
 *
 * A pivot's cells are not a range of numbers — a grand total sits in the same
 * column as the rows it sums, so the contribution fact reads it as a peer and
 * says "Grand Total is 50% of all Revenue". The backend refuses such a range
 * outright (`PIVOT_RANGE_REFUSAL`, the guard every caller shares); this is the
 * matching courtesy in the menu, so the reader is not offered an action that
 * can only be refused.
 */
function selectionTouchesAPivot(context: GridMenuContext): boolean {
  const sel = context.selection;
  if (!sel) return false;
  const sr = Math.min(sel.startRow, sel.endRow);
  const er = Math.max(sel.startRow, sel.endRow);
  const sc = Math.min(sel.startCol, sel.endCol);
  const ec = Math.max(sel.startCol, sel.endCol);
  return getGridRegions().some((r) => {
    if (r.type !== "pivot") return false;
    const g = r as unknown as { startRow: number; startCol: number; endRow: number; endCol: number };
    return g.startRow <= er && sr <= g.endRow && g.startCol <= ec && sc <= g.endCol;
  });
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
  // A selected chart is the subject, ahead of the grid selection: the same rule
  // the pane's own button follows, so the palette and the button never disagree
  // about what "analyse" means right now.
  context.commands.register(INSIGHTS_ANALYZE_SELECTION_COMMAND, () => {
    openPane();
    return analyzeCurrentTarget(openPane);
  });
  cleanupFns.push(() => context.commands.unregister(INSIGHTS_ANALYZE_SELECTION_COMMAND));

  // 4. Grid context menu — only for a real rectangle. On a single cell the item
  //    would be offering to guess at what the user meant.
  gridExtensions.registerContextMenuItem({
    id: INSIGHTS_GRID_MENU_ITEM_ID,
    label: "Analyse this range…",
    group: GridMenuGroups.DATA,
    order: 60,
    visible: (context: GridMenuContext) => isMultiCellSelection(context) && !selectionTouchesAPivot(context),
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

  // 6b. The overlay: "Show points of interest" and the cue-scoped items on the
  //     chart context menu; a command for the selected chart (palette,
  //     keybinding, script); the data-changed subscription that keeps every
  //     overlay object true; the persisted comments.
  cleanupFns.push(registerOverlayMenu());
  context.commands.register(INSIGHTS_TOGGLE_OVERLAY_COMMAND, async () => {
    const chartId = getSelectedChartId();
    if (!chartId) return { outcome: "refused", chartId: null, reason: "Select a chart first." };
    if (isOverlayOn(chartId)) {
      hideOverlay(chartId);
      return { outcome: "hidden", chartId };
    }
    return showOverlay(chartId);
  });
  cleanupFns.push(() => context.commands.unregister(INSIGHTS_TOGGLE_OVERLAY_COMMAND));
  cleanupFns.push(followChartData());
  void loadComments();
  const onInsightsRefresh = (): void => void loadComments();
  window.addEventListener("insights:refresh", onInsightsRefresh);
  cleanupFns.push(() => window.removeEventListener("insights:refresh", onInsightsRefresh));

  // 6c. The overlay on cells: a range's or a pivot's points of interest, drawn
  //     by an over-selection cell decoration (which the core replays after the
  //     pivot overlay, so it reaches a pivot's cells too). One grid menu item,
  //     scoped to a real rectangle or a click inside a pivot; it toggles.
  cleanupFns.push(registerCellCueDecoration());
  cleanupFns.push(followSheetData());
  const sheetOwnerFor = (context: GridMenuContext): SheetOverlayOwner | null => {
    const cell = context.clickedCell;
    if (cell) {
      const region = getGridRegions().find((r) => {
        if (r.type !== "pivot" || r.data?.isEmpty) return false;
        const g = r as unknown as { startRow: number; startCol: number; endRow: number; endCol: number };
        return cell.row >= g.startRow && cell.row <= g.endRow && cell.col >= g.startCol && cell.col <= g.endCol;
      });
      const pivotId = region?.data?.pivotId;
      if (typeof pivotId === "string" && pivotRect(pivotId)) return { kind: "pivot", pivotId };
    }
    // A selection that reaches into a pivot is not a range either, even when
    // the click that opened the menu landed outside one.
    if (!isMultiCellSelection(context) || selectionTouchesAPivot(context)) return null;
    const sel = context.selection!;
    return {
      kind: "range",
      request: {
        sheetIndex: context.sheetIndex,
        startRow: Math.min(sel.startRow, sel.endRow),
        startCol: Math.min(sel.startCol, sel.endCol),
        endRow: Math.max(sel.startRow, sel.endRow),
        endCol: Math.max(sel.startCol, sel.endCol),
      },
    };
  };
  gridExtensions.registerContextMenuItem({
    id: INSIGHTS_GRID_OVERLAY_MENU_ITEM_ID,
    label: (context: GridMenuContext) => {
      const owner = sheetOwnerFor(context);
      return owner && isSheetOverlayOn(owner) ? "Hide points of interest" : "Show points of interest";
    },
    group: GridMenuGroups.DATA,
    order: 61,
    visible: (context: GridMenuContext) => sheetOwnerFor(context) !== null,
    onClick: (context: GridMenuContext) => {
      const owner = sheetOwnerFor(context);
      if (!owner) return;
      if (isSheetOverlayOn(owner)) {
        hideSheetOverlay(owner);
        return;
      }
      void showSheetOverlay(owner).then((r) => {
        if (r.outcome === "refused") showToast(r.reason, { variant: "warning" });
        else if (r.cueSet.cues.length === 0) showToast("Nothing stands out here.", { variant: "info" });
      });
    },
  });
  cleanupFns.push(() => gridExtensions.unregisterContextMenuItem(INSIGHTS_GRID_OVERLAY_MENU_ITEM_ID));

  // 7. The document can be replaced under us (File > New / File > Open, and the
  //    .calp working-copy open that announces the same way). The previous
  //    workbook's connections and its answer both belong to a document that has
  //    gone; keeping either would have the pane describe cells nobody is
  //    looking at.
  const onDocumentReplaced = (): void => {
    resetInsightsStore();
    resetOverlays();
    resetSheetOverlays();
    void refreshConnections();
  };
  for (const evt of [AppEvents.AFTER_OPEN, AppEvents.AFTER_NEW] as const) {
    cleanupFns.push(onAppEvent(evt, onDocumentReplaced));
  }
  // The comments belong to the workbook that was opened; Charts clears the
  // transient store on the same event, so they are re-pushed after it.
  cleanupFns.push(onAppEvent(AppEvents.AFTER_OPEN, () => void loadComments()));

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
  resetOverlays();
  resetSheetOverlays();
  isActivated = false;
  console.log("[Insights] Deactivated.");
}

const extension: ExtensionModule = {
  manifest: InsightsManifest,
  activate,
  deactivate,
};

export default extension;
