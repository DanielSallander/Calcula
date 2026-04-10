//! FILENAME: app/extensions/Print/index.ts
// PURPOSE: Print extension entry point. ExtensionModule lifecycle pattern.
// CONTEXT: Registers Page Setup dialog, File menu items, Ctrl+P shortcut, PDF export,
//          page break preview overlay, page break management commands,
//          print area/titles commands from selection.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  AppEvents,
  IconPageBreaks,
  IconInsertPageBreak,
  IconRemovePageBreak,
  IconResetPageBreaks,
  IconPrintArea,
} from "@api";
import type { Selection } from "@api";
import {
  getPrintData,
  writeBinaryFile,
  insertRowPageBreak,
  removeRowPageBreak,
  insertColPageBreak,
  removeColPageBreak,
  resetAllPageBreaks,
  getPageSetup,
  setPrintArea,
  clearPrintArea,
  setPrintTitleRows,
  clearPrintTitleRows,
  setPrintTitleCols,
  clearPrintTitleCols,
  indexToCol,
} from "@api/lib";
import { save } from "@tauri-apps/plugin-dialog";
import { PageSetupDialog } from "./components/PageSetupDialog";
import { executePrint } from "./lib/printGenerator";
import { generatePdf } from "./lib/pdfGenerator";
import {
  renderPageBreakOverlay,
  isPageBreakPreviewEnabled,
  setPageBreakPreviewEnabled,
  refreshPageBreakData,
} from "./lib/pageBreakOverlay";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];
let currentSelection: Selection | null = null;

// ============================================================================
// Selection tracking
// ============================================================================

function getSelectionBounds(): {
  startRow: number; startCol: number; endRow: number; endCol: number;
} | null {
  if (!currentSelection) return null;
  const sr = Math.min(currentSelection.startRow, currentSelection.endRow);
  const er = Math.max(currentSelection.startRow, currentSelection.endRow);
  const sc = Math.min(currentSelection.startCol, currentSelection.endCol);
  const ec = Math.max(currentSelection.startCol, currentSelection.endCol);
  return { startRow: sr, startCol: sc, endRow: er, endCol: ec };
}

// ============================================================================
// Print handler
// ============================================================================

async function handlePrint(): Promise<void> {
  try {
    const data = await getPrintData();
    executePrint(data);
  } catch (err) {
    console.error("[Print] Failed to get print data:", err);
    alert("Failed to prepare print data: " + String(err));
  }
}

// ============================================================================
// PDF Export handler
// ============================================================================

async function handleExportPdf(): Promise<void> {
  try {
    // Show save dialog
    const filePath = await save({
      title: "Export to PDF",
      defaultPath: "spreadsheet.pdf",
      filters: [{ name: "PDF Files", extensions: ["pdf"] }],
    });

    if (!filePath) return; // User cancelled

    // Get print data
    const data = await getPrintData();

    // Generate PDF
    const pdfBuffer = generatePdf(data);

    // Write to disk
    const bytes = Array.from(new Uint8Array(pdfBuffer));
    await writeBinaryFile(filePath, bytes);

    console.log("[Print] PDF exported to:", filePath);
  } catch (err) {
    console.error("[Print] PDF export failed:", err);
    alert("Failed to export PDF: " + String(err));
  }
}

// ============================================================================
// Page Break Management
// ============================================================================

async function handleInsertRowPageBreak(): Promise<void> {
  try {
    const row = getSelectedRow();
    if (row === null || row <= 0) {
      alert("Select a row below row 1 to insert a page break.");
      return;
    }
    await insertRowPageBreak(row);
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Insert row page break failed:", err);
  }
}

async function handleRemoveRowPageBreak(): Promise<void> {
  try {
    const row = getSelectedRow();
    if (row === null) return;
    await removeRowPageBreak(row);
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Remove row page break failed:", err);
  }
}

async function handleInsertColPageBreak(): Promise<void> {
  try {
    const col = getSelectedCol();
    if (col === null || col <= 0) {
      alert("Select a column after column A to insert a page break.");
      return;
    }
    await insertColPageBreak(col);
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Insert col page break failed:", err);
  }
}

