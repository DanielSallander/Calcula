// FILENAME: app/extensions/Collaboration/index.ts
// PURPOSE: Collaboration extension entry point — .calp publish, subscribe, refresh, overrides.
// CONTEXT: Registers task panes, dialogs, the writeback guards and the writeback
// grid painters (a region frame layer -- a soft line with tiny "w"s -- and unsent/rejected state
// markers, registered only while regions exist). It also owns TWO top-level
// menus — "Collaboration" (order 46) for the .calp application lifecycle and
// "Writeback" (order 47) for the data-collection channel. They were one
// "Distribution" submenu (this feature's name until 2026-09-25) under External
// Data until 2026-08-29; External Data keeps only "Refresh Data" from this extension.

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
import { EnvironmentsSection } from "./components/EnvironmentsSection";
import {
  CollaborationManifest,
  COLLABORATION_MENU_ID,
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
  SUBSCRIPTION_DIFF_DIALOG_ID,
  DESIGNATE_WRITEBACK_DIALOG_ID,
  CONNECTION_DIALOG_ID,
  PublishDialogDefinition,
  CheckoutDialogDefinition,
  CHECKOUT_DIALOG_ID,
  PublishModelDialogDefinition,
  SubscribeDialogDefinition,
  RefreshPreviewDialogDefinition,
  SubscriptionDiffDialogDefinition,
  PromoteDialogDefinition,
  EditPipelineDialogDefinition,
  PROMOTE_DIALOG_ID,
  EDIT_PIPELINE_DIALOG_ID,
  DesignateWritebackDialogDefinition,
  ConnectionDialogDefinition,
} from "./manifest";
import { WritebackPane } from "./components/WritebackPane";
import {
  hasWritebackRegions,
  refreshWriteback,
  refreshWritebackLocal,
  resetWritebackSnapshot,
  startWritebackStore,
  subscribeWritebackSnapshot,
  getWritebackRegionList,
  isWritebackSnapshotLoaded,
  getActiveSheetId,
  getActiveSheetFrameRegions,
  hasWritebackFrames,
  getDesignatedRegionCount,
  getActiveRegionAt,
  getActiveCellState,
  activeRangeOverlapsWriteback,
  getRegionSummary,
  regionApplicationName,
  unsentDraftsOnSheet as unsentWritebackOnSheet,
  writebackRegionListKey,
} from "./lib/writebackStore";
import { decideWritebackRangeGuard, coerceWritebackInput } from "./lib/writebackGuards";
import { createWritebackDecoration } from "./lib/writebackDecorations";
import { createWritebackOutlinePainter } from "./lib/writebackOutline";
import { WRITEBACK_REGIONS_CHANGED_EVENT } from "./components/DesignateWritebackDialog";
import {
  handleWritebackSelectionChange,
  syncWritebackTabToRegions,
  resetWritebackTab,
} from "./lib/writebackTab";
import {
  submitWritebackRegion,
  submitButtonState,
  resetWritebackTabModel,
  valuesText,
} from "./lib/writebackTabModel";
import { refreshCollectStreams, resetCollectStreams, wireCollectStreamsRefresh } from "./lib/collectStreamsStore";
import { columnToLetter } from "@api/types";

import { onSelectionOwnershipChanged } from "@api/selectionOwner";
import { rangeToCanvasRect } from "@api/gridLayers";
import { getCanvasToneColors, getActiveGridTheme } from "@api/appearance";
import { getGridStateSnapshot } from "@api/grid";
import { parseNumber } from "@api/locale";
import { openApplicationInspectorWindow } from "./lib/openApplicationInspectorWindow";
import { designateWritebackRegion } from "./lib/designateWritebackRegion";
import { installInspectorFormPreviewBridge } from "./lib/inspectorFormPreview";
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
  detachSheet,
  resetSubscription,
  WRITEBACK_INDEX_CHANGED_EVENT,
  ENVIRONMENTS_CHANGED_EVENT,
} from "@api/collaboration";
import { emitAppEvent } from "@api/events";
import { confirmAsync, alertAsync } from "@api/dialogs";
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
  registerSheetTabDecorationProvider,
  invalidateSheetTabDecorations,
  sheetExtensions,
  unregisterMenu,
  gridExtensions,
  GridMenuGroups,
  type GridMenuContext,
} from "@api";
import { CollaborationRoleStatusItem } from "./components/CollaborationRoleStatusItem";
import { SUBSCRIBED_CHIP, WORKING_COPY_CHIP } from "./lib/roleChipColors";
import {
  provenanceForSheetId,
  subscribedProvenanceForSheetId,
  workingCopyForSheetId,
  subscriptionForSheetId,
  refreshSubscribedSheets,
  resetSubscribedSheets,
} from "./lib/subscribedSheets";
import { announceSubscribedContentReplaced } from "./lib/refreshAftermath";

