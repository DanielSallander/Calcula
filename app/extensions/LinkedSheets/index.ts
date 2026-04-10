// FILENAME: app/extensions/LinkedSheets/index.ts
// PURPOSE: Linked Sheets extension entry point (ExtensionModule pattern).
//          Provides centralized report distribution: publish, link, refresh.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { DialogExtensions, emitAppEvent, onAppEvent, AppEvents } from "@api";
import {
  refreshAllLinkedSheets,
  getLinkedSheets,
} from "@api/linkedSheets";

import {
  LinkedSheetsManifest,
  PublishDialogDefinition,
  BrowseLinkedDialogDefinition,
  PUBLISH_DIALOG_ID,
  BROWSE_LINKED_DIALOG_ID,
} from "./manifest";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn(`[${LinkedSheetsManifest.name}] Already activated, skipping.`);
    return;
  }

  console.log(`[${LinkedSheetsManifest.name}] Activating...`);

  // Register dialogs
  context.ui.dialogs.register(PublishDialogDefinition);
  context.ui.dialogs.register(BrowseLinkedDialogDefinition);

  // "Data > Publish Sheets..." to open the publish dialog
  context.ui.menus.registerItem("data", {
    id: "linked-sheets.publish",
    label: "Publish Sheets...",
    action: () => {
      context.ui.dialogs.show(PUBLISH_DIALOG_ID);
    },
  });

  // "Data > Link Sheets from Model..." to open the browse/link dialog
  context.ui.menus.registerItem("data", {
    id: "linked-sheets.link",
    label: "Link Sheets from Model...",
    action: () => {
      context.ui.dialogs.show(BROWSE_LINKED_DIALOG_ID);
    },
  });

  // "Data > Refresh Linked Sheets" to refresh all linked sheets
  context.ui.menus.registerItem("data", {
    id: "linked-sheets.refresh",
    label: "Refresh Linked Sheets",
    action: async () => {
      try {
        const results = await refreshAllLinkedSheets();
        const updated = results.filter((r) => r.updated).length;
        const warnings = results.flatMap((r) => r.warnings);

        if (warnings.length > 0) {
          console.warn(
            `[${LinkedSheetsManifest.name}] Refresh warnings:`,
            warnings
          );
        }

        console.log(
          `[${LinkedSheetsManifest.name}] Refreshed: ${updated} updated, ${results.length - updated} unchanged`
        );

        emitAppEvent(AppEvents.LINKED_SHEETS_REFRESHED, { results });

        // Reload to reflect changes if any sheets were updated
        if (updated > 0) {
          window.location.reload();
        }
      } catch (e) {
        console.error(`[${LinkedSheetsManifest.name}] Refresh failed:`, e);
      }
    },
  });

  // Auto-refresh on workbook open
  const unlistenAfterOpen = onAppEvent(AppEvents.AFTER_OPEN, async () => {
    try {
      const linked = await getLinkedSheets();
      if (linked.length === 0) return;

      console.log(
        `[${LinkedSheetsManifest.name}] Auto-refreshing ${linked.length} linked sheet(s)...`
      );
      const results = await refreshAllLinkedSheets();
      const updated = results.filter((r) => r.updated).length;
      const unavailable = results.filter(
        (r) => r.warnings.some((w) => w.includes("Failed to refresh"))
      ).length;

      if (unavailable > 0) {
        console.warn(
          `[${LinkedSheetsManifest.name}] ${unavailable} linked sheet(s) could not be refreshed (source unavailable)`
        );
      }

      if (updated > 0) {
        console.log(
          `[${LinkedSheetsManifest.name}] Auto-refresh: ${updated} sheet(s) updated`
        );
        emitAppEvent(AppEvents.LINKED_SHEETS_REFRESHED, { results });
      }
    } catch (e) {
      console.error(
        `[${LinkedSheetsManifest.name}] Auto-refresh failed:`,
        e
      );
    }
  });
  cleanupFns.push(unlistenAfterOpen);

  isActivated = true;
  console.log(`[${LinkedSheetsManifest.name}] Activated successfully.`);
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log(`[${LinkedSheetsManifest.name}] Deactivating...`);

  // Unregister dialogs
  DialogExtensions.unregisterDialog(PublishDialogDefinition.id);
  DialogExtensions.unregisterDialog(BrowseLinkedDialogDefinition.id);

  // Cleanup event listeners
  for (const fn of cleanupFns) {
    fn();
  }
  cleanupFns.length = 0;

  isActivated = false;
  console.log(`[${LinkedSheetsManifest.name}] Deactivated.`);
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: LinkedSheetsManifest.id,
    name: LinkedSheetsManifest.name,
    version: LinkedSheetsManifest.version,
    description: LinkedSheetsManifest.description,
  },
  activate,
  deactivate,
};

export default extension;
