//! FILENAME: app/extensions/ReportStore/index.ts
// PURPOSE: Report Store extension entry point (ExtensionModule pattern).
//          Registers package browsing, import, and export functionality.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { DialogExtensions } from "@api/ui";
import {
  registerRegistryProvider,
  unregisterRegistryProvider,
} from "@api/distribution";

import {
  ReportStoreManifest,
  BrowseDialogDefinition,
  ExportDialogDefinition,
  BindingDialogDefinition,
  BROWSE_DIALOG_ID,
  EXPORT_DIALOG_ID,
} from "./manifest";
import { HttpRegistryProvider } from "./lib/providers/httpRegistryProvider";

// ============================================================================
// State
// ============================================================================

let isActivated = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Add an HTTP registry provider.
 * Call this from settings or configuration UI to connect to a remote registry.
 */
export function addHttpRegistry(id: string, name: string, baseUrl: string): void {
  const provider = new HttpRegistryProvider(id, name, baseUrl);
  registerRegistryProvider(provider);
  console.log(`[${ReportStoreManifest.name}] Registered HTTP registry: ${name} (${baseUrl})`);
}

/**
 * Remove a previously registered HTTP registry provider.
 */
export function removeHttpRegistry(id: string): void {
  unregisterRegistryProvider(id);
  console.log(`[${ReportStoreManifest.name}] Unregistered HTTP registry: ${id}`);
}

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn(`[${ReportStoreManifest.name}] Already activated, skipping.`);
    return;
  }

  console.log(`[${ReportStoreManifest.name}] Activating...`);

  // Register dialogs
  context.ui.dialogs.register(BrowseDialogDefinition);
  context.ui.dialogs.register(ExportDialogDefinition);
  context.ui.dialogs.register(BindingDialogDefinition);

  // Add menu items
  // "Insert > From Package..." to open the browse dialog
  context.ui.menus.registerItem("insert", {
    id: "report-store.import",
    label: "From Package...",
    action: () => {
      context.ui.dialogs.show(BROWSE_DIALOG_ID);
    },
  });

  // "Insert > Export as Package..." to open the export dialog
  context.ui.menus.registerItem("insert", {
    id: "report-store.export",
    label: "Export as Package...",
    action: () => {
      context.ui.dialogs.show(EXPORT_DIALOG_ID, {
        sheetIndices: [0], // Default to active sheet
      });
    },
  });

  // DEV: Register a default local registry for testing.
  // Remove or make configurable before release.
  addHttpRegistry("local-dev", "Local Registry (dev)", "http://localhost:8080");

  isActivated = true;
  console.log(`[${ReportStoreManifest.name}] Activated successfully.`);
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log(`[${ReportStoreManifest.name}] Deactivating...`);

  // Unregister dev registry
  removeHttpRegistry("local-dev");

  // Unregister dialogs
  DialogExtensions.unregisterDialog(BrowseDialogDefinition.id);
  DialogExtensions.unregisterDialog(ExportDialogDefinition.id);
  DialogExtensions.unregisterDialog(BindingDialogDefinition.id);

  isActivated = false;
  console.log(`[${ReportStoreManifest.name}] Deactivated.`);
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.report-store",
    name: "Report Store",
    version: "1.0.0",
    description: "Package browsing, import, and export for report distribution.",
  },
  activate,
  deactivate,
};

export default extension;
