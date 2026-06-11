// FILENAME: app/extensions/Distribution/index.ts
// PURPOSE: Distribution extension entry point — .calp publish, subscribe, refresh, overrides.
// CONTEXT: Registers task pane, dialogs, menu items, grid overlay badges,
// writeback guards (Phase 9), and conditional style interceptor.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { AppEvents } from "@api/events";
import { OverridesPane } from "./components/OverridesPane";
import {
  DistributionManifest,
  OVERRIDES_PANE_ID,
  WRITEBACK_PANE_ID,
  PUBLISH_DIALOG_ID,
  SUBSCRIBE_DIALOG_ID,
  REFRESH_PREVIEW_DIALOG_ID,
  DESIGNATE_WRITEBACK_DIALOG_ID,
  CONNECTION_DIALOG_ID,
  PublishDialogDefinition,
  SubscribeDialogDefinition,
  RefreshPreviewDialogDefinition,
  DesignateWritebackDialogDefinition,
  ConnectionDialogDefinition,
} from "./manifest";
import { WritebackPane } from "./components/WritebackPane";
import {
  isWritebackCell,
  rangeOverlapsWriteback,
  hasWritebackRegions,
  refreshWritebackSnapshot,
  resetWritebackSnapshot,
  setActiveSheetIndex,
  getActiveSheetIndex,
  getWritebackCellState,
  getRegionForCell,
} from "./lib/writebackStore";
import { registerCommitGuard } from "@api/commitGuards";
import {
  saveWritebackDraft,
  refreshData,
  getSheetIdForIndex,
  type SubmissionValue,
} from "@api/distribution";
import { emitAppEvent } from "@api/events";
import { ExtensionRegistry } from "@api";

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// Current grid selection (normalized), tracked for the writeback designation
// flow: the menu action snapshots it into the dialog payload.
let currentSelection: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} | null = null;

