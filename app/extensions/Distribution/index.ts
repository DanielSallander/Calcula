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
  PublishDialogDefinition,
  SubscribeDialogDefinition,
  RefreshPreviewDialogDefinition,
  DesignateWritebackDialogDefinition,
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
} from "./lib/writebackStore";

let isActivated = false;
const cleanupFns: (() => void)[] = [];

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
  cleanupFns.push(() => context.ui.dialogs.unregister(PUBLISH_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(SUBSCRIBE_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(REFRESH_PREVIEW_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(DESIGNATE_WRITEBACK_DIALOG_ID));

  // Register menu items under Data menu
  context.ui.menus.registerItem("data", {
    id: "data:publishPackage",
    label: "Publish Package...",
    action: () => context.ui.dialogs.open(PUBLISH_DIALOG_ID),
    order: 900,
  });

  context.ui.menus.registerItem("data", {
    id: "data:subscribePackage",
    label: "Subscribe to Package...",
    action: () => context.ui.dialogs.open(SUBSCRIBE_DIALOG_ID),
    order: 901,
  });

  context.ui.menus.registerItem("data", {
    id: "data:refreshSubscriptions",
    label: "Refresh Subscriptions...",
    action: () => context.ui.dialogs.open(REFRESH_PREVIEW_DIALOG_ID),
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
    action: () => context.ui.dialogs.open(DESIGNATE_WRITEBACK_DIALOG_ID),
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

  // Load writeback snapshot on file open / new
  const unsubAfterOpen = context.events.on(AppEvents.AFTER_OPEN, () => {
    refreshAndUpdateInterceptor();
  });
  cleanupFns.push(unsubAfterOpen);

  const unsubAfterNew = context.events.on(AppEvents.AFTER_NEW, () => {
    refreshAndUpdateInterceptor();
  });
  cleanupFns.push(unsubAfterNew);

  // Register edit guard: refuse edits on writeback cells
  const unregEditGuard = context.grid.editGuards.register(
    async (row: number, col: number) => {
      if (!hasWritebackRegions()) return null;
      const sheetIdx = getActiveSheetIndex();
      if (isWritebackCell(sheetIdx, row, col)) {
        return {
          blocked: true,
          message: "This cell is reserved for input in a future version.",
        };
      }
      return null;
    },
  );
  cleanupFns.push(unregEditGuard);

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
