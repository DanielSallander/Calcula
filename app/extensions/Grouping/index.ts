//! FILENAME: app/extensions/Grouping/index.ts
// PURPOSE: Grouping/Outline extension entry point.
// CONTEXT: Registers the outline bar renderer, context menu items, Data menu items,
//          and outline bar click handler (for +/- buttons and level buttons).
//          Called from extensions/index.ts during app initialization.

import {
  registerPostHeaderOverlay,
  onAppEvent,
  AppEvents,
  ExtensionRegistry,
  DialogExtensions,
} from "../../src/api";
import { GroupSettingsDialog } from "./components/GroupSettingsDialog";
import { renderOutlineBar, buttonPosForLevel } from "./rendering/outlineBarRenderer";
import {
  resetGroupingState,
  performGroupRows,
  performUngroupRows,
  performGroupColumns,
  performUngroupColumns,
  performCollapseRow,
  performExpandRow,
  performCollapseColumn,
  performExpandColumn,
  performShowLevel,
  performShowColLevel,
  getCurrentOutlineInfo,
  getLastRenderedState,
} from "./lib/groupingStore";
import {
  registerGroupingMenuItems,
  registerGroupingContextMenuItems,
} from "./handlers/dataMenuBuilder";

// ============================================================================
// Constants (must match outlineBarRenderer.ts)
// ============================================================================

const LEVEL_BTN_SIZE = 14;
const LEVEL_BTN_GAP = 2;
const BUTTON_SIZE = 13;

// ============================================================================
// State
// ============================================================================

/** Current selection snapshot (updated via ExtensionRegistry.onSelectionChange). */
let currentSelection: {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  type?: string;
} | null = null;

/** Cleanup functions for all registered listeners. */
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Outline Bar Hit Testing
// ============================================================================

/**
 * Handle a mousedown event on the grid canvas.
 * Checks whether the click landed on a level button or +/- button
 * in the row or column outline bar.
 */
function handleOutlineBarClick(event: MouseEvent): void {
  const { rowYMap, colXMap, outlineBarW, outlineBarH, colHeaderH, rowHeaderW } =
    getLastRenderedState();

  if (outlineBarW <= 0 && outlineBarH <= 0) return;

  const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const clickX = event.clientX - rect.left;
  const clickY = event.clientY - rect.top;

  if (clickX < 0 || clickY < 0) return;

  const info = getCurrentOutlineInfo();
  if (!info) return;

  // =========================================================================
  // Row outline bar (left side, x < outlineBarW)
  // =========================================================================
  if (outlineBarW > 0 && clickX < outlineBarW) {
    event.preventDefault();
    event.stopPropagation();

    // Level buttons (in corner area, y < colHeaderH)
    if (clickY < colHeaderH && info.maxRowLevel > 0) {
      for (let lvl = 1; lvl <= info.maxRowLevel; lvl++) {
        const btnX = (lvl - 1) * (LEVEL_BTN_SIZE + LEVEL_BTN_GAP) + 2;
        if (clickX >= btnX && clickX < btnX + LEVEL_BTN_SIZE) {
          performShowLevel(lvl);
          return;
        }
      }
      return;
    }

    // +/- toggle buttons (y >= colHeaderH)
    if (clickY >= colHeaderH && info.rowSymbols.length > 0) {
      for (const sym of info.rowSymbols) {
        if (!sym.isButtonRow || sym.level === 0) continue;

        const rowY = rowYMap.get(sym.row);
        if (rowY === undefined) continue;

        const btnCx = buttonPosForLevel(sym.level);
        const hitZone = BUTTON_SIZE / 2 + 2;

        // Find row height from the map
        let rowHeight = 24;
        for (const [r, ry] of rowYMap) {
          if (r > sym.row && ry > rowY) {
            rowHeight = ry - rowY;
            break;
          }
        }

        const btnCy = rowY + rowHeight / 2;

        if (
          Math.abs(clickX - btnCx) <= hitZone &&
          Math.abs(clickY - btnCy) <= hitZone
        ) {
          if (sym.isCollapsed) {
            performExpandRow(sym.row);
          } else {
            performCollapseRow(sym.row);
          }
          return;
        }
      }
    }
    return;
  }

  // =========================================================================
  // Column outline bar (top side, y < outlineBarH)
  // =========================================================================
  if (outlineBarH > 0 && clickY < outlineBarH) {
    event.preventDefault();
    event.stopPropagation();

    // Level buttons (in corner area, x < rowHeaderW)
    if (clickX < rowHeaderW && info.maxColLevel > 0) {
      for (let lvl = 1; lvl <= info.maxColLevel; lvl++) {
        const btnY = (lvl - 1) * (LEVEL_BTN_SIZE + LEVEL_BTN_GAP) + 2;
        if (clickY >= btnY && clickY < btnY + LEVEL_BTN_SIZE) {
          performShowColLevel(lvl);
          return;
        }
      }
      return;
    }

    // +/- toggle buttons (x >= rowHeaderW)
    if (clickX >= rowHeaderW && info.colSymbols.length > 0) {
      for (const sym of info.colSymbols) {
        if (!sym.isButtonCol || sym.level === 0) continue;

        const colX = colXMap.get(sym.col);
        if (colX === undefined) continue;

        const btnCy = buttonPosForLevel(sym.level);
        const hitZone = BUTTON_SIZE / 2 + 2;

        // Find column width from the map
        let colWidth = 100;
        for (const [c, cx] of colXMap) {
          if (c > sym.col && cx > colX) {
            colWidth = cx - colX;
            break;
          }
        }

        const btnCx = colX + colWidth / 2;

        if (
          Math.abs(clickX - btnCx) <= hitZone &&
          Math.abs(clickY - btnCy) <= hitZone
        ) {
          if (sym.isCollapsed) {
            performExpandColumn(sym.col);
          } else {
            performCollapseColumn(sym.col);
          }
          return;
        }
      }
    }
    return;
  }
}