/** Status-bar item id for the working-copy / subscriber role badge. */
const ROLE_STATUS_ITEM_ID = "collaboration:roleBadge";

/** Tags this extension's own WRITEBACK_INDEX_CHANGED_EVENT announcements. */
const WRITEBACK_STORE_EVENT_SOURCE = "collaboration:writeback-store";

/** A cell in A1 notation (zero-based row and column in). */
function cellA1(row: number, col: number): string {
  return `${columnToLetter(col)}${row + 1}`;
}

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
        // Directly after the working copy, because it answers the developer's
        // SECOND question: this is where my work stands — and who has it.
        // A push moves the line; only a promotion moves an audience.
        id: `${APPLICATION_EXPLORER_PANEL_ID}.environments`,
        label: "Environments",
        component: EnvironmentsSection,
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
    component: CollaborationRoleStatusItem,
    alignment: "right",
    priority: 60,
  });
  cleanupFns.push(() => unregisterStatusBarItem(ROLE_STATUS_ITEM_ID));

  // WHICH SHEETS ARE MINE? The status badge above answers it for the WORKBOOK;
  // this answers it per tab, and says WHICH KIND of not-yours it is, because the
  // two behave oppositely on the one gesture that matters:
  //
  //   ↓ subscribed  — somebody else's. Refreshed from the workspace, your edits
  //                   on it become overrides, and it stays OUT of your publishes.
  //   ✎ working copy — the application itself. A push CARRIES this sheet.
  //
  // Working-copy sheets were deliberately NOT marked while checkout replaced the
  // document: essentially every tab was the application's, so a badge on all of
  // them was noise the status chip already covered. Checkout is now additive —
  // the application's sheets join a workbook that keeps its own — so the answer
  // varies per tab again, which is the test this seam's existence rests on.
  cleanupFns.push(
    registerSheetTabDecorationProvider({
      id: "collaboration:subscribedSheet",
      priority: 10,
      provider: (sheet) => {
        const entry = provenanceForSheetId(sheet.sheetId);
        if (!entry) return null;
        if (entry.role === "workingCopy") {
          return {
            glyph: WORKING_COPY_CHIP.glyph,
            color: WORKING_COPY_CHIP.fg,
            background: WORKING_COPY_CHIP.bg,
            tooltip:
              `This sheet belongs to the application "${entry.packageName}", which this ` +
              `workbook is the working copy of. Pushing publishes it as the next ` +
              `version; your own sheets beside it are not carried.`,
          };
        }
        return {
          glyph: SUBSCRIBED_CHIP.glyph,
          color: SUBSCRIBED_CHIP.fg,
          background: SUBSCRIBED_CHIP.bg,
          tooltip:
            `This sheet came from the application "${entry.packageName}"` +
            (entry.environment
              ? `, following its "${entry.environment}" environment — it moves when ` +
                `${entry.environment} is promoted, not when a version is pushed`
              : "") +
            (entry.upstreamRemoved
              ? `. That application's current version NO LONGER PUBLISHES this sheet, so ` +
                `nothing refreshes it — it is kept as it was. A later version bringing it ` +
                `back updates this tab in place. It stays out of your publishes; detach it ` +
                `to make it yours.`
              : `. It is refreshed from the workspace, your edits on it are kept as ` +
                `overrides, and it is left out of a publish unless you tick it deliberately.`),
        };
      },
    }),
  );

  const reloadSubscribedSheets = async (): Promise<void> => {
    if (await refreshSubscribedSheets()) invalidateSheetTabDecorations();
  };
  // These three, and not SHEET_CHANGED: that fires on every tab click, and
  // re-reading the ledger per click buys an answer that cannot have changed.
  // Nor the sheet add/delete/move/rename events — EVERY consumer now keys on
  // `sheetId`, which none of them alters, and the strip re-renders on them
  // anyway.
  //
  // That sentence was here before it was true. A second cache keyed by workbook
  // INDEX fed the four tab menu items below, and a move or a delete shifted it
  // under them with no event to notice: the menu offered `Detach from
  // "vendor-kpis"` on an unrelated sheet and hid all three items on the sheet
  // that still wore the badge. Adding a fourth event would have been the cheap
  // fix and the wrong one — the fix is that the answer no longer depends on
  // position at all.
  cleanupFns.push(context.events.on(AppEvents.AFTER_OPEN, () => void reloadSubscribedSheets()));
  cleanupFns.push(context.events.on(AppEvents.AFTER_NEW, () => void reloadSubscribedSheets()));
  cleanupFns.push(
    context.events.on(AppEvents.PACKAGE_UPDATED, () => void reloadSubscribedSheets()),
  );
  // Subscriptions may already exist: the workbook was opened before we activated.
  void reloadSubscribedSheets();
  cleanupFns.push(() => resetSubscribedSheets());

  // DETACH — the deliberate way to make a subscribed sheet yours, and the remedy
  // the backend's delete guard points at by name. `visible`, not `disabled`: an
  // item greyed out on every ordinary tab is clutter that teaches people to
  // ignore the menu.
  sheetExtensions.registerContextMenuItem({
    id: "collaboration:detachSheet",
    label: (ctx) => {
      const app = subscriptionForSheetId(ctx.sheetId);
      return app ? `Detach from "${app}"` : "Detach from application";
    },
    visible: (ctx) => subscriptionForSheetId(ctx.sheetId) !== null,
    separatorAfter: true,
    onClick: async (ctx) => {
      const app = subscriptionForSheetId(ctx.sheetId);
      if (!app) return;
      // `confirmAsync`, never the `confirm` global — under Tauri that returns a
      // Promise, so `if (!confirm(m))` tests `!Promise`, which is always false
      // and the guard NEVER fires. Fails CLOSED.
      // Detaching DELETES the unsent writeback values of the regions on the
      // sheet (they can never be submitted once the sheet is no longer the
      // application's). Say so, with the count, before the user agrees.
      const unsent = ctx.sheetId ? unsentWritebackOnSheet(ctx.sheetId) : 0;
      const unsentWarning =
        unsent > 0
          ? `\n\n${valuesText(unsent)} you typed into writeback cells on this sheet ` +
            `${unsent === 1 ? "has" : "have"} not been sent and will be discarded. ` +
            `Submit ${unsent === 1 ? "it" : "them"} first (Writeback > Submit) if the ` +
            `publisher should have ${unsent === 1 ? "it" : "them"}.`
          : "";
      const ok = await confirmAsync(
        `Detach "${ctx.sheet.name}" from the application "${app}"?\n\n` +
          `The sheet and everything in it stays. What stops is the connection: it ` +
          `will no longer be refreshed from the workspace, you lose the ability to ` +
          `revert its cells to the published version, and it becomes yours to ` +
          `publish. This cannot be undone except by subscribing again.` +
          unsentWarning,
        { title: "Detach sheet" },
      );
      if (!ok) return;
      try {
        await detachSheet(ctx.index);
        await reloadSubscribedSheets();
        // The badge, the Application Explorer and any open publish dialog all
        // read provenance; one announcement refreshes them together.
        emitAppEvent(AppEvents.PACKAGE_UPDATED, {});
        invalidateSheetTabDecorations();
      } catch (err: unknown) {
        await alertAsync(String(err), { title: "Could not detach the sheet" });
      }
    },
  });
  cleanupFns.push(() => sheetExtensions.unregisterContextMenuItem("collaboration:detachSheet"));

  // RESET TO PUBLISHED — the other thing you can want to do to a subscribed
  // sheet, and until now the hardest to find.
  //
  // Reported from live testing: "I subscribed to a sheet, overwrote some values,
  // clicked refresh subscription, and nothing happened." Refresh is not that
  // verb — it fetches a NEWER version, and there wasn't one. The verb they
  // wanted was this, and it lived four clicks deep in a task pane.
  //
  // It sits on the tab because that is where the sheet is. The command itself is
  // per-APPLICATION, not per-sheet, so the confirm names how many sheets it will
  // touch rather than pretending the scope is the one tab you right-clicked.
  // THE DIALOG OWNS THE CONFIRM, and it has to: `ui.dialogs.show()` returns
  // void, so a menu item cannot await a dialog and act on the answer. The
  // reset call, its aftermath and the two-step confirm all live in
  // `SubscriptionDiffDialog`. What used to be here was a text-only
  // `confirmAsync` — a sentence as the basis for a decision about work you may
  // not remember making.
  sheetExtensions.registerContextMenuItem({
    id: "collaboration:resetSheet",
    label: (ctx) => {
      const p = subscribedProvenanceForSheetId(ctx.sheetId);
      return p ? `Reset "${p.packageName}" to published...` : "Reset to published...";
    },
    visible: (ctx) => subscribedProvenanceForSheetId(ctx.sheetId) !== null,
    onClick: (ctx) => {
      const p = subscribedProvenanceForSheetId(ctx.sheetId);
      if (!p) return;
      context.ui.dialogs.show(SUBSCRIPTION_DIFF_DIALOG_ID, {
        registryUrl: p.registryUrl,
        packageName: p.packageName,
        resolvedVersion: p.resolvedVersion,
        mode: "reset",
      });
    },
  });
  cleanupFns.push(() => sheetExtensions.unregisterContextMenuItem("collaboration:resetSheet"));

  // THE SAME COMPARISON, WITHOUT THE LOADED GUN. Looking at what you have
  // changed is a reasonable thing to want on its own, and making it reachable
  // only through a button labelled "Reset" teaches people not to press the
  // button that answers their question.
  sheetExtensions.registerContextMenuItem({
    id: "collaboration:viewSheetChanges",
    label: (ctx) => {
      const p = subscribedProvenanceForSheetId(ctx.sheetId);
      return p ? `View changes vs "${p.packageName}"...` : "View changes vs application...";
    },
    visible: (ctx) => subscribedProvenanceForSheetId(ctx.sheetId) !== null,
    separatorAfter: true,
    onClick: (ctx) => {
      const p = subscribedProvenanceForSheetId(ctx.sheetId);
      if (!p) return;
      context.ui.dialogs.show(SUBSCRIPTION_DIFF_DIALOG_ID, {
        registryUrl: p.registryUrl,
        packageName: p.packageName,
        resolvedVersion: p.resolvedVersion,
        mode: "view",
      });
    },
  });
  cleanupFns.push(() =>
    sheetExtensions.unregisterContextMenuItem("collaboration:viewSheetChanges"),
  );

  // PUSH, from where the sheet is. The other side of the same workflow: a
  // developer editing a checked-out application should not have to leave the
  // tab to publish the next version.
  //
  // It opens the EXISTING publish dialog rather than a smaller one. That dialog
  // is already the push surface, already fetches and shows the working-copy
  // diff, and already carries the stale-base gate, the merge outcome, the
  // version bump and the required change summary. A leaner push dialog would be
  // four second sources of truth about what a push is.
  //
  // The label names the APPLICATION, never the sheet: a push carries the link's
  // whole base_sheets set, exactly as reset covers a whole subscription.
  sheetExtensions.registerContextMenuItem({
    id: "collaboration:pushFromTab",
    label: (ctx) => {
      const p = workingCopyForSheetId(ctx.sheetId);
      return p ? `Push changes to "${p.packageName}"...` : "Push changes to application...";
    },
    visible: (ctx) => workingCopyForSheetId(ctx.sheetId) !== null,
    separatorAfter: true,
    onClick: (ctx) => {
      const p = workingCopyForSheetId(ctx.sheetId);
      if (!p) return;
      // A HINT, never a selection. The dialog highlights the row so the
      // developer can see where the sheet they right-clicked sits in the push,
      // but it must not TICK it: a right-click that changes what leaves the
      // machine is exactly what the "(new — not in v…)" marker exists to keep
      // deliberate.
      context.ui.dialogs.show(PUBLISH_DIALOG_ID, { focusSheetName: ctx.sheet.name });
    },
  });
  cleanupFns.push(() => sheetExtensions.unregisterContextMenuItem("collaboration:pushFromTab"));

  // Register dialogs
  context.ui.dialogs.register(PublishDialogDefinition);
  context.ui.dialogs.register(CheckoutDialogDefinition);
  context.ui.dialogs.register(PublishModelDialogDefinition);
  context.ui.dialogs.register(SubscribeDialogDefinition);
  context.ui.dialogs.register(RefreshPreviewDialogDefinition);
  context.ui.dialogs.register(SubscriptionDiffDialogDefinition);
  context.ui.dialogs.register(DesignateWritebackDialogDefinition);
  context.ui.dialogs.register(ConnectionDialogDefinition);
  context.ui.dialogs.register(PromoteDialogDefinition);
  context.ui.dialogs.register(EditPipelineDialogDefinition);
  cleanupFns.push(() => context.ui.dialogs.unregister(PUBLISH_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(PUBLISH_MODEL_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(SUBSCRIBE_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(REFRESH_PREVIEW_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(SUBSCRIPTION_DIFF_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(DESIGNATE_WRITEBACK_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(CONNECTION_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(PROMOTE_DIALOG_ID));
  cleanupFns.push(() => context.ui.dialogs.unregister(EDIT_PIPELINE_DIALOG_ID));

  // -----------------------------------------------------------------------
  // Menus. Collaboration and Writeback are two features, so they are two
  // top-level menus — peers of Data and Model, not a submenu buried under
  // External Data. This extension owns every item in both, so it registers
  // the shells itself (the same way AutoFilter owns "Data"). "Refresh Data"
  // still belongs to External Data below: it verifies external connections
  // generally, not .calp subscriptions specifically.
  // -----------------------------------------------------------------------

  // "Collaboration" (order 46 = after Formulas at 45, before Review at 70):
  // the .calp application lifecycle — publish, subscribe, refresh, inspect,
  // and the override layer a subscriber lays over a received report.
  context.ui.menus.register({
    id: COLLABORATION_MENU_ID,
    label: "Collaboration",
    order: 46,
    items: [
      {
        id: "collaboration:publishApplication",
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
        id: "collaboration:openApplicationForEditing",
        label: "Open Application for Editing...",
        icon: IconSubscribePackage,
        order: 11,
        action: () => context.ui.dialogs.show(CHECKOUT_DIALOG_ID),
      },
      {
        id: "collaboration:subscribeApplication",
        label: "Subscribe to Application...",
        icon: IconSubscribePackage,
        order: 12,
        action: () => context.ui.dialogs.show(SUBSCRIBE_DIALOG_ID),
      },
      {
        id: "collaboration:refreshSubscriptions",
        label: "Refresh Subscriptions...",
        icon: IconRefreshSubscriptions,
        order: 13,
        action: () => context.ui.dialogs.show(REFRESH_PREVIEW_DIALOG_ID),
      },
      { id: "collaboration:sep.manage", label: "", separator: true, order: 19 },
      {
        id: "collaboration:manageSubscriptions",
        label: "Manage Subscriptions...",
        icon: IconManageSubscriptions,
        order: 20,
        action: () => {
          context.ui.taskPanes.open(SUBSCRIPTIONS_PANE_ID);
          context.ui.taskPanes.showContainer();
        },
      },
      {
        id: "collaboration:openApplicationExplorer",
        label: "Application Explorer",
        icon: IconPackage,
        order: 21,
        action: () => context.ui.panels.open(APPLICATION_EXPLORER_PANEL_ID),
      },
      {
        id: "collaboration:openApplicationInspector",
        label: "Application Inspector...",
        icon: IconPackage,
        order: 22,
        action: () => void openApplicationInspectorWindow(),
      },
      {
        id: "collaboration:openAuditLog",
        label: "Audit Log...",
        icon: IconAuditLog,
        order: 23,
        action: () => {
          context.ui.taskPanes.open(AUDIT_LOG_PANE_ID);
          context.ui.taskPanes.showContainer();
        },
      },
      { id: "collaboration:sep.overrides", label: "", separator: true, order: 29 },
      {
        id: "collaboration:openOverridesPane",
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
        action: () =>
          designateWritebackRegion(context, currentSelection, async () =>
            getActiveSheetId() ??
            getSheetIdForIndex(getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0),
          ),
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

  // Both menus are this extension's; taken back on deactivate (X19). Kept
  // while another extension has added an item to one of them, like every
  // menu an extension builds for others to join.
  cleanupFns.push(() => {
    unregisterMenu(COLLABORATION_MENU_ID, { keepWhileShared: true });
    unregisterMenu(WRITEBACK_MENU_ID, { keepWhileShared: true });
  });

  // Model packaging lives in the consolidated Model menu — a model is
  // published FROM the Model surface, so the entry point stays there rather
  // than duplicating into the Collaboration menu above.
  context.ui.menus.registerItem("model", {
    id: "model:publishModel",
    label: "Publish Model as Application...",
    icon: IconPublishPackage,
    order: 50,
    action: () => context.ui.dialogs.show(PUBLISH_MODEL_DIALOG_ID),
  });
  cleanupFns.push(() => context.ui.menus.unregisterItem("model", "model:publishModel"));

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
  cleanupFns.push(() => context.ui.menus.unregisterItem("externalData", "externalData:refreshData"));

  // -----------------------------------------------------------------------
  // Writeback, subscriber side: the shared snapshot, the guards, the grid
  // outline and state markers, and the events that re-read it.
  // -----------------------------------------------------------------------

  // The sheet-id map the active-sheet lookup reads (@api/reportPages).
  cleanupFns.push(startWritebackStore());

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

  // THE CONTEXTUAL "Writeback" RIBBON TAB (lib/writebackTab.ts): shown while
  // Core's active cell is inside a subscribed writeback region on the active
  // sheet. Re-derived when the cursor moves, when a selection owner's claim
  // starts or ends (the tab stands aside for a floating grid's cell), when the
  // active sheet changes, and on every snapshot change below (a subscribe
  // bringing the first regions, a detach taking them away, a submit changing
  // the badge) -- none of which moves Core's cursor.
  cleanupFns.push(ExtensionRegistry.onSelectionChange(handleWritebackSelectionChange));
  cleanupFns.push(onSelectionOwnershipChanged(() => syncWritebackTabToRegions()));
  cleanupFns.push(
    context.events.on(AppEvents.SHEET_CHANGED, () => {
      syncWritebackTabToRegions();
      // The grid publishes the new sheet's context in the same task that
      // announced the switch; ask once more after it has.
      setTimeout(syncWritebackTabToRegions, 0);
    }),
  );
  cleanupFns.push(() => {
    resetWritebackTab();
    resetWritebackTabModel();
    resetCollectStreams();
  });

  // WRITEBACK > COLLECT FROM (lib/collectStreamsStore.ts): the one client copy
  // of which streams this workbook collects, shared by the tab's hero and the
  // Collected Responses pane. Read now, and again whenever the answer can have
  // changed -- a document opened or created, a region designated or removed (a
  // first publish creates the link) -- never on a cursor move.
  void refreshCollectStreams();
  // The events are listed in the store (COLLECT_STREAMS_REFRESH_EVENTS) --
  // including ENVIRONMENTS_CHANGED_EVENT, the only event a publish (the FIRST
  // publish creates the link), a pipeline edit and a promotion announce.
  cleanupFns.push(...wireCollectStreamsRefresh((eventName, cb) => context.events.on(eventName, cb)));

  // RIGHT-CLICK SUBMIT on a writeback cell -- the same action as the tab's
  // Submit hero (preview, confirm, send, re-read). Shown only on a cell of a
  // region; greyed with the reason when nothing in the region is unsent.
  const regionAtMenu = (ctx: GridMenuContext) => {
    if (!hasWritebackRegions()) return null;
    const cell =
      ctx.clickedCell ??
      (ctx.selection ? { row: ctx.selection.endRow, col: ctx.selection.endCol } : null);
    return cell ? getActiveRegionAt(cell.row, cell.col) : null;
  };
  gridExtensions.registerContextMenuItem({
    id: "collaboration:submitWritebackValues",
    label: "Submit Writeback Values",
    group: GridMenuGroups.DATA,
    order: 95,
    visible: (ctx) => regionAtMenu(ctx) !== null,
    disabled: (ctx) => {
      const region = regionAtMenu(ctx);
      return region === null || submitButtonState(getRegionSummary(region.regionId)).disabled;
    },
    disabledReason: (ctx) => {
      const region = regionAtMenu(ctx);
      if (!region) return null;
      const state = submitButtonState(getRegionSummary(region.regionId));
      return state.disabled ? state.tooltip : null;
    },
    onClick: async (ctx) => {
      const region = regionAtMenu(ctx);
      if (!region) return;
      await submitWritebackRegion(region.regionId);
    },
  });
  cleanupFns.push(() =>
    gridExtensions.unregisterContextMenuItem("collaboration:submitWritebackValues"),
  );

  // EVERY event after which the region index or the layer can differ re-reads
  // it. Subscribing used to be missing from this list: the dialog announces
  // PACKAGE_UPDATED, nothing here heard it, and a subscriber typed into a
  // freshly subscribed form with no guard, no draft and no marker -- "I cannot
  // see if it was written back". Requests in one task share one read
  // (refreshWriteback coalesces).
  const refreshOn = (eventName: string) =>
    cleanupFns.push(context.events.on(eventName, () => void refreshWriteback()));
  refreshOn(AppEvents.AFTER_OPEN);
  refreshOn(AppEvents.AFTER_NEW);
  // A pull (subscribe), a refresh or a tab-menu detach.
  refreshOn(AppEvents.PACKAGE_UPDATED);
  // A subscribed sheet deleted takes its regions with it.
  refreshOn(AppEvents.SHEET_DELETED);
  // The author designated, edited or removed one of this workbook's own
  // regions (the frame shows them too).
  refreshOn(WRITEBACK_REGIONS_CHANGED_EVENT);
  // Inserting or deleting rows/columns moves the author's own regions in the
  // backend (subscribed regions refuse structural edits). Only a workbook that
  // designated some re-reads.
  for (const structural of [
    AppEvents.ROWS_INSERTED,
    AppEvents.ROWS_DELETED,
    AppEvents.COLUMNS_INSERTED,
    AppEvents.COLUMNS_DELETED,
  ]) {
    cleanupFns.push(
      context.events.on(structural, () => {
        if (getDesignatedRegionCount() === 0) return;
        void refreshWriteback();
      }),
    );
  }
  // An environment switch can change the version, and with it the regions.
  refreshOn(ENVIRONMENTS_CHANGED_EVENT);
  // SHEET_CHANGED with NO sheet index is the "content replaced" announcement
  // (Detach All, reset aftermath, a data refresh). A tab click carries the index
  // and needs no read: the snapshot is keyed by sheet id and resolved at paint
  // time. Only a workbook that HAS regions re-reads -- the read reconciles with
  // the workspace, and a workbook without writeback must not pay for it on every
  // data refresh. (A subscribe that brings the first regions is PACKAGE_UPDATED.)
  cleanupFns.push(
    context.events.on(AppEvents.SHEET_CHANGED, (data: unknown) => {
      const payload = data as { sheetIndex?: unknown } | undefined;
      if (payload && typeof payload.sheetIndex === "number") return;
      if (!hasWritebackRegions()) return;
      void refreshWriteback();
    }),
  );
  // The backend's own announcement (bridged by the Shell): the deferred HTTP
  // half of an open landed. This extension announces the same event after each
  // read for the script host's cached copy, tagged with its source -- those are
  // ignored, or every read would trigger the next one.
  cleanupFns.push(
    context.events.on(WRITEBACK_INDEX_CHANGED_EVENT, (data: unknown) => {
      const payload = data as { source?: unknown } | undefined;
      if (payload && payload.source === WRITEBACK_STORE_EVENT_SOURCE) return;
      void refreshWriteback();
    }),
  );

  // RANGE GUARD. A single-cell entry (keystroke, F2, double-click, formula
  // bar -- operation "edit") is ALLOWED, so the commit guard below can save it
  // as a draft; before this, the guard refused the 1x1 range the editor asks
  // about and swallowed every keystroke on a writeback cell without a word.
  // Paste (even of one cell, which never reaches the commit guard), fill,
  // drag-move and structural operations over a region stay refused, with a
  // message that says why.
  const unregRangeGuard = context.grid.rangeGuards.register(
    (startRow, startCol, endRow, endCol, operation) => {
      if (!hasWritebackRegions()) return null;
      return decideWritebackRangeGuard(
        activeRangeOverlapsWriteback(startRow, startCol, endRow, endCol),
        startRow,
        startCol,
        endRow,
        endCol,
        operation,
      );
    },
  );
  cleanupFns.push(unregRangeGuard);

  // COMMIT GUARD: a value typed into a writeback cell is saved as a draft. The
  // normal cell update still proceeds (action = "allow"), so the cell shows it;
  // the draft is what Submit later sends.
  const unregCommitGuard = registerCommitGuard(async (row, col, value) => {
    if (!hasWritebackRegions()) return null;
    const region = getActiveRegionAt(row, col);
    if (!region) return null;

    // By the region's DECLARED type, in the APP locale (sv-SE "1,5" is a
    // number) -- see coerceWritebackInput.
    const submissionValue = coerceWritebackInput(value, region.valueType, { parseNumber });
    const trimmed = value.trim();

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

    // Save as draft -- if the backend rejects (schema validation, lifecycle
    // deadline, one-shot/locked regions), keep the user in edit mode. Falling
    // through to "allow" on a rejection would display a value that was never
    // saved as a draft and will never be submitted.
    let saved: Awaited<ReturnType<typeof saveWritebackDraft>>;
    try {
      saved = await saveWritebackDraft(region.regionId, region.sheetId, row, col, submissionValue);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[Collaboration] Writeback draft rejected:", msg);
      context.ui.notifications.showToast(msg, { type: "warning", duration: 5000 });
      return { action: "retry" as const };
    }
    // An `immediate` region SENDS on save: typing is submitting, and the
    // subscriber is told at the point of entry -- there is no marker for a sent
    // value, so without this the value would leave the machine unannounced. A
    // failed send kept the value as an unsent draft (the marker shows it).
    const application = regionApplicationName(region) || "the publisher";
    if (saved?.sent) {
      context.ui.notifications.showToast(
        `${cellA1(row, col)} sent to ${application}. The publisher can now see it.`,
        { type: "success", duration: 3000 },
      );
    } else if (saved?.sendError) {
      context.ui.notifications.showToast(
        `${cellA1(row, col)} was saved but not sent to ${application}: ${saved.sendError}. ` +
          `It is kept as an unsent value; Writeback > Submit sends it.`,
        { type: "warning", duration: 8000 },
      );
    }
    // Re-read so the draft marker, the tab and the pane follow; the store
    // repaints when the read lands. LOCAL only: the save changed the layer,
    // not the workspace, so a keystroke does not pay for a reconcile that
    // reads every subscribed application's workspace.
    void refreshWritebackLocal();

    // Allow the normal commit to proceed so the cell displays the value
    return { action: "allow" as const };
  });
  cleanupFns.push(unregCommitGuard);

  // GRID PAINTERS: one discreet "w" frame per region on the active sheet
  // (a layer under the selection) and a small state marker on unsent and
  // rejected cells (an over-selection decoration beside the note triangle).
  // Registered only while regions exist, so a workbook without writeback pays
  // nothing per frame. Colours come from the skin (the frame: the grid's cell
  // text colour at low alpha; the markers: the tone tokens), read per frame.
  let unregOutline: (() => void) | null = null;
  let unregMarkers: (() => void) | null = null;

  const outlinePaint = createWritebackOutlinePainter({
    regions: getActiveSheetFrameRegions,
    colors: () => {
      const text = getActiveGridTheme().cellText;
      return { line: text, glyph: text };
    },
    rectOf: rangeToCanvasRect,
  });
  const markerPaint = createWritebackDecoration({
    cellState: getActiveCellState,
    colors: () => {
      const tones = getCanvasToneColors();
      return {
        warn: tones.warnFg,
        danger: tones.dangerFg,
        background: getActiveGridTheme().cellBackground,
      };
    },
    pixelRatio: () => (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1),
  });

  function updateGridPainters(): void {
    // The FRAME is for every writeback region the author designated or a
    // subscription brought in; the state MARKERS only for subscribed regions,
    // the only ones that hold values.
    if (hasWritebackFrames()) {
      if (!unregOutline) {
        unregOutline = context.grid.layers.register({
          id: "collaboration:writeback-outline",
          anchor: "under-selection",
          priority: 10,
          paint: outlinePaint,
        });
      }
    } else if (unregOutline) {
      unregOutline();
      unregOutline = null;
    }
    if (hasWritebackRegions()) {
      if (!unregMarkers) {
        unregMarkers = context.grid.decorations.register(
          "collaboration:writeback-marker",
          markerPaint,
          6, // just after the note triangle (5): the note stays on top
          "over-selection",
        );
      }
    } else if (unregMarkers) {
      unregMarkers();
      unregMarkers = null;
    }
  }

  // Every snapshot change re-decides the painters (the store requests the
  // repaint itself, after its listeners ran). A NEW region list -- a read
  // landed, not just a sheet-map change -- also re-syncs the publisher's
  // validators and tells the script host's cached copy of the index.
  // Compared by CONTENT, not identity: every read installs a new frozen array,
  // so an identity check re-ran the validator sync (unmount + remount of every
  // Worker realm) and re-announced the index on every draft commit.
  let lastRegionKey: string | null = null;
  cleanupFns.push(
    subscribeWritebackSnapshot(() => {
      updateGridPainters();
      // The contextual tab and its badge follow the snapshot too.
      syncWritebackTabToRegions();
      const list = getWritebackRegionList();
      if (!isWritebackSnapshotLoaded()) return;
      const key = writebackRegionListKey(list);
      if (key === lastRegionKey) return;
      lastRegionKey = key;
      // Publisher-shipped custom validators. The AUTHORITATIVE run is Rust-side
      // at submit (same body, out of the Ed25519-verified manifest, in the
      // embedded QuickJS realm) and it fails CLOSED without the user's consent
      // -- so this pass exists to (a) collect the consent the backend demands
      // and (b) mount approved bodies for advisory as-you-type feedback. Never
      // allowed to break the refresh.
      void syncWritebackValidators([...list])
        .catch((err) => {
          console.warn("[Collaboration] writeback validator sync failed:", err);
        })
        .finally(() => {
          emitAppEvent(WRITEBACK_VALIDATORS_CHANGED_EVENT, {});
        });
      // The script host keeps its OWN copy of the region index, so a script
      // grid write can be routed into the same validated draft path without
      // one IPC per cell. (A stale copy fails CLOSED in Rust's
      // ensure_writeback_draft_before_write.) Tagged so the listener above
      // does not answer its own announcement.
      emitAppEvent(WRITEBACK_INDEX_CHANGED_EVENT, {
        regionCount: list.length,
        source: WRITEBACK_STORE_EVENT_SOURCE,
      });
    }),
  );

  cleanupFns.push(() => {
    if (unregOutline) {
      unregOutline();
      unregOutline = null;
    }
    if (unregMarkers) {
      unregMarkers();
      unregMarkers = null;
    }
  });

  // Tear down every mounted advisory validator worker on deactivate.
  cleanupFns.push(() => resetWritebackValidators());

  // The Application Inspector runs in its OWN Tauri window with no Shell and no
  // extensions, so the form renderer it needs lives only HERE. It sends the
  // source; this listener runs the preview, paints it in this window, and
  // sends the outcome back for the inspector to render inline.
  cleanupFns.push(installInspectorFormPreviewBridge());

  // Initial snapshot load (in case subscriptions already exist at startup)
  void refreshWriteback();

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
      console.error("[Collaboration] a deactivate cleanup threw; continuing", error);
    }
  }
  cleanupFns.length = 0;
  resetWritebackSnapshot();
  isActivated = false;
}

const extension: ExtensionModule = {
  manifest: CollaborationManifest,
  activate,
  deactivate,
};

export default extension;