async function handleRemoveColPageBreak(): Promise<void> {
  try {
    const col = getSelectedCol();
    if (col === null) return;
    await removeColPageBreak(col);
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Remove col page break failed:", err);
  }
}

async function handleResetAllPageBreaks(): Promise<void> {
  try {
    await resetAllPageBreaks();
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Reset page breaks failed:", err);
  }
}

/** Get the currently selected row from the tracked selection or fallback. */
function getSelectedRow(): number | null {
  if (currentSelection) {
    return Math.min(currentSelection.startRow, currentSelection.endRow);
  }
  // Fallback: read from DOM
  const selEl = document.querySelector("[data-active-row]");
  if (selEl) {
    const row = parseInt(selEl.getAttribute("data-active-row") || "");
    if (!isNaN(row)) return row;
  }
  const sel = (window as Record<string, unknown>).__calcula_selection as
    | { activeRow?: number }
    | undefined;
  return sel?.activeRow ?? null;
}

/** Get the currently selected column from the tracked selection or fallback. */
function getSelectedCol(): number | null {
  if (currentSelection) {
    return Math.min(currentSelection.startCol, currentSelection.endCol);
  }
  const selEl = document.querySelector("[data-active-col]");
  if (selEl) {
    const col = parseInt(selEl.getAttribute("data-active-col") || "");
    if (!isNaN(col)) return col;
  }
  const sel = (window as Record<string, unknown>).__calcula_selection as
    | { activeCol?: number }
    | undefined;
  return sel?.activeCol ?? null;
}

// ============================================================================
// Print Area & Titles handlers
// ============================================================================

async function handleSetPrintArea(): Promise<void> {
  try {
    const bounds = getSelectionBounds();
    if (!bounds) {
      alert("Select a range of cells first to set as print area.");
      return;
    }
    const rangeStr = await setPrintArea(
      bounds.startRow, bounds.startCol, bounds.endRow, bounds.endCol,
    );
    console.log("[Print] Print area set to:", rangeStr);
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Set print area failed:", err);
    alert("Failed to set print area: " + String(err));
  }
}

async function handleClearPrintArea(): Promise<void> {
  try {
    await clearPrintArea();
    console.log("[Print] Print area cleared");
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Clear print area failed:", err);
  }
}

async function handleSetPrintTitleRows(): Promise<void> {
  try {
    const bounds = getSelectionBounds();
    if (!bounds) {
      alert("Select one or more rows first to set as title rows.");
      return;
    }
    const titleStr = await setPrintTitleRows(bounds.startRow, bounds.endRow);
    console.log("[Print] Title rows set to:", titleStr);
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Set title rows failed:", err);
    alert("Failed to set title rows: " + String(err));
  }
}

async function handleClearPrintTitleRows(): Promise<void> {
  try {
    await clearPrintTitleRows();
    console.log("[Print] Title rows cleared");
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Clear title rows failed:", err);
  }
}

async function handleSetPrintTitleCols(): Promise<void> {
  try {
    const bounds = getSelectionBounds();
    if (!bounds) {
      alert("Select one or more columns first to set as title columns.");
      return;
    }
    const titleStr = await setPrintTitleCols(bounds.startCol, bounds.endCol);
    console.log("[Print] Title columns set to:", titleStr);
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Set title cols failed:", err);
    alert("Failed to set title columns: " + String(err));
  }
}

