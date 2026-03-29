//! FILENAME: app/extensions/Print/index.ts
// PURPOSE: Print extension entry point.
// CONTEXT: Registers Page Setup dialog, File menu items, Ctrl+P shortcut, PDF export,
//          page break preview overlay, and page break management commands.

import {
  DialogExtensions,
  registerMenuItem,
  registerPostHeaderOverlay,
} from "../../src/api";
import {
  getPrintData,
  writeBinaryFile,
  insertRowPageBreak,
  removeRowPageBreak,
  insertColPageBreak,
  removeColPageBreak,
  resetAllPageBreaks,
  getPageSetup,
} from "../../src/api/lib";
import { save } from "@tauri-apps/plugin-dialog";
import { PageSetupDialog } from "./components/PageSetupDialog";
import { executePrint } from "./lib/printGenerator";
import { generatePdf } from "./lib/pdfGenerator";
import {
  renderPageBreakOverlay,
  togglePageBreakPreview,
  isPageBreakPreviewEnabled,
  refreshPageBreakData,
} from "./lib/pageBreakOverlay";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

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
// Page Break Preview toggle
// ============================================================================

function handleTogglePageBreakPreview(): void {
  const enabled = togglePageBreakPreview();
  console.log("[Print] Page break preview:", enabled ? "ON" : "OFF");
  // Trigger grid redraw
  window.dispatchEvent(new Event("app:grid-refresh"));
}

// ============================================================================
// Page Break Management
// ============================================================================

async function handleInsertRowPageBreak(): Promise<void> {
  try {
    // Get the currently selected row from the grid
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

/** Get the currently selected row from the global selection state. */
function getSelectedRow(): number | null {
  // Access selection through the global event system
  const selEl = document.querySelector("[data-active-row]");
  if (selEl) {
    const row = parseInt(selEl.getAttribute("data-active-row") || "");
    if (!isNaN(row)) return row;
  }
  // Fallback: read from window.__calcula_selection if available
  const sel = (window as Record<string, unknown>).__calcula_selection as
    | { activeRow?: number }
    | undefined;
  return sel?.activeRow ?? null;
}

/** Get the currently selected column from the global selection state. */
function getSelectedCol(): number | null {
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
// Registration
// ============================================================================

export function registerPrintExtension(): void {
  console.log("[Print] Registering...");

  // 1. Register Page Setup dialog
  DialogExtensions.registerDialog({
    id: "page-setup",
    component: PageSetupDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("page-setup"));

  // 2. Add File menu items (Print + Page Setup + Export PDF)
  registerMenuItem("file", {
    id: "file.print-separator",
    label: "",
    separator: true,
  });

  registerMenuItem("file", {
    id: "file.print",
    label: "Print",
    shortcut: "Ctrl+P",
    action: handlePrint,
  });

  registerMenuItem("file", {
    id: "file.export-pdf",
    label: "Export to PDF...",
    action: handleExportPdf,
  });

  registerMenuItem("file", {
    id: "file.page-setup",
    label: "Page Setup...",
    action: () => {
      DialogExtensions.openDialog("page-setup");
    },
  });

  // 3. Register Ctrl+P keyboard shortcut
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "p") {
      e.preventDefault();
      e.stopPropagation();
      handlePrint();
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  // 4. Register page break preview overlay
  const unregOverlay = registerPostHeaderOverlay(
    "page-break-preview",
    renderPageBreakOverlay,
  );
  cleanupFns.push(unregOverlay);

  // 5. Add View menu items for page break preview
  registerMenuItem("view", {
    id: "view.page-break-separator",
    label: "",
    separator: true,
  });

  registerMenuItem("view", {
    id: "view.page-break-preview",
    label: "Page Break Preview",
    action: handleTogglePageBreakPreview,
  });

  // 6. Add Page Layout menu items for page breaks
  registerMenuItem("view", {
    id: "view.insert-row-page-break",
    label: "Insert Row Page Break",
    action: handleInsertRowPageBreak,
  });

  registerMenuItem("view", {
    id: "view.insert-col-page-break",
    label: "Insert Column Page Break",
    action: handleInsertColPageBreak,
  });

  registerMenuItem("view", {
    id: "view.remove-row-page-break",
    label: "Remove Row Page Break",
    action: handleRemoveRowPageBreak,
  });

  registerMenuItem("view", {
    id: "view.remove-col-page-break",
    label: "Remove Column Page Break",
    action: handleRemoveColPageBreak,
  });

  registerMenuItem("view", {
    id: "view.reset-all-page-breaks",
    label: "Reset All Page Breaks",
    action: handleResetAllPageBreaks,
  });

  console.log("[Print] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterPrintExtension(): void {
  console.log("[Print] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Print] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[Print] Unregistered.");
}
