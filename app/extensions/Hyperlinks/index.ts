//! FILENAME: app/extensions/Hyperlinks/index.ts
// PURPOSE: Hyperlinks extension - enables click-to-follow, cursor feedback,
//          insert/edit dialog, context menu, and Ctrl+K shortcut.
// CONTEXT: Registers a cell click interceptor (Ctrl+Click to follow) and a
//          cursor interceptor (pointer cursor on hyperlink cells).
//          Registers Insert Hyperlink dialog, context menu items, and keyboard shortcut.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerCellClickInterceptor,
  registerCellCursorInterceptor,
  emitAppEvent,
  AppEvents,
  registerMenuItem,
  gridExtensions,
  ExtensionRegistry,
  showDialog,
} from "@api";
import type { GridContextMenuItem, GridMenuContext } from "@api";
import {
  getHyperlink,
  getHyperlinkIndicators,
  removeHyperlink,
  type Hyperlink,
  type HyperlinkIndicator,
} from "@api/backend";
import { setActiveSheet, getSheets } from "@api/lib";
import { InsertHyperlinkDialog } from "./InsertHyperlinkDialog";

// ============================================================================
// State
// ============================================================================

/** Cached hyperlink indicators for the current sheet. */
let cachedIndicators: HyperlinkIndicator[] = [];
let indicatorSet: Set<string> = new Set();

/** Currently active cell (tracked for keyboard shortcut). */
let currentActiveCell: { row: number; col: number } | null = null;

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

async function refreshIndicators(): Promise<void> {
  try {
    cachedIndicators = await getHyperlinkIndicators();
    indicatorSet = new Set(cachedIndicators.map((h) => cellKey(h.row, h.col)));
  } catch {
    cachedIndicators = [];
    indicatorSet.clear();
  }
}

// ============================================================================
// Follow Hyperlink
// ============================================================================

async function followHyperlink(row: number, col: number): Promise<boolean> {
  const hyperlink = await getHyperlink(row, col);
  if (!hyperlink) return false;

  switch (hyperlink.linkType) {
    case "url":
      window.open(hyperlink.target, "_blank", "noopener,noreferrer");
      return true;

    case "email":
      window.open(hyperlink.target, "_self");
      return true;

    case "internalReference":
      await navigateToInternalRef(hyperlink);
      return true;

    case "file":
      // File links: attempt to open via default handler
      window.open(hyperlink.target, "_blank");
      return true;

    default:
      return false;
  }
}

async function navigateToInternalRef(hyperlink: Hyperlink): Promise<void> {
  const ref = hyperlink.internalRef;
  if (!ref) return;

  // Switch sheet if needed
  if (ref.sheetName) {
    const sheetsResult = await getSheets();
    const targetSheet = sheetsResult.sheets.find(
      (s) => s.name === ref.sheetName
    );
    if (targetSheet && targetSheet.index !== sheetsResult.activeIndex) {
      await setActiveSheet(targetSheet.index);
      emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: targetSheet.index });
      // Small delay for sheet switch to complete
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Parse cell reference (e.g., "A1", "B5")
  const match = ref.cellReference.match(/^([A-Z]+)(\d+)$/i);
  if (match) {
    const colStr = match[1].toUpperCase();
    const rowNum = parseInt(match[2], 10) - 1; // 0-based
    let colNum = 0;
    for (let i = 0; i < colStr.length; i++) {
      colNum = colNum * 26 + (colStr.charCodeAt(i) - 64);
    }
    colNum -= 1; // 0-based

    emitAppEvent(AppEvents.NAVIGATE_TO_CELL, { row: rowNum, col: colNum });
  }
}

// ============================================================================
// Open Dialog Helpers
// ============================================================================

function openInsertDialog(row: number, col: number): void {
  showDialog("insert-hyperlink", { row, col, editMode: false });
}

function openEditDialog(row: number, col: number): void {
  showDialog("insert-hyperlink", { row, col, editMode: true });
}

// ============================================================================
// Keyboard Shortcut
// ============================================================================

let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

async function handleKeyDown(e: KeyboardEvent): Promise<void> {
  // Ctrl+K: Insert/Edit Hyperlink
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    // Don't intercept if an input/textarea/contenteditable is focused
    const active = document.activeElement;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        (active as HTMLElement).isContentEditable)
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (!currentActiveCell) return;
    const { row, col } = currentActiveCell;

    // Check if cell already has a hyperlink -> edit mode
    const existing = await getHyperlink(row, col);
    if (existing) {
      openEditDialog(row, col);
    } else {
      openInsertDialog(row, col);
    }
  }
}

function registerKeyboardShortcut(): void {
  keydownHandler = handleKeyDown;
  window.addEventListener("keydown", keydownHandler, true);
}

function unregisterKeyboardShortcut(): void {
  if (keydownHandler) {
    window.removeEventListener("keydown", keydownHandler, true);
    keydownHandler = null;
  }
}

// ============================================================================
// Context Menu
// ============================================================================

const HYPERLINK_GROUP = "hyperlinks";
const HYPERLINK_ORDER_BASE = 750;

