//! FILENAME: app/extensions/Table/index.ts
// PURPOSE: Table extension entry point.
// CONTEXT: Registers all table functionality with the extension system.

import {
  ExtensionRegistry,
  DialogExtensions,
  onAppEvent,
  emitAppEvent,
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
  convertFormulaToTableRefsAsync,
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

  // Refresh table cache when the active sheet changes so tables from
  // the previous sheet are removed and the new sheet's tables are loaded.
  cleanupFunctions.push(
    onAppEvent(AppEvents.SHEET_CHANGED, () => {
      refreshCache().catch(console.error);
    }),
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
      // Convert cell references to structured table references (e.g., =B2+C2 -> =[@Price]+[@Qty])
      const converted = await convertFormulaToTableRefsAsync(table.id, value, row);
      // Only auto-fill if the column doesn't already have a calculated formula
      // or if the formula is different from the current one
      if (!column.calculatedFormula || column.calculatedFormula !== converted) {
        await setCalculatedColumnAsync(table.id, column.name, converted);
        emitAppEvent(AppEvents.GRID_DATA_REFRESH);
      }
    }
    return;
  }

  // Check for auto-expansion (cell is adjacent to a table)
  if (!table) {
    const expanded = await checkAutoExpand(row, col);
    if (expanded) {
      console.log(`[Table] Auto-expand triggered at (${row},${col}), table now: rows=${expanded.startRow}-${expanded.endRow}, cols=${expanded.startCol}-${expanded.endCol}, columns:`, expanded.columns.map(c => c.name));
      syncTableRegions();

      // If the cell that triggered expansion contains a formula, set it as a
      // calculated column so it auto-fills to all data rows in the table.
      if (value.startsWith("=")) {
        const dataStartRow = expanded.startRow + (expanded.styleOptions.headerRow ? 1 : 0);
        if (row >= dataStartRow && row <= expanded.endRow) {
          const colIndex = col - expanded.startCol;
          console.log(`[Table] Formula auto-expand: colIndex=${colIndex}, columns.length=${expanded.columns.length}, value="${value}"`);
          if (colIndex >= 0 && colIndex < expanded.columns.length) {
            const column = expanded.columns[colIndex];
            // Convert cell references to structured table references
            const converted = await convertFormulaToTableRefsAsync(expanded.id, value, row);
            console.log(`[Table] Converted formula: "${value}" -> "${converted}"`);
            await setCalculatedColumnAsync(expanded.id, column.name, converted);
          }
        }
      }

      // Notify that table definitions changed so AutoFilter and other listeners refresh
      emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);

      // Re-fetch viewport data and repaint to show computed values + table styling.
      // Uses GRID_DATA_REFRESH which re-fetches cells from backend (unlike GRID_REFRESH
      // which only repaints with stale data). The pendingRefreshRef mechanism in
      // GridCanvas handles the case where a fetch is already in progress.
      emitAppEvent(AppEvents.GRID_DATA_REFRESH);
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
