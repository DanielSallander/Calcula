//! FILENAME: app/extensions/Grouping/index.ts
// PURPOSE: Grouping/Outline extension entry point. ExtensionModule lifecycle pattern.
// CONTEXT: Registers the outline bar renderer, context menu items, Data menu items,
//          and outline bar click handler (for +/- buttons and level buttons).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  AppEvents,
  ExtensionRegistry,
} from "@api";
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

let isActivated = false;
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
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[Grouping] Already activated, skipping.");
    return;
  }

  console.log("[Grouping] Activating...");

  // 1. Register the post-header overlay renderer
  const unregOverlay = context.grid.overlays.register(
    "grouping-outline-bar",
    renderOutlineBar,
  );
  cleanupFns.push(unregOverlay);

  // 2. Register group settings dialog
  context.ui.dialogs.register({
    id: "group-settings",
    component: GroupSettingsDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("group-settings"));

  // 3. Register grid context menu items
  const unregContextMenu = registerGroupingContextMenuItems();
  cleanupFns.push(unregContextMenu);

  // 4. Register Data menu items (appends to AutoFilter's "data" menu)
  registerGroupingMenuItems(context, () => currentSelection);

  // 5. Outline bar click handler (capture phase to intercept before grid selection)
  window.addEventListener("mousedown", handleOutlineBarClick, true);
  cleanupFns.push(() =>
    window.removeEventListener("mousedown", handleOutlineBarClick, true),
  );

  // 6. Keyboard shortcuts
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() =>
    window.removeEventListener("keydown", handleKeyDown, true),
  );

  // 7. Track current selection
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

  // 8. Reset state on sheet change
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
    resetGroupingState();
  });
  cleanupFns.push(unsubSheet);

  isActivated = true;
  console.log("[Grouping] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[Grouping] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Grouping] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  resetGroupingState();
  currentSelection = null;

  isActivated = false;
  console.log("[Grouping] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.grouping",
    name: "Grouping",
    version: "1.0.0",
    description: "Row and column grouping/outline with collapsible groups and level buttons.",
  },
  activate,
  deactivate,
};

export default extension;
