// FILENAME: app/extensions/Distribution/index.ts
// PURPOSE: Distribution extension entry point — .calp publish, subscribe, refresh, overrides.
// CONTEXT: Registers task panes, dialogs, grid overlay badges, writeback guards
// (Phase 9), and the conditional style interceptor. It also owns TWO top-level
// menus — "Distribution" (order 46) for the .calp application lifecycle and
// "Writeback" (order 47) for the data-collection channel. They were one
// "Distribution" submenu under External Data until 2026-08-29; External Data
// keeps only "Refresh Data" from this extension.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { AppEvents } from "@api/events";
import { OverridesPane } from "./components/OverridesPane";
import { SubscriptionManagerPane } from "./components/SubscriptionManagerPane";
import { PublisherDashboardPane } from "./components/PublisherDashboardPane";
import { AuditLogPane } from "./components/AuditLogPane";
import {
  ConnectedObjectsSection,
  PublishPreviewSection,
} from "./components/ApplicationExplorerPanel";
import { WorkingCopySection } from "./components/WorkingCopySection";
import {
  DistributionManifest,
  DISTRIBUTION_MENU_ID,
  WRITEBACK_MENU_ID,
  OVERRIDES_PANE_ID,
  WRITEBACK_PANE_ID,
  SUBSCRIPTIONS_PANE_ID,
  PUBLISHER_DASHBOARD_PANE_ID,
  AUDIT_LOG_PANE_ID,
  APPLICATION_EXPLORER_PANEL_ID,
  PUBLISH_DIALOG_ID,
  PUBLISH_MODEL_DIALOG_ID,
  SUBSCRIBE_DIALOG_ID,
  REFRESH_PREVIEW_DIALOG_ID,
  DESIGNATE_WRITEBACK_DIALOG_ID,
  CONNECTION_DIALOG_ID,
  PublishDialogDefinition,
  CheckoutDialogDefinition,
  CHECKOUT_DIALOG_ID,
  PublishModelDialogDefinition,
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
import { openApplicationInspectorWindow } from "./lib/openApplicationInspectorWindow";
import {
  syncWritebackValidators,
  resetWritebackValidators,
  WRITEBACK_VALIDATORS_CHANGED_EVENT,
} from "./lib/writebackValidatorSync";
import { registerCommitGuard } from "@api/commitGuards";
import { runWritebackValidator } from "@api/writebackValidators";
import {
  saveWritebackDraft,
  refreshData,
  getSheetIdForIndex,
  WRITEBACK_INDEX_CHANGED_EVENT,
  type SubmissionValue,
} from "@api/distribution";
import { emitAppEvent } from "@api/events";
import {
  ExtensionRegistry,
  IconPackage,
  IconPublishPackage,
  IconSubscribePackage,
  IconRefreshSubscriptions,
  IconManageSubscriptions,
  IconCollectedResponses,
  IconAuditLog,
  IconOverrides,
  IconWriteback,
  IconWritebackPane,
  IconRefreshData,
  registerStatusBarItem,
  unregisterStatusBarItem,
} from "@api";
import { DistributionRoleStatusItem } from "./components/DistributionRoleStatusItem";

/** Status-bar item id for the working-copy / subscriber role badge. */
const ROLE_STATUS_ITEM_ID = "distribution:roleBadge";

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

  // Register the Subscriptions manager task pane (D6)
  context.ui.taskPanes.register({
    id: SUBSCRIPTIONS_PANE_ID,
    title: "Subscriptions",
    component: SubscriptionManagerPane,
    contextKeys: ["always"],
    priority: 34,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(SUBSCRIPTIONS_PANE_ID));

  // Register the Publisher data-collection dashboard task pane (D5)
  context.ui.taskPanes.register({
    id: PUBLISHER_DASHBOARD_PANE_ID,
    title: "Responses",
    component: PublisherDashboardPane,
    contextKeys: ["always"],
    priority: 33,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(PUBLISHER_DASHBOARD_PANE_ID));

  context.ui.taskPanes.register({
    id: AUDIT_LOG_PANE_ID,
    title: "Audit Log",
    component: AuditLogPane,
    contextKeys: ["always"],
    priority: 35,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(AUDIT_LOG_PANE_ID));

  // Register the Application Explorer transparency panel (sections API): which
  // objects are connected to each subscribed application (with presence checks
  // + click-to-navigate), and a dry-run publish preview for authors showing
  // exactly what would ship vs stay behind.
  context.ui.panels.register({
    id: APPLICATION_EXPLORER_PANEL_ID,
    title: "Application Explorer",
    icon: IconPackage,
    sections: [
      {
        // First, because it answers the question a developer opens this panel
        // with: what am I working on, and where does it stand?
        //
        // Labelled "Working copy", not "Workspace": once a WORKSPACE is the
        // shared folder that holds published applications, this section — which
        // is about THIS workbook and which application it came from — would be
        // named after the wrong noun.
        id: `${APPLICATION_EXPLORER_PANEL_ID}.workingCopy`,
        label: "Working copy",
        component: WorkingCopySection,
      },
      {
        id: `${APPLICATION_EXPLORER_PANEL_ID}.connected`,
        label: "Connected objects",
        component: ConnectedObjectsSection,
      },
      {
        id: `${APPLICATION_EXPLORER_PANEL_ID}.publishPreview`,
        label: "Publish preview",
        component: PublishPreviewSection,
      },
    ],
    defaultPlacement: "sidebar",
    priority: 37,
  });
  cleanupFns.push(() => context.ui.panels.unregister(APPLICATION_EXPLORER_PANEL_ID));

  // WHICH WORKBOOK AM I LOOKING AT? A working copy and a subscribed copy are
  // visually identical and behave oppositely on Push, and the only place that
  // said which was a sidebar section you had to go and open. This badge says it
  // without being asked, and renders nothing for a workbook that is neither.
  registerStatusBarItem({
    id: ROLE_STATUS_ITEM_ID,
    component: DistributionRoleStatusItem,
    alignment: "right",
    priority: 60,
  });
  cleanupFns.push(() => unregisterStatusBarItem(ROLE_STATUS_ITEM_ID));

  // Register dialogs
  context.ui.dialogs.register(PublishDialogDefinition);
  context.ui.dialogs.register(CheckoutDialogDefinition);
  context.ui.dialogs.register(PublishModelDialogDefinition);
  context.ui.dialogs.register(SubscribeDialogDefinition);
  context.ui.dialogs.register(RefreshPreviewDialogDefinition);
  context.ui.dialogs.register(DesignateWritebackDialogDefinition);
  context.ui.dialogs.register(ConnectionDialogDefinition);
  cleanupFns.push(() => context.ui.dialogs.unregister(PUBLISH_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(PUBLISH_MODEL_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(SUBSCRIBE_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(REFRESH_PREVIEW_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(DESIGNATE_WRITEBACK_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(CONNECTION_DIALOG_ID));

  // -----------------------------------------------------------------------
  // Menus. Distribution and Writeback are two features, so they are two
  // top-level menus — peers of Data and Model, not a submenu buried under
  // External Data. This extension owns every item in both, so it registers
  // the shells itself (the same way AutoFilter owns "Data"). "Refresh Data"
  // still belongs to External Data below: it verifies external connections
  // generally, not .calp subscriptions specifically.
  // -----------------------------------------------------------------------

  // "Distribution" (order 46 = after Formulas at 45, before Review at 70):
  // the .calp application lifecycle — publish, subscribe, refresh, inspect,
  // and the override layer a subscriber lays over a received report.
  context.ui.menus.register({
    id: DISTRIBUTION_MENU_ID,
    label: "Distribution",
    order: 46,
    items: [
      {
        id: "distribution:publishApplication",
        label: "Publish Application...",
        icon: IconPublishPackage,
        order: 10,
        action: () => context.ui.dialogs.show(PUBLISH_DIALOG_ID),
      },
      {
        // The author-side counterpart of Subscribe, and deliberately next to
        // it: the two look similar and mean opposite things — edit the
        // application itself, versus take a copy of it to use — so they are
        // read together or not at all.
        id: "distribution:openApplicationForEditing",
        label: "Open Application for Editing...",
        icon: IconSubscribePackage,
        order: 11,
        action: () => context.ui.dialogs.show(CHECKOUT_DIALOG_ID),
      },
      {
        id: "distribution:subscribeApplication",
        label: "Subscribe to Application...",
        icon: IconSubscribePackage,
        order: 12,
        action: () => context.ui.dialogs.show(SUBSCRIBE_DIALOG_ID),
      },
      {
        id: "distribution:refreshSubscriptions",
        label: "Refresh Subscriptions...",
        icon: IconRefreshSubscriptions,
        order: 13,
        action: () => context.ui.dialogs.show(REFRESH_PREVIEW_DIALOG_ID),
      },
      { id: "distribution:sep.manage", label: "", separator: true, order: 19 },
      {
        id: "distribution:manageSubscriptions",
        label: "Manage Subscriptions...",
        icon: IconManageSubscriptions,
        order: 20,
        action: () => {
          context.ui.taskPanes.open(SUBSCRIPTIONS_PANE_ID);
          context.ui.taskPanes.showContainer();
        },
      },
      {
        id: "distribution:openApplicationExplorer",
        label: "Application Explorer",
        icon: IconPackage,
        order: 21,
        action: () => context.ui.panels.open(APPLICATION_EXPLORER_PANEL_ID),
      },
      {
        id: "distribution:openApplicationInspector",
        label: "Application Inspector...",
        icon: IconPackage,
        order: 22,
        action: () => void openApplicationInspectorWindow(),
      },
      {
        id: "distribution:openAuditLog",
        label: "Audit Log...",
        icon: IconAuditLog,
        order: 23,
        action: () => {
          context.ui.taskPanes.open(AUDIT_LOG_PANE_ID);
          context.ui.taskPanes.showContainer();
        },
      },
      { id: "distribution:sep.overrides", label: "", separator: true, order: 29 },
      {
        id: "distribution:openOverridesPane",
        label: "Overrides Pane",
        icon: IconOverrides,
        order: 30,
        action: () => {
          context.ui.taskPanes.open(OVERRIDES_PANE_ID);
          context.ui.taskPanes.showContainer();
        },
      },
    ],
  });

  // "Writeback" (order 47): the two-way data-collection channel. Both ends of
  // it live here — the publisher designates the input regions and reviews what
  // came back ("Collected Responses" is the submissions inbox with
  // approve/reject), the subscriber fills and submits them from the pane.
  context.ui.menus.register({
    id: WRITEBACK_MENU_ID,
    label: "Writeback",
    order: 47,
    items: [
      {
        id: "writeback:designateRegion",
        label: "Designate Writeback Region...",
        icon: IconWriteback,
        order: 10,
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
      },
      {
        id: "writeback:openPane",
        label: "Writeback Pane",
        icon: IconWritebackPane,
        order: 11,
        action: () => {
          context.ui.taskPanes.open(WRITEBACK_PANE_ID);
          context.ui.taskPanes.showContainer();
        },
      },
      { id: "writeback:sep.publisher", label: "", separator: true, order: 19 },
      {
        id: "writeback:openCollectedResponses",
        label: "Collected Responses...",
        icon: IconCollectedResponses,
        order: 20,
        action: () => {
          context.ui.taskPanes.open(PUBLISHER_DASHBOARD_PANE_ID);
          context.ui.taskPanes.showContainer();
        },
      },
    ],
  });

  // Model packaging lives in the consolidated Model menu — a model is
  // published FROM the Model surface, so the entry point stays there rather
  // than duplicating into the Distribution menu above.
  context.ui.menus.registerItem("model", {
    id: "model:publishModel",
    label: "Publish Model as Application...",
    icon: IconPublishPackage,
    order: 50,
    action: () => context.ui.dialogs.show(PUBLISH_MODEL_DIALOG_ID),
  });

  context.ui.menus.registerItem("externalData", {
    id: "externalData:refreshData",
    label: "Refresh Data",
    icon: IconRefreshData,
    action: async () => {
      try {
        const result = await refreshData();

        if (result.needsConfiguration.length > 0) {
          // Show connection dialog for data sources that need manual setup
          context.ui.dialogs.show(CONNECTION_DIALOG_ID, {
            dataSources: result.needsConfiguration,
          });
        } else if (result.sourcesRefreshed > 0) {
          // Data sources verified — notify the grid (pivot refresh pulls
          // the actual data through the BI connections)
          emitAppEvent(AppEvents.SHEET_CHANGED, {});
          context.ui.notifications.showToast(
            `${result.sourcesRefreshed} data source(s) connected and verified`,
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

    // Coerce based on the region's DECLARED type, not the string's shape — so a
    // product code "12345" or a numeric enum label typed into a TEXT region is
    // sent as text, not silently sniffed into a number and rejected.
    let submissionValue: SubmissionValue;
    const trimmed = value.trim();
    const isBool = (s: string) => s.toLowerCase() === "true" || s.toLowerCase() === "false";
    if (trimmed === "") {
      submissionValue = { type: "empty" };
    } else {
      switch (region.valueType) {
        case "number":
        case "integer": {
          const n = Number(trimmed);
          submissionValue = isNaN(n)
            ? { type: "text", value: trimmed } // backend will reject with a clear message
            : { type: "number", value: n };
          break;
        }
        case "boolean":
          submissionValue = isBool(trimmed)
            ? { type: "boolean", value: trimmed.toLowerCase() === "true" }
            : { type: "text", value: trimmed };
          break;
        case "text":
        case "date":
        case "enum":
          submissionValue = { type: "text", value: trimmed };
          break;
        default:
          // No declared type (unschematized region): fall back to shape-sniffing.
          if (!isNaN(Number(trimmed))) {
            submissionValue = { type: "number", value: Number(trimmed) };
          } else if (isBool(trimmed)) {
            submissionValue = { type: "boolean", value: trimmed.toLowerCase() === "true" };
          } else {
            submissionValue = { type: "text", value: trimmed };
          }
      }
    }

    // Advisory custom validator (distribution brick 3): a publisher-declared,
    // subscriber-side UX check layered on top of the authoritative built-in
    // schema. Unknown/unregistered validators are skipped. Runs BEFORE the
    // draft save so a rejection keeps the user in edit mode with the message.
    if (region.customValidator && trimmed !== "") {
      const verdict = runWritebackValidator(region.customValidator, trimmed, {
        valueType: region.valueType,
        regionId: region.regionId,
      });
      if (verdict) {
        context.ui.notifications.showToast(verdict, { type: "warning", duration: 5000 });
        return { action: "retry" as const };
      }
    }

    // Save as draft — if the backend rejects (schema validation, lifecycle
    // deadline, one-shot/locked regions), keep the user in edit mode. Falling
    // through to "allow" on a rejection would display a value that was never
    // saved as a draft and will never be submitted.
    try {
      await saveWritebackDraft(region.regionId, region.sheetId, row, col, submissionValue);
      // Refresh the writeback snapshot to update visual state
      refreshAndUpdateInterceptor();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[Distribution] Writeback draft rejected:", msg);
      context.ui.notifications.showToast(msg, { type: "warning", duration: 5000 });
      return { action: "retry" as const };
    }

    // Allow the normal commit to proceed so the cell displays the value
    return { action: "allow" as const };
  });
  cleanupFns.push(unregCommitGuard);

  // Writeback style interceptor management.
  // Only registered when writeback regions exist, so per-cell render cost
  // is zero in the common case (no writeback applications).
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
              // Fillable: subtle blue tint.
              return { backgroundColor: "#f0f7ff" };
            case "draft":
              // Unsent local edit: amber.
              return { backgroundColor: "#fff8e1" };
            case "submitted":
              // Sent, awaiting the publisher's decision: neutral blue.
              return { backgroundColor: "#e3f2fd" };
            case "approved":
              // Accepted by the publisher: green.
              return { backgroundColor: "#e6f4ea" };
            case "rejected":
              // Rejected — needs revision: red tint.
              return { backgroundColor: "#fce8e6" };
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
    const regions = await refreshWritebackSnapshot();
    updateStyleInterceptor();
    // Publisher-shipped custom validators. The AUTHORITATIVE run is Rust-side
    // at submit (same body, out of the Ed25519-verified manifest, in the
    // embedded QuickJS realm) and it fails CLOSED without the user's consent —
    // so this pass exists to (a) collect the consent the backend demands and
    // (b) mount approved bodies for advisory as-you-type feedback. Never
    // allowed to break the refresh: an unreachable backend must not stop the
    // style interceptor or the index event.
    void syncWritebackValidators(regions)
      .catch((err) => {
        console.warn("[Distribution] writeback validator sync failed:", err);
      })
      .finally(() => {
        emitAppEvent(WRITEBACK_VALIDATORS_CHANGED_EVENT, {});
      });
    // The script host keeps its OWN copy of the region index, so a script grid
    // write can be routed into the same validated draft path this extension's
    // commit guard uses without paying one IPC per cell. Tell it the index
    // moved. (Its copy is an optimization only: a stale one fails CLOSED, in
    // Rust's ensure_writeback_draft_before_write.)
    emitAppEvent(WRITEBACK_INDEX_CHANGED_EVENT, { regionCount: regions.length });
  }

  cleanupFns.push(() => {
    if (unregStyleInterceptor) {
      unregStyleInterceptor();
      unregStyleInterceptor = null;
    }
  });

  // Tear down every mounted advisory validator worker on deactivate.
  cleanupFns.push(() => resetWritebackValidators());

  // Initial snapshot load (in case subscriptions already exist at startup)
  refreshAndUpdateInterceptor();

  isActivated = true;
}

function deactivate(): void {
  if (!isActivated) return;
  for (const fn of cleanupFns) {
    // One failing cleanup must not strand the others, so the loop continues —
    // but it does not continue SILENTLY. These teardowns unmount validator
    // workers and drop event listeners; a swallowed throw here is a leak that
    // survives deactivate with nothing to show for it.
    try {
      fn();
    } catch (error) {
      console.error("[Distribution] a deactivate cleanup threw; continuing", error);
    }
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