async function handleClearPrintTitleCols(): Promise<void> {
  try {
    await clearPrintTitleCols();
    console.log("[Print] Title columns cleared");
    await refreshPageBreakData();
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error("[Print] Clear title cols failed:", err);
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[Print] Already activated, skipping.");
    return;
  }

  console.log("[Print] Activating...");

  // 1. Register Page Setup dialog
  context.ui.dialogs.register({
    id: "page-setup",
    component: PageSetupDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("page-setup"));

  // 2. Track selection changes
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    currentSelection = sel;
  });
  cleanupFns.push(unsubSelection);

  // 3. Add File menu items (Print + Page Setup + Export PDF)
  context.ui.menus.registerItem("file", {
    id: "file.print-separator",
    label: "",
    separator: true,
  });

  context.ui.menus.registerItem("file", {
    id: "file.print",
    label: "Print",
    shortcut: "Ctrl+P",
    action: handlePrint,
  });

  context.ui.menus.registerItem("file", {
    id: "file.export-pdf",
    label: "Export to PDF...",
    action: handleExportPdf,
  });

  context.ui.menus.registerItem("file", {
    id: "file.page-setup",
    label: "Page Setup...",
    action: () => {
      context.ui.dialogs.show("page-setup");
    },
  });

  // 4. Register Ctrl+P keyboard shortcut
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "p") {
      e.preventDefault();
      e.stopPropagation();
      handlePrint();
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  // 5. Register page break preview overlay
  const unregOverlay = context.grid.overlays.register(
    "page-break-preview",
    renderPageBreakOverlay,
  );
  cleanupFns.push(unregOverlay);

  // 6. Listen for view mode changes to sync page break preview state
  const unsubViewMode = context.events.on<{ viewMode: string }>(
    AppEvents.VIEW_MODE_CHANGED,
    (detail) => {
      const shouldEnable = detail.viewMode === "pageBreakPreview";
      if (shouldEnable !== isPageBreakPreviewEnabled()) {
        setPageBreakPreviewEnabled(shouldEnable);
        console.log("[Print] Page break preview:", shouldEnable ? "ON" : "OFF");
      }
    },
  );
  cleanupFns.push(unsubViewMode);

  // 7. "Page Breaks" submenu in View menu
  context.ui.menus.registerItem("view", {
    id: "view.pageBreaks",
    label: "Page Breaks",
    icon: IconPageBreaks,
    children: [
      {
        id: "view.pageBreaks:insertRow",
        label: "Insert Row Page Break",
        icon: IconInsertPageBreak,
        action: handleInsertRowPageBreak,
      },
      {
        id: "view.pageBreaks:insertCol",
        label: "Insert Column Page Break",
        icon: IconInsertPageBreak,
        action: handleInsertColPageBreak,
      },
      {
        id: "view.pageBreaks:sep1",
        label: "",
        separator: true,
      },
      {
        id: "view.pageBreaks:removeRow",
        label: "Remove Row Page Break",
        icon: IconRemovePageBreak,
        action: handleRemoveRowPageBreak,
      },
      {
        id: "view.pageBreaks:removeCol",
        label: "Remove Column Page Break",
        icon: IconRemovePageBreak,
        action: handleRemoveColPageBreak,
      },
      {
        id: "view.pageBreaks:sep2",
        label: "",
        separator: true,
      },
      {
        id: "view.pageBreaks:resetAll",
        label: "Reset All Page Breaks",
        icon: IconResetPageBreaks,
        action: handleResetAllPageBreaks,
      },
    ],
  });

  // 8. "Print Area" submenu in View menu
  context.ui.menus.registerItem("view", {
    id: "view.printArea",
    label: "Print Area",
    icon: IconPrintArea,
    children: [
      {
        id: "view.printArea:set",
        label: "Set Print Area",
        action: handleSetPrintArea,
      },
      {
        id: "view.printArea:clear",
        label: "Clear Print Area",
        action: handleClearPrintArea,
      },
      {
        id: "view.printArea:sep",
        label: "",
        separator: true,
      },
      {
        id: "view.printArea:setTitleRows",
        label: "Rows to Repeat at Top...",
        action: handleSetPrintTitleRows,
      },
      {
        id: "view.printArea:clearTitleRows",
        label: "Clear Title Rows",
        action: handleClearPrintTitleRows,
      },
      {
        id: "view.printArea:sep2",
        label: "",
        separator: true,
      },
      {
        id: "view.printArea:setTitleCols",
        label: "Columns to Repeat at Left...",
        action: handleSetPrintTitleCols,
      },
      {
        id: "view.printArea:clearTitleCols",
        label: "Clear Title Columns",
        action: handleClearPrintTitleCols,
      },
    ],
  });

  isActivated = true;
  console.log("[Print] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[Print] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Print] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  currentSelection = null;

  isActivated = false;
  console.log("[Print] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.print",
    name: "Print",
    version: "1.0.0",
    description: "Print, PDF export, page setup, page breaks, print area, and title rows/columns.",
  },
  activate,
  deactivate,
};

export default extension;