const contextMenuItems: GridContextMenuItem[] = [
  // Insert Hyperlink (shown when cell does NOT have a hyperlink)
  {
    id: "ctx:insertHyperlink",
    label: "Insert Hyperlink...",
    shortcut: "Ctrl+K",
    group: HYPERLINK_GROUP,
    order: HYPERLINK_ORDER_BASE,
    visible: (ctx: GridMenuContext) => {
      if (!ctx.clickedCell) return false;
      return !indicatorSet.has(cellKey(ctx.clickedCell.row, ctx.clickedCell.col));
    },
    onClick: (ctx: GridMenuContext) => {
      if (!ctx.clickedCell) return;
      openInsertDialog(ctx.clickedCell.row, ctx.clickedCell.col);
    },
  },

  // Edit Hyperlink (shown when cell HAS a hyperlink)
  {
    id: "ctx:editHyperlink",
    label: "Edit Hyperlink...",
    group: HYPERLINK_GROUP,
    order: HYPERLINK_ORDER_BASE + 1,
    visible: (ctx: GridMenuContext) => {
      if (!ctx.clickedCell) return false;
      return indicatorSet.has(cellKey(ctx.clickedCell.row, ctx.clickedCell.col));
    },
    onClick: (ctx: GridMenuContext) => {
      if (!ctx.clickedCell) return;
      openEditDialog(ctx.clickedCell.row, ctx.clickedCell.col);
    },
  },

  // Remove Hyperlink (shown when cell HAS a hyperlink)
  {
    id: "ctx:removeHyperlink",
    label: "Remove Hyperlink",
    group: HYPERLINK_GROUP,
    order: HYPERLINK_ORDER_BASE + 2,
    separatorAfter: true,
    visible: (ctx: GridMenuContext) => {
      if (!ctx.clickedCell) return false;
      return indicatorSet.has(cellKey(ctx.clickedCell.row, ctx.clickedCell.col));
    },
    onClick: async (ctx: GridMenuContext) => {
      if (!ctx.clickedCell) return;
      const { row, col } = ctx.clickedCell;
      try {
        await removeHyperlink(row, col);
        await refreshIndicators();
        emitAppEvent(AppEvents.DATA_CHANGED, {});
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      } catch (err) {
        console.error("[Hyperlinks] Remove hyperlink failed:", err);
      }
    },
  },
];

function registerContextMenuItems(): void {
  gridExtensions.registerContextMenuItems(contextMenuItems);
}

function unregisterContextMenuItems(): void {
  for (const item of contextMenuItems) {
    gridExtensions.unregisterContextMenuItem(item.id);
  }
}

// ============================================================================
// Interceptors
// ============================================================================

const clickInterceptor = async (
  row: number,
  col: number,
  event: { clientX: number; clientY: number; ctrlKey?: boolean; metaKey?: boolean }
): Promise<boolean> => {
  // Ctrl+Click (or Cmd+Click on Mac) follows the hyperlink
  const modKey = event.ctrlKey || event.metaKey;
  if (!modKey) return false;

  // Quick check: does this cell have a hyperlink?
  if (!indicatorSet.has(cellKey(row, col))) return false;

  return followHyperlink(row, col);
};

const cursorInterceptor = (row: number, col: number): string | null => {
  if (indicatorSet.has(cellKey(row, col))) {
    return "pointer";
  }
  return null;
};

// ============================================================================
// Lifecycle
// ============================================================================

const cleanups: Array<() => void> = [];

function activate(context: ExtensionContext): void {
  console.log("[Hyperlinks] Activating...");

  // 1. Register the Insert Hyperlink dialog
  context.ui.dialogs.register({
    id: "insert-hyperlink",
    component: InsertHyperlinkDialog,
    priority: 100,
  });
  cleanups.push(() => context.ui.dialogs.unregister("insert-hyperlink"));

  // 2. Register interceptors
  cleanups.push(registerCellClickInterceptor(clickInterceptor));
  cleanups.push(registerCellCursorInterceptor(cursorInterceptor));

  // 3. Load initial indicators
  refreshIndicators();

  // 4. Refresh indicators on sheet change or data change
  const onSheetChange = () => { refreshIndicators(); };
  window.addEventListener(AppEvents.SHEET_CHANGED, onSheetChange);
  window.addEventListener(AppEvents.DATA_CHANGED, onSheetChange);
  cleanups.push(() => {
    window.removeEventListener(AppEvents.SHEET_CHANGED, onSheetChange);
    window.removeEventListener(AppEvents.DATA_CHANGED, onSheetChange);
  });

  // 5. Track current selection for keyboard shortcut
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    currentActiveCell = sel
      ? { row: sel.startRow, col: sel.startCol }
      : null;
  });
  cleanups.push(unsubSelection);

  // 6. Register keyboard shortcut (Ctrl+K)
  registerKeyboardShortcut();
  cleanups.push(unregisterKeyboardShortcut);

  // 7. Register context menu items
  registerContextMenuItems();

  // 8. Add "Insert Hyperlink" to the Insert menu
  registerMenuItem("insert", {
    id: "insert:insertHyperlink",
    label: "Hyperlink...",
    shortcut: "Ctrl+K",
    action: () => {
      if (currentActiveCell) {
        openInsertDialog(currentActiveCell.row, currentActiveCell.col);
      }
    },
  });

  // 9. Add "Follow Hyperlink" to the Insert menu
  registerMenuItem("insert", {
    id: "insert:followHyperlink",
    label: "Follow Hyperlink",
    shortcut: "Ctrl+Click",
    action: () => {
      if (currentActiveCell) {
        followHyperlink(currentActiveCell.row, currentActiveCell.col);
      }
    },
  });

  console.log("[Hyperlinks] Activated successfully.");
}

function deactivate(): void {
  console.log("[Hyperlinks] Deactivating...");

  // Unregister context menu items
  unregisterContextMenuItems();

  // Run cleanup functions
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (err) {
      console.error("[Hyperlinks] Cleanup error:", err);
    }
  }
  cleanups.length = 0;

  currentActiveCell = null;

  console.log("[Hyperlinks] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.hyperlinks",
    name: "Hyperlinks",
    version: "1.0.0",
    description: "Insert, edit, follow hyperlinks with Ctrl+K shortcut and context menu.",
  },
  activate,
  deactivate,
};
export default extension;