function activate(context: ExtensionContext): void {
  if (isActivated) return;

  // Register the Overrides task pane
  context.ui.taskPanes.register({
    id: OVERRIDES_PANE_ID,
    title: "Overrides",
    component: OverridesPane,
    contextKeys: ["always"],
    priority: 35,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(OVERRIDES_PANE_ID));

  // Register the Writeback task pane
  context.ui.taskPanes.register({
    id: WRITEBACK_PANE_ID,
    title: "Writeback",
    component: WritebackPane,
    contextKeys: ["always"],
    priority: 36,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(WRITEBACK_PANE_ID));

  // Register dialogs
  context.ui.dialogs.register(PublishDialogDefinition);
  context.ui.dialogs.register(SubscribeDialogDefinition);
  context.ui.dialogs.register(RefreshPreviewDialogDefinition);
  context.ui.dialogs.register(DesignateWritebackDialogDefinition);
  context.ui.dialogs.register(ConnectionDialogDefinition);
  cleanupFns.push(() => context.ui.dialogs.unregister(PUBLISH_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(SUBSCRIBE_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(REFRESH_PREVIEW_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(DESIGNATE_WRITEBACK_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(CONNECTION_DIALOG_ID));

  // Register menu items under Data menu
  context.ui.menus.registerItem("data", {
    id: "data:publishPackage",
    label: "Publish Package...",
    action: () => context.ui.dialogs.show(PUBLISH_DIALOG_ID),
    order: 900,
  });

  context.ui.menus.registerItem("data", {
    id: "data:subscribePackage",
    label: "Subscribe to Package...",
    action: () => context.ui.dialogs.show(SUBSCRIBE_DIALOG_ID),
    order: 901,
  });

  context.ui.menus.registerItem("data", {
    id: "data:refreshSubscriptions",
    label: "Refresh Subscriptions...",
    action: () => context.ui.dialogs.show(REFRESH_PREVIEW_DIALOG_ID),
    order: 902,
  });

  context.ui.menus.registerItem("data", {
    id: "data:showOverrides",
    label: "Show Overrides Pane",
    action: () => {
      context.ui.taskPanes.open(OVERRIDES_PANE_ID);
      context.ui.taskPanes.showContainer();
    },
    order: 903,
  });

  context.ui.menus.registerItem("data", {
    id: "data:designateWriteback",
    label: "Designate Writeback Region...",
    action: async () => {
      if (!currentSelection) {
        context.ui.notifications.showToast(
          "Select the cell range to designate first, then run this command again.",
          { type: "info", duration: 4000 },
        );
        return;
      }
      try {
        const sheetId = await getSheetIdForIndex(getActiveSheetIndex());
        context.ui.dialogs.show(DESIGNATE_WRITEBACK_DIALOG_ID, {
          sheetId,
          startRow: currentSelection.startRow,
          endRow: currentSelection.endRow,
          startCol: currentSelection.startCol,
          endCol: currentSelection.endCol,
        });
      } catch (err) {
        context.ui.notifications.showToast(
          `Cannot designate writeback region: ${err}`,
          { type: "error", duration: 5000 },
        );
      }
    },
    order: 904,
  });

  context.ui.menus.registerItem("data", {
    id: "data:showWritebackPane",
    label: "Show Writeback Pane",
    action: () => {
      context.ui.taskPanes.open(WRITEBACK_PANE_ID);
      context.ui.taskPanes.showContainer();
    },
    order: 905,
  });

  context.ui.menus.registerItem("data", {
    id: "data:refreshData",
    label: "Refresh Data",
    action: async () => {
      try {
        const result = await refreshData();

        if (result.needsConfiguration.length > 0) {
          // Show connection dialog for data sources that need manual setup
          context.ui.dialogs.show(CONNECTION_DIALOG_ID, {
            dataSources: result.needsConfiguration,
          });
        } else if (result.sourcesRefreshed > 0) {
          // Data refreshed successfully — notify the grid
          emitAppEvent(AppEvents.SHEET_CHANGED, {});
          context.ui.notifications.showToast(
            `Refreshed ${result.queriesExecuted} queries, ${result.cellsUpdated} cells updated`,
            { type: "success", duration: 3000 },
          );
        } else {
          context.ui.notifications.showToast(
            "No data sources found in subscriptions",
            { type: "info", duration: 3000 },
          );
        }
      } catch (err) {
        context.ui.notifications.showToast(
          `Refresh failed: ${err}`,
          { type: "error", duration: 5000 },
        );
      }
    },
    order: 906,
  });

  // -----------------------------------------------------------------------
  // Phase 9: Writeback readiness — guards, interceptor, event listeners
  // -----------------------------------------------------------------------

  // Track active sheet index for guard evaluation
  const unsubSheetChanged = context.events.on(
    AppEvents.SHEET_CHANGED,
    (_data: unknown) => {
      // The event payload contains the new sheet index
      const payload = _data as { sheetIndex?: number } | undefined;
      if (payload && typeof payload.sheetIndex === "number") {
        setActiveSheetIndex(payload.sheetIndex);
      }
    },
  );
  cleanupFns.push(unsubSheetChanged);

  // Track grid selection for the writeback designation menu action
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    currentSelection = sel
      ? {
          startRow: Math.min(sel.startRow, sel.endRow),
          startCol: Math.min(sel.startCol, sel.endCol),
          endRow: Math.max(sel.startRow, sel.endRow),
          endCol: Math.max(sel.startCol, sel.endCol),
        }
      : null;
  });
  cleanupFns.push(unsubSelection);

  // Load writeback snapshot on file open / new
  const unsubAfterOpen = context.events.on(AppEvents.AFTER_OPEN, () => {
    refreshAndUpdateInterceptor();
  });
  cleanupFns.push(unsubAfterOpen);

  const unsubAfterNew = context.events.on(AppEvents.AFTER_NEW, () => {
    refreshAndUpdateInterceptor();
  });
  cleanupFns.push(unsubAfterNew);

  // Edit guard: writeback cells ARE editable (subscriber fills them).
  // No edit guard block needed — writeback cells allow editing.
  // The commit guard (below) routes the value to the writeback draft layer.

  // Register range guard: refuse range operations that overlap writeback regions
  const unregRangeGuard = context.grid.rangeGuards.register(
    (startRow: number, startCol: number, endRow: number, endCol: number) => {
      if (!hasWritebackRegions()) return null;
      const sheetIdx = getActiveSheetIndex();
      if (rangeOverlapsWriteback(sheetIdx, startRow, startCol, endRow, endCol)) {
        return {
          blocked: true,
          message: "Some cells in this range are reserved for input in a future version.",
        };
      }
      return null;
    },
  );
  cleanupFns.push(unregRangeGuard);

  // Commit guard: when a writeback cell value is committed, save it as a draft.
  // The normal cell update still proceeds (action = "allow"), so the cell displays
  // the value. The writeback layer also stores it for later submission.
  const unregCommitGuard = registerCommitGuard(async (row, col, value) => {
    if (!hasWritebackRegions()) return null;
    const sheetIdx = getActiveSheetIndex();
    const region = getRegionForCell(sheetIdx, row, col);
    if (!region) return null;

    // Determine the submission value type
    let submissionValue: SubmissionValue;
    const trimmed = value.trim();
    if (trimmed === "") {
      submissionValue = { type: "empty" };
    } else if (!isNaN(Number(trimmed)) && trimmed !== "") {
      submissionValue = { type: "number", value: Number(trimmed) };
    } else if (trimmed.toLowerCase() === "true" || trimmed.toLowerCase() === "false") {
      submissionValue = { type: "boolean", value: trimmed.toLowerCase() === "true" };
    } else {
      submissionValue = { type: "text", value: trimmed };
    }

    // Save as draft — if schema validation fails, keep the user in edit mode
    try {
      await saveWritebackDraft(region.regionId, region.sheetId, row, col, submissionValue);
      // Refresh the writeback snapshot to update visual state
      refreshAndUpdateInterceptor();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Schema validation failed")) {
        // Show the validation error and let the user correct the value
        console.warn("[Distribution] Writeback validation error:", msg);
        context.ui.notifications.showToast(msg, { type: "warning", duration: 5000 });
        return { action: "retry" as const };
      }
      console.error("[Distribution] Failed to save writeback draft:", err);
    }

    // Allow the normal commit to proceed so the cell displays the value
    return { action: "allow" as const };
  });
  cleanupFns.push(unregCommitGuard);

  // Writeback style interceptor management.
  // Only registered when writeback regions exist, so per-cell render cost
  // is zero in the common case (no writeback packages).
  let unregStyleInterceptor: (() => void) | null = null;

  function updateStyleInterceptor(): void {
    if (hasWritebackRegions() && !unregStyleInterceptor) {
      unregStyleInterceptor = context.grid.styleInterceptors.register(
        "distribution:writeback",
        (_cellValue, _baseStyle, coords) => {
          const sheetIdx = getActiveSheetIndex();
          const state = getWritebackCellState(sheetIdx, coords.row, coords.col);
          if (!state) return null;

          switch (state) {
            case "empty":
              // Subtle fillable background tint
              return { backgroundColor: "#f0f7ff" };
            case "draft":
              // Draft: tinted background indicating unsaved work
              return { backgroundColor: "#fff8e1" };
            case "submitted":
              // Submitted: tinted background indicating confirmed input
              return { backgroundColor: "#e8f5e9" };
            default:
              return null;
          }
        },
        30, // priority: after tables (5) and conditional formatting (20+)
      );
    } else if (!hasWritebackRegions() && unregStyleInterceptor) {
      unregStyleInterceptor();
      unregStyleInterceptor = null;
    }
  }

  // Wrap snapshot refresh to also update interceptor registration
  async function refreshAndUpdateInterceptor(): Promise<void> {
    await refreshWritebackSnapshot();
    updateStyleInterceptor();
  }

  cleanupFns.push(() => {
    if (unregStyleInterceptor) {
      unregStyleInterceptor();
      unregStyleInterceptor = null;
    }
  });

  // Initial snapshot load (in case subscriptions already exist at startup)
  refreshAndUpdateInterceptor();

  isActivated = true;
}

function deactivate(): void {
  if (!isActivated) return;
  for (const fn of cleanupFns) {
    try { fn(); } catch {}
  }
  cleanupFns.length = 0;
  resetWritebackSnapshot();
  isActivated = false;
}

const extension: ExtensionModule = {
  manifest: DistributionManifest,
  activate,
  deactivate,
};

export default extension;
