//! FILENAME: app/extensions/Table/index.ts
// PURPOSE: Table extension entry point.
// CONTEXT: Registers all table functionality with the extension system.

import {
  ExtensionRegistry,
  DialogExtensions,
  onAppEvent,
  AppEvents,
} from "../../src/api";
import { registerMenu } from "../../src/api/ui";
import {
  registerGridOverlay,
  removeGridRegionsByType,
  type OverlayRenderContext,
} from "../../src/api/gridOverlays";

import {
  TableManifest,
  TableDialogDefinition,
  TABLE_DIALOG_ID,
} from "./manifest";

import {
  handleSelectionChange,
  resetSelectionHandlerState,
} from "./handlers/selectionHandler";
import { buildTableMenu } from "./handlers/tableMenuBuilder";
import {
  resetTableStore,
  syncTableRegions,
  resizeTable,
  getTableById,
  shiftTablesForRowInsert,
  shiftTablesForColInsert,
  shiftTablesForRowDelete,
  shiftTablesForColDelete,
} from "./lib/tableStore";
import { drawTableBorder, hitTestTable } from "./lib/tableOverlayRenderer";
import { TableEvents } from "./lib/tableEvents";

// ============================================================================
// Extension Lifecycle
// ============================================================================

let cleanupFunctions: Array<() => void> = [];

/**
 * Register the table extension.
 * Call this during application initialization.
 */
export function registerTableExtension(): void {
  console.log("[Table Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(TableManifest);

  // Register dialog
  DialogExtensions.registerDialog(TableDialogDefinition);

  // Register the contextual Table menu (initially hidden)
  registerMenu(buildTableMenu(null, true));

  // Register grid overlay renderer for table borders
  cleanupFunctions.push(
    registerGridOverlay({
      type: "table",
      render: (ctx: OverlayRenderContext) => {
        drawTableBorder(ctx);
      },
      hitTest: hitTestTable,
      priority: 5,
    })
  );

  // Sync table regions to grid overlay system when tables change
  const handleTableChanged = () => {
    syncTableRegions();
  };

  window.addEventListener(TableEvents.TABLE_CREATED, handleTableChanged);
  window.addEventListener(TableEvents.TABLE_DEFINITIONS_UPDATED, handleTableChanged);
  cleanupFunctions.push(() => {
    window.removeEventListener(TableEvents.TABLE_CREATED, handleTableChanged);
    window.removeEventListener(TableEvents.TABLE_DEFINITIONS_UPDATED, handleTableChanged);
  });

  // Listen for overlay resize completion to resize tables via drag handle
  const handleOverlayResizeComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.regionType !== "table") return;

    const tableId = detail.data?.tableId;
    if (tableId == null) return;

    const table = getTableById(tableId);
    if (!table) return;

    resizeTable(tableId, detail.endRow, detail.endCol);
    syncTableRegions();
  };
  window.addEventListener("overlay:resizeComplete", handleOverlayResizeComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("overlay:resizeComplete", handleOverlayResizeComplete);
  });

  // Listen for structural changes (row/column insert/delete) to update table boundaries
  cleanupFunctions.push(
    onAppEvent<{ row: number; count: number }>(AppEvents.ROWS_INSERTED, ({ row, count }) => {
      shiftTablesForRowInsert(row, count);
      syncTableRegions();
    }),
  );
  cleanupFunctions.push(
    onAppEvent<{ col: number; count: number }>(AppEvents.COLUMNS_INSERTED, ({ col, count }) => {
      shiftTablesForColInsert(col, count);
      syncTableRegions();
    }),
  );
  cleanupFunctions.push(
    onAppEvent<{ row: number; count: number }>(AppEvents.ROWS_DELETED, ({ row, count }) => {
      shiftTablesForRowDelete(row, count);
      syncTableRegions();
    }),
  );
  cleanupFunctions.push(
    onAppEvent<{ col: number; count: number }>(AppEvents.COLUMNS_DELETED, ({ col, count }) => {
      shiftTablesForColDelete(col, count);
      syncTableRegions();
    }),
  );

  // Subscribe to selection changes to show/hide the Table menu
  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange),
  );

  console.log("[Table Extension] Registered successfully");
}

/**
 * Unregister the table extension.
 * Call this during application shutdown or hot reload.
 */
export function unregisterTableExtension(): void {
  console.log("[Table Extension] Unregistering...");

  // Cleanup event listeners
  cleanupFunctions.forEach((fn) => fn());
  cleanupFunctions = [];

  // Reset handler state
  resetSelectionHandlerState();
  resetTableStore();

  // Remove table overlay regions
  removeGridRegionsByType("table");

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(TableManifest.id);
  DialogExtensions.unregisterDialog(TABLE_DIALOG_ID);

  console.log("[Table Extension] Unregistered successfully");
}

// Re-export for convenience
export { TABLE_DIALOG_ID };
