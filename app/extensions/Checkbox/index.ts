//! FILENAME: app/extensions/Checkbox/index.ts
// PURPOSE: In-Cell Checkbox extension entry point. Registers/unregisters all components.
// CONTEXT: Called from extensions/index.ts during app initialization.

import {
  registerCellClickInterceptor,
  registerStyleInterceptor,
  registerMenuItem,
  ExtensionRegistry,
  onAppEvent,
  AppEvents,
} from "../../src/api";
import { registerCellDecoration } from "../../src/api/cellDecorations";
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
// Registration
// ============================================================================

export function registerCheckboxExtension(): void {
  console.log("[Checkbox] Registering...");

  // 1. Register cell decoration for rendering checkboxes
  const unregDecoration = registerCellDecoration("checkbox", drawCheckbox, 10);
  cleanupFns.push(unregDecoration);

  // 2. Register style interceptor to suppress TRUE/FALSE text
  const unregStyleInterceptor = registerStyleInterceptor(
    "checkbox",
    checkboxStyleInterceptor,
    5, // Run before conditional formatting (priority 10)
  );
  cleanupFns.push(unregStyleInterceptor);

  // 3. Register cell click interceptor for toggling
  const unregClickInterceptor = registerCellClickInterceptor(checkboxClickInterceptor);
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
  const unregDataChanged = onAppEvent(AppEvents.DATA_CHANGED, () => {
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

  // 8. Register Insert > Controls > Checkbox menu item
  registerMenuItem("insert", {
    id: "insert.controls",
    label: "Controls",
    children: [
      {
        id: "insert.controls.checkbox",
        label: "Checkbox",
        action: insertCheckbox,
      },
    ],
  });

  // 9. Register cursor change for checkbox cells
  const unregCursor = setupCheckboxCursor();
  cleanupFns.push(unregCursor);

  // 10. Initial style cache load
  refreshStyleCache();

  console.log("[Checkbox] Registered successfully");
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
// Insert Checkbox Action
// ============================================================================

/**
 * Insert checkbox formatting on the current selection.
 * Applies checkbox=true style and sets empty cells to FALSE.
 */
async function insertCheckbox(): Promise<void> {
  const { applyFormatting, getCell, updateCell } = await import("../../src/api/lib");
  const { dispatchGridAction } = await import("../../src/api/gridDispatch");
  const { restoreFocusToGrid } = await import("../../src/api/events");

  // Get current selection from the tracked state
  const { getCurrentSelection } = await import("./interceptors");
  const sel = getCurrentSelection();
  if (!sel) return;

  const minRow = Math.min(sel.startRow, sel.endRow);
  const maxRow = Math.max(sel.startRow, sel.endRow);
  const minCol = Math.min(sel.startCol, sel.endCol);
  const maxCol = Math.max(sel.startCol, sel.endCol);

  // Collect all rows and cols for formatting
  const rows: number[] = [];
  const cols: number[] = [];
  for (let r = minRow; r <= maxRow; r++) rows.push(r);
  for (let c = minCol; c <= maxCol; c++) cols.push(c);

  // Apply checkbox formatting
  await applyFormatting(rows, cols, { checkbox: true });

  // Set empty cells to FALSE so they show an unchecked box instead of ghost
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      const cellData = await getCell(r, c);
      if (!cellData || cellData.display === "") {
        await updateCell(r, c, "FALSE");
      }
    }
  }

  // Refresh style caches (extension-level + renderer-level) and restore focus
  await refreshStyleCache();
  window.dispatchEvent(new CustomEvent("styles:refresh"));
  restoreFocusToGrid();
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterCheckboxExtension(): void {
  console.log("[Checkbox] Unregistering...");
  for (const cleanup of cleanupFns) {
    cleanup();
  }
  cleanupFns.length = 0;
  console.log("[Checkbox] Unregistered");
}
