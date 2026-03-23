//! FILENAME: app/extensions/ReportStore/index.ts
// PURPOSE: Report Store extension entry point.
// CONTEXT: Registers package browsing, import, and export functionality.

import {
  DialogExtensions,
  registerMenuItem,
} from "../../src/api";
import {
  registerRegistryProvider,
  unregisterRegistryProvider,
} from "../../src/api/distribution";

import {
  ReportStoreManifest,
  BrowseDialogDefinition,
  ExportDialogDefinition,
  BindingDialogDefinition,
  BROWSE_DIALOG_ID,
  EXPORT_DIALOG_ID,
} from "./manifest";
import { HttpRegistryProvider } from "./lib/providers/httpRegistryProvider";

const cleanupFunctions: Array<() => void> = [];

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

export function registerReportStoreExtension(): void {
  console.log(`[${ReportStoreManifest.name}] Registering extension...`);

  // Register dialogs
  DialogExtensions.registerDialog(BrowseDialogDefinition);
  DialogExtensions.registerDialog(ExportDialogDefinition);
  DialogExtensions.registerDialog(BindingDialogDefinition);

  // Add menu items
  // "Insert > From Package..." to open the browse dialog
  registerMenuItem("insert", {
    id: "report-store.import",
    label: "From Package...",
    action: () => {
      DialogExtensions.openDialog(BROWSE_DIALOG_ID);
    },
  });

  // "Insert > Export as Package..." to open the export dialog
  registerMenuItem("insert", {
    id: "report-store.export",
    label: "Export as Package...",
    action: () => {
      DialogExtensions.openDialog(EXPORT_DIALOG_ID, {
        sheetIndices: [0], // Default to active sheet
      });
    },
  });

  // DEV: Register a default local registry for testing.
  // Remove or make configurable before release.
  addHttpRegistry("local-dev", "Local Registry (dev)", "http://localhost:8080");

  console.log(`[${ReportStoreManifest.name}] Extension registered`);
}

export function unregisterReportStoreExtension(): void {
  console.log(`[${ReportStoreManifest.name}] Unregistering extension...`);

  // Run cleanup functions in reverse order
  for (let i = cleanupFunctions.length - 1; i >= 0; i--) {
    cleanupFunctions[i]();
  }
  cleanupFunctions.length = 0;

  // Unregister dev registry
  removeHttpRegistry("local-dev");

  // Unregister dialogs
  DialogExtensions.unregisterDialog(BrowseDialogDefinition.id);
  DialogExtensions.unregisterDialog(ExportDialogDefinition.id);
  DialogExtensions.unregisterDialog(BindingDialogDefinition.id);

  console.log(`[${ReportStoreManifest.name}] Extension unregistered`);
}
