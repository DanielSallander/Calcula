//! FILENAME: app/extensions/Hyperlinks/index.ts
// PURPOSE: Hyperlinks extension - enables click-to-follow and cursor feedback.
// CONTEXT: Registers a cell click interceptor (Ctrl+Click to follow) and a
//          cursor interceptor (pointer cursor on hyperlink cells).
//          Also registers Insert menu item for adding hyperlinks.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerCellClickInterceptor,
  registerCellCursorInterceptor,
  emitAppEvent,
  AppEvents,
  registerMenuItem,
} from "@api";
import {
  getHyperlink,
  getHyperlinkIndicators,
  type Hyperlink,
  type HyperlinkIndicator,
} from "@api/backend";
import { setActiveSheet, getSheets } from "@api/lib";

// ============================================================================
// State
// ============================================================================

/** Cached hyperlink indicators for the current sheet. */
let cachedIndicators: HyperlinkIndicator[] = [];
let indicatorSet: Set<string> = new Set();

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

function activate(_context: ExtensionContext): void {
  // Register interceptors
  cleanups.push(registerCellClickInterceptor(clickInterceptor));
  cleanups.push(registerCellCursorInterceptor(cursorInterceptor));

  // Load initial indicators
  refreshIndicators();

  // Refresh indicators on sheet change or data change
  const onSheetChange = () => { refreshIndicators(); };
  window.addEventListener(AppEvents.SHEET_CHANGED, onSheetChange);
  window.addEventListener(AppEvents.DATA_CHANGED, onSheetChange);
  cleanups.push(() => {
    window.removeEventListener(AppEvents.SHEET_CHANGED, onSheetChange);
    window.removeEventListener(AppEvents.DATA_CHANGED, onSheetChange);
  });

  // Add "Follow Hyperlink" to the Insert menu (if it exists)
  registerMenuItem("insert", {
    id: "insert:followHyperlink",
    label: "Follow Hyperlink",
    shortcut: "Ctrl+Click",
    action: () => {
      // Follow hyperlink in currently selected cell
      const sel = document.querySelector("[data-active-row]");
      if (sel) {
        const row = parseInt(sel.getAttribute("data-active-row") || "0", 10);
        const col = parseInt(sel.getAttribute("data-active-col") || "0", 10);
        followHyperlink(row, col);
      }
    },
  });
}

function deactivate(): void {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.hyperlinks",
    name: "Hyperlinks",
    version: "1.0.0",
    description: "Ctrl+Click to follow hyperlinks, cursor feedback on hyperlink cells.",
  },
  activate,
  deactivate,
};
export default extension;
