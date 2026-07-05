//! FILENAME: app/extensions/Checkbox/index.ts
// PURPOSE: In-Cell Checkbox extension entry point. Registers/unregisters all components.
// CONTEXT: Loaded by the ExtensionManager during app initialization.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  AppEvents,
} from "@api";
import { drawCheckbox } from "./rendering";
import {
  checkboxStyleInterceptor,
  checkboxClickInterceptor,
  toggleCheckboxesInSelection,
  handleCellChange,
  setCurrentSelection,
  refreshStyleCache,
  checkboxStyleIndices,
} from "./interceptors";

// ============================================================================
// Command Registration
// ============================================================================

/** Command ID for checkbox toggling (dispatched by Spacebar in useGridKeyboard) */
const CHECKBOX_TOGGLE_COMMAND = "checkbox.toggle";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[Checkbox] Activating...");

  // 1. Register cell decoration for rendering checkboxes
  const unregDecoration = context.grid.decorations.register("checkbox", drawCheckbox, 10);
  cleanupFns.push(unregDecoration);

  // 2. Register style interceptor to suppress TRUE/FALSE text
  const unregStyleInterceptor = context.grid.styleInterceptors.register(
    "checkbox",
    checkboxStyleInterceptor,
    5, // Run before conditional formatting (priority 10)
  );
  cleanupFns.push(unregStyleInterceptor);

  // 3. Register cell click interceptor for toggling
  const unregClickInterceptor = context.grid.cellClicks.registerClickInterceptor(checkboxClickInterceptor);
  cleanupFns.push(unregClickInterceptor);

  // 4. Track selection changes for Spacebar toggling
  const unregSelectionChange = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(sel);
  });
  cleanupFns.push(unregSelectionChange);

  // 5. Handle cell value changes (non-boolean input destroys checkbox, delete clears)
  const unregCellChange = ExtensionRegistry.onCellChange(
    (row, col, oldValue, newValue) => {
      handleCellChange(row, col, oldValue, newValue);
    }
  );
  cleanupFns.push(unregCellChange);

  // 6. Refresh style cache on data/style changes
  const unregDataChanged = context.events.on(AppEvents.DATA_CHANGED, () => {
    refreshStyleCache();
  });
  cleanupFns.push(unregDataChanged);

  // 7. Register the toggle command handler
  ExtensionRegistry.registerCommand({
    id: CHECKBOX_TOGGLE_COMMAND,
    name: "Toggle Checkbox",
    execute: async () => {
      await toggleCheckboxesInSelection();
    },
  });

  // 8. (Removed) The Insert > Controls > Checkbox menu item now lives in the
  // CellTypes extension ("Insert > Cell Type > Checkbox", cell-type brick).
  // Legacy style-flag checkboxes keep rendering/toggling for existing
  // workbooks until this extension is retired.

  // 9. Register cursor change for checkbox cells
  const unregCursor = setupCheckboxCursor();
  cleanupFns.push(unregCursor);

  // 10. Initial style cache load
  refreshStyleCache();

  console.log("[Checkbox] Activated successfully");
}

// ============================================================================
// Cursor Change for Checkbox Cells
// ============================================================================

/**
 * Set up a mousemove listener that changes the cursor to "default" (arrow)
 * when hovering over a checkbox cell, instead of the standard "cell" crosshair.
 * Sets cursor on the canvas element (child overrides parent container cursor).
 */
function setupCheckboxCursor(): () => void {
  let lastCanvas: HTMLCanvasElement | null = null;
  let pendingLookup = false;

  const handleMouseMove = async (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLCanvasElement)) {
      if (lastCanvas) {
        lastCanvas.style.cursor = "";
        lastCanvas = null;
      }
      return;
    }

    // Quick exit: no checkbox styles registered at all
    if (checkboxStyleIndices.size === 0) {
      if (lastCanvas) {
        target.style.cursor = "";
        lastCanvas = null;
      }
      return;
    }

    // Throttle: skip if a lookup is already in flight
    if (pendingLookup) return;
    pendingLookup = true;

    try {
      const { getCellFromPixel, getGridStateSnapshot } = await import("../../src/api/grid");
      const { getCell } = await import("../../src/api/lib");

      const gridState = getGridStateSnapshot();
      if (!gridState) return;

      const rect = target.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      const cell = getCellFromPixel(mouseX, mouseY, gridState.config, gridState.viewport, gridState.dimensions);
      if (!cell) {
        if (lastCanvas) {
          target.style.cursor = "";
          lastCanvas = null;
        }
        return;
      }

      const cellData = await getCell(cell.row, cell.col);
      if (cellData && checkboxStyleIndices.has(cellData.styleIndex)) {
        target.style.cursor = "default";
        lastCanvas = target;
      } else {
        if (lastCanvas) {
          target.style.cursor = "";
          lastCanvas = null;
        }
      }
    } finally {
      pendingLookup = false;
    }
  };

  document.addEventListener("mousemove", handleMouseMove);
  return () => {
    document.removeEventListener("mousemove", handleMouseMove);
  };
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[Checkbox] Deactivating...");
  for (const cleanup of cleanupFns) {
    cleanup();
  }
  cleanupFns.length = 0;
  console.log("[Checkbox] Deactivated");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.checkbox",
    name: "Checkbox",
    version: "1.0.0",
    description: "In-cell checkbox controls for boolean data entry.",
  },
  activate,
  deactivate,
};

export default extension;
