//! FILENAME: app/extensions/Print/index.ts
// PURPOSE: Print extension entry point.
// CONTEXT: Registers Page Setup dialog, File menu items, Ctrl+P shortcut, and PDF export.

import {
  DialogExtensions,
  registerMenuItem,
} from "../../src/api";
import { getPrintData, writeBinaryFile } from "../../src/api/lib";
import { save } from "@tauri-apps/plugin-dialog";
import { PageSetupDialog } from "./components/PageSetupDialog";
import { executePrint } from "./lib/printGenerator";
import { generatePdf } from "./lib/pdfGenerator";

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