// ============================================================================
// Keyboard Shortcuts
// ============================================================================

function handleKeyDown(event: KeyboardEvent): void {
  if (!currentSelection) return;

  // Alt+Shift+Right = Group (Excel shortcut) - auto-detect rows vs columns
  if (event.altKey && event.shiftKey && event.key === "ArrowRight") {
    event.preventDefault();
    event.stopPropagation();
    const norm = normalizeRange(currentSelection);
    if (currentSelection.type === "columns") {
      performGroupColumns(norm.startCol, norm.endCol);
    } else {
      performGroupRows(norm.startRow, norm.endRow);
    }
    return;
  }

  // Alt+Shift+Left = Ungroup (Excel shortcut) - auto-detect rows vs columns
  if (event.altKey && event.shiftKey && event.key === "ArrowLeft") {
    event.preventDefault();
    event.stopPropagation();
    const norm = normalizeRange(currentSelection);
    if (currentSelection.type === "columns") {
      performUngroupColumns(norm.startCol, norm.endCol);
    } else {
      performUngroupRows(norm.startRow, norm.endRow);
    }
    return;
  }
}

function normalizeRange(sel: {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}): { startRow: number; endRow: number; startCol: number; endCol: number } {
  return {
    startRow: Math.min(sel.startRow, sel.endRow),
    endRow: Math.max(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endCol: Math.max(sel.startCol, sel.endCol),
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerGroupingExtension(): void {
  console.log("[Grouping] Registering...");

  // 1. Register the post-header overlay renderer
  const unregOverlay = registerPostHeaderOverlay(
    "grouping-outline-bar",
    renderOutlineBar,
  );
  cleanupFns.push(unregOverlay);

  // 2. Register group settings dialog
  DialogExtensions.registerDialog({
    id: "group-settings",
    component: GroupSettingsDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("group-settings"));

  // 3. Register grid context menu items
  const unregContextMenu = registerGroupingContextMenuItems();
  cleanupFns.push(unregContextMenu);

  // 3. Register Data menu items (appends to AutoFilter's "data" menu)
  registerGroupingMenuItems(() => currentSelection);

  // 4. Outline bar click handler (capture phase to intercept before grid selection)
  window.addEventListener("mousedown", handleOutlineBarClick, true);
  cleanupFns.push(() =>
    window.removeEventListener("mousedown", handleOutlineBarClick, true),
  );

  // 5. Keyboard shortcuts
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() =>
    window.removeEventListener("keydown", handleKeyDown, true),
  );

  // 6. Track current selection
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    currentSelection = sel
      ? {
          startRow: sel.startRow,
          endRow: sel.endRow,
          startCol: sel.startCol,
          endCol: sel.endCol,
          type: sel.type,
        }
      : null;
  });
  cleanupFns.push(unsubSelection);

  // 7. Reset state on sheet change
  const unsubSheet = onAppEvent(AppEvents.SHEET_CHANGED, () => {
    resetGroupingState();
  });
  cleanupFns.push(unsubSheet);

  console.log("[Grouping] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterGroupingExtension(): void {
  console.log("[Grouping] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Grouping] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  resetGroupingState();

  console.log("[Grouping] Unregistered.");
}
