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
  refreshCache,
  getTableAtCell,
  getTableById,
  checkAutoExpand,
  enforceHeaderAsync,
  resizeTableAsync,
  setCalculatedColumnAsync,
} from "./lib/tableStore";
import { drawTableBorder, hitTestTable } from "./lib/tableOverlayRenderer";
import { registerTableStyleInterceptor } from "./lib/tableStyleInterceptor";
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

  // Register style interceptor for table formatting (header, banded rows, etc.)
  cleanupFunctions.push(registerTableStyleInterceptor());

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
    refreshCache().catch(console.error);
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

    resizeTableAsync(
      tableId,
      table.startRow,
      table.startCol,
      detail.endRow,
      detail.endCol,
    ).then(() => {
      refreshCache().catch(console.error);
    });
  };
  window.addEventListener("overlay:resizeComplete", handleOverlayResizeComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("overlay:resizeComplete", handleOverlayResizeComplete);
  });

  // Listen for structural changes (row/column insert/delete) to refresh cache
  cleanupFunctions.push(
    onAppEvent<{ row: number; count: number }>(AppEvents.ROWS_INSERTED, () => {
      refreshCache().catch(console.error);
    }),
  );
  cleanupFunctions.push(
    onAppEvent<{ col: number; count: number }>(AppEvents.COLUMNS_INSERTED, () => {
      refreshCache().catch(console.error);
    }),
  );
  cleanupFunctions.push(
    onAppEvent<{ row: number; count: number }>(AppEvents.ROWS_DELETED, () => {
      refreshCache().catch(console.error);
    }),
  );
  cleanupFunctions.push(
    onAppEvent<{ col: number; count: number }>(AppEvents.COLUMNS_DELETED, () => {
      refreshCache().catch(console.error);
    }),
  );

  // Listen for cell updates to handle auto-expansion and header enforcement
  cleanupFunctions.push(
    onAppEvent<{ row: number; col: number; value?: string }>(
      AppEvents.CELLS_UPDATED,
      (detail) => {
        // CELLS_UPDATED may carry a single cell or batch info
        if (detail && typeof detail === "object" && "row" in detail && "col" in detail) {
          handleCellEdited(detail.row, detail.col, detail.value ?? "");
        }
      },
    ),
  );

  // Also listen for EDIT_ENDED which fires when the user commits an edit
  cleanupFunctions.push(
    onAppEvent<{ row: number; col: number; value?: string }>(
      AppEvents.EDIT_ENDED,
      (detail) => {
        if (detail && typeof detail === "object" && "row" in detail && "col" in detail) {
          handleCellEdited(detail.row, detail.col, detail.value ?? "");
        }
      },
    ),
  );

  // Subscribe to selection changes to show/hide the Table menu
  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange),
  );

  // Initial cache load
  refreshCache().catch(console.error);

  console.log("[Table Extension] Registered successfully");
}

/**
 * Handle cell edit events for auto-expansion and header uniqueness.
 */
async function handleCellEdited(row: number, col: number, value: string): Promise<void> {
  // Check if the edited cell is a table header
  const table = getTableAtCell(row, col);
  if (table && table.styleOptions.headerRow && row === table.startRow) {
    // Header cell was edited - enforce uniqueness
    const colIndex = col - table.startCol;
    await enforceHeaderAsync(table.id, colIndex, value);
    return;
  }

  // Check for calculated column (formula entered in a table data cell)
  if (table && value.startsWith("=") && row >= table.startRow + (table.styleOptions.headerRow ? 1 : 0)) {
    const colIndex = col - table.startCol;
    if (colIndex >= 0 && colIndex < table.columns.length) {
      const column = table.columns[colIndex];
      // Only auto-fill if the column doesn't already have a calculated formula
      // or if the formula is different from the current one
      if (!column.calculatedFormula || column.calculatedFormula !== value) {
        await setCalculatedColumnAsync(table.id, column.name, value);
      }
    }
    return;
  }

  // Check for auto-expansion (cell is adjacent to a table)
  if (!table) {
    const expanded = await checkAutoExpand(row, col);
    if (expanded) {
      syncTableRegions();
    }
  }
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
